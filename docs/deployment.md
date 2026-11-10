# Deployment

This document records the server implementation behind deployment. Operator recipes and configuration are owned by the published [self-hosting guide](../apps/docs/content/docs/self-hosting/index.mdx), including [Docker and Kubernetes](../apps/docs/content/docs/self-hosting/docker.mdx#kubernetes).

In 0.3 development, `projectDeploymentDomainFactsV1` owns the recovery projection
for the Domain's recorded controller operation. A typed `not_found` from that
exact operation read projects an unknown outcome, exposes the reason in Technical
details, and permits a fresh Remove. Pending or unavailable reads keep removal
unresolved. This projection preserves the persisted removal intent and captured
placements; only verified native absence can tombstone the Domain.

In 0.3 development, Cloudflare Domain preparation and retirement accept the API's optional pagination metadata and omitted or null tunnel configuration. Without pagination metadata, the route owner reads through an empty page before deciding ownership or absence. Malformed responses retain `providerOutput` in the existing Domain failure details: an endpoint template, issue path and expected type, without response values or credentials. The original provider cause, required fact and remedy remain attached, including when remote changes leave the outcome unknown. Preparation creates each target's sealed connector grant automatically; a failed grant write retains its typed cause and HTTP status without credentials or response values.

In 0.3 development, the Cloudflare plugin's read-only `cloudflare-named/selections-read` Action lists complete named tunnel selections for a connected Account and selected zone. It derives the Cloudflare Account ID from that connection and supplies its canonical connector image and version pin; callers can explicitly override those defaults. It reuses selected-zone validation without requiring Zone Read, and reports `connector_discovery_unavailable` rather than claiming the connector is running. Native execution verifies that connector; the route owner separately decides hostname-route and DNS ownership.

In 0.3 development, choosing the Cloudflare Workers or Pages target fixes the product for its linking choices. Each target supplies its own inspect fields and choice Resource, reusing the existing preparation handlers and finite provider reader. The sheet asks for that product’s account, project and environment without another Product choice or Cloudflare-specific UI logic.

Cloudflare Pages Direct Upload accepts the provider's `success: true` asset-upload
and hash-registration acknowledgements without a `result` field. Data-bearing
responses still require `result`. An explicit provider rejection remains
`provider_request_failed`; a lost or malformed mutation response remains
`outcome_unknown`. Provider response text and authorization material are excluded
from failure diagnostics. This decoder behavior follows the
[Pages Assets API](https://developers.cloudflare.com/api/resources/pages/subresources/assets/).

In 0.3 development, public terminal deployment settlements and failed, cancelled
or unknown receipt-list rows use the shared failure-recovery projector. List
recovery names the unavailable deployment result and a state-specific remedy
from existing metadata; it does not open private receipt content or claim a
provider prerequisite. Detailed private failures remain the existing receipt
reader's responsibility.

In 0.3 development, Stop and remove prepares a typed `nothingDeployed` result when
complete Environment-wide receipt History is empty and no target has an active
deployment or imported native workload. It skips source content, receipt creation
and native preparation, then uses the same teardown Action and HTTP route to
invoke the existing Environment deletion owner. That owner retains its authority,
revision and complete-workload disposition checks. Partial or unavailable History
and deployments on another target cannot establish this absence. A missing Docker
executable alone does not prove absence on a previously used target. Unavailable
observation or removal keeps the outcome unknown, with a sanitized cause code in
the step proof and Action details; command output is not included.
Native teardown runs on the recorded Environment controller, which dispatches
native observation and removal to the sole target Machine through the existing
admitted-child transport. Prepared references stay pinned through review. Only
explicit `detachKeepRunning` uses Account storage. Native admission explains unsupported target shapes with a sanitized
cause, a reason and a remedy.

In 0.3 development, a lost native Action HTTP response follows the existing
controller Action operation for Add, Deploy, teardown and restore. The host and UI
consume the shared Protocol request-identity owner: creation intent, Environment
intent or prepared restore identity takes precedence over the transport request
id. Actions without a derived identity retain their original transport request id;
template previews create no operation. The terminal operation result decides
success or failure, including acknowledged partial Add progress. A fully reconciled
terminal record can end observation while an earlier terminal-read reply is lost,
including failed or cancelled records with no result. The in-memory qualified
record carries full-read provenance; a list summary still requires the complete
record, even at the same revision. Environment absence
alone does not prove cleanup completed. Failed observation retains the unknown
outcome. Recovery neither repeats the effect nor adds a polling timer. A removal
refused because a deploy is running offers History and the receipt's existing Stop
Action, using the receipt owner's cancellability and cancellation-consequence facts.

In 0.3 development, Stop and remove reviews native named volumes through the same
`deployments.teardown` Action with `mode: 'preview'`. The controller observes
Compose-labelled volume membership on the recorded target Machine, including a
remote target through its existing read-only preparation child. Preview cannot
dispatch removal. Each volume defaults to Keep; Delete carries its exact name and
matching confirmation in the Action input. Native admission binds those choices
to the owned volume inventory once, and the existing receipt executor removes only
the selected names. Omitted choices preserve every volume. Complete History for a
never-deployed target proves there is no data to keep; optional native inventory
does not block its removal. Retry consumes the
retained receipt inventory, including volumes already removed by that operation.
Older strict-schema daemons reject the new preview or explicit volume operands;
clients retain the review on that failure and never retry as an implicit deletion.

Teardown mint and Domain Remove child admission keep the Environment's recorded
controller Machine authoritative. A request on another Machine returns
`credential_scope_denied` with reason `controller_placement_mismatch`, the
recorded `controllerMachineId` as its required fact, and a remedy to run on that
Machine or make it reachable. The existing Action failure fields carry this
refusal through HTTP; admission never substitutes a controller.

Receipt teardown admission holds the Environment row lock and revision CAS under
Read Committed isolation. This excludes competing teardown admissions while
allowing unrelated Account cursor publication; detach keeps its existing
Serializable transaction. A confirmed Home rollback reports the missing
transaction commit, a retry remedy, and a sanitized database cause before native
dispatch, without increasing retries.

In 0.3 development, the host request-key owner permits a new reviewed deployment
attempt after a settled failure explicitly records `effectAttempted: false`.
Fresh preparation may replace the candidate Artifact address; every other prepared
operand and the requester origin must match. Successful, active and uncertain
effects retain the existing replay/conflict behavior. This policy is host-local;
it changes no persisted request identity or wire format.

The global HTTP timeout response carries `transactionOutcome: rolled_back` only
when the transaction owner established rollback with no earlier ambiguous attempt.
The shared Home response reader preserves the timeout code and that certainty, so
Store retains the recovery fact and remedy in its partial install result, keeps
the created Environment, and offers another deployment review.
A timeout without this fact stays uncertain. An accepted receipt continues through
the existing dispatch and settlement owner. This is an unreleased 0.3 response
extension (including optional partial-result recovery fields): reload the matching
clients and hosts together. Older readers conservatively keep timeout outcomes
unknown; no stored format or native execution contract changes.

A returned template partial settles its root invocation and retains the failed
step's recovery, including an uncertain child deploy. The UI deployment API follows
a missing root outcome through its retained operation. Store uses that shared
recovery and keeps the open install result across modal remounts and pane resize.

## Redeploy after teardown (0.3 development)

The shared member-version projection treats successful teardown as proof of
absence for its captured installations and ends their older activation/restoration
history. A fresh deploy has no incumbent to restore. Failed or uncertain teardown
does not prove absence; a later successful deployment supplies its own version.

In development, `deployments.templates.instantiate` requires `target.installationId`
from the selected row of the existing `machines.list` Action. This nullable public
identity is also visible to Machine Use recipients; it grants no authority. A
missing identity cannot select an installed target. Template creation still
requires Machine Manage and the existing Project and Environment permissions.

In 0.3 development, adding a catalog service or database to an existing Environment
uses `intent: "add"` and `destination: { kind: "stored" }`. The template preparer
opens the saved definition at the supplied Environment revision and preserves its
existing services. Callers may still supply an exact definition pin; they do not
need to read an internal Artifact or compute a Compose digest. Selected template
generators create credentials private to their creator when
`generatedSecretAudience` is omitted. Explicit additional grants remain part of
the reviewed input. UI, CLI and agent paths share the catalog default-binding owner.

## Domain and binding observations (0.3 development)

Domain health reads reuse `deployments.health.current` and the existing saved
Domain-bound HTTP and certificate checks. Reading a Domain starts no network
probe. The shared projection combines retained check evidence with the Domain's
DNS result and returns typed certificate and Needs-you facts for both people and
agents. Outside evidence remains distinct from a check on the serving Machine;
a local success cannot establish outside reachability. Missing checks and an
unreachable controller remain explicit rather than implying a healthy Domain.

Custom certificates become due for replacement at two thirds of their observed
lifetime. Known validity dates can advance the projected state when read, without
a new timer. Automatic certificates expose observed expiry without inventing a
Caddy renewal window. The underlying observation time remains visible.

Deploy review compares its already-resolved reference addresses with those recorded
on the serving receipt it already reads. Reference addresses are captured privately
when launch resolves them; a changed address is shown in the deploy review.
There is no page-time cross-Environment binding read or separate read admission.
Saved-secret revision comparison uses the receipt's existing approved binding revisions and
current resource metadata, without revealing secret values or acquiring them
again. Secret bindings retain their explicitly selected revisions: update the
reference through the existing binding editor and `deployments.bindings.set`, then
deploy. An ordinary redeploy does not silently select a newer saved revision.
Unavailable evidence does not claim a change or unchanged material.
Agents compose the existing independently authorized Environment, content Artifact,
selected receipt and receipt Artifact reads, then use the same shared comparison.

## Pull-request preview reads (0.3 development)

The Environment query owner selects preview Environments by exact pull request
and repository identity. The GitHub plugin's `github/pull-request/preview` read
returns every matching template's preview, composing that selection with its
receipt and Domain. A child with a validated receipt copies its canonical operation
(deploy, rollback, promote or teardown); an unavailable child may have no receipt.
An unavailable child remains visible beside successful siblings. The same private
readiness projection serves preview-status publication. A ready URL requires a
successful current preview deployment, matching repository and pull-request head
provenance, and its active Domain; caller-supplied URL text is not authority.
The typed preview state is the existing PR Overview's input through the shared
executor; the page does not derive readiness or filter an Environment inventory.

Preview templates are private Environment content. Save through the existing
`deployments.environments.update` Action with `patch.previewTemplate` (or `null`
to remove it). The Environment content owner prepares the mode-aware internal
Artifact and its existing Team audience, then publishes the final reference under
the existing authored-input proof. Generic Artifact creation refuses this internal
kind. The full input digest binds the template; the metadata digest preserves the
remaining patch while the private operand is removed before Home storage.

## Runtime overview
- **App server:** Fastify + Socket.IO. Published `relay-server` images run the packaged server binary and embed the web UI; source-based `server` images use the repository start script.
- **Database:** selected independently by `HAPPIER_DB_PROVIDER`; prebuilt images include SQLite and Postgres.
- **Socket fanout:** in-memory by default; optional Redis Streams for multiple API replicas and split workers.
- **Files:** S3-compatible storage or local disk, selected by `HAPPIER_FILES_BACKEND`.
- **Metrics:** Optional Prometheus `/metrics` server on a separate port.

In 0.3 development, Linux Node servers ask the native allocator to return free pages
after a major V8 collection, independently of the metrics exporter. The runtime
GC observer permits one asynchronous release at a time and disconnects at
shutdown. This reduces glibc residency after allocation churn; it does not force
garbage collection or limit the live working set. Native maintenance is best
effort, with failures logged without interrupting server startup.

## Public-profile operations (unreleased 0.3)

`app/account/profile/publicProfileContext.ts` resolves request-effective public
ingress and report contact. Publication requires both
`HAPPIER_PUBLIC_SERVER_URL` and `HAPPIER_PUBLIC_PROFILE_REPORT_URL`; the latter
accepts HTTPS or mailto and is Home-editable unless the deployment environment
fixes it. `HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME` supplies the visitor-facing
service name, falling back to the ingress hostname. Generated URLs retain the
configured ingress prefix. `account.publicProfiles` is advertised by default on
supporting servers, with `HAPPIER_FEATURE_ACCOUNT_PUBLIC_PROFILES__ENABLED=0`
as operator opt-out. No configuration publishes an Account automatically.

The shared key-holding Action preparation builds the public-eligible Usage
snapshot and compiles the selected private layout into an inert applied edition.
The server owns publication storage and anonymous HTML, JSON, badge, card and
social-image delivery through `registerPublicProfileReadRoutes.ts`, independently
of optional web UI mounting. Each finite read admits current feature, policy,
publication and restriction state before validators or rendering. No private
Account credentials are used by anonymous visitors.

`publicProfileModeration.ts` owns Home-authorized restriction and restore plus
Activity. Owner edits cannot remove an operator restriction. Restore only clears
that restriction; it cannot recreate an edition erased by Unpublish.
`publicProfileHandleReclaim.ts` delegates identity mutation to the canonical
username owner with the exact reviewed handle, reason and owner notice. Reclaim
withdraws publication and releases the handle without a hold. Voluntary release
also permits immediate reuse; rename preserves publication at the new handle.

Development publish/render/restrict/restore are consumed paths. Native blocking
Ask-result delivery, actual scheduled daemon refresh and supported version-skew
validation remain integration obligations; real public HTTPS, crawler and
external-cache behavior remain release checks. See the
[operator setup](../apps/docs/content/docs/self-hosting/env.mdx#public-profiles),
[moderation guide](../apps/docs/content/docs/self-hosting/home-administration.mdx#public-profile-moderation-in-development),
and [compatibility boundary](compatibility.md#public-profile-integration-boundary-03-development).

## Own-server application deployment boundaries (0.3 development)

Repository-backed platform Environments use the existing
`deployments.environments.create` Action with
`definition: { from: 'repository', ref: 'main' }` and no `firstTargetLink`.
The ordinary Project, protection, purpose, deployer and controller inputs still
apply. Create stores a protected repository definition without fabricating
Compose or a native runtime target. Inspect the provider against the created
Environment and link its returned provider content with `deployments.targets.link`;
the recorded target principal and repository-access observation remain the
authority for provider operations. Deploy selects an exact repository commit
through the existing source-intent owner. Platform Publish accepts the same
absence of Compose; own-server Publish, first-target creation and native
receipts retain their required Compose selectors. These are unreleased 0.3
contracts and require matching development components.

UI, CLI and agent Link preparation use Protocol's
`buildDeploymentTargetLinkInputV1` to replace private provider operands with the
published Artifact reference. Link inventory, Environment-read and association
validation refusals carry an optional `diagnostic` with the failed step, a known
top-level field (or `$input`) and a closed rule code. The Home projects these
facts from its validator; hosts retain them without exposing submitted values,
unknown property names or validator messages.

First-target Environment creation and later own-server target linking offer
`machines.managed.retention.update` to keep each managed allocation until
explicit deletion. The existing reviewed-child admission presents the exact
allocation revision and preserves `wakeOnAcceptedMessage`; preparing the offer
does not change retention or Account defaults. `managedRetention: 'keep'`
declines the offer and retains the current lifetime policy. An accepted
until-delete change goes through the managed mutation owner, which returns
`provider_unavailable` when that policy is unsupported. Finite-lifetime
providers remain usable when the person keeps their existing policy.
For a scoped execution credential, Home admits only the filtered allocation
lookup and the exact installation-signed retention child through the original
requester's deployment root. It does not replace that credential with host
Account authority; the managed mutation owner retains its ordinary access,
revision and provider-policy checks.

The unreleased own-server target is being connected through the existing
deployment Actions, not a separate command/effect dispatcher.
Home carries its effective Machine admission role in the signed Action root;
the host consumes it once when admitting the stored deployment definition.
Create uses Machine Use only to carry the original Account Action to its host;
the host's existing definition admission requires Manage before preparation or
creation and returns `deployment_access_denied` for a Use requester. This also
applies to authored and prepared Create inputs on a foreign Machine.
Host admission permits Machine Use for an existing deployment's stored-definition redeploy,
rollback and deployment-scoped `deployments.restart`, not creation or definition
overrides. Machine-wide service control remains Manage-only. Restart selects
the Environment's captured native installation and reuses its existing restart
effect; it does not acquire source or publish a candidate.
The Environment's deployer policy still applies: Machine Use is sufficient only
on the Machine-access side and does not bypass a managers-only Environment.
Definition and placement writes also require the requester's effective Machine
Manage grant, including grants inherited through a Team, as well as Source
management. The server decides this at the existing definition-write admission;
it does not infer the requester's role from the Source owner's access or repeat
the decision during an admitted deployment. Opaque encrypted definition changes
need the same admission because Home cannot prove that their definition stayed
unchanged.

For a Team-owned Source, placement also requires an explicit Machine grant to
that Team. A member's personal Machine ownership does not supply the Source's
custody. In 0.3 development, missing Source custody returns `machine_unavailable`
with `diagnostic.requiredFact: source_machine_use` and
`diagnostic.remedy: share_machine_with_source_owner`. A definition admission
refusal records `effectAttempted: false`; prepared Environment-create approval
history retains that diagnostic bound to the reviewed Machine and role.

A stored Compose definition requires no requester checkout. Native repository
definitions retain repository and Compose selectors, but no
Manage-approved workspace root or commit, so their Use redeploy remains refused
with a typed result. Requester-chosen workspace roots remain physical-owner-only
at the shared native/upload source acquisition owner. Missing signed role never
grants Use deployment authority; existing owner/Manage behavior is retained.

`ownServerDeploymentTarget.ts#createOwnServerDeploymentTargetForHost` delegates
to one executor. Its host runtime borrows the daemon's mounted
`projectManagedServices` owner; it must not construct another supervisor.

The development native executor runs a declared migration once on the first
runtime Machine through P30's admitted candidate command. Configure its optional
pending check in `ownServer.migration.pendingCheck.argv`. Exit zero means no
pending work and skips both backup and migration. Any nonzero exit means pending
work and runs the migration, honoring `ownServer.backupBeforeMigration`. An
unrelated check error therefore also triggers migration, with backup controlled
by that configuration. An `outcome_unknown` result refuses the deployment and is
never replayed or treated as pending work. With no check, migration runs under
the same backup and failure policy. New configurations default to backup before
migration and Ask after a failure. Backup recovery uses the existing public
restore flow and requires a verified restore before code rollback. An unavailable
backup destination or tool returns a typed refusal; it does not silently switch
to code-only recovery. Forward startFirst now consumes P30's healthy physical candidate,
the complete Domain leg reader and the existing Caddy switch adapter; only an
acknowledged switch permits Docker-owned incumbent retirement. An unknown
switch retains both generations for next-admission reconciliation, without a
replay store. The same native `activateStartFirst` path accepts an owner-observed
retained target for reverse cutover, including a stable project: it switches
routes to that generation before witnessed retirement of the losing generation.
An unacknowledged reverse switch preserves both generations. The executor now
consumes the admitted member Domain read purpose and reconstructs retained U
from its captured inputs and original native generation. If U was retired,
Compose reactivates it before the same native owner's observed-target cutover.
The same native observer's retirement-custody purpose identifies the losing
generation independently of its readiness, retaining exact native
configuration, pinned image, engine, project and replica identity. It reports
unverified health rather than lending an activation certificate. This allows
healthy U to replace an unhealthy B and retire B after the route acknowledgement;
the default observation and activation of U still require native readiness.
The development composed executor proves this cutback; loaded native journey
and review obligations remain separate.

Native admission also has a protected-stage option for swap through
verify-or-undo. A real job Stop during that boundary reports `stop_pending` and
is forwarded after the stage and its admitted children settle; unstarted sibling
stages are refused. Explicit force-stop still aborts immediately. Source, Exec
and retained-secret lifetimes must use that native owner's forwarded cancellation
signal, not an independently cancelled or detached consumer signal. These are
development producers. Public restore and failed-candidate restoration consume
the native restore owner and verify recovery before code rollback; unavailable
recovery fails explicitly rather than becoming code-only recovery. Backup-enabled
migration obtains repository and database operands from the installed destination
Action and P42 binding owner, then backs up the captured serving generation before
running the migration. An unavailable destination or serving generation refuses
the required backup. Security review does not gate development QA.

In 0.3 development, the backup-writing lifecycle initializes a new repository
only when the pinned restic 0.19.1 `cat config` returns exit 10. Restic classifies
S3 `NoSuchKey` as absence; wrong passwords, access denial, connection failures
and unknown outcomes never trigger initialization. The lifecycle consumes the
repository ID from `init --json`, then requires the same snapshot, tree and
payload read-back as an existing repository. Test, inventory, verification,
pruning and restore-source reads do not initialize repositories. Restore
preparation retains the recorded repository's S3 region and addressing options.
This follows restic's [exit-code contract](https://restic.readthedocs.io/en/stable/075_scripting.html#exit-codes)
and pinned [S3 absence classifier](https://github.com/restic/restic/blob/v0.19.1/internal/backend/s3/s3.go).

No incomplete path may substitute recreate for a reviewed startFirst. Connection
overrides use P42's protected runtime carrier, not host environment variables.

The development host transition boundary projects Protocol domain failures into
the existing Action failure envelope once: `ok: false`, a required `errorCode`
and `error`, with the original domain facts in `details` (including quota facts).
Native rollout, executor, build and teardown consumers use that same result;
they do not guess a code from a missing field. Successful native continuations
require a receipt ID and revision. Pending deployment admission is not a native
transition acknowledgement or a child execution success.

Development-source Machine Services group-header reads use the existing
`deployments.environments.list` Action with `environmentIds`: a nonempty exact
set of visible Environment owners. Inventory callers omit that field. The
server applies its existing Source disclosure owner before paging, and its
opaque read cursor remains bound to the Account, Home and selected filters,
including the exact ID set. These reads do not expand latest Deployment receipts;
the Account loader opens only the requested Environment Artifact headers, not
bodies or history. An internal empty vector means zero demand and zero HTTP;
the public Action rejects it before deployment GET encoding can turn it into an
unfiltered inventory request. The shared controller coalesces equivalent ID sets and
routes Environment metadata changes only to matching sets. Rendered Services
grouping and the Environment destination remain separate composition work.

The development-source Services presentation-data owner permits Environment
health attention only when its header can be opened. The row and underlying
service health remain available to their observers. Missing headers do not prove
access denial: the Services hook retains the Environment reader's typed result
and existing Retry; partial content stays `deployment_content_unavailable`.
Only the reader's explicit access-denied result is presented as denied.

Development Environment content owns its name. Writers project `content.name`
into the private Artifact `header.title` in the same content write, including
template application and edits after a rename. Deployment collections open the
visible page's Environment content in one deduplicated Account Artifact batch.
Their titles and the detail page use the same canonical `content.name`, so legacy
placeholder headers display correctly without a migration or backfill. Services
header consumers retain the writer's title projection.

The development-source read controller projects receipt-derived chip facts through
`acquireReceiptChip`, borrowing its existing exact receipt lease. The chip retains
the receipt's state, operation and Action operation identity. Session surfaces use
their scoped Action operation's deployment domain reference, rather than attaching
every deployment of the Session's Project. PR surfaces select the saved P44
`previewRepositoryId` relation and exact `previewPullRequestIds` through this same
list owner. Both operands are required together; an internal empty vector issues
no request. The Environment page instead selects its preview children with
`previewTemplateEnvironmentId`, using P44's admitted template relation without
requiring open PR identities. Both selectors filter at the existing relational
list owner before pagination; neither scans inventory. Each demand opens one
page, with explicit continuation bound to its selection. This optional template
selector is a closed, non-ignorable development V1 input: an older strict server
refuses it rather than falling back to an unfiltered list. It changes no persisted
or response shape and has no supported `0.2` predecessor path.

Joining hooks borrow an already-active Environment's current snapshot without
re-reading it. Once all demand closes, reopening retains the existing fresh-read
behavior; pushed changes and explicit recovery still refresh the shared owner.

Demanded inventory pages also carry `projectSources:[{id,name}]`, projected from
the Sources already loaded by admission and deduplicated for the visible page.
The opened collection exposes `item.projectSourceName`, without a local checkout,
Source-catalog crawl or extra Source read. Source names retain their existing
disclosed metadata exception for both Account modes (see [encryption](encryption.md));
this does not copy them into Environment storage or create a new encryption rule.
Legacy responses without the projection yield an unknown/null name. Existing
Source-change notifications refresh only the demanded deployment read owner.

The same already-opened, mode-aware receipt header supplies
`item.currentDeployment.title`. This is the latest attempt, not necessarily the
serving version. `item.liveVersionTitle` is present only when that carried receipt
matches the runtime TargetLink's `activeDeploymentId`; otherwise it is null.
The list does not open an older serving receipt or its body to fill that gap.
Header batching, continuation and Source disclosure remain with their existing
owners; rendering and loaded-surface evidence remain with the surface owners.

`acquireActivity` uses the same list Action's metadata-only `projection:'activity'`
read for the current Home or one Source, without inventory paging or Artifact
reads. The server selects the latest receipt per live Environment and admits its
distinct Source/state groups through the existing Source access owner. It exposes
only running/failed facts. A failed older attempt does not survive a newer success
in this summary. Navigation consumes `acquireActivity`; individual collection
rows expose chip facts, never a competing page-local badge summary.

In unreleased 0.3 source, creating a plugin runtime link in either a production or
non-production Environment enrolls the Machine-services `deployment-failed` and
`deployment-succeeded` Events as observation-only Automation sources on the
Environment controller. Cloudflare and other runtime targets use this same Event
set. Setup retains `{serverId,environmentId,targetLinkId}` and the link's recorded
`credentialPrincipal` in the existing private trigger envelope. Replaying link
creation reuses the enrollment and original configuration. Retained receipt replay
and existing Event admission deduplication handle reconnects and restarts; the
generic adapter keeps only finite attempt state in memory. Protection changes retain those sources;
unattended CI and Workflow deployments use them without a viewer or Session.
Observer setup remains a follow-up to Link: unavailability is reported without
undoing the successful Link result.
UI Link prepares its private content under the captured Account, then forwards
the original prepared Link Action to the Environment controller. The controller's
same Link completion owner performs receipt enrollment for UI and CLI callers.

Successful enrollment also returns a secret-free `failureObserver` read-back on
`deployments.targets.link`: the exact Source/Environment reference and link,
controller Machine and its observed availability, failed/succeeded Event refs,
filters, editable Automation/trigger identifiers, and pending-observation period
(null when still unconfigured). This enrollment observes receipts and discloses
through Account notices; it does not arm Agent work or apply an approval profile.
If a later enrollment fails, the unavailable result's `readBack` retains the
sources already enrolled; failure does not silently imply that nothing is armed.
The guided Agent automation separately projects its authored Event/filter,
project and Environment, supplied controller availability, the effective profile
from the approval-profile owner, and Inbox plus selected notification channels.
Unread controller/profile facts remain null. Notification channels never select
the Events that wake work. The setup review consumes this typed projection before
Agent selection, using the Event catalogue's title and the page's private Source
and Environment names. The shared guided starter carries the page's watched subject
into the existing plugin setup; health setup still requires its native health form.
For the automatic failed-deploy habit, the Environment reference and its controller
prefill the same setup owner, without exposing raw payload or watcher controls.
Guided review and saved trigger rows share the Event summary presenter. An Event
without a display label uses its declared, localized title; unavailable declaration
metadata stays generic rather than exposing the Event identifier.
`workflow.trigger.list({ automationId, triggerId })`
opens that exact Event's retained private definition through the Account-mode
owner; ordinary list responses keep private configuration closed. Observation-only
`workflow.trigger.add` can request `includeEventDefinition: true` to return the
retained definition without another read, including when it rejoins an existing
enrollment. H4 projects its filter and period from that returned definition.
Environment/Machine read Actions and `actions.policy.get` expose the other owner
facts to agents. Observation-only and guided Agent triggers retain owner pause
and removal after an Environment is deleted, through the same cleanup admission.
Authoring and re-enabling still require admission.

The SDK runner consumes the finite adapter's `result.nextEligibleAt`; it does
not supply a polling interval. The generic source configuration accepts an explicit
positive `periodMs`. This is the person's pending-receipt observation period,
editable on the same observation-only trigger through `workflow.trigger.update`;
it is not inferred from unrelated
health checks. While a receipt remains pending, the adapter returns
`nextEligibleAt = now + periodMs` and uses that same period for an unavailable
pending observation. Once no receipts remain pending it returns `null`, leaving
zero scheduled idle work. Initial link enrollment has no period to invent:
pending work without a configured period reports attention until setup is saved.

The host platform adapter enriches generic committed receipt observations from
the retained receipt details, provider identity and current Environment
classification. It commits the failed/succeeded observation to the existing C1
service-health item keyed by Environment and link. Success moves that item to
unread Updates; older failures cannot
reopen it. Notice titles say deployment failed or deployment succeeded; there is
no separate recovered deployment Event. The shared service-health storage keeps
its existing `healthPhase` vocabulary. Controller changes move the public watcher
without changing the private configuration. If the new controller lacks the
plugin materialization, the source is unavailable; repeating controller selection
after installation repairs it. Unlink and completed teardown withdraw the source
at the next catalog boundary. Protection changes retain enrollment and configuration.
Production failures enter Needs you; non-production failures and
all successes update the same Environment/link item in Updates.

The generic failed-receipt observer selects pending receipts from the retained
history read on adoption or reconnect and from addressed receipt invalidations.
It invokes
machine-placed `deployments.receipts.observe({serverId,environmentId,deploymentId})`
for its link. The generic producer selects the exact TargetLink and excludes
teardown receipts for link-scoped sources. The platform's finite observe Action
dispatches the target's existing observe handler, including Cloudflare's; the
Cloudflare plugin has no separate background watcher or receipt map.
An admitted Machine background SDK call uses the runtime's own
Machine binding and existing Home dispatch, retaining the plugin caller and its
authority; `actions.execute` options do not accept a target override.
The installed controller derives the exact provider id, credential
principal and operation identity from retained content and calls the target's
declared observe Action through the existing reviewed-child owner. Receipt content
and terminal state use the same installation-signed transition and CAS as Deploy;
no second work queue or observation scheduler is introduced. In current development
source, own-server calls to `deployments.receipts.observe` and
`deployments.observation.get` return `unsupported_action` with
`reason: target_not_supported`, the target kind and a `deployments.receipts.get`
recovery hint. Read that receipt for its recorded result and use
`deployments.health.read` or `deployments.logs.read` for native runtime state;
native settlement stays with the rollout owner. Reassigned controllers cannot borrow an earlier accepted
installation's receipt custody; that retained-operation recovery boundary remains
separate from future-controller selection.

Receipt admission, meaningful running/failed transitions, cancellation and
Environment deletion publish a separate bodyless `deployment-activity` fact on
the existing Account feed. Progress-only changes keep ordinary receipt wakes but
do not wake the badge. Existing receipt entity ids are unchanged, so older readers
continue receiving them and ignore the additive presentation fact. Identical
summary/chip values publish nothing. Older strict development servers refuse the
new read operands; clients present unavailable instead of dropping the selection
or crawling inventory. Rendered navigation and chips remain with their surface
owners; current source and loaded-surface validation are separate evidence.

### Cloudflare token connections (0.3 development)

Manual-token Connect and health verify token activity, expiry and `not_before`,
then use the configured Account ID as the identity and display name. The optional Features selection checks
only the corresponding Workers scripts, Pages projects, Tunnel list or exact DNS
zone; DNS also requires the zone to belong to that Account. A retained connection
without a selection verifies the token and any already configured DNS zone. Reported manual-token scopes describe
these selected readable features, not proof of write authority.

Connect does not read token details or the permission-group catalog and needs no
API Tokens Read permission. It also avoids Account Details, whose [accepted permissions](https://developers.cloudflare.com/api/resources/accounts/methods/get/)
exclude Pages Write, DNS Write and Cloudflare Tunnel Write; no Account Settings Read
permission is required. Cloudflare authorizes each actual operation; denied
reads and writes retain their typed refusals without reflecting provider bodies.
The token guide still lists the write permissions needed to use each feature.
OAuth continues to interpret scopes actually granted by its authorization flow.

### Receipt Events for Workflows (0.3 development)

The Machine services plugin contributes `deployment-failed`,
`deployment-succeeded`, `promotion-completed`, `deployment-cancelled`,
`deployment-outcome-unknown` and `rollback-completed` through the same Event
catalog that Workflow setup reads. This is the single deployment outcome Event
set for all targets, including Cloudflare; target declarations do not name a
separate transition Event.
Their setup Actions select one existing Environment and record the setup time as
the source's start boundary. Settlements before setup do not enroll as new
occurrences; settlements between setup and first observer adoption remain eligible.
Optional private `targetLinkId` and `credentialPrincipal` operands scope automatic
link enrollment. The generic receipt producer applies exact-target and
non-teardown selection there. Sources without a TargetLink selector remain
Environment-wide.

The canonical receipt transition commits the outcome and publishes its existing
Account-change receipt identity. The daemon converts that identity into a
content-free `@happier/deployment/receipt-invalidated` Host hint. The plugin reads
that exact receipt through the existing Action; adoption and reconnect page the
durable receipt list for recovery. Settled receipts add no polling timer or
second outcome store. Pending link receipts use the finite observer and explicit
period described above. Existing Event admission deduplicates stable occurrence
identities across receipt hints, reconnects and daemon restarts.

`deployment-failed` requires terminal `state:failed`. Its structural payload
contains Environment, receipt and TargetLink identity, receipt revision,
`observedAt` from the receipt's settlement time, operation, failure phase and
failure code. The phase and code come from the exact receipt Artifact revision;
older receipts without failure detail carry explicit nulls. Unavailable or
malformed content leaves observation unavailable until the next receipt hint or
reconnect. The CLI's existing `deployments.receipts.get` opens a failed receipt
once through its private receipt opener and returns only a nullable structural
`failureSummary`: phase, code and optional required fact or remedy. The Event
producer consumes that summary; it does not read internal Artifacts through the
public Artifact Actions. Other receipt states remain metadata reads.
Private titles, URLs, logs, commands, credentials and Artifact bodies
are never copied into Event payloads. `rollback-completed` requires a rollback
receipt settled successfully and reads only receipt metadata; cleanup or an
attempted restore within a failed deployment does not imply a completed rollback.

The other receipt Events also read only metadata: deployment success requires
a non-teardown operation and state `succeeded`; promotion completion requires `promote`
and `succeeded`. Cancellation and unknown outcome use their recorded receipt
states for any operation. `running_unverified` is not success. Each Event keeps
the receipt's settled time and existing occurrence identity; metadata refreshes
do not manufacture another transition.

The current-source receipt lease also exposes `facts` from the already-opened
private receipt: a captured failure code/phase, selected commit subject and
revision, recorded incumbent rollback target, masked stage-log excerpts, and
step-to-operation log references and sink-recorded step ranges. Historical evidence
needs no additional request. In 0.3 development, the receipt hook also joins the
Environment's runtime pointer with its shared retained-history page. That page
opens visible receipt contents in one Account batch, projecting revision and
recorded failure into each attempt's title. The receipt projection derives the
previous retained version, retained predecessor count and rollback choice from
that same page, using the selection shared with native release retention. The
retention setting is capacity, not an observed count. A rollback choice cannot
be the serving receipt or another receipt of its revision. Pending, failed and
incomplete history never claim an absent predecessor or a zero count. Explicit
backup restoration remains a separate recovery intent and can restore data
while its recorded code version already serves. A log reference supplies exact operands
for the existing `deployments.logs.read` build/stage owner; its scope is the
operation file; `facts.stageLogs` and each matching `facts.steps[].stageLogs`
carry the recorded `ref`, byte `range` and exact read operands. Missing legacy evidence
remains unknown. A receipt id is not a fabricated deployment sequence number.

The existing `deployments.logs.read` build arm pages that masked operation file
using the receipt's exact Environment, deployment, target link, Machine and
installation tuple, plus the native source-bound cursor. It reuses the native
log page window and can reopen retained output after a daemon restart. The sink's
`beginStep({stepId})` records the association in the same protected receipt's
`ownServer.stageLogs[].steps`, closing the preceding byte range before any new
phase output. Writers pass only the actual step id; they do not calculate ranges.
`ref` selects that step's masked bytes, with no operation-wide fallback for an
unknown or legacy ref. A null range end extends to the retained file's current
end; it is not a step lifecycle or success claim. Omit `tail` to page from the
start using the returned cursor, or pass `tail:true` for the latest native window.
Find, Failed-only and download remain consumer presentation over these facts.

Build follow attaches to the existing native logs/Resource substrate with
`{hostRead:'deployments.logs',input:{...exactBuildRead,ref,tail:true},sourceRevision}`,
using the revision from an admitted page. The original `deployments.logs.read`
Action still admits the read; Resource continuation carries the same exact
input and Account lifetime. The sink pushes changed nonempty appends only,
and appends for another step do not wake a selected-step watch. Last-consumer
release or abort disposes it. Native source changes retire continuation;
ordinary unavailability can retain the existing last-good page. No second
log file/store, reader, polling loop or timer is introduced. Agents see only
the already-masked sink bytes, including retained output after restart.

In the 0.3 development source, receipt history carries the Environment's existing
Artifact audience. The server's publication admission applies that audience's
grants in the receipt Artifact's create or refresh transaction. The writer then
prepares its admitted recipients through the canonical mode-aware Artifact codec;
it does not read the Environment's grants under candidate authority or select a
second audience. This gives the audience read access, while the
Environment's owning Account or Team retains admin access. A Machine Use deployer
reads earlier receipts as themselves when preparing a stored-definition redeploy;
this does not grant definition management or permit a non-member to read history.
An older private E2EE receipt still requires its existing key holder to share it;
a new requester cannot manufacture a missing recipient envelope.

For a signed native root in 0.3 development, mint admits one finite Deploy
preparation. Candidate publication inside it retains that admission after a
requester withdrawal or Source revision edit. It remains scoped to the root's
derived receipt/Environment content identities, Environment and Source, content
kinds and exact route input. Receipt admission or a controller change ends this
preparation authority; a fresh root checks current requester authority again. Publication
uses the existing custody and Artifact audience readers, without a second
requester permission decision.

The admitted `deployments.receipts.get` read also supplies optional
`cancellable`, forwarded unchanged to the opened receipt/controller. The server
uses the existing Source deploy permission and receipt transition rule; an
already requested cancellation or settled receipt is not offered again. An
older response without this field is unknown, not a client-derived permission.
The existing `deployments.cancel` Action takes the exact receipt revision and
retains mutation admission. It stops future deploy stages; a Machine Service's
desired-stop control is a different operation and is not a deploy-cancel alias.
In development, the cancel request records `outcome_unknown` while a finite
child is active. The captured own-server controller settles `cancelled` after
that child returns a known outcome and before any later stage starts. An uncertain child
outcome remains `outcome_unknown`; cancellation does not assert container removal
or change the last uniform deployment.

In development, the next native preparation or admission reconciles an unfinished
receipt on its captured controller installation for the same requester. The
existing operation owner decides whether work remains live. A missing or succeeded
operation settles as `outcome_unknown`; a retained failed or cancelled
operation settles in that state. For an unknown outcome without an existing failure,
the signed receipt writer atomically records `deployment_activation_not_observed`
in the existing private failure schema with phase `observe`, preserving the remaining
content and active deployment. The UI explains that interruption prevented confirmation.
A fresh signed root for the same requester and captured controller can perform this
terminal settlement, including its existing receipt Artifact update, but cannot stage,
activate or replace that Artifact. Receipt reads remain reads; recovery precedes the next
preparation or admission and never replays interrupted native work.

Native failure/settlement writers snapshot only the existing already-masked
stage-output sink into the same protected receipt Artifact. The excerpt reuses
the native log owner's diagnostic-page byte budget, preserves a truncation
indicator and does not copy raw exception text. It is not a second log store;
the retained operation file and its existing reader remain authoritative.
Git export captures the subject of the selected immutable object, forwards it
with the same source custody and presents it in review/receipt metadata. The
subject does not participate in approval or native-effect equality.

Provider URLs retain their receipt observation time; receipt member health is
historical evidence, not a live health verdict. Own-server public hostnames,
TLS and current health still belong to Domain/P50 owners. The receipt does not
infer a public URL from a Machine address. Review's recreate-with-incumbent
`stopThenStart` class and configured rollback retention are owner facts, not
estimated downtime, start-first readiness, kept count or measured disk usage.
Total kept-rollback bytes and free space have no receipt measurement producer.

Move to Team uses that same development-source list with
`projectSourceId` and `includeDeleted: true` to enumerate retained as well as live
Environments. The flag is preserved on every page; omission remains live-only.
The existing Source admission and header projection still decide disclosure,
and the cursor also binds this selection. The GET adapter accepts only the exact
string `true`. This is an unreleased, coordinated change to the closed deployment
V1 input, not a persisted-format change: an older strict development server must
refuse the operand rather than silently return an incomplete live-only inventory.
Move must not fall back to that incomplete inventory.

In 0.3 development, Source deletion uniformly sets `ProjectSource.deletedAt`.
The Source disappears from lists, pickers and ordinary Source reads. Environments
already created from it keep deploying under their existing authorization, by
the owner's Option B decision. Deletion refuses new Environment creates, template
instantiations, Publish operations and Source-pinned deploys; new Environment
creation returns `deployment_unavailable`. Existing Environment and deployment
history keeps the Source identity and display name,
including deleted Environments and preview repository references. History reads
use the same Source access owner with deleted records included; deletion grants
no additional access. No history is cascade-deleted. A fresh Source may reuse the
deleted Source's name or repository with a new ID and create request key.
The delete acknowledgement retains its existing `{ ok: true, sourceId, revision }`
shape, so older CLI readers continue to accept it.

Its Environment GET opts into `includeRetainedTargetLinkCleanup: true`. Only
that read returns `retainedTargetLinkCleanupCompleteIds`, including an empty
array when no retained link is proven clean. Omission is unavailable evidence,
not an empty cleanup set. The server derives this fact from the existing signed
teardown owner after ordinary Source/content admission; the client does not
classify cleanup from deletion flags or receipt state. Ordinary GETs do not
perform these cleanup reads.

Before its Source owner CAS, Move must share every referenced Environment,
target-link, receipt and defaults Artifact through the existing Artifact grant
writer. Its recipient preparation shares the Artifact's content key and separate
private-provenance key; retained revisions use those same keys. An acknowledged
grant with recipient preparation still pending is not proof that Team members can
open history. The client Move composition consumes this preparation through the
existing writer, not a new transfer service, per-revision key format or server
decryption path. The canonical approval-scope resolver follows a preview's
admitted template relationship, whose repository identity must equal its Source
identity. Preview children therefore consume the template's live approval
preferences rather than copying a waiver or inferring identity from PR content.

Used-secret copying likewise consumes the existing create owner's recipient
census and envelope-repair acknowledgement. A created resource can be known
while recipient preparation remains pending; Move retains that exact copy's
reference/revision and stops before binding changes or Source transfer. Known
Artifact, binding, token and trigger acknowledgements are also returned as
resource effects on a partial or unknown outcome. These are invocation results,
not a persisted transfer ledger or permission to replay an uncertain write.

Generated child inputs retain their already-known scope operands in the host's
reviewed-child plan. The canonical scope reader folds an exact Environment's
Require policy into the parent before any effect, even when the parent is
waived. Future Secret and Artifact operands remain deferred. The existing child
issuer binds the eventual concrete input to those known operands; it does not
re-evaluate permission at each step. Default Move review uses the same prepared
inventory preview, and its per-Action/per-surface waiver remains configurable.

Known scoped-child operand condition: a scoped child with neither input nor
scopeInput inherits its parent's scope. Current operand-less producers target a
not-yet-existing resource or the parent's own scope. A producer adding a scoped
child over another existing resource must declare its known scope operand;
that producer owns the deciding pre-effect Require test. This condition adds no
runtime check or second approval.

The existing Account token Action family passes its captured Account request and
lifetime to the token transport owner. Focusing another Home does not retarget a
Move's token renewal; a retired captured Account does not fall back to the active
one. Direct active-Account callers use that same transport owner without the
private Action context. An uncertain issued write still returns outcome unknown.

CLI and UI forward deploy, rollback, promote and teardown as the original
Action to the currently admitted destination controller, before receipt
reservation. Home Machine authorization covers only their declared native
preparation/storage phases; it grants no generic Artifact update or grant write.
UI create/edit also reaches the receiving daemon's existing content-preparation
owner instead of writing records around that normalizer. Server deployment
transactions remain storage/admission/CAS owners, not native effect executors.
The UI target-link Action accepts target intent without content references;
its admitted invocation creates the empty link Artifact through the captured
Account and prepares the existing Team audience before storage. Compact rollback
selects an Environment and retained Deployment receipt; the receiving daemon's
native preparation derives current placement and a fresh candidate, preserving
retained source/images without copying the old review or observed outcomes.
Finite child admission preserves Home's lower admitted authority ceiling even
when the signed root credential permits present-user authority. Rollout receipts
preserve typed transport failure codes without copying private exception text.
In 0.3 development source, a known failed rollout also returns its Home,
Environment, target-link and receipt identity with the recorded failure phase.
Approval settlement retains this strict payload only when it matches the request.
A failed candidate cleanup remains explicit alongside the original failure,
so the caller can locate the receipt and distinguish an activation failure from
an incomplete removal.
Both Actions still accept prepared callers, and storage accepts only prepared
content references. Content preparation does not invoke a separate Artifact
Action or ask for a second child confirmation.
Controller preparation reports changed Source revisions or reviewed native
inputs as `deployment_conflict`, substituted Source or candidate identity as
`target_mismatch`, and malformed compact replay or missing required review basis
as `invalid_parameters`. The factory uses the canonical `RpcError` to preserve
its refusal reason across RPC. Candidate preparation opens the Environment body once;
current-owner metadata is still checked at the Team Artifact-sharing boundary
before receipt admission, preserving disclosure protection. The server
transaction owns the actual Environment and target-link revision CAS.

The development-source review projector reports `downtime: 'stopThenStart'`
only when a recreate deploy replaces a serving receipt, without estimating a
duration. `rollbackStorage.keepPreviousDeployments` reports the Environment's
configured retention policy, not an observed kept count, retained bytes or free
disk space. Secret names come from the opened client-side binding content,
never server-visible metadata; values and resource references stay out of the
review. Start-first, Domain/TLS and disk measurements need their real producers
before those facts can be reported. These are typed review facts, not a claim
that every UI row or the composed native journey is verified.

Promotion selects a successful source receipt by identity and uses its captured
source bytes. Source Environment edits and receipt metadata revisions do not
replace that immutable source. New promotion and review still require source
deploy rights, destination management rights and destination/link/content CAS.
Initial review pins the source archive custody. An admitted build may adopt the
same image identities into the destination receipt's archive location; subsequent
children consume that receipt's custody rather than comparing its new location
with the source's. Source, image, destination-content and placement comparisons
remain unchanged.
In 0.3 development source, UI, CLI and agent callers can send a compact
`deployments.promote` request with `environmentId` (destination),
`sourceEnvironmentId`, `sourceDeploymentId`, explicit `artifact: 'image' | 'rebuild'`
and an optional `requestKey`. The receiving destination controller uses the same
Action preparation and review path as Deploy. The stored-promotion owner derives
the candidate from the selected receipt, preserves destination configuration and
publishes both reviewed content references before approval. Storage and approved
replay still require the prepared input; replay cannot regenerate candidates.
The current native producer supports recorded-image promotion between stored
definitions; explicit rebuild remains typed unsupported until its producer lands.
Compact requests require the corresponding protocol and controller reload;
older controllers continue to require prepared references and reject this new input.
Pending supersession retains its source intent and request/operation identity,
not another reviewed-link revision. New pending writes use the strict current
shape; retained plain and opened encrypted intent drop obsolete top-level fields
at the existing reader. Encrypted TAKE still compares the exact original
ciphertext, and signed pending requester/Home/controller correspondence remains
required. Cold recovery opens that same intent and candidate before restoring
the captured operation. It forwards the original Environment and target-link
revisions to server admission, whose CAS decides whether they are still current.

In 0.3 development source, own-server Deploy accepts `onFailure: 'rollbackAll' |
'keepPartial'` before candidate preparation. Omission retains `rollbackAll`.
The prepared receipt and native approval review carry that selected policy;
pending supersession captures it and resume uses the captured value. An approval
does not edit the already prepared policy. Platform targets refuse an explicit
`onFailure` with `unsupported_action`; omitting it preserves their provider-owned
deployment behavior.

The existing Environment update Action also accepts partial
`patch.ownServer` operands for `rollout` (`recreate` or `startFirst`) and
`autoRestorePreviousRelease`, plus `patch.retainPreviousDeployments` (a
nonnegative safe integer). Preparation patches the existing private Environment
content and preserves omitted settings. An unchanged patch does not write an
Artifact; a changed patch uses the existing signed content-publication path.

In the same 0.3 development Action, `patch.ownServer.serviceExports` replaces the
declared exports with an explicit private endpoint list: each entry names its
key, Compose service, container port, scheme and `privateNetwork` exposure with
the selected private network. An empty list clears the declarations. This operand
cannot author public or loopback exports; existing declarations remain readable.
`patch.definition` accepts the existing
`from: 'compose'` source input, including document, public files and selectors;
the native source owner derives its digest and stored content revision. It edits
an existing stored definition, rather than converting a repository source.
Both operands stay in the private invocation and Account Artifact; Home receives
the prepared content reference. Signed private authoring publishes its invocation's
Artifact even when the selected content is unchanged. Neither an export
declaration nor a source save opens a firewall rule or deploys the change.

An explicit deployment supplies its exact private workload binding to the
existing Machine firewall transition. The native writer retains the applied
Environment declarations in the root-owned `rules.nft`; replacing one
Environment's bindings preserves the others. Network and Domain transitions
read and preserve that same applied policy through the existing writer, without
a separate Machine desired-state record. Private sharing does not create public
sharing or copy database credentials.

Deployment approval observation uses the existing `approval.request.get` result's
optional `deploymentReceipt` projection. An open request reports
`waiting-for-approval`; Approve and Deny use the existing approval decision
Action. No Deployment row is reserved before approval. After admission the
projection carries the existing accepted receipt result, which can be either
pending Action-operation custody or an admitted Deployment identity.

The 0.3 development receipt-list query accepts `state`, `actorAccountId` and
`operation`. These selectors intersect at the server query before paging, and
the read controller keeps different selections as separate demands. Actor means
the receipt's requesting Account; it does not infer an agent or automation
category. Empty matches remain an empty selected page.

Environment reads expose an optional `controller: { machineId, state }` fact.
Its states are `available`, `paused` (jobs and alerts pause), and `unknown` when
presence is unavailable. The server reads only the Environment's recorded
controller and uses the existing Machine presence decision. The exported
projector also accepts existing pushed Machine presence; it adds no polling
or new timer.

Opened native receipts expose `cancellationConsequence` to person and agent
readers. An observed stopped incumbent reports `service-down-until-rollback`;
older activation-phase evidence reports the qualified
`may-leave-service-down-until-rollback`. Native stop/start observations update
the existing private receipt writer. This is consequence presentation, not
another cancellation or authorization path.
If cancellation wins before that observation is published, the last receipt can
retain only the qualified activation warning, or no consequence during a backup
restore phase. Existing native recovery and the person's rollback remain the
recovery paths; this read projection does not make publication durable across
cancellation.

The host's existing secret acquisition refuses unavailable or empty bound
application secrets and unsatisfied required secret declarations from the exact
Source's `.happier/project.json`. It returns `secret_missing` with the strict
value-free details `{ deployable: false, missingRequiredSecretNames: string[] }`.
No native review is fabricated when missing secrets prevent Compose rendering;
the existing refusal presenter consumes these names. Optional declarations and
configuration requirements do not become required secret bindings.

Aggregate success signs the current target-link revision; the native owner still
requires final version evidence for every installation, without echoing that
membership back as a separate server proof. The pending observer consumes one
filtered in-progress receipt fact after a relevant pushed change or reconnect;
it does not page settled receipt history to decide whether the slot is busy.

New deploys and preparation use current requester/Source admission. An accepted
job instead retains its captured controller, builder and installations after
the requester leaves a Team or rotates their sign-in token. Its child-currentness owner makes one relational
job-existence lookup, checking the receipt/operation binding and live link/member
facts without another requester or Team permission evaluation. Workflow continuations
also require their admitted Run to remain active; they do not re-admit the requester
or publisher against the Source. Cancellation,
detach, removed membership and a foreign controller still refuse. Transport
authentication retains installation identity; new secret/codec acquisitions
retain their own data-access boundary. Signed receipt writes reuse the existing
installed-Machine Source boundary rather than requiring the original deployer
to remain a Team member. This changes neither new-deploy admission nor approval
defaults and adds no mid-operation revocation watcher.

The development-source final-disposition Actions are
`deployments.targets.unlink` and `deployments.environments.delete`. Both use
Environment-scoped policy and irreversible consequence review; Agent callers
require approval by default. A resource-free configured association can be
unlinked directly. An owned or active association requires a current, complete,
settled teardown receipt, including its selected retention choices, or explicit
`detachKeepRunning`. Queued/running receipts and pending deployment intent
must settle through their existing owners first. An `outcome_unknown` receipt
does not occupy the effecting slot or retain former-builder grants/references.
Its unknown outcome remains disclosed by the retained receipt reader, including
after explicit detach; it is not proof that the workload was cleaned up.
A successful partial teardown
does not prove an entire link was cleaned up.

Delete, unlink and explicit detach use ReadCommitted transactions. Their shared
disposition owner locks the exact Environment before admission and revision
checks, then atomically changes its records and publishes to the Account.
Unrelated Account cursor publication can complete during this work without
invalidating a transaction-wide Serializable snapshot. Competing Environment
writers still serialize on the existing Environment row lock; revision and
teardown-proof refusals remain owned by disposition. This does not add retries.

The canonical signed transition writer retains the admitted `teardownProof` on
the receipt. Final disposition validates that proof against the current custody
and resource revision; private receipt Artifact content is not server authority.
Historical receipts without that captured proof cannot establish complete
cleanup. The additive receipt-proof migration must be deployed before the new
server source is loaded against a retained database.

After a successful unlink/delete, the same cleanup reader recognizes the one
additional disposition revision on the retained link. The explicit receipt
check used to authorize disposition still requires the pre-disposition revision;
an arbitrary later revision does not inherit cleanup proof.

Settlement and final disposition share `readDeploymentTeardownSubjectsInTx`:
own-server members, a plugin's scalar placement, or its receipt-captured
controller for account-placed resources. An admitted own-server successor
inherits overlapping installation custody along the existing target lineage;
unlinking its predecessor does not tear down the successor's workload. A plugin
on the same Machine does not inherit that custody.

Unlink/delete change Happier records, future Automation admission and secret
grant custody. Those Actions do not touch volumes. Native teardown retains its
separate resource-disposition contract: only a prepared native inventory can
name selected owned data deletion. There is no direct per-volume input on the
record-disposition Actions. Detached link, member and receipt records remain
available to history and Machine-reference disclosure. Detach ends management
and alerts for the removed runtime or Environment; already-running processes
can retain decrypted secret bytes, so upstream rotation is needed to invalidate
those bytes. The UI logic hook exposes these consequences and observes the
existing pushed receipt reader without polling or automatically retrying a
disposition when a receipt settles. Rendered review composition and native
inventory preparation remain separate integration work.

The Variables editor's `useEnvironmentSavedSecretBindings` composes the existing
Saved Secret catalog's `secrets.create` Action with
`useEnvironmentSecretBindingsEditor`. It creates private Saved Secrets only for
secret-classified bulk rows and gives the editor exact references and revision
1; plain rows remain values. It requests catalog metadata without decrypted
material. The controlled draft's existing parent remains the sole caller of
`deployments.bindings.set`. Destination validation uses the editor's own rules
before creating resources. If a later creation fails, completed references are
returned for explicit reuse; no bindings are partially applied, no created
Secret is silently deleted, and no creation is automatically retried. Scope
retirement or cancellation releases the existing Action continuation and
prevents a late result from binding into another draft. These are development
hook contracts; the rendered Bulk edit and consequence-review flows are owned
by the Environment page composition.

In the development UI, Variables opens the existing `SharedSavedSecretValueItem`
for a saved-secret row. Opening it reads metadata only; its confirmed
`secrets.shared.reveal` Action owns material acquisition and transient display.
Overview and Variables retain withdrawn bindings with the catalog's typed reason
and a link to Saved Secrets for recovery. Rotation also opens Saved Secrets.
The Variables links to Machine Services and API tokens reach their existing
control and grant editors. Machine service Stop uses `machines.services.control`
through the UI executor's captured Machine RPC adapter.

Ordinary Environment creation uses the same Action's one-shot preparation before
review. Clients submit repository, Compose or image intent to the same create
Action's authored `mode:'preview'` through the existing Action front door.
That returns the protected prepared CreateInput and review-only creation-default
provenance; consumers review values from that response and pass its exact prepared
input to the existing front-door `prepare` method, retaining its run-only
invocation. The receiving daemon
admits the actual Source owner/revision, opens that Source's private defaults,
and uses the one resolver: explicit > shared Project > owning Account > built-in.
Team Projects never consult the invoking person's Account preferences. An
own-server intent without its first runtime has no runtime-derived Machine
default; it does not become a platform target or borrow the controller as a
runtime. Unresolved controller selection refuses before content is written.
Running the reviewed invocation reuses its exact Artifact references and values;
it never reruns defaults or recreates content, including on approval replay.
The same create Action's authored `mode:'preview'` is the transport behind that
preparation, not a second creation Action or a live inheritance relationship.
Its Artifact writes occur only for an explicit Review/preparation intent, never
on mount or for inert initial prefill.

Development-source Duplicate uses this same create Action with explicit
`copyFrom` source revision and choices. Preparation admits source read and
destination Source management, resolves explicit choices before creation defaults,
and presents a redacted copy diff. The stored create retains source identity,
revision and an opaque host-produced copy-intent commitment, not private choices
or plaintext content. Prepared and stored copies require that commitment; ordinary
creation needs none. The existing create request-key owner compares this reviewed
intent without newly allocated Artifact identities: an equivalent retry returns
the recorded Environment, while changed source revision, choices or resolved
configuration conflict. E2EE equality uses the requester's Account-keyed commitment;
Plain Accounts use a keyless canonical digest. Neither branch creates another
result store or changes the existing request-key retention. Selected bindings use the
ordinary reviewed `deployments.bindings.set` child on the newly allocated
Environment; secret references receive fresh audience/grant admission rather
than copied live grants. The generic reviewed-child HTTP carrier preserves the
original requester and create root. Running state, history, waivers, consent and
credentials are not implicitly duplicated. Missing E2EE custody returns
`client_required`; unavailable data/operational destinations return typed
unavailable results rather than silently reusing resources. A failed child leaves
the created Environment visible with an explicit continuation, not a rollback.

Preview database, backup and alert selections remain unavailable at this leaf
until their domain-owned schemas and first-configuration writers are connected.

Shared Project defaults also participate in the Source authority CAS. The only
supported owner transfer is the actor's own Account Source to a Team. Before that
owner change, their stored Artifact revision must remain current,
the new owner requires durable write access, and the future
Source audience must have current recipient envelopes where encryption requires them. A failed
check returns `source_conflict` before changing the Source. Equal writes and
name-only and audience-only edits do not read dependent defaults. Artifact sharing
remains a separate operation through its existing writers. This development-source defaults
check does not complete the separate five-step workload Move to Team.

The same development-source CAS checks workload custody through the existing
Machine, Artifact and Saved Secret admission owners. Required secret uses come
from the binding writer's non-content capture and current placement, not from
delivered grant rows; build-only bindings do not fan out to runtime Machines.
Incomplete captures require preparation through the binding writer before the
owner flip. Retained content stays readable, and a retired link releases Machine
custody only when the disposition owner's current teardown proof establishes it.
The CAS neither copies secrets nor changes CI token or saved-trigger approval.

In development source, a retained Machine Services list borrows the original
requester's Account/Home change observation. Linked-identity changes use the
Protocol-owned `account/linked-identities` fact, not profile equality or a
Settings hint. A relevant access change or lost observation closes that
disclosure; reopening reads current Environment access through its existing
owner. The observation itself never grants access and adds no polling timer.

The development catalog entry `deployments.publish.prepare` is a separate
read-only step in the same Publish owner. It accepts P45's unchanged pinned app
reference and an explicit Machine installation, with either an existing Project
Source revision or `newProject: { name, owner, requestKey }`. The latter retains
the reviewed Account/Team owner without writing a Source or reading a Project
defaults layer.
The existing pinned-item reader and creation-default resolver return an inert
draft with native variable/domain declarations and explicit > Project > own
Account > built-in provenance; Team Projects skip Account preferences. Its
signed read purpose admits only that Source and its current private defaults
Artifact, not Environment creation, template apply, secret generation or native
execution. `useCatalogAppPreparation(lifetime)` is the mounted UI hook over
`prepareCatalogAppPublish`; SDK projection
uses `deployments.preparePublishCatalog` to avoid colliding with Publish itself.
This draft is not a reviewed Publish operand or a deployment approval.

Ordinary `deployments.environments.create` accepts the same `catalogApp`
definition operand as a Stored App Preset and delegates preparation and apply
to the existing template composition. Reviewed creation defaults retain their
values and provenance through apply; generation and bindings stay with their
existing owners. The first runtime Link remains optional: an explicit controller
can create the catalog Environment without selecting a runtime or inferring a
builder. Runtime variable bindings are saved as references without acquiring
credentials until a destination is linked; selected Domains require that first
runtime Link before creation. For a new repository-free Project, the Environment transaction
calls the ordinary Source creator at apply time. A later Environment refusal
rolls both records back; there is no early Project write or separate Store writer.

Environment template provenance retains each database by its Compose service when
another template is added. Data overview and detail pages read that inventory;
pre-migration backups select the database named by the saved dump source. The
Environment decoder normalizes scalar database metadata already written by the
current development producer into the same inventory. Catalog templates continue
to declare their own single database.

The existing Environment Add sheet sends `intent: 'add'` to template
instantiation. Preparation selects the first available shared suffix for the
template's services, variable bindings and private Compose resources, then
rewrites their declared references, connection exports and database/backup
metadata together. For example, adding the default PostgreSQL template twice
creates `database` and `database-2`, with separate `postgres-data` volumes and
`DB_PASSWORD` / `DB_PASSWORD_2` generated credentials. External resources remain
shared by their declared names. Omitting the Add intent preserves the existing
pinned-template replacement and upgrade behavior.

In development, generated template bindings select the pinned descriptor's `generatedSecrets[].key`;
they do not name a new Saved Secret. The shared planner refuses an undeclared
selection with `template_generator_undeclared`, naming the supplied key in the
message and `details.key`. This input refusal is distinct from catalog readiness.

The development Environment home is also checkout-independent:
`buildDeploymentEnvironmentHref({ serverId, projectSourceId, environmentId })`
opens `/deployments/[projectSourceId]` with the exact Home and Environment query
parameters. This route hosts the same `ProjectDeploymentsBody` and
`useDeploymentProject` controller as the checkout's Deployments page. Exact
detail reads do not require membership in the rail's current page and remain
available while that collection is pending, failed, or empty. Surface composition
and Store activation are separate UI integration work.

The unreleased Environment protection edit uses the same manager-owned update
Action and Environment/content CAS as other reversible edits. Its UI Action data
exposes the admitted previous and proposed protection plus a static fork-safety
hint on a Production downgrade. Preparing that data reads no Environment
associations or eligibility and adds no confirmation. Save preserves the current
private content reference; an equal write publishes no change. This hint is not
a permission-changing policy notice or evidence that a Machine is eligible for
fork previews. P44's setup eligibility and exact-commit approval remain separate
requirements; the page's visible editor/hint composition is still being connected.

New own-server configurations authored by UI creation or template instantiation
use the deployment-protocol Environment initializer once: recreate rollout,
automatic previous-release restoration enabled, backup before migration enabled,
Ask me after a migration failure, and no service exports. Explicit configuration
is preserved. Reads, ordinary updates and validation of pre-authored Artifacts
do not reapply these creation defaults or rewrite private content. These defaults
describe development-source configuration; P41/P45 still own migration and
verified backup/restore execution.

Deployment Account-change publication retains its admitted Project Source id in
both durable hints and content-free socket identities. The Source-scoped read
controller consumes one hint batch per wake and refreshes each affected demanded
resource once; another Source's changes do not reread its collections. Retained
feed entries without Source routing remain conservative, and Source/Team access
changes and connection repair retain their existing revalidation path. These
development-source routing facts carry no private Artifact content or authority.

The development collection read also serves Account-wide and Machine-filtered
inventory through that same controller. Each requested page retains current
Source admission and native partial-coverage facts; it does not enumerate Projects
or drain continuation pages. Machine filtering includes retained placement roles,
so runtime inventory uses the supplied current runtime-link membership, not the
controller or builder Machine. An unreadable candidate can advance an opaque
continuation without exposing its identity. Continuations are private request
state beside the controller's page projection: subscribers receive rows,
`hasNextPage` and `hasPreviousPage`, never cursor ciphertext. Equal refreshes do
not publish, while explicit navigation spends the latest admitted token.
Environment detail opens only its own private content and batches Artifact-head
admission for retained link headers; a retained link is never a replacement for
the exact selected runtime. Receipt history uses request time and id for stable
newest-first pagination. Settled history can reuse its listed header while opening
only the receipt bodies needed to resolve member versions; live or uncertain
receipts retain the canonical fresh read. Explicit Retry can supersede a stalled
read without losing the last admitted presentation.

Development collection readers preserve valid siblings when an individual stored
header or private Artifact cannot be projected. Environment and target inventories
mark that page's coverage partial; receipt history and Domain pages do the same,
retaining valid rows and continuation. Their tabs show the existing unavailable/Retry
state alongside those rows, and partial history cannot establish that no predecessor
exists. A page containing only omitted rows still advances without claiming absence.
Shared Artifact references are requested once and opened against each row's own
kind and revision. A failed collection request or Artifact batch remains a failure;
detail, mutation and in-progress receipt authority reads remain strict.

Installed Workflow deployment children retain their Run origin and installation
proof through the existing Home sender; they do not become new host invocations.
Home checks current Run publisher custody, Source deploy authority and the Environment's current
installed controller/runtime link. Run assignment alone grants no deployment
consent; the receiving executor owns exact-input approval. Issued proofs recheck
that same provenance owner; receipt writers retain revision
and placement CAS, so a legitimate receipt write does not expire its own root.
An admitted prepared receipt captures controller/builder installation identities;
later Environment edits do not invalidate its retained receipt on retry.
Admission also captures the verified
root's existing request-envelope digest in `Deployment.acceptedRequestEnvelopeDigest`.
Compact and prepared continuation requests match that digest, the native operation
and the captured controller installation in one receipt lookup. Sharing a candidate
Artifact does not authorize another receipt; a missing digest refuses continuation.
The additive column migration must be deployed before the new server writer.
Its exact prepared continuation does not move to a replacement controller;
Home still rechecks the originating
Run, Source, installation and receipt correspondence. This exception does not
authorize fresh root issuance, generic proof verification or a semantic request
without an admitted prepared-receipt correspondence. Captured identities are
not copied grants, keys or requester custody.
For a same-Account deployment leaf, the sender first obtains that Home-issued
root, then seals the requester's existing Account context to the admitted receiver
installation using the existing private carrier. The installed receiver opens
that context through its normal custody owner; Workflow origin never permits
borrowing ordinary daemon credentials. A foreign custodian still requires a
separate confidentiality decision and is not automatically given requester material.
Setup app review reads the exact candidate and selected Environment admitted by
its signed preparation purpose. The requester projection carries those documents
under that same proof, without substituting an ordinary Account bearer read.

Candidate authoring persists the actual resolved source/build intent in a receipt
Artifact before P42's secret-launch admission reads that exact id. Image discovery
and review update this invocation-owned candidate by Artifact CAS and return its
acknowledged revision; they do not substitute a throwaway admission Artifact.
Separate builders use the same producer and return the persisted reference for
the controller to reopen. Explicitly supplied and already-approved candidates
retain their existing non-rewriting review/replay behavior. Team content still
requires the Source's canonical Artifact audience: the existing Artifact grant
and recipient-key owners prepare that exact Team, not an arbitrary audience.
The shared signed-root mint binds the current Source id/revision and the exact
candidate Artifact identity. Promotion has one additional Environment-content
identity. Reminting the same invocation and Source retains these identities;
pending preparation refreshes the unadmitted head with its current CAS, while a
changed Source receives fresh identities. An encrypted native request exposes
only its Environment admission; opening it must agree with that projection and
the signed root before preparation can publish content.
The HTTP Artifact mutation rechecks that custody inside its write transaction,
under the same Environment lock as receipt admission; admitting the receipt
retires preparation writes. Replacement content must not retain foreign grant
principals, recipient keys or a live public link, even when their current readers
overlap the intended Team.

In development source, the private Environment body accepts a strict
`previewTemplate` with the repository, runtime link, fork choice, Domain naming
inputs, variable blueprints and exact template or managed-data references. The
public Environment header carries none of these private choices. This content
field alone does not activate a PR observer or authorize child effects.
The host preview-admission owner opens the private parent template before a fork
can create a child or acquire deployment runtime, provider or registry resources.
Forks with `forkPreviews: off` are refused. `approveEachCommit` also remains
unavailable until an exact-head, per-Action approval producer and eligible
non-production execution are supplied; standing Workflow approval does not
substitute for either. This decision runs on the host for encrypted Accounts as
well as plaintext Accounts, before binding or data credential acquisition.

Protected preview provenance has one strict schema shared by the private
Environment content reader and public read-only consumers. It carries the full
neutral repository/head identity and PR association, not an approval mode or a
copied waiver. Deployment Artifact readers first share exact Artifact id,
header/body revision, private kind and JSON-body admission; the domain reader
then parses the full body or the particular strict leaf it consumes. Opening an
Artifact does not establish a preview relationship, current head or approval.
A prepared preview child identifies its current template revision, pull request
and runtime target link. Storage derives the four preview relation ids from that
same Source-managed repository template and live link, and requires an enabled
saved admission definition. Standard Environments have none of those four ids.
This storage relation does not establish current-head/fork approval or a complete
preview setup and cleanup journey; those execution producers remain required.

The GitHub plugin's development preview publication Workflow reads the current
deployment receipt on a selected controller, then binds its receipt, Environment
and runtime link ids into the single `github/pull-request/preview-status` Forge
Action. It publishes an admitted own-server child and exact receipt to the current
PR head; retrying publication does not redeploy. The host admits its Environment approval
scope through the preview relation to the template. Publication does not grant
deployment approval. Pending, failed and removed publications carry no URL. Ready
publication remains unavailable until P41 supplies current application readiness
and its authoritative preview URL; historical receipts and caller URLs do not
supply that fact. This explicit Workflow does not supply the automatic Plan 44
preview lifecycle trigger. Teardown publication precedes child deletion.

In development source, a managed preview data-create Action retains a minimal
paired-delete projection in its existing Workflow invocation output. Neon and
Supabase branch create/delete Actions admit the normal Workflow agent surface
through their declarations, retaining their existing approval policy. Ordinary
`deployments.teardown` accepts the exact `dataCreation:{runId,invocationId}`
reference, opens it through the authenticated Workflow invocation getter, and
admits the captured Account credential reference and native delete operands once. Its
existing reviewed-child issuer then performs deletion through the declared data
Action and records success, failure or an unknown outcome in the ordinary
teardown receipt. Editing the live data link from A to B does not redirect cleanup
of A or delete B. Provider refusals retain the same canonical failure and cause in
the receipt and public Action result, including whether an effect was attempted;
an uncertain effect remains an unknown outcome. Replaying a successful teardown request reuses its existing receipt
and content Artifact without a second provider deletion. A missing or unknown
creation result cannot authorize cleanup.
Data-only cleanup has no application source revision; it retains receipt outcome
and step facts without fabricating one. These owners do not supply the remaining
SCM lifecycle producer, automatic preview setup or rendered preview surfaces.

The development Add editor submits its person-authored definition and first
own-server membership through the existing `deployments.environments.create`
Action. Its optional `firstTargetLink` contains exact private Artifact references
and nonempty installation-bound Machine membership. One approval retains both
operands; the Home creates the Environment and delegates that first link to the
normal target-link owner in one transaction. A refused first link rolls back the
Environment too, and replay does not create a second link. The separate link
Action remains available for changes to an existing Environment.

The public source port materializes the receipt's immutable commit through the
SCM backend's optional `exportCommit` operation and the existing manifest/blob
staging owner. Git object bytes, rather than HEAD/index/dirty workspace bytes,
supply the release. The P42 opaque execution-environment port supplies each
phase to canonical Exec; targets receive no secret-value map.

An approved target basis retains source/configuration fingerprints, current
Environment/link/installations, binding references/revisions, image pins and a
stable physical Compose project. No secret-interpolated-model digest is retained.
Its optional root/member `servicePlatforms` vector records each selected service's
effective platform from that member's native runtime model. Older records without
the vector retain their host-platform default; another member's override is never
used as that default.
The structured approval review projects that same admitted candidate's exact
commit, or stored-definition revision and digest, alongside the selected link's
serving receipt revision. A first deployment reports no replaced receipt.
Passive native review opens its Environment snapshot once and re-admits the full
snapshot before publishing review facts. A receiving deployment child admits its
signed job, installation and Home authority once. Its finite native work retains
local custody and cancellation; Docker commands do not repeat Home authority
checks. Each new server request remains subject to server admission, and each
new secret phase acquires its material through the launch-admission owner.
Review reads only its selected rollback receipt, the current link's serving
receipt, and a promotion's explicitly selected source receipt. It does not gain
receipt-history access. When a mixed fleet's repository bind uses another native
incumbent, the existing source-custody reader derives that exact receipt from the
observed mount's canonical release/restoration root. Its receiver-signed private
fact carries the receipt identity and physical-root fingerprint, not the path.
Home checks current Source/installation authority and the exact Environment/link
lineage; the native reader validates the protected manifest and rechecks the
actual mount after the awaited read. This is not a second reader or a history
fallback. Execution and retention retain their separate consumed history paths.
Source handles retain their admitted Source and installation custody rather than
reopening secret admission during nested native work. Input-free native commands
capture stage output with an empty redaction lease without materializing
application inputs; secret-bearing commands retain their phase redaction. Detached
service observations keep their generation-owned authority, not the finished
deployment invocation's lifetime.
Environment name, available ingress intent, Machine identity and delivered
variable-secret binding names travel with the native review; stored documents,
binding references and secret values do not. The current Environment read model
has no Domain hostname projection, so review does not invent one. Historical
approvals may omit these optional display facts.
One native project activation produces one Environment witness per Compose
service under Local Services purpose `deployment`, with ids
`<environmentId>/<composeService>`. These witnesses have no requester or
Workspace, and the existing service owner supplies health and controls.
The development template `health` hint controls deployment readiness participation,
while each service keeps its actual Compose healthcheck and individual health report.
The native owner starts the full admitted dependency graph, then waits only for
participating services; required dependency health and successful init completion
still apply. Its generation proof checks every service's image, process state and
restart count. Participating services use Docker's reported `State.Health.Status`:
healthy checks settle as healthy; a participant without a check leaves the aggregate
unverified. Observation reuses that native proof without a separate Happier check or
new polling. Excluding every service yields unverified readiness.
The same optional hint is exposed in review and captured in the receipt's
`approvedInputBasis.health`. Activation, project-readiness observation and restoration consume that
capture; an older receipt without it retains all-service participation, even when
the current template has a different hint.
After a known failed rollout, automatic recovery reads the current uniform
release pointer and restores that receipt's source, images and captured inputs.
An intervening Environment bindings edit does not re-admit the failed candidate
or substitute new bindings into the retained release.
Integration and loaded-runtime proof remain program work; these source
boundaries do not establish released availability.

The native image owner verifies saved CONFIG bytes and exact platform identity,
with manifest provenance checked separately from store-specific Docker ids.
Deploy and code rollback first look for the receipt's exact local owned image or
config identity, without opening registry credentials. Public code rollback
reactivates the selected retained release's immutable images; its fresh review
does not dispatch the builder or require new build outcomes. If an image is absent and the
current target-link/origin binding permits `pushPull`, the same activation path
pulls only the recorded platform manifest digest using P42's invocation-private
Docker configuration, disposes that configuration on every exit, and verifies
the acquired CONFIG before tagging or activation. A failed or revoked registry
use is a refusal; activation never substitutes a mutable tag or rebuild.

When no eligible recorded registry variant is available, the native owner can
consume an exact receipt-owned single-platform archive. Its holder is recorded
with size and raw SHA-256, outside immutable source releases. The receiving
daemon mounts the existing finite filesystem transfer driver; the controller
coordinates references, never image bytes. Archive bytes, CONFIG and platform
are verified before load, then verified again in the receiving Docker store.
Local CONFIG/platform equality remains portable when Docker store ids and
manifest metadata differ. A selected registry failure does not fall back to an
archive, and unknown transfer/load settlement never triggers blind replay.

Build/member dispatch retains the original Action root and controller signature;
the receiving daemon remains the finite transport actor, not a replacement
requester. Its initial exact-Machine codec lookup uses the same signed child
proof, without an ambient Account bearer or unknown-mode fallback. Home verifies
archive origins through immutable rollback/promotion edges, Source custody
and the exact holder installation/grant, never chronological predecessors or
the original requester's current Team membership. Codec projection consumes the
native admission while retaining Account-mode and recipient-envelope checks. A
receiver's origin annotation alone grants no path authority. The native filesystem
owner admits only the proven archive root and hash. Finite operation get/list/push
also retain that parent identity; ordinary Account readers cannot obtain private
child results through another operation alias.

The build phase uses the same source normalization and opaque execution port.
Preapproval discovery declares source builds without executing them and resolves
one actual prebuilt-source variant, not an assumed builder-host variant. For an
index it retains the first runnable descriptor and immutable index digest; it does
not fetch every platform. After review, only the required service/platform pairs
are resolved from that approved immutable index. Admitted builds use those distinct
pairs, native Bake evaluation and separate single-platform exports rather than
rebuilding on each runtime Machine. The
host owns an empty build working directory so native tools cannot discover an
untracked source `.env`; exact source currentness remains enforced. These native
owners do not alone establish a completed separate-builder flow.

Storage admission reads that proven image's `Config.Volumes` together with the
native effective Compose mounts. Multi-Machine runtime admission rejects writable
image, anonymous and named volumes, mutable host binds, and external or network
storage. Explicit read-only overrides, tmpfs, configs, secrets and unchanged
manifest-source binds remain usable; a writable source bind warns. One-Machine
replicas sharing named writable storage produce a concurrent-writer warning.
Bind checks include runtime-created and modified bytes after source custody is
committed; the public source handle does not expose the manifest or filesystem.

Source retention runs only after the Environment receipt settles and its member
results prove the current uniform version. The controller dispatches that finite
continuation to runtime members and the receipt's captured builder. Repository,
stored and build source custody use the same manifest provenance; builder custody
is published before native build effects. Stage-log descriptors retain the Machine,
installation and pinned `.happier/deploy.log` path; local cursor identity detects
rotation without persisting an inode witness in the receipt. Writers create the log
exclusively and never recreate a missing retained log. Cleanup removes only unchanged
manifest leaves and that pinned log under the source-root and native storage deletion
fence, preserving mounted paths, modified application files, shared data and other runtime bytes.
File and symlink removal cannot recurse
if an application replaces a leaf with a directory.

Retention reads its initial content snapshot and receipt history, then rechecks
signed Environment, link and receipt headers before deletion; it does not reopen
private bodies for every file.
Native mount inspection and cleanup share the existing Docker-engine admission.
The same receipt-retention projection exposes protected image CONFIG/platform
identities and their canonical owned tags and activation references. Missing
receipt/image custody or an unsettled protected operation returns unavailable
protection, not an empty set. This is input to the native prune integration;
the projection alone neither verifies Docker's image store nor authorizes pruning.
Failed cleanup and preserved-data diagnostics currently reach the daemon file log;
person-visible warnings, native image/tag protection and archive retirement remain
separate integration work. This source cleanup does not certify those outcomes or
the loaded native journey.

These are partial development-source capabilities. Admitted build/member child
dispatch, mounted receiver distribution and ordered fleet compensation are being
connected through the existing receipt and Machine RPC owners. The accepted
Environment revision comes from the parent's actual admission response, not a
guessed increment or a new current-state snapshot. Missing child authority or
execution wiring fails closed. Scoped semantic preparation/key-bootstrap issuance,
semantic accepted-host continuity after controller changes, and joining/drain
route proofs still require their owning producers. The connected native journey and P45's typed
single-writer/data-move remedies remain unfinished; these source changes do not
establish released multi-Machine execution support.

### Public deployment contracts (0.3 development)

Environment `chosen` deployers are exact Account or Team Group references, not
copied roles. Selection is admitted against the Source's current principal
scope. Reads and deployment effects use that same Source admission and the
actor's current qualified membership; an archived Group or removed member does
not retain deployment authority. Definition managers retain management and
deployment access. Changing the selected references shares the existing
Environment revision CAS, including a combined binding/builder edit. This is
development-source policy support, not completion of the Move-to-Team journey.

The shared `createDeploymentTargetCatalogV1` in `packages/deployments` indexes
admitted normalized targets by their complete host or plugin contribution source.
The CLI projection qualifies declaration-local Action and dynamic Resource
references through the single Protocol role traversal. The strict `runtime` arm
retains its required Actions; the strict `data` arm has only optional `dataV1`
capabilities, with omitted groups/leaves unsupported. Both normalized arms reuse
the Protocol role factories rather than maintaining a second grammar. The data
parent branch reference is one strict provider-project/branch native-id pair,
not a branch name or authority grant. Own-server execution admission reads this same
catalog. A plugin's local target id cannot select the host target. This is
development-source catalog and admission wiring, not installed runtime/data
conformance.

Managed data Actions use the same role admission as runtime targets. Project
preparation needs no fabricated resource id; selected branch and connection
operations prove the exact data link, revision, credential principal and native
provider tuple without a runtime deployment receipt. Neon and Supabase contribute
Account Actions on the Environment controller, with invocation-bound provider
HTTP and Plan 42 secret custody. Project creation and preview branch mutations
never replay an ambiguous write: they re-observe or return an explicit unknown
outcome for exact adoption. Connection saves return opaque references for pooled
`DATABASE_URL` and migration-safe `DIRECT_URL`; Supabase uses its provider-returned
session pooler for the latter. The normal Environment binding owner binds both.
Provider link intent is prepared by the existing mode-aware client Artifact
writer; server-visible target metadata receives references, not provider content
or connection strings. The Resource leaves are explicit-refresh snapshots, not
provider push observers or background polling. Account artifact publication,
composed runtime validation and the Plan 44 Workflow caller remain separate
integration obligations; real scoped provider tenants are named release checks.

`packages/deployment-protocol/src/v1` owns private Environment, target and receipt
content; Protocol owns the shared transport and serialized binding leaves.
Binding purposes keep registry, backup, Domain and data-role credentials separate
from application variables. Nonsecret variable sources include deployment facts;
the Machine-grant decoder consumes that same source schema rather than a copied
subset. Purpose materialization and fact resolution still require their owning
runtime producers; schema acceptance alone does not make them executable.

Stored-definition sub-revisions are resolved by the deployment-protocol
Environment owner for host preparation, promotion, template instantiation and
server admission. A bindings-only edit retains the definition revision. A
changed definition document or its ordered service/profile selection advances
it; replacing a repository definition is not a stored-definition edit. Hosts
apply the same rule before sealing encrypted content; ciphertext is not a
server-readable definition.

Stored-template preparation lives in
`packages/deployments/src/templates/prepareDeploymentTemplateInstantiationV1.ts`.
It consumes the registry's pinned strict descriptor and P41-parsed Compose,
preserves existing services, and plans the selected data-service dependencies,
public defaults, opaque Saved Secret bindings and declared generation profiles.
Create inputs identify selected template Domains with
`domainBindings: [{ templateDomainId, hostname }]`. Preparation admits those
ids against the pinned template; in 0.3 development, an undeclared id returns
`template_domain_unknown`, including a selection mixing declared and unknown ids.
The signed intent projection and installer share `readDeploymentTemplateDeployIntentV1`
to decide whether selected Domains imply a first deploy for a new Environment.
Preparation admits the selected
hostnames as lowercase DNS labels (letters, digits and interior hyphens,
separated by dots; IDNs use punycode). Other forms
return `template_needs_review`. Presenters forward the choice and display this
typed refusal; consumers trust the admitted hostname.
In 0.3 development source, the selected Domain's HTTP health declaration is
optional and is retained unchanged when present. Its absence permits ordinary
reviewed deployment and Domain creation, with health **Not checked**; native
routing omits active HTTP checks and health authentication exemptions. Malformed
supplied declarations still fail schema admission.
Connection outputs remain Compose interpolation expressions; preparation never
creates a secret, resolves a credential URL, writes content or deploys a service.
Replacing an existing variable binding, including with a generated credential,
and conflicting application connection keys require explicit per-key Replace
choices before any secret creation.

The private Environment content's optional strict `template` leaf records the
exact registry pin, applied stored-definition revision/digest and selected
service/health/data/export/login hints. Compose stays in `definition`, credentials stay
in `bindings`, and no template catalog or secret-reference map is copied into
this metadata. P45 owns template semantics at the existing Environment CAS owner;
the ordinary stored-content writer remains the sole Compose writer. Metadata,
binding and stored-definition changes retain their separate owning admissions.
Canonical initial creation may include prepared template provenance. For later
updates, the ordinary writer preserves `template`, the binding writer changes
only `bindings`, and the narrow template writer changes only `template`. The
template writer shares the existing Environment lock, revision CAS and
publication; its stored-definition revision/digest must match `definition`.
For encrypted content the authorized host must enforce the same leaf ownership
before sealing; the server does not reinterpret ciphertext as plain content.
The development `deployments.templates.instantiate` Action routes its original
request to the persisted Environment controller, or the reviewed controller for
a new Environment. Its runtime target may be another installed Machine. Preview reads the exact ready
registry pin and any existing stored definition without generating secrets or writing
Artifacts. Apply uses normal agent Ask policy, P42 generation and binding custody, the
ordinary Compose writer and the metadata-only CAS route. A later failure returns
an Action failure whose details retain acknowledged secret refs and Environment
revisions; an unknown secret candidate is distinct from an acknowledged save and
must not be blindly regenerated. The existing Action operation owner rejoins
the same creation intent across transport retries, retaining its terminal partial
result rather than repeating generation. Preview does not reserve an operation.
The registry owns one enabled app-source admission for each selected read;
template generation does not repeat contributor admission for each secret.
Each new content write checks current Project Manage permission and its captured
Account or Team owner through the Artifact writer's `beforeWrite` admission.
Admitted sharing uses local cancellation, and an unrelated Project Source
revision change does not interrupt installation. Environment and content CAS
remain with their existing writers.

In development, an optional closed `deploy: { requestKey }` intent makes catalog
installation one template Action leaf. Preview discloses that effect. After the
stored definition, bindings and template metadata commit, that controller calls
the normal own-server deployment preparation owner and deploy transport, which
admit the runtime target independently of executor placement. It retains the
original template approval and operation, with no second root or controller-child
handoff credential. It passes the exact
definition it just committed; there is no result-binding port or provenance
lookup between separate leaves. For a new Environment with selected template
Domains, including optional Domains with an address, this same owner adds the
reviewed deployment intent when the caller omits it, using the Environment
creation request key across preview and apply.
The Store consumes that review for both first install and retained retry;
explicit deployment intents stay unchanged. Other inputs without `deploy` only
instantiate.
For a new Project, preparation reads only the Source allocated to that admitted
creation request, using the existing allocation relation. It does not grant
reads of another Source. A rejected signed HTTP proof returns
`action_forbidden` with the closed authorization-refusal phase when Home supplies
one; it does not mean the person signed out. Template authorization failures
retain that cause alongside the acknowledged partial result.
An applied install carries the normal successful deployment receipt. A failed
preparation or transport, or an unfinished deployment, returns a deploy-phase
partial result retaining the actual Environment, target, definition, Saved
Secret refs and any accepted deployment/operation reference. Retry is a fresh
Machine setup plan/apply for unfinished apps, not a replay ledger or another
creation of completed apps. Explicit Deploy Require is folded into the parent
review through the existing host-reviewed-child policy owner.

The strict template review retains the selected descriptor's optional
`firstRunSetup: true` hint, including inside the Machine setup parent's app
reviews. It describes first-visitor administrator setup; it does not report that
the app is configured or create a credential. The consuming page presentation
and loaded-runtime journey remain separate integration work.

For new Environments, the host reads the requesting Account's exact private
Project-defaults Artifact and captured Account preferences, then uses the shared
defaults resolver. Preview includes the resolved values and their provenance;
existing Environments retain their configured values. Declared memory minimums
are compared with one snapshot from the existing Machine sampler, preserving
unknown observations. Disk capacity stays unknown until the workload filesystem
is identified; another filesystem's free space is not substituted. This finite
review starts no collector or polling loop. The Action owner retains the review
for a present-user prepared invocation or durable Ask request and repeats
preparation before dispatch. Changed capacity or Project-default revisions return
`approval_stale` before secret or content mutation; a newer sample with equal
capacity remains the same reviewed fact. The semantic host repeats the comparison
on entry to apply.

The composed native journey, proposed-template native risk preflight and
repository-PR destination remain integration work. The current native candidate
override is limited to promotion, and P42 review materialization requires a
persisted candidate Artifact; template preview stays read-only. This is not
released template or backup-runner availability.

An opened Environment requests a finite update observation for its exact template
through the existing registry owner, under the original Account's current
Environment and Source authority. Unrelated content edits may retain the same
template observation; a changed template, withdrawn authority or explicit refresh
invalidates it. Late older checks cannot replace a newer observation, and hiding
one consumer does not cancel another consumer's read. No background update loop
or deployed-content mutation is implied.

Explicit busy-deploy supersession uses the existing deploy transport's optional
`whenBusy: 'supersede'` and one protected `pendingDeploy` envelope. Receipt,
approval and pending provenance use the same serialized source schema. The
pending field stays outside Environment content and public headers; an exact
Environment read may return its protected envelope. Automation occurrences are
references to the Automation owner's current evidence, never caller-asserted
trigger authority. Storage admission owns replacement/take CAS and mode checks;
the controller owns settlement/reconnect re-admission, not a server queue or timer.
The current server stores the envelope in `DeploymentEnvironment.pendingDeployContent`
and returns `kind: 'pending'` with the Action operation id, without creating or
dispatching a second receipt. Replacement, exact replay and take use the existing
Environment transaction and Artifact mode/currentness checks. Settlement and
offline cancellation publish the existing Environment hint; a new receipt takes
the field atomically, runtime-link replacement clears it, and adding a data link
preserves it. Pending content mode follows the Environment Artifact's owning
Account, not an independently owned Team receipt Artifact. Re-admission refreshes
the outer row/link CAS while retaining the exact protected reviewed intent;
successful settlement may have advanced the same link's serving revision.
Preparing a new candidate Artifact from the retained intent does not replace
that intent or expire pending state with the repeat-key cache. Once a receipt
has been admitted, its own exact Artifact replay correspondence remains strict.
The pending consumer keeps the same accepted Action invocation and observes
relevant Environment changes through the existing push owner. A signed pending
admission also records server-authenticated requester, Home, operation, request
and controller-installation correspondence beside the protected envelope in
the same JSON field. Environment reads project that correspondence without
creating an operation or executing a deploy. After host loss, an explicit fresh
prepared Deploy from the same requester can restore the qualified operation
through the existing host runner. It must recheck the signed root, current
Source rights, controller installation, outer CAS and opened intent/candidate
before restoring the operation; correspondence itself grants no authority.
Historical unstamped envelopes remain readable but do not acquire requester
identity from their reader. Pending cleanup
requires a fresh signed cancellation context and an exact protected-content CAS;
an ordinary Account bearer alone cannot clear the field. When a host reload has
removed the in-memory operation, fresh signed cancellation sends the existing
operation Address to `POST /v1/deployments/pending/cancel`. Home locates the
retained admission by its captured Account, Home, controller installation and
operation Address, then delegates to the same pending writer. The original requester, Home and captured controller installation must
match; transferring the current controller does not transfer the pending
admission. The writer clears only the observed protected envelope and revision,
then publishes the existing Environment hint. Refused cleanup leaves the
accepted invocation active rather than aborting it first.
Authenticated trigger ordering, approval/operation supersession and
the full advancing native journey remain integration work. Compact preparation
opens the retained source pin before candidate authoring; a changed stored
definition still receives the native owner's ordinary stale-approval refusal.
An explicitly retained source method that the candidate producer cannot honor
refuses before publication rather than selecting another method. Compact retry
observation is under integration validation: after ordinary authorization and
approval, it rechecks the protected intent and original candidate, then joins
the exact active, nonterminal invocation before any new candidate authoring.
The runner retains its original input, child and token identity checks; observation
cannot recreate an operation or replay a terminal result. These boundaries do not
establish the complete cold-recovery journey. Unattended recovery of another requester's encrypted pending intent
is not enabled: a reader, Source owner or daemon custodian is not inferred to
be the original requester, and requester credentials are not persisted here.
Remote cancellation uses the existing signed Action root, original reviewed
envelope and canonical operation operand mapper; the receiver remains the
authority for binding that reviewed Address to the requested operation.

Native deployment operations retain the originating API token, Home and
Environment in the existing host-private invocation metadata, including while
approval is pending before a receipt exists. Environment-scoped token reads use
that exact origin on the operation's recorded Machine; neither a controller move
nor an absent receipt selects another host. Both operation-get versions guard
the retained record before a domain lookup or wait and recheck the admitted
credential's currentness before disclosure. Reusing a request key from another
token cannot join the original invocation. This metadata follows the existing
native-operation retention lifetime and is absent from public snapshots; missing
custody is not reconstructed from display attribution. Ordinary Account and
Machine-grant observations keep their existing authority. Home issuance of the
Environment-only operation-read root remains subject to the original operation's
custody, not the current controller's identity.

In 0.3 development, `happier actions get deployments.deploy --github-actions
--environment <id> --server-id <profile>` emits a copyable GitHub Actions steps
array. Generation checks the selected Home's current Account mode and repository
Environment through the existing Action readers. Stored definitions refuse with
`needs_repository`; encrypted or unverifiable Account mode requires the in-process
SDK (`client_required`) rather than emitting an unusable binary-only step.
The step uses the installed `happier` binary, the selected Home's canonical URL,
`secrets.HAPPIER_TOKEN`, the event SHA and the run id/attempt as its request key.
It does not embed a token value or select a deployment Machine.

The emitted `--wait --json` invocation observes the exact returned operation
address on its original host, carrying the submitted Environment explicitly.
It never infers an Environment from a token grant, retargets to a new controller,
or submits another deployment to learn an outcome. Confirmed success exits 0;
failure exits 1, an approval hold 3, an unavailable Machine 4 and an uncertain
outcome 5. Invalid invocations may exit 2. Acceptance or an unsettled operation
is not reported as success. These source-owner checks are not composed CI/runtime
certification.

In development source, person-authored token create/update can save Automatic
consent for one Environment through the existing exact-operation approval owner.
The choice is the optional `ApiTokenGrantV1.deployApproval: 'automatic'` flag,
valid only with the exact single-Environment deployment/operation-read grant.
Both direct grant authoring and the deployment choice use the same person-proof
producer; raw Account or terminal attribution alone does not supply consent.
Ask removes the flag, and ordinary token revocation withdraws the credential.
No private consent record, token Self consent read, or Environment-content basis
is retained. Later Environment edits, including becoming Production, do not
withdraw Automatic; explicitly stricter live Ask policy still wins. E2EE
content access uses a separate encryption-only wrapping facet inside the
protected invocation, not the bearer secret, and is disposed with the invocation;
the daemon does not borrow another Account's credentials. These checks do not by themselves
establish the complete emitted CI step or saved-trigger journey.

The development token-inventory reader for Move requests complete non-secret API-token summaries from the
existing Account token owner with `includeChildren: true`; ordinary lists keep
their root-only default. The present-user token update route can renew a root
or a child's own current authentication evidence without replacing its bearer
or widening its grant. Child renewal accepts no configuration edits, and parent
renewal does not copy consent to existing children. Update acknowledgements read
only the exact Account/token row. These development-source token operations do
not establish complete Move, saved-trigger consent or unattended CI execution.

### Repository-trigger deployment filters and saved consent (0.3 development)

The canonical Workflow starter catalog exposes `deploy-on-push` through
`workflow.starters.list` and `workflow.starters.resolve`. It is an unsaved,
deterministic Workflow containing one `deployments.deploy` Action and no Agent
or enabled trigger. The person binds `serverId`, `environmentId` and
`targetLinkId` when saving a repository trigger; the admitted occurrence supplies
`sha` and `requestKey`. The Action uses `whenBusy: supersede`, so the existing
pending-deployment owner handles newer commits. Resolving the starter grants
no consent and starts no work.

The development Workflow trigger owner accepts `deployment: {branch?, paths?}`
on `workflow.trigger.add`. The update Action changes that selected trigger's
private configuration through `patch.deployment`; `null` removes it. This
configuration is stored with the existing mode-aware Automation Workflow
context. Routing/filter configuration alone is not an Action approval.

The same add/update Actions use the generic `actionApproval: 'automatic' | 'ask'`
choice (`patch.actionApproval` on update). Automatic records that person's exact
trigger and materialized effects in the existing private `actionApprovals` context
through the shared standing-consent producer. A `deployment_sha` binding permits
only the commit SHA and invocation request key to vary; authored non-SHA operands
remain exact. Ask records no proof. The omitted-choice default is Automatic
for a verified person's non-production deployment and Ask for Production or
automation. That default is decided when saving, not when reading saved consent.
Agent/automation attribution alone supplies no person consent. Failed saves cannot
publish it; Ask, selected-trigger disable or changed operands withdraw the matching proof.
Pausing the outer Automation retains its per-trigger configuration and proof.
An Environment-content edit, including changing protection to Production, does
not withdraw saved Automatic. The stored reader normalizes the actually emitted
older deployment-only proof into the same generic operation without renewing
person consent or reading its former Environment basis; new saves write no basis.

The claim freezes only the selected unbound proof and the admitted event input;
it does not prepare a candidate or create deployment Artifacts. The ordinary
receiving Action executor prepares the native candidate after the Run is accepted.
Its existing approval reader compares the actual post-hook, pre-native semantic
input with the selected saved operation, then binds that proof to the exact
prepared candidate input through the generic reviewed-child issuer. Native
candidate/domain admission retains its ordinary Source and target checks; those
checks do not reconstruct a full-Environment consent basis.
Each fresh admission reads the selected saved consent. Its live continuation
retains the exact private proof through dispatch; it does not re-admit the same
work. A copied manual input, another trigger, revoked proof, changed dependency
or unavailable native proof retains ordinary approval policy at a new admission. Explicitly stricter live policy still wins. This writes
no scoped Actions preference and creates no second approval authority.

A source-composed journey resolves this starter, saves person consent and
runs two event SHAs through the production coordinator, native preparation and
receiving consent owner. Its authenticated Home/Artifact transports and Docker
process are test boundaries; it is not a loaded-UI or real-tenant certificate.
In current development source, the Home Workflow-origin issuer authenticates the installed
Run publisher and exact signed request, current Run custody, Environment/Source
authority and placement without requiring Home to decrypt standing consent.
That root proves execution origin, not approval: native preparation and the
receiving executor's ordinary live/shared exact-input approval still apply.
Ordinary Ask, encrypted snapshots and an unbound trigger template must not be
turned into consent by publisher identity. Current public-build, sender/receiver
and native cleanup checks are still required before claiming a complete
Home-issued journey; no new approval store or publisher waiver is introduced.

For an opted-in trigger, the controller reads the normalized GitHub push or
merged-PR occurrence. Its declared `sha` input receives `payload.after` for a
push or `payload.pullRequest.mergeCommitSha` for a merge. Its declared
`requestKey` receives the Automation owner's admitted occurrence key. The
Workflow's deployment Action must consume those values; private event content
cannot replace the admitted identity or choose an Environment or command.
Other Workflow triggers retain their generic input binding.

Push branch mismatches and deleted refs settle as skipped before an accepted
snapshot, Environment/Source reads or native candidate preparation. A short
branch name matches its exact `refs/heads/` ref; an explicit ref matches exactly.
For a relevant event, the controller re-reads the Environment's current
controller and ProjectSource repository identity. A branch-filtered merge uses
the admitted SCM PR read's actual base branch; the event's missing base branch
is never replaced with a default branch. These checks precede native candidate
preparation; ordinary current deployment authority and Action policy still apply
at dispatch.

The current normalized event supplies no forge deployment URL, so this join
supports GitHub.com repository Sources only. An enterprise-hosted Source is
refused rather than matched by repository name alone.

Push path and commit-marker decisions use the canonical SCM exact
`revisionRange: {kind:'revisionRange', baseOid, headOid}` readers. The same flat
range is a comparison source. The file inventory compares those two
immutable endpoints, so an intermediate add followed by a revert is absent from
the net diff. Renames test both paths. Ordered path globs support `!` exclusions;
the last matching rule decides each path. An exclusion-only list starts with
all paths included. A complete known range with no included changed path may
skip. `[skip ci]` or `[skip cd]` suppresses only when every commit in the complete
exact push range contains a marker; the merge message alone never supplies that
proof. Commit pages must echo the exact endpoints and attest complete history,
including the native total head-not-base count independent of page size. The
controller requires all of those commits before skipping. Native history also
reports equal, forward or diverged graph relation; only forward is a newer count.
Unavailable, partial, shallow or mismatched file/commit evidence deploys normally.
These finite reads create no Session, fetch, queue or polling loop.

These development-source owners are under integration validation. Owner tests
do not establish a completed loaded GitHub-to-native deployment journey or the
pending slot's authenticated ordering and settlement/reconnect consumer. Those
remain separate admission and runtime integration work at their existing owners.

Plugin runtime/data links retain their actual optional scalar installation
placement rather than fake own-server members. The own-server membership schema
remains nonempty and ordered. The scoped paged link-read transport exposes only
admitted Environment/link headers; normalized provider identity remains in private
link content. Linking preparation compares readable opened content, not server
plaintext hashes or a provider uniqueness index. The server's authenticated
`POST /v1/deployments/targets/list` performs that finite header-only scope read
under current Source and Artifact admission and reports incomplete coverage.
Both admitted clients' provider-link preparation consumes those pages in the current
Account/Team owner scope and opens matching contribution/kind link Artifacts through
the canonical mode-aware reader. Equal provider Account/resource/environment tuples
return `provider_scope_already_linked` with the existing Source/Environment/link
destination before creating private content or associating a new link. Requester
keys and credential principals do not define that tuple. Incomplete coverage or
unreadable content refuses preparation without disclosing an existing destination;
replacing that same link skips its own prior tuple. Its link writer stores host,
plugin runtime and data identities in the same relational owner. Prepared Artifact
references still use that storage writer directly. This client-side comparison is
not a database uniqueness guarantee between concurrent preparations and does not
establish platform runtime readiness.

Environment-created Automations carry an optional qualified
`executionRecipe.deploymentEnvironment` reference in the existing V3 authoring
transport. Its Home, Source and Environment identity is admitted before the
nullable `Automation.deploymentEnvironmentId` relationship is stored; subsequent
edits cannot change or remove that relationship. Public definition, trigger,
assignment and manual-run mutations retain Account custody and also require
current Source management. Session-scoped deletion cleanup remains the Session
lifecycle owner's separate internal path.

Development-source preview definitions use this same saved relationship. An
optional non-content `previewRole` distinguishes `preview_admission` from
`preview_cleanup`; current Source management admits the role only on a live
standard template, and later definition edits cannot change the role. Workflow
content remains private. The Source-replacement retirement helper disables only
admission definitions and admits ordinary cleanup Workflow Runs within the
caller's transaction; a cleanup refusal rolls back that transaction. Actual
teardown remains normal Workflow and deployment Action execution, not a
server-side preview executor.

The Source writer invokes this helper only after a successful repository-change
revision CAS, before publication. Renaming, changing the default ref/subdirectory,
an identical repository write and a stale CAS do not retire previews. Expected
cleanup refusal is mapped to HTTP 409 `source_conflict` only after rollback;
the caller can restore the saved cleanup Workflow and retry the unchanged Source.

`deployments.environments.controller.set` changes admitted controller placement
and the Environment revision through the same transaction, then moves linked
Automations' future definition assignments through the existing assignment owner.
An independent Machine assignment cannot move them away from that controller.
Publication uses each Automation's actual creator Account; accepted Run assignment
snapshots remain unchanged. This changes no dispatched receipt and executes no
native effect.

Permanent controller revocation pauses the affected linked definitions while
retaining their explicit derived placement for later controller repair. Choosing
another controller moves that placement but preserves the paused state; it does
not resume execution or grant another Account access to the sealed recipe.
Ordinary Automation assignment removal retains its existing behavior. Frozen Run
settlement requires a nonempty complete assignment snapshot whose every Machine
is positively revoked; missing, live, offline or replaced Machines do not supply
that proof, and frozen assignments are never rewritten.

Cross-Account sealed-recipe execution and Machine activity retention still require
their existing custody/activity producers and composed validation.

New installation-signed receipt reservations capture `acceptedExecution` in
noncontent receipt metadata: the controller and optional builder Machine and
installation identities, plus the Environment revision read after the successful
reservation CAS. One server constructor projects the five nullable relational
facts; retries retain the original capture. It contains no grant, ciphertext or
private receipt-content copy. Historical unsigned storage records remain readable
without a capture and cannot authorize native children or settlement.

Native continuation must consume that receipt identity rather than today's
controller or builder pointer, while retaining current Source, installation,
Machine grant, resource, cancellation and receipt-state admission. Preparation
and review still use current placement. The capture producer is development
source under integration validation; Workflow-root currentness and native
builder consumers still need their corresponding migration, so capture alone
does not establish an in-flight continuity guarantee.

The existing ProjectSource is the Project identity, including when it has no
repository. Its public owner is one Account or Team, never an audience member
chosen by position. Legacy producer compatibility permits an omitted owner at
the schema boundary; the Source service must derive that legacy owner from the
creator Account and admit explicit ownership changes. Repository-only selection
returns a typed absence instead of inventing a repository selector.

Shared creation defaults are a separate mode-aware leaf keyed by that Source id,
not Source content or a viewer's Project organization row. The pure
`resolveDeploymentCreationDefaultsV1` resolves explicit values, shared Project
values, eligible owner-Account preferences, then built-ins; Team-owned Projects
skip Account preferences. Its current public core covers build/controller
placement and release retention. Creation/first-configuration writers must
consume the reviewed result once; defaults do not rewrite configured Environments.
Producer-owned preview, backup and alert leaves and composed runtime validation
remain integration work. These are development contracts, not released settings
or a completed deployment journey.

`projects.deploymentDefaults.set` uses the existing Home Action carrier and
Source-keyed defaults transaction. GET/PUT
`/v1/projects/:id/deployment-defaults` return the canonical Artifact reference
and revision; clear retains the revision for subsequent CAS. Reads require
current Source access, writes require management, and Artifact mode/recipient
admission remains at the Artifact owner. Equal writes publish nothing and never
rewrite configured Environments.

The development `deployments.environments.list` read accepts Account-wide All,
an optional Source, and an exact `machineId`. The same owner admits the Home and
selected Machine, filters relational controller/build/edge/retained references
before paging, then applies current Source admission. The selected runtime-link
header supplies actual runtime membership; a controller or retained reference
alone does not establish that an app runs on that Machine. Environment headers
retain their Source/Home identities and labels use the canonical Artifact header.
Environment pages start with the newest generated IDs and continue toward older
IDs, so creating an Environment makes it visible on the first finite inventory
page without draining older pages.
Unreadable Environment/Source identities stay out of rows and cursors;
`coverage: 'partial'` records hidden matches. An empty partial page can continue
through an opaque position bound to the reader, Home and selectors. Existing
admitted-row ID cursors remain valid. This is a finite header read, not a private
Artifact-body census or an all-Project discovery loop.

`useDeploymentInventory` shares the Account-lifetime controller and push owner
with selected-Project reads. Collection and receipt-history hooks expose explicit
next/previous-page navigation through the existing cursor-keyed leases; no
consumer automatically drains continuations. Only the Environment's
`runtimeTargetLinkId` selects the runtime; missing or tombstoned links never fall
back to the first retained link. Retained custody headers do not demand private
TargetLink bodies when the selected page opens its Environment content.

The deployment catalog exposes two entry paths. A Store/catalog install uses
`deployments.publish.prepare` followed by `deployments.templates.instantiate`.
Deploying your own project uses `deployments.environments.create` with a
repository, stored or catalogApp definition, followed by `deployments.deploy`.
The unconsumed combined `deployments.publish` Action and its Workflow composer
are removed; each retained Action uses its existing review and execution owner.
Managed Machine enrollment supplies Docker/Compose prerequisites. Environment
creation and target linking retain their existing managed-retention offers.

Historical accepted Workflow snapshots retain their original parent and exact
child consent as opaque data. Run reads, cancellation and recovery use the
existing Run owner; removing the parent from the live Action catalog does not
register or execute it again. Combined Setup still uses the existing generic
Workflow storage and requester authority.

Prepare carries an exact Source revision, credential-free repository identity,
immutable base commit and path-free workspace key. Its `deploymentPrepare`
executor callback receives authenticated Home/Account context and runs on the
admitted workspace daemon. Optional Environment scope must belong to that
Source; a Project without an Environment remains valid. Handoff returns an exact
Session/child-operation reference or typed partial/conflict/refusal, never a
claim that source preparation or merge completed. P60 owns the Session/SCM/Forge
producer. The current CLI handoff resolves the workspace key through the existing
Account workspace owner, rechecks Source/repository/base commit and optional
Environment/link revisions, then requests an ordinary new Session with a
value-free preparation brief. An optional exact `sessionRef` instead sends that
brief through ordinary `session.message.send` admission in the same Home;
Prepare does not spawn a replacement when that admission is held or its outcome
is unknown. Optional `importFrom` contains only a tool name and configuration
paths for that Session to inspect, never inline configuration or secret values.
These references do not grant permission to read or change external resources.
Receiver workspace and Source reads use the
factory's existing signed-root-aware admission ports, not a retained Bearer-token
shortcut. Later SCM, Forge and deployment effects keep their
own admission. If the ordinary Session Action requires approval, Prepare forwards
that existing approval deferral with its original Artifact and child Action id;
it neither treats pending review as a failed Session nor invents an operation ref.
Session-origin or Workflow-origin handoff currently refuses when
the canonical source signer cannot provide the child Session's authority; it
does not borrow ambient daemon credentials. Both Actions retain default agent Ask and explicit-person direct
confirmation; no later child-action waiver is implied. Registration and these
installation seams are not a complete Publish or Prepare journey.

`deployments.health.read`, `deployments.drift.read` and `deployments.logs.read`
are safe read Actions with configurable default no-approval policy and admitted
Environment scope. Their exact receipt/link/Machine/installation selectors route
to the selected native Machine, not a server-storage endpoint or first-Machine
fallback. Health/drift/runtime logs carry the canonical stable service identity;
build logs select the build Machine without inventing a runtime service. Health
and drift expose explicit unknown/stale evidence, not fresh probes or repairs.
Build/runtime log front doors reuse the native source-bound cursor/result and
the host-owned byte budget; unavailable redaction remains explicit. The existing
encrypted Action envelope and signed Home binding carry only the exact read's
noncontent record and installation references, drift revision or log kind.
The receiving daemon compares that projection with the opened input; private
service names remain sealed. Each signed preparation read rechecks current
Source authority and the exact Environment, receipt, link and Artifact reference.
Health/drift require the current active own-server member; retained log reads do
not substitute today's builder for the receipt's captured native occurrence.
P41 owns
the actual native projections, currentness and redacted log producers. These
registrations and read-transport seams do not establish those producers' runtime
availability.

Environment-scoped Action confirmation uses one admitted metadata loader across
CLI, daemon and UI. Policy is re-read at dispatch and approval replay rather
than copied into an Environment. The policy owner can inherit a preview child's
per-Action preference from its admitted template while keeping effects scoped to
the child. The shared scope resolver consumes the server-admitted
`previewTemplateEnvironmentId`; it does not repeat repository admission or copy
a waiver into the child. The neutral PR lifecycle/current-head producer remains
separate from this policy-scope resolution.

The optional own-server migration configuration is retained in the immutable
review basis and data-only native review. The native migration consumer uses
P41 commands and P45 verified pre-migration backup. The host opens the configured
destination through its installed read-only Action and resolves the literal database
through P42. It retains the verified backup capture and advances the receipt CAS
before recording or running the migration. Missing backup operands or a serving
generation return `backup_required` before the migration command. Explicit backup
opt-out and a pending check reporting no work do not acquire backup operands. Public restore uses
the native restore owner; an unavailable capture or restore is an explicit
failure and never permission for code-only recovery.

Development-source backup metadata has one Protocol codec for source selection,
retention and normalized native manifests; deployment-protocol consumes that codec
for the Environment backup leaf. The manifest binds repository, snapshot/tree, source and configuration
revision; it is not a separate backup store. The semantic run owner consumes
native process results and verifies the exact snapshot, tree and payload
checksum before returning verified manifests, retaining known snapshot identities
on failure. Public `deployments.backups.inventory`, `deployments.backups.run`,
`deployments.backups.verify` and `deployments.backups.prune` consume the same
configured destination opener and native runner. Their shared input builder names
the exact Environment, serving deployment, target installation and configuration
revision for UI and agent callers. Inventory asks restic for that Environment's
owned snapshots and reads matching retained operation evidence at an exact target
lookup; it never scans an Account's backup inventory. Missing retained capture
evidence is reported as unknown verification, and missing native size remains unknown.
Inventory admission follows Environment read access, including read-only Team viewers;
it returns backup metadata without contents or credentials. The daemon compares
the opened backup input's canonical digest and target projection with the signed
admission before invoking the native owner.
Run uses the existing PostgreSQL producer-success-gated stream. Verify reads the
exact snapshot, tree and payload checksum, optionally running repository integrity
checks; it never calls restore preparation, creates a safety backup, or stops writers.
Prune requires a matching successful verification from the existing operation owner
and the person's unchanged configured policy. Restic owns the configured keep
groups; Keep everything deletes nothing. Unsettled recovery captures and unresolved
restore preparations remain protected; an exact verified successful restore releases
its preparation's protection. Standalone preparation records are requester-scoped,
so another authorized member's prune can remove their source; confirmation then
fails visibly and the person prepares again. Deployment recovery references remain
protected through their existing Environment receipt owner. No schedule, retention default or backup
ledger is added. If capture or verification evidence expires with ordinary operation
retention, a new run and verification are required before destructive maintenance.
Development-source backup setup uses `deployments.environments.update` with
`patch.backup`, carrying the existing `DeploymentBackupConfigurationV1` shape.
The host resolves the selected installed destination and calls
`prepareDeploymentBackupConfigurationV1` to validate its nonsecret configuration,
source selection, ownership and credential-role identities and capture the current
occurrence. Credential values and references remain on `deployments.bindings.set`
with purpose `backupDestination`. Setup can be saved before those bindings exist;
that does not establish runtime readiness. The full reviewed input binds the
private configuration, while Home receives only the prepared Artifact reference
and public metadata for the existing Environment revision CAS.
Development-source retention editing uses `deployments.environments.update` with
`patch.backupRetention`, the selected `configRevision` and the person's retention
counts. The existing private-content preparation and Environment revision CAS own
the save. This changes only retention: destination, sources, bindings, ownership
and capture `configRevision` stay unchanged, so existing snapshot verification
remains valid. A missing configuration returns `backup_required`; a changed capture
choice returns `stale_input` before publication.
Environment copies do not inherit
the source's backup configuration or ownership. The private destination
materializer keeps the password file on the host but declares the read-only
Linux container target `/run/happier/backup/repository-password`, independent of
host path syntax. The native restore adapter consumes the same integrity read-back
owner while retaining its separate effectful restore lifecycle.

Restore preparation and settlement retain optional typed `steps` facts for safety
backup, stopping writers, restoring, starting writers and health. The semantic
restore owner emits each running/completed/failed/skipped fact at the native
effect; the existing Action operation pushes its `restore.<step>.<status>` phase.
`readDeploymentRestoreStepProgressV1` decodes that phase for presenters. Preparation
failures retain safe step facts in the existing failure details; partial and final
results retain the same facts alongside recovery evidence. Older retained receipts
may omit steps. This unreleased 0.3 change needs matching Protocol, daemon and UI
readers to reload together; no polling, second progress store or native call is added.

The same `deployments.backups.restore` prepare/confirm Action restores a selected
scheduled snapshot with `backupOperationId` plus the exact `restoreBackupId`
snapshot ID from inventory or history. The host selects that scoped successful
run receipt; callers never provide a manifest or native capture. Omitting
`backupOperationId` retains pre-migration receipt selection. Confirm must repeat
the preparation's exact operands. Retained run selection spans deployment
generations within the same Account, Home, Machine installation, Environment
and target link. Callers keep the active `deploymentId`; the receipt retains its
original generation, and restore targets the active native deployment.

New backup runs retain optional `restoreCaptures` with their original PostgreSQL
database, source, configuration and repository, without credential values. Older
manifest-only runs remain readable. Their recovery deliberately targets the
current configured native PostgreSQL database and keeps the original manifest's
revision distinct from the current destination configuration. The canonical
producer's exact service `.dump` path identifies its custom-archive format.
Prepare verifies the repository ID, snapshot, tree and payload against that
manifest before safety backup or restoration. An unavailable receipt reports
`backup_required`; a different repository reports `backup_integrity_failed`.
Select the original repository configuration and retry when its credentials and
native source are available; the host never substitutes a different snapshot.

The installed daemon retains authored backup run, verification, prune and Restore
receipts in the operation owner's existing encrypted device-local receipt store,
partitioned by Home profile, installed custodian Account and Machine. Original
requester scope, input, manifests and `restoreCaptures` survive restart; the
target index is rebuilt from those authored records, never from current settings
or imported history. Successful recovery evidence is exempt from ordinary
operation-history age/count expiry. Read-only inventory/history/probe results are
refreshable and retain ordinary history policy. Admission and terminal recovery
facts are written durably; log/progress revisions do not write receipt files.
A lost active operation becomes typed `action_outcome_unknown`, without replay.
Unreadable receipt storage refuses new recovery work before effects and reports
operation reads unavailable rather than claiming that no captures exist. This
development-source fix cannot reconstruct captures already lost before retention
was installed; it does not replace missing evidence with a surviving snapshot.
The existing local envelope and encryption purpose remain unchanged. A development
daemon with the older Open-only reader refuses this expanded history as unavailable;
load the current daemon to read it, without deleting or resetting receipt files.

The development-source `projects.readiness.read` Action composes selected Project
and Environment facts on demand, without a stored score or background polling.
Its controller reads the exact Environment membership and revision, then delegates
selected native health reads through the existing target-daemon Action. Backup health
comes only from the backup owner's exact scoped operation records: the last successful
backup and last verification result, with their recorded completion times. Failed
verification retains only its safe code and step on the existing operation result.
Reading readiness or the daily digest never opens restic or acquires repository secrets.
No recorded backup reports `no_verified_backup_yet`; scheduled verification owns freshness.
The existing receipt query is daemon-local: a controller reports backup health as
`unavailable` for another target daemon until that owner exposes reachable recorded
facts. It never interprets inaccessible remote history as an empty backup history.
The result identifies each fact's owner and reports `ready`, `actionNeeded` or
`unavailable`. CI Source/check selection, health observer coverage, alert wiring,
required secret grants and security Source status require their owning projections;
missing projections remain explicitly unavailable. An older configuration's verified
backup does not establish current configured-source readiness. The backup owner
requires recorded verification for every currently configured source, without a
consumer-defined age threshold. Readiness does not mint another public admission or
acquire a separate credential. Backup starters use
the same public Actions and input builder. The daily digest reads selected Automations
through `workflow.trigger.list` and `workflow.run.summaries`, preserving native
next-due and actual started-run facts without a local scheduler.
Backup maintenance reads the current Environment at execution. A saved Nightly
target's `expectedRevision` is accepted but ignored; later Environment edits do
not require rewriting existing triggers. Native runtime preparation uses that
current snapshot's revision. Environment-changing Actions, including restore,
keep their revision checks. Capture configuration, active generation and retention
selection checks remain with their existing backup owners.
Failed backup runs remain in the existing operation history, projected by
`projectDeploymentBackupHistory` through `deployments.backups.history` with their
terminal state, safe error code and step. Backups failure notices consume those
facts; an enabled schedule alone does not establish that its last backup succeeded.
The development-source `workflow.trigger.list` Action also accepts a
`deploymentBackup` target, derived from the public backup-run input without the
Environment revision. Its existing owner resolves saved and inline Workflows,
including nested definitions and targets from saved or literal loop items, and matches actual bound backup-run Actions rather
than arbitrary input names. Returned sets include `missedSchedules` when enabled
saved schedule cursors are overdue and no actual Run has started at or after that
cursor. Disabled schedules and Automations are excluded. An unavailable private
source returns `source_unavailable`. This is an on-demand projection of existing
facts, with no grace period, timer, polling or new persistence.

The same package now exports `prepareDeploymentRestoreV1` and
`confirmDeploymentRestoreV1` as development-source semantic producers for an
admitted PostgreSQL custom-archive recovery. Prepare binds the exact repository
manifest and destination and takes a verified safety backup for meaningful
existing data. Confirm restores into an operation-owned database, checks
integrity before activation, preserves the incumbent under its recovery name,
and requires activated integrity and service health before `restored` with
`verified: true`. A rollback is not successful restoration. The approved native
integration requires one P30-protected stage for the swap through verification
or proven undo and writer restart. Ordinary Stop is pending until that stage
settles; it does not start recovery commands under an already-aborted context.
A crash or force-stop is repaired at the next restore admission by observing
the exact operation-owned database names and undoing only a proven swap.
K-P42's retained loan remains owned until the stage ends. The prepare evidence
belongs in the existing Action receipt, not a prepared-token store.
The development-source P41 `executeOwnServerNativeRestore` adapter composes these
producers with P30's real restic/stream custody, exact-generation writer stop/start
and health observation. One P42 backup preparation spans both prepare and confirm;
the adapter passes the admitted job's forwarded signal and disposes it in `finally`
after native settlement. Standalone prepare and confirm calls own independent P42
preparations; confirmation receives fresh material rather than a disposed port.
The development-source public `deployments.backups.restore` Action exposes these
standalone phases as `mode: 'prepare'` and `mode: 'confirm'`. Both are effectful
Environment-scoped writes with their own default Ask policy; a person confirms
the irreversible operation, and scoped agent policy can explicitly allow it.
Preparation selects the capture receipt's exact `restoreBackupId`, observes the
current serving database, and takes the required safety backup before returning
nonsecret evidence in its existing Action operation. Confirmation names that
`prepareOperationId`; the installed host reads the succeeded preparation under
the same requester and Machine, checks that its operands match, and gives the
native lifecycle fresh P42 material. The existing operation runner rejoins repeat
confirmations for that preparation instead of swapping the database again.
If the daemon no longer retains the preparation, the caller must prepare again.
If a confirmation changes the prepared operands, start a new preparation rather
than reusing the rejected operation.
Standalone restore shares the rollback path's serving-generation runtime and
restore producers, and leaves deployment receipts and the active code pointer
unchanged. Its signed native admission admits the Source/deployer once and scopes
capture/current-generation reads and installed-secret acquisition to that job.
PostgreSQL integrity uses the engine's `pg_amcheck` default corruption checks
with `--install-missing`, not a connectivity query; its supported object scope
is documented by [PostgreSQL](https://www.postgresql.org/docs/15/app-pgamcheck.html).
Pre-migration completion retains `ownServer.preMigrationBackup` in the existing
receipt Artifact through its existing compare-and-swap writer. The closed capture
contains the owned manifest, actual PostgreSQL database and custom-archive format,
backup configuration and repository locator, without credential material or file
paths. `restoreBackupId` is that manifest's `source.snapshot.snapshotId`.
`resolveDeploymentRestoreCaptureV1({environmentId,restoreBackupId,receipt,destination})`
selects the exact capture once at restore admission from an already-authorized,
opened receipt. Unknown or foreign snapshots return `backup_required`, mismatched
Environment/target facts return `stale_input`, and other target kinds return
`unsupported_action`. The admitted destination supplies current writer/data facts
and operation-owned restore names. The host binds the retained configuration to
P42's current credential acquisition; prepare and confirm retain the selected
repository rather than reading a newly configured destination. No history store
or per-step admission lookup is added. Scheduled backups have no completion writer
yet and are outside this reader's scope.
Only `restored` with `verified: true` may advance code recovery. In development
source, the public rollback Action now carries its ID-only `restoreBackupId`
through Home admission to the own-server executor. The first runtime member
reads the current receipt preceding this recovery through the existing ordered
receipt reader; it never searches older receipts for a usable backup. Native
admission observes the exact running generation's destination database and
writers, then `prepareOwnServerNativeRestore` resolves the ID once before its
factory acquires backup credentials. Prepare and confirm use that same capture.
Any existing database receives the parent's safety backup, including schema-only
data. The native image owner acquires the pinned restic runtime through its
existing image identity and private public-registry preparation.
The existing recovery receipt records the database-restore step before code
activation. A missing capture, unknown/foreign ID, failed or uncertain restore
never enters code-only compensation. Other members consume the first member's
successful restore step. The failed receipt's recovery control consumes its
captured migration policy: restore-and-rollback includes the retained snapshot,
Ask offers restore-and-rollback, explicit code-only rollback, or Cancel, and a
missing required snapshot never falls back to code-only. Database recovery stays
available when the incumbent code is already active. The delta is ready for the next security batch; review
does not gate development or QA. DEP-21 still needs its loaded public recovery
journey. Other engines, uploaded dumps and volume restoration remain incomplete.

The private `/v1/deployments/environments/:environmentId/backup` writer reuses
Source manage admission and the existing Environment/Artifact compare-and-swap.
For plain content it changes only the backup leaf; binding and template writes
preserve that leaf, and initial creation does not accept it. Ordinary Environment
updates preserve it except for the explicitly reviewed retention-only patch above. E2EE content
remains opaque to the server: the admitted client owns its content semantics,
while the server enforces the existing mode, envelope, authority and exact
Artifact-reference revision contract. There is no second credential or backup
status record at this storage boundary.

The Project deployment read controller opens Environment collection content and
visible history receipt content through the existing Account Artifact reader.
Compact Environment rows expose optional `backupConfigured`, derived from that
Environment's saved `content.backup`: a configuration is true; absence or
`{notNeeded:true}` is false. It does not require a backup run. Unreadable content
retains a readable header row with partial coverage and omits the fact; older
producers also omit it, so omission is unknown rather than false. The Store
consumes this fact through the shared Environment inventory, without settings,
a backup-history aggregate, or a per-Environment request.
The Environment list includes each row's latest receipt attempt
(id and state), which is distinct from the serving receipt selected by the
runtime link's `activeDeploymentId`. The visible Environment page and its current
receipt summaries share one deduplicated Artifact content batch per list. Only
the current receipt's header is projected; retained receipts and TargetLinks are
not fetched by the list. Environment and receipt reads enforce exact Artifact identity, version
and kind checks through their canonical content projections.

Current 0.3 development source also admits an Account-wide collection when
neither ProjectSource nor Machine is selected. `useDeploymentInventory` shares
the Project read controller's Account lifetime, push invalidation and cursor
leases; it does not enumerate Projects. Each page retains the server's partial
coverage and continuation and carries the selected runtime link's membership
alongside its Environment/Project/Home identity. A Machine filter retains the
native role-reference selection: controller, builder and retained references
alone must not be presented as current runtime membership.

An unreadable final candidate advances through a server-encrypted cursor bound
to the Account, Home and filters, without disclosing its identity. Previously
issued admitted-row cursors remain readable. Opening a page never drains its
continuation automatically.

Selected details expose `runtimeTargetLink` from the shared controller. Only
`Environment.runtimeTargetLinkId` selects that live, attached link; a missing or
tombstoned selection yields no serving link. Retained predecessor headers remain
available for custody and version evidence and cannot become a serving fallback.

The rail's current-receipt steps come from the same private Artifact-header
batch. The receipt writer projects `DeploymentContentV1.steps` into that header
when creating or atomically updating the receipt. This remains Account-mode
private content; no steps or labels are added to server-visible metadata.
Older headers without that projection return `steps: null` (unknown), while an
explicit empty array means the prepared receipt has no recorded steps yet.

The UI data callbacks can prepare new Environment content and a rollback
candidate through the ordinary Artifact Actions. Rollback preserves the
selected receipt's immutable source/images, clears its old review and outcomes,
and re-reads current Environment/link revisions before ordinary native review.
Its shorthand also retains an explicitly selected `restoreBackupId` on that
same rollback Action; omitting it keeps the code-only path. Supplying it selects
the current receipt's recorded pre-migration backup; scheduled backups and
arbitrary snapshot IDs are unavailable on this path.
The Deploy callback accepts Environment and target-link ids through the same
Action. The installed preparation hook resolves the selected repository ref and
native image provenance, creates a fresh candidate Artifact, then performs the
ordinary review and approval. Prepared callers retain their existing input;
storage still requires the complete prepared references and revisions. An
approved replay cannot turn ids-only intent into a newly reviewed candidate.
The current own-server producer requires one installed build/runtime Machine
and existing local immutable images; build-bearing definitions remain
unsupported until their native builder lands. This source wiring remains under
integration validation and does not establish a complete page or loaded-runtime
deployment flow.

The development native Caddy producers are separate from Domain persistence and
teardown settlement. `cli-common/machineSetup/nativeCaddy` projects root-owned
durable directories and the existing firewall owner's exact private/public
exposures, then ensures the pinned persistent container against the explicitly
admitted Docker endpoint. The caller applies the setup/firewall plans once through
the existing interpreter before consuming that result. Route observation and
removal do not start or recreate the shared container.

These are development producers, not a complete installed Domain flow: the
authored Caddy setup/profile/private-binding caller is still missing. Tunnel
private-origin activation is not proof of public Cloudflare routing; consumed
usable-zone selection and connector activation remain required. Neither native route
configuration nor a storage admission acknowledges DNS/TLS/HTTP health.

The same native owner assembles public/private bindings from the admitted Caddy
recipe exposures and the selected private-network observation. Its listener
observation reads the owned Docker container and the live Caddy Unix admin
configuration, including actual published endpoints and attached networks. A
private-origin role requires the exact admitted private binding; plaintext or
disabled automatic HTTPS alone is not evidence of that role. Observation and
route effects share one Unix admin transport, not another probe or route store.

`machines/reachability/nativeCaddyRoutes` consumes already-admitted placement
facts and the installation key. Its Unix-socket transport activates, observes and
removes exact native IDs using Caddy's ETag preconditions; it does not replace the
whole configuration, modify DNS or issue credentials.
The sole byte owner is `deployments/targets/ownServer/caddyRouteMaterialization`.
That owner also materializes public TLS, exact-host redirects and certificate
policy. Native effects apply its exact tagged resources through the same admin
transport. Custom PEM and Basic Auth material remain finite host-private inputs,
not Domain metadata; managed certificates use Caddy's native automation policy.
`target.redirectTo` accepts a canonical Domain (HTTPS by default) or an explicit
HTTP/HTTPS URL with an optional path prefix. Destination userinfo, query and
fragment are refused by this codec; the incoming path and query are preserved.
Public edge routes use admitted private-origin endpoints; private replica routes
use static container names and the Environment's admitted source ranges. Only
the private listener's exact GET health request has the Basic Auth exemption.

Tunnel/member origins keep automatic HTTPS disabled and produce no certificates
or HTTP-to-HTTPS redirects. Stock Caddy 2.10.2 fixture evidence covers custom
wildcard TLS, auth, redirects, private forwarding, restart and exact removal.
Actual public DNS/ACME issuance and renewal delivery remain release checks
requiring the external infrastructure; Happier adds no renewal scheduler.

A lost native acknowledgement is unsigned `unknown`, not success. The next
admission observes the same exact IDs rather than blindly replaying effects.
Only observed absence yields an installation-signed removal binding the Home,
Account, Environment, target link, Domain, Machine, installation, operation,
request, native server and route IDs. The teardown consumer verifies that proof
against its captured placement, expected route/listener and authenticated
installation key. The verifier derives IDs through the sole route codec rather
than asking the consumer to rebuild them. It then uses its
existing settlement writer. Public removal proves absence of all six owned
route, redirect, policy and certificate IDs; private removal proves its two
owned route IDs. Exported native producers alone do not certify the composed
Domain writer, secret delivery or complete teardown flow.

Removal reconstructs dynamic routing fields from the exact installed IDs, then
compares the codec's complete shape against captured Domain intent. It can
finish after workloads or secret grants disappear; changed hostname, path,
health or auth identities still conflict, and foreign/shared resources survive.

Start-first consumes the same owner's validated nonsecret local replica legs;
public edge/private-origin forwarding legs remain unchanged. The native switch
compares the installed incumbent replica set, then patches only the exact proxy
ID under its server ETag with every candidate replica and `n - 1` retries. Native
auth hashes and custom TLS material are neither reacquired nor rewritten. Equal
candidate material performs no write; a lost reply remains unknown, and P30 does
not retire the incumbent until every affected leg is active.

For start-first deployment, acknowledged route activation is the handoff to
Plan 30's existing exact-generation Docker stop/retirement owner. Docker uses
the incumbent's configured `stop_grace_period`/`StopTimeout`: it sends SIGTERM,
allows the application to finish in-flight requests, then kills at the deadline.
Happier does not observe retired-upstream request counts or add a separate drain
timer, retained upstream, shadow route, custom Caddy module or wake. A request
longer than the grace period may be cut; this is visible and the grace period is
configurable. Cancellation and an uncertain stop retain the existing native
lifecycle semantics rather than becoming a successful retirement.

The single `createNativeCaddyStartFirstRoutes({routes, legs})` adapter implements
Plan 30's native `switch({candidate, incumbent, signal})` port. Its admitted legs
come from the observed listener/placement/binding owner, while the native Compose
generation supplies each service's complete incumbent and candidate replica
names. `readDomainCaddyStartFirstLegs` at the existing Domain placement owner
enumerates the canonical inventory and opens exact captured content; callers do
not rebuild or independently filter that list. The adapter uses the same native
owner's `switchReplicas` operation above. Only all-leg `active` yields `switched`; native unknown, conflict,
unavailable or cancelled outcomes are returned without retiring either generation.
An Environment with no affected route legs needs no Caddy work. Docker retirement
remains with Plan 30, not a second ingress adapter or Caddy writer.

The complete-list reader compares the existing desired-inventory revision
across every page. Differing revisions return a conflict without partial legs;
callers cannot interpret that result as an empty list. No second route store,
generation or retry loop is involved.

Historical characterization, not a completion gate: pinned Caddy 2.10.2 removed
the incumbent from `/reverse_proxy/upstreams` while a request was still open,
for both route and exact upstream-list PATCH. Its tagged
[handler cleanup](https://github.com/caddyserver/caddy/blob/v2.10.2/modules/caddyhttp/reverseproxy/reverseproxy.go#L361-L370)
removes old entries from the pool enumerated by the
[admin endpoint](https://github.com/caddyserver/caddy/blob/v2.10.2/modules/caddyhttp/reverseproxy/admin.go#L69-L97).
That observation motivated the approved Docker-grace design; it is no longer a
request-counter RED or a blocker on implementing start-first.

`deployments.cancel` submits a storage-only cancellation through the same receipt
transition route used by installed daemons. Current Source/deployer admission and
the expected receipt revision decide the write, even when the controller cannot
reply. The write records `cancelRequestedAtMs` and overall `outcome_unknown`,
releasing the Environment's effect slot. It preserves protected member evidence,
the last uniform release and native resources. Repeating the acknowledged request
does not publish another change, and cancellation cannot resume that receipt's
queued/running stages. A later native success cannot advance the uniform pointer
past a newer attempt. This is uncertainty, not proof that native work stopped;
the next effect still needs its target owner's current-state observation. Loaded
rollout recovery and multi-Machine execution remain program integration work.

The deployment read controller derives `memberVersions` from its already-opened
receipt window and current link installations. A newer unknown or unvisited
member does not erase the newest proving activation/restoration identity;
uncertainty remains visible separately. This adds no per-member read or persisted
version vector. Native uniform settlement requires every captured current
installation's final release proof, not merely a list of link members.

`projectDeploymentHealthAggregateV1` owns the active-runtime-plus-edge reduction.
Joining members are excluded, a Machine in both roles counts once, and Production
unknown coverage counts down. Its input is the observer's current admitted fact
snapshot, not an incremental event stream; the observer still owns cross-call
currentness and withdrawal. The read controller carries this one strict aggregate
without another reducer. The development-only
`createDeploymentHealthAggregateLeaseV1` wraps that projector and the existing
semantic publication owner. Producers adopt complete admitted snapshots;
consumers check its currentness and retirement signal before using a retained
snapshot. Equal facts do not publish, and retired authority cannot revive.
The development native attachment now acquires its complete receipt-derived
service inventory after the local member row is acknowledged, then consumes the
existing Machine Services row pushes through this lease into one controller-owned
Environment C1 condition. This path can publish when the controller is also a
runtime member; unavailable remote members and edge coverage remain unknown.
It does not establish P50's separate-controller/private-probe coverage. C1 carries
condition-at-write history, not the current health authority.

Current native health uses the existing `machines.services.list` Resource with
an optional exact `environmentId` selector. Its owner narrows rows, Source
disclosure and push invalidations before delivery; omitted selection retains the
ordinary Machine page. Each native row carries normalized health, cached
freshness, a reason when available and the real timestamp of its adopted semantic
observation, plus the exact deployment/installation/service witness. Clock-only
native refreshes preserve row identity and publish nothing; an explicit Services
detail read still exposes the latest raw observation clock. Reading these rows
does not inspect native processes or disclose their private configuration.

Saved watched-service checks use the existing Automation Event authoring and
materialization path. The plugin's setup opener carries the exact watched
subject; the monitoring Machine is selected independently. Configure returns a
source proposal, while the explicit Save writes its observation-only definition
through the existing Automation writer and publishes its enabled state to the
materialization owner. Before
Save, a saved-check read correctly reports `source_unavailable`: a successful
setup proposal alone is not a saved or enabled source. The Event declaration
supplies observation-only intent for both new and edited checks; no recipe,
execution assignment or separate health-check store is required.

Opening setup again carries the plugin's canonical source identity. The existing
Account Automation inventory and private-definition reader resolve that exact
Event source before Configure, retaining its checks and selected monitoring
Machine. An unavailable or ambiguous saved source stays unavailable instead of
opening an empty replacement draft; a subject with no saved source starts a new
draft through the same writer.

The shared Environment read controller consumes those exact selected Resources
only while an Environment or full receipt page demands current health. Both
page hooks expose the same `healthFeed`: per Environment, active member and
Service, it carries producer state, nullable `observedAt`, reason and expected
Stop evidence. Record-only consumers and Session receipt chips add no health
demand. A member installation or Environment protection change rebinds current
health, so Production unknown/down accounting follows the admitted protection.
Hiding the last consumer or retiring its Account closes it. Ordinary metadata refreshes
retain current health, and the existing explicit refresh retries unavailable
Resources. No timer, native inspection or second health reader is introduced.
Historical receipt facts and L5's current URL/TLS remain separate projections.

Operations outcome links consume this existing health feed through
`useOperationsRunOutcome`. Receipt recovery requires its same Environment and
runtime target link; service recovery selects the same Machine and service id.
The model preserves the aggregate's recovery evidence and partial/unknown
coverage; it never promotes a successful operation or historical receipt health
to current recovery. Domain/certificate, setup and backup subjects without their
own matching health projection remain explicitly unavailable in this model.
Failure surfaces use `useInvestigateFailure` with their exact owner address and
the mounted Account's shared investigation owner; rendered placements belong
to the UI composition lane. The handoff derives a receipt/Environment controller,
its accepted Project Source folder (or managed default workspace), and the
ordinary New Session default Agent. Only ambiguous/unreachable placement or
missing Agent facts yield `placement_choice_required` candidates for an inline
choice; the owner never routes the person to Triage settings. These are
development-source contracts.

Environment `healthNotices` separately selects authenticated Home/Account C1
activity through the shell's existing Artifact acquisition. Optional typed
`environmentHealth` is the producer's condition-at-write aggregate, not a
current-health fallback. Empty notices or Services, unknown observations and
unavailable coverage never imply healthy or recovered. Loading and failed
delivery retain admitted facts without inventing newer observations. These
development-source hooks do not certify a loaded or rendered page.

Native workload observations supply the complete current service set to that
same projector. A newer healthy sibling or singleton probe cannot hide an
unhealthy service. Missing or unsupported service observations retain
`coverage_unavailable`; a proved outage and incomplete coverage can coexist on
one Machine without counting it twice. An omitted member observation withdraws
previous healthy coverage, while a newer complete service set removes retired
services. Observation timestamps and service ordering alone do not publish.
The supervisor's real desired Stop reaches these same rows and P40 evidence as
`expectedDown: 'stop'`. Actual stopped/down state remains visible, intentional
stops do not contribute to actionable outage counts, and Stop never proves
authoritative recovery. C1 presents the expected condition as an Update on its
existing identity; a genuine later failure or recovery retains its normal policy.
In 0.3 development source, a fresh native transition back to running clears that
stop intent, including an external restart. The systemd adapter treats an
inactive, unloaded (`LoadState=not-found`) unit as stopped; a confirmed Stop
settles its operation rather than retaining an uncertain receipt.

In 0.3 development source, the mounted Inbox explains an existing service-health
condition from an already-readable running stop, restart, deployment or reboot operation.
Native control publishes its exact service and generation before dispatch;
reboot captures running services and retained Domain placements for the admitted
Machine installation. Domain explanations require the exact Environment, link
and Domain probe subject, and never cover certificate failures. An unavailable,
uncertain, foreign-Account or settled operation supplies no explanation. This
presentation changes neither the health observation nor server-followed presence,
and creates no second notice or persisted expectation.

For a contributed target whose installed descriptor declares no teardown role,
the development teardown Action prepares the existing plain detach disposition.
Its review says remote resources, data and costs remain; an unavailable descriptor
is a typed refusal rather than evidence that the role is absent. Home executes
the same manager-only unlink owner and returns its typed `detached: true` result.
It creates no cleanup receipt or provider-absence claim. Explicit Detach keeps
that behavior. Stop and remove requests Environment removal and refuses this
keep-running fallback with a typed missing fact and remedy; it cannot claim
that the workload stopped or the Environment was removed. Retained/data links
keep the disposition owner's existing inventory and revision rules.

The native teardown Action uses one receipt and the existing signed transition
writer. Its finite continuation observes the first unproved owned step before
dispatch and skips recorded proved steps. Retry on a native teardown receipt
invokes `deployments.teardown` through the same Action executor. While the daemon
retains that admitted invocation, it resumes the same operation and receipt with
the original signed request and resource retention choices, without preparing or
approving another teardown. A fresh observation may prove that the unproved step
still needs execution; an unknown observation remains an unproved removal.
Development own-server teardown accepts an Environment/target revision intent;
the Action placement owner routes an unprepared intent to the Machine, where
the installed host prepares its workload inventory before approval, including
Workflow execution. Prepared receipt operands retain Account placement. A local
single-member target, local or remote from the controller, uses source-independent
native acquisition, observes the
canonical project and retained candidate generations, and stops/removes their
verified containers with Docker's configured stop grace, then removes networks
labelled with each exact owned project in that same teardown step. Networks with
active endpoints cannot be removed; the receipt retains the unproved step and
its typed reason. Successful empty container and owned-network inventory is an
idempotent absence proof; an unavailable engine is not. Named data volumes remain
unless explicitly selected for data removal; images and source files are kept.
Stop and remove supplies `removeEnvironment: true`. Home admits the existing
manager permission once and captures that disposition on the admitted receipt.
After native proof, the signed final transition invokes the canonical Environment
removal writer in the same transaction and returns `environmentRemoved: true`.
It never selects detach or starts another delete/unlink Action. Plain teardown
without that flag may retain the Environment; its successful receipt remains
usable by the existing explicit disposition Actions.
Deleted Environments remain readable as retained tombstones with `deletedAtMs`.
In 0.3 development, confirmed Environment deletion or teardown with
`environmentRemoved: true` also retires its open deployment approvals through
the Action executor's existing deleted-subject approval settlement. The executor
opens approval bodies on the client and matches both Home and Environment;
stop-only, deferred or failed removal leaves them open. Artifact failures use the
existing retirement warning and do not change a confirmed removal result.
Imported native projects and multi-member native targets still return
`unsupported_action` until their native custody/removal owner is available.
Preparation spends receipt-history reads and the Home-issued receipt candidate
bound to the same teardown root; Home and daemon must load the matching 0.3
development contracts. Storage continues to require a prepared receipt operand.
After an outcome-unknown cleanup and daemon replacement, the old receipt is
retained; a fresh approved teardown request observes native facts and completes
with its own receipt rather than borrowing the old operation's authority.
Workflow deployment mutations dispatch through the installed controller before
preparation and approval. The receiver restores the selected approval policy
from the exact accepted invocation; an Account waiver cannot erase its Require
decision. An issued Workflow root and admitted receipt retain their continuation
custody while the run is paused for approval: the approved finite effect executes
before Workflow resume. Paused runs cannot issue fresh roots. Replay uses the
accepted Run's permission ceiling, while the existing installation signature
binds the prepared effect. Detached approval replay restores private content
custody from the deciding invocation's admitted requester, never from ordinary
daemon credentials. Cancelled or otherwise terminal runs cannot spend
that continuation.
The absence proof assumes native own-server workloads use only the canonical
Environment project name or a receipt-derived candidate project name. Imported
project names are excluded; another native naming producer would need to extend
the canonical inventory before its workloads could use this proof.
Neither schema acceptance nor a caller-supplied empty resource list certifies cleanup.

The development `DeploymentDomain` relation retains non-content route custody
and a private Artifact reference. Its capture JSON retains current desired and
unresolved native placements with their exact content references, installation
keys and accepted execution identity. Changing placement retains the previous
location until signed absence settles it; a new desired edge cannot erase old
edge custody. The Machine reference census reads these exact captures rather
than deriving destinations from retained secret grants. New native captures also
retain the selected Docker engine identity. Native acquisition compares that
identity before observing or changing routes; another configured engine's empty
Caddy cannot prove absence on the captured engine. Missing legacy identity is
incomplete custody, not successful cleanup.

Domain get/list also project installation-signed, last-observed Network facts
per captured Machine: installed Caddy TLS flags, published TCP ports with a closed
audience class (`loopback`, `privateNetwork`, `wildcard`, or `other`), and whether
the route has a local origin or peer fallback. A wildcard binding is not proof of
Internet reachability. The existing native
route owner produces these facts during add or explicit verify; settlement
retains them in capture JSON without a new query or polling loop. Missing facts
are `unavailable`, and `observedAtMs` remains the last semantic observation,
not a live reachability claim. Listener strings and addresses stay in the private
controller-to-target topology and encrypted Machine state; clients join audience
classes to their existing Machine network facts locally. The projection excludes
admin sockets, container and network identities, upstreams, certificates and credentials. Existing Source
admission governs disclosure through Domain get/list.
This address-free audience-category and port contract closes the E2EE disclosure
finding in [SEC-REVIEW-1102F](../.project/plans/2026-10-26-implementation/o-deploy/lanes/SEC-REVIEW-1102F.md)
and is approved by [SEC-REVIEW-1102G](../.project/plans/2026-10-26-implementation/o-deploy/lanes/SEC-REVIEW-1102G.md).

Accepted Domain work opens only its captured Domain, Environment and target-link
Artifact references through the existing Artifact owner and original requester
recipient envelope. It does not switch to the Machine custodian's Account key
or repeat the requester's Team ACL decision for those admitted reads. Existing
body revision retention serves an exact older body; unavailable historical
headers or recipient envelopes remain typed unavailable. There is no new header
snapshot, key store or invented old revision. Remove and native verification
need no mutable Environment metadata; activation consumes its admitted private
member snapshot and exact content references instead of newer heads.

In 0.3 development, the accepted add controller also reads facts for its exact
Domain capture through the existing secret-launch admission endpoint before
requesting a connector token. That facts-only request carries the installed
controller signature and the Domain effect, including its reviewed child proof
when invoked by a template. Home consumes the accepted Domain job and captured
target identity; it neither grants target secret use to the controller nor
repeats Source or Team admission. Home refusals retain their typed phase and
HTTP status through the Domain Action result.
Signed `verification_purpose` refusals retain that required fact and a remedy to
update Home and the Machine before retrying; the projection exposes no operands
or signed carrier content.
When no active Domain members can supply a route, the same typed failure names
`activeDomainMembers` and asks the caller to deploy the app on that Machine
before adding the Domain.

Unreleased 0.3 Domain native failures preserve the reported required fact and
remedy through operation settlement and public approval reads. When native
execution reports no more specific fact, the Domain recovery projector names
`nativeExecutionResult` and asks the caller to inspect native state before
retrying; this does not assert an unreported native step. Unavailable network
exposure similarly names `networkExposure`.
The shared recovery projection describes a native-execution `deployment_conflict`
as ambiguous running service generation and directs the person to Machine
services. Review-admission conflicts retain their fresh-review recovery.
Store's partial Domain result uses this same presentation owner to read its
retained Domain failure; a wrapper's generic recovery does not replace the
native required fact or authored remedy. Completed installation steps remain
in the partial result.
Own-server retained-service recovery accepts a single native Compose project
whose services come from different retained source folders, as when Compose
reuses an unchanged app container while adding a database. The existing source
custody reader proves each folder against its receipt before observation;
competing native projects remain a conflict.

Unreleased 0.3 Domain readiness also consumes the signed DNS health result from
the existing finite DNS health owner during native add or verification. Home
settles a desired Domain as `warning` until every desired placement reports DNS
`up`; installed Caddy material alone does not establish `active`. Missing DNS
retains `dns_missing` and its remedy in the header's `dnsHealth` evidence.
Resolver unavailability stays `unknown`. No hostname, answer, observation clock
or latency is copied into this semantic public projection. Verification uses A,
then AAAA only when A does not resolve, and runs again only through the existing
verify Action. There is no DNS polling. NetworkExposure remains a native topology
observation and makes no Internet reachability claim. Home, native executors and
clients must load this development contract together; observations without DNS
stay warning.

Recovery Add resolves ingress through the same Domain route-selection owner as
installation. It reads topology from the existing private Environment content;
no new selection is persisted on the Environment. A `cloudflareTunnel`
Environment requires a full named Domain selection in `content.ingress` before
admission, otherwise the Action returns `cloudflare_selection_required` and a
remedy. With no recorded ingress, the native placement owner permits one active
Machine's public Caddy route; several active Machines return
`domain_ingress_required` with a remedy. A named selection supplied by the caller
takes precedence.

The Environment Domains Add form is also the Store recovery entry. It consumes
the Cloudflare plugin's existing `cloudflare-named/selections-read` Action through
the UI Action executor. Omitted `zoneId` lists the configured account's zones;
only an HTTP 403 `zone_list_unavailable` exposes an explicit zone ID field.
The read owner authors the cause and remedy for missing credentials or Account
metadata, refused permissions, provider HTTP failures, network failures and
unreadable responses. The shared form displays that recovery, retaining the
provider status or sanitized Action cause in Details instead of replacing it
with a generic connection message. An HTTP 401 requires reconnecting the account;
it does not offer the missing-scope fallback. With a selected zone,
the same Action returns complete eligible tunnel selections. The form prefills
only a unique zone or tunnel, requires a person's explicit choice when there are
several, and writes the selected `content.ingress` without a second eligibility
or authority decision. The selected connection supplies the Account ID and the
plugin supplies its connector pin through the same Action output. Explicit
overrides appear under Advanced; connector discovery remains unavailable. Reads
happen on a person's press, with no polling. A form without recorded topology visibly offers
deployment topology or a named Cloudflare selection; native placement decides
whether deployment topology alone is sufficient.

A Domain header can expose the current operation address derived from its
existing private execution captures. The UI reads that exact controller
operation and shows settled failure details through the shared approval
technical-details component. A failed or cancelled Remove permits another
review and retry without rewriting the Domain's desired state. Legacy or mixed
captures without an unambiguous controller address omit this projection.

In unreleased 0.3 source, the Caddy startup seed can transition between the exact
Happier public and private configurations through the reviewed Domain Apply.
Domain approval discloses this possible replacement. The file owner admits only
the desired bytes or the exact known predecessor digest and checks the captured
file again before activation. A custom seed remains `foreign_effect_conflict`
and requires reconciliation; it is not overwritten or deleted. Live routes and
certificate state remain in Caddy's separate persistent state.
A never-started owned container with the profile's exact public 80/443 bindings
can also be recreated for private ingress after a failed public start. Removing
publications from a running or previously exited public container, or changing
custom port bindings, requires separate reconciliation. A ready Caddy can serve
a private origin while retaining its existing public routes and publications.

The development prepared-content continuation lets the accepted add controller
commit private tunnel adoption and owned-DNS coordinates before its first native
dispatch. `createOwnServerDomainContentWriter` prepares the body with the existing
Artifact codec; Home updates that same Artifact and the Domain's desired capture
references in one admitted transaction. A stale capture or Artifact version
changes neither side. The header, Domain and Environment revisions, placement
identity and operation stay unchanged; retained predecessor captures keep their
original references. Subsequent acquisition or removal uses the committed body
reference rather than losing vendor provenance when native activation fails.
This continuation is not itself native activation or proof of provider cleanup.

Removal admission also captures `retireSharedTunnel` on every placement.
Plan 21 selects one shared tunnel per Environment, with its controller held on
that Environment; the Domain owner checks for another non-tombstoned Domain in
that scope once, before capturing the removal job. Removing rows still count as
consumers. Native removal consumes the captured boolean without inspecting
private provider content or recounting Domains. A replay retains its original
decision. Concurrent removals of the last two Domains may both retain the tunnel;
that visible leftover can be removed explicitly after both settle. There is no
new lock, store or native ownership decision.

The app sends Domain add, remove and verify intents to the Environment's
controller through the original Machine Action transport. That controller
observes native placements and supplies the admitted operation fields to Home;
the app never sends a public intent directly to the placement-required storage
route. Domain get/list remain Home reads. Controller refusals, such as a mismatched
target or unavailable native placement, retain their typed reason.

In unreleased 0.3 source, Caddy setup preserves the elevation owner's typed
`native_protocol_invalid`, `native_check_unavailable`, `native_check_unsupported`
and `native_effect_failed` failures, optional closed native reason and existing
managed-CLI recovery. Domain presentation maps only proven administrator-policy
refusals to `machine_admin_access_required`; a generic denial does not establish
missing Admin Access. An uncertain native effect remains `outcome_unknown`.
Own-server preparation also preserves `plugin_exec_system_tool_unavailable`
with the closed Docker details `kind: 'systemToolUnavailable'`, `toolId: 'docker'`
and `remedy: 'install_on_machine_and_add_to_daemon_path'`. Recovery is to install
Docker Engine with Compose on that Machine, put `docker` on the daemon PATH and
allow the daemon user to access Docker. Missing executable evidence does not
establish an Engine, socket-permission or Compose-version failure.

Docker Buildx is also a prerequisite for image preparation, including image-only
Compose services: native `imagetools inspect` establishes immutable image index,
manifest, configuration and platform provenance before approval. Bake is invoked
only for services with a build definition. `docker_buildx_not_installed` retains
`kind: 'systemToolUnavailable'`, `toolId: 'docker-buildx'` and
`remedy: 'install_docker_buildx_plugin_on_machine'`. Install Docker Buildx on the
image preparation Machine (`docker-buildx-plugin` with Docker Engine packages;
the observed Ubuntu distribution package is `docker-buildx`) and verify
`docker buildx version` works for the daemon user. Installing Engine and Compose
alone does not establish that this plugin is available.

The development Domain add/remove/verify/get/list contracts share that owner.
Producer-signed observations update metadata only for semantic changes; equal
observations do not advance revision or publish. Remove intent alone does not
tombstone a Domain: every captured placement must supply verified native
absence. Legacy missing captures remain incomplete, never vacuous success.
`readDeploymentDomainInventoryInTx` uses the
current Source admission and the existing Environment transaction lock to read
every non-tombstoned Domain, including removing rows and predecessor or detached
target links. It opens no private content and has no list-page limit. An empty
result describes that transaction only; an Environment revision does not freeze
Domain membership across native work.

The existing Stop and remove confirmation lists the Environment's Domains and
approves one teardown operation. Receipt admission uses this inventory to capture
Domain retirement through the existing Domain removal owner, with the same
operation, controller and request binding. Its native calls spend that admission
and check only that the admitted job remains active. The controller retires the
captured Domains before target cleanup; it does not issue another Domain Remove
Action or ask for another confirmation. Native target cleanup then disconnects
the canonical shared Caddy container from exact Compose-owned networks before
removing them, preserving Caddy and its sibling attachments. Other active
endpoints still prevent verified network removal. A failed retirement returns a typed
partial result naming the Domain and its required fact and remedy, records a
cleanup failure, and leaves the Environment present. Environment removal is the
last step of Stop and remove. A rejected or uncertain final removal returns a
typed `removeEnvironment` partial with the Environment identity, required fact
and remedy, preserving the original failure code. Only a committed removal
returns `environmentRemoved: true`; clients consume that signed result without
rereading the removed Environment. Signed teardown completion still refuses a
contradictory live Domain inventory with `deployment_conflict`.
Domain routing, credentials and native absence remain with the Domain owner.

The selected Environment ingress mode lives in protected content. Its explicit
edge Machine is only a non-content placement projection; an absent edge never
means Tunnel. The existing Environment CAS admits ingress edits and preserves
captured predecessor cleanup. Candidate preparation consumes the full private
mode, while edge route selection consumes observed native listeners and private
origins for every active member. A selector is not evidence that native
activation, the conditional usable-zone Tunnel default or live health wiring
has completed.

Native Domain discovery also carries `caddy.containerOrigins` through its
existing private topology contract. The one Caddy observer derives each
`{ serverId, networkName, service }` from the owned container's actual primary
network address and a matching live plain HTTP listener. It does not substitute
a host-published endpoint or assume container-name DNS on the default bridge.
The provider's native plan must select the admitted Domain server and consume
the same observed Caddy container/network. These finite endpoint facts neither
promise address stability after replacement nor prove connector activation,
firewall scope, public reachability or health; those remain their native owners'
responsibilities. Missing network/listener facts produce no container origin.

For a shared Tunnel, the existing Domain placement selector chooses one
`service` URL observed for the selected private Caddy server on every active
member. Its private `tunnelOrigin` topology carries that URL and each member's
Machine, installation, Caddy container, network and native server. The controller
forwards this selection unchanged through the existing child transport and
rejects a discovery reply for another Machine or installation before admission.
Missing or unequal endpoint facts return `required_fact_unavailable` for the
complete active set; joining members are included when they become active.
There is no reduced member set, per-Machine remote Tunnel configuration or
inferred Docker DNS name. Different observed addresses need a proven shared
native endpoint mapping before they can serve one global Tunnel configuration.
This selection does not configure or certify the provider or connector.

## SQLite read snapshots (0.3 development)

Plugin Data contract/get/query/UI-query reads, Session query/list/detail reads,
signed-credential Account currentness and login-status reads, request/job Home
configuration overlays, Account Settings
and encryption GETs, Artifact GET authorization/data reads, and the Account
changes feed use `inTx(..., { readOnly: true })`. The storage client owner in
`apps/server/sources/storage/prisma.ts` keeps one lazy, single-connection reader
beside the write pool and serializes deferred read transactions through the
existing `AsyncLock`. SQLite's `query_only` pragma rejects accidental writes;
rollback ends each snapshot, and database shutdown drains and disconnects the reader.
This preserves row/cursor and access snapshots without Prisma's SQLite
`BEGIN IMMEDIATE` writer lock. Other database providers retain their existing
transaction path. Write transactions continue to use `inTx` and `afterTx`.
On PostgreSQL and MySQL, a read declared `singleStatementRead` runs without a
transaction at all; SQLite still serves it from this read snapshot.

Use this existing owner for genuine reads rather than the primary Prisma client:
a pending writer on that client can queue unrelated reads behind SQLite's busy
wait even while WAL readers could proceed. Keep snapshots limited to database
work; Artifact blob IO and upstream login eligibility checks remain outside.
The changes feed's post-page retention-floor recheck uses a separate fresh
snapshot, and signed credentials still recheck current Account revocation/status
after cryptographic verification. PAT last-use updates and all mutation paths
remain writable transactions.

Protected standalone snapshot-backed Session, SystemRecord, Discussion and private
Artifact reads capture admission, content, mode and key bindings together once.
The storage-owned `captureReadSnapshot` helper materializes captured facts after
closing that snapshot. A finite admitted read may finish after access changes;
the next request evaluates current authority. Socket delivery admits each new
event independently, so retained consumption demand cannot authorize later
protected deliveries after revocation. Lists return their captured corpus without
refreshing it from the write pool or substituting newly accessible rows. Supplied-transaction
read helpers remain in their caller's transaction, including mutation readbacks.
This is development-source behavior, not certification of a deployed runtime.

The existing SQLite busy-timeout owner supplies transaction acquisition and
execution defaults (30 seconds by default, with the existing one-second
transaction minimum). The retry budget permits two complete attempts plus the
first backoff. Explicit transaction environment overrides still take priority.
No database schema, migration, content format or client wire contract changes.

## PostgreSQL transaction deadlines (0.3 development)

For an explicitly configured Prisma pool with at least two connections, `inTx`
admits at most the pool size minus one interactive transactions at a time.
Read snapshots and writes share this process-local admission through the existing
`AsyncLock`. Excess attempts queue before acquiring a connection, leaving capacity
for direct Machine validation, RPC availability and presence queries (signed-credential
Account reads and other single-statement reads also use that capacity). Queueing
consumes the existing acquisition budget and respects the request deadline;
retry backoff starts after the attempt releases its admission permit. This does
not change pool size, Account lock ordering or isolation. An implicit pool size,
a single-connection pool and other database providers keep their existing paths.
Direct queries can still contend with one another; this reservation prevents
interactive transactions alone from occupying the entire configured pool.

In 0.3 development, `inTx` sets the PostgreSQL statement budget once at transaction
start, using the existing transaction-attempt budget after setup. An already-enforced
stricter `statement_timeout` is reused; otherwise one `SET LOCAL statement_timeout`
applies that budget. Later statements keep the same SQL limit. Prisma still owns
the interactive transaction deadline, but an in-flight SQL statement or lock wait
may continue past it until that statement's fixed SQL budget expires. It then
settles as a timeout and releases the connection; no per-statement refresh or
query queue is added by `inTx`. A statement the budget cancels (SQLSTATE `57014`)
and a transaction Prisma expired (found by a query, batch query or commit) are
known rollbacks. PostgreSQL execution timeouts settle without replay; genuine
serialization conflicts retain the existing retry/backoff policy. This is distinct
from the containing request's deadline: retries never extend that deadline. Exhausted
known rollbacks remain retryable storage refusals; an earlier indeterminate
commit remains an unknown outcome. After-commit effects run only for the
successful attempt. Domain consumers such as Pending reuse this owner rather
than adding their own transaction retry loop.

## Managed Home owner provisioning boundary (0.3 development)

The current repository has no managed-host producer that creates a Home's first Account.
`provisionFreshAccountInTx` belongs to authentication admission—native, Key Challenge, OAuth,
and mTLS—and must not turn one of those signup paths into an owner election. The server-side
ownership contract is ready for a distinct trusted deployment producer, but this does not make
a managed-hosting journey available by itself.

A supported producer must run inside the trusted server deployment and compose Account
creation with
`apps/server/sources/app/home/governance/ownerAssignment.ts#claimHomeOwnerInTx` in the same
serializable database transaction. The owner service accepts one explicit Account ID, requires
that Account to exist and be active, and succeeds only while the Home has no active owner. It
also writes the target's `AccountChange` refresh and the Home-governance invalidation in that
transaction. If the transaction fails later, Account creation, role assignment, and both
refresh writes roll back together.

The producer owns its existing provisioning-request identity and must resolve a retry to the
same Account before deciding anything about ownership. After an uncertain outcome it re-reads
that Account and the active owner in a fresh transaction: the same active Account already being
owner is recovery of the prior success; a different owner, an inactive Account, or a missing
Account is a refusal. With zero active owners it may call `claimHomeOwnerInTx` again. The
producer returns success only after commit and a canonical Account/Home-governance readback.

This boundary is deliberately not HTTP-accessible. Do not add a public bootstrap route, setup
bearer, first-signup election, second owner writer, scheduler, or provisioning ledger. An
out-of-process producer that cannot participate in the server transaction needs an explicitly
approved integration contract; the deployment-local `--claim-home-owner` command remains an
operator setup/recovery tool and is not a substitute for atomic managed provisioning.

Operators and owners reach the same transition through three adapters, all ending in
`claimHomeOwnerInTx` with its zero-active-owner precondition (Teams Lane 01.02 AM-1, Home owner
console plan §3.5):

- `happier-server --claim-home-owner=<accountId>` (deployment command; audit actor
  `deployment_command`);
- the hosting desktop's hsetup task `relay.runtime.personal_home.claim_owner.v1`, which runs that
  command against the local Personal Home runtime (installed server binary, `server.env`) while the
  runtime keeps running (SQLite WAL), under the Personal Home data-operation lease so it never
  interleaves with a backup, restore, erase, relocation or update. Only hsetup registers it; the
  daemon does not advertise it;
- `POST /v1/home/governance/claim` (`home.governance.claim`), redeeming a one-time code minted on
  demand by `happier-server --print-home-claim-code`. The code is 32 random bytes, stored only as
  a SHA-256 in `SimpleCache` key `home.owner-claim-code.v1` (a new print replaces it), expires
  after 15 minutes, is spent in the claiming transaction (a refused claim rolls the spend back),
  and is rate-limited per address (`home.governance.claim`). Every refusal is the same
  `home_claim_refused` 403. The audit actor is the claiming Account with `via: 'claim_code'`.
  Holding a code proves the same deployment-level access as the command, so this is not a public
  bootstrap route: nothing is claimable until an operator prints a code.

## Services for the full Postgres/S3 recipe
1. **Postgres**
   - Owns persisted data in this recipe; light SQLite deployments use persistent local storage instead.
   - Configure via `DATABASE_URL`.

2. **Redis**
   - Optional for one `SERVER_ROLE=all` process. Startup pings Redis only when the Redis socket adapter is enabled.
   - Multi-replica API and split-worker deployments need `REDIS_URL` and `HAPPIER_SOCKET_ADAPTER=redis-streams`, plus load-balancer affinity for HTTP polling.

3. **S3-compatible storage**
   - Used for avatars and other uploaded assets.
   - Configure via `S3_HOST`, `S3_PORT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`, `S3_USE_SSL`.

## Shared-database QA servers (0.3 development)

Stack's shared-database preset points consumer servers at a privately provisioned
source-stack environment on their server host. `applySharedDatabaseSourceEnv`
projects that authority at launch: database, server at-rest secret, file storage,
and socket clustering. Consumers skip migrations against the shared database.

When the source selects `HAPPIER_SOCKET_ADAPTER=redis-streams` with a nonempty
`REDIS_URL`, consumers use the same adapter and Redis endpoint. Otherwise both
projected settings are cleared, including stale consumer values. Remote server
hosts need the current private source projection and authenticated network access
to that endpoint. Keep connection secrets in the private environment file; never
put them in command arguments or diagnostics. Reload consumers through Stack
after provisioning changes so running processes consume the new settings.

Sharing a database alone does not share Socket.IO fanout: in-memory adapters keep
Machine activity/presence ephemerals and updates inside each server process.
Servers connected to the same Redis Streams adapter scope fan those events out to
clients on other servers. In unreleased 0.3 development, repo-dev and `agent-qa-*`
stacks keep separate adapter scopes even when they share the database and Redis
endpoint; cross-stack presence and socket events no longer fan out between them. `SERVER_ROLE=all` continues to flush presence to the
database locally; selecting the adapter does not turn it into an API/worker split.

## Environment variables
**Required for the full Postgres/S3 recipe**
- `DATABASE_URL`: Postgres connection string.
- `HANDY_MASTER_SECRET`: master key for auth tokens and server-side encryption.
- `S3_HOST`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`: object storage config.

**Common**
- `PORT`: API server port (default `3005`).
- `METRICS_ENABLED`: set to `false` to disable metrics server.
- `METRICS_PORT`: metrics server port (default `9090`).
- `S3_PORT`: optional S3 port.
- `S3_USE_SSL`: `true`/`false` (default `true`).

**Development 0.3 private Artifact storage**
- `S3_PRIVATE_BUCKET`: a separate provisioned S3 bucket for binary Artifact bytes,
  using the existing S3 connection and credentials. It must differ from the public
  `S3_BUCKET` and have no anonymous-access policy. The server does not change bucket
  policies or fall back to the public bucket; missing or unsafe private storage
  leaves private operations unavailable.
- The local files backend defaults to the existing private-files directory,
  separate from the public file root. Its development guard resolves both roots
  and refuses private IO when either contains the other, including symlinked
  overlaps. The regression GREEN remains blocked by an unrelated Action-catalog
  collection error; this is source behavior, not deployment certification.
  Neither backend issues a public URL for these bytes.

**Optional browser-hosted plugin Artifacts**
- `HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN`: opt in to browser Artifact delivery with a dedicated HTTPS origin. Leave it unset to keep browser Artifact hosting unavailable; desktop/native Artifact delivery is independent.
- The Artifact origin must differ from both the effective web-app origin and `HAPPIER_PUBLIC_SERVER_URL`. The server fails closed if either configured origin aliases it.
- The deployment operator must provision DNS, TLS, and a dedicated path-restricted virtual host that forwards only the `/v1/plugins/availability/ui-artifacts/browser/` route prefix to the existing API service. Preserve the trusted request host/protocol projection so the server can validate the Artifact origin. This repository does not provision that host or start a second static server.
- Browser Preview uses this delivery path only for online plaintext Accounts; E2EE Accounts receive the typed unavailable result.

**Optional integrations**
- GitHub (OAuth + optional org allowlist enforcement)
  - OAuth (used for linking a GitHub identity and for GitHub-only signup when enabled):
    - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
    - `GITHUB_REDIRECT_URL` (preferred) or legacy `GITHUB_REDIRECT_URI`
      - Set this to your server callback: `https://YOUR_SERVER/v1/oauth/github/callback`
    - Optional: `GITHUB_STORE_ACCESS_TOKEN` (`true` to persist encrypted user tokens; default `false`)
  - Auth policy / enforcement (enterprise / self-hosting restrictions):
    - `AUTH_ANONYMOUS_SIGNUP_ENABLED` (default `true`)
    - `AUTH_SIGNUP_PROVIDERS` (e.g. `github`)
    - `AUTH_REQUIRED_LOGIN_PROVIDERS` (e.g. `github`)
    - `AUTH_GITHUB_ALLOWED_USERS` (CSV list of lowercase GitHub logins)
    - `AUTH_GITHUB_ALLOWED_ORGS` (CSV list of lowercase org slugs)
    - `AUTH_GITHUB_ORG_MATCH` (`any`/`all`, default `any`)
    - `AUTH_OFFBOARDING_ENABLED` (default `true` when allowlists are set)
    - `AUTH_OFFBOARDING_INTERVAL_SECONDS` (default `600`)
    - `AUTH_OFFBOARDING_MODE` (`per-request-cache`)
    - `AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE` (`github_app` recommended when org allowlist is set, or `oauth_user_token`)
  - GitHub App mode for org membership checks (recommended; avoids relying on user OAuth tokens):
    - `AUTH_GITHUB_APP_ID`
    - `AUTH_GITHUB_APP_PRIVATE_KEY` (PEM)
    - `AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG` (e.g. `acme=123,other=456`)
- Voice (server-minted ElevenLabs conversation tokens via `POST /v1/voice/token`):
  - Required: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID_PROD`
  - Required when `HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION=true`: `REVENUECAT_SECRET_KEY`
  - Optional controls:
    - `HAPPIER_FEATURE_VOICE__ENABLED` (`true`/`false`, default `true`)
    - `HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION` (`true`/`false`, defaults to `true` when `NODE_ENV=production`)
    - `VOICE_FREE_SESSIONS_PER_MONTH` (default `0`)
    - `VOICE_FREE_MINUTES_PER_MONTH` (default `0`, enforced when `HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION=true`)
    - `VOICE_MAX_CONCURRENT_SESSIONS` (default `1`)
    - `VOICE_MAX_SESSION_SECONDS` (default `1200`, min `30`)
    - `VOICE_MAX_MINUTES_PER_DAY` (default `0` = unlimited; global per-user guardrail)
    - `VOICE_TOKEN_MAX_PER_MINUTE` (default `10`, `0` disables rate limiting)
    - `VOICE_COMPLETE_MAX_PER_MINUTE` (default `60`, `0` disables rate limiting)
    - `VOICE_LEASE_CLEANUP` (`true`/`false`, default `false`)
    - `VOICE_LEASE_RETENTION_DAYS` (default `30`, clamp 7–365)
    - `VOICE_LEASE_CLEANUP_INTERVAL_MS` (default `21600000` = 6h, min `10000`)
  - In 0.3 development, reservation release reconciles provider-attested terminal
    conversation usage through the same settlement owner as completion. Active,
    unknown or unverifiable provider state does not free the reservation. Tokens
    without a usable provider conversation identity remain reserved; expired
    unsettled leases remain quota-counted through their UTC grant month and day
    windows rather than disappearing during retention cleanup.
- WorkOS SSO and Directory Sync (0.3 development; see
  [enterprise-identity.md](enterprise-identity.md)):
  - `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` — the deployment owns the WorkOS platform
    credentials. Teams never store an API key; they store exact WorkOS organization and
    connection references.
  - Both must be present. Neither set reports `not_configured`, exactly one reports
    `partial_configuration`, and an unusable pair reports `invalid_configuration`. All three
    surface to administrators as `workos_platform_unavailable`, so a half-configured
    deployment fails closed instead of appearing to work.
  - Changing either value changes the WorkOS runtime fingerprint, which invalidates
    already-started OAuth attempts bound to the previous runtime.
- Logging format (development source): `HAPPIER_SERVER_LOG_FORMAT=json` opts Node into structured stdout through the server configuration registry and post-Home-overlay logger initialization; unset or invalid values retain pretty output.
- Sentry native CPU profiling (development source): `SENTRY_PROFILE_SESSION_SAMPLE_RATE` defaults to `0`. A positive rate enables the native integration on Node. Bun-based servers cannot load the V8 profiler; they emit a `profiling-unavailable` warning and retain Sentry error capture. Native profiling is not available in Bun-compiled server binaries.
- Debug logging: `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` (enables file logging + dev log endpoint).

## Happier Cloud as the default Account Service (0.3)

Official 0.3 builds select Happier Cloud (`https://api.happier.dev`) as the default Account Service
through their [build profile](feature-gating.md#first-run-defaults-and-setup-admission-03-development).
Source builds without a profile have no hosted Account Service or Home default. Clients
treat it exactly like a self-hosted one: every method, creation path and reset is read from what it
advertises. The operator-facing contract is the published
[Running your own Account Service](../apps/docs/content/docs/self-hosting/auth.mdx) section; this
records what the Happier Cloud deployment itself must set.

Observed 2026-09-25: production runs 0.2. `GET /v1/features` has no `capabilities.accountDirectory`,
`capabilities.server` is empty (no canonical URL), GitHub is enabled but not configured, and
`/v1/auth/entry` does not exist. Current clients therefore show "Happier Cloud can't find Homes yet"
and no sign-in methods. Nothing changes until Cloud deploys 0.3.

For email and password on Happier Cloud once it runs 0.3:

- `HAPPIER_CANONICAL_SERVER_URL=https://api.happier.dev`. Without it, clients reject the service
  (no stable audience for the Account Directory key challenge).
- `HANDY_MASTER_SECRET`: already required. It derives the Account Directory signing key, so it must
  stay stable; rotating it changes the key Homes pin.
- `HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME` is optional. Clients already call the default service
  "Happier Cloud".
- `HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED=1` and `HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED=1`.
  Both are on by default; set them explicitly so a later default change is not silent.
- SMTP, required for account creation, "Forgot password?" and sign-in email changes:
  - `HAPPIER_AUTH_EMAIL_SMTP_HOST` and `HAPPIER_AUTH_EMAIL_FROM_ADDRESS` (for example `no-reply@happier.dev`);
  - `HAPPIER_AUTH_EMAIL_SMTP_PORT` and `HAPPIER_AUTH_EMAIL_SMTP_SECURE` (465 with `true`, or 587 with `false`);
  - `HAPPIER_AUTH_EMAIL_SMTP_USERNAME` and `HAPPIER_AUTH_EMAIL_SMTP_PASSWORD` from the mail provider;
  - optionally `HAPPIER_AUTH_EMAIL_FROM_NAME=Happier`.
- Mail links also need an application origin and a published Home connection descriptor:
  `HAPPIER_WEBAPP_URL` (for example `https://app.happier.dev`) and the public HTTPS ingress
  (`HAPPIER_PUBLIC_SERVER_URL`). Without them the mail-dependent actions are reported unavailable
  (one readiness owner: `resolveAuthEmailReadiness`, SMTP **and** a buildable link), so clients do
  not offer them.
- Public sign-up policy (`shouldDenyPublicSignupProvisioningAction`) still applies to email
  account creation. Decide it together with key sign-up.

Without SMTP, clients show email and password sign-in only: no "Create an account" by email and no
mailed reset. That is safe, but new users could then create accounts only with a key.

## Managed identity provider secrets (0.3 development)

Database-managed provider credentials — OIDC client secrets and GitHub App private keys and
client secrets — are write-only. They are encrypted with the existing server operational
encryption under a domain-separated path
(`storage / identity_provider_instance / <id> / <kind> / secrets / v1`), decrypted only for the
selected runtime, and never returned by any read; administration responses carry only a
`configured` boolean.

These are operational secrets the Home can read, not end-to-end encrypted material, and they
derive from `HANDY_MASTER_SECRET`. Losing or rotating that master secret makes existing
provider secrets undecryptable: the affected provider fails closed with
`provider_secret_unreadable` and must have its credential re-entered. Include managed identity
providers in the blast-radius assessment for any master-secret rotation plan.

## Managed identity networking (0.3 development)

Database-managed OIDC resolves its network policy in
`apps/server/sources/app/auth/providers/managed/managedIdentityNetworkPolicy.ts`.
The deployment is the outer ceiling: absent or malformed
`HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED` leaves managed
providers public HTTPS-only on port 443. When explicitly enabled, the persisted
Home policy may permit exact private hostnames, CIDRs, and ports. Team
administration cannot widen that policy. File/environment OIDC retains its
existing deployment-trusted policy through the same outbound transport.

The catalog includes the effective network policy and, for a Team-bound provider,
the exact Team connection revision in the selected runtime's fingerprint.
Finalization resolves it again in the transaction that commits the identity
changes, so an earlier OAuth attempt cannot authorize against a changed policy or
Team connection. The outbound owner enforces DNS/address, connected-peer, TLS, redirect,
timeout, header and decoded-response bounds; callers do not substitute a plain
fetch implementation.

Managed administration and composed live sign-in validation are still in progress;
this is development architecture, not a stable/preview availability claim. See the
[operator OIDC guide](../apps/docs/content/docs/self-hosting/auth-oidc.mdx) for
configuration and the deployment-provider compatibility boundary, and
[enterprise-identity.md](enterprise-identity.md) for the surrounding provider, Team
connection, and directory domain.

## Docker image
A single multi-target Dockerfile is provided at `Dockerfile`.

Build targets:
- API server: `server`
- Worker: `server-worker`
- Website: `website`
- Webapp: `webapp`
- Docs: `docs`

Key notes:
- The server defaults to port `3005` (set `PORT` explicitly in container environments).
- The image includes FFmpeg and Python for media processing.
- In development source, `server`, `server-worker`, and `server-stress` share the existing production dependency projection. Redis validation tools stay development-only; generated Prisma clients and native runtime dependencies remain in the images.
- The server entrypoint (`apps/server/scripts/run-server.sh`) runs `prisma migrate deploy` on startup by default (set `RUN_MIGRATIONS=0` to disable). On Postgres, it retries on advisory-lock contention.
- Health-managed Postgres deployments use one pre-deploy Job running the prebuilt image's `/opt/happier/server/happier-server-migrate`, then start API and worker replicas with `RUN_MIGRATIONS=0`. The Job is independent of API probe deadlines. Source-built images use their provider migration script. Development 0.3 irreversible-migration admission remains owned by `apps/server/sources/app/runtime/updaterMigrationAdmission.ts`; a Kubernetes Job must not fabricate its updater capability or bypass refusal.
- Before a MySQL deployment first applies
  `20260729102000_add_voice_conversation_grant_provenance`, follow the
  maintenance-window, old-writer drain, trigger-authority/configuration, and
  definer-lifetime preflight in `docs/release-process.md`. The MySQL migration
  command fails closed unless that pending transition has exact operator
  admission and its live trigger prerequisites pass. A normal rolling
  entrypoint deployment is unsafe for that one non-atomic transition.

## Socket.IO Redis cluster transport

When `HAPPIER_SOCKET_ADAPTER=redis-streams` (or the legacy
`HAPPIER_SOCKET_REDIS_ADAPTER` boolean) is set together with `REDIS_URL`, the
API role joins a Socket.IO cluster through
[`@socket.io/redis-streams-adapter`](https://github.com/socketio/socket.io-redis-streams-adapter)
`0.3.1` in current development source; stable/preview deployment availability is
not established by this document.

Home Iroh composition is currently limited to a single serving API instance.
In unreleased 0.3 development source, a single API process using `redis-streams`
(including its legacy boolean alias) may declare `HAPPIER_HOME_IROH_HOLDER=1`
in that process's deployment environment. This process alone holds the persistent
endpoint key and runs Home Iroh. The declaration is process-local, restart-applied
and cannot be changed through Home settings. Exactly one process may declare
itself holder for a Home; never copy the marker to a replica-wide environment or
share a live endpoint key between processes. Startup logs the typed diagnostic
`iroh_holder_declared`; existing key-loss and EndpointId-drift refusals still apply.
The declaration is operator authority, not leader election or proof of exclusivity.

Without the marker, `redis-streams` stays HTTPS-only with
`iroh_multi_instance_unsupported`. Other processes remain HTTPS-only; they do not
serve or reconstruct the holder's Iroh descriptor. The default in-memory adapter
remains default-on. `HAPPIER_HOME_IROH_MODE=disabled` and the authorized Home
reachability opt-out still disable Iroh on the holder.

HTTPS-only descriptor publication requires eligible configured ingress, readable
continuity, and no incumbent Iroh publication. An existing committed Iroh descriptor
is not implicitly retired by topology unavailability: both feature projections may
omit the descriptor while retaining its continuity. Restore supported composition
or explicitly retire Iroh through its owner; do not reset continuity to force an
HTTPS-only publication.

Multi-replica followers reading the holder's full committed descriptor require a
persistence extension that is deferred to the first 0.3 cloud/alpha deployment.
An explicit holder currently supports the single-API-process redis-streams case;
it does not make discovery through multiple API replicas supported. A process
without the holder's committed facts must not retire or replace its Iroh identity.

Canonical socket-cluster owners:

- `apps/server/sources/config/socketAdapter.ts` — the one adapter option
  projection.
- `apps/server/sources/config/socketClusterRedis.ts` — the shared socket stall
  timeout and response/timer grace contract used by the projection and factory.
- `apps/server/sources/storage/redis/redis.ts` — the one socket-cluster Redis
  connection factory, its root accessor, and the adapter-facing client.
- `apps/server/sources/app/api/socket.ts` — the one `createAdapter(...)` call
  site and shutdown order.

### Two backplanes

| Traffic | Redis mechanism |
|---|---|
| Ordinary room broadcasts (connection-state recovery is disabled) | Redis Streams (`XADD`/`XREAD` on `socket.io`) |
| `fetchSockets`, `serverSideEmit`, `serverSideEmitWithAck`, broadcast-acknowledgement control traffic | Redis Pub/Sub (`socket.io#<namespace>#…` channels) |

Pub/Sub traffic is intentionally transient. A request published while Pub/Sub is
unavailable is never replayed after Redis recovers: the caller receives its
existing timeout/error and retries if the operation is still wanted. RPC target
discovery, external-action routing, and peer/tunnel coordination all consume
this path, so it is load-bearing beyond human presence.

In current 0.3 development source, RPC availability waits subscribe to method-room
joins through `socketRoomDiscovery.ts`. Local adapter joins and the closed
server-side `happier:socket-room:joined:v1` hint wake only that room's waiters.
Each wake reruns canonical discovery; the hint grants no authority and cannot
prove absence or single-client uniqueness. Untargeted `requireSingle` reads
still require a complete census. An ordinary wait has one grace-deadline timer
and no discovery poll. An admitted managed wake retains its existing
caller-currentness predicate checks, whose contract has no invalidation event;
those checks never trigger a census. Cancellation removes the subscription.
This server-internal hint requires the current API pool; it adds no client wire
fields, changes no RPC timeout, and is not a replay mechanism across a Pub/Sub
outage. Callers keep the existing timeout/error and retry contract above.

With Redis Streams adapter 0.3.1, membership comes from live Redis Pub/Sub
subscriptions (`serverCount()`), not adapter heartbeats. A nonresponsive peer
whose subscription remains connected counts toward a complete census and can
consume its full existing window. Closing that subscription removes it from
subsequent census membership.

### Development stack isolation

In unreleased 0.3 development, Stack derives `HAPPIER_SOCKET_ADAPTER_SCOPE` as
`hstack:<stack-name>` for `repo-dev-*` and `agent-qa-*` stacks. The server's one
adapter option projection appends this scope to both `streamName` and
`channelPrefix`: `socket.io:hstack:<stack-name>`. Ordinary broadcasts and RPC
census/control traffic therefore stay inside that stack on the existing Redis
instance. Source-mode remote placement projects the controller's scope before
assigning its target-local runtime identity; replicas of one stack share a scope.
API processes and split workers serving one stack must use the same scope.
Unscoped deployments retain `socket.io` for both backplanes.

This takes effect at each stack's next restart; changing source does not move a
running adapter. Restart repo-dev and the 0.3 `agent-qa-*` stacks through their
lifecycle owners. Old and restarted stacks can coexist: old processes keep their
shared scope while restarted stacks join only their own scope. Old stacks remain
exposed to each other's slow peers until restarted. The 0.2 stack is unchanged.
If Redis uses restricted ACLs, allow the scoped stream keys and Pub/Sub channels
in addition to the unscoped patterns below before restarting.

### Connections per API process

At `streamCount = 1` each API process holds **four** Redis connections, not one:

| Diagnostic `CLIENT` name | Purpose |
|---|---|
| `happier-socket-cluster:root` | Adapter `XADD`, `PUBLISH`, and `PUBSUB NUMSUB` commands |
| `happier-socket-cluster:adapter-1`, `happier-socket-cluster:adapter-2` | One blocking `XREAD` reader and one Pub/Sub subscriber; ordinals identify connections, not semantic roles |
| `happier-socket-cluster:relay-admission` | Exact peer-tunnel relay-grant admission claims |

The relay-admission connection reserves and commits one-time relay-grant claims
independently of the adapter's blocking reader and Pub/Sub recovery. It is not
another backplane or Redis pool.

Every adapter connection is built by the same factory, so each has independent
reconnect state, its own classified/rate-limited error diagnostics (`module:
redis-socket-cluster`, with the `connection` field naming the failing socket),
and command instrumentation. The names are diagnostics only; they carry no
authority. Size managed-Redis connection limits for four connections per API
replica, plus the separate application/worker connections.

The adapter owns the lifecycle of the connections it creates. Shutdown order is
`io.close()` (aborts the reader, disconnects the subscriber) → tunnel relay
coordinator close → `closeRedisSocketClusterClient()` (root only). Happier keeps
no competing duplicate registry.

### Fixed adapter options

`maxLen` (`HAPPIER_SOCKET_ADAPTER_MAXLEN`) and `readCount`
(`HAPPIER_SOCKET_ADAPTER_READ_COUNT`) remain the only operator tunables.
Everything else is fixed: `streamName`/`channelPrefix` `socket.io`,
`streamCount: 1`, `useShardedPubSub: false`, `onlyPlaintext: false`, and
`blockTimeInMs: 4_850` in current 0.3 development source.

The block is derived from the dedicated client's fixed 5,000 ms `socketTimeout`
minus ioredis 5.9.2's 100 ms finite-block response grace and the retry owner's
existing 50 ms stale-timer grace. The socket timeout and reconnect policy remain
unchanged. Both the configured and minimum supported adapter socket timeout are
5,000 ms; relay admission's separate 2,000 ms connection never runs this reader.
Compared with the former 100 ms block's nominal upper 600 empty returns per
minute per replica, the derived block permits at most 13. These are loop-derived
counts; Redis scheduling and transport overhead affect observed counts.
An arriving Stream entry releases `XREAD` immediately, preserving broadcast
freshness. Running servers adopt the change at their owners' next restart.

### Redis ACL

For Redis 6.2+ ACL users, the adapter-only rule tokens are:

```text
~socket.io &socket.io#*
+auth +info +client|setname
+xadd +xread
+publish +subscribe +pubsub|numsub
```

These are ACL tokens, not a shell command. Preserve other permissions required by
application Redis, worker streams and peer/tunnel coordination using `REDIS_URL`;
this is not a complete API-user ACL and must not replace one with `reset`.
`~socket.io` is the Stream key and `&socket.io#*` covers common request and private
response channels. Sharded commands (`SPUBLISH`, `SSUBSCRIBE`,
`PUBSUB SHARDNUMSUB`) and connection-state-recovery session keys are not required
by the active configuration.

The dedicated relay-admission connection uses the same API Redis credential but
has a separate, narrow command/key surface: `SET` for provisional claims and
`EVAL` scripts that read, update, or delete the exact
`peer-tunnel-relay-grant:v1:*` claim key. Grant the corresponding `SET`, `GET`,
`DEL`, and `EVAL` permissions plus that key pattern when server-routed peer
tunnels are enabled. Do not mistake those relay permissions for adapter
requirements or grant them to an adapter-only credential.

The command surface follows the pinned [0.3.1 adapter source](https://github.com/socketio/socket.io-redis-streams-adapter/blob/e4e38eb1065b04383749347f97b6442f60249a24/lib/adapter.ts)
and [Redis utilities](https://github.com/socketio/socket.io-redis-streams-adapter/blob/e4e38eb1065b04383749347f97b6442f60249a24/lib/util.ts).
A missing Pub/Sub permission can leave startup healthy while discovery degrades.
Check command failure metrics and Redis ACL denial logs and exercise a cross-node
query; do not assume every command rejection emits a `client_error` connection
log. Redis is trusted internal infrastructure: retain authentication, private
networking/TLS and least-privilege credentials because adapter messages have no
separate authentication or encryption.

### Upgrade and rollback: no mixed adapter generation

Adapter `0.2` and `0.3` nodes are **not** a supported serving cluster. A `0.2`
node publishes transient requests to the Stream while a `0.3` node publishes them
to Pub/Sub and answers on a private Pub/Sub channel, and `serverCount()` changes
from Stream heartbeats to Pub/Sub subscriber count. Ordinary broadcast bytes may
still cross versions, which makes the failure worse: RPC and tunnel logic can
conclude a live target does not exist.

- Single-node Home: ordinary process restart.
- Multi-replica: drain/stop the old Socket.IO API pool, confirm it no longer
  serves, then bring the new pool up as one compatibility unit.
- Confirm the ACL above before starting the new pool.
- Roll back with the same coordinated no-mix transition in reverse; never roll a
  single replica back while `0.3` replicas serve.
- Watch: Redis connection count (four per API replica), `redis-socket-cluster`
  diagnostics, RPC/tunnel outcome metrics, socket reconnect health.

A deployment with its own zero-downtime requirement needs separate old/new
load-balancer pools and isolated Redis adapter namespaces during cutover. That is
an operator topology decision; the application deliberately has no dual
`0.2`/`0.3` protocol.

### Validation recipe

Use `apps/server/sources/app/api/socket.redisStreamsAdapterCluster.integration.spec.ts`
for the real two-node adapter/ACL/restart/shutdown boundary, together with the RPC,
worker-emitter, tunnel and transfer suites for their current outer consumers.
A test's presence is not evidence that the current run passed.

In an isolated environment matching the target Redis version and ACL:

1. Connect clients to different API nodes and establish binary Stream fanout,
   remote discovery, server-side emit/ack, RPC and tunnel/transfer operations.
2. Stop Redis without restarting API nodes. Observe the current timeout/failure
   for an in-outage transient request; it must not hang indefinitely.
3. Restart Redis, wait for all eight transport connections to recover, and repeat
   those operations. Disconnect a remote socket and verify discovery removes it.
4. Shut down in production order and inspect `CLIENT LIST` with a separate
   operator credential. No socket-cluster or relay-admission connection may remain or reconnect
   after a grace interval longer than the five-second stale-timer boundary.
5. Repeat the full sequence twice; also exercise silent partition recovery and
   positive/negative restricted ACL cases. Do not grant administrative test commands
   such as `CLIENT LIST` or `ACL SETUSER` to the application's adapter credential.

`apps/server/scripts/validate.redisAdapterFanout.ts` creates two local test servers
against the selected Redis URL. It is an ordinary-fanout smoke check, not a probe
of deployed API nodes or certification of Pub/Sub/restart recovery. Use isolated
Redis: the script uses the same fixed Stream/channel names as the application.

From a development checkout, run `pnpm --dir apps/server run validate:redis-adapter`. Set
`REDIS_URL` to use an existing isolated Redis instance, or let the development
dependency acquire and start a temporary local instance. Root package configuration
defers acquisition until validation runs, so ordinary dependency installation does
not require Redis build tools.

### Prospective predecessor compatibility

On 2026-09-09, `../0.2` at `b23f95ed354e8d49183017e487bdb75f217017de`
declares adapter `^0.2.2` and resolves `0.2.3`. Its actual `socket.ts` calls
`createAdapter(getRedisClient())` with upstream defaults; `redis.ts` owns one
ordinary shared client. `config/socketAdapter.ts` and
`app/events/createRedisStreamsRoomEmitter.ts` do not exist there; adapter selection
is in `config/backends.ts`, and event routing uses the Socket.IO server through
`eventRouter.ts`/`connectionEventRouter.ts`. These inspected production and
lockfile paths have no staged or unstaged changes.

This source evidence requires the coordinated no-mix API rollout in both
directions. It does not certify a released artifact or deployment. The current
worker emitter's `uid`/`nsp`/`type` plus JSON `data` Stream envelope is accepted by
the pinned 0.3.1 decoder; the real emitter integration remains the deciding runtime
check. The adapter upgrade changes neither client handshake/events nor SQL state;
no client capability gate, persistence migration or dual-generation adapter is added.

## Kubernetes manifests
The canonical [Kubernetes recipe](../apps/docs/content/docs/self-hosting/docker.mdx#kubernetes) explains the examples in `apps/server/deploy`:

- `config.yaml`: explicit full/Postgres/S3, memory-adapter, single-process configuration; 0.3 canonical server identity is separate from ingress.
- `migrate.yaml`: one pre-deploy Job using the packaged migrator; create and await it before rollout. Migration admission can refuse an unsupported 0.3 upgrade.
- `server.yaml`: one `Recreate` Deployment and a Service on `3005`; numeric UID/GID 1000, startup/liveness `/health`, database readiness `/ready`.
- `happy-redis.yaml`: optional private-network Redis example for multi-replica deployments; not a default dependency.

Both migrator and server consume `happier-server-config` and `happier-server-env`; no External Secrets CRD is required. Pin the same validated image digest in both manifests. The metrics listener on `9090` supplies worker probes but is not exposed through the API Service. Database and S3 data are external; the pod's `/data` is temporary in this recipe and must be replaced by retained storage for SQLite or local files. Development 0.3 private Artifacts require a separate private S3 bucket, as documented above.

Keep `Recreate` for a multi-replica Redis API transition across adapter `0.2` and `0.3`: stop all old API pods before starting the new generation, including on rollback. The worker publishes the compatible Stream envelope and is not a Socket.IO discovery peer; its ordinary rollout strategy can remain. See the Redis cluster transport contract above. These examples and schema checks do not certify an unreleased 0.3 image or irreversible-data upgrade.

## Local dev helpers
The server package includes scripts for local infrastructure:
- `pnpm --filter @happier-dev/server run db` (Postgres in Docker)
- `pnpm --filter @happier-dev/server run redis`
- `pnpm --filter @happier-dev/server run s3` + `s3:init`

Use `.env`/`.env.dev` to load local settings when running `pnpm --filter @happier-dev/server run dev`.

## Host checkout requester authority (0.3 development)

Checkout-backed source acquisition belongs to `readDeploymentSourceIntentForHost`.
Before opening requester workspace rows or running Git in a local checkout, it
consumes the existing physical host requester identity decision. The custodian
and a verified Manage grantee on this Machine qualify for host checkout effects.
Use and unqualified requesters receive `agent_isolation_unavailable`.
Native and upload consumers propagate that refusal without another ownership
check. Stored definitions and workspace-free provider Git paths do not acquire
a checkout and are unchanged.

## Authored Domain and binding Actions (0.3 development)

`deployments.domains.add` accepts either authored `content` or prepared Artifact
references. Both forms use the same canonical Domain content schema. The installed
Domain owner reads authored content for review without publishing it, then creates
the invocation's private Domain candidate after Action admission, before native
discovery opens it. Home permits only that signed candidate and binds the prepared reference
back to the admitted routing metadata. Team content uses the Environment owner's
existing Artifact grant path. Refused Action admission creates no private content.

A Domain's reviewed Cloudflare Named selection also selects tunnel placement when
the Environment has no ingress setting. The Domain route-selection owner supplies
that effective ingress to both controller discovery and native setup. The selected
configure child must acknowledge the tunnel route and proxied DNS CNAME before
native activation can settle the Domain as active; a failed or unknown configure
result cannot be replaced by successful public Caddy activation.
The prepared body update carries the Artifact owner's matching revision provenance
and key envelope through the existing Artifact writer, keeping the new body readable
without changing the retained header.

After a template's Deploy succeeds, its Domain step invokes that same authored
Action through the admitted reviewed-child issuer. The existing signed child
proof carries the Domain-native projection, and Home binds its candidate to the
template's allocated Environment and exact child input. The template does not
publish private Domain content before child admission. The finite Deploy receipt
does not authorize generic Artifact publication afterward. Native failures retain
the canonical typed Home refusal and HTTP status through Domain settlement.

The shared UI API and deployment editor send `set` and `remove` to
`deployments.bindings.set`.
`prepareDeploymentBindingsForHost` owns applying the patch, preparing the private
Environment candidate and sealing its admitted secret uses. UI and agent callers
of that shared API do not publish those private candidates themselves.

For `deployments.environments.update`, the current content reference, revision CAS
and `patch.ingress` already express the authored change. The Environment content
owner opens the current private content and prepares the changed candidate after
Action admission. The same Action serves UI and agent callers. Home binds the
candidate to the admitted patch and CAS; dedicated binding, backup and template
fields remain unchanged by this ingress preparation. Cloudflare Tunnel accepts a
nonempty own-server member set; edge Caddy retains its two-Machine requirement.

For a failed Cloudflare Domain whose preparation was not saved, Remove derives the
current private origin through the same native observation and route-selection
owner as Add, then includes that service in the existing reviewed disable child.
The disable owner resolves the exact reviewed tunnel name in its reviewed account
without creating a tunnel. No matching tunnel completes remote cleanup. A match
removes only the owned hostname/path routes with that exact service and DNS CNAME
records at those hostnames targeting that tunnel; it keeps the tunnel. A foreign
route or DNS record returns `route_conflict`. An unavailable native origin returns
a typed refusal; a changed origin requires manual Remove after redeploy. Recorded
preparation continues to use its retained tunnel and ownership coordinates.

## Implementation references
- Entrypoint: `apps/server/sources/main.ts`
- Dockerfile: `Dockerfile`
- Kubernetes manifests: `apps/server/deploy`
- Env usage: `apps/server/sources` (`rg -n "process.env"`)

Publish keeps its Action operation nonterminal with `outcome_uncertain` (or
`stop_unconfirmed` after an observation abort) when its Workflow Run's terminal
outcome cannot be observed. Recovery retains the Run ID, Publish operation and
observed child operations; cancelling or recovering work targets that existing Run.

## Time-anchored investigation tasks (0.3 development)

The default Investigate task and guided automation tasks ask for the occurrence
time, exact attempt and source revision, retained before/after logs and metrics,
a code comparison, an alternative explanation, missing inputs and the next action.
The handoff carries owner-read addresses and retained time/attempt/revision references,
including a predecessor receipt when recorded, rather than log or metric snapshots.
Notice capture time remains distinct from occurrence time. Missing history must be
reported as unavailable; current health and vitals cannot reconstruct the past.
