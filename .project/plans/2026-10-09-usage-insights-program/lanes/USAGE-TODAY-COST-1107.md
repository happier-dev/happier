# USAGE-TODAY-COST-1107

**Verdict: historical thin evidence dominates; a Today date cutoff violates the required full-answer equality.**
The comparison needs historical baselines, but it does **not** need all 69,160 token/cost bodies.
The all-history thin population also owns historical coverage; calling all of that “comparison history” would be inaccurate.
No Today production behavior changed. The separately routed protocol compiler defect is fixed in `4a666fa90c63270279feea8301903edbc785ca05`.
Initial entry-loads passed 5/7 and failed 2/7 on deployment exports; the requested repaired rerun passed 7/7.
One focused test initially timed out, then passed unchanged. An initial DB observer failed; corrected boundary observers subsequently passed four ranges and the complete Today statement census.

## Observed measurement basis

- Continued `USAGE-ACCT-SCOPE-1106.md` and source optimization `979b240542a6191e230a7fe68506f04d842d7943`.
- Real retained PostgreSQL behind `agent-qa-usage-insights`, port 12166, serving PID 242687; reload 122 remained running.
- Owner harness, current source, frozen demand instant `2026-11-06T14:15:00Z`, offset −60, same Account prefix 5e3a0581.
- Read-only repeatable-read capture; all-history control captured in the same snapshot. No retained data was changed.
- Main evidence: `.project/tmp/usage-today-cost-1107/measure-raw-boundary.log` (`4 passed`).
- These are shared-host source-harness timings, not new loaded HTTP latency measurements.

| Range | Thin rows / read ms | Full bodies / read ms | Current + prior fold inputs | Batch fold ms | Capture wall ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Today | 69,160 / 1,667.9 | 2,312 / 117.2 | 1,356 + 958 | 336.7 | 5,469.1 |
| 7D | 69,160 / 1,528.7 | 41,840 / 1,381.4 | 9,921 + 32,036 | 1,133.3 | 5,299.7 |
| 30D | 69,160 / 1,677.9 | 69,025 / 2,404.8 | 69,006 + 20 | 1,762.3 | 6,792.0 |
| All | 0 / 0 | 69,160 / 2,466.3 | 69,161 | 3,790.4 | 2,595.9 |

Fold counts include the retained synthetic legacy bridge. Today raw body inputs are 1,355 current and 957 prior.
Complete Today statement repeat: `measure-today-statements.log`, `1 passed`, same rows and full-answer equality.

| Capture statement | Returned rows | Await wall ms |
| --- | ---: | ---: |
| Thin UsageEvent evidence | 69,160 | 1,964.3 |
| Selected full UsageEvent bodies | 2,312 | 144.9 |
| Retained legacy reports | 107 | 1,964.0 |
| Home settings/policy join | 1 | 1,963.9 |
| Stored price catalog | 1 | 62.5 |

Five application statements, 71,581 returned rows; excludes setup, BEGIN/COMMIT and control reads.
These are Prisma boundary wall durations, including queue/decoding; overlapping statements must not be summed as server SQL CPU.
Their interval union is 2,171.7 ms; capture wall 5,292.7 ms leaves 3,121.0 ms outside DB intervals (including preparation/yields).
Actual batch fold: 2,314 inputs / 397.5 ms. Diagnostic synchronous replays: thin admission 69,160 / 1,523.9 ms; preparation 263.9 + 336.7 ms.
Those replays are separate executions of the same owners, not additive exclusive capture spans. Coverage reduction replay: 117.2 + 119.8 ms.

## Owner and falsifiers

- Dominant unit: all-history thin evidence read/admission/preparation, rather than full-body hydration or committed body folding.
- Canonical capture owner: `apps/server/sources/app/usage/query/readUsageAnalyticsBatch.ts#captureUsageAnalyticsBatchInTx`.
- Storage read owner: `query/loadUsageEventsForQuery.ts`; historical subject/baseline selection: `query/resolveScopedUsageContributions.ts`.
- Historical coverage owner: `query/projectUsageCoverageEvidence.ts` (group eventCount, asOfMs, completeness and reasons).
- Today evidence inputs: 69,161 current / 67,806 prior. Coverage groups: 258 / 256; window-only evidence gives 28 / 12.
- The prior comparison has 941 window rows plus 16 pre-window body baselines. Removing older history raises its tokens from 24,271,151 to 24,408,767 (+137,616).
- Complete Today/7D/30D/All responses equal the all-history control, including contributions, money and historical coverage: GREEN 4/4.
- Existing owner regression `usageQueryService.integration.spec.ts` retains 128 historical-only coverage groups while hydrating two bodies.
- Derived: without reusable persisted summaries, exact historical counts/completeness still require historical work somewhere; an SQL aggregate merely relocates that scan.
- Therefore no Today cutoff was shipped. A coverage-contract change would violate this lane's equality requirement; no new count-based RED was needed for unchanged Today behavior.
- Scalar and batch/NDJSON analytics share the capture/project owners. No competing read path, new cache, cap, timeout, table or schema change was added.

## Compiler and commit gates

- Requested server rerun reached diagnostics: touched file:line:code baseline 0, current 0, added 0, removed 0 across all six predecessor files.
- Full package exited 2 with 6,217 unattributed locations; not whole-package green. Evidence: `server-typecheck.log` in the same scratch folder.
- O-DEPLOY's `usageSummary.ts:47:TS2345`: frontier values already receive `labels.get(key) ?? key`; their producer type now requires that label.
- Protocol touched delta: added 0, removed that exact location; unrelated `actions/specs/deployments.ts:79:TS2322` remains with its owner.
- Evidence: `protocol-typecheck.log`; focused `protocol-focused.log` 54/55, unchanged retry `protocol-focused-retry.log` 1/1.
- Entry-loads: `entry-loads-repaired.log`, all seven current-source graphs passed; private index → commit-tree → CAS update-ref used.
- Producer fix is type-only: runtime checks/states/errors/timers/retries +0/−0, source files +0/−0; one existing annotation refined.
- No documentation contract changed. This requested report adds one content artifact; scratch logs/specs remain ignored evidence.

**Residual risk:** historical thin work remains under exact historical coverage; these samples do not establish a loaded HTTP speedup.
Reload 123 is **not needed** for this lane's type-only change and diagnosis; no restart or reload was performed, and no browser was opened.
