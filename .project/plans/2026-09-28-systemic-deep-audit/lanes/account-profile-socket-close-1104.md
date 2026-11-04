DONE

Lane: account-profile-socket-close-1104
Scope: diagnose signed-in GET /v1/account/profile socket closure observed on agent-qa-fin2 reload 147; fix the canonical owner with real-storage route RED → GREEN, entry-load evidence, and a private-index commit.
FIN owns fin2 lifecycle. No live probes before board coordination; no reloads or retained database mutations by this lane.
Result: HARNESS DEFECT, corrected at its owner; no server route/serializer defect reproduced. The FIN helper authenticated before synchronously importing the large CLI executor graph. Its subsequent raw fetch reused an authentication socket that had closed during that import. Moving the import ahead of authentication fixes the original request on unchanged fin2 code.

## Deciding evidence
All evidence below is under `.project/tmp/account-profile-socket-close-1104/` unless an absolute path is shown. Live probes were authorized by FIN's board replies at 16:41 and 16:50 UTC, as secondary 50084d92. No lifecycle/reload or retained-DB mutation was performed by this lane; the allowed existing-account authentication ceremony was used in-process. No credential or profile body was printed.

| Check | Observed result | Evidence |
| --- | --- | --- |
| Original FIN helper ordering | `UND_ERR_SOCKET`, no HTTP response | `fin2-probe.log` |
| Instrumented original ordering | `PROFILE_REUSES_AUTH_SOCKET`, then `UND_ERR_SOCKET`; socket bytes read remain 730 | `socket-order.log` |
| Fresh HTTP connection, identity encoding | HTTP 200, 1333 bytes | `fin2-compare.log` |
| Fresh HTTP connection, gzip encoding | HTTP 200, 582 bytes | `fin2-compare.log` |
| Fetch after fresh-connection comparisons | HTTP 200, 1333 bytes | `fin2-compare.log` |
| Import before authentication, same helper exports | HTTP 200, 1333 bytes | `import-before-auth.log` |
| Original probe after owner-helper correction | HTTP 200 | `fin2-fixed-helper.log` |
| Existing real-storage route harness | GREEN 9/9, isolated real SQLite | `baseline.log` |
| Diagnostic real-authentication HTTP test | GREEN 1/1, 9 skipped; real encrypted Claude connected-account storage, compression registration, monitoring, Fastify and token issuer | `real-http.log`; temporary test removed after diagnosis |
| Entry-loads | GREEN 7/7, terminal exit 0 | `entry-loads.log` |

The retained controller state identified server `b8f4721584a96937` before and after the comparisons, with the same selected/loaded identity. Successful requests through the same controller origin falsify a persistent route crash, profile encoding/size defect, or profile serializer failure for this Account. Socket instrumentation plus the import-order A/B establishes the faulty client bootstrap ordering; the precise remote actor that retired the idle socket was not instrumented. The server's existing idle-lifetime owner is `packages/protocol/src/server/http/connectionLifetimeV1.ts`; its 72-second boundary is unchanged.

Current remote log: `/home/happier/.happier/dev-targets/nl3/stack-state/agent-qa-fin2/logs/server.log`. Redacted inspection found zero profile error records before/after reproduction. FIN's suggested controller-local `~/.happier/stacks/agent-qa-fin2/logs/server.log` contains historical requests and cannot establish this incident's cause. Redacted inspections initially lived at `/tmp/account-profile-fin-{server,after-probe}.log`; retained projections accompany this report's evidence directory.

## Correction and scope
Corrected existing ignored FIN helper `.project/tmp/fin-guest-credential/secondary.mjs`: set its existing runtime environment and import `createCliActionExecutorFromCredentials` before the challenge/sign-in requests. Its exports and credential handling are unchanged. The same original probe then returns 200. This is a diagnostic harness correction, deliberately excluded from the source commit as a temporary QA artifact. FIN should use this corrected helper for follow-up work and discard the claimed server-profile defect.

Canonical product route remains `apps/server/sources/app/api/routes/account/registerAccountProfileRoute.ts`; its snapshot reader assembles the Account, qualified connected accounts/groups, linked-provider presentation and linked-identity management. The adjacent CLI HTTP agent owner is `apps/cli/src/utils/proxy/agents.ts`; FIN's raw-fetch diagnostic helper bypassed that client path. No product split-brain or bypass was added. The pre-existing requestHomeEnv argument hunk in the route belongs to another lane and is preserved. All source-test edits made for diagnosis were removed without altering foreign work.

Production RED → GREEN is not applicable: no production behavior changed. The original live failure and corrected-helper HTTP 200 are the deciding harness RED → GREEN. Production checks/states/error codes/timers/retries/files: +0 / −0. Persisted source delta: +1 lane report / −0 files; ignored helper only reorders existing initialization. No canonical product documentation update is needed because the profile contract did not change.

Skipped/failed probes: one nl3 read-only state inspection was refused before payload start by a Mutagen synchronization failure; no ad hoc SSH or database access followed. A second diagnostic source-test run asserting the gzip header was canceled while waiting for memory admission (not run); actual live gzip 200 is recorded separately. No package typecheck is claimed for this diagnosis-only source result. Initial memory-admission deferrals resolved before the credited route tests ran.

Self-review: challenged the route/serializer diagnosis with fresh transport, both encodings, real-storage route tests and the original failing client; then verified the import-order correction using that same client. Scratch probe scripts and temporary source-test edits were removed. Helper syntax check passed. The report is the only source path selected for the private-index commit; finalizer evidence is `commit-finalize.log`.

Residual risk: socket retirement by the server versus an intermediary was not separately observed; both are normal idle-connection boundaries, and import reordering removes this reproduced harness failure. This diagnosis does not promise immunity from unrelated transport failures or prove every possible Account shape.
