<!-- EXTEND: composed-additions -->
## Hapsta Overlay (MANDATORY)

- Do **not** start servers manually (`yarn dev`, `expo`, etc.). The stack lifecycle must be managed by Edison’s `web_server` integration, which should run via `hapsta`.
- Always run validation stack-scoped via the wrapper:
  - `hapsta edison --stack=<stack> -- qa validate <task-id> --execute`
  - Or omit `--stack` when the task/QA id is present and stack auto-inference applies.
- Use the **Web Server URL** printed in the validator prelude as the base URL for browser navigation.
- If the UI stack is unreachable, treat it as **blocked** unless the configured `web_server` profile can start it automatically.

### Auth + machine selection (Happy UI)

- If you see a login screen, **DO NOT click “Create account”**.
  - Creating an account generates a brand-new local keychain that **will not match the stack daemon’s seeded account**,
    and you will typically see **no machines** (making the validator blocked).
  - Treat “Create account” usage as a validation error unless the task explicitly asks for a fresh account.

- Instead, always log in to the seeded dev account:
  - click **“Login with mobile app”**
  - **Preferred (avoid leaking the key into logs)**:
    - copy the restore key to clipboard:
      - `hapsta auth dev-key --print | pbcopy`
    - paste into the restore key field (Cmd+V) and complete login
  - **Fallback (OK for this validator run: this is a development-only test key)**:
    - print the key and paste it:
      - `hapsta auth dev-key --print`
    - Note: this key is intended for local dev automation; it is not treated as a production secret.
    - **Do not mark the validator “blocked” just because the dev key appears in logs/tool output.**
- When starting a session, ensure a **machine is selected** before pressing “Start”.
  - If you get “Please select a machine…”, open the **machine picker** (machine icon/chip) and select the local machine, then retry.
<!-- /EXTEND -->
