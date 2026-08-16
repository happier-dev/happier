---
name: happier-session-control
description: Manage Happier sessions and execution runs through the CLI JSON contract, and create independent Happier diagnosis sessions with explicit ownership, safe options, and fire-and-forget presentation semantics.
metadata: {"openclaw":{"requires":{"bins":["happier"]},"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Session Control (CLI JSON)

This skill enables an agent framework (for example OpenClaw) to control Happier sessions using the **existing** `happier` CLI in `--json` mode.

## Prerequisites

- The `happier` CLI is installed and authenticated.
- If using multiple servers/profiles, pass server selection flags **before** `session` (prefix-only):
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

Common error codes to handle:

- `not_authenticated`: run `happier auth login` on the host (or mount/provide a valid `HAPPIER_HOME_DIR`).
- `session_id_ambiguous`: pick deterministically from `error.candidates` (prefer exact id; otherwise ask the user).
- `session_not_found`: call `happier session list --json` and retry.
- `unsupported`: feature disabled by server policy or backend doesn’t support the requested intent.

## Independent session delegation

Use an independent Happier session only when the user asks for new sessions or when an invoking workflow explicitly selects that topology. Native subagents remain the owner for in-session delegation.

When an independent session owns a complete work bundle:

- create it with a self-contained `initialMessage`, descriptive `title` and `tag`, the intended repository `path`, and only user-selected or safely resolved machine/profile/backend/model options;
- use canonical `read-only` permission mode for diagnosis when the selected backend supports it, plus an explicit no-write constraint in the brief. Permission modes are backend-applied policy, not a universal security sandbox; do not overclaim enforcement;
- treat a successful accepted spawn as the triage lane's completion for that bundle;
- return the new session id/title and allocation to the user, then stop by default;
- let the spawned session present its diagnosis directly to the user;
- do not wait for idle or pull its transcript merely to re-present the same result;
- do not instruct the spawned session to create further independent sessions unless the user explicitly requested recursive orchestration.

Use monitoring only when the user asks the parent to supervise, consolidate, or continue after the child. In that case, `session.wait.idle`, `session.transcript.get`, and `session.message.send` are optional follow-up tools, not part of the default spawn flow.

The Happier MCP action ids are:

- `session.spawn_new` — accepts `initialMessage`, `title`, `tag`, `path`, `machineId`, `profileId`, backend/model selection, and `permissionMode`;
- `session.wait.idle` — optional monitoring;
- `session.transcript.get` — optional transcript retrieval;
- `session.message.send` — optional follow-up or correction.

The MCP binding names are `session_spawn_new`, `session_wait_idle`, `session_transcript_get`, and `session_message_send`. When actions are unavailable, use the corresponding CLI JSON commands below where the needed options are supported, or report the missing capability instead of silently changing topology.

## Auth Commands (JSON)

Check auth status without scraping human output:

```bash
happier auth status --json
```

## Session Commands

List sessions:

```bash
happier session list --json
```

Inspect session status (server snapshot):

```bash
happier session status <session-id-or-prefix> --json
```

Inspect session status with a best-effort live refresh:

```bash
happier session status <session-id-or-prefix> --live --json
```

Create/load a session by tag:

```bash
happier session create --tag <tag> --json
```

Send a message to a session:

```bash
happier session send <session-id-or-prefix> "<message>" --json
```

Send a message and wait until the session is idle:

```bash
happier session send <session-id-or-prefix> "<message>" --wait --timeout 300 --json
```

Wait for a session to become idle:

```bash
happier session wait <session-id-or-prefix> --timeout 300 --json
```

Stop a session:

```bash
happier session stop <session-id-or-prefix> --json
```

Read session history (compact is recommended for prompt stuffing):

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

Stream turn IO for a streaming run (e.g. `intent=voice_agent`):

```bash
happier session run stream-start <session-id-or-prefix> <run-id> "<message>" --json
happier session run stream-read <session-id-or-prefix> <run-id> <stream-id> --cursor 0 --json
happier session run stream-cancel <session-id-or-prefix> <run-id> <stream-id> --json
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

Add a server profile non-interactively:

```bash
happier server add --name "My Server" --server-url https://example.com --webapp-url https://example.com --use --json
```

Switch active server:

```bash
happier server use <id-or-name> --json
```

Remove a server profile:

```bash
happier server remove <id-or-name> --force --json
```

Probe server reachability/version:

```bash
happier server test [<id-or-name>] --json
```

Set a one-off custom server as active:

```bash
happier server set --server-url https://example.com --webapp-url https://example.com --json
```
