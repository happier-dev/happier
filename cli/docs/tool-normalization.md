# Tool Normalization (CLI)

This document describes the **current** tool normalization + tracing + fixtures workflow implemented in `happy-cli`.

It is intended for developers who:
- add support for new tools or tool variants
- improve tool rendering reliability (by making tool input/output schemas stable)
- refresh fixtures when providers evolve

## Goals

- Emit **canonical** tool-call and tool-result shapes (V2) across providers/protocols.
- Preserve the raw provider payloads for debugging while keeping render-friendly fields stable.
- Catch provider drift via a small, curated, fixture-driven regression suite.

## Where the code lives

- Tool normalization (V2 canonicalization)
  - `cli/src/agent/tools/normalization/index.ts`
  - `cli/src/agent/tools/normalization/families/*`
  - `cli/src/agent/tools/normalization/types.ts`
- Tool tracing (JSONL recorder + fixtures extraction)
  - `cli/src/agent/tools/trace/toolTrace.ts`
  - `cli/src/agent/tools/trace/curateToolTraceFixtures.ts`
  - `cli/scripts/tool-trace-fixtures-v1.ts`
  - `cli/scripts/tool-trace-fixtures.v1.allowlist.txt`
- Tests (drift prevention)
  - `cli/src/agent/tools/normalization/fixtures.v1.test.ts`
  - `cli/src/agent/tools/trace/toolTraceFixturesAllowlist.test.ts`

## Canonical tool metadata (`_happy` + `_raw`)

When the CLI emits a normalized tool event, the normalized input/result is wrapped with:

- `_happy` (V2): stable metadata used for routing/rendering and debugging
- `_raw`: the original provider payload, truncated for safety

Example `_happy` fields (not exhaustive):
- `v`: `2`
- `protocol`: `acp | codex | claude | cloud`
- `provider`: provider id string (e.g. `gemini`, `codex`, `opencode`, `claude`, `auggie`)
- `rawToolName`: the provider’s tool name
- `canonicalToolName`: the CLI’s canonical tool name (renderer key)

## Canonical tool names

Canonical tool names are chosen so UI renderers can be provider-agnostic.

The mapping is implemented by:
- `canonicalizeToolNameV2(...)` in `cli/src/agent/tools/normalization/index.ts`

If you introduce a new tool name or a provider-specific alias, update `canonicalizeToolNameV2` and add a test in:
- `cli/src/agent/tools/normalization/index.test.ts`

## Normalization entrypoints

The core API used by provider/protocol adapters:

- `normalizeToolCallV2({ protocol, provider, toolName, rawInput, callId? })`
  - returns `{ canonicalToolName, input }` where `input` contains `_happy` + `_raw`
- `normalizeToolResultV2({ protocol, provider, rawToolName, canonicalToolName, rawOutput })`
  - returns a normalized output object with `_happy` + `_raw`

Per-tool logic lives in `cli/src/agent/tools/normalization/families/*`. Keep those files small and intention-based
(e.g. `search.ts` covers `Glob`/`Grep`/`CodeSearch`/`LS`), rather than protocol-based.

Some providers return “summary-only” results for certain tools (notably Gemini ACP’s `glob` / `search`), e.g. content blocks like
`Found N matches` without file lists. In those cases we still normalize into a minimal renderable shape so the UI can show
something (while keeping `_raw` for debugging), even if the provider didn’t return full detail.

## Tool tracing (capturing real provider payloads)

### Enable tracing (stack-scoped)

Set:

- `HAPPY_STACKS_TOOL_TRACE=1`

Optional:
- `HAPPY_STACKS_TOOL_TRACE_DIR=/path/to/dir` (defaults to `$HAPPY_HOME_DIR/tool-traces`)
- `HAPPY_STACKS_TOOL_TRACE_FILE=/path/to/file.jsonl` (forces a single output file)

Tool traces are written as JSONL (one event per line) and are safe to commit **only after** fixture curation (see below).

### Output location

Default stack location:

`~/.happy/stacks/<stack>/cli/tool-traces/*.jsonl`

## Fixtures (how drift is caught)

We keep a small committed fixture set so tests are deterministic and stable.

### The committed fixture

- `cli/src/agent/tools/normalization/__fixtures__/tool-trace-fixtures.v1.json`

This file contains a curated subset of tool trace events, keyed by:

`<protocol>/<provider>/<kind>/<toolName?>`

Notes:
- `tool-result` / `tool-call-result` keys are tool-name-suffixed when possible (e.g. `acp/opencode/tool-result/read`).
- Fixtures are **curated**: we prefer higher-signal examples and cap the count per key.

### The allowlist

- `cli/scripts/tool-trace-fixtures.v1.allowlist.txt`

This is the single “what do we keep?” control.

The allowlist and committed fixture keys are kept in sync by:
- `cli/src/agent/tools/trace/toolTraceFixturesAllowlist.test.ts`

### Regenerating fixtures

From `cli/`:

```bash
yarn tool:trace:fixtures:v1 --stack leeroy-wip --write
```

This:
- reads all trace JSONL files for the stack
- curates examples per allowlisted key
- writes the committed fixture file

If you need to change coverage, edit the allowlist file first, then regenerate.

## Tests: what must pass

The drift regression suite asserts normalization invariants and key transformations:

- `cli/src/agent/tools/normalization/fixtures.v1.test.ts`
- `cli/src/agent/tools/normalization/index.test.ts`
- `cli/src/agent/tools/trace/toolTraceFixturesAllowlist.test.ts`

Run the CLI tests via Happy Stacks (recommended):

```bash
happys stack test <stack> happy-cli
```

## Adding a new tool (workflow)

1) Capture traces that exercise the tool (with tracing enabled).
2) Add fixture keys to `cli/scripts/tool-trace-fixtures.v1.allowlist.txt`.
3) Regenerate fixtures: `yarn tool:trace:fixtures:v1 --write`.
4) Add tests in `cli/src/agent/tools/normalization/index.test.ts` for:
   - canonical name mapping
   - result schema normalization
5) Implement per-tool normalization in `cli/src/agent/tools/normalization/families/*` and wire it in `index.ts`.
6) Run stack-scoped tests: `happys stack test <stack> happy-cli`.

If a provider changes its tool payload shape later, the fixture suite will fail once fixtures are refreshed, which
forces the normalization layer to be updated intentionally.
