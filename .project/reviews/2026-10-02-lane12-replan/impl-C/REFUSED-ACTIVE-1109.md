IMPLEMENTED_NOT_VERIFIED — member composition blocked by manifest admission; host composition still preparing; loaded replay owed to Fork C.
Observed: R106/R108 runners 3008, 5504 and 5441 still exist on the retained guest; this is not delivery to a nonexistent runner.
Read-only guest projection: `qa-shots5/gaps/REFUSED-ACTIVE-1109/guest-projection.json`; SSH/limactl exited 0, no lifecycle mutation.
Member logs 3008/5504 line 96 record `agent_runtime_open/resource_unavailable`; lines 97–99 all return `no_pending`.
Derived cause: `runHostSessionRuntime` publishes the failed turn, then `serveFailedStartupInputs` waits forever for an original the refused caller never admitted; publisher presence continues.
Owner reused: Session host construction lifecycle → input consumer `readLiveWork` → existing `session.close` → server publisher-presence close. No server activity override.
Fix: a retiring failed receiver consumes the input owner's authoritative settled fact and releases construction custody without waiting for future input.
Queued originals retain existing refusal settlement; unknown input retains custody. The deferred failure transcript now publishes even when no original exists.
RED: `hstack-exec --local -- pnpm --dir apps/cli exec vitest run src/agent/runtime/session/loop/serveFailedStartupInputs.test.ts` — 1 timeout/2 pass, empty-input receiver never retires.
GREEN: same command — 3/3 pass, exit 0; queued-original/retryability controls retained.
Entry-loads: `hstack-exec --script=check:entry-loads` — all 13 reported graphs passed, exit 0 (including all core entries).
Host composition: Codex/Claude recorded Team error + empty Pending regression added in `runHostSessionRuntime.runtimeCatalog.composed.integration.test.ts`.
[blocked] Its full-preparation command remains handle 75044, before Vitest; preparation reported TS2883 in Copilot, Machine settings, Oh My Pi and continues waiting. Preserve this handle; do not requeue.
Member composition: existing `runHostSessionRuntime.piUserMcp.test.ts -t member-native` now raises the real Team error after separate-users preparation and asserts failure + close.
[blocked] That run exited 1 before Session setup: `readOpenableContentViewerDestinationDiagnostics`, protocol `plugins/manifest/ingest.ts:749`, undefined `ui.views`; no lane diff in that file. Integration/plugin owner must restore admission, then rerun this case.
Typecheck: not launched, per lane instructions; integration wave owns it. Browser/lifecycle/live Stop+Archive replay not run, per lane boundary.
Same-shape sweep: failed startup receiver waiting for absent input — 1 serving owner fixed; all launch-refusal codes and Agents route through it, including resource_unavailable, broker_unavailable, provider/model refusals; Codex/Claude host and Pi separate-users checks authored as above. Bootstrap and live-loop cleanup already close directly, retained as separate lifecycle phases.
Touched: `apps/cli/src/agent/runtime/session/loop/{serveFailedStartupInputs.ts,serveFailedStartupInputs.test.ts,runHostSessionRuntime.ts,runHostSessionRuntime.runtimeCatalog.composed.integration.test.ts,runHostSessionRuntime.piUserMcp.test.ts}`.
Net mechanism delta: +1 existing-fact read at failed-receiver retirement / −0; states/errors/timers/retries +0/−0; production files +0/−0. No reaper or polling.
Self-attack: queued work still settles; no parallel activity authority; late input after empty observation remains recoverable through inactive Session resume. No persisted/wire format or published feature contract changed, so no canonical documentation update required.
Commit uses current bytes, including compatible pre-existing tool-normalization and startup-refusal fixture hunks in the two shared host files; no push.
Residual risk: automatic retirement/Stop/Archive on the loaded member runtime remains unverified. Fork C must load the fix and replay the recorded B/C refusal shape after the composition prerequisites recover.
