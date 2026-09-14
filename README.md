# WhatsApp AI agent on Appwrite

A WhatsApp support agent built with two Appwrite Functions and TablesDB. The agent keeps
per-customer chat history, compacts old history into a running summary once it grows past a
token threshold, and calls a tool to look up orders.

## Layout

| Path | Purpose |
| --- | --- |
| `functions/whatsapp-webhook` | Receives Meta webhooks, verifies the handshake, stores inbound messages, triggers the agent |
| `functions/whatsapp-agent` | Loads history, compacts it when needed, calls the model with a tool, sends the reply over WhatsApp |
| `appwrite.config.json` | Tables, columns, indexes, and both functions for `appwrite push` |

## Setup

1. Create an Appwrite project and a TablesDB database. Put the database ID in `appwrite.config.json`.
2. `appwrite push tables` then `appwrite push functions`.
3. Set these environment variables in the Console:

| Function | Variable | Value |
| --- | --- | --- |
| both | `DATABASE_ID` | your database ID |
| whatsapp-webhook | `AGENT_FUNCTION_ID` | `whatsapp-agent` |
| whatsapp-webhook | `WHATSAPP_VERIFY_TOKEN` | any random string, also pasted into Meta |
| whatsapp-agent | `WHATSAPP_PHONE_NUMBER_ID` | from the Meta app's WhatsApp setup page |
| whatsapp-agent | `WHATSAPP_TOKEN` | the WhatsApp access token |
| whatsapp-agent | `OPENAI_API_KEY` | your OpenAI API key |
| whatsapp-agent | `OPENAI_MODEL` | optional, default `gpt-5.6-luna` |
| whatsapp-agent | `COMPACT_AFTER_TOKENS` | optional, default 1500 |

4. In the Meta app, point the WhatsApp webhook at the webhook function's domain and subscribe to the `messages` field.
5. Add a few rows to the `orders` table and message the test number.
