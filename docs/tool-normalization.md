# Tool Normalization & Rendering (End-to-End)

This document describes the **final, current** tool pipeline in Happier:

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
- **V2 tool payload**: a normalized tool input/result that includes stable tool metadata under `_happy` (and `_raw`).
- **Legacy session**: sessions created before V2 tool normalization was emitted by the CLI.
- **Claude local-control**: sessions where the app mirrors a local terminal transcript and reconstructs tool events client-side.
- **Task / progress event**: a high-level “progress report” emitted by an agent (not always a concrete tool invocation).

---

## Architecture: the tool pipeline

### 1) Provider → backend/protocol

Backends run providers via one of the supported protocols:

- **ACP** (agent control protocol): tool calls/results stream through the ACP engine.
- **Codex MCP** (Codex via MCP): tool calls/results stream via Codex-specific integration.
- **Claude**:
  - **remote**: backend emits structured events over the daemon protocol
  - **local-control**: the app reconstructs tool events from the transcript (no `_happy` metadata)

### Messages: user/assistant/system/developer

Happier stores and transports message roles broadly (user/assistant/system/developer), but the UI does **not** generally render
system/developer messages in the main chat timeline (they are treated as internal instructions / provenance).

Tool normalization focuses on **tool-call/tool-result** and “tool-ish” structured events, not message role rendering.

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

### Shared protocol (single source of truth)

The canonical **V2 tool contract** (tool names + per-tool input/result schemas + `_happy` metadata schema) lives in:

- `packages/protocol/src/tools/v2/*`

Preferred imports:

- `@happier-dev/protocol/tools/v2` (subpath export)
- or `@happier-dev/protocol` (re-exported from root)

This shared package is the place to look if you want to answer: “what is the normalized schema the app expects?”.

If you’re adding a new agent/provider, see:
- `docs/agents-catalog.md` (how to wire a new backend/provider end-to-end)

Important design choices:

- Schemas are intentionally **forward-compatible**:
  - `_happy.canonicalToolName` is a string (not a closed enum), so new tool names can ship before the protocol package updates.
  - Most input/result schemas are permissive (`optional()` + `passthrough()`), because providers drift.
- We avoid dropping events:
  - Production code should prefer “best-effort normalization + preserve `_raw`” over “throw if schema changes”.
  - Schemas are primarily enforced in tests (fixtures + provider harness) to make drift visible and actionable.

### Code locations

- V2 canonicalization + per-tool families:
  - `apps/cli/src/agent/tools/normalization/index.ts`
  - `apps/cli/src/agent/tools/normalization/families/*`
- Entry points where tool events are normalized before sending/storing:
  - `apps/cli/src/api/apiSession.ts` (ACP + Codex MCP paths)

### Canonical tool metadata (`_happy` + `_raw`)

Normalized tool input/results are wrapped with:

- `_happy`: stable metadata used for routing/rendering and debugging
- `_raw`: original provider payload (truncated for safety)

Note: the project is named **Happier**, but the on-the-wire field name remains `_happy` for backward compatibility with older clients.
In code, the metadata schema/type is `ToolHappierMetaV2` (aliased as `ToolHappyMetaV2`).

Example `_happy` fields (non-exhaustive):

- `v`: `2`
- `protocol`: `acp | codex | claude`
- `provider`: provider id string (e.g. `gemini`, `codex`, `opencode`, `claude`, `auggie`)
- `rawToolName`: provider tool name
- `canonicalToolName`: canonical renderer key

### Canonical tool names

Canonical tool names are selected so UI renderers can be provider-agnostic. The mapping lives in:

- `canonicalizeToolNameV2(...)` in `apps/cli/src/agent/tools/normalization/index.ts`

Per-tool normalization is implemented in `families/*` (intention-based groupings like search/tools, file edits, etc.).

---

## CLI: tool tracing + fixtures

Tool tracing captures real provider payloads as JSONL so we can curate fixtures and prevent regressions.

### Enable tracing

Stack-scoped env vars:

- `HAPPIER_STACK_TOOL_TRACE=1`

Optional overrides:

- `HAPPIER_STACK_TOOL_TRACE_DIR=/path/to/dir` (defaults to `$HAPPIER_HOME_DIR/tool-traces`)
- `HAPPIER_STACK_TOOL_TRACE_FILE=/path/to/file.jsonl` (forces a single file)

Implementation:

- `apps/cli/src/agent/tools/trace/toolTrace.ts`

### Curated fixtures (v1)

Committed fixtures:

- `apps/cli/src/agent/tools/normalization/__fixtures__/tool-trace-fixtures.v1.json`

Allowlist (the “what do we keep?” control):

- `apps/cli/scripts/tool-trace-fixtures.v1.allowlist.txt`

Fixture generation script:

- `apps/cli/scripts/tool-trace-fixtures-v1.ts`

