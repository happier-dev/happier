# Telegram Session Bridge

This repository now includes a **built-in channel bridge core** plus a **Telegram adapter**.

- Core worker: `apps/cli/src/channels/core/channelBridgeWorker.ts`
- Telegram adapter: `apps/cli/src/channels/providers/telegram/telegramAdapter.ts`
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
- Inbound forwarding policy is configured **per binding** at attach-time:
  - Default is **owner-only** (only the user who ran `/attach` can forward messages into the session from that conversation).
  - Use `/attach ... --anyone` to allow any member of a shared chat/topic to forward messages (only recommended for fully-trusted chats).
  - If sender identity is missing, `/attach` and forwarding are **denied by default** (safe-by-default). You can override with `--allow-missing-sender-id` (unsafe).

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
2. `settings.json` bridge config (local, scoped by `serverId` + `accountId`, includes secrets)
3. `settings.json` bridge config (local, scoped by `serverId`)
4. `settings.json` bridge config (local, global defaults)
5. built-in defaults

`allowedChatIds` behavior:

- `[]` (empty list) = **DM-only** (shared chats are blocked by default).
- non-empty list = allow only those shared chat IDs.
- to allow *all* shared chats (unsafe), set `allowAllSharedChats=true` (CLI: `--allow-all` or `--allow-all-shared-chats true`).

## Secret Handling Policy (for all adapters)

- In v1, bridge configuration is **local-only** (settings/env).
- Store secrets only in:
  - local scoped `settings.json` (`providers.<adapter>.secrets.*`), or
  - process env vars (`HAPPIER_*`).
- Do not assume any server-side shared bridge config exists (even for non-secret fields).

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

## Feature gating (experimental)

Channel bridges are gated in three places:

- Server feature gates: `channelBridges` and `channelBridges.telegram` must be enabled in `/v1/features` (server env/build policy can hard-disable them).
- Local experimental opt-in: users must enable the `Channel bridges` experimental toggle in Settings → Features → Experimental options.
- Daemon runtime: the daemon starts the worker only when both the server gates are enabled and the local toggle is enabled.

Note: `happier bridge telegram set ...` automatically enables the local experimental toggle (`channelBridges`).

Server env keys (v1):
- `HAPPIER_FEATURE_CHANNEL_BRIDGES__ENABLED=0|1`
- `HAPPIER_FEATURE_CHANNEL_BRIDGES_TELEGRAM__ENABLED=0|1`

## Environment Variables (daemon process env)

Set these on the daemon process to override `settings.json` (or to run env-only). Environment variables are read directly from `process.env` (there is no automatic `.env.local` loading for the CLI/daemon).

```bash
HAPPIER_TELEGRAM_BOT_TOKEN=<bot-token>

# Optional hardening:
HAPPIER_TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890,-10055555555
HAPPIER_TELEGRAM_ALLOW_ALL_SHARED_CHATS=0
HAPPIER_TELEGRAM_REQUIRE_TOPICS=1

# Bridge tick cadence (ms)
HAPPIER_CHANNEL_BRIDGE_TICK_MS=2500
```

## CLI Management (account-scoped)

Use the bridge CLI to manage Telegram config for the active `serverId + accountId` scope:

- `telegram set`
  - writes full config (including secrets) to local scoped `settings.json`
- `telegram clear` clears local scoped `settings.json`
- `bridge list` prints scoped local config and effective runtime resolution

```bash
happier bridge list

happier bridge telegram set \
  --bot-token <bot-token> \
  --allow-all \
  --require-topics true \
  --tick-ms 2500

# webhook relay configuration (polling is default)
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

`happier doctor` aggregates critical failures and sets the final diagnosis line accordingly:

- final line is `✅ Doctor diagnosis complete!` only when no critical failures are found
- final line is `❌ Doctor diagnosis complete!` if any critical failure is detected

Telegram bridge example:

- if Telegram bridge is configured but bot token is missing, doctor prints a red bridge error and the final line is `❌`
- if `webhook.enabled=true` and `secrets.webhookSecret` (or `HAPPIER_TELEGRAM_WEBHOOK_SECRET`) is empty, doctor prints a critical bridge error and the final line is `❌`

## Webhook Setup (daemon relay mode)

By default the adapter polls `getUpdates`.

If you prefer webhooks, enable the built-in relay in the daemon:

```bash
HAPPIER_TELEGRAM_WEBHOOK_ENABLED=1
HAPPIER_TELEGRAM_WEBHOOK_SECRET=<random-secret-token>
HAPPIER_TELEGRAM_WEBHOOK_HOST=127.0.0.1
HAPPIER_TELEGRAM_WEBHOOK_PORT=8787
```

`HAPPIER_TELEGRAM_WEBHOOK_SECRET` is used for Telegram `secret_token` header validation (`X-Telegram-Bot-Api-Secret-Token`).
The token must match Telegram’s webhook `secret_token` constraints: `[A-Za-z0-9_-]` and a max length of 256 characters.

The webhook endpoint path is fixed (`POST /telegram/webhook`) and does not include any secrets.

In daemon-relay mode, Telegram must call a public URL that forwards to the daemon relay (loopback-only).
If you do not have an inbound public endpoint/tunnel to the daemon, use polling mode (`getUpdates`).

Expose/proxy this daemon endpoint publicly:

```text
POST /telegram/webhook
```

Example:

```text
https://your-public-host/telegram/webhook
  -> http://127.0.0.1:8787/telegram/webhook
```

Set Telegram webhook:

```bash
# Recommended: use a POST body so the secret does not end up in URLs (shell history, proxy logs, etc.)
curl -X POST "https://api.telegram.org/bot<token>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-public-host/telegram/webhook","secret_token":"<secret>"}'
```

Use a high-entropy random value and avoid sharing/logging webhook secrets.
Ensure your public reverse proxy/tunnel forwards the `X-Telegram-Bot-Api-Secret-Token` header unchanged to the daemon relay.

If you switch back to polling mode, clear webhook first:

```bash
curl "https://api.telegram.org/bot<token>/deleteWebhook"
```

## Telegram Commands (inside DM/topic)

- `/help` — command list
- `/sessions` — list active Happier sessions
- `/attach <session-id-or-prefix> [--anyone] [--allow-missing-sender-id]` — bind current DM/topic to a session
- `/session` — show current binding
- `/detach` — remove binding

After `/attach`, normal messages in that DM/topic are forwarded into the mapped session, and agent replies flow back into that same DM/topic.

Authorization notes:
- By default, inbound forwarding is **owner-only** (the user who attached the conversation).
- In shared chats, other users who try to send messages will receive a denial reply (and the message will not be forwarded).
- `--anyone` opts a binding into allowing messages from any sender in that conversation.
- `--allow-missing-sender-id` disables sender-based safety checks for that binding (unsafe; only use if the platform/conversation does not provide stable sender identities).

## Extending Beyond Telegram

To add another provider, implement the same adapter shape used by Telegram:

- inbound pull method
- outbound send method
- provider id + conversation/thread identifiers

No session pipeline logic needs to be duplicated; the core bridge worker handles command routing, binding state, and session forwarding.
