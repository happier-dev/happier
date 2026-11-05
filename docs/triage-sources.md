# Triage source protocol ownership

Triage and independently authored source plugins share one versioned, source-neutral ABI. Triage owns the feature and configured-source lifecycle; each source owns its provider-specific discovery, reads and detail rendering. Generic hosts admit, invoke and mount contributions through the plugin platform.

This page describes **0.3 development / Developer Preview source**. Exact field layouts, exported names and bounds live in [`packages/triage-protocol/src/v1/index.ts`](../packages/triage-protocol/src/v1/index.ts) and its schemas, not a copied schema in this page. Registry publication and loaded external-provider validation are separate release/runtime evidence.

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

[`sources/administer-v1`](../packages/triage-protocol/src/v1/sourceAdministration.ts) is the one caller-bound lifecycle mutation ABI: create, reconfigure, remove and reactivate. [`sources/read-configured-v1`](../packages/triage-protocol/src/v1/configuredInstances.ts) is its read half. An optional `source` names an admitted contribution address, never caller provenance. In 0.3 development, the target's [`callerSource.ts`](../packages/plugins/triage/src/actions/callerSource.ts) lets any same-Account reader select that address, including another installed plugin. Source-less plugin reads retain their own-source default; direct host UI, Voice, agent, MCP, CLI and API callers can read all admitted configured sources. Entry detail reads enforce admitted source/kind and configured-instance correspondence for every caller. Source administration retains host-stamped write provenance: plugin callers stay within their own source; host create requires an exact admitted source address, while lifecycle operations resolve the source from their stored instance and reject an inconsistent supplied address. Selecting a surface does not change plugin write provenance.

Triage's [`administerConfiguredSourceInstance.ts`](../packages/plugins/triage/src/corpus/configuration/administerConfiguredSourceInstance.ts) owns configured-instance writes and the exact source-ownership comparison. [`readConfiguredSourceRows.ts`](../packages/plugins/triage/src/corpus/configuration/readConfiguredSourceRows.ts) supplies the shared active-row read and cursor handling. Discovery produces candidates, not automatic durable creation; mounted source Settings uses the administration Action rather than a direct Collection writer. The read ABI distinguishes complete from truncated results and refuses invalid or changed caller authority.

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
guard still refuses equal-version declarations with different contract digests.

The source plugin retains its private configuration-token encoding and provider-specific behavior. Triage business behavior stays in `packages/plugins/triage`; shared host code stays source-neutral. Do not use this schema package as a new source service, credential store or corpus persistence owner.

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
and code text inside its escaped data block. This avoids treating the four
bounded list facts as a complete advisory. Source text never chooses an Agent,
destination or permission policy.

Native dismiss/reopen Actions use current credential and repository proof,
preflight and readback. Lost responses settle through a confirming read, never
automatic replay. Their present-user confirmation exemption retains the
ordinary automated approval default and explicit Actions policy. Fix consumes
the shared configured Session handoff; no security-specific launcher exists.
UI composition and loaded-provider validation are separate program integration
checks; these source contracts do not establish release availability.

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

The same contribution protocol declares optional `create`, `edit` and
`transition` roles for task kinds. They bind ordinary source Actions with closed
inputs and outcomes and a remote-write approval default. A source declares its
editable fields and native transitions through the existing kind descriptor;
live entry facts may refine a dynamic workflow. Read-only sources omit these
roles and remain admissible. The executable layouts and public exports live in
[`tasks.ts`](../packages/triage-protocol/src/v1/tasks.ts), rather than a second
SDK or host Tasks API.

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

Task create, edit and transition controls follow the selected source's declared
roles, configured instance and host execution readiness. An age-stale list or an
unrelated unavailable source does not disable a ready task's controls. Pending
or unavailable execution follows the selected source's admitted Action. The
current authored aggregate and personal-source Actions select the shared Account
runtime described below; their portable loaded-client validation remains pending.
An external source's admitted operation retains its own execution placement and
may require a Machine. Account-data ownership alone does not select that
placement. The source Action retains authorization and confirming-read authority.

Task category is derived by the single public `triageTaskStatusCategoryV1`
mapper from the existing entry state, including its optional active stage and
terminal completion reason. Unknown or unclassified suppressed states remain
unclassified. Agent activity and waiting are still derived from linked Sessions.
Optional parent, children summary and blocked-by facts use the existing complete
entry reference. External sources materialize these relationships live; the
contract adds no provider mirror, task store or relationship writer.

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

