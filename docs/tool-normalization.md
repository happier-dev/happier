# Tool Normalization & Rendering (End-to-End)

This document describes the **final, current** tool pipeline in Happy:

- how tool calls/results are captured from providers
- how the CLI normalizes tool payloads into canonical shapes (V2)
- how the app renders those tools consistently (including legacy sessions + Claude local-control)
- how to capture traces, curate fixtures, and update the normalization safely when providers drift

It is written for developers working on **tool reliability and UX** (not for historical context).

---

## Goals

- Provide stable, renderer-friendly tool shapes across providers and protocols.
- Preserve raw provider payloads for debugging without leaking provider-specific shapes into the UI.
- Make provider drift visible and easy to update via trace + fixture-driven regression tests.
- Keep tool rendering configurable (title/summary/full + optional debug/raw view) without branching per provider.

---

## Glossary

- **Tool call**: a request from the model to run a tool (e.g. `Read`, `Bash`, `Patch`).
- **Tool result**: the output from running that tool.
- **Canonical tool name**: the UI renderer key (e.g. `Read`, `Bash`, `Patch`, `TodoWrite`).
- **V2 tool payload**: a normalized tool input/result that includes `_happy` metadata (and `_raw`).
- **Legacy session**: sessions created before V2 tool normalization was emitted by the CLI.
- **Claude local-control**: sessions where the app mirrors a local terminal transcript and reconstructs tool events client-side.

---

## Architecture: the tool pipeline

### 1) Provider → backend/protocol

Backends run providers via one of the supported protocols:

- **ACP** (agent control protocol): tool calls/results stream through the ACP engine.
- **Codex MCP** (Codex via MCP): tool calls/results stream via Codex-specific integration.
- **Claude**:
  - **remote**: backend emits structured events over the daemon protocol
  - **local-control**: the app reconstructs tool events from the transcript (no `_happy` metadata)

### 2) CLI boundary normalization (V2)

At the **CLI boundary** (before events become “session messages”), tool calls/results are normalized into V2:

- tool name is canonicalized (`canonicalToolName`)
- tool input/result is normalized into a stable shape suitable for rendering
- `_raw` is preserved for debugging

This is the **preferred** normalization path.

### 3) App rendering normalization (fallback)

The app prefers V2 (`_happy.canonicalToolName`) when present. For sessions without `_happy` metadata (legacy + Claude local-control),
the app applies a **rendering-only normalization** to infer a canonical tool name and coerce a minimal render-friendly input/result.

This is intentionally narrower than CLI normalization: it exists to keep older data renderable.

---

## CLI: tool normalization (V2)

### Code locations

- V2 canonicalization + per-tool families:
  - `packages/happy-cli/src/agent/tools/normalization/index.ts`
  - `packages/happy-cli/src/agent/tools/normalization/families/*`
  - `packages/happy-cli/src/agent/tools/normalization/types.ts`
- Entry points where tool events are normalized before sending/storing:
  - `packages/happy-cli/src/api/apiSession.ts` (ACP + Codex MCP paths)

### Canonical tool metadata (`_happy` + `_raw`)

Normalized tool input/results are wrapped with:

- `_happy`: stable metadata used for routing/rendering and debugging
- `_raw`: original provider payload (truncated for safety)

Example `_happy` fields (non-exhaustive):

- `v`: `2`
- `protocol`: `acp | codex | claude`
- `provider`: provider id string (e.g. `gemini`, `codex`, `opencode`, `claude`, `auggie`)
- `rawToolName`: provider tool name
- `canonicalToolName`: canonical renderer key

### Canonical tool names

Canonical tool names are selected so UI renderers can be provider-agnostic. The mapping lives in:

- `canonicalizeToolNameV2(...)` in `packages/happy-cli/src/agent/tools/normalization/index.ts`

Per-tool normalization is implemented in `families/*` (intention-based groupings like search/tools, file edits, etc.).

---

## CLI: tool tracing + fixtures

Tool tracing captures real provider payloads as JSONL so we can curate fixtures and prevent regressions.

### Enable tracing

Stack-scoped env vars:

- `HAPPY_STACKS_TOOL_TRACE=1`

Optional overrides:

