> Current verdict, reload 119: target_start_failed comes from Claude native-auth preflight returning agent_signed_out. Coordination owns the earlier native-resume row; evidence is routed to Coordination / Providers ORCH. No transition patch or Account/stack mutation is justified.
> SEC-USAGE-1106 F1 reproduced RED → GREEN: real router 3/3 and daemon proof binding 4/4 pass. Exact Session readTranscript admission replaces all three optional-scope bypasses; decrypted requests are bound to that proof.
> Custodian-only is rejected: existing Machine admission supports requester-owned New Session/resume. Own and read-shared Sessions remain admitted; another person's unshared Session is refused.
> Security committed: `2926f623143199e8e60b06cb43dd810b32cbd6f6`; canonical finalizer new=0, unowned=0. Foreign second-ACL guard removal excluded as directed. Refreshed router 3/3, daemon 4/4 and public protocol typecheck pass.
> Target custody committed: `569b55145cd20b413ac4f834b2b263afbb0d1ffd`; RED → GREEN 53 checks, canonical finalizer new=0/unowned=0. Both source fixes are ready for orchestrator reload 118.
> Terminal invocation committed: `7a3a971484f21446b5bb6dfe6e40b2f767fdc622`. Real authenticated control-route RED → GREEN; unstamped Account remains forbidden. Finalizer new=0/unowned=0, moved-HEAD CLI recheck passes. Reload 119 owns the live replay.
> Adjacent run: 102 pass / 18 fail; fallback-bypassed comparison reproduces 16 failures plus terminal `forbidden` RED. Two Account-controller failures pass both comparison and restored-source rerun (4/4 GREEN); their original failures remain unattributed. Earlier fixture failures are excluded.
> Public CLI/UI attempts exited 2 without complete diagnostics: not run, no delta evidence. CLI/server/UI replacements remain queued on nl1 at this handoff; package checks are not run, not zero-delta. No queued job was duplicated or timed out.
> Original commit: `e38e25098110bc79cb9267b5fe580cadb9824831`; finalizer new=0, unowned=0.
> Home-connect diagnosis is now exact: profile adoption throws `Home identity conflicts with URL`. Updated ASK routed to Home/server-profile owner at 09:52; no Home changes.

## Observed basis
- Stack: agent-qa-usage-insights, server :3011, daemon on nl3; original diagnosis reload 116, follow-up reload 117.
- Reload 117: server `f8b7cb372304e541`, daemon `d5f6e314bb58580d`, observed daemon PID 4107396.
- Loaded shared stack-state source-bundle maps, rather than dist, were inspected. Evidence: `.project/tmp/usage-live-prereq-1106/`; QA: `.project/tmp/qa-usage-journey-1106/`.
- No stack lifecycle, dependency input, Account setting or Home configuration was changed.

## Security correction — exact Session read access
- Reproduced: a real Machine Use grantee's unscoped call reaches the custodian daemon for inspect, batch and brief (`security-router-red5.log`); daemon separately admits missing proof (`security-daemon-routed-red.log`). Earlier invalid fixtures and dispatch failures are not disclosure evidence.
- Protocol's existing Session RPC owner now requires `session.read`; server calls `resolveSessionAccessForOperation` with readTranscript. Daemon's existing authorizer binds `sourceSessionId`/`sessionId` to the proof and never spends it on mutation. HEAD's redundant forwarding ACL guard stays in this commit; its removal remains the producer's work, as directed by the orchestrator.
- Consumers updated: UI single/batch inspection, UI brief preview, CLI Workflow recovery observation. Server-only routing remains; no daemon ACL owner or fallback transport added.
- GREEN: router rejects unscoped/unshared requests, admits own/read-shared Sessions; daemon rejects absent/write/substituted proofs and read proof on mutation. Own-Session routing does not prove custodian decryption of requester-isolated content.
- Authorized focused --local queues never executed: both cancelled (143) after controller saturation; original remote duplicates cancelled (130). All actual RED/GREEN ran routed; no further local runs. Evidence: `security-diagnosis.json`.
- Matching unreleased Protocol/Home/daemon/UI tuple is required; mixed readers fail closed. Canonical contract updated in `docs/compatibility.md`.
- Earlier current-source entry graphs 7/7 and UI transport tests 8/8 pass; full router 18/18 passes. Refreshed router 3/3 and daemon 4/4 pass. A rerun first used the wrong unit config (no tests); daemon first hit a concurrent protocol import crash, already removed in current source. Corrected reruns pass; logs are `security-resumed-*`.