A source can declare `taskCapabilities.completingTransitionId` to name an
offered native completed transition for one-step completion. Dynamic sources use
the public `triageTaskTransitionCapabilitiesV1` projection: a workflow with zero
or several completing transitions omits the quick choice. The existing
transition role and approval policy own the write. Runtime entry capabilities
replace the kind declaration, and an unoffered or non-completing id supplies no
quick completion. Mine includes source-declared assignee or author involvement;
mentions, subscriptions and participation alone do not qualify. Everyone and
Agents retain their existing task-kind and linked-Session meanings.

Sources whose own domain record owns task-to-Session relationships may bind the
optional `linkSession` and `readSessionLinks` roles. Both use the exact admitted
configured instance and source-local entry reference. The write role retains
remote-write approval; the read role returns complete current-Account,
current-Home relationships or an explicit source failure. An omitted role leaves
external-entry links with Triage's existing relationship owner. These roles add
no second link store or credential authority. Their closed executable inputs and
results live in
[`sessionLinks.ts`](../packages/triage-protocol/src/v1/sessionLinks.ts).

### Error-source writes (0.3 development source)

Sentry's [native write Actions](../packages/plugins/sentry/src/source/writeOperations.ts)
resolve, archive forever, or assign one issue. They use the existing exact-account
HTTP client, refuse a merge observed during preflight, and confirm the requested
status/substatus or assignee identity through a fresh issue read. PostHog's
[source operations](../packages/plugins/posthog/src/source/operations.ts) resolve,
assign, suppress, or unsuppress one issue through its configured Team route; assignment uses the
provider's separate assignment endpoint. Its confirming read uses authoritative
CRUD metadata rather than query-window enrichment.

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

Personal task item labels remain stored string
names. In 0.3 development, the authenticated Account's separate
`task-label-colours.v1` KV catalog stores `{v: 1, colors: { [name]: colorToken }}`
through the same Account-mode envelope owner. It stays outside `todo.*`, so
released item/order readers cannot mistake it for a task. No item rewrite or
second colour writer is needed.

`tasks.internal.labels.setColor` and `tasks.internal.labels.clearColor` change
that catalog with the existing KV CAS behavior. Inputs carry the captured
`scope`, exact label `name`, and (for set) a `colorToken`: `secondaryText`,
`accent`, `info`, `success`, `warning`, or `danger`. A missing entry projects
`secondaryText`; hex values are rejected. One catalog read joins each task-list
read, irrespective of the row count. Host results carry `labelCatalog` and
per-task `labelColors`; the source exposes optional sibling `snapshot.labelColors`
beside string-valued `snapshot.labels` for list, board and detail. These
observations are process-local/wire projections, never Collection values.

The built-in `internal` source in `happier.triage` reads the current Account's
existing unqualified `todo.<id>` records and `todo.index`. Its configured
binding uses `source: 'accountData'`; it has no Connected Account or machine
login. Explicit source setup still uses the same source-administration writer.
The plugin invokes the public `tasks.internal.*` host Actions rather than
reading plugin-namespaced KV or copying tasks into a Collection. The Protocol
[todo owner](../packages/protocol/src/todos/todoSessionLinkV1.ts) owns additive
fields, completion projection, and Session-link CAS; its
[Action operations](../packages/protocol/src/todos/todoActionOperationsV1.ts)
preserve the existing index ordering. Both authenticated transports enforce the
Account encryption mode. Earlier records without task refinements, including
bare Session-key links, remain readable.

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
can declare `descriptor.sessionRelations.kindIds` as a nonempty, unique subset
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

The portable Account activation owns one lazy retained-PR upgrade pass, started
by its first admitted relation read or write. It reads existing source ownership
and native relationships, verifies an already-native link's exact identity,
and conditionally retires only the exact retained corpus revision. It invokes no
relationship write Action or approval from a read. Non-PR rows remain at their
existing owner. Missing or uncertain native proof retains the original PR row
with incomplete coverage. Later successful exact native proof feeds the same
conditional contraction owner during scoped read reconciliation. Until that
proof exists, later reads retain diagnostic coverage and the original row;
they may also notice an explicit unlink's already-removed row. Ordinary explicit linking retains
the source's existing Action authority. Retirement cancels and drains the pass.
A failed or caller-cancelled initialization is retried only by the next admitted demand,
using that demand's authority; an overlapping fresh demand waits for the cancelled
pass to drain first. A successful pass stays memoized, and activation retirement
never restarts it. Unavailable source authority retains explicit incomplete
coverage. There is no background repair loop or operator migration command.
The upgrade acquires one configured/admitted view; its first requested live read
acquires a fresh view after that asynchronous pass. Subsequent invocations
acquire one view and do not repeat the corpus census.
Collection schema migrations remain pure row transforms and do not perform the
cross-plugin transfer. The inspected 0.2 predecessor has no persisted PR-link
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
placement. `unlink` revokes the exact retained binding and its scoped triggers
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
Changing the default does not escalate a retained binding. The local-reproduction
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
incoming blockers, comments and workflow states independently. Row facts retain
the existing snapshot bounds; the full metadata and description are live detail
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