- `HAPPY_STACKS_TOOL_TRACE_DIR=/path/to/dir` (defaults to `$HAPPY_HOME_DIR/tool-traces`)
- `HAPPY_STACKS_TOOL_TRACE_FILE=/path/to/file.jsonl` (forces a single file)

Implementation:

- `packages/happy-cli/src/agent/tools/trace/toolTrace.ts`

### Curated fixtures (v1)

Committed fixtures:

- `packages/happy-cli/src/agent/tools/normalization/__fixtures__/tool-trace-fixtures.v1.json`

Allowlist (the “what do we keep?” control):

- `packages/happy-cli/scripts/tool-trace-fixtures.v1.allowlist.txt`

Fixture generation script:

- `packages/happy-cli/scripts/tool-trace-fixtures-v1.ts`

Run (from repo root):

```bash
cd packages/happy-cli
yarn tool:trace:fixtures:v1 --stack <stack> --write
```

### Tests

The drift regression suite is fixture-driven:

- `packages/happy-cli/src/agent/tools/normalization/fixtures.v1.test.ts`
- `packages/happy-cli/src/agent/tools/normalization/index.test.ts`
- `packages/happy-cli/src/agent/tools/trace/toolTraceFixturesAllowlist.test.ts`

Run via Happy Stacks:

```bash
happys stack test <stack> happy-cli
```

---

## App: rendering + fallback normalization

### Tool renderers

The app uses **one renderer per canonical tool name**, registered in:

- `packages/happy-app/sources/components/tools/views/_registry.tsx`

The timeline tool card renderer:

- `packages/happy-app/sources/components/tools/ToolView.tsx`

The full tool view (always uses the same renderer with `detailLevel="full"` when available):

- `packages/happy-app/sources/components/tools/ToolFullView.tsx`

### Detail levels + user preferences

Tool cards support multiple levels:

- `title`: header only (no tool body)
- `summary`: compact body
- `full`: expanded in-place body (when supported by the tool view)

Additionally, `ToolFullView` supports an optional debug/raw view toggle controlled by:

- `toolViewShowDebugByDefault`

Preferences are synced per-user in:

- `packages/happy-app/sources/sync/settings.ts`

Relevant keys:

- `toolViewDetailLevelDefault`
- `toolViewDetailLevelDefaultLocalControl`
- `toolViewDetailLevelByToolName`
- `toolViewExpandedDetailLevelDefault`
- `toolViewExpandedDetailLevelByToolName`
- `toolViewTapAction` (`expand | open`)

### Fallback normalization for rendering (legacy + Claude local-control)

When `_happy.canonicalToolName` is missing, the app normalizes tool calls for rendering via:

- `packages/happy-app/sources/components/tools/utils/normalizeToolCallForRendering.ts`
- helpers in `packages/happy-app/sources/components/tools/utils/normalize/*`

This normalization:

- infers a canonical tool name for renderer routing
- coerces common legacy aliases into a stable renderable shape
- keeps the original raw values in `tool.input`/`tool.result` when possible (no data loss)

This path covers two cases:

1) **Legacy sessions** (pre V2 CLI normalization)
2) **Claude local-control** reconstructed tools (transcript-derived; no `_happy` metadata)

---

## Claude local-control: reconstructing tool events

Claude local-control sessions reconstruct tool events from the transcript and normalize them into the app’s raw message schema.

Key files:

- `packages/happy-app/sources/sync/typesRaw/schemas.ts` (accepts/transforms tool formats)
- `packages/happy-app/sources/sync/typesRaw/normalize.ts` (canonicalizes tool_use/tool_result blocks)

These reconstructed tools then flow into the same UI pipeline and render via the same registry + views.

---

## Updating normalization when providers drift

When a provider changes tool shapes, the recommended workflow is:

1) Enable tool tracing and reproduce the tool calls.
2) Curate fixture keys (edit allowlist).
3) Regenerate fixtures.
4) Update CLI normalization (`families/*` + canonical name mapping) and add/adjust tests.
5) Ensure the app still renders legacy + Claude local-control sessions (fallback normalization should remain conservative).
6) Run stack-scoped tests:
   - `happys stack test <stack> happy-cli`
   - `happys stack test <stack> happy` (app test suite)

The canonical rule:

- Prefer fixing drift in **CLI V2 normalization**.
- Only extend the app fallback normalization when you must keep older stored shapes renderable.
