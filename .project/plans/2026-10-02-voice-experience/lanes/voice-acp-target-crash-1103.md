STATUS: IMPLEMENTED_NOT_VERIFIED; entry loads 7/7; loaded-runner reload/replay outstanding

# VOICE-ACP-TARGET-CRASH-1103

- Fixed both mounted crashes without choosing a replacement Agent.
- Canonical executable identity: Protocol `readBackendTargetKeyV2`; operational catalog projection: `resolveOperationalBackendTargetForAgentSelection`.
- `resolveVoiceConfiguredAgentTarget` owns Account/catalog freshness. Its pure projector now serves settings preflight as well as execution; it is not another executable-identity authority.
- Composer presentation fallback reads a nullable key. Voice preflight preserves the configured definition and renders the existing unavailable reason when resolution fails.
- Public Voice selection uses the same Protocol target reader, normalizes predecessor keys, rejects abstract ACP entries, and preserves the exact catalog tuple.
- The exact B1 public catalog key already passes the current real Account-catalog binding test before this patch; historical `invalid_setting_value` was not reproduced on current source.

## RED → GREEN

- Providers' supplied mounted RED: `.project/tmp/session-target-crash-1103/mounted-red.log`; supplied reproduction restored into the mounted composer suite.
- Independent mounted RED for both sites: `ui-red.log`; generic projection RED: `catalog-red.log`; legacy Voice projection RED: `resolver-red.log`.
- Public selection-owner RED: `public-selection-red.log` (abstract entry accepted and equivalent configured key rejected).
- Focused UI GREEN: `focused-green.log`, four files, 6 passed / 112 intentionally skipped.
- Protocol owners GREEN: `target-owners-green.log`, two files, 21 passed.
- Evidence filenames above are under `.project/tmp/session-target-crash-1103/`.

## Runner first cause and external blocker

- Read-only nl3 retrieval used `node ./apps/stack/scripts/repo_local.mjs dev-targets exec nl3 -- …`; no runtime lifecycle operation.
- Observed child PID 938440 exited 1 at daemon-log line 40678: MCP `settings_invoke` / `settings.invoke`, `Action schema cannot be represented as JSON Schema: mutationSchema.options is not iterable`.
- Exact extraction: `nl3-runner-first-cause.log`; original log: `/home/happier/.happier/dev-targets/nl3/stack-state/agent-qa-voice-dev/cli/logs/2026-11-03-08-22-08-pid-3620773-daemon.log`.
- Typed blocker: `action_schema_unrepresentable`, before microphone capture. This is not an ACP command/credential failure.
- Current source contains no `mutationSchema.options` access. Loaded-runner/source mismatch is derived, not a verified reload result.
- Next action: runtime owner loads the corrected schema/Action graph, then replays exact-target Home Start for `qa-foldseed-acp`. Stack restarts/stops were prohibited and none were performed.

## Validation limits

- Broad UI run: 111 passed / 7 failed (`ui-green.log`); failures concern submission/admission and bundled-picker expectations and are not claimed pre-existing without a baseline.
- Broad Protocol schema run failed three deployment restart projections (`mcp-schema-current.log`); another registry census timed out (`protocol-green.log`). Neither is GREEN evidence.
- Continuation entry-load rerun passed all seven graphs with exit 0 (`entry-loads-retry.log`): daemon preparation, daemon, CLI, Voice inference worker, Server, UI catalog and SDK browser. No failing graph or `firstFailingModule` remains to attribute. The earlier 3 passed / 4 failed result (`entry-loads.log`) is historical and superseded.
- UI/package typecheck results: `ui-typecheck.log` failed in workspace declaration preparation; UI package-wide GREEN is not claimed. The Protocol run subsequently completed with zero diagnostics (`protocol-typecheck.log`, 09:54:16Z). No diagnostic baseline was manufactured.
- The first coherence/CAS invocation refused the packet: the added mounted fixture omitted required `path`/`host` metadata. Corrected the fixture; its focused mounted test passed (`corrected-fixture-green.log`). The user explicitly authorized one retry in the continuation. The corrected private packet replayed cleanly onto current HEAD; concurrent source changes are excluded.
- Authorized continuation coherence/CAS evidence: `coherence-retry.log`. The private index contains only this lane's reviewed hunks, tests, documentation and report; no push is authorized or performed.
- Live browser and exact-target Start replay remain unverified; mounted rendering is the UI evidence.

## Scope, audit and application

- Inspected consumers: composer, settings, public binding, configured/session Voice resolvers, persistence, Voice spawn, New Session preflight and exact-model choice.
- Removed raw settings preflight reconstruction and legacy Voice executable bypass. Strict request parsers and fixed OpenCode predecessor migration remain distinct boundary/compatibility paths.
- Existing qualified-target fallbacks consume strictly parsed or catalog-selected targets; they do not admit abstract ACP presentation entries.
- No new state, error code, timer, retry, polling, gate or registry. Checks: +2 uses of the existing executable reader (operational projection and public setting admission), each preventing the reproduced abstract-target bypass; −2 raw target reconstructions. Files: +1 owner regression suite, +1 requested report / −0.
- Self-simplification retained the existing catalog, target reader and unavailable state; no alternate resolver or runtime workaround was added.
- Partial-file private staging preserves unrelated work; only picker producer/direct-consumer hunks needed to make the composer correction reachable are included.
- No provider-registry hunk collision, dependency mutation, stack restart/stop or push.
- UI/source changes apply through the normal UI reload/hot update. They do not repair the already loaded runner; its schema failure needs the runtime owner's reload and replay.
- Residual risk: UI package-wide diagnostics and the loaded nl3 runner still prevent Voice Start certification. The runtime owner must reload the corrected schema/Action graph and replay exact-target Home Start; stacks were not touched.
