STATUS: SOURCE_ALREADY_PRESENT — current HEAD includes 4121906d62's Voice hunks, both original diagnostic fixes and the TS2322 null-fallthrough closure through 0e2dac7b99; reconciliation commit/checks pending. Authenticated live check remains owed.

VOICE-RECONNECT-REASON-1102 carries the Connected Services owner's reconnect diagnostic and profile through Voice startup to the existing terminal error copy.
Blocked: live Start Voice/Send and full Account-settings restoration need an existing authenticated QA tab. Borrowed Expo is healthy; this lane's fresh browser is unsigned-in.
The single permitted coherence run failed with two own diagnostics. Both source fixes landed, but no second compiler run was made; a passing coherence verdict is not claimed.

Observed implementation:
- The canonical credential diagnostic builder decides action-required, retryability, service and profile. Voice consumes it; no reconnect-code table was added.
- Run factory/manager errors, repeated redaction, public Run failure details and retained failures preserve the canonical diagnostic.
- Session launch projection and carrier Action transport preserve it; RPC, rejected text turns, terminal runtime state and snapshots carry it to both presenter callers.
- The existing connected-service presenter supplies its translated reconnect copy. Retry follows owner retryability and suggested action; temporary refresh remains retryable.
- Removed the Voice-local refresh classifier and duplicate RPC branch. Speech Provider credential remediation remains separate because its credential owner differs.
- Snapshot publication includes diagnostic-only changes and explicitly clears the diagnostic after recovery, preventing stale reconnect copy.
- No layout, translation, settings, credential, admission or stack lifecycle changes. No public documentation update: this restores the existing contract.

Observed constructed RED → GREEN (logs under `.project/tmp/voice-reconnect-reason-1102/`):
- `owner-red-local.log`: carrier launch projection lost the owner's diagnostic/profile.
- `consumer-red-local.log`: terminal Voice lost the diagnostic and offered Retry for reconnect.
- `owner-final.log`: four focused CLI suites passed, four matching cases (213 skipped): real manager/factory failure, retained Run error, repeated redaction and carrier launch contract.
- `consumer-local-closure.log`: three UI suites passed, five matching cases (109 skipped): carrier reconnect/temporary refresh, RPC transport and terminal copy/recovery behavior.
- `store-browser-red.json`: the loaded real snapshot owner ignored the diagnostic-only change (publication=false, retained=false).
- `store-browser-green.json`: after the two-line owner fix and reload, publication=true, retained=true and clearedAfterRecovery=true.
- `store-local-green.log`: all three snapshot subscription tests passed, including identical-snapshot notification behavior.
- `entry-loads-final.log`: 7/7 entry loads passed, exit 0 (daemon preparation, daemon, CLI, inference worker, server, UI catalog, SDK browser).
- Earlier RPC encryption and carrier admission failures were fixture gaps. Canonical plaintext Session responses, a current-Account token fixture and the managed Machine census boundary resolve the focused cases above.
- The initial factory probe wrongly expected synchronous rejection. The API accepts a receipt; the corrected retained-terminal assertion passed in `owner-final.log`.
- Queued nl3 follow-up test clients were cancelled individually after local dependencies recovered; deciding replacement checks used `hstack-exec --local`. No stack was touched.

Coherence and commit:
- `coherence.log`: exactly one `hstack-exec --local --allow-local-compilation -- node scripts/workspaces/checkCommitTypeCoherence.mjs` invocation, exit 1; changed=27, roots=455, new=2, unowned=0.
- Fixed TS2339 with the existing `launchError` union guard; fixed TS2741 by adding the diagnostic to the snapshot owner's exhaustive field inventory, plus its recovery clearing assignment.
- Focused tests and the loaded-store probe passed after these fixes. No post-fix typecheck or whole-package green verdict is claimed.
- Commit assembly uses explicit own slices in a private index and HEAD compare-and-swap, preserving foreign dirty/index hunks; no push.

Live QA:
- Requested target remains `agent-qa-voice-dev` restart88, built-in Codex bound per Session to codex3 `92fe29be-575b-4551-8e90-edaacc3ec7a4`.
- Reloaded after final EXPO READY at 13:20Z and after the snapshot fix at 13:37Z. `runtime-info.json` records stack identity; `browser-store-fix-reload.json` records the latter reload.
- `live-prerequisite.json` observes settingsScope=null and visible sign-in choices; `live-account-required.png` captures this prerequisite. An existing authenticated tab was requested.
- No credentials were imported/reconnected/revoked and no Account settings were changed. Start/Send, per-Session pin, reconnect screenshot and full settings comparison remain owed; `differences=[]` is not claimed.
- Next action: borrow an authenticated tab for the existing Account, snapshot all current settings, pin that profile through Providers, Start Voice and Send once, capture the reason, restore and compare all settings. Do not restart the stack.

Self-review: traced both presenters, both startup adapters, retained Run and rejected-turn paths, carrier launch projection and subscription/recovery clearing. Independent review found no remaining confirmed defect; `independent-terminal-consumer.log` records its separate current-source rerun: exit 0, two cases passed (four skipped).
Net mechanism delta: authority/credential checks +0/−0; states, error codes, timers and retries +0/−0; Voice-local diagnostic classifiers +0/−1; duplicate RPC branches +0/−1; files +3/−0 (startup adapter, focused Run regression, this report). Additive typed fields transport existing owner facts to prevent the reproduced loss.
Residual risk: no passing post-fix coherence verdict or authenticated live reconnect replay. Live evidence must also establish that the retained daemon emits the new owner fields; no stack restart is authorized.

14:36Z reconciliation: compared the original commit's before/after blobs with observed HEAD ef08fa31889e8b00105284972e34ee71878d4e2a and current working bytes. Every original source hunk is already in HEAD; the carrier fixture differs only because HEAD already has the corrected Response | null contract. The guarded launchError read and snapshot field inventory/clearing fixes are also present. No source hunks need replay, and unrelated working-tree changes are excluded. The requested fresh private-index/CAS commit records this reconciliation only; its coherence run cannot certify inherited TypeScript because it changes no TypeScript roots. Focused tests and seven entry loads are rerun separately. Authenticated live QA remains owed.
