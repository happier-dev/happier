# `[Unparsed agent message]` — Root Cause Analysis

**Affected version:** `hdev 0.2.10-dev.12` (and current `dev` source — identical schema)
**Symptom:** Running `happier dev` with Claude **unified terminal mode** surfaces `[Unparsed agent message]` in the UI. Reproduces identically under tmux and zellij (it is a data/schema issue, not a terminal issue).

---

## TL;DR

`TranscriptRawRecordV1Schema` (in `packages/protocol`) has a forward-compatibility trap: the
"unknown output" catch-all schema carries a `.refine()` that **rejects any `type` in the known set**.
So a Claude `assistant` row whose body doesn't match the strict known shape fails **both** the
Known branch *and* the Unknown branch → the whole record fails validation → the UI renders
`[Unparsed agent message]`.

This directly violates the package's own stated design goal
(*"don't drop the whole message if upstream changes"*).

**Fix:** remove the refine so a malformed known-type row falls through to the catch-all.
Well-formed rows are unaffected (`union([Known, Unknown])` tries Known first).

---

## Where the string comes from

`apps/ui/sources/sync/typesRaw/normalize.ts` → `normalizeRawMessage()`:

```ts
const parsed = rawRecordSchema.safeParse(rawInput);
if (!parsed.success) {
    // ...
    const text = role === 'user' ? '[Unparsed user message]' : '[Unparsed agent message]';
    // ...
}
```

So `[Unparsed agent message]` is the placeholder emitted whenever an agent record fails Zod
validation.

## The data flow (Claude unified terminal)

1. Claude writes JSONL transcript rows.
2. `createClaudeUnifiedTranscriptBridge` → `createClaudeSessionTranscriptProjector`
   → `createClaudeRawMessageTurnDiffBridge` forwards each raw row (filtering internals).
3. `sessionClient.sendClaudeSessionMessage(body)` wraps it:
   ```ts
   content = {
     role: 'agent',
     content: { type: 'output', data: body },   // body = raw Claude JSONL row
     meta: { sentFrom: 'cli', source: 'cli', ...meta },
   };
   ```
