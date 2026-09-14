import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { Client, ID, Query, TablesDB } from 'node-appwrite';
import { z } from 'zod';

const DATABASE_ID = process.env.DATABASE_ID;
const MESSAGES_TABLE_ID = 'messages';
const CONVERSATIONS_TABLE_ID = 'conversations';
const ORDERS_TABLE_ID = 'orders';

const MODEL = 'claude-opus-5';
// When the uncompacted history grows past this many tokens, fold the older
// part into the running summary. Small on purpose so the demo shows it happen.
const COMPACT_AFTER_TOKENS = Number(process.env.COMPACT_AFTER_TOKENS ?? 1500);
// Always keep this many recent messages verbatim after compaction.
const KEEP_RECENT_MESSAGES = 6;

const SYSTEM_PROMPT = `You are the WhatsApp support assistant for Northwind Coffee, an online coffee roaster.
Answer in two or three short sentences, the way a person types on WhatsApp. No markdown.
When a customer asks about an order, call the lookup_order tool with the order number
before answering. Never invent order details. If you do not have an order number, ask for it.`;

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
  const anthropic = new Anthropic();

  // 1. Load the running summary for this phone number, if there is one.
  const conversation = await getOrCreateConversation(tablesDB, phone);

  // 2. Load every message that has not been folded into the summary yet.
  let history = await loadUncompactedMessages(tablesDB, phone);

  // 3. Compact when the verbatim history is getting long.
  const tokens = await countTokens(anthropic, conversation.summary, history);
  log(`Uncompacted history for ${phone}: ${history.length} messages, ${tokens} tokens`);

  if (tokens > COMPACT_AFTER_TOKENS && history.length > KEEP_RECENT_MESSAGES) {
    const older = history.slice(0, history.length - KEEP_RECENT_MESSAGES);
    const summary = await summarize(anthropic, conversation.summary, older);

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

  // 4. Ask the model. The tool runner handles the tool-call loop.
  const lookupOrder = betaZodTool({
    name: 'lookup_order',
    description: 'Look up a Northwind Coffee order by its order number.',
    inputSchema: z.object({
      orderNumber: z.string().describe('The order number, for example NW-1042'),
    }),
    run: async ({ orderNumber }) => {
      const result = await tablesDB.listRows({
        databaseId: DATABASE_ID,
        tableId: ORDERS_TABLE_ID,
        queries: [Query.equal('orderNumber', orderNumber.toUpperCase()), Query.limit(1)],
      });
      if (result.total === 0) {
        return `No order found with number ${orderNumber}.`;
      }
      const order = result.rows[0];
      return JSON.stringify({
        orderNumber: order.orderNumber,
        items: order.items,
        status: order.status,
        expectedDelivery: order.expectedDelivery,
      });
    },
  });

  const system = conversation.summary
    ? `${SYSTEM_PROMPT}\n\nWhat you already know from earlier in this conversation:\n${conversation.summary}`
    : SYSTEM_PROMPT;

  const finalMessage = await anthropic.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 1024,
    system,
    tools: [lookupOrder],
    messages: history.map((row) => ({ role: row.role, content: row.content })),
  });

  const reply = finalMessage.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (!reply) {
    error(`Model returned no text for ${phone} (stop_reason: ${finalMessage.stop_reason})`);
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

  return res.json({ ok: true, tokens, compacted: conversation.summary !== null });
};

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
      data: { phone, summary: null },
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

async function countTokens(anthropic, summary, history) {
  if (history.length === 0) return 0;
  const result = await anthropic.messages.countTokens({
    model: MODEL,
    system: summary ?? undefined,
    messages: history.map((row) => ({ role: row.role, content: row.content })),
  });
  return result.input_tokens;
}

async function summarize(anthropic, previousSummary, rows) {
  const transcript = rows
    .map((row) => `${row.role === 'user' ? 'Customer' : 'Assistant'}: ${row.content}`)
    .join('\n');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system:
      'You maintain a compact memory of a customer support conversation. Merge the existing summary ' +
      'with the new transcript into one plain-text summary under 200 words. Keep names, order numbers, ' +
      'preferences, unresolved questions, and promises made. Drop greetings and small talk.',
    messages: [
      {
        role: 'user',
        content: `Existing summary:\n${previousSummary ?? '(none)'}\n\nNew transcript:\n${transcript}`,
      },
    ],
  });

  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
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
