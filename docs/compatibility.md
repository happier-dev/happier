# Compatibility and version skew

## Workflow audience review (unreleased 0.3)

The existing Artifact grant-list Action accepts optional `requestedAudience` and returns optional
`missingAudience`. The request, response and nested principal identity envelopes remain closed.
The management-only read resolves effective Team and Group membership through the ordinary
grant owner; omission preserves the ordinary roster read. Grant mutation inputs and receipts
keep their existing shape. Emitting the new review input requires matching development Protocol,
server and UI readers; older strict readers reject it. This introduces no persisted format,
migration, wire epoch, fallback or mixed-development adapter.


## Project Source Open progress (unreleased 0.3)

The Action operation domain-reference union adds `projectOpen`, carrying the
admitted Source id. Existing operation scope qualifies its Account and Machine;
the Home transport qualifies the server. Terminal list summaries retain that
association, while the existing full operation read supplies the canonical Open
result and actual checkout. Team progress joins the existing Project setup
observation without inferring readiness from `prepared`. Matching development
Protocol, CLI and UI readers reload together; older strict readers reject the
new union arm. No migration, store or compatibility adapter is introduced.


## Action Workflow triggers (unreleased 0.3, implementation in progress)

The existing trigger union adds `action`: a canonical Action set, `before` or
`after`, and one optional qualified subject. Before checks optionally select
`wait` or `notify`; only waiting checks accept `onFailure`. Actor consent uses
the same discriminator with a `consentFor` reference and reviewed Workflow
revision, rather than another matching trigger. The Account host keeps authored
subjects in the existing private trigger-definition envelope; the Home index
receives structural kind/key facts. Action occurrence evidence excludes raw
input, output, exception text and raw execution-origin objects.

The public Action result optionally carries `automationNotices` for unchecked
automations and skipped triggers. These typed notices preserve the original
Action outcome and contain code/reference facts rather than private failure
text. Matching result readers must preserve them through deferred approval and
terminal result projection; presentation stays with the Action message owner.
The closed external Action HTTP and reverse client-invocation response schemas
carry the same optional notice array on success and failure. Their matching
development readers reload together; no separate notice vocabulary or adapter
is introduced. The reverse request optionally retains the sending host's existing
`actionRequestId` so the answering UI settles that invocation. It carries no
automation admission token or caller authority.

Protocol, Home, CLI and UI strict readers need the matching development union.
These are unpublished development contracts, with composed validation still in
progress; they do not establish released availability. Existing trigger kinds
retain their meanings. The ordinary Automation Run occurrence and cause owners
admit Action events; an Action declaring deferred completion uses its terminal
domain event instead of treating its accepted handle as completion.

An after-Action trigger remains one row and revision. Existing terminal Event
declarations name their completed Actions and map their terminal state to the
safe `outcome` field (`succeeded`, `failed`, `cancelled` or `outcome_unknown`).
An Only-when filter on that field stays in the private trigger definition;
the structural index does not receive it. No combined Event is introduced.
Accepted V2 operations and deployment receipts retain the admitted Workflow
origin separately from the approver, so terminal admission applies the ordinary
ancestor loop rule. The V1 operation projection omits that provenance field.

## Workflow authoring discovery (unreleased 0.3)

The existing Action discovery read accepts optional `purpose: 'workflow_step' |
'automation'` and nullable `limit`; omission preserves ordinary discovery.
Matching development Protocol, CLI and UI readers consume these authoring
summaries together. This changes neither execution admission nor persisted
state and introduces no compatibility adapter.

## Session preset carrier admission (unreleased 0.3, implementation in progress)

A Session selected from a shared Machine preset can reach that preset's hidden
controller through the existing preset admission owner. The prompt-free Session
admission optionally carries `managedPresetAcquisition`: only the selected
Home/preset/revision and controller Machine/installation. Home admits that pair
once and retains the canonical preset metadata, mode-tagged content, recipients
and delegation in the signed root's `sessionPresetAcquisition`. The installed
receiver compares the public pair with the opened Session input; its existing
Home verifier authenticates the full supplied binding against the token before
the snapshot is consumed. Encrypted preset content stays opaque to Home.

The reviewed resource-bound acquisition consumes that admitted snapshot without
mutable preset or Group admission reads. Archive and edits apply to the next root;
the admitted creation retains its revision and policy through first allocation.
Capacity is measured by the allocation owner. Direct controller launches keep
their existing Machine authority requirement.

Matching development Protocol, Home, CLI and UI readers must reload together;
older strict readers reject these optional fields when present. No migration,
new grant, proof format or route is introduced. Composed validation is pending.

## Workflow command JSON input (unreleased 0.3)

The closed `machines.command.run` input accepts optional strict JSON `stdin`.
The CLI serializes that value once as UTF-8 JSON through the existing Bash RPC
and process input adapter, closing stdin after delivery. Native identity launches
retain their launch frame before the command's input bytes. Literal command text,
declared environment values, cancellation and output contracts are unchanged.
Older inputs without `stdin` remain valid; matching development Protocol and CLI
must reload together because an older strict reader rejects the new field.
This is an unpublished 0.3 direct cut without a migration, epoch or adapter.
The inspected `../0.2` frontier at
`87aaa83f6b81c92a4ceee5816df2e566ed429bc7` has no Workflow command schema.

## Prepared image freshness (unreleased 0.3)

Prepared images bind authored launch, setup, reviewed source contents and selected
Connected Account configuration revisions. Preset row revisions are CAS facts,
not image freshness. The private binding reader accepts and discards the retired
`presetRevision` field in retained development rows; new bindings omit it. The
supplier CLI identity remains build provenance. A CLI-only change selects the
same warm image with private `preparationExecution.updateCli: true`, and the
existing guest installer replaces the CLI during admitted Session startup.
Launch or setup changes still select a cold launch. The optional encrypted
`preparation.whenHappierUpdates` preference defaults to `update-at-start`.
`rebuild-automatically` requests the existing finite Prepare on first use after
a supplier CLI identity change only when the Session starter can Manage the
preset. It uses that person's admission and the existing cost review. Team Use
members retain the warm launch and CLI replacement. No author authority is
borrowed, and no timer, poller or separate preference store is introduced.
Foreign controllers holding only the existing codec also retain the warm image
and CLI replacement, including when the starter can Manage: that custody contains
no requester sign-in for a fresh Prepare admission.
The inspected prospective 0.2 frontier `cfbc463ba8` has neither
managed preset nor prepared-image schemas; no predecessor wire adapter is added.

## Preset configuration counter (unreleased 0.3)

The canonical client preset authoring owner writes optional public
`configurationRevision` separately from the preset row revision. New presets
start at zero; absent legacy counters mean zero. Only authored launch or setup
changes advance the counter. Display names, Keep rules, preparation state and
the supplier CLI identity leave it unchanged. The server receives no content
digest or cross-preset equality key.

Updates compare opened incumbent content at the exact expected row revision;
unavailable incumbent content fails closed. Matching development Protocol,
client and server readers deploy together: older strict development inputs
reject the new field, while new readers accept its absence. The prospective
0.2 frontier described above has no managed preset contract. No released wire
epoch, compatibility adapter or migration is added by this client carrier.

The server persists the authored integer and captures it as an immutable
`preset.configurationRevision` on each new managed admission. Shared-kept idle
reuse matches this counter within the selected preset; ordinary row revisions
continue to identify Action selections and CAS writes. The append-only server
migration initializes preset counters to zero and seeds a retained Machine's
nullable snapshot only when its Home, preset id and admitted preset revision
match the current preset row. Older or missing snapshots remain unknown and
cannot be reused; their rows and opaque content are preserved.

## Workflow trigger Event references (unreleased 0.3)

The closed Workflow value-reference union adds `trigger_event`, and the private
accepted snapshot optionally carries sealed `triggerEventValues`. Existing
snapshots without the field read unchanged. Closed create/update inputs optionally
carry intended trigger locators, and private Event declaration reads expose the
current payload schema. The Event identity accepts qualified plugin refs or
`{ kind: 'action', phase: 'before' | 'after' }`. Action declarations share the
canonical safe Run-evidence schema across the trigger's selected Action ids;
the payload retains the actual invoked Action id. Admitted Action causes supply
only those safe scalar values to the existing private snapshot materializer.
Raw operands, output and exception text have no declared Event path.
Matching Protocol, Home, CLI and editor consumers reload
together under the unpublished 0.3 direct cut; older strict development readers
reject these new fields. No epoch, migration, gate or compatibility adapter is
added. The scoped-clean 0.2 frontier at
`253d4138e2a19c777fd7df027e5b35be3a769002` has no Workflow reference owner.

## Simulator device Actions (unreleased 0.3)

Simulator discovery optionally carries device state, runtime identity, AVD name,
supported device operations and hardware-button subsets. The daemon's platform
inventory owns these facts; capture availability is independent of whether a
device can boot or accept a platform command. Device Actions use closed operation
inputs and typed results. Screenshot Actions return an image through Session
media; the old stream snapshot Action takes the same device/screenshot input.
Frame refresh remains the keyframe Action. The retired raw preview snapshot event
is refused rather than acknowledging a keyframe as a saved screenshot.

Matching Protocol, SDK, CLI and UI reload together under the unpublished 0.3
direct cut. Earlier strict development readers reject the new discovery fields,
and earlier callers of the snapshot Action must migrate their input. This adds no
persisted format, database migration, wire epoch or compatibility adapter.

## Managed guest carrier diagnostics (unreleased 0.3)

Managed guest Home failure details and provider observations optionally retain
`carrierFailure`: the existing closed carrier/reason vocabulary, including the
unavailable Iroh attempt preceding HTTPS. The guest diagnostic boundary removes
private fields before reporting; retained observations and Details carry no
addresses, URLs or keys. Older records without this diagnostic remain readable.
Matching Protocol, controller and UI reload together under the unpublished 0.3
direct cut; older strict development readers reject the added field. This adds
no database migration, routing authority, wire epoch or compatibility adapter.

## Cloudflare tunnel retirement provenance (unreleased 0.3)

Private Domain content optionally records closed `cloudflarePreparation.tunnelOwnership`
as `created` or `adopted`. Existing records without it remain readable and are
retained without inferring ownership from a tunnel name or another Domain. The
closed Domain mutation success optionally carries `tunnel`, whose `removed` or
`retained` disposition includes the exact ID when known and a typed retention
reason. Matching Protocol, deployment-protocol, Cloudflare plugin and CLI readers
and writers reload together under the development direct cut; older strict 0.3
readers reject the added fields. The scoped clean `../0.2` frontier at
`c680de922e4475b7dfbaeedcd63a8af7d985d3c3` has no deployment plugin contract. This
adds no database migration, released wire epoch or compatibility adapter.

## Attempt configuration drafts (unreleased 0.3)

Accepted attempt configuration now persists in the existing sealed transaction.
Manual and active OAuth/device transactions retain their existing staged content
and revision fields. Before OAuth/device authorization, a previously null payload
can hold `{ configuration: { revision, content } }`; continuation replaces that
draft with the ordinary authorization snapshot. Existing null drafts remain
readable. Matching configuration readers and writers reload together under the
unpublished 0.3 direct cut; this changes no database schema or released 0.2 format.

## Native firewall recovery commands (unreleased 0.3)

`MachineFirewallRecoveryV1` optionally carries closed `restore: { capturedAt,
commands }` material. The native firewall owner derives the ordered restoration
program once from its captured snapshot; native undo executes it and the recovery
card displays its POSIX commands with a translated capture-time basis. Existing
foreign-effect checks and restoration verification stay at the native owner.
Historical records without `restore` remain readable and are not backfilled or
interpreted by the UI. Matching Protocol, native CLI and UI reload together under
the unpublished 0.3 direct cut: older strict development readers reject the new
field. No wire epoch, compatibility adapter or database migration is added.

## Home guest CLI source (unreleased 0.3)

`/v1/features` advertises optional `capabilities.guestCli` with the closed identity
`{ source: 'home-payload' | 'public-release', line: 'major.minor', channel: 'stable' | 'preview' | 'publicdev' }`. This selects
installation artifacts; it is independent of feature enablement and the server's
diagnostic package version. The current program line is explicitly `0.3`.
Development source builds select Home payloads; released server binaries and
Docker images select public releases. Updated managed installers require this
identity, choose the newest published CLI on its line and channel through exact
signed acquisition, and refuse an installed-version downgrade. Missing or malformed
identity refuses with `guest_cli_identity_unavailable`, including on an older
Home that has not gained the producer; no version-based fallback is inferred.

Source-built Dev/QA Homes may opt in to HTTP payload export with
`HAPPIER_DEV_GUEST_CLI_EXPORT=1`; the default is off and released builds compile
this capability out. Their identity may additionally carry `payloads`, each with
its canonical guest build target, exact archive-byte SHA256 and Home URL/path.
Home captures its own list once in the existing admitted Create input; requester
copies have no authority. The native target probe selects one entry from that frozen list; the guest verifies
its pinned SHA256 before extraction or execution and uses ordinary payload
promotion. Explicit Update/Retry captures a new Home-issued list without changing
the Create pin: a Machine root uses its signed managed admission, while an Account
root uses its existing authenticated controller-context response.
Approval replay reuses the already bound input. Neither download rereads live
Home metadata nor silently substitutes a public release. Missing target archives
refuse with `guest_payload_missing`. Controller-local payload installation remains
available when HTTP export is off.

The capability root is additive: released 0.2 readers discard the unknown family.
The identity and archive descriptors are closed because they select executable
artifacts. Matching unreleased 0.3 server and controller/app consumers reload
together. This extends existing admission JSON and adds the source-only payload
endpoint; it adds no table, migration, signing authority or SDK epoch.


Home identity readiness retains the existing unsupported-feature refusal codes
`HOME_FEATURES_UNREADABLE` / `HOME_FEATURES_ENDPOINT_MISSING` as non-retryable
connection failures. A successful HTTP response does not establish protocol
compatibility. The daemon settles these failures with the same typed reason;
it does not replace its executable or reinterpret them as authentication errors.
A development Home without HTTP export still requires its controller payload for managed recovery.

## Managed guest Home network context (unreleased 0.3)

Local provisioner `guestHome` input optionally carries closed `hostIdentity`
facts (Home and controller machine hosts). Devcontainer realization retains
optional `homeOnControllerHost: true` in resources and uncertain-acquisition
references. Native bootstrap carriers can carry the diagnostic hint
`homeNetworkHint: 'authored_network'`; confirmed Home reachability failures
retain it as optional typed `reason` without changing their failure code.
Existing inputs and resources that omit these facts remain readable and keep
their previous network default. Protocol, SDK, provisioner declarations and CLI
reload together under the unpublished development direct cut: earlier strict
development readers reject the added fields. No migration, wire epoch,
compatibility adapter or released format changes.

Agent install failed outcomes optionally carry the existing `ActionFailureCauseV1`
as `failureCause`. The download owner projects the original transport cause;
machine/member job transports and the UI consume it without a second classifier.
This additive field follows the same unpublished 0.3 direct cut: Protocol, CLI
and UI reload together because older strict development readers reject it.
No new failure-code vocabulary, persistence table or migration is introduced.

## Managed Machine creation provenance (unreleased 0.3)

The separate Machine `isolationPolicyV1` stored policy uses the Protocol leaf
readers in `machines/machineIsolationV1`. Missing policy reads as absent and the
native Agent sandbox preference defaults OFF. Stored readers drop unknown fields
but reject malformed present policy; callers must surface metadata unavailable
rather than treating invalid policy as Directly. The optional provisioner
`sessionPlacement` declaration remains closed, including its existing predicate
grammar, and is not safely ignorable by placement consumers. SDK and host
declarations move together under the unpublished development direct cut. The
optional provisioner `preparation` declaration and its build/inspect/destroy
role schemas follow the same cut: older strict readers reject the declaration;
the SDK and host publish the canonical qualified-reference contracts together.
This contract declaration does not supply the preset operation's effect custody.
Preparation failures and retained preparation state may carry the existing
typed `nativeCause`. Code-only results remain valid; a later observation without
a new cause preserves the original failure diagnostic until readiness or
confirmed cleanup. This optional field follows the same unpublished direct cut:
Protocol, SDK, preset owner and CLI host reload together; older strict readers
can reject it. It introduces no new error vocabulary or persistence migration.
The scoped clean `../0.2` frontier at
`c680de922e4475b7dfbaeedcd63a8af7d985d3c3` has none of these declarations; reverse development
SDK writes remain unsupported. Package SemVer and the existing author-contract
epoch are separate; this addition introduces no new epoch or migration.

Provider-authored bound acquire results carry optional `resource.origin: 'created'`
through the existing retained resource, including opaque preset content. Creation
enrollment seeds Machine metadata `isolationV1: { environment: 'managed-guest',
provisionerId }` only while the field is absent, in the same metadata CAS as default
roles. `provisionerId` is the qualified plugin contribution identity. Created Lume
VMs receive the fact even with personal/existing-user enrollment; adopted hosts and
Account-native or SSH enrollment of existing hosts carry no origin and gain no fact.

`readMachineIsolationV1` in Protocol `machines/metadataUpdate` reads opened Machine
metadata and returns the fact or `null` for missing/unreadable provenance. Missing
provenance retains the host sandbox default. Matching Protocol, SDK projections,
provisioners and daemon Action hosts reload together under the unreleased 0.3 direct
cut. The optional field reuses existing resource/metadata persistence; it adds no
table, migration, settings key or compatibility epoch.

## Connected Account Team-share constraints (unreleased 0.3)

Connected Account UI projections may carry `nativeLoginRequiredBy`, a closed
list of qualified Agent identities and declared display names. The Team
credential demand owner derives it from existing Agent Provider requirements
and qualified Connected Account purposes; it is presentation metadata and
grants no broker, credential or execution authority. Older projections omit the
field and remain readable. Matching Protocol, CLI and UI source deploy together
under the development direct cut because earlier strict development readers
reject the added field. No persisted record, authored plugin declaration,
release wire epoch, migration or compatibility adapter changes. The inspected
0.2 frontier `008450323b7baf3a499de4d80042046cd7d89bd3` has no
`connect/connectedAccountUiProjectionV1.ts` counterpart.

## Session authoring open (unreleased 0.3)

`session.authoring.open` remains the admission owner for first-party, agent and
MCP New Session entry points. Its source-Session input additionally accepts a
`seed` of editable changes, a `replay` cutoff using `SessionForkPointSchema`, and
`connectedServices` using the canonical binding ingress schema. The client reads
the source from its captured Home and Account, copies configuration through the
existing authoring adapter, and leaves creation to the composer's explicit Send.
Embedded UI callers supply only private navigation and draft-identity ports after
admission; these callbacks never enter Action input or approval custody.

This is an additive change to the unpublished 0.3 Action input. Existing seed-only
and source-address-only requests remain valid; producers and strict development
readers deploy together. No persisted document or released 0.2 wire format changes.
Post-launch Pool recovery restores already-admitted draft custody and is the sole
internal seed-opening exemption, scoped by the parity walker to that callback.

## Plan Action round context (unreleased 0.3)

`subagents.plan.start` accepts optional JSON `previousRoundContext`. Its Action
executor adds that context to the planning request before the plan-intent profile
runs. Plan with a panel binds its retained round context to this input; omission
or `null` keeps the request unchanged. This input affects planning semantics and
is not safely ignorable: matching Protocol, CLI and generated SDK source reload
together under the unpublished development direct cut. The existing Action
envelope and detached-target object remain closed; the context is opaque JSON
data and grants no identity, authority or routing meaning. No migration, wire
epoch, capability gate or earlier-development adapter is added.

## Failure cause carriers (unreleased 0.3)

Execution-run Action completion observations and review, plan and narration terminal
values retain optional `runtimeIssueV1`. External-linked takeover operation errors
and owner progress retain the same optional metadata. The existing runtime issue
reader and metadata projector own parsing and content-free publication. Existing
records without the field remain valid. Protocol and CLI reload together; older
strict development readers may reject the added field. These unreleased 0.3
contracts receive no compatibility adapter or migration.

## Stored App Preset Domain selections (unreleased 0.3)

Catalog App preset intent accepts optional root `domainBindings`, using the
same closed `{ templateDomainId, hostname }` selections as ordinary template
instantiation. Setup retains them through source copies and capture, forwards
them to template preparation and rejects a reviewed child whose selections
differ from the saved intent. The template owner still validates declared ids
and hostnames. Existing presets without selections remain readable unchanged;
required Domains still need an explicit hostname. Compose App intent does not
accept template selections. Matching Protocol, daemon and preset readers reload
together; earlier strict development writers reject the added field and older
stored readers may drop it. The inspected `../0.2` frontier
`c8867dad513ef489183953878c084d660fbe0653` has neither affected Protocol module.
No migration, wire epoch or compatibility adapter is added.

## Machine OS-update check time (unreleased 0.3)

The closed `MachineSetupUpdatesObservationV1` admits optional `checkedAt`, Unix
epoch milliseconds when the native inspector completed its last successful check.
The daemon publishes it with the existing update observation; unavailable checks
retain the previous successful time alongside last-known counts. Reads never
refresh it. Older stored observations without a time remain valid and mean not
reported. Protocol, native producer, daemon and UI's shared stored reader reload
together under the unpublished 0.3 direct cut; older strict development readers
reject the added field. The scoped-clean `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has neither the setup observation schema
nor native update inspector. No epoch, adapter, polling or extra state owner is added.

## Saved finite health results (unreleased 0.3)

The canonical result schema admits optional typed `cause` facts. Current finite
producers write those facts directly and leave Forge evidence as readable prose.
The nested cause and enclosing result use the health Action's recursively closed
publication contract. Checkpoint and inventory persisted reads derive
`createProtocolStoredReadSchema` from their canonical schema: known facts validate
and unknown stored diagnostics are removed. No cause fact grants routing or execution authority.
Older stored results without `cause` remain readable. The existing health
checkpoint also admits optional recent samples, coverage and failed-streak facts;
an absent sample collection means that checkpoint did not record history.
Protocol, SDK facades, finite producers and checkpoint readers consume the same
schema in the coordinated development reload; there is no second JSON-in-text
decoder or independent probe runner.

## Machine managed-service summary (unreleased 0.3)

Machine daemon state optionally publishes `managedServices: { running, failing }`
from the same retained row owner as `machines.services.list`. Running counts native
rows whose phase is `running`, or healthy/unhealthy non-native processes. Failing
counts the row owner's down/degraded health verdict except expected downtime,
or unhealthy processes when no health verdict exists. Unknown rows contribute
neither count. Dev-server `localServices` remains a separate inventory.
The summary reads admitted inventory without initiating discovery or recovery;
existing lifecycle row changes push updates, and reconnect republishes the current summary.
Missing summaries mean not reported. Strict publication accepts only nonnegative
integer counts; stored readers discard a malformed optional summary while keeping
other Machine facts. Matching 0.3 Protocol, daemon and UI reload together. This adds
no poller, inventory store, migration, permission decision or compatibility shim.

## Daemon Voice inference failure causes (unreleased 0.3)

Inference RPC errors and TTS stream error events accept optional `failureCause`
through the existing content-free `ActionFailureCauseV1` schema. Native runtime
loading and audio decoding retain their causes; worker IPC and RPC projection preserve
typed phase, class, closed native codes and HTTP status without publishing
exception text or arbitrary native code strings. Authored typed causes retain
their declared codes.
Replies without a cause remain valid. Matching 0.3 daemon and UI peers reload
together; no persisted format, error-code vocabulary or retry policy changes.

## Agent preflight failure causes (unreleased 0.3)

Capability invocation errors accept optional `failureCause` using the existing
Session runtime cause contract. Native preparation retains its original cause;
the capability invocation owner projects otherwise unclassified exceptions
through the same runtime cause owner. CLI and UI inventory Actions carry this
runtime diagnostic in their existing opaque `details.failureCause` field.
Replies without a cause remain valid. Matching Protocol, daemon and UI peers
reload together under the unpublished 0.3 direct cut. No persisted format,
released SDK contract, retry policy or compatibility adapter changes.

Model and configuration preflight observations also retain optional
`failureCause` through their existing strict observation schemas and the SDK's
ACP session-controls result. A refused configuration refresh keeps the accepted
catalog and original native diagnostic. Existing observations without a cause
remain valid. Matching SDK, Agent plugins, Protocol, daemon and UI peers reload
together because older strict development observation readers reject the new
field; no released predecessor adapter or persisted format is added.

Passive realtime setup results retain optional `failureCause` through the
existing Action cause schema while preserving their setup status. Native
exceptions expose only closed diagnostic codes, class, phase and HTTP status;
authored typed causes remain authoritative. The SDK derives this result from
Protocol, and matching development peers reload together.

## Retained resume refusal causes (unreleased 0.3)

Pending discard requests accept optional `errorDetail` only as the closed,
content-free `PendingDeliveryFailureCauseV1` (kind, codes and enums); the route
rejects launch prose, child stderr, cwd, profile ids and free-form diagnostics
with 400. The CLI projects its local spawn detail into that cause before
settlement; its public send error details keep the full local detail. The server
persists a nullable `deliveryFailure` JSON field and projects typed `failure` on
retained inputs; UI uses the existing typed-error presentation. Existing rows
without a stored cause, or with a stored detail that is not the closed cause,
remain visible as generic failed inputs when their recorded reason is
`resume_failed`. User discards remain distinct.
Apply the new PostgreSQL, SQLite or MySQL additive migration before reloading
the server, then reload matching 0.3 daemon and UI peers together. No released
SDK contract, reply-observer state, ciphertext, feature gate or retry changes.

## External Session import refusal causes (unreleased 0.3)

The SDK transcript Item, host admission and canonical Protocol source Item accept
absent `createdAtMs`. Present timestamps still pass the same safe nonnegative
integer validation. Native page/read-after and secure-refresh responses share
that source Item schema; UI display placement does not fabricate source time,
and attention derives only from known source times. Terminal-follow runtime
events use host emission time when native creation time is unknown. Muse uses
this for Tool calls whose original creation time is unknown; plugin and host reload together under the unpublished
0.3 direct cut. Native tool results retain their observed revision time. Strict
older development UI readers require a reload to accept untimed native calls.

Repeated E2EE historical preparation now consumes the existing keyed message
idempotency primitive with the destination Session and stable historical id.
This preserves ciphertext for equal content across page windows; changed content
and destinations remain separate. Previously prepared staging stays immutable;
a fresh capture is required for an interrupted pre-fix operation with conflicting
repeated records. No ciphertext migration or server equality weakening is added.

Private operation errors and owner progress accept optional `publicationErrorCode`
from the existing historical socket refusal vocabulary. Older records without it
remain valid. Matching Protocol, CLI and UI development peers reload together;
older strict 0.3 readers reject the added field. The current `../0.2` frontier has
no `packages/protocol/src/sessions/external/operationV1.ts` counterpart. No server
command, migration, capability or retry behavior changes.

## Retained Provider helper models (unreleased 0.3)

`ProviderRuntimeBindingBasisV1` retains optional `roleModels` through the existing
closed role-model schema. The authorization projector writes the admitted roles;
managed Agent materialization consumes them with the prepared adapter binding key.
Earlier records without roles remain valid. Records prepared without roles keep
that behavior; a historical Claude record whose retained basis lost its prepared
roles requires a new launch through current authorization. Protocol and CLI
daemon/Runner peers reload together because older strict development readers
reject the added field. The inspected `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no counterpart at
`packages/protocol/src/providers/sessions/bindingMetadataV1.ts`.
No migration, capability, compatibility adapter or new storage owner is added.

## Provider broker refusal causes (unreleased 0.3)

Broker admission and finite Action refusals accept optional `failureCause` using
`ActionFailureCauseV1`. Broker producers retain their original closed refusal
code and source-open reason; consumers project the sanitized cause through the
existing Provider error owner. Replies without a cause remain valid. Matching
Protocol and CLI broker peers reload together under the unpublished 0.3 direct
cut because older strict development readers reject the added field. The scoped
`../0.2` frontier `dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no
`packages/protocol/src/providers/brokerRouteGrantV1.ts` seam. No persisted format,
new capability, retry, or released compatibility adapter is added.

The existing Session runtime cause also accepts optional `actionCause`, using
that same Action carrier. Its reader translates Provider and broker causes at
the phase supplied by the launch or turn owner while preserving the full
sanitized original, including an uncoded error class. Native recovery fields
and older causes without `actionCause` remain valid. The synchronized 0.3 reload
also covers Session runtime issue producers and readers; earlier strict
development cause readers reject the added field.

Provider errors also accept optional `connectedAccountTarget`, reusing the
canonical qualified Account/Pool selector for exact source recovery. Missing
targets remain valid; matching 0.3 daemon/UI readers load together because older
strict development readers reject this field. The scoped `../0.2` frontier
`008450323b` has no `providers/errors.ts` seam. This changes no stored format,
wire epoch, or released compatibility adapter.

The CLI's strict Runner/daemon service refusal envelope also accepts optional
`error.failureCause` with `ActionFailureCauseV1`. Provider model-transition,
managed-binding and broker-binding writers retain the cause through their
existing error codes, and Runner consumers preserve it through the existing
Provider or Session error carrier. The matching 0.3 Runner and daemon reload
together; older strict development readers reject the field. The scoped
`../0.2` checkout has no
`apps/cli/src/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol.ts`
seam. This changes no persisted format or released SDK contract.

Runner launch-readiness responses accept optional `failureCause` using the same
Action carrier: the strict HTTP 200 root response and existing HTTP 403/503 error
payload retain it through the terminal launch error. HTTP statuses and the
resource-readiness domain schema keep their existing meanings. Protocol, daemon
and Runner refresh together under the unpublished 0.3 direct cut; older strict
development readers reject the added root field. The scoped `../0.2` frontier
has no `packages/protocol/src/teams/credentials/readinessV1.ts` seam. No persisted
format or compatibility adapter is added.

## Runner endpoint-read causes (unreleased 0.3)

The existing unavailable results for Runner managed-service endpoint open and
body reads accept optional `failureCause`, reusing `ActionFailureCauseV1`.
Captured endpoint/environment failures retain their sanitized cause through the
daemon and exact-handle Runner consumers. Status, no-result guards, cancellation
and replies without a cause are unchanged. Runner and daemon readers reload
together under the unpublished 0.3 direct cut; older strict development readers
reject the added field. This is the current CLI process seam, with no separate
released predecessor or persisted representation to migrate.

## Triage task creation places (unreleased 0.3)

The source contribution V1 epoch adds optional `listCreationPlaces`; package
versions remain independent. Its request, page/failure union, places, create
operands and nested refusals are closed objects. Sources without the operation
remain admitted. The existing create request accepts optional source-owned
`placeId`, forwarded by Triage unchanged and interpreted by Jira inside its
configured project selection; omission keeps configured create defaults.
Matching source plugins, Triage and protocol readers load together under the
unpublished development direct cut; no persisted format, wire epoch, gate or
adapter changes. The scoped-clean `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no triage-protocol package.

## Triage source caller diagnostics (unreleased 0.3)

The source-administration `invalidCaller` result accepts optional `admission`
operands: caller kind and plugin/contribution identifiers, invocation surface,
and candidate count. The resolver produces these from its existing admission
snapshot; authorization and stored source-instance formats are unchanged.
Matching Triage protocol, plugin and UI source reload together under the
unpublished 0.3 direct cut; older strict development readers reject the added
field. The inspected scoped-clean `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no `packages/triage-protocol`
package or corresponding caller-source implementation. No adapter is required.

## Domain-filtered Session selection (unreleased 0.3)

The V1 Host API `selectActionInput` Session-address request accepts optional
`sessionCandidates`, a list of closed `{ serverId, sessionId }` addresses from
the requesting domain's eligibility owner. The request, host-action literal and
address objects stay closed; unknown fields are rejected. The native picker
projects that set through its existing Home, visibility and input-access rules.
It does not decide Triage's workspace or repository eligibility or grant Send
authority. Omission preserves existing reference selection; an empty list offers
no recipient. The SDK type is derived from the Protocol schema.

This field is not safely ignorable: ignoring it would offer ineligible targets.
Matching Protocol, SDK, plugin and host source reload together under the
unpublished 0.3 direct cut, within existing Host API wire epoch1 and independently
of npm package SemVer. Earlier strict development readers reject it, rather than
silently opening an unrestricted picker. No persisted format, new capability,
adapter or runtime union is introduced. The inspected `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has neither scoped Host API file nor
working changes to `packages/protocol/src/plugins/ui/hostApiRequests.ts` or
`packages/plugin-sdk/src/ui/hostApi.ts`; no reverse-development adapter is added.

## Turn publication refusals (unreleased 0.3)

Home retains the existing Team binding rejection code and its canonical reason
in socket and HTTP mutation failures. The CLI preserves that cause through Turn
publication and ends the input's Pending settlement. Readers also settle a final
rejection without a reason, retaining an unknown cause rather than inventing a
withdrawal. The new Pending presentation reason `team_access_removed` maps to the
existing Send rejection `session_input_unauthorized`. A committed user row does
not end delivery observation: Send keeps following Pending to settlement. A
retained Team refusal does not fence fresh input after regrant or automatically
retry the refused original.

Home, CLI and UI refresh together under the unpublished 0.3 direct cut. The
Pending reason is a bounded presentation addition, with no new authority,
admission, persistence field or migration. The inspected `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no Team binding contract or
scoped working change at the corresponding paths.

## Team broker job activity (unreleased 0.3)

The existing opaque V1 `brokerPlacementFingerprint` in a signed Team broker
admission binds both placement and the admitted `TeamCredentialResource.revision`.
The Home's active-job lookup compares that binding with the resource row; a
changed revision refuses the next request without re-evaluating source or Team
permissions. Grant withdrawal advances the revision in its existing transaction.
Already-open response bodies finish, and affected recipients start again to
obtain a fresh admission, including recipients unaffected by the withdrawn grant.

Home and custodian refresh together under the unpublished 0.3 direct cut.
Earlier development admissions fail the new fingerprint comparison and require
a fresh Start. There is no new wire field, persisted format or migration. The
inspected `../0.2` frontier `dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf`
has no Team broker admission or route-grant contract at the corresponding paths.

## Machine-service usage history (unreleased 0.3)

The existing `machines.vitals.history.get` accepts optional `serviceId` from a
Machine Services row. A selected read includes `service: { serviceId, points }`;
each point carries `t`, `cpuPercent`, `cpuMaxPercent`, `memoryBytes`, and
`memoryMaxBytes`. Missing buckets and unavailable counters remain null. CPU uses
the native accounting scale and may exceed 100% across cores. The series uses
the existing 1h/24h/7d minute, five-minute, and thirty-minute buckets.

The daemon samples already-admitted service handles at the vitals owner's
existing minute boundary and persists optional service samples in the same
seven-day local journal. History reads never sample or discover services; visibility joins the existing
Services projection, including its first-use restoration.
Older minutes without samples remain readable as gaps. Ordinary Machine history
never includes the journal's service samples. A filtered read requires a current
service visible through the Machine Services disclosure owner; removed services
are unavailable through this read, even while their samples remain retained.
Monitoring Off and on-demand monitoring retain the vitals owner's behavior.

Protocol, daemon and consumers refresh together under the unpublished 0.3 direct
cut; old strict development readers reject new operands rather than ignore the
filter. All request, response, point and service envelopes remain closed.
There is no new wire epoch, database table, migration, sampler or polling path.
The inspected scoped-clean `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no scoped Machine vitals contract.

## Machine-service advisory selection (unreleased 0.3)

The closed `machines.services.list` input accepts optional `preflight` selectors
for published ports and adapter-qualified native resource names. Selected
snapshots carry optional `coverage: 'managed_services'`; omission is unknown,
never proof of whole-Machine clearance. Protocol, daemon and app readers refresh
together under the unpublished 0.3 direct cut. Earlier strict development readers
reject the new fields; selectors are not safely ignorable. Existing requests and
snapshots remain accepted, with no persistence, wire epoch or authority change.
The inspected `../0.2` frontier `dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf`
has no scoped `actions/specs/machine/services.ts` contract or working change.

## Deployment destination activity count (0.3 development)

The deployment Environment list's existing activity projection now includes optional
`attentionCount`, a nonnegative integer counting readable Environments whose latest
attempt is running or failed. The existing `running` and `failed` fields retain
their meaning. A missing count stays unknown in destination consumers; they do not
infer a number from booleans or drain inventory pages. This extends the current
0.3 development response and introduces no persisted field or migration.

The saved health observer adds optional `current` per-check results to its
existing encrypted Account KV checkpoint. New readers accept checkpoints without
that projection and report never observed; results are joined only to the same
Automation trigger revision and source selector. This is an unreleased 0.3 direct
cut: the observer and UI reader load together. Earlier strict development
checkpoint readers are not a supported rollback target for newly written rows.
The same unreleased checkpoint and retained-results page accept optional
`source: { sourceInstanceId, subject }`. New readers preserve legacy rows without
it; the existing observer fills it on a natural observation. The Check page uses
that identity with its captured Home and retained check id for Automations,
without inferring an identity from its Machine or edit seed. Observer, Account
Action artifact and UI reader reload together for this closed-schema addition.
The optional `current.checks[].history` daily sample projection follows the same
0.3 direct cut: observer and UI reader reload together. New readers accept
existing current results without history; no migration or backfill is required.

## SessionMessage content codec (unreleased 0.3)

Direct transcript writers use the shared content-byte frame before their existing
Session cipher. AES messages use bundle version 1; legacy-secretbox messages seal
the same marked content. New readers retain version-0 AES and unframed secretbox
JSON. Generic non-message writers and ciphertext copied from Pending keep their
historical representation until their own content batch is migrated. Platform
gzip byte streams need not be identical: deterministic message nonces bind the
actual framed bytes in a message-specific namespace, separate from older writes.

Server physical storage adds nullable `SessionMessage.contentBytes`; byte-backed
rows retain JSON null in the historical `content` column. The one storage codec
restores the unchanged wire envelope. New readers accept historical JSON rows,
plain values remain JSON, and noncanonical accepted ciphertext strings retain
their exact JSON representation. Migrations add a nullable column without
rewriting historical content; MySQL uses LongBlob rather than narrowing messages
to its default Blob capacity. Deploy the additive schema before loading new
server queries. An older server reading new byte-backed rows is unsupported.

The same physical storage owner also handles Session metadata/Agent state,
Machine metadata/daemon state, Session System Records, Automation Run results
and Workflow checkpoints, and Account settings snapshots. Their nullable byte
siblings are additive and have no backfill. Text and envelope shells preserve
serialization, extra fields, and the Workflow cipher prefix. Read owners decode
before returning domain values or comparing replay/CAS content; writes clear
obsolete byte siblings. Provider Usage History's nested record payload stays in
its existing representation. See [other stored-content bytes](encryption.md#other-stored-content-bytes-03-development).

The predecessor basis is `../0.2` at
`7b0f74960b1393886b994dbda71dcb3439c1ab57`, with no scoped working changes to
CLI encryption or UI encryptor at inspection. Its AES uses version 0, a 12-byte
nonce and 16-byte tag; secretbox uses a 24-byte nonce and serialized JSON. Reading
0.2-created content in 0.3 is required. The first 0.3 release includes matching
Node, browser, native-worker and notification-extension readers together;
0.2 binaries reading newly framed writes and automatic old-binary rollback are
not supported directions. See [content bytes](encryption.md#sessionmessage-content-bytes-03-development).

## Deployment joining settlement (unreleased 0.3)

The closed V1 deployment transition accepts optional `servingDeploymentId` for a
successful joining settlement with `expectedTargetLinkRevision`. The controller
derives it from fresh, complete native observations of the current retained
release. The existing transition signature binds the field; the server compares
it with the locked link's serving pointer and commits membership while retaining
that pointer. Omission preserves the ordinary new-receipt pointer update.

Protocol, CLI producer and server parser load together under the unpublished 0.3
direct cut. Earlier strict development readers reject the operand; it is not
safely ignorable. Unknown fields remain rejected, and no new epoch, persisted
format, signature system or predecessor adapter is introduced. The inspected
`../0.2` frontier `7b0f74960b1393886b994dbda71dcb3439c1ab57` has no
`packages/protocol/src/deployments/deploymentActionsV1.ts` contract or scoped
working changes to that path.

## Action mutation outcomes after cancellation (unreleased 0.3)

The Protocol invocation owner derives cancellation settlement from the Action's
existing input-sensitive `readOnly` declaration. Started mutations retain their
handler's exact success, native failure or typed unknown outcome while their IO
signal remains cancelled. Read-only Actions, observations and cancellation
before dispatch retain their existing behavior. CLI, UI and SDK testkit hosts
pass the declaration to this one owner; the managed-role retention opt-in is
removed. These development hosts refresh together under the unpublished 0.3
direct cut. Action envelopes, persisted formats and wire epochs are unchanged.
The inspected `../0.2` frontier
`7b0f74960b1393886b994dbda71dcb3439c1ab57` has no scoped Protocol invocation
module or working change for that path; no predecessor adapter is introduced.

## Resource finite-page delivery (unreleased 0.3)

Resource subscriptions add a generic `pages` event carrying the same finite
content envelope as `readResource`. Existing invalidation, completion and error
events retain their behavior. The native log result union remains finite; an
optional page `rowId` identifies a provider row for display-only deduplication,
without claiming a provider resume cursor. Protocol, SDK projections, daemon
watch and UI readers refresh together under the unpublished 0.3 direct cut;
earlier strict development readers reject the new event or page field.
The scoped predecessor inspection at `../0.2` frontier
`91e2afbaca33e8589652c2d2b7e2abfa9a2cf049` found none of the subscription/native
log/SDK Resource source paths. No persisted format, wire epoch or predecessor
adapter is introduced.

## Action daemon transport refusals (unreleased 0.3)

The closed Action HTTP error vocabulary consumes the existing RPC failure-code
schema; target-unavailable HTTP failures also retain optional, validated
`failureCause`. Plain Action failures use their existing code/cause shape.
Matching protocol, Home and client readers load together under the unpublished
0.3 direct cut; older strict development readers reject the newly recognized
transport codes. Credential-scope denials retain their optional request ID and
validated nested daemon cause; clients preserve target refusal phases. After
existing envelope and encryption binding checks, failure extraction uses the
outer request ID when the execution has none. Response serialization and Account
content encryption stay unchanged. No admission rule, persisted format or retry
policy changes.
The inspected `../0.2` frontier at `91e2afbaca33e8589652c2d2b7e2abfa9a2cf049`
has no `packages/protocol/src/actions/externalActionHttpError.ts` or scoped
working changes for that path. No predecessor adapter is added.

## Connected Account connection tests (unreleased 0.3)

The Connected Account runtime adds optional `testConnection`; its shared Action
and established-operation dispatch return a closed result with `ok`,
`needsReauth`, `networkUnavailable` or `unsupported`. A missing callback remains
unsupported and is never emulated with a local health check. Protocol, SDK,
CLI host and app readers load together under the unpublished 0.3 direct cut;
older development dispatchers do not recognize the new operation. No persisted
format, wire epoch, credential mutation or predecessor adapter is added.
The inspected `../0.2` frontier at
`57cd3db058af7767335d6d5a4ed44904460c50bb`, including scoped working changes,
has none of the SDK runtime, established-owner or shared Action source paths.

## Machine service exec presentation (unreleased 0.3)

Machine service rows add optional `capabilities.exec`, and their native state
adds optional `composeServices`. Missing fields remain valid; the V1 envelope
and persisted watch format are unchanged. The SDK snapshot transports the latter
as optional `nativeComposeServices`. Protocol, SDK, machine-services plugin and
CLI daemon readers reload together: earlier strict development schemas reject
unknown fields, while consumers that ignore unknown fields remain unaffected.
The inspected `../0.2` frontier at `b825a99dfedcb68e223155a1ba0be84babe9e2d0`
has none of these three protocol/SDK source paths and no scoped working changes.
No predecessor adapter or new admission rule is added.

## Managed creation mutation admission (unreleased 0.3)

Cancel and Continue without setup retain their resource's controller through CLI
routing and approval replay. The existing closed managed recovery projection
includes their exact Home, resource and intent revision. Home admits the creator
or manager once; signed HTTP mutation purposes must match that projected input.
A foreign controller receives the scoped invocation codec, without requester
Account credentials. Bare terminal credentials retain their existing refusal.
Creator Cancel/Delete roots additionally carry Home's positive
`authority: 'creator_recovery'` decision inside the existing exact Cancel/Delete
`managedAdmission` operand, bound to that signed Action, Home,
controller, body and revision. The custodian consumes it without creating a
requester-private Ask or borrowing requester credentials; nondelegated managers
retain approval policy, and other native controls retain Manage authority.

Protocol, Home, CLI and UI transport readers reload together for these added authority-bearing
union members. This corrects an unpublished development contract in place; it
adds no persisted format, wire epoch, gate or predecessor adapter. The inspected
`../0.2` frontier at `b825a99dfedcb68e223155a1ba0be84babe9e2d0`, including scoped
working-tree changes, has no managed-machine admission contract.

## Session external identity (unreleased 0.3)

`Session.externalIdentityTag` is a new nullable column with
`@@unique([accountId, externalIdentityTag])`, added by the additive migration
`20261111180000_session_external_identity_tag` (PostgreSQL, SQLite, MySQL). It
copies every `direct:v1:` creation tag into the column; `(accountId, tag)` is
already unique, so the copy cannot collide. 0.2 servers and clients never read
or write it, and 0.2 rows survive unchanged: rows whose conversation identity
exists only in encrypted metadata (0.2 handoff targets, hosted Sessions) are
indexed by each Machine's daemon backfill, and until that completes
`link.ensure` keeps its bounded Account scan (see `search.md`).

`POST /v2/sessions/lookup-by-tags` (a 0.3-only route; the `../0.2` frontier at
`b141382c277a73d0e81e33c7469eb4f0b30802d6` has none) gains the optional request
flag `matchExternalIdentity` and the response field `externalIdentities`.
Without the flag the route answers exactly the creation-tag lookup, so its
other callers (voice history, workflow and CLI session lookups) never receive
an identity-only row. `PATCH /v2/sessions/:id` gains a strict
`{ externalIdentityTag }` body mode (claim, or same-Session replace; another
Session's identity is a typed 409). Older strict development servers reject
both additions; Protocol, server and CLI load together. No predecessor adapter
or capability gate is introduced.

## Backup Configure receiver admission (unreleased 0.3)

The closed native Configure admission optionally carries `receiverMachineId`,
derived from the same Another Machine setup input as its digest. Matching
Protocol, CLI envelope producers and Home readers reload together. Older strict
development readers reject that field; no released epoch or persisted format
changes. The inspected `../0.2` frontier at
`b141382c277a73d0e81e33c7469eb4f0b30802d6` has no deployment protocol directory
or working-tree additions there. No predecessor adapter is introduced.

## Usage catalog delivery (unreleased 0.3)

Scalar and batch analytics queries accept optional `includePriceCatalog` per query.
The batch projection owner includes one acquisition-level catalog only when at
least one admitted query requests it; contribution delivery does not imply catalog
demand. Scalar responses use the same decision. Pricing still uses the captured
server catalog. The shared UsageQuery transport builder requests the catalog for
local repricing and price explanations, while totals-only workflow reads omit it.
Matching Protocol, server and clients reload together under the unshipped 0.3
direct cut; no compatibility shim, capability flag or persistence change is added.
The scoped clean `../0.2` frontier at `c680de922e4475b7dfbaeedcd63a8af7d985d3c3`
has no current analytics query service/contracts.

## Usage filter inventory (unreleased 0.3)

Private accounting responses add optional closed `scopeKeys` entries containing
the complete identities for requested scope-filter breakdown dimensions. Ranked
charts retain `topLimit`; filter membership uses the full admitted population,
without event detail. The existing client Project display-key owner groups these
identities for both the filter and ledger, including absent Project usage.

Matching Protocol, server and UI readers load together. Older strict development
readers reject the extra response field; new readers accept its absence. Requests,
persisted formats and the V1 wire epoch remain unchanged. The inspected `../0.2`
frontier at `7b37d65ca75e58560f8f3ca850958ac5407d2e75`, including scoped local
changes, has no current Usage analytics contract or query-service path. No
predecessor adapter or capability gate is introduced.

## Combined Machine Setup admission (unreleased 0.3)

The existing Setup preparation admission adds optional `machineTargets` for
Apply. Matching CLI, Home and protocol source admit all selected native Machines
before starting the combined Run. Installed Workflow children retain the
publisher's signed origin, narrow their operands to the signed parent scope,
and bind delivery and invocation encryption to their selected receiver. This development correction requires the matching source
components to reload together; it adds no released wire epoch. The retained 0.2
release at `7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no Machine Setup contract.

The receiving Machine owns each native child's Operation; the Workflow publisher
does not open a competing Operation before signed ingress. Apply, Remove and
Updates use the existing Action Operation completion declaration: the Workflow
retains the receipt, records running, and observes the native terminal outcome.
Inline Actions still return their full result. This development correction uses
the existing receipt and frozen completion shapes, with no new wire epoch.

A confirmed failed Action interrupts its Run and retains the failed invocation
for exact retry. Interruption keeps recovery custody pending; the combined Setup
observer returns the recorded child failure without waiting for terminal custody.
When a failed script has published partial progress, the signed Workflow retry
uses the retained unfinished script ordinals only if the desired sources and
exclusions still match its frozen review. Completed recipes and scripts stay
completed. Ordinary stale reviews and later desired edits still require a fresh
Plan. No new persisted progress format is introduced.

## Machine Setup connector grant scope (unreleased 0.3)

The existing Setup preparation admission optionally carries `connectorGrants`
from the exact secret-grant references in reviewed native Apply plans. Home
signs those references with the original request and admits their Machines once;
Setup may set or remove only those connector grants. Setup without a reviewed
connector operand retains its installed read access. Recipe inputs and native
paths remain encrypted for E2EE Accounts.

Matching Protocol, CLI and Home readers consume this closed development
projection together; older strict development readers reject the added field.
No persisted format, storage owner, wire epoch or compatibility adapter changes.
The inspected `../0.2` frontier at
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no Machine Setup contracts.

## Platform upload provenance (unreleased 0.3)

Protected TargetLink provider content also accepts optional `sourceMethod`. Existing links without it remain readable and use the legacy Git default; new Create and inspection flows retain the authored choice, with explicit invocation choices taking precedence. No migration or inference from provider Git-access facts is performed. Matching Protocol, deployment-protocol, CLI and UI development readers update together because older strict readers reject the added field.

`DeploymentTargetRoleResultV1` adds optional `uploadProvenance` to the existing provider observation. Existing receipts without upload evidence remain valid. New upload results record a source manifest fingerprint and a discriminated build location: `provider`, or `controller` with image, toolchain name/version and output manifest fingerprint. Later observations may omit it; the receipt writer retains the original upload evidence.

This is a development contract cut across the protocol, plugin SDK, provider declarations and their host consumers. Older strict role-result readers reject results containing the new field; update those components together and regenerate bundled provider manifests through their canonical publisher. No migration, new persisted record, alternative parser or released-version compatibility fallback is introduced.

## Machine Setup receiver evidence (unreleased 0.3)

Setup Plan and Apply add optional `backupReceivers` public results. The native
SSH probe declaration can request `publicHostKeyEvidence`, and the elevated
settled result can carry its public `sshHostKeys` witness. Matching Protocol,
CLI, recipe projection and generated SDK Action readers reload together;
older strict development readers reject these additional fields. This extends
an unpublished 0.3 contract in place, with no persisted format, wire epoch or
compatibility adapter. The inspected `../0.2` frontier at
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no Machine Setup contracts.

## Machine service export commitment (unreleased 0.3)

The closed development TCP grant's `scope.serviceExport` now carries only
`{ commitment }`; the binding and random nonce move to the encrypted inner
`open.serviceExport: { binding, nonce }`. Home, A and B load the matching source
together. Older development readers reject the new shape; no cleartext fallback
is retained. This replaces an unpublished development field in place, without
changing the V2 carrier epoch or adding stored data. The inspected `../0.2`
frontier at `7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no peer-mediation
contracts under `packages/protocol/src/machines/peer/mediation`.


## Database copy and reference components (unreleased 0.3)

Protected provider target-link content optionally carries `data` presentation:
engine, version and a credential-free HTTP(S) provider-console URL and label.
The existing mode-aware link artifact writer captures these provider-produced
facts; target metadata and authority are unchanged. New readers accept links
without the leaf. Matching development Protocol, CLI and UI readers reload
together because older strict readers reject it. This is the unpublished 0.3
direct cut, with no new envelope, wire epoch or compatibility adapter. The
inspected `../0.2` frontier at `91e2afbaca33e8589652c2d2b7e2abfa9a2cf049`
has no deployment target-role contract, including scoped local changes.

Native deploy intent can restrict one operation with an explicit, nonempty
`services` subset. Preparation retains that restriction in the private receipt
and pending intent while keeping the complete `sourceIntent` unchanged. Native
review refuses dependency expansion beyond the restriction. Omitting it keeps
the ordinary full deployment behavior. A successful preview database provision
can retain `previewCleanup` with its exact observed Machine and owned named
volume identities in the receipt and Action result; ordinary subset deployments
do not produce this cleanup authority.

These closed development request, pending and receipt fields require matching
Protocol, CLI and Home readers to reload together; older strict development
readers reject the additional fields. They add no wire epoch or compatibility
adapter. The inspected `../0.2` frontier at
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no deployment protocol or native
deployment implementation, including scoped local changes.

The public restore input's `source` selects a repository snapshot or an upload.
A repository source's optional `origin` identifies the source Environment/Link
for cross-Environment copy; `destination` selects the database or volume to
restore. Home admits Manage on both Environments and the source member once.
Ordinary recovery omits `origin` and keeps its same-Environment contract. The
installed source member consumes the existing source grant through
`copySourceRead`; no credential transfer format or removed-`copy` adapter is added.

An Environment variable reference can optionally select `component: 'host'` or
`'port'`. Existing references without that field still resolve to the complete
endpoint. This changes the closed development binding shape: matching Home,
CLI and UI readers must reload together, and older strict development readers
reject the new selector. There is no new envelope, grant kind or wire epoch.

The existing Environment content update can carry a reviewed binding patch
alongside its definition. The client prepares ordinary Saved Secret grants and
the server stores the combined content and grants under the same revision
compare-and-swap. Matching development readers reload together for this closed
patch shape; separate ordinary binding updates retain their existing contract.

## Voice ending presentation (unreleased 0.3)

The existing local Voice teardown projects `ending` through the closed read-only
attempt presentation and public Action status. Transport status retains its
existing connected/connecting value until physical cleanup finishes; `ending`
does not claim completion or change stop admission. Matching Protocol, generated
SDK Action DTOs and UI readers reload together under the unpublished 0.3 direct
cut: older strict development readers reject the new presentation variant.
No persisted format, wire epoch, gate or compatibility adapter is added. The
inspected `../0.2` frontier at `7b37d65ca75e58560f8f3ca850958ac5407d2e75`,
including scoped local changes, has no `voice/attemptPresentation.ts` contract.

## Machine Setup prerequisite presentation (unreleased 0.3)

The receiving effects Plan optionally reports
`review.administratorUnavailable: { reasonCode: 'mode_none' }` when its existing
administrator requirement meets the captured None policy. Review displays the
canonical administrator prerequisite and disables Apply; Ask remains usable.
This optional closed presentation fact never enters Apply or persisted state.
New readers accept its absence; matching development readers reload together
because older strict Plan readers reject it. The inspected `../0.2` frontier
at `7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no Machine Setup contract.

An unperformed Setup item check is `unverifiable`, and an unimplemented native
declaration check is `unavailable`; positively observed native `unsupported`
results retain that classification. The target Plan's support
projection optionally carries `requiredFact` from its selected native blocker,
without guessing a fact for an unperformed check. This is presentation metadata
and does not enter the Apply operand. Matching development Protocol, CLI and UI
readers reload together; older strict development Plan readers reject the added
field. No persisted format, new status, wire epoch or compatibility adapter is
introduced.

## Requester profile admission (unreleased 0.3)

The reserved daemon relay accepts the existing `invalid_token` pre-open refusal
from signed-root verification. The CLI already emits it before effects; retaining
it prevents Home from treating a known refusal as an unknown Action outcome.
HTTP keeps its existing 401 projection and verification remains required.
Matching development Protocol, Home and CLI readers must reload together because
older strict relay readers reject this code. This adds no error code, persisted
format or released adapter; the scoped-clean `../0.2` frontier inspected at
`f10121a13b` has neither affected external-Action Protocol owner.

Requester identity admission in current development source reads the existing
Account self-profile projection, so an unrelated pool-policy version does not
invalidate identity. Consumers that need connected-account catalogs still use
the full profile reader. Installed guests retain their Create-time CLI until
the existing Machine CLI update operation runs; equal CLI semver does not
establish equal profile readers.

The current daemon pre-open failure carrier optionally retains the existing
sanitized Action `failureCause` through direct HTTP and Home relay responses.
Profile parsing reports `internal_error` with phase `requester.profile`; an
actual validated HTTP 426 retains its `client-upgrade-required` cause. Older
producers may omit this diagnostic. Older strict development relay readers need
an update before accepting the additional field from a new daemon. This does
not add a version comparison, change Account-mode authority or certify an
already-running guest.

## Contributed Action finite refusals (unreleased 0.3)

Finite contributed Actions retain the same closed public refusal as direct
execution in the existing operation `result`: code, optional message, retryability,
handler-start status and remediation. The snapshot accepts it only for a qualified
contributed Action whose failure code matches the operation error. Author-private
data is excluded by the shared direct-response projector. Current CLI, Protocol
and UI reload together; the existing V1 predecessor projection omits this failed
result while retaining the ordinary operation error. No field, envelope, state or
wire epoch is added.

Managed native schema refusals now retain the actual contributed Action identity
and canonical issue path/code in the existing `nativeCause` diagnostic, both in
the managed observation and the failed operation. Rejected values, expected
values and issue prose are excluded. Matching development Protocol, SDK, CLI
and UI readers and regenerated bundled provisioner role-result declarations
reload together because older strict native-cause readers reject the new variant.
This does not change the provisioner input or add a wire epoch.

## Public preview exposure invalidation (unreleased 0.3)

The existing ephemeral carrier adds the closed content-free
`local-service-public-preview-changed` event with `machineId`, `previewId` and
`exposureId`. The server exposure runtime publishes it after creation or a
withdrawal transition. Managed Service previews wake the existing current Machine
audience; other previews wake current Session recipients. The creator and service
owner are also included. These are the canonical recipient owners for the same
branches used by public-status admission, which still decides disclosure. No
link, token or exposure content crosses the wake.

Matching development Protocol, server and UI reload together. The UI re-reads
only demanded matching Home/Account/Machine/preview scopes and uses existing
reconnect recovery. This adds no persisted record, wire epoch, polling or older
client live-update guarantee; an unrecognized ephemeral event is skipped by the
existing parser. The inspected `../0.2` frontier at
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` has none of the current public-preview
runtime/store module paths, including scoped local changes.

## Managed Provider model observations and restriction copy (unreleased 0.3)

Managed native catalog observations add optional `modelIdPrefix` to their
closed Agent-source declaration. It has routing meaning: the shared source
observation decoder admits matching native selectors and removes that prefix
before publishing Provider descriptors. Omission preserves exact native ids.
Matching Protocol, CLI and declaring Provider plugins reload together; older
strict development readers reject the field. This unpublished direct cut adds
no wire epoch, stored format, capability gate or predecessor adapter. The
inspected `../0.2` frontier at `4c64c3f1ddfca82db8bcb61e7e8c87f6bd013e69`
has none of the affected declaration, observation or managed-family paths,
including scoped working changes.

Managed connected-account purposes may declare localized
`operationRestriction.summary` and `operationRestriction.sentence`. The existing
managed-purpose resolver and public purpose projection retain this passive copy.
Operation admission remains with the family's existing dispatcher; copy changes
do not change managed runtime identity or security consent fingerprints.

The current connection-model response adds optional `catalogObserved` and
per-purpose `sourceCatalogs` so absent observation differs from observed empty
without discarding usable model descriptors. SDK model-result types derive from
this Protocol response. The existing `providers.models.refresh` Action accepts a
connection operand for explicit source refresh; model listing stays current-only.
Both refresh operands use the existing dangerous-Action approval default for
agents because explicit refresh can contact Providers.

These closed development contracts reload together under the unpublished 0.3
direct cut. No persisted record, wire epoch or predecessor adapter is introduced.
The inspected `../0.2` frontier at
`7b37d65ca75e58560f8f3ca850958ac5407d2e75`, including scoped local changes, has
none of these Provider declaration, RPC or managed-family paths.

## Native provider failure evidence (unreleased 0.3)

Agent plugins normalize native provider errors before reporting structured
category, quota scope and optional status/code facts through request-auth.
Pi owns its characterized terminal formats and native retry behavior; Protocol
and SDK no longer interpret Pi versions or signature identities. The private
transport accepts only `evidenceSource: { kind: 'structured' }`.
Matching Pi, SDK, Protocol and daemon source reload together. These request-auth
and classifier modules are absent from the inspected `../0.2` frontier
`7b37d65ca75e58560f8f3ca850958ac5407d2e75`, including scoped local changes;
no persisted format, wire epoch or predecessor adapter changes.

## Tool provenance V3 (unreleased 0.3)

The V2 tool envelope now carries current metadata V3 with `native | acp`
protocol and a closed qualified Agent contribution identity. Current writers
and SDK normalization callbacks use the admitted runtime source; the enclosing
ACP transport does not change native provenance. Loose metadata adjuncts remain
open. The existing metadata owner accepts V3 and released V2, including `_happy`.
Its explicit legacy result preserves the old unqualified provider without
fabricating a plugin identity. The exact V2 codecs keep their closed protocol
vocabulary; V3 does not widen those released contracts.

The inspected `../0.2` frontier at
`7b37d65ca75e58560f8f3ca850958ac5407d2e75`, including scoped staged and unstaged
changes, has that V2 metadata contract. No transcript rewrite is needed. Debug
tool trace writers also advance their JSONL format to V2 for qualified source
facts; the one trace reader retains the predecessor's V1 records. Current SDK,
host and plugin source reload together. See [tool normalization](tool-normalization.md).

## Retained Agent compatibility (0.3 development source)

Released Agent flavors, Connected Service mappings and exact-v0.2.1 credential
recipes remain scoped to their documented ingress callers. The exact-v0.2.1
materialization owner supplies the historical projection-only decision; generic
spawn consumes that result instead of selecting a service recipe itself.

Current configured ACP inventory, installation and launch share the qualified
Agent target and selected definition from `buildConfiguredAcpAgentSelectionV1`.
The existing Account namespace and configured definition remain intact. Historical
selection readers translate old shapes at ingress; they do not select current
runtime identity. No stored-record rewrite or new compatibility epoch is added.

## Provider model roles and stored pool policy (unreleased 0.3)

The current Provider connection contract uses `roleModels` and plugin-declared
`modelRoles` in place of its never-shipped vendor-specific helper fields. Matching
Protocol, SDK, plugin and UI consumers reload together; no development-record
alias or conversion is provided.

The released predecessor's pool policy remains a frozen V1 stored-data codec.
`parseConnectedServiceAuthGroupPolicy` translates its optional
`claudeCodeAutoContinueAtUsageLimit` into current V2
`nativeUsageLimitContinuation`, preserving absence, false and true. Current
qualified reads, creates and patches use V2. A deliberate update writes V2 to the
existing record; there is no backfill or dual write. The predecessor auth-group
route remains unavailable (404). The format basis is the scoped-clean
`../0.2` schema at `7b37d65ca75e58560f8f3ca850958ac5407d2e75`.

## Account Action confirmation continuity (unreleased 0.3)

The existing closed private Account invocation confirmation also carries settled
UI consent for a Plugin-origin `action.invoke`, without changing the Plugin caller
or its automation authority. The receiver binds the same exact operand,
Account, Home, request and execution target when it consumes the confirmation
once. Plugin declaration, source, version and newly computed policy are not
compared after approval; the approved operands remain the operation's input.
Host confirmation and reviewed-parent admission keep their existing restrictions.

The private record shape and persisted approval formats do not change. The closed
`action.invoke` input gains optional `expectedContributorOccurrenceId`; raw host
repair relays retain that existing target-selection constraint through the
generic Action path. Earlier development readers reject the Plugin confirmation
and the new optional operand. The input-only consent digest also changes within
unpublished 0.3; UI, Protocol and daemon reload together under the
unpublished 0.3 direct cut.
The inspected `../0.2` frontier at
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no private requester-invocation
carrier at this source seam, including scoped staged and unstaged changes.
No wire epoch, migration or predecessor adapter is introduced.

Session creation also carries the creation owner's optional `sessionCreationDefaults`
inside this existing private invocation. The captured selected-scope context and
original authored target and placement choices, plus any already-bound preset
acquisition and its controller access projection, travel under the exact requester admission and
installation seal; the receiving executor consumes them without selecting defaults
again. They are absent from public Action inputs and Session metadata. Matching
Protocol and CLI/daemon development readers reload together; older strict readers
can reject this optional private member. The inspected `../0.2` frontier at
`87aaa83f6b81c92a4ceee5816df2e566ed429bc7` has no requester-invocation carrier,
and no epoch, migration or adapter is added.


## Direct Machine RPC simplification (unreleased 0.3)

Direct RPC request/response envelopes drop `commandReceipt`; route-policy rows
drop `commandReceiptRequired` and fold `direct_medium_risk_receipted` into
`direct_ephemeral`. The fallback enum drops `quarantined`,
`command_receipt_required`, `command_receipt_rejected` and `grant_idle_expired`.
Atomic one-shot grant consumption still refuses reuse with
`direct_call_limit_exceeded`; signed grant, proof and identity validation remain.
Grant `maxCalls`/`maxIdleMs` fields are unchanged.

Protocol, Home route-policy consumers, UI and daemon source reload together under
the unpublished 0.3 direct cut. This changes no persisted data, supported release
format or wire epoch. The inspected `../0.2` frontier at
`7b37d65ca75e58560f8f3ca850958ac5407d2e75`, including scoped local changes, has no
Machine peer-mediation RPC contract; no predecessor adapter is introduced.

This document defines when Happier preserves old behavior across UI, CLI, daemon, server, installers, and persisted state. The goal is safe upgrades and mixed-version operation without turning undeployed implementation history into permanent compatibility debt.

## Explicit Saved Secret repair (unreleased 0.3)

`secrets.shared.repair` adds a client-placed Action with closed resource-id and
revision input and closed value-free completion metadata. It uses the unchanged
internal envelope-census/repair transport and exact-revision owner; existing
Saved Secret Actions, grants, content and persistence formats do not change.
Protocol, generated Action projections and the answering UI load together under
the current 0.3 direct cut. Older development readers do not recognize the new
Action; no optional field is silently ignored, no wire epoch or package version
changes, and no compatibility adapter is introduced. The inspected `../0.2`
frontier `7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no shared Saved Secret
Action family at the scoped source paths, including staged and unstaged changes.

## Session Action cause continuity (unreleased 0.3)

The closed `SessionActionRpcOriginV1` adds optional canonical
`actionRequestAttributionV1`, including its closed requester, persona and source
message objects. The installed Session host derives that cause from authenticated
input admission; its existing signature and Home binding carry it to socket RPC
and external Action receivers. It grants no execution or approval authority.
Unknown people remain unknown; malformed cause is rejected at the signed Session
boundary. The closed private Account invocation also retains the existing cause
for a host caller authenticated as the same qualified requester Account and Home.
Unknown requesters remain null. A different requester or Home, terminal or
API-token credential, Session or Workflow origin, or Plugin caller is refused;
the carrier cannot name another person. Mixed-person requester approvals retain
the original-Session decision route rather than this own-Account host projection.

New readers accept earlier origins without the field. A retained approval whose
stored cause differs from its signed Session origin is stale, including an older
origin that omitted an otherwise stored cause; request approval again after reload.
Older strict development
readers reject the added field, so Protocol, Home, UI, CLI/daemon, native Session
hosts and the SDK type projection reload together under the unpublished 0.3 direct cut.
The wire epoch, package version and persisted approval format do not change.
The inspected `../0.2` frontier `d370a14c49f3383ca145938462bdfb257f6e453c`,
including scoped staged and unstaged paths, has no Session Action origin or
request-attribution contract; no predecessor adapter is introduced.

## Availability content-addressed declaration reads (unreleased 0.3)

`intents.list` and `intent.read` project `currentDeclaration` and
`machineDeclarations[].declaration` as `{ declarationDigestSha256 }` only; the
previous manifest bodies (one per plugin in the census, one per Machine plus the
current one on exact reads) are gone. `intent.read` accepts optional
`declarationDigests` and answers `declarationBodies` with each held body once.
Protocol, server and UI reload together: strict development readers of the old
shape reject the identity-only envelopes, and an older server rejects the new
input field. No stored shape changes (version-3 rows already address bodies by
digest), so 0.2 data is unaffected; the scoped `../0.2` frontier has no
Availability V1 intent reads, so there is no released predecessor to adapt.

`materializations.read` also changes transport: rows reference a shared
`uiArtifactSets` entry by `uiArtifactSet` index (inline `uiArtifacts` rows still
decode). Older strict readers reject the new fields, so the same reload-together
rule applies; reported and stored materializations are unchanged.

## Availability digest-only declaration claims (unreleased 0.3)

The existing Collection-writer claim accepts either its unchanged closed full
manifest input or a closed `{ pluginId, manifestDigestSha256, prepare? }` input.
A held digest resolves only an already-admitted declaration for that Account and
plugin and follows the existing Collection/intent merge and publisher proof.
A miss returns HTTP 404 `plugin_declaration_not_found`; the host then sends the
full declaration. Responses and persisted declarations are unchanged. Unknown
fields reject, and a digest grants no identity, routing or effect authority.
Protocol, CLI and server reload together under the unpublished 0.3 direct cut;
earlier strict development servers reject the new input arm. Full-manifest
producers remain accepted. No wire epoch, capability gate or predecessor adapter
is added. The scoped-clean `../0.2` frontier
`7b0f74960b1393886b994dbda71dcb3439c1ab57` has no corresponding claim owner or
Availability actions module.

## Availability Machine declaration demand (unreleased 0.3)

The Availability V1 list retains each Machine's closed identity, installation and
digest envelope and omits its manifest body. Exact plugin reads retain that
body; guided Event setup acquires it through the existing scoped Availability
loader and admits its semantics before use. Account-current declarations remain
discovery inputs. New readers accept earlier full-body lists; older strict
development readers require Protocol, server and UI to reload together under the
0.3 direct cut. No persisted format, publication admission or wire epoch changes.
The inspected `../0.2` frontier `30790800ef79b06cac4941ddf3f73bcc73a9aab2`
has no corresponding Availability list/Machine declaration contract in scoped
source or staged/unstaged paths; no predecessor adapter is introduced.

## Managed provisioner check qualification (unreleased 0.3)

The closed `machines.provisioners.check` V1 input adds optional `selectors`, using
the existing plugin JSON value grammar. Configuration readers project only paths
referenced by the provisioner's credential-purpose requirements; unrelated launch
options keep the same shared availability answer. The existing credential owner
uses these values at admission. Missing selectors keep conditional purposes
required, including broad picker reads. Selectors qualify credentials only: the
native check Action still receives its declared empty input, while options receive
their selected query.

New readers accept requests without this field. Older strict development readers
reject it, so Protocol, SDK projections, UI and daemon source must reload together
under the unpublished 0.3 direct cut. No persisted format, migration, runtime ABI
or wire epoch changes. The inspected `../0.2` frontier at
`a730ff7d94352baa194bcccae957aadf5474149a`, including scoped staged and unstaged
changes, has no corresponding managed Action contract; no released adapter or
reverse-development rollback direction is introduced.

## Trigger Event subject projection (unreleased 0.3)

The selected `workflow.trigger.list` input is an unreleased 0.3 direct cut. Its selection
and identity objects are closed. Matching Protocol, CLI, UI and server readers
must reload together; older strict development readers reject these new
selections. Existing unselected list inputs remain valid. Attachment results add
only list-safe summaries, source/Run facts, Artifact access presentation and safe
author attribution; denied references disclose only a Trigger count. No new
persisted format, migration, compatibility adapter or wire epoch is introduced
by these reads.

The saved-check-only `workflow.subjects.list` Action follows the same matching
development-reader contract. It adds no persisted format or probe enrollment.

The closed `workflow.trigger.list` Event detail adds optional `subject`, using
the existing closed Health check subject schema. The Account trigger owner opens
recognized receipt and Health Event sources through its existing plaintext/E2EE
reader; their domain schemas project the saved observation subject. Environment
lists match each Event's projected subject. Unknown or unreadable subjects remain
available in Account and Machine lists without being attributed to an Environment.

This presentation field changes no source configuration, execution placement,
Environment lifecycle binding, persisted format or wire epoch. New readers accept
earlier rows without the field; older strict development readers reject it, so
matching Protocol and UI readers reload together under the 0.3 direct cut. The
inspected `../0.2` frontier at `519c05dc1320396738f42babf2d6a2a2af754e4f`, including
scoped staged and unstaged changes, has no Workflow trigger contract or V2 recipe
at these paths. No released compatibility direction or adapter is inferred.

## Shared-Session managed Browser (unreleased 0.3)

Session Browser reads and commands use the existing Session RPC selector. Home
resolves canonical Session capabilities and mints the closed `session.browser`
transport context bound to its current Machine and installation. Browser
discovery accepts an omitted Machine selector on this path and returns the safe
source Machine route. Installed ephemeral-source proofs carry an optional
`sessionBrowserSessionId`; the closed personal relay V2 carries optional
`sessionBrowserAccess`, binding the same Session, actor and installation. These
facts select the Session encryption mode (its key for E2EE, keyless for plaintext)
and retain the canonical input capability;
they grant no generic Machine access. Missing Session authority never widens a
Machine-scoped caller. Persistent profiles stay excluded for nonowners.

This is the coordinated unpublished 0.3 direct cut: matching Protocol, Home,
daemon and UI reload together. Older strict development readers reject the new
closed fields; no released predecessor, persisted format, new epoch or adapter
is introduced.

## Browser view discovery push (unreleased 0.3)

`BrowserDaemonViewV1` projects optional `sourceOccurrenceId` from the existing
capture registry. The UI passes that identity to the existing live-stream ingestion
owner so a native profile replacement admits a fresh source without changing the
logical Browser view. Old occurrences still retire, and guest saved-profile refusal
still applies at fresh admission. This is a coordinated unpublished 0.3 direct cut:
matching Protocol, daemon and UI reload together; earlier payloads may omit the
field, while older strict development readers reject it. The inspected `../0.2`
frontier at `c680de922e4475b7dfbaeedcd63a8af7d985d3c3` has no Browser control schema
at this path. No released epoch, persisted format or compatibility adapter changes.

Browser parity inputs add optional `engineOverride: 'embedded' | 'managed'` to workspace
and view open/retarget, and optional `navigationIntent: 'address' | 'target'` to navigation.
Saved-profile management Actions and `files.save`'s closed `browserDownload` source are
also development-only additions. The latter names a Machine, BrowserSession, view and
download, never a host path. Matching Protocol, SDK, daemon and UI must reload together:
older strict readers reject these additions; absent optional fields retain their prior
meaning. The existing Details Browser resource retains the optional engine choice,
and old resources remain readable. No wire epoch, profile storage migration or released
compatibility adapter is introduced by this direct development cut.

Shared-Machine Browser and Computer viewers reuse the existing V1 installed-source
proof and V2 viewer-bound relay grant. The common stream starter now obtains that
proof for shared Machines, including Manage requesters. Browser source admission
is registered at the Machine client lifetime independently of Computer startup.
Matching development UI and daemon must reload together; a daemon without Browser
source admission returns unavailable rather than falling back to an owner grant.
No proof schema or grant version changes in this correction.

Persistent-profile custody uses the same product-side profile predicate for every
Browser command and view list/watch. A requester without Manage access receives
`profile_policy_denied` for commands targeting a persistent profile, and discovery
omits those views. The requester's ephemeral Session browser remains available;
owners and Manage requesters retain persistent-profile control. Controller
commands are admitted before input ownership changes.
Automation, diagnostics, context and recording Actions that name a Browser
Session consume that same refusal at the runtime Action entry before effects.
Raw context, diagnostics and recording RPCs consume it through one shared
request-admission adapter. Recording IDs and lists use the recording owner's
stored profile identity, including after a browser closes or reopens with another
profile. Global snapshots and retention cleanup include only allowed targets.
Saved context IDs resolve their captured source before attachment, clearing or
replacement. The existing in-memory source record retains the native profile
bound to the capture, so closing or reopening a Browser cannot expose an owner's
saved capture. Context attachments remain addressable independently of the
currently focused view; no context wire or persisted format changes.

The control-error union adds the existing profile refusal code
`profile_policy_denied`. Matching development Protocol, daemon, SDK and UI readers
must reload together because older strict control-result readers reject that enum
member. Existing accepted requests, stored profiles and the wire epoch do not
change. The inspected `../0.2` frontier at
`b548768d83ff32699bad779c7324b254d6d7adad` has no Browser control or product-side
profile path, including scoped local changes; no predecessor adapter is added.

`daemon.browser.view.watch` is a new closed V1 request with the list request's
Machine/Session scope and a `knownViewIds` array. It returns the unchanged strict
V1 list response after native membership changes. Existing list requests and
responses, Browser events and stored state do not change. The UI treats a missing
watch method as unavailable, retains one-shot discovery and never polls.

Development UI, daemon and Home/peer route-policy consumers must load the new
method together for push discovery. The inspected 0.2 frontier at
`7607f9dc568d462e61ce73583881e4ce6def549e` has no browser control protocol or
daemon Browser RPC handler (including local changes at those paths); no released
predecessor adapter or persistence migration is introduced.

## Browser extension profile choices (unreleased 0.3)

The existing `browser.extensions.list` ready result adds optional closed
`profiles` entries containing only `profileId` and optional `displayName`. The
daemon projects its persistent-profile inventory, including profiles with no
extensions. New readers still accept a ready result without this field and
report profile suggestions unavailable rather than inferring an empty inventory.
The shared select hint `allowCustomValue` permits typed string answers while
retaining input-schema validation; ordinary selects keep their membership check.

Matching development Protocol, daemon, SDK and UI readers must reload together:
older strict development readers reject the additional result and hint fields.
This adds no Action, RPC, persistence format or wire epoch. The inspected 0.2
frontier at `7607f9dc568d462e61ce73583881e4ce6def549e` has neither the Browser
extension Action contract, shared input-field contract nor daemon profile store
at the affected paths, including local changes; no released predecessor adapter
is introduced.

## Deployment Domain, binding and preview facts (unreleased 0.3)

CLI and Machine-hosted Environment list Actions include optional `items[].name`
from the private Artifact header title. Home metadata stays content-free; list
presentation requires no body read. Legacy `Deployment content` titles remain
visible unchanged. Matching development strict readers refresh together for this
additive result field; no persisted format or released predecessor adapter changes.

Own-server runtime projections optionally retain the native member review's
`engineKind`, using the review schema's existing enum. Receipts that omit it stay
readable with an unknown engine; the field adds no acquisition or authority.
This is a matching unpublished 0.3 Protocol/CLI/UI direct cut: older strict
readers reject the new field, so matching development components refresh together.
There is no released 0.2 deployment-protocol predecessor or compatibility adapter.
Domain headers also expose the native owner's optional `routedReplicas` recorded
apply snapshot. Its names and count do not imply live health or traffic.

Domain health extends the existing current-health read with exact Domain
selection and typed retained HTTP/certificate facts. Deploy review compares its
resolved reference addresses with private receipt evidence already read by that
review; receipts may record the reference addresses already resolved at launch.
Receipts without address
evidence remain unknown. Saved-secret comparison reuses existing approved-input
revision evidence and does not change secret envelopes or encryption authority.

Preview Environment queries accept canonical repository identity alongside the
existing exact pull-request selector. The GitHub preview read and status
publication share receipt/provenance/Domain readiness rather than accepting a
caller-owned URL. The canonical GET binder encodes the structured repository
selector as JSON; the Home route decodes it before strict input validation.

Preview-template edits use the existing Environment content-update proof and
sole template schema. The authored patch carries the private operand; prepared
Home storage rejects it and accepts only the rewritten Artifact reference plus
the remaining metadata patch. Create root admission preserves the existing
`source_changed` refusal for a readable copy source whose reviewed revision is
stale. The bounded Action HTTP error vocabulary now carries that conflict (409
at the authorization endpoint) through matching unpublished 0.3 components;
unreadable and deleted sources retain `credential_scope_denied`. No 0.2
deployment predecessor or compatibility adapter is involved.
Create preparation also retains `source_access_denied` when the requester lacks
management of an explicitly selected owner or readable Source. The same closed
Action HTTP vocabulary carries that existing Source refusal as HTTP 403 through
mint and re-presented roots. Matching unpublished 0.3 Home, CLI and UI components
refresh together; older strict development readers reject the additional code.
This adds no permission, credential, persisted field or released adapter. The
scoped `../0.2` frontier `dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf`
has neither the deployment preparation nor Action HTTP error owner.
Own-server template selections optionally retain
`copyFrom` source capture coordinates and explicit `destinationBackup` authoring
inputs. Child preparation owns fresh generated bindings; source credentials and
grants are not copied. Repository Compose remains the sole repository content
owner: declared PostgreSQL services receive fresh bindings and metadata without
an overlay. Other selections use a catalog-derived standard companion, with a
nullable unique `previewCompanionOfEnvironmentId` foreign key to the main preview.
It persists no second four-part preview identity. Header and approval readers
derive its template id through the main preview; list and close use the named
relation. Create captures carry the required-companion marker and ordinary
variable/Secret references for the main preview's binding update. The
unpublished augmentation field has been removed rather than retained as a
compatibility path. Older selections without these optional operands remain
readable; native copying requires the explicit source and destination choices.
The reviewed Create child uses the canonical backup Configure Action and its
actual configured revision; generic Environment updates do not configure backups.
Saved managed parent references may carry a display name for reload presentation;
the Workflow removes that metadata before invoking strict provider Actions.
These are unreleased 0.3 fields consumed by matching development readers.

Matching development Protocol, Home, daemon/CLI, SDK, UI and GitHub plugin must
load together. Older strict development readers may reject the new fields or
Actions. An additive preview lookup index serves the exact PR query on each
database provider; no stored data shape, wire epoch, polling transport or
compatibility fallback changes. The inspected 0.2 frontier at
`b92a92801425868f22ac911d0f11327c37e1f43f` has neither the Protocol/CLI deployment
directories nor the GitHub preview-status admission path, including local
changes in those paths, so no released predecessor adapter is added.

## Event source failure codes (unreleased 0.3)

Availability's existing `intent.read` and paged `intents.list` responses also
expose the optional closed `currentDeclaration`: the Account-selected
declaration digest, including a host-claimed release-less declaration (bodies are
read by digest; see "Availability content-addressed declaration reads").
An explicit null means no current declaration; omission from an older producer
does not prove eligibility. Event watcher admission and server Create share the
canonical Event contribution reader for eligibility and source-contract version.
This leaves Account execution selection, persistence and mutation inputs
unchanged. Matching development Protocol, Home and UI readers load together;
older strict development response readers reject the additional field. No new
transport, Action, wire epoch or reverse-development adapter is introduced.
The inspected `../0.2` frontier at `7607f9dc56` has neither the Availability V1
Protocol nor its server operations owner, so this field has no released
predecessor response contract to adapt.

Release-less Availability claims now reuse the existing installation-publisher
header. The server verifies its Account, Machine, installation and body binding;
no claimed body field establishes Machine identity. The existing private intent
JSON column stores version-2 per-Machine entries and retains readable unsigned
development declarations separately. An unsigned claim cannot replace an
attributed entry; no Machine provenance is fabricated for historical rows.
`intent.read` and `intents.list` optionally project closed `machineDeclarations`
entries. Machine-specific Event consumers use those entries, and an Account-wide
single declaration is derived only when the entries agree. Matching development
Protocol, Home, daemon and UI must reload together; older strict development
response readers reject the additional field. The inspected `../0.2` HEAD
`7607f9dc568d462e61ce73583881e4ce6def549e` has neither affected Availability
server nor CLI publisher paths, including local changes at those paths. This
adds no released predecessor adapter, database column, registry or wire epoch.

Event source status keeps the existing persisted `code` column and accepts all
legacy values plus producer error codes validated by the canonical Action error
code reader. The shared read projection adds an optional typed `explanation`;
new readers still accept statuses without it. No database fields, states,
migrations or retry timers are added. A source attempt with no provider-owned
retry deadline settles as `attention` and waits for its existing authenticated
source or host invalidation wake.

Matching development Protocol, SDK/daemon and Home readers must reload together:
older strict enum readers reject new producer error codes, and older strict
status readers reject the additional explanation. This is an unreleased
development contract change, with no permissive fallback or released adapter.

## Connected Account credential kind (unreleased 0.3)

Connected Account authentication and established-health results accept the
optional closed `credentialKind: 'oauth' | 'token'` provider fact. Authentication
settlement, retained prepared settlement and refresh carry it into the existing
V4 credential metadata's optional `kind`; inventory reads project that fact.
Presentation metadata remains unchanged. Omitted refresh facts preserve an
existing kind. Prior records without the field remain readable and unknown
unless the existing legacy-mode classifier recognizes them; no service or
modern authentication-mode inference or automatic backfill is introduced.
Unknown kinds retain health and selection eligibility; only a known kind
outside the Agent's declared set excludes an account.

This is a coordinated direct cut in unpublished 0.3: reload the matching
protocol, plugin SDK, daemon, server and clients together. Older strict metadata
readers do not accept the added field. Existing kindless records acquire a
known kind only after a real provider refresh or reconnect reports it. No
database migration, additional schema epoch or released 0.2 adapter is needed.

## Artifact kind change hints (unreleased 0.3)

The existing Account-change wake adds optional `artifactKinds`, and Artifact
catch-up hints may carry the same array of encoded, server-visible `Artifact.kind`
values. New UI readers accept omission from an older server and retain the existing
coarse refresh. Unknown or incomplete kind hints also stay coarse. Kind filtering
does not infer membership from locally known Artifact ids, so new shares remain
observable.
Classified values without a custom hint, including a normal Doc's `v1:other:`,
are complete metadata and can exclude unrelated typed catalogs.

Matching development Protocol, Home and UI load together: older strict development
wake readers reject the additional field. This is an optional read hint with no
new capability gate, wire epoch, database schema or released compatibility adapter.

## Session row-only change wakes (unreleased 0.3)

Secondary Home routing reuses the existing `sessionSystemRecords` fact. For a
Session-only wake, an explicit empty array proves that every coalesced Session
publication passed the canonical strict row-hint classifier. Unknown or
membership-changing writes retain a Session record target. The Home change
planner combines this existing proof with retained row membership to select
exact row reads. Missing proof, mixed domains, unknown rows and recovery retain
snapshot refreshes.

This changes no envelope, wire epoch, capability gate or persistence format.
Older publishers may omit the existing proof; new readers remain conservative.
The inspected 0.2 frontier at `ead3f779118d6a3d17e167517a64660f9e2c2c0d` has
no Account-change wake in `packages/protocol/src/updates.ts` (no local changes to
that file), so this routing correction needs no released compatibility adapter.

## Launcher observation scopes (unreleased 0.3)

The closed V1 local-service inventory watch request accepts optional `launcherScopes`,
derived from the launcher request's Session and Workspace fields. Mounted Workspace
launchers contribute these scopes to their shared Machine observation; transport
cancellation releases recursive package watching while retaining discovered facts.
Machine declaration observation remains independent of these scopes.

Matching development Protocol, daemon and UI load together. Older strict development
readers reject the new field; the inspected 0.2 frontier at
`1321319f311da3d44931afd39eeac7252b6350a4` has no local-service inventory watch contract.
No persistence, protocol epoch, fallback transport or released compatibility adapter changes.

## Continuation Session read authorization (unreleased 0.3)

Continuation inspection, batch inspection and transition brief preview require
`session.read` scope for the exact Session. Home resolves the requester's existing
`readTranscript` access before forwarding; the daemon binds the decoded
request's Session to that proof. Machine Use alone grants no Session access, and
Session read proof cannot authorize a mutation. Requester-owned and read-shared
Sessions remain eligible on shared Machines.

Protocol, Home, daemon/CLI and UI load this development contract together. Older
consumers reject the unknown proof; current Home rejects unscoped callers. There
is no permissive fallback, persistence change or new access-control owner.

## Ordinary spawn setup admission (unreleased 0.3)

The existing public Session-spawn admission projection adds optional
`machineSetupRequested: true`, derived from the canonical setup input. Home uses
it for the initial Machine role decision, and the daemon binds the projection to
the decrypted request, including rejecting an omitted setup projection. Ordinary
spawns without setup keep their existing admission shape.

The existing combined setup Run authorization also carries an ordinary Account
spawn's signed parent grant and reviewed-child identity. Its Machine role and
consent remain the original admission; unrelated Account Runs do not gain retained
authority. Protocol, Home, daemon and UI load this development contract together.
Older strict development readers reject the additional projection or Account
setup grant. The inspected 0.2 frontier has no ordinary spawn setup contract; no
predecessor alias, new credential, protocol epoch or persistence record is added.

## Managed Machine setup names (unreleased 0.3)

Managed Machine records use `machineSetup`; managed presets use `setup`.
The existing `20261026172000_rename_machine_setup_columns` migration renames
the previous development columns and their retained JSON operands for each
database provider. Its SQL remains unchanged.

The prospective 0.2 frontier (`1321319f311da3d44931afd39eeac7252b6350a4`,
including its index and working source on 2026-11-06) has no managed Machine
or managed-preset reader or writer for `environmentSetup` or preset
`environment`. Its ordinary Machine wire records carry `metadata` and
`daemonState`; SSH setup and provider environment profiles are separate flows.
This rename therefore needs no predecessor alias or second persisted format.

## Credential-free native Actions (unreleased 0.3)

The host-private Action declaration may set
`originalExecution.requesterCredentials: 'none'` for an Action that needs no
requester Account credentials. `machines.agents.signIn.status`,
`machines.agents.list`, `machines.agents.install.status`,
`machines.agents.install.cancel`, `machines.work.summary.get` and
`localServices.actions.stopManaged` opt in.
The shared credential-carrier policy also selects credential-free transport for
Services inventory reads (`machines.services.list`, `machines.services.discovery`
and `machines.services.detail`). CLI and browser dispatch consume that same
policy; logs and watch effects retain requester credential consent and custody.
The browser's Services inventory Resource continuation consumes that same
verified invocation codec and requester identity without acquiring full Account
credential custody. Its Resource target and input must match the admitted Action;
log Resources retain their requester credential requirement.
Foreign-Machine dispatch uses the existing sealed
invocation codec carrier; it conveys a fresh request/reply key and invocation,
never the requester's ordinary bearer or Account encryption key. Omission keeps
the existing credential custody and disclosure gate for other Actions. Native
inventory reads retain the verified requester identity and signed Home HTTP
projection without acquiring Account content keys; private Service visibility
still follows that requester. Home admission and Machine authorization are
unchanged. The declaration and existing carrier envelopes
remain closed, with matching development Protocol and dispatch/daemon readers;
no wire field, codec purpose, epoch or rollback adapter is added.

An original Account's Service Stop Ask stays in that Account. A human CLI
approval replays the exact reviewed Stop through the existing signed native
carrier; its confirmation binds the Account, Home, request, target and input.
Terminal authentication may carry that human CLI confirmation, while MCP and
automation cannot supply it. Already signed native approvals retain their
originating Machine custody, including in public approval reads.

On a foreign admitted `machines.agents.list` root, the receiving handler returns
the Machine's Agent roster and detection facts with the definition catalog
marked unavailable. It never reads the executor's Account ACP catalog for that
root. Requester definitions use the existing executable-only `draftDefinitions`
input; custodian catalog reads retain their existing behavior.

## Voice `voice` carrier retirement (0.2 → 0.3)

`voiceSettingsV1` is the only Voice root 0.3 needs. A 0.3 write omits the `voice`
root when it would be a pure derivation of `voiceSettingsV1`, and keeps the marked
carrier only while the Account still holds 0.2 material there: a pending Chat
import, a legacy credential source, a transcript epoch, retired tuning or a
recovery carrier. Reading 0.2 `voice` data is unchanged. This is direct-cut by
coordinator decision (no 0.2 ↔ 0.3 component coexistence): the inspected `../0.2`
checkout reads only `voice`, so a client rolled back to 0.2 shows Voice defaults
for such an Account, while `voiceSettingsV1` survives as a preserved unknown root.
A CLI Settings mutation is sparse and cannot remove the root; the next whole-document
UI write does.

## Contributed target teardown detach (unreleased 0.3)

The existing teardown Action's prepared/admission input also accepts the existing
unlink operand with `detachKeepRunning: true` and a teardown reason. Its result
accepts the existing typed unlink result alongside the native receipt result.
The installed descriptor owner selects this arm only when no teardown role is
declared; missing descriptor availability remains a refusal. Home retains the
manager-only unlink authorization and disposition rules, and consumers explicitly
report that remote resources remain running. This creates no provider-stop proof,
receipt, persisted format or migration.

Protocol, Home, daemon/CLI and UI must load these matching development contracts.
Older strict development readers reject the new input/result arm; mixed source
versions are not a supported transition and add no gate or fallback transport.

## Teardown custody refusals (unreleased 0.3)

Home teardown refusal uses the existing Action failure fields (`errorCode`,
`effectAttempted`, `details`, and `failureCause`) in the closed deployment result.
The nested reason/remedy, optional requiredFact and sanitized cause contracts remain closed; no identity,
authority, input, persistence format or wire epoch changes. Matching development
Home, Protocol and daemon readers load together: older strict development readers
reject the enriched result. Bare existing storage failures remain accepted. The
inspected `../0.2` checkout at `1321319f311d` has no deployment Action contract;
this adds no predecessor adapter or capability gate.

The same existing Action `details` and sanitized `failureCause` fields accompany
controller-placement refusals in authorization-mint and signed child-request
HTTP errors. The recorded Environment controller remains authoritative: the
request is refused with that required Machine and a remedy to run there or make
it reachable. No controller is substituted. Matching development Home, Protocol
and daemon readers preserve these optional fields; bare refusals remain valid.

Native target-placement teardown refusals also name the recorded Environment
controller in `details.requiredFact`. A sole remote native target now receives
teardown observation/removal through the existing signed admitted-child transport;
the recorded controller owns the receipt and its transitions. The child routing
owner keeps teardown and non-teardown action IDs narrowed by kind, without a
second admission. Matching development Protocol, Home and daemon readers load
these closed child contracts together.

The existing teardown admission captures Environment Domain removals through the
Domain owner under the same root operation. Its typed partial failure details
name the Domain, the missing fact and the remedy; the existing Action failure
cause is preserved. Stop and remove supplies the sole approval and keeps the
Environment when retirement fails. This adds no Domain registry or persisted
format and requires matching 0.3 development readers; 0.2 has no deployment
Action contract.

Stop and remove adds the optional `removeEnvironment: true` teardown operand.
The admitted receipt captures it in its existing proof JSON; final signed
settlement reuses the Environment disposition writer and returns the optional
`environmentRemoved: true` success fact. Failed or uncertain final removal
retains typed `removeEnvironment` partial details through strict approval
settlement and public/stored reads. Plain teardown retains its existing behavior.
These unreleased closed contracts require matching Protocol, Home, daemon and UI
readers; no new migration, child admission or fallback transport is introduced.

## Workspace Sync controls (unreleased 0.3)

`workspace.sync.relationship.replace` uses the existing relationship creation
request with an explicit `replaceRelationshipId` and `destinationIntent: 'use_existing'`.
The relationship owner stops the selected link before creating its replacement
with the reviewed mode and content policy. Both folders remain in place; if
creation fails after stopping, the failure is visible and the person can create
the link again. This is a new synchronization history, not an in-place policy edit.
Matching development Protocol, daemon and UI load together; no compatibility gate,
persisted relationship format or migration is added.

Replacement target preflight carries the same `replaceRelationshipId` in its
closed V1 request. The target authority may inspect the selected enabled link's
exact retained root custody without acquiring that root again. This preserves
the existing link while destination approval is pending; exact mirroring still
requires its deletion consequence, and another root holder still refuses.
Unknown fields remain rejected; matching 0.3 builds load this input together.

Shared-Machine Sync runs through the existing controller with the admitted
requester’s Account rows and retained execution custody. Use requires an accepted
Workspace inside that requester’s native member root; a custodian’s private ref
or directory does not supply authority. Manage retains explicit Machine filesystem
control while accepted refs and relationship writes remain requester-owned.

The list request may opt into `requesterAvailability`. Its typed result supplies
requester `homeDir` and `workspaceRoot` from the native placement owner, or an
unavailable reason. Source and destination pickers consume this result for
availability and path expansion; they do not fall back to custodian metadata.
Normal creation preserves the original signed Action envelope across the existing
SOURCE-writer/TARGET transport. The SOURCE’s admitted snapshot owns accepted refs
and staged worker-copy provenance; the physical TARGET owns root preparation and
replacement approval. A successful signed TARGET preparation also settles that
endpoint’s retained recovery journal; the SOURCE consumes that acknowledgement
instead of issuing a second raw recovery request. A pending journal preserves the
existing typed recovery refusal. Destination replacement preflight requires Manage,
and exact mirroring retains its reviewed deletion consequence. Load matching development
Home, Protocol, daemon and app together; no persisted format or migration changes.

Sync readers consume the canonical Machine RPC failure envelope before parsing
the strict success status. Handler `failureCause`, `effectAttempted` and `details`
retain their existing meaning. The UI displays the original failure code and
settles failed commands with unknown engine status, or completed observations
without an engine session, as unavailable instead of leaving a loading label.
A refused command preserves an already known engine status.

The native target's final READY record uses V2 for requester-owned copies. It
retains the original requester and installed SOURCE writer identities with the
exact relationship and Workspace binding, alongside the existing physical root
identity. It stores no credentials or signed admission envelope. After a WORKER
restart, the existing target authority consumes that binding and native receipt
for copy inspection and reviewed retirement. V1 records remain readable for
installed-owner recovery; a foreign copy without the original binding remains
refused. Fresh requester-owned copies need the matching daemon build before
creation. These Sync target paths are absent from the inspected `../0.2`
frontier at `7b37d65ca75e58560f8f3ca850958ac5407d2e75`; no released migration or
rollback adapter is introduced.

## Shared-Machine native Agent sign-in status (unreleased 0.3)

Machine Use can read the existing sign-in status RPC. The daemon omits identity
fields for Use and adds optional `signInScope`; owner/Manage responses retain
their prior shape. Load matching Home, Protocol, daemon and app together: an old
development daemon does not perform this privacy projection, and an old strict
app reader rejects the projected response. Do not enable the wider Home policy
against an old development daemon. No persistence, migration or protocol epoch
changes. The inspected `../0.2` checkout at `4aa70a37c4` has no
`packages/protocol/src/daemon/agentSignIn.ts` contract.

## Authored Domain preparation (unreleased 0.3)

The existing `deployments.domains.add` Action adds an authored `content` arm;
prepared Artifact operands remain accepted. Private content uses the incumbent
Domain schema, now owned by Protocol and re-exported by deployment-protocol.
The native admission projection carries the authored metadata digest, and the
storage admission carries the original input digest to bind its exact prepared
candidate. Load matching UI, Protocol, controller and Home server together;
older strict development readers reject these fields. No persisted Domain
format, migration, protocol epoch or released compatibility obligation changes.
The inspected `../0.2` checkout at `4aa70a37c4` has neither deployment Domain nor
deployment Action protocol files.

The same unreleased source adds optional receipt failure remedies, typed stale
review details with the current Environment revision, Domain network-exposure
diagnostics, and a public Domain header operation address derived from existing
private captures. Matching strict Protocol, UI, controller and Home readers must
load together. These projections add no persisted Domain state, migration or
protocol epoch. Shared UI technical details consume the typed cause, required
fact and remedy rather than deriving a new failure classification.

Store template partial results retain an optional typed Domain failure beside
completed install progress. The shared recovery reader consumes its authored
required fact and remedy; Caddy admin refusals retain the safe request phase and
HTTP status without exposing response bodies or configuration. Matching strict
Protocol, controller and app readers must load together for this unreleased
field. It adds no persisted state, migration, protocol epoch, timer or retry.

The Domain prepared-content request carries the existing Artifact mutation's
optional revision provenance and provenance key envelope alongside its body.
These remain opaque to the Domain owner and are committed by the Artifact writer.
This unreleased correction also requires matching Protocol and controller/Home
versions; older strict development readers reject the added fields.

Template Domain children add the existing Domain-native admission projection as
an optional field on the signed reviewed-child proof. Both HTTP and Machine RPC
serializers preserve it; the issuer derives it from the admitted authored child.
Home requires the exact template Environment and child-derived private candidate.
This unreleased change needs the matching Protocol, controller and Home versions;
it neither adds another Action nor changes the finite Deploy receipt's purpose.

Environment ingress updates retain the existing current-reference, revision CAS
and patch input. The controller derives private content after admission; its
ingress-only native admission and storage digest bind the exact authored patch
and CAS. Domain discovery receives a prepared candidate, checked against the
same admitted authored metadata. These additive development fields require the
matching Protocol, controller and Home versions described above; they add no
persisted format or migration.

Unprepared Domain removal extends the same development `domainDiscover` packet
with the original Remove operand plus current Domain content and target-link
references. Home admits those exact references; the native receiver observes
without setup. Load matching Protocol, controller, receiver, Home and Cloudflare
Account Action readers together. The disable Action also accepts an exact
reviewed tunnel name when no preparation was retained; its absent-tunnel success
has no tunnel ID. Prepared removal keeps its existing operand and result. No
persisted Domain format, migration or released compatibility contract changes.

The existing `deployments.bindings.set` success result adds optional
`preparedArtifact` references from the controller's prepared operand. The UI
uses those exact references when sharing a candidate before changing a source
to Team ownership. Load matching Protocol, controller and UI readers together;
the Home storage acknowledgment retains its existing shape.

## Link failure-observer diagnostics (unreleased 0.3)

The successful Link result may include a failure-observer warning with the
returned child's optional Action `errorCode` and its canonical `failureCause`.
New readers accept warnings without a code; older strict development readers
may reject the additional field. Load the matching Protocol and host together.
This changes no released contract, persistence format or protocol epoch.

Workflow Action failures and persisted invocation `reason` may retain the same
optional canonical `failureCause`. Completion preserves that cause separately
from result/details payloads; older stored rows without it remain readable.
Load matching Protocol, Workflow daemon and client readers together because
older strict development readers reject the additional field. No migration or
protocol epoch changes.

## Local Services observation lifetime (unreleased 0.3)

The existing closed inventory-watch request accepts optional `observationOnly`.
That request retains mounted producer demand until cancellation; value watches
continue to answer on material changes. The updated UI and daemon load together.
Older strict development daemons reject the field. No released contract,
persistence format, protocol epoch or migration changes.

The same inventory-watch request also accepts optional `launcherProjection`, containing
the canonical launcher scope/projection and the targets the caller already holds.
That watch returns the existing launcher snapshot shape only when its material targets
change. Guest reads use the launcher's requester-owned managed bindings; broad Machine
inventory remains unavailable to them. Unrelated activity never settles the projected
watch or discloses an inventory generation. Echoing targets costs payload proportional
to the caller's actual projection and closes the snapshot/watch gap without a cursor
registry. Cancellation and the existing parked-watch owner retain the observation
lifetime. Matching development Protocol, daemon and UI load together; older strict
development daemons reject the optional field. No released compatibility adapter,
persistence, protocol epoch or migration changes.

An observation-only Home still delivers authenticated Machine reconnects to its
mounted launcher consumers. Reconnect reads the WORKER's current requester
projection, including an empty result after daemon retirement, without enrolling
a Session or Machine census. Other Machines and ordinary heartbeats do not renew
that read.

An authenticated admitted guest's broad inventory read returns the existing
`RPC_METHOD_NOT_AVAILABLE` result after the credential-custody owner validates the
Machine admission. Missing or invalid custody retains its refusal; credential-bearing
mutations and preview reads retain their strict scope. The matching development UI
retains this unavailable read outcome without inventing an empty inventory snapshot.
A healthy settled empty requester launcher composes as empty Services, and Check again
refreshes that available projection. Genuine scan, transport and credential failures
still offer their existing recovery. Load the matching daemon and UI together.


## Triage source availability diagnostics (unreleased 0.3)

Configured sources in the aggregate list result add optional
`availabilityFailure` using the existing closed source-failure schema. The list
projects the upstream plugin-admission code and plugin id from the registration
snapshot; consumers disclose that supplied cause without another inventory read.
Omission preserves existing results and does not manufacture a request id.
The exact reobservation result carries the same optional source failure on its
existing `unavailable` arm, so detail reads preserve the same supplied diagnosis.

Registration, the aggregate producer, shared schema and mounted readers reload
together under the unpublished 0.3 development cut. Earlier strict development
readers can reject these fields. No persisted record, protocol epoch, gate,
migration or predecessor adapter is added.

## Triage exact PR status lookup (unreleased 0.3)

The closed V1 Session-relation result and Triage entry Action input accept optional
`sourceInstanceRowId`, the private configured-source storage address selected by
the relation owner. The PR Resource passes it into each fresh status admission;
the address grants no authority and the current row must still match the requested
stable UUID, source and active lifecycle. A missing address produces the existing
unavailable result rather than a whole-inventory fallback.

The relation producer, shared schemas, PR Resource and status Action load together.
Older strict readers reject the new field; new readers accept its absence without
inventing an address. This is an in-place development change with no persisted
format change, migration or protocol epoch. UUID-only administration keeps its
existing lifecycle-index lookup.

## Execution Run starting Account (0.2 → 0.3)

The Run store owns requester-scoped ID reads and lists. A detached Run's stored
starting Account takes precedence. If starting attribution is absent, the Run
belongs to the daemon's captured installed Account. Missing installed identity
does not grant access. Foreign requesters receive the existing not-found refusal
for ID operations and cannot see the Run in lists. This rule adds no migration,
backfill, version flag or special handling for earlier 0.3 development builds.

The separate `machines.runs.list` Action reads the existing process marker
registry through `daemon.executionRuns.list`. Manage sees the Machine-wide
inventory, including fallback marker details. Use sees only markers whose stored
Home, Account, Machine and installation attribution matches the receiving Home
and authenticated Machine admission; unattributed or invalid records never establish Use visibility.
Requester Session Run reads retain their separate scope. The Action, Home policy
and daemon filter load together in unreleased 0.3; an older development daemon
does not implement the Use projection. This adds no RPC payload or persistence
format, migration or version flag.

The unreleased `machines.capabilities.detect` Action refreshes only the existing
Tools Check-again operand and returns refresh status with an existing typed
failure cause. It accepts a Machine target, never a caller-authored detection
request, and discloses no detector facts. UI facts remain in the incumbent pushed
capability cache; agents read the approved `machines.agents.list` projection.
`machines.add.local.cancel` cancels enrollment through the answering App's
retained task and existing SystemTaskRunner custody, including a pending native
start. It creates no separate task registry or persistence format.

The inspected 0.2 source at `512915f3ccf4a29a8454b74ad9db6ca72079d916`
routes Run starts within one Account (`apps/server/sources/app/api/socket/resolveRpcCallTarget.ts:26`). Its only
cross-Account RPC exception is the approval family, which excludes Run start
(`packages/protocol/src/rpc.ts:331`). The installed identity is supplied by host
composition; neither a Run request nor the requester chooses the fallback owner.

## Home-owned Machine presence (unreleased 0.3)

Home stamps `presenceProtocolVersion: 1` on published Machine rows. This additive
projection selects authoritative pushed online/offline presence independently of
the daemon's operation capabilities. A 0.2 daemon therefore uses the same Home
presence authority as a 0.3 daemon. No persisted field or migration is needed.

The daemon sends a heartbeat every 50 seconds. This cadence replaces the initial
60-second owner decision to leave margin below released 0.2 clients' 60-second
grace. Each steady beat updates its Machine row once and renews the existing
offline deadline. With only current clients attached there is no audience read
or client presence delivery. The default deadline remains three intervals:
150 seconds after the last received beat, subject to the existing operator
override. Home pushes one observation per recipient on each online/offline
transition; the offline observation retains the last stored `activeAt`.
An explicit clean socket disconnect persists Offline immediately and releases
the publisher claim before pushing the transition. An unexpected
transport loss retains the missed-heartbeat deadline.

Live Machines have no client expiry timer. A failed request can say “Unreachable
from this Home” without a ticking last-seen label. Offline labels use the retained
last-active time. Opening a Machine page or popover pulls that timestamp once;
periodic heartbeats cause no current-client UI work. The existing keyed activity owner publishes
presence transitions without replacing inventory rows or lists.

Before the first census or pushed activity answer, retained UI rows are Unknown.
`resolveMachinePresence` owns that decision and the Home/legacy presence rules;
`isMachineOnline` is its nullable adapter, and request reachability layers scoped
request failures over the same result. An answer lives in the UI Machine record's
in-memory `activity` state, shared with display projections and retained by the
record owner on same-authority content replacement. Warm display persistence
omits it. A first census arrival answers even when all cached values match, and
only that Machine's activity readers wake. Status subscriptions compare the typed
presence result, so a same-value first answer becomes visible without heartbeat
rerenders. The existing legacy grace timer schedules its absolute deadline from
wall time; an older sampled reader clock cannot postpone that deadline.

The Agent settings presentation input also carries `online: null` while unknown.
Its closed V1 envelope remains strict; this bounded presentation value grants no
execution, routing or credential authority. Protocol, UI and first-party Agent
settings surfaces refresh together under the unpublished 0.3 direct cut; older
strict development readers reject null. No persisted format, epoch or adapter is
added. The scoped-clean `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has neither
`packages/protocol/src/plugins/ui/agentSettings.ts` nor the Claude settings surface.

An Account socket loss retains each known Machine's last online/offline verdict.
Reconnect and inventory revalidation do not introduce an intermediate Unknown
state. New activity observations, request outcomes and revocation update the
shared reachability verdict; wall-clock passage alone does not expire a
Home-owned presence observation.

Machine admission retains a content-free availability diagnostic when the
requester has access: its closed `reason`, `requiredFact`, and `remedy` distinguish
an offline Machine, a missing installation, revocation, and replacement. External
Actions keep `target_unavailable` as the failure code and carry this diagnostic in
V1 execution `details` or pre-open HTTP `diagnostic`, including authorization
minting. Current clients retain
those fields through their Action failure projection. This unreleased 0.3 contract
requires matching Protocol, Home, and client readers; it adds no admission checks,
presence timers, retries, or persisted fields.

A 0.2 Home omits the projection marker, retaining its existing UI heartbeat grace
and shared runtime clock. Its ten-minute default Machine timeout accommodates a
0.3 daemon's 50-second cadence. A 0.2 UI connected to a 0.3 Home receives the real
stored observation on each beat. Home identifies these sockets by the existing
stored-content handshake's `legacy-missing` result: released 0.2 sync clients send
no declaration, while current 0.3 clients send the current declaration. No new
feature gate or client-dependent daemon cadence is introduced. Each Home indexes
its local legacy sockets at connection admission; only Homes with such sockets
resolve the current Machine audience. Clustered Homes forward each steady
observation through their existing server-side transport so legacy readers on a
different replica receive it; current clients receive transitions only.

| Daemon | Home | UI | Presence delivery |
| --- | --- | --- | --- |
| 0.3 | 0.3 | 0.3 | Home marker; transitions only; no client expiry |
| 0.3 | 0.2 | 0.2 or 0.3 | Real 50s observations; released 60s grace |
| 0.2 | 0.3 | 0.2 | Released daemon cadence; legacy-only real observations |
| 0.3 | 0.3 | 0.2 | Real 50s observations only to legacy sockets |
| 0.2 | 0.3 | 0.3 | Home marker; transitions only |

The 50-second cadence leaves 10 seconds for delay before the released helper's
grace expires; a delay exceeding that margin can still cause a visible legacy
flip. No synthetic timestamp, lease or 0.2 backport changes this behavior.
Revocation and request-failure verdicts retain their precedence. Earlier
undeployed 0.3 capability negotiation is removed rather than maintained as a
second presence authority.

## Link preparation scope admission (unreleased 0.3)

The closed V1 execution binding adds optional `deploymentLinkAdmission`, carrying
the Environment id and its owner captured by Home at issuance. Link preparation
inventory, Environment reads and the Link mutation require those facts and refuse
older bindings without them. The closed V2 encrypted request adds
`deploymentLinkEnvironmentId`,
a non-content selector checked against the sealed input by the opener. Home uses
that selector to admit the Environment and derives its owner itself; the sender
cannot supply an owner admission.

Link publication creates one private target-content Artifact whose UUID is derived
from the signed invocation and admitted Environment. Only that Artifact can receive
the admitted Team's admin grant or recipient-key preparation; Link authority cannot
update or delete Artifact content or read unrelated Artifact identities. Artifact
routes retain the requester's persisted Account encryption-mode and content-access
checks, including when the executing Machine belongs to a different custodian.

Target comparison lists accept optional `selection` with the public source and
target kind. The server applies it before paging and content admission; matching
candidates retain their complete-coverage and private duplicate checks. Updated
Link clients send this selector and require the matching server schema. Older
strict 0.3 servers reject it; unselected list requests remain valid, with no
whole-inventory retry for selected requests.

Target lists reuse the existing opaque deployment cursor envelope when the last
selected row is omitted, so an empty partial page can reach later valid rows
without exposing the omitted identity. These tokens bind the actor, Home, owner
scope and target selection and require the updated target-list reader. Existing
raw admitted-row cursors and requests without cursors remain valid. Environment
cursor bindings and persistence formats do not change.

`deployment_invalid` may also carry a closed, secret-free Link validation
`diagnostic`. Older strict error readers cannot retain this optional field;
the updated Home and clients load together. Plain refusals remain accepted.
This unreleased development correction adds no persistence format or epoch.

Updated server, daemon and originating clients must load together. Older strict
readers reject present new fields; retained requests lacking admission need a
fresh approved Link. There is no unbound read fallback or envelope downgrade.
Account encryption mode, content envelopes and stored Environment data do not
change, and no migration is required.

## Software first-presence provenance (unreleased 0.3)

Software Apply records the executing native interpreter's presence observation
before its first mutation, even when the daemon's earlier check was unavailable.
Only proven absence makes a new item eligible for declared Remove; pre-existing
or unproven software stays retained. Existing source-fact persistence, Account
content envelopes and removal admission are unchanged; no ownership is inferred
for earlier installations whose initial presence was never recorded.

For package-selected programs, first-presence matches the selected checks' exact
native package identities against the executing interpreter's observations.
Supporting packages and repository trust do not establish target presence.
Existing recorded first-presence remains authoritative on repeat Apply; this
correction does not infer or rewrite the history of earlier installations.

The closed managed-CLI result adds optional `initialPresence` in admitted plan
order. The daemon and executing Machine's managed CLI must load the matching
implementation together; older strict internal readers reject the new field.
Older results without it remain readable and do not fabricate executor evidence.

## Reviewed recipe scripts (unreleased 0.3)

The closed recipe-step union adds `script`, carrying a literal body, a POSIX
shell, optional literal check and optional impact. The declaration, resolved
Plan, reviewed digest and elevated interpreter consume the same typed arm.
Protocol, daemon, managed CLI, review client and bundled recipes must load the
matching source together; older strict readers reject a present new arm.
Existing step shapes remain unchanged. There is no new protocol epoch,
migration, legacy-script translation or retry through an older representation.
Software first-presence and removal keep their existing native-footprint owner;
a script check contributes no installation presence or new persisted state.

## Software native failure diagnostics (unreleased 0.3)

The native apt owner classifies failed update/install commands into a closed
category and retains their phase and exit code in `failure.nativeCommand`.
The added diagnostic contains no raw command output, package names or lock-holder identity.
A proven busy package manager uses `package_manager_busy` and asks the person
to retry after first-boot or other package-manager updates finish; unknown lock
ownership still requires an administrator check. No automatic retry or lock
removal is introduced.

The shared Setup result and root-process protocol carry optional `failure`
using the existing elevation-failure schema; Action completion and composed
Setup retain it. Load the daemon and the executing Machine's managed CLI
together: older strict readers reject the added internal/public fields.
New readers accept older results without diagnostics and do not invent a cause.

## Deployment child HTTP authorization carrier (unreleased 0.3)

The execution binding optionally seals `deploymentChildRoot: true` at mint.
Updated dispatch readers require that fact; an absent stamp does not grant child
custody. Mint rejects caller-supplied stamps. This changes the unreleased 0.3
server/CLI contract together; no mixed-version child-dispatch guarantee is claimed.
The 0.2 predecessor has no deployment-root counterpart.

Deployment child HTTP proofs reference the authorization token already carried
in the outer authorization header instead of repeating it inside the proof.
The server reconstructs the full logical proof before the existing token,
binding, source RPC signature and receiver HTTP signature checks. Signature
inputs and authorization predicates are unchanged. A missing outer token or
unknown reference is refused. The reader still accepts the full-token proof.
Servers must load the reference reader before updated CLI/daemon writers;
older servers refuse this new carrier. There is no unsigned or legacy retry.
HTTP 431 is a typed `request_headers_too_large` transport refusal, not a
deployment output schema failure; no server header limit is raised.

## Local private service reference routes (unreleased 0.3)

The private service reference resolver selects the native loopback publication
when source and consumer share a Machine. Cross-Machine exports continue using
Iroh; direct-route grants still require distinct endpoints. Local references
reuse the existing container bridge and retained observation custody. Receipt
reference addresses record the closed `local` route with an optional
`containerNetworkId`, so restart recovery restores the same bridge without an
Iroh self-route. Missing export observations carry `service_export_unavailable`
through the existing deployment exception and Action failure-cause projectors.

This is the unpublished 0.3 direct cut: matching Protocol and daemon readers
reload together; older strict development readers reject the new route member.
The scoped-clean 0.2 frontier at `c680de922e4475b7dfbaeedcd63a8af7d985d3c3`
has no deployment reference-address schema. No migration, gate or predecessor
adapter is introduced.

## Deployment output diagnostics (unreleased 0.3)

The public receipt-list read accepts either its existing closed header or that
header plus the closed `requiredFact`/`remedy` recovery pair. The Action adapter
projects the pair for failed, cancelled and unknown rows using existing receipt
state. Stored receipt headers, private content and terminal states are unchanged.
Matching development Protocol, CLI/daemon and clients must reload together;
older strict development list readers reject the added presentation fields.
There is no new wire epoch, admission input, credential or persistence format.
The inspected 0.2 frontier `33f6528a541872654370d84bd316261e8f7cacb6`
has none of the Protocol/CLI deployment directories or Cloudflare deployment
plugin (and no local changes in those paths); no released predecessor adapter
is needed.

An accepted deployment's signed metadata read is authorized once against its
exact active receipt and Environment. Later HTTP purpose dispatch consumes that
admitted read instead of classifying it again as a new root operation. Malformed
signed carriers retain the existing authorization phase in both the HTTP refusal
and the redacted server warning; no proof or credential bytes are logged.

Private deployment receipt failures may retain optional `validation` with the
parser source, HTTP status and structural schema issues. Existing failures
without it remain valid. Rejected response values, unknown-key lists and custom
error messages are excluded using the existing Action validation projector.
The HTTP response acceptance and authorization rules do not change. Server,
daemon and clients that read these closed receipt envelopes must reload together
before producing the optional field; older strict development readers reject
it. Public receipt Events continue projecting only failure code and phase.

Receipt failures also retain the producer's optional `effectAttempted` boolean.
Known `true` and `false` survive receipt readback and approval settlement; an
older failure without the fact stays unknown. Dispatch alone does not establish
that an effect started. Matching strict receipt readers must load before this
optional field is written; the existing V1 operation projection is unchanged.

Teardown approval failures retain the receipt's Environment and revision
coordinates plus the existing teardown step and safe reason code. The shared
strict settlement/read projection binds those details to the requested
Environment and failed or unknown receipt state; opaque fields are discarded.
This restores existing producer details without changing admission or V1.
Native `unsupported_action` refusals before receipt creation retain their strict
reason/remedy details through the same projection, along with their typed cause
and producer-authored effect fact.

## Native administrator refusal diagnostics (unreleased 0.3)

The shared elevation owner retains the missing native fact and its remedy for
Software Apply and Domain setup refusals. Native observations supply their fact
name; an observation without a separate fact name retains its checked step id.
The existing failure projection adds optional `remedy` beside `requiredFact`;
readers still accept retained failures without either field. Raw native output
and credentials remain private, and admission and administrator policy do not
change. Load the updated managed CLI on the executing Machine before replaying
these diagnostics. Older strict 0.3 diagnostic readers need the matching update;
the existing V1 operation adapter continues to omit these details.

## Shared-Machine Workflow requester custody (unreleased 0.3)

The existing `requester_session_bootstrap_v1` private installed message adds
`scope: 'workflow_trigger'`, with an exact Machine target, opaque scope id,
optional Automation id for trigger custody, and `retain`/`retire` operation. A Session message keeps its existing absent scope
(or explicit `session`). Both the discriminator and input are covered by the
existing installation seal; changing either invalidates the message. An older
strict daemon refuses the new scope. There is no unsealed or custodian-credential
fallback. UI and daemon must reload together to use shared Workflow custody.

The existing daemon-local requester custody record may retain an optional
`retireWhenIdle` marker for a disabled or deleted trigger. It uses the same
at-rest protection and is not sent to the server. Re-saving clears that marker;
the existing Run terminal/reconnect events drain admitted work before retiring
the context. The protected record retains the Automation association so the
existing guest Account-change/reconnect observer can read the exact Automation
inventory and retire offline deletions. If reconnect cleanup wins before a late
save commits, its occurrence gets the content-free custody refusal and the person
re-saves. No new queue, timer or server-side custody record is introduced.

Machine-only Automation wakes add an optional requester-scope routing hint.
Run summaries add optional `errorCode` so existing typed Workflow presentation
can show `requester_custody_unavailable` with re-save/start-again recovery.
These fields contain no private content. Older loose wake readers ignore the
routing hint. Normal Run summaries omit the error field when there is no error,
preserving the ordinary owned-Machine response shape. Older strict Workflow
Run-summary readers reject a present new error projection, so the UI must reload
with the server for that presentation; they cannot execute the new
shared-Machine flow. Server and daemon must reload together for
admitted-installation routing and accepted-job authorization.

`AutomationRunAssignment` adds nullable `admittedMachineInstallationId` in a new
additive migration; existing migration files and Run ownership are unchanged.
Old servers ignore the column, and old clients never depend on its presence.
Existing null assignments retain their prior owned-Machine path. New shared
admissions require the current server, schema and daemon. Deploy the migration
before loading the new server; rollback does not remove the nullable column.
No new table, Machine-recipient Run envelope or Account permission is introduced.

Existing owned Machines may have no installation identity: the identity migration
adds nullable fields without backfilling earlier registrations. A Machine can
also retain encrypted content after its Account changes to plain mode until its
next registration performs the content transition. Workflow admission preserves
the previous owned-Machine behavior for these retained records. Installation
and content readiness remain requirements for the shared-guest path; this does
not grant legacy records new execution or missing-custody settlement authority.

## Live SCM rename reads (unreleased 0.3)

Live `scm.diff.file` rename reads use the closed
`{ renamed: { path, previousPath }, area?, ...SCM envelope }` selector. Its nested
path pair is also closed. The omitted legacy top-level `path` makes older
daemons refuse rather than silently ignore rename lineage and return an
addition-only patch. Ordinary file requests retain their additive-open/drop
shape. Matching UI and daemon readers load together; no wire epoch, runtime
ABI or persisted format changes. The inspected 0.2 predecessor at
`512915f3ccf4a29a8454b74ad9db6ca72079d916` has the required top-level `path`
reader (scoped-clean `packages/protocol/src/scm.ts`).

The Action owner normalizes this selector into the existing backend file request
with `previousPath`. Git includes both paths for HEAD comparisons; pending-only
diffs still compare the destination in the index. Captured selectors remain
closed and continue reading their pinned evidence.

## Paged live SCM status reads (unreleased 0.3)

Live status adds the closed optional `entriesPage: { limit, cursor?, path? }`
request and `snapshot.entriesPage: { totalFiles, nextCursor }` response. The
snapshot summary and totals describe the whole repository; entries describe the
requested page. An exact-path request returns that entry without walking later
pages. These are delivery projections of the existing status computation, with
no persisted format or backend ownership change. The requested row limit is
caller demand; the existing workspace-file socket response byte budget is a
ceiling. A page that reaches that ceiling preserves its continuation, while
oversized metadata or an individual entry returns the existing `too_large` error.

The Machine SCM transport sends the operand only when the addressed Home's
Machine advertises `scmStatusSnapshotPaging: { protocolVersions: [1] }`. The
daemon publishes that capability only when Home accepts the leaf. Missing
support omits the operand in the original request, preserving the full legacy
read without a probe or retry. The inspected 0.2 predecessor at
`519c05dc1320396738f42babf2d6a2a2af754e4f` has neither operand nor page metadata
in `packages/protocol/src/scm.ts`; new consumers continue accepting its full
snapshot. Older consumers receive the same full response when they omit paging.

## Unchanged full SCM status re-reads (unreleased 0.3)

A full changed-file list reply (no `detail`, no `entriesPage`, at least one
entry) carries `snapshot.listRevision`: a content revision of the delivered
facts that ignores observation times (`fetchedAt`, `freshness`, the cached PR
projection's `checkedAt`). A caller holding that list sends it back as the
optional `knownListRevision`; when the fresh scan delivers the same list the
reply is `{ success: true, unchanged: true }` with no snapshot, and the UI keeps
its held snapshot object (no republish). Any other shape, or a changed list,
returns the full reply with its new revision. The scan still runs: this removes
the transfer, parse and store work of the deliberate re-reads (workspace-watch
readiness, PR discovery, focus) when nothing changed, not the daemon's status
computation. A daemon without the field never produces a revision, so it is
never sent one; there is no persisted format and no 0.2 reader of this field. Producer: `apps/cli/src/rpc/handlers/scmStatusSnapshotProjection.ts`;
consumer: `apps/ui/sources/scm/scmRepositoryService.ts`.

## Paged SCM capture reads (unreleased 0.3)

Capture inputs add the closed `projection: { kind: 'index', cursor?, path?, limit? }`
request. Its success adds `page: { totalFiles, nextCursor }`; projected files
carry explicit deferred evidence without patch strings. Source, comparison,
page and file envelopes remain closed; persistence still writes full evidence.
The existing captured source union and RPC wire epoch are unchanged. This
request cannot be safely ignored: daemons predating index projections reject it,
and the UI reports that refusal without retrying a legacy whole-evidence request.
Viewport-sized pages are negotiated separately through the existing pushed
Machine operation capability `scmComparisonIndexPaging: { protocolVersions: [1] }`.
The daemon publishes this installed-handler capability only when Home's existing
feature response accepts the leaf. The UI's Machine SCM transport reads the
addressed Home's Machine projection once before dispatch. Missing or unsupported
support omits only `projection.limit`, retaining the older index/cursor/path
shape, pinned comparison and ordinary authorization. It adds no probe or retry.
This covers the pre-`2867466524be0e077dc680f7f60032fc278a88fa` 0.3 index reader
observed in VALIDATE92's older daemon; it does not establish 0.2 capture support.
Older development clients can still read small legacy replies; oversized
legacy reads fail within the existing reply budget with a client-update reason.

Captured `scm.diff.file` reads omit the legacy required top-level `path` and
instead use the closed `captured: { comparisonId, source, path, sessionId? }`
selector. An old daemon therefore refuses the request instead of silently
returning a live working-tree diff. Ordinary file requests and their semantics
are unchanged. The response's optional `capturedFile` carries the retained
file; it is not a new persisted format or an alternate evidence authority.

Session-scoped file reads use the existing optional `readTranscript` Session
authorization classification. Load that registry entry and the captured-file
handler together with the UI transport. Captured file reads take the same SCM
Action admission path as the index: Session scope is the ceiling, followed by
admitted Machine or signed public-Action custody and forwarded Session lookup.
Request selectors do not grant authority. A refused scope never falls back to a
broader Machine read or a live diff. Mixed intermediate 0.3 builds are not certified;
the coordinated component upgrade requirement below still applies.

The inspected 0.2 basis (`b06b31d66f9474bcf322627ae63ecf6a37d4a9a2`, clean
SCM protocol/handler paths) and source tags `cli-v0.2.17` / `ui-web-v0.2.18`
(`a2c45c86804b24e60ac0b76146a3ef36dfcaa15b`) expose ordinary file diff but no
capture counterpart. These observations establish source compatibility, not
artifact deployment certification; the existing 0.3 encrypted-RPC coordinated
upgrade rule still applies. No legacy giant-response fallback is introduced.
Saved generated-result response schemas are unchanged. Their outward comparisons
retain all file and occurrence identities while using the existing deferred
evidence shape instead of patch bodies. Matching CLI and UI readers must load
together so opening a saved deferred file uses the pinned capture reader. Existing
full saved records remain readable through the saved-result owner; internal model
context, refinement and Undo keep full evidence. There is no dual saved-result
writer or legacy whole-patch response fallback.

Retained captures are private CLI storage. The current writer keeps complete
evidence in one atomic record file, with a patch-free index and seekable file
positions; its existing pathname is unchanged. The capture owner recognizes old
JSON records, validates their repository, Session and source, serves the read,
then promotes them through that same writer. A failed promotion preserves readable
evidence and emits a content-free warning; later reads can still incur the old
full-record cost until promotion succeeds. No background migration or cache is
introduced. Earlier intermediate 0.3 CLIs cannot read the new record layout;
load the matching CLI to retain access. This is part of the coordinated unreleased
0.3 transition above, not a change to the captured-file wire envelope.

## Contributed Action Automation recipes (unreleased 0.3)

The existing V1 Automation recipe adds the `contributedAction` target and private
`actionInput` template member. V3 definition writes accept this target alongside
Workflow V2 recipes. New daemon workers use the `execution` claim scope and
receive the explicit `action-v1` discriminator; older readers reject these new
shapes. This is an in-place 0.3 development extension: servers and workers that
execute these definitions must be upgraded together. Existing Workflow V2 and
retained one-shot recipes keep their existing owners and wire shapes. No stored
schema migration, alternate writer or old-worker fallback is added.

## Idle compaction records and capabilities (unreleased 0.3)

This is an in-place development SDK contraction: one strict compaction
descriptor replaces the old SupportLevel shape and duplicated bundled manifest
literals. External plugins targeting this development API must update their
Agent declaration and return the capability of the runtime actually opened.
An unsupported opened mode cannot inherit support from another mode.

Stored `context-compaction` events add `trigger: 'idle'` and optional measured
`tokenCountBefore` / `tokenCountAfter`. Existing manual, auto, threshold,
overflow and unknown triggers remain readable. Historical raw compaction
readers remain for retained transcripts; live runtime events use the canonical
typed writer. Runtime `outcomeUnknown` remains outside the stored phase grammar.
Only idle origin is newly quiet, including the owner-produced encrypted local
identity understood by the server's existing write admission.

The approved policy is a one-way upgrade. The predecessor 0.2 reader's closed
trigger enum rejects new idle records, so reverse mixed-version reading and
rollback to that reader are unsupported after these records are written. There
is no dual writer, rewritten trigger or old-reader alias. The observed predecessor
basis is `c16edc75540e5f8819932f9d90495564b9b2db7f`, scoped to its unchanged
`packages/protocol/src/sessionMessages/transcriptRawRecordV1.ts` trigger grammar.
The three optional Account preference maps preserve missing-as-inherited values
and require no stored-data migration. This is development-source compatibility,
not a release certification.

## Computer provider trial (unreleased 0.3)

Computer Actions add optional `provider` inputs; omission retains the enabled
Machine default, initially Cua. Account Settings adds `computerUseByMachineId`
through the existing Settings reader/writer. Capture/query responses add optional
provider identity and query capture binding; older responses remain readable.
The mutation input union adds element click/set-value (and native drag/wheel/move).
These closed operation envelopes never reinterpret an unknown kind as pointer
input: an older Computer daemon rejects it as typed `invalid_parameters`.
A mismatched provider or obsolete element binding returns
`computer_element_stale`, requiring another observation. An explicit disabled or
missing provider returns `computer_provider_unavailable` with an install hint.
This is a contained development-source trial, not a released availability claim.

Machine-person Computer control makes the person-facing RPC's Session field optional;
omission selects a source keyed by the verified requester Account on that Machine, using
the existing owner/Manage or personal-desktop route. Session calls retain their existing
shape. A Session-less capture has an inline PNG `frame` instead of Session `media`.
These are coordinated 0.3 development-source changes; an older closed receiver may reject
the new request or `move` operation. Hover uses the same stream sideband relay and is sent
only under human control, coalesced to the latest pointer position per animation frame.
Touch does not produce hover. Unsupported native target/provider combinations return
`input_not_supported` rather than turning hover into a click.

The shared 0.3 viewer input envelope also carries optional click button/count and
key/click modifiers. Existing callers can omit these fields. Closed older
receivers reject unsupported additions; the native provider returns its typed
unsupported result when a combination cannot be delivered. Browser trackpad
drag uses the existing drag Action's live pointer phases. Computer trackpad
drag uses the existing atomic input on release, with a client cursor and trail;
it does not introduce native button-down/up primitives. Input mode is scoped
device-locally to the viewer, while pinch and edge panning affect only the local
picture. Simulator gestures retain direct device input.

Computer clipboard read/write are additive Actions on the same scoped transport
and private desktop worker. In unreleased 0.3 source, UI, Agent, MCP and public
automation use the same Actions; automation defaults to Ask and the person can
waive it per surface. Their text remains live-only and redacted from Action
observations. Clipboard reads and writes share the selected source's automation
consent; See-only selections refuse automation writes. Agent calls retain agent
control admission, while present-user calls take over control. Supported native drivers transfer text, while other drivers return a
typed unsupported result. This addition does not reinterpret an old input
kind or provide an older daemon with a fallback clipboard path.

## Custom theme library (unreleased 0.3)

Saved custom definitions are Account-scoped `theme_profile.v1` Artifacts. The
kind is excluded from the generic Artifact browser and sharing; its Account
owner retains Artifact deletion rights. The
`ThemeProfileLibrary` facade owns addressed save, duplicate, delete, selection and
Undo operations. It uses the existing Artifact transport, revisions and
Account encryption mode: plain Accounts use plain envelopes, and E2EE Accounts
use the existing Account-scoped cipher. A theme save writes one body and its
header together. Lists use header metadata; bodies are opened only on demand.
Theme mutations publish bodyless Account changes and suppress legacy body-bearing
Socket events; addressed Artifact reads deliver the retained document. Other
Artifact kinds keep their existing publication behavior.
Create acknowledgements add an optional `created` fact. Only `true` permits
delete-on-Undo; Keep refuses selection if an older server omits that fact.

A parsed theme document retains its raw JSON alongside the fields this build can
apply. Unknown presentation fields and safe token identifiers survive unrelated
edits and export; unsupported presentation has no visual effect. A deliberate
edit overlays only the supported fields it changed. The header carries palette
inputs and style summary; the miniature is derived from those inputs at read
time. An explicit Reset removes known seeds, style or CSS while retaining unknown
presentation children; omitted sections in a partial edit remain unchanged.

Device `themeProfileSelection` entries are tagged Artifact, built-in or plugin
references. An unavailable reference renders the mode's base theme without
rewriting the saved choice. Pure light/dark/adaptive changes retain both mode
references. Startup can apply bundled built-ins immediately; Artifact and plugin
presentation arrives through the source owner's demand hydration.

The released 0.2 Account `themeProfiles` array, device-local legacy library and
scoped pending envelope are one-shot migration inputs. They are excluded from
writable effective Account Settings. The migration owner transfers raw documents
through the same Artifact facade, then retires the old Account source after
acknowledged record writes. Canonical definition identities produce deterministic
Account-scoped Artifact ids, coalescing equal inputs and separating differing
same-id definitions. A lost response retries the same destination. Released
pending edits and attempted-remap checkpoints remain readable solely for this
transfer; the new client creates no staged intent or parallel settings writer.
Device selection settles before source retirement, and cleanup retains failed
inputs for retry. If cleanup fails and a person deletes the copied Artifact before
the retry, replay of that retained input can recreate its id; the person can
delete it again after transfer completes. Existing scope activation moves retained pending inputs and the
legacy Account binding together; another Account cannot consume that backup.
An existing destination pending theme snapshot and checkpoint take precedence
over an older server-identity alias; the alias is a fallback, so explicit
deletions in the current snapshot cannot be resurrected by a union.

The retained `yourThemes` settings Action is an adapter to the facade while its
callers transition to theme Actions. Its read returns the canonical header
inventory and tagged selection, loading headers on demand through the same
Artifact owner. A missing Account context or failed load returns unavailable;
the read does not enumerate bodies. Older 0.2 clients cannot edit the new Artifact
format. Upgrade preserves their saved input without an ongoing bidirectional
settings/Artifact mirror.

## Local Action Operation acknowledgements (unreleased 0.3)

Activity and Inbox share device-local terminal seen and dismissal decisions in
MMKV under `action-operation-acknowledgements-v1`, qualified by Home and Account.
The qualified operation store hydrates each scope synchronously before publishing
its first replayed snapshot. Complete daemon operation lists prune decisions for
receipts no longer retained; machine removal prunes only after the scoped machine
inventory has settled. Transport-unavailable active suppression remains ephemeral.

The reader accepts the current 0.2 predecessor's v1 entries without a revision,
binding their seen acknowledgement to the first terminal replay. New entries add
`seenRevision` so a later terminal refinement can need attention again. Existing
0.2 readers ignore that optional field. Explicit dismissal hides a failed receipt
from Activity and Inbox while resource details retain the daemon's failed result.
Clear recent preserves failures, active work, and unresolved follow-up attention;
held reviews still require a decision. These preferences do not synchronize across
devices and do not change daemon or server wire contracts.

## Trigger

Apply this policy when a change affects a cross-component wire shape or semantic, persisted/session/settings data, schema or migration, feature/capability negotiation, installer or service state, upgrade/coexistence, or rollback. Routine internal refactors that leave these seams unchanged do not need a compatibility matrix or shim.

### Shared internal Tasks (0.3 development integration)

Personal-task label colours are an additive development extension. Item
`labels: string[]` and legacy item/index writes remain unchanged. The sole colour
writer uses the separate Account KV key `task-label-colours.v1`, outside the
released `todo.*` inventory, with the existing Plain/E2EE envelope owner. New
readers accept a missing catalog and project the neutral `secondaryText` token.
Optional host `labelColors`/`labelCatalog` and source snapshot `labelColors`
extend the development Action results; snapshot `labels` remains a string
array. Observation snapshots are process-local/wire values and are not embedded
in Triage's persisted Collection declarations. The new set/clear Actions require
an upgraded host; they do not need a dual writer or a stored-data migration.

Task sharing preserves the owner's `todo.<id>` row and private `todo.index`;
additive grant/envelope relations do not copy content into a new task store.
Plain sharing does not rewrite content. E2EE promotion writes the task-key
representation through the existing Account-KV classifier, which refuses raw-KV
access to that representation. Older 0.2 clients keep the existing typed KV
`426 update required` for current task formats: there is no filtered list or
plaintext compatibility copy. The Account-mode transition converts the same row
with its complete grant audience and recipient envelopes.

New task-resource clients recognize the older Home's exact unknown-route response
as typed unavailable. Existing personal-task operations may retain their ordinary
Account-KV path there; sharing does not fall back to a weaker grant or content
path. Owner-qualified shared identities keep same-id tasks from different Accounts
distinct while preserving personal aliases. This describes development source,
not released sharing availability; see [the encryption boundary](encryption.md#shared-internal-tasks-03-development-integration).

The development Task Action contract accepts omitted edit/transition Task scope
from plugins: the authenticated invocation supplies it, while explicit UI echoes
must still match. Applied mutation snapshots include that captured scope. Session
link inputs may omit qualifiers and resolve them at their existing authenticated
owner; explicit qualified Session links retain their current meaning. Action-only
parent references may carry the existing full entry identity; the mutation owner
resolves them to the same stored parent id and owner-relative blockers. No Todo
storage format, Account mode or grant contract changes. These recursively closed
Action shapes are an undeployed 0.3 direct cut, not unknown-field normalization;
an older strict development Action host may refuse the new inputs. The inspected
0.2 predecessor has no internal Task Action schema, while its stored Todo records
and bare Session links remain readable through their existing owners.

Task read snapshots and grant rosters may carry nullable `ownerDisplayName`,
projected by the neutral Account display owner beside an already-authorized
resource. Task-specific grant rows may carry `readiness` counts: ready, waiting
for an envelope, and each existing Account-key unavailability reason. Mixed
Team/Group audiences retain all counts rather than choosing one reason. These
closed development response extensions are optional for older Home responses;
absence is unknown, not a positive readiness fact. They add no Todo field,
profile endpoint, recipient authorization rule or plaintext compatibility copy.

The development Task list accepts optional `selection: { kind: 'ids', tasks:
[{ ownerAccountId, taskId }] }`. The resource client sends it as a JSON query
field on `/v1/tasks`; the server applies the owner-qualified set before reading
content and acknowledges it with `selectionApplied: true`. A selected read
without that acknowledgement fails as `task_selection_unsupported` before
opening bodies, so an older Home cannot silently return its entire inventory
as a selected answer. Omitting the selector preserves the existing request and
response. Parent and Session relations remain inside encrypted Task content;
this extension adds no persisted metadata or relation index.

### Retired workspace replication files (0.3 development)

The 0.3 daemon leaves 0.2's `<activeServerDir>/workspace-replication` files at
their original paths with unchanged contents. It never executes or adopts that
state, and its presence does not refuse new sync or daemon startup. Mutagen
uses its separately owned state directory. Existing retired-state quarantines
are also left untouched; no automatic restore, deletion or migration occurs.
Retired replication wire requests retain their operation-scoped update-required
refusal. These are distinct disk-preservation and wire-execution contracts.

The explicit inspection RPC is diagnostic only; startup and new operations do
not inspect old files. A present path is reported as `preserved`, without
traversal, classification or permission changes. Session handoff settings no longer
mount the retired recovery consumer or infer filesystem trouble from a missing RPC
or a daemon version. Older diagnostic variants remain readable
for older development daemons; they do not become admission facts in new code.

The preservation vector comes from immutable `cli-v0.2.11`
(`98ea8fb76733b1dd785d38c31360179cafa84824`) and the moving 0.2 paths/job store.
The required directions are old files beside the new daemon, and a downgrade
finding those same unchanged files. No new-engine state is written into the old
format, so there is no reverse-format adapter or mixed-engine coordinator.

## Producer-owned Home process facts (0.3 development)

The server configuration registry classifies launch, update and build facts as
`internal`. Home settings writes refuse these entries with `not_home_editable`,
and settings projections omit them. Retained Home overrides cannot supply or
replace these facts at startup: the launching producer's environment wins, and
an absent producer value stays absent. Existing stored records remain readable;
this classification correction requires no persistence migration.

## Foreign-Session HTML policy (unreleased 0.3)

D15's own-Session Board-authoring defaults change Action declarations, not
settings rows or approval-request shapes. Existing explicit Require/Waive
preferences remain authoritative. The internal host policy hook carries an
optional contextual-safety fact already produced by admission; its adapters
consume that fact before the declaration defaults activate. No new scope,
classifier, migration or parallel approval path is introduced.

The `foreign_session_html` caller class is host-private policy context, not a
new transport surface or guest-supplied authority. Its deliberate per-target
choices use the additive `actionsSettingsV1.callerSurfacePolicies` root. Existing
Action rows, surface arrays and scoped approval rows keep their prior grammar.
Qualified Resource policy targets share the same writer but are not executable
Action ids. The current Account Settings CAS preserves an omitted optional
caller-policy root from an older writer; `{}` clears it deliberately.

The existing durable approval execution origin has an optional, finite
`callerSurface: 'foreign_session_html'` fact. Only host-classified foreign
requests write it; existing origins without it remain readable and ordinary
writes are unchanged. The origin builder captures it and the existing replay
context restores it for the same policy owner. The current 0.2 predecessor has
no execution-origin validator and accepts unknown approval-root fields; it does
not supply this new policy enforcement. No alternate approval format or replay
decision-maker is introduced.

The moving 0.2 predecessor's Action rows are strict, while its open root is
projected back to known fields. Keeping the new choice outside those rows
preserves the predecessor's existing Off/Require choices. An old reader may
discard only the new caller-class choice; a current reader then returns to the
default refusal rather than granting access. Older hosts do not enforce this
new class. This is development-source behavior, not a released availability or
mixed-version enforcement claim; the current loaded bridge and policy owner
must be exercised together. No Project override, new wire epoch, migration or
parallel policy writer is introduced.

## Shared-Machine requester isolation (unreleased 0.3)

Machine Shell discovery opts into `machineShell: true` on the existing terminal
list request. Its optional `machineShell` result carries either the requester's
default `cwd` or the terminal owner's typed refusal. Ordinary list responses
keep their existing shape. The Machine header and Shell sheet consume this
result; Machine metadata is not a fallback for an unavailable requester root.
This development extension requires the updated daemon for root discovery and
adds no Action, persistence format or migration.

On a shared Machine with native member placement, the default comes from the
existing member identity's workspace root. That root permits daemon-group
access; the member's private home does not. Manage retains full Machine control
and explicit paths. A present Use requester can open only its own native member
root through this Machine Shell path; accepted Project and Session terminals
retain their existing custody. Native identity and retained requester custody
continue to refuse another Account's terminal.

Off preview optionally adds `plan.retirement`, and accepted/unchanged Set results
optionally add `retirement: { removed, retained }`. The closed presentation rows
carry the bootstrap owner's observed resource, planned disposition and typed
retention remedy; they grant no execution authority. The exact setup plan still
owns elevated removal. These optional additions retain old-result readability;
older strict development readers require the matching Protocol update before
using the new daemon response (the existing 0.3 all-component direct cut).
There is no persisted format, new Action, wire epoch or released/predecessor
counterpart for this isolation retirement seam.

The preview's optional `setup` preserves the elevation owner's closed refusal
and recovery. Read-only CHECK under administrator mode None may return recovery
`{ kind: 'configure_admin_access', mode: 'preauthorized' }`. This is presentation
guidance only: it changes no policy, admission or attended Ask support. Current
readers still accept missing recovery; older strict development readers reject
the new recovery variant, so its producer and consumers update together. No
released/predecessor counterpart, persistence change or new wire epoch applies.

The requester-only `machines.agentIsolation.status` V1 read may include
`directories: { home, workspace }` on `protection: 'member_separated'`. Both
paths come from the daemon's already verified native member identity and
provisioning owner, after its existing readiness observation; they are never
Machine metadata, another member's roots, or execution permission. The status
envelope, status variants and nested directories object remain closed. The
directory projection is optional, with no new union member, npm version change,
wire epoch, persistence, probe or polling. New readers accept omission by an
older daemon and leave a separated requester's automatic folder unresolved;
they never substitute the custodian's home. A current New Session uses the
member workspace as its automatic default and the member home for expansion.
Explicit and retained draft paths stay exact and can receive the existing typed
isolation refusal.

Older strict 0.3 development readers reject a response containing the new
optional field; adding an optional field alone does not provide that direction
of mixed-version compatibility. A UI-before-daemon update or an explicit
response transition is required before activating this producer with older
readers; the supported rollout direction needs an owner decision.
The prospective 0.2 worktree at `67123c84ca168ac6f7847532a531eaa7f5566111`
has no own-status Action or schema, so it establishes no counterpart for this
unreleased seam. New-reader/old-daemon omission degrades safely; this does not
establish old-reader/new-daemon support.

Deployment roots may carry optional `admittedMachineRole: 'use' | 'manage'`,
minted from Home's existing Machine admission. The host verifies that carried
fact against the signed root through the existing verification request before
using it for stored-definition deployment admission. Missing role does not
grant Machine Use deployment authority; legacy owner/Manage admission remains
unchanged. This is an additive development authority projection, not an
ignorable user-input field or a new permission role. The new deployment-scoped
restart Action requires a matching 0.3 host; Machine-wide service control is
unchanged. The 0.2 predecessor has no supported deployment-root counterpart.

Home-signed deployment HTTP refusals optionally carry the authorization owner's
closed `authorizationRefusal` phase. Daemon RPC authorization refusals use
`credential_scope_denied` with `diagnostic.admissionStage: "daemon_rpc"`, the
existing `RPC_FORBIDDEN` code and an optional code-only `failureCause`. They are transport
refusals, not Action settlements or receipts. Current readers accept omitted
diagnostics from older producers; older strict development readers require an
update before consuming these additional fields. Deployment child admissions
also require a daemon that understands the signed `deploymentChildRoot` binding;
an older closed binding reader rejects that field before execution.

Domain and receipt read roots bind their single `environmentId` at Home minting.
The HTTP authorization owner compares that binding for both Environment
preparation and metadata reads. Encrypted V2 requests project only that identifier
as `deploymentMetadataEnvironmentId`; the request codec checks it against the
protected input, and Home uses it to mint the same binding as plaintext requests.
Older strict V2 readers need refreshing before consuming this projection.
Installed development payload v19 accepts those
roots without the binding but rejects the same roots with `environmentId` under
its older refinement. Refresh those guest readers with the controller; omission
must not bypass the binding. Domain child approvals also use the existing daemon
replay placement so replay retains its operation acceptance.

Failed approval executions may retain the existing code-only `ActionFailureCauseV1`
as optional `failureCause`. Settlement, public approval reads and CLI JSON preserve that
cause and an explicitly supplied `effectAttempted`; the CLI does not infer an
effect flag from `RPC_FORBIDDEN`. New readers still accept older executions with
no cause. Older strict approval-execution readers, including the #62 development
reader, need refreshing before consuming this field. Controller and guest readers
must therefore update together; this is unreleased development behavior.

For stored Machine metadata, an absent isolation policy reads as disabled through
`readMachineAgentIsolationPolicyV1`. A predecessor daemon without an isolation
observation does not establish support: the held daemon reader reports
unavailable, while absent host-power observations remain unknown through
`presentMachineAuthorityV1`. Invalid/unavailable metadata is distinct from an
absent field and refuses isolated launch rather than silently selecting off.
Stored readers discard additive fields; Action inputs and current publication
schemas remain closed. These are separate read/write boundaries, not a second
launcher or an identity downgrade path.

Isolation Action READ, preview and set results accept the member-qualified
effective status without a shared `agentUser`. Persisted global launch status
still requires its shared-user proof. The daemon and client result readers
refresh together for this unreleased 0.3 correction; no stored shape changes.

The prospective 0.2 `apps/cli/src/api/types.ts` Machine metadata/daemon-state
schemas do not produce isolation policy or observed host-power facts. Its
first-party install layout uses the ordinary Happier home; the 0.3 dedicated
`HAPPIER_FIRST_PARTY_INSTALL_HOME` input leaves the no-override personal layout
unchanged. It separates payloads/shims/tools from `HAPPIER_HOME_DIR` private
state without migrating Account credentials or changing the published Machine
shape. An older binary's ability to operate that dedicated installation is not
established by personal-layout compatibility; no automatic downgrade or
fallback to private-home tools is promised.

The development SSH enrollment role/administrator flags and explicit-identity
Machine-add Actions require the matching new CLI/client implementation. An old
closed Action reader rejects this new intent rather than discarding it. When
no identity is selected, generated personal SSH commands retain their existing
argument shape; this path does not impose a CLI update floor. No alternate
installer, synthetic managed record, version fallback or new wire epoch is
introduced. The optional author-saved Preset controller label is existing
Preset content; readers accept its absence without a migration or additional
controller metadata access.

The shared bootstrap replaces the desktop `hsetup` installer path in place.
Released desktop `ui-desktop-v0.2.19` (`63829e3cd6a8f1f48b10891af0c8b2313e51ac7e`)
bundled `hsetup` and used ordinary personal installation; omitted-identity
enrollment retains that placement. The new dedicated choice requires the new
bundled host as well as its client. This adds no lasting parallel installer or
update floor for personal enrollment. The existing mobile SSH transport carries
the shared bootstrap's finite command/stdin exchanges; source tests are not a
claim that every supported native release has executed that journey.

MI-1 changes the execution and filesystem authority consumed by existing
terminal, Session, raw execution, MCP and file/transfer owners. Retained draft
MCP syntax and legacy filesystem aliases remain readers of those owners; they
must not retain independent daemon-user effects. A caller-selected root, Account
Workspace reference, Team role or copied Session context does not supply host
filesystem or present-owner authority.

The deciding mixed-version direction is old client → current Home → old daemon:
protected non-owner operations must refuse at authoritative admission when the
target cannot enforce the boundary, with an unaffected owner positive control.
A new-client warning alone proves no such protection. Released artifact and
moving-predecessor vectors, plus loaded-runtime enforcement, must be pinned by
the implementation's composed validation before claiming that direction verified.
This documentation does not establish those pending results or impose a global
client update floor.

Home's authoritative admission requires a valid, positively revisioned
`requesterExecutionIsolation: { protocolVersions: [1] }` Machine-operation leaf
for protected non-owner execution and filesystem operations. The verified
Machine custodian's ordinary person or non-Session Account automation remains
exempt across operation families, not only Session authorization minting.
Genuine Session-origin raw/file deputies require enforcement even when their
Account is the custodian: copied Session authority cannot borrow an old daemon's
file authority. Existing finalized typed Project/Session payloads retain their
canonical family/root admission, including owner Session mint and its native
delivery. Independent Action approvals,
scope/currentness checks, native-effect admission and existing Agent/presence
restrictions still apply. Capability exemption does not turn an Agent Session
or copied Session context into present-person authority. Non-owner typed
Session admission still requires the leaf. Unrelated capabilities retain their
existing behavior. During a Machine
RPC-daemon handshake, a newly claimed socket withdraws only that leaf before it
becomes eligible, even when the installation is unchanged. Withdrawal and
publication share the existing Machine publication fence; only the current RPC
owner can replace the complete projection, after its enforcers or typed refusals
are installed. An old publisher cannot restore a withdrawn leaf.

The `/features` fact
`capabilities.machines.requesterExecutionIsolation.protocolVersions: [1]`
declares that Home accepts this representation and enforces its admission
contract. It is not a grant, native-readiness result or effective-isolation
observation. Daemon publication must negotiate this fact and omit exactly the
new leaf when Home support is missing, malformed or unsupported, preserving
owner operations and unrelated capability leaves. The existing daemon
publication resolver consumes the existing Home-snapshot resolver for this negotiation,
including when no unrelated capability is ready. Daemon composition retains its
existing feature-refresh owner; negotiation adds no direct feature request, timer
or native-readiness inference. Source negotiation and Home admission/lifecycle checks
do not by themselves establish the complete loaded-runtime validation described
above.

New Home code also typed-refuses protected non-owner or Agent-origin raw RPCs
whose actual receiver is Session-scoped, independently of the Machine leaf.
A retained old Session process cannot inherit enforcement from a newly upgraded
daemon's advertisement. A verified physical Machine custodian, calling without
Agent/Session source authority, retains its existing owner route through the
same optional Machine-admission receipt; new Session receivers recheck that
receipt against the exact Session binding, Home and local installation.
Session ownership alone does not establish Machine custody. The inspected old
receiver ignores the optional receipt fields; this is source compatibility,
not an executed old-binary claim. A new receiver cannot adopt missing requester
authority from an older Home: that protected raw operation remains unavailable,
without rejecting the connection or unrelated owner operations. Focused source
coverage does not establish the complete loaded-runtime journey.

The CLI's immutable requester attribution retains its existing saved-profile
`serverId`; it must not be reinterpreted as canonical Home identity. The optional
`homeServerIdentityId` belongs to existing private custody/bootstrap/credential
scope. Fresh birth captures the held or verified Home, and recovery preserves
and compares that retained value instead of adopting the current profile's Home.
Absent historical Home identity stays unknown. No public Session birth schema
field, SDK serialization, migration or parallel identity registry is introduced.

Lack of requester-child scope alone does not qualify an ordinary native owner
Session. MCP and native Exec/SCM share the exact protected-file discriminator,
using the original held profile id and Home: genuine `ENOENT` or complete
original tuple/Home with the same original credentials must accompany independent
current Account/Machine/exact-Session proof. Malformed or incomplete historical
custody, foreign Home/Account and a different unrecovered bearer refuse rather
than adopting old credentials, another catalog or a new Home. Existing successful
canonical scoped recovery, including a different bearer, remains unchanged.
The result is owner-Agent identity, not person break-glass. This correction
changes no wire or persisted format.

Qualified ordinary owner Sessions also use the existing accepted-Project launch
preparer without inventing private birth. This preserves current Project trust,
review and environment contracts; it does not imply that an older Home supplies
Project APIs it never supported. The captured general child Account reader is
independent of managed-MCP selection, including for E2EE Provider and selected-
secret material; no ambient Account fallback or format transition is introduced.

Grant-based PluginExec uses the same host-private requester identity as resolved
Agent launches. Project refusal diagnostics reuse the existing bounded
`{code, stage}` cause, preserving the outer failure code; no additional strict
response field, requester identity format, or public Action schema is introduced.
Runner logs accept only the canonical closed Project causal codes, not arbitrary
plugin exception details.

For the supported `.17` Home and matching predecessor wire, authenticated exact
Machine GET was owner-only. The canonical CLI reader preserves that seam only
for its complete, validated legacy response generation, before tolerant row
parsing. Modern or mixed responses missing `access` do not imply ownership.
This private proof applies only to ordinary stored-credential Account Sessions;
held Home, Account lifetime, exact Machine/local installation and revocation
checks still apply. It creates neither an access DTO nor person authority.

Opaque API credentials in a closed local CLI custom-tool workflow use their
existing authenticated Self endpoint, not JWT decoding or stored-Session
provenance. Before catalog/material access, the held Home, current Account and
actual local Machine installation must establish the custodian. This remains
Account automation, not an ordinary Session fallback or present-person proof;
private requester scope cannot be discarded to enter it.

The current observed effective isolation shape still names one `happier-agent`
user. It does not establish per-member separation or confidentiality for selected
credentials, Direct-delivered keys or readable Session context. Unknown,
desired-only and applying state cannot upgrade that claim. MI-2 is now being
integrated, not yet verified as a complete usable journey. Its explicit reviewed
`memberProvisioning: 'linuxUsersV1'` policy is distinct from historical
`enabled: true`; an old preference does not authorize member provisioning.
Following the 2026-11-07 owner ruling, new dedicated managed Machines (cloud,
Lima and Lume) select that reviewed member policy at the enrollment producer.
Existing Machine metadata and enrollment-record parsing stay unchanged, with no
migration. Separate users off retains shared-Agent placement when Agent isolation
is enabled.

The preceding 0.3 Protocol at `f85e44aed3b76272a8afdbc2cee871059e19d86a`
already accepts the optional `linuxUsersV1` value in policy, preview and set
inputs, so this default adds no field to those contracts. An older guest CLI
using those schemas can parse the new creation child, but its older enrollment
producer still compares against the shared-Agent default and refuses that child.
Home, controller and guest must load the updated enrollment producer together
for new dedicated enrollment. This preserves a typed policy refusal rather than
silently claiming member separation on an older guest. The inspected 0.2 frontier
at `f760eedfec477fef70f56f30c7f250e5ccb23e7d` has no isolation or managed
enrollment Actions; its CLI Machine metadata reader drops unknown fields. That
reader can ignore the metadata safely but cannot establish member separation or
execute these children. Guests predating the member-policy contract need an
update for this flow; ignoring the policy is not evidence of isolation.
The daemon-private reverse binding pins the qualified Home/Machine/installation/
Account tuple to its native UID and home. Restart or regrant must reuse that
verified binding, never reassign its private files to a newly selected UID.
Private launch frames carry the same selected native identity and runtime home;
they are an unreleased host/payload contract, not a new public identity issuer.
The own-requester status read does not turn the aggregate shared-user observation
into a per-member security claim. Mixed-version refusal and actual Linux
confidentiality remain deciding validation, not conclusions supplied by these
formats. Machine-owner visibility of material delivered there remains part of
the trust model after that transition.


The 2026-11-02 guest-fallback amendment changes host placement, without changing
policy or refusal wire shapes. Enabled Linux member provisioning selects member
users; otherwise guests use the owner's Agent placement (shared Agent user when
enabled, daemon user when disabled). Requester credentials and Session roles stay
intact. Happier's Computer controls require Manage to access the owner's real
display. In fallback mode, a guest's Agent runs as you and can do anything you can
do on this Machine, including seeing your screen. Pre-amendment 0.3 daemons
may return `agent_isolation_unavailable` for those guests. Updated clients retain
the typed isolation-failure presentation rather than retrying a private RPC or
claiming separation. Updating the daemon is required to obtain fallback behavior.
The retained 0.2 checkout has no member-isolation surface, so it cannot certify
this pre-amendment 0.3 refusal path. No persisted migration or version shim is
introduced by the placement change.

## Inbox Work group identity (0.3 development)

Unreleased 0.3 provider-deletion reminders use the closed `managed_machine`
Inbox focus arm with the existing `serverId` and `id` fields. The mounted Inbox
and `inbox.get` expose the same transient item and deletion-time context; its
page and native notification destination resolve through the Inbox focus
registry. Matching development Action readers must refresh with the producer.
The headless CLI retains its explicit unavailable live-item coverage. No
Inbox state, wire epoch or released-client contract changes.

The deletion-reminder lead time is the deliberate Account preference
`managedMachineDeletionReminderLeadTimeMs`, defaulting to two days when absent.
The existing Settings Actions expose it as
`machines.defaults.deletionReminderLeadTime`, also rendered on Machine defaults.
Inbox attention and local notification scheduling subscribe to that key for
each inventory entry's exact Home and Account through the shared exact-Home
settings owner. Unsynchronized or absent Account settings withhold new
reminders; the focused Account never supplies another Home's preference.
Editing it updates the existing notification schedule. Unknown Account keys
remain preserved by older readers. This additive development preference needs
no migration or additional deadline store. Native keeps its OS schedule when
the app closes. Browser and desktop reminders use the shared deadline timer
while mounted, canceling only the changed entry on a notice or preference
change; they make no closed-app delivery guarantee. Browser delivery requires
notification permission.

The current app-shell `inbox.get` read requires `serverId` beside `sessionId` on
each closed `lead` root. The mounted model preserves that Home even for an
unreadable lead; equal Session ids on different Homes cannot share a group or
suppress one another. The headless CLI notice reader emits no Work groups.

This corrects an unpublished 0.3 read projection. The inspected immutable CLI
stable/preview `cli-v0.2.17` / `cli-v0.2.17-preview.1`, UI stable/preview
`ui-web-v0.2.19` / `ui-web-v0.2.19-preview.25`, and mobile/desktop `v0.2.19`
tags, plus the moving 0.2 predecessor at
`a4c8a3a1746a59d9d8d0318a643b69099b3880bb`, have no `inbox.get` producer or reader.
There is no supported unqualified root to preserve. Matching development
serializer, strict reader and generated SDK DTO move together; older development
readers may reject the corrected shape. No persistence migration, new epoch,
released-client update floor or reverse-development adapter is introduced.

## Runtime failure transcript metadata (0.3 development)

Current 0.3 exact Run reads may include `inputTurns.last.error`, using the existing
`ExecutionRunErrorSchema` and `runtimeIssueV1` carrier even while the retained Run
remains running. Its failure cause optionally retains vendor `requestId` and
`retryable`; absent fields mean unreported facts. New readers accept older
records with these fields absent. Earlier development readers with strict turn
schemas require the matching 0.3 update to accept the new error field. The
server-readable Session socket remains witness-only and excludes turn errors.

`SessionRuntimeIssueV1.failureCause` is an optional presentation leaf carrying
identifier-only cause codes under the existing issue-code bound, closed
preparation/turn phases and classified reasons, recognized native codes
or a JSON-RPC integer code, and an HTTP status in the protocol's valid range.
Its nested object is closed. Correlated Codex JSON-RPC application rejections
may add optional `providerErrorMessage`, using the existing bug-report secret
redactor; response data and generic native error messages stay excluded.
The redactor preserves filesystem paths in provider prose. Strict 0.3 cause
readers must load the matching schema before receiving that field; causes
without it remain valid. This optional diagnostic has no authority or retry
meaning. The outer issue keeps
its existing additive-open/drop read policy: absence remains valid. Older
readers that accept the surrounding issue discard the leaf while retaining its
code and safe preview; existing Agent-vocabulary adaptation is unchanged.
This adds no authority, retry decision, lifecycle event, wire epoch or migration.
The inspected moving 0.2 predecessor (`48d42d420446e3d90e1a4587ccd6e4794d00a79e`)
has the same unknown-field-drop outer issue policy and no cause leaf; no
compatibility adapter or client update floor is required.

Unreleased 0.3 `SessionModelTransitionResultV1` failure variants also retain this
optional closed `failureCause`. The live configuration adapter projects native
diagnostics through the primary Session issue owner; coordinator failure and
reconciliation results, prompt settlement, and Action details retain that cause.
JSON-RPC request codes remain integer `providerErrorCode` values, not HTTP
statuses. These closed transition readers require matching development source;
older results without the leaf remain valid. The inspected 0.2 frontier
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no corresponding transition
contract. This adds no wire epoch, persistence migration, authority or retry rule.

The unreleased 0.3 `SessionSpawnLaunchErrorV1` admits an optional closed
`agentIsolationRefusal` diagnostic for member preparation. It retains the
owner's setup reason, native preparation phase, available setup reason code and
owner-review remedy. Unknown PluginError fields remain excluded. Producer and
strict development readers must load matching source; this diagnostic grants
no execution authority or retry policy.

Unreleased 0.3 deployment approvals retain the closed
`DeploymentSourceAdmissionFailureV1` diagnostic before a receipt exists. Action
details retain its phase, reason, required fact and remedy; receipt failures use
the same schema in `sourceAdmission`. Older approval projections may discard
this diagnostic, so displaying it requires matching development source. The
diagnostic grants no authority and changes no retry or isolation policy.

The unreleased 0.3 `SessionSpawnLaunchErrorV1` also admits this same optional
`failureCause` leaf for runner failures before native Session startup completes.
The runner producer, daemon child-exit projection and strict launch-result readers
must load matching development source. Older strict development readers may reject
the new field; an absent cause remains valid. This changes presentation only and
adds no released-client update floor, migration, wire epoch or retry behavior.

The unreleased 0.3 private `session.open.attest` operation and persisted runner-open
attestation admit optional `failure` with the existing launch-error code schema,
construction phase and optional closed `failureCause`. This distinguishes rejected
native construction from native-mode refusal and a missing acknowledgement; it
does not create a second diagnostic channel. Forms without `failure` remain valid.
Older strict development daemon/host readers reject the new field, so the FIN
replay requires both roles to reload matching source. The released 0.2 tree has no
corresponding private attestation seam; no released SDK or public wire epoch,
migration, retry policy or client update floor changes.

The same unreleased closed launch-error schema admits optional `subtype` for
source-runtime reload diagnostics. Strict development producers and readers
must load the matching schema; results without a subtype remain valid. The
existing error code, admission and retry decisions are unchanged. This adds no
released-client update floor, wire epoch or migration.

Host failure messages carry the existing typed `SessionRuntimeIssueV1` in optional
`runtimeIssueV1` message metadata, beside the legacy `runtimeIssueCode` and
`runtimeIssueSource`. The canonical stored-message reader retains these declared
display facts for owners and authorized collaborators; malformed optional issues
are dropped without making the fallback text unreadable. Older readers may
ignore the new field and display the stored text. Typed Team failures and native
Agent sign-in requirements omit the generic Agent-failure prefix. Native sign-in
previews and stored text use the same existing code/source/Agent facts as the UI;
a Provider endpoint credential failure retains Provider guidance. The failed-turn
marker remains a non-rendering lifecycle record, not a second issue row. No
stored schema or migration changes are required for this text correction.

This is a presentation-only addition to the existing message-metadata envelope,
not an input, credential, recovery or permission authority. It changes no SDK
activation ABI, event union, admission rule or database schema. The inspected
moving 0.2 predecessor has no typed Team failure metadata; its messages remain
readable without it. No adapter, migration or client update floor is required.
Historical recovery controls and resource-name presentation are separate UI
composition; carrying the issue does not establish that those controls render.

## Provider connection usage (0.3 development)

The optional strict `usageSources` executable declaration, registered usage
parsers and explicit `providers.usage.refresh` Action are unreleased additions.
The response reuses existing Provider Account Usage snapshots and Q1 meters;
missing capability remains `not_supported`, and missing optional billing binding
remains `not_configured`. Unsupported older hosts must refuse unsupported
executable declarations through normal plugin admission, not silently grant a
new network or credential operation.

Each bounded usage read admits its Source, parser and credentials before the
request. Destination authorization and Saved Secret acquisition remain at their
existing boundaries. An admitted response finishes if its parser or credential
is subsequently retired; revocation applies to the next read. Cancellation and
the operation deadline still apply to the admitted read.

Separate billing credentials reuse the existing slot-keyed Saved Secret binding
format and Account/Machine writers. Only declared slots can be set; stale slots
remain clearable. No credential migration, alternate settings format, PAU ledger
or Connected Account revision is synthesized. The inspected moving 0.2
predecessor has no Provider contribution/usage Action seam; its existing PAU
meter records remain readable. No adapter for never-released development SDK
types or reverse-binary execution promise is introduced.

The existing Q1 meter adds optional `currency`, a three-letter uppercase
presentation code. New readers still accept legacy `unit: 'usd'` meters without
it. DeepSeek emits CNY with the existing neutral `unknown` unit and a denominated
label; predecessor readers drop the new leaf and retain the amount without
misrepresenting it as USD. No unit-union expansion, conversion, persistence
migration or credential authority is added.

The existing `usage` ephemeral may include optional `providerConnectionId` and
`machineId` wake hints captured from the ingested request's attribution. They
select a currently demanded observation for invalidation; the existing Action
still owns authorization and acquisition. No current Session selection supplies
a missing hint. Legacy/native events omit it, and new clients then perform no
connection refresh. The inspected moving predecessor `../0.2` at
`285ee7c5acb3bea1489896a254e4445f2483a213` has a passthrough usage-event reader
and no consumer of these hints. Its producer and reader paths had no staged or
unstaged changes. Existing Session usage events remain readable in both
directions; no new event union member, routing authority or SDK epoch is added.

The same development `usage` event may carry a closed optional
`accountingChange: { sessionId, observedFromMs? }` read-invalidation hint.
An ordinary Session ingest names its Session and earliest affected observation;
native subjects and native-history deletion use `sessionId: null`, because
reconciliation can span linked and unlinked Session rows. Legacy report bridges
name the Session without a time boundary, preserving their older baseline.
Both Home socket paths use the same Usage publisher. A mounted query can skip
an unrelated Session or a range ending before the observation, but never exclude
an observation merely because it precedes the range start. Allowance-only reads
remain outside accounting invalidation. Missing hints from older producers keep
conservative accounting invalidation; the hint supplies no read permission,
checkpoint or accounting value.

The scoped moving `../0.2` frontier at
`ff9a75fe6da334934b568b84df7662d4120c3ed0` and immutable
`ui-web-v0.2.19` / `server-v0.2.17` usage readers/producers retain the existing
passthrough event without this hint. The inspected predecessor paths were clean.
An older reader can ignore the optional hint and preserve its existing behavior;
new readers accept an unhinted event. This changes no persisted format or wire
epoch. Source compatibility evidence does not establish a loaded mixed-version
replay.

Development Session Account changes may also carry optional
`usageAccountingChanged: false` with `usageAccountingUnchangedSinceCursor`.
The existing coalesced change owner establishes this floor only for known
Session writes that leave accounting inputs unchanged. The client compares the
floor with the change page's starting cursor, so a later status update cannot
hide an earlier, unconsumed transcript or accounting-relevant change. Unknown
writes and deletion withdraw the proof; missing or malformed hints preserve
conservative accounting invalidation. Session/private evidence still refreshes.
This additive development hint changes neither read authority nor Follow source
currentness, and requires no database migration, table or wire epoch. Older
readers can ignore it; new readers accept older unhinted producers.

Development Session Account changes may likewise carry optional
`memoryInputsChanged: false` with `memoryInputsUnchangedSinceCursor`. Only the
runtime-activity, publisher-presence (register, heartbeat activation, expiry,
activity loss), ready-projection, pending-queue bookkeeping, Turn status and
Agent-state-only writers mark it; they change no Session seq, archive state or
owner locality. A later `updatedAt` can only widen the 30-day selection, and the
transcript write that follows any queued input carries that change. The same
coalesced change owner keeps the floor, so a later activity write cannot hide an
earlier, unconsumed metadata, transcript or archive change. The daemon Memory
worker skips its Session read only when the consumed range is covered; missing,
malformed or withdrawn hints keep the read. 0.3 development only: no migration,
table or wire epoch, and 0.2 readers never see the field.

Development CLI and UI Usage Session evidence use the query-owned
`/v2/usage/session-evidence` projection, without inventory or singleton fallbacks.
It returns only the selected Sessions. The optional 0.3 development request flag
`readWorkFacts: true` returns compact actor-scoped Session SystemRecord content
with a small authorized Session projection and optional turns. Its optional
`workFactKinds` scope defaults to `['work']`; Coach requests `['work', 'coach']`.
Each compact row carries a `records` array of kind and opaque content, using the
existing `work_facts.v1` kind with separate `work` and `coach` local ids. The
opened payload identifies its kind; the client rejects a substituted kind and
uses the existing Session-mode and content-version owners for both. This is an
unshipped 0.3 replacement: old `how_you_work` records are reread, without a
migration or a compatibility reader. Successful compact
rows omit `detail`; refusals retain typed `detail` results. Missing records remain
unknown, and malformed or wrong-mode envelopes fail closed. The compact option
and its producer/consumer schemas load together; no migration or startup backfill
is required. Requests without the flag retain their existing metadata/evidence
contract and whole-document encrypted client-opening boundary.
Usage clients can request NDJSON (one request-cohort header, then one Session
result per line) in either mode. Streaming avoids a single Account-sized JSON
string; only the compact record path changes the acquired encrypted evidence.
The Session read-batch keeps its ordinary JSON contract for its other consumers.

Released 0.2 legacy SystemRecord clients use a closed record vocabulary. An
unscoped legacy list omits Usage records before pagination, preserving that
page contract; explicitly scoped v1 Usage record reads remain available.

If an older server lacks the Usage projection route, the client projects its
whole-route 404 as the canonical typed update requirement
(`kind: update_required`, `operation: usage.query`, `component: server`,
`reason: usage_session_evidence_unsupported`) on the unavailable/partial detail
source. The UI transport and Resource preserve this typed fact for the presenter;
this does not establish that the rendered state has been verified.
This means that operation needs a newer server; available accounting,
the connection and unaffected operations remain usable. An unavailable Session
within a supported batch is not a missing-route update requirement. Current
per-part update requirements retain their original component and reason while
readable sibling evidence remains available; a successful fresh read clears the
requirement. Query period and selected membership belong to the evidence demand;
facts captured for one period are not reused as complete evidence for another.
Presentation changes that preserve the period and selected membership reuse the
same evidence demand. The development server uses portable SQL chunks and the
existing Session admission/publication owners; only allowed ids reach fact reads.
Plain Usage evidence reads typed permission/message leaves without fetching
ordinary transcript bodies or permission arguments. Encrypted messages retain
their existing first-page lookahead/cursor and client opening contract. A clear
message timestamp can admit an opaque Session. New normal writers additionally
publish timing-only `usageTimingV1` beside the encrypted metadata/state tuple
and each message. The owner-approved privacy boundary and unknown-coverage
semantics are documented in [Encryption](encryption.md#server-visible-usage-timing-bounds-unreleased-03).
Nullable Session, SessionMessage and SessionPendingMessage columns are added by forward migrations;
applied migration bytes are unchanged. Retained rows have unknown coverage and
remain conservatively included, without startup backfill or read-triggered writes.
An older daemon may omit timing: ordinary writes still work, and changing a
component without timing withdraws that component's stale coverage atomically.
An unchanged component keeps its coverage; each message proves only itself.
Pending inputs retain their own bounds through normal transcript materialization;
old queued inputs without bounds remain unknown.
Thus narrow reads of old encrypted histories can remain expensive until normal
writes supply coverage. This is a correctness-preserving migration effect, not
evidence of a native performance improvement.
New development metadata-tuple/transcript writers and their strict Home schemas
load together. Older development schemas may reject the new optional input;
no capability flag or released client update floor is introduced. The inspected
0.2 predecessor at `41f80ea11c2d493d55e0475baeea603a3498bcf9` sends no timing in
legacy metadata/state socket writes; its handlers read named fields and ignore
additional siblings. New Home readers accept those omitted fields as unknown.
This guarantee covers older clients and daemons writing through the new Home.
An older Home writing directly to a database containing new timing coverage is
not covered: it cannot withdraw coverage when it changes the associated content.
The normal development stack must load the new Home before timing-aware writers.
The ordinary Session batch contract is unchanged. This source contract does not
establish loaded latency; that requires a recount after the server reload.

The development Usage query routes retain the shared HTTP storage-failure
contract: terminal database deadlines and availability refusals propagate to
the canonical safe typed503 response, rather than becoming a generic Usage500.
This neither extends transaction deadlines nor retries the query. A subsequent
caller-initiated read uses the existing request path; no fallback query is added.

Request-cost decoding adds the closed optional `requestCost` facet to the
existing Provider executable declaration and its matching activation composite.
It names only already-declared endpoint ids and requires the matching current
host. The strict external terminal-usage mutation adds optional nonnegative
`reportedCostUsd`, accepted only with successful reported terminal usage; absent
fields preserve token-only behavior. These are unreleased 0.3 author/operation
extensions, not safely ignorable executable restrictions on older hosts. Normal
manifest admission withdraws unsupported contributions under the existing
strict-author/tolerant-load policy. No reverse-development SDK adapter, alternate
accounting format, new writer or released client update floor is introduced.

## Connected Account authentication facts (0.3 development)

Qualified V4 credential metadata may carry optional `authenticationProvenance`:
the observed successful authentication time and the executing Machine's qualified
`{ serverId, machineId }` identity. Here `serverId` is the portable Home server
identity, never a device-local profile alias; an unknown binding leaves the fact
absent rather than inventing a target. The existing profile/list projection carries
the same fact and optional `lastRefreshSuccessAt` from credential health. These
are display facts, not credential-selection, permission or currentness authority.
Their objects and existing mutation/identity envelopes remain closed.

Missing history stays unknown. Readers accept older profiles and credentials
without either field; persistence readers use the existing unknown-field-drop
projection. Native import, quota work and provider reconciliation do not invent
a sign-in time. A prepared settlement retains its captured fact through retry
and restart, and refresh retains existing provenance instead of replacing it.
A successful re-authentication replaces that provenance with its newly observed
sign-in fact. If the executing Machine binding is unknown, the replacement leaves
provenance absent rather than inheriting the previous sign-in.
No row-timestamp backfill, database migration or second health writer is added.

V4 is current development source, absent from the inspected 0.2.16 and moving
0.2 predecessor contract. Released outer Account profiles accept the existing
top-level V4 addition while their strict legacy service rows stay unchanged.
This does not introduce a promise to interoperate with stale, independently
bundled development V4 readers or a new client update floor.

The development V4 `GET /v4/connect/qualified/accounts` also accepts explicit
`services` or exact `accounts` reference arrays through the existing
structured-query codec. These selectors are mutually exclusive with each other
and with `service`; exact-reference requests return closed `{ accounts }`,
multi-service requests retain closed `{ services, accounts }`, and single-service
requests retain closed `{ service, accounts }`. Qualified references and profile
envelopes remain closed. Exact references are resolved only within the
authenticated Account, without reading unrelated profiles or credentials. Empty
selector sets read no Accounts; an unknown selector never becomes an unrestricted
Account read.
This filter requires the matching development server and has no fallback to
per-service fan-out or an older unfiltered operation. The inspected 0.2.16
stable/preview and moving predecessor have no qualified V4 route. No persisted
format, SDK activation ABI or released single-service contract changes.

The private runner Connected Accounts watch event also gains the required
`authorityChanged` boolean in unreleased 0.3. Its strict envelope and the SDK
projection change together; the daemon and runner consume the same refined
event. The inspected moving 0.2 predecessor (7b37d65ca75e58560f8f3ca850958ac5407d2e75)
has none of these runner bridge files. This is a development direct cut, with
no persisted shape, compatibility adapter or new protocol epoch.

## Discussion list outcomes (0.3 development)

Discussion summaries add optional, closed `roundOutcomeV1` and nullable
`openCommentCount` read facts. Current server writes maintain them with the
existing Workflow and Discussion transactions; stored round readers drop unknown
fields. The Workflow's private installed-worker storage packet carries only its
admitted built-in identity and non-content count/synthesis facts. Public Action
inputs cannot set a summary. PostgreSQL, SQLite and MySQL add nullable round JSON
and a root counter backfilled only from existing anchor/reply-target metadata.
Retained authored content and keys are untouched. This is undeployed 0.3 source,
with no old-writer or reverse-binary adapter. Missing count facts remain unknown.
The inspected clean scoped predecessor at
`01107c0e7a6b2d4b521573c6d69b53070187e76a` has no first-class Discussion seam.

Approved Workflow publication failures retain identifier-only refusal codes in
the existing closed Discussion acknowledgement and Action execution envelopes.
Reader, Action admission, Machine admission and transaction-custody codes are diagnostic facts,
not new authority, routing inputs or permission grants. Source Action failures
retain their existing code; opaque failure payloads are not copied. Generic
older failures remain readable. Matching development readers consume the new
closed code vocabulary; no request epoch, stored content shape or migration is
introduced. This seam is absent at immutable `cli-v0.2.17`
(`a2c45c86804b24e60ac0b76146a3ef36dfcaa15b`) and the clean scoped moving
predecessor `285ee7c5acb3bea1489896a254e4445f2483a213`; no released-client
adapter or reverse-development-binary promise is added.

## Shared Workflow projections (0.3 development)

Workflow start adds the closed source arm `{ kind: 'repo_file', path }`;
accepted snapshots and Run detail retain `{ kind: 'repo_file', path, commit }`,
and Discussion capture preserves that provenance. It uses the existing
`happier.workflow` version 1 document codec. New starts read the document from
the observed immutable HEAD commit, excluding local file edits. Previously
accepted Runs retain their frozen snapshots. Existing source arms remain readable. Matching
Protocol, host and generated SDK readers update together under the unpublished
0.3 direct cut; there is no migration, new wire epoch or reverse-development
reader adapter. The scoped clean predecessor at
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no Workflow start/source contract.

The existing SCM file-read selector also accepts the closed `{ commit }` arm,
using the full SHA-1/SHA-256 commit schema and a literal repository-relative path.
Its request and nested selector objects remain closed; unknown fields reject.
Matching Protocol, Git plugin and host readers reload together under the
unpublished 0.3 direct cut, within the existing wire epoch. Older development
readers refuse the new selector. Existing blob and before-side selectors remain
readable; the scoped-clean predecessor at the commit above has no SCM file-read
schema. No persisted format, fallback, capability gate or reverse-development
adapter is added.

The closed Workflow failure vocabulary retains the trigger owner's existing
`present_user_required` refusal when an agent requests private legacy-conversion
review. This read is refused before storage access; it no longer appears as
`storage_unavailable`. Matching Protocol, CLI/daemon and UI readers reload
together under the unpublished 0.3 direct cut because older strict readers do
not recognize this code. Approval and review authority, persisted formats and
wire epochs do not change.

Retained original step input and recovery replacement values share
`WorkflowAuthoredInputV1Schema`: composer document, input values and optional
`renderedText`. The rendered text freezes the admitted input and survives
fresh-agent recovery; it must not be regenerated from later origin content.
Stored original-input normalization uses the canonical stored-read projection
to discard unknown fields before sealing the next attempt. New writes and
recovery controls remain strict. Existing 0.3 Runs need no migration; reload
the executing CLI/daemon and refresh the app for its local recovery Action.

The retained Automation V3 Run list and detail carry optional
`workflowRunState` for Workflow-owned Runs. History, Inbox and latest-run
presentation use this canonical state; the retained Automation `state` vocabulary
and admission correspondence stay unchanged. Omission from older development
peers and Automation-only rows retains the older, lossy Automation presentation.
The closed development response requires matching Home and client source when
the field is emitted. No persisted format or released 0.2 contract changes; the
current 0.2 predecessor has neither the V3 API nor the Workflow state schema.

The admitted Artifact list and exact-read projections optionally carry
`sharedTeamIds`, filtered through the actor's effective Team memberships and
the Artifact's direct Team grants. The canonical Workflow library preserves
these ids so a Team overview can select its shared definitions without a
second library read owner. Personal shares carry no Team audience.

The development V3 definition-list response optionally includes
`sharedWorkflowSummaries` for an explicit Workflow-definition selection. These
carry list-safe trigger summaries and the earliest enabled scheduled time for
the actor's authorized Team Run audience; the Account-owned definition/details
list is unchanged. The shared-library owner merges these facts for every client.
Schedule summaries additionally carry optional nullable `nextRunAt` from that
trigger's scheduler cursor, normalized to null when the trigger or its set is
disabled. Exact-trigger History uses only this occurrence; Event triggers and
older summaries without the field show no next occurrence. The workflow-wide
minimum remains the library and Board summary. Matching development Protocol,
Home and client readers reload together because older strict summary readers
reject the added field. No persisted format, epoch or adapter changes. The
inspected `../0.2` frontier at `7b37d65ca75e58560f8f3ca850958ac5407d2e75`
has no Workflow trigger summary contract or scoped local changes at that path.
Each trigger summary also carries its Automation and trigger ids for the saved
Workflow's History entry. Account and Team readers use the same Run history
component and the optional `workflow.run.list.triggerId` predicate; the predicate
narrows the existing Run audience and is bound into the paging cursor. Opening
History acquires that trigger's occurrences, including frozen save attribution;
closed trigger rows do not acquire Run history. Matching development server and
client code is required for this closed request and summary extension.
The development `workflow.activity.list` Action is additive and delegates to the
existing public Run-membership reader. `workflow.run.list` membership no longer
requires an attention filter; its private Session/provenance selectors remain
rejected. The new Action reports UI-local live coverage as unavailable rather than
inventing a retained event history. UI clients share transient acquisition within
the active Home Account; no persisted format, migration or compatibility adapter
is introduced. An older Action catalog does not expose this new read.

The V2 recipe's optional outer `visibleTeamId` is emitted by the Account seal for
plain and encrypted context. Retained plain recipes can project their existing
audience; encrypted predecessors without it remain private until re-saved.
The owner's revision-CAS `workflow.trigger.update` can re-save the current
`visibleTeamId` to add that outer metadata without changing execution context.
This additive development wire change requires a matching 0.3 Home and clients;
it does not change the released 0.2 contract.

## Automation managed-target index (0.3 development)

The V3 definition wire epoch adds optional nullable `managedTarget` structural
ids to the closed outer Workflow V2 recipe and public definition projection.
Absence remains unknown; `null` means known unrelated. The canonical Account
seal derives the field, and the definition CAS writes its indexed projection.
Older writers that omit it preserve the stored ids and invalidate the index
instead of erasing the relationship or trusting an old target. Unchanged recipe
and trigger-only writes retain the current index.

The closed structured definition query accepts exact managed-target demand and
an explicit temporary unknown-row inclusion. A current reader opens only those
candidates and verifies the private inline Action. An authorised client startup
pass backfills readable unknown current recipes through the same recipe CAS;
conflicts and locked rows retain the unknown fallback, without hot retries.
The fallback can contract when supported writers always emit the field and
retained current recipes are indexed. Unsupported structured queries remain
unavailable; they never become an unrestricted request.

This requires a matching 0.3 development Home. The inspected immutable Server
tags `server-v0.2.17` / `server-v0.2.17-preview.1` (both
`a2c45c86804b24e60ac0b76146a3ef36dfcaa15b`) and clean scoped moving predecessor
`29c845495702acde2824dae13067d8a09322b26b` expose V2 Automation definitions,
not this V3 recipe/query seam. Their retained templates cannot represent an
inline managed scope Action and remain readable under the existing conversion
owner. The additive PostgreSQL, SQLite and MySQL migration marks those
structurally unrelated legacy targets as indexed without opening content.
No new V2 field, released client update floor or reverse-development-binary
adapter is introduced.

## Managed Session birth relation (0.3 development)

The current Layout-1 creation request accepts the closed optional `managedCreation`
id carrier, reusing the immutable recipe's schema. Session birth owns its validation
and nullable relational column; rejoin never rewrites a stored relation. The closed
`machines.managed.birth.get` Action reads the Account-owned birth indexes in one
snapshot, returning a unique workflow Run first, then a unique Session (including
archived Sessions), or null. Controller Moves do not
change birth identity; ambiguous matches remain unresolved.

New migrations are additive for PostgreSQL, SQLite and MySQL. Existing requests
without the carrier remain accepted. Existing rows retain null rather than an
inferred backfill from private content. Absent or ambiguous relations leave that
source unresolved. Machine detail reads its retained Home scope policy and the
exact birth; it does not read or author FIN recipes to decide retention.
Other HTTP failures and malformed responses propagate. The scoped UI birth reader
keeps pending, ready and failed states distinct and exposes demanded Retry; Check
now and existing Run-change notifications can re-arm unresolved exact reads.
No Session or Run inventory scan supplies a missing relation.
Current managed creation requires the matching development Home; silently dropping
the carrier is not an older-server creation adapter. The immutable private recipe
remains the retry-meaning owner, not a second writer of the server relationship.

Machine-policy placement records optional `managedCreationOrigin: machine_policy`
and, only when the native-sandbox value was defaulted,
`nativeSandboxOrigin: machine_policy` in that same immutable private recipe.
The canonical creator restores those marked facts from authenticated owner metadata
before exact retry comparison. It checks the current policy and acquires a target
only for a fresh creation. Explicit authored placement or native-sandbox intent
still participates in exact comparison, including a newly explicit value equal to
a prior default. Recipes without these markers keep the existing exact behavior;
readers do not infer provenance from a managed id. These fields are internal birth
provenance and are absent from the public spawn Action input.

The unreleased 0.3 acquisition input can also admit a closed optional
`creationScopeRetention: { effect: 'stop' | 'delete' }` choice. The birth owner
binds its exact Session or workflow Run only when that acquisition already
admitted the choice for the creating Account and exact guest. Birth cannot add
an effect to a Keep acquisition. The existing custodian retention-update Action
can edit or remove the choice under its ordinary authority and review.
The Session archive and Run terminal owners publish their end into that retained
policy; the existing Home retention admission and controller drain/native-effect
path execute it. Unarchiving the bound Session withdraws its end timestamp and
advances the existing intent revision, canceling scope cleanup that has not been
submitted. An already-submitted native effect retains its exact request and
settlement path; reopening does not cancel that effect or revive a deleted
resource. Delete keeps its existing shared Action review. There is no
second FIN deletion decision, timer or settlement receipt.

The retained admitted-input JSON optionally carries the choice, source and source
end timestamp. Ordinary retention stays intact for Keep. Runtime `unused` policy
accepts zero delay for an ended source; reusable settings still require positive
delay. Protected managed detail can read the scope source; public Machine runtime
projections carry only derived presentation. These closed development shapes
require matching 0.3 Home, Protocol, SDK and clients; omission preserves prior
rows and acquisitions. This does not add a released 0.2 seam or rollback adapter.

The moving predecessor inspected on 2026-10-24 is `../0.2` HEAD
`3482a9101ebb7ee2983608ef0deb00831dfcb2e7`, with clean scoped status/diff for
the Session schema, create route, CLI API and correspondence path. Its ordinary
creation request carries opaque metadata and no server-visible managed birth
relation. Retained content remains readable through the existing metadata reader;
no 0.3-to-0.2 rollback or new-writer/old-reader relation contract is introduced.

Durable Workflow Run admission uses the same optional closed `managedCreation`
carrier and an additive nullable `AutomationRun.managedCreationId` relation.
Ordinary Run requests omit it; historical Runs remain null. The incumbent Run
birth Action accepts `{ homeId, managedId }` and returns only relationship ids,
without Run content. Machine detail resolves this exact relationship before Session
provenance, so task births at Keep never require Session or Run inventory reads.
The Action uses the ordinary server transport at
`POST /v1/machines/managed/actions/birth.get`; malformed responses and HTTP
failures remain refusals. The former two-step lookup endpoints were unreleased
and are removed without compatibility fallbacks. This is an unreleased
0.3 extension requiring a matching admission owner, rather than an ignorable
optional input on an older Home. No no-op Keep trigger, inferred relationship
backfill or historical Run-content scan is added.

## Managed Machine query selection (0.3 development)

The existing closed V1 `machines.managed.list` request accepts optional exact
`presetId` and `enrolledMachineId` selectors. When combined, both must match.
Selection happens in the managed query before access projection; it grants no
additional access. Active and archived history keep their separate reads, and
requests without selectors retain their existing shape and behavior.

Stored Managed Machines keep their admitted launch under the protocol-owned
retained grammar. A different host can publish another declaration at the same
development version; that must not re-admit the immutable launch or prevent
reading and deleting its allocation. The stored-row owner preserves declared
launch normalization when compatible, otherwise reads the admitted retained
launch; both paths still project native values through the known declaration.
The existing batched declaration lookup remains. New acquisition validates the
current declared launch; native reports and enrollment validate the incoming
native identity or handle. Raw snapshots remain unchanged, and controller
reassignment retains its destination validation. This corrects the 0.3 reader
without changing persisted formats or admission authority.

These selectors require a matching development Home. A reader never substitutes
an unrestricted inventory when the selected operation is unavailable or rejects
its input. The inspected immutable `server-v0.2.17` and
`server-v0.2.17-preview.1` trees have no managed query owner; the clean scoped
moving `../0.2` frontier at `c1e74e521fa2e725702ae21b472afe46a9d2d6c6`
likewise has none. This changes no persisted format, wire epoch, package version
or released-client update floor.

## Baseline classes

### Project checkout authoring relationship (0.3 development)

The V1 Project Account row owner stores an optional, closed
`authoringSession: {serverId, sessionId}` display relationship beside the private
content in its existing reserved KV record. The qualified row key, relationship,
read requests, mutation requests and results remain closed. The new dedicated
`POST /v1/account/project-rows/authoring-session` operation records only this
relationship for an existing Account-owned checkout. It grants no access and
does not interpret a Session title or setup outcome.

Read/list requests opt in with `includeAuthoringSession: true`; requests without
that field and ordinary structural mutation acknowledgements keep their prior
wire shape. New readers accept absent relationship fields. A current UI talking
to an older strict row server retries its rejected opt-in census once without
the flag, then uses the existing hydrated-Session discovery. A missing recording
operation (404/405) retains the already-committed owner-private provenance.
Other failures propagate rather than pretending the relationship was recorded.
The Session's Home is stored by its established portable identity. When that
identity is unavailable, private provenance remains the fallback; a device-local
profile alias is never written into the shared relationship.

The persisted metadata needs no database schema migration. Structural mutations
and Account-mode conversion retain it; checkout deletion removes it. Historical
rows are not inferred or backfilled from private Session content. The new writer
runs only at Session creation/recovery, and identical retries do not advance the
row revision or publish another change. There is no new SDK epoch, client-update
floor or reverse-development-binary storage promise.

Setup authoring in 0.3 development can hand its private origin to Session birth.
The existing Machine operation-capability owner advertises
`sessionSpawnAuthoringOrigin: { protocolVersions: [1] }`; only an explicitly
supported leaf permits the optional closed `authoringOrigin` spawn input. The
origin and its nested destination references retain their existing closed
schema. This is a negotiated extension of the existing spawn operation, separate
from SDK package SemVer, with no new route, event union or database migration.
Missing, malformed or unsupported capability leaves retain the existing
post-create owner-private checkpoint and its typed failure. Older callers omit
the input and a new daemon preserves their creation behavior.

The daemon carries the admitted origin through its private runner startup
custody into `work.authoringOriginV1` in the initial owner metadata. The existing
Account-mode envelope writer owns encryption. The UI confirms the equal origin
through an exact owner read before the relationship POST and sends no origin
PATCH after handing persistence to birth. Missing or unreadable confirmation is
an `authoring_origin` failure, not permission to start a second writer. The
capability advertisement alone is not proof that persistence succeeded.

The existing device-local spawn-attempt record retains the chosen persistence
owner for deferred and recovered creation. An older record without that fact
can confirm an already stored equal origin; otherwise recovery refuses the
unknown handoff rather than guessing which writer owns it. Temporary-computer
creation retains an explicit legacy checkpoint until its own birth handoff is
negotiated. These adapters preserve older request/record shapes without a new
storage key, retry loop, timer or server-visible provenance content.
Cross-Home recovery reads operation and spawn-attempt custody with the admitted
destination Account. The originating Account still owns the draft and checkout
relationship; its Account id is never substituted for the destination's id.

### Team vendor-native delivery (0.3 development contract)

The current development Team route union adds `vendor-native`. The resource's
ordered custodian `preferredAllowedModes` and independent audience route sets
replace binary ceiling/grant authority; new resources default to brokered only.
Legacy `brokered_only` consent maps to `['brokered']`, and `direct_allowed` maps
to `['brokered', 'direct']` independently of enabled state, audience or readiness.
Audience `brokered`, `direct` and `both` separately map to their existing route
sets, never native. This preserves dormant consent and direct-only recipients'
narrower rights. Current writers use normalized shapes after migration; legacy
read adapters must not remain independent policy writers. Migration execution and
loaded integration are separate evidence, not established by these schemas.

Policy, grants, accepted Team witness/native facets, Action operands/outcomes,
destination selectors and provisioner executable declarations are recursively
closed authority-bearing contracts. Unsupported native fields or route values
must never execute as direct or brokered. The existing ordinary managed install
Action, Session binding owner and pinned Provider launch service evolve together;
there is no separate native RPC epoch. Experimental Team Agent/model pairings
are informational and require neither custodian nor recipient confirmation.
Hard incompatibility, source currentness and vendor-disclosure authority still
refuse unsafe use. Personal Provider confirmation is unchanged.

The approved first-use authority extends the existing signed-child and managed
admission owners: `session.spawn_new` approval covers only that Session's exact
already custodian-authorized native binding. The installed guest signs after Ask,
and the existing issuer remints the controller install Action. Private birth
identity alone grants no install authority. Owning-Session terminal removal is
allowed for that lifetime without live spawn/turn ingress. These unreleased
contracts add neither a separate native authority protocol nor an old-development
rollback writer.

The optional provisioner declaration and demanded support result remain distinct:
missing declaration is unsupported; missing check qualification is unknown.
Unknown/malformed stored native support withdraws that leaf only, preserving
healthy sibling capabilities. Strict author/tolerant manifest load rules still
apply. Manifest schema, host ABI, wire epoch and SDK package SemVer are separate;
source additions alone do not decide a published package version.

An older generic result decoder accepting an additional optional result key
proves neither native capability nor support for a new native operation. The
all-component 0.3 direct cut remains in force;
no reverse-development rollback writer, dual writer or new client floor follows.
Unsupported Home/Machine combinations refuse before credential effects while
unaffected ordinary released operations retain their existing contracts.

### Team direct-material invalidation (0.3 development)

Direct-material PUT and withdrawal retain the existing Account-change `kind:
account` and publish the distinct `entityId: team-credential-material`. This is a
payload-free material invalidation, not a new ChangeKind or authority envelope.
It shares the canonical Team audience and cannot overwrite a pending `teams`
coalescing row. Current credential views and retained recipient currentness consume
it; source census subscriptions continue to consume Team authority changes.

The immutable 0.2.17 UI reader at
`b8d1c449c46ab4dfa8637db36b66f643d149e66d` admits arbitrary Account entity ids
and uses its existing broad Account refresh. Its planner rejects an unknown
top-level kind, so this correction does not add one. The immutable 0.2.17 CLI at
`a2c45c86804b24e60ac0b76146a3ef36dfcaa15b` independently selects its known
Machine/self/Session facts and advances the successful page cursor. This preserves
ordinary released-feed processing without a new adapter or client update floor.
The scoped moving predecessor at `29c845495702acde2824dae13067d8a09322b26b`
has clean relevant readers and retains the same Account entity-id admission.

The 0.3 development Discussion reply owner adds optional closed `returnPublication`
metadata to existing original-input JSON and a closed `discussion_publication` observation
mutation. Existing originals without that metadata remain readable; native outcomes are
unchanged. Failed-return presentation extends the same Discussion participant-delivery
projection. The existing original-reply hint adds optional `workflowRunId`; omission remains
valid. These are unreleased 0.3 contracts under the direct cut, without a new table,
migration, dual writer or adapter for an older development binary.
Approved Discussion replay uses that same mutation with `approvalArtifactId` for any
typed publication failure, including `discussion_answer_policy_denied`. Reject/Cancel
still require the exact Artifact; pending approval metadata cannot carry that decision
operand. This extends the existing closed development contract and requires matching
0.3 readers and writers, without changing released approval history or native outcomes.
The same development-only storage route accepts an optional closed `runId` selector
on `recovery.list`. Exact return/approval recovery requires the matching reader;
older requests without it retain broad lifecycle recovery. It changes no stored shape
or public Action/SDK input and is absent from the clean scoped moving predecessor
`dac1efd68dee668d15c0c84fa5cacd29c15fb176` inspected on 2026-10-25.
The scoped moving predecessor last rechecked at `01107c0e7a6b2d4b521573c6d69b53070187e76a`
has no original-reply or first-class Discussion corridor and no scoped staged/unstaged
changes there. This change does not reinterpret a predecessor-created reply format.

### Hard released obligations

- Active stable and preview releases count because both can exist on user machines or deployed infrastructure.
- Resolve each component independently. UI, CLI/daemon, server, desktop/mobile, and stack tags may point to different commits.
- Discover the current channel through rolling tags such as `cli-preview`, then record the immutable component version tag, commit, and relevant artifact/deploy evidence used by the check.
- Older releases count only when explicitly supported by policy or task scope; tag existence alone does not imply indefinite support.

### Moving `../0.2` predecessor frontier

- `../0.2` is expected to ship before this repository. Its real current on-disk code is a prospective compatibility input even when it is uncommitted or not yet released.
- Inspect committed, staged, and unstaged code in the relevant paths. Record `HEAD`, working-tree status, the relevant diff/basis, and what was directly observed versus inferred.
- Never modify or clean the sibling worktree. Dirty changes may be incomplete or concurrently owned; if the externally observable contract is contradictory or unknowable, report that uncertainty rather than inventing multiple speculative adapters.
- Track the latest observable prospective shape, not every superseded internal implementation. When the sibling evolves before deployment, refresh the comparison and remove support that existed only for a replaced, never-released intermediary shape.
- Recheck relevant sibling paths before handoff when they were dirty or advanced during the task. Released stable/preview shapes remain hard obligations regardless of later sibling changes.

### Non-obligations

Usage request attribution in 0.3 development extends the existing event ingest
and contribution projection. Older scalar usage reports and historical events
without this proof remain readable and project unknown attribution; they are
not relabeled from current Session metadata. The moving 0.2 predecessor uses
scalar `/v2/usage-reports` and does not advertise the event-ingest capability.
Its scalar transport remains the existing fallback, without request-source
proof. This is not a second accounting ledger or an inferred attribution shim.
The development publisher awaits the canonical feature observation under its
caller's cancellation; a slow observation alone does not trigger a local
1.5-second downgrade to scalar reports. Negotiated unsupported-server behavior
continues through the same existing transport owner.

Current event metadata may carry optional `usageAccounting.runtimeEventOrder`
with the host's existing `runtimeIncarnationId` and event `sequence`. It resolves
equal-source-clock ordering within that incarnation, not across runtimes or
missing witnesses. Event metadata is additive; stored accounting readers drop
unknown fields, and older scalar transport never receives this supplemental
request stream. Existing rows without the witness retain chronological fallback.
Duplicate ingestion preserves the stored fact and proof while retaining an
earlier valid same-runtime position; it does not synthesize a later source clock.

The 0.3 foreground daemon claim returns optional, credential-free
`sessionConnectedAccounts` through the same schema as native Session open. The
foreground startup reader consumes the canonical claim-response schema rather
than a second local response shape. Daemon-started Sessions carry the same bounded
optional field in their protected runner bootstrap after successful exact-purpose
materialization. Existing bootstraps without it remain readable and provide no
Account-reference proof. The bootstrap is private to the selected daemon/runner
source bundle, not a cross-version public SDK contract. The CLI retains the
materializer's selection controls from its explicit scope only for daemon
launches with a validated matching private bootstrap; the marker or caller
environment alone is insufficient. This changes no wire shape or stored data.
These correct
current-development launch projections; they add no persisted binding format or
historical attribution. The moving 0.2 predecessor has no foreground claim seam and retains its direct
Connected Service launch path.

The optional `usageAccountScope` materialization result and launch carrier are
additive 0.3 development evidence: older service results omit it and remain
unknown, and older hosts may ignore it without changing authentication. Only a
service's actual admitted credential revision may supply the classification.
Public usage continues to use the existing `usageAttribution` shape; no stored
row is backfilled from a current subscription or Session selection.

- `dev`/`*-dev.*` builds, untagged history outside the live predecessor frontier, abandoned experiments, and undeployed internal module paths are not lasting compatibility contracts.
- Do not keep aliases or adapters solely for an atomic internal rename/move whose old path never shipped.
- The predecessor rule preserves observable wire/data/state behavior, not `../0.2`'s internal architecture.

## Session PR watch integration (0.3 development)

The retired `stopWhenMerged` option is no longer part of current Watch policy
or Account setting declarations. The existing schema-derived stored binding
reader drops either historical boolean value while preserving mode, archive
choice and progress; the Settings default resolver ignores the old key. Current
Watch Action inputs remain closed and write only mode and archive choice.
Merged/closed PRs already stopped unconditionally, so this removes no runtime
Watch behavior and requires no stored-data rewrite or migration.

The new Channels Watch/update envelopes, optional binding-owned watch progress
and optional Automation `prUpdate` evidence belong to unreleased 0.3 source.
Automation producers preserve omitted evidence for existing occurrences; current
readers validate supplied PR envelopes at the Channels boundary rather than
interpreting arbitrary workflow JSON as trusted instructions. Existing authored
literal workflows are not silently repaired or rewritten.

The inspected moving predecessor is `../0.2` at
`2bf968563bf2015455c0cd54bcc74e91f67891b9` (2026-10-24 recheck). Its relevant
new Watch/binding/result paths and `automationResultDeliveryV1.ts` are absent,
with no staged or unstaged changes at those paths. This is not a released
mixed-version Watch contract and does not justify a second watch store, dual
writer or undeployed-intermediate adapter. Retained link conversion remains
with the existing source/Channels relation owners; this watch integration does
not independently discard predecessor relationships. Package and composed
runtime validation are still required before claiming completion.

## Composer inline references (0.3 development)

Transcript annotations use the existing Composer attachment V1 record and
app-context contribution lifecycle. Their strict value is `{ quote, note,
source: SessionMessageRefV1 }`; it creates no primary message envelope or data
migration. Attachment presentation additionally admits optional `source` as a
closed committed-message reference for historical navigation. The presentation
object keeps its additive-open/drop read policy; existing records without a
source remain unchanged, and older presentation readers keep the existing
label/description fallback. No source link grants access to the message.
This is an unpublished 0.3 author contract under the direct cut, not a new
0.3-to-0.2 writer or rollback direction. The native renderer's legacy selection
event can still supply exact selected text without `renderedText`; annotations
retain that quote and committed identity without inventing source offsets.

This is an unreleased, one-way 0.3 format change. Current writers persist
`[label](happier-ref:<scheme>:<opaque>)` at the reference's position in text.
Protocol's [token grammar](runtime-core.md#session-input-and-inline-references)
uses the existing percent-encoded MentionRef destination. Identity stays in
the envelope's positionless `mentions[]`, draft reference ranges and attachment
records; the token alone cannot authorize or create a reference. Upload
descriptors gain optional `id`, matching the tray id and structured image input
id. Existing contributed attachments retain `instanceId`. Image ordinals are
derived, never persisted. The token bound is derived from existing label/ref
bounds and escaping; other mention and resolved-context bounds are unchanged.

The retained reader is for 0.2-created data:

- Messages with legacy `@`/`$` tokens keep the Markdown text and appended
  references row. `messageDisplayText.ts#stripLegacyAttachmentsBlock` hides the
  old `[attachments]` suffix where structured attachments replace it. Dispatch
  preserves an existing legacy listing once rather than duplicating it in the
  new reference block.
- Positioned legacy drafts load through `parseComposerStructuredInputMentionsForText`
  and `sessionDraftLegacyMigration.ts`. Their shared normalization rewrites
  each bound range into the inline grammar and shifts subsequent ranges before
  saving the current shape. Pending edits and rewind/fork hydration recover
  ranges from exact token occurrences.
- New references render inline; legacy references without inline tokens keep
  the row. A hand-typed workspace path may still appear in that row through
  the canonical path scan. That is text detection, not another token writer.

Observed predecessor basis, 2026-10-21: `../0.2` HEAD
`8a088dd70f57ccf43fade3543fb6a3e874bee12a`. Its
`packages/protocol/src/mentionRefV1.ts` defines positionless typed mentions,
the existing destination encoding and `maxTokenChars: 256`; its attachment
producers append `[attachments]` text and its draft readers retain ranges.
These are retained-data inputs, not an obligation for a 0.2 binary to read 0.3
writes. Under the all-component upgrade there is no 0.3-to-0.2 writer, alias,
dual format or old-binary rollback contract. Keep the historical reader while
0.2-created messages and drafts remain supported; undeployed 0.3 intermediates
do not get additional compatibility paths.

## Discussion attachments (0.3 development)

The strict development Action inputs for create/post/reply accept optional
`attachmentSources: [{blobId,path}]` on the invoking Machine. This operand is
effect-bearing and cannot be ignored: unsupported hosts must refuse it, never
post text while dropping selected files. Private publisher requests retain the
sources through active-turn or approval verification; server publications omit
the paths. The V1 upload metadata's optional closed `agent` arm binds the exact
publication and byte framing to the existing installed Machine key, Home and
Account. Its producer and server reader change together in this unreleased
0.3 direct cut; older strict upload readers refuse the arm safely. Existing
uploads without the arm and existing attachment content remain unchanged.

For this extension, the clean relevant predecessor paths were inspected at
`../0.2` HEAD `420e78875b59a5d50169d31497853c447498f470` on 2026-10-24. Its
Discussion source/upload corridor is absent; no Session attachment contract is
removed or rewritten by the new invoking-host operand.

New Discussion writers use one strict `attachment` content arm containing the
shared Session file/folder payload. Folder paths and empty directories are
content, not Machine-local authority. Stored-content readers remain tolerant of
unknown future part kinds; fresh writes do not accept undeployed attachment
intermediates. The existing inline attachment token is reused rather than
introducing a Discussion token family.

Bytes use the existing explicit plain/encrypted envelope and are bound to the
committed Discussion message. Exact reads require current Discussion access;
an older or unsupported Home cannot be treated as supporting the byte operation.
There is no fallback to a public URL, unrelated Artifact grants, or the sender's
Machine path. Account conversion includes retained attachment bindings and
bytes, including archived Discussions, in its existing fenced transition.

The predecessor frontier for this corridor was refreshed on 2026-10-23 at
`../0.2` HEAD `a487b2ec48873bfc0ad67bb1d31be0a2cffd3c92`. The relevant Protocol,
Session attachment and CLI Artifact/Discussion paths had no committed change
from the earlier `e7c3bd55849a0d00e86eb74a26f478f96c6bc0e0` inspection. Dirty
AgentInput changes add send-menu/shortcut options, not a new attachment input
shape. Its Session attachment inputs remain supported by the shared owners.
Discussion attachments are new 0.3 development behavior, not a released 0.2
write format or a promise that old binaries can read new writes.

## Public-profile integration boundary (0.3 development)

Public-profile publication is an unfinished new capability, distinct from the
implemented username operations below. A feature-missing server must not be
treated as supporting it, and a public-profile request must not normalize into
the existing private Usage path or a generic Account-KV/Artifact write. Existing
private recap inputs, seven styles and three formats retain their own support.

Historical Accounts and Usage without ownership evidence remain readable by
their existing private owners and count in the approved public population unless
known Team evidence excludes them. Known Team usage means a Happier Team
credential, a genuinely Team-owned Session, or a provider workspace plan proved
by the connected-service owner. Unknown ownership, including API-key usage and
imported native history, does not require personal-ownership proof or a history
rewrite. Running-total residuals and turn-less rows count under the same
reconciliation as private Usage.
`UsageQuery.population` selects `public_eligible_personal` explicitly; omitted
or explicit `all_personal_history` retains ordinary behavior. The canonical
transport omits that default so older strict request parsers keep accepting
ordinary reads. The new public selection is gated by `account.publicProfiles`;
an unsupported server cannot silently fall back to the broader private query.
The scoped accounting owner reconciles all baselines before excluding known
Team contributions through one eligibility predicate. Public detail uses the
same eligible contributions and Session evidence, not every turn in a mixed
Session. Whole-Session message counts do not establish that membership and are
omitted for this selection. Excluding known Team usage defines the intended
population; neither that exclusion nor unknown ownership alone makes coverage
partial. Source-history evidence still determines completeness.

Current Session ownership is Account-owned (`Session.accountId`); Team/Group
grants and `primaryTeamId` authored context do not transfer that ownership.
No Team-owned Session input exists in the current model. This is not a claim
that Team credentials or proved Team subscriptions are personal.

Publication, snapshot and nested authority writes now use closed schemas at
`account/publicProfile.ts` and `account/publicProfilePublication.ts`. Their
stored readers drop unknown presentation fields and field ids; missing consent
is false and malformed known consent or facts fail closed. The additive
publication table does not publish historical Accounts or change their keys.
No released route, mixed-version publication or active supporting-server
guarantee is claimed before the consumed integration exists.

The closed V1 public view and local preview carry optional `relativePeriod`
from the saved or prepared Usage query. Its enum is the canonical Usage preset;
the snapshot keeps the actual absolute bounds. Older views without the preset
remain readable, and labels must not infer one from those bounds. This is an
unreleased projection extension requiring matching development readers, not a
new wire epoch or a released-client update floor. The inspected moving 0.2
predecessor has no public-profile publication contract.

The same public fact projector omits unattributed Agent bridge rows from Agent
mix, days, weekly mix and anonymous durations, including retained snapshots and
source lenses. Their usage still counts in totals, and named Agent shares keep
their original denominator. An unknown execution source remains a valid source
category; it is distinct from a missing Agent attribution. Private Usage keeps
its existing unattributed rows. Public projection does not disclose a person's
private custom-Agent configuration name.

The development Action intents for preview, publish and update accept either an
inert inline public layout or a closed private `WidgetAreaLayoutV1` selection.
The shared key-holding Action preparation owner compiles a private selection
before review; HTTP requests and persisted editions keep the existing inline
public layout. Inline input remains valid for acknowledged-edition Undo. The
private selection, including definition bodies, stays out of durable Action
observations. This is an Action-only development extension, with no stored
format, publication wire epoch or released-client floor change.

## Account username intent and release (0.3 development)

`Account.username` remains the single service-scoped identity used by Friends.
The canonical username policy and transaction-taking mutation in
`apps/server/sources/app/social/usernameUpdate.ts` admit explicit changes,
provider fill/unlink, provisioning and provider-reset transfer. The existing
authenticated social profile's provider-suggestion fallback is presentation,
not ownership of a username.

The additive identity migration preserves retained username bytes, including
underscore/hyphen and customized-policy names. It initializes
`usernameAutoFillEnabled` to false for retained non-null names of unknown origin,
and true for null names and new unclaimed Accounts. Explicit set, including a
same-name replay, and release disable auto-fill. Only a matching name assigned
while auto-fill remains enabled can clear on identity unlink; a matching linked
provider login alone does not prove retained provenance. Existing holders may
retain names newly excluded by reserved-name or configurable claim policy.

Explicit release clears the Account name and public disclosure without reserving
the name. Another Account, the former holder or provider fill may claim it
immediately under the same policy and unique constraint. The response keeps
`reservedUntilMs` for existing readers and returns null. The unread
`ReleasedUsername` table (0.3 development only, never released) is dropped by
migration `20261115210000_drop_dead_share_access_log_and_released_username`,
together with the never-written direct-share `SessionShareAccessLog`. Renaming preserves the publication at the new current
handle, including paused state and independent operator restriction. Release,
reclaim, automatic identity unlink, erasure and reset still withdraw disclosure.
Recovery transfers the actual current name and intent bit, but never disclosure;
a different desired name is a new claim.

The existing username POST preserves its request, success and 400/409 error
envelopes for older clients. Reserved/claimed conflicts map to its existing
`invalid-username`/`username-taken` errors. The new strict check and release
operations have their own closed schemas; no input can supply an internal
mutation role. Against a server missing either operation, current UI/CLI Action
transport reports `unsupported_action`; it does not simulate release through an
empty set or infer availability locally. Ordinary username set keeps its own
older-server support. On current development servers, the existing shared
username route eligibility admits claim, check and release when
`account.publicProfiles` is enabled, independently of Friends and its identity
provider requirements. When profiles are disabled, the existing Friends
eligibility remains in force. This does not enable Friends discovery or
relationships, and the same username policy, reservations and mutation owner
still apply.

The prospective predecessor rechecked on 2026-10-29 was `../0.2` HEAD
`fd3f03529d96e899e95c8b384f5843340a1339c6`, with clean scoped status and
`diff HEAD` for Account schema, social policy/update, username route/UI adapter,
GitHub/OIDC writers and OAuth finalize routes. It has nullable unique usernames,
trim/lowercase normalization, configurable defaults of 3–32 characters and
`^[a-z0-9_-]+$`, and the original Friends-gated set envelopes. Its direct provider
and finalize writers establish retained-data input shapes, not a requirement to
preserve those internal owners or matching-login provenance inference.

Public stable/preview release pages were read on 2026-10-21 and resolved to
immutable `server-v0.2.16` / `server-v0.2.16-preview.1` at
`22ac8263cfdbcdb845441b9044ff18199cf7652e`, and
`ui-web-v0.2.17` / `ui-web-v0.2.17-preview.19` at
`b8d1c449c46ab4dfa8637db36b66f643d149e66d`. Source comparisons confirm this
username seam. The immutable server
[stable manifest](https://github.com/happier-dev/happier/releases/download/server-v0.2.16/linux-x64.json)
and [preview manifest](https://github.com/happier-dev/happier/releases/download/server-v0.2.16-preview.1/linux-x64.json)
identify those versions, channels, versioned archive URLs and build commit, with
workflow run `37794037498`; publication timestamps are respectively
`2026-10-08T16:02:29.363Z` and `2026-10-08T16:09:18.975Z`. This is public
publication metadata. The immutable UI
[stable checksum file](https://github.com/happier-dev/happier/releases/download/ui-web-v0.2.17/checksums-happier-ui-web-v0.2.17.txt)
and [preview checksum file](https://github.com/happier-dev/happier/releases/download/ui-web-v0.2.17-preview.19/checksums-happier-ui-web-v0.2.17-preview.19.txt)
were also readable and name the corresponding versioned web archives. No
archive/signature verification or evidence of which binary a particular service
deploys is claimed. Deployment provenance remains unverified.
Additive schema does not establish safe old/new server writers sharing one
database: an older writer bypasses intent and holds. Such coexistence is not
claimed or implemented by this identity vertical.

## Session viewer read projection (0.3 development)

The Account-private `viewer` object in Session detail/list records is an
additive-open read projection. Older clients drop unknown outer viewer facts;
known fields and their nested read-state, relevance, attention, Follow and
notification schemas remain strict. New required viewer facts therefore need
the normal reader-first transition before the server emits them. This keeps an
independently updated Home from blocking an older daemon's Session attach on a
new presentation/read fact, without allowing unknown data to acquire access,
routing, mutation or persistence meaning.

## Machine Manage storage and native Skills (unreleased 0.3)

Machine Manage grants full control of storage administration, disk scans and native
skill installation/removal. The Home's existing route policy requires Manage for
these effects; the daemon consumes the admitted role rather than requiring the
requester to be the custodian. Use retains its own Session-folder and Trash scope.
Skill content and installation receipts use the requester's Account library and
credentials, never the custodian's private Account catalog.

Load the updated Home, daemon and UI together. Older intermediate 0.3 components
may still refuse a Manage grantee or hide administration controls. This is an
in-place authorization correction with no wire shape, persistence or epoch change.

## Machine RPC method absence (0.3 development)

The Home distinguishes unsupported Machine operations from temporary routing
failures before forwarding. A successful empty method-room lookup plus a
connected, available Machine whose Home-owned acknowledged registration list
omits the method returns `RPC_METHOD_NOT_FOUND`. The daemon uses that same code
for an absent local handler. Failed discovery retains the existing availability
grace, then returns `RPC_TRANSPORT_UNAVAILABLE` before dispatch, not evidence of
an absent capability or client. An eligible local socket is preferred without
an adapter-wide census; global single-answering-client selection still requires
that census. An unknown registration list or a registered method missing from
its room remains `RPC_METHOD_NOT_AVAILABLE`;
an absent daemon retains `target_unavailable`. Session-owned routes keep their
own current-publisher availability decision.

The selected socket's final lookup uses the same distinction: failed or incomplete
revalidation returns `RPC_TRANSPORT_UNAVAILABLE` with phase
`rpc.target.revalidation` (and `ETIMEDOUT` for an adapter timeout). It never
supplies an absent target to an authorization guard. A completed lookup still
allows the guard to return a genuine `RPC_FORBIDDEN` refusal.

Discovery failures carry the existing optional code-only Action `failureCause` through
the RPC acknowledgement. A timeout reports `ETIMEDOUT` at
`rpc.discovery.global_uniqueness` when an untargeted single receiver requires
the full census, or `rpc.discovery.target` for ordinary target discovery.
The outer code remains `RPC_TRANSPORT_UNAVAILABLE`; neither cause proves that
the target disconnected. Live CLI approval decisions retain the full-census
requirement, including when the deciding CLI also owns the waiting origin.
Those are separate sockets, and method registration alone is not exclusive.

Session Run services apply the same distinction to their existing failure codes:
`RPC_METHOD_NOT_AVAILABLE`, `RPC_CLIENT_NOT_AVAILABLE`,
`RPC_TRANSPORT_UNAVAILABLE` and `target_unavailable` become
`execution_run_target_unavailable`; affirmative `RPC_METHOD_NOT_FOUND`
becomes `execution_run_protocol_unsupported`. Legacy untyped method-unavailable
and method-not-found messages retain that distinction. Explicit producer refusal
codes take precedence over prose. This changes error classification in 0.3
development, not the registration packet, Run storage or input-delivery contract.
A connection outage does not establish host death.

Current cluster peers also answer room discovery through the server-only
`happier:socket-room:query:v1` event. This supplements the existing adapter
census because its timeout discards partial replies. One authenticated room
member is positive routing or Machine-presence evidence; an incomplete census
cannot establish absence, unsupported methods, or global client uniqueness.
Account Machine inventories retain observed identities as `partial`, and
unobserved Machines remain unknown. Broker admission keeps its existing
identity, lifecycle, capability, entitlement and currentness checks. Older
servers continue answering the original `fetchSockets` census; a silent older
target still yields the existing transient failure rather than inferred presence.
The adapter's existing fetch deadline owns the operation; no additional timer,
retry, cache or cluster membership policy is introduced.

Session runtime Action placement uses that same snapshot, accepting a carrier
only after the Session publisher owner validates its committed generation,
current fence and Machine access. It revalidates the projection after discovery;
a stale publisher or revoked binding cannot select placement. Committed Pending
input placement remains independent of live publisher discovery. Daemon reconnect
hydration publishes REGISTERED hints from positively observed Account-room members
even when the census is incomplete; UNREGISTERED still requires complete absence.

Resource clients classify only affirmative `RPC_METHOD_NOT_FOUND` as unsupported.
The existing unsupported latch and daemon-state recovery remain unchanged;
temporary failures retain the ordinary retry/recovery path. No client RPC field,
registration protocol, timer or retry policy is added. The registration shape
is pinned to CLI `cli-v0.2.16` / `cli-v0.2.16-preview.1` at
`b8d1c449c46ab4dfa8637db36b66f643d149e66d`, whose Machine socket sends
`{ method: '<machineId>:<method>' }` only for installed handlers. This preserves
the reachable 0.2-daemon → 0.3-Home direction without supporting undeployed 0.3
intermediates or a 0.3 client against a 0.2 Home.

## Confirmed background runner refresh (0.3 development)

Ordinary runner-refresh V1 and process-attested V2 request bodies are unchanged.
The explicit `daemon.sessionRunner.restart.confirmedBackground` operation accepts
those same strict bodies and delegates to the ordinary restart owner with only
native-background interruption allowed. It preserves child draining, foreground
refusal, process identity and Provider binding security confirmation. No request
reason proves consent.

The app confirms raw reported activity, independent of presentation freshness,
and also confirms a current daemon's native-background busy result. Only after
that consent may a missing dedicated method fall back to the original V1 or V2
operation; authorization, cancellation and other failures never downgrade.
An older client using the ordinary operation safely receives busy for active
native work. A current daemon accepts an omitted native activity field from a
non-reporting runner; a successful unknown report permits refresh, while an
actual read failure refuses it. The optional native slot extends the existing
unreleased 0.3 Session-input live-work response in place. An old 0.3 development
reader of a new runner is not a released coexistence contract.

The inspected immutable CLI `cli-v0.2.16` and UI `ui-web-v0.2.17` tags at
`b8d1c449c46ab4dfa8637db36b66f643d149e66d` retain the strict V1 request;
artifact publication provenance was not independently checked for this port.
The moving 0.2 source intent includes PR607 refinements through `5763a9844b`.
The new operation adds no persisted data or downgrade reader. Remove the
missing-method adapter when supported original-operation-only daemons are no
longer a reachable app target.

## MCP Add suggestions and OAuth import intent (0.3 development)

The unreleased MCP catalog adds a closed `mcp.servers.create` suggestion arm;
explicit-entry and Registry-backed inputs remain accepted. Static Action options
expose suggestion identities without changing configured-row listing semantics.
The selected suggestion becomes an ordinary catalog row, with no upstream
Registry reference or automatic update contract.

Remote HTTP imports/install links may explicitly carry only the closed
`auth: { kind: 'oauth' }` intent. New readers continue to accept existing inputs
that omit auth. The preview projects that intent; materialization uses the
existing catalog OAuth shape. No persisted format, wire epoch, credential
authority or migration is added. The optional input is not safely ignorable:
an importer that discards it cannot preserve the sign-in requirement. This
extension requires matching development import/create readers rather than
claiming compatibility with older development importers.

The clean scoped moving predecessor at
`285ee7c5acb3bea1489896a254e4445f2483a213` has no current import/suggestion
owner. Its existing URL-only definitions remain accepted. No reverse-development
adapter or released client update floor is introduced; release availability and
artifact provenance remain separate from this development-source contract.

## MCP Test ingress (0.3 development)

Current MCP Test Actions and UI requests address a saved server with `t: 'byId'`.
The daemon's V1 RPC reader separately retains `t: 'draft'` for the released
`ui-web-v0.2.17-preview.19` client at
`b8d1c449c46ab4dfa8637db36b66f643d149e66d`: its `McpServerTestPanel`
sends the unsaved server and optional binding. The ingress adapter folds the
binding's configuration overrides into the draft before passing it through the
canonical reach resolver and daemon test pipeline. It adds no catalog write or
second test pipeline. Remove this ingress when support for those released 0.2
clients testing against an upgraded daemon ends. The moving predecessor at
`f18aba940c5c56e5b24454e176c836c171098a2d` still produces that request.

Test explicitly selects its one requested server through the canonical Session
selection resolver, including an Off or ruleless server, without changing its
reach rules. A successful saved-server Test records tool annotations in the
existing catalog snapshot. Read-only Session tool projection still denies
unclassified tools; checking an `allow_read_only` server first supplies the read
annotations needed to expose its read tools after restart with resume.

## Bot template format (0.3 development)

`bot_template.v1` uses one closed Protocol schema for private drafts and released
Artifacts. Drafts contain owner-private candidates and source/reserved-release
addresses. Releases carry the reviewed portable content, explicit full SemVer,
release time and notes. The shared projection excludes private candidates and
source bindings; skill bundles retain their validated binary companion files.
MCP export uses recipient input declarations for environment/header values and
URL credentials/query values, without source values or defaults. Remaining
literals require author review.

Direct Artifact and plugin readers consume the same release type. Provenance
comes separately from the admitted transport, never from authored content.
Unknown template serialization versions return operation-scoped
`update_required`; invalid content is refused. Ordinary Artifact and Session use
continues. This new development format has no predecessor template format or
legacy-reader shim, and makes no mixed-component or released-availability claim.

Plugin manifest V2 adds the declarative `contributes.botTemplates` family in
0.3 development. Public authors use its strict descriptor schema; host manifest
and registry-metadata ingress tolerate additive fields and skip unsupported
contributions through their existing readers. This is a plugin-format addition;
the executable runtime ABI is unchanged. A selected template uses the same Bot
template release reader and the exact source
`{kind:'plugin',registryItem,contributionId}`. `registryItem.version` is its sole
package version, separate from the template release version. The host reads
descriptor metadata before acquiring the selected package, without installing
or activating it. An older host or registry lacking the selector, descriptors,
or preview operation returns an operation-scoped unavailable/update-required
result; clients do not introduce a second package reader or install fallback.

Signed-in template links extend the closed existing Artifact public-link
management Actions with `audience:'signed_in'`, plus `artifact.public_link.join`.
They require a matching development Home and keyholding host, with no released
mixed-version compatibility claim. Omitted audience preserves anonymous-link semantics.
Reviewed releases send signed-in creation with `preserveExisting:true`, retaining
the current bearer across releases. Explicit creation without this field still
rotates it. This closed mutation input requires the updated development server
and keyholding client together; older servers must reject it, with no retry
that drops the field. A preserved result contains only `publicShare`, with no
new URL or secret callback. New creation retains the existing URL delivery.
They use authenticated transport and a dedicated relation, never anonymous
publication. A missing join route or unsupported closed input is unavailable;
clients do not retry through an anonymous endpoint. Links bind the target Home
and keep their fragment transient. A successful join creates ordinary view
access, so later copies and updates need no retained fragment. An E2EE source
opened by a Plain Account returns the existing `recipient_key_unavailable`
refusal with reason `plain_account`, without delivering a copy or changing
Account mode. The recipient can ask the author to publish it to the Store.

Received template discovery extends the existing Artifact list request with
optional `audience:'received'` and exact `kinds:['bot_template.v1']`. The access
owner excludes caller-owned Artifacts before paging and coverage counting. The
shared summary selector reads one structural header page, keeps its continuation
through sparse title/description searches, and preserves partial coverage without
reading bodies or walking legacy inventory. An older Home may ignore the new
audience and include owned templates; existing access checks still apply. This
visible mixed-version imperfection adds no compatibility gate or anonymous-link
fallback.

Instantiation is a matching-development-components Action with Account placement.
The requester's host commits ordinary Session birth; the selected Machine remains
the execution target from the nested creation selection. This permits birth
while its daemon is asleep. The birth and setup continuation remains invocation-local;
the immutable recipe carries neither a setup credential nor a browser callback.
Browser-host birth wiring and deferred startup are still undergoing integrated
validation. The private `work.templateInstance` binding records the source,
accepted version and private released-base address, local skill/MCP key maps,
follow flag and optional skipped version. It uses existing Session metadata,
without a database migration or a predecessor-format adapter.

Template birth and onboarding use the person's ordinary Account transport for
Account credentials; API-token execution retains its signed token transport.
Initial access, manager, primary Team and Team credential selections remain
ordinary creation fields, with eligibility and envelope tuples enforced by the
existing Session access owner. The selected Machine's ordinary access-key binding
is installed before launch; onboarding retains Session ownership checks.

Setup and update operands are closed development schemas shared by the UI and
headless Action hosts. Setup carries recipient connection/input references and
selected Machine recipes; template bytes cannot carry the author's bindings.
The template creation continuation joins ordinary Machine setup after birth and
before Agent start. It carries no template setup credential in the immutable
creation recipe. Pending input acceptance remains separate from setup completion
and successful Agent start.
This extension requires matching development components, rather than an older
daemon silently dropping setup selections.

Full-credential copy and update no longer mint template
requester roots or carry template birth/authorship fields. Matching development Protocol, hosts and Home
must load together; older strict schemas reject the changed operands. Restricted
API tokens retain their token-only template HTTP-purpose checks. Software setup
uses ordinary Machine Actions and their approval path. Token-called setup requires
the token's own setup grants; template grants alone do not install software.
No-software operations keep their token-only transport; the daemon's Account
credential never widens a scoped token.

Update review retains the recipient's accepted release as its three-way base;
it never reconstructs that base from the author's revision history. Instruction,
skill and private-instance writes retain their existing expected revisions.
Apply does not compare an unrelated whole-Session metadata revision.
The closed update-diff result now projects accepted first-task and Agent
suggestions from that same base for read-only review beside the offered release.
The new field is required by updated UI readers; matching development Protocol,
Action host and UI must load together. Older strict readers reject the added
field, while an updated reader rejects a result from an older host. This changes
no update Apply operand or persisted instance shape.
Successful settlement advances the base even for upstream parts deliberately
kept or skipped, so those choices become local differences in the next review.
Partial writes leave the accepted version unchanged and return recovery details.
Skip and Stop following remain private instance mutations, without Account
settings, a new update scheduler or a predecessor adapter.

The matching-development server accepts a closed Artifact access
`PUT /v1/artifacts/:id/access/accepted-version` report after successful direct copy
or update settlement. An additive sharing-owned table retains each authenticated
recipient's existing private copy routing and last accepted version. Optional
`acceptedVersions` summaries extend the existing grants-list rows only in the
template owner's projection; there is no new list Action. A server without the
report endpoint leaves the successful copy/update intact because delivery is best
effort, without retries or a compatibility shim.

## Artifact query hints (0.3 development)

The existing `artifact.list` Action accepts optional `kinds` and
`approvalStates` selectors and admits explicitly selected approval headers.
Its input remains closed and uses the canonical approval-state schema; its
strict header output is unchanged. This is a matching-development-client/host
extension, with no new endpoint, content envelope or older-Home adapter.
Unfiltered document lists retain browser membership, and specialized approval
body and mutation admission is unchanged.

Artifact kind filtering is an additive HTTP and persistence extension.
Current readers send the optional coarse `kind` query, exact `kinds` set, or
`browserListed=true`. These wire selectors and `unclassified` are mutually
exclusive. Browser selection is the complement of the canonical Artifact kind
policy's non-listed types, not a whitelist: unknown and classified null-kind
ordinary documents remain candidates. It uses the same typed coverage envelope
as exact-kind reads, with no older-Home fallback in this one-way 0.3 contract.
The daemon negotiates new exact-hint writes through the canonical
`artifacts.queryHints` server feature. Missing or malformed support resolves to
typed `unsupported`; ordinary content writes omit the optional new hint rather
than sending a tagged value to a retained coarse-only schema. This operation
negotiation does not establish general mixed-component compatibility.

The one-way 0.3 upgrade does not support a 0.3 client against a 0.2 Home.
The query-hint operation degrades safely as described above; it is not a general
legacy-server adapter. Current readers still require authenticated owner, access
and Account-mode projections. The data compatibility obligation includes retained
0.2-created data opened through the current Home.

Writes without kind remain accepted. Predecessor rows have null kind; earlier
development rows can have only a coarse kind. An opaque header edit without a
hint invalidates the previous classification; a body-only write retains it.
Protocol's single extraction keeps the existing coarse family and normally the exact
private `header.kind`, without extracting content, names or titles. Managed-Delete
approval headers additionally derive a domain-separated subject key from the admitted
Home and managed-Machine ids. Its indexed hint combines the approval kind with that
key so accepted Delete retirement selects only the exact target; the private body and
revision-fenced approval transition remain authoritative. Its stored
form is `v1:<coarse>:<exact-or-empty>` in the existing nullable string column and
Account/kind index. Read projections still expose coarse `kind`; `kindHint`
presence distinguishes a canonical exact classification from a legacy row.
The existing MySQL column's 191-codepoint boundary limits optional metadata,
not the supported private header type string. Shared extraction omits an
unrepresentable hint; valid private content is neither rejected nor truncated,
and the row remains unclassified. Explicit malformed wire hints still fail
validation. This encoding needs no additional schema migration.

The shared `listArtifactHeadersV1` owner requests the indexed selector and
propagates server-derived coverage: complete with count0, or partial with the
unclassified count and reason `unclassified_legacy_rows`. Neither UI inventory
nor selective reads write metadata. The previous automatic read-triggered repair
was withdrawn after a live write-burst regression. The replacement is one
explicitly paged native daemon Account bootstrap pass, labeling every openable
owner legacy header across all type families. Its `ownerAccountId` selector
intersects authorization; ordinary unclassified discovery also includes
authorized shared rows. The derived count uses the same requested scope,
including for an empty exact-kind set. Labels use the observed header CAS
at the existing metadata-only batch owner. Unopenable/refused rows remain
unclassified and keep coverage partial. No completion marker is stored. While
partial, the same reader may resolve legacy headers through the existing
coarse/unclassified path; that branch stops executing once derived coverage is
complete. Bodies remain selected-id only. New Artifact writers set hints at create.
Current 0.3 development approval queries also carry optional `approvalStates`
and `approvalSessionIds`, backed by nullable state/Session relationship columns
and additive provider migrations. These selectors compose with kind selection;
non-approval kinds are unaffected by the state selector. Approval headers from
0.2 remain readable without either hint. Known-kind rows lacking state join
the existing unclassified header pass, and the native daemon bootstrap writes
the extracted hints through the same metadata-only header-version CAS. An opaque
header change without hints clears them; a body-only change preserves them.
Settled private receipts retain their existing format and exact-id readers.
No read-triggered backfill, cleanup policy or replacement receipt store is added.
State-filtered absence does not certify Artifact deletion. The UI inventory
owner refreshes only formerly matching pending identities by exact header batch
before absence reconciliation; exact not-found retains normal deletion handling.
This prevents an open-queue refresh from discarding concurrent settled receipt
discovery. It does not fetch settled bodies or add a metadata writer.
The scoped predecessor recheck at `01107c0e7a6b2d4b521573c6d69b53070187e76a`
found no staged or unstaged approval/schema changes. Its UI writes the same
V1 approval kind, status and Session binding inside the private header, without
the new server columns. The current Home accepts that retained data; a 0.3 client
against a 0.2 Home remains outside the supported direction above. PostgreSQL
runtime validation and current generated-client publication remain separate
integration checks, not claims established by this source description.
Adapters keep classification progress in `kindCoverage`, distinct from existing
read/decryption `coverage`. A fully resolved legacy answer is readable-complete
even while its server index remains partial; genuinely unavailable sources are
still incomplete and retain their existing refusal behavior.
The browser stream already includes legacy and ambiguous indexed candidates,
so it does not run a second unclassified discovery pass. Opened private headers
still apply the same kind policy, including after selected body reads. An
annotated approval subject hint can also be an unknown ordinary kind string;
it cannot be prefix-excluded without losing the latter. Those candidates may
therefore still be read and privately filtered. MySQL candidate paging compares
stored hints bytewise so its retained case/accent/space-insensitive collation
cannot discard supported unknown kinds. Current grant and content admission
remain authoritative after candidate selection.
Exact-kind HTTP responses in this undeployed, one-way 0.3 contract require the
typed witness; the old Boolean alone cannot certify absence. The predecessor's
unfiltered array response is unchanged, not an exact-kind compatibility shape.
An exhausted scoped structural read may render retained locked rows and reconcile
absent baseline members within its kinds without claiming readable completeness;
unavailable/non-exhausted observations remain additive. Concurrent local changes
retain the same captured-map admission and reconciliation fences as full reads.
Equal labels are no-ops, and labels
change neither private bytes, header/body content versions, nor Artifact recency
and row sequence; discovery AccountChanges remain independent. Needed labels
share the existing CAS owner through the ordered metadata batch transport, not
per-id HTTP bursts. Ordinary coarse-only inventory does not demand exact hint
refinement. Private header
validation, Account-mode, current access and custody remain authoritative.

The original nullable kind column/index migration is still required for a Home
that lacks that earlier extension. Environment owners deploy migrations and
generate shared Prisma clients; this exact-kind extension adds neither another
column/index nor an operator backfill. The current server contract must load
before changed tagged writers/exact readers are used, followed by matching
client reloads. Retained 0.2 rows are labeled by their owning daemon through the
current Home, not UI-reader repair or an operator full scan. A refusal settles
to a typed result for the daemon run; the next attempt is the next bootstrap,
never the next reader fetch or a retry timer.

## Map the seam

For the changed concept, identify:

- the canonical domain owner;
- every producer, consumer, reader, writer, serializer, parser, and persisted artifact;
- the old/new component versions that can actually meet during rollout or rollback;
- the wire, semantic, persistence, and operational expectations at that seam;
- any existing split-brain, duplicate decision path, fallback, or compatibility adapter in the touched corridor.

An existing same-concept split-brain in the touched corridor must be consolidated at the canonical owner. A compatibility adapter may translate released or predecessor shapes, but it must not independently decide domain behavior.

## Direction and rollout

- New readers accept supported old shapes; new writes use the canonical current shape.
- Old readers need to accept new writes only when coexistence, independent component rollout, or rollback makes that direction reachable.
- New clients talking to old servers must capability-negotiate or degrade safely instead of assuming the new contract.
- Old clients talking to new servers retain released behavior for ordinary compatible changes and for every operation the new server can still execute safely. A major incompatible server change may require a newer client for the affected operation, but that support boundary is an explicit developer/product decision—not an agent-selected default.
- Persisted-state changes consider both old-writer → new-reader and, when rollback/coexistence is supported, new-writer → old-reader.
- Prefer operation-scoped graceful degradation over connection-wide rejection: admit the old client, keep unaffected reads and writes available, and return a typed upgrade requirement only when the requested operation cannot be performed safely. Reject the whole connection only when no authenticated operation can be made safe. `agent-transition.md` is the current worked example: an old daemon answers `session.agentTransition` with `RPC_METHOD_NOT_AVAILABLE`, the client maps that one code to a no-effect operation-scoped rejection, every other transport failure maps to an indeterminate outcome rather than a false "nothing happened", and Machine presence — not the error — decides whether the reader is told to update the CLI or that the machine is offline.
- For an incompatible transition, prefer prepare/expand → activate/migrate → contract when mixed-version coexistence or rollback is an approved requirement. Do not assume that old clients must read new writes merely because the server is self-hosted.

Before adding dual writers, parallel persisted formats, rollout modes, operator flags, socket-drain protocols, or a mandatory client floor, compare their lifetime cost with the actual user behavior required. If preserving old-client/new-server behavior for a major change would require substantial machinery, stop and obtain an explicit developer/product decision among: operation-scoped degradation, a documented client update requirement, or the heavier compatibility transition. An agent must not silently choose either forced upgrades or heavy compatibility machinery. This exception is for genuinely incompatible, high-cost transitions; routine server changes must remain compatible and must not manufacture client-update requirements.

### Autonomous exchange Turn-begin witness (0.3 development)

The new optional `startingInputId` on a Session `begin` mutation identifies the
host-correlated accepted input that caused that exact native Turn start. It is
sent only when the current Home advertises `sessions.autonomousExchange` as
enabled; ordinary human Turn mutations keep their previous wire shape. An
older Home's strict Turn-mutation reader rejects unknown fields, so a current
CLI must hold a countable autonomous effect before provider dispatch when the
bit is missing or malformed, rather than omit the witness and run uncounted.
The current Home accepts older clients' witness-free begins without inferring
an input cause or counting them. The moving `../0.2` predecessor inspected at
`40f515ff4bfe55b839e2dc585292f960164ee1e9` has a strict `begin` schema
without this field; the relevant predecessor paths were clean at inspection.

### Question-wait primary turns (0.3 development)

An authored wait-mode question ends its exact primary Turn as `waiting`, not
completed or cancelled. This refines the existing, unshipped cumulative
stored-content V4 declaration; it adds no version, header or minimum client
floor. Current Homes already advertise V4 as their current supported wire
version while retaining the existing V2 minimum for incumbent operations.
Before publishing a wait-mode question or ending its native Turn, the question
owner requires that existing advertised wire version to be V4 or newer. An
older or unknown Home returns `question_turn_yield_unavailable`; continue-mode
and ordinary native questions keep their existing paths. This is operation
wire admission, not a new feature flag or connection-wide update requirement.

The CLI reader at `cli-v0.2.16` and `cli-v0.2.16-preview.1` (both
`b8d1c449c46ab4dfa8637db36b66f643d149e66d`) strictly parses the four-state
primary-Turn union. For peers below V4, the server's canonical compatibility
projection withholds waiting history rows and projects the current status as
unknown, without sending a ready or cancelled result. External-message cursor
settlement still treats waiting as unresolved input; withholding an unknown
history row cannot advance that cursor past it. V4 peers retain the typed state.
Older UI reconciliation can retain historical readiness, so this projection
preserves readable transport rather than promising V4 waiting UX on older apps.

The moving `../0.2` predecessor was rechecked at
`f16a3759a3944bc4be4bbb7e14a3e6a01397f7b5`; its relevant schema and HTTP reader
paths were clean. The [runtime owner](runtime-core.md) owns waiting semantics;
this adapter only translates reader shapes.

Development Follow question originals optionally carry the request owner's closed
`currentHandler` Session value on their exact request reference. Existing unbound
references retain their original keys; an actionable handler assignment has a
distinct accepted-input key so an earlier generic notice cannot consume its offer.
This refines unshipped 0.3 Follow custody without a new store, migration or wire
epoch. Older strict development readers refuse the new field rather than discard
it, so the server and consuming CLI must load the extension together. The question
answer Action and its present-person/manager admission are unchanged.

The same development source-route observation can carry that existing handler
reference and return optional `representedQuestionHandlerSessionId` only when
the exact handler-bound original has admitted Pending or Message custody.
The response and nested identities remain closed V1 objects. The field is
suppression evidence, never a grant, new occurrence identity or persistence
format. Clients that omit the handler reference receive the previous response
shape. A missing result from an older development Home supplies no suppression
proof; the incumbent final admission still applies. This unshipped 0.3 extension
adds no wire epoch, new store, migration or released client update floor.

Development layout-1 metadata-only writes preserve Agent-state bytes and do not
advance their version. The server still compares both expected tuple versions;
clients consume the returned versions rather than assuming both advanced.
Exact lost-response reconciliation accounts for unchanged Agent state while
retaining byte equality and metadata-commit checks. Layout-0 migration remains
a distinct transition. No stored shape or wire epoch changes.

Development non-Session Follow range reads return HTTP 204 with no body when
the authorized, current source has no occurrence yet, or a seeded Discussion
range is exhausted. The existing daemon readers stop without delivery or
progress on that status; the next source change uses the same normal read path.
An exact original still requires positive current evidence and returns 409 when
absent or superseded. Missing source authority, Discussion seed, readable content
or delivery readiness is not an empty range. The closed 200/error bodies and
persisted formats are unchanged; this adds no retry, timer or update floor.

### Retained skill bundles (0.3 development)

The inspected 0.2 predecessor at `82f2997875dd45b0af68bbee2763d095aaa87505`
writes skill Markdown verbatim and projects registry names/descriptions with a
first-colon line reader. Its stored inputs therefore include unquoted description
colons and other non-YAML scalars, as well as safe relative POSIX paths such as
`refs/CON.txt`. Current stored reads retain these inputs at the canonical bundle
owner: YAML decoding takes precedence, with the exact predecessor line projection
used only on YAML syntax failure. New imports and writes stay canonical and
portable; Windows materialization refuses only a Windows-invalid item. This is
forward stored-data admission, not a legacy writer or a parallel catalog. The
[skill content contract](plugin-platform.md) owns the detailed behavior; real
predecessor writer captures live in `packages/protocol/fixtures/`.

New repository and multi-skill upload imports retain an optional `sourceFolderName`
in the encrypted Artifact header's `skillLock`. The current content reader carries
that single directory segment to the Session materializer; edits preserve it.
Headers and Session manifests without it keep declared-name delivery, with no
migration. This is an unreleased 0.3 extension of the closed lock and daemon
materialization request, not a new plaintext Artifact field. The current SDK
delivery also requires each item's absolute `directory`, returned by the
materializer and forwarded by the runner. Plugins use it for path reads, copies
and identity matching; deriving the folder from the declared name loses accepted
imports and renames. The delivery envelope, each item and each native-disable
record remain closed; no optional unknown field acquires path authority. This
is an in-place correction of the unpublished 0.3 delivery contract, independent
of package SemVer, with no released epoch transition or old-development fallback.
The one-way upgrade does not support old 0.3 development daemons or Agent adapters
reading the new shape; reload the runner, daemon and plugin adapters together
before replaying it. Retained headers and Session manifests do not change.

Well-known skill indexes and pack links add a `wellKnown` provenance arm in
unreleased 0.3: `indexUrl`, item `name`, the materialized bundle `digest`, and an
optional `publishedDigest` recorded only after publisher-artifact verification.
Preview pins travel through the existing link `source.refs` carrier alongside
Git tree refs; Add re-verifies selected content before writing any library items.
Existing Git and upload locks stay readable without a migration. This closed
union extension follows the one-way 0.3 development cut, with no old-development
reader adapter. The inspected 0.2 predecessor at
`cc0dbf9ab862f81f8aa94fc3fc1186fb53245963` has neither the current registry ref nor
skill provenance schema paths, so this arm does not replace a predecessor format.

### Account trigger deletion receipts (0.3 development)

The current Automation deletion transaction returns the removed definition's
`templateVersion` as `removedRevision` in its successful V3 response. Whole-set
`workflow.trigger.remove` forwards that evidence in its existing closed result;
child-trigger removal still returns the updated set. Both receipt readers
accept omission from an older Home without inventing a revision. These are
additive fields in development contracts, not new mutation inputs or a new
wire epoch. The prospective 0.2 UI deletion client consumes only success from
V2; this does not restore V2 routes or promise mixed V2/V3 operation.

The existing row-inventory ordering helper retains this evidence for the
focused Account so delayed acknowledged writes at or below the removed
revision cannot restore a deleted trigger set. Read revalidation remains
authoritative: equal revisions may enrich health, and an absent identity may
reappear as a genuinely recreated row. Receipt history is display ordering,
not read or mutation authority, and retires with the Account's trigger state.
Without removed-revision evidence, clients keep revalidation and the existing
ordering limitation for previously unseen higher revisions.

### Home identity connection Team usage (0.3 development)

Home identity connections may include `teamsUsingIt`, an optional read-only list
of `{ teamId, name }` facts from explicit Team authentication-policy Home-method
references. Current projections share that usage reader with removal admission
and resolve it once for the connection set. An unavailable method or an archived
Team can still have a configured reference; inherited Home sign-in choices are
not explicit uses. This list grants no Team content or roster authority.

The Home connection V1 envelope and each Team identity remain closed. The
generated SDK DTOs project the optional field from that same Protocol schema;
no mutation input, persisted shape or wire epoch changes. Omission by an older
Home means unknown usage, while an empty list means no explicit references.
Readers continue accepting omission. This is an unreleased 0.3 projection, not
a promise that older clients can execute the new Home identity operations.

### Quota recovery details (0.3 development)

The moving 0.2 predecessor keeps optional `recoveryCreditDetails` outside its
strict Provider Account Usage base body. Plain V3 records carry the facts in
metadata after negotiating `connectedServices.quotaRecoveryCreditDetails`;
encrypted records carry an account-sealed supplemental facet. Its inspected
released readers at `22ac8263cfdbcdb845441b9044ff18199cf7652e` retain the base
usage while ignoring optional sealed-envelope facts.

Current 0.3 V4 usage snapshots retain the rich optional details in their existing
snapshot, material identity and history owners. The approved all-component,
one-way upgrade does not need another V3 negotiation flag or a competing plain
writer. The existing legacy storage reader reattaches actual predecessor metadata
facets. Encrypted current/history reads and qualified quota projections use the
canonical sealing owner for supplemental facts. Their omission remains valid.
Credit inventory status and count authorize actions; saved quantities and display
reasons never establish debit permission independently.

The SDK recovery facet retains canonical credit statuses and accepts the existing
plugin `unavailable` status only at the host adapter, where it becomes `unknown`.
Known pre-debit failures can explicitly report a certain no-effect outcome;
older plugins that omit this information retain the existing conservative unknown
receipt behavior. Legacy reset RPC aliases delegate to the qualified established
credential owner rather than authorizing scalar V2/V3 transport. This is forward
data and ingress compatibility, not a restored second credential or debit path.

### Antigravity account data (0.3 development)

Antigravity's 0.2 service id, `antigravity`, is a persisted-data input to the
qualified service `happier.agent.antigravity` / `antigravity-account`. Its bundled
compatibility declaration admits stored OAuth credentials, profile/group defaults
and runtime-issue references into the existing qualified owners. Current writes
use qualified identity. OAuth project metadata survives as `projectId` in the
qualified credential and becomes the native ACP token's `project_id` at
materialization.

This is storage ingress, not a new scalar public-service alias. The existing
closed legacy peer service set remains unchanged, and Antigravity advertises no
legacy peer operations. Reverse profile/revision projections must omit this
storage-only mapping rather than publish a scalar Antigravity row. Internal
physical database identity columns do not grant an old peer operation.

The additional 0.2 defaults carrier is read by the existing qualified preference
migration and retired on edits/deletion through that owner. It is not copied into
a second 0.3 default chooser. Fetched settings that reject the canonical schema
refuse qualified launch defaulting instead of selecting cached or native
authentication; network failures retain the existing cache policy. Runtime
issues retain generic failure, retry and reset information while their stored
service references are normalized once.

The approved all-component, one-way 0.3 upgrade does not require 0.2 outward
reader negotiation, but does require forward readability of actual 0.2 data.
Generated compatibility publication, real stored-row/revision checks and current
package validation remain required integration gates. Retire the storage adapter
when those persisted 0.2 inputs leave the supported data window, not merely when
old processes disappear. This integration is unreleased and still under validation.

### Retained quiet input (0.3 development)

Pending Input revision 5 adds the closed `retainedContext` materialization proof
for exact informational originals still retained by the current publisher's
local queue. The parent proof-bearing request is also closed. A CLI sends this
operand only after observing revision 5 support; an older or unknown Home leaves
the operation unavailable instead of silently ignoring the proof. Ordinary
requests without retained context retain the existing revision 2–4 ingress.
The server verifies the same-Session claimed rows, informational admission and
current publisher before excluding them from rejoin/claim selection. It does not
resolve those rows or infer native acceptance. The materialization proof adds no
persisted format.

File review notes extend the existing unreleased 0.3 admission operand and
receipt with optional `nextTurnNote: 'file_review_note.v1'`. Authenticated Pending
admission stamps this content-free intent; the action and paths remain inside
the ordinary Session content envelope. The runtime requires both this receipt
and a valid note payload before retaining the input for the next actual turn.
The retained-context owner recognizes that same receipt, so an informational
note cannot block the following ordinary input or acquire its permission
identity. Existing 0.2-created inputs without the marker keep their ordinary
semantics. This evolves the undeployed 0.3 contract in place. Before publishing
a note, CLI and UI senders require the existing advertised Pending revision 5;
older or missing support returns a typed delivery failure without a Pending POST.
The predecessor's open HTTP body strips unknown operands, so merely sending the
marker would not establish quiet delivery. The UI's existing wire-version owner
retains revision 5 through initial admission and replay rather than projecting
the note onto an older wire. No new capability bit is introduced.

The inspected moving 0.2 predecessor at
`89868c98f0cddc0a42fc3a97b2b3e311363756ed` advertises revision 2 and ignores
unknown fields at its materialization ingress; its relevant paths were clean.
That reader cannot safely consume this proof, hence the operation-scoped
capability requirement. This is a 0.3 development contract, not a released
mixed-version or loaded-runtime certification.

### Pending reset starts (0.3 development)

Runtime failure diagnostics keep the predecessor's closed failure POST fields
and activation authorization fields unchanged. The optional, strictly decoded
`failureDetails` query carries only closed diagnostic codes; a predecessor
without that query reader ignores it and still performs the exact failure CAS.
Current Session reads expose those facts as the separate additive
`pendingActivationFailureDetails` projection. The existing failure column accepts
the predecessor's scalar code and the current flattened diagnostic JSON. These
diagnostics neither alter activation authority nor claim delivery, and do not
introduce another writer or retry path.

For a launch refused because a connected-account pool has no usable member,
the daemon projects the canonical launch detail to
`runtimeReason: 'no_eligible_member'`. It retains no profile identifiers or provider prose in
Pending diagnostics. The pending owner blocks an unclaimed input with
`runtime_config_blocked` for a definite spawn rejection; the Session remains
available. Current UI Session readers retain the optional diagnostic through
list, socket and local-cache projections so Pending and Resume can explain the
pool refusal and recovery. This extends the unreleased 0.3 diagnostic vocabulary;
current server, daemon and UI readers need the matching diagnostic vocabulary.
The unchanged CAS body alone does not establish mixed-version consumption of
these diagnostics.

The diagnostic JSON is forward-only development storage: a 0.2 server reader
recognizes only the scalar failure code and cannot project these new writes.
The current reader preserves 0.2-created scalar failure state. This does not
promise predecessor-server coexistence or downgrade; old-client reads of the
unchanged authorization envelope are a separate direction.

Managed accepted-input Start failures use that same failure-code field with the
closed development vocabulary `managed_start_refused`, `managed_start_denied`,
`managed_start_expired`, and `managed_start_failed`. The installed controller
reports through the existing signed activation-failure route even when Ask
settles before native admission. The pending owner compares the original input
and `requestedAt`, retains its queued content, and publishes the failed state;
an explicit retry rearms the same input with a newer timestamp. Native or approval
error prose is not persisted in this field. Unknown codes are omitted by stored
readers, and the current reader still accepts predecessor `runtime_start_failed`.
This extends unreleased managed-wake contracts; it adds no migration, reverse
0.2 writer, or promise that a predecessor understands managed wake.

The existing Pending Input numeric protocol revision 4 advertises the new
identity-bound `reset_start` arm, installed Machine release, and source-filtered
waiting read. That read can also return optional `unboundEntries`: content-free
identities of owned, admitted, unconsumed Session Pending input. Its omission by
an older reader is not authority to invent an Account-wide queue or disclose
prompt content. Earlier positive revisions retain their own main/target-aware input
behavior. A new daemon must omit its reset operation leaf unless the cached Home
supports revision 4 and the concrete reset owner is mounted: Machine capability
publication is a strict complete projection, not a place to send unknown leaves.

The inspected 0.2 predecessor uses four strict Pending action kinds. Its UI
treats an unknown non-null action as a blocked unsupported row, never as default
enqueue; other rows remain readable. The server holds reset rows before claim,
refuses reset admission to unsupported Machines, and releases to the already
supported enqueue shape. This adds no reverse writer or rollback representation.

The reset set Action retains the existing-row request and additionally accepts a
strict `initialInput` in the canonical plain or Session-encrypted content envelope.
If a device misses the witnessed reset while asleep or offline, the original
held message sends at the next fresh comparable window. The shared readiness
owner still checks current authority, entitlement, denominator and observation
freshness; stale, incomparable or not-yet-observed windows keep waiting. The
daemon consumes that readiness through the existing Pending release owner, with
the original accepted witness and cancellation unchanged. It does not rebind the
hold, ask again, add a timeout/retry policy or wait forever for a past window.
The initial-input effect uses the same Pending admission owner and creates the
row held from its first write; it never enqueues ordinary input before binding.
The stored message projection preserves the existing `modelSelectionV1` carrier,
including malformed presence. Its canonical model-selection reader validates the
intent; projection cannot erase it and cause a legacy-model fallback.
Fresh opened B and its exact accepted witness qualify the current window before
the effect. The server also checks installed-target capability and accepted
history identity before creating custody. Unknown or stale windows do not fall
back to immediate delivery. The development signed reset root carries a strict
input-bound projection of Session/local input, qualified source, B record, meter
and accepted witness. It authorizes only Account-mode currentness and exact
source/record/witness preparation reads, then the matching Pending effect.
Plain issuance derives these facts from the input; encrypted issuance signs the
visible projection, which the canonical opener compares with the decrypted input.
That projection uses fixed-size canonical domain-separated Session/source/record/
witness digests and a full mutation-purpose digest, retaining the decoded Action
input budget without copying large accepted identities into signed HTTP headers.
Missing or mismatched facts fail closed. This changes only the unreleased 0.3
signed contract and introduces no reverse 0.2 writer or generic Account authority.

In 0.3 development, approval decision requests use the same admission pattern.
The closed V2 request and Home-signed binding carry optional
`approvalDecisionAdmission: { artifactId, decision }`, containing only the existing
Artifact id and `approve`, `reject` or `cancel` state. The request-seal owner
projects it; the installed executor checks it against the decoded decision.
Private operands, including narrowed input, remain encrypted. Both server purpose
fences require this admission for non-publishing reply settlement, and the existing
original-input transaction permits a change only for its pending Artifact and
exact Session, local input, Discussion question and accepted turn.
Approve permits only an approval-bound failed publication, never review.
Reject/cancel permit their matching review or, for ordinary confirmation,
only `approval_rejected` / `approval_canceled` respectively with
`phase: action_admission` and `retryable: false`; native outcomes remain intact.
An identical completed settlement is a no-op. Older requests without admission
remain valid for existing Actions; they cannot spend this new settlement purpose.
The inspected 0.2.17 stable/preview and moving 0.2 worktree have no V2 carrier or
strict reader for it. No released format, persisted state or dual writer changes.

### Project and checkout identity (0.3 development)

Current development checkout resolution has one Protocol owner:
`workspaces/workspaceRefResolutionV1`. Exact selection qualifies a WorkspaceRef
id with its Home, or supplies Home, Machine and normalized root; a full address
also verifies the checkout id. An unqualified id is accepted only when the whole
candidate set is unique. Duplicate candidates remain ambiguous, rather than being
collapsed or narrowed to the active Home. UI Home aliases and target-platform
path helpers adapt to that same owner.

Accepted refs retain a stable Project anchor, `projectKey` (the ref id for an
unenriched predecessor). Adding Source or hosting facts cannot change that anchor
or merge independently accepted Projects. A new checkout may join its host-proven
native parent or dedicated copy source, or a unique, proven same-Home Source or
repository association. Personal Project widget
Artifacts use the anchor; filesystem access and plugin grants use the exact
checkout. Home-qualified local checkout preferences read bare-id predecessor
values only when canonical resolution proves their unique Home.

The optional SCM SDK checkout-discovery `parentRootPath` carries a host-proven
main checkout or bare repository root. Hosts consume it only for discovery of
the current exact checkout; older contributions may omit it. New linked refs
inherit through the existing parent Workspace contract, after exact accepted
refs and explicit parent addresses have taken precedence. The field introduces
no persisted row shape or Session metadata format, and independent local clones
gain no association from it.

Canonical writes are strict. Stored ref readers drop unknown fields recursively
while validating known identity and enrichment fields. These are development
source contracts, not a released row-storage rollout or loaded-runtime QA claim;
Project row persistence has its own Account/Home owner.

Session Project association uses `resolveSessionProjectKeyV1` at that same
Protocol owner. The optional nullable `Session.projectKey` row field carries the
accepted Home-local anchor; readers qualify it with the row's Home and can group
or filter before private Project refs or labels load. Missing and null both mean
not yet published. Older rows remain readable through exact Machine/root
association, using a published sandbox's host `machinePath`. An explicit
Home-qualified `workspaceId` selects its accepted checkout independently of the
Session's subdirectory or execution Machine. Legacy `projectId` only checks a
resolved ref; it cannot establish association alone. Incomplete or ambiguous ref
coverage remains unavailable rather than becoming a guessed Project.

The accepted-workspace registration publishes the key through the existing
owner metadata tuple patch, including an already accepted exact checkout without
SCM. Native links use that same publisher after affirmative current creation or
as part of a real metadata update. An unchanged historical revisit does not
discover or publish identity, and a legacy response that omits `created` is not
affirmative creation evidence. Omission preserves the stored key; shared-editor
and migration patches cannot set it. The additive nullable column has no SQL
backfill: the server cannot derive private Project association. Pre-upgrade
Sessions may remain keyless. The visible list retains their exact Machine/folder
group and demands the open Home's existing Projects read while those rows are
visible. Foreign Homes retain the fallback until their accepted row key arrives.
This is a development-source contract; retained database deployment and loaded
runtime validation remain separate evidence.

Development filtered listing accepts optional Home-local `projectKeys` include
and exclude sets. Follow previews send them only when the existing
`sessions.filteredListing` enabled advertisement also carries
`projectSelectorVersion: 1`; absent, malformed, disabled or unavailable support
keeps exhaustive paging and the same results on older strict query readers.
The shared filter projector qualifies each key with its selected Home before
sending it. The server preselects accepted-key matches plus unclassified
null-key candidates before pagination, preserving access and every other
structural predicate. A Session whose owner published `projectKey: null` ("no
Project", stored as `projectKeyNone`) is skipped by an include selection through
`Session_project_selection_idx`; an exclude-only selection still admits it.
0.2-created rows carry no classification and remain candidates until their owner
republishes, so 0.2 data keeps its membership. A Session that gains a Project
later is selected once its owner publishes the key, which replaces the "no
Project" fact. Owner republication happens on accepted-workspace registration
(Session start/resume), native-link metadata writes, and when the Machine's
accepted checkouts change: each daemon subscribes to its installed Project rows
(`subscribeActiveProjectAccountRowsSnapshot`, refreshed by the server's Project
row change push) and, when a checkout on its Machine arrives, reads its
owner-published no-Project rows (`projectKeys: { include: [], exclude: [], none:
true }`, which selects only `projectKeyNone` rows and takes no keys) and
publishes the key for each Session on that Machine the canonical resolver now
places (exact checkout root, not a subfolder). When a checkout on its Machine is
forgotten, it reads that checkout's Project keys and returns each of its
Sessions on that Machine stamped with that checkout to "no Project" (or to the
checkout now at the same root). A daemon that was offline at the change applies
it at each Session's next registration.
The canonical local Project predicate remains responsible for unpublished
identities; the server does not derive private Workspace associations. The
Project Session roster (`useProjectSessions`) sends its Project as this selector
when the canonical query support owner (`resolveSessionListQueryHomeSupport`)
admits it. Otherwise its request producer omits the unadvertised selector and
retains the existing strict-query or ordinary-list path and complete local
matching. That compatibility path can still traverse the Account inventory.
On supported Homes, Session document reads are proportional to matches plus
unpublished candidates, not the known-key corpus. Historical client
publication/backfill is not part of this
development correction.

Filtered Session query pages may be short or empty with a non-null continuation:
the existing V1 response schema places no minimum on `sessions`. Development
servers bound exact admission by the initial request's two existing protocol-maximum response batches
(ordinary plus attention); continuations assign both batches to their single cursor family and preserve the
existing V2 activity/id cursors. Snapshot, complete-query and preview
readers continue by cursor, independently of row count. Progressive query
readers fill one visible page across short responses; earlier progressive
readers retain a valid explicit Load more path. No wire field or negotiation
changes. The 0.2 predecessor at `fde87977487081701c4e9471f160f4a4a9982914`
does not produce the strict filtered-query request and retains its GET adapter.

Project titles remain private Account content, separate from that row anchor.
`projects.organization.update` edits or resets only the existing Project
organization row's `label`, using its expected revision and preserving pin,
visibility and context. A reset removes the organization override; it does not
rename an accepted checkout. `projects.workspace.update` remains the exact
checkout metadata operation (label, pin and, since 2026-11-08, the optional
`projectKey` grouping: an existing Project key, or `"self"`), not a competing
Project-title writer. The field is additive: an older writer that omits it leaves
the anchor unchanged.

Worker-copy classification uses optional creation provenance on the same Sync
relationship: `worker_clean_copy` binds distinct source and target WorkspaceRefs
to that relationship's endpoints. Retained provenance cannot be added, removed,
or redirected in place. Stored relationships without it, or with an unknown
provenance kind, remain readable ordinary Sync rows and do not qualify for worker
admission or worker-copy retirement. Canonical worker retirement refuses them
before graph mutation; ordinary Sync termination remains separate and unchanged.
The existing `workspace.sync.relationship.create` Action accepts optional
`purpose:'worker_clean_copy'`, with the user's required target Machine and path.
Destination replacement preflight consumes the selected Machine's Manage
admission, including an admin grantee from another Account. It inspects that
Machine's selected folder before consent; it grants no access to the custodian's
Account workspace graph. Bootstrap prepare/release retain their private custody,
and destination approval and exact installation/root checks are unchanged.
Normal relationship create/replace Actions from saved-profile MCP and UI select
the source Machine from the requester's Home-qualified WorkspaceRef and obtain
the existing original Account admission before Ask, including an Account-owned
source. Approval retains that signed requester invocation. The source controller
uses its requester relationship owner and signed target phases; it does not fall
back to a raw bootstrap that reads the destination custodian's Account graph.
The destination obtains the finite source seed through that same signed
relationship authority, rather than its own custodian's Account credential.
Later authenticated recovery uses the receiving target authority's retained
signed native loan, matching its Home, actor, receiving Machine installation,
relationship and target WorkspaceRef. It does not require an isolated execution
capture for that native loan or acquire a second admission. A missing loan,
including after receiver restart, still refuses with
`agent_isolation_unavailable`; a raw recovery request cannot recreate custody.
Project Open retains its original source packet; a normal relationship root
retains its own admitted source and target without inventing a Project packet.
Signed target and seed socket phases accept the installed daemon's paired
terminal credential as transport custody, alongside Account credentials. The
signed Action authority, custodian and exact Machine installation still decide
the operation; a terminal credential alone grants no cross-Account authority.
Unrecognized create failures retain `workspace_sync_unavailable` as the outer
RPC code and preserve the underlying typed `failureCause`. The daemon projection
keeps a credential-redacted nested code, name and message, includes that reason
in the Action error text, and logs the same projection with the request id.
It does not serialize the raw exception, request payload or stack.
RPC manager admission refusals use the same `error`/`errorCode` envelope as
serialized handler exceptions, preserving `effectAttempted: false` and any
typed cause. They do not carry a domain `ok` flag. The shared refusal reader
raises that typed error before a consumer parses its domain success schema;
Sync recovery still accepts only `settled` or `recovery_needed` success results.
This producer correction requires the current daemon; it does not grant recovery
access when requester isolation or retained custody is unavailable.
Its relationship owner stamps endpoint provenance before bootstrap; a fresh ref
inherits its proven source anchor without requiring a Project object. A folder
already anchored to a different Project is refused before bootstrap. The owner
never upgrades an ordinary relationship's provenance. Missing copies return typed
`worker_copy_missing` no-acceptance facts before operation admission; UI recovery
opens the existing Sync creator with the Machine selected and path left for the
user. Dequeue flushes only the admitted existing route and retains its provenance.
These are 0.3 development source contracts, not released or loaded-runtime QA
claims. An ordinary link or committed receipt does not supply copy provenance.

New 0.3 worker-copy relationships store `committedAtMs: null` while staged. The
existing relationship owner replaces it with the commit timestamp only after
the target commit settles, in the same publication that enables the link.
Pause/resume preserves that fact. A failed creation retains the explicit null;
an absent field on an older row conservatively retains possible native custody.
The Project Service binding observer excludes only worker-copy definitions with
the explicit null marker. Committed and legacy paused links still require a
complete native binding observation; an unreadable endpoint returns unavailable
with its Machine identity. This recorded creation fact does not replace the
target-local materialization receipt or authorize removal of target files.
The stored relationship and placement result remain closed V1 objects; the
tolerant stored reader accepts an absent legacy field and validates present
values. These undeployed 0.3 refinements introduce no supported old-reader/new-writer
or rollback direction.

Service placement observations in 0.3 development carry an optional bounded
`reasonCode` when native custody cannot be read. Machine-specific failures also
retain the Machine identity; Account/topology currentness and malformed binding
failures remain distinct from absence. The closed V1 reader accepts omission
from earlier development producers. This diagnostic grants no execution or
control authority and adds no persisted state or supported rollback direction.

### Widget and organization stored readers (0.3 development)

Shared Project dashboard widget names use the already optional
`WidgetInstanceV1.displayName` field in the layout body. Existing layouts that
omit it remain readable and retain the neutral title fallback when the
definition is unavailable. Current writers populate that same field for shared
layouts; there is no additional title field, schema epoch or migration. Current
0.3 readers already accept `displayName`, including strict instance readers.
The inspected moving 0.2 predecessor at
`54918b9269ec4e4f57287605472a01e96b6b5767` has no tracked widget layout or title
implementation; it does not establish an old-reader/new-dashboard contract.

WorkBoard widget placement refs retain their original server label, which can
be client-local, as part of the persisted placement key. The admitted Board Artifact fixes the
Home for Actions: the widget port projects its placements into the caller's
captured routing scope and translates edits back to their stored refs, preserving
item order and canvas positions. Account and Artifact access checks still apply;
another local server label cannot bypass strict host-target admission. Ambiguous
retained instance ids refuse edits instead of selecting a placement arbitrarily.
The Board UI supplies its current binding to executable widget bodies; a stored
placement alone cannot activate reads. This development correction changes no
wire schema or stored key and does not establish loaded-runtime certification.

Account Settings' retained legacy JSON carriers use the same stored-read owner.
Valid predecessor profiles and SavedSecrets remain readable above current
collection or byte budgets; new-write admission applies those budgets and
returns a typed refusal. Present profile/secret data must not recover to an
empty default merely because it exceeds a new-write budget. Automatic Voice
machine selection and recovery now remember their target in the device's
Account/Home-scoped runtime memory, not in Account Settings. The never-shipped
`executionMachine.autoMachineId` field is dropped by the stored Voice reader;
an explicit fixed machine choice remains an Account preference.

### Settings alias contraction (0.3 development)

The canonical Account Settings catalog no longer admits the historical preference
aliases `viewInline`, `expandTodos`, `usePickerSearch`, `compactSessionView`,
`compactSessionViewMinimal`, `reviewPromptAnswered`, `reviewPromptLikedApp`,
`lastUsedPermissionMode` or `lastUsedModelMode`. Its retired-root classifier also
excludes them from effective reads and history restore. Raw captured documents
remain separate from that projection: ordinary preference mutations do not erase
untransferred sources.

The prospective producer inspected for these aliases is `../0.2` at
`e087d15a2f0cce1de6de8ef0895d9c8bcc035056`, with a clean relevant
`accountLegacySettingDefinitions.ts` UI registry (the separate dirty Protocol
change adds a Connected default). This is predecessor-worktree evidence, not
a claim that this exact tree was released. The UI compatibility seam
reads its compact booleans into `sessionListDensity`, `usePickerSearch` into the
two current picker preferences, and the permission alias into target-keyed
permission intent. Explicit current preferences take precedence. These readers
do not write old aliases back; they remain required while supported predecessor
documents can enter the Settings opener. Dead presentation, feedback and model
state has no replacement policy. The sensitive inference source has a separate
[SavedSecret transfer contract](encryption.md) and is not globally retired.

Viewer selections remain an Account preference, not an entity transfer. The
catalog uses the viewer owner's existing 64-KiB encoded-value budget and 128-entry
schema; the enclosing Settings document retains its 512-KiB budget. Selectors use
the SDK's canonical spelling. An unavailable plugin identity remains stored;
temporary resolution fallback does not authorize rewriting that intent.

Profile definitions/bindings, prompt stacks, folders, invocations, external links,
registry sources, context selections, role overrides and historical guidance
entries are read-only raw sources, not writable Settings definitions. The
Protocol Settings owner retains their existing domain schemas only for
provenance admission; current readers use Profile rows, prompt-library rows or
Role Artifacts. Captured raw sources and history remain until their respective
destination/control admission proves cleanup safe. The Profile and prompt
source owners perform that conditional removal, not the effective Settings
parser. Builtin Profile enablement, run-instruction enablement and the genuine
Agent spawn/allow-list/delegation/approval policies are still current Settings.

Registry transfer admission uses the registry owner's complete inventory, not
its tolerant display projection. Released V1 sources allow arbitrary adapter ids
and config dictionaries; an unrepresentable source/config, duplicate id or
malformed entry keeps that row inactive and its original source/history intact.
Independent complete catalogs can activate, while cleanup remains pending until
the unresolved source is repaired. Current writes retain the strict V2 shape.

Remote-host, notification and Connected metadata sources follow their existing
private-row importers under the same destination-first rule. Their Settings
exports do not remain live fallbacks. These source readers are removable only
when the supported predecessor/raw-history census no longer needs them.

In 0.3 development, skill reach rules use the same prompt-library entity-row
authority under `skill-rules`. That row has no retained 0.2 Settings root: its
first write still requires captured Settings currentness, but source cleanup,
history normalization and encryption conversion skip its null root. Presence
and versioned deletion prevent initialization from restoring removed rules.
The row reader drops additive stored fields and rejects duplicate rules for
the same skill, place and Agent scope; current writes use the closed record.

The development Prompt Library list reads only physical keys recognized by
its canonical key schema, before decoding their envelopes. Unfamiliar rows,
including opaque content and tombstones, stay stored and confer no prompt
authority; they do not make known context unreadable. Known rows still fail
closed on corrupt content, key disagreement or Account-mode mismatch. Direct
reads and mutations reject unknown keys. Account-mode conversion and its
post-state check retain a complete prefix census and refuse unknown rows;
display omission does not authorize a conversion that leaves them behind.

`skills.rules.set` resolves skill names or ids through the Account Artifact
library and applies the shared reach intent to the row revision it read. A bulk
change commits in one row CAS, returns each item's previous rules for Undo,
and returns `conflict` when that CAS loses. An unreadable row or incomplete
Artifact inventory is `catalog_unavailable`, never an empty rules value.
The shared rules Action spec supplies CLI `skills on/off/inherit` and declares
the same approval behavior as MCP rules: present-user UI changes apply directly;
Agent, CLI and MCP callers ask by default unless the existing policy waives it.
These are unreleased development contracts. The bundled `happier` skill has one
deterministic Everywhere rule in the initial `skill-rules` row; existing rows,
Off rules and removed places never reseed it.

Context-stack skill migration adds deterministic rules at the Account and
Project layers, Profile seeds and Session includes. It retains legacy coding
entries as inert stored data so retained `disabledInheritedEntryIds` can still
map to skills at start/attach and become Session excludes. Shared Project
attachments yield per-viewer Account rules and remain stored. Migration
at the Profile and Session owners consumes enabled legacy entries once: the
existing row's `skillMigrationV1: true` field is written with its seed or include
in the same CAS. Removing that positive selection without Off does not restore
it on reload. The kept marked entries still resolve inherited exclusions;
predecessor readers ignore the additional field.
Profile positive migration classifies only enabled, unconsumed entries; a disabled
unavailable Artifact does not withdraw the catalog. Voice dropping and retained
Session inherited exclusions still classify their disabled references.
Account and Project migration record the scoped deterministic legacy entry ids
in `skill-rules.value.consumedLegacyEntryIds` on the viewer's existing destination
row, in the same CAS as the projected rules. Rule edits and deletion preserve
these ids, and later migration skips them before Artifact classification. Shared
Sources are never written; each viewer consumes their attachments independently.
The canonical strict Prompt Library row schema accepts this optional field;
stored readers continue to ignore unknown fields. This is an unreleased 0.3
contract, so a QA server must reload that schema before testing new writes.
Classification preserves proven inherited excludes when an unrelated own
Session bundle is unavailable. Unresolved required inherited custody withholds
skill delivery through the existing capability notice, not Session startup.
Private Run preparation reads only its captured Account custody and Artifact
transport, including with ordinary Account credentials. Qualified references
use the existing Home identity owner; foreign Home credentials are not borrowed.
Skill-schema bundles are never pasted; retained generic bundles keep their
existing text.
Voice skill entries are dropped without a rule or include. The migration uses
the existing catalog, Profile, Project and Session owners and adds no mapping
store. Existing library skills without an applicable rule or Session selection
stay Off. These source contracts still require the composed program live check.

Launch Profile publication likewise uses only the admitted Profile-row port.
It replaces the captured row's definition under its existing revision check;
enablement, prompt attachments and private binding masks stay on that row. The
published Artifact contains no private bindings. The unused raw-Settings
publication writer and its dependency union have been removed rather than kept
as a second mutation authority.

Artifact-backed Profile Save uses that same private row writer for binding
changes, including explicit None masks. A binding-only edit does not rewrite
the Artifact or pin inherited defaults; unchanged editor timestamps are not a
body edit. A combined edit first acknowledges the captured private row and
Artifact revision, then updates the authored Artifact body while retaining its
published default bindings. These are separate acknowledgements: a later body
failure leaves the acknowledged private row intact and returns failure, not
complete success. The editor retains its draft; reload the current row before
reapplying it rather than retrying the old row revision. This development-only
owner correction introduces no new wire or persisted format.

Launch Profile rows also carry private `skillSeeds`, defaulting to an empty list
when older stored rows omit the field. `launch_profiles.save` edits those seeds;
the generated save command accepts repeated `--skill` names, resolved through
the canonical Account skill Artifact inventory. New Session admission adds the
seeds to `capabilitySelection.skills.forceIncludeSkillIds`, retaining explicit
Session exclusions. Resume consumes the stored Session selection without
reapplying the Profile seeds. Seeds stay on the private row and do not become
reach rules or published Profile Artifact content. These are 0.3 development
source contracts; the Profile catalog adds seeds from classified enabled legacy
stack entries while retaining those entries for inherited exclusion identity.
New Profile Save stacks, including first Artifact membership attachments, use
the current prompt-stack authoring placement contract. Existing rows and
captured duplication retain their stored placements through the row owner.

### Tolerant stored-data readers

Session input receipts and stored authorities in 0.3 development retain terminal Follow notices that
were admitted with an exact message original before host Turn originals became
required. The receipt-owned delivery schema accepts only those historical
`finished` / `failed_or_stopped` message shapes alongside current deliveries,
so authenticated transcript pages, message updates and Pending projections keep
the accepted history readable. The canonical authority schema registers its
stored projection with `json/storedReadSchema.ts`, reusing that same retained
delivery schema. Session-core and UI raw-record readers inherit it through
stored message metadata; source and permission refinements still apply.
New Account and Machine input admission still
uses the strict current delivery schema and requires a host Turn for terminal
events. Receipt compatibility never synthesizes a Turn or grants new input
authority; known identity, placement and event fields remain validated.
Transcript receipt projection removes the private `followSources` and
`followRelations` proofs before validating public attribution. Retained receipts
can therefore remain readable when their private Follow witness predates the
required `selectedDelivery` vote. Full native custody reads and new input
admission still require the current private proof; projection neither invents
that proof nor grants input authority.
This is retained development data, absent from the inspected 0.2.17 release and
moving 0.2 predecessor, with no database rewrite or released client update floor.
In the development UI, an admitted Follow original without its exact correlated
WorkerUpdate card remains visible through the shared source notice, without
exposing the model prompt. Source visibility does not imply accepted delivery:
the wake explanation still requires the canonical accepted-wake projection.
Durable Pending readers use that same stored-authority projection and retained
receipt-delivery schema. A blocked Pending twin keeps its transcript slot and
delivery controls while presenting the source notice; it is not a decrypt failure
merely because its admitted authority predates the stricter write contract.

Collection filter records in 0.3 development are a narrowing-sensitive exception
to dropping unknown stored fields. The canonical filter owner registers its
stored-read projection with `json/storedReadSchema.ts`, so nested Follow rules,
SessionTargets, Boards and saved spaces retain unknown core conditions and
extension selections as opaque data. Known fields retain their validation.
An unknown or list-only condition evaluates unavailable in an unsupported
evaluator; a known miss still dominates. Effect dispatch requires a fresh match.
Strict current writes reject unknown fields and daemon-rule writes reject
list-only fields. Opaque stored conditions never become executable callbacks,
access authority or a successful filter. These are development source contracts;
no current-to-predecessor rollback writer is introduced.

Development Session creation provenance retains earlier immutable recipes through
the canonical recipe stored projection. A stored string directory becomes a path
intent, and the former nullable `mcpSelection` carrier becomes the current
`capabilitySelection` carrier, preserving explicit MCP choices and null. This also applies when
opening the recipe inside Account-owned Session metadata. Current writes still
require the current directory and capability fields; malformed or missing known
provenance remains invalid. The projection preserves creation retry meaning and
does not discard the birth record to make the enclosing metadata readable.

Session capability Actions in 0.3 development source keep the released
`mcpSelectionV1` and `mcpSelectionRestartRequiredV1` shapes. The generic metadata
codec also owns the skill selection and its applied baseline; its optional
`capabilitySelectionApplyV1` field is a refusal/status projection, not desired
policy or a durable work queue. A raw predecessor MCP selection patch reaches
the same settled-turn synchronizer. Attach retains pending baselines; a fresh
start acknowledges only the selections it actually prepared. The preview RPC
adds generic capability fields while retaining its old MCP response projection
for supported older clients. Current Actions validate the strict generic output,
so a reachable older producer lacking those fields is an invalid input/unsupported
producer response, not evidence that the Machine is offline. Native per-Session
Off writes an exact native skill name through the existing overlay selection
contract; it does not require an online scan to save the desired change.

Stored widget definitions, instances and placements, Session/WorkBoard and Home
layouts, Companion preferences, workspace tabs/canvas state, and legacy folder
settings read their known fields and drop unknown object fields recursively.
The Protocol-owned `json/storedReadSchema.ts` derives persistence projections
from the canonical schemas, preserving required identities, domain refinements
and opaque JSON values. UI-local persistence schemas use the same stripping
policy. Organization display envelopes use a stored projection only when opening
database content; HTTP snapshots and mutations remain strict.

The same policy applies to Account catalog values, device-local Settings and
pending deltas recovered after restart, stored Session drafts and delivery facts,
CLI custody/checkpoint/permission records, and plugin Collection values and
source-instance checkpoints. Custom preprocessors register their stored
projection at the schema owner so an internal strict reparse cannot undo the
read projection. Composable plugin schemas use Protocol's schema-derived
stored reader, exposed as `createProtocolStoredReadSchema` through the SDK's
`/protocol` facade, rather than a second validator. This facade is for persisted
reads only; operation inputs and writes use the original strict schema.
Opaque JSON remains opaque until
its semantic owner projects the recognized stored fields. Unknown fields do
not acquire routing, permission, credential, or mutation authority.

In 0.3 development, Provider Account Usage current records, retained history
pages and exact reset-witness reads use this persistence projection. History
and witness payloads then pass the canonical write validator's known-field,
record-identity and payload-mode invariants. New writes remain strict.

Authentication and typed interpretation are separate boundaries: authenticate
the original material covered by the format, independently of typed projection.
Package Asset integrity covers its complete logical body JSON; hosted UI
integrity covers the exact file set and file bytes, not header annotations.
Never authenticate a stripped projection instead. Likewise, a retained request
may expose projected known facts without changing the original replay body or
the digest/tag computed from the original intent. Newly authored requests and
proofs still pass their strict input validators.
Voice provider Settings owners separate retained `parseStoredConfig` from
strict edit `parseConfig`; readiness and runtime readers consume the former.
Known credential identities, slots, references, modes and consent still require
validation. Unrecognized provider/version carriers remain opaque recovery data,
not silently accepted current configuration.

Action/request inputs, runtime events and wire results keep their strict
validators. Writers emit the current canonical shape, including when editing
an opened record. This changes additive-field read tolerance, not the persisted
format, storage-mode authority, access policy or supported version frontier.
Stored Plain Machine content uses the same projection at `machineStoredContent`:
an extra envelope field is ignored on read and dropped on re-encoding, while
required content, encryption-mode agreement and strict encoded writes remain enforced.
The generic Artifact header remains an open metadata custodian; kind-owned
readers project its known fields. Artifact body and private-revision readers
drop extras separately while retaining body, Artifact/revision binding and
encryption-mode checks. Source validation is not loaded-runtime certification.

Saved Home profiles read their retained connection descriptor through
`StoredHomeConnectionDescriptorV1Schema`, dropping additive fields recursively
while retaining identity, origin, revision and endpoint validation. Incoming
descriptors and feature responses remain strict. When a signed-in Home moves,
address admission confirms the saved and selected addresses before forwarding
the incumbent credential, then reads its exact authenticated descriptor at the selected
address and commits through the existing credential/profile adoption transaction;
public discovery alone cannot replace a retained descriptor generation.

### Live-stream relay diagnostics (development)

`capabilities.machines.liveStream.serverRouted` is an optional read projection.
Current relay policy caps are optional positive integers: `{}` means the Home
has configured no explicit limits, while `caps: null` means relay policy is
unavailable. Malformed diagnostics normalize at the Protocol capability owner
to `caps: null` and `disabledReason: 'relay_caps_missing'`; they cannot invalidate
Home identity or unrelated feature gates. Relay operations still require their
canonical feature and grant admission, and invalid caps never become an
uncapped policy. Authorization and stream wire schemas remain strict about
their known fields.

The inspected `../0.2` predecessor at
`4651997217a36250e203643f2bd002dbf7a93321` has no live-stream capability producer
or reader. Omission retains the existing disabled default. The earlier 0.3
required-cap reader was development-only; update managed server and daemon
support together rather than inventing policy limits to satisfy stale output.

### SCM native workspace observation (development)

`scm.workspace.watch.v1` adds a closed Machine request and response contract over
the existing cancellable parked RPC transport. A retained observation request
holds one shared native subscription per admitted directory; revision requests
return readiness or change facts without repository content. Unavailable replies
preserve the native error code and reason. Cancellation releases observation.
Machine admission and its filesystem policy remain the authority.

The wire operation is V1, independently of package SemVer. All request, result
and nested reason objects are closed; unknown fields and status variants reject.
No persisted format or protocol epoch changes. The clean scoped 0.2 predecessor
at `ead3f779118d6a3d17e167517a64660f9e2c2c0d` has no workspace watch operation in
`packages/protocol/src/rpc.ts` or `scm.ts`. A new UI receiving affirmative
`RPC_METHOD_NOT_FOUND` settles watch availability for that Machine through the
existing method-absence classifier. Watch absence does not publish an SCM read
error: Session and Project Git still load, manual refresh remains available and
the existing visible refresh fallback continues. Observation is not retried
during the retained presentation lifetime;
matching development Protocol, daemon and UI enable native observation. No
predecessor adapter, retry timer or new stream protocol is added.

### SCM status snapshot transport (development)

The current machine `scm.status.snapshot` RPC omits neutral per-entry facts:
zero line counts, false area/binary flags, and null rename origins directly at
the machine producer, before its existing shared request/cache publication. The
canonical working-snapshot schema supplies their defaults for validated reads;
there is no separate transport schema or encoder. UI RPC admission checks the
response envelope through its existing admission owner, and the existing snapshot
mapper restores defaults in its normal entry pass without an additional per-entry
schema parse. A neutral statistics object may be empty. Nonzero counts, rename
paths, both status columns, binary facts,
and explicit statistics-completeness flags remain intact; no changed paths are
truncated. The domain and plugin SDK working snapshot remains fully populated.
File/commit diffs and worktree enrichment keep their existing separate RPCs.

Full status responses remain valid inputs to the same schema and UI mapper. This development
transport changes no persisted repository or Session data. The one-way 0.3
component upgrade does not support an older UI reading sparse responses from a
new daemon; update the producer and its consumers together.

### SCM live diff review-unit discovery (development)

The existing `scm.diff.file` read response adds optional `reviewUnits` only for
successful reads with explicit `area: 'both'`. Its outer object remains
additive-open/drop; each unit is closed and carries the canonical opaque key,
hunk/run indices and old/new line coordinates. Existing responses without this
projection remain valid. Older open response readers may drop it safely; no
input, wire epoch, persistence format or mutation authority changes.

The host Action executor derives these units from `buildReviewUnits`, also used
by live Discard. Agents copy selected keys into the existing comparison entry's
`changeKeys`; the mutation owner still revalidates exact live membership. Captured
`changeRefs` and comparison identities retain their separate semantics. Omitted
diff areas keep the backend default rather than being relabeled as combined.
The clean scoped predecessor at `dac1efd68dee668d15c0c84fa5cacd29c15fb176`
has the open response without review units. This is unreleased 0.3 read-projection
behavior, with no compatibility adapter or new client update floor.

### SCM reviewed marks selectors (development)

The canonical `scm.diffSummary.reviewed.mark` and `.unmark` Actions retain the
implicit V1 saved-result selector (`cwd`, `resultId`, `changeRefs`). Files-only
reviews also use a closed V2 selector (`v: 2`, `cwd`, `comparisonId`, `source`,
optional Session namespace, and `changeRefs`); they do not require a generated
or saved narration. The same captured selector accepts exact `changeKeys`
instead of occurrence references, so Files Keep can select one review run
without marking neighboring runs in the same occurrence. V2 also accepts the explicit live selector `source` plus
`changeKeys` without a comparison id. That Action validates the keys against
the current working-tree diff, without capturing it. The selected
Home/Machine/root authority reads retained comparisons for occurrence selectors;
captured keys use that same evidence read and membership validation. Caller
comparison bytes are not authority. Unmark additionally accepts `reset: true`
with the V2 source selector and optional comparison id; a source without a
comparison id must be `workingTree`. Reset clears the stable scope, including
retained keys absent from the current evidence. Mark rejects reset, and reset
cannot be combined with keys or references. Session and turn sources additionally
retain their Session admission. All selectors use the same content-keyed Record
V1 `{ v: 1, scopeId, reviewedChangeKeys }` and
`workspace:scm-reviewed:scope:<encoded scopeId>` key. There is no parallel store
or RPC. Native UI Mark, Keep and Reset invoke these Actions through their bound
Session/Machine. An unavailable evidence host makes writes unavailable; retained
Account-KV marks can still be read. There is no local or queued write bypass.

Settings Clear composes saved-result deletion and personal-mark cleanup at its
shared Action owner. Only confirmed Machine deletion receipts authorize
cleanup of their comparison scopes through this same Account-KV owner. An
offline, refused or unconfirmed deletion supplies no cleanup authority. A mark
cleanup failure remains a partial result after deletion, retaining the deletion
receipt and an explicit retry through the existing host-validated unmark Reset
Action. The closed cleanup failure carries `reviewed_marks_cleanup_failed`,
`resultDeleted: true` and that strict Reset request. Retry still requires access
to the captured evidence; it does not infer authority from the deleted result.
The Account record and encryption envelope are unchanged; there is no
second store or deletion tombstone. These are unreleased 0.3 Action semantics; the moving
`../0.2` predecessor has no producer or reader for this Clear/mark contract.

Retained bare-turn capture and saved-result comparisons are qualified on read
from their stored Session/turn/receipt metadata by the capture source owner.
This is a projection, not a database or Account-KV backfill; comparison and
occurrence IDs remain unchanged. Ambiguous old bare-turn mark records are not
guessed into new scopes or deleted. PR reviewed scopes reuse the existing
comparison identity without endpoint or request-witness inputs. A witness refresh
does not change that scope; the request freshness key remains witness-sensitive.
Other reviewed scope keys are unchanged. This is unreleased development behavior.

V2 is an explicit operation epoch because the captured selector is an
authority-bearing input, not an ignorable optional field. A terminal supporting
only the strict saved-result form rejects V2 before an Account write; unaffected
operations and V1 remain usable. This is a development contract, not a claim
that a released terminal advertises V2. The captured-key and reset additions
remain closed requests: older strict readers refuse them before Account writes.
The inspected `../0.2` predecessor at
`21060ed08dc7c0b0ad5742dc7466143086f1a5eb` had no reviewed-marks producer or
reader in the Protocol, CLI SCM and UI Session Files paths, which were clean.
The earlier comparison-keyed 0.3 record was unreleased and is replaced in place;
it has no retained-data migration. Released-artifact support at this seam has
not been established. The released review-comment anchor union is unchanged:
terminal and transcript Ask use fenced composer text rather than a new anchor kind.

### Plugin projection invalidation (development)

The development daemon also carries optional
`daemonState.contributionRegistryProjectionRevision` through the existing Machine
content transport. It is a nonnegative integer for projection invalidation, not
Machine identity or execution authority. Running-state publication initializes an
absent revision; the existing plugin-registry publication bridge advances it.
Current UI readers accept retained states without it and use the existing generic
daemon-state-version invalidation for those states. Marked states use the specific
revision and daemon identity, so unrelated daemon-state publications remain cheap.
No Machine content codec, Account-mode decision or database schema changes.
The inspected clean `../0.2` state producer at
`3a0f38b9d5d1fd1a3debe7a2d140178b14aca0ac` omits this field; its retained states
remain readable. This is development-source behavior, not a claim of loaded or
released mixed-component certification.

### Home Services widget (unreleased 0.3)

The builtin descriptor owner adds `local_services_app`, an App-target Services
variant with no inputs. `local_services` keeps its required qualified Session
input and existing Workspace behavior. Both use the same Services row owner;
the App variant consumes the existing Machine-scope launcher and inventory
subscriptions for visible online Machines. That feed owns declaration, managed
lifetime and listener selection; the widget does not enumerate checkout scripts.
Home identifiers use the existing daemon-read target normalizer so equivalent
identifiers borrow the same subscription stores.
Offline Machines contribute an offline fact instead of retained service rows,
and scan failures retain their producer's diagnostic reason code.

Widget instance and definition-reference wire epoch V1 is unchanged, independently
of package SemVer. The instance, reference, bindings and qualified Session
reference remain closed; no optional routing input is introduced. The builtin
reference's existing nonempty string id admits an unknown identity for presentation
as unavailable, without executing it. Older 0.3 readers therefore keep the layout
and show `widget_type_unavailable` for this variant. Older strict authored builtin
declarations reject the unknown id through their existing unavailable-definition
path. The original Session id is never reinterpreted as an App read.

The inspected 0.2 frontier at `d27fd0a677c3f040a33664a963db75a7743dfbb0`
has no corresponding widget descriptor, instance or surface paths. This is an
unreleased catalog extension, with no migration, new wire epoch, dual writer or
reverse-development rollback adapter. Home default placement and empty/degraded
card composition are owned by the Home layout and Services presenter.

### Local-service Machine summary (development)

The optional `daemonState.localServices` field carries the Protocol-owned strict
`LocalServiceMachineSummaryV1` presentation union. Its V1 epoch is independent of
package SemVer. Each member is closed: `ready` carries the listening user-service
count; `unknown`, `error`, and `disabled` carry no count. Missing or malformed data
is unknown to consumers. The existing Machine content transport and Account-mode
encryption decision remain authoritative.

This safely ignorable optional projection changes neither Machine identity nor
authorization or mutation admission. The inspected `../0.2` predecessor at
`17ba05df68d4d3d4cad1c1241b58e63805db37ed` has no summary producer; old Machine
states remain valid and supply no count. New daemons reconstruct their projection
from the current inventory and republish through the existing Machine lifecycle,
without a persisted format migration or a parallel count writer.

### Plain Machine and credential predecessors (0.3 development)

The moving 0.2 predecessor writes plain Machine metadata/state as base64 JSON
`{t:'plain',v}` and the existing data-key carrier as base64 `{t:'plain',v:null}`.
Current 0.3 readers recognize that carrier as plain without a Machine database
mode column. Retained encrypted predecessor Machines on an already-plain Account
stay locked until the old key holder performs the existing whole-content
conversion described in [encryption.md](encryption.md). Neither case generates
replacement Account encryption material.

The canonical CLI credential reader accepts 0.2's explicit
`{token,encryption:null}` and its genuine legacy/data-key shapes; current 0.3
plain writes may omit `encryption`. Historical custody survives ordinary
same-Account refresh, while active provisioning follows authenticated Account
currentness. The all-component upgrade requires a fresh terminal/QR pairing link
for an in-flight predecessor request; it does not preserve the predecessor's
reader-negotiation decisions. The 0.2 Account-link QR carries the recipient public
key and reader support bit; its recipient secret exists only in the mounted
Restore QR view. A saved image of that link is therefore an in-flight pairing
request, not a recovery-key backup. Its additional applied auth-reader migration history
is retained by the existing SQLite deploy owner rather than copied into a second
0.3 pairing authority.

### Machine resources and Storage (0.3 development)

The development daemon retains minute history but no longer persists alert
suppression state. New history readers ignore retired alert/checkpoint rows in
the existing day files; minute records remain readable without a migration.
Restarting begins fresh alert episodes. Immutable CLI stable/preview
`cli-v0.2.17` / `cli-v0.2.17-preview.1`
(`a2c45c86804b24e60ac0b76146a3ef36dfcaa15b`) and the clean scoped moving
predecessor `fd3f03529d96e899e95c8b384f5843340a1339c6` have no corresponding
vitals/history or resources-policy paths. This is an unreleased-source
contraction, not a released rollback adapter or loaded mixed-version claim.

Guard Keep running retains its existing V1 request and response. The current
development Home admits Use; the daemon still applies the existing Session/PTY
warning-ownership check. A development Home retaining the prior custodian-only
route refuses a Use caller even with a newer daemon, and a daemon retaining the
prior custodian-only handler refuses that caller even with a newer Home. No role
promotion, retry fallback or compatibility shim is introduced. These are source
properties of the two admission gates, not a loaded mixed-version claim; Guard
policy, Session ceiling and Activity Undo remain custodian-only.

Machine Process checks may include optional `row` display facts from the same
authorized observation as the identity result. The existing strict Process and
non-Happier row schemas own these facts; Left-behind's owner is carried separately
by the check. Absent rows remain valid for older responses, missing/reused
identities and inaccessible work. The check envelope and nested identity/owner
objects remain closed. This refines the unreleased V1 read contract and requires
matching development consumers; it introduces no mutation operand, migration or
new cleanup authority. Proposal presentation must keep opaque refs as identity,
using row names/commands and the checked owner for user-facing text.

The transient V1 resource summary preserves the sampler's optional
`memory.pressureSource` (`kernel_level`, `psi`, `events`, or `none`) and
`cpu.load1`, rounded to two display decimals in its existing normalized units.
Optional `cpu.logicalCores` and `cpu.effectiveCores` come from the existing
transition-published host facts, never a second sampler or extra sample fields;
effective capacity remains fractional. Absent facts remain absent, including
load on Windows. Its CPU and memory presentation objects are additive-open/drop: readers accept omission without
inferring a source, drop unknown presentation fields, and strictly validate
known fields. The summary envelope, disk/network objects and series points
remain closed. The shared summary strip and full Memory tile use the same
localized provenance wording; samples and this value projection are not
published in `daemonState.resources`. This refines an unreleased 0.3 read
projection without changing its V1 epoch or package version. The inspected
0.2 predecessor at `b3e25a20bd6b8969e5a8b20b149c30d9705b591e` has no resource
summary or vitals module in the corresponding Protocol paths; no predecessor
writer or reverse compatibility adapter is introduced.

Storage is a new Machine RPC V1 epoch, independent of package SemVer. Current
contracts live in [`storageV1`](../packages/protocol/src/storage/storageV1.ts),
the [`Storage Action family`](../packages/protocol/src/actions/specs/storage.ts)
and the exact-Machine route policy. Its requests and mutation/identity envelopes
are strict; stored Pile and Trash readers discard unknown fields without coercing
invalid known identities. Presentation sizes and reasons accept and drop additive
fields. Pile refs, item checks, and staying refs optionally carry the canonical
catalog title; absent titles remain readable. Review/check presentation objects
drop unknown fields while nested identity and mutation envelopes remain strict.
Titles do not participate in cleanup authority or review tokens.

Pile reads retain `droppedSinceLastView` in the existing protected local state.
The existing `pile.set` mutation accepts optional `acknowledgeDropped` item ids;
Done acknowledges only those displayed drops across the Account's projections.
The response and persisted V1 shapes are unchanged. This input extends the closed,
unreleased Storage V1 contract: it requires matching development readers and
writers and is not silently ignorable by an older mutation handler. Immutable
`cli-v0.2.17` / `cli-v0.2.17-preview.1` (`a2c45c86804b24e60ac0b76146a3ef36dfcaa15b`)
and the clean scoped moving predecessor `177a7bf55c1a9437f9cf7dc24b8279047fef8a50`
have no Storage pile domain or wire contract. No migration, adapter or new
connection-wide update floor is needed.

Category reads use the Protocol's typed evidence vocabulary for display. Evidence is a skippable
presentation list: readers preserve known codes and the `recognizer:` / `manifest:`
namespaces, normalize unfamiliar string codes to `unknown`, and reject non-string
values. The UI supplies localized labels and a neutral unknown label; evidence
never grants cleanup authority. Opaque directory digests receive titles from their
owning Storage category rather than becoming display names. Category reads
can include exact `trashEntries` restoration metadata;
an entry id is not filesystem authority, and the daemon rechecks every effect.
Scan views additionally serve an optional `root` with the selected folder's facts,
independent of the paged children. The Storage service projects its protection
through the same owner as every child; List, Map and Rings consume these facts for
their headline and breadcrumb. Its absence remains readable on older answers.
Disk refs reuse the served `nodeId` as both `itemId` and path, including exact-byte
ids; invented item labels confer no authority. A rejected collection preserves
`storage_item_not_collectable` through RPC and Action output normalization.
Disk nodes now carry the Storage owner's required `verdict` and `collectable`
facts. List, Map and Rings consume them; protection and in-use display flags do
not reconstruct cleanup eligibility. Virtual rows retain their display exclusions,
and collection admission still belongs to Storage. This changes the closed,
unreleased 0.3 DiskNode V1 and retained scan-index projection in place: matching
Protocol, daemon and UI readers reload together, and earlier development scan
indexes require a new scan. No migration or compatibility adapter is added.
The inspected `../0.2` frontier `7b37d65ca75e58560f8f3ca850958ac5407d2e75`
has no Storage scan contract, including scoped staged and unstaged paths.

Guard, Processes, Vitals and Storage read adapters share the Machine daemon RPC
failure projection. They preserve the existing safe `errorCode` and
`failureCause`, including the failing phase, through Actions and parked watches;
their stores retain these diagnostics until recovery. Storage keeps its existing
policy, permission and approval presentation reasons at that adapter. This changes
no RPC failure vocabulary, admission, cancellation settlement or retry behavior.
Session-bound Storage tools default an omitted Machine target through the existing
Action contextual-default owner, while explicit targets remain explicit.
Accepted Storage operations use the transport's unbounded operation wait with
bounded connection setup. A consumed acknowledgement remains settled after caller
cancellation; uncertainty does not prove that no item moved.
Summary volumes can additionally report optional verified-Safe `canGoBytes`.
Readers accept its absence as unreported rather than zero; older presentation
readers drop this additive field. It conveys no cleanup authority and is omitted
from recipient summaries.
Storage summary presentation also accepts optional `suggestionsTotalCount`,
`suggestionsSafeTop`, `suggestionsSafeTotalCount` and `suggestionsSafeFreesBytes`.
Current producers send up to eight rows per mixed/Safe
preview (the largest bounded widget presentation), with the actor-filtered full count; `suggestions.list`
remains the full inventory read. Readers accept older unbounded arrays and an
omitted count as unreported coverage; older replies lack the dedicated Safe preview.
These additive-open/drop fields carry no
cleanup authority and do not change the Storage V1 epoch, stored data or
mutation/identity envelopes.
Summary volumes also accept optional `pileFreesBytes` and `trashFreesBytes` for
exclusive cleanup forecasts, independently of allocated `pileBytes`/`trashBytes`.
These are additive-open/drop presentation facts within Storage V1, with no authority
meaning. New UI readers omit a forecast when absent; older readers can discard the
fields. Temporary-directory Trash entries retain the existing owner-marker bytes
beside the payload; manifests and owner data keep their existing schemas. Entries
without a retained marker remain readable, but cannot recover a witness already
deleted by the former retirement path.
Development scan inputs remove client-supplied `drawableNodes` in place. Every
interactive, direct-folder relist and scheduled native scan consumes the protocol's
`STORAGE_CHART_MAX_DRAWABLE_NODES` export, also prescribed by the approved Map/Rings
culling contract; visual integration is separate from the runner's implementation.
Never-before-scanned present volumes need no prior client request to be scheduled.
This unreleased input does not acquire a compatibility alias or a separate headless
budget.

Scan progress is an additive-open/drop presentation object inside the closed
scan identity/target envelope. `progress.usedBytes` is optional: folder scans
omit the unknown denominator, while whole-volume scans retain measured zero.
The local index reader normalizes retained folder denominators before reads and
resume; current writers omit them. This is an unreleased Storage V1 correction,
not a second wire epoch or support for mixed 0.3 development intermediates.
The clean relevant paths in `../0.2` at
`3482a9101ebb7ee2983608ef0deb00831dfcb2e7` (2026-10-24) contain no Storage scan
producer, reader or UI surface; no predecessor adapter is required.

Settings extend the existing `metadata.resourcesPolicyV1.storage` section. Missing
sections receive current defaults through the stored reader; writes remain strict
minimal patches through the single daemon metadata-field CAS owner. Protected-folder
Actions use that same revisioned writer and return its conflict/current-policy
result. No second settings file or server copy of the scan index is introduced.
The index is a machine-local projection, with at most one current and one previous
complete database per present volume; opting out removes the owned scan databases. Pile refs
and self-describing Trash manifests remain protected local state, not published
Machine content. See [Storage ownership](cli-architecture.md#storage-sizing-pile-and-trash-03-development)
and [Machine encryption boundaries](encryption.md#machine-metadata--daemon-state).

The inspected clean predecessor at
`e087d15a2f0cce1de6de8ef0895d9c8bcc035056` has neither the Storage RPC/domain nor
the resources-policy module in these paths. These additions impose no new
connection-wide update floor or dual writers. On an otherwise compatible admitted
transport, unavailable Storage methods are an operation-scoped feature boundary;
unrelated operations keep their existing contracts. The independent encrypted
socket epoch below still applies. The resources-policy and local-manifest readers do not establish supported
rollback to a predecessor that never produced them. These are development-source
contracts, not released availability or mixed-version runtime certification.

### Encrypted socket RPC binding (v0.3 development)

Unreleased 0.3 `scm.workEvidence.read` carries one Machine's Session/workspace/turn
set in one encrypted request. Its public outer selector contains only Session
ids. Home uses the same admission owner as singleton SCM evidence reads, once
per unique Session, and replaces that selector with individual `session.write`
proofs or typed refusals. The daemon accepts that batch stamp only through its
authenticated Home ingress and checks each Session through `authorizeWorkSession`.
A refused or unlisted Session returns no witnesses while admitted siblings
continue. Native discovery is shared by resolved repository within the read;
Session/turn membership still scopes each witness. Existing singleton methods
keep their exact Session proof contract.

Matching Protocol, Home, CLI daemon and UI/native source must reload together.
An older daemon without this distinct method returns method unavailable; clients
do not fall back to per-Session evidence fan-out. This direct development cut adds
no persistence migration, wire epoch, capability negotiation, retry, timeout or
Session-count limit. The shared Usage collector and its CLI/UI adapters consume
the batch; other many-Session SCM evidence readers use the same dispatcher.

E2EE socket RPC uses the shared codec's V2 plaintext envelopes: requests bind
the complete target-prefixed method, caller-generated 128-bit call id and request
direction; responses bind that call id and response direction. Unbound encrypted
payloads are never accepted alongside V2. Current readers reject unbound,
malformed or mismatched envelopes with `RPC_UPDATE_REQUIRED`, including unbound
responses from an older daemon. A v0.3 responder refuses a 0.2 request before
handler dispatch; a 0.3 caller cannot trust a 0.2 response. All components must
upgrade together under the one-way 0.3 boundary. This is an intentional wire
epoch change, independent of package versions, and introduces no persisted state,
new key or negotiation. It does not prevent request replay. Plain-mode accounts
and reserved server-origin methods keep their existing contracts. See
[encryption.md](encryption.md#encrypted-socket-rpc-routing-v03-development).

The current development structured plugin Action ingress also requires
content-free `structuredMessageRouting` for encrypted requests, automatically
projected by `callSocketRpc`. Its required invocation kind makes mounted/client
binding claims consume `action.invoke` Manage at Home; host-presented Session kinds
retain Use. Home stamps its admitted Machine, invocation kind and Session selectors
in `machineAdmission`; the daemon binds them to the opened payload.
Action-read Resource watch opens use the same contract. Matching client, Home
and daemon development versions must be reloaded together: these fields carry
admission meaning and cannot be safely ignored. This extends the existing 0.3
development wire boundary without new persisted state, keys or negotiation.

Development requests may add optional `traceId` as transient diagnostic metadata
when the existing cancellation/signed `requestId` is absent. It is safely
ignorable: it carries no authority, cancellation, routing or result-custody
meaning. Home replaces it with target-local diagnostic correlation; missing or
malformed metadata does not change the operation. Existing authority envelopes
and their closed schemas are unchanged. This adds no wire epoch, persisted data,
mixed 0.2/0.3 stack support or rollback reader.

### Machine Session-log diagnostics (v0.3 development)

Machine diagnostics register and call `daemon.session.log.tail`; `session.log.tail`
is Session-only. The Machine operation retains its explicit log path, response and
path-safety rules. The existing `bugreport.getLogTail` has a different diagnostics
allow-list and response contract and is unchanged.

The standing one-way 0.2 → 0.3 ruling requires all components to update together,
with no rollback or 0.2/0.3 cross-component support. Only 0.2-created data must
remain usable. A released 0.2 UI or daemon using Machine-prefixed `session.log.tail`
against a 0.3 server is outside that boundary, so the server retains strict scope
enforcement without a legacy registration or routing exception. This rename changes
no persisted data, log contents or historical log reader.

### Saved agent-start policy (development)

`sessionAgentSpawnPolicyV1` retains the strict 0.2 V1 field set, including
`allowEnvironmentVariables`. Admission refuses explicit environment overrides
when that flag is false, including an empty environment object; omitted
environment overrides remain allowed. Profile-inherited environment remains governed by
profile selection. Settings reads strip unknown keys
and recover malformed fields independently through their field defaults; a bad
field cannot erase another field's deny rule. Durable approval evidence uses
`SessionAgentSpawnPolicyV1StrictSchema` and rejects malformed or unknown fields.
Account bounds failures reject the policy instead of replacing it with open defaults.

The development-only role and Agent-target allow-lists live in the separate Account
setting `sessionAgentStartAllowListsV1`. The host reads it into the admission context;
`admitAgentStartV1` remains the single decision owner. Null means unrestricted and
an empty list allows none in that selection family. The UI writes this setting
independently, so a current V1 policy remains readable by 0.2 strict readers.

### Android device CA trust (development)

Android native builds from development source opt into both the platform system
and user-installed CA stores through the Expo network-security configuration
plugin. HTTP and WebSocket clients retain platform certificate-chain and hostname
verification. The configuration consumes the same resolved cleartext setting as
Expo build properties because Android gives network-security configuration
precedence over the manifest's cleartext flag.

Older installed binaries retain their original trust policy; neither a server
update nor an OTA JavaScript update changes their native CA trust. A new native
Android build is required. This introduces no JavaScript/native API requirement
or relay protocol change, and does not change iOS, web, or desktop trust policy.
Published release availability and device-level TLS confirmation remain separate
from source validation.

### Android file actions native runtime (development)

The development UI's Android Save As, Open With, and Share actions require the
compiled `HappierFileActions` Expo module. The destination uses the fresh
`0.3.0-native` runtime train for non-publicdev lanes; publicdev retains Expo's
fingerprint policy. This train is distinct from the predecessor's native runtime
and must be paired with a new native build before publishing its updates. Do not
use a runtime maintenance override to send this JavaScript to a binary without
the module.

Workspace downloads and previews continue through the canonical prepared transfer
carrier; the port does not restore predecessor bulk-RPC probing or alter encrypted
transfer contracts and daemon-owned limits. Native cache files have independent
storage identities while Android receives the original display name. Failed or
canceled document copies remove the newly created destination; a provider that
refuses deletion produces an error identifying the remaining document. Web and
iOS keep their existing download actions.

### Native date/time picker availability (development)

An OTA update cannot add a compiled native module to an installed app. The
current UI package defaults non-publicdev Expo lanes to its configured
`happierExpoRuntimeVersion` train; publicdev defaults to fingerprint compatibility, and
explicit runtime overrides remain configuration-owned. A runtime match alone is
not evidence that the installed binary contains a newly added native SDK.

The shared `DateTimePickerPopover` native adapter owns the installed-capability
check before lazily loading `@react-native-community/datetimepicker`: the iOS
view registration, or all four Android bindings eagerly required by SDK 9.1.0.
`LocalDateTimeEditor` consumes that same decision and hides unavailable picker
buttons in both Session reminders and Temporary-computer package expiry. Manual
date/time editing and domain validation remain unchanged, including the reminder
modal's saved-reminder/preset-retry flow. Equipped binaries keep their native
picker; web retains its JavaScript picker.

This preserves older-native/new-JavaScript behavior only where the actual OTA
runtime admits that combination. It does not establish that a particular 0.2
binary is eligible for 0.3 updates. Remove the guard only when no supported
eligible binary can lack the SDK; delivering native modules still requires a
native app build.

### Native Doc passage selection (0.3 development)

Exact passage comments use the existing enriched-Markdown native menu event's
full `renderedText` snapshot, committed `sourceMarkdown` basis and UTF-16
selection range. A menu from a different rendered basis cannot supply mapping
evidence for the latest callback. The native dependency
patch and its generated event emitters must be included in a rebuilt iOS/Android
app; JavaScript or an OTA alone cannot add that payload to an installed binary.
Older native events without the full snapshot do not publish a whole-block or
quote-searched substitute; legacy text-only custom menu callbacks remain usable
without source-mapping evidence. The marked-text refinement data contract passes the
captured Markdown and a completion callback for the same native renderer and
source mapper; the visible refinement host remains a Doc UI handoff.
This is development behavior, not evidence that the host is composed, an
installed app has the patch, or native selection/accessibility release checks
have passed.

### Coach finding suppressions (0.3 development)

Coach dismissal and snooze Actions share the `workspace:usage-coach:suppressions` Account
JSON-KV record across UI and installed agent hosts. The existing Account-mode
cipher, version CAS and Home change stream own storage and delivery. Account
Settings retain only the deliberate `disabledChecks` and `modelSuggestion`
preferences. Account encryption-mode conversion inventories and rewrites the KV
record through its existing `workspace` inventory and transaction; an omitted
nonempty namespace refuses conversion. This namespace owns Account JSON records,
including SCM reviewed marks, without requiring a Workspace identity.

An absent KV record reads as empty. Historical dismissals and snoozes stored only
in 0.3 development Settings are not migrated; those findings may reappear once
and can be dismissed again. An existing KV record, including an empty one, is
authoritative. A conflicting edit reports the existing `version_mismatch`
outcome and can be retried. Coach preference edits no longer read or write
suppression state; their mutation schema still strips the empty compatibility
`suppressions` field from current Settings writes.

The scoped clean `../0.2` predecessor inspected at
`1321319f311da3d44931afd39eeac7252b6350a4` has no Coach preferences schema.
The existing Settings schema still reads stored suppression fields. Updated UI and installed hosts
must load together; no dual writer or older-development-client rollback is promised.

### Voice duration settings (0.3 development)

The canonical Local conversation and Local direct settings schemas accept
positive integer speech-request timeouts, retaining only the JavaScript timer
maximum of 2,147,483,647 milliseconds. Local conversation accepts positive
integer idle-agent TTLs in seconds without a Happier upper bound. There is no
protocol minimum of sixty seconds for idle TTLs or one thousand milliseconds
for speech requests.

The released `ui-web-v0.2.15` and `ui-mobile-v0.2.15` readers at
`88d45f33a5e5faf3235f621ee168a6f0ca58762d` admit idle TTLs of
60–21,600 seconds and speech-request timeouts of 1,000–60,000 milliseconds.
Their parser rejects an out-of-range Local adapter and retains its defaults.
On 2026-10-08 the maintainer explicitly approved longer values and removal of
unsupported lower bounds, accepting this older-client defaulting consequence.
Current readers still accept settings within the released ranges; current
writes preserve admitted values without a transition, shim or parallel policy.

### Voice settings and transcript memory (development)

The deliberate Account preference `voice.audibleWaitingCue` defaults to false
in unreleased 0.3 source. The existing Settings declaration and Action writer
own edits. When enabled, the lifecycle's transcribing/thinking phase starts
one finite audible cue on entry; phase departure, opt-out and disposal stop
it through the existing playback owner. There is no periodic cue timer or
inference from silence. This adds no recording, progress or install state to
Settings and requires no migration. The clean scoped 0.2 predecessor inspected
at `7a01417876753a916563b8df70cf25a6c563e2d8` has no cue preference; its
Voice parser can discard this additive choice on an older-client edit, after
which current readers return to the opt-out default. New Say/Stop Actions are
client-local operations discovered from the answering client's catalog;
older clients do not acquire speech support from a newer server.

Recorded Dictation failure recovery in 0.3 development retains the recording
only in the existing client controller and artifact cleanup owner. Retrying
uses the same recording and inserts editable text into the same live field;
it never sends that field. The additive mounted-field `dictation.retry`
Action retries a retained transcription failure, and existing `dictation.cancel`
discards it. Older clients cannot execute the new client-local operation;
existing operation inputs and results keep their schemas. Successful transcription, explicit disposal and the incumbent
field/Account cleanup retire the audio. This adds no persisted recording,
settings value, wire shape or mixed-version writer. The field recovery
composition and loaded-runtime validation remain separate integration work.

The existing Account `rootSessionPolicy` preference now selects `continue`
(default) or `new` for executable Voice conversations. Released
`ui-web-v0.2.19` (`63829e3cd6a8f1f48b10891af0c8b2313e51ac7e`) writes
`single|keep_warm`; both remain readable as `continue`, not fresh-conversation
requests. Current policy writes use the canonical values. Historical
`maxWarmRoots` input is discarded by the canonical parser; it has no default,
analytics field, portable setting or retirement/selection authority.
The clean scoped moving predecessor at
`fd3f03529d96e899e95c8b384f5843340a1339c6` retains that released shape
(rechecked 2026-10-29; relevant Voice paths clean).

Default Start reads the person's last executable Voice conversation from the
Account-scoped Session list, using its Voice marker and meaningful activity.
History Continue selects the row's exact Session address; explicit New uses an
ordinary Session creation-attempt key. Retry retains that admitted selection
independently of later preference edits. Session metadata owns target and
runtime facts. There is no device-local last-conversation pointer, recipe pool
or separate selection authority, and no reverse 0.2 writer guarantee.
Global native Voice keeps its exact Agent Session/thread. Direct native Voice
continues the person's Session without creating a carrier; direct-media
transcript History remains a separate non-executable substrate. Old
conversations and their Pending rows survive New and End, with cleanup only
through the existing approval-governed Pending Actions.

Voice Agent preferences retain the selected Agent id, exact target key and
qualified contribution identity. The unused selection-time
`agentProjectionGeneration` observation is no longer persisted in 0.3
development. Stored readers tolerate and drop that unknown field without
changing the selected Agent; this removes no 0.2-created selection contract.

The optional Voice Agent `connectedServices` choice uses the canonical V2
Connected Service binding schema. Predecessor adapter ingress preserves canonical
optional Agent choices its payload omits; an explicit `null` still selects native
authentication. Account Settings loads project retained formats locally without
rewriting the stored document. The next deliberate settings mutation performs
normalization through the existing write boundary, including retained cipher and
secret formats. Updated UI clients must reload to stop the former write-on-load
path; this does not require a daemon or server restart.

The Voice transcript reset boundary lives in the Account KV row
`voice:transcript-memory:v1`, through the existing mode-aware JSON/CAS owner.
Forget advances this boundary only when remembering conversations is enabled;
it applies to replay from every carrier in that Home/Account. Initialization
reads the same row for transcript stamps and replay requests. Run/resume metadata
clearing retains its existing bound-carrier scope, and ordinary Session history
is preserved. No Account preference is written by Forget.

The clean 0.2 predecessor at `420e78875b59a5d50169d31497853c447498f470`
writes `voice.adapters.local_conversation.agent.transcript.epoch`. That field
remains an inert retained source through unrelated preference edits and seeds
an absent memory row. An existing row is authoritative, including after later
resets; malformed memory fails closed. Current `voiceSettingsV1` preferences
contain only `transcript.persistenceMode`. The legacy source reader remains
until supported 0.2-created settings no longer need it; this is a one-way data
upgrade, with no mixed-version reset writer or rollback contract.

### Voice presence settings (development)

The device-local `voicePresenceContainer` chooses `top_bar`, `island`, or `orb`.
Missing or malformed values resolve through the existing local-settings parser to
the responsive default: Island on phones, Top bar otherwise. Container selection
does not change the admitted attempt, microphone, transcript, or Account-scoped
conversation settings.

The inspected clean `../0.2` Voice and local-settings owners at
`388915739e64655b454e0bee8198833a54e6eabc` retain Account `voice.ui.surfaceLocation`
(`sidebar`, `session`, `auto`) but have neither of the old orb booleans. Current
ingress still accepts that Account field; it is not the new placement authority.
The replaced `voiceOrbEnabled` and `voiceOrbExpanded` were 0.3-only choices, so
their removal does not create a predecessor-data migration or a second writer.

Private owner Voice bindings retain optional nullable `targetServerId` alongside
`targetSessionId`, matching the current Home-qualified Voice binding writer.
The strict owner envelope preserves that field; the shared projection does not
disclose the binding. The inspected current `../0.2`
`voice/sessionBinding/voiceConversationBindingMetadata.ts` writer omits the
field, and those bindings remain readable through the same current owner.
No new caller authority, persisted format, or old-component rollback path is
introduced.

### Native voice word segmentation (development)

Voice endpoint and client-owned interruption policy share one Unicode text
normalizer and meaningful-word owner. Browser word boundaries use
`Intl.Segmenter`; native boundaries come from the UI-local
`HappierTextSegmentation` module using Apple's `NLTokenizer` and Android ICU
`BreakIterator`. The bindings provide boundaries only: phrase matching, noise
filtering and the measured short-word backchannel gate remain JavaScript-owned.
Native dictionaries can differ around a word-count threshold; release QA checks
CJK and Thai short acknowledgements and multi-word turns on both platforms.

An eligible OTA update cannot add this module to an older installed binary.
Resolve native capability lazily when its word-gated voice path starts and
refuse missing capability through the existing visible
`provider_setup_required` failure, rather than weakening word gating or
failing app startup. Unrelated operations remain usable. This is current
development source, not evidence that a particular older binary admits the OTA
or that native release checks have passed.

### Native mode catalog projection (development)

`sessionModesV2` adds an explicitly unknown accepted current mode independently
of known available options. Its canonical Protocol reader accepts retained strict
`sessionModesV1` and `acpSessionModesV1` records, but a present malformed V2 record
cannot fall back to stale V1 state. One current-authorized publisher writes V2
and projects unchanged strict V1 only when accepted current is known. It does
not write null, sentinels or additional properties into V1, or treat desired mode
intent as accepted. Agent transitions clear all catalog generations together;
forks retain the same canonical facts without inventing a selection.

This is current 0.3 development metadata, not a new 0.2 reader obligation or a
mixed 0.2/0.3 coexistence promise. The supported one-way upgrade retains V1 data
and reads it through the same canonical owner. See [the catalog owner](agents-catalog.md)
for the native source and publication lifecycle.

### Terminal metadata projection (development)

The released `ui-web-v0.2.12` terminal reader at commit
`a357c65536ba89669422977d6f7daf9aa0d17e73` rejects `herdr` in both terminal
enums. Where an existing legacy flat-metadata flow reaches that reader, current
writes project the enum values to `plain` and carry Herdr through additive
`hostKind` and `requestedHostKind` properties. The shared Protocol terminal
owner immediately restores the canonical host and removes those recognized
selectors on read; opaque metadata fields survive the round trip.

This is a bounded terminal-field seam, not support for an older UI opening 0.3
Account-owned envelopes or participating in the all-component upgrade. Layout-1
writes retain their Account encryption and strict owner envelope. Its terminal
schema composes the same canonical known fields with the existing closed,
bounded policy rather than keeping a separate host enum or an unknown-field bag.
The pinned historical terminal reader fixture validates only the flat seam.

### Terminal workspace and RPC attribution (development)

Terminal byte-stream reads optionally request `holdForOutput: true`. The daemon
keeps an admitted, cancellable read pending until bytes, control frames, exit or
close wake the PTY owner. Unbounded RPCs have no idle timer; bounded RPCs reuse
the caller's deadline, retaining half its remaining budget for the reply. Credit
returns and reads without the option remain immediate. The successful response
echoes `holdForOutput: true` only to opted-in readers, preserving older strict
response readers. This is an additive development V1 extension with no persisted
format or SDK ABI change.

The UI carrier probes this option independently of `controlCursor`. A strict
predecessor's `terminal_invalid_request` retries without the hold option while
preserving control replay; a peer that ignores the option returns no echo. Both
cases retain the existing snapshot-read pacing. Only an explicit echo removes
that pacing. The inspected prior-development request at
`83dcfa74621521d33fce9ad4d2ce4080ef605d9b` is strict and has `controlCursor`
but no hold option; the moving 0.2 checkout at
`2b8fe93db6cb8ec2969f81e738a2f818a7dd8106` has no byte-stream protocol owner.
These are source compatibility observations, not predecessor-binary QA.

The development-only Machine terminal launch also accepts
`{kind:'service_shell',serviceId,expectedGeneration}`. The receiving terminal
owner uses its existing person identity and Machine custody admission, then the
managed-service owner resolves the exact retained generation into
`docker compose exec -it <service> /bin/sh`. The request cannot supply cwd,
Project/Session attribution, an initial command, or native launch context.
Session terminal workspace targets do not accept this Machine-only intent.

The existing host Action operation links the returned terminal id to native
effect custody while the shell session is active. Observed Docker-client exit
settles that session, including intentional Ctrl-P/Q detach; the receipt reports
`sessionEnded` and the known client exit facts, not an in-container process
exit. Missing local exit custody remains an uncertain outcome. Reconnect uses
the retained terminal id rather than admitting another generation by key.

The clean moving 0.2 `packages/protocol/src/daemonTerminal.ts` schema at
`4bcb930c0082304e4918284a4c18d2dcfe44ef1b` accepts only `session_attach` and
`happier_cli` launch arms. It rejects `service_shell` before execution. The
current UI maps that generic invalid-request response to the existing
operation-scoped `cli_update_required` result, with no shell-text fallback or
retry. This does not change ordinary terminal admission or finite service
command settlement, and is not native-platform or release certification.

The moving 0.2 terminal writer at `ae3773c7cd14a13296199f0a03846b243498a175`
can send `initialCommand`. The current shared Ensure/Restart parser accepts it
and immediately normalizes it to the typed `shell_command` launch, removing
the predecessor field. Simultaneous `launch` and `initialCommand` remain invalid;
current writes use only the typed shape. This reader seam shares ordinary
person-only admission, platform shell resolution and PTY ownership, rather than
retaining another executable launch path. The inspected predecessor terminal
schema, handler, PTY and UI writer were clean.

In the other direction, that 0.2 daemon rejects the new `package_script` arm.
The current UI maps its generic invalid-request response for that typed
operation to `cli_update_required` through the existing terminal error envelope
and update presentation. It does not negotiate, retry as free text, or mark
the Machine globally unsupported. Plain shell and `session_attach` requests
remain accepted by both readers; current-daemon Project refusals retain their
own cause. This is a development-source contract, not native or release
certification.

Ensure and Restart use the same terminal launch request schema, including optional
`sessionId` attribution. Current session controllers send it for either operation;
Restart can also retain the previous PTY's attribution when a caller omits it. The
request field supplies attribution after daemon state loss without introducing
durable terminal identity. Session-restricted RPC owners reject a different Session.

The inspected clean `../0.2` terminal RPC and Protocol owners at
`388915739e64655b454e0bee8198833a54e6eabc` accept extra launch-request fields but do
not consume this attribution. Current callers therefore remain accepted there,
without promising Other sessions discovery on that older daemon. The same
predecessor's Details and URL owners create only `terminal:embedded` with a
`{ kind: 'terminal' }` resource. The current workspace reader seeds that member
when predecessor workspace state is absent; an unresolved current instance is
unavailable rather than a request to create another shell.

The current device-local terminal member also accepts optional
`openCancelled: true`. Omission preserves the preceding open behavior; a decline
survives leaf replacement until explicit Open or Restart. The member, target,
approval reference and layout remain closed schemas. This development-only
presentation field changes neither terminal RPCs nor approval authority. The
clean moving predecessor at `f18aba940c5c56e5b24454e176c836c171098a2d`
has no `terminal/workspace.ts` member producer; its absent workspace continues
through the existing default-member reader. No reverse 0.3-to-0.2 layout writer
or migration is added.

Borrowed `terminal_view` members in current 0.3 development can retain the
actual accepted `workspace` address separately from the process `cwd`. Project
admission checks that exact address and its Project association; a nested cwd
does not replace the accepted root. Inline and docked Project output use the
same attachment-to-checkout resolver. The member and nested address stay closed.
Docking consumes the output Action's freshly authorized operation snapshot,
so an earlier UI projection cannot select another terminal or checkout.
No unknown field supplies routing authority. This is device-local presentation
state, not a terminal RPC or a new plugin launch API. The predecessor at
`f18aba940c5c56e5b24454e176c836c171098a2d`, rechecked on 2026-10-16, has no
`terminal/workspace.ts` producer or current Session terminal workspace owner.
Existing members without the optional address keep their prior admission path;
no reverse 0.3-to-0.2 workspace writer is supported.

### Terminal-host account settings (development)

The same released UI at `a357c65536ba89669422977d6f7daf9aa0d17e73`
strips unknown fields inside `sessionTmuxByMachineId` when echoing that map.
Non-tmux machine choices use the additive top-level
`sessionTerminalHostByMachineId` setting, which the legacy raw-baseline writeback
preserves. Protocol owns its schema and retained-shape normalization;
`terminalSettings.ts` owns the effective host for launch and presentation.
Modern edits patch that map and the legacy tmux projection together. None/tmux
choices retain the released boolean, session-name, isolation and temporary-path
semantics.

A released same-machine `useTmux: true` remains authoritative. Its false value
also accompanies non-tmux choices and cannot distinguish a repeated echo from
an intent to disable Herdr; older UIs do not gain Herdr controls. Protocol
normalizes the development-only nested `terminalHost` only when the new map is
absent, so an explicit new-map clear cannot revive it. Remove that development
reader once retained nested settings are no longer encountered. Immutable reset
keeps the canonical root absent and removes only its recognized nested aliases;
tmux options and unknown neighbors remain intact. After a lost write response,
the CLI confirms the reset only when replaying that same canonical mutation on
readback is unchanged. This seam
preserves retained settings shapes, not older-client access to 0.3 Account
envelopes or a mixed-version all-component upgrade.

### Current-Session presentation custody (development)

Current-Session presentation bind, acknowledgement, and retirement are
Session-owner-only RPCs. The Home stamps the authenticated Account and exact
socket connection onto the private forwarded authorization context; public
`clientId`, focus, and acknowledgement fields never establish custody. The
UI issues these connection-affine RPCs only through the active Home's persistent
socket: an active-socket pre-issuance failure is preserved, and an explicit
non-active Home fails closed instead of creating an ephemeral scoped socket. The
daemon accepts an acknowledgement or retirement only from the exact origin that
won the current process-local binding, and the Home retires that origin when its
socket disconnects. A mounted UI also retires the exact binding on unmount or
Account/Session-scope retirement. Rejected binds are read-only and do not clear
an incumbent command.

This contract is development-only and ephemeral: it adds no persisted binding,
lease, timer, generation, or compatibility registry. The inspected prospective
`../0.2` predecessor has no Current-Session presentation RPC, so there is no
older wire shape to retain; new callers fail closed when the method is absent.

### Organization standing snapshot readers (development)

The development `GET /v2/session-organization` accepts `projectionVersion=2`
from current readers and returns every requested attention standing. This changes
neither the persisted standing format nor the snapshot's `schemaVersion: 1`.
Without that declaration, snapshots containing at most 500 standings retain the
released representation. A requested standing snapshot above 500 returns HTTP 426
with `error: 'client-upgrade-required'` and
`requirement: { v: 1, kind: 'session-organization', minimumProtocolVersion: 2 }`.
Only that refresh requires an updated client: writes and reads that do not request
standings remain available. Rows are never truncated or deleted for compatibility.

The bound belongs to the strict reader released as `ui-web-v0.2.11`
(`98ea8fb76733b1dd785d38c31360179cafa84824`), not to current product capacity.
The HTTP adapter owns this projection check; organization queries and mutations
remain the single domain owners. Remove the legacy check only when support for
that released reader is explicitly retired. The inspected released server query
whitelist ignores the new query parameter; this does not expand the supported
old-Home directions of the one-way 0.3 transition.

### Browser request headers and CORS

The development change-feed cursor header is selected only when the requested
Home explicitly advertises `capabilities.changes.cursorHeaderVersion: 1`. Supported
older Homes retain `GET /v2/changes?after=...`; their CORS allowlists and ignored
unknown headers are not evidence of cursor-header support. Current servers
retain that query shape at the same page/auth/retention owner. A header response
must echo the requested cursor through an exposed response header before a new
reader accepts it, preventing an ignored cursor from becoming a successful page
from zero. See the [change-feed wire contract](protocol.md#session-changes-03-development-source).
This representation negotiation leaves the feed available on either wire shape;
it is not a feature-availability gate or an Account preference. Unknown versions
withdraw only the header representation. This changes no stored shape and adds
no POST read, probe cache or client floor.

A new browser request header changes both the endpoint contract and its CORS preflight contract. Before shipping one, test the new client against the exact supported predecessor relay and verify that every value in `Access-Control-Request-Headers` is already accepted by that relay's `Access-Control-Allow-Headers`. Adding the header to only the current relay's allowlist does not preserve new-client/old-relay compatibility: the browser rejects the request before the endpoint can negotiate or degrade it.

Prefer an existing CORS-safelisted header, a query parameter, or the request body for non-sensitive capability negotiation. Use a custom request header only when its semantics require one and supported predecessor relays already allow it or explicitly negotiate that support. Validate the real `OPTIONS` request for every reachable browser-origin/relay direction rather than relying only on same-process route tests. When browser code needs to read a new response header, include and verify the corresponding `Access-Control-Expose-Headers` contract as well.

### Self-hosted relay release checks

The public release profiles treat self-hosted relay upgrades as independent
component upgrades, not as a fleet migration protocol. For a stable release,
prioritize these directions:

- current UI, CLI, and daemon core flows against a supported older
  self-hosted relay;
- bounded core flows from a supported older client or daemon to the current
  relay, preserving unaffected operations and returning a typed update
  requirement only for an unsafe operation;
- persisted state written by the supported prior release read by current
  readers; and
- current-writer to supported old-reader only when rollback or coexistence
  can actually make that direction reachable.

The release agent derives the affected, reachable directions from the actual
diff and supported released baselines while it performs the initial release
inspection, before release-note/version materialization or a release commit.
That single inspection also owns the public-note proposal and validation
selection. After materialization, the agent only confirms that the final delta
contains the approved release inputs and no unexpected runtime-reachable
change; a full second analysis is required only when the source contract
changed. Exact scripts can prove named behaviors
against named artifacts—for example the published-server-v0.2.1 pending-queue
regressions or a `docker-release-assets` published-channel → local-build
upgrade—but none of them issues a general compatibility verdict. The Docker
upgrade suite runs in a normal profile only when the diff affects relay
storage/schema, startup/runtime dependencies, authentication persistence,
encryption storage, or upgrade behavior, the release changes the server, and a
supported published relay predecessor exists. A server version change alone is
insufficient. Broader installer, platform, and
historical-version exploration remains risk-selected deep certification.
Release orchestration does not wait for every
self-hosted process, impose a mandatory client floor, orchestrate a database
migration, or coordinate a global cutover.
If a concrete migration has a writer-drain or maintenance-window requirement,
its dedicated migration procedure owns that external operation.

### Connected personal metadata (development)

Qualified Connected Account V4 profiles add optional presentation `statusReason`,
sourced from credential health using the existing closed refresh-failure enum.
The profile, nested qualified identity and list envelopes remain closed; there
is no new union member, wire epoch, package version or persisted field. New
readers accept profiles without the field. The inspected scoped-clean moving
`../0.2` frontier at `2b8fe93db6cb8ec2969f81e738a2f818a7dd8106` has no V4
profile or V4 list client. Older strict 0.3 development V4 readers require matching
Protocol source; they cannot be described as ignoring unknown profile fields.
This follows the unpublished development cut, with no compatibility adapter or
change to released V2 profiles. The field is display evidence and never changes
credential selection, admission, retry or routing authority.

The same development profile optionally projects stored health
`lastRefreshFailureAt`, `lastRefreshSuccessAt` and `providerHttpStatus`, omitting
unknown observations. It retains the same closed envelopes and development
compatibility boundary described above. Reconnect diagnostics add optional typed
`diagnostics.reconnectCause` within the existing open, preserving scalar record;
the outer diagnostic envelope and error code stay unchanged. Older readers of
that record accept the extra key, and new readers accept its absence. The three
causes distinguish a missing credential, listed reauthentication requirement and
exact stored-health rejection without changing the refusal decision. No new
endpoint, persisted field, read path, compatibility adapter or wire epoch is added.

The inspected moving `../0.2` Settings definitions produce profile labels,
default-auth pool-adoption dismissals, exact global/per-Machine CLI warning
booleans and sparse account/pool-member disclosure keys. The development reader
qualifies those addresses against an admitted complete inventory; punctuation is
not an identity parser. The literal profile ID `default` and explicit false
values remain unchanged. Unknown or ambiguous addresses retain their source for
repair rather than becoming an empty successful import.

Labels and acknowledgements move into independent Account-mode catalogs;
disclosure moves only through the actual device-local persistence owner. A
present row or revision-retaining tombstone prevents reseeding from Settings or
history. Complete row proofs authorize only the corresponding history roots,
not caller-supplied root claims. Historical disclosure snapshots remain read-only
history, not live authority; the remaining retired-root restore cutover must prevent
their reinstatement. They do
not receive an unrelated Account-row proof or a new device-import ledger.
Pinned quota meters, quota strategies and genuine
default preferences remain with their existing owners. This is a development
source transition with consumer/restore activation and composed checks still being
integrated, not a new released-client compatibility floor or rollback guarantee.

### Connected Account pool option policy (development)

The strict V2 Account profile group and released predecessor reader remain
unchanged and carry no policy. Options derived from that projection report
`autoSwitch: null`, meaning unknown. The current qualified V4 group already
carries its required policy: Action inventory and default-authentication
suggestions read that authority directly, without an additional V3 request or
compatibility adapter. No wire, persisted group, or default-binding format changes.

### Connected Account Pool selection clock (development)

The qualified V4 group row owns the active member and its selection time together.
Every member change writes `state.activeSince: { accountId, atMs }` and the same
`state.lastSwitchAt` in the selection transaction, including automatic switches
and fallback after disabling or removing a member. Re-selecting the same member
keeps its time; runtime status writes cannot replace it. Clearing the active
member clears both timestamp fields.

The same selection transaction records the existing `state.lastSwitchReason`.
The closed V4 active-account mutation accepts an optional `switchReason`, using
the stored cause's string shape; omission means `manual`, including re-selecting
the same account. Runtime-state writes preserve recorded provenance. Disabling
or removing an active member records a manual replacement through this same
owner. No V3 switch header or legacy group transport is added on this line.

With priority strategy and `autoRestorePrimaryWhenReset` enabled, the canonical
candidate selector can restore the highest-priority eligible member ahead of
the active member from fresh healthy quota observed after an automatic limit
fallback, even while the first member remains exhausted and without a provider
reset time or surviving member failure marker. Restoration requires headroom
above the soft-switch threshold. Manual provenance prevents the override.
Older rows without provenance retain the landed-reset proof; unknown history is
not treated as an automatic fallback. Existing quota freshness and member
eligibility policies are unchanged.

`useQualifiedConnectedAccountGroups` exposes that identity-bound `activeSince`.
An older row without a matching identity-bound clock remains readable, but its
selection time is unknown: historical `lastSwitchAt` alone cannot label the
current member. This is the Pool selection time, not evidence that an existing
Session has hot-applied that account. The inspected clean `../0.2` group schema
at `17ba05df68d4d3d4cad1c1241b58e63805db37ed` has optional `lastSwitchAt` and no
`activeSince`; those persisted rows need no backfill or invented clock.

### Automatic pool quota-reset opt-in (development)

The shared V1 pool policy accepts optional `autoUseQuotaResetsWhenExhausted`;
absence means false and is not materialized on reads. Current qualified V4 pool
routes mask this field while `connectedServices.autoQuotaReset` or a dependency
is disabled. They preserve the saved choice, and policy edits merge against stored
policy so an edit from a masked reader cannot erase that choice. Re-enabling the
feature makes the stored choice effective on subsequent recovery reads.

The UI offers the opt-in only with the server feature bit and an applied Connected
Account descriptor declaring `recoveryCredits: { supported: true }`. The descriptor
fact is projected with the service; the runtime additionally requires the matching
recovery-credit facet. Missing facts fail closed.

The 0.2 source-line Accept-header adapter protects strict released V3 group readers.
It is not revived on this development line: pools use qualified V4 identities and
the retired V3 group endpoints are not a current transport. This change does not
establish rollback from development V4 storage or plugin descriptors to 0.2.
The locally available stable and preview predecessors `server-v0.2.11`,
`server-v0.2.11-preview.2`, `cli-v0.2.11`, and `cli-v0.2.11-preview.2` all
resolve to `98ea8fb76733b1dd785d38c31360179cafa84824`; their route, API, and
Connected Account schema trees have no qualified V4 group transport.

### Failed-request account attribution (0.3 development)

Runtime-auth classifications add optional `providerReportedOrganizationId` as
independent provider evidence. Explicit null means the organization is unproven;
absence preserves predecessor interpretation. Sanitization and the canonical
report-source projection retain this distinction through live reporting, outbox
replay and recovery-intent comparison. Current runtime registration does not
replace a captured failed credential tuple. Existing persisted intents remain
readable; missing history cannot reconstruct an identity already recorded
incorrectly.

The additive strict SDK observation event travels over the existing admitted
runtime daemon service operation `connected_account.identity.observe`. An older
daemon that cannot accept it leaves prior state unchanged; the host reports the
delivery failure with a default warning. The event grants neither switching nor
new-turn authority.

The moving 0.2 predecessor carries the same optional observation. On this line,
service keys remain qualified and the plugin request/native-transcript owners
produce the evidence; the predecessor's provider runtime architecture is not
restored. Codex's evolved request attribution stays unknown after an in-turn auth
change until a fresh request captures the new account.

Session group bindings add optional `appliedProfileId`. Current ingress preserves
it as observed account evidence for session labels. Missing values preserve the
existing pool presentation and Account default; `profileId` remains the fallback.
Desired auth-choice payloads and child selection projection omit the observation.
The field adds no selection authority, recovery version or database migration.

Member runtime state adds optional `lastFailureProviderLimitId` so fresh,
reliable positive quota evidence can be matched to the failed allowance after
the existing policy cooldown. Absence retains account-level matching; stale
observations cannot clear the blocker. Predictive soft-switch freshness is
unchanged.

### Claude pool native waiting preference (development)

The shared V1 pool policy adds optional `claudeCodeAutoContinueAtUsageLimit`;
absence means Happier-managed recovery. Qualified V4 pool readers use the existing
stored-read policy projection, which drops unknown additive policy fields for
predecessor readers. Current policy patches merge the persisted preference with
unrelated changes. The retired V3 routes remain retired; the 0.2
`happierClaudeCodeAutoContinueAtUsageLimit` reader-query negotiation is not
reintroduced into V4.

Claude's existing admitted selection environment carries the policy into its
plugin launch overlay before subprocess isolation removes selection metadata.
The preference changes newly launched pool processes only; individual accounts
and native login do not receive this override. No persisted-policy rewrite,
old-server database rollback guarantee or live mixed-version deployment check
is implied by the forward reader projection.

### Pool quota-limit selection (development)

`quotaLimitSelection` is optional in the shared V1 pool policy; absence and
`mode: 'all'` retain predecessor behavior. Qualified V4 readers and writers use
the same policy owner, and older 0.2 readers reach their released compatibility
projection rather than the V4 transport.

`windowDurationMs` is an optional additive quota-meter fact. Updated readers use
it for presentation and expiry-first pool ranking; older readers ignore it.
Pool-selected display projection filters only meters and
preserves account-, subscription-, freshness-, and recovery-credit fields.

Provider credits (Codex `credits`, Claude `extra_usage` or an in-band Claude
`overageStatus`) travel as an ordinary quota meter with `unit: 'credits'` and no
`details.limitCategory`; Codex adds the balance as `remaining` and the provider
verdict as `isExhausted`. No wire field or enum value is added. Readers classify it
with the protocol `isConnectedServiceQuotaCreditMeter` owner: it is never an included
allowance, every pool `quotaLimitSelection` keeps it, and an account whose included
usage allowances are spent stays usable (ranked after accounts with included quota)
while it has credit headroom. A provider usage-limit error remains authoritative.

Provider rejection codes (for example Claude's `rate_limit`) are not allowance
IDs. When the provider does not identify the exhausted allowance, recovery keeps
that identity unknown and uses the existing account-level recovery policy; only
an explicit allowance identity can be excluded by the pool selection.

The existing V1 runtime-auth recovery event's `cancelled` carrier also contains
terminal policy outcomes. Its existing `reason` distinguishes explicit
cancellation from recovery that stopped without an automatic retry. Current
readers use the shared protocol interpretation; no new event enum or persisted
recovery state is introduced. Primary-session failures remain visible even when
independently owned background runs continue.

Expiry-first is the development default for new or absent pool policies. Explicit
`least_limited`, `priority`, and `manual` choices remain unchanged. Among eligible
members with fresh headroom above the existing soft-switch threshold, the daemon
prefers the earliest future reset of the longest selected usage allowance or an
independently fresh subscription end with renewal off. Unknown durations use the
effective allowance; stale, missing, renewing, and passed dates add no preference.
Ties and inadequate-headroom recovery retain headroom then member-order ranking.
Healthy active members remain sticky; this does not schedule swaps or restart sessions.

Qualified V4 pools consume the canonical policy directly. The retired V3 routes
remain retired: the 0.2 old-reader strategy projection and authoring-support bit
are not added to V4. Runtime quota-store and Provider Account Usage projections
share one meter normalizer, while policy-specific allowance filtering remains
selector-owned. UI summaries describe the strategy rather than duplicating the
daemon's automatic ranking; explicit manual switch suggestions use member order.

### Provider Account subscription facets (development)

The canonical V1 sealed usage envelope retains the predecessor's optional separate
`subscription: { observedAtMs, ciphertext }` facet. The Protocol opener verifies
its record identity and observation binding; corrupt or wrong-key facets fail
closed, never fall back to plaintext. New E2EE quota writes use the canonical full
envelope sealer, not the base-ciphertext-only helper.

The daemon quota coordinator merges subscriptions through the shared
`mergeProviderAccountSubscription` owner, both after a cold V4 read and before
scalar or qualified writes. A quota-only refresh retains the last valid
subscription; a failed subscription refresh retains it with its refresh error.
Subscription changes participate in the existing material fingerprint so they
are not suppressed as unchanged quota data. Plain writes use the same semantic
merge; opaque server storage preserves the separate E2EE facet without opening
it. No parallel persistence format or subscription reader is introduced.

The development Connected Account SDK quota result now admits optional
`ProviderAccountSubscriptionV1`; its host result owner snapshots the trusted
in-process SDK result before the coordinator consumes it. External quota wire
remains strict. Stored usage readers project recognized fields before applying
the shared known-field checks.
Plugins omitting the field retain their quota behavior. This is a development
author-surface extension, not a predecessor SDK contract or a promise that an
older host accepts newly authored plugin results.

The development SDK quota-limit result also carries the consumed optional meter
facts (`windowDurationMs`, `modelId`, scope, labels, units and confidence).
Canonical PAU diagnostics are retained by the quota projection; their optional
`retryAtMs` describes the existing producer backoff, not another retry owner.
Readers accept retained snapshots without diagnostics or retry timing. The
qualified V4 development UI consumes producer error status alongside last-known
meters; bootstrap sources use `not_loaded` and do not assert a fresh observation.
No credential identity, runtime union or persisted record key changes.

In 0.3 development, the canonical usage write policy settles a refresh when a
provider observation or a recorded failure outcome is at or after its request.
Plain failure time derives from `error_last_known_good` diagnostics. The existing
non-strict sealed envelope carries optional `refreshErrorAt`, emitted by the
canonical sealer; strict write metadata and V4 read envelopes stay unchanged.
Opaque storage retains the newest observation ciphertext and its independent
failure clock. Reads expose producer status and the settled request marker;
opened failure snapshots retain safe diagnostics and retry guidance. Existing
snapshots without the optional clock remain readable. An older writer cannot
report that clock, and an older server may discard it, so such writes do not
promise failure settlement. No observation time is advanced to mimic success,
and no migration, new retry owner, or refresh-expiry lifecycle is introduced.

The development Usage insights quota read retains material accepted B snapshots
at the existing Provider Account Usage write owner. History is scoped to the
actual qualified record identity, paged over the caller's requested range, and
keeps the same plain/sealed envelope and separate subscription facet as current
B. Once the first actual accepted observation is retained, timestamp-only
refreshes do not manufacture additional usage samples. Existing retained
current records remain readable when their accepted history is not yet available;
readers must not invent a historical witness or join distinct credential records.
The existing [B Account-mode conversion lifecycle](encryption.md#provider-account-usage-history-03-development)
clears these records and their cascading history; this is not a historical
rewrap or a promise of continuity across mode conversion.

Development accounting page reads add `/v2/usage/query-batch`; scalar v2 and
retained v1 routes remain unchanged. The batch request, response, query clauses
and nested accounting envelopes are closed V1 objects. `includeContributions`
defaults to false and is interpreted only by the new operation, so an older
server cannot silently ignore the raw-delivery choice. A missing batch operation
settles as unsupported rather than issuing a scalar fan-out. CLI external-Action
proofs sign the actual selected path and request body: scalar for one accounting
read, batch for several primary/comparison reads. The existing Home purpose
owner admits both routes under the same Usage Action authority.
The UI negotiates NDJSON delivery of the same closed batch objects and validates
each delivered chunk. Native fetch without body streaming consumes those lines
from the same buffered response, never a second acquisition or scalar fallback.
The current development batch grammar additionally accepts `contributionQueries`:
its presence selects compact aggregate/pricing delivery, with raw detail only for
the named query subset. Optional `sessionQueries` requests distinct membership for
private evidence, not raw accounting. `contributionPages` makes detail continuation
explicit (`offset`, `totalCount`, nullable `nextOffset`); JSON readers can request
`contributionOffset`, while NDJSON completes the captured snapshot's pages in one
response. Omitting the new operand preserves the existing batch delivery choice;
the scalar grammar and external-Action proof grammar are unchanged. The matching current
Resource consumes both incumbent rich and compact responses. Because development
UI hot reload precedes independently loaded strict servers, the existing Usage
producer advertises the additive `features.usage.compactBatch.enabled` bit.
The API owner uses the captured Home's existing feature observation: strict true
sends compact; missing/disabled/unreadable support sends the exact incumbent
request grammar. No rejected-request retry or scalar fan-out is used. Remove
the old-shape path once no supported/development server lacks the bit, rather
than requiring a fleet-wide restart before the new client can load. Existing
strict `capabilities.server.usageAnalytics` children are unchanged. Private tariffs remain client-side;
typed grouped tariff operands feed the same exact decimal-integer arithmetic
owner as rich pricing. The 2026-10-31 orchestrator ruling authorizes correcting
prior IEEE summation-order boundary inconsistencies rather than preserving an
ordered-evidence exception. Existing observed report/invoice values are retained;
pricing no longer requires raw contribution detail. The later grouped producer
must be loaded before its support bit is advertised; an earlier compact-grammar
reload alone does not advertise support. Compact-only cost cells retain typed
selected-basis availability across JSON; legacy rich cost objects gain no new
field. Host-only `workProjection`, export `includeContributions` and
`includeComparison` operands are removed before accounting HTTP normalization.
The inspected `../0.2` predecessor at `7f4aae2c35ae3a3de626640d0078b43e69c80684`
has only the retained v1 query route; its relevant route file was clean.
This is an unreleased 0.3 operation, not a new global client update floor or a
claim of loaded-runtime availability. No persistence format changes.

The development `usage.query` result remains closed V1, independently of package
SemVer. Its slice optionally reports the closed delivery-only `incomplete` object:
`reason: 'response_size_limit'`, nonempty unique `omittedSections` (`work`,
`howYouWork`, `coach`) and `recovery: 'narrow_query'`. Unknown keys and section
values are rejected, not dropped. An omitted Work section also withdraws its raw
contributions and dependent merged summary; other admitted summary facts and
query identities remain intact. The projection reuses the existing complete
Action envelope budget without changing source/acquisition currentness.
Matching development readers consume this explicit omission instead of treating
it as complete evidence. Work allocations carry outcome/branch identities; full
contribution memberships occur once in their respective tables, avoiding
quadratic response growth. `workSummary` optionally retains `sessionCount`,
`contributionCount` and `allocatedContributionCount`, including when rich Work
is omitted. These counts describe admitted contributions, not unobserved history.
The matching strict 0.3 producer and readers must reload together for the narrowed
allocation shape; the inspected 0.2 predecessor has no such seam. There is no new request operand, persistence format,
SDK ABI, released-client floor or compatibility adapter. The scoped-clean 0.2
frontier above has no corresponding Usage Action result seam.

`connectedServices.quota.get` is a read, not a provider refresh. It opens current
and requested history under the captured Account encryption mode and projects
pace only from witnessed window duration, reset and utilization facts. Unknown
or incomparable evidence is explicit. Advisory targets do not enforce a spend
ceiling. Optional subscription monetary facts distinguish provider-observed
paid amounts from versioned, dated list prices; absence is not a zero cost or an
inferred payment.

In development UI source, a requested refresh does not start a follow-up quota
poll. Material writes publish the existing `provider-account-usage` Account key
and an additional `provider-account-usage-record:<recordId>` key in the same
transaction. The global row's advisory hint names its paired record. The Changes
Protocol leaf owns these identities and reads the consumed page's record scope;
coalesced record rows retain changes to several sources. A complete pair lets the
UI reread only sources admitted to those records, retaining the other sources.
A legacy/unscoped key, an incomplete pair, unknown scope, snapshot, foreground
or explicit recovery keeps the full reread. New UI with an old server therefore
retains its previous behavior; old UI with a new server still consumes the global
key. Replacing a source's record binding publishes the existing Connected Service
change fact so readers admitted to the previous record resolve the new binding.
This additive development contract changes no request/response envelope,
wire epoch or authority. A server reload is needed to publish the new identities.
The push invalidates the admitted read when the producer settles, including an unchanged-material write that clears
`refreshRequestedAt` without advancing the snapshot timestamp. Removing that
producer fact settles the local refresh indicator. The negotiated predecessor
quota transport retains a healthy re-read only for a positive producer-supplied
`staleAfterMs`, honoring that interval without a client floor. Zero or missing
means no healthy re-read; it does not become an immediate loop or a default
30-second timer. Ordinary acquisition failures retain last-known-good data and recover
through the same quota pushes, foregrounding or explicit refresh, with no local
error-backoff ladder. Presentation-aging deadlines remain separate from
acquisition and refresh completion.

In development page reads, the B owner derives `pageFacts` before returning to
the Usage Resource: all earlier-curve points and exclusions, witnessed reset
windows and the latest immutable reset witness. Together with current meters,
pace and ended-window results, these are the facts Plans consumes. Packed
observations remain in B's protected persisted document, rather than being
repeated in each Resource slice. Exact-history requests still return every
requested record. This is an undeployed 0.3 read-projection change; neither the
retained 0.2 record shape nor the protected document's encoding changes.

An exact-history client can drain its requested range through one captured quota
Action read. The client starts at the existing page
size, grows later pages by the accepted volume, and publishes current capacity
and accepted prefixes independently of entered-price and Pending metadata. It coalesces unchanged
material runs to their witnessed endpoints without dropping reset or entitlement
changes. A remaining cursor still marks partial history; failures retain that
prefix, while authority refusal retires it. This is an in-process read option,
not a new wire or persisted format: ordinary quota Actions retain one-page
semantics and exact witness reads remain unchanged.

The development V4 history operation also admits
`{ recordId, projection: { range, resolution: 'accepted_observations' } }`.
Its closed read result is `{ projection, complete }`; a missing materialization
is explicitly incomplete. One conditional demand GET returns that atomic result,
with `ETag`, `Cache-Control: private, no-cache` and `Vary: Authorization`.
Matching conditional reads return an empty 304 only after qualified source,
Account-mode and accepted-prefix admission. The validator includes demand
completion: a newly accepted tail changes it even when the protected prefix is
unchanged. A changed representation returns its body with 200. Explicit HEAD and
the separate `/history/document` ladder were undeployed 0.3 work and are removed
without a compatibility shim or a third confirmation GET.
The existing Account Resource retains its admitted B representation, validator
and opened/derived facts, shared across batches and retired with Account/credential
authority. The captured HTTP owner does not guarantee automatic 304-body replay;
this is the same retained B state, not a second cache or read authority. Stateless
or cold readers receive the full 200 result rather than inventing held coverage.
A reader can include content-free `heldProjection` coverage in the same demand
GET. The storage owner checks its count/frontier against accepted history and
returns `x-happier-usage-projection-prefix` for exact-tail reuse. Changed or removed
witnesses, range origins and Account modes still force full backfill or refusal.
Backdated changes during tail acquisition cannot inherit earlier completeness.
Backfill publication goes directly to the server prefix/CAS owner; no client
publish queue or parallel duplicate-write decision remains. A successful PUT
acknowledges the actual stored document's ETag, including equivalent reseals that
retain existing ciphertext. That stored-document acknowledgement is distinct from
the demand GET validator, which also covers completion. A locally sealed body
never borrows another writer's ciphertext validator. Browser preflights admit
`If-None-Match`; no timer, fallback route or replacement cache is added.
A qualified PUT to that same route accepts a closed
Account-mode protected projection with its record, range, accepted count and
frontier. The server admits only a complete accepted range and preserves other
record metadata. Clients open the protected content and validate its identity;
plain coverage metadata must also agree with its packed observations. The
`meter_readings_runs_v1` dictionary format separates meter definitions from
changing readings and groups consecutive equal material. Every immutable id and
exact clock delta remains, preserving irregular poll times and sample counts.
New projections omit historical per-fetch diagnostics. Current readings, exact pages
and immutable witnesses retain those diagnostics and their existing shapes.
No retention horizon or polling policy is introduced.
Existing records without this metadata remain readable and backfill on demand.
The current encoding marker is required on new development projection writes
and in the packed body. Stored reads tolerate a missing metadata hint: the
protected body's encoding determines whether it is current. Mode, authentication
and malformed-body failures do not become backfill. Superseded development bodies
have no compatibility decoder or special recovery classification. The plain/E2EE content
envelope, exact-history API and immutable reset witnesses are unchanged.
This is an undeployed 0.3 read materialization, not a predecessor writer, a second
allowance authority or a promise of reverse 0.2 process compatibility.

The development `connectedServices.subscription.price.set` Action sets or clears
an amount and currency for an exact qualified connected account. It uses normal
dangerous-write approval and captured Account-mode authority. The entered amount
is retained in the existing Connected personal metadata Account-row catalog and
composed as `enteredMonthlyPrice` into the exact-account quota read. It is labelled “you entered”
and remains separate from observed paid amounts and dated list prices. Provider
refreshes cannot erase it; unknown subscription periods still cannot produce a
period-qualified price or fit result. Entry requires an owned connected account,
not an accepted B record, and never creates a quota identity. Existing label and
price edits retain each other's facets; account cleanup removes both together.

Current-period monetary selection uses the witnessed subscription start and end,
effective/as-of dates, current subscription freshness, and matching tier/region
where the fact requires them. An unknown period or unmatched fact remains
unavailable. Subscription refreshes that omit a monetary observation retain
previous dated facts; those historical facts do not become the new period's price.
The canonical pace projection supplies its qualified observed curve and linear
depletion instant, so chart readers cannot requalify history independently.
Usage page money totals likewise preserve each kind and denomination separately,
with every contributing accounting source in the aggregate provenance.

U3 refreshed the moving predecessor's actual usage/subscription files at clean
`c03f1e9625ec924bfadde207eacd1b28530a8af0`: its strict separate facet has no
monetary facts, and remains a supported forward input. The immutable
CLI/Server v0.2.11 source (`98ea8fb76733b1dd785d38c31360179cafa84824`) has no
subscription facet at all. Neither basis establishes reverse old-process
consumption of new development writes; this extension adds no dual writer or
new mixed-host promise.

`connectedServices.pools.selection.get` reads the target daemon's own selector
decision and comparator order. It does not switch a credential, acquire a lease
or create a cross-pool value ranking. Existing UI summaries and explicit manual
switch intent remain presentation/authoring seams, not automatic selectors.

The unreleased 0.3 pool diagnostics preserve the selector's existing
`quota_probe_deferred`, `quota_evidence_unavailable`, and
`not_meaningfully_better` reasons through pool reads and launch errors. The
canonical selection schema owns this vocabulary for matching development
readers; this correction changes no persisted pool policy or state format.

The inspected clean `../0.2` usage paths at
`17ba05df68d4d3d4cad1c1241b58e63805db37ed` supply the separate-facet input contract;
development V4 qualified account transport is not a promise that older clients
can consume that transport.

### Model-entitlement pool disable opt-in (development)

`autoDisablePlanInvalidAccounts` is another optional V1 policy field whose
absence means false. Qualified V4 routes expose and accept it only while
`connectedServices.autoDisablePlanInvalid` and its fallback dependency are
enabled; masked policy edits preserve any stored choice. No 0.2 Accept-header
adapter is revived on this line.

The Codex plugin emits model-scoped `plan_invalid` evidence for explicit
ChatGPT-account unsupported, unavailable, or not-enabled model responses. The daemon records a 24-hour
per-model exclusion. When the pool opt-in is true it also disables that member;
manual re-enable clears the automatic-disable marker and runtime blockers.
Generic or provider-scoped `plan_invalid` evidence never triggers persistent
disable. Qualified V4 persists the marker, model cooldown, and disabled flag in
one member mutation guarded by both group generation and runtime-state revision.
For a finite Run's rejected initial input, the provider also attests that no
turn work was accepted. The Run's scoped materialization bridge validates the
exact activation, runner, member, generation, credential revision and model
before the existing pool coordinator records the exclusion and selects another
member. These rejected starts do not consume turn or hourly switch limits;
ordinary switches retain those limits. Exhaustion reports
`connected_service_run_model_unavailable` with the requested model. This is an
unreleased 0.3 source contract, not a change to the predecessor's daemon. Detached
Codex's canonical Run host now supplies bounded native-home reads and Run-scoped
refresh through the existing materialization control channel and shared daemon
authority. Focused and composed source checks do not establish loaded-daemon or
released availability.
The projected `ConnectedAccountUiProjectionEntryV1` contract is also absent from
that predecessor; its current strict development schema adds the optional
recovery-credit declaration together with its producer and UI consumer.

### Requester Machine bindings and work-summary preparation (development)

The development AccessKey migration changes only its Machine foreign key from
`(machineId, accountId)` to `Machine.id`. Existing requester/Session ownership,
tuple uniqueness, encrypted bytes and versions remain unchanged. SQLite and
PostgreSQL migration probes preserve predecessor rows; MySQL and retained-stack
deployment are separate outstanding validation, not established availability.
Foreign AccessKey admission still requires the shared Machine grant owner and
verified requester runtime channel.

The nullable `Session.runtimeMachineTarget` field retains the exact Home,
requester, Session, Machine and installation committed by the admitted publisher.
Closing that publisher preserves the placement; a later admitted publisher
replaces it in the existing publisher transaction. Predecessor rows have no
placement until an actual publisher establishes it. Stored readers drop unknown
fields, then recheck the original tuple, Home, installation and current Machine
access. Invalid or retired placement cannot select another AccessKey or adopt a
replacement installation. Cold pending input and Workflow origin delivery consume
this same fact; Session DTOs do not expose the internal placement. The additive
provider migrations and loaded-runtime journey require their own validation.

`MachineWorkSummaryV1` is a new strict read projection: `current` carries the
complete requester Account display identities and integer Session/task/terminal
counts; `unavailable` carries no inferred counts. Both object boundaries reject
unknown fields, including work identifiers and content. This is neither a
stored-data reader nor an inventory producer. Its Action, RPC and mounted UI
must consume the canonical live inventory and owner-or-Manage admission; the
schema alone does not make that operation available.

Mounted development work-summary readers refresh from the live inventory's
existing `subscribeFacts` publication. Its content-free `workSummaryChanged`
hint travels through `machine-alive` → `machine-work-summary-changed`;
ordinary heartbeats carry no work invalidation. Only a mounted exact-Machine
summary subscriber reads in response, and a fact received during a pending read
causes one trailing read. Counts and requester identities remain in the admitted
summary response, never in presence, Machine content or a persisted counter.
Older readers safely ignore the separate ephemeral; older producers omit it,
leaving explicit refresh and connection/access recovery available.

The development-only, server-origin Machine access-loss RPC also reads a private
requester census from that same live inventory on publisher reconnect. Its closed
requester-census arm returns Account ids and explicit coverage, without work ids
or content. The Home unions those subjects with existing AccessKey bindings and
rechecks current effective access before invoking the incumbent cleanup owners.
The census completes under its admitted installation pin even if the installation
changes during the read; the next request must pass admission again. Missing
census support or unknown coverage remains observably incomplete. Access-loss
cleanup closes interactive terminals, not admitted finite work or Project
services. A requester Session finishes its admitted turn, then a refused
reconnect ends its runner rather than retrying forever. Physical exit, including
Stop, retains that requester's private credential file so the Session remains
resumable. A later recovery that receives a definite authorization refusal, or
a Session deletion observed by the daemon's existing deletion subscription,
retires only that Session's requester file through the existing custody owner.
A cancelled recovery or unavailable Home retains the file. Existing full-loss
cleanup requests keep their shape. The closed,
development-only V1 request also accepts optional `remainingRole: 'use'` for
Manage withdrawal: only Machine-custody interactive terminals close, without
retiring the member identity or Project/Session Use terminals. This lifecycle
operand cannot be ignored safely; matching development Home/daemon readers are
required, and older strict readers reject it. No wire epoch, persistence format,
timer, poll, grant lookup or reverse-development adapter is added. The scoped-clean
moving 0.2 predecessor at `e8c78c5bf96b5b2c207d86312f179d43332f45e3` has no
access-loss custody schema/dispatch in these paths. Retained Session history is
unchanged.

The installed development terminal runtime consumes C42's admitted original
requester Account ports for accepted Project shells and exact own local Session
workspace reads. Current Machine Use does not grant access to another requester's
terminal or Session. Each operation retains requester attribution and current
custody; no Agent or custodian credential is manufactured. This replaces the
unreleased blanket custodian-only terminal classification, not the separate
signed finite Project-script original-caller guard.

Execution Run preparation, active budget custody, visibility markers, private
retained lifecycle records and pending terminal delivery preserve the admitted
`RequesterWorkAttributionV1` tuple. Automation claim and Workflow coordinator
custody carry their captured host admission through the same live inventory.
Session-owned Run starts consume exact protected child custody, or an ordinary
accepted Session marker with the current process generation and command hash.
The extra decoded credential annotation is immutable, nonenumerable and never
part of the persisted credential codec. Private Action options carry admitted
Workflow attribution only across the existing in-process host seam; a public
request or Session metadata cannot provide it.

Detached Workflow steps with Connected Services borrow the live controller's
admitted requester bootstrap. The runner identity owner still binds the sealed
Run to its daemon PID/start generation, server, Machine and installation; an
ordinary detached Run cannot borrow Workflow custody. Credential resolution,
purpose activation, generation reads and recovery use the guest Account's
existing owners and private directories. Qualified generation reads use the V4
metadata owner, including plugin services omitted by the legacy V2 projection.
Releasing a materialization context leaves the Run-owned bootstrap alive until
the Workflow settles. This correction is daemon-local: it adds no wire or
persisted format and requires only a daemon reload.

These optional fields do not upgrade legacy work: missing attribution or
conflicting active observations make the summary unavailable rather than hiding
that work behind an attributed duplicate. Current public Run projections omit
the host-local field; stored readers tolerate its absence and unknown fields.
The inspected `../0.2` marker reader retains unknown fields through its
passthrough schema, so its local marker read is not claimed to strip this
nonsecret tuple. The private retained lifecycle format has no corresponding
predecessor reader. Neither format grants runtime authority or changes Run
placement, and source-level coverage alone does not establish a loaded journey.

### Account display names (development)

Undeployed 0.3 stores one nullable `Account.name`. The additive PostgreSQL,
SQLite and MySQL migration backfills it from trimmed legacy first/last columns;
those columns remain read-compatibility data. Current profile writers use only
the canonical name. An explicit null clears it and must not resurrect stale
legacy columns. Readers of a released profile with no `name` field may join its
legacy first/last fields at the Protocol compatibility boundary.

The 0.2 Account-profile reader is passthrough, while released social and direct
sharing readers require first/last fields. Current producers therefore retain
both fields, projecting the complete chosen name into `firstName` and null into
`lastName`. This preserves nicknames and multi-part names without guessing their
structure. The strict new self-name mutation accepts no Account id and adds no
new name-length limit. Protocol owns the name → username → null label rule for
both server and UI; Account ids are not display fallbacks.

Home People ordering belongs to `listHomeAccountsInTx`: owners, then admins,
then members; named rows precede unnamed rows within each role. The keyset
captures `(roleRank, unnamedFlag, sortKey, accountId)`. Provider-native SQL folds
the name (or trimmed username fallback) and retains its first 32 Unicode code
points for sorting; the Account id breaks ties. This is sort precision required
by the unchanged 512-character cursor ceiling, not a name-length limit. Ordering
and continuation use the same provider-specific SQL expression and bytewise
comparison. A renamed row may cross the captured boundary or recur; unchanged
rows remain complete even when the boundary Account is renamed or deleted.
This replaces the unshipped creation-time cursor in place with a new query
binding, without retaining that intermediate ordering or adding a second codec.

The development Home Account list response carries optional `total`: all Home
Accounts before pagination, including suspended and disabled Accounts, counted
in the same transaction as the page. Overview uses this exact people total;
answers without it retain the loaded-row count and `+` while more pages remain.
This extends the undeployed V1 read response without changing cursor semantics.

### Direct sharing and Account erasure (development)

Self-erasure and Home administration share the closed Account deletion result:
`deleted` confirms physical completion; `disabled_pending_completion` confirms
retirement and credential revocation while physical deletion remains unconfirmed.
The erasure owner refuses with `account_erasure_upload_pending` before
retirement while private upload IO is outstanding. Both routes relay this as
HTTP 409 without disabling the Account, revoking credentials or signing out the
self-eraser. After retirement, blob deletion or retained-locator mismatch returns
`disabled_pending_completion` from that same owner; routes do not infer retirement
from error codes. The existing encryption-cleanup refusal stays distinct.
A typed database failure in the final deletion transaction preserves that partial
result after the retirement transaction committed. Revocation is immediate. An
active Home owner resumes cleanup through `home.accounts.delete` for the same
Account; repeating completed deletion returns `deleted`. Recovery-key sign-in
does not reactivate a disabled Account. No worker, timer or automatic retry is added.
If a managed resource is reported after retirement, the same partial result
preserves its custody. The next Home-owner request reviews its current resource
identity before erasure can continue; preflight review retains its full resource list.
The existing status-only retirement receipt admits these results for
`account.delete` and `home.accounts.delete`, so a Home owner deleting their own
Account can receive the acknowledgement without disclosing old Account data.

This is an unreleased development-contract cut: matching Server, Protocol and UI
readers reload together. The prior strict self-erasure response rejects the partial
status; the scoped-clean `../0.2` frontier at
`afd83d1e5bc594c624f6caa9546028b74a75de54` has no corresponding self-erasure
endpoint or result schema. No persisted format, migration, wire epoch or adapter
is introduced.

The development Account-erasure transaction preserves direct grants that the erased
Account authored on somebody else's Session. The canonical grant service reassigns
their non-null `SessionShare.sharedByUserId` to that Session's owner, preserving the
grant identity, access level, permission delegation, key envelope, and creation time.
This field is current compatibility provenance, not immutable audit history or access
authority. Existing direct-share readers continue to receive a real Account profile.
Received grants are removed, and owned Sessions use the ordinary recipient-aware
deletion lifecycle. Direct and public access logs retain their existing policies:
erasure removes logs identifying the erased Account, and deleting a share cascades
its logs; logs for surviving shares and other Accounts remain subject to normal
retention.

### Session access projection normalization (development)

Retained 0.2 public Session links keep their legacy token and wrapped-key
derivation. Flat layout-0 metadata is not recipient-safe: anonymous reads return
typed `metadata_privacy_upgrade_required`, never the raw flat metadata. On the
owner's initial 0.3 visit, authenticated owner-only discovery includes pending
shared Sessions outside the active list, and the existing currentness-checked
metadata tuple writer upgrades them. The same link then reads the recipient-safe
projection. The pending viewer asks the owner to open Happier; it does not treat
the privacy refusal as revocation or silently weaken the projection. This is a
retained-data upgrade direction, not a new old-server fallback or rollback claim.

Current Session readers treat a valid strict `effectiveAccess.v = 1` projection as
the sole access presentation authority. A present but malformed current projection
is unavailable and cannot fall through to released owner/direct inference. Only
true absence of `effectiveAccess` permits the released `share` translation; that
translation never represents Team- or Group-only access.

That rule has one implementation: `readSessionAccessProjectionRoleV1` in
`packages/protocol/src/sessions/access/sessionEffectiveAccessV1.ts`, which maps a Session
record to `owner`, `recipient`, or `unavailable`. It is representation normalization only
and never decides authorization. A record with neither field is treated as released owner
content when `metadataLayoutVersion` is absent or `0`, and as unavailable otherwise, so a
newer layout a reader does not understand fails closed instead of being read as ownership.
Persistence keeps the same separation the projection does: `SessionShare` is the direct
grant table only, while `SessionTeamGrant` and `SessionGroupGrant` hold collective grants
that a released reader never sees — see
[session-collaboration.md](session-collaboration.md).

The UI preserves the same distinction through hydration, access events, Voice,
encryption migration/key resolution, and reconnect state. Its additive warm-cache
field stores the current effective projection, or `null` for malformed-current
unavailability. Older cache entries without that field remain readable through the
released flattened fallback. Released direct-share events may refresh a normalized
legacy projection only when it has no current `sources`; they never replace a
sourced current projection or the fail-closed `null` marker.

Current development by-ID hydration reads prior full rows and admitted publication
only from the requested Home. A retained row with the same Session id on another
Home is not prior state for that request; each Home retains its own list row.
Account lifetime, encryption generation, and the by-ID Home/mode checks still
reject stale responses.

Server-side, the released owner/direct seam and the version-qualified current seam
are two presentations of one access decision, not two admissions. Released
unqualified V2 lists and unqualified by-ID detail leave Team and Group grants out
of the answer, but they resolve through the same
`resolveSessionAccessForOperation` owner, so omitting `accessProjectionVersion`
cannot widen a credential: a verified Session-scoped Runner principal stays a
capped `edit` recipient with no owner metadata on both projections, and its
persisted activation/Machine/AccessKey binding is revalidated on both. The
released branch passes the row it already loaded to that owner rather than
projecting access itself.

The prospective `../0.2` predecessor inspected at
`ac30c50856abd2265c14459e77ee3384da1698ad` (branch `dev`, clean) in the relevant CLI/UI
Session-detail consumers:
`apps/cli/src/session/transport/http/sessionsHttp.ts`,
`apps/ui/sources/sync/engine/sessions/sessionById.ts`, and
`apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope.ts`.
The committed Account/client encryption requirements do not change listing
or access-projection behavior. The predecessor still has no `effectiveAccess`
producer or consumer and no ephemeral Runner. Its `V2SessionRecordSchema` and
`SessionSummarySchema` remain `.passthrough()`, so current additive projection
fields are accepted. The former direction "a 0.3 client against a 0.2 Home", which the
server-only `sessions.collaboration` decision and a UI direct-only legacy share adapter
served, is not supported under the one-way 0.3 upgrade (every component updates to 0.3
together, no rollback); that bit, its `HAPPIER_FEATURE_SESSIONS_COLLABORATION__ENABLED`
switch and the adapter were removed on 2026-09-24. Current clients select the
version-qualified projection, Team/Group grants and initial access from the exact Home's
`sharing.session` decision. The surviving obligation is data: direct shares a 0.2 Home
persisted in `SessionShare` remain effective and readable in 0.3 through the same
access evaluator, independently of that decision.

### Session draft rollout

The current development UI stores browser draft repositories and pending-message outboxes in
IndexedDB, outside Web Storage's small synchronous quota. Native clients retain MMKV. Browser
startup prepares drafts before restoring Sync or rendering draft consumers; a failed preparation
uses the existing app recovery boundary rather than treating saved drafts as absent.

The 0.3 development draft repository stores one local record per draft, keyed
`<scope record key>/<canonical draft address>`, so an edit rewrites only its own draft and
autosave cost does not grow with the number of drafts an Account holds. The scope record itself
keeps only opaque envelope fields (`v: 3`, such as 0.2's `ordinaryEntryDraftId`) and is absent when
there are none. Each draft record uses the compact v2 replica form: equal base/local documents and
pending fields are stored once and reconstructed on read; independent conflict values are retained.
A whole-scope `v: 1`/`v: 2` record written by 0.2 or an earlier build is moved into per-draft
records on first read, with each draft's bytes unchanged and envelope fields kept; browser startup
does this in one IndexedDB transaction per scope, and native/in-memory storage on first scope load.
Migration refuses, per scope, when an existing draft record differs from the copy being migrated
or a record could not be read in the same transaction: nothing is overwritten, both copies stay
stored, that scope alone reads as unreadable retained custody, and the app still starts. This does
not change the synchronized draft document or server wire format.

0.2 cannot read the per-draft layout. On a browser origin whose drafts 0.3 has migrated, a 0.2 tab
that reloads cannot start: its startup refuses the per-draft and `v: 3` records and goes to app
recovery. A 0.2 tab that is still open fails closed on draft saves, and its unsaved edits stay only in
memory. No stored data is destroyed in either case.

Legacy browser values are removed only after their IndexedDB transaction commits. Migration
preserves conflicting copies and reports a failure instead of silently choosing one. Reload older
open tabs when updating the UI so they stop writing the retired Web Storage records. Concurrent
editing from an unupgraded tab during migration is not supported: old Web Storage writers cannot
participate in IndexedDB transactions. Browser
outbox operations await local transaction completion before reporting local custody; enqueue
acknowledgements cannot retire a concurrently recorded cancellation.

Draft autosaves retain failed writes in memory, expose the existing error status, and retry through
the repository's flush owner. One autosave commits its changed draft records in one IndexedDB
transaction; drafts written by another tab are untouched, and a change to a draft that another tab
changed since this tab last read it is rejected (both copies preserved) and commits nothing. IndexedDB still has browser/disk limits:
an error is not permission to discard drafts or pending messages, and unsaved in-memory edits must
be preserved before reloading. These device-local stores are not substitutes for server acknowledgement.

Synchronized Session drafts are negotiated through the `sessions.drafts` server feature bit. A new
client fails closed when that bit or the typed routes are unavailable and retains the incumbent
local-only behavior; it does not send draft records through generic Account KV routes. A capable
server reserves the draft KV prefix so old generic-KV clients cannot read or overwrite typed draft
rows.

In 0.3 development source, unsent child-conversation, Plan, Review and Delegate launchers use that
same repository. Their text, references, attachments and explicit launch selection occupy separate
`happier` extension fields on the parent Session draft, keyed by launch intent and role or Discussion origin.
The parent's message composer remains independent. Reload restores the saved launcher identity and
choice, including when hydration finishes after mount; accepted submission clears only its captured
fields, preserving edits made while admission was pending. These fields use the existing draft
envelope and encryption/CAS owners. Loaded UI validation remains separate from source availability.

Development V2 draft operations use the same repository, physical rows and CAS while preserving
strict V1 reads, writes, conflicts, cursors and events. V2-only Run/discussion and Project Open
addresses, plus successor new-Session content, use the distinct V2 socket and AccountChange hint schemas. Current
clients materialize their exact addresses before advancing the change cursor. Account encryption
transitions opt into the V2 draft directive when captured Account-owned content needs it;
older strict servers reject that directive before mutation. The
[Account transition contract](./encryption.md#account-mode-transition-status) owns resealing and
replay; Session-bound drafts never participate solely because their address uses V2.

New Discussion V2 addresses may carry an optional UUID `draftId`, serialized as
`new-discussion/<draftId>`. The unkeyed `new-discussion` address retains the ordinary
New Discussion draft. Keyed drafts use the same rows, encryption, CAS and Account-mode
transition owner; they do not alias or replace the retained singleton. The key is
closed identity data: an unavailable V2 operation retains the keyed local draft and
must never retry it as an unkeyed write. This is part of the one-way development
upgrade below, not a new V1 address or mixed-version coexistence contract.

Development Discussion V2 documents also retain an optional, nullable `replyTarget`
field with the existing field mutation identity and closed Discussion reply-target
schema. Missing fields read as no deliberate Reply. Navigation focus is never
converted into this field. Current writes, reload and captured-field clearing use
the same private payload, encryption and CAS owners; released V1 documents and
addresses are unchanged. This follows the one-way 0.3 development upgrade, without
an old/new draft writer pair or a rollback promise.

New-Session V2 authoring retains the title, creation identity, explicit memory choice and qualified
prompt stack in the canonical synchronized field catalog. Another client can therefore reopen a
Bot or Ask Happier draft with those choices. Existing 0.3 device-local copies are read only when
the corresponding canonical field is absent; a canonical clear wins. The next authoring edit
writes the recovered values through the catalog and removes their local copies. Device-local
unsaved Instructions editor content stays local. A draft whose original client never synchronized
its identity or prompt references cannot recover them from its text alone. These are development
V2 fields; the released V1 projection remains unchanged.

Development Project Open drafts use `project-open/<draftId>` through the existing draft
repository, reserved KV prefix, field mutation identities and revision CAS. Their V2 document
retains unfinished selections separately from strict submitted Open inputs, uncertain inputs
and acknowledged/retired outcomes. It has no Composer or Session binding. This address/document
cannot be projected into V1 or a synthetic new-Session draft. An unavailable typed draft route
does not authorize an Open effect with an unretained intent. The retained draft does not replace
Machine acknowledgement or prove filesystem effects, setup completion or exclusive checkout custody.

### Automation predecessor data (development)

The 0.3 development line updates server, daemon and clients together, without rollback.
Undeployed 0.3 snapshots and earlier recipe spellings are not compatibility contracts.
Current Automation transports use V3 directly; there is no V2 route, API-epoch probe,
representability adapter or older-component update-required fallback. This does not
remove the canonical Automation feature gate or Account authorization.

The strict V3 definition query accepts an explicit `details: true` private-page
request. Its request, selection and response envelopes are closed; existing
definition and stored-content readers retain their current policies. The page
bound and cursor ordering are unchanged. Normal list
requests still return public summaries. The matching development server must
admit private detail demand explicitly: unsupported or malformed requests fail
the existing typed read path and never fall back to per-row or unrestricted
reads. Released stable/preview V2 clients and the moving 0.2 predecessor have
no V3 private-page consumer; their retained definition bytes keep the existing
conversion/read owner. No persisted format, SDK epoch, migration, client update
floor or reverse-development adapter is introduced.

The current V3 definition also has an explicit `observationOnly` arm for Event
enrollment. It has no execution recipe or execution assignments. The existing
Definition stores its strict marker and matching `templateVersion` in
`templateCiphertext`; private source configuration remains in the existing
Account-mode trigger envelopes. Readers preserve this arm explicitly through
setup, catalog adoption, pause/resume, placement changes and Account-mode
transitions. It follows the same undeployed 0.3 direct cut, with no new
definition kind, store, old-client adapter or reverse-write obligation.

Event admission returns `observed` with `checkpointSafe: true` for a valid
observation-only occurrence. It does not create a Run or increment admitted or
skipped counts. Invalid occurrences retain `skipped/occurrenceRejected` and do
not publish committed-observation notices. This closed result is an undeployed
0.3 direct cut: server, CLI/daemon and SDK readers reload together; it adds no
persisted state or predecessor adapter.

The development-only webhook correspondence result also accepts optional
canonical readiness and nonsecret endpoint binding observations. Its existing
`ready` discriminant still means the binding can be attached, including before
provider setup is confirmed; it does not itself authorize the monitor to stop
polling. The monitor requires verified readiness and exact contribution,
source-instance, target and revocation observations. Missing observations keep
the existing fallback active. This unreleased 0.3 extension retains the closed
result envelope and the present-user/plugin caller split; it adds no operation,
principal, store, persisted format or released-reader adapter.

The development-only webhook `convergeTarget` input accepts either its existing
exact `desiredTargetMaterialization` or closed `desiredTargetRouting` containing
the Home identity and Machine id. Webhooks derives the plugin from the declared
contribution and resolves the current eligible installation through Availability
and the current contribution owner. The routing arm can refresh a changed
materialization on the same Machine under the same controller intent epoch;
the exact arm retains its equal-epoch correspondence rule. Both arms reject
unknown fields and cannot appear together. Older development servers reject
the new arm; matching development producer, server and SDK source are required.
There is no persisted-format change, new wire epoch or reverse-development
adapter. The scoped-clean moving 0.2 predecessor at
`7a01417876753a916563b8df70cf25a6c563e2d8` and immutable CLI tags
`cli-v0.2.17` / `cli-v0.2.17-preview.1` have no webhook endpoint contract.

The closed V3 worker claim and signed-claim receipt Run projections require
`leaseExpiresAt`, the server-granted expiry captured by the claim transaction.
Both direct and Automation-origin workers initialize the existing heartbeat
from that expiry; response delivery and receipt replay never grant a fresh
lease duration. Successful heartbeats advance the confirmed expiry, while
transient renewal failures retain only the last confirmed lease. This is an
undeployed 0.3 direct cut: its server producer and daemon reader update together.
In current development source, renewal proof preparation and HTTP use that
confirmed expiry as their shared deadline, without shorter attempt budgets or
an independent HTTP timeout ceiling. Cancellation or expiry still retires the
wait, and a late response cannot restore an expired claim.
Claim and renewal share the positive-integer lease-duration schema; current
development writers no longer clamp the requested duration to a local range.

The development V3 Run list also serves Account-wide attention at
`GET /v3/automations/runs?attention=required`; the definition-scoped list accepts
the same filter. It includes ordinary failed, dispatch-failed and uncertain Runs,
plus blocked Channel reply handoffs, even when no Session was created. Accepted
managed Workflow Runs remain under their existing attention predicate. The list
returns paged structural summaries, without private execution content or per-Run
history reads. Inbox consumes this membership through the shared Run-window owner
and opens the exact Automation Run route. Existing lifecycle changes clear
membership; this read adds no acknowledgement or permanent-dismissal contract.

The compatibility obligation is data created on 0.2. Its stored manual schedule maps
to zero automatic triggers; retained cron/interval schedules and enabled Machine
assignments remain readable through the current server's stored-row projection.
Reading those rows does not recreate a V2 runtime or old-client API.

In 0.3 development source, retained 0.2 `templateCiphertext` rows use the
Protocol-owned `automationTemplatePayloadV1`/`automationTemplateStoredV1` codec
in the daemon, Account trigger projection and UI read adapters. Explicit plain
and encrypted V1 envelopes, including the predecessor outer Session-id
consistency check and template-only raw-secretbox recovery, remain readable;
the canonical trigger Action checks persisted Account mode before opening content.
On a plain Account, an encrypted predecessor existing-Session template bound to an
authenticated retained E2EE Session remains paused until present-user review and
Save; it is not an encrypted execution exception. The server validates that exact
same-Account Session binding, not arbitrary ciphertext. A keyless reader projects a locked legacy row
with deletion available. Generic Account crypto does not gain an
untagged-ciphertext fallback.

The Account transition converter owns explicit per-row recovery of predecessor
templates targeting a plain Session or no Session. It uses genuine historical
material, writes canonical plain content through `templateVersion` CAS, and does
not repeat an already-plain write. A failed decrypt stays locked; a CAS conflict
requires a fresh read. Templates bound to retained E2EE Sessions are not rewritten,
and their historical material remains in existing device custody until no longer
needed or explicitly discarded. These are development-source upgrade guarantees,
not evidence that the loaded runtime or a release has been certified.

Retirement also retains material for returned encrypted trigger definitions and
opaque predecessor Run summaries. The 0.2 transition did not convert Run summaries;
current inventory can return their explicit `legacySummaryCiphertext` representation
even on a plain Account. Recovery does not reinterpret or rewrite that history.

The existing V3 PATCH mutation remains closed. Its recovery-only
`templateCiphertext` input is mutually exclusive with `executionRecipe` and
`observationOnly`; the two current definition arms are also mutually exclusive.
This is a
direct cut of the undeployed 0.3 request, not an ignorable extension promised to
an older server. The current CRUD owner requires the stored predecessor source,
plain Account mode, unchanged target and revision CAS; ordinary recipe writers
cannot use it to downgrade current content. No reverse 0.3-to-0.2 write or rollback
adapter is introduced.

The canonical trigger Action owner converts representable predecessor rows on
ordinary read through the existing inline converter and one Automation
revision-CAS reconciliation. It retains the Automation id, trigger ids and each
assignment's enabled state and priority, including zero or multiple assignments;
conversion creates no Artifact. Channel bindings address that same Automation
id and remain associated, rather than vetoing conversion. Unrepresentable
settings refuse without rewriting execution bytes.

A plain Account's encrypted template bound to a retained Session instead pauses
recipe-free, retaining the exact ciphertext. Its projection is
`legacy: { editable: false, reason: 'created_in_0_2', lockedReason: 'review_required' }`, with unavailable
execution health; ordinary reads neither request its key nor decrypt its private
content. The UI shows “Needs your review” using the existing attention treatment.
A present user opening the row requests a deliberate review through the
authenticated retained-Session/historical-material path. Its decrypted draft stays
local to the popover, not in the shared trigger store. Opening changes no private
stored content and does not resume execution.

Save uses `workflow.trigger.update` with `confirmLegacyConversion: true` and the
opened revision. Its notice explains that the normal plain Workflow stores the
reviewed content without E2EE and resumes enabled triggers; the Session itself
remains E2EE. That reconciliation preserves the original triggers and all original
assignments when the reviewed project is unchanged from the authenticated Session,
including zero/plural assignments that do not contain its Machine. A deliberately
changed project replaces placement through the normal authoring contract. Later
present-user enabled/trigger-only edits use recipe-free reconciliation and retain
those assignments and the opaque private definition body. Failed
key authorization or a lost revision leaves the original paused ciphertext intact.
Agent or unattended callers cannot take this confirmation path. Trigger removal
needs no conversion; a legacy toggle cannot bypass review. Ordinary per-trigger
enable behavior still enables only the selected trigger, whereas conversion
confirmation retains each sibling's enabled state. This is development-source
behavior, not released or loaded-runtime QA evidence.

When a new-Session predecessor omits both Agent fields, the converter resolves
the canonical default Agent before constructing execution selection and any
Agent-qualified model reference. Explicit unsupported launch settings still
refuse conversion; existing Sessions retain their authenticated Agent identity.
The current converter preserves a new-Session predecessor's native Agent
`resume` token as `providerSessionResume`: it still creates a fresh Happier
Session, rather than treating that native token as a Happier Session id.
Predecessor environment values use the existing Agent launch-environment schema
in the Workflow's private execution selection; they are not rewritten into
Launch Profile secret references or synced Session draft fields. Agent-start
environment policy still applies. For a fresh Session, a requested checkout name
and base ref use the existing `new_worktree` selection and SCM creation-intent
owner; omitted values keep the incumbent generated name and committed-revision
behavior. An existing-Session predecessor checkout draft was a no-op and keeps
that Session's actual directory instead of creating a worktree. Separate display
text stays distinct from the Agent prompt, and unchanged prompts retain their
exact original bytes.

Inputless Session steps now persist a truthful `session_ready` correspondence
for either fresh creation or existing Session acquisition, without authored input
or a fabricated receipt. Recovery reuses that durable correspondence and the
existing stable Session-creation custody. Explicit existing-Session steps ready
the target through the canonical inactive-resume owner before admitting Pending
input; failed resume admits no prompt. Offline launch choices flow through the
canonical runtime snapshot, whose timestamped permission/model policy accepts
newer incoming values and incoming-wins ties. Same-Agent portable driver choices
retain native recovery identities; different-Agent choices are refused and a
retained live process keeps its actual driver. Retained Session ciphertext never
gains an automatic Account-plain fallback.

Definition conversion alone does not certify preservation of already queued
predecessor Runs. The inspected 0.2 producer at
`639a32ec0e832dedb35d5a5809c36717c568225f` creates queued Runs without an
`executionInputEnvelope` column or frozen input. Development migration checks
now preserve null-input queued/claimed rows only before execution evidence
exists across PostgreSQL, SQLite and MySQL; the migration does not invent frozen
recipe bytes. MySQL enforces the complete input arm in insert/update triggers,
because its cascading produced-Session foreign key cannot participate in a CHECK.
Its preflight also refuses retained `run_started` event evidence. Effectful open
predecessor history still refuses activation. The development claim owner now
first-freezes a safe null-input Run from its definition through the same input
owner as new admission. The existing claim CAS commits those bytes and the lease
together, preserving the Run's assignments and checking that no execution evidence
appeared. Existing non-null frozen inputs are never replaced from the Automation's
later mutable definition. A retained Session ciphertext template stays held for
explicit review, and an already-started historical Run is not replayed merely
because its definition was converted. This source behavior does not certify the
loaded retained-data upgrade journey.

For a non-null frozen predecessor input, the current server claim/admission owner
may promote an ordinary queued or reclaimed Run into canonical Workflow custody
only before execution evidence exists. It converts that exact frozen input, not
the Automation's later definition, and retains the input bytes. A retained
encrypted template on a now-plain Account remains held for review. This server
boundary does not resolve the null-input migration above or authorize acquiring
a Session on a different Machine from its canonical runtime owner.

Current-development assigned inventory may carry `executionRecipeVersion: 2` for
an actual canonical recipe. Missing/null means unclassified, not legacy execution
permission. The existing Automation Run-detail route may carry a canonical
`workflowRun` identity and open its result through `workflow.run.get`; it omits the
historical recipe payload for that custody. Channels reply-handoff retry remains
the existing same-Run mutation, not a second Workflow executor or execution retry.

The retired `/automations/[id]` and `/automations/edit?id=` routes only resolve
the existing direct Automation read, then open the bound workflow's trigger
section or the Account trigger popover in Workflows. A deleted row lands in
Workflows with a not-available line; a transport failure keeps Retry rather than
claiming deletion. The full parallel Automation editor is removed, not the
retained template codec or historical data.

Current development trigger-set projections use the Automation's `templateVersion`
as their revision. Semantic trigger authoring changes advance it in the owner's transaction,
including recipe-free removal and individual trigger CRUD. Current strict recipes
advance their outer `templateVersion` with the row
without opening or resealing private envelopes; retained 0.2 template bytes remain
unchanged. Trigger-local revisions remain independent. A delayed pre-removal list
therefore cannot replace the newer removal result in the shared UI store.
Equal PATCH, whole-set and trigger authoring preserve revisions, timestamps and
publications. Key-holding producers suppress equal private operands before
sealing; the server never infers equality by opening E2EE content. Assignment
changes preserve untouched rows. Session review hints follow the changed Run's
immutable source, not all history of its Automation, and lifecycle status selects
only the latest applicable Run per demanded trigger. No persisted format changes.

Session-scoped schedules use the same latest-pending coalescer as other scoped
automatic firings: the active Run stays intact, and a newer firing replaces the
older queued occurrence. Their cadence cursor advances at admission through the
existing exact trigger-revision/cursor CAS. An older terminal Run cannot move a
newer cursor. Unscoped recurring schedules retain one-open-Run suppression and
advance their cursor at terminal settlement.

In unreleased 0.3 source, the schedule union also accepts
`{ kind: 'once', scheduledAt: <epoch milliseconds> }`. The existing schedule
worker admits its occurrence through the same Run owner. Admission consumes
its `remainingOccurrences` from 1 to 0 and clears `nextRunAt`; cursor recovery
does not rearm it. The trigger remains readable with its history. A target
offline at the due instant produces a terminal `missed` occurrence with
`machine_offline`, rather than queued work that fires on reconnect. If later
presence transitions have erased evidence for the due instant, admission also
records `missed`, with `machine_presence_at_due_unavailable`; it never guesses
that the Machine was online. The UI
resolves a relative delay when confirming the trigger and then retains only
the absolute instant. Cron and interval shapes remain unchanged; this new
kind requires matching development components and the additive schedule
migration.

The development schedule and reply-handoff workers retain their existing
10-second fallback scans. Process-local schedule wake hints cannot reach a
different API replica, and a database can recover without a reconnect event.
These scans preserve liveness for both paths alongside the existing due-time
deadlines; they are not a second scheduling authority. The owners are
`automationScheduleWorker.ts` and `automationReplyHandoffWorker.ts` under
`apps/server/sources/app/automations/`.

### Workflow Session input admission (development)

Development Action field bindings support a flat `object` of existing value
references alongside `list`. The preview caller uses this to combine the saved
credential principal with a branch Action's returned native identity for the
existing target-link writer. Protocol validation, materialization, daemon
resolution and editor readers change together; reload these development
consumers together. This adds no predecessor migration or result-capture store.

Workflow collaboration patterns and the public plugin-ui Run band are unreleased
0.3 source contracts. The Run band's React props are in-process presentation,
not a new wire epoch or execution authority. Plugin UI package exports and
declarations use their canonical API-governance producer; no package publication
or supported package baseline follows from a workspace export.

Input-bound participants, qualified Discussion origin/context, result destinations,
authored `discussionReplyTo` and capture requests use the existing closed
identity/routing/executable declaration and Action schemas. Stored Workflow
readers retain the canonical tolerant unknown-field projection; new writers emit
the current shape. Host-resolved parent identity stays in invocation progress,
not caller-editable input. Unsupported operations use existing Action/host
admission and must not be silently downgraded. This direct cut adds no migration,
second writer or shim for superseded development intermediates. Existing native
0.2 Workflow activity and retained Automation data keep their distinct readers;
the Run presentation extraction changes none of those data formats.

Typed Session inputs confer no authority by themselves. Current admission records
per-leaf `sessionAuthorityBindings` only after exact target resolution and the
starting principal's current Session-corpus check. Session-authored direct and
trigger starts retain their own/led restrictions; person-authorized starts use
that person's current access. A matching retry after a lost start response
returns the existing Run receipt (`admission: 'existing'`) after checking that
the accepted authorization is still current; it does not re-run target
admission or widen the retained witnesses. Every effect that uses a target
re-checks current Session access at execution time. Runtime Actions resolve the existing run/logical-invocation/attempt
correspondence against the accepted leaf and its exact lexical frame, so one
child's target never becomes another child's authority.

The signed ReviewComment principal carries that invocation's `workflowScope` to
Home. The scope, its addresses and its invocation identity are closed objects
covered by the existing Machine-installation signature. Home checks the Run's
assigned host, invocation slot and current Session access again. A snapshot or
principal without the new witness cannot extend origin-only authority. These
undeployed 0.3 producers and strict consumers move together; an older consumer
rejects the extended header rather than granting broader authority. No schema
migration, reverse writer or older-development compatibility mode is added.

Input/item-bound Agent engines and their finite accepted `engineBindings` are
closed development Workflow declarations and private snapshot content. Unknown
engine fields or choices outside the admitted roster refuse before execution.
They use the current 0.3 direct cut; no predecessor reader or reverse writer is
added for these undeployed managed Workflow shapes. Native Workflow activity in
0.2 remains a separate contract.

The optional `authenticatedStarterV1` in the accepted Workflow origin is a closed
development fact, with closed qualified requester identity and request reference.
Only current authenticated direct-person host admission produces it; public
Workflow start inputs reject starter claims. It records a cause, never authority.
Existing snapshots without the fact remain unknown, and Session participants
consume it through the existing protected Action-attribution input. These
facts also travel on the closed Workflow approval caller for Account-bound
starter consent before any Session exists. Unknown fields are rejected, and
absence never identifies the Run owner as a person. No public Action input or
released V1 approval history changes. These undeployed producer and strict reader
shapes move together under the Workflow
direct cut; older development readers reject the field rather than silently
dropping its meaning. The inspected clean `../0.2` at
`29c845495702acde2824dae13067d8a09322b26b` has no current accepted-origin or
Workflow admission owner at these paths. No new transport epoch, server column,
migration, reverse writer or rollback adapter is introduced.

The current daemon may return a strict `launch_retired` detail with
`SPAWN_FAILED` after its startup owner verifies process exit and custody cleanup.
The Workflow Session creator accepts it only for the requested spawn nonce, then
uses the existing failed-invocation fact. This is a current 0.3 producer/consumer
cut; older spawn failures and retained Workflow rows without decisive evidence
remain unresolved, rather than gaining proof from their error code or age.
No persisted format, migration, rollback adapter or timeout is added.

Current development Session-conversation reuse refusals retain their existing
codes and carry optional `WorkflowConversationUnavailableDetailsV1` facts through
`WorkflowActionFailureV1Schema` and invocation progress. These closed objects name
the rejected selection or resolver check and include only expected/observed kinds
and non-secret identifiers. Configuration values, credentials, prompt text and
working-folder paths are not diagnostic payloads. Missing retained delegation
depth and deleted origin Sessions use the same diagnostic owner. The daemon writes one structured
file-log event at the refusal; `workflowProblemPresentation.ts` renders the same
facts from Actions and persisted Run detail. Model and permission intents remain
Session Pending decisions, and inactive Sessions remain eligible for the existing
resume path. No reuse eligibility or lifecycle decision changes.

Historical progress and refusals without details remain valid. The Workflow
feature is an undeployed direct cut: these strict V1 diagnostic additions move with
its current readers and coordinator, without a released-reader or rollback shim.

Workflow cancellation in current development targets the same Run across claim
and progress writes. Its existing `expectedRevision` field is an observed lower
bound: a newer revision may be stopped, while a future revision or terminal Run
still refuses. The server applies cancellation against the current revision under
the existing publication locks. Pause, resume, replacement and recovery retain
their exact currentness checks. Terminal cancellation and settled execution or
publication custody remain separate facts; accepting Stop does not invent proof
that an admitted operation stopped or a Discussion reply was delivered.

Current development Workflow definitions accept declared decisions beyond
`continue | stop`, including strict `{decision, reason?}` results, and input-bound
`until`/`evaluate` round limits. Admission freezes a positive safe integer; inline
Workflow frames retain their resolved inputs in sealed body progress. Loop
closing records add a strict decision/stop-condition/exhaustion outcome; exhaustion
now completes successfully. Existing `continue | stop` and bare-string results
remain accepted, and existing iteration-array result paths remain unchanged.
Current authored references additionally accept a value-only item `path` and
the `last` array result-path segment. Numeric array paths and object properties
retain their meaning. Older development readers reject or misinterpret these
new forms; the current reference schema and input resolver move together.
This is an undeployed Workflow direct cut, not a released-format compatibility
shim. Old development readers cannot execute these new definitions correctly;
use the current admission and coordinator together. No new rollout mode or
dual writer is introduced.

Accepted Action contracts retain a finite Action's terminal schema once, in
`completion.terminalOutputSchema`; `outputSchema` points to it with the
contract-relative JSON pointer `#/completion/terminalOutputSchema`.
`readWorkflowActionOutputSchemaV1` resolves the schema for execution, recovery
and review, and still reads older snapshots containing both copies. Immediate
Actions retain their inline output schema. Admission and storage use the HTTP
request-body boundary rather than Automation's unrelated per-field ceiling.
Load the current freezer and readers together for this development change.

Inline Workflow body progress also retains the selected project workspace as
`frameProjectWorkspace`, including its generated-checkout creation intent.
The frame's separate `workspace` pair owns the child's lazy generated default.
Current readers preserve and verify both pairs on resume; a deleted or mismatched
recorded checkout is unavailable and is never automatically recreated. New
generated frame-project names use a project-slot suffix; the child's default
keeps the invocation-qualified default name. Recorded intents keep their names.
Explicit restoration resolves an unmaterialized child's default through the
canonical frozen ancestry owner. A frame can propagate either slot's failure,
so restoration verifies all its recorded generated pairs before publishing a
replacement attempt; it does not guess the failed slot or recreate a checkout.
This is the same
undeployed direct cut: the strict V1 private progress shape changes with its
coordinator and readers, with no older-development reader or rollback shim.

Workflow child prompts use Session input admission protocol V2 with the invocation
purpose and Workflow Run provenance. Direct final-result delivery no longer writes
a Session Pending input: the origin runtime pulls current Run state into the host's
context-only WorkerUpdate slot. Neither path invents an Automation id or uses
Automation reply handoff. Updated Session readers
accept both V1 and V2 request, provenance and settled-authority records, while
Automation and other incumbent V1 writers retain their existing shape.

Automation workflow definitions use the strict stored recipe epoch `v: 2` in
the existing private Automation definition body. They have no synthetic legacy
target projection (`targetType` is `null`). At occurrence admission, the
incumbent Automation transaction creates the parent Run and attaches its opaque
definition envelope; occurrence evidence remains a separate frozen Automation
envelope. Before root coordination, the assigned daemon binds its canonical
payload to declared inputs exactly once and seals the immutable accepted
workflow snapshot used by origin-neutral Runs. Actual 0.2 templates remain
readable through the canonical trigger conversion owner, and retained Run data
through the historical Run readers. The stored strict one-shot read shape is
not an adapter for obsolete copied Workflow definitions.
Retained 0.2 flat-template prompts stay literal, including brace text, when run
or explicitly converted to a Workflow; native current one-shot input-token rules
do not reinterpret or restrict those historical prompts.

Conversion in 0.3 development keeps the exact Automation id and therefore its
Channel binding. Existing-Session conversion uses that Session's authenticated
Agent identity and actual project/Machine, not an arbitrary retained assignment.
The shared trigger owner writes the inline recipe through the existing Automation
revision CAS; unsupported templates remain unchanged with a typed
`legacy_conversion_unsupported` reason. Retained encrypted templates on plain
Accounts require the present-user review and Save described above.

Predecessor recovery follows the Account-transition and retained-Session paths
described above. The 0.2 transition to plain could leave Automation ciphertext
whose outer template requires genuine historical Account material; its embedded
Session key does not decrypt that outer template. Plain/no-Session-target rows
can be explicitly recovered to canonical plain content through the existing
converter and `templateVersion` CAS. Templates bound to retained E2EE Sessions
stay encrypted and paused until present-user review and confirmation. A key-holding
device opens the local review through the authenticated Session/historical-material
path, then Save writes the normal Account-plain Workflow; the Session itself stays
E2EE. A keyless reader stays locked with deletion available. Historical material
stays in existing custody; discarding it is an explicit user action, not a generic
reader fallback or recreated Account key.
These implemented development paths do not certify a loaded runtime or release.

The current development trigger context replaces the earlier copied-definition
payload in place. It seals workspace, execution target, constant inputs, optional
role overrides and either an inline definition or context for the row's live
`workflowDefinitionId`; the assigned Machine remains in Automation assignments.
`readTriggerTargetV1` rejects missing or ambiguous targets. Library, `builtin:`
and qualified `plugin:` references share one parser; parsing does not establish
catalog availability. This is not a released V1 format change. Direct admission
and Automation claims share the Protocol accepted-snapshot materializer: it
normalizes the program, freezes role overrides and child definitions, derives
the effective permission ceiling, applies ORC policy, checks the assigned
Machine's targets, then seals. Unsupported catalogs fail closed. Frozen
`causeWorkDepth` travels in the first-admission Automation claim receipt,
not private trigger input, and scoped conversation causes may carry `triggerId`.
An already accepted Workflow reclaim omits this optional field and uses the
depth in its immutable accepted snapshot. It does not require the causal Session
or turn to survive; current accepted-authorization checks still run at the worker.

Saved-definition admissions freeze `source.savedBy` for direct and Automation-origin
Runs. The field is required for a saved source; an explicit null records a header
without authorship. It is private display metadata, not execution or authorization
authority. Accepted Runs never re-read the mutable header to recover authorship.

Accepted development snapshots require `workDepth`, `authoredDefinition`,
`materializedLeaves`, `frozenChildren` and explicitly nullable display metadata.
There is no pre-materializer snapshot fallback. Fresh
Session and detached Agent steps receive the accepted depth plus one; protected
Workflow input and provenance depths must agree. `profileId` denotes a Launch
Profile, never a plugin execution-run profile. Detached steps freeze portable
Launch Profile defaults at admission and refuse nonportable profile behavior;
dispatch does not look up execution-profile custody. Loaded-runtime and package
validation of this finalization remains tracked by the implementation lane.

The internal Workflow storage admission operation accepts only a direct origin,
and its authenticated publisher Machine must equal the target Machine. An
Automation occurrence never enters through that route: its canonical Automation
transaction creates the parent and attaches the Workflow body there.

The unreleased Workflow storage `get` operation accepts optional
`prepareAdmission` source and Team hints. An existing Run still returns its
authorized snapshot and ignores those hints. A missing Run returns
`{ run: null, keyCensus }` after the canonical admission-census authorization;
ordinary `get` without hints keeps its not-found response. Known inline and
saved-source E2EE Starts request and consume that census within the same
admission; Plain Starts use ordinary `get` without key preparation. Start
reuses its canonical encryption witness for preparation, sealing and admission;
the final `admit` still checks current Account mode, source visibility and
recipient bindings. Catalog and replay Starts retain their later census because
their final source binding is resolved later. Daemon and server must reload
together for this development seam; no older-server fallback is provided.
The 0.2 predecessor has no Workflow storage endpoint.

At `accepted-snapshot.resolve`, a scoped Automation freezes its Account-owned
`scopeSessionId` into the Run's `originSessionId`; the server checks both the
current scope and Session ownership. This context does not change the Run's
Automation origin or immutable cause. Explicit originating-Session delivery
initializes the same acknowledgement as direct admission; otherwise it remains
null. An exact acceptance replay uses the frozen scope and delivery choice,
preserves an advanced acknowledgement, and does not reread a later scope edit.

Development Discussion-origin Runs freeze a nullable `originDiscussionId` beside
`originSessionId` at direct admission. `originKind` remains `direct`; the new
field records provenance, without changing Run access or execution kind. Run
again retains the whole accepted origin. The existing Run-list storage owner
selects the exact Discussion relation using its `(originDiscussionId, createdAt,
id)` index and binds that selector into the cursor. Apply the additive migration
before loading this server code. Existing Runs keep null: there is no backfill.

Development Run projections retain a nullable `sourceArtifactId` frozen at
direct admission or Automation accepted-snapshot attachment, plus
`ownerAccountId`. Inline/catalog Runs retain a null source; private snapshots
are not server-decrypted to infer a source.
`workflow.run.list` without a source filter lists the caller's own Runs. A source
filter selects that workflow's caller-visible history. Current development
Team visibility requires the Run's exact frozen Team grant on the source
Artifact and the caller's live effective membership in that Team; personal or
other-Team grants alone do not preserve it. Exact reads, source-filtered history,
summaries and recipient-key census consume the same Run access owner.
Cursors bind both Account and source/filter scope. `workflow.run.summaries`
has two exclusive development request shapes. `{sourceArtifactIds,recent}`
retains saved-workflow last-started, recent and Needs-you facts with byte-bounded
`remainingSourceArtifactIds`. `{automationIds}` returns each requested
Automation's latest caller-admitted started Run status (including retained
one-shot Runs), or an answered null, with byte-bounded `remainingAutomationIds`.
Last-run order is `startedAt DESC, id DESC`, independent of outcome: a Run that
never started cannot advance it. Recent history and Needs-you facts still
include unstarted Runs. The definition API's `lastRunAt` consumes this same
summary; admission and settlement do not write a separate Automation timestamp.
Inline sources and different Automations sharing a
saved source retain distinct Automation identity. Requested ids filter access;
they do not grant it. The Automation result contains public state, custody,
attention, creation and actual start time, not accepted snapshots or private progress.
Its capture is released before result materialization and exact byte paging;
returned Run members undergo fresh admission before disclosure. Neither shape
imposes a row-count cap. Remaining ids preserve input order and are unanswered,
not null results.
The development attention list accepts an explicit `projection: 'membership'`
for consumers such as the closed Inbox badge that need admitted membership but
not private display facts. Omission keeps the full list projection. Membership
does not open or transfer accepted, root or held private content; its explicit
response marker distinguishes unrequested private facts from an opened untitled
Run or unreadable content. Membership updates the existing window's ordered ids
and paging frontier, not the full Run-body map. Exact readers therefore retain
their normal missing-body acquisition, while the durable Account change applier
continues to materialize changed Run bodies before advancing its cursor.
Private destination, Discussion and subtree filters
and requested invocation provenance require the full projection. Both modes use
the same attention predicate and fresh Run admission; no server decryption or
second badge cache is introduced. Cursors also bind the projection. The existing
response-byte boundary still owns paging, so a thinner page may contain more
valid rows. An open Inbox or Work consumer promotes the same window to full
private display demand, including when a membership read is already in flight;
refresh retains the previously loaded ordering frontier. These undeployed 0.3
producers and consumers update together, without an older-development adapter.
List, detail, wait and summaries share the server's attention predicate: failed
Runs, or non-cancelled Runs with actionable invocation rows. Accepted managed
Automation Runs use this Workflow predicate and are excluded from ordinary
Automation attention, so a failure without a Session still appears once in Inbox.
Linked step Session attention folds beneath the same Run. An interrupted state,
pending physical Stop custody, failed origin delivery or a settled exhausted
result alone does not add attention.
Lean list rows expose `attentionRequired` from that same membership, including
exact Run reads used by Boards. Other projections may omit it; omission is
unknown, not false. Ordinary child-row wakes refresh this fact without advancing
the parent control revision; aggregate attention-membership changes advance the
existing parent revision as described below.

Workflow Session inputs use the current input-admission owner directly. There is
no older-daemon capability preflight or V1 downgrade before creating or mutating
a Session; the strict input/provenance parser still rejects malformed content.

Each Workflow invocation input has one protocol-derived stable identity including
its exact invocation record. Ordinary Session steps use the existing Pending queue;
`origin_session` steps use the required context-only `workflow_step` input and the
origin's input-admission owner. Originless admission refuses an `origin_session`
leaf with typed `invalid_input`. The producer freezes its rendered text alongside
the admitting correspondence; the origin consumes that exact text without a
second role or result-contract renderer. General authored/recovery input can exist
before rendering, but an origin input cannot be consumed without its frozen text;
this is a current admission phase distinction, not an older-snapshot reader.
Only the input owner decides withdrawal. A positive host
event restores dispatched custody after restart; a missing event does not prove
withdrawal. Permission settlement and the exact-turn transcript observer remain
authoritative. An omitted Workflow timeout selects explicit no-deadline observation;
a supplied timeout starts at the accepted host event and is not restarted on rejoin.

Origin Run delivery stores nullable `originDeliveryAckRevision`: null disables
delivery, and enabled admission initializes it to zero. The origin reads current
snapshots above this acknowledgement and advances it monotonically only after
provider acceptance. Aggregate attention-membership transitions advance that same
Run revision: the first hold above a zero acknowledgement and a later re-entry
after acknowledgement are deliverable, including when the origin reconnects.
Ordinary child facts remain row-local; siblings entering or leaving a hold while
the Run still needs attention do not advance its revision. Fact acknowledgements
include `parentRevision` from the same storage transaction; workers adopt it
monotonically before their next parent CAS. A failed acknowledgement for one Run
remains retryable without stopping delivery for other Runs in the origin Session.
Pull and exact Run reads use the shared attention predicate, so admission
rechecks reject a resolved
or superseded snapshot. There is no second delivery cursor or replay of resolved
holds. Delivery does not hold invocation custody. The retired
`result_delivery` input purpose and `workflow_result_delivery` provenance are not
accepted by current development readers; the distinct Automation/Channels reply
handoff remains unchanged. This is an undeployed Workflow direct cut, not a released
Session V1 removal. Package and loaded-runtime verification remain pending.

Workflow-only `attached_run` execution is retired in current development source
(FIN U5 feature removal). Workflow targets are Session or detached Background run;
the retired target and its private correspondence are rejected, not reinterpreted
as Session execution. Native Session-attached Execution Runs outside Workflows
remain unchanged. Detached starts require the real initial prompt.
The daemon derives the Run identity from the existing
host-stamped Action request id for the exact Workflow input, so a response loss
or failed correspondence write rejoins the already-started Run instead of
starting or sending it again. This is Run-manager idempotency over the existing
Workflow input identity and Run registry, not a second Workflow receipt store.

Boundary Resume's content-free `workflowResumeRequestedRevision` is a nullable
Run column and an optional field on the closed V3 Workflow claim and existing
claim receipt. A successful claim clears the column in the claim transaction
and passes the consumed revision to the current worker; a replay of that same
claim preserves its disposition, while a new claim omits it. Pause or Cancel
supersedes an unclaimed Resume. Null storage means no pending Resume, and absence
from a claim means it consumed no Resume; neither is an old-row compatibility
fallback. Managed Workflows are undeployed and have no released or 0.2 predecessor
seam: current server and worker are refactored in place, with no obsolete
development shapes or guessing from checkpoint pause state. Ordinary current
one-shot Automation claims carry no Workflow Resume request.

Workspace restoration is an explicit development-only `workflow.run.resume`
recovery choice. The server projects only coarse eligibility from public Run
state and the existence of an execution row; the authorized client opens the
selected private progress and qualified frame-owned correspondence and requires
recorded creation intents and Git worktree descriptors before offering Restore
workspace. Execution is routed to the exact Machine frozen in the accepted
snapshot, verifies only those recorded checkout paths through the incumbent
SCM currentness owner, and publishes the new
attempt under the same expected-Run-revision check before any retry work starts.
It never falls back to a suffixed or newly selected checkout. Because managed
Workflow Runs remain development-only, this closed Action/availability addition
updates the current protocol in place and establishes no released mixed-version
compatibility adapter.

Recovery eligibility belongs to the shared Account Run Action owner, which uses
exact input-owner observation and current conversation capability; prepared
continuation content is not eligibility evidence. Missing workspace and a stop
acknowledgement do not prove an input inactive. Replacing proven-stopped input
with uncertain effects additionally requires acknowledgement for that attempt.
Reattach observes the recorded input without starting, sending, or allocating an
attempt. Its signed Machine fact write uses the existing `invocations.fact`
operation with the exact row's `expectedContentRevision`, the observed parent
`expectedRevision` and `resolution: 'observed_terminal_execution'`
instead of a fabricated worker `parentAttempt`. The server requires the exact
assigned interrupted Run with pending custody and the current invocation; it
permits only observed settlement, preserving the parent revision and claim.
The incumbent claimed-worker fact shape remains unchanged. This observation
arm is development-only and changes no persisted format or released contract.

In 0.3 development source, invocation replacement through `invocations.recover`
is an Account Run control operation, shared by Retry and Resume recovery. It
uses the existing editable-Run access owner rather than requiring the calling
Machine to be the assigned executor. Account-mode validation, envelope bindings
and change publication use the selected Run owner. Signed Action requests retain
their exact Action purpose, Account and installed-publisher Machine binding;
worker execution and retained-child observation keep their executor authority.
The optional publisher field is accepted from existing callers; no persisted
format or released-client compatibility contract changes.

Managed Workflow Runs are origin-neutral `WorkflowRun` rows driven from the frozen
accepted snapshot; observed Claude activity snapshots remain presentation-only and
never drive the coordinator. Schedule and occurrence admission freeze the reviewed
definition plus applicable Artifact revision: later library or Automation edits
affect only future admissions, never admitted Runs. All 0.3 components update
together; older-component interoperability and rollback are unsupported. There is
no reverse migration, dual write, Workflow compatibility mode or rollback-only writer.

The current-development storage `get` request accepts `projection: 'control'`
for state, revision and the original root progress, or `projection: 'revision'`
for state and revision alone. These projections omit accepted-program,
checkpoint, result and key-census response bodies. Full reads remain the opening
and recovery contract. The same access and Account-mode owner admits each read;
root disclosure keeps its mode and envelope-binding validation. This optional
closed request field follows the same 0.3 coordinated update, with no persisted
format or released-reader change.

Current-development root progress optionally retains accepted destination leaf
labels and exact last-observed invocation facts in `stepProgress.destinations`.
The same root envelope/currentness projection carries them through lean Run
lists; no public database columns or extra history reader are added. Counts-only
root progress remains readable, and a missing leaf observation stays unknown.
Observation ordering uses the existing unique per-Run physical sequence
and the exact record's content revision, including after reload. This is an
in-place 0.3 addition, not an older-component interoperability promise.

The current-development review cut adds invocation and parked-parent
`waiting_for_review`, canonical decimal `contentRevision` on every invocation,
and the outbound `review_required` update kind. Current producers and consumers
move together. Decimal strings are the current lossless JSON representation of
database BigInts, not a historical-format reader. Only a current completed invocation exposes successful result
data; a stored draft alone is not completion. Private Workflow payloads now use
per-run keys and strict owner/Run/purpose bindings. Pre-cut development content
is intentionally unreadable, without a dual-key reader or historical reseal.
The inspected `../0.2` Workflow owners are absent at
`17ba05df68d4d3d4cad1c1241b58e63805db37ed`; ordinary Automation and Session
data remain separate predecessor obligations.

Current-development Workflow Actions preserve `history_not_readable`,
`encryption_setup_required`, and `waiting_for_keys` from the per-Run key owner.
These are distinct from malformed private content (`content_unavailable`) and
an unavailable storage boundary (`storage_unavailable`). Recognized database
failures at Workflow storage HTTP admission return 503 with the latter code;
unexpected application exceptions remain with the global error owner. A failed
read never establishes mutation currentness or an empty successful result.
The review UI keeps a fieldless Wait's card and disabled Continue visible while
its exact evidence is pending or unavailable, and offers reason-specific recovery.
Only successfully read exact evidence can enable mutation. This is development
source behavior, not verification of a loaded QA runtime or a released contract.

The current Account-transition inventory GET reads the captured Home directly,
without an older-server feature probe or inventory-426 translation. Request failures
remain failures rather than a fabricated empty inventory. This development cut does
not activate dormant V5 or downgrade current requests to predecessor transition wire.

### Same-machine session handoff (development)

Same-machine handoff extends the current V3 operation without another transport or
persisted shape. Path-backed Sessions require an explicit, different local target
before the source stops. Managed Sessions retain their existing private-directory
allocation. The existing local durable bundle path works without a network transfer
carrier; the `sessions.handoff` feature decision still applies.

Source cleanup shares the target job locally, requires completed target commit, and
must not stop the successor by Session id. Abort preserves an already completed job.
Tracked cancellation remains available during preparation and closes before target
launch, which begins publishing the target's canonical Session metadata. The accepted
launch then completes confirmation, commit, and cleanup through its existing nonce
observation owner. This is development behavior, not a released rollback guarantee.
The 0.3 development computer refuses moves driven by a 0.2.11 computer or the
predecessor V2 peer contract. Unversioned handoff operations and V2 capability,
prepare, resume, confirm, commit and abort return `handoff_update_required` with
“Update both computers to move this Session” before job mutation, import or
native process effects. Update both computers before retrying the move. The V2
semantic adapter is removed; current V3 handoff retains its canonical lifecycle.
This operation-scoped refusal leaves unrelated Machine and Session operations usable.

### Existing native session-state handoff (development)

The development handoff contract adds optional `stateTransfer: 'transfer' | 'existing'`.
Omission preserves transfer. Existing-state mode verifies the exact Agent-native Session
already on the target rather than exporting/importing its conversation data; it rejects
copy payloads and requires `workspaceAction: { kind: 'none' }` (or its omitted equivalent).
A managed directory that requires allocation/materialization is not an existing-state target;
that carrier is rejected at the shared Action/start/prepare policy boundary.
Same-machine explicit existing-state uses the same resolver and lifecycle; topology does
not silently change a default transfer into existing-state.

The current V3 capability and read-only existing-state check are negotiated before source
mutation. Missing, malformed or predecessor V2 capability cannot authorize this mode:
the operation reports an update requirement, and the caller may explicitly choose transfer.
The development UI keeps transfer on by default and disables the option when either peer cannot prove
support. Its Action adapter preserves explicit `existing`, disables workspace copying, and
keeps `existing_session_state_unavailable` inline in the picker. Turning transfer on and
submitting again is an explicit choice, never an automatic fallback. Same-machine moves
hide the toggle and retain ordinary transfer. The current 0.2 predecessor's V2 `existingState` bit does not prove V3 support.
Its V2 carrier and the current V3 request must never be silently reinterpreted across versions.

Agent plugins provide the optional public-SDK `handoff.resolveExistingState` hook through
current generation-bound execution surfaces. It returns the same native identity, source
and launch hints as import, but must not copy or repair native state. Claude resolves the
exact transcript in the target's effective config root, including a re-homed project; Codex requires
the exact native index row and its existing rollout in the target's effective native homes.
An unsupported Agent or missing state fails closed, with transfer offered as the remedy.
Target preparation and final launch recheck the native state under their effective environment;
when the host supplies the complete effective child environment, plugins do not restore
native-home variables removed from it by falling back to the daemon environment.
the final check is not a second state-action owner. The ordinary confirmation/commit/abort
owners remain authoritative. Governed callers retain exact accepted Session and Machine
authority for the read-only preflight rather than borrowing ambient custodian authority.

This is development source behavior, not a released compatibility or loaded-runtime claim.
The feature's integrated and live evidence is tracked in its existing execution lane.

### Workspace-sync handoff rollout

Workspace handoff is operation-scoped across UI, daemon, and Machine RPC versions. A current
client may send the canonical `none`, `copy_once`, `create_relationship`, or existing
`relationship`, or `linked_workspace` action only to a daemon that understands that exact action. A predecessor daemon
that cannot execute the requested workspace action returns
`workspace_sync_update_required`; the client keeps the connection and unrelated Machine/session
operations usable and asks for that daemon to be updated. It must not reinterpret the request as a
legacy file-transfer job or report a successful handoff without the workspace result.

The development-line `linked_workspace` choice carries only the target Machine/path in the
public Action. The current daemon resolves the admitted Session's source and the exact target
WorkspaceRefs from its current Account settings, then invokes the controller-owned
`daemon.workspaceSync.prepareBetween.v1` operation. A controller without that exact method
returns `workspace_sync_update_required` for the linked operation; the caller must not silently
fall back to a direct copy or claim that a first completed link prepared the destination.
The result records only the links actually traversed and their observed statuses. A later
retry starts a fresh route check, not a persisted cursor or replay of the second link.

The development-line devcontainer bind-workspace extension keeps the admitted child
Machine and Session as the execution identity. Only physical workspace work is routed
to its current controller, through the existing Workspace Sync RPC family. A parent
without the exact private `daemon.workspaceSync.handoffSourcePhase.v1` member returns
`workspace_sync_update_required` before Session quiescence or Agent export; there is
no SSH, legacy-copy, or generic parent-Account fallback. The installed child socket
retains the original child admission, actor and caller constraints. Home verifies
that scoped routing, while the parent rechecks the current child relation, controller
installation and native bind root before preparing or finalizing a write.

Source commit and abort release only the exact operation and original context retained
by the existing parent preparation owner. They can settle that custody after source
adoption, cancellation, native replacement or withdrawal of the original actor's grant;
they do not restore effect authority or reuse a retired borrower credential. Current
installed-child custodian transport and parent installation/Home authentication remain
required. An unavailable retired child socket cannot manufacture cleanup authority.
This private routing does not expand public Session-handoff or Workspace Sync policy:
a missing scoped chosen-target producer fails closed, and reaching a physical parent
with the daemon's ambient custodian credential is not admission to the chosen child.

The current daemon remains the sole relationship-settings writer and uses the external Mutagen
sidecar as the sole reconciliation engine. Mutagen session identifiers and private broker details
are daemon-local implementation state, not wire or persistence compatibility contracts. A missing
verified external engine artifact is an `engine_unavailable` failure for the requested workspace
operation; it does not authorize a fallback to the retired replication engine.

Development status observation requires the matching native broker's `wait_for_change`
command. It preserves Mutagen v0.18.1's Manager.List index as a decimal uint64 string:
zero establishes the baseline, the last returned index parks until an engine change,
and cancellation detaches the native wait. The Sync owner reads demanded statuses
after that signal; successful observation has no periodic GET. A failed observation
retains known status and uses the existing recovery delay, resetting the index to zero
on reconnect. Shutdown cancels parked native waits before draining mutations.
Source-runtime stacks and shipped CLIs use the same first-party artifact owner:
`MUTAGEN_ENGINE_VERSION` in `packages/cli-common/src/firstPartyRuntime/mutagenEngineArtifact.ts`,
kept in parity with `packages/cli-common/mutagen-engine.json`. The Sync-wait release
is `0.18.1-happier.12`, from fork commit
`bee29cad5c61b10e129d9f03e25c86a00f5d7925`; both native executables report that version.
The signed release covers all five policy targets. Daemon composition
validates the installed payload against that exact pin before starting the broker,
acquires that exact release if absent, and validates it again before use. An old
`.11` payload cannot be admitted; an unavailable `.12` settles as the existing typed
`engine_unavailable` readiness failure. There is no old-engine polling fallback.
Separate CLI/install homes acquire that release independently through fixed
pinned-tag asset download URLs, without GitHub REST metadata discovery or tokens.
The canonical asset owner selects the published Windows ZIP or Linux/macOS TAR.GZ;
the same Minisign/checksum and pinned-payload validators decide trust. Both the controlling
manager and receiving Machine's agent must match version and native build identity;
Add machine, Project Open Sync, handoff/flush and worker copies consume the same
resolver. Updating the controller does not replace a running receiver. The earlier
local QA candidate also reported `.12` but had a development build identity; replace
it with the signed payload and reload both endpoints before cross-machine replay.
The native handshake compares the numeric version triplet and immutable build
identity (`pkg/mutagen/version.go`); the displayed `happier.12` suffix alone is
not the handshake identity.
No public RPC, persistence format or protocol epoch changes.

Project Open consumes the relationship owner's settled preparation refusal after
native/target cleanup and staged relationship rollback are acknowledged. The handoff
adapter also releases its captured private execution before propagating that proof.
A definitive engine refusal then returns the existing typed refusal instead of an
uncertain outcome. This does not promise that no filesystem effects occurred.
Cancellation, indeterminate failures and unacknowledged cleanup remain uncertain.

The current development Workspace Sync extension retains pairwise relationship persistence and
derives linked sets from their existing WorkspaceRefs and controller roles. It does not persist
a group or rewrite valid beta-controlled two-way relationships. Direct Project creation uses
`workspace.sync.relationship.create` and the same relationship writer and destination approval
owner as handoff; it cannot disguise existing-folder attachment as an older handoff request.

Unreleased 0.3 committed-copy removal keeps its containing Action operation at the
source host while cleanup and filesystem effects run at the admitted target. The
existing Socket RPC call opts into `rpc-continuation` for progress, native-owner
updates, setup review and Stop. Each endpoint uses that call's captured content
codec and relay-selected socket; installed target content also binds subsequent
frames to the initial reply key, method and route. The relay forwards opaque
frames through socket rooms across cluster nodes. No operation record, credential
or permission evaluation is created for a continuation. Cooperative cancellation
retains the original terminal acknowledgement; final settlement remains at source.

Current status replaces the unmeasured `changedFiles` field with no substitute count and names
the process-local cycle observation `lastCycleObservedAtMs`. Endpoint scan/transition problem
facts come from the matching engine producer. Missing endpoint evidence is unknown, not clean.
The controller's clean-result predicate gates dependent execution and fresh/recovered Copy once;
raw manual Flush remains a diagnostic operation. A completed cycle does not establish immutable
inputs or global convergence.

The 0.3 development Machine publication is a readiness-only invalidation signal,
not a second private relationship-status channel. The existing daemon-state version
orders that signal; current UI consumers refresh admitted status/conflict reads for
their demanded exact Home/controller scopes and retain last-known values while
refreshing. Full relationship detail, cursor invalidation and stale-response
rejection remain owned by those existing private reads and stores.

Ordinary Machine metadata/state publishers share the strict publication contract in
`machines/machinePublishedContentV1.ts`. Stored readers tolerate additive or retired
fields and retain supported predecessor host facts, including
`startedWithCliVersion`; UI metadata still treats malformed optional CLI-update
facts as absent. Their new writes do not echo retired private Sync fields or unknown
peer/transfer bags. Tolerant reading does not migrate the retained blob: wider key
delivery must check the entire opened current content and its committed versions,
or remain pending until an authorized custodian rewrite. The incumbent legacy
content-key transition intentionally rekeys the exact opened bytes; it is a retained
content transition, not an ordinary publisher or a second privacy projection owner.
Converting that key cannot make unsafe retained content eligible for delivery.
This refines unshipped 0.3 source in place; it is not a loaded-runtime or release
safety claim.

Machine grant and Team membership effects consume the same canonical effective
access union before and after the complete mutation. The existing membership
wrapper captures Machine and Session impacts together; a surviving direct, Team
or Group grant must not be treated as final loss. Final actor-room invalidation
occurs after commit without deleting Session history or retained AccessKey bytes.
This is incomplete development source: socket disconnection alone does not certify
settled Session or process cancellation.

The development Machine content-key lifecycle reads predecessor owner data with
either an absent legacy-secret envelope or an Account-key envelope, then converts
both ciphertexts and the owner envelope as one conditional state. Conversion
preserves the opened blobs rather than treating a tolerant read projection as a
privacy migration. New E2EE Machines use random resource keys; Plain Machines do
not allocate key material. Registration adopts the returned winner and does not
independently replace an existing envelope or ciphertext. New encoded writers
send the exact owner-envelope identity and expected content revision; recipient
opening envelopes remain separate from this `keyBasis`. Retired writers refuse,
and a lost transition acknowledgement is observed without automatic replay.
Current contexts, caches, hydration and RPC use the existing update carrier.
These wire refinements replace unreleased 0.3 shapes in place; historical reads
are custodian-only and malformed present envelopes never become legacy or Plain.
Shared recipient preparation observes the authenticated custodian Machine and
runs that existing conversion before the strict current-holder census. Foreign
Manage holders retain their delivered key tuple, not historical custodian reads.
The development grant projection carries member-level compatibility and key
recoverability separately from grant-edit authority; both initial continuation
and Retry consume its canonical `canPrepareKeys` result.
This describes current source, not a successful composed runtime certification.

Reviewed conflict resolution refines the development Action in place: source and explicit
destination entry expectations are required, including complete structural identity for a
directory replacement. Historical approval records remain readable, but an older loser-only
pending request cannot execute by fabricating a reviewed source. Captured bytes use the existing
finite transfer, and target authority rechecks the approved effect. Partial and unknown outcomes
do not authorize automatic replay or unattended application to a later-reconnecting endpoint.
These current-development shapes do not create a second resolver or a compatibility alias for
an unshipped input. Exact operation support must be checked before effect; unrelated operations
remain usable when that support is absent.

The development pin selects the published `0.18.1-happier.11` engine at
`0139d6755f7281c84899b207de3179235afe9b9e`, which supplies the extended compact engine
problem/selection contract. Existing daemons must load the updated CLI and acquire that verified
manager/agent pair before using it. The historical `.9` endpoint shape still returns
`workspace_sync_update_required`; consumers must not guess missing fields, accept a second
dialect, or silently run a dirty fork as a fallback. Source-built integration evidence alone
does not prove that an existing daemon has loaded the new engine.

The first capable client imports the retired local existing-Session text/semantic stores and the
singleton new-Session draft into the canonical draft repository. It removes each legacy value only
after the corresponding canonical record is durably acknowledged, so an interrupted import remains
recoverable. The legacy readers are migration adapters, not parallel writers, and may be removed
when supported persisted local state no longer requires them.

The 0.3 upgrade is one-way: every component updates together, with no supported 0.2/0.3
coexistence or rollback to 0.2. Drafts created on 0.2 remain supported data. The 0.3 reader
validates and preserves the published 0.2 `machineId`, `serverId`, `agentId`, `backendTarget`,
`modelId`, and `codexBackendMode` fields; its UI projects only exact safe equivalents into
canonical execution, Agent, and native-model selections. Canonical 0.3 fields, including
explicit clears, win over predecessor values. Current new-Session authoring writes the
canonical V2 document; an unavailable V2 mutation keeps the local draft and is not retried
as a V1 write. Existing V1 documents remain readable through the current payload union.
Remove historical-data reader bridges only when those persisted drafts are no longer
supported inputs; the absence of old running clients alone is not a removal condition.

Draft documents preserve bounded unknown extension fields as JSON. This lets a client without a
newer composer contribution edit fields it understands without deleting newer semantic data; it
does not authorize that client to execute the unknown contribution. Raw generic-file bytes, local
file handles and URIs, credentials, secret values, and local presentation state remain outside the
compatibility shape. Plugin semantic attachments, mentions, fallback presentation, and opaque
execution-target-bound staged-media handles may round-trip; execution still fails closed when the
owning plugin or target is unavailable.

### Session-owned run input convergence (development)

The development Action contract sends Session-owned run input through
`session.message.send` with an optional strict participant recipient. Main
Session input omits the recipient. `execution.run.send` requires explicit
`sessionId: null` and retains direct delivery only for detached runs; its
`prompt`, `steer_if_supported`, and `interrupt` modes do not become Session
pending actions.

Attached `execution.run.send` calls receive
`session_input_target_update_required` before a direct send. The approved 0.2
compatibility adapter keeps the released request parser for this refusal; it
must not approximate the old delivery modes or retry against the main Session.
Remove that adapter only when the last supported 0.2 UI/CLI-to-current-daemon
attached-send direction closes. Existing run and transcript records remain
readable. Attached chat follows `session.message.send` Action settings, while
detached chat follows `execution.run.send`; settings are not copied between IDs.

Targeted admission requires the exact target Machine's `sessionInputAdmission`
revision 2 and the nested execution-run pending resource
`POST /v2/sessions/:sessionId/execution-runs/:runId/pending`. Released servers do
not match that nested route, so they cannot strip the target and report a
main-Session success. Missing support must fail before relay or mutation, without
dropping the recipient; a target send never becomes a main-Session send, and an
unavailable capability snapshot is withheld rather than published as a false
negative.

The reachable directions are:

| Direction | Required behavior |
|---|---|
| Released client main send → current stack | `required` — unchanged. Main input carries no recipient, takes no target query, and pays for no capability check. |
| Current client main send → supported released server/daemon | `required` — unchanged. The existing no-target path stays usable. |
| Current client targeted send → released or partial stack | `required` — fail closed before mutation with the operation-scoped `session_input_target_update_required`; no row, no relay, no recipient-dropping retry, and unrelated operations stay usable. |
| Released client attached `execution.run.send` → current daemon | `required` — the same operation-scoped refusal through the retained released request parser. Detached `sessionId: null` sends keep working. |
| Current target rows → released-server rollback | `unsupported` after activation. No dual writer, mirror, or rollback-only path exists for target rows; recovery is ordinary Pending state. |
| Released persisted rows → current readers | `required` — old pending rows read as the implicit main target (`targetExecutionRunId IS NULL`); transcripts, sidechains, and markers stay readable. Old terminal transcript rows have no server-private Run binding, so main-message retry remains compatible while a targeted terminal retry that cannot prove its exact target fails closed rather than inventing a match. |

The nested target resource, its strict body, and the plugin-facing recipient
projection are undeployed 0.3 development shapes: refine them in place at the
Action and admission owners rather than adding a reader for a superseded
intermediate. These are operation-specific development contracts; the composed
live target-send and mixed-version gates must pass before the feature is
described as available. The delivery semantics themselves live in
[Pending delivery architecture](pending-delivery.md#execution-run-targets).

### Deferred Action approvals (development)

Released `ApprovalRequestV1` Artifacts remain readable as history using their
released closed status vocabulary. They carry no current replay authority: a
current attempt to execute one fails safely as `approval_stale`. Current
effect-bearing approvals use strict `ApprovalRequestV2`, including the immutable
execution origin admitted before the user is asked to decide.

Current development creation derives one exact Artifact id from the captured
Home, Account, requester, request id, Action and destination subject. A retained
child can keep its root request id while naming a different Action/destination
and therefore different consent. Identical retries open and return the original
stored receipt, including decisions or settlement that won during creation;
different operands under that identity fail with `approval_request_conflict`.
An invalid proposed body fails before creation as `approval_invalid`, with
schema issue codes, paths and messages. An unreadable or invalid stored
body/header is also invalid; it is not evidence of different approved content.
The optional private V2 `requestInputDigest` binds original operands when the
stored review projection omits live-only secrets. It is never clear lookup
metadata. Built-in and contributed Action writers share this creation owner;
historical V1 and origin-less target requests keep their existing reader and
creation behavior. New deterministic approval ids use the UUID8/variant-a
Account-scoped namespace. The create-only `idScope: { v: 1, sourceId }` contains
only the previous public structural id. The canonical Artifact transaction
recomputes the new id with the authenticated Account and refuses missing or
mismatched scope for every new reserved-id create, regardless of Artifact kind.
Ordinary random ids and the existing UUID8/variant8 subspace remain accepted.
Creation first looks up the scoped id, then an owner-only legacy receipt; an
existing owner receipt keeps its exact id and private binding. Foreign granted
rows are excluded before opening their bytes. Stored links and normal granted
reads are unchanged. This is an unreleased development direct cut, not a new
released-client update floor or a second persistence format.

Approval is not an execution lock by itself. After an approval decision, the
existing Artifact is the durable effect-custody owner:

```text
open -> approved -> executing -> executed | failed | outcome_unknown
```

The executor must win the Artifact compare-and-set from `approved` to
`executing` before performing the effect. A duplicate caller reads the winner's
state instead of running the Action again. Current policy, credential, Home,
runtime, target, and resource authorization are revalidated against the stored
origin. In 0.3 development, only unsigned host-CLI requests for Account-placed
Actions with durable input custody gain app replay through the approving app's
authenticated Home adapter. Signed/external and Session requests retain their
exact admitting daemon, including Account-placed Actions. Machine-placed,
plugin and live-only-input requests likewise retain their exact-daemon or
admitted live invocation custody. The immutable input, Action id, requester,
Home and Account remain bound to the Artifact. One-time results reach only the deciding app's
`liveExecution`; Agent reads, observations and durable history receive the
Action's material-safe projection. If the
effect may have happened but terminal persistence cannot be proven, the
Artifact remains `executing` and later callers receive
`approval_execution_outcome_unknown`; they do not replay blindly.
Current V2 terminal receipts also record whether the Action effect was attempted.
Direct `approved -> failed` settlement records `effectAttempted: false`; terminal
settlement after the `executing` claim records `true`. Existing development V2
records without this presentation fact remain readable and do not gain inferred
execution history.

The current development V2 vocabulary also permits terminal `outcome_unknown`
from `approved` when a replay transport may have dispatched but its result is
unconfirmed, or from `executing` for a typed unknown result. It requires an
approve decision, unsuccessful confirmation receipt and
`execution.effectAttempted: true`; that flag permits uncertainty and does not
prove an effect ran. Local pre-dispatch refusals settle `failed` with their
typed reason instead. Existing terminal history remains authoritative and no
terminal status grants another execution claim. This is a refinement of the
unreleased 0.3 V2 lifecycle: current hosts/readers move together. Released V1's
closed status vocabulary, history and stale-replay refusal remain unchanged;
an older strict reader cannot interpret a V2 unknown record as execution
authority. No migration, V1 writer, compatibility adapter or retry is added.
The settling owner passes its observed status privately to the existing
Artifact writer. This is a restrictive host-internal CAS precondition, not a
new persisted or public wire field; it prevents a raced claim from becoming a
false pre-effect failure.

The development strict Action failure envelope carries optional boolean
`effectAttempted` from its producer. Replay admission refusals before effect
entry publish `false`; CLI, UI and external Action projections preserve it.
The outer failure object remains closed and opaque `details` retain their
existing policy. This is an output fact, never an authority-bearing input or
permission to retry. Daemons from `cli-v0.2.17` and
`cli-v0.2.17-preview.1` (`a2c45c86804b24e60ac0b76146a3ef36dfcaa15b`)
omit the field. A current deciding client treats an absent or malformed fact
after dispatch as unknown, rather than reconstructing it from an error code.
New development producers and strict readers load together; older strict
development readers may refuse an extended result safely. Released V1
approval history and the failure envelope's wire epoch are unchanged.

Canceling an approved but unclaimed V2 request preserves its approval decision
and settles it as `failed`, with `approval_canceled` and `effectAttempted: false`.
The same rule applies to development target/plugin approvals. Repeated cancel
or approve decisions return that terminal receipt. The transition owner rejects
this cancellation receipt once the request is `executing`; its Artifact CAS
also refuses a claim that races the cancellation write. Open requests retain
their existing `canceled` settlement, and released V1 history is unchanged.

The Artifact header is an index, not authority. Current readers hydrate the
body, validate its strict approval-family schema, and require every duplicated
header field to agree before presenting or acting on it. A contradictory or
unknown body/header combination fails closed.

Managed-Machine Delete approvals duplicate only a domain-separated subject key
for `(Home, managedId)` into that index. Accepted Delete retirement queries the
existing Artifact index by this exact non-content key, then revalidates the body
and uses the normal revision-fenced approval update. A transient refusal leaves
the accepted Delete successful; the next accepted-delete/currentness transition
retries the same lifecycle convergence without a timer or Inbox-side filter.

Project Service Starts in 0.3 development use the existing private
`approvalSubjectKey` header index to identify the SOURCE Machine/checkout before
mounting body readers. This private Home/Account-scoped index hashes only Machine
and checkout ids, contains no command or Service name, and grants no execution authority. A supplied hint must agree with
the strict V2 body. Headers without this development hint remain readable;
Project observation can reuse an already-admitted local body to select them,
but does not hydrate unknown identities across the Account. Released V1 history
and predecessor V1 writers are unchanged. A Service census shares demanded
Devcontainer child facts only for that observation; reconnect or a real later
observation reads them again, including after a failed read.

This is an in-place development evolution, not a second approval store or a
backfill requirement. Undeployed target/plugin approval schemas may be refined
in place through the same Artifact owner. Released V1 bytes and readers remain
the historical compatibility boundary.

For live-only target/plugin approvals in 0.3 development, the original admitted
invocation retains the confidential operands and the same approval Artifact id
through settlement. Its captured Account/Home writer publishes the terminal
outcome, effect-attempt fact and any admitted operation-credential identity on
that Artifact. Neither confidential input nor handler output is persisted by
this receipt path. Success, failure and uncertain execution retain the original
requester and execution origin; an unacknowledged receipt write reports
`approval_execution_outcome_unknown` without retrying the effect. Once the live
waiter is gone, another approval attempt remains `approval_stale`; history is
read through the existing approval reader rather than replaying the operands.

Storage proposals in 0.3 development optionally retain `storageRetryResults`
inside the same strict V2 Artifact. This is an append-only list of strict settled
Pile results, limited to the original execution's unsuccessful items with distinct
batch and Trash entry ids. The transition owner preserves the terminal status,
original subject, decision and execution; the field supplies no replay inputs or
authority. Existing V2 records without the field and released V1 history remain
readable. The predecessor has no Storage proposal or V2 execution contract;
current development V2 writers do not promise rollback to those V1 readers.

## Ephemeral Runner release compatibility (development)

`happier-runner` is a 0.3-only release product. Its strict V1 release manifest is
owned by `@happier-dev/release-runtime/releaseManifest`; the publisher validates
what it emits and the server is the only public-release acquisition adapter.
Activations pin product, version, target, and lowercase SHA-256, so an existing
activation never follows a rolling tag. The creator downloads the exact archive,
checksums, and Minisign signature named by that verified projection and applies
the same release-runtime verifier before local package assembly. It also requires
the archive basename to encode that exact product, version, and target before it
performs any network acquisition. An exhausted immutable release-tag `404` means
the version is not published; transport failures, other HTTP statuses, and
malformed publication metadata remain a retryable publication-unavailable result
rather than being reported as positive absence. The signed
checksum envelope carries the Runner archive's exact compressed byte size and
closed entry list (path, kind, expanded size, mode, and link target when
applicable); the release manifest and Home-safe projection must agree with that
signed metadata. Acquisition rejects compressed-byte overrun or underrun, and
assembly rejects any missing, extra, colliding, unsafe, or size-mismatched entry
before the package is usable.

Current 0.2 clients and servers have no Runner activation or runtime contract.
New clients hide Temporary computer against an old server; old clients continue
ordinary Session and persistent-Machine operations against a new server, and a
materialized Runner Session remains readable as an ordinary Session. No dual
Runner manifest, token, activation, or socket shape is retained solely for
unreleased 0.3 work. Existing Machines retain effective `persistent` kind.
Shared V1 manifests for released non-Runner products remain readable without
Runner archive metadata; those products neither emit nor interpret these fields.

The `EphemeralRunnerActivation` table is a 0.3-only Home-owned record with no
predecessor shape to read or write. Its strict V1 lifecycle advances one way —
`pending → claimed → consented → materialized` — and every pre-materialization
state can instead reach `closed` carrying one of `canceled`, `declined`,
`expired`, `revoked`, or `failed`; each closing transition is conditioned on that
pre-materialization set, so a materialized activation is never retroactively
closed. `apps/server/sources/app/ephemeralRunner/activationLifecycle.ts` owns
closure and erasure. Deleting the creator's draft closes that draft's
pre-materialization activations in the same transaction as the draft tombstone,
and Account erasure closes every remaining pre-materialization activation as
`revoked` and then deletes only `closed` rows. A materialized activation is
deliberately left to the Session deletion owner, which removes the row with its
Session (`apps/server/sources/app/session/delete/deleteSessionTree.ts`), so an
orphaned materialized row keeps blocking Account deletion instead of being
hidden by a cascade. Nothing outside 0.3 reads this table, so rolling back to a
build without the Runner contract leaves these rows unread rather than
reinterpreted.

The strict V1 activation-create request may carry the optional literal
`authorizeUnattendedTeamAccess: true`. Omission is the safe compatibility shape:
the activation remains usable for independently authorized personal/direct work
but cannot satisfy a restricted Team's authentication policy. When present, the
Home copies only current evidence from the verified creator credential into the
activation's server-owned snapshot. That intent and snapshot are never written
to the exported activation package or endpoint projection. The exact materialized
Runner token carries the currently valid evidence in signed V2 provenance; every
restricted Team selection, readiness, Session creation, broker open, and broker
effect re-enters the canonical Team-authentication qualifier.

The development-only Team source-health failure readers retain the existing
`connected_service_credential_reconnect_required` diagnostic in Provider errors,
broker refusals and `source_unavailable.reason`. Failure and runtime-issue
envelopes remain closed; the optional readiness reason does not add source
identity or grant authority. The generated SDK Action DTOs project the same
Protocol owner. Matching development producers/readers are required for the new
failure arm; existing failure reasons and healthy shapes remain accepted. This
is an unpublished source-contract correction, not a new released-client floor,
persisted-source migration or parallel failure vocabulary.

The development-only 0.3 Provider broker grant also carries the exact opening
signed credential's `initiatorTokenEpoch`. Broker open and every subsequent
request or model-catalog admission recheck it through the same Account revocation
owner as bearer authentication. Signing out everywhere therefore ends existing
broker authority without turning the tunnel-opening expiry into a runtime
lifetime. This is a strict direct cut: grants without the epoch are rejected,
not upgraded from current Account state. PAT credential-row revocation remains
independent; ordinary PAT bearers cannot open this broker route.

The published payload is never the bare Bun executable. Bun 1.3.5 established
that the standalone runtime exposes its embedded CLI dispatcher when `BUN_BE_BUN`
is inherited; the current 0.3 development pin reproduces that behavior through
`scripts/pipeline/release/bun-runner-hardening.test.mjs`, which reads the canonical
`apps/stack/scripts/provision/.bun-version`. Therefore the
shipped product is the Rust shell in `apps/cli/runner-native-shell`, which refuses
unknown arguments and clears the environment before spawning the Bun core as a
nested sidecar. Release admission rejects any candidate that reaches the embedded
dispatcher. Per target the archive contains exactly one payload root beside the
adjacent `happier-runner.activation.json` the creator client adds: Linux ships one
AppImage named `happier-runner` that contains the core as a bundled sidecar;
Darwin ships `Happier Runner.app` with the core at
`Contents/MacOS/happier-runner-core`, which the builder asserts before archiving.
`packages/protocol/src/ephemeralRunner/runnerPackageLayout.ts`
owns that layout and the publication-eligibility list;
`scripts/pipeline/release/lib/runner-packaging.mjs` is the release-side mirror the
builder, asset preparer, and admission all consume, pinned to the Protocol source
by `scripts/pipeline/release/runner-native-shell.test.mjs`.

Linux x64 is the first publication-eligible build/publish/smoke target. This
eligibility lets the release owner produce and validate an immutable candidate;
it is not a Home availability claim. The Home projects only exact records from a
verified immutable publication. The `sessions.ephemeralRunner` Home feature is on
by default, with `HAPPIER_FEATURE_SESSIONS_EPHEMERAL_RUNNER__ENABLED=0` as the
operator opt-out; publication eligibility and release checks are separate from
that feature decision. Linux arm64, Darwin x64/arm64, and Windows x64 retain the
same product/manifest target identities, but must not be projected as available
until their immutable native artifact and applicable platform-signing evidence
are published. Building a target does not make it available: the builder can
compose the Darwin shell, but only with a real Developer ID
identity and notarization output, and it fails closed rather than emitting an
unsigned or ad-hoc signed Runner. Darwin trust is owned by
`notarize-standalone-binary.mjs`, which signs the JIT-entitled nested core before
sealing the app, notarizes, staples, and records schema-3 `app-bundle` evidence —
the released schema-2 standalone-payload evidence keeps its own online-ticket
contract and is not reused for a bundle. Windows' two-executable portable,
no-installer shape is approved (Lane 13 A05). It remains unadvertised until the
existing release producer and admission owner implement and verify timestamped
Authenticode for that shape and publish an eligible immutable record. Missing
signing integration is implementation work under that approval, not a request
for another product amendment or permission to bypass admission with a build flag.

The Home feature decision is on by default;
`HAPPIER_FEATURE_SESSIONS_EPHEMERAL_RUNNER__ENABLED=0` is the operator opt-out.
Current source contains the authenticated pre-Session credential selection, Pool
source-eligibility and exact-Machine binding, signed broker-readiness
authorization, and production Runner consumer. Those source paths continue to
fail closed on missing or stale readiness. The composed creator-to-endpoint-to-Session
journey on a loaded runtime and the platform-trust evidence above are release
checks owned by release automation and human QA, separate from the feature
decision and from an availability projection that still requires an exact
artifact in a verified immutable publication.

Runner Follow consumes the ordinary Session Follow preparation contract rather
than defining a Runner protocol. The exact method is
`daemon.sessionFollow.sourceKey.prepare.v1`, with strict Protocol request,
authorization, and `installed` response schemas. Lane 09 owns that contract,
hydration, current-edge reconciliation, and accepted-effect acknowledgement.
The Runner composition owns one exact-Machine receiver, one process-local source
material resolver, edge-removal pruning, reconnect registration, and terminal
disposal. It has no Runner engine, Runner store, durable source-key cache, or
second Follow loop. The unreleased, closed V1 source projection requires each
message's nullable `localId`: an existing stable id preserves original ordering,
while explicit null identifies a legacy row. Omitting this field is invalid,
not permission to consume an unadmitted original as terminal context. Current
server and Runner readers move together under the 0.3 direct cut; no persisted
format or database migration changes. The prospective `../0.2` source inspected at
`7e1ce993c408c0f634b81267aac2bcd8e7859975` has no observed Runner or preparation
method; new clients therefore fail closed against it instead of negotiating a
parallel format. Refresh that dirty sibling's relevant bytes before activation.

In unreleased 0.3, the existing post-commit source-key preparation `waiting`
result may also carry a bounded `cause` diagnostic. Its strict Protocol schema
accepts omission from earlier writers and rejects arbitrary error text or extra
fields. Follow partial results and committed manager/spawn results retain the
same cause. These codes identify the observed preparation branch; they grant no
authority and do not promise that a retained creation settlement will refresh
when a Runner later registers. The private preparation RPC request,
authorization and installed response remain unchanged.

In unreleased 0.3, the closed `SessionTurnMutationV1` and receipt envelopes also
admit the host's `session_opened` action. It retires only an older startup issue
from the Session projection after confirmed native open; the historical failed
turn remains readable. CLI producer, durable transport and Home consumer update
together under the all-component direct cut. The scoped clean `../0.2` frontier
at `a487b2ec48873bfc0ad67bb1d31be0a2cffd3c92` lacks this action; current readers
still accept its existing mutations, while mixed 0.2/0.3 components and reverse
writes are unsupported. The existing receipt table records the new action; no
persisted fields or database migration are introduced.

The local UI spawn-setup projector retains `RPC_TRANSPORT_UNAVAILABLE` in the
existing optional `launchError.rpcErrorCode` closed enum. This admits the
existing transport code without changing a daemon producer; the prior timeout
and `RPC_OUTCOME_UNKNOWN` values remain accepted.

## Plugin Platform direct-cut frontier

### Saved provisioner size roles (unreleased 0.3)

The shared Action input-hint field grammar admits optional `role: 'cpu' |
'memory' | 'disk'`. Roles describe saved numeric provisioner choices only: CPU
is cores; memory/disk are GiB unless the existing `unit: 'bytes'` is declared.
Strict manifest admission rejects unknown roles. Stored declaration readers keep
their existing tolerant projection; declarations without roles retain generic
saved-choice presentation. Localization preserves roles through the shared hint
normalizer. The receipt and preset offer share one size projection and the
existing native-size formatter; they do not infer roles from provider ids or keys.
Input fields and their executable Action/manifest envelopes remain closed; this
optional presentation fact grants no execution or credential authority. Matching
0.3 Protocol, SDK, plugin declarations and UI reload together under the direct
cut, with no new epoch, migration or rollback adapter. Bundled declarations must
be regenerated by their publication owner before loaded-runtime validation.

### Generic plugin publication (unreleased 0.3)

The closed development publication inputs and typed results in
[`pluginPublication.ts`](../packages/protocol/src/actions/specs/pluginPublication.ts)
add `plugins.dev.publication.inspect`, `plugins.dev.publication.prepare`,
`plugins.dev.publish`, and `plugins.dev.publication.status` to the existing plugin
development Action family. Matching UI, CLI/executor and generated Action
consumers move together under the unpublished 0.3 direct cut. Public inputs
select an npm profile and reviewed effects, never credentials. Direct success,
`awaiting_maintainer`, `review_required`, conflicts and uncertain effects retain
distinct result semantics; older consumers must not reinterpret them as success.
This adds no persisted publication record, server route, runtime ABI or wire
epoch, and does not claim availability in a released SDK. Existing npm profile
persistence and ordinary package/manifest formats retain their owners.

The existing npm-profile sign-in Action also admits machine-config and browser
login intent under this direct cut. The Machine RPC distinguishes a browser
challenge, cancellation and unsupported web login from completed sign-in. Its
private completion URL and acquired token never enter the public Action result;
machine-config login retains a source reference at the existing profile owner.

### Operations trigger Events (0.3 development source)

Machine presence Events `machine-offline` / `machine-online` retain the existing
timeout and recovery decisions in nullable `Machine.presenceTransitions`.
The owner-approved append-only `20261102101034_add_machine_presence_transitions`
migration adds the field for PostgreSQL, MySQL and SQLite without backfilling
initial-state Events. The source stack database owner deploys pending migrations
before producer/catalog reload; shared-DB consumers never migrate that database.
Existing presence wire DTOs remain unchanged. `machines.presence.read` exposes
only structural latest offline/online occurrences through existing Machine
access. Enrollment starts at the current revision; stable occurrence identities
use the committed revision rather than heartbeat clocks. The retained pair
coalesces overwritten cycles rather than recording every transition.

Machine services declares `health-check-failed`, `health-check-recovered`,
`deployment-failed`, `deployment-succeeded`, `promotion-completed`,
`deployment-cancelled`, `deployment-outcome-unknown`, `rollback-completed`,
`managed-machine-setup-failed` and `mcp-update-available` through the ordinary plugin Event
catalog. Health payloads contain structural subject/check identity, transition
and observation time; endpoint results and evidence stay at the daemon. The
incumbent `health-status` subscription uses the same producer and cursor.
The saved-health source configuration and cursor format are unchanged.
Deployment Events project the existing terminal receipt, including its recorded
failure phase, and wake through the existing receipt account-change stream.
Their configured observation start survives restart; occurrence identity and
ordinary Event admission retain replay deduplication.

Managed setup retains optional `settledAtMs` on the existing operation result;
MCP registry origins retain optional `upstreamObservedAt` on changed upstream
observations. Duplicate reports/checks retain those values. Existing rows without
the fields still parse, but cannot manufacture historical Events. Setup uses the
operation id for replay; MCP uses the retained observation clock and installed /
upstream reference digests. Both consume the latest retained fact; this adds no
transition history or promise to recover an overwritten fact. Committed Account
entity ids reach the observers through the new strict content-free
`@happier/account/entities-invalidated` Host hint.

This is the unpublished 0.3 direct cut: plugin declarations, strict payload
readers, optional catalog `event.localizedPresentation` and daemon Host receipt
hints move together without a new run kind or compatibility fallback. The
presence extension requires the additive column migration described above;
receipt, setup and MCP Events require no schema migration. A read-only check of the prospective `../0.2`
source at `67123c84ca168ac6f7847532a531eaa7f5566111` on 2026-11-02 found
no Machine services plugin in that source tree; this is source evidence, not a
claim about deployed artifacts or published SDK availability.

### Provider continuation authority (0.3 development source)

The continuation capability and correlation events extend the strict
`AgentSessionRuntimeEventV1` contract. They require a matching development
host and SDK: an older strict consumer cannot safely ignore events that
establish turn ownership. This is a coordinated change within the unreleased
Plugin Platform direct-cut frontier, not an independently negotiated deployed
protocol version. No persisted authority, historical replay grant, 0.2 rollback
adapter, or compatibility alias is introduced.

The 0.2 implementation retains permission context inside its shared ACP owner.
The 0.3 implementation uses the existing host turn invariant and native Session
composition instead; the plugin supplies native correlation only. Both use
Kimi Code 2.4.1's journal protocol 1.5 alongside the same executing ACP session.
Unknown journal versions fail the session rather than admitting late work
without an understood causal origin.

### Project page author contract (0.3 development source)

Source repository admission canonicalizes the known legacy SCM hosting-provider
ids through the existing protocol alias owner. Source create, update and stored
reads share the credential-free repository selector, so accepted development
records with `github` resolve to the registered qualified identity before clone
dispatch. Custom provider ids remain exact; clone discovery has no alias table.
This does not add a migration or an older-binary rollback contract.

The development `appPage/project` extension retains manifest V2 and the Host UI
context V1 vocabulary; these wire names are independent of package SemVer.
Executable View declarations, policy expressions, qualified destinations, rich
Project targets and `projects.pages.list` inputs/results are closed, including
the accepted Source, repository and strict checkout shapes nested inside them.
The Project target uses `projectKey` with optional qualified `source`, `checkout`,
`repository` and observed `branch`; current-source Project mounts migrate together. Widget owner
fields retain their own existing names through that same context adapter.

Contextual Resource session/surface arms accept optional `target` using that
same strict public target owner. Session targets add optional repository, branch
and `headOid`, with an exact sessionId match on the Session Resource arm. Readers
still accept prior contexts without target; global context is unchanged. New
context facts do not become credential or effect authority. One declaration-owned
`counts` binding can select an ordered labelled record from a dynamic JSON
Resource; the old strict scalar `countResourceId` shape remains supported,
mutually exclusively. These are coordinated development-source extensions, not
new claims that an older strict host accepts their additional fields.

The new target and repository policy fact cannot be safely ignored by an old
host. Existing engine/toolchain and artifact `hostUiApiRange` admission must
reject an unsupported declaration, never reinterpret it as an app page. The new
host preserves target-less app shorthand and existing valid app URLs. No
released old Project-context reader has been established, and current `dev` to
the predecessor SDK rollback remains unsupported under the direct-cut ruling.

Read-only source-frontier verification on 2026-10-24 resolved origin's immutable
`cli-v0.2.17` and `server-v0.2.17` to
`a2c45c86804b24e60ac0b76146a3ef36dfcaa15b`, and `ui-web-v0.2.19` to
`63829e3cd6a8f1f48b10891af0c8b2313e51ac7e`. The prospective `../0.2` checkout
was `2bf968563bf2015455c0cd54bcc74e91f67891b9`; its exact plugin/SDK/page/pinning
corridor had no staged or unstaged changes. These observations establish a source
basis, not deployed artifact support or a published SDK census. Package API
regeneration, published SemVer review and loaded-platform certification remain
separate checks; no compatibility shim or new epoch is inferred from missing
publication evidence.

The Plugin Platform simplification is a direct cut within the unreleased 0.3
development line. The current working tree was rechecked on 2026-09-24 while
the checkout HEAD was `08b245d0337e7ee6b1bad249cdb79081b809449b`.
The repository-local immutable source tags rechecked at the same time were `cli-v0.2.11`,
`cli-v0.2.11-preview.2`,
`server-v0.2.11`, `server-v0.2.11-preview.2`, `ui-web-v0.2.11`, and
`ui-web-v0.2.11-preview.186` at
`98ea8fb76733b1dd785d38c31360179cafa84824`; `ui-mobile-v0.2.0` at
`e49afc11e8d8c068043bc108722ca2ed90b11d1d`; and `ui-desktop-v0.2.0` at
`ed11a23e45fb18b6ef7a7f13c256ab148c8d50a3`. Their app and package trees
contain none of the current Happier Plugin Availability/materialization,
`.happier-plugin` manifest, Provider-contribution, installed-generation,
occurrence/currentness, or Plugin UI artifact contracts. The release registry
uses `plugin-sdk-v` for the separately published Plugin SDK pair, but the local
tag set contains no such immutable tag. This is repository-local source and
publisher-contract evidence; it does not claim an independently queried
deployment or npm-registry state.

The current development Agent Session output contract accepts omitted host `turnId`
for Session-scoped transcript output, and treats a witnessed `sidechainId` as Session
scope even when an originating host turn is recorded. Existing foreground writes with
required turn identity remain accepted unchanged; foreground lifecycle events still
require that identity. This is an in-place development contract change under the
Plugin Platform direct-cut basis above, not an established released predecessor
migration. See [runtime scope](runtime-core.md) for the consumed host behavior.

The prospective `../0.2` source was inspected read-only on branch `dev` at
`439125d17582cdfa7534a156737d52559565353b`, including the committed tree,
zero staged changes, four tracked unstaged changes, and no untracked files. Its
dirty paths cover the Codex app-server and request-user-input implementation and
tests, outside the Plugin Platform corridor. Neither the
complete on-disk app/package tree nor the unstaged diff contains the Plugin
Platform identifiers above, Re.Pack/Module Federation runtime identities,
`immutableGenerationId`, `hostUiApiRange`, or a plugin persistence model/file.
Refresh this comparison before activation if that moving predecessor changes.

Consequently there is no released or prospective old/new Plugin Platform wire
or persistence direction to preserve through aliases, dual writers, or
framework-version admission. Managed third-party installation generations are
the current design's immutable package custody, not a predecessor
compatibility shim. Development source is evaluated into a process-local
occurrence; its last accepted occurrence is not persisted for restart
recovery. Current-development `AccountPluginIntent`, `AccountPluginRelease`,
`AccountPluginUiArtifact`, and `PluginMachineMaterialization` rows, managed
third-party generation-store files, and digest-keyed UI artifact caches remain
forward-only current data; they do not create an old-reader or old-writer
direction for `../0.2`.

The repo-local development Stack uses dedicated `mac-host` server placement.
Live-process file-descriptor evidence from server PID 51343 identifies its
active SQLite database as the target-scoped
`/Users/leeroy/.happier/stacks/repo-dev-a1cc5e0671/cli/stack-state/dev-target-mac-host-dfcbfd6a94d90609/server-light/happier-server-light.sqlite`.
A read-only check on 2026-09-23 found all 118 current source migrations applied
with matching checksums, including the `d484…` automations migration and the
`20260920230000_migrate_session_subagent_source_custody` migration applied on
2026-09-21. The current `reporterSourceCustody` schema is present, and SQLite
`quick_check` and foreign-key checks are clean.

The live ledger has 122 applied rows. Its four ledger-only development
identities—`20260810140000_add_event_automations_v1`,
`20260810210000_contract_session_turn_anchor_projection`,
`20260813110000_add_automation_event_source_status_reporter_immutable_generation`,
and `20260815180000_backfill_automation_execution_dispatch_state`—refer to
source directories consolidated away during development. Their presence alone
does not establish a deploy blocker; the canonical deploy result owns that
decision. The parent-level mac-host database and the Linux-local database at
`/home/leeroy.guest/.happier/stacks/repo-dev-a1cc5e0671/server-light/happier-server-light.sqlite`
are inactive files, not the current Stack migration target. None of these
development-only ledger shapes is a released compatibility direction or
justification for a product alias, bridge, or reader.

### Automatic Session turn transcript-anchor projection (0.3 development)

The server automatically converts historical Session turn anchor projections
before starting its API, using the existing JSON-derived converter in bounded
transactions. A restart safely rescans the rows; completed updates are idempotent.
This is the same path for fresh installs and forward upgrades from 0.2 on
PostgreSQL, SQLite, MySQL and PGlite. No operator command, approval environment
variable, cache marker or removed migration identity activates the projection.
The current capability payload advertises turn projection directly.

The external-shareable transcript still checks each Session's legacy and
inconsistent rows in its read snapshot. An unconverted row holds the cursor at
the first unsafe page sequence; removing the global activation switch does not
relax these publication or turn-settlement barriers. Existing anchor JSON stays
the authority; scalar ranges remain its query projection. Conversion does not
rewrite message content or introduce a second transcript.

### Collection readers and answering-client routing (0.3 development)

Independently upgraded apps retain their compiled Collection reader refs. A
current writer admits an exact compatible reader through Data's existing access
resolver or refuses that Collection with `collection_update_required`; the app
must not substitute the writer contract. No released 0.2 Collection/Run-on
contract was found in the inspected clean predecessor corridor at
`f18aba940c5c56e5b24454e176c836c171098a2d`; no 0.3 intermediary shim is retained.

Collection GET responses require the producer's `absenceEpoch`, including when
`row` is null. A missing epoch is invalid; readers do not invent epoch zero for
an unpublished intermediate response.

Exact answering-client selection is authority-bearing and cannot be an optional
field an older relay silently ignores. The canonical reverse RPC transport uses
the `answering-client.v1/` method prefix plus a closed `answeringClient` envelope.
The current relay normalizes this operation into the incumbent authenticated
Machine continuation and applies the selector before dispatch. A relay without
that operation refuses the unknown method without executing the mutation;
the caller reports `client_routing_update_required` and never retries through
unselected delivery. Client-routed UI Actions accept exact `clientId` in their
closed input, including reads. Without it, current selection uses a sole eligible
client or the unique latest focus transition stamped by the existing `ui-focus`
push; missing or tied history returns `client_ambiguous` with candidate ids and
the `clientId` remedy. Optional candidate metadata in older ACKs may be absent;
that remains typed ambiguity. Updated strict Action readers are required for the
new selector field; an older reader refuses it rather than silently rerouting.
Exact socket addresses expire on reconnect,
and a missing selected client refuses without replacement. No persisted format,
Run-on writer or store is added.

### Spaces membership and saved lenses (0.3 development source)

Session Spaces retain optional membership mode and historical Home/Account-
qualified tag references in the existing catalog. Catalogs without membership
keep their saved-filter behavior. Current membership derives from all matching
typed internal-tag relations at the Session's own Home/Account, including tags
created by overlapping first preparations. The marker qualifies the Space and
its catalog Account; tag content uses the existing Plain/E2EE envelope.
Historical catalog references remain readable and survive deliberate mode edits.
The current closed catalog mutation schema rejects `associateTag`: Add, Move,
remove and New Session write organization assignments without automatic Account
settings writes. Move and remove clear all matching source tags. Ordinary-label
edits preserve internal assignments, and membership operations preserve ordinary
tags through the organization writer.

The closed filtered-list query adds an optional `membership` selector only when
the Home advertises `sessions.filteredListing.membershipSelectorVersion: 1`
alongside its enabled bit. An older Home is visibly unavailable for membership;
the client never substitutes an unfiltered GET. The selector unions the saved
structural lens with explicit assignments before pagination, then intersects
ordinary refinements and fixed access/context restrictions. A missing smart
branch matches nothing. An unavailable smart producer reports the optional
`membershipUnavailableReason` while retaining proven manual members. Raw viewer
tag ids are Account-scoped facts, not decrypted labels or shared membership.

The new client-owned `session.space_membership.set` Action uses the existing
approved Action and Account reverse-RPC path; unknown older Action hosts refuse
it. Existing full-set tag writes remain supported alongside explicit add/remove
intents. No migration, second membership store or rollback writer is added.
The scoped-clean moving predecessor at
`105df9f060c8b9d3ff8281f1f0922141d6033906` replaces all tag assignments on an
ordinary-label edit and cannot classify the new hidden display content. Its
writing newly-created 0.3 membership data is outside the standing one-way,
all-component upgrade boundary; forward use of its ordinary tag data remains
required. This is source-contract evidence, not release certification.

## Private Account notice Investigate operand (0.3 development source)

The existing C1 header/body pair adds optional `investigation`, containing only
a closed `alertEntry` operand with the canonical bounded entry reference and
configured-source UUID. New readers accept its absence; older C1 stored readers
drop the unknown field from both projections. Recognized operands remain closed
on stored reads, are sender-plugin bound and must match between header/body.
They are data, not Session, Agent, placement or permission authority; the
existing configured Triage Action re-admits the native source and choices.
The SDK send input is strict, so a host predating this unpublished author
extension refuses the unknown input instead of falsely acknowledging custody.
No new wire epoch, retained record rewrite or reverse-development SDK adapter
is introduced. The inspected moving predecessor at
`285ee7c5acb3bea1489896a254e4445f2483a213` has no C1 notice owner; its clean
generic Artifact header retains unknown metadata without interpreting it as
routing, and its body remains a string.

The same development C1 pair accepts optional ordered `recoveryChoices` (one to
three) for an Environment's `deployment_failed` condition. Each recognized
choice is closed: the current `deployments.rollback` input, with or without its
optional backup reference, or `inbox.notice.dismiss` for this exact Artifact.
Backup failure notices can also offer the existing `deployments.backups.run`
input captured by the native backup owner. Unknown outcomes never offer replay.
Missed-backup notices consume Automation's exact due/start projection and the
backup history owner on existing controller wakes. They offer the same run
operand as “Run backup now”; later successful history resolves the same backup
condition. This adds no timer, poller or second schedule/history store.
The Environment page's optional `deploymentId` selects the existing receipt
route. Failed deployment settlements take their rollback choice from the rollout
owner's recorded `rollbackTarget`; a first failure without that target offers none.
Deployment service-health notices use the same ordered choices for the existing
`deployments.restart` input and that rollout-owned rollback target. Restart
operands are bound to the notice Home, Environment and native service identity;
the service owner's current row supplies its generation and restart capability.
The existing Machine metadata projection supplies display names. Unavailable
names are shown as unavailable rather than exposing raw Machine identifiers.
These closed routing and Action operands require matching development Protocol,
CLI and UI readers under the unreleased 0.3 direct cut; no new epoch or adapter
is introduced. The recovery-choice renderer remains separate UI integration.
Header and body must agree. Older stored C1 readers drop the entire unknown
presentation field; new readers accept its absence and reject unknown Action or
input members rather than interpreting them as authority. These are V1 notice
data, not a new wire epoch or SDK send capability.

The host writer resolves the retained Artifact identity before constructing a
dismiss operand. The UI reopens the displayed revision before invoking a
choice through ordinary Action policy; the Account-placed dismiss Action
rechecks private ownership, current Account custody and Artifact revision at
the existing CAS writer. Dismissing an active failure does not assert recovery.
This is development source support; failure-producer and rendered choice
integration are separate from the operand contract. The scoped-clean moving
0.2 predecessor at `bd96136cd37af7f48e5d84750cff1885e7dbeac4` still has no C1
owner; its generic Artifact header preserves unknown metadata and its body is
opaque. This is source inspection, not an executed predecessor-binary claim.

The development committed-health controller RPC retains V1 and carries the
Machine/Home ids, Artifact id and closed Artifact revision only. Both request
and revision remain closed; the retired duplicate `opening` payload is rejected.
The matching development sender and receiver move together, with no persisted
format change or reverse-development adapter. The inspected clean scoped 0.2
frontier at `fd3f03529d96e899e95c8b384f5843340a1339c6` and immutable
`cli-v0.2.17` / `cli-v0.2.17-preview.1`
(`a2c45c86804b24e60ac0b76146a3ef36dfcaa15b`) have no corresponding C1 delivery
schema or receiver in the inspected paths. This is source evidence, not a
predecessor-binary or loaded-runtime claim.

## Follow Run refusal target binding (0.3 development)

The existing Run occurrence-route V1 error envelope stays closed. Its optional
`targetMachineId` is a server-visible, non-content availability binding, returned
only on an authorized Session-backed `409/source_unavailable` and only when the
request opts in with the closed query `includeTargetMachineId=true`. The target
is the canonical committed Session placement already read by the route; it grants
no access, execution authority or placement choice. The optional `releaseReason`
query is a closed code projected into the existing completion record only.
Both controls are optional and the strict request-body unions stay unchanged.

The opt-in matters: prior 0.3 development daemons strictly reject unknown refusal
fields rather than dropping them. They omit this query and receive their original
fieldless response, not a silently incompatible extra field. Prior servers ignore
the query and return the fieldless refusal that a new daemon still accepts; its
held reader then keeps broad Machine recovery. No retry or second transport is
needed. A hinted refusal instead releases on that target Machine's reconnect,
the exact Run event, or Account reconnect/full recovery. Unknown query properties,
malformed declared controls and unknown reason codes are not admitted by the new
closed query schema.

The inspected moving 0.2 predecessor at
`285ee7c5acb3bea1489896a254e4445f2483a213` has no corresponding transport,
daemon reader or server route; those exact paths have no staged or unstaged edits.
The inspected CLI/server stable and preview `0.2.17` tags resolve to
`a2c45c86804b24e60ac0b76146a3ef36dfcaa15b` and also lack this corridor. These
source observations do not establish independent artifact/deployment provenance
or a released C1 contract. The actual prior-development strict-parser and
query-ignoring-handler checks own the reachable skew claim. This is an additive
opt-in within V1, not a new wire epoch, persistence format or SDK ABI.

## Follow Session projection hints (0.3 development)

The 0.3 development Session AccountChange hint retains its existing open metadata
slot and adds advisory `followSourceChanged: false` plus the bounded integer
`followSourceUnchangedSinceCursor`. The outer change identity and cursor remain
unchanged. The publication owner derives the latter from the existing Account
cursor before a run of projection-only writes; it is not another delivery cursor.
Current daemon readers suppress Follow traversal only when their consumed feed
range covers that preceding source change. Missing, malformed or older hints
conservatively retain traversal. The optional local Session notification carries
the source decision and an independent receiver-availability decision. These leaves grant no access or delivery
authority, and do not add a store, migration, transport or SDK operation. The
scoped moving 0.2 predecessor inspected at
`a4c8a3a1746a59d9d8d0318a643b69099b3880bb` has no Protocol changes directory or
Session-change callback; its dirty Machine-client work does not implement this
Follow seam. This is a development source contract, not a released availability
or reverse-development rollback claim.

Receiver lifecycle producers additionally publish the advisory boolean
`followReceiverAvailabilityChanged` in that same open hint. Publication retains
true through coalescing and associates it with the original existing Account
cursor, `followReceiverAvailabilityChangedAtCursor`; a reader that already
consumed that event receives false even when a later title retains the hint.
Missing fields from older servers retain a bounded own-receiver
`legacy_unqualified` release only while original admission is held. Consumed
Follow progress is not availability. These optional presentation leaves are
safely ignorable by old readers; the closed Session-deletion hint remains exact.
No wire epoch, transport, store, timer or Account setting is added.

Active publisher touches no longer write a durable Session publication in 0.3.
Released UI `ui-web-v0.2.19` (`63829e3cd6a8f1f48b10891af0c8b2313e51ac7e`) shared
viewers kept runtime freshness from those updates because heartbeat ephemerals
were owner-only. Under the 2026-10-26 owner rule, 0.2 and 0.3 components are not
mixed, so 0.3 delivers the active heartbeat to its whole publication audience as
the existing `activity` ephemeral (`thinking` omitted) and persists only the
liveness fence. Inactive → active recovery, retirement and expiry keep their
durable publication and Follow availability. Persisted 0.2 data is unaffected;
no wire field or schema changes.

## Browser recording and diagnostics (unreleased 0.3)

The closed V1 recording-list Action input and Machine RPC request require
`browserSessionId` beside `viewId`. The matching daemon and UI adapters move
together under the unpublished 0.3 direct cut; omitting Session scope is rejected
rather than listing recordings from unrelated Sessions with the same view id.
This is an identity-bearing required field, not an ignorable extension. Recording
results and ID-addressed status/Stop/Cancel shapes are unchanged. The scoped-clean
moving `../0.2` frontier at `2b8fe93db6cb8ec2969f81e738a2f818a7dd8106`
has no browser recording protocol or daemon recording owner at these paths.
No persistence migration, wire epoch, compatibility adapter or rollback path is added.

The unreleased recording writer adds optional `browserRecording.outcomeReason`
to the existing Session media item, using the canonical recording outcome enum.
The lifecycle chooses the reason when capture stops, before persistence; transcript
media readers present `policy_revoked` as a privacy stop. Existing media without
the optional field remains generic and playable; filenames and captions never
infer a reason. The scoped-clean predecessor media schema at
`fde87977487081701c4e9471f160f4a4a9982914` has only image media and no browser
recording producer. This coordinated 0.3 development-source cut adds no migration,
new enum, wire epoch or compatibility adapter.

The same unreleased recording cut removes the dormant `paused` status from both
recordings and terminal results, the `view_hidden`, `view_parked`, `view_suspended`,
`view_closed`, `host_lost` and `adapter_lost` outcomes, and the unused recording
policy variants `sensitiveOrigin`, `sensitiveFieldsPresent` and `ephemeralOnly`.
The daemon's uncalled lifecycle API is removed; current UI readers and generated
SDK recording DTOs consume the narrowed closed V1 schema together. Browser-context
privacy and browser-surface lifecycle contracts remain separate. `completed` and
`expired` retain their existing stored-media reference rules.

The same development cut adds an exact-view diagnostics request and revision watch
to the existing closed Machine RPC. The daemon store owns actual-change revisions;
the UI bootstraps once and waits on its scoped subscription. Machine-wide snapshot
requests remain for existing diagnostics callers. The scoped-clean predecessor
above has no corresponding diagnostics protocol, daemon handler or UI reader at
these paths. These changes add no persisted format or SDK epoch and retain the
existing viewer-party redaction before egress.

Managed-browser discovery in this same development cut preserves the daemon tuple
in the optional `streamedBrowser.daemonView` object (`browserSessionId`, `viewId`).
The target and nested identity object remain closed; the whole tuple is present
or absent. New workspace readers retain tupleless saved targets, but those tabs
cannot identify a daemon view: close and reopen them from current discovery.
New discovery writes the tuple, and the opener uses it for both Session and view
identity rather than deriving either from an opaque stream id. The predecessor
frontier above has none of the target schema or workspace producer/consumer paths.
Current 0.3 readers and generated SDK DTOs move together under the direct cut;
the routing identity is not an ignorable extension for older closed readers.
No migration, alternate routing owner or wire epoch is added.

## Service Move setup consent transport (unreleased 0.3)

The closed native Service Start request adds optional `setupReview`, using the
existing setup review schema. Move's child producer carries its prepared review
in the existing signed child operand. The receiving Move path reconstructs that
prepared root only for its admitted child; SOURCE's live Start claim still checks
the exact admitted input before execution. Ordinary public Start input cannot
grant consent, and the original signed Move envelope is unchanged.

Matching Protocol and SOURCE/WORKER daemons reload together under the unpublished
0.3 direct cut; earlier strict development Start readers reject the new field.
New readers accept requests without it. No persisted format, wire epoch, approval
step or new proof carrier is introduced. The inspected `../0.2` frontier
`7b37d65ca75e58560f8f3ca850958ac5407d2e75`, including scoped staged and unstaged
paths, has neither this native launcher schema nor the Move contract; no
predecessor adapter is introduced.

## Conditional Machine source declarations (unreleased 0.3)

The existing targeted-contribution RPC accepts optional `sourcePluginId` and
`knownSourceRevision` selectors for source-declaration reads. Full replies carry
`sourceRevision`; matching revisions return the closed
`sourceDeclarationsUnchanged` variant. Readers accept an unversioned full body
but cannot retain it for conditional reuse. Protocol and CLI daemon/Account
runtimes reload together; older strict development request readers reject the
selectors. Endpoint authorization and native Action admission are unchanged.
The inspected `../0.2` frontier `57cd3db058af7767335d6d5a4ed44904460c50bb`
has no tracked source-declaration protocol at this path and no scoped working
changes. No predecessor adapter, capability bit or persisted format is added.

Full source-declaration replies also retain optional `unavailablePlugins`, the
admission owner's closed plugin-id/code diagnostics. Conditional revisions include
these exclusions so an unchanged empty declaration list cannot retain an obsolete
disabled reason. Account readers retain declarations and diagnostics together;
older replies without diagnostics stay readable without an invented cause or
Request ID. Matching development Protocol, daemon and Account runtime readers
reload together: older strict readers reject the added response field. This
unpublished 0.3 direct cut changes no SDK wire epoch, authority or persistence.
The scoped-clean `../0.2` frontier `dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf`
has no tracked source-declaration protocol or Account reader at these paths.

## SDK protocol evolution

Unreleased 0.3 receipt metadata accepts optional `restoreBackupId`, retaining the
opaque backup selected at rollback admission. Existing receipts without it remain
valid; the additive nullable Deployment column leaves historical rows unset.
Emitting this field requires matching development server, Protocol, UI and daemon
readers because receipt schemas are closed. There is no released wire change or
mixed-development adapter.

Unreleased 0.3 requester registry reads may carry the private
`registryThemeContent` operand in the original Account envelope. E2EE requests
keep it inside the encrypted payload; the receiving daemon opens it into host
context. Ordinary registry Action input remains metadata-only. Matching
development UI, Protocol and CLI readers must reload together: older strict
plain-envelope readers reject the added operand, and older encrypted readers do
not implement it. This adds no Action id, stored format or released ABI change.

Unreleased 0.3 preparation ready results accept optional `artifactSizeBytes` from
native artifact inspection. The existing private prepared state retains the same
optional measurement; older records without it remain readable and unknown. The
closed native result schema requires matching development Protocol, SDK and
provider manifests when the measurement is emitted. No released wire epoch,
new store, migration, mixed-development adapter or gate is introduced.

Unreleased 0.3 service-launch environment contributions use the canonical
`serviceLaunchEnvironments` manifest family and `activate(api)` registration.
The declaration carries names, while private original values and service-lifetime
cleanup stay in the in-daemon SDK callback. This new family requires matching
development Protocol, SDK, CLI-common registration and daemon source; preceding
strict development readers reject it. Existing declarations remain valid through
the family owner's empty default. No released wire format, persisted Account
record, ABI epoch or mixed-development adapter changes.

Unreleased 0.3 daemon-database declarations accept optional
`retention: [{ table, timeColumn }]` through the existing closed manifest family
and `definePlugin` projection. Omitted retention preserves existing declarations.
The declared epoch-millisecond rows consume the Machine's `logRetentionDays` at
the existing maintenance owner; no database format, migration identity, runtime
ABI epoch or separate policy changes. A preceding strict development reader
rejects the new field, so declarations using it require matching development
Protocol, SDK and daemon readers; there is no mixed-development adapter.


Unreleased 0.3 member SCM Actions admit the native owner's existing pre-operation
refusal (`success: false`, `BACKEND_UNAVAILABLE`, `actionErrorCode`) separately
from repository results. This closed diagnostic response cannot establish success
or execution authority; operation-specific success envelopes retain their existing
unknown-field policy. Native refusal fields are primitive and closed, and no input,
persisted format, union authority, wire epoch or package version changes. Matching
Action readers load with this development correction; no reverse-development
adapter is added. The scoped-clean `../0.2` frontier inspected at
`87aaa83f6b81c92a4ceee5816df2e566ed429bc7` has no `packages/protocol/src/scm` owner.

Unreleased 0.3 `teams.credentials.create` accepts authored `displayName` text
alongside its existing prepared private-label envelope. The closed Action input
extends the existing create schema; the captured Account host prepares text
through the same private-label owner as Group update. The HTTP mutation and
persisted label formats remain unchanged. Matching Protocol, generated Action
DTOs and hosts consume this development author-contract change together; there
is no new wire epoch, migration, or compatibility adapter. The inspected
`../0.2` frontier at `d3b1be4dc48fa886c85fb03edc79e20f5d27dfd2` has no Team
credential-resource schema or Action map at the corresponding Protocol paths.

Unreleased 0.3 qualified provider-usage exact history supports an optional finite
NDJSON response on its existing GET route through `Accept: application/x-ndjson`.
Every line uses the existing V4 history response schema; the caller's `pageSize`
bounds a frame, and only `nextCursor: null` proves completion. A truncated stream
is incomplete. Admission runs once and stored sealed records remain sealed.
JSON paging, witness reads and page projections keep their existing contracts.
Clients use the response content type: a Home returning JSON still requires
cursor paging. The safelisted Accept header adds no CORS preflight requirement.
This changes no persisted shape or wire epoch. The scoped-clean 0.2 frontier
at `972cdc0e5978aaf95a2902d4970441590c75b978` has no qualified provider-history
route or schema; no predecessor adapter is added.

The unreleased day-summary read accepts optional `includeCoverage: true`:
its existing `{ summaries, missingDays }` result contains the selected stored
plain/encrypted envelopes and canonical pending-day coverage in one snapshot.
An invalidated stored prefix can remain present alongside its missing-day proof;
it does not establish complete coverage. The daemon's `includeMissingDays: true`
mode retains its narrow missing-body/predecessor behavior. Older strict development
Homes reject the new request option; clients must not silently replace an
unsupported summary read with a full-Year raw-history drain. The response
container and its encryption envelope remain unchanged.
For complete all-days coverage, omit `range` with `includeCoverage: true`; the
server omits date filters for both stored envelopes and pending-day discovery.
Other reads still require an explicit range. No artificial client ceiling is used.
The same unreleased contract adds optional sealed day-summary `observedAtRange`
(half-open provider-clock extrema), outer `clockBoundsVersion: 1`, and daemon
request `requireClockBounds: true`. The existing daemon upgrades legacy summaries
from complete remaining-day reads plus retained endpoints; it does not recover
expired detail or change pace verdict semantics. The one pace owner derives
coalesced accepted-history ranges for the actual current meter windows, including
clock-skewed days. Legacy or missing evidence is explicitly unproven rather than
a foreground exact-history fallback. This is an additive development format
change with a producer-first direct cut: matching Protocol, server, daemon and
client load together; older strict development readers may reject new fields.
Day summaries supply daily/reset chart facts; recent exact history supplies current
pace and reset witnesses. An explicitly requested exact history or page projection
still supplies earlier curves and ended-window unused-capacity facts, including
distinct sample counts and exclusion reasons. A summary-only read leaves these
unrequested exact facts `not_loaded`; it never substitutes endpoint estimates.
No migration, new store, wire epoch or predecessor adapter is added.

Unreleased 0.3 deployment lifecycle observations and repository receipt investigation
summaries optionally carry `builtSha`, the provider-observed commit. The requested
`sourceIntent.sha` stays unchanged; historical observations without `builtSha` remain
readable. Pages Git builds branch HEAD and reports its observed commit rather than
labelling the build with the reviewed SHA. Matching Protocol, SDK projections,
deployment-protocol, Cloudflare plugin, CLI and UI reload together under the
development direct cut; older strict development readers reject the added field.
No migration, wire epoch or compatibility adapter is added.

Unreleased 0.3 Vercel links extend the closed `preparedNative.gitSource` union
with GitLab `{type, projectId}` and Bitbucket `{type, repoUuid, workspaceUuid}`.
GitHub `{type, repoId}` is unchanged. These are non-secret native deployment
operands in existing protected link content. Matching Protocol, SDK declarations,
plugin projections and client/daemon readers reload together under the development
direct cut; older strict development readers reject the new variants. No migration,
wire epoch or compatibility adapter is added.

Unreleased 0.3 deployment target fit facts optionally declare closed
`sources: { gitIntegration: string[], upload: boolean }`. The declaration, normalized
target and suggestion catalog share the same Protocol schema owner. Matching
Protocol, deployment-protocol, SDK projections, CLI and UI reload together under
the development direct cut; older strict development readers reject the new
field. This adds no persisted format, migration, wire epoch or compatibility
adapter.

The suggestion catalog always includes `forges`, containing the admitted
repository publishers. Recommendations may select `repositoryProviderKind`;
before selection, the recommender considers all catalog publishers. An empty
publisher list cannot admit a code-creating pair.

The same development cut extends `projects.starters.create` with a selected
repository `providerKind` and a `source` alternative for an empty scratch
repository. Optional `providerId` and `providerBaseUrl` retain the selected
deployment through the existing SCM publication contract. Existing starter
operands retain their meaning. Scratch results may
omit the informational starter id and commit because the repository has no
initial commit. The create executor still returns the ordinary Project, Source
and Session handoff; no new deployment or Session lifecycle is introduced.

Unreleased 0.3 deployment lifecycle results optionally retain `builtInUrls`,
provider-observed built-in routing addresses separate from deployment-specific
`urls`. The lifecycle result and receipt content remain closed V1 objects;
absence means unobserved and an empty array means observed absent. Matching
Protocol, SDK, plugin declarations, receipt readers and UI source reload together
under the development direct cut; older strict development readers reject the
new field. The scoped-clean `../0.2` frontier at
`c680de922e4475b7dfbaeedcd63a8af7d985d3c3` has no deployment target role contract.
No request, authority, wire epoch, migration, capability or adapter is added.

Unreleased 0.3 manual Connected Account modes add optional `machineSetup` for
the existing Machine recipe review/Apply followed by the same mode's public
configuration and authentication form. The executable mode, recipe reference,
prefill/source and `afterApply` objects remain closed. Older strict development
readers reject this field; matching Protocol, SDK projections, bundled
declarations, CLI and UI readers reload together and use the canonical API
governance/publication producers. Modes omitting the field retain their existing
flow. This is an unpublished development-contract cut, independent of package
SemVer, with no migration, new wire epoch, fallback parser or compatibility
adapter. The inspected clean `../0.2` frontier at
`c680de922e4475b7dfbaeedcd63a8af7d985d3c3` has no corresponding authentication-mode
schema at `packages/protocol/src/connect/pluginConnectedAccountAuthenticationV2.ts`.

Unreleased 0.3 Agent Provider requirements add optional `reasoningEffortValues`
to the closed executable declaration. Omission retains existing Provider-tier
application; a declared list narrows picker controls and explicit launch
admission through the shared reasoning owner. Claude declares its native effort
values, while source catalogs retain their original tiers. Protocol, generated
SDK declarations, bundled manifests and host readers reload together under the
development direct cut; older strict development readers reject the new field.
The scoped-clean `../0.2` frontier at
`c680de922e4475b7dfbaeedcd63a8af7d985d3c3` has no matching Agent Provider
requirements declaration. No persisted format, migration, wire epoch or adapter
is added.

Unreleased 0.3 deployment declarations add the closed data role
`projects.delete` and read-only `projects.observe`; runtime `teardown` already
belongs to the role grammar.
Lifecycle observations optionally carry positive `providerResourceAbsent: true`
evidence. Protected provider Link content optionally records
`providerResourceOrigin: 'created'`; older records without it default to Unlink.
Link authoring strips caller-supplied origin, including from prepared Artifacts;
only the creation host's acknowledged Create path retains it. The stored schema
continues to read existing acknowledged origin records.
The unprepared teardown request accepts `providerRemoval: 'unlink' | 'delete'`.
Source-free provider teardown receipts retain the same provider custody and
existing teardown content with no native Machine/resource proof inventory.
These authority-bearing inputs are not safely ignorable: Protocol, plugin SDK,
plugins and host consumers reload together under the development direct cut.
The scoped clean `../0.2` frontier at
`c680de922e4475b7dfbaeedcd63a8af7d985d3c3` has no deployment plugin declarations.
No released wire epoch, database migration or predecessor adapter is added.

Unreleased 0.3 Setup reports add a closed bound-target branch addressed by the
existing managed resource and controller installation, with the committed Session
association for postbirth reports. Installation-only reports retain the existing
bootstrap completion fact independently of Setup. Its Retry facts extend
the existing admitted preset's private content; opaque Home state remains
lifecycle-only. Protocol, controller CLI and Home reload together under the
development direct cut; older strict development readers reject the new branch
or private field. The inspected `../0.2` frontier
`c680de922e4475b7dfbaeedcd63a8af7d985d3c3` has no managed-machine Protocol or server
directory. No released wire epoch, database migration, enrollment identity or
compatibility adapter is added.

The same development cut adds `boundSetup` to the existing native Setup plan
basis and a declaration Check request to `machine effect-internal`. The basis
names the admitted operation and existing managed resource/committed Session
association; it carries no guest Machine identity or synthetic admission digest.
Matching Protocol, controller and installed guest CLI consume the multi-recipe
plan contract together. Legacy enrollment/bootstrap bases retain their meaning.

Unreleased 0.3 auth-switch diagnostics retain the existing
`continuity_unsupported` cause in `ConnectedServiceUxDiagnosticV1`, including its
existing fresh-session recovery Action. Matching Protocol, daemon and UI source
reload together under the development direct cut; older strict readers reject
the added diagnostic variant. Action failures carry the domain result in the
existing `details` field. No persisted format, epoch or adapter is added.

Unreleased 0.3 `session.spawn_new` adds optional `agentArgs: string[]` for
foreground-to-daemon launch fidelity. The closed request preserves each string
exactly; older strict development readers reject the field rather than silently
launching with different native arguments. Protocol, CLI, daemon and generated
SDK source reload together under the development direct cut. Browser-safe
server-start drafts and durable runner respawn descriptors exclude this
launch-only input. The private runner carrier `--agent-args-v1` uses the same
array schema and does not reinterpret native arguments as Happier controls.
No wire epoch, persistence migration, capability or adapter is added.

Unreleased 0.3 `workflow.run.list` adds optional `starter: 'current_account'`
to its closed request. The server resolves this selector from the authenticated
Account and intersects it with the existing Run audience; omission preserves
shared history. Start-role prefill requests the newest matching Run rather than
paging teammate history. The selector is not safely ignorable: matching Protocol,
server, UI and generated SDK source reload together under the development direct
cut. Earlier strict development readers reject it. The inspected `../0.2`
frontier `c8867dad513ef489183953878c084d660fbe0653` has no Workflow protocol
module. No persistence, wire epoch, capability or compatibility adapter is added.

In unreleased 0.3, a `session.message.send` wait reply whose accepted turn failed returns
`replied` with outcome `{ kind: 'failed', runtimeIssueV1 }`, which is a new strict variant of
the inline `SessionMessageReplyResolvedOutcomeV1`. The cause is the accepted turn's
typed `SessionRuntimeIssueV1`, taken from the same exact-turn reader as
`session.input.result.get`. The persisted reply-progress outcome stays code-only
`{ kind: 'failed' }`. Matching Protocol, CLI and UI source reload together under the
direct cut; an older strict reader rejects the added variant. The inspected `../0.2`
frontier has no inline reply projection.

The legacy `session.message.send` completion wait also retains that typed issue on
`{ status: 'failed', code: 'session_input_turn_failed', localId, runtimeIssueV1? }`.
The optional field uses `SessionRuntimeIssueV1` and the same canonical failure
reader as the reply wait; it carries no transcript text or credentials. Protocol
and CLI reload together; an older strict development reader rejects the added
field. No adapter, legacy parser or wire epoch is added for unreleased 0.3.

`SessionRuntimeFailureCauseV1` also retains optional `carrierFailure`, containing
only the closed `closingSide` and `closingStage` native diagnostic enums. The
Session evidence reader carries these facts through daemon/runner turn enrichment
to the existing UI runtime-issue Details disclosure. They never authorize access
or reclassify a transport failure as a credential refusal. Matching Protocol,
daemon, runner and UI reload together; no compatibility path is added.

In unreleased 0.3, the existing native state-entry declaration's optional
`createIfMissing` also accepts `file`. The host creates that shared file without
truncation before linking; isolated state never creates it. Kimi consumes this
for its native session index. This executable declaration is closed and is not
safely ignorable: load matching host, SDK and Kimi source together under the
unpublished development direct cut. The runtime wire epoch, persisted format,
and existing directory declarations are unchanged; no compatibility adapter or
capability gate is added.

Unreleased 0.3 runner activity notifications add
optional `providerInputAdmissionReady`, decided by the Session client's installed
handler and usable local publication or Home registration receipt. Matching CLI,
daemon and runner source consume this notification; older strict development
daemons reject the added private field as a best-effort activity publication
failure. Foreground environment claims keep their existing strict contract. A
retained older runner or attached Session target without this private capability
may omit the notification: the daemon attempts
the existing RPC once and preserves its typed unavailable result, with visible
retry, rather than waiting for an absent producer. A delayed pending notification
also cannot block an RPC that already works. Early credential-target publication
is unchanged. No SDK version, persisted format, timer, retry budget or readiness
registry is introduced. The inspected `../0.2` frontier
`eca066a11edbc6091f214e29da24d60ae4a7d5ac` has no counterpart to this provider-input
RPC owner.

Unreleased 0.3 Library cleanup uses `workflow.trigger.list` scope
`account_source_unavailable`. The existing Automation definition list accepts
`account_saved` scope, optionally narrowed by Workflow references, to select
saved Account rows without Session bodies. The Account trigger owner reads
bodyless source references first and opens retained private details only for
unavailable sources; the Account codec, source authorization and full
`account_all` census remain unchanged. Matching Protocol, server and UI source
reload together under the unpublished 0.3 direct cut; earlier strict development
readers reject the selectors. No persistence, epoch, capability or adapter is
added. The inspected `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has neither affected protocol module.

Unreleased 0.3 `automation.event.sources.list` adds optional closed `source`
selection (`eventRef`, `sourceInstanceId`, `sourceContractVersion`). Admission
queries only matching definitions from the existing adopted snapshot; omission
retains full discovery and reconciliation. Selection narrows the existing caller
and transport scope and binds pagination cursors. The request, source and event
identity remain closed; unknown fields reject. Matching Protocol, host and SDK
source reload together under the unpublished 0.3 direct cut; earlier strict
development readers reject the field. This adds no persistence, epoch, capability
or adapter. The scoped-clean `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has neither affected source module.

Unreleased 0.3 Usage analytics token aggregates add optional closed
`measured: { total, fromParts: true }`. Each admitted contribution contributes
its reported total when present, otherwise its measured parts as a floor;
aggregates conserve those amounts and retain floor provenance. The six raw
observation fields remain distinct reported facts, including `total`. Scalar
execution, calendar, recap and Work projections carry `tokensFromParts` when
their amount includes such a floor. Ingest and individual observation shapes
remain unchanged, and readers accept older aggregate responses without the
optional fields. Matching Protocol, server and UI source reload together;
older strict development readers reject the added aggregate fields. The private
activity summary advances its existing cache version from 8 to 9 and rebuilds
from retained source facts, without a database migration. The inspected `../0.2`
frontier `dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no
`packages/protocol/src/usage` counterpart. No adapter, wire epoch or second
reconciliation path is introduced.

The consumed public-profile snapshot facts also carry optional `tokensFromParts`
on their headline and Agent/source token amounts. The existing token consent
owner removes both amounts and their provenance, including declarative layout
bindings, when tokens are hidden. Stored V1 snapshots without this optional
metadata remain valid; new prepared editions and fixed/public UI renderers
retain the floor qualifier. No new disclosure permission or published field
control is introduced.

Unreleased 0.3 Computer interrupted input results may carry optional `code`,
retaining the native refusal independently of completion certainty. The result
and its target identity remain closed; omission remains valid. Matching Protocol,
daemon and UI source reload together: older strict development readers reject
the added field. This diagnostic adds no authority, retry, persisted format,
wire epoch or adapter. The inspected `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no Computer protocol or daemon
counterpart at these paths.

Unreleased 0.3 authenticated Session detail adds optional `computerMachineBinding`
with a closed `{ homeId, machineId }` object. C79 limits this recipient projection
to Session participants with existing Machine Manage. It is a routing hint, never
Computer admission, and is absent for other recipients and older producers.
The outer Session record remains additive-open/preserve; older readers ignore the
unrecognized hint. The inspected `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` uses a passthrough
`V2SessionRecordSchema` in `sessionControl/contract.ts`. Current readers validate
the known closed binding. No shared ciphertext, owner envelope, database schema,
wire epoch, request field, compatibility adapter or capability changes.

Unreleased 0.3 Machine Services list/detail rows add optional `failureCause`
using the existing closed `ActionFailureCauseV1` schema. A failed retained
source is an inert unavailable row; healthy services remain readable through the
same Account disclosure owner. The row and nested identity/diagnostic objects
stay closed, with no unknown-field preservation or executable custody granted by
the diagnostic. Earlier rows without the field remain valid. Matching Protocol,
CLI, UI and SDK source reload together under the unpublished 0.3 direct cut;
earlier strict development readers reject the new field. No persisted format,
union member, wire epoch, capability or adapter changes. The inspected 0.2
frontier `dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no counterpart at
`packages/protocol/src/actions/specs/machine/services.ts`.

Unreleased 0.3 Session capability writes and Session-trigger PR-link availability
add optional `diagnostic: { reason }` to their closed failure outputs. They use
Protocol's shared Action refusal vocabulary; omitted diagnostics remain valid.
Matching Protocol, CLI, UI and SDK source reload together under the unpublished
0.3 direct cut (owner approval, 2026-11-13 18:16Z, and the 2026-11-07 no-compatibility
for unshipped data ruling). Older strict development readers reject the added
field. The inspected 0.2 frontier `dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf`
has no Session capability spec counterpart. This adds no adapter, gate, epoch
or persisted format.

Unreleased 0.3 `ComposerReadResultV1` adds optional `requestId` to its closed
`unavailable` result. The Composer host copies the existing request envelope id;
the SDK derives its result type and parser from that Protocol schema. Missing ids
from earlier producers remain valid. Matching host, Protocol and SDK source reload
together under the unpublished 0.3 direct cut; older strict development readers
reject the added field. This adds no authority, persisted state, epoch or adapter.
The inspected `../0.2` frontier `dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf`
has no `packages/protocol/src/plugins/ui/composer.ts`.

Unreleased 0.3 `deployments.receipts.get` adds optional input
`projection: investigation` and optional result `investigation`. UI and daemon
Account hosts strip the projection before reading server metadata, open the exact
receipt through the Account encryption owner, and project source revision identity
and structural failure facts. The source and failure objects remain closed; no
Compose document, selectors, logs or credentials enter this result. Omitted
projection preserves the ordinary read path, and an absent result projection
means those facts are unavailable. Matching strict Protocol, SDK, UI, daemon and
Triage source reload together under the unpublished 0.3 direct cut; older strict
readers reject the added fields. This changes no persisted format, epoch,
capability or generic Artifact policy. The scoped 0.2 frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no deployment Action contract at
`packages/protocol/src/deployments/deploymentActionsV1.ts`.

Unreleased 0.3 in-process `AgentSessionOpenRequest` adds optional
`promptProfile: 'conversation'`. Local Voice selects it for its retained carrier;
the Codex adapter omits native project instructions and automatic skill
instructions at process launch and thread start/resume. Omission preserves coding
Session defaults. This is an advisory prompt-cost input, safely ignorable by
other Agent adapters, with no permission, routing, persistence or credential
meaning. The open request remains closed to known SDK fields; the profile is a
single literal with no nested object or unknown-field preservation. Matching
host and Codex source reload together under the unpublished 0.3 direct cut;
there is no wire epoch, package version, capability or persisted-format change.

Unreleased 0.3 in-process `ExecService` adds optional `readEnvironment(keys)`.
The invocation factory captures the existing Session environment reference;
the method returns only requested inherited values, independently of the narrow
child-launch projection. Claude and Gemini native adapters require this method
when invoked by a host, preserve explicit launch values and unsets, and report
the existing `plugin_service_unavailable` error when it is absent. Standalone
helpers with no host service retain their process baseline. Matching host and
plugin source reload together under the unpublished 0.3 direct cut. This adds
no wire field, epoch, persistence format, capability or old-host adapter.

Unreleased 0.3 Machine Shell and Workspace Sync requester availability may carry
optional `preparation: member_not_prepared` on their existing available result.
The enclosing objects remain closed and reject unknown fields. This projection
adds no authority or persisted state; absent bindings expose only the native
identity owner's deterministic directories, and deliberate admission still
prepares and validates the native identity. Responses without the field remain
valid. Matching strict development readers and writers reload together under
the unpublished 0.3 direct cut; older strict readers reject the extra field.
No wire epoch, capability, migration or adapter is added.

Unreleased 0.3 plugin exec requests add optional `requiredFiles`, carried by the
runner writer and strict daemon reader together. It declares transient launch
dependencies for the native selected-material owner’s pre-spawn refusal; it adds
no persistence, capability, wire epoch, adapter or retry. Older strict development
readers reject the field and must reload with the matching writer. Requests
without the field remain valid. The scoped 0.2 frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no runner/daemon plugin-service
protocol module.


Unreleased 0.3 `ScmHostingRepositoryGetResponseV1` failures may carry the
existing optional `ActionFailureCauseV1`. Both objects remain closed. Matching
SCM RPC and Public Profile readers refresh together under the unpublished 0.3
direct cut; older strict development readers reject the added field. Responses
without a cause remain valid. This diagnostic adds no authority, retry policy,
persisted format, wire epoch or capability. The scoped `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no hosting-repository read contract.

Unreleased 0.3 Action failure causes add optional `nativeErrorReason`, a
producer-projected diagnostic code using the existing native-code alphabet.
The cause and enclosing result/event objects remain closed; unknown fields
are rejected, and no reason gains authority, routing or retry meaning.
ElevenLabs projects only known SDK-authored literals; arbitrary close prose
is excluded. Matching Protocol, SDK and UI readers refresh together under the
unpublished 0.3 direct cut; older strict development readers reject the field.
Old causes without it remain valid. No wire epoch, persisted format, capability
or adapter changes. The scoped-clean `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no corresponding Action cause
module.

The unreleased 0.3 realtime `provider_error` code union also accepts
`voice_provider_agent_unavailable`. ElevenLabs alone classifies the exact
observed SDK initialization refusal; the host consumes that reason through
existing Voice setup recovery and localized copy. The diagnostic category
`call_initialization_error` uses the existing optional `nativeErrorReason`;
numeric `3000` already fits `nativeErrorCode`. No vendor prose enters the
event or cause. SDK, provider and UI refresh together under the same direct
cut; no wire epoch, persisted format or adapter changes. The scoped 0.2
frontier above has no corresponding realtime event contract.

Unreleased 0.3 Local Voice turn error events add optional `runtimeIssueV1`, reusing
the closed Session runtime issue and failure-cause schemas. This diagnostic
presentation carries the native owner's redacted vendor message and HTTP status
through the existing Account-carried stream, without changing retry or authority.
Current loose error-event readers tolerate the optional field; older producers
without it remain valid. Matching CLI and UI consume the typed issue together.
No persisted format, wire epoch or compatibility adapter changes.

Unreleased 0.3 price Actions accept optional `modelIds` for exact tariff delivery.
Agent/MCP defaults return a closed count/provenance summary; selected reads return
the existing closed V1 catalog shape with only matching entries. UI/CLI defaults
and native HTTP catalog responses remain unchanged. The Action input, both result
objects, provenance and rate entries are closed; unknown fields are rejected.
The selector changes delivery and is not safely ignorable. Protocol hosts and
generated SDK DTOs refresh together under the unpublished 0.3 direct cut, without
a new wire epoch, persistence or adapter. Older closed development result readers
reject summaries. The scoped-clean `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no Usage price schema or Action
contract at the corresponding paths.

Unreleased 0.3 Agent Session declarations add optional `functionTools: true` to
advertise native host-function delivery on Session creation. The manifest and
nested Session capability object remain closed; absence selects the existing
shared Happier Action tool surface rather than refusing Voice. Protocol, authored
Codex declaration and daemon transport selection update together under the 0.3
direct cut. No persisted Account/Session format or 0.2 wire request changes.
The existing runtime `functionToolsDelivered` acknowledgment remains the actual
launch-delivery contract.

Local Voice Start and retained-run Ensure use the existing signed Account Action
carrier. The live Run and its MCP binding retain the admitted caller, surface and
authority; Start/Ensure replies return those same facts to the hosting App. The
existing client Action reverse transport adds a per-Voice-Run address and operands
for the active occurrence, turn and Action request. Requests carry no authority
claims. Ordinary Session MCP retains agent authority. Matching unpublished 0.3
Protocol, UI, daemon and Home RPC routing refresh together; older development
components cannot consume this path. This direct cut adds no persisted format,
authority type, catalog or compatibility adapter.


Unreleased 0.3 agent/MCP Usage delivery adds optional
`accounting.coverage.sourceSummary` to the client-only `UsageQueryAccountingSchema`.
It is a closed presentation object with total source count and closed groups
derived from existing source status, path and capture-kind fields. Broad tool
delivery replaces per-source rows with this summary while retaining coverage
reasons and Work counts; selecting one Session retains per-source detail.
Broad agent/MCP accounting also omits retained calendar/repricing operands and
Session membership lists. Aggregate accounting facts remain available; UI/CLI
and selected-Session reads retain those Resource operands and membership detail.
The server accounting schema, query identity and stored data are unchanged.
Matching Protocol hosts and generated SDK DTOs update together; older closed
0.3 result readers reject the added field. This direct development cut adds no
epoch or adapter. The scoped-clean `../0.2` frontier
`7b0f74960b1393886b994dbda71dcb3439c1ab57` has no Usage delivery or accounting
contract at the corresponding paths.

Unreleased 0.3 `usage.sources.discover` and unselected `usage.sources.get`
deliver an inventory summary to agent/MCP callers. Groups retain Agent identity,
consent, status, coverage and pending counts, with exact source selectors and
discovery-only file counts. `usage.sources.get` with `sourceId` recovers the full
source card; UI/CLI inventories remain full. The closed native Machine response
still requires full cards and rejects Action summaries before identity checks.
Matching Protocol hosts and generated SDK DTOs refresh together under the same
development direct cut. No stored data, collection consent or wire epoch changes.

Unreleased 0.3 direct Machine RPC removes `maxCalls` from the closed grant scope.
Home signs `callerAuthority` on every V2 Machine RPC grant; the requester reuses
that credential-bound admission until its existing signed expiry or disconnect.
Ordinary methods no longer consume the one-use ledger, while explicitly listed
high-risk methods and native Workspace Sync keep their existing single-use
semantics. The V1/V2 grant and nested scope/proof envelopes remain closed: unknown
fields are rejected, never retained as authority. Matching Protocol, UI, Home and
CLI reload together; older strict development readers require `maxCalls` and
cannot consume the new shape. This approved direct development cut adds no wire
epoch, capability or migration. The scoped-clean `../0.2` frontier
`7b0f74960b1393886b994dbda71dcb3439c1ab57` has neither this peer-mediation scope
module nor its direct RPC receiver, so no predecessor adapter is added.


Unreleased 0.3 `deployments.publish.prepare` adds optional `recommendation` to
its closed prepared result. The nested target, evidence, uncertainty, correction
and identity arrays are closed presentation facts; they grant no execution or
credential authority. Missing fields retain existing prepared results. Unknown
fields are rejected and are never promoted to routing or permission facts.
Matching Protocol, CLI producer, SDK DTO and UI readers reload together; earlier
strict development readers reject the new field. This unpublished V1 direct cut
adds no wire epoch, persistence format, capability gate or predecessor adapter.
The inspected `../0.2` frontier `7b0f74960b1393886b994dbda71dcb3439c1ab57`
has no `packages/protocol/src/deployments/deploymentPublishPreparationV1.ts`
contract and no scoped working changes to that path.

Unreleased 0.3 `agents.backends.list` results add optional `executionTarget`
through the existing closed `SessionExecutionTargetV1` schema. The result,
its rows and nested routing/Agent identities remain closed; unknown fields
are rejected and no unknown data gains routing meaning. Omission preserves
Account-only browsing without Machine readiness. Scoped Voice listings return
the exact Machine whose readiness and default they describe. Matching Protocol,
UI and SDK readers reload together under the unpublished 0.3 direct cut;
earlier strict development readers reject the field. No new wire epoch,
capability gate, persistence format or compatibility shim is introduced. The
scoped-clean `../0.2` frontier `4c64c3f1ddfca82db8bcb61e7e8c87f6bd013e69`
has no `actions/agentBackendInventory.ts` contract.

Unreleased 0.3 Account Availability exact `intent.read` accepts optional
`omitDeclarations: true`, reusing the list projection that omits
`currentDeclaration` and `machineDeclarations`. Account activation-source
revalidation requests this projection; intent, release facts, authorization and
custody comparison are unchanged. Matching Protocol, server and CLI readers
reload together: earlier strict development servers reject the new input field.
Omission retains the full response. This direct development cut adds no epoch,
persistence migration or predecessor fallback. The inspected `../0.2` frontier
`4c64c3f1ddfca82db8bcb61e7e8c87f6bd013e69` has no Availability actions module
at `packages/protocol/src/plugins/availability/actions.ts` and no scoped working
changes to that path.

Unreleased 0.3 realtime Voice tool results validate owner-produced, privacy-projected
output with the canonical strict JSON value schema. The provider-call input
limits are unchanged; they no longer impose collection, string or nesting quotas
on tool output. The closed V1 result envelope accepts an optional host-owned
`summary`, derived from already-redacted output, and optional `errorDetails`
for non-success results, carrying the existing structured PluginError details
through the same privacy projection as output. Success still forbids error
fields. Failure results retain their typed status/code while the canonical
provider projection includes the human summary alongside them; unknown envelope
fields remain rejected. Matching Protocol, UI and
bundled Provider readers reload together because earlier strict development
readers reject the new field. This is an unpublished direct development cut,
without a new epoch, persistence migration or predecessor adapter. The inspected
`../0.2` frontier `4c64c3f1ddfca82db8bcb61e7e8c87f6bd013e69` has no
`packages/protocol/src/voice/realtime/events.ts` contract.

Unpublished 0.3 realtime Voice adds microphone-commit, finished-transcript and
response-lifecycle facts to the closed SDK canonical event union. Tool batches
omit an independent response ID when the vendor exposes only call IDs; existing
call/result grouping IDs are unchanged. The host binds person origin only to
finished microphone input or typed composer input, preserves it through tool
continuations, and treats missing origin as synthetic. These authority-relevant
facts are consumed by the existing spoken Action confirmation owner. Provider
connections notify the host immediately before actual greeting or host-readback
input opens a response. Context-only sends do not open responses. When distinct
inputs overlap before an uncorrelated response-created event, the host treats
that response as synthetic and retains ordinary review rather than guessing its
opening input. This can require an extra, recoverable review during overlap;
it introduces no new approval rule. Matching SDK, UI and bundled Provider source readers refresh
together under the unpublished 0.3 direct cut; this introduces no wire epoch,
persisted format or compatibility adapter. The scoped-clean `../0.2` frontier
`91e2afbaca33e8589652c2d2b7e2abfa9a2cf049` has no
`packages/plugin-sdk/src/voice/client.ts` contract or scoped working changes.

Unreleased 0.3 Connected Account modes add optional `accessOnlyExport`, a closed
declaration of access-token, expiry and public-metadata credential keys. The
existing closed `directExportContract` persistence/mutation field accepts its
new access-only contract literal alongside the unchanged manual contract. Both
are authority-bearing; unknown contracts and unknown declaration fields reject.
Omission retains the existing manual behavior. Matching Protocol, SDK, server,
CLI host and declaring plugins reload together; earlier strict development
readers reject the new declaration/contract. Per the approved direct development
cut, this adds no wire epoch, capability bit or migration. Existing Accounts
need reconnect to record the new contract. The inspected `../0.2` frontier
`57cd3db058af7767335d6d5a4ed44904460c50bb` has neither affected Connected Account
schema path and no scoped working changes; no predecessor adapter is added.

Unreleased 0.3 Connected Account purpose declarations add optional
`managedProviderEndpoint`, a closed pair of exact Provider contribution identity
and upstream purpose, with an optional native `modelIdPrefix` mapping checked
against the exact Provider catalog. Omission retains native delivery. The field is routing
authority, not an ignorable hint: shared Provider launch admission resolves the
selected binding through the declared managed endpoint before native launch.
The live Agent Provider binding source also accepts a closed `connected_account`
variant identifying the admitted Agent purpose and exact selected Account;
resolved Pool intent and credential acquisition remain with their existing owners.
The SDK projects the canonical purpose type rather than duplicating its schema.
Matching Protocol, SDK, CLI host and declaring plugins reload together; earlier
strict development readers reject these additions. This unpublished direct cut
adds no wire epoch, capability, saved connection or persistence migration. The
inspected `../0.2` frontier `b825a99dfedcb68e223155a1ba0be84babe9e2d0`
has no Connected Account purpose declaration module at this path, so no
predecessor adapter is introduced.

The unreleased 0.3 `DaemonProviderModelProjectionRequestV1` also accepts optional
`connectedServices` using the existing closed qualified V2 binding schema. It
selects only the Agent declaration's managed-purpose catalogs and is mutually
exclusive with explicit source and Team catalog selectors. Omission preserves
saved Provider projection. This is routing and credential-selection input, so
older strict readers reject it; it must not be ignored. Matching UI, Protocol
and CLI hosts reload together under the same direct development cut, with no
new wire epoch, capability or persistence migration. The inspected `../0.2`
frontier `7b0f74960b1393886b994dbda71dcb3439c1ab57` has no affected Provider RPC
module or scoped working changes; no predecessor adapter is needed.

Unreleased 0.3 plugin Session input sources and durable `pluginSession`
provenance accept optional `displayNameSnapshot`, a descriptive source label
using the existing NFC/128-code-point display snapshot contract. Actor names
remain separate. Both envelopes stay closed; unknown fields are rejected,
and the existing provenance envelope budget still applies. Omission remains
readable with a generic integration byline. The field grants no identity,
routing, permission or approval authority. Matching Protocol, SDK, Channels,
CLI host and UI source reload together because earlier strict development
readers reject the field. This direct development cut adds no wire epoch,
capability, persistence migration or predecessor adapter. The inspected
`../0.2` frontier `b825a99dfedcb68e223155a1ba0be84babe9e2d0` has neither the
Session input admission schema at this path nor the plugin SDK package.

Unreleased 0.3 committed user runtime events add optional `nativeContent`, a strict
JSON array retained as opaque data in `raw.meta.nativeContent`. The V1 event and
its identity, role and lifecycle fields remain closed; nested native values are
round-trip data and acquire no host or trusted-content authority. Non-user events
reject the field. Protocol, SDK, Codex plugin and host reload together; earlier
strict development readers reject the addition. This direct development cut adds
no wire epoch, capability, persistence migration or reverse-development adapter.
The inspected 0.2 base `7b37d65ca75e58560f8f3ca850958ac5407d2e75` and PR #905
through `9308855b1cf55c7ca901fd6d7c1aa56d3ff38fab` write opaque native parts in
existing message metadata (`codexNativeContent`); they have no 0.3 runtime-event
contract. Existing stored metadata remains readable. The port preserves 0.3's
visible unsupported-record projection and hard caller/transport reply budget;
it does not port 0.2's soft-limit exception for a single oversized record.

Unreleased 0.3 Workspace Sync reconnect accepts the existing signed SOURCE
relationship projection without a new target bootstrap choice. The target owner
requires exact persisted READY custody before rehydrating that relationship.
The closed V1 request fields and physical SOURCE admission remain in force.
Matching Protocol and CLI source reload together because earlier development
readers require a bootstrap choice for every transient projection. This direct
development cut changes no wire epoch or persistence format. The inspected
`../0.2` frontier `7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no Workspace
Sync handoff schema at this path.

Unreleased 0.3 Environment create/update storage projections accept an optional
`referencedSavedSecretRevisions` capture array from admitted template preparation.
The existing resource-id/revision format omits routing for pending bindings;
updates retain previous reference identities until the binding writer commits.
Canonical Saved Secret use admission protects incoming identities. Public Action
inputs and the persisted column format are unchanged.
Matching CLI, Protocol and Home source reload together; earlier strict storage
readers reject the new field. Omission preserves existing binding-free behavior.
This is a direct development cut, without a new epoch, capability or migration.

Unreleased 0.3 Session spawn errors accept optional `failureCause` through the
existing closed `ActionFailureCauseV1` schema. Directory preparation preserves
the lower admission phase and code for path and managed creation callers; the
field grants no authority and carries no transport prose. The result and nested
cause remain closed. New readers accept earlier errors without the field; older
strict development readers require matching Protocol, CLI, UI and SDK source. This
direct development cut changes no wire epoch, input, persistence or error code.
The scoped-clean `../0.2` frontier at
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no SessionSpawnNewResultV1 contract;
no predecessor adapter is added.

Unreleased 0.3 `scm.log.list` accepts the closed optional
`revisionRangeFromRef: {baseOid, headRef}` selector, exclusive with other log
selectors. The existing SCM Git ref resolver selects one immutable head; the
existing exact-range reader returns `revisionRange` with both OIDs and the
resolved `headRef`. Deployment comparison requires that selector and base echo
before showing history or opening the immutable-range viewer. No response echo
means unavailable, including older readers that ignored the optional selector;
there is no fallback to checkout HEAD or automatic fetch. The immutable
`ScmRevisionRangeV1` viewer contract is unchanged. Request, selector, response,
and range evidence objects remain closed; no unknown field gains meaning or is
preserved. Matching Protocol, SDK, SCM plugin and UI reload together, with no
new wire epoch, Action, persistence format or adapter. The inspected `../0.2`
frontier `7b37d65ca75e58560f8f3ca850958ac5407d2e75` (including unchanged scoped
working files) strips unknown log inputs and returns only recent entries with
no range echo; current consumers therefore report comparison unavailable.

Unreleased 0.3 `automation.event.sources.list` accepts optional closed
`catalogRefresh` intent (`refresh`, or `retry` with the provider's
absolute `retryAt`). The existing daemon adopted-catalog owner consumes it to
share one retry across observers. It is omitted from stored-definition HTTP
requests and grants no authority. Matching SDK, Protocol and CLI host reload
together; older strict development Action readers reject the added field.
The inspected `../0.2` frontier `7b37d65ca7` has no
`automations/automationActionSpecsV1.ts`. No released predecessor adapter,
persistence format, wire epoch or capability gate changes.

Unreleased 0.3 GitHub PR Preview child results accept optional `controller`,
using the canonical Deployment controller availability schema exposed through the
SDK protocol facade. Both receipt-backed and unavailable child results can carry
the fact; omission makes no controller availability claim. Matching SDK, plugin
and UI readers consume this additive projection together. Older strict
development readers reject the extra field. There is no persisted format change,
new wire epoch or compatibility adapter.

Unreleased 0.3 Triage Environment investigation subjects accept optional
`readiness: { projectId, fact }` context. The existing Environment read verifies
Project membership; the context supplies no authority or caller-authored verdict.
Matching Triage protocol, plugin and UI readers reload together. Older strict
development readers reject the extra context; omitted context preserves existing
Environment handoffs. No new Action, Session writer, persistence format or wire
epoch is introduced.

Unreleased 0.3 runtime usage observations share the closed payload schema in
`runtime/agentUsageObservedPayloadV1.ts`, independent of Session and finite-Run
envelopes. A witnessed `accounting.nativeSessionId` permits an observation with
no measurements. Absent tokens, cost and counter semantics stay absent; this
does not authorize deriving counted totals or attributing child spend to a parent.
Within a supplied token or cost object, unavailable numeric measurements are
`null`; an observed zero remains `0`. The SDK derives its usage arm from the
same leaf. Matching development readers consume this contract together, without
a legacy adapter or new wire epoch. The UsageEvent ledger stores the six token
and three numeric cost columns as nullable measurements. Aggregation skips null
operands. A nonempty population with no measured value retains null; an empty
population publishes zero totals without attributing a report or tariff basis.
Incomplete facts remain visible through the existing accounting coverage
projection. New migrations preserve
existing measured values; they do not reinterpret historical zeros as unknown.

Unreleased 0.3 native Agent model snapshots and ACP model controls add optional
`catalogConfidence`, using the existing Provider catalog confidence vocabulary.
The shared publication owner consumes this presentation provenance to withhold
`account_unverified` choices; active model identity and private native controls
remain intact. Matching SDK, native Agent producers and CLI host reload together.
This in-process additive presentation fact changes no Host Event, persisted
record, routing, authority, wire epoch or npm version. Omission preserves the
existing native catalog publication path; no older-host support is claimed for
selected-account declarations that require the new projection.

Unreleased 0.3 Connected Account completion results and V4 presentation metadata
accept optional `includesApiKey: true`. It records an additional key actually
created during successful authentication; credential kind, manual key mode and
native imports do not establish it. The existing prepared settlement retains the
fact, credential settlement stores it, and public attempt/profile responses carry
it to the existing account views. Absence remains unknown. Refresh preserves the
stored metadata rather than inferring a new fact.

Matching Protocol, plugin SDK, daemon, server and UI readers reload together;
older strict development readers reject the added field. New readers accept
records and responses without it. The inspected `../0.2` frontier
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` has neither the current V4 profile,
daemon attempt schema nor authentication-completion owner, including scoped local
changes. This adds no released predecessor adapter, wire epoch or storage owner.

Unreleased 0.3 permission occurrences add closed optional `nativeChoices`, with
canonical offered response payloads, and answer carriers add `nativeChoice`.
An offered choice may also carry one optional `followUp: { actionId, input }`
for an existing Action. Current submitters read it from the stored offer, run it
after native success and preserve catalog-only retry after a save failure.
The `nativeChoice` field may carry an answer without a legacy `approved` alias. Current
responses resolve the stored choice before deriving decision and grant fields;
an answer without a valid selection cannot approve a native-choice occurrence.
Matching Protocol, SDK, daemon and UI readers reload together. Stored occurrences
without offered choices retain the frozen reader and existing response codecs;
there is no new permission request kind, wire epoch or persistence store.
The inspected `../0.2` frontier at
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` has neither the current
`respondRpcParamsV1.ts` nor `runtime/session/scopedServices.ts` module, including
scoped local changes. This does not establish old-host support for native-choice
answers: their opaque selection must reach a current application owner.

Unreleased 0.3 connected-service diagnostics replace the three live Claude
native-auth codes with `connected_service_credential_scope_missing`,
`connected_service_native_auth_materialization_failed` and
`connected_service_credential_mode_unsupported`. The existing diagnostic ingress
translates the corresponding 0.2 codes to these service-neutral results before
spawn recovery or UI presentation. Current writers use the generic vocabulary;
reconnect actions, diagnostic privacy and service identity are unchanged. The
closed diagnostic envelope retains its V1 version. Matching development
Protocol, SDK projections, daemon and UI reload together; old readers do not
consume new codes. The inspected `../0.2` frontier
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` still declares all three old codes,
including no scoped local changes, so their read compatibility remains.

Unreleased 0.3 startup diagnostics add `model_selection_required` to the existing
closed `SessionRuntimeFailureCauseV1.failureReason` vocabulary. Pi, Copilot, CodeBuddy, Droid and Kilo refusals of
an unverified ChatGPT default keep the existing model reconciliation code and
phase; matching host, runner decoder, launch Action and UI retain the precise
reason and present model selection rather than retrying unchanged input. This is
a direct cut: matching Protocol, Pi and host/UI readers reload together because
earlier strict development readers reject the added enum value. New readers
still accept existing causes, including `unknown`. The inspected `../0.2`
frontier `7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no failure-cause carrier
in its runtime issue schema. No wire epoch, migration or compatibility adapter
is introduced.

Waiting Session sends now reuse resume readiness and may settle with the existing
`failed` status and `resume_failed` code, retaining the accepted input receipt and
optional canonical launch error detail. The prompt remains in Pending as blocked
and recoverable; admission does not imply successful execution. Matching Protocol,
CLI Action and UI readers reload together for this closed result extension.
Asynchronous sends retain their admission-only behavior. This is the same
unpublished 0.3 direct cut, without a new status, epoch or persisted format.

Unreleased 0.3 custom Agent runtime declarations add optional
`permissionModeMapping`, using the existing native permission mapping grammar.
CodeBuddy projects the same mapping its ACP factory consumes, preserving permission
controls when launch moves to a custom factory. Both full and retained bundled UI
publication read this admitted declaration. Omission keeps existing custom Agents
unmapped; declarative ACP mappings retain their existing location and meaning.
Earlier strict development readers reject the added field, so Protocol, SDK,
CodeBuddy, daemon and UI declarations reload together under the 0.3 direct cut.
No persisted format, wire epoch or compatibility adapter changes. The inspected
`../0.2` frontier `7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no corresponding
custom runtime schema or SDK author declaration at these paths, including scoped
local changes.

Unreleased 0.3 Session launch errors add optional closed `pluginCodeRefusal`
with the existing closed Machine setup remedy union. Linux plugin-code access
failures retain `plugin_code_unreadable` and the admitted requester's remedy:
Manage opens the existing Machine Security page; Use receives an informational
manager handoff. This is presentation only and grants no setup authority.
Matching Protocol, daemon and UI readers reload together because earlier strict
development readers reject the added field. New readers accept earlier launch
errors without it. No Action, persisted format, wire epoch or adapter changes.
The inspected `../0.2` frontier at `7b37d65ca75e58560f8f3ca850958ac5407d2e75`
has no Session creation launch-error schema in tracked or scoped local source.

Unreleased 0.3 Voice Session creation allows `agentTarget` omission on its Voice
surface only. The Voice host binds the existing inventory's complete default
target before strict Action admission, review or daemon dispatch. Named tools,
discovered execution and Voice action blocks use the same surface schema.
Canonical Action/RPC inputs, stored approval operands and Agent identities stay
closed and fully bound; malformed explicit targets remain invalid. Refresh the
UI host with the matching Protocol source. No daemon change, wire epoch,
persisted format or compatibility adapter is introduced.

Unreleased 0.3 native duration facts add optional `idleAfterMs` beside `afterMs` in
the existing closed `ProviderNativeOptionFactsV1.duration` object. Modal's closed
launch/options inputs accept optional `idleTimeoutMs`; omission preserves existing
requests and stored reviewed facts. New writers carry both requested limits into
the existing reviewed creation snapshot. Matching development Protocol, SDK, Modal
and UI readers reload together: earlier strict development readers reject the added
field. This is a direct cut within the current author epoch, with no new Action,
store, wire epoch or compatibility adapter. Absolute native expiry remains a separate,
preferred observation; neither duration is converted into a timestamp.

Unreleased 0.3 spawn failures add optional `nativeErrno` and `cwd` diagnostics
to the closed `SpawnFailureV1` cause. Terminal Session creation errors retain
that cause in optional `spawnFailure`; a no-PID start keeps `SPAWN_NO_PID` as
its launch code. New readers accept earlier causes without these fields. Older
strict development readers reject the added fields, so matching Protocol,
daemon and UI readers refresh together. This changes no launch input,
authority, persisted format or wire epoch and adds no compatibility adapter.

Unreleased 0.3 `doc.edit.propose` accepts a closed thread-addressed input
(`discussionRef`, `localId`, `after`, optional `reason`) alongside the existing
closed explicit-passage input. Nested routing and passage objects remain closed.
The Doc adapter resolves the thread's committed passage before review, so stored
approval and proposal content retain the existing fully bound shape. New readers
accept existing explicit inputs; older development readers reject the shorthand.
Matching Protocol, SDK and host readers reload together under the direct cut;
no persistence format, wire epoch or compatibility adapter changes. The inspected
`../0.2` frontier at `0425f64269b607642e7723fb30a83a0b53e17bf4` has neither the
Doc collaboration schema nor spec, including scoped staged and unstaged changes.

Development paragraph-scoped Doc suggestions reuse the existing optional passage
`prefix` and `suffix` fields and the unchanged fully bound proposal shape. Capture
keeps the selected quote and offsets; the thread adapter recaptures paragraph context
from the current Doc, including for older attachments without those fields. Explicit
reviewed inputs and stored proposals retain their exact authored basis. No schema,
wire epoch or persisted-format change is introduced. Protocol and the Session host
refresh together so tool guidance, generated context and target binding agree.
The inspected `../0.2` frontier `7b37d65ca75e58560f8f3ca850958ac5407d2e75`
has no corresponding passage, collaboration schema or Action spec in tracked source
or scoped staged/unstaged paths; no predecessor adapter is added.

Unreleased 0.3 GitLab native mutation results add optional `failure` diagnostics
to the existing closed `refused` arm, using the existing closed
`TriageSourceFailureV1` object. Dispatched provider refusals retain their Code
and available request identity in its bounded detail. New readers accept
existing refusals without diagnostics; older strict development readers reject
the added field, so the source and plugin UI reload together under the existing
V1 direct cut. No input, authority, persisted format, package version or wire
epoch changes, and no compatibility adapter is introduced.

Unreleased 0.3 backup destination descriptors publish `credentialRoles` as closed
`{ role, optional?: boolean }` entries instead of role-name strings. Omission or
`false` means required; the bundled S3 descriptor marks its session token optional
from the same role requirements as its open Action. Protocol, SDK, bundled
publication and UI readers change together; old strict development readers reject
the new shape. No Environment binding format, Action input, wire epoch or
compatibility adapter changes.

Unreleased 0.3 Triage exact `get` and `entries/reobserve-v1` results add optional
`detailData`, transient source-owned JSON presentation passed to the embedded
detail input. Task editing consumes the existing optional `taskFields` from that
same read. The get/reobserve result arms remain closed with the new field
declared; the detail envelope remains additive-open/drop, and the source owns
its inner schema. Matching development producers and readers reload together;
older strict development result readers reject the new field. No persisted
format, authority, identity or wire epoch changes. Embedded targeted input keeps
strict JSON and role validation; the 8 KiB `openSurface` navigation bound remains
on navigation and no longer constrains embedded typed presentation.

Unreleased 0.3 `doc.comment.reply` accepts optional initial `participants` through
the existing `DiscussionInitialParticipantsV1` schema, only when starting a new
passage Discussion. The Action input, participant identities and nested passage
references remain closed; omission preserves ordinary comments. Nonempty initial
invitations use the existing present-user sharing classification and canonical
Discussion creation owner. Older strict development readers reject the operand,
so matching Protocol and UI readers reload together. No persisted format, wire
epoch or compatibility adapter changes. The inspected `../0.2` frontier at
`7607f9dc568d462e61ce73583881e4ce6def549e` has neither the Doc collaboration Action
schema nor spec, including scoped staged and unstaged changes.

Unreleased 0.3 `workspace.tabs.open` adds the optional closed SCM `resource`
input, reusing `PluginUiResourceIntentV1`. The Action envelope stays closed;
resource addressing is mutually exclusive with href/file and placement controls.
New readers retain existing href/file/empty-tab inputs. Older strict development
readers reject the new input, so matching Protocol/UI readers reload together;
no silently ignored input, persisted format or wire epoch is introduced. The
inspected `../0.2` frontier at `7607f9dc568d462e61ce73583881e4ce6def549e`
has no workspace Action family path or local changes in that path.

Unreleased 0.3 Storage summaries add optional `docker` presentation facts on the
existing summary and refresh Actions. The summary remains additive-open/drop:
older readers drop the leaf and new readers accept its absence. Native candidate
identities reuse the closed Docker prune selectors as expectations, with custody
decided by the daemon at effect time. This changes no request, Action, persisted
format or wire epoch. The inspected `../0.2` frontier at `f760eedfec` has no
`packages/protocol/src/storage/storageV1.ts` path.

The same additive-open/drop volume projection adds optional `cleanup` facts:
`{kind:'available'}` or `{kind:'unavailable',reason:'system_partition'|
'permission_denied'|'read_only'}`. These bounded presentation objects are
additive-open/drop; they confer no effect authority. Older readers drop the field,
new readers accept its absence as unreported, and no request, persisted format,
Action or wire epoch changes. Scan and Trash consume the daemon protection owner.

Storage summaries also add optional `measurement` presentation facts: `ready`,
`measuring` with `hasMeasured`, or `failed` with `hasMeasured` and an error message
that contains no native paths. The daemon returns last-measured figures during sizing, and no
measured rows before the first measurement. New consumers preserve Sizing for
that cold result and keep the existing revision watch subscribed. Absence retains
the legacy measured-summary interpretation; older additive-open/drop readers
discard the field. This development producer/consumer change adds no Action,
request, persisted format or wire epoch; the predecessor basis above has no
Storage domain. Current clients need the measurement-aware reader to distinguish
an unmeasured result from an empty inventory.

Unreleased 0.3 backup restore accepts optional `source.backupOperationId` to
select an exact retained scheduled run alongside its repository
`source.snapshotId`. Omitting it preserves pre-migration receipt selection.
Backup run results optionally retain
typed `restoreCaptures` using the existing closed source/configuration/native-target
capture schema, now owned by Protocol and re-exported by deployment-protocol.
Older manifest-only results remain readable and recoverable against a compatible
current native target after exact repository and payload verification. These
mutation envelopes and every nested capture remain closed; old strict development
readers reject new fields, so matching Protocol, daemon, SDK and UI readers reload
together. No released wire epoch, new Action or persisted index is introduced.

The unreleased 0.3 mounted Workflow trigger snapshot adds optional
`roleOverrides` and `visibleTeamId`, using the existing trigger-context schemas.
The snapshot and its nested mutation envelopes remain closed. Matching Protocol
and UI readers reload together: older strict development readers reject these
fields, while the new reader accepts snapshots that omit them. The existing
trigger add/update Actions already carry both settings; the snapshot preserves
them through agent reads, edits and undo until Save. The inspected `../0.2`
frontier at `33f6528a541872654370d84bd316261e8f7cacb6` has no mounted Workflow
authoring or trigger-draft contract, including scoped local changes. This direct
development cut adds no Action, route, persisted format or wire epoch.

Unreleased 0.3 Browser login-import results retain the existing
`app_bound_encryption` code and skipped status. Their optional closed `reason`
vocabulary also accepts the canonical app-bound recovery copy. Matching
Protocol, daemon and UI readers reload together: older strict development
readers reject this additional reason. No persisted format or released adapter
changes.

The unreleased 0.3 Saved Secret catalog adds optional derived
`capabilities.reveal`, produced from qualified access and ready material. Its
closed schema accepts retained projections without that capability; the current
UI offers Reveal only when it is explicitly true. Older strict development
readers reject the additional projection, so Protocol, Home and UI reload
together. This changes no persisted grant, encryption envelope or Action id.
The inspected 0.2 frontier at `b92a92801425868f22ac911d0f11327c37e1f43f` has no
Saved Secret resource catalog contract, including local changes in those paths;
no released compatibility adapter is needed.

Unreleased 0.3 encrypted Browser Action envelopes add optional non-content
`browserSessionId` routing. The shared sealer derives it from the Browser operand;
Home's authorization mint admits a Use guest only to Sessions they own or can
access through sharing. The opener refuses a routing/operand mismatch, including
an omitted projection for a Session-addressed command. Session-less operations
retain their existing addressing. Matching Protocol, UI/SDK producers, Home and
daemon readers reload together: older strict development readers reject the
field, and the new opener refuses older unprojected Session-addressed commands.
This is a direct development cut with no persisted format, epoch, fallback or
per-step Session reauthorization.

The unreleased Triage aggregate `entries/list-v1` and `tasks/list-v1` catalog
summaries carry the existing opaque `configurationRowId`; selected requests
pair that address with `sourceInstanceId` in `sourceInstances`. Both nested
objects remain closed. Matching Triage Action and mounted UI readers reload
together: this replaces the internal id-only selection directly, without a
catalog-scanning compatibility fallback, persisted format, source-plugin ABI
change, or new wire epoch.

The unreleased 0.3 Triage source entry snapshot adds optional `branches`
(`{ head, base }`, closed, bounded display text) for pull and merge requests.
The snapshot object is `additive-open/drop`, so an older Triage reader drops it
and a newer reader treats its absence (older sources, list scans) as unknown.
GitHub's exact read is the only producer today. A retained copy of a snapshot
carries it as the same optional member. No epoch, gate or adapter is added.

Unreleased 0.3 Session directory preflight accepts the optional literal-true
`prepareAgentIsolationMember` launch intent. Deliberate Session launch sets it
so the existing `sessionPreparation` owner prepares the admitted requesting
person before the native folder read. Background folder and isolation-status
reads omit it and remain read-only. The operand grants no requester, Home,
Machine or OS-user selection. The closed request requires matching Protocol,
CLI and UI development readers to reload together; older strict development
readers reject it. The inspected `../0.2` source at
`ead3f779118d6a3d17e167517a64660f9e2c2c0d` has no directory-preflight contract.
This direct development cut adds no persisted format, wire epoch, capability
gate or reverse-development adapter.

Unreleased 0.3 Workflow approval origins retain the exact accepted Run-start
authorization while correlating each leaf with its own invocation request ID.
The closed origin schema permits this distinction only for a Workflow caller
carrying that same root; ordinary origins and protected envelopes keep their
exact binding checks. Account roots remain Agent automation and PAT roots retain
API provenance. Matching Protocol and CLI source readers reload together; no
wire field, epoch or compatibility adapter is added.

Unreleased 0.3 Environment Copy failures use the template-instantiation partial
result envelope: acknowledged Environment identity and revision, the failed
binding step and code, and the existing typed continuation. Approval settlement
and public reads preserve that same envelope and retain their request-binding
checks. Store and Environment drafts keep completed steps visible and open the
failed step's existing editor instead of offering another create/install.
Matching Protocol, CLI and UI readers reload together; the previous untyped
Copy detail is an unreleased development shape, not a second compatibility path.
The binding-patch schema remains a deployment leaf shared with the Action catalog.
No authority, persistence field, retry timer or protocol epoch changes.

Unreleased 0.3 `session.agentTransition` committed-view partial results optionally
carry the existing closed `SessionSpawnLaunchErrorV1` as `errorDetail`, preserving
target-start recovery through the shared result parser. New readers accept its
absence. Older strict development readers reject the added field, so matching
Protocol, CLI and UI readers reload together. This direct development cut adds
no persisted state, wire epoch, gate or 0.2 adapter.

Unreleased 0.3 RPC handler exceptions retain the existing serialized `PluginError`
identity through a sanitized `PluginErrorContractData` projection: name, code,
redacted message, retryable, and the validated code-only `failureCause`. The RPC
producer excludes author details, remediation, diagnostics, and arbitrary fields.
The shared socket codec restores this exception after plain decoding or authenticated
E2EE opening; the transport preserves its known handler response rather than replacing
its code with transport uncertainty. Ordinary business results keep their existing
shapes. Matching development Protocol, CLI and sync-client readers refresh together;
this direct development cut adds no wire epoch, gate, or 0.2 compatibility adapter.

Unreleased 0.3 Provider error V1 envelopes optionally retain the shared Action
`requestId` and closed `failureCause`; their objects remain closed. Matching development readers refresh
together, while omitted identity remains readable. The closed Provider connection
view also accepts `sourceStatus: 'loading'` for the app's pending declaration
projection. This presentation state is produced locally, without sending a new
state to an older daemon or granting execution authority. Daemon descriptions
continue to produce `available` or `unavailable`, both accepted by the new reader.
Neither change adds persistence, an epoch, a gate, or a development-to-0.2 adapter.

Unreleased 0.3 Team credential Test results add optional `requestId` and
`failureDetail` diagnostics. New readers accept older replies with both fields
absent. Older strict development readers reject added fields, so this is not a
bidirectional mixed-version guarantee: matching Protocol, server and UI reload
together. The nested detail stays closed to the broker refusal code, carrier
stage and HTTP status; it carries no vendor body or arbitrary headers. Public
external Provider error classification remains unchanged, with no persistence,
epoch, feature gate or compatibility adapter added.

Unreleased 0.3 Plugin UI adds `VoiceCompactTranscript` and the optional same-realm
presentation-host callback `renderVoiceCompactTranscript`. The component delegates
to the app's existing compact transcript renderer inside `VoicePresence`; hosts
without the callback retain the author's fallback. Its presentation-only props
(`testID`, `fallback`) add no serialized object, union member, wire epoch, runtime
ABI or persisted field. Unknown fields gain no authority or routing meaning.
Refresh Plugin UI declarations and the matching app host together for rendering;
package API release classification remains separate from protocol evolution.

The unreleased 0.3 closed `VoiceAttemptPresentation` projection also carries an
optional `failureTitle` for a short failure identity, separate from its explanatory
`failureMessage`. Matching Protocol, Plugin SDK and host readers refresh together;
older strict development readers reject the new field. Omission uses the existing
error-state word. The existing Voice Action epoch is retained, with no persistence
format or development-to-0.2 author-contract rollback adapter added.

That projection's closed `surfaceState` enum also includes `live` for a connected
attempt whose provider reports no conversational phase. It presents Connected
without claiming Listening; the underlying Session mode remains `idle`. The UI
uses the Protocol-owned union, and matching unreleased 0.3 Protocol, Plugin SDK
and host readers refresh together. Older strict development readers reject this
new presentation member. The existing Voice Action epoch, persisted formats and
runtime phase contract are unchanged.

Unreleased 0.3 machine provisioners may declare optional `actions.renew` for a
renewable native wall deadline. The descriptor, resource input, optional selected
deadline and renewal result remain closed. Protocol owns the role and result;
the SDK, matching bundled producer and existing daemon retention consumer refresh
together. Older strict development readers reject the new executable declaration.
Omission preserves existing provisioners. This direct development cut adds no
persisted field, wire epoch, runtime ABI or 0.2 rollback adapter.

Managed provisioner options and their shared selection projection optionally carry the existing `BillingCapabilitiesV1` shape on base and dimension facts. Development hosts, SDK and producers move together; omitted billing retains the descriptor default and older result declarations may omit this optional fact through the canonical result matcher. This adds no required field, billing enum or wire epoch; refresh generated bundled manifests through their canonical publisher with the matched development contract.

Unreleased 0.3 Triage source descriptors add optional `minimumScanPageSize`,
bounded by the existing single-window transport capacity. Matching Triage
Protocol, target and source declarations refresh together. The outer descriptor
is additive-open/drop, so older readers drop the declaration; a source requiring
the minimum must target supporting hosts rather than claim that this preserves
older-host scan behavior. Omission retains positive arbitrary page geometry.
The existing V1 epoch, opaque provider cursor and Account storage remain
unchanged; no alternate parser or provider-specific target path is introduced.

Unreleased 0.3 Account authentication-mode declarations may carry the closed
`browserReachability: 'unreachable'` field. Omission preserves browser execution;
there is no separate reachable/unknown wire state. The existing UI authentication
host consumes this declaration only at sign-in/reauth start: native HTTP stays
local; an explicitly browser-unreachable mode uses the existing selected Machine
attempt owner on web. Established refresh placement is unchanged. Matching Protocol,
SDK projections, bundled plugin declarations and UI refresh together; older
strict readers reject the new declaration. This is a direct development-contract
evolution, with no alternate parser, new wire epoch or Home token proxy.

Web placement admits only a Machine advertising `connectedAccountAuthentication`
V1 through the existing operation-capability projection. The installed runtime
publishes that optional leaf only after the Home advertises acceptance of the
same leaf in `capabilities.machines`; older strict Homes keep receiving the
projection without it. The existing socket-claim withdrawal removes this leaf
when another daemon claims the Machine; that runtime must advertise support
again. Other sibling capabilities retain their existing lifecycle. Missing
support yields the existing `cli_update_required`
refusal before dispatch. CLI package versions cannot discriminate this operation:
the inspected 0.2 predecessor reports 0.2.20 while current source reports 0.2.10.
Neither projection revision nor this version identifies a loaded daemon build.

Unreleased 0.3 `selectActionInput` adds the closed, no-invoke
`session.spawn_new` / `sessionPlacement` projection. It accepts the existing
saved-project candidates and returns one exact candidate or cancellation;
it does not author an Agent recipe or start a Session. Matching Protocol,
SDK, Triage UI and host readers refresh together. Older strict readers reject
the projection; no fallback parser, wire epoch or 0.2 adapter is added.

Unreleased 0.3 contributed Actions may declare `approvalScope: 'environment'`.
This optional field is a closed executable-authority declaration, retained in
the daemon and Account Action projections. Matching development Protocol, SDK
and UI/CLI/daemon readers refresh together; older strict readers reject the
field, and ignoring it would incorrectly spend global approval policy. An
external plugin emitting it must target supporting hosts. The existing runtime
ABI and wire epochs remain unchanged, and no development-to-0.2 author-contract
rollback adapter is provided. Daemon Action failures may carry the existing
`actionHandlerInvocation: 'notStarted'` fact so the UI can present a required
confirmation and explicitly retry without repeating the effect.

The unreleased 0.3 Triage kind descriptor adds optional `glyph: 'shield'`,
and Plugin UI's icon vocabulary adds `shield` and `edit`. Matching bundled
protocol, source plugins and host icon readers move together under the direct
development cut. The descriptor remains closed: optional does not mean an
older strict reader accepts the field, nor does an older icon enum accept new
tokens. This is not a mixed-development-version compatibility guarantee or a
new wire epoch. An external plugin emitting these values must target a host
and Triage protocol reader that support them, using the existing engine and
`hostUiApiRange` admission where applicable; it must not claim an older host
range while emitting unsupported values. A plugin retaining older-host support
must omit the new field and use that host's existing icon vocabulary. No new
negotiation or permissive descriptor parser is introduced for this direct cut.

Unreleased 0.3 selected Triage fix-PR reads carry the existing configured-source
tuple and last-known locator in their closed `sourceContext`. The exact
configured-row owner derives its private tag and reads the stored active row;
the submitted tuple does not grant source authority. Matching development
Triage Protocol, UI and Account Action readers must refresh together because
the earlier closed context carried only `sourceInstanceId` and a locator.
Candidate-result contexts retain their id/locator and may also carry the known
stored row address. The existing reobserve exact-address input now consumes
that address instead of searching the configured-source catalog. This removes
catalog acquisition from a selected native association read without adding a
persisted field, index, wire epoch, runtime ABI or compatibility fallback. The
selected observation and closed entry-detail input also preserve that optional
row address through initial and continued detail preparation; addressless
callers retain their existing lookup path. The
scoped-clean 0.2 predecessor at `364d60bf067347f42e46e87c378af28ebfbd712d`
has no Triage Protocol, Triage plugin or Plugin SDK at these paths; reverse
development rollback is unsupported.

The unreleased 0.3 `deployments.observation.get` Action adds a machine-placed
read of recorded deployment identities for P50. Its input, result, nested
Environment/Link/receipt headers and credential principal references use closed
schemas. This is a distinct operation in the generated public Action map;
unsupported hosts refuse it rather than interpreting an ignored optional input
or falling back to generic internal Artifact access. The existing V1 wire epoch,
runtime ABI and persisted content formats are unchanged; matching development
Protocol, SDK projections and daemon readers load together. It grants no provider
credential acquisition or settlement authority and adds no reverse-development
rollback adapter.

Unreleased 0.3 managed bootstrap failures retain isolation Set conflicts and
changed-plan facts in the existing closed `managedAgentIsolation` details.
Both metadata versions and policies are retained; native plans and paths are
excluded. Existing Preview-unavailable details remain valid. Load matching
Protocol, controller, CLI and UI operation readers together because older
development readers reject the new Set arm. Released V1 operation projections
continue omitting these development-only details. No admission, credential,
isolation identity, wire epoch, migration or alternate cause carrier is added.

Unreleased 0.3 `providers.binding.status` accepts an additional
`{machineId, sessionId}` Action operand. Updated UI and CLI Action hosts derive
the existing daemon request through authenticated owner-only Session readers;
the full explicit operand and daemon RPC contract remain valid. Only the
Session-addressed `changed` result adds the exact
`providerBindingSecurityChangeConfirmationV1` consumed by `session.runtime.refresh`.
Refresh the Protocol, SDK DTO projection and originating Action hosts together
to use this development-only arm. No persisted format, grant decision, RPC
admission, wire epoch or runtime ABI changes.

Unreleased 0.3 stored native deployment admissions retain their closed wire
schema when approval Artifacts are read. The generic Environment-only union arm
must not consume Domain, restart or restore facts and erase their signed
discriminator or operands. Unknown native fields and kinds refuse rather than
normalizing into another admission. Existing valid approval bytes remain valid;
no Artifact rewrite, migration, wire epoch or new admission is needed. Refresh
the Protocol readers in the originating client, daemon and review hosts together.

Unreleased 0.3 capability previews retain optional `reachEnabled`, the Machine
rule owner's baseline before Session overrides. Current producers always emit it;
older previews remain readable with their existing effective `selected` value.
Matching development Protocol, daemon, Action host and UI readers must refresh
together because current preview objects are closed. Push-only reset-to-inherit
requires the updated producer; older previews do not retain that baseline. No
persisted selection, wire epoch, runtime ABI or migration changes.

Unreleased 0.3 `openConnectedAccounts` returns the existing Connect settlement:
connected/selected with a qualified account reference, or dismissed. The result,
account identity and nested service identity are closed; unknown fields and
credential material reject at the SDK transport reader. Its canonical reader
normalizes only legacy null/absent acknowledgements to `undefined`, allowing the
caller to re-read account options. Existing SDK readers discard a result, so
old-reader/new-host calls retain their behavior. No request, method capability,
wire epoch (1), semantic Host API generation, runtime ABI or package
version changes. The scoped-clean moving 0.2 predecessor at
`512915f3ccf4a29a8454b74ad9db6ca72079d916` has no Plugin SDK UI host contract.
This is an additive development response, not a released-package claim.

Unreleased 0.3 External Action locality refusals retain their selector or
locality phase in the existing Action failure details. Exact matching Machine
targets remain supported; admission decisions and error codes are unchanged.
Pre-open `target_not_local` failures also retain a closed receiving phase through
the current relay, HTTP and client error readers; other transport failures cannot
carry this field. Released V1 relay projectors continue omitting it. Matching
development Protocol, daemon, Home, CLI and SDK readers must refresh together
because current objects are closed. No protected-envelope opening is changed.

Unreleased 0.3 Session runtime failures may retain the daemon's existing closed
plugin preparation `{ code, stage }` as `failureCause.preparationCause` through
the Agent failure projector. The Runner client may add its existing contribution
request's `requestId` for diagnostic correlation, retained in the settled Session
presentation. Omitted request IDs remain valid. Source identifiers may contain
hyphens; messages, source identities and credentials are excluded. The Protocol
owns that schema and the CLI retains its existing export. Matching development
Protocol, Runner and UI readers must refresh together because
the current `failureCause` object is closed. No lifecycle state, retry, timer,
wire epoch or migration is added.

The existing Runner daemon failure envelope may also retain the PluginError's
optional `retryable` boolean so a definitive source refusal remains definitive
after transport. Omission retains the existing client behavior. Matching
development daemon/CLI readers must load together; older strict readers reject
the new optional field. This conveys the source's decision and adds no retry.

Unreleased 0.3 native service observations add optional `displayName`, retained
through the existing host snapshot as `nativeDisplayName` and projected as
`native.displayName` in Machine service rows. The native adapter owns this display
identity; a person's watch label and the opaque native resource ID retain their
existing meanings. Matching development Protocol, SDK, CLI and UI readers must
refresh together because the current native objects are closed. Existing
observations without a name remain readable. No persisted field, wire epoch,
runtime ABI, or compatibility adapter is added.

Unreleased 0.3 Connected Service configuration replacements add optional
`selectedSecrets` for service-scoped Saved Secret reference patches, and reads
add optional `secretRefs` metadata. Matching development Protocol, UI and CLI
must refresh together because the current Action schemas are closed.
Account/attempt configuration remains inline. This changes no persisted catalog
shape and adds no wire epoch, migration or compatibility adapter.

Unreleased 0.3 Action operation readers retain exact native service-control
subjects, optional reboot Domain subjects and optional deployment `expectedDown`
subjects in the existing `domainRef`. Recreate and stop-copy producers publish
exact service IDs and retained Domain subjects before interruption, then
withdraw them after phase acknowledgement or confirmed resume. The closed
Inbox expected-operation projection also accepts `backup`.
These facts explain a matching health notice only while its already-readable
operation is running; they do not change health or Machine presence authority.
Matching development Protocol, CLI and UI readers must refresh together because
the current objects are closed. The released V1 projector continues omitting
these domain references: the predecessor at `37a654157874` accepts only fork,
spawn and handoff references. No migration, new wire epoch or server-side
expectation record is introduced.

Unreleased 0.3 Project Source deletion uniformly tombstones metadata through
the nullable `ProjectSource.deletedAt` column added by an append-only migration.
Ordinary Source reads and new-Environment admission exclude deleted records;
Environment and receipt history retain the same admitted Source identity and
name. The existing closed `{ ok: true, sourceId, revision }` acknowledgement and
all inputs remain unchanged, including for older CLI readers. The development-only
`environment_history_retained` refusal is removed. No wire epoch, runtime ABI,
alternate disposition owner or compatibility adapter is added. Deploy the additive
migration before loading the new server; rolling back the server after tombstones
exist would expose them again in old lists and is unsupported.

Unreleased 0.3 Software Apply operation failures may carry closed
`details: { kind: 'machineSetup', failure: { kind, reason?, requiredFact? } }`, reusing the
elevation owner's diagnostic schema. Current operation readers preserve this
presentation data; the existing released V1 projection omits all error details.
Matching development readers must refresh together because earlier strict current
readers reject the new detail kind. Failure codes and uncertainty semantics stay
unchanged. No wire epoch, runtime ABI, migration or compatibility adapter is added.

Pre-native Setup refusals use the same closed diagnostic with
`failure: { kind: 'target_unavailable', phase: 'machine_setup_target', branch, reason? }`.
The branch identifies installed-runtime or finite-terminal availability; the optional
reason is a fixed, content-free predicate name. Matching development Protocol,
daemon, CLI and UI readers must refresh together to retain this additional failure
shape. It changes neither admission nor the native execution identity.

The same unreleased diagnostic preserves the native owner's optional non-secret
`requiredFact` through private CHECK and elevation refusals. An unavailable
firewall fact is `required_fact_unavailable`, with its fact name in the Domain
remedy; actual reviewed-plan drift remains `plan_stale`. The private interpreter
and daemon refresh together, as do development readers of the closed failure
diagnostic; existing failures without the fact remain readable.

The unreleased private Machine firewall V1 intent distinguishes `preserveSsh`
(preserve native management scopes in both stages) from `retainSsh`
(apply an explicitly reviewed SSH posture). Domain reconciliation uses the
former even when stored posture says closed. This executable declaration and
its nested operands remain closed; unknown fields and intent kinds reject.
The development daemon and installed root helper refresh together under the
0.3 direct cut: an older root helper rejects the new `preserveSsh` kind before
applying changes. There is no downgrade, new wire epoch, migration or server reload.

The existing public SSH close choice now consumes that reviewed transition via
reachability configure. Its unreleased review basis optionally carries the
canonical firewall intent, setup revision and native Docker impact identities.
The Home, browser and daemon protocol readers refresh together for this close
choice; old reviews require fresh preparation. The already-approved Domain SSH
preservation fix can ship independently in v16 without this new review field.
The persisted `reachabilityPosture.management.publicSsh` format is unchanged:
no records are removed or reinterpreted, and Domain reconciliation still uses
`preserveSsh`. This wiring does not hold a payload refresh already in progress.

The unreleased Configure result also retains the firewall owner's optional
`recovery` capture through the [existing Action outcome](actions.md). Matching
0.3 protocol, daemon, UI and generated SDK readers refresh together; no migration
is needed. Existing results without the optional capture remain readable.

The unreleased Domain failure details also distinguish a missing post-stage
Home-routed daemon ACK (`requiredFact: 'homeRoutedDaemonAck'`) from a native
firewall observation. They retain the observer's optional non-secret RPC error
code and the native owner's verified restoration. Native cancellation without
an observed missing fact remains cancellation. Home permits the exact admitted
`capabilities.describe` read back to the registered daemon's socket; other
self-calls remain excluded. This correction requires both the development Home
server and daemon to refresh, without changing the Action envelope or storage.

The same unreleased Domain details name unavailable native Caddy facts, including
`caddyAdminConfig`, and preserve non-secret OS or HTTP error codes and a remedy
through the guest, controller and public Action response. Docker start is not
admin readiness: the native Caddy owner awaits its Unix admin API while observing
container exit and the admitted operation's cancellation. Existing owned Caddy
state remains available for reconciliation after refusal. This correction needs
a guest daemon refresh; it adds no server reload, Action envelope or storage change.

On a subsequent admitted Domain setup, a stopped owned Caddy container whose
Docker state reports a deleted primary network is recreated on the admitted
route network. This uses the existing publication reconciliation after ownership
and mount checks, retaining its mounted data, configuration, autosave and surviving
network attachments. Before replacement, Docker's network inventory filters out
deleted attachments; an unavailable inventory leaves the existing container intact.
Public listener additions run against the resumed container.
The correction is daemon-side, introduces no timer or automatic retry, and does
not remove the mounted state directories.

Unreleased 0.3 Machine isolation unavailable status adds optional
`prerequisite: { reason, requiredFact, remedy }` for preparation refusals before
native CHECK. The reason and required fact are closed; the remedy is non-secret
display text selected by the preparation owner. Existing statuses remain readable.
Matching development Protocol readers must load with the daemon producer because
older strict readers reject the added field. This extends the existing preview,
Machine publication and operation-detail schemas without a new wire epoch,
runtime ABI, migration or compatibility adapter.

The unreleased 0.3 Machine terminal request adds the closed `service_shell`
launch intent. Its service id and reviewed native generation are resolved by
the receiving service owner; callers cannot combine it with a cwd, Workspace
or Session selector. Matching development Protocol and daemon readers are
required. An older closed reader refuses the new intent rather than opening
an ordinary shell. The existing terminal operation and response envelopes
remain the owners; no alternate writer, runtime ABI or wire epoch is added.
The scoped-clean 0.2 predecessor at `b06b31d66f94` has no terminal or deployment
schema at these paths; reverse development rollback is unsupported.

Unreleased 0.3 deployment repository definitions and exact source intents allow
omitting `compose` for provider-built platform targets. Authored Environment
creation retains `{definition:{from:'repository',ref}}`; Publish retains the
existing repository and platform destination arms. Native first-target creation,
own-server Publish, native acquisition, native receipts and native review bases still require
Compose selectors. All enclosing and nested objects remain closed, and no
unknown field gains source or authority meaning. Existing Compose-bearing
records remain readable unchanged. Matching development Protocol, CLI, server
and UI readers are required: earlier strict readers reject the omitted required
field, so there is no mixed-development fallback. This updates the unreleased
V1 contract without a new wire epoch, package version, runtime ABI or database
migration. The scoped-clean 0.2 predecessor at `b06b31d66f94` has no deployment
Environment/source-intent owner; reverse development rollback is unsupported.

Unreleased 0.3 Account Action contexts expose optional host-stamped
`invocationId`, using the existing Action request identity for diagnostics only.
Portable callbacks without an Action request omit it. It grants no authority,
replay or credential capability. Triage uses it to correlate setup refusals with
the host read when no source Action was invoked; source failures retain their
original request identity. Matching development Triage readers consume optional
diagnostic `requestId`; their strict artifact schemas must refresh together.
No persisted format, transport envelope, runtime ABI, wire epoch or package
version changes.

Unreleased 0.3 `connectedServices.accounts.revoke` makes its existing `machineId`
operand optional and uses Account execution placement. Omission removes Account
custody through the existing V4 credential DELETE, preserving revision admission,
dependency review and the existing `remoteNotAttempted` result. A supplied Machine
retains the native provider-revocation path. Matching development Action owners
are required for omission; older owners refuse the missing Machine. The request
envelope remains closed. No persisted format, route, error code, ABI or epoch is
added.

Unreleased 0.3 skills add optional private `skillCreator` attribution and a
content-derived header summary. Existing records and historical Action results
without these fields remain readable; absence establishes neither a person nor
a Bot creator. Bundle/export bytes stay unchanged. Matching development Action
owners and generated SDK DTOs carry `skills.list({skillIds})` and acknowledged
create summary/inclusion results together. The selected-id input is closed and
must not be silently ignored by an older reader, which could return unrelated
skills. These additions introduce no wire epoch, runtime ABI, migration or
parallel endpoint. The existing Session `rightSidebarTab` slot and immutable
transcript snapshot rules are unchanged.

Unreleased 0.3 deployment target roles retain optional closed
`preparedNative.pages` operands for an adopted Pages project's mode, production
branch and non-secret build command/output/root. The link, receipt and runtime
role envelopes remain closed, and their nested Pages object rejects unknown
fields. Existing operands without Pages metadata remain readable; Pages upload
requires the matching development producer and consumer rather than ignoring
the captured settings or re-probing them. Earlier strict readers reject the
addition. This extends the current V1 development contract without a new wire
epoch, runtime ABI, package version, credential field or compatibility adapter.

The unreleased 0.3 `session.transcript.get` external-shareable projection accepts
`cursor: 'tail'` to acquire an empty no-history page at the committed Session
sequence. The Machine transcript owner retains Session access and encryption
material admission; it reads no transcript rows for this acquisition. Channels
uses this single boundary for binding creation, rotation, `/new` and gap recovery,
so an older unsettled turn cannot block attachment. Ordinary continuation reads
retain publication barriers. Matching Channels and Machine hosts are required;
older hosts refuse the cursor as `invalid_cursor`. No persisted format, server
route, envelope, runtime ABI or wire epoch changes.

The unreleased 0.3 `sessions.spawn.connected_services.list` input adds optional
`includeDefaults: false` for explicit CLI authentication discovery. Omitting it
retains default resolution. This bounded presentation flag changes no identity,
credential admission, authority, result union, persistence or wire epoch. The
existing additive-open inventory input preserves unknown fields; earlier owners
may ignore this flag and retain their catalog refusal. Matching development CLI
and Action owners remove that dependency; no compatibility fallback is added.

The unreleased 0.3 `workflow.definition.list` request adds optional exact saved
`definitionId`, using the existing get identity vocabulary, including retained
non-UUID ids; creation still requires UUIDs. The routing envelope remains closed
and this selector cannot be combined with `workflow`, `cursor` or `limit`. Matching development callers and
Action owners are required; earlier strict readers refuse the selector rather
than returning an unfiltered catalog. Existing list and canonical Workflow/plugin
selectors retain their shapes. No wire epoch, runtime ABI, persisted format or
released-client contract changes; the inspected 0.2 predecessor at `0cdd7fb1fcc`
has no Workflow definition Action owner.

The unreleased 0.3 `shell.column.get` result adds optional closed `items`
metadata (id, label, availability/reason, effective placement and page kind).
Matching development Protocol and answering-client readers supply this projection;
`shell.column.set` keeps its input shape and permits selection through the mounted
main owner as well as the side owner. There are no new Action ids, ABI or wire
epochs. Device-local navigation placements extend their existing stored map with
sparse `detailPages` and `pageTabs` branches. Stored readers strip unknown fields;
Action writes remain strict. Existing mapped Session/Project branches retain
their addresses and data without copying or a database migration.

The device-local pane checkpoint adds optional nullable `mainTabId` for Session
Editor-first page selection. Missing records retain Chat; the companion's existing
destination remains independent. Phone checkpoint writes preserve the saved desktop
page choice through the existing pane persistence owner. This is unreleased 0.3
local state, with no new server schema or transport field.

The unreleased 0.3 `openSurface` request and `OpenSurfaceOptions` add optional
`presentation: 'window'`. Matching Protocol, SDK and mounted host readers are
required because earlier closed development readers reject this field. Omitting
it retains the existing destination container. Unsupported hosts or destination
owners return the existing `unsupported_method` envelope instead of dropping the
requested presentation. There is no API-version/ABI/epoch change or compatibility
translation. Workspace tab Actions retain legacy `tabId` and add qualified
`address` inputs; pane addresses include their Home, Account, layout, scope and
tab key. These are local answering-client contracts, not new server records.

The unreleased 0.3 desktop shell adds the closed client Action
`desktop.notch.set {state?: 'rest' | 'open' | 'pinned', position?: number | {x,y}}`
with the closed success result `{applied:true}`. Matching desktop source supplies
the effect; hosts without it report typed unavailable through the existing Action
dispatcher. Generated SDK Action DTOs consume the Protocol schema. This adds no
runtime ABI, external wire epoch, Account setting or persisted presentation format.
The native presentation request and keyboard commands are same-build renderer/host
IPC; no released mixed-version adapter or alternate presentation owner is added.

The unreleased 0.3 signed Workflow origin accepts a closed `sessionLeaf` variant
for an admitted Session's Workflow child Actions. Its nested caller, accepted
authorization and requester-attribution objects are closed; an unknown field
never acquires authority. It is mutually exclusive with `sessionAuthority`.
This extends the existing installed-source proof and authorization V1 carrier,
independently of package SemVer and runtime ABI. It requires matching development
issuer, Home and daemon readers: older strict readers refuse `sessionLeaf`.
There is no released predecessor producer, persisted format change, permissive
fallback or host-caller translation. FIN supplies the retained leaf admission;
its relay integration is a separate consumer of this producer contract.

The unreleased 0.3 Plugin SDK connected-accounts entry exports cli-common's
`classifyConnectedAccountTokenEndpointFailure`. Codex/Claude diagnostics carry
its existing Protocol failure kind in the existing optional JSON `details`
slot as `credentialRefreshFailureKind`; matching daemon source projects that
kind into the existing health field. Older hosts ignore that detail and retain
their prior health behavior. No diagnostic schema, enum, wire epoch, runtime
ABI or persisted shape changes; stored rows without a cause remain readable.

The same development SDK entry also exports the structured
`parseConnectedAccountTokenEndpointFailure` result. Codex adds its optional,
allowlisted `providerErrorCode` to the existing diagnostic details bag; matching
daemon source prefers it in the existing health `providerErrorCode` slot.
Older producers omit it and retain the plugin diagnostic code fallback. The
classification API, normalized kind, health schema and authentication decisions
are unchanged; this adds no wire field, migration, ABI or version gate.

Unreleased 0.3 manifest V2 destination views accept optional `resourceLinks`,
using the existing closed resource-kind, URL-pattern and local-destination grammar.
Existing SCM view declarations remain valid; resource-only integrations use their
real destination without claiming an inline slot. Matching development projection
and UI readers are required; earlier strict author readers reject the new field.
This keeps projection V2 and runtime ABI 1, with no persisted format or released
compatibility adapter. The scoped-clean 0.2 frontier at
`2b8fe93db6cb8ec2969f81e738a2f818a7dd8106` has no plugin contribution owner.

Unreleased 0.3 Discussion channel provenance adds optional sealed
`externalSource.inputLocalId` to the Protocol-owned content schema and generated
SDK Action DTOs. New thread roots use it to retain original ingress correlation
while their native local id identifies the external thread. Existing messages
without the field keep their original local-id correlation. This draft content
addition ships with matching first-party readers and writers; it changes no
runtime ABI, envelope mode, database schema or released 0.2 contract. The inspected
0.2 predecessor at `2b8fe93db6` has no corresponding Discussion content owner.

The unreleased 0.3 Account Action context adds optional invocation capability
`services.machineConnectorSecrets.write`. Its closed input contains token bytes
and the existing closed access-provider/connector identity; its closed result
contains only `{ grants: [{ machineId, installationId, grantRef }] }`. The host
supplies the controller, receiving installation and public key, and admitted
operation through the existing Domain admission.
This is an in-process SDK/host addition under runtime ABI 1, independently of
package SemVer. The public catalog declares `MachineConnectorSecretsService`
with realm `cli`; it adds no wire epoch, persistence format or authority union.
An absent sink means this invocation cannot write a connector
grant; an author must refuse that operation rather than omit its effect. The
scoped-clean moving 0.2 predecessor at
`a7cfad84168f21b364b37d431175f50c311acb7e` has no Plugin SDK or connector-grant
host path. No released compatibility adapter or reverse-development rollback
direction is introduced.

The same unreleased development cut adds optional protected Domain
`cloudflarePreparation` content for acknowledged tunnel/DNS ownership and an
opaque installation grant. Its private native-child `cloudflareConnector`
operand is excluded from the public child-routing projection. These strict
development schemas carry provenance, never vendor token bytes; they do not
establish native activation or loaded-runtime readiness.

### Page location view (unreleased 0.3)

The unpublished 0.3 plugin UI `replacePageLocation` request adds optional `view`, a
contribution local id naming the caller's own declared `appPage` that the new location
presents. It is presentation only: the host titles route chrome from that view's
declaration, and omission means the mounted page. The request stays closed, so an older
strict host refuses it; bundled first-party plugins (Triage) ship with matching host and
SDK source, as for `preserveUnsavedChanges`. No persisted format, method or negotiation
version is added, and the `../0.2` frontier has no plugin page location owner.

### Adopted Compose target-link origin (unreleased 0.3)

Deployment protocol `/v1` remains an unreleased draft epoch, independently of
package SemVer. Its closed own-server target-link content accepts optional
`nativeOrigin: { projectName, dockerEndpoint, workingDirectory }`, with all three
nonempty strings required when present. `dockerEndpoint` is the captured native
engine identity used by Machine native-effect admission; Machine and installation
identity remain on target-link membership. Existing stored `{}` links remain
readable through the same strict target-link Artifact reader.

H11 adoption adds optional `capture: { installationId }` inside that protected
origin. The installation selects the imported member from link membership without
retaining watch metadata or configuration paths. P41 consumes the physical project and
engine selectors and retains the current native generation in its existing
reviewed input basis. These executable selectors, the closed
`machines.services.adopt` Action and the SDK native source-capture callback require
matching development protocol, SDK, plugin and daemon consumers. They are a
coordinated unreleased 0.3 source contract, not ignorable presentation fields or
a new version, epoch, migration or compatibility gate. Older origin leaves
without `capture` retain their original physical project/engine semantics.

Adopt apply envelopes now carry the create `deploymentPreparationAdmission`.
Earlier development Homes refuse that field on this root, and earlier daemons
sign adopt preparation with the Create effect, so matching Protocol, UI, CLI
and Home source reload together. This direct development cut adds no wire
epoch, persisted format or predecessor adapter.

The existing host-only Environment create preparer accepts the captured origin
and writes it in the first target-link Artifact through the existing mode-aware
Account Artifact owner. Public create/storage requests contain only the Artifact
reference; server-visible target metadata does not gain native paths or project
names. Original Compose/config/env files and values are not part of this leaf.
This producer does not activate a stack or transfer watch custody; P30/P41 own
that composition and first-deploy handoff. No import record, second content writer,
migration or development rollback adapter is added. The scoped-clean moving 0.2
frontier at `b53a968ce1424a7b2f6f9d76bd9126871d145fd1` has no deployment-protocol or
CLI deployment owner at these paths.

The unpublished 0.3 `ManagedServiceRequest` adds optional literal
`interactive: true` to its closed request and private runner HTTP-open envelopes.
Omission means finite work; interactive event subscriptions retain scope
retirement cancellation. The client-environment arm and response/read envelopes
are unchanged. This lifecycle input requires matching development SDK, host and
runner source under the existing ABI, independently of package SemVer; it is not
an ignorable presentation field or a new persisted format. The scoped-clean
`../0.2` frontier at `fd3f03529d96e899e95c8b384f5843340a1339c6` has no managed-services
SDK, private endpoint protocol or OpenCode plugin path. No released compatibility
adapter or reverse-development rollback direction is introduced.

The unpublished 0.3 SCM clone input adds optional
`initialCheckout: { branch: 'main' | null, commit }`, with a closed nested object and
the existing full SHA-1/SHA-256 commit schema. Project Open carries this same
operand in its clone materialization, through both owner and private-member
execution; it has no separate top-level checkout operand. Matching development
Open readers are required because older strict readers reject it.
The explicit `null` branch selects a detached HEAD without moving local branch
refs; `'main'` retains the reviewed starter-checkout contract. Open derives the
detached operand for a full commit ref through the existing commit schema.
The mutation input remains closed;
omission keeps ordinary clone semantics. Dropping this operand is unsafe, so
matching development host/SDK source is required. Older strict host admission
rejects it. The current host also checks the callback's existing snapshot:
an ignored pin or missing head fact settles as a typed failure with the created
destination, never successful pinning or an automatic replacement clone.
This is the unpublished direct cut, independently of package SemVer, with no
persisted format, new epoch or reverse-development adapter. The inspected
scoped-clean `../0.2` frontier at
`fd3f03529d96e899e95c8b384f5843340a1339c6` and immutable
`cli-v0.2.17` / `cli-v0.2.17-preview.1` have no corresponding clone contract in
the affected Protocol/SDK/clone-route paths.

The same unreleased clone owner also accepts `initialCheckout: { branch }` for
a selected remote branch and optional `authentication: 'connected_account'`.
Project Open derives both fields from the clone input. Omission preserves the
existing clone behavior; a connected-account request requires the provider's
private credential callback and never falls back to ambient Git credentials.
The optional SDK repository filesystem port keeps reservation, publication and
readback on the admitted workspace source; a bound older host without that port
returns `BACKEND_UNAVAILABLE`. The private provider credential callback is not
an Account Action result. These changes require matching development Protocol,
SDK, provider and CLI sources, without a new epoch or persisted migration.
Managed pre-Session clones require the matching native holder's `workspace`
stdio mode and confined helper's empty-directory removal operation. Connected
clone and target push also require the optional SDK `repositoryTransport` port
and native `git-http-transport` command: credentials remain on the controller,
with binary smart HTTP forwarded through the existing holder streams to a
credential-free target loopback endpoint. These are matching-source development
contracts, not a wire epoch or a persisted credential format.

The unpublished 0.3 signed external Action binding adds optional literal
`managedAcquireDelegation: true`. Only Home derives it from the exact reviewed
Team preset and bound custodian controller. The receiving daemon consumes that
decision through its existing approval owner while retaining the member
principal and custodian credentials. Callers cannot supply the fact; omission
retains ordinary approval policy. Fresh acquisition admission that resolves a
delegated preset requires this verified bit and otherwise refuses with
`permission_denied`; retained admissions remain read-only replays without
requalifying delegation. This is authority in a closed signed binding,
so matching Home, Protocol and daemon source reload together; earlier strict
development readers reject the addition. This uses the existing V1 epoch and
unpublished direct cut, with no persistence migration or reverse-development
adapter. The inspected `../0.2` frontier
`b825a99dfedcb68e223155a1ba0be84babe9e2d0` has neither the corresponding binding
nor daemon executor path.

The unpublished 0.3 managed acquire-result V1 contract adds optional literal
`startPending: true` only to its closed bound-result envelope. Nested resource
identity and value admission are unchanged. It reports a start accepted by that
acquire invocation whose native start returns before boot (currently Lume
HTTP202), so dropping it can prematurely fail that starting guest;
matching development host, Protocol and SDK source are required. Omission keeps
ordinary bootstrap behavior. The host consumes the fact until the first exact
Running observation and does not persist it or infer it from retained custody.
Read-only reconciliation emits no reconstructed acceptance. This uses the
existing V1 epoch and unpublished direct cut, independently of SDK package
SemVer, with no migration, compatibility adapter or reverse-dev rollback promise.
The inspected moving `../0.2` frontier at
`ff9a75fe6da334934b568b84df7662d4120c3ed0` has no managed acquire-result or
machine-provisioner SDK author path.

The unpublished 0.3 machine-provisioner destroy-result V1 adds the closed
`{ kind: 'pending' }` outcome for positive evidence that accepted deletion is
unfinished. It carries no diagnostic code or cause; `accepted` retains the
existing exact native-operation reference, and failures remain `unknown` or
`refused`. Ordinary power and file-write results do not admit this outcome.
This authoritative lifecycle fact requires matching development host, Protocol
and SDK source under the existing V1 epoch and unpublished direct cut,
independently of package SemVer. It introduces no database schema change,
migration or reverse-development adapter. Correlation recovery already carries
the declared launch, including the backend and namespace Crabbox needs for an
exact read; no recovery operand is added. The scoped-clean predecessor at
`fd3f03529d96e899e95c8b384f5843340a1339c6` has no corresponding provisioner
Protocol or SDK author path.

The 0.3 development SDK adds `exec.clients.connectJsonRpc` for existing Unix
WebSocket endpoints. Existing process-client `spawn` operations keep their
contracts. The new connection handle has no process identity or manufactured
process-exit result; connection errors preserve real OS codes and syscalls for
the caller's existing readiness policy. Available and unavailable invocation
facades expose the same method. This is an additive development API with no
persisted-format or candidate-index change.
`PluginJsonRpcClient.onNotificationReceived` is also a required synchronous
receipt subscription on matching development host/SDK builds. Codex consumes
those notification facts for its existing approval metadata projection;
request/response dispatch still bypasses ordered domain callbacks.

The 0.3 development External Sessions author contract adds optional
`hydrateCandidates`, an in-process selected-page display operation under the
existing runtime ABI. Its source, candidate request/result envelopes and nested
identity/link fields remain closed. Only title, cwd and message count can change;
count, order and all other candidate facts are checked against the admitted input.
The host derives one positive support facet from the current registration and
returns typed unsupported when absent. Matching development host and SDK source
are required; no method-presence version fallback, new wire epoch, persisted index
format, migration or reverse-development adapter is introduced. Existing v2
indexes remain readable because enrichment happens after selection and is never
persisted. The 0.2 predecessor has no plugin SDK External Sessions author operation.

The unpublished 0.3 ACP author contract adds optional
`AgentAcpRuntimeDefinition.allowExplicitUnlistedModels` and optional
`configuration.model.selectionSource: 'explicit' | 'inherited'`. The configuration
envelope, nested model object and enum remain closed; omission stays inherited.
This is an in-process host/plugin contract under the existing runtime ABI and V1
configuration epoch, independently of SDK package SemVer. Matching development
host and SDK source are required: dropping explicit intent could clear a requested
model instead of applying it. No persisted model format, released-client floor,
new catalog, dual writer or reverse-development rollback adapter is introduced.

The 0.3 development shared allocation classifier is an in-process presentation helper, exposed
through the existing SDK `/machine-provisioners` entrypoint. It consumes only
allocation and an optional already-correlated creation-operation fact; it adds
no operation lookup, authority, persistence or wire epoch. Absent operation
evidence preserves `may-exist`, while only running acquire/retry evidence can
classify it as creating. Host correlation and translated recovery remain owned
by their existing adapters.

The unpublished 0.3 machine-provisioner contract also adds optional
`actions.snapshot`, paired coverage/cost facts, and the closed snapshot role
input/result through that entrypoint. Missing support remains unsupported.
Snapshot failure or uncertainty cannot be dropped into a successful restore:
the existing restore parent retains the result and requires a fresh explicit
choice to continue without it. Host and plugin source must match for the new
`machineProvisioners.waitForNativeObservation` service method. These direct
development changes introduce no persisted format, new epoch or adapter for an
earlier development host.

The existing Plugin UI Resource V1 reference union adds the closed
`{ hostRead: 'machines.managed.list', input: { homeId } }` arm. Both envelope and
input reject unknown fields, including selectors this active-inventory
observation does not implement. The existing Action preparation admits every
mounted read/watch before borrowing the canonical inventory. Resource events
remain bounded invalidation signals, and Account retirement withdraws cached
bytes. Explicit Retry refreshes the same inventory; invalidation reads consume
its already-applied receipt.

These unpublished SDK/host additions use the direct cut below, independently
of npm SemVer. An older host rejects the new reference rather than dropping
its meaning; no released-client update floor, polling fallback, dual writer,
new epoch or reverse-development rollback adapter is introduced. The inspected
moving 0.2 predecessor at `c1e74e521fa2e725702ae21b472afe46a9d2d6c6`
has no machine-provisioners SDK author path.

The 0.3 development client Actions add optional boolean `replace` to
`workspace.tabs.open` and `reconsiderCli` to `machines.add.local.start`.
Omission preserves existing behavior; the answering client enforces replacement
through the existing guarded Workspace owner and reconsideration through the
existing private native setup owner. Earlier strict input readers reject these
operands instead of silently dropping their navigation or consent meaning.
These current-source changes introduce no persistence format or wire epoch.

The same local-setup Action also accepts the closed alternative
`{ serverId, purpose: 'relay_repair' }`, with no `reconsiderCli` operand. This
selects the existing exact-Home repair task rather than guided enrollment;
dropping the purpose would change its service-consent behavior and is unsafe.
Older strict readers reject that input. The existing omission/boolean input
remains readable, and both arms use the same Action approval and private setup
owner. Only enrollment enters the Add draft and machine-arrival watch. This is
an unpublished 0.3 direct cut, with no new epoch or persisted format; the
inspected moving 0.2 predecessor at
`084961916ebf908baec6fd4453aa8ecd8f5d8516` and immutable UI tags
`ui-web-v0.2.19` / `ui-web-v0.2.19-preview.25` have no corresponding Action.

The 0.3 development `session.bot.set` Action adds optional `expectedBot` to its
closed input; the nested Bot marker remains the closed V1 shape. Omission
preserves unconditional writes, and explicit null requires no current marker.
This mutation condition is not safely ignorable: a host must enforce it on every
metadata CAS candidate or reject the input through strict Action admission.
Older strict readers reject the operand rather than silently applying an
unguarded inverse. This adds no persisted format, marker version, dispatch wire
epoch or host/runtime ABI version. The current `../0.2` frontier at
`c1e74e521fa2e725702ae21b472afe46a9d2d6c6` has no corresponding Bot Action/schema
or Undo producer in the inspected paths; no predecessor adapter is required.

The unreleased 0.3 face extension adds optional shared `botFace` metadata and
summary fields alongside the optional Bot marker. Missing or unavailable metadata
does not imply a Bot or a face override. Strict face writes use the canonical
cosmetic schema; stored reads discard unknown extensions. The optional
version-1 `shape` travels inside the same face field, including template
identity and Artifact headers. It is an additive cosmetic extension, with the
existing `body` as the rendering fallback. Planet ignores both body and shape
art and keeps its standard planet, palette and mouth. Face Actions, template
authoring/release and birth use the same admission and centring owner;
stored readers carry admitted art without revalidating its
geometry. Readers predating shape discard the unknown extension under the
existing stored additive/drop contract, so an older rewrite may lose custom art;
there is no mixed-development-version preservation guarantee or adapter.
The current `../0.2` frontier at
`6de38e0ff3e63649ad152145cdc292ee015215b8` has no corresponding Session face
schema. This adds no new wire epoch, metadata layout or runtime ABI.
The unreleased closed face Action input also accepts a seeded generation request
inside `face.shape`: `{ generate: 'surprise', seed: <integer> }`. It resolves to
the existing concrete shape before persistence. Older strict Action readers reject
this request, so reload the calling clients and executing CLI/daemon together;
there is no stored-shape change, fallback algorithm or mixed-development-version
generation adapter.
The Account's new `botFaceStyle` preference defaults to Dither. The additive `botMotion` preference
defaults to `lively`; `reactions` retains finite reactions and `still` stops Bot
motion. System Reduce motion takes precedence. Unknown saved values use the
default through the Account preference reader; the settings Action accepts only
the declared choices. `avatarStyle` adds Planet while
retaining the current brutalist fallback and saved choices. These are additive
development contracts, not a new metadata layout, wire epoch or host/runtime ABI.
The earlier 0.2 avatar catalog is a separate pre-existing compatibility seam;
this extension does not migrate its removed styles.

The unreleased Provider endpoint-policy extension keeps manifest schema 2,
Provider declaration V1 and host/runtime ABI 1, independently of npm SemVer.
Endpoint constraints, credential transports and additional credential slots,
connection overrides and mutation operands are closed, including their nested
objects, as is Agent `credentialSupport`. A transport with companion credentials
requires `credentialSupport.supportsAdditionalCredentials:true`; omission retains
single-key behavior and does not authorize an adapter to drop companions.
A required location, address/model constraint, routing header or secret
destination is not safely ignorable: a matching development host must enforce
it or refuse the contribution/operation through existing admission. Localized
policy hints and authority descriptions are display facts and confer no power.
The SDK aliases these Protocol-owned declarations rather than adding a second
normalizer. Existing declarations without the new fields retain their behavior.

This follows the unpublished author-contract direct cut below, not a new
released-client update floor, dual writer or reverse-dev rollback promise.
Manual catalog readiness remains a local admission result; older readers may
not turn an unsupported remote probe into authentication success or accept a
policy edit while dropping its restrictions.

### Manifest load compatibility (0.3 development source)

Owner decision 2 for the prepublication SDK cleanup establishes **strict author,
tolerant load** for manifest V2, independently of npm SemVer and runtime API 1.
Author-time `definePlugin`, pack and doctor remain closed. The host's canonical
Protocol ingester skips invalid individual contributions and unknown families,
skips a whole contribution on any unknown field, and reports skipped declarations via
the existing plugin diagnostics owner. It admits healthy siblings and invalidates
dependants whose references no longer resolve. Registration rights are derived
only from that admitted set; registering a skipped contribution fails activation.

Stored Account releases and installed manifests may retain empty
`contributes.tools` and `contributes.commands` defaults from before the
Action-owned tool/CLI cut. Load admission drops those empty defaults silently;
nonempty or malformed retired families use the ordinary skipped-contribution
diagnostic. Neither family receives registration rights. Authoring continues
to reject both keys and current writes emit neither. Remove this load arm only
after all stored/installed manifests are rewritten or the minimum supported
host advances.

Availability keeps publication/reporting schemas strict and uses explicit load
variants only for stored responses and installed declarations. Initial malformed
responses publish `plugin_availability_invalid_response` and do not automatically
retry. Initial non-success HTTP reads and rejected transport reads publish
`plugin_availability_unavailable` through the same scoped readiness owner while
retaining normal transport retry. A read intentionally pending under HTTP recovery,
Account retirement or request supersession does not publish an outage.
Both settle pending Artifact acquisition without fetching bytes; a successful
refresh recovers, and a failed refresh does not withdraw last-good Account facts.

This is the explicit manifest-load exception to closed executable declarations
below. The envelope and nested identity, runtime ABI, HostAccess, entrypoint and
engine declarations stay closed; source integrity remains acquisition-owned.
Unknown plugin-wide keys refuse the plugin; ignoring a newer restriction must
never widen its authority. Unknown contribution objects are skipped as a whole. Known
fields still validate strictly. All source kinds enforce a declared
`engines.happier` range with typed `plugin_manifest_engine_incompatible` refusal;
an omitted optional range imposes no requirement. Authors must exclude hosts that
cannot safely ignore new semantics. This policy introduces no persisted format,
epoch change, or reverse-development SDK rollback promise.

### External Session imported images (0.3 development)

The current closed Agent source raw-record envelope accepts optional `media`:
a closed array of standard ACP image objects with only `type: 'image'`,
`mimeType` and base64 `data`. It carries source bytes, not path, routing,
permission or lifecycle authority. Both the containing record and each image
object reject unknown fields. This is an unpublished author-contract extension
under the existing direct cut, independent of package SemVer; it requires the
matching host. Older strict development hosts reject it, so omission is never
treated as a successful image import.

The host consumes the transient bytes through Session media staging/adoption
and writes the existing media references/failures. No persisted transcript or
media format changes, dual writer, migration or reverse-development adapter is
added. Existing text-only source records remain valid. The inspected moving
0.2 predecessor at `177a7bf55c1a9437f9cf7dc24b8279047fef8a50` has neither this
source-record schema nor the plugin SDK External Sessions author contract.

### Environment installation grant admission (0.3 development source)

The private deployment `secret-launch-admission` transport uses closed V1
request, materialization, grant, resource-metadata and result envelopes. Its
installed proof adds `deploymentSecretLaunch` to the existing installation
signing owner, binding the exact request digest under a distinct purpose.
That authority-bearing purpose cannot be combined with transition, Session,
RPC, replacement or managed-policy purposes. Existing proof payloads and
their serialized signing bytes are unchanged when the new purpose is absent.

This is an unpublished operation, separate from package SemVer. A target talking
to a Home without the route receives `unsupported_action`; it never falls back
to an actor catalog, plaintext mode or Account-key provisioning. The inspected
clean scoped moving `../0.2` frontier
`07a887dd42cfd921ecd46cac9f81c0338f3d0f86` has no deployment owner/package or
grant-read purpose. No predecessor grant format, alternate writer, persistence
migration or reverse-development-binary adapter is introduced.

Restart sanitizer reconstruction from Home is not enabled. Exact receipt references and current
grant authority do not authenticate the original delivered secret bytes; a
same-subject first-read replacement envelope can reconstruct the wrong sanitizer.
The 2026-10-30 C12 ruling keeps development runtime logs available to people
with Environment read access after memory loss, marking the page with optional
`secretMasking: 'incomplete'` and the note “secret masking may be incomplete until
the next deploy”. Agent/MCP reads, including person-approved replays, refuse with
`secret_redaction_unavailable`; incomplete pages require the person's own direct
host invocation. Approved UI log reads send the existing `account_automation`
ceiling across Account-to-Machine delivery; terminal transport already arrives
as automation. Neither reclassifies the approver as the log recipient. Surviving original masking
leases remain in use, including borrowing from the same live activation before
service registration. Known-value masking without exact generation proof still
returns an incomplete page only to the direct person. Borrowing adds no lease
or retention lifetime. This is an unpublished 0.3
page extension, not a new SDK read-request permission: its person disclosure
option stays host-private. The inspected scoped-clean `../0.2` frontier
`7a01417876753a916563b8df70cf25a6c563e2d8` has no native-log value contract
(the relevant paths are unchanged from the earlier inspected frontier).
The same development change qualifies native instances and Compose projects by
Home server id plus Environment id, with release roots under the saved Home
profile directory. Launch, prepare/build source checks, cold logs, image archives, retention and stage logs
consume the one own-server identity owner. Unqualified development-only paths
are not a cold-discovery fallback: they cannot establish the original Home.
No new labels, receipts or persisted routing map are introduced.
The next deploy restores masking through normal launch. No settled-generation
transport widening, persistence migration, retained binding producer, alternate
grant representation or new authenticated-sender guarantee is introduced.

### Environment service identity (0.3 development)

Native service log values use closed V1 cursor, page and result objects; their
wire epoch is separate from SDK package SemVer. The unpublished SDK `logs`
method's read request carries `kind: 'read'` and returns that value union
instead of a string. Its same-property `kind: 'watch'` overload accepts the
same cursor and host byte budget plus an emission callback and cancellation
signal, returning native-cleanup custody as a disposable. These callbacks are
in-process SDK values, not a new wire selector or Resource transport. Current
native adapters and the failure-diagnostic consumer migrate together.
A source revision describes native generation/rotation, not
content or authority; the receiving service owner still admits every read.
There is no string-returning alias or retained development-format adapter.

A denied native log result may include the optional closed `recipeRemedy`
reference (`pluginId`, `recipeId`, `revision`). It is presentation data for the
existing recipe review flow, not setup inputs, approval or effect authority.
Results without it remain valid. This is a coordinated unpublished 0.3 shape:
the inspected scoped-clean `../0.2` frontier
`a4c8a3a1746a59d9d8d0318a643b69099b3880bb` and immutable `cli-v0.2.17` have no
native-log value contract, so no predecessor adapter is introduced.

The existing Local Services V1 read projection remains closed, including its
nested Environment reference. Development Environment rows carry
`environmentId`, `environmentInstanceId`, `deploymentId` and `composeService`,
with `lifecyclePurpose: 'deployment'` and exact
`id = <environmentInstanceId>/<composeService>`. Workspace authority and actor
fields are rejected on those rows. Existing Workspace projections retain their
shape. The separate canonical service identity excludes Deployment receipts,
release paths, actors and timestamps; C1 consumes its tuple through Protocol's
Local Services owner rather than deriving another notice identity.

That same closed V1 service identity also admits an adopted watch's exact
`machineId`, `serviceId`, `watchId` and `watchRevision`. The C1 page retains and
matches the complete identity, rejects an Environment operand on an adopted
page, and excludes the mutable watch revision from its occurrence tuple.
Infrastructure remains a purpose rather than an identity kind. Deployment
health, drift and runtime-log reads retain the deployment-only arm.

Machine service list/detail rows project that admitted value as optional
`identity`; Workspace services have no Machine-service identity. Consumers pass
it directly to the existing service-subject entry point rather than parsing a
service id. The daemon also owns the human label in `name`: an adopted watch's
name, or the managed service's name. Native discovery projects the same label
and identity for an admitted candidate. Ordinary unowned Compose candidates
retain their discovered project names. A Happier hash whose Environment
instance cannot be resolved retains the native name in rows and discovery and carries
`nameResolution: 'unresolved_environment'`; consumers present an unresolved
Happier Environment rather than stripping or interpreting the hash. This is a
display result, not proof of Environment provenance: native Workspace Compose
projects can have the same hashed name shape. An adopted identity stays adopted.

Selected Machine service detail may carry optional `runtimeFacts` with
`configuration`, `observedAt` and `freshness`. Every nested object stays closed;
the optional closed `configurationDetails` array carries each immutable
container's redacted image, image CONFIG digest, effective command, network names/mode,
environment variable names (never values), and health-check test/interval.
Older producers without the array remain readable; matching Protocol, daemon
and UI source reload together when producing it.
The redacted configuration shares the existing deployment-review service
schema, including bind address and TCP/UDP protocol for every reported port.
Absent facts remain valid. These are matching-reader, unpublished 0.3 direct
cuts within V1, independently of package SemVer: prior strict development
readers reject the new field or identity kind. They add no adapter, new epoch
or reverse-development rollback guarantee. The scoped-clean moving predecessor
at `ff9a75fe6da334934b568b84df7662d4120c3ed0`, immutable `cli-v0.2.17` and
`ui-web-v0.2.19` have none of these service identity, detail or review schemas.

The 0.3 development service accounting sample adds optional nullable
`networkReceivedBytes`, `networkSentBytes` and `restartCount` presentation
facts per immutable container ID. Existing samples without these fields remain
valid. The enclosing V1 result and nested samples remain closed: current
Protocol, daemon, SDK DTO and UI readers reload together; older strict
development readers refuse the added facts. No epoch, persistence or Action is
added. The scoped `../0.2` frontier at
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no
`packages/protocol/src/actions/specs/machine/services.ts` contract.

Machine Services' native list Resource is another matching-current-source
direct cut within the existing closed V1 host-read reference, protected
original-Action continuation and Resource response. The new
`machines.services.list` arm routes authority and is not silently ignorable:
a matching host is required, while an older strict host safely refuses that
operation. Existing logs references, generation/source constraints and cursors
retain their shape. No SDK method, persistence format, epoch, adapter or
reverse-development compatibility guarantee is added.

The scoped basis is `../0.2` at
`fd3f03529d96e899e95c8b384f5843340a1339c6`, with no corresponding Machine
Services Resource contract in the inspected paths. The exact Resource schema
and subscription files are absent from immutable CLI 0.2.17/0.2.17-preview.1
at `a2c45c86804b24e60ac0b76146a3ef36dfcaa15b` and UI
0.2.19/0.2.19-preview.25 at `63829e3cd6a8f1f48b10891af0c8b2313e51ac7e`.
Those contracts do not require an old reader to accept the new list arm.

The same unreleased list input accepts optional `composeService` together with
`environmentId`. The daemon selects those admitted Environment handles before
projecting rows or subscribing to their changes; this narrows demand without
changing disclosure authority. Omitted selectors retain the Machine-wide list.
An older strict 0.3 development reader rejects the new selector, so UI and daemon
load together under the existing direct-cut contract, without an adapter or new
wire epoch. The inspected moving `../0.2` basis at
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no corresponding list schema,
Resource reference or daemon owner in the scoped paths.

### Attached bounded Run recovery (0.3 development)

The development Refine child purpose extends the existing closed authorization
V1 carrier with optional, closed `scmRefineSession: { sessionId, signature }`.
The admitted SCM host signs the saved Session under the original token, Machine,
request id and request-envelope digest; Home verifies that fact before admitting
the exact V2 Run Pending child. This is authority, not ignorable presentation.
An absent fact grants no Refine child purpose. Existing root requests remain
readable without it; an older strict development reader rejects the extension
rather than accepting a broader send. The producer and verifier must load together
under the unreleased 0.3 direct cut, with no new package version, persistence
format, epoch adapter or reverse-development-binary promise.
The inspected immutable `cli-v0.2.17` and `server-v0.2.17` trees have no matching
authorization/Refine owner paths. The clean scoped moving predecessor at
`177a7bf55c1a9437f9cf7dc24b8279047fef8a50` likewise has none. Ordinary retained
Session input remains with its existing reader; this adds no migration.

Explicit recovery uses the existing `session.message.send` Run recipient with
the closed requested-action epoch `{ v: 2, kind: 'recover_execution_run' }`.
Its Action input, Run routing identity, Pending mutation and Machine capability
envelopes remain closed. Ordinary requested-action V1 and omitted legacy values
retain their current reader/normalizer behavior; recovery never normalizes to
ordinary enqueue. The existing Pending JSON column retains the new intent,
without a migration, second writer or alternate recovery endpoint.

This effect-bearing intent is negotiated through epoch 3 of the existing
`sessionInputAdmission` Machine capability. A current Home refuses a target
advertising only 1 or 2 with `session_input_target_update_required` before row
creation. Ordinary main/Run input still requires only 1/2 respectively.
An older strict requested-action reader rejects the new epoch; it cannot
silently authorize ordinary input. The transport's existing target admission
and settlement epochs are unchanged. No public SDK symbol is added.

The inspected immutable CLI stable `cli-v0.2.17` and preview
`cli-v0.2.17-preview.1` both resolve to
`a2c45c86804b24e60ac0b76146a3ef36dfcaa15b`; their public Linux manifest
metadata reports those versions/channels and the same build commit. Their
`sessionMessages/pendingRequestedActionV1.ts` writes strict ordinary V1,
Session Send has no exact Run recipient, and their daemon advertises no
`sessionInputAdmission` capability. The clean scoped moving `../0.2` frontier
at `29c845495702acde2824dae13067d8a09322b26b` has the same relevant shapes.
Old-client/new-Home ordinary writes and retained old data remain supported;
new recovery against an old daemon is an operation-scoped update refusal.
A current recovery writer requires the current target-aware Home. Reading
new recovery rows with old development binaries, or rolling this unreleased
author contract back into 0.2, is outside the direct-cut support direction.
No dual writer, rollout flag or operator mode is introduced.

Machine operation-capability stored reads evaluate each declared leaf independently
through `machines/operationProtocolCapabilitiesV1.ts`. An unknown version or
malformed known value withdraws only that leaf's support; valid siblings remain
available. Exact version tuples and other known values are still validated, while
unknown outer and nested properties retain the existing drop-on-read policy.
Authenticated complete-projection publication and event admission stay strict.
Admission V3 advertisement still uses the existing Home Pending V3 negotiation:
the immutable `server-v0.2.17` and `server-v0.2.17-preview.1` source and inspected
moving predecessor advertise Pending V2, so they receive primary-only admission.
Target-aware pre-admission-V3 readers are unreleased development intermediates;
older QA server processes must reload current source to consume V3 publications.

The development Composer region placement `statusStrip` extends the existing
closed executable declaration in manifest V2; Composer surface input remains
V1 and host/runtime API remains 1. Its optional `emphasis: 'quiet' | 'prominent'`
is also part of that closed development declaration and requires the matching
host; omission follows the public badge's `prominent` default.
Its renderer binding, identity, occurrence,
scope and mount envelopes stay closed. Existing before/after declarations remain
valid. This is an unpublished SDK author-contract extension under the direct
cut: older strict development hosts reject this placement, so authors require
a matching host. It is not an ignorable optional input or an open routing union,
and adds no mixed-version adapter or persisted format. The inspected 0.2
predecessor at `01107c0e7a6b2d4b521573c6d69b53070187e76a` has no plugin
contribution/Composer region corridor.

Plugin UI executable compatibility is negotiated only through the artifact's
`hostUiApiRange`. One artifact id names one byte-identical CommonJS bundle on
web, iOS, and Android; React, React Native, Expo, Hermes, and app patch versions
are not artifact admission keys. Artifact bytes are addressed by digest. A
daemon-process-local occurrence establishes contribution currentness, but it
must not become a second byte identity or mount-compatibility gate.

In unreleased 0.3 source, caller-supplied UI `executeAction` and `openNewSession`
request ids reuse the existing closed host envelope and grant no authority.
Exact operation observation exposes the existing V2 `requestIdentity` filter
through `action.operations.list`; its plugin binding can fill an omitted Home
and Machine from the captured mounted runtime only when that exact filter is
present. Core Action input remains fully qualified. SDK, Action schema and
mounted host changes load together through the normal app/plugin reload. Older
strict development Action readers refuse the new filter rather than dropping
it and returning unrelated operations. The inspected 0.2 predecessor at
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no corresponding public operation
Action/schema or SDK UI owner. This direct development cut adds no wire epoch,
persisted record, compatibility adapter or alternate lookup endpoint.

Hosted Plugin UI also negotiates each SDK client's semantic API generation
within wire epoch 1. Installed 1.0 SDKs have a closed method enum and require an
exact 1.0.0 reply, even though they request `^1.0.0`. The current host therefore
selects the oldest supported generation satisfying the client's declared range
and advertises only methods introduced by that generation. The current SDK
requests `^1.1.0`; `actionControl` and `openManagedMachineConfiguration` start in
1.1.0. One Protocol definition owns method names and introduction versions.
The pre-negotiation bootstrap remains 1.0.0; different SDK copies in one realm
receive separately correlated negotiation replies, with sharing only for equal
ranges. Semantic generation selects representation and advertised methods, not
dispatch authority. Current presentation and an older authored SDK intentionally
share one document identity; ordinary requests and subscriptions carry no
per-client semantic version. Dispatch has one document-scoped authority set:
installed handlers intersected with transport support and the mounting ceiling.
After the existing ready/bootstrap transition it enforces that set even before
negotiation; negotiating 1.0 neither revokes a 1.1 sibling's methods nor grants
an uninstalled or withheld operation. Closed wire and operation payload schemas
remain enforced. A 1.1 wire negotiation request reaching a 1.0-only Host API receives
the existing typed `incompatible_api_version` outcome. An older host's injected
single-range controller may instead refuse a later 1.1 client locally after
its presentation client negotiated 1.0, surfacing `transport_unavailable`.
That historical controller direction retains safe refusal, not a guaranteed
direct-wire error reason. All envelopes, identities, method enums and
operation payloads remain closed. This fixes observed installed-artifact skew;
it neither reopens the retired draft 1.1/1.2 strata nor promises dev-to-0.2 rollback.
The same installed reader's closed theme predates optional `statusTint`.
Protocol owns its 1.0 context presentation projection, consumed per negotiated
client by the shared guest delivery seam for context results and registered
context observations only. Current 1.1 clients retain the field. Resource JSON,
mount/target identity, Account scope and readiness facts remain unchanged.

Page-mode Tabs extends the current development 1.1 installed method set with
`setPageNavigation` and closed optional `page.navigation` context metadata.
Matching development Protocol, SDK and host readers consume the descriptor,
placement and controlled-selection projection together. The existing 1.0 context
presentation omits this metadata, and hosts without the installed operation keep
ordinary local Tabs. This adds no runtime ABI or wire epoch. The inspected
`../0.2` frontier at `b06b31d66f9474bcf322627ae63ecf6a37d4a9a2` has no Plugin SDK
or Plugin UI package, so it supplies no predecessor page-navigation reader or
reverse-development adapter obligation.

The closed `ComposerOptionsInputV1` projection includes the existing optional
`sessionConfigOptionsV1` and `acpConfigOptionsV1` state alongside their overrides.
The Session config-option owner needs that state to apply global override rules
to selected-model controls. Their nested schemas remain closed, and absent state
remains valid. This unreleased 0.3 projection correction requires matching
development readers; it adds no runtime ABI or wire epoch. The inspected 0.2
predecessor at `4ff15b40b79900c41c3770df06a74188746d0bb7` has no corresponding
Embed Session options reader or reverse-development adapter obligation.

Triage's current development V1 detail-tab declaration carries optional `scrollOwner`
presentation (`scrollArea` or `list`), projected as `panelScrollOwner` in the detail
launch input. The declaring source remains the sole owner; the frame and source
wrappers consume the same declaration to bound virtualized Lists. Omission keeps
frame scrolling. The existing detail Surface role declares `fill` presentation;
the target's current manifest must be reloaded so its admitted source mounts
select the physical host's existing fill behavior. This changes no presentation
enum or envelope and adds no host branch. The nested tab declaration stays closed, so older strict
development readers reject the added property and need matching protocol,
source descriptors, frame and source UI artifacts reloaded together. The launch
projection remains additive-open/drop. This unpublished author-contract
correction changes neither routing nor authority, npm release versions, runtime
ABI or wire epoch, and introduces no adapter for earlier development snapshots.

A wire epoch describes compatible semantics, not an exact property census. Every
material object boundary, including nested objects, is classified explicitly as
`closed`, `additive-open/drop`, or `additive-open/preserve`; a parent policy
never silently classifies its children.

Workspace Sync source admission uses the existing closed external Action V1
binding. Home admits both endpoints and signs the source installation, access,
custody and logical child/controller mapping under `workspaceSyncAdmission`,
scoped to the relationship id. Project Open and finite Project preparation use
the same producer and reader. Controllers consume that mapping for ordinary
sources and native children without re-admitting the source. The encrypted V2 request exposes only the source
Machine/Workspace identifiers and an existing relationship id when applicable;
opening it verifies that projection against the sealed input. No content,
credential or new store is carried. Receivers consume those source facts and
reserve requester Machine GET for the exact receiving Machine.

Ordinary Project Open consumes its admitted Account and HTTP projections without
requiring Sync source facts. Before effects it reads currentness once through the
HTTP projection, which owns Account and installed-host currentness; local saved
profile identifiers are not compared with portable Home identifiers. The existing
host execution-identity owner retains physical receiver and requester isolation.

Home owns source admission; invalid or mis-scoped facts refuse with
`workspace_sync_source_admission_unavailable`, without a foreign Machine GET,
new credential, wire epoch or mid-operation recheck. Service Move carries the
requester's resolved source Machine identifier in its required reviewed
`sourceMachineId` input. Earlier 0.3 development shapes have no compatibility
adapter or fallback. The inspected 0.2 frontier
at `512915f3ccf4a29a8454b74ad9db6ca72079d916` has no corresponding relationship
binding reader; its legacy Sync files and paths remain unchanged.

Project Open operation snapshots retain their typed receipt when the result is
`refused` (failed operation) or `outcomeUnknown` (running operation with the
existing `outcome_uncertain` observation). An unknown result never establishes
success. This corrects unreleased 0.3 settlement semantics without an adapter for
earlier development snapshots, an additional operation state or a retry.
The closed refused receipt accepts the existing optional `ActionFailureCauseV1`
carrier. Known terminal checkout failures retain their phase and SCM code through
the Open RPC, Action result and operation failure. Earlier strict development
readers need matching source for this optional field; no released Open contract
or reverse-development adapter is introduced. Lost Account acknowledgements and
uncertain worktree effects retain their existing unknown settlement.

In 0.3 development, `/v1/features` capability diagnostics use `additive-open/drop`
recursively: readers validate known fields and strip unknown properties so an
older or newer server's diagnostic additions cannot invalidate the Home response.
Shared authoring schemas retain their strict path; capability reads derive their
projection at the same owner. Identity and authoritative operation-contract
envelopes stay closed, and this policy does not admit new enum or union members.
The endpoint's wire version and package versions are unchanged.

In 0.3 development, Action Operation failure diagnostics also use an
`additive-open/drop` read projection. The canonical cause parser preserves known
code-only causes and replaces unfamiliar causes with the typed
`unknown_failure_cause` diagnostic, discarding their contents. Required failure
fields, known failure details, operation identity and lifecycle remain strict.
Failure authoring stays closed; the released V1 projection continues to omit
cause diagnostics. An optional diagnostic cannot hide a terminal failure.

- **`closed`** rejects unknown properties. It is mandatory for identities,
  qualified references, Account or credential selection, permissions, routing,
  mutation inputs/outcomes, authoritative lifecycle facts, executable
  declarations, and runtime unions. Stable Host Events are always closed.
- **`additive-open/drop`** may accept bounded optional unknown properties only
  for transient, presentation, or read projections where an older consumer can
  safely ignore them. Normalization removes those properties.
- **`additive-open/preserve`** may retain bounded unknown properties only when
  the component is an explicit round-trip custodian for a persisted document or
  opaque provider configuration. Preserving data never grants identity,
  authority, routing, credential selection, persistence-policy, or trusted
  prompt/transcript/UI power.

Known fields remain strict under every policy: required fields stay required;
invalid values do not coerce; and owner-justified encoded-byte or semantic
cardinality bounds still apply where the actual wire, storage, or operation
contract requires them. Implementation safety guards such as serializer/parser
recursion depth are private fail-safe details, not public semantic JSON quotas.
An accepted unknown is data, not authority.

An optional input is compatible only when an older implementation can ignore it
without falsely reporting success. Otherwise advertise an optional
operation/capability or introduce a new wire epoch. Likewise, a new union member
is compatible only in an explicitly skippable, bounded presentation list.
Identity, presence, permission, pagination, retry, and mutation-outcome unions
need an existing safe `unknown` arm or a new epoch; they are not skippable by
default.

npm package versions and exported wire epochs evolve independently: a later npm
major may still export V1, and a later npm minor may make only V1-compatible
additions. A public cross-plugin business protocol is a separately publishable
package with any valid scoped or unscoped npm name ending in `-protocol` and
explicit `/v1` and `/testing/v1` exports. Its npm scope identifies its author
and grants no additional protocol authority. One existing protocol-only package
may also own several domains through explicit domain-versioned pairs such as
`/ci/v1` with `/ci/testing/v1` and `/releases/v1` with
`/releases/testing/v1`. Each pair names that domain's wire epoch and conformance
fixtures; adding a domain does not rename or replace the existing `/v1` and
`/testing/v1` epoch. A domain's incompatible evolution requires its own explicit
epoch under the same rules above, independently of package SemVer.

The package contains schemas, types,
helpers, and conformance fixtures only—not host runtime, persistence, provider
implementation, credential materialization, polling, or a private
`@happier-dev/protocol` dependency—and it has no `latest`, `current`, or
`default` aliases. Compatible
package copies interoperate through serialized protocol identity/version and
runtime validation, never JavaScript object identity.

The package README and nearest `AGENTS.md` must name the feature's domain owner
and link here rather than copy this doctrine. New feature-protocol code must use
one synchronous executable validator/normalizer that derives its bounded public
JSON Schema; independently handwritten parser/schema pairs are not allowed.

The approved SDK r0.31 direct cut does not make current `dev` → `../0.2`
rollback a supported direction. Do not add predecessor readers, dual writers,
aliases, writer-floor waits, or rollback-only gates for unpublished author
contracts; forward migration and current-version integrity still apply.

The unreleased machine-recipe `packageSource` executable union distinguishes
APT and DNF by `manager`. Both source objects, their enclosing executable and
conditional declarations, and their nested operands remain closed. The existing
APT shape is unchanged; DNF adds its repository id and RPM architecture names.
Matching Protocol, SDK DTO projections, recipe manifests, review clients and the
native interpreter load together. Earlier 0.3 strict readers reject DNF; this
unpublished direct cut adds no predecessor adapter, alias, writer floor or gate.

The development Action-operation V2 domain reference for runtime target linking
retains its Home, Environment and original request key, with the producer identifying
native creation separately from association. Current UI and daemon readers reload
together. The V1 outward projection omits this domain reference, as it already does
for other current-only operation domains; it does not add it to the 0.2 reader's
closed union. The existing encrypted operation record retains native-create evidence
needed for exact-resource recovery and preventing replay; ordinary settled-history
pruning must not erase that evidence.

The unreleased `ui.listExtensions` manifest family is optional; manifests that
omit it retain their prior normalized shape. Its descriptor, fields, sources
and mark references are closed. It uses the existing UI declaration projection
and adds no persisted host-row data or runtime registration. The 0.2 predecessor
has no plugin UI projection reader. Earlier 0.3 development strict readers
reject the new projected entry's field and therefore the describe response;
they are not a supported mixed-version author contract. This is no additional
client update floor, compatibility adapter or negotiation layer. Executable UI
compatibility continues to use the existing `hostUiApiRange` owner.

The development Machine registry describe remains wire protocol version 1.
Its optional full-read `knownProjectionDigest` is safely ignorable: an older
daemon returns its full response, and a client accepts a full response without
the optional `projectionDigest`. Only an explicitly matching digest request may
receive the separate closed `{ protocolVersion: 1, unchanged: true,
projectionDigest }` response. The client requires its exact held digest before
reusing admitted inputs; that witness does not replace current Machine access
or daemon authority checks. Named exact reads retain their existing envelopes.
This opt-in read optimization changes no executable declaration, runtime event,
persisted format or downgrade floor. The inspected 0.2 predecessor at
`29c845495702acde2824dae13067d8a09322b26b` has no registry describe corridor.

Current development full discovery opts into `deferredSections: true` and
receives a closed digest manifest. Its nested section map is read-only byte
addressing; section bodies, included-body records and cursor envelopes are
closed. `sectionRead` is sent only after a manifest, and is invalid on named
selections. This extends wire epoch 1 independently of package SemVer and
changes no persisted format, executable declaration or runtime event union.

Each section index is a closed `sectioned: true` record: ordered literal JSON
spans and section references carrying a digest and inline Machine-value spans.
Bodies are grouped by plugin within each projection section; origins,
occurrences, source custody, availability, authorization and targeted snapshots
stay inline. Reassembly takes every referenced body from that
Home/Account/locale's digest-verified holdings and passes the complete
reconstructed response through the existing strict nested projection schemas
before adoption. The digest binds the body spans, not authority or freshness.

Every manifest carries the narrow `searchProviders` section: Search declarations
and Action bodies selected by their exact qualified references, alongside the
base and installed-package admission sections. It does not claim complete
Action or plugin-UI coverage. Complete catalogues satisfy this narrower demand;
merging a narrow answer never erases complete same-manifest coverage. Live
latency is not certified by the constructed cost tests.

Every manifest carries `sectionFrameVersion: 2`: index frames travel as raw
serialized index text and body pages as their JSON span array. The digest of an
index still covers its one-span array, so the address is unchanged. A manifest
without that version, a bad page or a digest mismatch settles as
`invalid-response` with a content-free `deferredHydrationRejection` branch name;
there is no full-describe compatibility read and no automatic retry. The earlier
`knownSectionDigests` inline framing, the JSON-array index encoding, the
`supportedSectionFrameVersions` and `supportedProjectionSections` offers, and the
unversioned full-read recovery were removed (unreleased 0.3 development paths;
0.2 has no registry describe corridor). The warm cache persists only admitted
projections, never section bodies, frames or digests, so no stored data uses
these shapes. Section digests are lowercase hex SHA-256 over the UTF-8 JSON span
array on every engine (`node:crypto` in the daemon, WebCrypto or `expo-crypto`
in the app).

In development source, a live authority or activation change may replace the
immutable build without advancing registry generation. A section unavailable in
the current build returns the existing RPC error envelope with code
`plugin_projection_section_stale`. The client re-establishes once with a fresh
manifest request, omitting the held conditional digest, then hydrates current
demand through the same bounded section reader. A second stale result settles
as `projection-stale` without automatic polling; explicit fresh demand or a real
invalidation can recover. Cancellation and Account retirement stop recovery.
This adds no response fields or wire epoch, retains no old build, and does not
replace strict admission or fresh daemon authority checks.

The existing build serves each requested digest in JSON frames at most 48 KiB,
paging larger valid bodies without truncation. Extra small bodies are returned
only when explicitly requested and fitting the same total frame budget. Clients
verify every digest, parse demanded sections with the existing projection schemas
and retain explicit completeness at the shared loader. Missing catalogues remain
unknown to readers requiring them. A matching full digest still returns the
124-byte unchanged response, including when the client holds only demanded
sections. Hydrating additional sections may reuse an already current manifest
only when the caller explicitly permits fresh-cache reuse; an explicitly fresh
read still asks current daemon authority first.

### Action operation observation epochs (development)

Current development Session creation can negotiate committed-Session observation
through the existing Machine `sessionSpawn` protocol capability, epoch 3.
Home advertises `capabilities.machines.sessionSpawn.protocolVersions`; a daemon
publishes epoch 3 only when that Home supports it. A caller sends
`observeSessionCommit: true` only to an epoch-3 Machine. Older strict spawn-input
readers reject this field, so its omission is required, not a best-effort hint.
The existing accepted `pending` receipt may then contain `sessionId`, proven by
successful Session commit and authenticated attach. It is not terminal success,
native readiness or initial-input acceptance. Strict older pending readers never
receive this new field: each observer opts in separately, while an unopted caller
continues waiting for the same invocation's terminal result.

An opted-in observer waits once on the receipt's existing operation address with
`action.operations.get` and `waitForTerminal: true`. This held observation never
re-executes the spawn, including after a retryable result has already settled.
A same-key spawn remains an explicit user Retry and may legitimately re-execute
an unstarted creation. The flag is not executable input identity, a persisted
creation draft, or an Agent, ordinary CLI/MCP, or public-API authoring option.
The shared API request projection drops it. Ordinary CLI field and whole-input
authoring, including raw Session Action execution, reject it through the declared
CLI caller schema before transport. MCP discovery and admission use the same
Action-owned terminal schema through its MCP surface binding. The standalone
MCP factory enforces it before Account or API-token dispatch; bound Session
callers retain their existing Agent authoring and inherited-target admission.
These terminal callers cannot send the
unnegotiated field to an older daemon. Native or Team startup refusal remains
the canonical typed failure after a receipt; the
original input is not resent. This development extension adds no operation owner,
polling loop or persisted format. Live manual-creation UI opt-in remains disabled
until destination recovery and spawn-owned pending-message controls are wired.

The existing daemon Action-operation owner exposes two read epochs over the same
store. V1 list/get retain the closed snapshot reader inspected in clean `../0.2`
at `37a6541578749067b49d4579be8c752c9591b8c8`: only `forkRequest`,
`spawnAttempt`, and `handoff` domain references, with the original terminal
`errorCode`/`error` pair. Its response projection omits current domain references,
`setupReview`, `observation`, `operationCredentialUses`, and failure `details`; it never rewrites retained
custody, state, revisions, or revision notifications.

Current V2 operation reads and current approval receipts retain content-free
`operationCredentialUses` from actual host credential materialization. They
describe the admitted label/kind, owning Account or Team when known,
purpose-binding reason, and admission-time currentness; they neither grant
credential access nor assert continuing readiness. Terminal/rejoined outcomes
remain unchanged. The existing V1 response and push projection omit these facts.

Successful terminal `machines.setup.apply` pushes retain the current full snapshot
so the existing client operation store can show completion before a daemon group
refresh replaces the process. Current clients validate its Account, Machine and
setup reference before consuming it; other setup notifications still use the V1
projection and current-read enrichment. This unreleased Action uses the existing
snapshot envelope and adds no retained Home or daemon result. After the refresh,
an operation read may return `not_found`; the next setup Plan observes whether
the recipe is satisfied. This visible, recoverable gap is accepted rather than
extending operation lifetime or retaining results across the restart.
Older closed snapshot readers drop this unknown setup domain; matching current
clients are needed to show that completion push. V1 RPC responses retain their
released projection.

Current development V2 setup references also carry optional ordered `steps`:
`planIndex`, `stepId`, the reviewed localized `label`, execution `state`, and
an optional native `failureCause` code. The admitted plan owns these display
facts; script bodies, commands, native output and credentials are excluded.
Apply, removal and update operations project the same native progress callbacks
through the existing operation store. Equal step facts publish nothing. Finite
toolchain and daemon-user script stages retain their existing phase and terminal
attachments; they do not invent native plan steps.

The snapshot, setup reference, step entries and localized label objects remain
closed. Matching Protocol, daemon and UI development readers reload together;
new readers accept references without steps. Released V1 readers still receive
the existing projection without a setup reference, so no released wire epoch,
persisted format, additional channel or compatibility adapter changes.

Managed controller failures in the current development V2 read retain a strict
`managedControllerRequest` diagnostic: the static request path, failure category,
observed HTTP status when available, and safe machine-readable code when supplied.
The controller request owner validates responses before returning them; enrollment
and Action execution preserve that observation through the terminal operation.
Response bodies, messages, headers, credentials and schema issue values are never
part of this diagnostic. V1 continues projecting only `errorCode` and `error`.

Dedicated managed bootstrap failures in the same development V2 read carry a
closed `managedBootstrap` detail: interpreter phase (`check` or `apply`), observed
integer exit status, terminal-response classification (`missing_result`,
`invalid_response`, or `result`), output-presence booleans and, for a valid result,
its status and optional identifier-only reason. The reason uses the existing
operation error-code bound. Raw stdout/stderr, submitted plans and transient
administrator credentials are excluded. The retained task preserves the owning
controller error; the shared Action failure normalizer validates this projection
before settlement. The V1 projection continues omitting all details.
This is an unpublished operation V2 presentation extension under the same direct
cut, requiring matching current readers, not a new capability, retry authority,
persistence format or released-client update floor.

Activation of an already enrolled managed guest retains a separate closed
`managedService` detail on `background_service_failed`: the failing `install`,
`restart`, or native-process `start` step, its integer exit status, and a stderr
tail redacted by the existing sensitive-text redactor and bounded by the process
owner's diagnostic capture budget. It carries no stdout or command arguments.
The generic `failureCause` remains content-free. This unpublished V2 diagnostic
requires matching current readers; V1 still omits details. Service activation
order, timeout ownership and restart behavior are unchanged.

Unexpected Action exceptions in the development read retain optional `failureCause`
on Action and operation failures: the producer phase, known exception class,
producer-declared identifier code (or null), and HTTP status (or null). This replaces the
`actionException` details kind, leaving domain details available alongside it.
The Action owner projects at most one immediate native cause when the outer
error has no typed code; transport adapters preserve the producer's cause and
phase. Managed enrollment preserves the administrator or isolation child phase.
Unreleased 0.3 nonterminal operations with `outcome_uncertain` or `stop_unconfirmed`
observations may retain this diagnostic in the existing `error` field. This records
an observer failure without asserting terminal native failure. Clearing the
observation or confirming success/cancellation clears that error. Matching current
V2 readers refresh together; the existing V1 outward projection omits nonterminal
errors for the provenance-pinned predecessor reader. No new field, state, error
code, capability or persistence carrier is introduced.
Composed Machine Setup publishes unsupported parent cancellation when its Workflow
Run accepts custody. The Run owns recovery; the shared Setup waiter forwards the
retained cause and recovery message without claiming terminal native failure.
The existing `error` message uses the bug-report redactor, which removes secrets,
tokens and labeled secret paths while deliberately retaining ordinary diagnostic
paths. Stack traces, opaque exception fields and native output are excluded from
the typed cause. Confidential continuation still exposes only its closed failure.
The development Action failure envelope also retains optional `requestId` from
the invocation context. Generic CLI invoke creates or accepts that identity once
and supplies it to dispatch and failure settlement, including pre-dispatch failures.
Typed exception details remain under their existing producer-owned `details` field;
the separate code-only log diagnostic reader retains its narrower allowlist.
The V1 operation projection omits diagnostics; existing failures without `failureCause`
remain readable. Released 0.2 RPC readers select error and code and ignore this
optional field. Accepted-spawn recovery identity remains in its existing details.
No error-code family, wire epoch, migration or alternate operation owner is added.

In unreleased 0.3, a Home `execution_authorization` exception before daemon
dispatch returns `action_not_admitted` (or the existing typed database failure)
with that exact phase in the safe `failureCause`. Plain Action results and
protected HTTP refusals preserve the same cause through the existing sender.
This exception is not evidence of Machine unavailability. Actual availability
refusals retain the Machine owner's existing diagnostic through RPC and operation
failure details; absent diagnostics remain absent. Matching strict development
readers must refresh for the added cause phase and diagnostic union arm.

The unreleased Machine-provisioner V1 role schemas are exported through the public
SDK and serialized into manifest V2 Action declarations. A current host accepts an
older result-schema snapshot that omits optional properties, including nested facts;
required fields, retained property constraints, object closedness and union arms
still match the canonical role. Descriptor-owned native Resource/operation value
schemas and Action input schemas remain exact. Actual result
readers retain their closed validation. This declaration comparison replaces
field-specific diagnostic exceptions, without a new wire field, schema-reference
registry, migration or reverse-development-binary compatibility promise.

The same unreleased managed-machine controller report adds optional
`configurationFacts` using the existing `ManagedConfigurationFactsV1` shape. New
servers accept reports without it. A new controller needs the matching server:
an older strict development report reader rejects the added field. Update the
controller payload and server together; this direct cut adds no capability gate,
auth scope or migration. Facts fill the existing `reviewedFacts` column without
rewriting the signed admitted input or replacing an existing reviewed snapshot.

An admitted managed row resolves its native schema from that retained reviewed
provisioner before consulting installed declarations. A controller republishing
its declaration therefore cannot invalidate a later report for the admitted
resource or prevent a successful observation from replacing `bootstrap.incomplete`.
Rows without retained provisioner facts still use the existing installed-declaration
lookup. New acquisitions continue selecting the current installed declaration;
report currentness and native-resource validation are unchanged.

Managed native failures in the same development V2 read retain a closed
`managedNative` detail with `nativeCause`: an HTTP status class and optional
documented vendor code, a documented gRPC status/Modal SDK error class, or a closed
local cause. `native_configure_refused` retains exact HTTP status 400 for a
message-only configure refusal; it does not imply that no setting was applied.
`native_delete_refused` carries the same exact status for a native Delete that
did not complete; an earlier Stop or partial effect may already have occurred.
`native_route_unavailable` and `native_lease_ended` distinguish a locally
unsupported acquisition route from a coordinator's terminal retained lease.
`native_route_not_found` carries exact HTTP404 and a closed route kind
(`inspect`, `run`, `stop`, `delete`, `pull`, or `configure`). Lume's pinned
0.6.1 handlers report missing VMs as HTTP400, so route404 never proves absence.
The shared provider-facts schema owns this allowlist; native messages, response
bodies, metadata and credentials are excluded. Hetzner input/uniqueness failures
may additionally carry `fields`: a closed, cardinality-bounded list of documented
create-request field names, restricted by the native producer to submitted keys.
It carries no validation messages or dynamic label paths. This extension uses the
same development direct cut; SDK/controller, Home readers and app must consume
matching schemas before the new diagnostic producer is loaded.
Acquire's rejected, unknown and
pending results, provisioner check/options/observation results, and refused or
unknown native-control results accept the same optional fact. Options can
explicitly report `provider_unavailable` without presenting a
failed catalog fetch as an empty catalog. Existing results without the fact stay
valid. These are unpublished managed V1/operation V2 extensions under the direct
cut, requiring matching current readers; no adapter for stale development
schemas or change to the released V1 operation projection is introduced.

Managed bootstrap questions in current V2 operations use one closed union for
provisioning consent, SSH trust/replacement, remote service replacement and
administrator establishment. Establishment projects only its prompt id and
reviewed administrator username; its password uses the existing transient
response channel and is absent from retained observations.
Trust carries its host and fingerprint facts. The development managed response
Action requires the exact projected question; the current task owner also checks
its kind atomically before accepting a response. This requires matching current
managed UI/Action/controller readers under the same direct cut. Ordinary SSH
setup retains its existing password flow, and released V1 operation reads still
omit managed domain references. No persisted format or migration changes.

The development managed-creation child continuation also admits
`machines.setup.adminAccess.set` for the exact enrolled guest and reviewed
creation policy, preserving its existing proof shape and requester authority.
Plaintext input is checked at Home; E2EE input is checked by the receiving daemon
against that same retained creation intent before metadata mutation. Another
Machine, Home or policy value cannot spend this creation child. This extends
only current development creation, with no predecessor alias or new persisted
policy writer.

Current Actions, Workflow observation/recovery, UI reconciliation, command output,
and prepared-copy completion use the existing V2 list/get methods so they retain
those richer facts. Stop uses the unchanged V1 cancel method. This is a bounded
read-epoch projection, not a second operation owner, parser, or promise of mixed
0.2/0.3 stack support. Remove it only when the original V1 reader contract is
explicitly retired; unrelated operations and retained operation results are
unchanged.

In 0.3 development source, declared Service Start publishes its source-qualified
`projectService` reference with purpose `start` through this same V2 owner.
Copying, preparation and native launch remain phases of that Start; a complete
binding read may be unavailable until native establishment settles. Mounted
Service rows retain the operation's progress during that interval and invalidate
their existing native readers on settlement. Finite setup retains its separate
review/output custody. V1 continues omitting the service reference; the Start
request and native result formats are unchanged. This is a development V2
extension, not a new observation channel or a released mixed-version guarantee.

V2 list can select `requestIdentity: { actionId, requestId }` for the newest
retained host receipt in the admitted Account, Machine and optional Session
scope. Selection precedes response projection and skips unrelated durable-domain
reconciliation. Accepted manual Session creation uses this selector, then waits
on the exact operation through the existing get owner. Both the request and
nested identity remain closed; V1 rejects the selector and a client requiring it
never falls back to an unfiltered predecessor inventory. The clean relevant
`../0.2` paths were rechecked at `3482a9101ebb7ee2983608ef0deb00831dfcb2e7`;
that predecessor registers V1 only. This development extension adds no retained
data format or second operation owner.

While the shared Action executor holds a blocking Ask, current operation progress
uses `waiting_for_approval` and carries the existing `approval_request_created`
reference in `progress.approval`. The reference identifies the Inbox Ask; it grants
no decision authority and contains no Action inputs. All wait exits clear it before
the domain owner continues or settles. V1 retains the phase and label but omits the
reference through its existing progress projection. This is development-only V2
observation data; the snapshot and nested reference remain closed schemas.

V2 get separates snapshot reconciliation from `refreshSetupReview: true`, which
awaits the retained producer's current setup effect before a human consent
decision. Ordinary reads can refresh in the background; identical progress and
review facts do not publish another revision. The refresh operand belongs only
to the closed V2 request. V1 rejects it, and an unavailable V2 method cannot
satisfy a required fresh review through a V1 fallback. `includeSetupReview`
retains its existing wait-only contract.

Current managed bootstrap observations capture the native resource and controller
installation on the V2 managed operation reference independently of an installer
task. An actual installer task supplies only its task id and kind. Already-enrolled
native boot recovery uses the same correlation without inventing a task or replaying
installation and pairing. Detail shows observed progress and Retry only when that
operation's captured facts match the retained managed row; a later successful retry
clears the failed diagnostic. Missing capture is unavailable evidence, not permission
to borrow an older failed operation for a rebuilt resource. This replaces an
undeployed task-nested capture in place. V1 continues omitting the managed reference;
no new operation store or retained-data migration is required.

### Account-owned managed creation (0.3 development)

Personal portable creation may omit the managed controller pair. A present
controller still requires both Machine and installation identities; absence is
not a wildcard that matches an installed target. Preset creation guards now
establish `launch` presence only. Installed local providers and delegated Team
creation retain their real controller and existing declaration lookup.

The single FINAL `20261031181500_managed_machine_optional_controller` transition
makes both `ManagedMachine` controller columns nullable and constrains them to be
present or absent together. PostgreSQL, SQLite and MySQL preserve existing paid
rows, native references and incoming birth associations. Ordinary enrolled Machine
identity and registration do not change. This is an unreleased source/schema
extension, not an app Machine identity, new enrollment credential, or second
managed-record format. The relevant `../0.2` Protocol/CLI/UI paths at
`a7cfad84168f21b364b37d431175f50c311acb7e` contain no managed acquire/controller
contract; no predecessor managed-row adapter is introduced.

### Notification channel sender source migration (development)

The current development `NotificationSender` request makes `categoryId` optional:
plugin-originated service sends retain the qualified plugin category, while host
Activity sends omit it. This required-to-optional sender change is a development
source-contract cut, not a V1-compatible relaxation for existing senders. Authors
must update and rebuild category-dependent senders before consuming host Activity
notifications; no synthetic category or silent compatibility shim is supplied.
The plugin `notifications.send` service still requires a declared category. See
the [author migration guide](../apps/docs/content/docs/plugins/services/notifications.mdx#channel-sender-source-migration-development).

### Detached Execution Run plugin context (development)

The CLI V2 preflight reuses the existing signed root Action purpose for its
passive capability read; no authorization envelope changes. The optional
`executionRunPreflight` Start failure detail is a closed presentation object,
with a closed `cause` object, literal `capabilities.describe` phase and only
canonical content-free diagnostic codes. The existing V1 failure projector
retains validated evidence and drops invalid evidence. It changes no input,
execution authority, persistence format, retry policy or wire epoch. Matching
development readers consume the updated strict Start-details schema together.
The scoped-clean moving `../0.2` frontier inspected at
`c1e74e521fa2e725702ae21b472afe46a9d2d6c6` has no Start-details evidence schema;
its Action failure carrier accepts `details?: unknown`. Existing results without
the optional field remain valid. No reverse-development adapter is introduced.

Real Agent Sessions keep the existing Session V1 request, event, context, and
host-service contract. A Session-primary Agent may additionally declare the
versioned `executionRunContext: { versions: [1] }` capability and return the
matching `sessions.executionRunContextV1` runtime facet. Only that facet receives
the host-stamped `execution_run` scope; it has no `context.session` and exposes
only host services whose authority is meaningful without a Happier Session.

The declaration and runtime facet are inseparable. A detached Run fails with the
existing operation-scoped `execution_run_protocol_unsupported` result before a
provider effect when either side is absent. Genuine Session operations remain
available, so older plugins do not need a compatibility adapter and the host must
never substitute the Run id into a Session V1 field. Composer attachment V1 also
remains Session-only; the additive V2 resolve callback carries the same truthful
scope, while SessionMedia continues to reject outside a Session.

The prospective `../0.2` checkout inspected at
`c4deb153e7d4740f06bfeee94b70cfda95d47068` has no observed execution-run context
facet or Composer V2 callback in the relevant SDK, Protocol, and CLI runtime
paths. Those unpublished author contracts therefore create no reverse adapter or
rollback obligation.

## Session read observations (0.3 development)

Ordinary list and exact Session envelopes add optional `observationCursor`, captured from the
viewer's Account change sequence with the returned content. Older readers can ignore it and
older producers omit it. It changes no persisted shape, authorization, SDK epoch or applied
change-feed frontier. The client uses it only with the page's proved coverage; absence of the
fact cannot justify retaining a covered omission as a post-cut creation. Older producers
retain conservative covered-omission withdrawal. Automation and restricted Session credentials do not receive this
Account-wide observation. See [Session collaboration](session-collaboration.md#list-omission-and-concurrent-exact-reads-03-development)
for the canonical producer, membership, withdrawal and scope rules.

## Proportionate matrix

List all affected reachable directions and mark each `required`, `unreachable`, or `unsupported` with a reason. Direct seam tests cover each required direction. End-to-end rows are selected by risk and real deployment order.

Do not run a full Cartesian UI × CLI × daemon × server matrix for an internal or unrelated change. Require broader combinations when a shared protocol, persistence shape, installer/service state, or rollout ordering actually couples those roles.

## Evidence and tests

- Prefer real released/predecessor artifacts, serializers, clients, or provenance-pinned golden vectors.
- A fixture reconstructed from current types is not evidence that the released or predecessor reader/writer behaves that way.
- Use the smallest discriminating test for each material direction, then add risk-selected upgrade, coexistence, rollback, and state-continuity flows.
- Do not multiply shallow permutations. A new test must distinguish a plausible incompatibility, reader/writer mismatch, semantic change, or rollout failure.
- Record the exact tag/commit/artifact or sibling worktree basis, component roles, direction, command, and result.
- Stored records are released inputs. Readers of persisted records (stored releases, settings, cached artifacts) are tolerant of retired or unknown fields and stay strict only on write; the stored-read owner has one test that reads a record carrying retired fields. On 2026-10-27 strict hydration rejected older stored plugin releases and broke encrypted plugin pages live while every constructed fixture passed.
- Installed plugins are released components. A host → older-plugin-SDK direction is reachable whenever a plugin is installed from a package, so the host offers only methods the plugin's declared SDK version negotiated, and the direction gets one seam test with an older SDK's real handshake. On 2026-10-28 the hosted plugin frame offered methods older SDKs did not know.

## Compatibility path lifecycle

Every retained compatibility path records:

- the released or prospective source shape it supports;
- its producer and consumer;
- whether it exists for upgrade, coexistence, rollback, or persisted historical data;
- the canonical owner it delegates to;
- its removal condition.

Remove the path when its support window has ended and evidence shows no supported reader, writer, or stored shape still requires it. Do not remove a released-data reader merely because current writers stopped producing that shape.

### New Session device state (0.3 development)

Picker focus and the ordinary-entry draft pointer belong to the existing keyed
device state owner, `apps/ui/sources/sync/domains/state/newSessionTargetUiState.ts`,
scoped by Home and Account. The local Settings load/save and scope-adoption owners
import retained seeds before removing their source fields. Import never replaces
current state, including an explicitly cleared draft pointer; a refused device
write keeps the source available for retry, including across a preference save.
The picker and draft-pointer catalog declarations are retired; their owning
device-state schemas admit retained input before the Settings parser strips it.
The moving 0.2 predecessor at `c1e74e521fa2e725702ae21b472afe46a9d2d6c6`
stores picker keys such as `agent:codex`; the current reader normalizes them through
the canonical target-key adapter. This device-local upgrade changes no Account
wire format and adds no dual writer or reverse-development compatibility promise.

Session-list disclosures use the same device-local lifecycle. The list-key owner
URI-encodes the context and group components once; it does not JSON-serialize an
already serialized context. This preserves qualified group identities while
avoiding backslashes rejected by MMKV 3.3.3 web storage. LocalSettings imports
translate pre-fix 0.3 seeds, and startup also adopts keys already retained by
native MMKV. Existing current choices win; an old key is removed only after its
destination is durable, and a refused migration prevents a clear from discarding
its source. The one-time native scan resets with the device-storage lifecycle;
it does not repeat on disclosure interactions or ordinary Settings reads.
Other disclosure namespaces and New Session scope keys are unchanged. This is
an unreleased device-state correction, not a new Account or cross-client format.

Session recents, active collection-space selections, composer-banner folds,
onboarding and acknowledgement history, pet dismissals and native terminal
renderer quarantine also use keyed device state in 0.3 development. Their
LocalSettings load/save owner copies retained input before retiring its source,
preserves newer destination values, and keeps unadmitted or refused copies
through unrelated preference saves. Auth/Welcome history retains its existing
logout lifetime; renderer quarantine retains its renderer and expiry. Authored
collection definitions and renderer/tmux preferences remain settings. Completed
tmux text edits commit through the existing Settings Action on submit or blur.

Ordinary Settings synchronization does not issue a policy-only Account write
when remote-alert status is stale or another client advances the version.
Actual preference CAS writes still carry the derived remote-alert policy when
the endpoint supports it. The server's version-bound policy fence remains the
authority; observing status does not create a preference intent.

### Home profile descriptors (0.3 development)

Shared-database Stack consumers keep descriptor continuity in their private
runtime directory, selected by the preset's explicit shared-DB consumer fact.
This is a QA/development topology: the source and consumers share the database's
one Home identity, while each consumer retains its own descriptor history.
One client profile must follow a single consumer; it must not alternate between
consumers of that shared database. Their revisions do not form one shared
endpoint history, so a different consumer's equal revision can conflict and a
lower revision can be ignored by the client's monotonic descriptor admission.
The source Stack and ordinary PostgreSQL/MySQL servers retain database-backed
continuity. Each consumer publishes and restarts from its own private history;
it neither reads nor writes the shared continuity row. Earlier undeployed 0.3
storage selections do not establish a compatibility transition or revision floor.

The UI's existing `server-state-v1` profile owner retains one exact
`homeConnectionDescriptor` for descriptor-backed Homes. Endpoint and revision
decisions read that snapshot; duplicate-profile merges keep its canonical URL and
public ingress together. The active runtime snapshot's revision is a derived,
non-persisted projection. The development-only `irohEndpoint` and
`connectionDescriptorRevision` profile fields are ignored and are not written.

In 0.3 development, `addressSelection` on that same device-local profile remembers
the canonical-address prompt answer for one Home identity and entered/canonical
address pair. Keep selects the entered transport address without changing the
canonical credential scope or the exact published descriptor. Saved-profile
authentication, focused connections, enrollment and secondary connections consume
the same address choice through the carrier policy or URL-only snapshot. A saved
Home requires the explicit address-change confirmation before persisting Keep for
a new address, including while signed out. An incumbent credential is sent there
only after that consent; authenticated Home identity observation must then succeed
before adoption. Use of an unchanged canonical Home never sends its credential to
the entered alias or replaces its descriptor. A different advertised canonical address asks again;
this local answer is not an Account preference or a cross-device format.

Ordinary URL-only profiles remain readable and usable over standard networking.
Their source shape is present in `ui-web-v0.2.11` and
`ui-web-v0.2.11-preview.186` at
`98ea8fb76733b1dd785d38c31360179cafa84824`, and in the clean prospective profile
owner at `../0.2` commit `9dd9c2580be619b4907257f94174e45ba5517976`.
Those profile shapes contain no Iroh endpoint or descriptor revision fields.
Once a Home has an exact descriptor, a revision-less manual update cannot replace
its connection destination; an exact current Home descriptor is required.
The CLI refreshes changed profile endpoints through authenticated publication.
A port move with retained publisher continuity advances the descriptor revision.
If publisher history is lost or disconnected, the CLI refuses a lower revision
with `stale_home_descriptor`; different Home authority is `identity_mismatch`,
and different content at the same revision is `home_descriptor_conflict`.
Recovery restores that Home's own verified continuity before republishing; it
does not lower the client's admitted frontier. A shared-database consumer's
private continuity therefore belongs with that consumer when its server moves.
Public privacy-reduced observations do not allocate a revision or erase private
facts from the retained authenticated descriptor.

Stack starts for an established Home wait for its matching authenticated
descriptor before refreshing profile endpoints or starting the daemon. The
existing readiness deadline owns that wait. A settled optional Iroh failure
publishes the remaining explicitly configured HTTPS or loopback HTTP ingress at
the next descriptor revision; it does not retire or replace the pinned native
EndpointId. The existing `home.reachability.get` projection retains the typed
Iroh state and failure reason. Recovery may restore the same native identity;
only explicit retirement clears that identity. A Home with no usable ingress
still cannot publish an empty descriptor. This is current 0.3 development behavior.

In current 0.3 development, successful env-only CLI enrollment and seeded daemon
authentication retain the exact Home descriptor on the existing credential
scope. Its initial URL-derived profile id remains immutable; credentials and
Machine state are not copied to another id. An endpoint move can then use the
ordinary authenticated `server set --server-id <existing-id>` admission above.
Daemon startup first materializes ordinary URL-only metadata at that same scope,
so reconnect can read a saved profile even when exact publication is unavailable.
This metadata does not establish Home identity authority.
If an exact authenticated observation finds that another saved profile already
owns the Home identity, descriptor adoption reuses that owner. URL-only invocation
metadata may remain at the selected scope; it does not acquire a second Home
binding or transfer credentials or Machine state. A selected profile already
bound to a different Home still refuses the observation, as does an advisory
observation attempting to bind across profiles.
For an older env-only CLI home with no saved Home binding, explicitly retaining
`HAPPIER_ACTIVE_SERVER_ID` selects its existing credential and Machine scope at
the new user-configured destination. A bare changed `HAPPIER_SERVER_URL` still
derives a different scope when no saved profile matches. Public Home identity
alone does not authorize scanning or rebinding credentials across those scopes.

The separate device-local Account Service endpoint accepts only `source: 'default'`
or `source: 'user'` on both reads and writes. The abandoned `configured` source
is not normalized into a policy choice. It has no endpoint-record producer in
the above stable/preview profile owners or the clean prospective profile owner
at `08e278be495e8f3a1b744bd1d069fc48d2d3276f`; an invalid persisted endpoint is
discarded without changing Home profiles or focus.

### Current finite-transfer admission (0.3 development)

Transfer listener V1 keeps its existing booleans and adds an optional closed
`diagnostic: { code: 'tailscale_operator_authorization_refused', retryable: false }`
presentation fact. It grants no routing or mutation authority and carries no text
or native output; current clients own localized recovery. Omission remains valid,
and stored readers drop unknown fields. This is an unreleased 0.3 projection;
the scoped moving 0.2 predecessor at `bd96136cd37af7f48e5d84750cff1885e7dbeac4`
has no corresponding publication schema or transfer listener in `apps/cli/src/api/types.ts`.
No new wire epoch, persistence migration or reverse-development adapter is required.

The 0.3 transition removes the old-daemon missing-declaration probe and
`legacy_machine_rpc` carrier. An absent, malformed or disabled daemon
transfer declaration is not support. Presentation and execution share the
current declaration reader; ordinary daemons must declare finite import and
export. A restricted Runner has no daemon transfer state and instead declares
`finiteTransferRpc` in its current, server-revisioned operation capability
projection. Endpoint publication alone does not establish finite-transfer
support: the same endpoint also carries workspace and broker traffic.

Iroh selection requires current application support, both
`machines.transfer.directPeer` and `machines.peerMediation`, the canonical current
endpoint descriptor, and a usable host carrier. Browser clients additionally
require the published relay hints. Under IR-105 (2026-10-13), browsers select
Iroh when usable and otherwise select the Home's server-mediated encrypted
transfer RPC phases. This applies at the canonical transfer owner to Found,
registry JSON, workspace files and the other finite Machine families; callers
do not make their own fallback decision.

The Home phases consume the same prepared-transfer capability and dispatch to
the incumbent daemon transfer handler in-process. They retain its encrypted
chunks, import lifecycle, destination completion and current authority checks;
they create no second byte store or filesystem admission path. Signed callers
spend their admitted operation root through
`resolveMachineRpcExternalActionEffectV1`, with the exact installed target and
phase body still verified by the Home. A browser in Standard-only mode uses
this Home route. Native prepared transfers retain their Iroh requirement.
The daemon keeps the prepared-transfer owner available for Home RPC when its
optional direct listener is disabled; that does not enable the finite Iroh
application on an endpoint published for other Machine applications.
Initial selection precedes preparation. A failed browser Iroh acquisition may
use Home only after successful custody cleanup, before any transfer HTTP phase
was sent; cancellation and Account retirement still refuse the operation.
Once the HTTP requester is acquired, failures never replay through Home,
matching Machine RPC's unknown-delivery rule. Undeclared daemons remain
unavailable without a declaration probe.
Session-scoped attachment admission remains separate; Composer media remains
independently negotiated.
This contraction changes live component admission, not readers for data created
by 0.2; no persisted transfer format or data migration is introduced.

### Mobile notification permission responses (0.3 development)

Notification permission buttons reuse `session.permission.respond` with the notification's exact `(Session, turnId, requestId)` and saved Home/Account credentials. The shared Session response owner retains its existing void-success result and accepts structured success; explicit failures and malformed results reject. The ordinary Session UI still resolves transcript projections against its live pending request. The exact notification adapter preserves the notification's turn instead of replacing it with a newer loaded turn. The existing CLI turn-custody check remains the receiver authority. Live iOS and Android responses use the same exact-turn adapter without switching the focused Home or navigating; retained pending-decision records supply review navigation only and cannot replay an answer.

Remote request push preserves the producer's captured request turn through the existing notification content owner; device-local request notifications already carry that turn. Payloads without it cannot answer: live/background mobile callbacks record a generic review notice without navigation; cached launch responses provide review navigation only. The 0.2 source intent at `794937289f` and `c6a67110ed` uses an occurrence UUID and a separate permission operation. Those changes are unreleased at this port boundary: 0.3 uses its existing turn-bound contract rather than adding a UUID-to-turn conversion or another permission operation. This does not establish mixed 0.2/0.3 live-component support under the all-component upgrade policy.

The existing native notification task handles Android action callbacks alongside Session-change wake reconciliation. Equipped iOS builds retain the live native response completion until the claimed callback finishes or the OS expires its background execution. That custody is process-local, survives an in-process JavaScript reload, and does not turn a cached response into permission authority. iOS permission categories require authentication; SecureStore access stays `WHEN_UNLOCKED`, and `Answer` remains foreground. Within the current JavaScript runtime, identical callbacks share work and retain only confirmed acknowledgements for the exact bound request; conflicting decisions cannot overwrite them, and every other settled outcome remains retryable. Live actions use a caller-owned scoped connection without changing the global network gate, focused Home, or ordinary socket pool. An unhandled cached launch response performs only safe review navigation; a permission response already consumed in the running app does not reopen after remount. Generic body-tap navigation keeps its existing hook lifetime, so a new live tap can navigate after remount. The presentation-recovery notice can retain the original Home/Account target, without a request or answer. Readers still accept the previous untargeted flag. Review revalidates saved credentials and refuses a replacement Account; it never replays a response. Android SDK 55 task support already belongs to the native application. The iOS completion/claim/expiry extension requires the patched Expo native module in a fresh binary and a new non-publicdev `happierExpoRuntimeVersion` train; publicdev keeps its fingerprint policy. An installed binary without that API keeps foreground permission categories when registration reports unavailable. This fallback does not guarantee that later execution failure will foreground the app. End-to-end notification-action lifecycle and physical-device validation remain outstanding; this is not a released-capability claim.

### Inline question replies and notification presentation (0.3 development)

Request-preview and local notification producers project supported simple questions through `push/notificationQuestionActions`. One single-select question with up to three choices can offer numbered native actions; one short freeform question can offer text input. The static category and complete display mapping must fit the existing push budget together, otherwise the producer retains ordinary Answer navigation. Privacy-off and missing Account/turn metadata also retain that path. The opaque Home-owned `activity_alert` consumer remains preview/navigation-only; it does not gain a separate native question parser.

Inline answers reuse `session.user_action.answer`, the shared Action-to-RPC answer mapping and `sessionRespondToUserAction`, with an exact saved Home/Account scope. The CLI request owner checks a supplied turn at admission and again against the published request before settlement, so reused request IDs cannot answer a later turn. Ordinary turnless callers retain their existing contract. Unlike the source 0.2 occurrence-aware reply extension, the existing 0.3 response contract genuinely permits void success. The public notification entry owns its existing overall response lifetime, including lazy loading; cancellation cannot issue a later answer. No new response operation, replay store or request journal is introduced.

Ordinary OS request notices are dismissed only after positive canonical completion of their exact Home/Account/session/request/turn. Missing or compact-only Session data is insufficient evidence. Cleanup runs independently of local sending preferences and inspects only Sessions named by presented notifications. On Android the local sender preserves the request category channel when the sound policy supplies no override, while custom and silent sound channels remain authoritative.

### Remote-push diagnostics and quiet-hours authoring (0.3 development)

The Account Action `notifications.push.test` uses the authenticated exact-registration route `POST /v1/push-tokens/:tokenId/test` and the existing Home push sender. The server chooses fixed content and verifies that the token belongs to the authenticated Account. No CLI, broadcast fallback, delivery-receipt loop or new retry owner is added. Service acceptance is distinct from device delivery; transport failure is unconfirmed. Sender results and default-on logs expose partial acceptance. Supported older Homes without the route remain unavailable for this diagnostic.

The custom Account/device quiet-hours editor writes through existing settings Actions and delivery-policy schemas. Authoring validates an evaluable time zone and schedule through one input owner; historical persisted readers retain their existing recovery/default behavior. Existing schedules remain authoritative until Save succeeds. This adds an editor to the current policy, rather than a second scheduler or persisted format.

### Request notification previews (development)

The 0.3 development Notify me Action adds `notify_me` to the webhook topic union
without changing existing topics or payload version. Its optional navigation
uses the existing `sessionId` field or an additive `runId` field. The Activity
owner applies the same attention-policy privacy projection before push, webhook
or plugin delivery. No notification persistence migration or Inbox record is
introduced. Webhook integrations that validate a closed topic enum must accept
this new topic before opting into Notify me delivery.

The Account endpoint-catalog transition is development-only and still in progress.
Its source reader accepts the genuine predecessor Expo Push and HTTP(S) webhook shapes,
preserves their channel ids, six topic fields and exact opened signing bytes, and derives
the builtin push channel only when the source root is absent. An explicitly empty source
stays empty; an admitted empty row or tombstone never reseeds from preferences. Signing
material moves to a SavedSecret Resource rather than a second inline delivery secret.
Catalog consumers treat an unsupported Home route, unreadable row or incomplete inventory
as unavailable, without a push fallback. This does not declare the Settings-based UI
editor retired or certify retained source/history cleanup.

Request previews use the existing `attentionDeliveryPolicyV1` channel/event privacy
owner. Remote push and Live Activity permission and user-action events default to
`include_preview` unless an explicit event preview policy restricts details; legacy
`requestIncludeMessageText` preferences are translated at the existing settings
adapter. Webhook request content defaults on unless the destination sets
`requestIncludeMessageText: false`. Disabling either disclosure decision omits
request details from the body and `request.toolDetails`.

Device-local ready and request preview overrides are separate fields under the
existing `attentionDeviceOverridesV1.localNotifications` owner. The request
override defaults to `account`, delegating to the shared policy. Notification
routing and permission-response schemas are unchanged; richer content uses the
existing text fields, with no new server operation or migration.

The released 0.2 notification editor at `98ea8fb76733b1dd785d38c31360179cafa84824`
(`ui-mobile-v0.2.11`, `ui-web-v0.2.11-preview.186`) rebuilds nested legacy
notification settings and strips unknown fields. A missing remote request flag
therefore restores previews, following the user-selected default. An older editor
can erase an explicit opt-out; users can disable previews again from an updated client.
Older CLI senders ignore this preference and retain their reduced hints.

### Changed Files attribution (development)

The unreleased Changed Files projection separates content confidence from Session/turn
attribution in the canonical Protocol merger, `sessions/changes/mergeTurnChangeSets.ts`.
An exact checkpoint delta can have only possible attribution when another checkpoint
interval overlapped. Correlated Agent/tool evidence remains independently attributable,
while workspace touched paths supply only best-effort content and possible attribution.
The derived per-file and summary axes do not introduce another persisted change-set document.

The foreground host publishes one terminal Diff recap after its existing checkpoint
lifecycle joins normalized tool evidence with the final checkpoint result. The runtime
transcript publisher writes that combined card; the checkpoint lifecycle does not write
a second recap. Bound native turns await that write in their terminal transcript
projection, preserving the existing required-write failure outcome before settlement.
Native turns without a dispatched checkpoint binding and standalone Runs
use the same publisher with provider evidence alone. Original tool rows remain separate
evidence, unavailable checkpoints retain provider evidence, and empty turns emit no recap.
The host tracker also carries tool activity privately to this join. A turn with no
tool calls or native file edits keeps its rewind baseline and emits no checkpoint
recap, even when another writer changed the repository. Any tool activity retains
the full checkpoint diff, including changes made by opaque shell commands.
Interceptable runtimes (currently Claude) dispatch while the baseline is captured;
their first write-like tool proposal awaits that capture at `toolExecution.before`.
Codex and generic ACP retain capture-before-dispatch because their tool events do
not provide that unconditional pre-effect boundary. Terminal publication joins
baseline capture and the turn-start alias even when the reply finishes first.
At that join, the CLI checkpoint projection expands home-relative forms with its canonical
path helper and uses the shared Protocol repository-path normalizer against the resolved
Git root for both current and rename-source paths. Absolute Agent paths and relative Git
paths therefore retain both observations under one root-relative identity; the existing
merger selects content and statistics once. Separator normalization and sibling-prefix
containment stay with the shared path owner, not a transcript/UI dedupe path.
This changes new development-source publication, not previously stored transcript rows;
loaded-runtime verification still requires the rebuilt host and a usable Agent turn.

The same merger normalizes evidence paths against the resolved repository root and retains
all contributing observations through rename chains; copies remain independent. Consumers
use that projection rather than reconstructing lineage from the final filename. Across
turns, a later tool patch is not a Session-wide diff. Continuous recorded text spans can
produce a best-effort net comparison, but tool text may be only a fragment: equal aggregate
endpoints cannot prove that the file is clean. Missing or discontinuous net evidence remains
unavailable, and scoped review does not substitute the current working-tree diff for it.
The Session's canonical latest-turn identity selects the turn view even when that turn
has no file evidence; older file changes remain available in the Session view. Hosts without
that identity retain the evidence-chronology fallback. Checkpoint capture preserves runtime
sequence ranges before asynchronous publication rather than using transcript arrival order.

Checkpoint overlap is historical, process-local capture evidence. The CLI registry uses
the resolved SCM root, remembers overlap for each interval after peers finish, and closes
the interval when final capture completes, before asynchronous diff projection. An interval
without observed overlap says nothing about writers in other CLI processes, daemons,
editors or shells. Project membership does not establish filesystem authorship or isolation.

Current checkpoint writers use `shared_worktree` when overlap was observed,
`no_happier_checkpoint_overlap_observed` when the process-local registry observed none,
and `unknown` when the observation is unavailable. The former development-only
`exclusive_worktree` value was removed from the strict reader after the inspected 0.2.11
stable/preview CLI and UI tags and the current predecessor corridor showed no producer.
No compatibility adapter reinterprets that unshipped exclusivity claim.

The clean prospective predecessor corridor at
`b23f95ed354e8d49183017e487bdb75f217017de`,
`packages/protocol/src/sessionChanges`, names Agent turn correlation `providerTurnId`.
The current evidence schema normalizes that field to `agentTurnId`, preserving an explicit
current field when both are present. Invalid aliases and unrelated unknown fields remain
rejected. Current writers use `agentTurnId`; remove the reader translation only when
predecessor-produced change sets cease to be supported inputs. These reader provisions
are not certification of mixed-version deployed clients or completed live UI validation.

### Session message authorship in development

Host onboarding Messages in 0.3 development may carry additive `meta.happierHostOnboardingV1` display facts (template name, version, optional author display name and first task). `sessionPreparedBirthV1` produces and reads this versioned object; UI and CLI birth adapters preserve it through ordinary Message admission. These facts provide the kickoff byline and a task chip that sends only when selected. They grant no authority: the host-onboarding provenance remains the discriminator. Readers ignore unknown display fields and fall back to the historical host notice when the object is missing or malformed; they never recover it by parsing prompt text. Older readers may ignore it.

The current authenticated transcript adds an optional nullable `accountActor` presentation field. Its Account identity and minimal profile are strict nested schemas; its nested optional `accessibility: current | former` is a resource-owner presentation fact, never authorization evidence. A readable neutral profile can coexist with `former`; consumers must not infer current relationship from profile visibility. Older message envelopes may ignore the additional field. An omitted field preserves previously projected actor metadata during an update, while explicit null clears it. New clients render no inferred author when an older server omits the field. Public/external transcript projection remains separate and omits the Account actor.

The nullable `SessionMessage.authorAccountId` relation is derived from the immutable admission receipt and uses `ON DELETE SET NULL`. Historical rows without a valid human receipt remain unattributed. Deploy current receipt-derived writers, run the [provider-neutral backfill and disagreement audit](pending-delivery.md#human-authorship-in-development), and verify its result before author-based personal Session scopes activate. Additive DDL alone does not establish old-server restart or overlapping-writer support. No JSON-query fallback, repair worker, or second author store participates in this transition.

The Session record also carries an optional `hasOtherNamedCollaborator` audience-existence signal: true when the current authorized human audience contains another Account besides the requesting viewer. It is presentation-only (the transcript self-byline "You" suppression), independent of live presence, and never a roster, authorization input, or grant source. Omitted means the producer did not project it; consumers preserve the last known value instead of asserting a solo Session, and an explicit boolean always replaces it.

### Session visual references (0.3 development)

These are development source contracts, not released availability or deployment
certification. Session visuals retain the existing `surface/item.v1` record owner.
Stored items without a creation destination read as `board`; current creation
records `transcript`, `board` or `both`. Pin and Unpin remain layout operations and
do not change that creation intent or create another item.

The centralized transcript producer captures a small collection of corresponding
visual references before sealing acknowledged tool completions. Multiple native
tool results in one raw message remain one message, with every corresponding
visual represented. The negotiated transcript observation V2 epoch carries the
collection to the existing message writer; V1 retains ordinary text delivery
without the unsupported association. Historical import V3 carries the same optional
collection through the existing batch writer. Its older V2 fallback preserves the
messages but omits the association, so a public visual is honestly unavailable
rather than read through a parent or generic-record fallback.

The retained server-private message JSON column stores the canonical collection;
one shared read codec also accepts the earlier development singleton. Each current
member names an item and its acknowledged record incarnation in the current
Session, plus the exact original item/revision/address for recognition. The
committing writer validates every local record independently: an unavailable member
does not discard valid siblings or otherwise valid text. Content correction clears
an old collection unless the writer admits a replacement. Public reads select an
admitted member index of a published message under the existing share grant and
cutoff, not an independently supplied item id. Fork imports associate independently
owned child records. Original identity is recognition only, never parent-read
authority. An earlier copied singleton without original identity cannot safely
identify a sibling and fails correspondence closed; no source identity is invented.

The development Artifact public-link Action accepts optional `networkOff`
through the same stored-content publication owner as Sessions. True restricts
the public viewer; it does not rewrite the saved document or require a child
`artifact.update` approval. HTML and HTML widget viewers pass the publication's
restriction to the existing sandbox builder. Omission preserves the ordinary
request shape. Explicit true must be acknowledged as true before issuance is
reported; a server that ignores it leaves an `outcome_unknown` result, never a
falsely confirmed network-off link. The original approval keeps its immutable
operands and preview; its validated decision may narrow that same link input.
This is an unpublished development contract with no new shape, migration, wire
epoch or predecessor adapter.

Public Session-share requests add optional `networkOff`, with absence reading as
`false`. The canonical request binder omits false, preserving the ordinary request
shape. An explicit true must also be acknowledged as true before either client
reports successful issuance. Older strict servers can refuse the option; an older
permissive server that strips it leaves the existing outcome-unknown result, never
a falsely confirmed network-off link. That unknown result does not prove that no
server-side link was created. The stored option can restrict the shared sandbox but
does not itself admit network access. See the
[Session share API](api.md) and [public encryption boundary](encryption.md) for
the canonical envelopes and viewer contract. The additive message/share columns
require the canonical provider migrations; source generation alone does not prove
deployment against retained data.

### Enterprise identity and directory provisioning (0.3 development)

Managed identity providers, Team identity connections, and directory sources are new
additive tables in 0.3 development source. Nothing about them is released, so the only hard
obligations here are the released `AccountIdentity` and `LinkedProvider` shapes they extend.
The domain itself is described in [enterprise-identity.md](enterprise-identity.md).

| Direction | Required behavior |
|---|---|
| Released UI → new server | Ordinary built-in and deployment authentication remains usable and strict `LinkedProvider` remains parseable. Managed administration is simply absent from an older client, never malformed. |
| New UI → released server | Ordinary Home authentication falls back to the released `/v1/features` projection **only** when `/v1/auth/entry` answers 404, 405, or 501. Team-managed operations are unavailable rather than sent to a permissive generic route. |
| Released database → new server | Migrations are additive and preserve every existing `AccountIdentity.provider` value and profile byte. No environment-provider row is backfilled, and there is no foreign key from `AccountIdentity.provider` to the managed provider table, because built-in and deployment providers intentionally have no row. |
| New schema → old server | Not a supported direction. Additive tables alone do not establish safe old-binary startup. |
| Mixed fleet after activation | Not supported. Every authorize, callback, and finalize handler must resolve managed providers before managed configuration is activated. |
| Old-server rollback after activation | Not supported, and no rollback-only writer or persistence path exists. This does not remove released-client support against a new server. |

The activation sequence is therefore prepare, then all-capable activation: add the tables,
codecs, readers, and catalog with managed providers disabled; replace every server process
that can receive an OAuth start, callback, or finalize; then activate managed configuration
and writes.

One compatibility reader is retained deliberately. `securityBinding` is optional in the
persisted OAuth attempt and pending schemas
(`app/api/routes/connect/oauthExternal/oauthExternalSchemas.ts`), because a server process can
be replaced while attempt rows it authored earlier are still inside their TTL. That reader
carries no managed or Team authority. `hasInvalidOAuthSecurityBinding` exists so a
**malformed** new binding can never be misread as a legitimately absent one. Its removal
condition is the drain of every legacy-writing server process plus the maximum attempt and
pending TTL — a server-authored ephemeral lifetime, which client support windows do not
extend.

Because none of this has shipped, an unreleased intermediate shape carries no obligation:
correct it in place rather than adding a reader for it. Persisted directory projections are
reconstructible from their upstream source, but native memberships and Group contributions
written from them are not — they are ordinary native facts owned by
[teams-membership-and-groups.md](teams-membership-and-groups.md) and follow that owner's
rules.

### Native email/password authentication (0.3 development)

The following describes the current development source, not a released feature.
The method is default-on, with
`HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED` and its provisioning key as the
operator opt-out described in [feature-gating.md](feature-gating.md). Persisted
Home policy and operation-specific mail readiness determine effective actions.
There is no disabled-until-validation activation gate. Current-source tests and
runnable development journeys remain implementation checks; physical-device,
real SMTP and production-like infrastructure evidence remain release checks.

The immutable stable server source tag was rechecked on 2026-09-26 as
`server-v0.2.12` at `a357c65536ba89669422977d6f7daf9aa0d17e73`.
The moving `../0.2` predecessor was inspected read-only at
`9047258b99545a8ce84923789c87945fcaeb1e69` with a clean worktree. Its bounded
auth, credential and schema paths contain no native-password or Account API-token
contract. These are source observations, not artifact/deployment certification.

`AccountEmail`, `AccountPasswordCredential`, and the native email identity are additive
tables and rows in 0.3 development source; the nullable password-mutation purpose/digest
fields extend the unreleased `KeyChallengeV2` migration in place rather than shipping an
add-then-alter history. Nothing here is released, so the released obligations are the
existing Account, identity, and credential shapes the new tables extend.

The incumbent Account-encryption migration request likewise gains only an optional strict
prepared `passwordCredential` participant. Released clients cannot have the unreleased
password row and retain their passwordless transition behavior; current clients with an
enrolled password must supply the participant, and the server fails closed instead of
flipping the mode beside a source-mode credential. No reader or dual writer is retained for
superseded, undeployed development request drafts, and the staged V5 route stays disabled.

The approved 0.3 upgrade is one-way: every component updates together, with no
mixed 0.2/0.3 operation or old-binary rollback. The former old-client-safe
`email_password` omission has therefore been removed. `/v1/features` publishes
the effective method decisions through `toPublishedAuthMethods`, while
`POST /v1/auth/entry` remains the complete contextual Home/Team/invitation
projection. Both consume the same policy owner; neither creates another
availability decision.

| Direction | Required behavior |
|---|---|
| Current 0.3 client → current 0.3 server | Native password actions use the current effective-method and contextual-entry contracts. |
| Mixed 0.2/0.3 client/server | Unsupported under the all-component one-way upgrade; no old-client omission or minimum-client simulation is required. |
| Released database → new server | Migrations are additive and preserve every existing `AccountIdentity` value and uniqueness rule; the native-identity widening is applied forward through the owning unreleased migration, not by a second lookup or digest alias. |
| New schema → old server | Not a supported direction. Additive tables alone do not establish safe old-binary startup. |

A password-only Home is a permitted operator configuration. Governance still
protects currently usable Account login routes and the final active Home
administrator through the canonical auth-domain check; it does not impose a
0.2-client floor. Forward readability of 0.2-created data remains required:
existing credentials, recovery-key bytes and provider identities are preserved,
and released migrations remain immutable. Purpose-bound mutation challenges
must still be rejected by ordinary login redemption. These invariants require
neither a compatibility writer nor a separate rollout protocol.

## Stored Compose supporting files (0.3 development source)

The unpublished stored definition and template Compose schemas accept optional
`publicFiles`, each containing a portable contained path and exact public content.
The template review accepts the same files and an optional Compose `document`.
Definitions without files retain their document-only digest. File changes take
part in source identity, stored content revision and the existing review; template
updates merge them against the pinned baseline and preserve local edits or report
the existing resource conflict. Export materializes them through the existing
workspace manifest alongside `compose.yaml`.

Current development components must update together: older closed readers reject
the new fields. There is no alternate writer, migration or supported reverse
development rollback. The optional fields preserve existing file-free inputs.

The Move Create preview's existing closed `files` entries now accept a string
or null for `before`, so an existing committed checkout can retain its file
before-images. Matching development Protocol, CLI and UI readers update together;
older null values remain accepted. This changes no persisted record or wire epoch.
The scoped-clean `../0.2` frontier at
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` has neither the Move schema nor its CLI
owner at the corresponding paths; no predecessor adapter is introduced.

## Optional app-template Domain health (0.3 development source)

The unpublished `deployment-template.v1` descriptor and private
`deployment-domain.v1` content accept an omitted `healthCheck`. Their nested
objects remain closed, and a supplied probe still requires a valid path and
exact expected status. Existing descriptors with probes retain those operands;
unprobed templates install through ordinary reviewed approval. The finite
observer returns existing `unknown` health without network I/O, and Caddy omits
active probes and health authentication exemptions. No healthy observation is
inferred from route activation.

Matching current development readers are required: older development readers
reject an absent probe. This is a direct development cut, with no migration,
adapter, new wire epoch or supported reverse-development rollback direction.
The inspected `../0.2` frontier at
`512915f3ccf4a29a8454b74ad9db6ca72079d916` has no corresponding template or
Domain schemas in the affected Protocol and CLI paths.

## Native Domain Caddy diagnostics (0.3 development source)

The closed V1 native Domain observation and captured-placement JSON accept
optional `routedReplicas: [{ containerName }]` outside placement identity. The
existing installation signature binds this last successful Domain-apply snapshot.
The closed get/list header optionally projects `routedReplicas` with literal
`source: 'recordedTopology'`, a derived count and closed Machine/installation/
container identity rows. Verification omission retains recorded topology; absent
desired snapshots remain unknown and removal clears them. These facts do not
claim current traffic or health, and start-first switches do not refresh them.
Matching Protocol, CLI and server readers reload together under the unpublished
0.3 direct cut: earlier strict development readers reject the new fields.
Existing stored captures without them remain valid. The V1 wire epoch is
unchanged, independently of package SemVer, and unknown fields remain rejected.
No column, migration, compatibility adapter, probe or polling path is added.
The inspected scoped-clean `../0.2` frontier
`7b0f74960b1393886b994dbda71dcb3439c1ab57` has neither the Domain Protocol nor
server Domain service path.

The existing Domain `native_execution` failure details now retain an optional
closed Caddy diagnostic: a fixed step and Docker phase, numeric command/container
exit status, classified bind failure and TCP port. Raw command output and Docker
container error text are excluded. The same schema owns persistence and public
approval reads; existing rows without the diagnostic remain readable. Current
development readers must update with the producer because older strict readers
omit these added details. This is a development cut with no migration, alternate
writer or supported reverse-development rollback.

Native Domain Caddy uses local host mounts, firewall setup and a local Unix admin
socket. Its admission observes Docker publications and local TCP conflicts before
effects. Explicit remote Docker endpoints contribute publication evidence only;
they cannot establish ownership of this process's local sockets. A port acquired
after admission remains a visible native start failure recoverable by retry.

## Shared Project setup (unreleased 0.3 source)

The development Project organization format adds optional compact
`setupSelection` and `setupContent` references. Accepted manifests and personal
overrides live in protected `project_setup.v1` Artifact bodies, outside the
default Project census. Existing rows with neither reference retain repository
definitions. A selection without its matching protected detail is unavailable,
never an empty setup or permission to run changed commands.

Current `projects.inspect` exposes `effectiveDefinition` separately from the raw
repository `definition` and its file basis. Execution/placement consumers use the
effective declaration; repository editing still uses the original file basis.
Explicit `reviewSharedSetup` demands add the typed `sharedSetupChange` comparison.
`projects.setup.set` is the acknowledged organization-CAS writer for shared
selection and personal overrides. Source-selected `artifact.get` adds the exact
`projectSourceId` parent to its request. These are current-source contracts,
requiring matching development components; no released skew fallback, alternate
trust store or migration is introduced.

## Migration history

Migration source has a stricter authoring boundary than ordinary internal code:

- A migration is **local-only** while it has not shipped in a supported stable or preview artifact. Follow the 2026-10-31 **Migrations: no edits during development, one consolidation before 0.3 release** row in `.project/OWNER-RULINGS.md` for migration authoring, the named release check and accidental-edit reconciliation; the reconciliation procedure is in `apps/stack/AGENTS.md` **Repo-local development database reconciliation**.
- Once a migration ships in a supported stable or preview artifact, its name and bytes are immutable. Correct later behavior with a new append-only migration; do not rewrite, rename, or delete the released migration.
- Shared development branches and `*-dev.*` artifacts are evidence that a development database may need explicit reconciliation, but they do not create a lasting product compatibility obligation. Migration authoring and release consolidation follow the owner row above.

The named pre-0.3 release consolidation check is owned by the migration-policy row above. Do not retain add-then-drop columns, temporary tables, renamed draft identities, checksum aliases, or corrective migrations solely because a developer database applied an earlier draft. Retain multiple migrations only when each step serves a real rollout, backfill, transaction, provider, or mixed-version requirement.

If an applied migration was edited anyway, follow the owner row above and the procedure in `apps/stack/AGENTS.md` **Repo-local development database reconciliation** for the current checkout's retained dev DB:

1. resolve the current checkout's deterministic repo-local stack and verify its repository path and managed database ownership;
2. treat its database as retained, non-disposable development data—never delete, reset, recreate, replace, truncate, clean, or discard it;
3. do not ask for separate confirmation and do not create a backup, snapshot, or clone for this narrowly scoped repo-local reconciliation;
4. compare its actual data, complete physical schema, and migration ledger with the intended final schema;
5. quiesce only stack-owned writers when required, apply the exact provider-specific schema/data delta or canonical backfill transactionally, and update only the matching ledger record after the transition succeeds;
6. run the canonical migration deploy twice, then verify current source checksums, the ledger, provider integrity, and foreign keys;
7. restore the stack's prior running state when it was quiesced.

Reconciliation after an accidental applied-migration edit belongs to the last editor under the Stack procedure. Any later accidental edit invalidates earlier checksum/ledger reconciliation evidence and requires fresh reconciliation before handoff.

For `main`, shared, staging, production, external, another checkout's/named QA stack, or otherwise user-owned databases, prepare the provider-specific procedure, back up or snapshot when required, and obtain explicit approval before mutation. If stack identity or database ownership is ambiguous, fail closed without mutating any candidate.

That reconciliation is an operator/development action, not a shipped compatibility path. Do not add runtime checksum exceptions, migration-name aliases, duplicate no-op migrations, or automatic ledger repair merely to preserve unpublished development history.

Keep PostgreSQL, SQLite, and MySQL migrations aligned by intent. Before publication, validate both a clean migration from the published baseline and the executed repo-local reconciliation path when affected; use the approved reconciliation path for other retained databases. After publication, preserve the exact migration history and test upgrades append-only.

### Unistyles native bindings (development)

The development UI upgrades Unistyles from 3.2.4 to 3.5.3 and Nitro Modules
from 0.35.6 to 0.37.1. Non-publicdev lanes use the new `0.3.1-native`
runtime train, so this JavaScript cannot be delivered to binaries containing
the previous bindings on `0.3.0-native`. Publicdev retains Expo's fingerprint
policy. Rebuild the native development client after installing these dependencies;
a Metro reload alone cannot update the native bindings. Publish the matching
native build before publishing an OTA update for this train.
React Native's CocoaPods post-install owner marks glog's namespace-fragment
headers textual, so Swift can import Nitro's public Fabric headers without
Clang attempting a submodule import inside `namespace google`.

## Daemon identity observations (development 0.3)

The optional admin-access account and service observations remain unknown
when absent or inaccessible. Linux password-lock and login-shell facts come
from the existing native account observer. A locked password does not prove
that the account has no password or cannot authenticate by another method.
Service scope describes process cgroup membership; the existing
`serviceManaged` fact identifies a managed daemon. `startsAtBoot` describes
configured automatic startup without signing in: an enabled system unit, or
an enabled user unit with observed linger. An enabled user unit without
linger reports false. Other enablement states remain unknown because a
dependency could still start the unit; no dependency graph is inferred.

## Machine managed-resource classification (unreleased 0.3)

Home's finite-wake authorization carries the admitted controller and installation
key. CLI and UI consume that result without requiring requester access to the
controller inventory. Optional `managedFiniteWake.requesterCredentialDisclosure`
names an additional credential recipient selected by Home: the managed row's
custodian, when different from both requester and guest custodian. Delegated
enrollment can give the guest another custodian. Existing guest disclosure covers
the same person once; a new controller recipient requires explicit consent before
sealing or dispatch. Matching development Home, Protocol and clients reload
together; older strict development readers reject this member. This unpublished
carrier has no released 0.2 counterpart or retained-data migration.

Current Home Machine rows publish `managedMachineRef` as an exact
`{ homeId, managedId }` or null. Readers accept the omitted field emitted by
supported 0.2 Homes as null through the canonical Protocol read projection;
explicit malformed references still fail parsing. The strict current published
row writer requires the field. Cached UI rows may retain unknown until the exact
canonical read. Omission in a legacy full row has ordinary-Machine meaning:
the inspected 0.2 frontier `1321319f311da3d44931afd39eeac7252b6350a4` has no
managed-resource producer. This preserves the Home-presence coexistence contract
above; it does not promise managed wake against an older development Home.

Current development Machine reads and new/update events also publish optional
`managedInputRuntime: { nativeReady, wakeState, acceptedInputWakeOwner?, newSessionWake?, state? } | null`. The managed runtime
owner derives native qualification independently of connectivity; existing
guest presence still decides reachability. `wakeState` is `asleep`, `starting`
or null and makes a wake claim only while the owner enables accepted-input
wake. Optional `acceptedInputWakeOwner: 'home'` identifies Home Pending wake for
existing Session input, including a controllerless resource served by a running
custodian Account daemon. Optional `newSessionWake` is `{ kind: 'available' }` or
`{ kind: 'unavailable', reason: 'no_controller' | 'controller_unavailable' }`, projected from
`resolveManagedWakeAvailabilityV1` using the assigned controller's exact installed,
online, unrevoked and unreplaced Machine. It exposes no controller identity.
The additional unavailable cause is an unreleased 0.3 direct cut: matching Home,
Protocol and UI reload together; it changes no retained data or 0.2 contract.
Installation rebinds update preset pins through the existing preset collection
publication, so mounted pickers refresh their structural controller binding.
New Session start-on-send requires both an owner-enabled `wakeState`
and `newSessionWake.kind === 'available'`; a missing support fact makes no claim.
Controllerless pre-Session wake remains unsupported and requires starting the
Machine before sending. Optional `state` reports the current native transition (`starting` or
`stopping`), a parked resource (`asleep`), or null, independently of wake
eligibility. Desired intent alone does not prove a transition. It contains no
protected native identity, and native Running does not prove guest reachability.
Machine rows, headers and Project Services consume the same presentation and
recovery from these facts; dated native observations remain in Details. Matching
Protocol, Home and UI development readers reload together because older strict
readers reject the additional optional member. Neither this projection nor Can
use on the guest grants manual power or
access to the controller's managed allocation. Missing or null projections make
no readiness or wake claim. This changes no retained database field or protocol
epoch. The inspected 0.2 frontier `ead3f779118d6a3d17e167517a64660f9e2c2c0d`
has passthrough new/update Machine readers and no managed-input producer; that
parser tolerance does not establish managed wake support against an older Home.

## Devcontainer preset operands and acquisition review (unreleased 0.3)

Devcontainer launch choices now use the provider's author-input schema and omit
native `reviewedEffectDigest`. Provisioners declare `effectReview.requiredWhen`
through the existing input predicate schema. The author Save admission captures
native source effects once in private `authorEffectReview`, whether Prepare is
enabled or disabled. Cold preset acquisition consumes this stored digest;
prepared acquisition uses the bound physical artifact. Members never recapture
author approval. One-off acquisition retains its existing transient options and
`reviewedFacts.reviewedEffectDigest` receipt. Native acquire receives the admitted
digest separately from launch operands and retains its effect-time drift check.

Matching Protocol, SDK, UI, Home and controller declarations must reload
together; older strict development readers reject the new optional review-fact
and acquire-input fields. Earlier development presets project saved values
through the current author-input schema when edited. Retained Machine resources
keep their existing executable digest and identity; power and resize keep the
retained-resource contract. Earlier unfinished acquisitions without the admitted
review fact require a fresh review rather than reconstructing approval from
their launch or resource. This changes no wire epoch and adds
no fallback or person-entered digest. The inspected `../0.2` frontier
`7b37d65ca75e58560f8f3ca850958ac5407d2e75` has no Devcontainer plugin or managed
Machine preset contracts.

## Managed guest authority (unreleased 0.3)

Managed guest CLI updates use the connected Home's guest payload through the
existing bootstrap retry operation, including acquire and repair. A missing
payload is a typed `guest_payload_missing` refusal rather than a fallback to a
public 0.2 release. Inspect recognizes the released 0.2 doctor-only JSON shape
when the guest lacks the diagnostic collector and returns
`guest_cli_incompatible` at `guest_capability`; malformed collector output still
returns `invalid_action_output`. No wire or persisted shape changes are involved.

Each enrolled managed Machine keeps its own Account, Team and Group grants.
Manage on a controller also supplies Manage on its guests, including nested
guests; Can use on a controller supplies no guest authority. Cyclic controller
references propagate only existing Manage authority. The ordinary Machine
permission graph owns guest access for Session, terminal, service and Action
admission. Native resource custody is separate: `managedRole.ts` caps a guest's
own role at Use for the managed-resource projection. Only controller Manage or
controller-less custody supplies resource Manage, required for native lifecycle
control and unredacted custodian credential/bootstrap selectors. Granting admin
on a guest does not delegate the custodian's billed resource.
Team workload authority uses the Team's grant, independently of any member's
personal Machine grant. Pools retain their separate ownership and audience
contract.

Guest publication and recipient-envelope work follow the same controller
ancestry. Permission does not supply encrypted key material: an E2EE guest still
requires its own current recipient envelope, and a plain Account is not given
fabricated encryption material. Withdrawal affects the next admission; a finite
native effect already admitted keeps its signed authority through settlement.
This is a server authority correction with no wire, persisted-shape, schema or
protocol-epoch change.

## Chrome Web Store registry format (unreleased 0.3)

`chrome-web-store` is a new registry format id for the built-in browser-extension source. It uses the store's private batchexecute listing and detail reads and the existing update2 content digest check; acquisition remains the daemon browser-extension owner. Older strict development clients reject the unknown format id at source admission, so the source is omitted until the client is upgraded. Paste-link/ID installation remains available.

The optional browser-extension payload `listing` carries upstream display version, declared permissions and website patterns; summary publisher comes from the Store detail organization or Offered-by name, falling back to a supplied manifest author. The existing content ref and summary version remain the package digest. These facts are informational: acquired-manifest permission review remains the browser owner's mutation contract. This unreleased 0.3 closed development contract loads matching daemon, Protocol and UI readers together; an older strict reader can reject the new field. No persisted format, epoch or compatibility adapter is introduced. The inspected `../0.2` frontier at `57cd3db058af7767335d6d5a4ed44904460c50bb` has no corresponding registry-item schema.

## Native startup failure diagnostics (unreleased 0.3)

Committed Session startup refusals preserve the existing `no_eligible_member`
and `no_eligible_group_member` Connected Account codes through the canonical
spawn-failure projection and Session turn issue. The closed startup catalog and
UI recognize both codes after a reload; private adapter prose is excluded.
This changes presentation and classification of existing codes, with no new
record, envelope, migration, epoch or compatibility adapter. Development CLI
and UI readers must adopt together for the corrected diagnostic presentation.

The existing optional `SessionRuntimeFailureCauseV1.providerErrorCode` accepts
redacted native string codes alongside integers. Existing enum strings remain
valid. This is presentation evidence in the existing closed diagnostic envelope,
never authority or retry policy. Matching development Protocol, CLI, Home and UI
readers load together; older development readers reject unfamiliar string codes.
No new epoch, adapter or persisted format is introduced. The inspected `../0.2`
frontier at `52d077ee67fdcf7b5f6dfb64be5af9e9893887e4` has no
`failureCause` or native-code fields in the corresponding runtime issue schema;
that path has no local diff against its HEAD.


## Environment secret request and Compose use review facts (unreleased 0.3)

Built-in approval headers may carry `approvalListFacts.environmentSecretRequest`, an
Environment id for a `deployments.bindings.set` request containing `person_selects`.
A present fact must agree with the admitted body; absent optional facts preserve older Inbox
readability and do not classify an inline Environment request. No secret names, references or
values are indexed by this field. Existing reference-only choice, consent and replay owners
remain authoritative.

The private native deployment review may carry optional `variableUseWarnings` with a name
and `unusedBinding` or `unboundVariable` kind. Native source interpolation names remain
host-private and are removed by the final review projection. Matching development CLI, Protocol
and UI readers load together; older strict development readers can reject this new review
member. No protocol epoch, database migration or compatibility adapter is introduced. The
inspected `../0.2` frontier at `91e2afbaca33e8589652c2d2b7e2abfa9a2cf049` has no
corresponding approval Artifact header or deployment-review schema. Its approval-request paths
have no local diff, and its released request reader is unchanged by this work.

## Vercel provider outcomes (unreleased 0.3)

Vercel Create's protected `preparedNative` and successful TargetLink result add
optional `productionBranchOutcome`. Its new closed presentation union records
`set`, `defaultKept` or `unconfirmed`, with closed SCM branch values and the
existing closed failure cause. The host projects only this outcome after saving
the association; it adds no server-readable branch metadata or effect authority.
Earlier content without the field remains valid. Matching Protocol, SDK, provider
declarations, controller and UI reload together under the unpublished 0.3 direct
cut; older strict development readers reject the new fields. The same inspected
0.2 frontier below has no deployment-role counterpart. No input, epoch, database
format, compatibility adapter or additional Action is introduced.

Vercel Domain provider observations add optional `failureCause` using the
existing closed Action diagnostic schema. Pending verification retains the
provider cause beside its ownership instructions in the existing private Domain
Artifact; no new metadata or storage owner is introduced. Earlier observations
without the field remain valid. The observation, Domain content and nested
diagnostic remain closed; unknown properties are not normalized or preserved.
Matching Protocol, SDK, provider declarations, controller and UI reload together
under the unpublished 0.3 direct cut; older strict development readers reject
the new field. The inspected `../0.2` frontier
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no deployment contract at these
paths or scoped local changes. No wire epoch, input, capability, adapter or
persisted envelope changes.

## Domain DNS draft verification (unreleased 0.3)

The existing `deployments.domains.verify` Action adds a strict `mode: 'preview'`
input and a DNS-only preview result. Attached verification retains its existing
input and Domain result. Its admitted `domainDns` child uses exact Machine and
installation routing; private Domain content remains in the encrypted child
body and is excluded from the public routing projection. Protocol, Home, CLI
and UI adapters adopt these closed unions together in development. Older strict
development readers reject the unfamiliar variant; no epoch, migration,
retained preview record or compatibility adapter is introduced. The inspected
`../0.2` frontier `dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no
`packages/protocol/src/deployments` contract and no local change at that path.

## Session Stop failure diagnostics (unreleased 0.3)

The owning daemon also settles explicit Stop for untracked plain Sessions whose
runner tuple and control projection are absent, including older Voice carriers.
The existing retirement writer persists the stopped lifecycle after checking
that no terminal attachment remains; a replacement runner or projection prevents
retiring that replacement. A retained server `active` bit alone does not require
a historical exit projection. This changes no wire or persisted metadata shape.

Incomplete daemon Stop receipts optionally retain the existing sanitized Action
`failureCause` and `effectAttempted` facts. The native receipt remains closed;
its nested cause uses the existing closed Action diagnostic schema. The command
Stop result remains additive-open/preserve and declares these optional fields,
along with the native `processFailure`. CLI, app and dependent Action projections
retain the facts without changing physical-stop confirmation or failure outcomes.
Receipts without diagnostics remain readable.

Matching Protocol, daemon, CLI and UI readers reload together under the unpublished
0.3 direct cut. The scoped-clean `../0.2` frontier at
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has a strict native Stop reader that
rejects these additions; current development responses are not a supported reverse
rollback direction. No input, authority, persistence format, wire epoch, error
taxonomy, polling or compatibility adapter changes.


## Team broker source-open refusal reason (unreleased 0.3)

The broker admission failure adds optional `sourceOpenFailureReason`, using the
existing closed source prerequisite vocabulary now owned by Protocol. The CLI
source owner derives its type from that schema; HTTP and Iroh carrier refusals
consume the same application-refusal formatter. Missing diagnostics remain valid.
Matching development readers reload together: earlier strict 0.3 readers reject
the added field. No reverse-development shim, epoch, authority or persistence
change is introduced. The scoped-clean `../0.2` frontier at
`dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf` has no corresponding
`packages/protocol/src/providers/brokerRouteGrantV1.ts` contract.

## Prepared-guest SSH trust (unreleased 0.3)

The existing `systemTask` Action operation attachment optionally carries the
non-secret `ManagedMachineBootstrapPromptV1` while Prepare waits for SSH host
trust. Attachments without a prompt remain valid. The existing task response
uses its task id and expected prompt kind; Prepare does not invent a managed
Machine id. The SDK observes the host before credentials exist, then asks the
host's admitted trust service before guest access. Matching Protocol, SDK, CLI
and UI development readers reload together; older strict 0.3 readers reject
the new optional field. This is a direct development cut with no persisted
format migration, epoch or feature gate. Existing managed-resource trust
identities and known-host pins retain their format.

## Promote source admission (unreleased 0.3)

The closed native deployment admission adds a `kind: 'promote'` variant with
`environmentId`, `sourceEnvironmentId` and `sourceDeploymentId`. Home admits
the selected source provenance at mint; its signed binding and envelope matcher
retain the exact projection so existing scoped preparation reads can spend it.
Matching Protocol, Home and controller readers reload together. Older strict
development readers reject the variant and old admissions must be reminted.
The inspected `../0.2` frontier `dff0d106e604efb7c9d7e6006e3bd5fb955a4ddf`
has no corresponding deployment-native schema or working changes at that path.
This uses the unpublished 0.3 direct cut; no migration, adapter or gate is added.

Project files authoring (unreleased 0.3) uses the existing private preset content
envelope for its default and the closed Session placement selection for its
override. Copy once and the existing Replica/Editable-copy modes carry the
existing workspace content policy for Included (content selection and include/ignore
patterns); their source Folder remains the placement's workspace source. Git clone
carries a credential-free repository/branch selector and an optional qualified
connected-account reference for Git account. Credentials never enter either
the preset content or the Session recipe. Two-way sync exposes the existing
Workspace sync conflict review; this authoring format adds no conflict policy.
Omitted private defaults retain the Copy once intent. This authoring contract
requires matching development readers and writers: an older strict placement
reader rejects the new field, and older private-content projections cannot be
used to execute its meaning. It establishes no support for mixed 0.3 development
versions and adds no predecessor shim or feature gate. The scoped-clean 0.2
frontier inspected at `87aaa83f6b81c92a4ceee5816df2e566ed429bc7` has neither
of the affected preset-content or placement modules. The immutable Session recipe
retains the effective choice, and enrolled copies retain their original workspace
addresses for reviewed return. Native managed workspaces use a closed V2 reference
rather than adding optional native locators to Machine V1 references: old readers
must reject an unsupported target instead of treating its guest path as a host path.
Return review consumes the existing SCM comparison owner and carries file-content
changes only; Git internals/history and ignored files remain in the sandbox.
Both-changed paths preserve the host by default, with explicit conflict replacement.
Runtime transfer and loaded journey evidence remain separate from acceptance of
the authored choice.
