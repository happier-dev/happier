# USAGE-TODAY-COST-1107

**Verdict: `54886f4a27d6` bounds snapshot admission to demanded windows; real PostgreSQL equality GREEN 4/4. Today capture 5,293 → 2,452 ms; snapshot span 2,476 ms.**
Exact historical coverage still requires 69,160 thin rows; strict range-only reads would change the answer. Only 2,312 full bodies are needed.
The first fix (`f7f668aa9e0f`) overfetched 35,381 bodies and did not improve capture (5,361 ms); the committed followup corrects that regression.
Compiler rerun found `projectUsageAnalyticsPopulation.ts:88:TS2345`; fixed forward at its metadata producer. Final public compiler completed: owned locations zero, added zero, removed that location.
Reload 124 is already running source from 18:05Z and excludes the followup. The next owner-controlled reload must include it; this lane performed no lifecycle action.

## Observed measurement basis

- Continued `USAGE-ACCT-SCOPE-1106.md` and source optimization `979b240542a6191e230a7fe68506f04d842d7943`.
- Real retained PostgreSQL behind `agent-qa-usage-insights`, port 12166, loaded PID 4005357; current-source owner harness, demand instant `2026-11-06T14:15:00Z`, offset −60, Account prefix 5e3a0581.
- Read-only RepeatableRead capture; final all-history control is a separate read snapshot over the retained Account data. No retained data was changed.
- Evidence root `.project/tmp/usage-today-cost-1107/`: final `window-seeds-real-pg.log` (`4 passed`); predecessor `measure-raw-boundary.log` and `measure-today-statements.log`. Shared-host source timings, not loaded HTTP latency.

| Range | Thin rows / read ms | Full bodies / read ms | Fold inputs / replay ms (current; prior) | App SQL | Capture / snapshot ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Today | 69,160 / 1,475.2 | 2,312 / 762.3 | 1,356 / 46.7; 958 / 36.6 | 5 | 2,452.4 / 2,476.0 |
| 7D | 69,160 / 1,276.2 | 41,853 / 2,057.4 | 9,921 / 143.1; 32,036 / 317.9 | 5 | 4,340.6 / 4,377.9 |
| 30D | 69,160 / 1,420.2 | 69,160 / 2,817.8 | 69,006 / 801.2; 20 / 0.2 | 5 | 5,955.6 / 6,005.5 |
| All | 0 / 0 | 69,160 / 1,738.3 | 69,026 / 679.6 | 4 | 1,817.4 / 1,844.6 |

Fold inputs follow canonical reconciliation/legacy admission; replays are outside the snapshot. Today admitted 1,355 current + 941 prior window rows; 7D admitted 41,851 and 30D 69,160. Complete demanded histories are hydrated, then selected exactly after commit.

| Capture statement | Returned rows | Await wall ms |
| --- | ---: | ---: |
| Thin UsageEvent evidence | 69,160 | 1,475.2 |
| Selected full UsageEvent bodies | 2,312 | 762.3 |
| Retained legacy reports | 107 | 1,474.8 |
| Home settings/policy join | 1 | 1,474.6 |
| Stored price catalog | 1 | 28.9 |

Five application statements, 71,581 returned rows; excludes transaction controls, setup and control reads. These count returned records, not physical tuples scanned.
Boundary durations include Prisma queue/decoding and overlap: union 2,266.3 ms; capture outside DB intervals 186.1 ms, versus 3,121.0 ms previously.
Old Today: thin admission 69,160 / 1,523.9 ms, preparation 263.9 + 336.7 ms, body fold 2,314 / 397.5 ms; thin history dominated the 89.5% corridor.
Final separate replays: historical admission 69,160 / 1,447.6 ms; window admission 2,296 / 42.8 ms; preparation 339.3 + 284.0 ms; coverage 91.4 + 91.7 ms.
Actual post-commit batch fold now includes historical admission: 2,485.2 ms; pricing 43.5 ms; projection 368.2 ms. Replay timings are not additive exclusive spans.
Measured demands have insights/message counts disabled. Enabling those fields adds two range-bounded ORM statements per distinct range (Session membership and SessionMessage grouping).

## Owner and falsifiers

