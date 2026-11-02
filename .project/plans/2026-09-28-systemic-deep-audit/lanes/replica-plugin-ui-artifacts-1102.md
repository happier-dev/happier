STATUS: DONE — Mac references repaired; regression RED→GREEN; entry-loads 7/7
Orchestrator summary: FSP READY posted after the Mac's canonical source compiler regenerated all inventory references.
Root fix: replica UI runtime preparation now runs the existing app inventory producer after workspace/package preparation.
Validation: Linux and macOS regression PASS; entry-loads 7/7; private-index/CAS terminal record in evidence root.

Evidence root: `.project/tmp/replica-plugin-ui-artifacts-1102/`.
| Check | Verdict | Evidence |
|---|---|---|
| Mac canonical regeneration | PASS exit0 | repair-mac.log: 84 plugins visited, 36 compiled, 0 failed; all 707 referenced files exist. |
| FSP unblock | READY posted 18:18Z | ready.md; canonical board writer addressed FSP, Systemic; FSP owns native Find replay. |
| Reproduced owner defect | RED intended exit1 | source-red.log: preparation succeeded but retained a missing declaration reference. |
| Same owner after correction | GREEN 1/1 exit0 | green.log (windows2-linux); mac-green.log (mac-host), same stale-reference fixture and real generator. |
| Entry-loads | PASS 7/7 exit0 | entry-loads.log: daemon preparation/daemon/CLI/voice worker/server/UI catalog/SDK browser. |
| Adjacent preparation paths | PASS 2/2 exit0 | adjacent.log: existing cold CLI publisher and UI source-test atmosphere cases. |
| Commit coherence / CAS | Terminal record | commit.log; machine identity verified; private index; no push. |
| Initial broad-preparation attempt | FAIL exit1 before subject | red.log / red.exit: protocol publication TS7056 declaration errors; no cancellation. Source RED/GREEN above is deciding proof. |

Observed canonical owner: `apps/stack/scripts/utils/dev_targets/remote_validation_workspace.mjs#prepareRemoteValidationWorkspace`.
The replica path previously prepared plugin manifests/package outputs, then returned without rebuilding its excluded UI inventory.
Managed hstack Expo and web/source compilation retain their existing app-owned source compiler; the replica package-output path now calls the same existing inventory generator. No copied controller output, second generator, consumer guard or fallback was added.
Consumers checked: hstack replica UI runtime/native Expo; managed native/web Expo; finite web/source preparation; CLI runtime and UI source-test preparation remain their distinct existing branches. Direct OS Expo launches bypass hstack preparation; FSP was told to use the managed entry.
The existing uncommitted preparation-owner extraction is the minimal named producer closure: remote_validation_preparation.mjs, remote_validation_workspace.mjs, native_custody_preparation.mjs, validation_preparation_policy.mjs. Other lanes' command-policy/source changes are excluded from this packet.
Self-simplification removed the temporary source-test allowlist/test-assertion/projection additions used to obtain focused source evidence; the permanent regression uses normal Stack discovery. Subject source and fixture were unchanged between RED/GREEN and cleanup.
Lane mechanism delta: +1 existing-producer invocation / −0; +1 regression file; +0 checks, states, error codes, timers, retries or budgets. Invocation prevents the reproduced missing-declaration bundle failure at the preparation owner.
Documentation: restores the existing replica-preparation contract; no public feature, schema or wire contract changed. Shared package typecheck remains Systemic's rolling baseline under the 10-31 generator/reload ruling; no TypeScript source changed.
Safety: no Metro8082/8083/8084/8086, simulator, QA app, stack lifecycle or DB was touched. Canonical Mac tooling owned its dependency refresh; no dependency inputs were edited.
Scratch: local detached basis `/tmp/happier-replica-plugin-ui-artifacts-1102`; cleanup terminal record `cleanup.log`. No worker basis mirror was created.
Residual risk: FSP's native Find replay is separate and unclaimed; direct raw Expo outside hstack still bypasses preparation. Actual Windows was not exercised (macOS and Linux were). The broad attempt failed in protocol publication before the regression; those diagnostics are outside this lane's changed paths.
