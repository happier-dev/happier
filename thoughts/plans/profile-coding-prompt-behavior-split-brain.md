# Plan: Apply profile coding-prompt behavior override to all prompt-derived surfaces

- **Path:** `thoughts/plans/profile-coding-prompt-behavior-split-brain.md`
- **Status:** `APPROVED` (execution authorized by user in session `cmt10qvi3005r2nzt5i0lubrj`, 2026-08-20)
- **Contract revision:** 1
- **Approval record:** user directive "Execute the plan in @thoughts/plans/profile-coding-prompt-behavior-split-brain.md" (2026-08-20); no amendments
- **Author:** happier pi session `cmt1a777m001h2n7s8eif395p` (diagnosis conversation, 2026-08-20)
- **Relationships:** none (no `Supersedes:`/`Extends:`/`Consumes:`). Related but out of scope: happier-dev/happier#283 (pi extension dialog handling).
- **Evidence basis (2026-08-20, CLI 0.2.10-dev.9001, daemon stable 0.2.10):**
  - Live probe session `cmt1nl6jf00cp2ntv9nsfemrp` ("Reply exactly ok probe", profile "Pi Slim" `d2f28913-c936-4355-885e-6e8e40325268`): creation + two resumes (incl. after `set-model`) — model self-report `1:NO 2:YES` both resumes (options guidance absent, rename guidance present); bridge `change_title` command executed at creation from appendix text.
  - Original session `cmt1a777m001h2n7s8eif395p`: created 15:51 WIB under the same profile, executed the appendix rename command ~15:52.
  - Materialized bridge asset `~/.pi/agent/extensions/happier-pi-tools-bridge/happier-pi-tools-bridge.js` with `RENAME_ENABLED = true` (global mode `ongoing` despite the profile override).

## 1. Intent

**Problem (verified):** A custom profile's `codingPromptBehaviorV1` override is applied only to the *base* blocks of the coding system prompt. Two other surfaces derived from the same decision read **raw global account settings** and ignore the profile override:

1. The tools-delivery prompt appendix (`resolveCodingToolDeliveryBlocks`) — so a profile that disables session-title updates still ships the full rename/"Required first action" guidance text to the model, for every `shell_bridge` agent.
2. The pi tools-bridge backend options (`resolveHappyToolsBridgeBackendOptions`) — so the pi bridge still registers the `change_title` tool (no `--happy-disable-rename`) for that session.

The result is a split-brain: the prompt's base blocks say one thing (no title tooling), while the appendix and the registered tools say the opposite. The model follows the leaked instructions (observed: executed the rename bridge command despite the profile disabling it).

