# USAGE-SWITCH-FREEZE-3-1107

Verdict: PARTIAL — repeated evidence folds fixed and committed; the switch still visibly freezes.
Observed unprofiled pointerdown-to-settled timing: **37.2 → 20.0 s**, longest task **10.1 → 6.0 s**.
[blocked] UI package typecheck remains queued for memory; adjacent failures reproduced with reuse bypassed.
Usage orchestrator: retain typecheck handle `54214`, inspect its eventual result, and own the remaining read/render work.

- Source commit: `9eb43599c65304b0325499f075dc945583848f39` (`perf(usage): reuse opened evidence aggregates across view switches`).
- Evidence directory: `.project/tmp/usage-switch-freeze-3-1107/`; JSON captures contain scoped counts/stacks, not bodies or credentials.
- Loaded: own single nl1 browser, Account A, existing `agent-qa-usage-insights`, reload 126; native Coach 90D → How you work.
- No stack restart/reload; Expo page reload loaded source. Final runtime probes verify FREEZE-1/2 and this owner/phase correction.
- Account key used on stdin only; owned browser closed and temporary remote root reclaimed at 00:28 UTC, November 8.

## Measurement and attribution

- Unprofiled `before-timing.json` → `after-final-timing.json`: 37,197 → 20,002 ms; 17 → 10 tasks; total 30,676 → 17,845 ms; max 10,135 → 5,999 ms.
- Correctly bracketed CPU/coverage `before-profile2.json` → `after-final-profile.json`: 23,106 → 16,735 ms; 9 → 7 tasks; total 19,660 → 13,757 ms; max 8,526 → 6,709 ms.
- Original supplied r126: 28.8 s. First own CPU capture: 37.5 s (`before.json`); its coverage includes stop-transport time, so counts are upper bounds.
- These are moving live cohorts, not a controlled causal speedup: accounting POSTs were 1 → 0; quota traffic also varied. Renderer pointerdown/settled bracket is authoritative, not runner wall time.
- Every task in the primary before/after CPU captures is below. B/A = before/after; offset and duration in ms; category samples are exclusive, named stack times inclusive and overlapping.

| Run | Offset | Duration | Attribution and deciding samples/stacks |
|---|---:|---:|---|
| B | 3109 | 300 | Fold/projection: 264; page aggregation / Coach. |
| B | 3442 | 154 | Decryption of quota metadata: openWithKindKey 80 inclusive; 40 crypto exclusive, 19 parse; no sealed work-fact opener. |
| B | 3611 | 8526 | Fold/projection: 4288; React 1681, parse 545, GC 181; readHowYouWorkEvidence 2219 inclusive. |
| B | 12200 | 259 | React render/commit: 245. |
| B | 12496 | 4914 | React render/commit: 4103; parse 219, GC 131. |
| B | 17411 | 367 | Unresolved: anonymous-only CPU stack; assigning one of the five categories would invent evidence. |
| B | 17816 | 1699 | React render/commit: 1406; fold 63, GC 47. |
| B | 19603 | 707 | React render/commit: 677. |
| B | 20315 | 2734 | React render/commit: 1439; fold/projection 1114; progress → page aggregation. |
| A | 2417 | 287 | Fold/projection: 255; Coach finding digest / page aggregation. |
| A | 2757 | 132 | Decryption of quota metadata: openWithKindKey 74 inclusive; 40 crypto exclusive, 17 parse; no sealed work-fact opener. |
| A | 2908 | 6709 | Fold/projection: 2806; React 1554, parse 524, GC 251; readHowYouWorkEvidence 1866 / readSessionInputPhase 1710 inclusive. |
| A | 9674 | 202 | React render/commit: 196. |
| A | 9926 | 3213 | React render/commit: 2717; parse 209, GC 88. |
| A | 13459 | 1504 | React render/commit: 1258; GC 57. |
| A | 14977 | 1710 | React render/commit: 1454; GC 44. |

## Owner finding and correction

- Observed: the switch does **not** fetch/open the 34 MB, ~3400-record population again. Unprofiled captures: 0 evidence POSTs; primary CPU before: one seven-candidate `readWorkFacts:true` POST, unfinished at bracket end; after: 0. Compact opens: 0 in both CPU brackets.
- Derived: different Coach/How-you-work output flags are not different canonical evidence demand. Already-opened Session inputs are reused, but fresh flattened fact/activity arrays defeated the existing Protocol interval owner's reference reuse.
- `usageQuerySessionInputs.ts` now retains the aggregate with its opened inputs; `usageQueryResource.ts` delegates to that owner. No widget-local cache or second folding algorithm was added.
- Loaded identity probe (`identity.json`) exposed repeated 806-Session refusal-subset / 3634-Session complete phases overwriting a single aggregate. The final retention key includes the existing admitted phase; no new admission decision/state machine.
- Primary CPU counts B → A: accounting/evidence POSTs **1/1 → 0/0**; compact opens **0 → 0**; aggregate projections **30 → 0**; interval computations **10 → 0**; page aggregations **14 → 14**; React roots **34 → 31**; widget bodies **71 → 71**.
- Sealed work-fact decryption contributes zero measured switch opens; sampled quota crypto totals ~50 → 48 ms. Coach evidence decryption is not the dominant switch cost. No persisted-format or Coach-record split implemented.
- Owner/callers audited: Account Session inputs, selection/publication phases, resource batches, Coach/How cohorts, work-evidence projection and Protocol interval reuse. Resource-owned array rebuilding removed; Protocol reuse retained as the sole interval decision owner.
- Net mechanisms: checks +2/−0 (reuse eligibility and valid-scope retention consume existing facts); retained aggregate map +1/−0 at Account input lifetime; states/error codes/timers/retries +0/−0; source files +0/−0, three modified. The map prevents reproduced repeated folds; dispose clears it. One internal projector seam replaces local rebuilding.

## Validation and residual risk

- Constructed RED: mixed readable/refused cohort revisits fact getters **5632 first / 7040 revisit** (`red-mixed-phase.log`). GREEN **0 / 0**, compact opens 0, first accounting/evidence reads 1/0, revisit reads 0, renders 24 first/27 revisit, settled extra renders 0 (`green-withdrawal.log`).
- That real HTTP/React test also verifies changed accounting/intervals and subsequent refusal withdrawing retained facts. Entry-loads **7/7** (`entry-load.log`); subsequent phase-key edit changed no import graph; final source passed focused test and loaded browser probes.
- Adjacent: 31 pass/6 fail (`green-adjacent.log`); final targeted set 8 pass/1 fail (`green-final.log`). The same failures persist with reuse bypassed (`adjacent-ab.log`, `refusal-ab.log`): five stale HTTP expectations, sibling identity, and exact partial-source equality rejecting its existing forbidden code.
- Typecheck `typecheck-public.log`, handle `54214`: still queued, not a pass. Earlier targeted attempts did not launch with a valid baseline; no diagnostics-delta claim. Source committed through private index → commit-tree → CAS; shared index preserved; no push.
- Author attack strengthened the fixture to mixed refusal phases and added changed-input/withdrawal controls; the first one-slot variant did not improve live (`after-profile.json`) and was replaced. No external documentation contract changed.
- Residual: final 6.7 s task remains in read/admission-basis projection plus React; later tasks are React dominated. One baseline anonymous task is unclassified. Native mobile/desktop QA and independent integrated review were not run; Usage orchestrator owns the queued package result and next integrated boundary.
