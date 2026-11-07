# FIX-COPY-R26

**Verdict: DIAGNOSED; post-reload reproduction pending orchestrator READY.**
UI Copy fails at shared directory preflight because current UI sends a field absent from the loaded daemon's strict schema. Agent Copy independently submits invalid model-selection objects and encounters a signed Account-profile read refusal. No template-specific production defect or expired provider credential is established. No production changes made.

| Failure | Exact refusal and compared values | Attribution / next action |
| --- | --- | --- |
| UI Copy, both R26 attempts | `registerSessionCreationTargetPreparationRpc.ts:22` parses the request. Current `sessionSpawnNewAction.ts` sends `{directory:{kind:'path',path:'~'},prepareAgentIsolationMember:true}`. Loaded `chunk-PJM6RHQE.js` strict request accepts only `directory`, `sessionCreationTag`, `checkoutCreationDraft`; its actual exported schema rejects the added key with `unrecognized_keys`. `sessionCreationTargetPreparationV1.ts:91` maps an unclassified reply to `incompatible_target / target_preparation_invalid_result`. | Confirmed UI/daemon schema skew. Orchestrator owns d2 reload; no consumer workaround. Plain Bot Start has the same failure per owner's QA-AGENT-ROWS-2 data point, consistent with this shared owner. |
| Agent Copy model, attempts 1 and 2 | `packages/protocol/src/providers/selection/v1.ts:14–31`: strict `{v:1,ref:{agentTargetKey,providerConnectionId:null,modelId},updatedAt:number}` for native selection. Attempt 1 supplied `{agentTargetKey:'agent:happier.agent.codex/codex',modelId:'gpt-6-luna',effort:'low'}`; attempt 2 wrapped that same object in `{v:1,ref:...,updatedAt:1794062963238}`. Both omit `providerConnectionId`; `effort` is not a ModelRef field. | Invalid agent-authored input, before model-id/catalog admission. Parent's correct native `gpt-6-luna` selection worked. Do not weaken the canonical schema or add a template parser. Tool discovery usability can be adjudicated by its owner. |
| Agent account lookup | At `14:48:40.189Z`, server emits `external-action-authorization-refusal`, phase `verification_purpose`, method `GET`, path `/v1/account/profile`; `req-1pen` returns 401 at `.190Z`. Native `connectedServices.accounts.list` input is `{}` and receives `invalid_token` at `.200Z`. CLI request owner rethrows the server `error` in `connectedServiceActionDeps.ts:259`. | Signed action HTTP-purpose refusal, not evidence of an expired Claude/Codex account token. Foreign authorization/connected-account owner; recheck after server+daemon reload before changing anything. |

## Evidence basis

- d2 observed running since `2026-11-07T09:18:12.842Z`; loaded server `bfe08a083f4de8ff` (source08:49:19.668Z), daemon `7c96223f58015b74` (source09:03:11.916Z). UI is borrowed current Metro. Stack info captured at `/tmp/fix-copy-r26-stack-info.json`.
- Old daemon root: `/home/happier/.happier/dev-targets/nl3/stack-state/agent-qa-l12-d2`; log `cli/logs/2026-11-07-10-25-46-pid-2078719-daemon.log` lines102155–102161 and105758–105764. Requests `rpc_c61d90e0-72af-44b8-b918-ad3ea06336ea` and `rpc_ed509ff9-bb63-43a5-8b7f-0a05c4d0a0c7` are admitted as `machine_custodian`, then fail in `handler` with `unclassified_error` in4/5ms. No child is created.
- Canonical projection evidence: `.project/tmp/FINAL-QA/r26-ui-create-failure.json`, `r26-ui-retry.json`, `r26-agent-exact-results.json` seq21/22,27/28,34/35. Tool inputs in the latter are redacted; exact inputs were recovered from the native Codex rollout instead of guessed.
- Native rollout: connected profile `2c84476e-10c3-438a-a079-5e098a3c5c74`, `codex/codex-home/sessions/2026/11/07/rollout-2026-11-07T15-46-27-01a1b679-a1b8-7833-afd1-8fab639cb20b.jsonl` under d2's `cli/servers/stack_agent-qa-l12-d2__id_default/daemon/connected-services/homes/openai-codex/`.
- Agent discovery seq11/13/25 asks for sections with `schemaSections`, while the canonical tool declares singular `schemaPath` (`packages/protocol/src/actions/specs/catalog.ts:157,178`; reader `actionSpecSections.ts:46`). Consequently those calls repeat the root `$ref` instead of retrieving the model schema. This is malformed agent-authored tool input, not missing canonical model fields.
- Scoped evidence directory `.project/tmp/FIX-COPY-R26/`: `runtime-refusals.log`, `rejected-values.log`, `loaded-schema-probe.log`, `loaded-contract.log`, `exact-server-refusal.log`. The schema probe imports the actual old bundle and parses data only; it makes no product request or model turn.
- Server correlation: remote `logs/server.log.1` lines36541,36546–36547; account lookup fails before any provider request. The UI dialog only names `incompatible_target`; it does not expose the underlying incompatible field. Agent transcript exposes `invalid_token` but not the signed-request purpose cause.

## Validation and scope

- AUTO entry-loads **PASS7/7**, terminal0 (`entry-loads.log`, handle8543). Initial source-sync refusal on happier-linux1 recovered through AUTO placement on windows1-linux; this is Linux-host evidence, not native Windows validation. Focused `sessionCreationTargetPreparationV1.test.ts` **PASS11/11**, terminal0 at15:55:37Z (`focused.log`, original handle55571, windows2-linux). AUTO waited for dependency refresh and memory admission without repinning or cancellation. No package typecheck is required for this report-only change.
- One post-READY reproduction is reserved, cheapest Haiku, tiny prompt, exact `FIX-COPY-R26` tag; no reproduction or new provider turn has been used so far.
- No account/default changes, stack lifecycle, foreign Session mutation, source/schema changes, new tests, or dependency changes. UI-BT-TEMPLATE's concurrent edits preserved.
- Self-attack: missing RPC-method hypothesis falsified by loaded registration and successful server relay; provider-credential hypothesis contradicted by the signed HTTP-purpose refusal; model-id hypothesis fails to explain the strict-object issues. Actual old schema probe independently confirms the concrete rejected key.

## Mechanism delta

Checks/states/error codes/timers/retries/production files: **+0 / −0**. One requested lane report added. Shared directory-preparation and model-selection owners remain authoritative; no competing path introduced.

## Handoff

ASK posted `2026-11-07 15:19 UTC` to Bot templates orchestrator, AUTHZ-PURPOSE-1106 and Providers ORCH on the existing handoff board, naming the signed-profile refusal and separate confirmed UI skew.
Loaded server source map independently confirms `enableAuthentication.ts:185`: `routeSessionIds === null` → `refuseExecution('verification_purpose')`. See `exact-server-refusal.log` (actual server bundle `runtime-16a99549…-CUG1wo/apps/server/src/chunks/startServer-3LSA4QJC.js.map`). This is a missing request Session operand, not a provider-token comparison.
Pending: orchestrator READY, exactly one new-runtime replay and final RESULT board post. Diagnostic report is ready for a same-HEAD guarded commit; the replay result will update it when authorized runtime readiness arrives. Residual risk: refreshed runtime may reveal a later failure after preflight; no end-to-end success claimed.
