BLOCKED — reported descriptor defect is absent; six adjacent test failures prevent full verification.

Observed: at 12:12Z and 12:14Z on 2026-11-06, public `/v1/features` from QA 9446
advertised canonical URL and HTTPS endpoint 9446, revision 28; dev 8443 advertised
8443, revision 62. Both share the same Home identity. Capability canonical URLs also match.
The cited FIX73 artifact records only revisions; it contains no advertised addresses.
Evidence: `.project/tmp/qa-home-descriptor-address-1106/home-identity.json`.
Owner: `apps/server/sources/app/features/homeConnectionDescriptorPublication.ts`
constructs descriptors using `resolveConfiguredCanonicalServerUrl` and
`resolveConfiguredPublicServerUrl` in `app/serverUrls/effectiveServerUrls.ts`.
`homeConfigOverlay.ts` already gives deployment env precedence over shared Home settings.
Stack's `utils/server/urls.mjs` selects the addresses; `server_env.mjs` projects them
into `HAPPIER_CANONICAL_SERVER_URL` and `HAPPIER_PUBLIC_SERVER_URL` for the serving process.
QA's stack-env public URL is already its own 9446 address.
Loaded: fresh `hstack dev-targets browser` profile on `agent-qa-l12-main`, UI 19364,
query Home 9446, loaded `/apps/ui/index.ts.bundle`; only 9446 supplied `/v1/features`.
Welcome/sign-in rendered without “Is this the right Home?”; no alias was accepted.
Evidence: `browser-evidence.json` and `fresh-profile.png` in the same evidence directory.
Validation: server URL/descriptor suites PASS (57 tests); current-source entry-loads PASS
(daemon preparation, daemon, CLI, voice worker, server, UI catalog, SDK browser).
UI Home-admission suite: 34/37 PASS; failures at `connectHomeAtAddress.test.ts:203`
(focus changed), `:443` (60s Action-confirmation timeout), and Protocol
`actions/actionSpecs.ts:542` (non-iterable SESSION_ORGANIZATION_RESOURCE_ACTION_SPECS).
Stack URL/runtime-env suites: 26/29 PASS; relay inference assertions fail at
`utils/server/urls.test.mjs:444`, `:554`, `:620` (loopback returned instead of relay URL).
Logs: `server-tests.log`, `ui-tests.log`, `stack-tests.log`, `entry-loads.log` there.
RED/GREEN: not applicable; existing producer and live outcome already satisfy the contract.
No production fix, typecheck, migration, Home/Account/identity/settings write, DB access,
or restart was performed. Existing genuine-mismatch confirmation remains unchanged.
Split-brain audit: descriptor construction, URL/config precedence, Stack projection and
UI `connectHomeAtAddress` agree; canonical audience and public ingress are distinct facts.
Mechanism delta: checks/states/error codes/timers/retries/source files +0/−0; report +1.
Security rationale: no request-origin trust, identity rewrite, or mismatch bypass introduced.
Residual: these failures are unattributed; this lane changed no production/test source.
Integration owners must resolve them; the historical prompt cause remains unestablished.
If Lane 12 still sees the prompt, supply its entered URL and public feature response.
If an owner later changes runtime configuration, request its next normal QA restart and
repeat the descriptor fetch; this lane must not restart the shared QA stack.
