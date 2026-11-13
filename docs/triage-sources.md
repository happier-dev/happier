# Triage source protocol ownership

Triage and independently authored source plugins share one versioned, source-neutral ABI. Triage owns the feature and configured-source lifecycle; each source owns its provider-specific discovery, reads and detail rendering. Generic hosts admit, invoke and mount contributions through the plugin platform.

This page describes **0.3 development / Developer Preview source**. Exact field layouts, exported names and bounds live in [`packages/triage-protocol/src/v1/index.ts`](../packages/triage-protocol/src/v1/index.ts) and its schemas, not a copied schema in this page. Registry publication and loaded external-provider validation are separate release/runtime evidence.

[`bounds.ts`](../packages/triage-protocol/src/v1/bounds.ts) owns one static presentation/control
string allocation derived from the canonical Action response envelope and the 56-row × 32-lane
transport geometry. Existing truncation and omission markers remain row-local. Projected facts
have no count cap; the row renders one Signal. The maximal-schema test uses explicitly finite
provider-collection witnesses: arbitrary provider facts, relations and transitions remain governed
by the existing host envelope, not that witness. Durable mark/link display strings instead use
the Collection's measured plain/E2EE envelope; an oversized mutation returns its existing typed
failure and preserves the previous row.

Configured-instance tokens and locator strings use the stable 7,336-byte
`MAX_TRIAGE_SOURCE_INSTANCE_FIELD_UTF8_BYTES_V1` storage contract retained by
the source-instances V4 writer. They never use the list's derived allocation:
adding projected fields may shorten display projections, but cannot narrow
persisted configuration or its readers. The list projects a configured source's
label at its display boundary and sets `projectionTruncated` when shortened.
This correction is development source;
an already-loaded declaration requires the normal producer reload.

Source fact ids are unique within each snapshot. Triage admits source scan and
exact-get output through `admitSourceFacts` after host structural decoding. A
duplicate id refuses the whole result with
`plugin_targeted_operation_result_invalid` before any row is folded or sent to
Composer; the same id in separate snapshots remains valid. This is a Triage
domain rule, independent of the JSON Schema transport.

## Unavailable source diagnostics (0.3 development source)

Plugin admission and loading own unavailable-plugin causes. Registration carries
their supplied plugin id and code through the targeted-contribution snapshot.
The aggregate list retains that cause as a configured source's optional
`availabilityFailure`, using the existing source-failure schema. Metadata-only
reads retain it too. Missing diagnostics remain unknown; Triage does not infer a
cause by comparing inventories.

Source management and shared source Settings use their existing Details
disclosures for codes, safe reasons and actual request ids. Losing source
admission preserves a known read diagnostic until a supplied admission cause
replaces it. An admission cause without a request id stays without one.
Pinned-entry refusal and exact reobservation carry the same supplied failure to
the existing detail disclosure when no source connection can run the read.
Native PR-status reads and their dependency observation preserve it too, before
the existing Forge readiness projection and failure disclosure consume it.

## Universal Search (0.3 development source)

The `entry-search` provider binds the Account-target `entries/search-v1` Action
in `triage-account-runtime`. Each query reuses the aggregate list's Account
context binding and `assembleTriageListPass` scan/fold/matcher, then projects
the bounded window into the canonical search result. Source-declared glyphs
come from that same admitted source snapshot; result activation carries the
existing Triage app-page command and exact entry/source-instance identity.

Search does not require a mounted Triage page, its retained client window, or
a Machine description. It reads Account data for each query instead of sharing
the mounted window's acquisition. At Home scope the Universal Search section
invokes that same Account Action with each reachable Machine as its source
execution context, merges provider result identities, and retains the supplying
Machine for activation. An explicit Machine scope uses only that Machine.
Unreachable Machines are named alongside the surviving results. With no reachable
Machine, the Account query still runs so personal tasks remain searchable;
Machine-backed sources retain their ordinary unavailable/incomplete lane results.

In development source, text queries reach sources through the existing scan
input. GitHub includes literal text terms alongside the configured repository
selection and the five involvement lanes. Each query reads at most one search
page per lane; further provider pages remain explicit Load More demand, with
partial coverage retained. The aggregate still applies its shared matcher and
fold. Sources without native text search may return their ordinary bounded
page; their coverage evidence is not promoted to a complete remote search.

Mounted list text, facet, named order (`newest`, `oldest`, `smart`) and Smart-policy changes project retained rows
locally without starting or cancelling provider reads. Partial coverage remains visible;
explicit Load More continues the existing unfiltered source frontiers and
applies the active lens to appended rows. Clearing text restores retained rows.
Universal Search's provider search uses the existing GitHub client's
resource-specific quota parking and adds no polling or retry.

Explicit field sorting in 0.3 development uses the same live, saved and agent
list lens: `sort: { field, direction }`. The source descriptor declares
`sortFields` for unconditional support; a source with configuration-dependent
support returns its `sortFields` from the existing `listScopeUnits` configured
metadata projection. An explicit empty array means unavailable, and a failed
configured projection offers no fields. The selected-source intersection owns
which fields the UI offers, and the aggregate list Action refuses an unsupported
selection before provider I/O. Selecting a field or changing its selected source set starts a fresh native
acquisition. Named orders retain their existing retained-window behavior.

For a field-sorted list, sources order their native pages before returning them.
[`scanPass.ts`](../packages/plugins/triage/src/projection/scanPass.ts) owns the
cross-source head merge and retains unshown rows with each native frontier in
the existing list continuation as typed `retained` data. The native page and
its opaque source cursor stay structured through plugin Action result redaction;
no JSON-looking string embeds the cursor. It compares the field and direction, then the
stable entry id. A page stops when the next head is unknown; Load More resumes
that frontier rather than re-sorting a partial client window. The mounted store
preserves the admitted aggregate row sequence. Existing Pinned, attention and
status bands (and board status columns) retain that field sequence inside each
band. A source failure leaves coverage visibly incomplete rather than claiming
exhaustion. The canonical Action response envelope governs retained pages.

GitHub configurations with all-repository security alerts offer no field sort:
the repository directory cannot supply a globally ordered native alert page.
Selected-repository configurations can merge their known native alert heads.
Named newest/oldest/Smart orders keep their existing traversal.

Mounted list body health follows the current view's source inventory and its
Source, Type and Scope selections. `projection/sourceHealth.ts` partitions the
whole scan using the selection from `ui/filters/plan.ts`; selected failures and
coverage drive the existing body states. Manage sources retains whole-scan
health. The shell exposes `outsideSourcesAttention` as one count and the
`manageSources` target for the status-line renderer, independently of body health.

## Attention arrivals (0.3 development source)

The optional finite `readAttention` source role is a feed capability, not another
scanner or persisted watch registry. Triage's SDK-adopted `attention` Background
Service joins active configured sources with admitted contributions and invokes
only sources declaring that role. Configuration and contribution changes are
pushed; a feed's next read follows its provider's explicit cadence or retry
instruction. Missing cadence or an unavailable source stops automatic reads
without resolving existing notices. Shutdown cancels and drains the reads.

GitHub binds this role to `triage/read-github-attention`. It uses the existing
authenticated GitHub request owner, conditional notifications requests
(`Last-Modified` / `If-Modified-Since`, including `304`), provider `Link` paging,
and `X-Poll-Interval`. After a completed walk, the next head request sends
`since` from the retained `Last-Modified`, converted to GitHub's ISO timestamp
format, so unchanged threads need no exact PR read. Continuations keep that
filter and the head response's watermark; a later page cannot advance it.
It does not invent a polling interval. Notifications use
GitHub's [classic-token notification API contract](https://docs.github.com/en/rest/activity/notifications);
fine-grained tokens and GitHub App tokens do not support that endpoint. Current
source-owned exact reads decide PR terminal state. Review requests create a
`decision` item; a later closed or merged PR resolves that same review item even
when GitHub changed the notification reason.

[`publishTriageAttentionV1`](../packages/triage-sources/src/observations/attention.ts)
owns the shared C1 envelope and stable identity: a domain-separated hash of the
complete entry reference plus attention reason. The invocation request id is
separate. Feed notices and verified assignment notices are sent by Triage and
open its exact `triage` detail route; a plugin page is always local to the
sending plugin, not an arbitrary cross-plugin destination.