Run (from repo root):

```bash
cd apps/cli
yarn tool:trace:fixtures:v1 --stack <stack> --write
```

### Tests

The drift regression suite is fixture-driven:

- `apps/cli/src/agent/tools/normalization/fixtures.v1.test.ts`
- `apps/cli/src/agent/tools/normalization/index.test.ts`
- `apps/cli/src/agent/tools/trace/toolTraceFixturesAllowlist.test.ts`

What fixtures assert (high level):

- The fixtures file contains real “raw” tool-trace events we’ve curated as representative.
- Tests run the CLI normalizers over those raw events and assert:
  - the canonical tool name chosen for each tool-call/tool-result
  - that `_happy` metadata is present and correct
  - that key normalization behaviors exist (e.g. execute→Bash, tool-result error extraction, etc.)

Fixtures are not a brittle “exact output snapshot” of every field; they are a drift detector paired with targeted invariants.

Run via `happys`:

```bash
happys stack test <stack> happy-cli
```

### Provider contract baselines (optional, e2e-style)

In addition to unit/fixture tests inside `apps/cli`, the provider contract runner in `packages/tests` can validate that:

- the **set of observed fixture keys** matches an expected baseline for a scenario
- the **shape** (structure) of representative payloads does not drift unexpectedly
- extracted fixtures include V2 `_happy` metadata and match shared protocol schemas where applicable

Key locations:

- Baselines: `packages/tests/baselines/providers/<provider>/<scenario>.json`
- Baseline diff logic: `packages/tests/src/testkit/providers/baselines.ts`
- Provider runner: `packages/tests/src/testkit/providers/harness.ts`
- Schema validation: `packages/tests/src/testkit/providers/validateToolSchemas.ts`

These tests compare **shapes**, not full values, to avoid brittle failures on dynamic content.

Strictness controls:

- By default, **extra observed fixture keys** do not fail (forward-compatible). Missing baselined keys still fail.
- To fail on extra keys as well, set `HAPPY_E2E_PROVIDER_STRICT_KEYS=1`.

---

## App: rendering + fallback normalization

### Tool renderers

The app uses **one renderer per canonical tool name**, registered in:

- `apps/ui/sources/components/tools/views/_registry.tsx`

The timeline tool card renderer:

- `apps/ui/sources/components/tools/ToolView.tsx`

The full tool view (always uses the same renderer with `detailLevel="full"` when available):

- `apps/ui/sources/components/tools/ToolFullView.tsx`

### Detail levels + user preferences

Tool cards support multiple levels:

- `title`: header only (no tool body)
- `summary`: compact body
- `full`: expanded in-place body (when supported by the tool view)

Additionally, `ToolFullView` supports an optional debug/raw view toggle controlled by:

- `toolViewShowDebugByDefault`

Preferences are synced per-user in:

- `apps/ui/sources/sync/settings.ts`

Relevant keys:

- `toolViewDetailLevelDefault`
- `toolViewDetailLevelDefaultLocalControl`
- `toolViewDetailLevelByToolName`
- `toolViewExpandedDetailLevelDefault`
- `toolViewExpandedDetailLevelByToolName`
- `toolViewTapAction` (`expand | open`)

### Fallback normalization for rendering (legacy + Claude local-control)

When `_happy.canonicalToolName` is missing, the app normalizes tool calls for rendering via:

- `apps/ui/sources/components/tools/utils/normalizeToolCallForRendering.ts`
- helpers in `apps/ui/sources/components/tools/utils/normalize/*`

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

- `apps/ui/sources/sync/typesRaw/schemas.ts` (accepts/transforms tool formats)
- `apps/ui/sources/sync/typesRaw/normalize.ts` (canonicalizes tool_use/tool_result blocks)

These reconstructed tools then flow into the same UI pipeline and render via the same registry + views.

---

## Tools vs Tasks (why they differ)

In Happier, **tools** and **tasks** are related but not identical concepts:

- **Tool**: “A concrete action the agent asked the runtime to perform.”
  - Examples: run a shell command, read a file, apply a patch, search the repo.
  - Tools have an input and (usually) a result.
  - Tools are primarily what the tool normalization pipeline targets.

- **Task / progress**: “A higher-level progress report or structured step.”
  - Examples: “enter plan mode”, “exit plan mode”, or an agent emitting progress updates.
  - Tasks may be hierarchical conceptually, but today the system does not enforce a universal, cross-provider Task object.

Current state:

- Many “task-like” things are represented as **tool-ish structured events** (e.g. `EnterPlanMode`, `AskUserQuestion`).
- The `Task` canonical tool name is used for provider/task APIs that are tool-call/tool-result shaped (when the provider exposes them that way).

This keeps the pipeline coherent (everything renders through one tool registry) while leaving room to introduce a future, universal Task model if needed.

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