**Target outcome:** One resolved coding-prompt behavior decision per session spawn (global settings merged with the selected profile's override), consumed by **every** surface derived from it: base prompt blocks, tool-delivery appendix, and pi bridge tool registration. The prompt's advertised tools and the bridge's registered tools can never disagree with the base blocks.

**Users/flows:** users running sessions under custom profiles that set `codingPromptBehaviorV1` (sessionTitleUpdates / responseOptions); all `shell_bridge` agents for the appendix half, pi specifically for the bridge half.

**Non-goals (plan-specific exclusions):**
- Do NOT change when/how the prompt is composed. Per-spawn recomposition stays; resume semantics are correct as-is (verified: `metadata.profileId` survives stop/resume, including through `set-model`; prompt is re-derived each spawn).
- Do NOT add system-prompt persistence, versioning, or a record of the composed prompt.
- Do NOT touch `responseOptions` rendering in the UI, the `<options>` protocol, or anything about how options chips are parsed/displayed.
- Do NOT address happier-dev/happier#283 (pi `extension_ui_request` handling) — separate defect, separate fix.
- Do NOT redesign profile env overlays, connected-services bindings, or memory-recall guidance (env/disk-driven, not profile-overrideable; unchanged).

**Falsified hypothesis — do not chase:** "the profile override is dropped on resume." Controlled probe disproved this: the override survives stop → resume → set-model → resume. Earlier transcript "evidence" for the stronger leak was self-referential false positives (the diagnosing agent's own prose quoting the templates). Only the split-brain above is real.

**Material requirements and invariants:**
- **REQ-1 (single decision-maker):** Exactly one merge of global `codingPromptBehaviorV1` with the selected profile's override exists per prompt/bridge resolution, and all three consumers (base blocks, tool-delivery blocks, pi bridge options) consume that merged result.
- **INV-1 (override honored everywhere):** For a session whose resolved `sessionTitleUpdates === 'disabled'`: the appended system prompt contains no title/rename guidance in *any* block, and the pi bridge registers no `change_title` tool (`disableRename: true` → `--happy-disable-rename`).
- **INV-2 (prompt/tool agreement):** Within one spawn, the tools the appendix advertises and the tools the bridge registers are derived from the same resolved settings object. (The comment on `PiBackendOptions.happyToolsBridge` already promises this; make it true under profile overrides.)
- **REQ-2 (no-regression):** Sessions without a profile override (or with an override that doesn't set the field) behave exactly as today: global defaults flow to all three consumers.
- **COMPAT-1:** No wire, persistence, settings-cache, or account-settings schema changes. No migration. Behavior change is purely client-side composition at spawn time.

**Outermost success evidence:** a live pi session created under a profile with `sessionTitleUpdates: 'disabled'` where (a) the model's self-report of its system prompt shows no rename instructions, (b) the transcript contains no `change_title` bridge invocation, (c) the same holds after stop → resume, and (d) a default (no-override) session still shows rename guidance and executes the rename command.

## 2. Current-state evidence

**Canonical owner of the behavior decision:** profile override lives at `settings.profiles[].codingPromptBehaviorV1` (read via `readProfilesFromAccountSettings`, `apps/cli/src/settings/profiles/readProfilesFromAccountSettings.ts`); merge helper `applyCodingPromptBehaviorOverrideToSettings` is protocol-owned (`packages/protocol/src/prompts/codingPromptBehaviorV1.ts`). The composition entry point is `apps/cli/src/agent/prompting/coding/resolveEffectiveCodingPrompt.ts`.

**The two broken consumers:**
1. `resolveEffectiveCodingPrompt.ts` lines 68–76 resolve `selectedProfileOverride` and build `basePromptSettings` (merged) — used **only** for `buildCodingSessionPromptPlanBaseV1` (line 78). Line 107 passes the **raw** `settings` to `resolveCodingToolDeliveryBlocks`, whose appendix text (`buildHappierToolsPromptAppendix`, `apps/cli/src/agent/tools/happierTools/runtime/buildHappierToolsPromptAppendix.ts`) renders the full rename guidance when the settings it receives say `ongoing`.
2. `apps/cli/src/backends/pi/acp/runtime.ts` line 133 calls `resolveHappyToolsBridgeBackendOptions({ settings: params.accountSettings ?? null, ... })` with **raw** account settings, although the same function ten lines earlier (line 98) reads `session.getMetadataSnapshot()?.profileId` for the prompt resolution. `resolveHappyToolsBridgeBackendOptions.ts` line 34 derives `disableRename` from `resolveCodingPromptSessionTitleUpdatesModeV1(params.settings)`.

**How the pi flag reaches the runtime (verified, no changes needed):** `resolveHappyToolsBridgeBackendOptions` → `PiBackendOptions.happyToolsBridge.disableRename` → `resolveHappyBridgeExtensionArgs` (`apps/cli/src/backends/pi/acp/backend.ts:141`) passes `--happy-disable-rename` per session → the bridge extension honors the flag at runtime (`piBridgeExtensionSource.ts:290`: `readFlagBool(pi, DISABLE_RENAME_FLAG) || !RENAME_ENABLED`). The baked asset constant is only a default; `ensurePiBridgeExtensionAsset` uses `writeFileIfChanged` (`piBridgeExtensionAssets.ts:91`), so asset flips are handled and per-session divergence is carried by the flag, not the shared asset.

**Affected corridor:**
- Appendix text leak: all `shell_bridge` agents — `auggie, qwen, kimi, kilo, pi, copilot, cursor` (`packages/agents/src/manifest.ts`). They all compose their prompt through `resolveEffectiveCodingPromptText` (spawn flag for pi via `deliversSystemPromptAtSpawn`; ACP instructions for the others via `runStandardAcpProvider.resolveFreshSessionSystemPrompt`, `apps/cli/src/agent/runtime/runStandardAcpProvider.ts:669–682`).
- Bridge tool-registration leak: pi only (`resolveHappyToolsBridgeBackendOptions` has no other callers).

**Split-brain audit (same-concept owners):** no other competing merge of profile coding-prompt behavior exists; `providerPromptBehaviorBlocks` (claude/codex tool-sequencing) does not read `codingPromptBehaviorV1` and is unaffected. Prompt-stack blocks and memory guidance do not read it either. The defect is exclusively the two consumers above.

**Existing tests:**
- `apps/cli/src/agent/prompting/coding/resolveEffectiveCodingPrompt.test.ts` — profile-override cases for base blocks exist; no case asserts tool-delivery appendix consistency (gap → RED test lives here).
- `apps/cli/src/backends/pi/bridgeExtension/resolveHappyToolsBridgeBackendOptions.test.ts` — already proves settings-driven `disableRename` (lines 57–69); the missing piece is that the *runtime caller* feeds it merged settings.
- `apps/cli/src/backends/pi/bridgeExtension/piBridgeExtensionSource.test.ts`, `piBridgeExtensionAssets` tests — asset/flag plumbing, unchanged by this fix.

**Highest-risk / quietest failure points:**
1. Fixing the appendix but not the bridge (or vice versa) — INV-2 violated in a less visible way than today. Both consumers must switch in one change.
2. Double-merge divergence: if pi runtime passes merged settings into `resolveEffectiveCodingPromptText` (which merges again by `profileId`), the two merges must agree — guaranteed by giving them one shared helper and making the merge idempotent under the same override (it is: override fields win; same override applied twice yields the same result).
3. Silent behavior change for profiles whose override sets only `responseOptions` (appendix unaffected) — covered by REQ-2 no-regression tests.

## 3. Target state

- One shared CLI helper — suggested placement `apps/cli/src/agent/prompting/coding/resolveSessionCodingPromptSettings.ts`, name at implementer's discretion — that takes `{ settings, profileId }` and returns the settings with the selected custom profile's `codingPromptBehaviorV1` override merged (extracting the inline logic from `resolveEffectiveCodingPrompt.ts:68–76`; reuse `readProfilesFromAccountSettings` + `applyCodingPromptBehaviorOverrideToSettings`).
- `resolveEffectiveCodingPrompt` uses the helper's merged settings for **both** the base plan and `resolveCodingToolDeliveryBlocks` (replace the raw-`settings` argument at line 107).
- pi runtime `resolveBackendOptions` (`backends/pi/acp/runtime.ts`) computes merged settings once via the helper (using the `profileId` it already reads at line 98) and passes them to `resolveHappyToolsBridgeBackendOptions`. Whether it also passes them into `resolveEffectiveCodingPromptText` (replacing its internal merge input) or lets that function re-merge idempotently is implementation discretion; the helper is the single merge owner either way.
- No changes to: `resolveCodingToolDeliveryBlocks`/`resolveHappyToolsBridgeBackendOptions` signatures (they keep accepting a settings record — now the merged one), the appendix builder, the bridge extension source, launch args, wire formats, or persistence.

## 4. Decisions

- **Approved-by-this-plan (design):** merged-settings-bag approach (Option A) — feed the merged settings record to the existing consumer signatures — over changing consumer signatures to accept a resolved `CodingPromptBehaviorV1` object (Option B). Rationale: both consumers and their tests already speak "settings record"; the merge owner moves to one helper; total diff is smallest at the correct owner. Option B would churn signatures and tests without removing any decision.
- **Delegated to implementation:** helper file/function naming and exact placement (nearest real domain folder is the prompting/coding module); whether pi runtime forwards merged settings into `resolveEffectiveCodingPromptText` or relies on idempotent re-merge.
- **Deferred/excluded:** per-profile memory-recall guidance (not currently a profile field); exposing resolved prompt diagnostics; anything in the UI.
- **Difficult to reverse:** none. Pure client-side composition change; undo = revert.
- **Rejected:** persisting the composed prompt per session to "freeze" creation-time behavior (rejected: solves nothing verified — resume recomposition is correct — and adds a persistence format); threading `profileId` through daemon spawn env for resume (rejected: metadata path already works, verified by probe).

## 5. Execution units

**EU-1 — Single merge owner + appendix fix (satisfies REQ-1, INV-1 for prompt text, REQ-2)**
- Extract the shared merged-settings helper; refactor `resolveEffectiveCodingPrompt` to use it for base blocks and pass merged settings to `resolveCodingToolDeliveryBlocks`.
- RED first: add to `resolveEffectiveCodingPrompt.test.ts` a case — settings with global `sessionTitleUpdates: 'ongoing'` + a custom profile (by id) overriding to `'disabled'`, `toolDelivery: 'shell_bridge'`, valid sessionId/directory — asserting the resolved text contains **no** rename/`change_title` guidance. Verify it fails on current code for the intended reason (appendix leak), then implement GREEN.
- Also assert the companion no-override case (global `ongoing`, no profile) still contains the rename guidance (REQ-2 guard).

**EU-2 — pi bridge binding fix (satisfies INV-1 for tool registration, INV-2)**
- In `backends/pi/acp/runtime.ts` `resolveBackendOptions`, resolve merged settings via the EU-1 helper (`profileId` from `session.getMetadataSnapshot()`) and pass them to `resolveHappyToolsBridgeBackendOptions`.
- RED first: a focused test that the runtime-level composition yields `happyToolsBridge.disableRename === true` under the same override scenario (direct unit test of the resolver with merged settings mirrors the existing `resolveHappyToolsBridgeBackendOptions.test.ts` shape; if the runtime wiring itself has no harness, cover the helper call contract in the EU-1 helper's test and rely on EU-3 live QA for the wiring — do not build a new runtime harness for one line).
- The asset and `--happy-disable-rename` plumbing is already correct; no changes.

**EU-3 — Validation sweep (satisfies completion contract)**
- Unit lanes: `apps/cli` prompting + pi bridge tests (`resolveEffectiveCodingPrompt.test.ts`, `resolveHappyToolsBridgeBackendOptions.test.ts`, `piBridgeExtensionSource.test.ts`); touched-package typecheck/build lane.
- Live QA (disposable probe sessions, mirror of today's method): under a `sessionTitleUpdates: 'disabled'` profile — create session → assert model self-report shows no rename instructions and transcript has no `change_title` invocation; stop → resume → assert identical. Under no override — assert rename guidance present and rename command executed at creation (REQ-2).
- Split-brain re-audit: grep the touched corridor for any other consumer of `codingPromptBehaviorV1` / `resolveCodingPromptSessionTitleUpdatesModeV1` reading unmerged settings (`resolveCodingToolDeliveryBlocks` caller, bridge options, `buildHappierToolsPromptAppendix` internal reads) and confirm each now receives the merged object.

Dependencies: EU-2 depends on EU-1's helper. EU-3 depends on both. No external/runtime preconditions.

## 6. QA and validation

- Automated: the EU-1/EU-2 RED→GREEN unit tests (owner-level, discriminating — they fail on current code for the leak reason); full existing suites for the two touched modules; `apps/cli` typecheck + build-enforcing lane.
- Live: EU-3 probe matrix (override-profile create/resume; no-override create) on the local daemon. Platform note: prompt composition is platform-independent; pi spawn path exercised on Linux here — no new platform-specific behavior introduced (settings composition only), so no additional platform matrix.
- Failure-mode coverage: override sets only `responseOptions` (appendix must be unchanged — add to EU-1 tests); unknown/built-in profile id in metadata (helper falls back to global — existing behavior, one test); settings missing `profiles` entirely (fallback, existing tests cover the merge helper).
- No compatibility directions to test: no released-format consumers change (COMPAT-1).

## 7. Completion contract

**VERIFIED_COMPLETE requires all of:**
1. EU-1/EU-2 unit tests observed RED on pre-fix code (for the intended leak reason) and GREEN after; suites and typecheck/build lane green.
2. Live QA matrix from EU-3 executed and passing on the attested daemon/CLI identity; probe session IDs and transcripts recorded below.
3. Split-brain re-audit recorded below naming every same-concept consumer and its merged-input status.
4. Negative requirements hold: no wire/persistence/schema change in the diff; no new gate, env var, or config; `resolveCodingToolDeliveryBlocks`/`resolveHappyToolsBridgeBackendOptions` signatures unchanged.
5. Residual risk stated explicitly (expected: none beyond model-behavior nondeterminism in live self-report probes, mitigated by also asserting transcript absence of `change_title`).

**Prevents completion:** presence of the helper or refactored call sites without the RED→GREEN record; live probes skipped; INV-2 verified only by reading code rather than the EU-3 live assertions.

## 8. Execution tracking (mutable — not part of the approved contract)

| Unit | State | Evidence |
|---|---|---|
| EU-1 | VERIFIED_COMPLETE | RED→GREEN in `resolveEffectiveCodingPrompt.test.ts` (appendix-leak case failed with `change_title` present pre-fix; 13/13 green after). Helper `resolveSessionCodingPromptSettings.ts`; merged settings feed both base plan and `resolveCodingToolDeliveryBlocks`. REQ-2 + responseOptions-only companions green. |
| EU-2 | VERIFIED_COMPLETE | RED→GREEN in `runtime.systemPrompt.test.ts` (runtime-level: `disableRename false`→`true` under override; REQ-2 control). `backends/pi/acp/runtime.ts` feeds merged settings (profileId from session metadata) to `resolveHappyToolsBridgeBackendOptions`. Bridge-extension lane 20/20. |
| EU-1.5 (audit finding) | VERIFIED_COMPLETE | Fourth same-concept consumer found and fixed: `shouldDenyAgentSessionTitleToolCall` in both permission handlers read raw settings — profile override silently disabled the deny layer. RED→GREEN in `ProviderEnforcedPermissionHandler.test.ts` (approved→denied under override); both handler suites 39/39. |
| EU-3 | VERIFIED_COMPLETE | Unit lanes green (17/17 prompt+runtime, 20/20 bridge, 39/39 permissions). Typecheck clean after refreshing stale protocol dist copy in `apps/cli/node_modules`. Live QA on deployed `0.2.10-dev.20260820T1548.gf1f786d5`: override probe C create+resume `1:NO 2:NO`, no `change_title` execution, asset `RENAME_ENABLED=false`; control probe D `REPORT=YES`, asset `RENAME_ENABLED=true`. Probe sessions: `cmt1p7cea000l2n7fms7nekqn` (override, resumed), `cmt1p8wek004j2n7fgp0cs7h1` (control). Early probes `cmt1ourf8…`/`cmt1oy7h0…` (pre-deploy/AGENTS.md-noise, kept for record). |

### Split-brain re-audit (2026-08-20, post-fix)

Consumers of `codingPromptBehaviorV1` / `resolveCodingPromptSessionTitleUpdatesModeV1` in `apps/cli/src` (non-test):
- `resolveEffectiveCodingPrompt.ts` → consumes merged settings (base plan + appendix) ✅
- `resolveSessionCodingPromptSettings.ts` → the single merge owner ✅
- `toolDeliveryPromptRegistry.ts` / `buildHappierToolsPromptAppendix.ts` → read the settings record passed in; both call paths now pass merged ✅
- `resolveHappyToolsBridgeBackendOptions.ts` → receives merged from pi runtime ✅
- `codingPromptTitlePermission.ts` (`shouldDenyAgentSessionTitleToolCall`) → both permission handlers now resolve merged settings (profileId from session metadata) ✅
No remaining consumer reads unmerged settings.

Notes:
- Probe sessions used for baseline evidence: `cmt1nl6jf00cp2ntv9nsfemrp` (stopped; kept for reference until superseded by EU-3 probes).
- GitHub issue: not yet filed for this defect (user redirected to authoring this plan; filing remains a separate decision).