## Original picker and prices repairs — loaded confirmation
- Observed at reload 116: daemon handlers and stored credentials exist; the loaded server authorization map omits inspection, batch inspection and brief preview.
- Reproduced: the socket dispatcher refused all three; original optional-scope repair caused F1, superseded by the exact-Session correction above.
- Prices and query share the CLI signer; the loaded server lacks the signed price purpose. Owner tests reproduce null verification for both price roots.
- Fixed in server `isAccountActionHttpPurpose`, using the existing price-ID, route and input owners; wrong methods, inputs and effects remain refused.
- Observed by QA at reload 117: native prices get/refresh PASS; single/batch/canonical inspection available for Claude/OpenCode.
- Evidence: `loaded-daemon-credentials.json`, `loaded-server-owner.json`, `red.json`, `green-adjacent.json`; QA `r117-*` artifacts.

## Reload 117 transition refusal — requester custody
- Observed: the LOADED coordinator shares catalog-target and provider preflight with inspection; its additional target-default admission catches `ConnectedServicesDefaultUnavailableError` as `target_unavailable`.
- Observed: the lifecycle adapter dropped `params.savedSecretOperationContext`; the spawn-default owner then compared an ambient invocation bearer with `readStoredCredentials().token`.
- Observed, without printing credentials: QA CLI and daemon bearers differ for the SAME Account (`r117-credential-equality.json`). Derived: ambient bearer comparison retires admitted requester custody; this is a currentness split, not another catalog/provider decision.
- Loaded daemon log clock is UTC+01:00. At 08:48:24.948–25.631 and 08:57:46.345–50.266 local, external dispatch is admitted/completed; requester settings phases complete.
- The old catch logs no default-refusal reason. Exact earlier live branch attribution remains derived; QA selection fields were not retained.
- Falsifier/control: loaded real default resolution succeeds for both targets with the daemon bearer; its present purpose catalog has no Claude/OpenCode default, so native authentication is valid.
- Reproduced RED: current requester context plus a different ambient bearer returns exactly `rejected / target_unavailable / sourceEffect:none`.
- Fix: forward existing requester custody through lifecycle Action → coordinator → spawn-default owner. GREEN: current custody transitions, expired custody refuses before stop; Team refusal/rebinding and native-default controls pass.
- No setup was justified by the custody refusal. Owner connected Claude/Codex accounts; QA's corrected Account A replay spawned Codex and inspected Claude, then hit the distinct authority refusal below. Vendor auth remains a separate launch requirement.
- Source copy check: `continueSessionWithArmedAgent.ts` maps `target_unavailable` to “{Agent} isn’t available on this machine. Nothing was sent.” (`en.ts:9778`). It supplies neither the underlying reason nor a setup recovery action.
- Separate source finding: that UI send path still invokes `runSessionAgentTransitionOnMachine` using the raw transition RPC, while the daemon registers only read operations and mutates through Actions. Its presence in the QA browser bundle is unverified; this may independently explain no divider.
- Evidence: `r117-diagnosis.json`, `r117-loaded-owners.json`, `r117-call-daemon-evidence.json`, `r117-rpc-completions.json`, `r117-owner-defaults-probe.json`.

