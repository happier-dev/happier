# Happier Session Control (CLI JSON)

This skill enables an agent framework (for example OpenClaw) to control Happier sessions using the **existing** `happier` CLI in `--json` mode.

## Prerequisites

- The `happier` CLI is installed and authenticated (`happier auth status`).
- If using multiple servers/profiles, pass server selection flags **before** `session`:
  - `happier --server <profile-id-or-name> session list --json`
  - `happier --server-url <url> --webapp-url <url> session list --json`

## Contract

All JSON outputs are a pure-stdout envelope:

```json
{ "v": 1, "ok": true, "kind": "...", "data": {} }
```

or:

```json
{ "v": 1, "ok": false, "kind": "...", "error": { "code": "..." } }
```

## Session Commands

List sessions:

```bash
happier session list --json
```

Inspect session status:

```bash
happier session status <session-id-or-prefix> --json
```

Create/load a session by tag:

```bash
happier session create --tag <tag> --json
```

Send a message to a session:

```bash
happier session send <session-id-or-prefix> "<message>" --json
```

Wait for a session to become idle:

```bash
happier session wait <session-id-or-prefix> --timeout 300 --json
```

Stop a session:

```bash
happier session stop <session-id-or-prefix> --json
```

Read session history:

```bash
happier session history <session-id-or-prefix> --limit 50 --format compact --json
```

## Execution Run Commands

Start an execution run:

```bash
happier session run start <session-id-or-prefix> --intent review --backend claude --json
```

List runs for a session:

```bash
happier session run list <session-id-or-prefix> --json
```

Get a run:

```bash
happier session run get <session-id-or-prefix> <run-id> --include-structured --json
```

Send input to a run:

```bash
happier session run send <session-id-or-prefix> <run-id> "<message>" --json
```

Stop a run:

```bash
happier session run stop <session-id-or-prefix> <run-id> --json
```

Execute an action on a run:

```bash
happier session run action <session-id-or-prefix> <run-id> <action-id> --input-json '<json>' --json
```

Wait for a run to finish:

```bash
happier session run wait <session-id-or-prefix> <run-id> --timeout 300 --json
```

## Server Commands (JSON)

List server profiles:

```bash
happier server list --json
```

Current active server:

```bash
happier server current --json
```