The existing Account/plugin/generation ephemeral scope leases only the addressed page's callback. No React state, provider rows, or mount address is persisted. Choosing a saved view here applies its route lens, just like a shared view link; it does not write the Account's durable selected-view preference. Durable saved-view changes remain separately admitted Actions. An absent/inactive page or unavailable tab/selection/continuation returns `unavailable`; refused route settlement returns `rejected`. Agent/MCP callers require an answering mounted client; a headless CLI cannot operate another client's UI. Opaque current-context commands remain subject to the host's existing retirement and Action admission.

The same mounted dispatcher now reaches source-panel intents in development:
`selectSourceOccurrence` calls the source's incumbent selection controller, and
Sentry's `setSourceOrdering` changes its existing retained-event ordering.
`loadMoreSourceOccurrences` advances the active Sentry retained-events or
PostHog sampled-occurrences controller, so a later occurrence can then be
selected and inserted. The visible Load more button uses this same intent;
pending, exhausted or inactive panels return `unavailable`.
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

The existing `actions/administer-v1` Action also accepts `kind: 'reset'` with
the catalog's `expectedRevision`. It removes the stored catalog through Account
KV's conditional delete, so subsequent reads report `availability: 'absent'`
and use the built-ins. The KV tombstone retains its revision for later CAS;
reset does not fabricate the never-written revision `absent`. A stale revision
or unreadable catalog refuses the reset. Direct App transport and daemon Actions
use the same catalog owner.

The client-targeted `happier.triage/actions/sessions/run-configured-v1` Action runs a catalog `actionId` through the same configured action/profile/prompt and Session owners as a mounted press. Its exact input and result declarations are [`configuredActionRunProtocol.ts`](../packages/plugins/triage/src/actions/configuredActionRunProtocol.ts), not a second agent-only workflow. Callers supply exact `entries` (`entryRef` and `sourceInstanceId`) and a declared `destination`; optional settled `drafts` retain the host's canonical launch-input admission.

The unreleased source adds the single-target `{v:1,handoff}` arm, defined by
[`sessionHandoff.ts`](../packages/triage-protocol/src/v1/sessionHandoff.ts).
`requestTriageSessionHandoffV1` on `@happier-dev/triage-sources/runtime` validates
those operands and invokes this same Action once. Hosted CI, release-note
context, selected entries or alerts, and selected local terminal output retain
their distinct evidence shapes. Configured Session, Agent/profile and
compose/send choices remain with the existing catalog and Session owners.
The helper preserves the standard approval/failure envelope and action-owned
recovery; an uncertain send is not permission to start again.

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

An existing Session keeps its admitted Agent. A configured profile's preferred
Agent applies to new-Session authoring; it does not silently switch or reject
an existing Session. An incompatible explicitly requested profile or Agent
returns `agentMismatch`. Compose appends ordinary evidence through the existing
composer transaction and preserves its prior text, attachments, selection and
focus; an unavailable composer is not a request to send instead.

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
treated as permission to start again. Prepared-workspace recovery obtains a fresh
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

## Refresh and provider settlement (0.3 development)

Manual Refresh respects provider retry deadlines and the mounted store's active
single flight, not local aggregate failure backoff. Automatic view demand retains
its existing pacing in the same refresh eligibility owner.

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

[`descriptor.ts`](../packages/triage-protocol/src/v1/descriptor.ts) owns per-kind `detailTabs` and `detailActions`. Shared tab ids select the target's Overview, Activity, Files and Checks vocabulary; source tab ids keep source-owned names and append after the shared tabs. A source tab's optional `titleKey` resolves through that admitted source's projected translation bundle, with `title` as the fallback. Either tab arm may name a `summaryFact`: the id of a row fact the kind's snapshots already carry. Triage's tab plan ([`tabs.ts`](../packages/plugins/triage/src/ui/detail/tabs.ts)) reads that fact from the snapshot of the entry that renders the tab (the linked fix PR's own facts for an issue's Files and Checks) and the strip shows its value beside the title: a number in the reader's locale (`~` when approximate), a status in the shared status tone (`resolveTriageRowFactStatusToneV1`), text quietly; time, actor and detail-only facts and a missing fact show nothing. Current declarations: GitHub Checks (`github/checks`), Sentry Occurrences (`events`), PostHog Occurrences and Affected sessions (`posthog/occurrences`, `posthog/sessions`). No source carries a changed-file count as a row fact, so Files has no summary. Triage owns the frame and tab strip. A source renders the requested [`detail.ts`](../packages/triage-protocol/src/v1/detail.ts) `panel` through its existing detail surface; `detailActions: true` requests the `actions` panel in the header. Omission preserves the whole-detail path. A source using public Plugin UI `Tabs` consumes `tabList="host"` for a target-selected panel and `useTabPanelActivity().activeSignal` for retained asynchronous work.

