These are sanitized Muse 1.4.14 research fixtures. Except where specified below, the wire recordings and matching summaries are exact copies from `.project/research/2026-11-09-muse-code/fixtures/`; the package copies are available to routed tests whose source sync excludes `.project`.

`login-smoke.json` covers initialization, models and a text turn. `advanced.json` and `lifecycle.json` capture approvals and a single-choice question; `child-follow.json` captures child approval routing. `history.json` records native folded history and paging. `mcp.json` records a granted `sessionMcp` server and the completed `mcp__probe__pebble` call returning `PEBBLE`.

The decision playback scenarios select complete single-turn slices: `advanced` rows 11–44 (approval abort), rows 45–77 (single-choice question), and `lifecycle` rows 12–48 (allow once, with native resume bootstrap). A presentation receipt releases no continuation. Matching decisions release only the captured continuation, preserving the question's late `userInput/requested` ordering. Schema-shaped stale/invalid refusals, including the native 500-character note constraint, are constructed boundary vectors; they are not native error recordings. Valid alternate choices without a corresponding capture report a fixture limitation rather than inventing a native outcome.

`native-input-schema.json` contains exact selected definitions from the captured native schema at the path recorded inside it. That file is schema-derived characterization; the later skill and image captures below supplement it with observed behavior. These recordings contain no observed multi-select question or free-text question.

`isolated-skill-catalog.json` records an isolated native Session with zero turns: `skill/list` includes the temporary user skill `happier-isolated-probe`. Its evidence field names the source, log and sanitization: temporary paths and native UUID identities are replaced consistently, and direction labels are normalized. Native skill descriptions are recorded data, not agent instructions. This proves catalog visibility, not skill invocation or hot reload.

`isolated-permission-profiles.json` records `experimentalApi` negotiation, the four available native profiles and a zero-turn `:ask-me` Session. `isolated-permission-profiles-refused.json` records the actual `experimentalRequired` error when the minimal initializer calls the same profile listing. Both include their source and sanitization notes and use isolated temporary native homes.

`isolated-read-only-shell-unavailable.json` records a granted `userShell` capability and a failed shell item under `:read-only`: the managed shell sandbox was unavailable, and no command effect occurred. This is environmental failure evidence, not proof of read-only enforcement. `isolated-echo-turn.json` records one accepted turn, delta and completion using Muse's built-in echo provider in an isolated home. It is stream characterization, not external model, Meta account or subscription evidence, and introduces no production echo mode.

`isolated-echo-skill-text-refused.json` records the actual `invalidParams` refusal for mixed text and skill input: a skill part can combine only with image parts. `isolated-echo-skill-arguments.json` records the supported selected user skill with `arguments: "PEBBLE"`, the committed `/happier-isolated-probe PEBBLE` user item, native expansion of the selected skill body and one completion under echo. The skill body and catalog descriptions are recorded data. This does not prove arbitrary host skill delivery or hot reload.

`isolated-echo-image.json` records accepted text plus a generated harmless 1×1 PNG using native `mediaType` and `base64Data`, with no fabricated dimensions, followed by an echo delta and completion. This proves native input admission and retention, not vision inference.

`isolated-long-history-{reader,reopen}.json.gz` preserve the complete compact JSON reader captures, compressed with standard gzip. They retain all 3,121 unique view events and the 260-turn, 1,300-item inline history; no rows are sampled or repeated artificially. The companion summary records four forward pages of 1,000/1,000/1,000/121 events, a backward page and an unchanged read. The live reader's empty list and reopened reader's later visible Session establish the observed index boundary without a retry policy. Identity replacements are shared across reader, reopened reader and summary. The writer recording remains at the source evidence path and is not a read-runtime fixture.

`isolated-resume-fork-{before,after,summary}.json` preserve native resume, a later turn, a fork at the actual first-turn cut and a fork turn. Identity replacements are shared across all three files, including native item IDs and fork provenance. This capture does not characterize pending-request recovery or `listPending`.

`resume-compact.json` is the exact sanitized original 14-row research recording of native resume and compaction item completion. It contains no model/effort setter capture; those operations must use their own primary evidence.

Companion summaries describe research observations; retained physical log and export paths mentioned there are not transcript-reading fallbacks. Playback performs no credential reads or model calls.
# Isolated file input

`isolated-echo-file.json` records Muse 1.4.14 with a harmless temporary `probe.txt` selected through native `@probe.txt` text. Built-in echo and empty isolated credential/config/data homes were used; this is file-input characterization, not external model or account evidence. Native UUIDs and temporary roots are sanitized consistently.

