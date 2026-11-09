BLOCKED — the canonical private firewall transition needs a workload-exposure wire operand beyond optional Environment content. Stopped at the lane's explicit contract boundary; no production edits, tests, or successful Connect claim.

## Caller-visible flow and smallest change

Intended flow, recorded before source changes: a person opens the database's existing Connect sheet. Its no-export refusal should lead to an Environment-owned sharing editor. There the person explicitly selects the service, container port and observed private network, reviews the private-only port publication and saves through `deployments.environments.update`. An agent uses that same Action and input. The definition owner prepares the reviewed Compose port change; the existing workload/network-exposure owner publishes it on explicit deploy. Current Machine private-network observations and observed bound TCP ports remain authoritative. After the data deployment settles, Connect writes the consumer's reference binding through the existing binding Action; the consumer is explicitly redeployed. No public fallback or credential copying.

Smallest proposed changes: expose the existing `ownServer.serviceExports` leaf through the existing Environment update Action; use the definition owner for its private Compose change; extend the existing firewall materializer/retained-SSH transaction to carry workload publications alongside Caddy; add an Environment-owned editor and connect the sheet's refusal remedy. The firewall step, unlike the content step, exceeds the authorized wire boundary. No partial writer/editor was landed that would save an export while leaving Connect unusable.

Load-bearing checks: the real update Action preserves/validates exports in ordinary content; declaration alone never claims an observed publication; the resolver succeeds only with actual matching private-network and TCP bind observations. Stop for an additional wire contract, credential custody change, or public-exposure/product decision.

Live recipe: default self-hosted database → Connect refusal/remedy → reviewed private export save → explicit data deploy and terminal observation → Connect to another Environment → explicit consumer deploy. Required runtime: matching current UI/controller/worker source, two authorized Environments, observed shared private network and bound TCP port. No Stack lifecycle authority in this lane.

## Deciding evidence and stop condition

Observed:

- P45:400–410 requires definition authoring, `deployments.environments.update`, private firewall setup, bindings and explicit deploys. P41:1091–1102 retains actual private-IP/published-port/currentness checks and the sole firewall writer.
- `packages/deployment-protocol/src/v1/environment.ts:64–83` already declares optional `ownServer.serviceExports`. `packages/protocol/src/deployments/deploymentEnvironmentContentPatchV1.ts:16` admits only partial release-policy fields under `ownServer`. `apps/cli/src/deployments/prepareEnvironmentContentForHost.ts:162–175` is the existing opened-content update owner. `apps/ui/sources/components/projects/deployments/deploymentActions.ts:229–237` invokes that Action; agents reach the same CLI Action dependencies. Optional content authoring is within this lane's grant.
- `apps/cli/src/deployments/targets/ownServer/privateServiceReference.ts:32–36,76–90` consumes the saved declaration, matching current private-network observations and a real bound TCP publication. Public resolution refuses. Compose/Docker observation remains at `apps/cli/src/daemon/local/services/launch/nativeComposeLifecycle.ts:625–628`; it is not an export publisher.
- `packages/protocol/src/machines/setup/machineFirewallV1.ts:36–56` has a closed transition containing Caddy public bindings, **one** private binding, and SSH policy. `packages/cli-common/src/machineSetup/nativeFirewallTransition.ts:54–56,108–114,129` permits those Caddy bindings, rejects non-public entries in the public list, and drops other new DNAT traffic. Saving an export and adding a Compose port alone therefore cannot provide working private access on this supported posture.
- This intent is a real privileged-process wire contract: `packages/cli-common/src/machineSetup/effectInternalProtocol.ts:24–26,81–84` → `apps/cli/src/machines/setup/effectInternal.ts:192–195`. Root CHECK owns protected native facts and lowering. `apps/cli/src/machines/reachability/machineReachabilityHost.ts:697–712` supplies Caddy-only intent again on Domain reconciliation.

Derived: supporting database publications alongside the existing private Caddy origin requires an operand at that canonical transition, not another Environment field alone. Reusing `caddy.privateBinding` would replace the origin and be overwritten on the next Domain reconciliation. Putting private publications in `publicBindings` is explicitly rejected. These are reachable failures, not a hypothetical capacity requirement.

Alternative attacked: the internal effect protocol also accepts concrete firewall plans (`effectInternalProtocol.ts:85–88`). That is not a workload-exposure declaration or a retained owner: a one-off custom rule plan would still be erased when the existing Network/Domain owner next rebuilds its Caddy-only table. No second nftables writer, copied rules, pseudo-Caddy database, or permissive firewall workaround was added.

[blocked] O-DEPLOY must authorize the smallest privileged wire extension, coordinated with O-MACH: carry private workload bindings alongside Caddy through the existing transition and ensure Network/Domain reconciliation retains them through one owner. Then resume this lane for content Action authoring, reviewed Compose publication, refusal remedy, and RED→GREEN. No public-exposure or credential-custody decision is requested.

## Coverage, validation and composition needs

Same-shape sweep: saved service-export consumers without a workload-sharing producer — 1 shared Environment/export corridor, reached by Database Connect and Environment reference variables; both routed to O-DEPLOY/O-MACH. AUTO inventory covered `apps`, `packages`, and `scripts` TypeScript/TSX/MJS sources for `serviceExports`, the firewall intent and its settlement owner. Tests and fixtures author synthetic exports; production matches are schema/defaults and consumers, not an export editor/publisher.

Affected consumers: database connection facts and picker, same-/cross-Environment reference resolution, template/receipt content, native Compose observation, Network review, Domain firewall settlement and privileged CHECK. Public paths stay out of scope; browser/native clients share the UI Action. No database record or new Action is warranted. Existing tests to extend on resume: `prepareEnvironmentContentForHost.test.ts`, `privateServiceReference.test.ts`, `machineCaddyFirewall.test.ts`, `machineFirewall.composed.test.ts`, `nativeFirewall.test.ts`, and `DeploymentDatabasePage.test.tsx`.

Visual composition need only: use Environment Settings' existing `ItemGroup`/`Item` rows, field/select primitives and shared review/sheet chrome; reuse the Connect refusal/remedy presentation to enter that owner. Show selected Environment/service/network and explicit save/deploy consequences. No restyling was performed.

Tests, RED→GREEN, package typecheck, entry-loads and live QA: **not run**, because implementation stopped before any production or protocol import change. No background check remains. Read-only AUTO searches completed; initial guessed-path searches reported missing paths and were superseded by full `apps/packages/scripts` inventory. No local test bypass, Stack lifecycle, package.json, database, credential or push mutation. No canonical behavior documentation update is needed because behavior is unchanged.

Net mechanism delta: runtime checks +0/−0; states +0/−0; error codes +0/−0; timers +0/−0; retries +0/−0; production files +0/−0; report files +1/−0 (this requested handoff).

Self-simplification: retained the real resolver and firewall owner; rejected a declaration-only fix and the existing generic-plan bypass because neither survives the owner's next reconciliation. No machinery was added.

Residual risk: Connect remains blocked for a default database. This is source-derived diagnosis, not loaded-runtime or RED→GREEN proof. After the wire scope is approved, verify coexistence with Caddy and two private service exports, retained SSH, next Network/Domain reconciliation, actual Docker bind observation, and the composed two-Environment journey above. No READY FOR RELOAD: there is no runtime change to load.
