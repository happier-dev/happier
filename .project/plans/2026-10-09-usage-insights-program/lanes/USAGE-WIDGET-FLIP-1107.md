VERDICT: requested correction committed as f02651f616; focused owner tests 2/2 and entry-loads 7/7 satisfy the user-selected 11-07 lane gate. F11 already covers unrelated idle reads. Adjacent validation remains pending; the earlier broad run was red (24 failures), not green or attributed away.

# USAGE-WIDGET-FLIP-1107

## Result and owner
- Observed: F11 already stops the reported unrelated idle reads. No second wake filter was added.
- Observed: the real-store regression passes with accounting enabled and disabled (`green-corrected.log`).
- Twelve unrelated socket wakes perform zero resolve, record, history and accounting reads, retain quota identity, and publish no changed text-driving state.
- Constructed RED: an unchanged exhausted quota, aged just beyond its observation deadline midway through a displayed minute, was published as available at read completion (`red.log`, 2 failures).
- Derived cause: cache reconciliation and completed-read reconciliation disagreed about the freshness of that same observation; minute-rounded presentation exposed the alternating answer.
- Fix: `apps/ui/sources/sync/api/account/usageQueryResource.ts#reconcileQuotaRead` uses the existing `isConnectedServiceQuotaObservationFresh` policy for retained-cache, cache-row and completed-read paths.
- The source observation time decides freshness. A completed fetch does not renew it; a genuinely newer provider observation still becomes available.
- The real-store test also exercises unchanged Profile/store/cache publications, relevant quota wakes, material history changes and the fresh-observation recovery control.

## Reachability and split-brain audit
- One Resource reconciler owns the quota source state across initial reads, cache observation, progress/completion and sibling Resource replacement.
- Home/Settings/Usage widgets consume it through `useUsageWidgetResource`; Usage Actions, plugin Resource surfaces and pool ordering use the same Resource store.
- Capacity's existing cell presenter consumes the Plans projection's stale fact. No consumer guard, memo, debounce or alternative text policy was added.
- The protocol freshness helper remains the numerical policy owner; the old fetch-time comparison and unconditional completion-to-available answer were replaced.
- Existing minute precision is presentation, not a provider observation. Existing structural sharing retains unchanged facts; no new equality/cache mechanism was added.
- No wire, persistence, query shape, dynamic import, layout, accessibility, translation or platform-specific path changed; no canonical documentation contract needed updating.

## Evidence and validation
- Evidence root: `.project/tmp/usage-widget-flip-1107/` (all filenames below are relative to it).
- Reused prior completed work: `baseline.log`, `red.log`, scoped `live-before.png` / `live-after.png`, live JSON, loaded-module probes and browser cleanup. No stack restart/reload or second browser was performed by the continuation.
- Loaded live: reload 125, `agent-qa-usage-insights`, Account A; server listener PID 483268, daemon bundle e9c7b2e1ff0753a8; borrowed repo-dev Expo (`runtime.json`).
- `live-before.json`: 19:59:15–20:00:45 UTC, 90 seconds, zero captured requests and zero text changes; confirms the idle-read part was already quiet.
- `live-after.json`: 20:12:25–20:13:55 UTC, 90 seconds, zero captured requests and zero text changes; scoped screenshot inspected during continuation.
- Loaded owner probes: `loaded-owner-before.json` preserves the old completion decision; `loaded-owner-after.json` records one bundle match at 20:18 UTC but does not preserve its search needle. That count alone is not independent proof of the exact patched expression.
- Browser cleanup: `browser-cleanup.log` records the lane browser PID gone and its profile removed.
- GREEN command: `hstack-exec -- pnpm --dir apps/ui exec vitest run sources/sync/api/account/usageQueryResource.test.ts -t 'keeps settled quota history through unrelated changes'`; exit 0, 2 passed / 204 skipped (`green-corrected.log`).
- Entry command: `hstack-exec -- pnpm check:entry-loads`; exit 0, all seven graphs passed (`entry-loads-continuation.log`).
- Adjacent continuation: pending (`adjacent-corrected.log`); original terminal handle 41688, linux1 Vitest PID 1500983 / worker 1502133. Four suites: invalidation, Resource stability, Plans model and Capacity widget. Retain this run; do not start an equivalent duplicate or re-pin it.
- Runtime diagnostics (`adjacent-process-diagnostic*.log`): CPU ticks advanced between 21:50 and 22:02 UTC; runner remained active in collection with no test verdict. No lane timeout or cancellation was applied. Integration owner must collect its eventual terminal result.
- Prior broader evidence: `adjacent-initial.log` had 212 passed / 24 failed. Its two lane cases now pass; the rest are not declared unrelated without an A/B or otherwise closed by this lane.
- Two continuation invocations selected the repository root and found no test files; both exited 1, and were corrected to the UI working directory (`green-continuation.log`, `adjacent-continuation.log`). They are not test results.
- Package typecheck was not run per the 2026-11-07 lane gate; the shared per-wave UI integration owner retains that obligation. No package-green or diagnostic-delta claim is made.

## Commit and mechanism delta
- Code and regression: f02651f616823a7f94249af69e4f51a2850ae94a (`fix(usage): keep quota freshness stable across unchanged reads`).
- Board RESULT posted at 2026-11-07 22:08 UTC to Usage orchestrator and P03-IDLE-PAGES via the guarded writer; first bullet names their integration/follow-up actions.
- Private index, verified current-machine identity, `commit-tree` and CAS `update-ref`; only the two Resource source/test paths committed. Shared index and unrelated work preserved; no push.
- Runtime checks +3 / −1: two freshness decisions replace unconditional retention/completion answers and one canonical observation check replaces the fetch-clock check, preventing stale-to-fresh flips at the owning reconciler.
- States +0 / −0; error codes +0 / −0; timers +0 / −0; retries +0 / −0; production/test files +0 / −0 (two existing files changed); lane report +1 / −0.
- Self-simplification found no need for a new consumer mechanism. Positive recovery remains tested; no existing freshness or recovery behavior was suppressed.

## Residual risk
Adjacent continuation results remain pending and the earlier broad failures are not fully adjudicated. The exact needle of the prior loaded-owner-after probe was not retained; current-source owner tests and stable live observations are separate evidence. Full package typecheck/native-device QA are not claimed; live captures are reused reload-125 observations, not a new replay of later shared-checkout changes.
