# Telegram Session Bridge

This repository now includes a **built-in channel bridge core** plus a **Telegram adapter**.

- Core worker: `apps/cli/src/channels/core/channelBridgeWorker.ts`
- Telegram adapter: `apps/cli/src/channels/telegram/telegramAdapter.ts`
- Runtime wiring: `apps/cli/src/channels/startChannelBridgeWorker.ts`

The design is intentionally modular so additional adapters (Discord, Slack, WhatsApp, etc.) can plug into the same core contract.

For core bridge architecture, ingress mode matrix, and relay deployment model, see [docs/channel-bridge.md](./channel-bridge.md).

## Current Behavior

- Bi-directional flow between Telegram and Happier sessions.
- Conversation-to-session mapping via Telegram commands.
- Mapping key is `(provider, chat_id, topic_thread_id|null)`:
  - **DM** = `thread_id = null`
  - **Topic** = `thread_id = <topic id>`
- Outbound agent replies are forwarded back into the mapped DM/topic.

## BotFather + Telegram Setup

1. Create bot with `@BotFather` (`/newbot`) and copy bot token.
2. In BotFather, disable privacy mode (`/setprivacy` → **Disable**) so group/topic messages are visible.
3. Add bot to your group/supergroup.
4. Promote bot to **admin** in the group so it can read/send in topics.
5. (Recommended) Use a **supergroup with topics** and bind one topic per Happier session.

## Configuration (`settings.json`) + Environment Overrides

You can configure the bridge in `~/.happier/settings.json` (or your `HAPPIER_HOME_DIR/settings.json`), and still use env vars for overrides.

Recommended model: configure bridges per `serverId` + `accountId`, so each account can own its own adapters and credentials.

Example:

```json
{
  "channelBridge": {
    "byServerId": {
      "127.0.0.1-3005": {
        "byAccountId": {
          "cmmb9sp...": {
            "tickMs": 2500,
            "providers": {
              "telegram": {
                "allowedChatIds": ["-1001234567890", "-10055555555"],
                "requireTopics": true,
                "webhook": {
                  "enabled": false,
                  "host": "127.0.0.1",
                  "port": 8787
                },
                "secrets": {
                  "botToken": "<bot-token>",
                  "webhookSecret": "<random-secret-token>"
                }
              }
            }
          }
        }
      }
    }
  }
}
```

Backward compatibility is preserved: root-level `channelBridge.tickMs` and `channelBridge.providers` still work as global defaults.

Precedence is:

1. `HAPPIER_*` environment variables
2. Server KV bridge config (account-authenticated, DB-backed in full deployment, **non-secret only**)
3. `settings.json` bridge config (local scoped fallback, includes secrets)
4. built-in defaults

`allowedChatIds` behavior:

- `[]` (empty list) = allow all chats/topics the bot can read.
- non-empty list = allow only those chat IDs.

## Secret Handling Policy (for all adapters)

- **Never sync secrets to server KV**.
- Store secrets only in:
  - local scoped `settings.json` (`providers.<adapter>.secrets.*`), or
  - process env vars (`HAPPIER_*`).
- Server KV is for non-secret shareable bridge config/state only.

For new adapters (Discord/Slack/WhatsApp/etc), use the same model:

```json
{
  "providers": {
    "adapterName": {
      "...nonSecretFields": true,
      "secrets": {
        "token": "<local-only>",
        "apiKey": "<local-only>"
      }
    }
  }
}
```

## Environment Variables (`.env.local`)

Set these to override `settings.json` or run env-only:

```bash
HAPPIER_TELEGRAM_BOT_TOKEN=<bot-token>

# Optional hardening:
HAPPIER_TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890,-10055555555
HAPPIER_TELEGRAM_REQUIRE_TOPICS=1

# Bridge tick cadence (ms)
HAPPIER_CHANNEL_BRIDGE_TICK_MS=2500
```

## CLI Management (account-scoped)

Use the bridge CLI to manage Telegram config for the active `serverId + accountId` scope:

- `telegram set`
  - writes non-secret fields to server KV
  - writes full config (including secrets) to local scoped `settings.json`
- `telegram clear` clears server KV + local scoped `settings.json`
- `bridge list` prints scoped local config, server KV config, and effective runtime resolution