Sentry's `issue-attention` webhook uses the host-owned
`sentry_hmac_sha256_v1` verifier with Account-endpoint routing. The registered
source handler accepts verified `issue` assignment/resolution envelopes, reads
the exact issue through the current configured source, and invokes Triage's
caller-bound `attention/publish-v1` Action. Triage reuses its configured-source
ownership admission and does not repeat the provider read. This source consumer
does not make real provider delivery available by itself: configuration of
Sentry's provider-issued signing secret remains a host credential-custody
prerequisite. Active assignment notices require the exact native user assignee
to match the authenticated `user.id` from the same configured origin's
`organizations/{id}/members/me/` read. An organization membership id, display
name, or team assignment is not that identity. This optional flow needs a
user-bound token with the [member lookup's required scope](https://docs.sentry.io/api/organizations/retrieve-an-organization-member/)
(`member:read` or a stronger member scope); a missing permission or identity
settles that delivery without publishing and can be recovered by reconnecting
with that credential and replaying the delivery. Existing source reads retain
their `org:read`/`event:read` and internal-integration-token support. A resolved
issue retires the stable notice without a viewer read, including after its
assignee is cleared. There is no Sentry assignment polling fallback.

Configured Sentry/PostHog Workflow Event observers remain their only error-alert
scanner, scheduler and checkpoint owner. Their existing save/acknowledgement and
automatic-investigation path calls the same publisher under the source plugin;
it does not register a second feed. These alerts already land in Inbox Updates.
The current scan projection does not publish a production-environment tag fact;
display labels are not evidence of a production tag.

The development Event notice identity previously included source-instance id
and issue fingerprint. New writes use the complete-reference/reason identity;
existing development notices are retained, not migrated or deleted. A retained
old notice can remain visible beside the next changed arrival and can be
dismissed normally. This is not a released-format migration guarantee.

## Package boundary

`@happier-dev/triage-protocol` retains its explicit V1 root, `/v1` and `/testing/v1` source-author entries in its [export map](../packages/triage-protocol/package.json). Hosted CI and Releases use the domain-versioned `/ci/v1` plus `/ci/testing/v1` and `/releases/v1` plus `/releases/testing/v1` pairs. Each domain retains an explicit wire epoch under the [SDK evolution doctrine](compatibility.md#sdk-protocol-evolution); package SemVer is independent. Do not add floating default/current/latest/legacy aliases. The package contains portable composable schemas, authoring values, source-neutral projections and conformance fixtures. Keep host registries/runtime, provider clients, credential materialization, HTTP, UI implementations and persistence outside it.

Schemas use the public SDK `/protocol` composition algebra and `/contributions` authoring seam. The [SDK feature-protocol dependency policy](../packages/plugin-sdk/src/featureProtocolPackagePolicy.test.ts) owns admissible public imports; do not import private `@happier-dev/protocol`, Zod, host internals or a source plugin, and do not handwrite a second JSON Schema/parser. Schema evolution follows [compatibility](compatibility.md#sdk-protocol-evolution).

In 0.3 development source, the minimal `TriageEntryRefV1Schema` and
`TriageEntryRefV1` live at Protocol's
[`tasks/entryRefV1`](../packages/protocol/src/tasks/entryRefV1.ts) subpath so core
consumers such as Discussion anchors need no dependency on the feature package.
The public SDK `/protocol` facade and Triage's existing V1 exports project the
same executable parser, JSON Schema and UTF-8/delimiter rules. This ownership
move preserves the closed source-qualified wire identity; configured execution
targets, mutable locators and source access remain feature-owned.

## Contributions and caller-bound administration

[`contribution.ts`](../packages/triage-protocol/src/v1/contribution.ts) declares `happier.triage/sources` V1 and the target-owned point, with at most one contribution per source plugin. It defines the required list/scan/get operations and detail surface plus optional PR-status/workspace and task roles. Operation roles reference ordinary source Actions; they are not implementation imports, convention-derived Action ids or a source-specific host registry.

The public [source conformance check](../packages/triage-protocol/src/testing/v1/conformance.ts) reads requiredness from those canonical declarations. An optional role may be omitted; when supplied, its binding must still satisfy the declared Action or surface contract. Conformance maintains no separate list of optional role names.

In 0.3 development, the optional `resolveResource` read role accepts the host's
typed resource intent and an exact configured source instance. It returns that
source's immutable local reference and current locator, or typed unavailable.
GitHub resolves the URL's repository through its existing credential and
repository reader before minting the numeric repository identity; neither the
target nor the host synthesizes identity from a repository slug. The target
then uses its ordinary exact-entry read and detail region without scanning the
list. The existing destination instance key restores Session details; the
plugin-owned app subpath restores app details.

The Account read Action `happier.triage/entries/resolve-resource-v1` owns this
resolution in 0.3 development source. Both the mounted resource surface and
agent, MCP and CLI callers submit `{ v: 1, resource }` using the host's canonical
resource intent. The Action walks active configured connections once through
their admitted optional `resolveResource` operations, stopping at the first
exact resolution. It returns the entry reference, source-instance reference and
locator, or `unavailable`; source configuration and credentials stay inside the
Account/source execution path. It neither scans the list nor requires a
mounted page. Matching Action declarations, Account runtime and UI runtime must
be reloaded together; this additive read introduces no persisted-state change.

GitHub PR, issue, Dependabot and code-scanning links offer these details in the
Session panel or PRs & Issues page. Actions run links use the existing native CI
run detail. Secret-scanning links have no native source detail and retain the
external fallback. A configured connection that cannot resolve a recognized
resource leaves an explicit **On GitHub** escape to the exact requested URL.
The core resource opener owns the Account preference and destination selection;
source resolution does not reinterpret that preference.

In 0.3 development source, `get` accepts the optional source-minted
`lastKnownLocator` for the exact entry. Without one, a source may use its own
identity codec to fetch the exact immutable provider resource, then validate the
returned repository and identity under the same credential before continuing
through its ordinary exact-get path. GitHub uses the numeric repository id to
read its current path, then validates the requested PR/issue identity. Denied,
mismatched or unresolvable identity stays typed `unresolved`. This permits no
guessed slug, configuration fallback, scan or new storage; the target never
parses a source identity or owns provider routing. A supplied malformed locator
is refused rather than silently replaced. The V1 schema is unchanged.

In current 0.3 development source, `listInstances` is a safe read on plugin,
UI, agent, MCP and CLI surfaces. All six bundled sources inherit that declaration;
automated callers invoke the source's ordinary discovery Action, then submit an
explicit `sources/administer-v1` intent. An empty placement list removes global
menu placement, not Action invocation. Discovery never creates a source and never
returns credential material; source administration retains its shared approval
default for Account writes.

Source settings supplies its discovery Action's `connectedAccountPurpose` to
the shared settings factory. Connect/Manage opens the host's existing purpose
setup for that qualified Action. Selecting an existing account or pool writes
the canonical purpose default; return and Refresh to discover candidates.
Creating a connection alone does not bind this purpose. Agents use the same
approval-controlled `connectedServices.purposes.default.set` Action with the
declaration machine, qualified discovery consumer/purpose, and exact target.
Discovery retains `use` authority and performs no selection write.

Current 0.3 development Sentry discovery fits its organization candidates against
the shared external Action response byte boundary. If the full result cannot fit,
it retains the largest fitting prefix and reports `incomplete` with
`sentry-instance-list-response-truncated`; it does not impose an organization
count ceiling or present the retained prefix as complete discovery. Existing
account-list and provider-walk incompleteness retain their original failure reason.

Account-only sources declare their Action inputs with the shared
`TriageSourceConnectedAccountInputsV1` schemas from the same protocol owner.
These preserve each role's fields while requiring a configured-account instance.
Conformance accepts the generic role schema or the canonical account-only and
credential-bearing specializations, not an independently authored variant.
Account-purpose declarations still have to address an exact credential selection
in every input arm. Native-capable sources use `TriageSourceCredentialInputsV1`
and declare the native-service selection path; this specialization excludes
Account-data authority while retaining both real credential arms.
Sources backed by the current authenticated Account's data also use the generic
schema, with its explicit Account-data binding. This binding carries no
Connected Account or native-service selector; its source reauthorizes the current
Account service on each invocation. The canonical binding-component owner keeps
all three authority arms distinct.

In 0.3 development source, finite Account-only source Actions share their
declarations and handlers between the plugin manifest and its Account artifact
(for example, [`linear/src/accountActions.ts`](../packages/plugins/linear/src/accountActions.ts)).
The artifact also registers the existing Connected Account authentication and
materialization owner. Admission chooses the host once; both hosts run that
same operation against the selected Account. This leaves the aggregate window,
search, detail and mutation result owners intact. Native credentials, review
workspaces and background delivery retain their daemon lifetimes. A source
declaration alone does not establish published or loaded app availability.

Bitbucket's ephemeral paging positions use the protocol's plain versioned
encoding. Invocation admission selects the configured source and credentials;
the source codecs retain API-origin, collection-route, page-geometry and scan-scope
admission. These positions grant no credential authority and need no signing key
or WebCrypto lifetime. Loaded source/auth artifacts still require runtime
validation before claiming phone availability.

[`sources/administer-v1`](../packages/triage-protocol/src/v1/sourceAdministration.ts) is the one caller-bound lifecycle mutation ABI: create, reconfigure, remove and reactivate. [`sources/read-configured-v1`](../packages/triage-protocol/src/v1/configuredInstances.ts) is its read half. An optional `source` names an admitted contribution address, never caller provenance. In 0.3 development, the target's [`callerSource.ts`](../packages/plugins/triage/src/actions/callerSource.ts) lets any same-Account reader select that address, including another installed plugin. Source-less plugin reads retain their own-source default; direct host UI, Voice, agent, MCP, CLI and API callers can read all admitted configured sources. Entry detail reads enforce admitted source/kind and configured-instance correspondence for every caller. Source administration retains host-stamped write provenance: plugin callers stay within their own source; host create requires an exact admitted source address, while lifecycle operations resolve the source from their stored instance and reject an inconsistent supplied address. Selecting a surface does not change plugin write provenance. In 0.3 development, administration `invalidCaller` results may carry the existing non-secret `TriageSourceFailureV1` carrier. The administration handler distinguishes unresolved caller admission from a selected-source mismatch; the configured-instance writer distinguishes draft-purpose mismatch from an instance not owned by the source. Source Settings retains this Code and reason plus the Action execution Request ID in its shared Details disclosure. Legacy refusals without details remain unclassified rather than claiming the source is no longer admitted.

Triage's [`administerConfiguredSourceInstance.ts`](../packages/plugins/triage/src/corpus/configuration/administerConfiguredSourceInstance.ts) owns configured-instance writes and the exact source-ownership comparison. [`readConfiguredSourceRows.ts`](../packages/plugins/triage/src/corpus/configuration/readConfiguredSourceRows.ts) supplies the shared active-row read and cursor handling. Discovery produces candidates, not automatic durable creation; mounted source Settings uses the administration Action rather than a direct Collection writer. The read ABI distinguishes complete from truncated results and refuses invalid caller authority at admission. An admitted finite read completes across source revocation; the next request admits independently. Open observations still close on revoke, and caller cancellation remains effective through response completion.

In 0.3 development, the aggregate list catalog returns each source's existing opaque Collection row address. Selected refreshes carry that address back to the configured-row owner, which reads just that row and checks its stable source id and active lifecycle; built-in Tasks still resolves through its static source owner. Refreshing K selected connections therefore reads K configured rows rather than K copies of the catalog.

The presentation/control allocation is derived from the actual shared source
and aggregate result constructors in
[`listSourceSchemas.ts`](../packages/triage-protocol/src/v1/listSourceSchemas.ts)
and [`listResultSchemas.ts`](../packages/triage-protocol/src/v1/listResultSchemas.ts),
using the canonical public Action response envelope. The aggregate keeps its
business inputs and provider-owned adjunct schemas private; only pure result
construction moves upstream so adding a projected field also changes its
allocation. The finite witness covers 56 rows, 32 lanes and their continuations,
with explicit provider-fact examples rather than provider collection quotas.
The 32-source value remains a catalog page and finite allocation witness; a
field-sorted acquisition includes every selected source in one aggregate read.
Selected membership, lane health and continuations have no competing count
quota beneath the host response envelope. Buffered field-sort pages use the
canonical source-page schema and remain under the real Action envelope,
alongside other provider-sized adjuncts. The finite allocation still reserves
opaque source cursor bytes.
The browser-safe maximal-value derivation has one owner in
[`maximumEncodedValue.ts`](../packages/triage-protocol/src/v1/maximumEncodedValue.ts);
the existing testing subpath re-exports it. Retained configured-instance fields
keep their 7,336-byte contract, and identity/native bounds remain unchanged.

Triage's built-in **Happier tasks** source is always part of that catalog and is
the default create target, including when no external source is connected.
Its immutable Account-data configuration lives in
[`internalTasks/configuration.ts`](../packages/plugins/triage/src/internalTasks/configuration.ts),
without a connection row or setup write. Older personal-source addresses remain
readable, but the catalog projects that inventory once. Connected external
sources remain explicit create choices. Task content continues through the
existing Account todo owner; generic host code makes no first-party exception.

In 0.3 development source, `tasks/create-v1` can carry an `originError` with
the complete source-qualified entry reference and its display pair. The source
creates the task once through its own HTTP adapter and write-settlement owner.
Only a confirmed `applied` result permits the subsequent relationship write.
The result retains that creation independently of `originErrorLink` (`linked`,
`failed` or `unknown`), alongside `sessionLink` when requested. An uncertain
create neither links nor retries, even if it includes an observation.

Triage's existing `user-marks` writer stores this user-selected origin privately
on the task's mark, without an index or provider-data mirror. Pin/unpin and fix-PR
changes preserve it; fix-PR choices remain pull-request-only. The registered
`tasks/read-origin-error-v1` and `tasks/set-origin-error-v1` Actions read, repair,
replace or remove that relationship by exact task reference. Recovery changes
only the link and never creates another task. Repeating unchanged intent emits
no row update; removing the last unpinned relationship removes its mark.

The error detail's **Make task** action opens the existing task draft with that
error as its origin and the selected linked Session, when present. Create uses
the same `tasks/create-v1` Action available to agents. A failed or unknown origin
write keeps the created task in the form with **Repair origin link**; repair
only calls the relationship Action. Saved task detail reads the persisted origin
and opens its exact error reference, including after a reload.

Uninstalling or disabling a source does not retire its configured instances. The
mounted list and Manage sources retain those active Account records, with the
list reporting that source as unavailable. The caller-scoped configured read
filters by currently admitted contributions, so its complete result may contain
fewer records than those Account-backed surfaces; that difference alone does
not establish stale mounted configuration.

In 0.3 development source, the durable `source-instances` Collection is v4. Its
binding admits credentialless current Account data; the preceding v3 also admitted
the reserved `happier/mcp-sign-in` Connected Account identity. The same migration
artifact carries v1/v2/v3 rows forward unchanged; the widening changes neither
existing configured-source identity nor private configuration. `session-links` and `user-marks` remain v2 because their
entry references do not embed that service schema. The canonical Availability
owner permits proven equal-version schema widenings as read-only access;
writes still require the exact current writer contract. The optional private
`originError` field widens `user-marks` v2 without rewriting retained rows.

The source plugin retains its private configuration-token encoding and provider-specific behavior. `configuration.token` is non-secret source-selection data, despite its name. Agents obtain the configured instance from `entries/read-detail-v1` and pass it unchanged into source Actions, including issue facts and pin/unpin. A `[REDACTED]` replacement is invalid configuration. Credentials are acquired separately through the admitted binding; keep configuration contents out of user-facing prose. Triage business behavior stays in `packages/plugins/triage`; shared host code stays source-neutral. Do not use this schema package as a new source service, credential store or corpus persistence owner.

Currentness readers that already possess a configured instance may pass it as
the read Action's optional `exact` witness. The target first resolves caller
authority, derives the existing private tuple tag through the Collection's
identity owner, then reads one row and checks its configured-instance id.
The built-in personal-task witness resolves to its immutable configuration without a stored row.
The caller compares the returned current configuration digest. This adds no
index, mapping, persisted witness or plaintext source identity. Settings reads
without that operand retain the existing caller-scoped inventory walk.

### Sentry and PostHog issue observations (0.3 development source)

Both native source plugins declare the strict `issue-transition` Event and use
the same finite Triage issue adapter. Their existing scan/client owners retain
credential selection, opaque pagination and native failure evidence. The public
SDK's daemon-only checkpointed observer owns assignment, invalidation, cadence
and admission safety; neither plugin adds a second timer or server poller.
Event setup states its default of 300 seconds (five minutes) and saves the
person's explicit period in sourceConfig. Provider retry deadlines can delay
the next check. Off, unconsumed and wrong-host sources perform no provider work.

Event authoring uses Administration's current source-custody choices as well as
portable installations. A machine-local source does not need a portable Account
release, but its descriptive Availability census alone grants no execution.
The existing daemon Event catalog binds the selected source origin to the actual
observer materialization from that same admitted runtime occurrence. Setup
invokes the declared Action with its current source custody; the saved trigger
keeps the existing watcher-materialization assignment. Reopening resolves that
assignment through the same current binding, never through a guessed source id.

The closed observation binding is sent only when a full-describe caller offers
`supportedEventObservationBindingVersions: [1]`; unoffered replies retain the
older Event shape. An older daemon can ignore that additive request field.
The [watcher binding owner](../apps/ui/sources/components/automations/editor/pluginEventAutomationObservationBinding.ts)
returns `event_observer_unavailable` with the original rejection reason,
`retryable` and a typed `remediation`. Plugin install, release/content, trust,
revocation, stale-source and portability failures point to Plugins settings;
an unsupported or invalid daemon or missing observer binding points to Machines.
Transient offline, Home, daemon or source-readiness failures offer Retry. These
are binding-result contracts; rendered watcher controls must consume the supplied
reason and remedy. Portable installation authoring retains its existing
admission. This correction adds no observer, polling loop or persisted format.

Per-issue Account Collection checkpoints record projected state and transition position,
not vendor payloads. Native last-seen time is evidence, not proof of a status
modification time: resolve/reopen at the same native time remains distinguishable.
An observed transition's `occurredAt` is its immutable first-observation time,
retained before admission as a pending candidate in the issue's private checkpoint. The effective
cursor remains unchanged until safe admission and notice commit; equal retries,
reloads and a CAS winner reuse the retained clock rather than refreshing it.
The pending candidate uses the existing ordinal for the latest distinct observed
snapshot, including a return to the effective baseline. Its phase is retained so
retries keep the same occurrence payload. Only the latest pending candidate is
stored; this is not a provider-history queue and cannot reconstruct unseen changes.
Each plugin declares the shared `TRIAGE_ISSUE_CHECKPOINT_COLLECTION_V1` contract.
Exact set queries read the scan's issue identities in protocol-sized pages;
pending and effective writes each batch changed rows within the Collection
owner's row and encoded-byte limits. An unchanged settled scan writes nothing.
Incomplete scans and absent rows never synthesize recovery. Initially resolved
issues establish a baseline without creating an Inbox item. Each issue uses the
same source-instance/fingerprint notice identity across transitions. The default
investigation mode is Inbox; explicit automatic mode uses the existing qualified
Triage configured-investigation handoff and native `alertEntry`, not a new
Session launcher. Only an actual admitted/rejoined Event for that exact occurrence
can permit an opening auto-start. A safely filtered or age-skipped Event may
commit notice facts and its cursor without launching an investigation; checkpoint
safety alone is not admission. Retained provider notices carry the bounded
`investigation: { kind: 'alertEntry', entry: { entryRef, sourceInstanceId } }`
operand on the same private C1 item. The Inbox data hook and notice drawer pass
that operand to the existing configured Triage Action, which re-admits the
native entry and current choices; the stored operand grants no Session, Agent,
placement or permission authority. This is development-source wiring. The
configured live Inbox-to-Triage handoff remains unverified.

The automatic path reads its configured investigation choice once for the
finite save phase. An unavailable choice, selection requirement, approval hold,
failed start or uncertain response adds a safe outcome to the same C1 notice;
exception text and opaque recovery facts are never copied into that notice.
A settled handoff failure does not prevent checkpointing. If the outcome-notice
write itself fails, ordinary checkpoint retry retains the same occurrence; replay of
the already-opened notice does not start another Session. This provides no
durable outcome-delivery guarantee or automatic recovery carrier. Manual
Investigate retains the configured handoff's existing create/send recovery.

### Operations failure investigation (0.3 development source)

`TriageFailureSubjectV1` extends the same configured Investigate handoff with
exact deployment receipt, managed Machine operation, backup operation, service,
Domain or Workflow Run addresses. The Account-scoped notice investigation owner accepts
these subjects too; `useInvestigateFailure(subject)` borrows that owner and its
existing uncertain-create/send recovery from `AccountNoticeInvestigationBoundary`.
The app shell mounts this small provider beside the Inbox summary, so receipts,
managed setup and other failure pages do not mount the Inbox model. Inbox consumes
the same owner. Mounting the provider issues no reads; surfaces rendering
configured agent-action buttons read their choices through its shared catalog
reader. Pages do not create investigators or select replacement Machines.
For receipts, Environment health and Domain attention, the handoff reads the
controller and accepted Source workspace from the exact receipt/current Environment
as evidence. The controller alone never becomes a fixed execution preference.
The shared action-placement owner applies the saved Profile's fixed/ask preference,
then the exact accepted Project or repository candidates, using the Project owner's
reachability fact. A valid non-SCM Project can identify its exact workspace without
a forge identity. An unresolved placement opens the seeded New Session composer
before `session.spawn_new`; no Session start or message is attempted.
The existing New Session preference owner projects its exact default Agent key
through `agents.backends.list.defaultTargetKey`; Triage consumes it. A complete
admitted placement and Agent can start directly. Investigate does not wait for
managed-service inventory or unrelated service establishment.

When Triage asks for placement, the Account investigation owner retains the
original configured Action and evidence across route unmounts. An explicit retry
resumes that handoff through Triage's placement owner without reading a
replacement catalog default. A Machine, workspace or Agent selection applies
to that same handoff. If no Machine is reachable, the existing chooser opens Create one in
the cloud on the failure's Home. The Machine Add page keeps that Create Home
separate from any retained connection task's admitted Home. Returning to the
failure still requires an explicit placement choice; acquisition does not start
an investigation. This development-source continuation awaits loaded-runtime
verification.

Workflow Run failures reach this same handoff from the invocation recovery card
in both Activity and Flow views. The Workflows owner declares its configurable
`workflows.investigate-run` action in the shared subject-action catalog. The
handoff reads the exact Run through `workflow.run.get` on its Home, retaining
only its identity, state, revision and timestamps as evidence. Its accepted
Machine and workspace reference supply placement; a person choosing another
Machine does not inherit the original Machine's workspace. Run output and logs
remain behind their existing read Actions.

Missing controllers, unreachable Machines, ambiguous/incomplete folder facts or
missing default Agents return `placement_choice_required` with `reason`,
`candidates: [{machine, workspace?, reachable}]` and `agents: [{targetKey,label}]`.
These are choices, never automatic failover. On the 0.3 UI, an unresolved new
Session opens the shared New Session composer with the subject reference and
any known Machine; that composer owns the remaining folder and Agent choices.
An unavailable composer returns an explicit `composerUnavailable` outcome.
Headless callers and existing Sessions retain the typed placement choice. A
caller supplying a workspace or Agent key uses the same placement and Agent owners.
A terminal Session creation refusal remains a refusal; it does not mark a Machine
unreachable or trigger a second start. A native ACP
transport that closes before startup completes retains the existing
`agent_startup_transport_failed` cause through the public ACP startup diagnostic,
host failure publication and Session creation without marking the controller offline. An arbitrary
`spawn_failed` or authorization refusal is not reclassified. Unknown
creation outcomes retain the existing same-key recovery and never offer a new start.

Other target refusals retain `unavailable: targetUnavailable` with optional typed
`detail: {reason, cause?}`. Each configured handoff exit identifies its own phase
(`action_references_unresolved`, `new_session_destination_refused`,
`session_start_refused`, or the corresponding entry/Review phase). `cause`, when
present, is the existing owner's structural status or refusal code, never an
exception message or diagnostic log. `useInvestigateFailure` preserves this detail
for the shared outcome UI, which prefers the typed cause in Details; older results
without it remain readable. A runtime reload refusal retains its launch code and
does not offer a replacement Agent as recovery. This diagnosis
does not turn authorization refusals or unknown creation outcomes into a new start.

The configured handoff reads the addressed owner and passes a structural subject
and exact read Action input as evidence. Health notices likewise carry their
Artifact identity and `artifact.get` input, without copying notice bodies, titles
or diagnostic logs into Session evidence. The existing host Action admission
continues to authorize the reads and Session effects. Provider `alertEntry`
operands continue through their native source owner.

Configured native Investigate sends also pass the admitted subject as an
`entryRef` and display through the existing Session-start link phase. The
internal source declares these non-Task kinds; its Task relationships retain
their native owner, while investigation links use the existing corpus Session
links. An exact native link read does not enumerate configured sources. Receipts
read that persisted link and demand only its latest linked Session through the
shared transcript consumer and completed-Turn result reader. Completion is
pushed; reopening does not depend on the handoff that started the Session.
Recovery still comes from the health owner, and proposal or applied rows require
their explicit owner results. Prior unlinked investigations are not backfilled.
Native health notices link their retained Artifact; they do not infer an old
receipt from a current deployment binding. A compose draft has not admitted a
Session and does not create a link.

The hooks are available to the surface composition lane; this does not certify
rendered native failure buttons. A failed backup needs its actual retained
operation address. The current backup status hook reports
`backup_status_read_missing`; no backup history store is invented here.

### GitHub security findings (0.3 development source)

GitHub contributes Dependabot and code-scanning findings as two declared kinds
on the existing `github-forge` source. Both use the existing `errorIssue`
workflow subject, status facts and source attention; neither is a task that
Happier can mark complete. Their kind-qualified references distinguish alert,
issue and pull-request numbers within the same immutable repository identity.

The private source token enables each alert family separately. Retained tokens
without these settings keep both families disabled. Alert discovery uses the
existing selected repositories or explicit All selection; it does not broaden
the scope from a credential's access. Repository alert streams include history,
follow native cursors beyond issue-search limits, and retain partial coverage
when one family cannot be read. Exact reads of retained links remain available
when discovery is disabled. No background alert poller or second source store
is introduced.

Partial scan evidence can carry the existing typed source failure beside its
readable observations. The source-health presenter shows that failure beside
the retained rows. GitHub preserves its permission code, required permissions and
provider request ID, when supplied, in the existing failure diagnostics;
an alert denial explains which family could not be read and asks the person to
reconnect with alert read access (classic tokens: `security_events`, or
`public_repo` for public repositories only), then refresh. See GitHub's
[repository alert permissions](https://docs.github.com/en/rest/dependabot/alerts#list-dependabot-alerts-for-a-repository).
This is an unreleased 0.3 result extension: matching development source
and host readers must be loaded together; no stored-data migration is needed.

Selected native detail, Locations, immutable-commit code and the current
Dependabot update PR are demand reads. Code permission is separate from alert
permission; unavailable code leaves native coordinates intact. Native
associations enter the existing fix-PR resolver alongside explicit choices and
Session co-links, without writing a user mark. The source's optional
`readFixPullRequests` operation supplies that association; the Account read
Action retains ranking, dismissal, coverage and exact selected-source context.
The existing exact fix-PR reader also supplies the detail frame's optional
`useTriageDetailFixPullRequestNavigation` binding. It opens that PR's own Triage
detail with its exact source instance, including when the PR is outside the
loaded list, or opens the admitted provider `webUrl`. The source controller
consumes this binding rather than reading the association again. Missing or
unavailable associations offer no navigation; changing the Account or selected
candidate retires the prior callbacks.

An exact `get` may supply source-neutral `dispatchEvidence` through the canonical
forge-evidence schema. This field is not part of scan observations or snapshots
and is not persisted in list rows. The composer resolver sends it through the
single Session input renderer used by the configured handoff, keeping advisory
and code text inside its escaped data block. This avoids treating projected
list facts as a complete advisory. Source text never chooses an Agent,
destination or permission policy.

In 0.3 development source, an attachment's authoritative unresolved read keeps
its source failure code and retryability in the existing `PluginError` envelope.
Typed invocation refusals pass through that same envelope. The host owns the
content-free diagnostic and its presentation; provider failure detail and
connection credentials are not copied into the attachment error message.

Native dismiss/reopen Actions use current credential and repository proof,
preflight and readback. Lost responses settle through a confirming read, never
automatic replay. Their present-user confirmation exemption retains the
ordinary automated approval default and explicit Actions policy. Fix consumes
the shared configured Session handoff; no security-specific launcher exists.
UI composition and loaded-provider validation are separate program integration
checks; these source contracts do not establish release availability.

### Release publication receipts (0.3 development source)

GitHub publication settles from its validated exact PATCH response (`draft: false`).
A follow-up GET is observation only: failure or an inconsistent draft observation
adds optional `observationWarning` using the existing source-failure shape to the
`confirmed` result, without replacing the PATCH release or changing settlement.
The release page presents this warning through the host notification owner while
retaining its normal published navigation. A refused PATCH stays rejected; a lost
or unvalidated PATCH receipt stays unknown and is never automatically replayed.
The closed Releases V1 schema, provider and UI readers reload together; older
strict development readers reject the new optional warning. No persistence,
wire epoch, gate or compatibility adapter is added.

### Shared source unit selection (0.3 development source)

A source can declare its natural scope unit through `descriptor.scopeUnit` and
bind the optional safe `listScopeUnits` role. The executable selection, unit,
input and result schemas live in
[`scopeSelection.ts`](../packages/triage-protocol/src/v1/scopeSelection.ts)
and are exported from the explicit V1 entrypoints. Selection is either All or
a non-empty set of source-native unit ids. Unit labels and secondary text are
presentation; an optional `collisionScope` is the source-authored join to its
entry identity. Consumers never derive that join from names or ids.

Snapshots can independently carry `scopeUnitId`, the source's native unit id
under the same `TriageSourceScopeUnitIdV1Schema` boundary as selection ids.
Filters join it to the selected unit's
id within the configured source. This is essential when issue identity is
site-, workspace- or organization-wide: Jira projects, Linear teams and Sentry
projects must not change entry collision identity to become filterable.

The aggregate list projects this configuration-only read into each configured
source summary before entries load. Source filters name the configured instance,
so two connections to one source remain separate choices. Scope filters combine
the selected units (or an All placeholder) with the unfiltered window's seen
units. Unit ids stay qualified by configured instance; an older entry without a
unit fact can match only an explicit source-authored collision-scope join.
These are display filters: materialization still scans every configured source.
The same lens schema carries instance and unit choices through routes, saved
views and list/mounted Actions. Retained contribution-wide source and
collision-scope lenses remain readable and removable.

The source keeps its token codec, authorization, provider paging and scan
behavior. The shared configuration envelope remains opaque. Available-mode
listing searches and pages the source's selectable units under its exact
credential binding. Partial pages retain readable units and a continuation or
failure; a failed read never becomes an empty complete page. Configuration-only
mode decodes the retained token and returns its selection and selected unit
metadata without materializing credentials or reading the provider. This lets
filters obtain configured units before entries load without a provider-specific
token parser. The listing input's `draft` requires only `v`, `binding`,
`localInstanceKey` and `configuration`; discovery-only `locator` and
`keyStability` are optional here. A full discovery draft remains accepted.
Consumers of retained configurations must not fabricate missing discovery facts.
New source token writers retain the selected units'
labels and known collision scopes; a legacy token can lack that identity fact.

Source Settings declares `scopeSelection` on the existing shared surface
factory. Its source-owned `readSelection` and `writeSelection` adapters translate
the token; the shared
[`editor`](../packages/triage-sources/src/settings/scopeSelectionEditor.tsx)
owns All/Selected, search, multiple selection, paging, counts and read states.
Retained selected editors seed unit labels through the same configuration-only
Action before provider discovery, preserving selected labels when access is lost
or a selected unit is absent from the first provider page.
Optional `DraftFields` keeps other source settings inside that editor's single
Save/Cancel flow. A source without this capability retains its existing editor.
No source id selects the control, so an independently installed plugin uses the
same contract.

UI, agent, MCP and CLI callers invoke the same ordinary listing Action, then
submit the chosen source-encoded draft to `sources/administer-v1`. Listing is a
safe read; configuration writes retain their existing approval default and
provider-silent lifecycle. The wire epoch remains V1, independently of package
version `0.0.0`. This is an unreleased 0.3 source contract, not a released SDK
rollback promise.

The mounted detail receives a launch projection admitted by the host's exact
`PluginUiLaunchInputV1Schema`, exposed through the public SDK `/ui` entry. When
necessary, Triage's existing detail-input owner keeps relationship counts and
editable-field summaries while omitting full relationship/workflow lists with
`projectionTruncated`. The source's live detail read retains the full content.
Linked Sessions use a prefix with `linkedSessionsHasMore` when the launch cannot
carry the whole Collection page; the common header retains the complete read
page. Identity, selected instance, locator and observation stamps stay exact.

### Task sources (0.3 development source)

Creation accepts optional `initialStatusId`, selected from the place's
`taskCapabilities.initialStatuses` catalog (`id`, `label`, `state`). A source
may mark the entry used when `initialStatusId` is omitted with `isDefault: true`.
An absent marker leaves that default unknown to the caller; it does not change
creation. Omission retains the source's default. This is an additive, closed, unpublished V1
contract requiring matching development source; an effect-bearing choice must
be applied or refused, never ignored. The source owns valid ids and the create
write. Personal tasks use the existing Todo create/transition semantics and
atomic task/index writer, including completed or canceled creation; no second
transition Action runs after creation. GitHub, Linear and Jira currently omit
this catalog and refuse explicit initial status before provider access.

The same contribution protocol declares optional `create`, `edit` and
`transition` roles for task kinds. They bind ordinary source Actions with closed
inputs and outcomes and a remote-write approval default. A source declares its
editable fields and native transitions through the existing kind descriptor;
live entry facts may refine a dynamic workflow. Read-only sources omit these
roles and remain admissible. The executable layouts and public exports live in
[`tasks.ts`](../packages/triage-protocol/src/v1/tasks.ts), rather than a second
SDK or host Tasks API.

Triage registers the platform's `work-items` client contribution for Work Boards.
Its live reader derives stable item ids from the complete entry reference and
uses the existing configured-source, exact-read and Session-relation owners for
title, category, parent and Home-qualified linked Sessions. Demanded relation
changes invalidate the read through those owners; leaving the Board retires
the observation. There is no task mirror. The named Account Action
`work-items/transition-v1` resolves the current item and invokes the existing
`tasks/transition-v1` Action. Read-only items offer no
transition, and transitions requiring additional form fields remain on their
existing task detail flow. Board grouping and linked-Session collapse remain
owned by the host's Work Board model.

Native transitions can declare required text, number, single-choice or
multiple-choice inputs. Their descriptors and gathered values use the closed
transition schemas in the same package; native field and option ids remain
source-owned. Jira discovers these requirements from its transition metadata
and revalidates them at execution before one provider write. A requirement the
shared form cannot represent remains visible with source-open recovery.
Sources must apply supplied transition values or refuse them; accepting and
silently dropping an effect-bearing value is not supported.

The source owns authorization, provider validation and confirming reads. Its
native Action and contribution role share the same implementation. Triage's
`tasks/list-v1`, `tasks/create-v1`, `tasks/edit-v1`, `tasks/transition-v1` and
`tasks/link-v1` Actions consume the existing configured-source, list and link
owners. They dispatch through the exact admitted role; they do not retry an
uncertain write. Sources reuse
[`writeSettlement.ts`](../packages/triage-sources/src/invocation/writeSettlement.ts)
when their provider contract requires at-most-once confirmation. Task body
inputs preserve multiline document text; row-display strings retain their
existing single-line projection rules.

For task editing, the existing exact `get` result can return optional
`taskFields`, using the same closed field vocabulary as edit inputs. Each
included value is complete; an omitted value means unavailable. These values
stay local to the edit read and never enter scan results, snapshots or the
retained list projection. The generic detail form loads them before editing,
offers only fields declared in `taskCapabilities.editFields` whose current
values were returned, and submits only changes through `tasks/edit-v1`.
Snapshot `projectionTruncated` describes display completeness and does not
disable an unrelated complete field. Sources without full values remain
readable and show the edit-read failure rather than seeding an empty field.
The mounted detail consumes these fields from its opening `entries/reobserve-v1`
read, including after a completed write or deliberate refresh; the task form
does not invoke the source `get` again on mount or after that callback.

An exact `get` may also return optional source-owned `detailData`. Triage carries
it through that same opening result into the embedded detail input, without
persisting it in observations, snapshots or list rows. The source validates its
inner presentation shape. GitHub issues use it for the full Overview and
repository capabilities already read by `get`; tabs and header facts consume
that result instead of fetching the same issue and repository again. Each open
still reads afresh, and deliberate refresh and completed writes start fresh reads.
Embedded typed detail data is governed by its declared role and containing
transport, rather than the 8 KiB navigation `openSurface` launch-input limit.

The mounted task commit shares pending, outcome and recovery state by entry
through the existing Account/plugin/generation ephemeral scope. Row glyphs,
Status cells and details consume that one operation; another task's write does
not invalidate their subscriptions. `tasks/check-write-v1` is a safe client
Action on UI, agent, MCP and CLI surfaces. It calls the existing
`entries/reobserve-v1` owner once, without replaying the mutation. Edit recovery
explicitly requests complete `taskFields` outside the list projection and
compares the requested values. Transition recovery needs matching native state;
a state-only answer cannot confirm additional required native field values.
Unavailable, mismatched and incomplete reads retain uncertainty and source-open
recovery. In 0.3 development, a fresh edit read with differing values keeps the
unknown-outcome notice but supplies the baseline for a new deliberate field edit,
including after a detail remount. The submitted text form closes so reopening it
starts from those fresh values. Only fields returned by that read remain editable;
the old mutation is never replayed. Transition uncertainty still needs native proof.
A lost create response without a known task identity stays held;
the existing scoped draft id preserves the hold across pane remounts. There is
no retry-create control or automatic write retry.

Message-to-task drafts retain the admitted message and Session context in the
same ephemeral handoff as their text; navigation carries only the draft id.
Explicit body text wins over quotation. The Session's accepted repository is
suggestion data, never implicit source or workspace authority. Optional create
linking delegates to the incumbent `sessions/link-entry-v1` relationship Action
only after confirmed creation (`tasks/link-v1` remains its public task alias). The
aggregate reports the create and link phases separately, so a failed or unknown
link never becomes a failed creation or authorizes another create. The created
detail retains that partial outcome independently of task-status recovery;
the existing detail relationship read can resolve it by confirming the exact
origin Session link.

Task create, edit and transition controls follow the selected source's declared
roles, configured instance and host execution readiness. An age-stale list or an
unrelated unavailable source does not disable a ready task's controls. Pending
or unavailable execution follows the selected source's admitted Action. The
current authored aggregate and personal-source Actions select the shared Account
runtime described below; their portable loaded-client validation remains pending.
An external source's admitted operation retains its own execution placement and
may require a Machine. Account-data ownership alone does not select that
placement. The source Action retains authorization and confirming-read authority.

In 0.3 development source, GitHub HTTP reads select placement at the plugin's
[read Action owner](../packages/plugins/scm-github/src/triage/readActions.ts).
Discovery, repository selection, search/scan, exact get, attention and HTTP detail
reads run in the invoking Account host for an Account-custodied connection,
including a previously imported GitHub CLI credential. No online Machine is
needed for those reads. A machine-native `gh` source selects the separate daemon
role and reports `plugin_action_machine_required` when no Machine is available.
Source settings discovery and Refresh wait for the invoking requester, then
dispatch through that same Action owner; Machine readiness cannot preempt it.
Workspace preparation and Session relationship roles retain their native owners.
The shared `prepareReviewWorkspace` role admits both plugin calls and the mounted
UI press used by prepared New Session authoring. It retains `writesLocal`
approval policy and the selected Machine; mounted callers keep UI authority.
Final workspace verification remains plugin-only.
Authentication/import and provider writes retain their existing placement and
approval contracts. This placement change does not authorize a fallback from a
failed Account credential to a machine's login.

The Account artifact registers the same GitHub credential materializer used by
the daemon. The existing Connected Account owner opens the selected credential
through the Account's plain or E2EE envelope path and supplies HTTP headers
privately. Reads use the host HTTP service; GitHub's existing API client still
owns rate parking. GitHub permits browser REST requests through its
[CORS contract](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests).
Loaded Machine-less acceptance and credential security review remain separate
validation obligations.

Task category is derived by the single public `triageTaskStatusCategoryV1`
mapper from the existing entry state, including its optional active stage and
terminal completion reason. Unknown or unclassified suppressed states remain
unclassified. Agent activity and waiting are still derived from linked Sessions.
Optional parent, children summary and blocked-by facts use the existing complete
entry reference. External sources materialize these relationships live; the
contract adds no provider mirror, task store or relationship writer.
In the development [relation schema](../packages/triage-protocol/src/v1/observations.ts),
child entries may additionally carry a bounded title and an exact locator from
the same relation read. These presentation fields do not expand canonical entry
identity; parent and blocker references retain their existing shape.

Optional snapshot `dueDate` retains a source's ISO calendar date or datetime;
personal tasks project their existing deadline as an ISO datetime. Optional
`completedAtMs` is the source's completion time, never its general update time.
Absent facts remain unknown. The Tasks row projection exposes both and accepts
an explicit `completedSinceMs` calendar boundary for a recently completed band;
entries without completion evidence cannot claim membership in that band.
The Tasks lens supplies the local Monday boundary to the existing
`tasks/list-v1` Action as `tasks.completedSinceMs`. The same scan/window owner
requests `completed: { kindIds, sinceMs }` for task kinds whose declaration
advertises `taskCapabilities.completedScan: true`
on initial and continuation pages. This selects current completed membership;
it is not an update watermark. Ordinary PRs & Issues scans omit the selection.
GitHub extends its existing involvement queries with recently closed issues
and projects `closed_at`; Linear filters `completedAt`, and Jira filters the
native resolved date. Personal tasks read the existing Account list and its
completion timestamps. Sources keep their scope, involvement, paging, failure
and coverage owners. Changing the calendar boundary restarts the mounted walk
through the existing coordinator. No completion timer, cache or store is added.

This is an in-place change to the unreleased V1 development contract (package
version `0.0.0`). The scan envelope and nested completion selection remain
closed. Omitted `completedScan` leaves the ordinary source read available but
keeps completion coverage partial; the aggregate never sends the selector to
that kind or reports a complete empty completion window. The list Action and
mounted projection use the same completion-membership predicate as pinned task
rows. Omission of a completion timestamp remains unknown, never evidence of no
completed work.

A source can explicitly declare `taskCapabilities.completingTransitionId` to name
an offered native completed transition for one-step completion. The personal
Happier source opts in. External tracker sources omit it so their row glyph opens
the native status menu, even when only one offered transition completes the task.
The existing transition role and approval policy own the write. Runtime entry capabilities
replace the kind declaration, and an unoffered or non-completing id supplies no
quick completion. Mine includes source-declared assignee or author involvement;
mentions, subscriptions and participation alone do not qualify. Everyone and
Agents retain their existing task-kind and linked-Session meanings.

Sources whose own domain record owns task-to-Session relationships may bind the
optional `linkSession` and `readSessionLinks` roles. Both use the exact admitted
configured instance and source-local entry reference. Reversible Session links
default to Direct in the source Action declaration; an explicit Ask preference
still applies. GitHub delegates links to Channels, whose plain PR attach and
unlink operands use the same Direct default across UI, CLI, agent and MCP.
Branch-hint Link and Create PR's automatic link call that same Channels Action.
Origin, Session admission and authorization checks remain in force; this default
only removes the confirmation prompt. The read role returns complete current-Account,
current-Home relationships or an explicit source failure. An omitted role leaves
external-entry links with Triage's existing relationship owner. These roles add
no second link store or credential authority. Their closed executable inputs and
results live in
[`sessionLinks.ts`](../packages/triage-protocol/src/v1/sessionLinks.ts).

In 0.3 development source, Session attachment dispatch records a resolved entry's
relationship through `createTriageSourceSessionRelations(...).write`, the same
owner direct starts use. This covers mounted Ask/Fix and host New Session seeds;
the host's Session identity and the exact attached source instance travel to
that owner. Replayed dispatches retain the existing relationship. Execution Run
attachments have no Session identity and do not create Session links.

In 0.3 development source, GitHub's `readSessionLinks` consumes the same
Account/native placement owner as scan and get. Account credentials read
Channels relationships through its portable `session-pull-request-relations-v1`
Action, using the same retained-row selector as the daemon binding Action;
native `gh` reads and link mutations retain their daemon placement. Opening an
entry therefore needs no online Machine for Account-custodied sources. A failed
relationship read remains a typed read failure, with its code and Request ID
available in detail, rather than reporting that the source connection was removed.
The retained relationship belongs to the Account and exact repository/PR identity,
independently of the credential or Machine used to establish its connection. Reading
the same PR through another configured GitHub profile therefore retains reciprocal
Session navigation. Same-Account relationship reads need no native caller origin;
native attach retains its origin requirement for execution routing. The Session panel keeps readable links beside per-source
warnings and exposes diagnostic codes and Request IDs in Details. A setup refusal
that invoked no source Action uses the host read's existing Action request identity;
an invoked source failure retains its original request identity. Account Action
contexts expose the originating host-issued identity as optional `requestId`,
without granting authority or changing the independent `invocationId`. The
canonical `TriageSourceFailureV1` carries that optional identity at its producer,
including failures embedded in a healthy cold-opening result. Strict native
read schemas preserve it; the shared read-failure disclosure shows Code, Reason
and Request ID. A mounted read may also retain its existing issued envelope ID
in successful execution metadata when the provider returned a typed failure.
Neither projection creates an identity when no request was issued.

### Error-source writes (0.3 development source)

Sentry's [native write Actions](../packages/plugins/sentry/src/source/writeOperations.ts)
resolve, archive forever, or assign one issue. They use the existing exact-account
HTTP client, refuse a merge observed during preflight, and confirm the requested
status/substatus or assignee identity through a fresh issue read. PostHog's
[source operations](../packages/plugins/posthog/src/source/operations.ts) resolve,
assign, suppress, or unsuppress one issue through its configured Team route; assignment uses the
provider's separate assignment endpoint. Its confirming read uses authoritative
CRUD metadata rather than query-window enrichment.

The development-source assignee controls use the shared Plugin UI `PropertyList`
choice picker. Sentry's exact issue reader supplies project members and teams;
PostHog's exact overview supplies organization members and roles only when the
assignment panel requests them. People are searched by their readable names and
chosen from those source facts; native ids stay inside the existing assignment
Action input. Unassigned clears through that same Action. Missing current
assignment facts never become an assumed Unassigned value. The property shares
the source-write group's approval, settlement notice and uncertain-outcome hold
with the issue's other writes.
Directory reads need Sentry `project:read`, or PostHog `organization_member:read`
for members and `organization:read` for roles. A missing directory permission
does not prevent the ordinary issue overview from being read.

These Actions declare remote writes and confirmation metadata, retaining the
shared Action policy's approval default on UI, agent, MCP and CLI surfaces.
Read-only credentials remain usable for reads; writes need Sentry `event:write`
or PostHog `error_tracking:write`. Both sources use the shared settlement owner
above, dispatch once, and report uncertainty when a fresh read cannot establish
the desired result. A lost response never causes automatic replay. PostHog has
no generic Ignore Action: its published writer rejects `archived`, and
`suppressed` is not substituted. The separate Suppress issue Action warns that
PostHog will drop future events for this issue; Unsuppress returns it to `active`
for future events, without recovering events already dropped. Both use the same
approval-by-default policy, configurable in Settings → Actions. Real-tenant write validation remains a release
check; these development-source handlers do not establish released availability.

### Personal Happier tasks (0.3 development source)

The built-in source is called **Happier tasks** in the list, detail and draft.
Its reversible Account-data Actions use the direct approval default, as do the
aggregate task relays; the selected source Action owns the effect and its
approval default. Outward source writes retain Ask, and explicit user Action
preferences still apply. No task setup is needed. PRs & Issues decides first
run from its external sources; an empty Tasks inventory offers New task.
The PRs & Issues Collection excludes built-in personal tasks, including pins;
Tasks retains them. The neutral corpus and Composer picker remain shared.

The source snapshot's optional `assigneeLabel` is presentation only: `null`
means the source confirmed no assignee, while omission means unknown. The
Everyone lens consumes that fact for Owner rather than inferring ownership
from authorship or source-specific fact ids. Older sources may omit it, and
older snapshot readers safely drop the optional field under the existing
additive-open/drop V1 contract. No stored task format changes.

For Happier tasks, an explicit assignment wins; otherwise the source projects
the recorded creator, falling back to the owning Account for earlier records.
List, detail and write observations use that same assignment. An Account owner's
display comes from the admitted `ownerDisplayName`; an unavailable name stays
unknown rather than displaying its raw Account id. The exact editable values
retain the assignee identity. Personal task item labels remain stored string
names. In 0.3 development, the authenticated Account's separate
`task-label-colours.v1` KV catalog stores `{v: 1, colors: { [name]: colorToken }}`
through the same Account-mode envelope owner. It stays outside `todo.*`, so
released item/order readers cannot mistake it for a task. No item rewrite or
second colour writer is needed.

`tasks.internal.labels.setColor` and `tasks.internal.labels.clearColor` change
that catalog with the existing KV CAS behavior. In 0.3 development, the label editor
refreshes on an applied result. Shared Plugin UI `PropertyList` commit handling keeps
refusal and unknown-outcome feedback beside the property, catches rejected promises,
and asks the person to refresh before trying again; it never retries a write.
Inputs carry the captured
`scope`, exact label `name`, and (for set) a `colorToken`: `secondaryText`,
`accent`, `info`, `success`, `warning`, or `danger`. A missing entry projects
`secondaryText`; hex values are rejected. The token is a stored id, not a theme
role: `accent` is the label people pick as Blue and `info` the one they pick as
Purple, drawn in the host's projected `theme.colors.blue`/`theme.colors.purple`
(its `accent.blue`/`accent.purple` hues), never the control accent or info tone. One catalog read joins each task-list
read, irrespective of the row count. Host results carry `labelCatalog` and
per-task `labelColors`; the source exposes optional sibling `snapshot.labelColors`
beside string-valued `snapshot.labels` for list, board and detail. These
observations are process-local/wire projections, never Collection values.

The built-in `internal` source in `happier.triage` reads personal and explicitly
shared tasks through the task-resource owner. Content remains in each owner's
existing `todo.<id>` row; `todo.index` stays private to that owner. Its configured
binding uses `source: 'accountData'`; it has no Connected Account or machine
login. The target is always available; older explicit setup addresses still
resolve to that same Account inventory.
The plugin invokes the public `tasks.internal.*` host Actions rather than
reading plugin-namespaced KV or copying tasks into a Collection. The Protocol
[todo owner](../packages/protocol/src/todos/todoSessionLinkV1.ts) owns additive
fields, completion projection, and Session-link CAS; its
[Action operations](../packages/protocol/src/todos/todoActionOperationsV1.ts)
preserve the existing personal index ordering. Both authenticated transports enforce the
Account encryption mode. Earlier records without task refinements, including
bare Session-key links, remain readable.

Task writes do not list the inventory to discover scope. The authenticated host
supplies omitted Task scope and creation attribution; explicit UI scope echoes
are still checked, and applied write snapshots carry that captured scope. Session
links default omitted Home/Account qualifiers at the existing authenticated
Session-link owner while retaining explicit qualified Session identities.
Full parent/blocker references normalize once at the Task mutation owner; stored
parent ids and owner-relative blocker semantics are unchanged. These are 0.3
development Action contracts, not a change to the stored Todo format.

Task read snapshots and grant rosters expose optional nullable
`ownerDisplayName` from the neutral public Account display projection. The
existing authorized Task read joins that owner's Account; no separate profile
request or stored Todo attribution supplies the label. Missing names retain a
generic presentation and never fall back to an Account id.

Each Task grant may include `readiness`: `readyCount`, `pendingCount`, and
`unavailableCounts` for `plain_account`, `encryption_setup_required`, and
`encryption_inconsistent`. These are recipient-key facts from the existing
census/envelope owners, not another grant check or a guarantee that encrypted
content is valid. One grants read captures live membership and one recipient
batch, without per-grantee requests. Counts exclude the implicit task owner,
as key preparation does. Plain tasks need no client keys; mixed Team/Group
audiences preserve every reason. All-zero counts mean no effective non-owner
recipients, not that an inactive grantee can read the task. Older responses
without these facts are unknown, not ready. These facts describe the captured roster read, not a live
observer; the host share sheet owns their presentation.

Shared identities qualify the task id by its owner Account, so equal ids owned
by different people remain distinct. Personal aliases continue to resolve only
within the current Account. Exact detail uses the authorized task read rather
than scanning an inventory for the addressed task. Its child relations use one
additional existing task-list read and the same owner-qualified parent join as
the list scan, with no per-child reads. A failed relation read or an unreadable
task from that owner leaves child membership unknown, not confirmed empty.

In 0.3 development, a Board surface load reads the Task list once, sharing that
admitted result across Session-set discovery, visible-item resolution and the
built-in source roles. The task source projects observations, inverse children
and Session links from that result. A refresh creates a new surface context and
reads again, so later changes remain visible. An exact Task detail reads its
address plus one shared list for inverse children; unavailable children leave
membership unknown. Relations remain in encrypted Task content, with no
server-visible relation metadata. External sources continue through their
declared operations; Session-set discovery invokes each admitted source once.

Explicit Account, Team and Group grants use the
existing resource-access evaluator; Project/Home context may prefill a picker
but creates no inherited audience. View access does not expose edit controls,
and revocation denies the next server read or write. E2EE sharing and old-client
refusals follow the [encryption contract](encryption.md#shared-internal-tasks-03-development-integration).
The shared task-list client reports an unopenable row in `unavailableTasks`
without failing other readable rows. This includes malformed Plain content and
unreadable E2EE content; Account/currentness withdrawal still refuses the invocation.

Personal task blockers stay in that same Todo record. `blockedBy` retains
personal task ids and accepts complete source-qualified `TriageEntryRefV1`
values for external blockers; equal provider ids from different sources or
collision scopes remain distinct. The source adapter expands stored personal
ids relative to the stored task's owner when projecting relations and editable fields, and preserves external
references unchanged. Fresh writes validate both identity envelopes strictly;
stored-data readers drop unknown fields while rejecting malformed known fields.
This is a 0.3 development extension, with no separate relation store or
requirement for a predecessor binary to read new task refinements.

The current authored Action map selects the `triage-account-runtime` Account
artifact for aggregate reads, exact detail, task writes and built-in source
roles; `accountRuntime.ts` projects that same map through `activateAccount`.
Their Account data owner is unchanged. Portable Account Resource support and
its loaded-client routing are being integrated in development source; package
and loaded-runtime checks remain pending. This source placement is not a claim
that no-Machine Triage is already available in an installed build. A source's
own native operation may still require its admitted Machine. Detail retains
authoritative Session links when optional Session summary presentation is
unavailable. Task reordering continues through the existing
`tasks.internal.reorder` host Account Action and index CAS owner. The 0.3
development Tasks page reaches that same owner through the shared entity drag
and drop controls and staged Move (row menu, Alt+M or Shift+F10; Space remains
Peek). Only unfinished personal tasks within the same displayed group can move.
The page rereads the canonical order after settlement; external entries retain
their source order, and refused moves retain a reason. There is no separate
Tasks order store.

Internal task links live only in `todo.<id>.linkedSessions`. The optional
`linkSession` and `readSessionLinks` source roles let the existing entry Session
orchestrator and linked-work readers reach that owner through admitted handles.
External entries normally use the existing `session-links` v2 owner. A source
with partly unreadable task content returns readable Session links with an
explicit partial result and canonical unavailable local references; one keyless,
key-pending or malformed task does not hide other tasks' links.
A source can declare `descriptor.sessionRelations.kindIds` as a nonempty, unique subset
of its declared kinds. Its paired `linkSession` and `readSessionLinks` roles then
own only those kinds. Omitting the subset retains legacy ownership of all that
source's kinds when either relation role is declared. An explicit declaration
still owns its kinds when executable handles are unavailable; a missing or
failed role never grants the corpus permission to read or write them. The
[source-neutral relation dispatcher](../packages/plugins/triage/src/sessions/sourceSessionRelations.ts)
owns this decision for link/unlink, detail, the Session cockpit, configured Fix,
manual attachments, fix-PR discovery and successor reconciliation. A successful
exact admitted source write precedes deletion of its old corpus duplicate;
failed or uncertain writes leave the duplicate intact. Source-owned successor
moves currently return unsupported without deleting the old relationship.
Non-owned successors retain the corpus's existing conditional in-place move.

Explicit link/unlink Actions surface the dispatcher's typed failure through the
standard Action error channel, including missing source roles, ambiguous configured
instances (`sessionLinksSourceInstanceRequired`) and unapplied source or corpus writes.
Supply `sourceInstanceId` when several configured instances own the same source.
Existing typed provider or Collection refusals retain their original code and retryability.
The start-Session flow keeps its existing `linkPending` continuation for an unapplied
relationship; it does not report a successful link or repeat Session creation.

Unscoped Session reads compose disjoint source-role and corpus kind slices.
One existing Session-indexed corpus selection checks retained coverage even
when all admitted kinds are source-owned; it never exposes owned-kind fallback.
Coverage is keyed by source, configured instance and kind, so an unavailable PR
role does not hide healthy Issue or Alert links from the same source. An
out-of-scope role row invalidates that slice. Known lanes carry `kindIds`; a
missing descriptor retains a source-wide diagnostic without asserting kind
coverage. Prior source-wide replies are read as incomplete rather than guessing
ownership from their rows. Healthy slices remain readable in a partial result,
and incomplete coverage never becomes complete empty state. Role-produced links
retain the admitted instance, its existing configuration revision, private exact
configuration-row address and an optional source locator; consumers do not
reconstruct native identity from display text. PR status admission reads that
exact row afresh, checking its stable instance UUID, lifecycle and source ownership.
Each refresh reads one configuration row independently of unrelated configured
sources; it retains no authorization or configuration cache.
An explicitly complete empty result with no lanes is valid only when both source
inventories are empty and the exact Session's readable corpus query proves no
retained relationships. Missing legacy lanes, unknown retained rows, unreadable
corpus data and unfinished cursors do not establish that absence.
The Session cockpit and picker consume the shared `session-links-v1` Resource,
whose read delegates to that same Action. Its typed projection keeps last-known
links only for failed source/instance/kind slices, alongside current failure
coverage, or for the exact unavailable entry references in a partial slice.
Other readable entries still update and confirmed omissions are removed. A
complete slice replaces its previous answer, including an empty
answer; source-scope removal and Account, Session or executable custody
retirement clear the corresponding baseline. Retention is shared by the cockpit
and picker, rather than held in either consumer. Its observation watches the exact
selected corpus relationship query, configured-source membership and admitted
source roles with registered read observers. A snapshot-only source role keeps
its existing manual-refresh behavior; it gains neither a polling loop nor a
substitute corpus relationship. Disposing the Resource retires those observers.

PR kinds whose source declares native Session relations are read and written only
through that source; no released build stored such links in the Triage Collection,
so there is no upgrade pass. The inspected 0.2 predecessor has no persisted PR-link
writer; its existing task `linkedSessions` records remain at their todo owner.

The existing Channels `session-pull-request-binding-v1` Action accepts an
exclusive URL attach input in development source:
`{kind:'attach',sessionId,pullRequestUrl}`. The detected PR card passes its
snapshot URL unchanged. The binding owner shares GitHub's conversation URL
parser and accepts only a GitHub PR, then requests
`session.status.get({sessionId,includeAcceptedWorkspace:true})`. Both URL and
structured attaches require the exact Session's admitted checkout repository to
match before provider setup or binding writes. Missing/private/ambiguous
checkout facts refuse attachment. The provider resolves the exact PR before
the existing binding writer commits the link; this path never creates a PR or
invokes `openOrReuse`. Loaded runtime validation remains separate from source
composition checks.

The developing GitHub PR adapter uses that same Action with an explicit exact
`credentialRef` (`null` means the admitted machine-native GitHub service),
and `expectedRepositoryId`. Channels checks immutable repository correspondence
before binding creation and preserves the existing relationship clock and Watch
on rejoin. The source descriptor claims only GitHub's `pull-request` kind;
Issues and security findings retain their existing relationship owner.
Its `readRelations` arm reads canonical connection/binding rows by exact
credential and optional immutable PR/Session identity, without contacting
GitHub; native reads additionally require the source caller's host-stamped
placement. The retained connection's transport Machine does not scope this
Account relationship read; rejoin preserves that transport placement while the
source may execute on another Machine. `unlink` revokes the exact retained binding
and its scoped triggers
through the existing binding deletion owner. A successful explicit native link
is acknowledged by that writer, without a mandatory follow-up read. The retained
upgrade described above proves existing duplicates only: it does not call this
link writer or change its normal Action approval policy. There is no timestamp
import operand or second relationship store.

The same binding Action declares only `list` and `readRelations` read-only and
observes their selected native Collection membership and connection dependencies.
The GitHub source forwards its admitted relationship observation through the
ordinary contributed-Action observer with the same native placement precondition
as its read, preserving the host callback's retirement capability. Its admitted
credential lifetime and native link/unlink changes remain observable; metadata
resync alone does not publish a PR change. Disposal retires both subscriptions.
Write arms retain their existing approval floor. No polling or snapshot fallback
replaces an unavailable native observer.

The developing Session PR controls consume that shared status/Watch binding,
not another GitHub read. A proven open/link success may offer the Account default
mode (Notify); only an explicit choice configures the exact binding revision.
Changing the default does not escalate a retained binding.
Watch always stops when the PR is merged or closed. Its merge option only
controls whether the Session is also archived once idle with nothing awaiting
the person. The former `stopWhenMerged` setting had no effect on Watch
admission and is no longer offered or written. Existing stored bindings and
Account settings remain readable; the retired field is ignored.

In 0.3 development, an existing-Session configured PR Fix keeps Triage's source
preparation, linking and retry custody, but delegates its final send to Channels'
`deliverConfiguredFix` Watch arm. The request carries the reviewed
`expectedHeadSha` and the canonical prepared Session attachments, not a guessed
head ref/repository. Channels checks the native head and owns send/start
accounting; held or uncertain results never fall back to an ordinary Triage send.
The host's immediate-caller attachment rule preserves Triage's declaring-plugin
identity without changing the Channels sender or accepting caller qualification.

The local-reproduction
control opens the existing GitHub local form with the Session's admitted source
checkout and only already-proven workflow/SHA hints. Unmapped or non-CI feedback
does not fabricate a YAML job id, and opening the form grants no fixing rounds,
starts no process and does not answer a question. Visual mounting and the complete
continuation journey remain integration work.

Legacy `/zen` links redirect to Tasks and keep the selected task identity. The
Zen-specific draft/start/link route is retired; Start/Send uses the ordinary
entry attachment and Session orchestrator.

The Jira source in 0.3 development uses the public Connected Accounts manual
authentication lifecycle for one Jira Cloud site, account email and an unscoped
personal API token. The host stores credentials; the source materializes them
only for that exact site. One configured source covers the site, with All or a
non-empty selected project set inside its private configuration. Historical
per-project configurations remain readable and retain their instance keys when
edited. The shared settings owner lists projects; source-native fields preserve
involvement, the default create project and its discovered native issue type.
Creation never guesses a project or type, and the editor does not persist issues.
See Jira's [API-token authentication contract](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/).

Jira issue identity uses the numeric issue id, not the mutable issue key. Enhanced
JQL search supplies continuation tokens, status categories refine task state,
and schema-identified Sprint fields, parent/subtasks and inward blocking links
remain live read facts. Exact reads expose offered edit fields and executable
native transitions; writes reauthorize against fresh provider metadata and
confirm their outcome through reads. Create, edit and transition bind the task
roles; comment is an ordinary named Action. An ambiguous write is never blindly
replayed. Provider rate-limit evidence uses the shared pacing contract, and a
permission-masked 404 never establishes absence. Real-site authentication and
write/recovery certification remain release checks, not a claim of loaded Jira
validation. The implementing owners are [Jira's source package](../packages/plugins/jira/src/manifest.ts)
and the shared [write settlement](../packages/triage-sources/src/invocation/writeSettlement.ts).

In unreleased 0.3 development source, GitHub repositories and GitLab projects
use the shared `scopeSelection` control described above. Add, Update and Restore
choose All or a non-empty selected set. Sources translate their own opaque tokens;
the shared page submits the caller-bound administration Action and owns settlement.
Cancel writes nothing. Update and Restore seed the editor from stored configuration
and current discovery location; switching rows resets unsaved inputs.
GitHub retains one instance per credential binding, GitLab one per deployment
and binding. Neither selection changes entry identity or exact-item write routing.
Selected scans traverse each unit through the existing native scan owner, carrying
only its current native frontier; All delegates to the original account/deployment scan.

The same development-source control selects Jira projects, Linear teams, Sentry
projects and PostHog environments inside one site, workspace or organization
instance. Sentry sends the selected numeric projects through its existing
organization scan. PostHog selects immutable environment UUIDs; numeric ids stay
source-owned routing metadata, and All resolves the live environment directory
rather than freezing the environments seen during setup. Historical Sentry All
and PostHog environment-set tokens remain readable. These sources expose unit
listing as a safe read Action, and configuration-only listing projects retained
selection metadata without provider requests. Unit membership uses
`snapshot.scopeUnitId` without changing existing entry collision identity.

GitHub also declares its existing deployment-derived instance-key stability to
the shared page. When discovery cannot reach a configured login, Update uses
the exact retained binding, key, configuration and locator from the caller-scoped
read. Changing its repository scope needs no provider login; provider reads still
reauthorize that binding on the executing Machine. Sources without this declared
key contract retain the discovery requirement, and a stored record without a
locator remains removable rather than receiving invented edit metadata.

Remove uses the administration Action's shared approval policy, just like the
other lifecycle changes: the default asks once, Allowed skips the question, and
resetting the preference restores Ask first. The settings page adds no separate
confirmation. The Action's confirmation explains that removing a source takes
its entries out of the list while retaining the user's pins and Session links.

### Native GitHub source bindings (0.3 development)

The canonical instance binding preserves the configured-account arm and adds
`{ purpose, source: 'native', service }`, where `service` is the qualified
Connected Service identity. GitHub discovery offers this candidate when the
executing machine's CLI login is usable and no explicit account is selected.
The shared source settings owner labels it **Use this machine's GitHub CLI
login** and persists it through `administerSourceInstanceAction`, exactly as
agent callers do. Neither configuration path contains authentication material.
When no account is selected and the machine login is unavailable, discovery
retains the native service identity with the authentication failure
`plugin_connected_account_native_unavailable`, exposing the sign-in remedy
instead of silently returning an empty candidate list.

Instance identity and currentness use the canonical binding components; native
bindings are distinct from configured accounts without a synthetic account id.
Session preparation, formal-review scope and comment publication carry that
same service identity through their existing owners. GitHub reads and writes
materialize the current credential on the executing daemon. Losing that login
requires signing in with `gh` on that machine, not creating a Connected Account.
Other first-party sources retain their account-only admission and reject native
bindings. Native selection does not weaken explicit-account precedence or
retired-subject checks; see [plugin platform ownership](plugin-platform.md#machine-native-github-credentials-03-development).

For agent-authored repository scope, use `action.invoke` with Action reference
`{ pluginId: 'happier.scm.forge.github', localId: 'triage/list-github-instances' }`
and input `{ v: 1 }`. Retain
the chosen candidate's binding, local instance key, stability and locator, and
replace only its configuration. GitHub's current source-owned token is the JSON
encoding of `{ v: 1, selection: { kind: 'selected', unitIds: ['owner/repository'] }, units: [{ id: 'owner/repository', label: 'owner/repository', collisionScope: 'github:123' }] }`;
the outer configuration remains `{ v: 1, token }`. Submit the resulting draft to
the Action reference `{ pluginId: 'happier.triage', localId: 'sources/administer-v1' }`
with `kind: 'create'` and source
`{ pluginId: 'happier.scm.forge.github', localId: 'github-forge' }`. Reconfiguration
uses the same draft and its existing `sourceInstanceId`. The Settings editor and
agent inputs share GitHub's [configuration encoder/decoder](../packages/plugins/scm-github/src/triage/configuration.ts);
this is a development source shape, not a generic host repository-scope schema.
Call `triage/list-github-scope-units` with `{ v: 1, draft, query?, cursor? }`
to obtain its existing repository-path selection ids and display metadata. Entry
identity remains numeric and immutable; selection paths retain their established
locator-derived rename/move behavior. GitLab's corresponding
Action is `triage/list-gitlab-scope-units`, with numeric project ids and the same
public input/result contract. Both are ordinary safe agent/UI/plugin/MCP/CLI reads.
`mode: 'configured'` projects retained selection metadata without provider access.
Historical GitHub account/repository tokens map to All/one selected path; historical
GitLab `{ v: 1 }` maps to All. New encoders always write the selected-set shape.

## Linear source (0.3 development)

[`packages/plugins/linear`](../packages/plugins/linear/src/manifest.ts) contributes
team issues through this same public source contract. Its Connected Account uses
the host's manual personal-API-key mode and credential store. The key is sent only
to Linear's fixed GraphQL origin, inside the executing source invocation;
configuration contains All or a non-empty selected set of immutable team ids,
alongside the involvement selection.

Team discovery is read-only. One configured source covers the workspace; the
shared source Settings control chooses All or Selected teams, while source-native
fields retain My issues, Assigned to me, Created by me, Subscribed, or All issues.
Historical singleton team tokens and instance keys remain readable. Creating an
issue requires an explicit team for All or multiple selected teams; a singleton
selection supplies that target directly.
The source maps those relationships onto the existing author/assignee/subscribed
facts. Entry identity uses Linear's immutable issue id in its deployment scope;
the mutable identifier, team name and account are not identity components.

The native detail read pages labels, sub-issues, outgoing blocking relations,
incoming blockers, comments and workflow states independently. Source snapshots
retain every projected row fact; the list presenter selects one Signal rather
than dropping facts at the source or on the wire. The full metadata and description are live detail
content. GraphQL errors never become an empty successful page or inferred absence.
The source forwards provider request, endpoint and complexity exhaustion through
the existing `retryNotBeforeMs` failure field and performs no timer-driven retry.
Linear's [API guide](https://linear.app/developers/graphql),
[pagination](https://linear.app/developers/pagination), and
[rate-limit contract](https://linear.app/developers/rate-limiting) define these
provider boundaries. Real-tenant authentication, writes and recovery remain
release validation; source/HTTP fixtures do not claim tenant verification.

The source declares the public task `create`, `edit` and `transition` roles,
and `linear/comment` as a named Action, all outward writes with the shared
approval default. Supported fields are title, description/body, one assignee,
labels, project, priority, due date, estimate and parent; create targets the
configured team. Unsupported fields are refused. Team workflow ids, not mixed
task categories, authorize transitions. Edits use native label additions/removals
so concurrent unrelated additions survive. Each write dispatches once and uses
the shared settlement lifecycle to confirm authoritative provider state. A lost
create/comment response without an entity id stays uncertain and is not replayed;
an accepted response alone never proves that the requested fields were applied.

## Mounted page actions (0.3 development)

The client-target [`ui/mounted-v1`](../packages/plugins/triage/src/actions/mountedUiProtocol.ts) Action accepts finite semantic operations against a `mountId` from the current UI context. It opens/closes detail through the existing reducer and route settlement, controls the same detail Tabs and List/Board preference as the UI, applies a lens or saved view through the existing lens/view owners, sets bulk selection through the public Collection selection store, and refreshes/pages through the mounted window and continuation owners. `focusRow` requests the Collection's physical row focus without activation; `peekRow` expands that row's table peek without opening detail (`expanded: false` closes it). Repeating the same peek intent is idempotent. Both require a key in the current Collection. `retryRun` and `cancelRun` reach the mounted bulk controller's existing Try again and Stop operations, preserving its retained identities and completed outcomes. The local-state Collection APIs are unchanged.

When saved views or pins cannot be read, the same mounted Action advertises
`retryAccountData` in current UI context. It invokes only the failed Account-data
hooks, as does the visible Retry, without rescanning provider entries.
`retrySessionActivity` likewise reaches the linked-Session activity reader's
existing Retry when that reader reports a failed read; terminal missing
Sessions do not become retryable.
The selected detail reports its failed fix-PR-link reader's existing Retry to
the same mount. `retryFixPullRequests` and the visible chapter Retry invoke
that callback; they do not rescan the provider list.

URL/resource details bind the same mounted dispatcher and source-panel callback
registry as page details. Their current UI context publishes the actual detail
tabs, linked Sessions, continuations and source-panel commands. Resource Retry
uses `refresh` to retry exact resolution/read rather than an aggregate scan.

In the current development implementation, `setLens` also accepts optional
`smartPolicy: { v: 1, precedence: ['attention', 'activity'] }` or the reversed
precedence. Omission retains the mounted policy. The canonical Smart-policy
parser rejects repeated predicates; the same settled route used by the UI
records an accepted change. This does not write a saved view or start a Session.

The mounted entry picker publishes its own `mountedAction` address in current
UI context. `attachEntry` and `removeEntry` accept an `entryRef` for a row in
that picker; they call the existing revision-checked attachment owner against
the exact Composer from the picker launch. The owner supplies Triage's
canonical attachment key, configured source and row presentation. Unknown rows
or retired picker mounts return `unavailable`; a list-page mount cannot handle
these operations. They change only the draft's identity attachment, never text,
navigation, provider disclosure or submission. Generic
`composer.transaction.apply` remains the host transaction transport, not a
second owner of Triage's attachment identity.

The existing Account/plugin/generation ephemeral scope leases only the addressed page's callback. No React state, provider rows, or mount address is persisted. In 0.3 development, choosing a saved view uses the same page-location owner as the Views control. The validated `sv` segment and effective lens are restored by the host's device-local workspace state; selecting writes no Account KV value. Saved definitions remain Account-scoped, with create/update/delete separately admitted through `views/administer-v1`. An absent/inactive page or unavailable tab/selection/continuation returns `unavailable`; refused route settlement returns `rejected`. Agent/MCP callers require an answering mounted client; a headless CLI cannot operate another client's UI. Opaque current-context commands remain subject to the host's existing retirement and Action admission.

In 0.3 development, mounted saved views observe their Account KV key through
Data's existing AccountChange dispatcher. A matching external change causes one
catalog read; the existing saved-view binding clears a missing selected view and
its `sv` route segment while retaining the current lens. The observation performs
no read itself, ignores other keys, and ends with the mounted Account lifetime.
Native and hosted-web clients use the same dispatcher; hosted clients carry
content-free wakeups through the existing Data bridge. Pinned entries and
configured sources consume their Collection changes through that owner. Core
Task Account changes invalidate the generation's shared mounted list window;
two mounted consumers share one Task-lane read, without a source census. A
sorted window refreshes its selected merge through the existing aggregate owner.
Source deletion also refreshes that window's configured-source projection.

Reversible saved-view, configured-Action, source-configuration, Session-link and
Session/review-start UI presses use their Triage Action declaration's
`confirmationWhen: { presentUserUi: false }` default. A configured Ask still asks;
agent and MCP callers retain confirmation by default. The write classification
and confirmation message remain on each declaration.

The same mounted dispatcher now reaches source-panel intents in development:
`selectSourceOccurrence` calls the source's incumbent selection controller, and
Sentry's `setSourceOrdering` changes its existing retained-event ordering.
`loadMoreSourceItems` with a source-declared `list` key advances that list's
incumbent controller. Sentry retained events and PostHog sampled occurrences
use `list: 'occurrences'`; GitHub and Bitbucket changed files use `list: 'files'`.
`setSourceItemExpanded` takes the same list key plus `itemId` and `expanded`;
GitHub Files identifies a changed file by its path. The visible controls use
these same intents. Bindings are addressed by kind and list, so several lists
can coexist in one panel. Commands published by the active source declare the
available keys and operands; absent, pending, exhausted or inactive lists return
`unavailable`. These are unreleased 0.3 operations, changed in place without a
compatibility adapter.
Concealing already revealed user details is an ordinary mounted intent. Revealing
them uses `ui/reveal-source-user-v1`; adding the selected evidence uses
`ui/insert-selected-evidence-v1`. Both named Actions apply the shared manifest
default, per-surface Ask-first setting and explicit waiver. Sensitive operations
cannot be submitted through the ordinary `ui/mounted-v1` input.

The detail's `selectLinkedSession` operand names a currently loaded linked
Session and selects it in the same inline Session panel as the UI picker.
`loadMore` with `section: 'linkedSessions'` advances that detail's existing
linked-Session controller, including its retained rows and failed-page retry.
The visible Load more and Retry controls invoke the same mounted intent.
Exhausted or retired details return `unavailable`; page acceptance is not a
claim that its asynchronous Account read succeeded.

Source commands are published only by active panels; selection and evidence
commands carry the occurrence identity. A changed selection, hidden/retired panel or absent mounted
owner returns `unavailable`, rather than selecting a substitute or rereading the
provider. Source controllers retain selection; the existing Triage disclosure
bridge issues the same identity-only candidate to the bound, revision-checked
Composer transaction. Sentry's evidence counts and exclusions remain visible
beside Add; approval itself belongs to the named Action, not a second local
confirmation. The admitted Action's cancellation signal reaches that same
transaction, so cancellation during its Composer read prevents the later apply.
In 0.3 development source, Sentry occurrence tags include customer-defined keys
and values through the existing event projector; no fixed tag-key allow-list
classifies the person's own data. The projector honours Sentry's `_meta`
annotations on both keys and values before display or selected agent evidence.
The evidence disclosure names the retained tag collection as unclassified
content. This does not claim unannotated values are secret-free.
PostHog's existing purpose-bound configuration-directory reader is
also admitted on UI, agent, MCP and CLI without changing its schema or account
authority.

## Configured Session actions (0.3 development)

The `triage.actions` catalog is owned by
[`settings/actions.ts`](../packages/plugins/triage/src/settings/actions.ts).
Reads append missing built-in actions in default order, preserving configured
rows and explicit disabled choices. Deleting a built-in stores that row with
`enabled: false`; deleting a custom action removes it. An empty stored catalog
therefore means no custom actions. The catalog Actions and direct UI transport
use this same reader and writer.

Subject owners declare default records in
[`subjectActions.ts`](../packages/triage-protocol/src/v1/subjectActions.ts):
Happier's own owners (Deployments) through `TRIAGE_SUBJECT_ACTION_DECLARATIONS_V1`,
and plugins through the target-owned `agent-actions` point
(`happier.triage/agent-actions` V1, descriptor `TriageAgentActionDeclarationV1Schema`,
no operations). Subjects are limited to `TRIAGE_ACTION_SUBJECTS_V1`. The catalog
owner qualifies a contributed id as `<pluginId>/<localId>` and merges it with the
static list through the same default set, so it is offered exactly like a missing
built-in. The daemon catalog Actions read contributions from
`services.targetedContributions`; the direct UI transport reads the mount's
`SurfaceContext.targetedContributions`. A contributed record nobody touched is never
stored, so disabling or uninstalling its plugin stops offering it. Editing,
deleting (stored disabled) or reordering it makes it the person's record; while its
plugin is missing, reads mark it `unavailable: { reason: 'pluginUnavailable', pluginId }`,
the planner offers it nowhere, and Settings shows that reason. Plugins are trusted:
there is no allowlist or sandbox on this point.

Built-in action IDs reference their current fallback prompts. Writes omit an
unchanged seeded prompt body, and reads resolve it from the canonical seed before
checking action coherence. The two shipped Investigate seed copies observed in
the deployment journeys also resolve to the current fallback without a write or
migration job. A different stored prompt, a custom action, or a Prompt Library
reference remains the person's configuration. This is an unreleased 0.3 change;
matching catalog readers must reload together.

The existing `actions/administer-v1` Action also accepts `kind: 'reset'` with
the catalog's `expectedRevision`. It removes the stored catalog through Account
KV's conditional delete, so subsequent reads report `availability: 'absent'`
and use the built-ins. The KV tombstone retains its revision for later CAS;
reset does not fabricate the never-written revision `absent`. A stale revision
or unreadable catalog refuses the reset. Direct App transport and daemon Actions
use the same catalog owner.

The Account-owned `happier.triage/actions/sessions/run-configured-v1` Action runs a catalog choice through the same configured action/profile/prompt and Session owners as a mounted press. Its exact input and result declarations are [`configuredActionRunProtocol.ts`](../packages/plugins/triage/src/actions/configuredActionRunProtocol.ts). Unreleased 0.3 source accepts one `{v:1,handoff}` envelope. Configured single, bulk and formal Review requests use `handoff.context.kind:'entries'` with exact `entryRef`/`sourceInstanceId` selection and destination; optional settled `drafts`, Review choices and continuation facts reuse the incumbent host admission. Optional `singleIntent` preserves the existing split launch (`configured` with `launchMode`), human-edited issue orchestration (`orchestrate` with `prompt`), and read-only walkthrough (`comparison` with its exact SCM source). It is accepted only for the single-entry destination; omission uses the stored action. These intents use the same Session owner and do not create another executor. Matching unreleased plugin declarations and UI reload together; earlier strict development readers reject the optional field, with no epoch or predecessor adapter. The retired top-level `actionId`/`entries`/`destination` envelope is rejected.

The handoff operand and summary result are defined by
[`sessionHandoff.ts`](../packages/triage-protocol/src/v1/sessionHandoff.ts).
`prepareTriageSessionHandoffV1` on `@happier-dev/triage-sources/runtime` validates
those operands and returns the projected `{input}` for a host Action control,
using `TRIAGE_SESSION_HANDOFF_ACTION_REF_V1`. `settleTriageSessionHandoffV1`
validates successful handoffs while preserving the original approval, failure
and recovery envelope. Imperative plugin and automation callers use
`requestTriageSessionHandoffV1`, which composes the same preparation and settlement
and invokes this Action once. Hosted CI, release-note
context, selected entries or alerts, and selected local terminal output retain
their distinct evidence shapes. Configured Session, Agent/profile and
compose/send choices remain with the existing catalog and Session owners.
The helper preserves the standard approval/failure envelope and action-owned
recovery; an uncertain send is not permission to start again.
Entry execution results use the same envelope with a typed `entryExecution`
phase summary and the original per-unit starts, Review outcomes and recovery
facts. Optional `failure` preserves the single-start owner's public diagnostic
codes and request id, including the existing workspace-mismatch recovery guidance;
starts without that detail continue to omit it. Deliberate continuation retains
creation/input identities and never repeats a successful bulk unit merely because
another reply was lost. A lost outer response with no known recovery remains
visible and is not automatically replayed; the reader can check their Sessions.
Known earlier outcomes remain available alongside the unknown-outcome warning.

Preparation preserves the original typed Action failure from source-context,
native-entry and host-health reads. A denied or failed read is not relabelled
`evidenceInvalid`; that result remains for unavailable or invalid evidence.
Cancellation still returns `cancelled`, and a settled permission denial does
not re-poll the handoff. These decisions stay in the configured Action owner,
shared by manual and automatic investigation.

Host service-health investigation reopens the Account's private notice and
requires its stored source and page to match the handoff. The selected Machine
must be reachable; an offline original Machine permits choosing another one.
The notice remains evidence after redeployment, service removal or Environment
access withdrawal. An explicit Machine choice does not reopen the historical
Environment or require its old target membership. Without a choice, an Environment
notice reads the current Environment for its controller and Project Source;
starting the Session has its own admission.

Non-Triage surfaces read the same live catalog through
`readTriageSessionHandoffChoicesV1` on `@happier-dev/triage-sources/runtime`.
It invokes the existing `actions/read-v1` Action's closed
`{v:1,projection:'sessionHandoff'}` arm. Each returned row carries its label and
the four exact handoff selection operands; Session, Agent and delivery remain
`configured`, not copied preferences. The canonical seeded Fix row is the
default only while enabled and offered. Otherwise `defaultActionId` is null and
the person chooses a row; callers must not silently substitute the first one.
There is no persisted global last-selected Action. An unreadable catalog is
unavailable, and approval/failure outcomes remain intact. Execution still
re-reads the configured record and admits the real target before effects.

In development source, native **Send to Session** explicitly requests `send`
through the shared entry handoff builder, including when the catalog defaults
to `compose`. New-Session authoring and contributed handoffs requesting
`configured` retain the catalog's delivery choice. An unbound entry can use the
chosen Session's accepted workspace; a repository-bound entry must match that
workspace's repository. Workspace-less recipients still receive the typed
`existing_session_workspace_missing` refusal.

An existing Session keeps its admitted Agent. A configured profile's preferred
Agent applies to new-Session authoring; it does not silently switch or reject
an existing Session. An incompatible explicitly requested profile or Agent
returns `agentMismatch`. Compose appends ordinary evidence through the existing
composer transaction and preserves its prior text, attachments, selection and
focus; an unavailable composer is not a request to send instead.

In unreleased 0.3 development source, a PR cited in an ordinary Composer Send
is content. The attachment resolver reads it without creating a Session–PR
relation, including from a Session without a checkout or in another repository.
Only explicit work-on-PR or link Actions create the checkout-verified binding;
`channels_pr_link_checkout_not_verified` belongs to that explicit Action.

For an existing PR workspace, the configured owner invokes the read-only
`entries/verify-existing-review-workspace-v1` Action. It obtains the exact
Session's admitted checkout through `session.status.get`, then calls the same
source review-workspace verifier with its `acceptedCheckout` arm. The source
reauthorizes the current PR and verifies that checkout without preparing,
moving or creating it. Missing correspondence refuses the handoff. Selected
local-terminal evidence separately checks the qualified Project operation's
metadata `sourceWorkspace`; its custody or worker Machine is not proof of
the source checkout, and no terminal history is fetched for that check.

External evidence uses the core `SessionInputForgeEvidenceV1Schema` and
`renderSessionInputContextPromptV1({transformedUserText,forgeEvidence})`, exposed
through SDK `/sessions`. The renderer emits one escaped source/author-labelled
data block. Host-authored work, target and permission instructions remain
outside it; provider titles, labels and bodies cannot grant authority. This is
development-source integration, with composed and loaded-runtime validation
tracked separately from publication or release availability.

The same SDK surface exposes `readSessionInputForgeEvidenceV1(meta)` for
transcript presentation. It validates `meta.forgeEvidence` and returns the
structured evidence or `null` when absent or malformed. Rendered prompt text is
not a metadata format and must not be parsed to recover the evidence. The
structured value remains descriptive data, not permission or provenance.
Channels' direct PR delivery supplies the same validated value for rendering and
the authored Session input. Selected retained forge evidence also travels as a
typed annotation on ordinary prepared attachments, projected into message
metadata before persistence. This does not invent a snapshot for ordinary entry
references whose fresh context is acquired later by their existing resolver.

An incomplete start returns `recovery` when the existing single/bulk controller
still holds retry custody. Echo it as `resumeStart` with the same ordered entries,
source instances, action and destination. Single recovery repeats its retained
creation and delivery identities or resumes the reported phase. Bulk recovery
retries only incomplete units, retaining successful outcomes and the exact inputs
of units cancellation left unstarted. It does not resolve prompts or placement
again. A mismatched continuation is refused before dispatch. Cancellation reaches
the existing host/controller signal path; if a dispatched request has no answer,
the result preserves that uncertainty rather than claiming nothing happened.
These are invocation-local facts returned to the caller, not a durable retry
record. A lost outer Action response supplies no recovery object and must not be
treated as permission to start again. If the mounted owner already retained an
exact recovery from an earlier response, the person may deliberately resume that
same input with its original recovery; changing the input cannot reuse it. The
unknown notice keeps prior results visible and directs the person to Sessions
for work already created. Prepared-workspace recovery obtains a fresh
authorization when needed; it never echoes a spent authorization carrier.

Every configured continuation checks the current catalog's offerability before
dispatch, including mounted bulk retries and formal-review retries. Disabling
or deleting the originating action prevents unstarted units and new review
engines from starting. Settled and unknown outcomes remain receipts; refusal
does not erase them or turn them into permission to replay. Review checks run
after launch selection, so a row disabled while that selection is open cannot
start a review when it closes.

In current development source, agent/MCP/CLI contributed invocations route through the daemon's existing machine-scoped reverse RPC to an answering client, then through the ordinary Action executor and shared client dispatcher. The real invocation surface, exact contribution occurrence, cancellation and shared approval policy remain intact. A missing answering client fails closed before execution; loss of an issued acknowledgement is an unknown outcome, not permission to retry. This client dependency serves New Session authoring, input selection and navigation; it does not introduce a second Session creator.

For a single formal Review, optional `reviewChoices` uses the incumbent [`TriagePullRequestReviewChoiceV1Schema`](../packages/plugins/triage/src/actions/entrySessionProtocol.ts): required `engineIds` plus optional `launchSelection`, `outputs`, `comparisonSource` and `narrator`. Without choices, `awaitingReview` returns the prepared Session's review context and configured instructions rather than claiming an engine started. To continue that same Session, send `resumeReview: { result, instructions: reviewInstructions }` using the returned fields, with the same entry, configured action and `single` destination. This skips Session creation and reaches the same [`pullRequestReviewContinuation.ts`](../packages/plugins/triage/src/sessions/pullRequestReviewContinuation.ts) as the mounted chooser. Retained facts are not authority: the existing final source/workspace/scope verification and `review.start` engine owner still admit the effect. For a partial result, explicitly select only the engines you want to retry; an unknown outcome is never retried automatically. There is no Triage engine registry, duplicate scope resolver or new engine fan-out.

`reviewStarted`, `reviewPartial`, `reviewRefused` and `reviewUnknown` distinguish the outcomes. `reviewResult` carries the incumbent started/failed engine ids or refusal/unknown verdict; `sessionOpen` separately reports `opened` or `failed`. A transport failure is not proof that no engine started. Bulk formal `reviewStart` retains the existing `reviewStartUnsupported` refusal; these destinations do not imply bulk formal-review support.

Configured action Settings, launch inputs and settled drafts all admit profile
references through the Launch Profile V2 id parser: trim, then 1–256 UTF-16 code
units. The public SDK projection `ProtocolLaunchProfileIdV2Schema` delegates to
that parser; Triage imposes no competing generic-id or UTF-8-byte restriction.

In unreleased 0.3 development source, **Save as this action’s default** in a
composer opened from a configured action saves its current name, instructions,
launch mode and Profile launch preferences through the existing catalog owner.
The action retains references to its own Prompt Library and Profile copies;
copying leaves the selected source records unchanged. Later saves update those
owned copies. These remain ordinary library records: explicitly reusing an
owned copy elsewhere also shares its later edits.
The Profile owner preserves reusable placement and checkout preferences in
current and retained legacy Profile records. Fixed placement keeps its directory
intent, including a managed folder. Pending acquisition or creation choices and
unsupported reusable targets receive a visible refusal. Directory choices
incompatible with the action’s workspace mode use the launch owner’s refusal
before any default is written.

Prompt, Profile and catalog mutations remain separate owner operations. A final
catalog refusal can leave unreferenced new copies or updated owned content with
the previous catalog name and launch mode. Shared originals remain intact; retry
or editing the owned records is the existing recovery path.

## Refresh and provider settlement (0.3 development)

Connected Account refusals are classified once by
`materializeTriageSourceAuthorizationV1` in `triage-sources`. Source clients
preserve its typed code and redacted Happier Request ID without sending provider
HTTP. A temporarily unavailable purpose catalog is a transient failure, including
when the host omits retryability or reports `retryable: false`; a genuine
credential refusal remains an authentication failure. Temporary catalog failures
therefore use the existing retry path rather than asking the person to reconnect.

GitLab native write settlement keeps a provider refusal after dispatch separate
from an unavailable preflight. A write answered with a refusal such as HTTP 403
returns `refused` with `dispatched: true` and the classified provider failure;
the existing outcome banner displays its Code and available GitLab Request ID.
An unavailable admission or currentness read sends no write. Lost write answers
continue through the existing confirming read and never invite a blind retry.
GitHub, GitLab state transitions and Bitbucket share the at-most-once lifecycle
owner; each source retains its provider-specific response classification.

Manual Refresh and automatic view demand respect provider retry deadlines and
the mounted store's active single flight. Neither adds a local minimum interval
or aggregate failure backoff. Pages follow caller cancellation through response
body completion, without an aggregate lane timeout or a timer between pages.
Successful reads retain their completion time; staleness reflects a failed or
unavailable read rather than a local age cutoff.

The mounted list window divides its existing row budget across selected-source
Actions and publishes each source's result as it settles. A pending external
source therefore cannot hide settled personal tasks or another source's rows.
Coverage stays partial while a source is unfinished; a refused source keeps its
typed unavailable state and source-specific notice beside the settled rows.
Unspent provider continuations remain reachable through Load More.

In 0.3 development source, the window store publishes changed row identities separately from membership,
order and window metadata. Each mounted list plans display items for those
changed rows before notifying keyed row readers. A title-only observation builds
one display item and leaves the Collection structure and unrelated rows alone;
membership, grouping and ordering changes still use the canonical list planner.
Each task subscribes to its referenced blocker's keyed name, so renaming a
blocker updates its dependents without replacing the Collection's anatomy.
The shell no longer rebuilds every display item to compare snapshots.

A source with a native minimum page publishes `minimumScanPageSize` in its
descriptor. The scan pass chooses the larger of the fair share and that
declaration for a new lane; a resumed lane keeps the geometry that minted its
cursor. Bitbucket publishes its existing provider minimum through this field,
without a provider list in the target. If the requested share cannot carry the
first lane's atomic page, the scan owner promotes that invocation's capacity to
the page size within the existing wire maximum. The aggregate fold consumes
that decided capacity, preserving the whole page even when it exceeds the
requested share. A later page that cannot fit the remaining
transport window is deferred whole, before I/O, in the existing ordered lane
continuations. The mounted reader reserves at least that retained page size on
Load More. No fetched rows are truncated, no provider cursor advances past rows
the wire cannot carry, and an unvisited peer precedes a deeper page next time.

The Account list read starts with Account readiness, including while Auto Machine
selection is pending. Its scope and scan Actions request current Machine
availability, so Machine-only sources report unavailable without delaying Account
sources. Machine re-admission submits a refresh to the existing mounted window;
unchanged rows retain their identity while newly available sources merge in.

GitHub's five involvement lanes share the submitted observation budget. An
unstarted lane uses the remaining capacity after a short earlier response, so
one Refresh can include later authored work. Issued provider next Links keep
their page size and are followed unchanged; the aggregate never advances past
rows it has not materialized.

Each consumed GitHub search page acquires missing repository identities and
current PR checks in a native GraphQL batch through the existing checks owner.
Only unfinished check connections request another page; malformed or denied
checks retain the inbox row with unavailable/partial evidence. The detailed
REST history surface remains separate and uses the same checks projector.

When the mounted host withdraws and then re-admits its Machine binding, the
aggregate, detail, fix-PR, expanded PR-status and daemon-backed catalog/pins readers consume Plugin UI's shared
`usePluginHostReadiness` projection. Its revision resumes existing read demand;
the aggregate still uses its own single-flight/pacing owner, without interpreting
host refusal diagnostics or maintaining a second readiness state. Direct Account
reads retain their independent availability. This also covers a withdrawn read
that refuses after re-admission. The shared lifecycle does not
start a cold Composer-only window or repeatedly retry a settled outage; a failed
reacquisition stays a failure until another host transition or explicit Refresh.

GitHub REST Checks and commit statuses follow validated provider continuation
links under caller cancellation, without the Search endpoint's local page/result
cutoff. The [check-runs endpoint](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)
exposes only the most recent 1,000 **check suites**. Suite saturation or a provider
total exceeding returned rows therefore discloses incomplete coverage; unreadable
rows disclose unknown coverage while retaining readable evidence.

After Azure accepts a merge, settlement serially observes the authoritative pull
request under the caller's lifetime, without dispatching another merge. Terminal
success and provider rejection are distinct; cancellation or a failed confirming
read returns honest pending. There is no local three-read/750 ms settlement window.

## Detail panels and cross-source fix links

In 0.3 development source, snapshots may also carry `scopeDisplayName`, a bounded short name authored by the source for the compact place cell. GitHub, GitLab, Bitbucket and Azure DevOps publish the repository name alongside the full `scopeLabel`; GitLab resolves its nested group path within the source. Triage carries this fact through its canonical row projection without parsing paths. Older snapshots omit it and retain the existing full-label presentation. The full path remains in the list byline, detail and accessible row context. Kind glyphs use the source descriptor's declared `workflowSubject`; an unmatched kind uses neutral lifecycle marks (`info` while active, `check` when resolved), never an inferred pull request.

A present snapshot ([`observations.ts`](../packages/triage-protocol/src/v1/observations.ts)) may carry two optional display lines for list rows and the detail header: `authorLabel` (who opened the entry, as the provider names them) and `designation` (its short native designation as the provider writes it: GitHub `#2481`, GitLab `!88`/`#12`, Bitbucket `#42`, Azure DevOps `!17`, Sentry's short id). Both are presentation only, never parsed back into identity, and a shortened one sets `projectionTruncated`. PostHog error groups and Sentry issues carry no author; PostHog carries no designation.

A pull or merge request snapshot may also carry `branches` (`{ head, base }`): the provider's branch names, presentation only and never a checkout or revision fact (`reviewRevision` owns those). GitHub's exact read publishes it from the same `GET /pulls/{number}` response its overview reads; list scans do not carry branch names, so a row learns them when it is opened. The detail header's byline says them as `head → base`, and its breadcrumb is the snapshot's `scopeLabel` then `designation`. This is an unreleased 0.3 additive field on the `additive-open/drop` snapshot: older readers drop it, and new readers treat its absence as unknown.

[`descriptor.ts`](../packages/triage-protocol/src/v1/descriptor.ts) owns per-kind `detailTabs` and `detailActions`. Shared tab ids select the target's Overview, Activity, Files and Checks vocabulary; source tab ids keep source-owned names and append after the shared tabs. A source tab's optional `titleKey` resolves through that admitted source's projected translation bundle, with `title` as the fallback. Either tab arm may name a `summaryFact`: the id of a row fact the kind's snapshots already carry. Triage's tab plan ([`tabs.ts`](../packages/plugins/triage/src/ui/detail/tabs.ts)) reads that fact from the snapshot of the entry that renders the tab (the linked fix PR's own facts for an issue's Files and Checks) and the strip shows its value beside the title: a number in the reader's locale (`~` when approximate), a status in the shared status tone (`resolveTriageRowFactStatusToneV1`), text quietly; time, actor and detail-only facts and a missing fact show nothing. Current declarations: GitHub Checks (`github/checks`), Sentry Occurrences (`events`), PostHog Occurrences and Affected sessions (`posthog/occurrences`, `posthog/sessions`). No source carries a changed-file count as a row fact, so Files has no summary. Triage owns the frame and tab strip. A source renders the requested [`detail.ts`](../packages/triage-protocol/src/v1/detail.ts) `panel` through its existing detail surface; `detailActions: true` requests the `actions` panel in the header. Omission preserves the whole-detail path. A source using public Plugin UI `Tabs` consumes `tabList="host"` for a target-selected panel and `useTabPanelActivity().activeSignal` for retained asynchronous work.

Conditional panels remain source-owned: a framed source passes its current
`visiblePanels` to `TriageDetailPanel`, which publishes through the existing private
panel-navigation context. Triage consumes that answer for the exact entry or linked
fix instance and falls back to an offered tab when a selected panel disappears.
Descriptors declare possible panels; Triage never rechecks the source's evidence.
Sentry uses the same visibility result for its standalone strip and framed detail.

The detail body keeps one mounted instance per entry/configured connection while
changing its `panel` input. Selection and settled evidence pages remain owned by
that source instance, never by Triage or a global cache. Public `Tabs.sharedPanel`
keeps a shared renderer mounted behind a changing strip; source host-mode Tabs
apply their own declared retention and end hidden panel intervals. Switching to
the linked PR or Session also withdraws the entire hidden source slot's activity.
Changing or retiring the entry destroys its source instance. The Overview rail's
`ScrollArea` stays mounted but disables scrolling for bounded source panels, whose
own collections then own the viewport.

Each tab's optional `scrollOwner` comes from the source's own panel declaration.
`list` makes the frame bound the panel without scrolling around it; the same
value reaches source wrappers as `panelScrollOwner`, so their Lists fill that
viewport. The protocol's detail Surface role uses `fill` presentation so the
physical host preserves that viewport instead of sizing its wrapper by the
source's inventory. This applies to both entry and linked fix-PR detail mounts.
`scrollArea` or omission keeps frame scrolling. Tab IDs do not decide
scroll ownership. The closed declaration and matching development artifacts
must be updated together as described in [SDK protocol evolution](compatibility.md#sdk-protocol-evolution).

PostHog's sensitive captured-variable reveal declares confirmation on its existing
Action, so the shared approval policy applies on UI, Agent, MCP and CLI surfaces.
The Stack trace panel invokes that Action through the host rather than making a
separate local consent decision. Explicit Ask-first settings and user waivers
retain their ordinary precedence. Revealed values stay in the active panel and
are discarded when it is left; unfinished reads use its activity cancellation.

[`TriageDetailInstance`](../packages/triage-sources/src/ui/detailPanel.tsx) binds
the source root to that same real Tabs activity owner, independently of the
selected source panel. Sentry summary/selected-event, PostHog summary/sample,
GitHub capabilities and Azure iterations abort unfinished root reads while the
source slot is hidden and resume them on return. Settled root evidence survives;
the shared exact-request authority hook replaces it when the configured account,
configuration or entry changes. Sentry also resets its selected occurrence at
that authority boundary, before rendering evidence for the replacement account.

The six first-party sources compose Overview through
[`TriageDetailStory`](../packages/triage-sources/src/ui/detailStory.tsx): the
source's ask, report or (for an error group, `kind: 'error'`) "What happened",
then changed-file evidence and a checks marker where that entry kind supplies
them. Sentry and PostHog put their selected occurrence (exception and top
application frame) in ① and their reach in ②
[`TriageDetailSpread`](../packages/triage-sources/src/ui/detailStory.tsx):
count tiles (events or occurrences, users affected, first release or first seen)
and the provider's own occurrence series — Sentry's `stats["24h"]` from the
existing issue read, PostHog's `sparkline` from the existing `query/issue/` read
(`includeSparkline`, provider-chosen buckets across the detail window). A fact
the provider did not state is absent, and those counts are not repeated in the
Facts list. A source control that points at a sibling panel ("Open the stack
trace") selects it through
[`useTriageDetailPanelOpener`](../packages/triage-sources/src/ui/detailPanelNavigation.tsx),
which the tabbed detail body backs with its own tab selection and offers only
for panels it shows. The shared composition uses public Plugin UI
`Step`; it does not own provider reads, selection, paging, or mutations. Host
stories are static content in Triage's rail, while the whole-detail source path
keeps its own scroller. Shared story copy enters each source's existing
translation bundle through the shared translation producer. Native changed-file
readers preserve their paging and incompleteness disclosures. Check markers
consume canonical provider rollups, never counts inferred from the loaded page;
missing, partial, unknown, and inapplicable evidence never becomes a passing
marker. Source-only evidence tabs and header write controls remain source-owned.

The optional exact-PR `readPullRequestStatus` role uses the existing closed
[`TriagePullRequestStatusResultV1Schema`](../packages/triage-protocol/src/v1/pullRequestStatus.ts).
Its public successful-arm schema, `TriagePullRequestStatusV1Schema`, is also
embedded in GitHub's Overview result; the native assembler remains shared with
the standalone status read and fresh mutation admission. Provider-labelled
requiredness stays on each check row, and reviewers carry bounded native ids
rather than display-name or position keys. Draft, native merge state, queue
requirements/membership, auto-merge, viewer capabilities, base/head and the
actual observed head revision stay facts on that same status. Missing, partial
or truncated requirement evidence remains explicitly incomplete; it does not
override GitHub's affirmative current native mergeability verdict. Conflict
freedom, optional failures and an empty emitted-check list alone do not
establish readiness.

In 0.3 development source, GitHub's existing permission failure also carries
optional `requiredPermissions` diagnostic text. The request classifier reuses
its validated `X-Accepted-GitHub-Permissions` value: commas join requirements
within a set, and semicolons separate alternative sets. The existing failure
code and `detail` remain unchanged. The one closed Triage failure schema and
its mapper carry the optional field across detail, CI and Releases; it neither
grants authority nor triggers another request. Missing or malformed requirements
are omitted, never inferred from an endpoint or repository role. GraphQL HTTP
refusals use the same classifier; a headerless `FORBIDDEN` error retains its
generic refusal. GitHub's GraphQL authentication guide promises an explanatory
message but does not specify a structured required-permission property. The
presenter can say “GitHub needs Contents: read” for `contents=read`; it must
preserve “and” versus “or” when explaining multiple sets, and use generic denial
copy when the provider did not identify a requirement.

In 0.3 development source, the same GitHub summary also supplies repository
capabilities to the mounted PR detail. Its existing GraphQL query selects
`hasIssuesEnabled` alongside archive and merge-method facts; the canonical
repository-capability projector maps it like REST `has_issues`, so disabled
issues keep all seven issue operations disabled. The Overview result carries
this projection only when all repository capability facts are present. Missing
or denied facts leave the existing repository-capabilities read in place;
issue detail and panels without a demanded Overview also keep that read.
The exact REST PR read remains the source of `mergeable_state`. With one
GraphQL page and no branch-rule reads, a fresh complete PR detail therefore
uses two provider requests instead of three. Capabilities share Overview's
existing retention and explicit Refresh; writes still perform their own fresh
native admission. This adds no query, cache or permission decision.

The same status optionally retains the provider's PR destination in `sourceUrl`
and each check or job's native destination in `checks.rows[].detailsUrl`. Missing
or unusable destinations are omitted, never synthesized or truncated into a
different link. These display destinations add no provider acquisition and
carry no mutation authority; source navigation uses the host's existing external
link owner.
The optional `title` is copied from that same exact native PR read through the
existing display-text budget; omission means no title was established, not an
empty title or a repository/number-derived replacement. Current and stale
Session Resource bindings expose it at `nativeStatus.value.title`.

In development source, a successful native status read may return
`refreshAfterMs`, a source-derived scheduling hint. GitHub derives it from that
read's response timing and REST request budget through its existing cadence
owner, without another provider acquisition. Closed and merged PRs omit the
hint. Missing timing evidence also omits it rather than inventing a delay.
The closed V1 result accepts older responses without the optional field;
producers and strict readers of the extended development result update together.

The Session PR Resource consumes the hint separately from semantic status facts
and owns one next-refresh timer per demanded exact PR. Firing marks native status
dirty and invalidates the Resource once; a newly admitted native read supplies
the next delay. Metadata-only changes do not read native status or postpone the
scheduled refresh. Disposal, removal of the PR demand, and a result without a
hint cancel it. Finite reads schedule nothing. Watch remains independent.
After an SCM push, status may lag by one derived interval; `checkedAtMs` exposes
its age and explicit Refresh remains available.

The development `session-pull-request-status-v1` Resource retains each admitted
Session binding, Watch policy and latest update independently of native status.
When its existing unique Source-admitted Session/locator correspondence supplies
canonical entry identity, the binding also carries optional
`entry: { entryRef, sourceInstanceId }`. This is a navigation selection, not an
authorization grant. Missing or ambiguous correspondence omits it; a valid
Channels binding need not have a Triage entry. No extra lookup or provider read
is performed, and consumers must not synthesize an entry from a URL or PR number.
In current development source, `configuredSourceUnavailable` can also carry
`nativeStatus.recovery: { kind: 'configureSources', offers }`. Each closed offer
reuses the admitted source's own Settings destination, display name and kind
names (`TriageConfigureSourceOfferV1`); it is invoked with the existing
`hostApi.openSurface(offer.destination)`, without launch input or sub-path.
The shared source Settings page collects the person's selection and submits
its draft through `sources/administer-v1`, the existing sole configuration
writer. Reading a recovery offer never creates a source or widens its selection.
The Session relation read supplies these destinations from its already admitted
pull-request sources; no provider discovery, credential acquisition or native
status read is added. Missing page declarations or retired sources produce no
invented destination. Equal offers retain shared projection identity, while
changed or removed offers publish independently of unchanged link metadata.
Glance presentation and loaded recovery validation remain separate UI work.
When the relation owner retains one linked entry but omits its configured-source
identity (including when several configured instances report the same relation),
the PR Resource reports `sessionLinksSourceInstanceRequired`, not
`configuredSourceUnavailable`. Relation reads and link navigation can still work;
native checks, review and merge status require one selected configured authority.
Recovery offers in this case are restricted to that entry's admitted source
plugin. The shared glance offers **Choose a source** without claiming that the
repository is missing or changing any saved selection. Its existing source
Settings page owns resolving overlapping repository selections. In unreleased
0.3 source, the relation owner automatically selects the lexically first source
instance when every overlapping instance binds the same retained provider
account id on the same host. For native PR status reads, a native binding with
unknown identity beside a connected binding selects the connected source;
unknown is not a different subject, including missing Account metadata. Several connected candidates select
the smallest `sourceInstanceId` unless stored subjects prove they differ.
Different hosts still require selection. The relation owner reads Connected
Account metadata once per service, without a native identity probe. Attach/link
writes and native effects retain their existing source requirements. Existing
duplicate Connected Accounts remain stored for the person to remove deliberately.
That Account metadata path does not require a Machine. GitHub's native status
role remains daemon-placed: the current portable Account Action services do not
provide its Connected Account materialization and admitted HTTP capabilities.
If the required native execution or credential authority is unavailable, the
binding remains present with an explicit unavailable native status, not an empty
linked set. Native success while that Machine is offline is not established.
Within the same admitted demand, two observations without native head evidence
can retain equal semantic facts; a changed observed head revision resets that baseline.
The exact configured SourceInstance is observed through its intrinsic Collection
row. Replacing or removing its admitted source authority retires the affected
bytes through the Resource owner. Changing only its display locator or
configuration timestamp neither retires native authority nor performs another
native status read; the shared relation projection owns those metadata updates.
Standalone native acquisition keeps its qualified observation until it settles
or hands off to an attached watch. Only the successfully admitted, encoded
response commits a native baseline; an unpublished retired read cannot seed the
replacement's stale value or successful-check clock.

The public `/v1` helper `reconcileTriagePullRequestStatusV1(previous, next)`
returns `{ value, checkedAtMs }` for already-admitted successful observations.
The retained producer supplies a baseline only for the same authorized Account,
plugin generation, source instance, credential, repository, PR and unchanged observed head revision.
Equal semantic facts retain their status, nested entities and ordered arrays;
reordered check/reviewer rows retain their native-id entities. Only the root
observation clock is excluded from equality: `checkedAtMs` is always
`next.observedAtMs`, even when `value` retains an older observation carrier.
The shared Session Resource receiver applies this same reconciler after JSON
admission, not a presentation-local comparator. It reuses a baseline only for
the same admitted entry proof, PR identity and observed head within the host's
Resource lifetime; private authority retirement clears that lifetime's baseline.
The receiver retains the Resource wrapper's supplied `checkedAtMs`, rather than
replacing it with the retained value's observation clock.
Domain timestamps, permission/head changes and incomplete or truncated evidence
remain semantic. Consumers keep successful freshness separate from semantic
subscriptions; failure must retain the last successful clock, and no prior
success means neither a value nor a clock is invented.

In this development contract, `branch.head` and `branch.base` are optional display
facts. `branch.headRevision` retains the observed native commit independently of
those labels, including a newer head reported by a superseding rollup. Missing
display names must not erase a known head change or suppress mutation currentness
checks. A presentation that needs both names omits that label pair until known.

The development status contract can carry optional `operations`, admitted by
`TriagePullRequestOperationsV1Schema`: source-owned readiness, named unmet
requirements, a primary offer and alternatives. An offer retains its original
`actionRef` and exact JSON inputs in uniquely identified `variants`; an optional
`method` supplies display text, not an inferred default. These portable offers
are data from the existing native acquisition, not another readiness engine,
credential lookup or mutation authority. Absence supplies no operation.

The common Merge header and shared PR status presentation (Companion glance,
Git/Project card and linked-entry detail) consume `operations.readiness` rather
than deriving Ready from native mergeability or the displayed requirement rows.
GitHub owns that verdict in `triage/pullRequestOperations.ts`; an affirmative
current native mergeability verdict remains Ready when the check list is
partial, including when fitted to the Action envelope. The shared facts and
Merge header retain the existing partial-status marker/copy rather than
claiming that every displayed requirement is known. Known native blockers
still remain blocked, and incomplete scope never enables explicit bypass.
Missing offers do not establish readiness, and a stale successful read never
appears as current Ready.

For the development PR fixing sequence, the same current-head status also carries
optional `review.threads:{rows:[{id,isResolved}],incomplete,failure?}` and nullable
`merge.conflicts`. Thread ids and resolution are provider facts, not inferred from
comments, replies or a green check. GitHub obtains body-free thread summaries in
the existing rollup's first page, using Feedback's existing thread window; a
provider continuation, denied field, malformed row or response-envelope omission
leaves coverage incomplete. A superseding head discards old thread/conflict
evidence while retaining the observed newer `branch.headRevision`. GitLab retains
its exact MR conflict fact and leaves unavailable thread coverage unknown.
GitLab's `has_conflicts:false` during asynchronous mergeability checking does not
prove conflict freedom; only its settled native mergeability establishes false.

The required binding-progress integration consumes these facts for D-I14: failing
required checks, unresolved threads, changes-requested review and merge conflicts
are fix subjects. Pending checks, missing approvals and queue position are not.
Only a current, exact-head, complete known snapshot with no remaining subject,
and no admitted input still in custody, may end the sequence. GitHub's existing
PR poll projects these same acquired facts into optional
`endpoint.pullRequestState.fixResolution:{headRevision,resolved,incomplete}` on
its existing endpoint snapshot. The same snapshot travels in ordinary Channels
observations and the poll's `pullRequestEndpoints` result, including a successful
poll with no events. Resolving the last thread therefore needs no fabricated PR
event to deliver the fact. Equal native facts preserve the endpoint, state and
resolution identities; a changed fact uses the actual observation time, even if
the clock has not advanced. The closed schema belongs to `channels-protocol`;
the native projection is shared with the status assembler. The existing CI
rollup includes status facts in the same request. A poll without that rollup
reports incomplete evidence and adds no read to fill it. Missing, stale, denied
or incomplete evidence never means resolved. Binding progress consumption and
custody remain Channels-owned; producer delivery alone does not certify the
sequence-ending consumer or loaded runtime.

GitHub's shared status assembler retains native repository merge-method and
archived flags in the same first-page rollup query. Its source-owned
[`pullRequestOperations.ts`](../packages/plugins/scm-github/src/triage/pullRequestOperations.ts)
projects offers from each candidate in the existing response-envelope fitting
walk, so omitted requirements cannot become a complete bypass acknowledgement.
The header and standalone controls forward these same variants; missing offers
never trigger a local capability/default-method fallback. The public
`TriagePullRequestRequirementRefV1Schema` also owns GitHub's existing skipped-
requirement acknowledgement grammar, rather than publishing a second shape.
The source detail retires a shown callback after a failed read or settled
uncertain/unreadable write. Only an explicit successful native re-read can
recover its uncertain control; it never replays that write or treats pending
state as a new authority lifetime. A read begun before a later uncertain result
does not clear that newer uncertainty when the read completes.

The Session consumer uses `usePullRequestOperationsV1` and
`executeTriageSessionPullRequestOperationV1`. A press rechecks the same shared
Resource synchronously, including fresh native status, admitted entry/source,
immutable PR identity, observed head and the selected original offer. Authority
retirement cannot be undone by reacquiring equal JSON. Ordinary refresh alone
does not withdraw a still-current offer, and aggregate blocked/unknown readiness
does not disable a source-enabled cancel or queue operation. Method selection
must be explicit when offered. Execution forwards the original Action and input
once through host confirmation/approval and returns its result unchanged,
including refusal or uncertainty; it never retries an uncertain write. Native
admission remains responsible for effect-time credential, head and requirements
checks. The native portable producer is present in development source.

The development public UI adapter is
`@happier-dev/triage-sources/ui#useTriagePullRequestPrimaryWriteV1`. It builds
`TriageDetailPrimaryWriteV1` from the same operations, native wrapper, mounted
signal and current-offer executor. The returned controller is
`{primaryWrite:TriageDetailPrimaryWriteV1|null,refresh():Promise<void>}`; ordinary
refresh remains usable without offers. Optional `readRequirements` supplies the
source's separate lazy policy read, falling back to ordinary refresh; both use
the same uncertainty-review fence. Optional `onSettled(execution,outcome,offer)`
receives the original host settlement, admitted portable answer (or null), and
original offer for source-specific effects. It runs outside dispatch error
classification and only within the mounted lifetime. The producer retains
unchanged controller/offer identity, while withdrawn offered objects retire
captured choices without discarding entry/head feedback. Replacing only the
settlement observer keeps that publication stable and uses the current observer.
A successful uncertainty re-read enables a newly offered callback while keeping
pre-write callbacks retired, even when native facts retain the same identity.
It retains explicit method ids, original
Action inputs and per-Action pending state, and aggregates the selected primary
or alternative's feedback in the existing adjacent feedback slot. The source
Action owns its portable `outcome`; the single
`readTriageSourceOperationOutcomeV1` reader admits that field and its source-owned
presentation. The adapter never parses a forge's native result or translates a
resolved dispatch into applied success. Host transport settlement reuses
plugin-ui's existing `projectPluginActionRejectionV1`, including declined
confirmation versus dispatched uncertainty.

Uncertain or unreadable results disable that Action until an explicit successful
native re-read. The optional `refresh` callback performs that existing read and
returns whether it established a current native observation. The adapter's
existing Banner recovery action invokes it without replaying the write; a
failed re-read retains feedback and recovery. Another Action's settlement cannot
hide recovery for an earlier uncertain Action. A read started before a later
uncertain settlement cannot clear that newer answer. A caller can supply
`unavailableReason` while presenting the Resource's admitted retained operations;
these facts stay visible but cannot execute. No cache, automatic retry, new
acquisition or second availability/readiness owner is added. Package publication,
actual composition and loaded-runtime availability remain separate evidence
boundaries; this development-source contract description does not certify them.

The original GitHub Merge, Mark ready, queue and auto-merge Action results carry
their source-projected `outcome` under the public
`TriageSourceOperationOutcomeV1Schema`. The incumbent
`projectGithubMutationOutcomeV1` is source-owned, outside private UI hooks; its
Action adapter retains applied/already-satisfied, refused, uncertain and failed
semantics plus source-authored presentation. Named refused requirements occur
once in `outcome.unmetRequirements`, rather than being duplicated at the Action
result root or squeezed into bounded prose; internal writer results retain their
native requirement field. The public
reader admits only this field, not GitHub's native result union. Optional source
translation keys retain portable fallback text. The source detail consumes the
same projected outcome; no provider read, confirmation or replay path is added.
Its primary-write hook binds the public controller to the source's existing
entry/head/activity lifetime and forwards settled effects to the existing source
observer. It no longer maps portable offers or classifies their feedback locally.

In 0.3 development source, a framed source detail can offer its primary write
through the optional `primaryWrite` member of the existing public
[`TriageEvidenceDisclosureV1`](../packages/triage-sources/src/ui/evidenceDisclosure.tsx)
bridge. The source publishes its title, disabled reason, pending state, explicit
method choices, original declared Action reference and operand builder, readiness
presentation, named unmet requirements, alternatives and existing Action callback.
Its optional `nativeStatus` uses the same `SessionPullRequestNativeStatusV1`
contract as the Session Resource: current/stale carry the admitted status and
last successful `checkedAtMs`; stale also carries the actual failure. Unavailable
has no invented status or successful clock. This is a projection of the detail's
existing read, not another Resource subscription or write-admission snapshot.
The header forwards that callback and its source-owned choice rather than
deriving write authority from a label or enabled bit. Triage scopes the offer to the
selected entry and connection and supplies it to the header composer; header
rendering remains separate. The source keeps confirmation, head preconditions,
provider decisions and settled feedback. Missing bridge support leaves the
source's existing actions panel usable. GitHub's
[`buildGithubPullRequestOperationsV1`](../packages/plugins/scm-github/src/triage/pullRequestOperations.ts)
consumes admitted status and native repository capabilities at the existing
acquisition, sharing the native requirement classifier with mutation admission.
The mounted source hook consumes those original Merge/Mark ready and native
enqueue/dequeue/auto-merge offers through the same bridge. Those header facts and the offered callback belong
to the detail mount, not its selected body tab: switching tabs neither withdraws
the offer nor starts another Overview read. Retiring the detail still cancels its
reads and prevents a captured callback from writing.

In 0.3 development source, PR title/description and base-branch edits use separate
declared Actions with independently configurable outward-write approval defaults.
They share one [PR edit owner](../packages/plugins/scm-github/src/triage/mutations/pullRequestEdit.ts),
the existing configured-entry admission, validated entity read and write-settlement
path. The PATCH contains only the fields supplied by the caller; an empty body
clears the description without replacing the title or metadata. Exact provider
text is preserved. An accepted change that the confirming read cannot establish
stays uncertain and is never automatically resent. The same Actions are exposed
to UI, agents, MCP and CLI; native detail control composition is separate work.

The development-source metadata Actions set/clear one milestone, set/clear an
issue type, or lock/unlock one issue/PR conversation. Existing label and assignee
delta Actions also accept PRs; none replaces a whole membership collection.
PR assignee and label properties use the same searchable Plugin UI picker over
GitHub's repository assignees and labels. The existing overview Action reads
those directories only on explicit property demand and follows the source's
validated provider pagination. A choice sends one exact add or remove through
the existing delta Action, preserving unrelated members. A directory failure
leaves the current overview and independently readable directory available;
missing current membership facts do not render an editable row.
The canonical overview supplies milestone number, issue type and lock state from
the same native fields consumed by the writer. GitHub may silently ignore an
issue-type update without the required repository access, so an unconfirmed
change stays uncertain rather than reporting success.

Native GitHub pending reviews use separate declared create, submit and delete
Actions; submitted reviews have a separate dismissal Action with a reason.
The [pending-review owner](../packages/plugins/scm-github/src/triage/mutations/pendingReview.ts)
binds an existing review to the admitted PR once, then uses GitHub's native
lifecycle and atomic response. Review-body editing uses the existing comment
edit target. These native drafts do not replace the Reviews-owned frozen-plan
publication/settlement flow. A lost mutation response is uncertain and never
automatically replayed. These are source contracts, not a claim that the new
controls have been exercised against a real GitHub account.

In development source, pull-request [Activity](../packages/plugins/scm-github/src/ui/renderSurface.tsx)
offers **Start a review** with an
optional summary when its complete review history contains no pending review.
The confirmed create Action pins the observed head and saves
the pending review on GitHub; Happier stores no local review draft. The ordinary
post-mutation refresh projects GitHub's review back into the existing Submit and
Delete draft review controls.

Issue administration in development source exposes transfer, delete, pin and
unpin Actions, plus separate issue/PR subscribe and unsubscribe Actions. The
[administration owner](../packages/plugins/scm-github/src/triage/mutations/entryAdministration.ts)
uses the existing validated entity read's native node id. GitHub's atomic
payload settles each write through the common at-most-once owner, with no
own-write reread or replay. A transfer returns the direct successor identity,
destination route and URL; deletion requires a positive native acknowledgement
at the existing observation owner, not a permission-masked 404. Unsubscribe
means GitHub's ordinary participation/mention notifications, not Ignore. These
outward writes retain individually configurable Ask defaults on agent surfaces.

The developing Notifications group reads issue pin and subscription facts only
when opened, through one small admitted GraphQL read. Opening an issue without
that group makes no additional request; showing it reads both facts together.
The canonical REST issue overview stays unchanged. Unknown facts show no guessed
switch state, and confirmed mutation payloads settle switches without another
facts read. Pull-request subscription joins its existing status query.

The native pending-review Submit Action also carries the selected head. Its one
review-identity read supplies the draft commit and current PR head; changed-head
or mismatched-draft submission is refused before publication. The existing
feedback reader projects `commitRevision` so another client can make that choice
from provider facts rather than remembered local state.

Development-source PR branch Actions consume the caller-observed head. Restore
uses GitHub's create-reference endpoint and never overwrites an existing ref.
Delete reads the exact source ref immediately before its one DELETE and returns
`branch_moved` with the current revision on a mismatch; it performs no second
permission evaluation. The Triage lead explicitly accepted the small read→delete
race (2026-10-31): a subsequent PR observation and create-only Restore provide
visible recovery. Merge itself never implicitly deletes a branch. Revert is a
separate native Action that creates a new PR and leaves the merged original
unchanged. All use the same source admission, transport, settlement and outcome
owners, with per-Action Ask defaults.

Issue-to-Discussion conversion is unsupported by GitHub's published API and
retains the existing Open on GitHub route. In 0.3 development, review comments
project complete suggestion blocks with their path, original commit oid,
original right-side line range and original lines from the same GraphQL response.
Incomplete anchors are omitted; outdated anchors remain marked. The
`scm.suggestion.apply` Action targets an exact Session checkout, resolves review
paths through the SCM owner's repository root even for a subdirectory Session, and uses the
existing guarded working-tree file replacement owner. It refuses outdated
suggestions and returns `suggestion_conflict` when original lines have changed
or selected ranges overlap. A batch is atomic per file; separate files report
their own results. It does not commit: review and commit/push use the existing
Git sidebar. Agents use the Action's Ask default; a direct UI click is the
person's approval. Open on GitHub remains the suggestion fallback.

In the same development source, [relationship Actions](../packages/plugins/scm-github/src/triage/mutations/relationships.ts)
link or unlink one manual PR/issue closing reference, add/remove/reprioritize one
sub-issue, add/remove one dependency in either direction, and add/remove one
GitHub Project item or edit/clear one of its fields. UI, agents, MCP and CLI
use the same declared Actions and configurable Ask default. Related entries
carry exact source identities and repository routes; a Project item must belong
to both the selected Project and the admitted issue or PR. None replaces a
relationship collection. Successful writes consume GitHub's returned mutation
payload; lost or partial responses remain uncertain without automatic resend.
These [closed inputs](../packages/plugins/scm-github/src/triage/mutations/relationshipContracts.ts)
are plugin-local 0.3 contracts; detail control composition is separate work.

The [GitHub Issues GraphQL reference](https://docs.github.com/en/graphql/reference/issues)
defines `addCloseIssueReferences`/`removeCloseIssueReferences`,
`addSubIssue`/`removeSubIssue`/`reprioritizeSubIssue`, and
`addBlockedBy`/`removeBlockedBy`. Blocking is the same dependency with its operands
reversed. Removing a manual closing link leaves body-keyword references intact;
those use the existing PR description edit Action. Sub-issue parent replacement
requires the caller's explicit choice. The
[Projects GraphQL reference](https://docs.github.com/en/graphql/reference/projects)
defines `addProjectV2ItemById`, `deleteProjectV2Item`,
`updateProjectV2ItemFieldValue` and `clearProjectV2ItemFieldValue`.
Field edits address one Project/item/field identity and one typed value (text,
number, date, single-select, multi-select or iteration); built-in issue/PR
metadata retains its existing native edit Actions. These API contracts were
checked against current GitHub documentation on 2026-10-31, not live write access.

Returning an open PR to draft uses GitHub's `convertPullRequestToDraft` mutation
at the same native state owner as Mark ready. It does not pin a commit set;
the existing notification-producing Mark ready transition retains its head pin.
Closed/merged PRs cannot be converted to draft. These are unpublished plugin-local
contracts, not a new server capability, persisted format or released UI claim.

The [native merge owner](../packages/plugins/scm-github/src/triage/mutations/pullRequest.ts)
reuses the fresh admitted PR/status decision before effects, including for agent,
MCP and CLI calls. Known unmet requirements refuse ordinary Merge with named
`requirements_unmet` evidence and zero merge writes. Unknown requirement details
remain marked partial even when GitHub's native verdict says Ready; an otherwise
admitted ordinary Merge lets GitHub enforce them. Explicit `withoutWaiting` uses that same Merge Action and requires
affirmative native viewer eligibility plus an exact acknowledgement of the
complete currently unmet requirement set. Unknown scope or a changed
acknowledgement refuses it; draft, conflicts, moved head and method refusal
remain constraints. An approved review does not establish that review threads
are resolved. The existing branch-rule read retains thread-resolution enforcement;
when it is required or unknown, this status cannot establish complete skipped
scope and explicit bypass is refused rather than inventing thread outcomes.
Eligibility comes from the already-required native PR read,
with no dedicated eligibility request. Local intent and acknowledgement are not
forwarded as provider bypass flags. Ambiguous writes use confirming reads rather
than blind replay.

The same Merge declaration supplies `confirmation.inputFields` for repository,
PR number, exact head revision, merge method and `skippedRequirements.[].label`.
The host's existing confirmation presenter reads these from the exact invocation
input bound by its current-intent gate. The normal arm has no skipped operand;
the without-waiting arm names its actual acknowledged requirements. No extra
provider read or feature-local confirmation is used to populate that review.

The current [Action declarations](../packages/plugins/scm-github/src/manifest.ts)
make enqueue, dequeue and auto-merge cancellation direct for a host-proved
present person. Merge, explicit without-waiting Merge and enabling auto-merge
retain confirmation; enabling may merge immediately. Consequential agent
invocations retain approval by default under the shared Action policy and its
explicit settings overrides. These are **0.3 development-source contracts**:
automated/package and loaded-runtime verification is pending. Final header/phone
composition remains UI-D-owned, and the shared Session status Resource lifecycle
and freshness subscriptions remain L05A-owned integration work; neither is
established by the source presenter or protocol helper alone.

Source detail failure sentences use `describeTriageSourceFailureV1` with the
source's translation function. It reuses the shared access/contract failure copy and
allows `plugins.triage.sourceFailure.<code>` for a translated source-specific
explanation, falling back to the caller's localized sentence when unavailable.
The optional translator preserves existing two-argument callers. Raw codes and
provider detail remain in the typed diagnostic result, not the reader's sentence.
Transient, rate-limit and unknown failures retain the caller's contextual warning
instead of substituting generic retry advice for a possibly applied write.
Source Actions explicitly opt into the same presenter's English access/contract
fallback with its fourth `'en'` argument when no client translator is present.
Settings and that opt-in share `TRIAGE_SOURCE_FAILURE_COPY_V1`; existing localized
callers keep their prior fallback semantics. An uncertain outcome retains the
no-replay warning alongside any actionable access explanation.

Checks, review and merge facts share
[`TriageStatusRow`](../packages/triage-sources/src/ui/statusRow.tsx) across cockpit,
story summary and the full source checks list. It owns only presentation; sources
retain state vocabulary, filtering, reads and operations. Spread tiles use the
public Metric caption slot instead of a separate caption renderer.

For hosted CI in 0.3 development source, Triage keeps the Checks tab's outer
list, ordering, rollup and source disclosure. A proven Actions-backed check opens
the same `@happier-dev/forge-ci/ui` run and job detail used by Project Actions and
Session CI. The forge plugin establishes repository, head, run, attempt and job
provenance before dependent reads or effects; a matching name or timestamp is
insufficient. External checks retain their source output and provider link, and
an unresolved relation retains summary, Retry and link-out. Shared CI runtime
owns exact-query foreground demand, logs and failure-summary projection; it
does not take over native check classification, PR merge decisions, credentials
or the configured Fix in a session handoff. Public protocol/runtime/UI imports
follow the CLI-managed authoring path and remain Developer Preview source
contracts; publication and loaded-runtime validation are separate evidence.

GitHub pages completed job logs using a cursor bound to the native `logId`,
selection and position. Each call reacquires and indexes the log; the native
reader retains no log bytes or index between calls and does not serialize the
whole log to bind a cursor. A cursor for a changed log identity returns
`github_log_continuation_invalid`. The shared page owner still fits each result
to the Action response envelope and preserves original byte/line positions.

GitHub's native outcome policy remains
[`readGithubCheckOutcomeV1`](../packages/plugins/scm-github/src/triage/checkOutcome.ts),
including its readonly failed and neutral conclusion sets. PR summary rollups,
Checks and hosted CI consume that policy: a failure wins, an unfinished member
prevents success, and unknown evidence cannot establish success. The provider's
account request owner supplies shared backoff and simultaneous safe-read sharing;
Triage keeps its own domain projections and demand rather than retaining settled
transport promises.

GitHub private-media reads accept the provider's download location without an
endpoint or host-suffix allowlist. API credentials remain scoped to the exact
GitHub API origin; redirected downloads send no authorization headers, and signed
URLs and Location headers never enter the Action result. Workflow dispatch reads
the selected definition once and leaves resolution of the submitted ref to GitHub.

The GitHub Overview reader retains its settled body/status projection in the
existing Account/plugin-generation **execution-bound** ephemeral scope. Closing
and reopening the same configured entry at the same head and source revision
reuses that projection without another Overview Action. A new source revision,
head, configured authority, or execution origin requires a new read; explicit
Refresh still reads. Pending Actions and their cancellation remain mount-owned:
neither a retained projection nor an unmounted entry creates read demand.

All six host Activity bodies render one chronological stream through
[`TriageActivityTimeline`](../packages/triage-sources/src/ui/activityTimeline.tsx).
Each source maps its provider records (remarks, reviews, threads, pushes,
state/label changes) into `TriageActivityEventV1` and hands them over unsorted;
the owner orders them (by instant, undated last, ties in source order) and maps
them into the public Plugin UI
[`Timeline`](../packages/plugin-ui/src/components/Timeline.tsx). Timeline owns
the themed rail and delegates scrolling and prepend continuity to List; source
event policy stays in triage-sources. Sources keep their
reads, dedupe and controls: thread replies and resolve/publication writes ride in
an event's `inset`, and every paged collection keeps its own continuation
(`reads: 'earlier'` above the stream for newest-first walks). Triage appends its
own `activityTail` after the panel. Azure's Overview
policy marker uses only its complete, untruncated evaluation result with known
approved/rejected/running/queued statuses; partial, unknown and empty evaluation
evidence yields no aggregate state. Commit statuses never establish policy
enforcement.
The known state meanings follow the source owner's
[Azure policy-evaluation endpoint](https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/evaluations/list?view=azure-devops-rest-7.1)
(`7.1-preview.1`): queued/running evidence is not approval. Other outcomes remain
visible in the native Policies plane without an inferred aggregate marker.
GitLab merge-request Activity uses its existing unified notes/event reader and
review discussions; it does not mount the separate issue-comments reader or
issue-comment publication control over those same notes.

[`fixPullRequests.ts`](../packages/triage-protocol/src/v1/fixPullRequests.ts) publishes the closed V1 fix-link caller schemas, result projections and exact qualified read/write Action references. Callers submit link/unlink intent through `marks/set-fix-pull-request-v1` and read ranked candidates plus the selected primary through `marks/read-fix-pull-requests-v1`. They do not receive raw mark rows, dismissals or co-linked entries to resolve themselves.

The private [`setPinned.ts`](../packages/plugins/triage/src/corpus/marks/setPinned.ts) remains the single `user-marks` writer. The private [`fixPullRequests.ts`](../packages/plugins/triage/src/corpus/marks/fixPullRequests.ts) resolves explicit links and Session-derived candidates, deduplicates origins, applies dismissals and chooses a primary that is never closed without merging. Mounted direct Account-data reads supply the admitted device projection; daemon reads obtain kind facts from the admitted source descriptors and lifecycle facts through the existing exact-get/reobserve owner and active configured-instance reader. Unavailable facts remain `unknown`; no provider observation is persisted. Triage mounts the primary PR's Files/Checks through that PR's source, including when the fixed issue came from another source.

The frame shows fix-link reads in progress and offers Retry when a read fails.
Unavailable execution settles that secondary read as unavailable. It does not
block the entry's source detail from rendering.
Selected reads carry the already prepared configured-source tuple. The exact
configured-row owner resolves its stored active row once; a native association
read does not acquire the configured-source catalog. Unscoped linked-Session
candidate reads retain their catalog demand. The supplied tuple addresses the
row and does not replace the stored configuration or source admission.
Native candidates carry their known configured-row address to the existing
exact reobserve path when their PR is outside the current window. Selected
observations and initial/continued detail preparation retain that address, so
binding a known fix PR does not search the configured-source catalog. Retained PR
relationship recovery remains separate work owned by its migration owner.
The primary PR's admitted kind declares its tabs independently of mount readiness:
Files/Checks remain selectable with the canonical unavailable state when the PR
is outside the current projection or its detail cannot mount. Durable explicit
links and dismissals do not inherit Session relationship query page limits;
the public read retains every explicit choice. Derived queries remain paginated
and disclose incompleteness rather than silently claiming a complete answer.

The agent step consumes the host Session snapshot's Work bucket and tone, with
Triage story copy and the shared Work semantic treatment. Its three-finding
preview offers See all through the canonical Session opener: the first omitted
finding's Session when named, otherwise the story's current linked Session for
scoped review rows without that optional field. A failed open is visible and retryable.

Known non-PR kinds are excluded by that resolver and rejected before a link write with `PluginError` code `triage_fix_pull_request_kind_invalid`. An unavailable descriptor is not evidence that a durable explicit choice is invalid: the writer preserves that intent and the read keeps its status unknown. Writes inspect admitted kind facts only, never fan out to provider reads.

The public [author recipe](../apps/docs/content/docs/plugins/ui/index.mdx) covers source detail panels and fix links; the [Collection composition](../apps/docs/content/docs/plugins/ui/react-native.mdx) uses public Collection, presentation, Step, Tabs and HappierDisclosure imports. The feature protocol exposes neither a corpus storage handle nor the mutation/resolution implementation.

## List Session facts (0.3 development)

“With an agent” is a cut of the existing Triage list, not a second Session list.
The mounted list submits its demanded entries through one batch of the existing
relation Action. The composed relation owner admits the configured-source view
once and reads only those entry relations, preserving each entry's independent
complete or failed result. It does not acquire entry detail bodies to count
links. [`readEntrySessionLinks.ts`](../packages/plugins/triage/src/sessions/readEntrySessionLinks.ts)
remains the corpus page/decoding boundary beneath that owner. Detail pagination
retains its opaque Collection continuation; complete Session/co-link reads walk
the selected relation's pages rather than scanning once per kind.
Distinct linked Session ids go through Plugin UI's shared `useSessionStates`
read/watch lifecycle. A confirmed missing or non-retryable Session read keeps
the relationship and shows a quiet unavailable line without Retry. A retryable
activity failure keeps the warning and explicit Retry; neither outcome starts
a retry loop. The host's canonical Work bucket `working` supplies
`agentActive` to the existing list planner. Required attention still takes
precedence, and Pinned remains a separate leading section, including retained
pins outside the current window.

An explicit open of an unsynchronized pin uses the same selected-detail exact-ref
reobservation path before mounting the contributed detail surface. It chooses an
active admitted connection for the entry's source/kind through the canonical
selector: an active explicit override, then the active observation/attention
choice, otherwise the smallest stable `sourceInstanceId`. A missing connection
is unavailable, not a fabricated observation or an account fallback after failure.
Rendering or paging pins never hydrates each row or reads its detail.

In 0.3 development, an explicit identity-only open from a deep link, notification,
Home widget, or mounted agent uses that same path when its entry is not loaded:
one exact source read with the admitted connection, then a detail mount when the
source returns the entry. A restored location follows the same configured-source
admission after the mounted window settles, including when its list coverage is
partial or unresumable. Source absence and typed read failures remain in the
selected detail; failures retain their code and supplied provider detail. Neither
open path scans the remaining source inventory. The existing Load more control
continues to own list continuation.

When a later window excludes the selected entry, settled-location adoption uses
that same exact read, retaining the selected connection. Window membership,
including partial or page-limited coverage, does not establish source absence.
Until the read answers, retained details are labeled not loaded/current state
unconfirmed; only an authoritative absent observation claims the entry is gone.

The join refreshes with mounted window acquisition, manual refresh and return
activity; Session invalidations re-read through the host. It creates no durable
projection or polling timer. Incomplete or unavailable
activity is shown in the list with an explicit retry. A failed link acquisition
keeps previously known relationships without claiming that missing entries are
unlinked; unreachable Session facts are not classified as working. A mount
without the Account Data client can still use the same portable Account Action;
it does not substitute a broad daemon inventory read.

## Committed investigation result data (0.3 development source)

The completed result retains its full readable reply (including evidence links
and next steps) and committed Session message reference alongside the ambient
preview. The investigation result also carries its exact failure subject and a
continuation address for that same Session. Completion alone does not establish
a root cause: an inconclusive report remains an inconclusive completed report.

## Related

[Plugin platform](plugin-platform.md), [Actions](actions.md), [Collection presentation](collection-presentation.md), [encryption](encryption.md), [compatibility](compatibility.md).