## Corrected native replay — separate invocation refusal
- Observed: QA `corrected-native-replay.json` ends at 13:17:56.033Z with parsed CLI `ok:false/errorCode:forbidden`; the full error response was not retained. The custody RED instead returns `rejected/target_unavailable/sourceEffect:none`.
- Observed: daemon line 251721 at 14:17:55.516 local (UTC+01) logs POST `/actions/root/execute`, HTTP 200, 57 ms. No external transition dispatch is recorded in that window.
- Loaded source maps confirm: private root supplies terminal authority/V1 input but no admitted invocation; `executeExternalAction.ts` selects requester/controller invocation only, then returns exactly `forbidden` for unstamped transition before its executor. Current HEAD retains this guard. Derived: this replay is refused before target/default admission.
- Orchestrator assigned the private CLI root repair here after the ASK. The authenticated route forwards its existing host invocation type, surface and authority. The unstamped guard stays unchanged; RPC/HTTP Account ingress cannot supply this host-private field. No new invocation kind or Account/Home policy.
- Reproduced RED: real control route returns `forbidden`; GREEN: terminal reaches the real coordinator's feature-disabled refusal, while unstamped Account stays forbidden (`r119-red-http.log`, `r119-green-terminal.log`). Missing HTTP, bare executor and missing stored-session provenance were fixture failures, excluded (`r119-diagnosis.json`).
- A/B with the final real-executor/terminal-credential fixture repeats exactly `forbidden` when only the host invocation fallback is removed (`r119-adjacent-baseline.log`). Only that expression was bypassed and patched back onto current bytes; no foreign work was restored. Comparison: `r119-adjacent-comparison.json`.
- Restored-source focused GREEN: 4/4, including both Account-controller cases (`r119-restored-green.log`). Sixteen broader failures reproduce without the fix: approval-context expectations, additional typed target-refusal fields, Environment envelope fixtures and plugin-availability HTTP fixtures. No complete adjacent-suite GREEN claimed.
- Terminal finalizer: changed=3, roots=112, new=0/unowned=0, then a successful CLI recheck after HEAD moved (`r119-finalizer.log`). Only 3 owned files, 58 insertions/2 deletions committed. Shared-index synchronization retained both foreign staged deltas; initial temporary-index merges conflicted, so only the reviewed invocation hunks were applied to captured staging. Worktree and unrelated staging remained unchanged (`r119-commit.json`).

## Reload 119 target startup — native authentication owner
- Observed runtime: source 19:53:27Z, daemon `de8c897363f67d68`, server `c6d34f12f7a7ab4c`; QA transition returns partially_applied/target_start_failed at 20:43:55Z. Owned Session retained.
- Actual nl3 root is `/home/happier/.happier/dev-targets/nl3/stack-state/agent-qa-usage-insights/cli/logs`; suggested stacks/logs roots are absent. Daemon log `2026-11-06-21-09-09-pid-2212914-daemon.log` uses UTC+01:00.
- Observed: line 3285 at 20:43:54.743Z spawn RPC completes agent_signed_out; line 3286 at .745Z resume refuses with that cause. Line 3333 at 20:43:56.059Z Pending activation also refuses agent_signed_out and retains custody. Last phase is child_environment, before Claude Session runner start; source Session log has no entries in the requested window.
- LOADED `daemonControl-ODCQPFHM.js.map` confirms `resolveSpawnChildEnvironment.ts:847–865`: qualified Connected Account request-auth bypasses unrelated native sign-in; otherwise logged_out returns agent_signed_out. Loaded coordinator maps failed resume to target_start_failed. PluginExec launches here are auth/preparation helpers.
- Derived: this launch lacks an effective qualified Claude request-auth/Provider/Team route and its native sign-in is logged_out. Connecting an account alone does not establish that this launch selected its purpose binding. Configuration versus an authentication-binding defect remains with that owner; no missing-token or expired-credential claim.
- Board checked: 14:20 ASK and 16:54 RESULT retain pre-reload runtime_start_failed with Coordination. Its artifact has no inner cause, so the failures are not asserted identical. Coordination / Providers ORCH must resolve the intended Claude binding or valid native sign-in; QA should resume the retained current target rather than repeat the already-applied transition. No product edit, credential probe, Account setting or lifecycle change.
- Evidence: `r119-target-start-diagnosis.json`, `r119-target-start-cause.json`, `r119-loaded-target-owner.json`, `r119-target-start-events.json`; QA `r119-native-replay.json`. One RESULT routed to Coordination / Providers ORCH (heading count 1); production mechanism delta +0/−0; no tests run for this diagnosis-only follow-up.

