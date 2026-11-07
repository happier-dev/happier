BLOCKED — diagnosis complete: nl3 source compilation and shared-build admission dominate; changing author-SDK preparation lifetime needs an owner decision. No production fix or post-fix timing is claimed.

## Observed reload timeline

All remote phase timestamps below are controller receipt timestamps from `~/.happier/stacks/agent-qa-unified-work-dev/logs/remote-nl3.log`; the work is emitted by the nl3 preparation worker, not a controller compiler. Request times come from the reload log filenames. These are existing real reloads, not constructed benchmarks.

| Milestone | Cold daemon reload | Coalesced reload |
| --- | --- | --- |
| Controller request | 16:32:47.630 UTC | 17:55:29.579 UTC |
| Recorded server / daemon source times | 16:33:29.525 / 16:34:18.542 | 17:55:59.225 / 17:56:16.795 |
| Daemon admission completed | 16:34:28.028; 2.128 s | 18:14:44.534; **1,065.059 s** |
| Daemon input capture | 16:34:52.006; 15.813 s / 16,750 files | Reused completed graph; no capture/build phases |
| Daemon entry preparation | **279.248 s** | None |
| Daemon main esbuild | 27.386 s | None |
| Plugin UI compilation | **320.521 s** | None |
| Author SDK closure | **560.547 s; 18 compiler emissions / 46,446 output files** | None |
| Daemon runtime resources / output identity | 31.278 / 34.068 s | None |
| Daemon publication | 16:56:13.982; 10.798 s | Already published by another producer |
| Replacement activation | 16:57:09.628 | 18:15:35.451 |
| Request → prepared activation | **24 min 21.998 s** | **20 min 5.872 s** |
| Subsequent runner sync | 7.028 s | 6.678 s |
| Subsequent server-readiness / daemon-readiness tail | 237.328 / 0.131 s | 185.899 / 0.091 s |

Readiness runs concurrently: the daemon tail is not the daemon's entire startup duration. The nl3 daemon's own log records start → control server → successful startup at stored local times **18:03:41.091 → 18:04:03.734 → 18:04:07.952**, and **19:21:08.060 → 19:21:26.794 → 19:21:33.986**. Those start-to-success spans are 26.861 s and 25.926 s. Server processes are observable in the corresponding nl3 runner logs; their first Iroh-unavailable warning is not an exact server-start timestamp. Preparation activation also precedes the subsequent runner's readiness; the table does not treat activation as end-to-end READY.

The three largest cold daemon phases total **1,160.316 s**, 79.4% of request-to-activation. The coalesced reload spends 88.3% in admission before reusing another producer's completed graph. Busy fingerprint leases are explicitly logged at `remote-nl3.log:13727–13728`; this log does not partition the 1,065 s into lock wait versus host-capacity wait. No claim that all of it was memory admission, or that controller CPU caused it, is justified.

## Canonical owners and rejected hypotheses

- **Observed:** `apps/stack/scripts/utils/dev_targets/supervisor.mjs:65` places preparation on the selected target. `build_source_runtime.mjs:827` owns source selection, build admission, capture and publication. `source_author_packages.mjs:22` owns physical author-package emission; its compiler loop is at line 81. The compilation is real work on nl3, not a fixed 20-minute readiness delay.
- **Observed:** bundles already share `dirname(stackBaseDir)/source-bundles`; `sourceRuntimeCandidateKey` and `sourceBundleFingerprint` use source/configuration/platform inputs, not daemon identity. The same fingerprint is coalesced by its existing build lease. The second reload's admitted reuse and zero compiler emissions falsify a general per-identity duplicate-build explanation. A new shared bundle cache or another coalescing owner would duplicate existing machinery.
- **Observed:** author closure reuse already exists (`source_author_packages.mjs:68`); Plugin UI also reuses its retained inventory. Current source tests cover unchanged preparation, host-only changes, workspace-only wiring, changed author inputs, and backend-only Plugin edits. These tests were inspected, not rerun or claimed green by this lane.
- **Observed:** retained nl3 records captured at 18:02:49.469 and 18:56:44.463 have different author identities and **130 changed consumed paths**, including 21 Protocol paths, 24 plugin paths, and SDK/Agent/Session changes. The later cold reload therefore cannot be characterized as an unchanged-input cache miss. Its preparation took 15 min 3.366 s, with entry/UI/author phases 189.940 / 224.726 / 318.470 s and 18 author compilers. This is another baseline, **not a post-fix improvement**.
- **Derived:** reducing the producer's actual compilation cost also shortens matching followers' lease waits. Retrying sooner, changing polling intervals, bypassing admission, or rebuilding on the controller does not remove that cost.

## Cheapest structural root candidate and stop condition

**Proposed, not implemented:** move author-only SDK declaration/package preparation out of ordinary daemon reload readiness, at the existing source-bundle and author-SDK owners. This targets the largest single measured phase (5.3–9.3 minutes) while keeping ordinary daemon code preparation and the supported authoring flow. The public physical-package consumer is `apps/cli/src/plugins/authoring/hostSdkResolution.ts:200`; `resolveHostPluginSdkPackageRoot` and its author-package resolver consume that closure. Runtime and Plugin UI compilation remain necessary separate outputs, not competing owners of author SDK state.

**[blocked] Systemic / Coordination decision:** authorize a separate author-capability preparation lifetime while preserving the required source relationship of its served SDK. Current emission seals the completed runtime and removes the temporary captured source (`build_source_runtime.mjs:1080`); deferring the work requires changing capture retention/publication and the physical-package consumer's lifecycle. Merely deleting the author emission would break authoring, and reopening moving checkout source would change its existing captured-source behavior. This is the brief's named lifecycle/topology decision boundary, not authority to invent a background service, retained-source store, or another cache. No safe compiler-only reduction with a measured benefit was established here; that remains an alternative investigation if eager preparation must remain.

## Deliverables, checks and remaining risk

- Content-free evidence and replay: `.project/tmp/reload-time-1107/{project_timeline.py,timeline.json,remote_projection.py,nl3-milestones.json}`. `hstack-exec --local -- python3 .project/tmp/reload-time-1107/project_timeline.py` completed exit 0; assertions verify both measured spans, 18 cold author emissions, and zero coalesced main-build phases. The nl3 SSH read-only projection also completed exit 0.
- Exact controller runner evidence: `logs/run.1794070738317.log:148–182,879–880` and `logs/run.1794075445899.log:148–180,537–538`; remote mirrored source evidence `remote-nl3.log:13467–13565,13719–13760`. Exact nl3 daemon log names and milestone lines are in `nl3-milestones.json`; nl3 runner logs were read directly under that stack's `stack-state/.../logs`.
- No source behavior changed: RED/GREEN, package checks, loaded fix replay, and before/after fix timings were **not run**. A new count contract belongs to the selected implementation: ordinary reload must not invoke author-only compilers, paired with real author acquisition consuming the correct source SDK; it cannot be honestly called RED/GREEN before that lifetime decision. No documentation contract changed.
- Mechanism delta: production checks/states/error codes/timers/retries/files **+0 / −0**; one approved lane report added, with ignored measurement artifacts. No stack lifecycle, database, dependency, shared index, or 0.2 checkout mutation occurred.
- **Residual risk:** compiler CPU profiles and lock-versus-capacity wait partition are unavailable; this diagnosis does not prove that the proposed lifetime change is the cheapest implementation. Owner selection of that tradeoff, implementation with count-based RED/GREEN, and Coordination's next owned reload are required before any reload-speed improvement can be claimed. macOS/Windows reload performance was not measured.
