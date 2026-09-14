import { Client, Functions, ID, TablesDB } from 'node-appwrite';

const DATABASE_ID = process.env.DATABASE_ID;
const MESSAGES_TABLE_ID = 'messages';

export default async ({ req, res, log, error }) => {
  // Meta calls this once with a GET when you save the webhook URL.
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.text(challenge);
    }
    return res.text('Forbidden', 403);
  }

  // Every inbound message, delivery receipt, and read receipt arrives as a POST.
  const change = req.bodyJson?.entry?.[0]?.changes?.[0]?.value;
  const message = change?.messages?.[0];

  if (!message || message.type !== 'text') {
    return res.json({ ok: true, skipped: true });
  }

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] ?? '');

  const tablesDB = new TablesDB(client);
  const functions = new Functions(client);

  try {
    await tablesDB.createRow({
      databaseId: DATABASE_ID,
      tableId: MESSAGES_TABLE_ID,
      rowId: ID.unique(),
      data: {
        phone: message.from,
        role: 'user',
        content: message.text.body,
        wamid: message.id,
        compacted: false,
      },
    });
  } catch (err) {
    // Meta retries deliveries it did not get a 200 for. The unique index on
    // wamid turns a retry into a conflict, so we acknowledge and stop here.
    if (err.code === 409) {
      log(`Duplicate delivery for ${message.id}, ignoring`);
      return res.json({ ok: true, duplicate: true });
    }
    error(err.message);
    throw err;
  }

  await functions.createExecution({
    functionId: process.env.AGENT_FUNCTION_ID,
    body: JSON.stringify({ phone: message.from }),
    async: true,
  });

  return res.json({ ok: true });
};
