import OpenAI from 'openai';
import { Client, ID, Query, TablesDB } from 'node-appwrite';

const DATABASE_ID = process.env.DATABASE_ID;
const MESSAGES_TABLE_ID = 'messages';
const CONVERSATIONS_TABLE_ID = 'conversations';
const ORDERS_TABLE_ID = 'orders';

const MODEL = process.env.OPENAI_MODEL ?? 'gpt-5.6-luna';
// When the prompt for the last reply used more than this many input tokens,
// fold the older part of the history into the running summary before the
// next reply. Small on purpose so the demo shows it happen.
const COMPACT_AFTER_TOKENS = Number(process.env.COMPACT_AFTER_TOKENS ?? 1500);
// Always keep this many recent messages verbatim after compaction.
const KEEP_RECENT_MESSAGES = 6;

const SYSTEM_PROMPT = `You are the WhatsApp support assistant for Northwind Coffee, an online coffee roaster.
Answer in two or three short sentences, the way a person types on WhatsApp. No markdown.
When a customer asks about an order, call the lookup_order tool with the order number
before answering. Never invent order details. If you do not have an order number, ask for it.`;

const TOOLS = [
  {
    type: 'function',
    name: 'lookup_order',
    description: 'Look up a Northwind Coffee order by its order number.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        orderNumber: { type: 'string', description: 'The order number, for example NW-1042' },
      },
      required: ['orderNumber'],
      additionalProperties: false,
    },
  },
];

export default async ({ req, res, log, error }) => {
  const { phone } = req.bodyJson;
  if (!phone) {
    return res.json({ ok: false, reason: 'phone missing' }, 400);
  }

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] ?? '');
  const tablesDB = new TablesDB(client);
  const openai = new OpenAI();

  // 1. Load the running summary for this phone number, if there is one.
  const conversation = await getOrCreateConversation(tablesDB, phone);

  // 2. Load every message that has not been folded into the summary yet.
  let history = await loadUncompactedMessages(tablesDB, phone);
  log(`Uncompacted history for ${phone}: ${history.length} messages, last prompt ${conversation.promptTokens ?? 0} tokens`);

  // 3. Compact when the last prompt was getting long.
  if ((conversation.promptTokens ?? 0) > COMPACT_AFTER_TOKENS && history.length > KEEP_RECENT_MESSAGES) {
    const older = history.slice(0, history.length - KEEP_RECENT_MESSAGES);
    const summary = await summarize(openai, conversation.summary, older);

    await tablesDB.updateRow({
      databaseId: DATABASE_ID,
      tableId: CONVERSATIONS_TABLE_ID,
      rowId: conversation.$id,
      data: { summary },
    });
    for (const row of older) {
      await tablesDB.updateRow({
        databaseId: DATABASE_ID,
        tableId: MESSAGES_TABLE_ID,
        rowId: row.$id,
        data: { compacted: true },
      });
    }

    conversation.summary = summary;
    history = history.slice(-KEEP_RECENT_MESSAGES);
    log(`Compacted ${older.length} messages into the summary`);
  }

  // 4. Ask the model, running any tool calls it asks for.
  const instructions = conversation.summary
    ? `${SYSTEM_PROMPT}\n\nWhat you already know from earlier in this conversation:\n${conversation.summary}`
    : SYSTEM_PROMPT;

  const input = history.map((row) => ({ role: row.role, content: row.content }));
  let response = await openai.responses.create({ model: MODEL, instructions, input, tools: TOOLS });
  let promptTokens = response.usage?.input_tokens ?? 0;

  for (let round = 0; round < 5; round++) {
    const calls = response.output.filter((item) => item.type === 'function_call');
    if (calls.length === 0) break;

    input.push(...response.output);
    for (const call of calls) {
      const output = await runTool(tablesDB, call.name, JSON.parse(call.arguments));
      input.push({ type: 'function_call_output', call_id: call.call_id, output });
    }
    response = await openai.responses.create({ model: MODEL, instructions, input, tools: TOOLS });
    promptTokens = Math.max(promptTokens, response.usage?.input_tokens ?? 0);
  }

  const reply = response.output_text.trim();
  if (!reply) {
    error(`Model returned no text for ${phone} (status: ${response.status})`);
    return res.json({ ok: false });
  }

  // 5. Send the reply over WhatsApp and keep a copy in the history.
  const wamid = await sendWhatsAppMessage(phone, reply);

  await tablesDB.createRow({
    databaseId: DATABASE_ID,
    tableId: MESSAGES_TABLE_ID,
    rowId: ID.unique(),
    data: { phone, role: 'assistant', content: reply, wamid, compacted: false },
  });

  // Remember how big the prompt was so the next run knows whether to compact.
  await tablesDB.updateRow({
    databaseId: DATABASE_ID,
    tableId: CONVERSATIONS_TABLE_ID,
    rowId: conversation.$id,
    data: { promptTokens },
  });

  return res.json({ ok: true, promptTokens, compacted: conversation.summary !== null });
};

async function runTool(tablesDB, name, args) {
  if (name !== 'lookup_order') {
    return `Unknown tool ${name}`;
  }
  const result = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: ORDERS_TABLE_ID,
    queries: [Query.equal('orderNumber', args.orderNumber.toUpperCase()), Query.limit(1)],
  });
  if (result.total === 0) {
    return `No order found with number ${args.orderNumber}.`;
  }
  const order = result.rows[0];
  return JSON.stringify({
    orderNumber: order.orderNumber,
    items: order.items,
    status: order.status,
    expectedDelivery: order.expectedDelivery,
  });
}

async function getOrCreateConversation(tablesDB, phone) {
  try {
    return await tablesDB.getRow({
      databaseId: DATABASE_ID,
      tableId: CONVERSATIONS_TABLE_ID,
      rowId: phone,
    });
  } catch (err) {
    if (err.code !== 404) throw err;
    return tablesDB.createRow({
      databaseId: DATABASE_ID,
      tableId: CONVERSATIONS_TABLE_ID,
      rowId: phone,
      data: { phone, summary: null, promptTokens: 0 },
    });
  }
}

async function loadUncompactedMessages(tablesDB, phone) {
  const result = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: MESSAGES_TABLE_ID,
    queries: [
      Query.equal('phone', phone),
      Query.equal('compacted', false),
      Query.orderAsc('$createdAt'),
      Query.limit(200),
    ],
  });
  return result.rows;
}

async function summarize(openai, previousSummary, rows) {
  const transcript = rows
    .map((row) => `${row.role === 'user' ? 'Customer' : 'Assistant'}: ${row.content}`)
    .join('\n');

  const response = await openai.responses.create({
    model: MODEL,
    instructions:
      'You maintain a compact memory of a customer support conversation. Merge the existing summary ' +
      'with the new transcript into one plain-text summary under 200 words. Keep names, order numbers, ' +
      'preferences, unresolved questions, and promises made. Drop greetings and small talk.',
    input: `Existing summary:\n${previousSummary ?? '(none)'}\n\nNew transcript:\n${transcript}`,
  });

  return response.output_text.trim();
}

async function sendWhatsAppMessage(to, text) {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    },
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`WhatsApp send failed: ${JSON.stringify(data)}`);
  }
  return data.messages?.[0]?.id ?? null;
}
