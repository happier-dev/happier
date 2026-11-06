> Verdict: Both original defects are reproduced and fixed at their authorization owners.
> Source RED → GREEN: five regressions fail before and pass after; adjacent server total: 12 passed.
> Commit: `e38e25098110bc79cb9267b5fe580cadb9824831`; canonical finalizer: new=0, unowned=0. Loaded replay requires the orchestrator reload.
> CLI public delta: +0/−0 selected locations, 493 unattributed elsewhere. Server delta: +3/−5 outside owned hunks, 85 unattributed elsewhere.
> Third item: Home-connect diagnosis routed by ASK; exact exception remains [blocked] without QA browser access.
> Broader checks: seven CLI Usage failures and one unrelated detached-execution protocol failure remain unattributed.

## Observed basis

- Stack: agent-qa-usage-insights, reload 116; server :3011, daemon on nl3.
- Runtime source identities from the QA evidence: daemon `122ce0e2a3932292`, server `cb1daf5527610bf9`.
- Loaded snapshots, rather than dist, were inspected through their source maps.
- Evidence directory: `.project/tmp/usage-live-prereq-1106/`; original artifacts: `.project/tmp/qa-usage-journey-1106/`.
- No stack lifecycle, dependency input, Account setting or Home configuration was changed.

## Agent picker

- Observed: loaded daemon registers the transition/inspection handlers with `readStoredCredentials`.
- Observed: invoking that loaded credential reader under the daemon's environment returns a credential with token/encryption present; no credential value was printed.
- Observed: loaded server's closed Session-RPC authorization map lacks inspection, batch inspection and brief preview.
- Derived: the server rejects these `session.*` methods before forwarding; UI normalizes method-unavailable into `operation_unavailable`.
- Reproduced: the real socket dispatcher returns `RPC_METHOD_NOT_AVAILABLE` for each of the three methods before the fix.
- Fix: classify these read-only, machine-routed operations in `packages/protocol/src/rpc/socket.ts`.
- Existing optional Session scope preserves explicit Session proof while ordinary Machine reads use the Account-owned room.
- No CLI credential workaround, UI error remapping or extra route was added.
- Evidence: `loaded-daemon-credentials.json`, `loaded-server-owner.json`, `red.json`, `green-adjacent.json`.

## Native prices

- Observed: CLI prices and `usage.query` use the same signed-header owner; loaded CLI contains that path.
- Observed: loaded server has the signed query purpose but lacks the price purpose; live price refusal is `verification_purpose`.
- Derived: bearer-authenticated UI refresh succeeds while signed native refresh/get is refused and flattened by the CLI to `not_authenticated`.
- Reproduced: both admitted native price roots fail request verification before the fix.
- Fix: extend `isAccountActionHttpPurpose` in server `externalActionExecutionAuthorization.ts`.
- Each price root admits only its own effect, exact HTTP method/path and empty input; query strings, extra input and cross-effects are refused.
- Price IDs come from their existing `usageActionIdsV1.ts` owner; request paths and input validation reuse their existing owners.
- Evidence: `loaded-price-refusal.json`, `loaded-server-owner.json`, `red.json`, `green-adjacent.json`.

## Second Home — routed outside Usage

- Observed: Connect → Keep → recognized-same-Home Continue ends at the generic address error before a key form.
- Observed: both public feature endpoints return 200 and the same advertised Home identity, with different canonical URLs.
- Derived: the flow enters existing-Home canonical-address reconciliation rather than independently creating a new identity.
- The generic message comes from `DirectHomePathPane.tsx:110`, covering `connectHomeAtAddress` and its `onHomeConnected` callback.
- Post-confirmation owners are incumbent credential lookup, optional authenticated observation, profile adoption and the post-connect credential lookup.
- Authenticated feature observation catches HTTP/network/decode failures as typed status; those alone produce Home-unreachable, not this generic catch.
- [blocked] The supplied artifacts contain neither the exception nor its request trace; no QA_USAGE_CDP endpoint was supplied to this lane.
- ASK posted to Home/server-profile owner and Usage orchestrator through the requested board script; no Home source was edited.
- Next action: capture the exact exception at that catch and fix through the credential/profile adoption owner.
- Evidence: `home-connect-diagnosis.json`, `home-public-probes.json` and original `home-b-*` artifacts.

## Verification and handoff

- RED: five regressions fail for method-unavailable or null signed-purpose verification (`red.log`).
- GREEN: 12 server integration checks pass, including all five regressions and adjacent shared-editor/query/quota paths (`green-adjacent.log`).
- CLI price suite: 2 passed; wider CLI Usage suite: 7 failed / 8 passed (`cli-adjacent.log`).
- Protocol socket suite: 15 passed / 1 failed in detached execution route-policy expectations (`protocol-adjacent.log`).
- Protocol public typecheck: passed (`protocol-typecheck.log`).
- CLI transition capability suite: 2 passed (`cli-transition.log`). CLI public delta: +0/−0 selected locations against `cli-1104.locs`, 493 unattributed elsewhere; package exit 2, delta command exit 0 (`cli-typecheck.json`).
- Server public typecheck: +3/−5 selected diagnostic locations versus `server-1103.locs`; 85 additions elsewhere. No whole-package GREEN is claimed (`server-typecheck.json`).
- Canonical finalizer: changed=5, roots=41, new=0, unowned=0; replayed onto moving HEAD and rechecked CLI/server before committing (`finalizer.log`, `commit.json`).
- All seven current-source entry graphs pass, including CLI, daemon, server, UI catalog and SDK browser (`entry-load.json`).
- Source commit contains only this lane's five-file repair/test packet and import closure; inherited foreign staged changes were preserved during index reconciliation.
- Documentation: no product contract changed; these repairs admit already declared operations. This lane report records runtime diagnosis and replay needs.

## Owner audit, mechanism delta and residual risk

- Socket registration and forwarding continue consuming the single protocol authorization map; no competing decision-maker was added.
- Native prices continue consuming the shared CLI signer and server HTTP-purpose owner; UI bearer auth remains its existing authenticated transport.
- Delta: authorization rows +3/−0; HTTP purpose branches +1/−0; states/errors/timers/retries +0/−0; production/test files added/deleted +0/−0 (five modified), plus this requested report.
- The added rows/purpose repair the reproduced refusal of current UI/native callers; the price ID export avoids a copied ID vocabulary.
- Self-review: exact-method and wrong-input/effect tests retain fail-closed neighboring behavior; no new limit, retry, feature gate or lifecycle machinery.
- Residual risk: loaded reload-116 processes still contain the old decisions. Orchestrator must reload and replay Agent picker, single/batch inspection, native prices get/refresh and the successful query/UI refresh controls.
- Home-connect exact exception and wider unattributed failures remain separate follow-up work; neither stack was restarted or reconfigured.