The detail body keeps one mounted instance per entry/configured connection while
changing its `panel` input. Selection and settled evidence pages remain owned by
that source instance, never by Triage or a global cache. Public `Tabs.sharedPanel`
keeps a shared renderer mounted behind a changing strip; source host-mode Tabs
apply their own declared retention and end hidden panel intervals. Switching to
the linked PR or Session also withdraws the entire hidden source slot's activity.
Changing or retiring the entry destroys its source instance. The Overview rail's
`ScrollArea` stays mounted but disables scrolling for bounded source panels, whose
own collections then own the viewport.

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
or truncated evidence stays unknown. Conflict freedom, optional failures and
an empty emitted-check list do not establish readiness.

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

The development `session-pull-request-status-v1` Resource retains each admitted
Session binding, Watch policy and latest update independently of native status.
When its existing unique Source-admitted Session/locator correspondence supplies
canonical entry identity, the binding also carries optional
`entry: { entryRef, sourceInstanceId }`. This is a navigation selection, not an
authorization grant. Missing or ambiguous correspondence omits it; a valid
Channels binding need not have a Triage entry. No extra lookup or provider read
is performed, and consumers must not synthesize an entry from a URL or PR number.
When the relation owner retains one linked entry but omits its configured-source
identity (including when several configured instances report the same relation),
the PR Resource reports `sessionLinksSourceInstanceRequired`, not
`configuredSourceUnavailable`. Relation reads and link navigation can still work;
native checks, review and merge status require one selected configured authority.
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
[`projectGithubPrimaryWriteV1`](../packages/plugins/scm-github/src/ui/detail/mutations.ts)
consumes the admitted Overview status and repository capabilities, sharing the
native requirement classifier with mutation admission. It offers the existing
Merge/Mark ready Actions and native enqueue/dequeue/auto-merge Actions through
that same bridge. Those header facts and the offered callback belong
to the detail mount, not its selected body tab: switching tabs neither withdraws
the offer nor starts another Overview read. Retiring the detail still cancels its
reads and prevents a captured callback from writing.

The [native merge owner](../packages/plugins/scm-github/src/triage/mutations/pullRequest.ts)
reuses the fresh admitted PR/status decision before effects, including for agent,
MCP and CLI calls. Known unmet requirements refuse ordinary Merge with named
`requirements_unmet` evidence and zero merge writes. Unknown requirements remain
unknown in presentation, while an otherwise admitted ordinary Merge lets GitHub
enforce them. Explicit `withoutWaiting` uses that same Merge Action and requires
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

GitHub's native outcome policy remains
[`readGithubCheckOutcomeV1`](../packages/plugins/scm-github/src/triage/checkOutcome.ts),
including its readonly failed and neutral conclusion sets. PR summary rollups,
Checks and hosted CI consume that policy: a failure wins, an unfinished member
prevents success, and unknown evidence cannot establish success. The provider's
account request owner supplies shared backoff and simultaneous safe-read sharing;
Triage keeps its own domain projections and demand rather than retaining settled
transport promises.

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
read/watch lifecycle. The host's canonical Work bucket `working` supplies
`agentActive` to the existing list planner. Required attention still takes
precedence, and Pinned remains a separate leading section, including retained
pins outside the current window.

The join refreshes with mounted window acquisition, manual refresh and return
activity; Session invalidations re-read through the host. It creates no durable
projection or polling timer. Incomplete or unavailable
activity is shown in the list with an explicit retry. A failed link acquisition
keeps previously known relationships without claiming that missing entries are
unlinked; unreachable Session facts are not classified as working. A mount
without the Account Data client can still use the same portable Account Action;
it does not substitute a broad daemon inventory read.

## Related

[Plugin platform](plugin-platform.md), [Actions](actions.md), [Collection presentation](collection-presentation.md), [encryption](encryption.md), [compatibility](compatibility.md).
