BLOCKED — Aggregate backlog and policy diagnosis delivered; exact class/eligibility composition, per-waiter placement attribution, matched command peaks and duplicate counts require broker metadata the running protocol does not expose. No placement defect established or production behavior changed.

## Ranked findings
1. **Observed admission saturation, not spare worker admission capacity.** Near-synchronous samples at 2026-11-06 15:42:27–28Z show zero unreserved memory on nl2, nl1 and nl3. Physical available RAM is already committed to existing floors. This refutes “workers have room” for that sample, but does not establish where older AUTO decisions were made or why the controller accumulated more demand.
2. **Observed high aggregate demand and broad compilation policy.** Controller demand is 4,079 GiB / 121 waiters (33.71 GiB average), versus nl1 1,248 / 48 and nl3 842 / 33. The real SDK script command resolves to worker-eligible `compilation`, 38 GiB, while commit coherence deliberately resolves to primary-only `compilation`. Their individual queue shares are unavailable. The SDK correction belongs to the separately assigned `script-test-compile-class-1106` brief; this lane did not duplicate it.
3. **Observed visibility gap prevents causal ranking within that demand.** The broker sample has 12 aggregate fields and no waiter array, class, arrival, placement or command/source identity. Slots encode PID/floor only; neither broker nor client retains completed-command peak history. A class count, duplicate count, stale-read verdict or measured per-job ranking would be fabricated with this interface. This is a diagnosis blocker, not an established scheduling root cause.

## Loaded broker observations
Evidence: `.project/tmp/controller-admission-backlog-1106/{nl2,nl1,nl3}-paired.json`; sampler `sample.mjs` in that directory. The sampler requests only `kind: sample`, whitelists numeric/status fields, and decodes slot filenames without process argv/environment access. Samples are broker-published observations, not forced synchronous OS measurements; the broker's existing catch-up refreshes waiting demand.

| Host | Active / waiting | Physical available GiB | Reserved / credited GiB | Unreserved GiB | Queued floors GiB |
| --- | --- | --- | --- | --- | --- |
| nl2 | 6 / 121 | 45.74 | 64 / 17.45 | 0 | 4,079 |
| nl1 | 3 / 48 | 42.16 | 60 / 15.97 | 0 | 1,248 |
| nl3 | 6 / 33 | 24.49 | 70 / 13.05 | 0 | 842 |

Derived: `max(0, available + credited resident - reserved)` is zero on each host even before a possible head reservation. Owner: `apps/stack/scripts/utils/proc/admission_broker.mjs:58` and `:134`. Queued floors are cumulative requested envelopes, not resident RAM or a forecast of simultaneous consumption. Slot enumeration happens after sampling and is not an atomic class/holder census.

## Q1 — controller composition
| Requested category | Waiting count | Floor GiB | Local-only / remotely placeable |
| --- | --- | --- | --- |
| Compilation excluding finalizers/tests | [blocked] | [blocked] | [blocked] |
| Package-dist / local runtime preparation | [blocked] | [blocked] | [blocked] |
| Finalizer / coherence | [blocked] | [blocked] | [blocked] |
| Test | [blocked] | [blocked] | [blocked] |
| Other | [blocked] | [blocked] | [blocked] |

Only the total 121 / 4,079 is measured. Semantic categories overlap admission classes: fixture tests and finalizers both use `compilation`. Aggregate totals cannot recover those categories or placement eligibility. `status()` and the `sample` handler (`admission_broker.mjs:134,376`) publish no individual requests. No argv workaround was used.

## Q2 — placement owner and real-job limitation
Observed current-policy probes are retained in `.project/tmp/controller-admission-backlog-1106/policy.json`, through the real `resolveRemoteCommandPolicy` export:
- Commit coherence: primary-only / compilation, 38 GiB; private-index Git objects belong to this checkout. Named contract: `.agents/skills/happier-commit-worktree/SKILL.md:139`; canonical rule `remote_commands.mjs:494`. `hstack-exec:1063` sends this directly to local execution before controller coalescing/AUTO selection. This is explicit policy, not a default or evidence of stale capacity.
- SDK `generateActionTypeMap.test.mjs`: worker-eligible / compilation, 38 GiB. Its source rule is at `remote_commands.mjs:482`; an authorized explicit local route still retains admission. Reported original AUTO and local handles are distinct requests, not proof of the same source/view being duplicated.
- UI typecheck: worker-eligible / compilation-ui, 20 GiB. Protocol dist: worker-eligible / package-dist, 6 GiB. Workspace-build coordinator: primary-only with no heavy floor; its workers own build admission (`remote_commands.mjs:511`). A primary-only coordinator is not itself evidence of a queued 6 GiB producer.
- AUTO owner: `hstack-exec:1775,1812` considers fit/native/affinity, queued floors divided by achievable memory, then CPU/load. Cached observations have an existing freshness rule at `:1340`. A chosen target remains the execution location while broker admission waits (`:2370`); no cross-host rebalancing is promised by this path.
- [blocked] Matching one live waiter from each large category to its original policy/target/capacity observation: requests and decision history are not exposed. No named worker-placement failure or stale read was reproduced. Board reports were treated as reports, never broker attribution.