- Canonical capture owner: `apps/server/sources/app/usage/query/readUsageAnalyticsBatch.ts#captureUsageAnalyticsBatchInTx`.
- Storage: `query/loadUsageEventsForQuery.ts`; subject/baselines: `query/resolveScopedUsageContributions.ts`; historical coverage: `query/projectUsageCoverageEvidence.ts` (eventCount, asOfMs, completeness, reasons).
- Today evidence inputs: 69,161 current / 67,806 prior. Coverage groups: 258 / 256; window-only gives 28 / 12. Existing `usageQueryService.integration.spec.ts` retains 128 historical-only groups while hydrating two bodies.
- The prior comparison has 941 window rows plus 16 pre-window body baselines. Removing older history raises its tokens from 24,271,151 to 24,408,767 (+137,616).
- Derived: without reusable persisted summaries, exact historical counts/completeness still require historical work somewhere; an SQL aggregate merely relocates that scan.
- No historical coverage cutoff was shipped. Both event reads retain one MVCC snapshot; in-window canonical typed identities drive conservative SQL candidates, with exact history admission/replay after commit. Folding/pricing were already outside.
- Scalar and batch/NDJSON readers share accounting/projection. PostgreSQL uses the new candidate adapter; portable storage retains its existing exact selector, not a competing accounting authority.

## R123 failures and phase

Loaded logs (`r123-transaction-causes.log`): 17:22:33.704 “conflict” was P2028 `transaction-not-found`, read-only RepeatableRead, attempts=1; zero retries or Serializable/40001 evidence. Other failures expired.
`storage/inTx.ts` maps the vanished transaction to the generic conflict-exhausted response. Usage writes/materialization/explicit locking were absent; catalog capture reads stored data only.
`remaining-usage` is the QA observer label spanning F11, 30D/90D history and How-you-work actions, not a server stage. Original failed request payloads were not retained, so their exact range unions are unknown.

## Compiler and commit gates

- Constructed count RED→GREEN: 33,658 historical rows → only 7,262 window metadata admissions inside capture; unrelated historical metadata admissions zero, two event statements. Shared producer/root overfetch RED: 6 → 4 bodies.
- `window-seeds-integration.log`: 39 passed; `window-seeds-pg-current.log`: 3 passed, including opaque/JSON-string/Unicode identities and native Session attribution. Final compiler-fix focused rerun: 55 passed.
- Requested repaired server run completed (`server-typecheck.log`): predecessor touched locations 0 → 0; package exited 2 with 6,217 unattributed locations. Earlier lockfile-interrupted run was not compiler evidence.
- New completed run `server-r124-compiler-raw.log`: one owned diagnostic; final `server-final-compiler-raw.log`: owned 1 → 0, added 0, removed `projectUsageAnalyticsPopulation.ts:88:TS2345`. Selected inputs included the followup; no Usage inputs changed during checking.
- Package remains red: 6,412 locations, zero global diagnostics. Against the recorded 6,410-location baseline (`server-r124-complete.locs`), all 277 additions are unattributed CLI locations; no new server/Usage locations. Final inventory: `server-final-complete.locs`.
- O-DEPLOY's `usageSummary.ts:47:TS2345`: frontier values already receive `labels.get(key) ?? key`; their producer type now requires that label.
- `protocol-typecheck.log`: touched added 0, removed that location; unrelated `actions/specs/deployments.ts:79:TS2322` remains. Focused `protocol-focused.log` 54/55 plus unchanged retry `protocol-focused-retry.log` 1/1.
- Entry-loads `compiler-fix-entry-loads.log`: final current bytes 7/7; focused `compiler-fix-focused.log`: 55/55. Initial deployment export failures were repaired and rerun 7/7; one initial protocol timeout passed unchanged on retry.
- Source commits: `f7f668aa9e0f` → `54886f4a27d6`; protocol `4a666fa90c63`; final packet includes the metadata producer's type-only correction and this report. Private index → commit-tree → CAS update-ref throughout; no shared-index mutation or push.
- Net mechanisms: adapter files +1/−0 versus predecessor (first coarse adapter removed); internal raw capture representation +1/−0; typed identity projection +1/−0 reuses the accounting owner. Storage checks +1/−0 (`pg_input_is_valid` avoids casting malformed stored strings, tested). Product states/error codes/timers/retries +0/−0; no cache, cap, table or Prisma schema change.
- `docs/api.md` records capture/projection ownership. Self-review exposed and corrected the first adapter's overfetch; all-history equality and neighbouring identity cases remain GREEN.

**Residual risk:** historical thin transport remains proportional to history because exact coverage requires it; SQL candidate decoding also scans historical metadata. Shared-host samples do not establish a loaded HTTP speedup or guarantee absence of contention timeouts. Reload 124 predates the final fix; the orchestrator owns the next reload and live replay. No browser was opened.
