# Channel Bridge UAT (Single Account, Multi-Machine)

This checklist validates that one Happier account can use multiple machines + Telegram bridge without cross-account bleed.

## 1) Start from clean local state (test env)

- Use a fresh test home per run:

```bash
export HAPPIER_HOME_DIR="$(mktemp -d /tmp/happier-uat-XXXXXX)"
```

- Stop daemon: `happier daemon stop`
- Remove stale local settings if present: `rm -f "$HAPPIER_HOME_DIR/settings.json"`
- Confirm active server: `happier server list`
- Start daemon: `happier daemon start`

## 2) Register primary machine + account

- Open Web UI for active server.
- Create account (or login with existing account secret key).
- Verify account id in UI/CLI matches expected scope.

## 3) Configure Telegram bridge for this account

- Configure bridge from CLI:

```bash
happier bridge telegram set \
  --bot-token <token> \
  --allow-all \
  --require-topics true
```

- Verify persisted state:

```bash
happier bridge list
```

Expected:
- `Telegram (scoped settings.json)` shows `configured: yes`
- `Telegram (effective runtime: env > settings.json)` shows configured token/topic policy

## 4) Restart daemon and verify bridge worker startup

```bash
happier daemon stop && happier daemon start
happier doctor
```

Expected:
- Channel bridge section shows configured state.
- No crash loop in daemon logs.
- Final diagnosis line matches overall health:
  - `✅ Doctor diagnosis complete!` when no critical failures
  - `❌ Doctor diagnosis complete!` when any critical failure exists (for example, Telegram bridge configured but bot token missing)

## 5) Session bind + bi-direction test from Telegram

- In Happier, create a new session and copy session id.
- In Telegram chat/topic with bot:
  - `/sessions`
  - `/attach <session-id-or-prefix>`
  - send: `bridge-e2e-ok`
- In Happier session, confirm message appears.
- Send reply in Happier session, confirm it appears back in same Telegram thread/topic.

## 6) Add second machine to same account

- Open a second browser/device.
- Use **Login with mobile app** → **Restore with Secret Key Instead**.
- Authenticate into same account.

Expected:
- Same account id.
- Existing sessions are visible/resumable (subject to agent backend credentials).
- Bridge config + bindings are local-only in v1: configure the bridge on the second machine too (or copy scoped `settings.json`), and attach the Telegram conversation again via `/attach`.

## 7) Isolation check (optional second account)

- Create another account on same server.
- Configure a different Telegram bot/chat allowlist.

Expected:
- No cross-account session visibility.
- No cross-account channel binding behavior.

## 8) Failure-mode checks

- Set `allowedChatIds` to a different chat and verify current chat is blocked.
- Revert to `--allow-all` and verify chat works again.
- In a shared chat/topic, validate inbound authorization:
  - User A runs `/attach <session-id>` (default owner-only).
  - User B sends a normal message and verify the bot replies with an authorization error and does **not** forward into the session.
  - User A runs `/attach <session-id> --anyone`, then User B sends a message again and verify it **is** forwarded.
- If using webhook mode, verify secret mismatch returns a non-200 response:
  - `404` when the URL path is wrong (route mismatch)
  - `401` when `X-Telegram-Bot-Api-Secret-Token` is missing/invalid

## Notes

- `allowedChatIds: []` means **DM-only** (shared chats are blocked by default unless `allowAllSharedChats=true`).
- Runtime precedence is: `HAPPIER_* env` > `settings.json` > defaults.
- Secrets (bot/API tokens) stay local-only (`settings.json`/env).