4. The UI validates that record against `TranscriptRawRecordV1Schema`
   (`data.type` = the Claude row's top-level `type`, e.g. `'assistant'`).

## The bug

`packages/protocol/src/sessionMessages/transcriptRawRecordV1.ts`:

```ts
// Known: discriminated union on data.type.
// The 'assistant' variant REQUIRES `message` with role:'assistant' and array/string content.
const RawAgentOutputDataKnownSchema = z.discriminatedUnion('type', [ /* ... */ ]);

// Unknown: a catch-all — BUT it rejects any type in the known set.
const RawAgentOutputDataUnknownSchema = z.object({ type: z.string() })
  .extend(OutputExtrasShape).passthrough()
  .refine((value) => !KNOWN_OUTPUT_DATA_TYPES.has(value.type as any), {
    message: 'Unknown output type must not collide with known output types',
  })
  .transform((value) => ({ ...value, type: value.type as UnknownOutputDataType }));

const RawAgentOutputDataSchema = z.union([RawAgentOutputDataKnownSchema, RawAgentOutputDataUnknownSchema]);
```

A row with `type: 'assistant'` that doesn't match the strict assistant shape:
- **Known** branch: fails (body doesn't match — e.g. `message` missing).
- **Unknown** branch: fails (refine rejects `'assistant'` because it collides with the known set).
- Result: **entire record fails** → `[Unparsed agent message]`.

The installed `hdev 0.2.10-dev.12` binary ships the **identical** schema (verified against the
bundled `@happier-dev/protocol/dist/sessionMessages/transcriptRawRecordV1.js`).

## Proven via runnable repro

A focused reproduction wrapped realistic Claude JSONL rows exactly as
`sendClaudeSessionMessage` does and ran them through `TranscriptRawRecordV1Schema`.
**3 of 12 realistic shapes failed:**

| Failing shape | When it occurs |
|---|---|
| `assistant` row **without** `message` | synthetic / API-error / interrupted rows (the CLI's own `RawJSONLines` schema marks `message` optional for exactly this reason) |
| `assistant` with `message.role` missing | malformed upstream rows |
| `assistant` with `content: null` | stop-only / usage-only rows |

The other 9 shapes (normal assistant, thinking, `redacted_thinking`, `server_tool_use`, string
content, tool results, etc.) parse fine.

## The fix

Removed the `.refine()` on `RawAgentOutputDataUnknownSchema`. The branded `.transform()` is kept,
so TypeScript narrowing on `data.type === 'assistant'` still works (the branded
`UnknownOutputDataType` is not assignable to the known literals).

```diff
 const RawAgentOutputDataUnknownSchema = z
   .object({ type: z.string() })
   .extend(OutputExtrasShape)
   .passthrough()
-  .refine((value) => !KNOWN_OUTPUT_DATA_TYPES.has(value.type as any), {
-    message: 'Unknown output type must not collide with known output types',
-  })
+  // NOTE: We intentionally do NOT reject known `type` values here.
+  // `RawAgentOutputDataSchema` is `union([Known, Unknown])` with Known tried first,
+  // so well-formed known-type rows still match their rich Known variant. A known-type
+  // row whose body does NOT match (e.g. a Claude `assistant` row missing `message`,
+  // or with `content: null`) falls through to this catch-all instead of failing the
+  // entire record — which would otherwise render as "[Unparsed agent message]" in the
+  // UI. This matches the package's forward-compatibility philosophy.
   .transform((value) => ({ ...value, type: value.type as UnknownOutputDataType }));
```

### Why this is safe

- `z.union([Known, Unknown])` tries Known first → happy-path rows still get their rich Known
  variant (no behavior change; all 43 pre-existing protocol tests still pass).
- For a malformed known-type row: Known fails, Unknown now matches → record parses.
- `normalize.ts`'s existing opaque fallback then renders the row as `[Unsupported agent output]`
  instead of hard-failing as `[Unparsed agent message]`. (`isOutputAssistantData` /
  `isOutputUserData` are proper type guards that return `false` for message-less / null-content
  rows, so there is no crash — the fallthrough is the explicit opaque-output branch.)

### Verification

- All 12 repro shapes now pass.
- All 43 pre-existing `transcriptRawRecordV1.test.ts` tests still pass.
- Added 4 regression tests under `describe('fail-soft malformed assistant/user output payloads')`.

## Design intent cross-check

The refine was introduced by commit `4dd41fcbc "feat(sync): fail-soft transcript normalization"`,
whose stated goal was to make parsing *more* robust. That same commit added a UI test
`normalize.outputInvalidKnownTypeFallback.test.ts` titled *"accepts malformed assistant output
payloads by treating them as unknown output types"* — but that test actually uses `content: 'hello'`
(a **valid** string), so it never exercises the refine. The fail-soft behavior for *genuinely*
malformed known-type rows was therefore **untested and broken**. This fix realizes the commit's
original intent.

## Files changed

| File | Change |
|---|---|
| `packages/protocol/src/sessionMessages/transcriptRawRecordV1.ts` | Removed the colliding `.refine()` on `RawAgentOutputDataUnknownSchema` (kept the branded transform). |
| `packages/protocol/src/sessionMessages/transcriptRawRecordV1.test.ts` | +4 regression tests for malformed `assistant` rows (no `message`, missing `role`, `null` content) plus a no-regression test for well-formed rows. |

## Open caveat

The user-facing server logs use privacy-redacted structure logging (shape only, no values), and
message storage is on the remote backend, so the *exact* failing payload from the reported session
could not be captured to confirm which of the 3 shapes was hit. The **synthetic / API-error
`assistant` row** (no `message`) is the most common real-world trigger. After rebuilding from this
source, the previously-failing rows will surface as `[Unsupported agent output]` instead of
`[Unparsed agent message]`, confirming the fix end-to-end.