```bash
happier bridge list

happier bridge telegram set \
  --bot-token <bot-token> \
  --allow-all \
  --require-topics true \
  --tick-ms 2500

# optional webhook relay configuration
happier bridge telegram set \
  --webhook-enabled true \
  --webhook-secret <random-secret-token> \
  --webhook-host 127.0.0.1 \
  --webhook-port 8787

# optional: restrict to specific chats
happier bridge telegram set --allowed-chat-ids -1001234567890,-10022222222

happier bridge telegram clear
```

Then apply changes by restarting daemon:

```bash
happier daemon stop && happier daemon start
```

## Doctor Status Aggregation

`happier doctor` now aggregates critical failures and sets the final diagnosis line accordingly:

- final line is `✅ Doctor diagnosis complete!` only when no critical failures are found
- final line is `❌ Doctor diagnosis complete!` if any critical failure is detected

Telegram bridge example:

- if Telegram bridge is configured but bot token is missing, doctor prints a red bridge error and the final line is `❌`
- if `webhook.enabled=true` and `secrets.webhookSecret` (or `HAPPIER_TELEGRAM_WEBHOOK_SECRET`) is empty, doctor treats it as critical and final line is `❌`
- if `webhook.enabled=true` and `webhook.host` or `webhook.port` is missing/invalid, doctor treats it as critical and final line is `❌`

Generic adapter behavior:

- doctor applies the same webhook-required checks to any channel adapter that configures `webhook.enabled=true`

## Webhook Setup (daemon relay mode)

By default the adapter polls `getUpdates`.

If you prefer webhooks, enable the built-in relay in the daemon:

```bash
HAPPIER_TELEGRAM_WEBHOOK_ENABLED=1
HAPPIER_TELEGRAM_WEBHOOK_SECRET=<random-secret-token>
HAPPIER_TELEGRAM_WEBHOOK_HOST=127.0.0.1
HAPPIER_TELEGRAM_WEBHOOK_PORT=8787
```

`HAPPIER_TELEGRAM_WEBHOOK_SECRET` is currently used for both:

- webhook URL path token (`/telegram/webhook/<token>`)
- Telegram `secret_token` header validation

This is an implementation limitation today (single configured secret) and is weaker than using separate secrets for path and header checks.

Important:

- `HAPPIER_SERVER_URL` is the Telegram callback target only when server-relay mode exists and is enabled (planned, not currently implemented).
- In the currently implemented daemon-relay mode, Telegram must call a public URL that forwards to daemon host/port/path.
- If you do not have inbound public endpoint/tunnel to daemon, use polling mode (`getUpdates`).

Expose/proxy this daemon endpoint publicly:

```text
POST /telegram/webhook/<HAPPIER_TELEGRAM_WEBHOOK_SECRET>
```

Example:

```text
https://your-public-host/telegram/webhook/<secret>
  -> http://127.0.0.1:8787/telegram/webhook/<secret>
```

Set Telegram webhook:

```bash
curl "https://api.telegram.org/bot<token>/setWebhook?url=https://your-public-host/telegram/webhook/<secret>&secret_token=<secret>"
```

Current implementation requires the same `<secret>` value for both webhook URL path token and `secret_token`.
Use a high-entropy random value and avoid sharing/logging webhook URLs.

If you switch back to polling mode, clear webhook first:

```bash
curl "https://api.telegram.org/bot<token>/deleteWebhook"
```

For server-relay and standalone-relay planning details, see [docs/channel-bridge.md](./channel-bridge.md).

## Telegram Commands (inside DM/topic)

- `/help` — command list
- `/sessions` — list active Happier sessions
- `/attach <session-id-or-prefix>` — bind current DM/topic to a session
- `/session` — show current binding
- `/detach` — remove binding

After `/attach`, normal messages in that DM/topic are forwarded into the mapped session, and agent replies flow back into that same DM/topic.

## Extending Beyond Telegram

To add another provider, implement the same adapter shape used by Telegram:

- inbound pull method
- outbound send method
- provider id + conversation/thread identifiers

No session pipeline logic needs to be duplicated; the core bridge worker handles command routing, binding state, and session forwarding.
