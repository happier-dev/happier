# USAGE-PAYLOAD-IDLE-1107

**Verdict: BLOCKED — diagnosis delivered; no production fix or before/after gain claimed.**
A needs an authorized read-scope contract; B historical causality is unavailable; C RED cannot launch.
Target: QA reload 121; no restart/reload performed. Test-only commit requires no reload 122.
Evidence `E = .project/tmp/usage-payload-idle-1107/`; counts/bytes only, opened content stayed in memory.
Recovery key used only on stdin; owned nl1 browsers closed, including `E/c-cleanup-ready.json`.

## A — compact payload

Historical: 3,406 rows / 29,896,168 bytes; turns 3,799,586; other/framing 26,096,582 (`E/baseline.json`).
Fresh: 3,415 rows / 33,669,585 bytes; 3,368 encrypted records (`E/live-browser-census.json`); nested totals overlap.

| Field/subtree | Count | JSON value bytes |
| --- | ---: | ---: |
| `workFacts.content` | 3,415 | 26,838,296 |
| `workFacts.content.c` | 3,368 | 26,764,012 |
| `workFacts.session` | 3,415 | 2,631,305 |
| `workFacts.session.access` (nested in session) | 3,415 | 1,390,240 |
| `turns` | 3,415 | 3,806,518 |
| Opened current fact | 3,368 | 19,749,225 |
| `evidence.coach` | 3,368 | 11,057,935 |
| `coach.composition` (nested) | 3,368 | 7,351,551 |
| `coach.detail` (nested) | 3,368 | 3,511,040 |
| `evidence.facts` | 3,368 | 1,778,676 |
| `evidence.phaseEvents` | 3,368 | 1,619,469 |
| `evidence.acceptedInputs` | 2,656 | 1,329,248 |
| `evidence.closedTurns` | 3,368 | 1,011,889 |
| `session.ownerMetadata` | 3,368 | 1,013,795 |

Complete table: `E/live-opened-fact-census.json`. Sealed content is 79.71% of response; Coach 55.99% of opened facts.
Owner: Protocol `createUsageSessionWorkFactsV1` → UI `persistUsageCompactInput`; server returns opaque admitted records.
E2EE prevents server field projection. Coach consumes composition/MCP/model/remedy context; How you work uses compactions.
Both surfaces declare identical evidence flags. Dropping shared fields would remove consumed data.
**[blocked]** Exact surface reads require explicit read scope and scoped encrypted records, conflicting with no schema edits.
Next: authorize that wire seam or assign its owner. No schema edits, payload RED, or post-fix byte evidence exists.

## B — idle traffic and conflict

Historical 60,057 ms: 10 GETs (1/5/3/1), one PUT 409. Collector lost endpoint suffixes and causal/material witnesses.
Pre-outage fresh 60,001 ms: 6 `sources/resolve` + 5 `record` GETs, all 200; zero PUT/409; settling unproven.
Post-recovery fully settled 60,033 ms: **0 qualified requests**, provider API/compact reads, observed targeted
Home/usage socket events, or long tasks (`E/c-switch-profile-ready.json`). Canonical invalidation observer unavailable.
This is baseline evidence, not an after-fix improvement. No current settled polling timer was found.
**[blocked]** Each historical GET's poll/unchanged-push/real-change classification cannot be recovered from those logs.
View-switch GETs originate in `readUiUsageQueryBatch` → `readOpenedQuotaHistory` → `readQuota`; changed view demand.
PUT issuer: UI `readProviderAccountUsageProjectedQuota`, `apiProviderAccountUsage.ts:291`, `/history`.
Server `pageProjectionStorage.ts` returns projection 409 for missing parent, count/frontier mismatch, or lost full-content CAS;
mode mismatch is a different 409. Historical subtype/cause remains unproven; typed recovery reopens canonical coverage.
Keep CAS: history can advance without metadata changes. Freshness-only writes suppress Account publication;
`usageHttpReads.invalidate` retires only a pending join partition, emitting neither a push nor a GET.

## C — view-switch freeze (added scope)

All 11:51–12:53Z live timings/failures are discarded; `E/c-switch-profile.json` is outage-invalid.
Valid nl1 rerun: one Coach → How you work switch, 12:58:55.523–13:00:45.640Z,
**110.117 s to settle**, with **23 long tasks / 36.835 s overlap / 5.671 s maximum**.
This is not a 110-second freeze: CPU samples included 65.395 s idle; profiling overhead applies.
Inclusive CPU: query projection 6.866 s; `resolveUsageHowYouWork` 3.986 s; React render root 10.458 s.
Coverage: How-you-work resolver 44 executions; interval projection 64; calendar bounds 395,250;
batch projection 38; Rhythm/Human Loop/Parallel renders 52/16/15. Inclusive times overlap.
Three compact POSTs selected one Session each; **no full-population reread**. Fact-row visits/commits unavailable.
Bootstrap was 3,423 rows / 35,016,729 decoded bytes; moving-Account observations, not before/after results.
Three scoped encryption errors, five untyped provider errors and four status-free failures occurred.
Successful provider cohorts were unchanged. Current browser bundle identity was not independently verified.
F11 occurred during Read now, excluded here; same-cause attribution remains unproved. `E/c-switch-profile-ready.json`.
Derived owner lead: new cohorts flatten retained Session facts into new arrays, losing existing interval-owner reuse.
That owner already keys by facts/activity/period/offset/night; preserve producer identity rather than add a view cache.
**[blocked]** Corrected compact-fact count oracle has not executed; no intended RED or production correction.
First run failed harness placement readiness, corrected via real frame demand. Remote retries then failed before Vitest
with foreign `ERR_PNPM_OUTDATED_LOCKFILE`; local no-install retry failed `prisma-outputs-incomplete`.
Next: dependency owner restores prerequisites; rerun same test, establish RED, fix Account Session admission owner,
then verify genuine fact change, access withdrawal, and measured-population scale. `E/idle-coach-switch*.log`.

## Validation and handoff

- Current compact SQLite owner baseline: **4/4 PASS**, terminal exit 0, `E/compact-current-contract.log`.
- Constructed storage: 60 identical observations → **0 writes**, unchanged cursor; freshness → no publication;
  real plan change advances cursor. **1 PASS / 19 skipped**, terminal 0, `E/idle-server-publication.log`.
- Extended Home/meter contract: 12 unrelated source-status pushes over one fake idle minute → **0 extra GET/RPC**;
  real quota change → 1 qualification + 1 record read. **32/32 PASS**, terminal 0, `E/idle-current-contract.log`.
- Entry-loads **7/7 PASS**, terminal exit 0, `E/entry-loads.log`. No package diagnostic delta is claimed.
- Idle contracts committed `2e801c6e3929`; private index → commit-tree → CAS, shared index untouched.
- C diagnostic test uncommitted/unverified; production checks/states/errors/timers/retries **+0 / −0**.
- Legacy transcript read/abort untouched (USAGE-WIDE-WINDOW-1106); no dependency/schema edits.
- No UI-only production fix landed. Future A contract/server scope needs orchestrator deployment adjudication.

Residual risk: no production correction is yet verified; do not use these baseline counts as a ship gate.