## Q3 — floor evidence and limits
- Current catalog owner: `apps/stack/scripts/utils/dev_targets/command_resources.mjs`. General compilation is 38 GiB; package-dist 6; runtime-build 18; app-specific compilation UI/CLI/server 20/15/16. JavaScript policy and generated native shell consume this owner.
- Re-derived raw historical evidence: `.project/tmp/compile-reservation-peaks-1104/holder-snapshot.json` (2026-11-04) records holder 2355054, old uniquely identifying 26 GiB floor, simultaneous tree RSS 38,992,620 KiB = 37.1863 GiB. Rounding gives 38 GiB. The other three holder snapshots are different unknown commands, not repeated peaks of that command; they cannot establish variance or justify reducing the shared floor.
- Historical same-command lead: `validation-floor-sizing-1104/measurements.json`, successful `package-typecheck` runs for `packages/support` (mapping in `measure-worker.mjs:16`), peaks 4,416,548–4,497,836 KiB, n=2. Current owner probe assigns that command compilation/38 GiB: floor exceeds the historical maximum by 33.71 GiB, versus observed peak range 0.078 GiB. This is an over-reservation lead for that measured shape, not a current-source calibration or measured share of this queue.
- Historic Protocol dist (4,682,608 KiB) and full daemon artifact (16,442,992 KiB) citations are retained in `remote_commands.mjs:193`; the runtime catalog explicitly says the original full-runtime capture is unavailable. No same-command repeated peak evidence for current finalizers or full runtime preparation was recovered from broker state. Instant resident memory is not peak RSS.
- [blocked] Current same-command peak/variance comparison for each large queued category, including SDK fixtures: the broker has no completed peak records; the script-suite measurement lane had no completed peak metrics in its retained measurement logs inspected here. No floors were reduced and no competing class was added.

## Q4 — duplication
Observed source: `controller_coalescing.mjs:115` keys repo + working directory + command + selected environment; it keeps one running job and one shared unstarted follower (`:121`). It deliberately does not equate an already-running source view with later requests. `hstack-exec:1063–1084` bypasses it for primary-only jobs, explicit target/local controls and other documented exclusions. Thus finalizers are not coalesced by this path, but distinct private trees are not duplicates merely because package names match.
[blocked] Exact duplicate count for the same package AND source across lanes: broker requests have neither a command key nor source-tree identity, and samples do not expose even their existing per-request fields. No count or coalescing change is justified from these observations.

## Owner action, verification and residual risk
ASK to Systemic: make a read-only broker census available through the existing sample owner, exposing existing class/floor/PID/arrival/blocked facts without commands, environment or secrets; arrange any required broker reload under Systemic's authority. To separate finalizers from fixture tests, correlate known requests with the placement owner's resolved policy. To count same-source duplicates, obtain the existing execution/tree identity at its owner; package names alone are insufficient.
Policy proposal, not applied: consider worker execution of the compiler portion of commit coherence only after measuring its queue share and deciding how the worker can consume the exact private tree. Git objects currently remain primary-owned; do not merely flip `primary-only` or requeue existing finalizers. This requires an owner decision and a concrete correctness contract, not an assumed transport.
Executed: three-host read-only broker samples, current canonical-policy probes, raw historical numeric evidence checks, source/caller/coalescing inspection and author self-review. No production edits, runtime tests, package build/typecheck, broker restart, waiter cancellation, requeue or repin. Documentation-only report finalization is compiler-free; no product documentation update is needed because behavior did not change. Net runtime mechanism delta: checks/states/errors/timers/retries/classes +0 / −0; one lane report added, with ignored evidence artifacts.
Residual risk: historical job attribution, exact category/eligibility totals, duplicate counts, admission-observation freshness and current per-command peaks remain unverified. The samples refute spare admission memory at the observed boundary, not every earlier placement decision. Next action is the owner-provided census; a root-cause fix remains blocked until that evidence distinguishes a defect from policy and legitimate contention.