## Second Home — routed outside Usage
- Observed: recognized-same-Home Continue fails before key entry; both feature endpoints return 200 with the same Home identity/different canonical URLs. Derived: existing-Home canonical-address reconciliation.
- QA's exception capture identifies `resolveHomeProfileAdoption` (`serverProfiles.ts:2222`) → preflight → adoption: `Home identity conflicts with URL`. Exact persisted operand remains unmeasured; UI displays Operation failed.
- Exact diagnosis ASK posted once at 09:52 to Home/server-profile owner and Usage orchestrator. QA discarded the draft; repo-dev remains read-only; no Home source edited.
- Evidence: `home-connect-exception.json`, `home-exception-owner.txt`, `home-connect-diagnosis.json`, `home-public-probes.json` and original `home-b-*` artifacts.

## Verification and handoff
- Follow-up RED: 1 failed / 5 passed; GREEN: all 53 checks across transition, target defaults, inspection and provider preflight pass (`r117-red.log`, `r117-green.log`).
- Follow-up CLI/daemon entry imports both pass (`r117-entry-load.log`). Public CLI/UI incomplete exit-2 runs are not run; server windows2 queue was cancelled (130) per Systemic. nl1 replacements retain handles CLI 13697/server 11988/UI 42940; no --local retry or duplicated running job.
- Admission private-index packet contains only three owned files; finalizer changed=3, roots=10, new=0/unowned=0 (`r117-commit.json`). Foreign approval-profile and Usage timing hunks stay excluded; shared staging/worktree preserved.
- Original checks: 12 server integration, 2 CLI prices, 2 capability checks pass. Broader CLI Usage 7 fail/8 pass; protocol socket 15 pass/1 detached-execution failure (`cli-adjacent.json`, `protocol-adjacent.json`). Security adjacent CLI 89 pass/7 unrelated fail; protocol 16 pass/1 same unrelated failure.
- Original CLI delta +0/−0 selected, 493 unattributed elsewhere; server +3/−5 outside owned hunks, 85 elsewhere. No whole-package GREEN claimed.
- Original finalizer changed=5, roots=41, new=0/unowned=0; security finalizer changed=10, roots=94, new=0/unowned=0. Foreign staging/worktree preserved (`commit.json`, `security-commit.json`).
- Documentation: `docs/compatibility.md` records the new read-proof wire requirement; no persisted format changed.

## Owner audit, mechanism delta and residual risk
- Inspection and admission retain one catalog/provider owner. Target defaulting retains one binding/currentness owner; same-Home ambient fallback remains for callers without captured custody.
- Follow-up delta: optional context parameters +2/−0, forwarding sites +3/−0; checks/states/errors/timers/retries/files +0/−0; three files modified. Existing context prevents false retirement without new machinery.
- Security delta: read-proof kind +1/−0; mandatory Session scopes +3/−3 optional bypasses; daemon payload-binding branch +1/−0. Errors/timers/retries/files +0/−0; 11 modified files. Existing ACL owner prevents cross-person disclosure; HEAD's second ACL guard is intentionally retained per orchestrator ruling.
- Terminal delta: host-private optional invocation field +1/−0, forwarding site +1/−0 and selector fallback +1/−0 preserve authenticated terminal cause. Checks/states/errors/timers/retries/new files +0/−0; three modified files; no added HTTP or idle work. Existing authority ceiling and MCP automation remain authoritative.
- Self-review: live bearer equality falsified the ambient-custody assumption; positive and expired-custody controls exercise the real defaults owner. No inspection-side credential workaround was added.
- Reload 118 RESULT contains security/custody SHAs; terminal repair's 19:49 UTC RESULT names reload 119, Opus recheck and QA R37/R38 (heading count 1). Invocation ASK was assigned and fixed here; Home ASK remains with its owner.
- Residual risk: reload 119 authority is verified, but native Claude auth/binding blocks target startup; resume the retained target after its owner resolves it. Earlier native-resume failure is not yet correlated. Public package checks, Home exception and adjacent failures remain open. No stack lifecycle or Account setting was changed.
