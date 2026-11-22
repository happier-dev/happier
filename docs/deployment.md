# Deployment

## Account erasure (0.3 development)

`purgeRetiredAccountDeploymentGraphInTx` owns deployment cleanup for whole-Account
erasure. Erasure asks this owner for a read-only precondition before retirement,
then calls its purge after external blob cleanup and before Artifacts and Machines.
Erasure itself deletes no deployment rows.

Only a solely Account-owned, dependency-closed graph is purged. Source ownership
and audience come from the Source owner; receipt occupancy and native absence
come from the existing receipt and teardown owners. A tombstoned Environment
still needs complete teardown evidence for its targets. A running workload or
retained provider resource still needs cleanup. Live controller custody,
in-progress work, foreign or Team ownership, shared content, or incoming foreign
lineage refuses the purge without deleting part of the graph. The HTTP 409 code is
`account_erasure_deployment_cleanup_required`; finish teardown or resolve the
shared dependencies before retrying.

Settled Receipts belong to their Environment's history. Erasing the requester
clears their attribution. Erasing the Account that owns a settled Receipt's
private Artifact deletes the Artifact and clears the Receipt's content reference.
The retained header records the operation, outcome and dates. Receipt detail
shows that the private details were removed. Failed private-object cleanup
leaves Account erasure pending so it can be retried.

After teardown and sharing withdrawal, either Account can erase first. If the
Environment owner goes first, their Receipts disappear with the Environment
and the other Account keeps its own Artifact until it erases. In-progress
Receipts still require their Artifact and can block erasure. The 0.3 development
server migrations make both requester attribution and Receipt content custody
nullable. Clients on the same cut can read the retained header without an
Artifact.

## Browser exception setup (0.3 development)

“Add telemetry to this app” supplies the agent with copyable app code in the
existing setup brief's evidence. The agent adapts the global `error` and
`unhandledrejection` listeners and `POST /api/telemetry` Web Request handler to
the app's framework. Install listeners once, preserving the app's own handlers.
Static-only apps need a server/edge route or an existing error integration.

The browser sends only exception fields to its own origin. The app route uses
the existing P6 server-side collector settings, stamps the served browser build's
`service.version` and Environment, and forwards structured OTLP logs through the
existing receiver. Never expose collector authentication in a browser bundle or
Session. Apply the app's existing ingress/body/abuse policies to this public route;
an Origin check alone does not authenticate visitors. Reporting is best effort:
forwarding failures return an empty failure response and never break app handling.

Exceptions must be selected on the Environment. Ingest owns redaction and grouping
once; the native issue writer and Team Collection sharing remain unchanged. For
minified evidence, investigation uses the matching release's repository/build and
local source map. Missing or mismatched builds remain unsymbolicated; there is no
source-map upload service. Verify setup with a controlled throw and rejection
outside spans, then inspect the selected occurrence and its release.

## First repository deploy (0.3 development)

Before proposing a new checkout, Deploy confirms an apparent absence with the
Home. This lets it reuse a matching checkout registered by the CLI or another
client while the app is still waiting for that row's update.

The app's Environment Deploy gesture joins the pending read of its exact Source
before preparing a local checkout. When the controller has no matching checkout,
the gesture runs the existing `projects.open` Action before dispatching
`deployments.deploy`. It uses Open's destination suggestion and input builders
and the person's ordinary destination review. An Open refusal or uncertain
outcome stops the sequence. When the typed Projects Open refusal names an
unsupported hosting provider, the Deploy panel includes its display name.
Stored definitions and provider Git integration do not require this checkout
step. Deploy itself never opens a checkout internally.

If Upload cannot clone a Source, the Deploy panel shows the checkout failure and
its repair step. The failed checkout is recorded by Projects Open. A deployment
receipt begins only after Deploy is admitted.

When a direct deploy Action needs a checkout, its refusal returns the complete
`projects.open` input for that Source and Machine. This also covers an old checkout
record whose directory or repository is gone. Open uses the same destination
suggestion and runs with its own review before the person retries the deploy.

## Declared platform plans (0.3 development)

The optional `deploymentTargets[].plans` contribution carries provider-authored
plan facts: `id`, `title`, an optional structured `price: { amount, currency,
unit }`, `facts: ({ label, value } | { label, price })[]`, optional
`included: string[]`, and `source: { url, checkedAt }`. `checkedAt` is an ISO
calendar date. Every `price` uses the shared `ProviderAmountV1` shape
(`packages/protocol/src/common/providerAmountV1.ts`), which Machine provider
prices also use. The schema refuses a fact labelled `Price` and any text fact
whose value writes money ("$0.30 per 1M"), so a manifest states every price as
data. A starting price with usage on top is the plan `price` plus priced usage
facts.
The contribution schema owns this closed shape; the normalized target consumes
the same schema. Omission leaves existing targets unchanged. These are dated
public facts, not a quote, live pricing feed or price calculator. Render only
declared facts and retain their source and checked date. The shared cost presenter
(`formatDeclaredPlanPrice`) is the only formatter of `price`. The plugin owning the
target owns updates to its facts.

Matching Protocol, SDK, deployment-protocol and bundled declarations reload
together under the unpublished 0.3 direct cut; earlier strict development readers
reject `plans`. No released wire epoch, authority, migration or adapter changes.

## Describe your app auto mode (0.3 development)

Auto mode has one catalog owner and one validation owner shared by the Deploy an
app dialog and the `happier:deploy` Session skill. The
`deployments.suggestions.catalog` Action composes the current starter and catalog
app listings, deployment target facts, Stores, Machines and their readiness,
connected-account metadata, and forge descriptors. A Store is a managed database
data target that declares its engine (`dataV1.database.engineId`, for example Neon
and Supabase for PostgreSQL), offered by its target id, engine and title; a
suggestion's `data: {kind: 'store'}` names that target, and the build Session
creates the database through the target's own data Actions. A platform target's
availability comes from the connected service its inspect Action's `credentialRef`
purpose declares (`readPluginActionCredentialPurposeV1` in `@happier-dev/deployments`,
used by both hosts' catalog ports): `available` when the Account holds any
connected account for that service, `needs_connection` when it has none, and
`unknown` when the connected-account read failed. Where it runs' Connect uses the
same rule (`holdsConnectedAccountForService`): a broken account needs a reconnect
from its attention state, never a second connection. For `needs_connection` the
dialog's card says "Connect <platform>" and its build brief adds the connect step;
the `happier:deploy` skill guide tells the agent the person must connect the
platform before the first deploy. A target that needs a connection stays
offerable. Each source remains owned by
its existing registry, Machine, target, connected-account, or SCM plugin owner.
The catalog is a snapshot held by the caller for the suggestion round. The dialog
rereads it once on the first follow-up after the Account's connected accounts
change (a connect, a removal, or an account breaking or being reconnected); later
follow-ups reuse it.

Saving a token alongside a Saved Secret publishes the connected Account profile
after the credential and resource commit together. Configure waits for that
exact connection before loading provider choices. If the profile is unavailable
or doesn't contain the connection after a foreground read, Retry reads the
profile again without saving a new token.

The UI obtains forge descriptors from an own reachable Machine through the same
Action with `{ projection: 'forges' }`. This projection reads only the activated
SCM publishing-provider owner; the other catalog collections stay empty and no
registry, connected-account, Machine inventory or setup-plan reads run. A failed
publisher read retains its typed code in the `forges` issue. The default `{}`
input continues to compose the full catalog.

The dialog uses a `no_tools` run on the first eligible Machine whose Agent can
run the `deploy_suggestion` task. An explicit Agent that the Machine catalog
knows cannot enforce `no_tools` produces the existing runner-unavailable result.
The run's working folder is that Machine's
home folder, which always exists; nothing is created on the Machine for it. An
online Machine whose record is still opening (no name or home folder yet) is not
called unavailable: the suggestion waits on the Machine owner's update
subscription until the record opens or settles unreadable, and Stop ends the
wait. Its input contains the person's description,
the catalog snapshot, and, when variable metadata is supplied, names with secret
flags rather than secret values. When the catalog is read for a suggestion while
the app shell still owes registry sources (`registrySourcesPending`) and no
enabled starter source is known yet, the read waits until one is known or that
fact settles, so starters supplied by a Machine are not dropped. The wait and the
registry lists call the same selection predicate (`selectRegistrySources`): built-in,
plugin and received user sources, enabled only. A Machine still owing its sources
can only add more of a known kind, so it does not hold the read up. The wait reads
the registry-sources record as received and never waits for that record itself;
the catalog read fetches it.
The run can return typed questions in the existing transient question shape. The
result schema given to the model, which the run also enforces before the check,
offers selection bounds on multiple-choice questions; on single choice it admits
only bounds that restate it (minimum 0 or 1, maximum 1). That rule is
`SingleChoiceRestatedBoundsV1Schema` in the question owner, and the check strips
the same bounds through `omitRestatedSingleChoiceBoundsV1`. The
dialog renders those questions in its existing form, and an answer starts a new
round against the retained snapshot. A connect explicitly rebuilds the catalog.

The runner is the `deploySuggestionRunnerV1` setting, the background-task runner
picker that Settings shows as "Agent for app suggestions". When a suggestion run
fails on a usage limit, the failed step says the limit, names the Machine it ran
on, and renders that same control for the next Try again. While the stored choice
is Auto, the picker opens on the runner that hit the limit, so its Runs through
choice lists that Agent's other routes. Picking one writes an explicit runner
through `settings.set`; nothing is written until the person picks, and Auto never
reads quota to route around a limit.

Both hosts admit the model result through one validator,
`validateDeploySuggestionV1`. The dialog calls it directly against the snapshot
it gave the run. A Session agent calls `deployments.suggestions.check` with
`{ suggestion: { recommendations: [...] }, description? }`: the Action reads the current
catalog itself through the same composition as `deployments.suggestions.catalog`,
because an agent cannot echo the whole catalog back as tool input (a live catalog
measured 131 KB, almost all of it catalog apps). Its result carries the catalog
it checked against, with catalog apps kept only when a surviving card names them,
for the transcript cards and the dialog they open. The check's input is strict
and typed by the recommendation schema, so an agent reads the shape from the
Action spec. A bare array, a wrong shape, or a recommendation missing a field is
refused at admission with `invalid_parameters` and the issue path (for example
`['suggestion']`), and the agent corrects its call. One schema-invalid
recommendation refuses the whole check rather than being dropped. In the dialog,
the run's result contract enforces the same schema before the validator sees the
result. Every recommendation requires a `title` (a few words, the card's title)
and a `why` (one sentence on why it fits, the card's second line), so a card names
the setup in the person's terms instead of by ids; the price scan covers both.
The validator then drops unknown ids, price text, and incompatible
source/target/forge pairs, and returns the validated recommendations, dropped
reasons, and any questions. Model questions are external input: single-choice bounds that only
restate single choice (minimum at most 1, maximum 1) are removed before the
shared question schema admits them, and a question it still refuses is dropped
with a typed `droppedQuestions` reason. When nothing is left, the dialog keeps
those reasons under Details. Cards are rendered from that checked result and the catalog facts.
No model-written price is displayed.

Target plugins declare dated plans with a public source URL. The catalog carries
each target's declared `plans` for the model to read. Setup cards in both hosts
take a target's plans from the Account's own deployment-target declarations, by
the recommendation's target id, never from the catalog a check result carries. Cards, Where it runs and Review render them through one plans
component: the shared cost presenter prints every structured price and the
checked date, and the other facts print as declared. Review alone adds a `Your plan` line, because the connected account is
chosen after Where it runs. When the selected Vercel or Cloudflare account exposes
a provider plan through its existing `quota()` read, the UI matches that name to a
declared plan by id or title, ignoring case and separators. Cloudflare reports
`Workers Paid`, which matches only the Workers plan id `workers-paid`. An absent
or unmapped plan leaves the declared facts visible without that line. The plugin
plan-id mappings are exact and are confirmed against live responses only at the
release check for account plan lines.

`Use this setup` routes through `applyDeploySuggestion`. A starter or scratch
recommendation uses the existing forge compatibility read, defaults to GitHub
when it is an offered choice, and creates the repository, Source, and Project
through `projects.starters.create`. That Action receives the description the
person reviewed in the dialog, byte-for-byte, followed by `renderDeployPlanBriefV1`.
`renderStarterSessionMessageV1` appends the Project this creation made, by
`projectId`, `projectSourceId` and `repositoryUrl`, and says that deployment
Actions take that `projectSourceId`, so the build Session deploys its own Source
rather than another Project's. Then the existing
`sessionHandoff` opens the build Session's first message in New session, where
the person's Send starts it (`session.authoring.open`). A modal New app steps
aside; the page settles on Project ready and says the agent starts when that
message is sent. The Session runs the project's own scripts, creates a preview
Environment, deploys the preview, and checks health. The brief's preview step
(`DEPLOY_BUILD_PREVIEW_RULES_V1`, also in `references/create-app.md`) asks for a
non-production, standard-purpose Environment with the Project's Source. Only when
the chosen target is Own server does the brief add
`DEPLOY_BUILD_PREVIEW_OWN_SERVER_RULES_V1` (the guide labels it Own server): an
own server deploys the repository's Compose file, so the agent adds
`compose.yaml` when the starter has none, and the brief shows the admitted
`deployments.environments.create` input with that Compose file and the Machine as
controller and first target.
Review shows the observed preview URL and health. Production remains the
person's ordinary reviewed step. A catalog-app recommendation and the dialog's
existing repository, image, and Compose doors are pure deploys and continue to
the existing Where it runs flow without a build Session.

Back on the creation review returns to the suggestion cards, kept, with no new
run. That holds while the draft is still the chosen setup: its starter, or no
starter for a scratch setup. A starter the person then picks by hand is not that
setup, so one decision in the New app screen (`suggestionForDraft`) makes the
review read as Describe, Create send no plan brief, and Back return to the source
step.

The built-in `happier:deploy` skill points to `references/create-app.md` on
demand. That reference uses the same catalog, native Session questions, check
Action (which takes the person's words unchanged as its optional `description`;
Use this setup opens the dialog with them, or with an empty description the
person fills in when the call carried none), cards, starter/scratch creation, and build → preview → health loop. The
flow budgets and deciding evidence for F1–F8 live in
`.agents/skills/happier-performance/references/flow-budgets.md` under the
`journey-deploy.F1` through `journey-deploy.F8` rows.

## Activity selection (0.3 development)

The existing `readDeploymentActivityPage` accepts `actorAccountId`,
`kind: 'receipt' | 'operation'`, `requestedAtFromMs` (inclusive) and
`requestedAtToMs` (exclusive), alongside its existing placement and cursor
selectors. Receipt history applies requester and requested-time predicates in
the server storage query before pagination. Action operation history applies
requester and the corresponding created-time predicates at the daemon store
before pagination. The shared Activity owner merges those pages and keeps a
receipt as the canonical representation of its observed invocation ID. A retained
receipt reference alone does not identify the same invocation: repeated teardown
can have a different operation and requester. Operation-only demand reads one
receipt page for observed matches; an unobserved older receipt can leave its
operation visible, without a full receipt census or inferred identity. Pages
pass selections to this read rather than filtering the rows they already hold.
Filtered Action operation reads require the current V2 RPC and never downgrade
to a released V1 reader that cannot enforce the selection.

## Prepare with an Agent (0.3 development)

Project, Environment and creation-draft Prepare/Import entries use the returning
Session recipe composer. Its shared Session authoring controls select the Agent,
Connected Account and other launch choices for the workspace Machine. Cancelling
the recipe starts no Session and does not change Account defaults.

`deployments.prepare` takes either a canonical `sessionDraft` or an existing
`sessionRef`. A fresh recipe must retain the reviewed workspace Home, Machine and
directory; a changed placement returns `input_changed`. The ordinary Session
creation owner handles authentication and launch. Continuing a returned Session
uses its ordinary message Action. The preparation brief contains source intent,
without copying the launch recipe or Connected Account references into messages.
The signed child-purpose owner carries the admitted Prepare root through its
reviewed Session child: a fresh child can read the selected Machine codec, and
a continued child can read Account encryption currentness and its exact Session.
Host, Session and Workflow callers use that same owner. Ordinary Session birth,
access and input owners retain their decisions; no additional permission or
Account encryption-mode decision is made by Prepare.

Approved replay retains the original bound envelope and the receiving Machine's
host-private admission through the shared approval executor. The Session birth
issuer consumes those facts for its existing child proof; consent does not
reconstruct them from approval operands. If that proof cannot be issued, the
Action receipt retains `session.creation.authorization`, `permission_denied`
and `effectAttempted: false` before any Session launch.

Reviewed provider children also retain the admitted deployment root's finite
workspace census purpose. Home's native preparation owner selects workspace
references on that Home; the Project-row route keeps Account isolation. This
read spends the existing active deployment receipt, without provider-specific
permission rules or a new admission.

Cross-Environment saved service references retain the selected Environment in
the existing host-reviewed read child. Its signed `environmentId` must match the
child's Action input digest. The shared preparation scope opens only that
Environment's metadata, owned content and Machine codec reads while the root
deployment runs. Source and Artifact access remain with their resource owners;
the reference does not inherit the root receipt's content custody. The signing
Machine's custodian chose the operand, so when that custodian is not the
requester (a Team member's Machine, or a controller another person owns) the same
owner also requires the custodian's own Account to read the referenced
Environment; otherwise Home refuses with `verification_purpose`. A requester's
personal Environment is never readable from another person's Machine. Member
activation always runs as a forwarded `member` child (even on the controller's
own Machine), so the member carrier signs this one reviewed read too: the child
packet plus the `deployment.reference` proof, effect `deployments.environments.get`
only. Home admits that pair solely through the same reference-purpose owner; any
other reviewed child on a deployment child carrier stays refused
(`deployment_child_http`), and the carrier records `forwarded_child_purpose`
locally when it declines to sign. Matching
Protocol, daemon and Home builds are required for this unpublished 0.3 proof
projection; older strict development peers reject the added optional field.

The Prepare read composes reported Session work state, structured SCM Action
results and the Session's linked pull requests. Forge owns PR status and checks,
including closed and merged PRs; an open-PR-only checkout summary is insufficient.
Missing or unreadable facts stay unknown. A reported push or PR refusal retains
the SCM owner's outcome and recovery actions, without interpreting transcript
prose or promising that a branch or remote effect was preserved. Creating a PR
does not establish build or health validation, or make the source deployable.
The read adds no waiting operation or polling loop. UI composition consumes its
typed result; continuing after merge still requires ordinary Source review.

This unpublished 0.3 input cut requires matching UI, Protocol and daemon source;
older development readers reject the added draft. The 0.2 predecessor has no
Prepare Action contract. No persistence migration or compatibility adapter is
introduced.

## Advisory deployment preflight (0.3 development)

Configure uses `projectDeploymentConfigurePreflightV1` for name, port and hostname
syntax. The same projection is returned as `configurePreflight` by
`deployments.publish.prepare` when its optional `configure` draft is supplied.
Fields retain `valid`, `invalid` or `notProvided` and a normalized value; these
facts establish neither name uniqueness, free listeners nor DNS resolution.

`readDeploymentPreparationFacts` combines those facts with the existing
`projects.inspect` Action's `read: {kind: 'applications'}` projection when a
qualified workspace is selected. `detection.applications` contains each package
file's recognized framework, declared Node engine, build/start references and
unambiguous literal start port. Unknown declarations stay null; command bodies
are omitted. The read resolves no tools and requests no setup review. Configure
edits can use the pure projection without repeating inspection. These unpublished
0.3 additions require matching UI, Protocol and daemon source; no migration or
Prepare-to-PR progress inference is introduced.

The Promote data hook compares the selected source and destination Environment's
P42 variable-binding identities, including build/runtime phase. Its warning data
contains names, phases and secret flags, never values or secret references.
It shares two exact controller reads while demanded; read failures retain their
cause rather than becoming an empty missing-input list. Native admission and
secret acquisition remain authoritative. Surface composition is separate.

P30 `machines.services.list` accepts an optional `preflight` selection of published
port numbers and adapter-qualified native resource names. It returns only matching
retained managed-service rows with `coverage: 'managed_services'`. The existing
Resource follows matching entries and exits; no scanner, watch establishment,
native accounting sample or UI inventory read is introduced by this selection.
Port matches are advisory candidates: protocol, bind address, freshness and state
remain in the rows for review. Display labels and Compose service labels are not
native names; container target ports are not published ports. Empty matches do
not establish Machine-wide clearance, since unmanaged listeners and unobserved
native resources are outside this projection. Add preview projects declarations
from P60's final allocated source through the canonical syntax parser. Short-form
and interpolated ports remain declarations; only literal numeric long-form
publications feed the exact selector. Native effective ports and runtime names
remain unresolved until first start. The UI does not evaluate Compose syntax or
treat unresolved coordinates as clearance.

## Destination activity and scoped inventory (0.3 development)

Environment collection pages admit private Environment Artifact headers through
the Artifact access owner before selecting the visible page. Source-controlled
sharing and E2EE recipient-envelope availability use that same admission. The
reader continues through inaccessible candidate windows so they do not consume
visible slots or leave empty tail pages. Work follows examined candidates in
the existing page-sized batches. The optional `includeTotal: true` demand also
scans the full query selection through that same header admission and returns
`totalCount`, excluding cursor and page size. Ordinary reads avoid this census.
The total is omitted when projection is incomplete, and is carried by the
collection controller and `useDeploymentCollection` with the same Account and
query identity as its rows; consumers do not count loaded pages.
Malformed readable records retain the collection's partial-coverage behavior.

The Account deployment activity projection counts readable, non-deleted Environments
whose latest attempt is running or failed. It uses the existing Source admission and
receipt-state projection, one aggregate read and the existing Account invalidation
push. It never counts a partial inventory page. Equal activity publishes no change;
hidden badge demand performs no reads. The destination catalog names this signal
`deploymentAttentionCount`; `useDeploymentDestinationSignal` exposes its count,
read status and recovery from the shared Account controller. A missing count is
unknown, including a peer that returns only the earlier boolean projection.

The UI History transport opens the visible receipt page through the Account's
mode-aware Artifact reader in a batch. `projectDeploymentReceiptHistoryEntryV1`
exposes controller and Machine member `steps`, preserving their labels, states
and recorded timing; member steps carry `machineId`. This is a client read
projection, with no added receipt storage or per-row operation read.

Development receipt content records private `actor` references at the admitted
root's first execution transition from `operationAcceptance.actor`. The Action
operation owner captures the admitted cause and updates it with the actual
approval before dispatch; receipt writers do not classify child contexts. The
common Action attribution owner selects
the authenticated approver, the present person's admitted trigger, the Session
Agent, or the Workflow Run. Agent and Workflow `onBehalfOf` people retain both
Home and Account IDs. Observation and recovery preserve captured attribution;
older content without it remains unknown rather than classifying its
`requestedByAccountId` as a person. History, Activity and the collection's latest
deployment consume the same receipt-facts projection. Actor names remain with
the existing people, Session Agent catalog and accepted Workflow metadata owners;
`useDeploymentActorPresentations` composes those demanded names, including the
Account owner's unknown-person fallback. Names are never copied into receipt
metadata or public server columns.

`useDeploymentBackupFacts` optionally reads native backup inventory for requested
source IDs and exposes `restorePoints` as a ready count or unavailable. Receipt
history never establishes how many snapshots remain after pruning or deletion.
The existing explicit reload refreshes the count; hidden demand adds no reads,
and a changed Account lifetime cannot retain the previous Account's facts.

Account-wide Domains and data-service pages use `deployments.domains.page` and
`deployments.data.page`. Each demanded page includes its Environment headers and
caller-authorized Artifact content in one response. The PostgreSQL reader captures
Source, Team credential and Artifact facts in one statement, then applies the same
access evaluators as per-Environment reads. Account-owned, shared and Team content
remain visible according to those evaluators; a page introduces no new audience.
Opaque continuations advance beyond denied candidates without exposing their ids.
Unavailable private content gives partial coverage. Data services derive from the
existing Environment content; they have no separate Database record. These page
leases retain the controller's demand, invalidation and explicit continuation;
they do not acquire per-Environment health observers. Surface composition remains
separate from these nonvisual readers.

The selected database detail requests `acquireDataServicePage({ environmentId })`
through the same controller. This local read uses the existing Environment metadata
and Account Artifact readers, then the same database size and subject projection.
It does not depend on the current Account page or advance its cursor; Account-wide
callers continue to use the paged query without `environmentId`.

The Account Domains page carries the same admitted `projectSources:[{id,name}]`
projection as the Environments inventory. Its opened items expose
`environmentTitle` and `projectSourceName` through the shared Environment
presentation reader: private titles come from the bundled mode-aware Environment
Artifact, while Source names retain their existing disclosed-metadata contract.
Legacy responses without Source presentation yield a null name. No row requires
another Environment, Artifact or Source request.

`useManagedInventory` accepts optional `kinds`: omission retains the complete
inventory, an empty list acquires no families, and requested families retain their
native coverage and continuation. Configured backups borrow the App page without
exposing unrequested App rows. Store Installed retains the complete inventory,
including configured checks, backups and setups.

Configured checks expose `lastResults` from the saved health observer's existing
encrypted Account KV checkpoint. Each result retains its check id, status and
actual probe time. Equal later observations do not republish solely for clock or
latency changes. The demanded reader acquires one `health:` page, follows Account
KV pushes, and exposes explicit continuation. Loading, never observed, not loaded
on the current page and unavailable remain distinct from a failed check. Matching
uses the Automation id, trigger id, trigger revision and source selector, so an
edited check cannot inherit an earlier configuration's result. No new probe,
schedule or health evaluator runs for this view.

## Home target admission (0.3 development)

Deployment Actions normalize the selected local profile to its admitted portable
Home identity before preparation, destructive review, input digests and signing.
The local profile remains available in invocation context for route and credential
lookup. Backup/restore hosts and storage consume the canonical target; Machine
and installation binding remain separate. Admitted repository workspace matching
uses the same profile/Home relationship for both target and stored references,
and refuses foreign or ambiguous workspace identities before effects.

## Domain DNS readiness (0.3 development)

The existing `deployments.domains.verify` Action supports finite draft inspection
with `mode: 'preview'`, as well as signed verification of an attached Domain.
Draft inspection selects the admitted own-server ingress without creating a
Domain or Artifact or preparing infrastructure. Unsupported provider, tunnel or
private-only ingress returns an unavailable result rather than a native proof.

P41 resolves the hostname and uses the existing native Caddy writer to insert an
exact temporary host/path route serving a random token on its public HTTP
listener. A single request through the hostname must return that token without
following redirects. The writer removes the exact challenge after success,
failure or cancellation. No record, a resolved name that did not return the
challenge, and a matching challenge are distinct outcomes; resolver, transport,
admin and cleanup failures retain their unavailable causes. Tokens and response
bodies are excluded from published evidence. A same-Machine observation proves
this route from its vantage; it does not establish outside-network reachability,
application health, certificate validity or a public-IP record value.

Attached public-listener Add and Verify observations use this finite proof before
the existing signed P40 semantic settlement. Private-origin observations omit the
inapplicable public proof. Both surfaces consume the same typed DNS projection.
The nonvisual Action adapter
performs work only on explicit demand; the surface owner wires open and manual
Check again. There is no polling, background registry or public-address discovery.

The separate `deployments.domains.dns.create` and
`deployments.domains.dns.verify` Actions consume required records already retained
in a provider Domain's `providerObservation.dns`. The person selects the DNS
Action, Connected Account, hosted zone and TTL for that operation. The Domain
owner groups records by name and type and dispatches them through ordinary
reviewed children; it neither derives addresses nor keeps a DNS registry.
Native Domains return `required_fact_unavailable` for `domain_dns_records` from
`expected_ingress`: the token challenge above does not produce record values.

The Cloudflare plugin exposes `records-create` and `records-verify` through that
same reviewed DNS role. Its zone picker supplies the Action identity alongside
the connected Account's zones. Creation adds missing DNS-only records and leaves
incumbent records intact; verification reads configuration without writing. A
lost write acknowledgement returns an unknown outcome, so inspect configuration
before retrying. Public DNS propagation and provider activation still use the
Domain's existing Check again operation. Other DNS hosts retain copy-records and
verification without an automatic write path.

The Route53 plugin uses the public Connected Account environment materialization
contract for AWS access keys and an optional session token. Authentication checks
the account's connection test hosted zone; each Domain operation selects its own
destination hosted zone. Each explicit record Action signs requests with
SigV4. Creation uses AWS `CREATE`, preserving incumbent records. A lost write
acknowledgement returns an unknown outcome; inspect configuration before retrying.
Verification reads one exact name/type record set and compares its TTL and values.
A match means configured, including AWS's pending configuration; it does not mean
public propagation, Domain readiness or application health. A returned change ID
can be inspected explicitly by the leaf Action without polling. See the
[AWS change API](https://docs.aws.amazon.com/Route53/latest/APIReference/API_ChangeResourceRecordSets.html)
and [record-list API](https://docs.aws.amazon.com/Route53/latest/APIReference/API_ListResourceRecordSets.html).

## Platform variable roles (0.3 development)

Vercel and Cloudflare platform targets project variable names, presence and
ownership through the deployment binding Actions without returning provider
values. Synchronization preserves unowned keys and other provider environments;
provider metadata without a revision cannot establish external drift.
Secret-reference writes acquire the exact Saved Secret revision through
invocation-bound `services.secrets.readSavedSecret` and construct an ordinary
HTTP body. Host custody registers redaction before returning material; the HTTP
owner blocks cross-origin secret-body replay and the invocation owner sanitizes
results and logs. Missing authorized key-holding E2EE custody returns
`secret_use_client_required` before the affected provider write. Plain-value
writes and owned-key removal use the same provider adapter roles.

## Platform runtime logs (0.3 development)

The canonical `deployments.logs.read` Action uses the retained provider deployment
and admitted controller. Platform callers supply `serverId`, `environmentId`,
`deploymentId` and `kind`; the receipt supplies the target and controller routing.
Machine log callers retain their target link, Machine and installation coordinates.
Platform logs need no fabricated Machine coordinates or Compose service.
Vercel's adapter incrementally reads its first complete runtime frame, returns a
finite page marked incomplete, and disposes the provider body. A quiet response
remains cancellable by the containing read. The existing `readResource` path
consumes this same Action and finite result.

Follow uses the declared Action's existing read observer and the existing native
log watch. The generic Resource subscription `pages` event carries finite content
to that watch's own subscriber. It never re-executes the initial read to recover
already-emitted frames. Rereadable Resources continue to invalidate normally;
no watch-slot selector, history cursor or background log store is added.
The Environment Runtime companion uses the same native/Forge log viewer as
Machine service and deployment-step logs, including Find, copy and save. Hiding
the pane or pausing Follow releases its existing watch demand; Retry reopens it.
Partial rows remain visible after recoverable failure, with an incomplete notice.

Vercel's documented runtime endpoint is a live `application/stream+json` response.
It provides no historical paging or resumable cursor. The adapter's line framing
uses the official CLI endpoint consumer as characterized in its recorded fixture;
build events remain a separate request. Normalized row fields are retained in
the native page's text, and optional row identity supports display-only duplicate
suppression in the existing native projection. Initial read and a reopened live
stream can overlap or leave gaps; neither identity nor Follow promises replay.
Provider tenants, permissions, stream framing and retention remain release checks.

## Platform upload evidence (0.3 development)

Vercel promotes a Preview deployment by rebuilding that exact deployment for
Production through `POST /v13/deployments`. The receipt observes the new native
deployment ID and settles when Vercel confirms production traffic. For a selected
Production deployment, the adapter uses the existing `POST /v10/projects/{projectId}/promote/{deploymentId}`
alias operation. A `READY` build with a pending alias remains in progress. Once
Vercel's project names the rebuild as its current Production target, the exact
deployment response can confirm alias assignment while the project's alias fields lag.
[Vercel promotion guide](https://vercel.com/docs/deployments/promoting-a-deployment)

Cloudflare **Create new** enables the Worker's public `workers.dev` route when it
creates the script and leaves preview URLs disabled. **Use existing** observes and
preserves the existing route configuration. After Cloudflare confirms the version
is serving and the route is enabled, Happier makes one public GET to the Worker's
name and the account's actual subdomain. A successful response or redirect confirms
the address for the receipt. A disabled route records an empty list. An unsuccessful
address check leaves the address unknown and keeps the confirmed deployment result.
A serving platform receipt with no provider URL leads to the Environment's Domains
page. Platform receipts use platform outcome copy and omit Machine execution and
Docker image-retention facts.

Platform deployment targets expose their declared Git integration and Upload methods through the shared target chooser. The selected method goes to inspection and the existing `deployments.deploy` intent; choosing Upload does not grant provider Git access or permit arbitrary local-folder publishing. Both methods retain the repository Source and reviewed immutable commit. Vercel uploads source for a remote provider build. Cloudflare Workers and Pages prepare output on the controller through their shared pinned container/toolchain owner, without attaching the platform's variable bindings to local Exec.

Provider Create, Inspect and Link Actions return the authored `sourceMethod` in the TargetLink's existing protected provider content; UI, CLI and agent callers consume that returned choice. Reopening the Environment reads that selected runtime link with the Environment's Artifact batch. UI and daemon use one resolution rule: an explicit invocation method overrides the recorded link method; links without the optional field retain the legacy Git default. Compact retries retain their already admitted method. Previously created links whose choice was lost are not inferred or backfilled: choose Upload explicitly or link the target again.

Vercel Create supports Upload and Git integration on github.com, gitlab.com and
bitbucket.org. GitLab repository paths retain subgroups (`group/subgroup/repo`);
Bitbucket uses `workspace/repo`. Create and Inspect share one native link reader
and retain each forge's deployment IDs. Git creation uses the reviewed repository
through Vercel's existing forge connection; a provider refusal retains its typed
reason and grant link (GitHub App installation, or Vercel Account Authentication
for GitLab and Bitbucket). Self-managed forge hosts remain upload-only. An explicitly requested
production branch is applied within the same Create Action. If that branch
update fails or its acknowledgement is uncertain, the created project identity is
retained and the result shows the branch outcome and provider cause. The person
can recover without creating the project again. This is unreleased 0.3 behavior.
Create and Finish linking use the same association owner. If association fails,
direct execution and retained operation reads preserve the typed failure cause
and the provisioned `deployments.targets.link` recovery input; replay does not
create another provider project.

In unreleased 0.3, you can create a Railway service from a selected GitHub
repository and branch or link an existing service. Railway builds the latest
commit on the connected branch at creation and redeploys when commits are
pushed. For an explicit Deploy, Check confirms the service repository and
Railway's access to it. The reviewed checkout must be clean and the commit must
be on the published branch. Deploy submits that exact SHA. [Railway Manage
Services](https://docs.railway.com/integrations/api/manage-services) · [Railway
GitHub autodeploys](https://docs.railway.com/deployments/github-autodeploys)

The protected Link and receipt carry provider coordinates as
`providerEnvironment: { kind: 'native', selection }`. Each deployment target
declares its closed `nativeSelectorSchema`. Protocol composes that schema into
the target's role inputs and checks those declarations at manifest admission.
The Link and receipts keep a separate `providerIdentity` tuple for comparison.

If a Railway-assigned address remains pending without a hostname, the existing
Domain Verify action accepts the exact hostname the person found on the linked
service. Railway checks the project's service and environment for that
provider-assigned address before the shared Domain owner records it. A check
reads the address inventory and never creates another address.
[Railway Manage Domains](https://docs.railway.com/integrations/api/manage-domains)

The existing `DeploymentTargetRoleResultV1` carries optional `uploadProvenance`: the exact source manifest and a provider build location, or the controller container image, toolchain name/version and prepared-output manifest fingerprint. This evidence lives in the existing receipt's platform observation, displayed by the receipt and its Build logs through one shared presenter. The canonical observation writer preserves the original evidence when subsequent status reads return lifecycle state alone; it creates no upload store or additional receipt. Provider preparation's existing `reviewNotice` discloses the upload build location and Cloudflare pins before execution.

This document records the server implementation behind deployment. Operator recipes and configuration are owned by the published [self-hosting guide](../apps/docs/content/docs/self-hosting/index.mdx), including [Docker and Kubernetes](../apps/docs/content/docs/self-hosting/docker.mdx#kubernetes).

In 0.3 development, the GitHub PR Preview read carries the Environment owner's
optional controller availability separately from receipt readiness. A paused or
unknown controller does not remove a serving app's URL or change a teardown's
receipt state. Both the PR surface and agent read consume this same projection,
including a created child without a first receipt. Recovery opens the existing
Environment settings. Machine presence changes invalidate the existing deployment
Resource; reconnect does not start a Deploy or publish a PR status.

In 0.3 development, `projectDeploymentDomainFactsV1` owns the recovery projection
for the Domain's recorded controller operation. A typed `not_found` from that
exact operation read projects an unknown outcome, exposes the reason in Technical
details, and permits a fresh Remove. Pending or unavailable reads keep removal
unresolved. This projection preserves the persisted removal intent and captured
placements; only verified native absence can tombstone the Domain.

Domain removal in 0.3 development uses the SDK's shared
`settleDeploymentTargetDomainRemovalV1` owner. After the removal attempt, the
provider adapter observes the selected Domain once: a native 404 or absence from
its Domain list settles removal, including when the DELETE response was lost or
failed. A DELETE acknowledgement alone cannot settle removal while the Domain is
still present; that outcome remains unknown. This observation does not retry the
mutation or poll the provider.

In 0.3 development, Cloudflare Domain preparation and retirement accept the API's optional pagination metadata and omitted or null tunnel configuration. Without pagination metadata, the route owner reads through an empty page before deciding ownership or absence. Malformed responses retain `providerOutput` in the existing Domain failure details: an endpoint template, issue path and expected type, without response values or credentials. The original provider cause, required fact and remedy remain attached, including when remote changes leave the outcome unknown. Preparation creates each target's sealed connector grant automatically; a failed grant write retains its typed cause and HTTP status without credentials or response values.

Cloudflare preparation records observed creation for the exact Cloudflare account and tunnel ID in the private Environment Artifact. Home commits it with the Domain preparation, so it survives removal of the Domain that created the tunnel. Removal first retires native routes and the final connector, then removes owned provider routes and DNS. Home captures the last-consumer decision; the Cloudflare Action removes the tunnel only with creation provenance and no foreign ingress. Adopted and shared tunnels, tunnels with foreign ingress, and older tunnels without creation provenance remain, with a typed reason in the Domain mutation result. Older Domain-local creation proof remains valid for the Domain that holds it. A failed native removal leaves the provider unchanged. Tunnel deletion settles from observed absence, including an initial exact-ID 404 or absence from the paginated active-tunnel list after a lost or failed DELETE; an acknowledgement while the tunnel remains present is an unknown outcome. There is no automatic retry or polling. These are unreleased 0.3 source contracts.

In 0.3 development, the Cloudflare plugin's read-only `cloudflare-named/selections-read` Action lists complete named tunnel selections for a connected Account and selected zone. It derives the Cloudflare Account ID from that connection and supplies its canonical connector image and version pin; callers can explicitly override those defaults. It reuses selected-zone validation without requiring Zone Read, and reports `connector_discovery_unavailable` rather than claiming the connector is running. Native execution verifies that connector; the route owner separately decides hostname-route and DNS ownership.

In 0.3 development, choosing the Cloudflare Workers or Pages target fixes the product for its linking choices. Each target supplies its own Inspect fields and choice Resource. The sheet selects a Cloudflare Account and a Worker script or Pages project. For an existing Pages target, the sheet asks for the provider environment after the Pages project is selected. Inspect reads the Worker's immutable script tag or the Pages project ID and returns the complete provider identity. Reinspection still accepts a complete identity, and Pages checks that it names the project read.

In 0.3 development, the Environment draft uses that same platform editor for Vercel, Cloudflare and other declared runtime targets before Save. Check reads the provider without requiring an Environment to exist. After the creation review, Create saves the Environment and passes the exact inspected provider content to the existing target-link Action. A refused link preserves the created Environment and opens its Settings for recovery. The draft and saved Permissions page share the existing deployer controls: managers, members, or chosen people and Groups from the Source's owner and shared audience. Shared Teams use the existing member and Group picker; a directly shared Account or Group can be chosen without expanding its access. Production protection remains a separate choice; Source audience admission still owns which principals can be selected.

Cloudflare Pages Direct Upload accepts the provider's `success: true` asset-upload
and hash-registration acknowledgements without a `result` field. Data-bearing
responses still require `result`. An explicit provider rejection remains
`provider_request_failed`; a lost or malformed mutation response remains
`outcome_unknown`. Provider response text and authorization material are excluded
from failure diagnostics. This decoder behavior follows the
[Pages Assets API](https://developers.cloudflare.com/api/resources/pages/subresources/assets/).

The deployment target SDK settles an oversized provider response using the
operation's declared read or write intent. Cloudflare Pages `check-missing`
uses POST and reports a read failure if its response exceeds the host limit.
A write with an oversized reply retains `outcome_unknown` and the sanitized
cause. Recovery uses the existing receipt observation.

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
observation or interrupted removal keeps the outcome unknown, with a sanitized
cause code in the step proof and Action details; command output is not included.
Unknown teardown steps only re-observe: unchanged uncertainty writes nothing and
never repeats removal. Authoritative absence permits continuation. A confirmed
Docker network-removal refusal settles failed, so explicit retry can resume the
same receipt from its first unproved step while skipping completed steps.
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

In 0.3 development, removing an Environment preserves its resource custody. Its
current Source manager can later use the same teardown Action with the exact
retained target link and selected volume names, including after Source removal.
This does not admit Deploy or Restart on the removed Environment.

A native deploy can restrict its operation to an explicit `services` set without
changing the exact source definition. Preparation discovers images for that set;
review rejects dependencies outside it, and migrations and service publications
for excluded services do not run. Choosing a set requires the existing definition
Manage role. A later deploy without that operand uses the source's ordinary selectors.

Preview PostgreSQL provision retains cleanup choices only when that set matches
the child's generated PostgreSQL inventory. Canonical template volume metadata
identifies the data targets; effective native storage review refuses a repository
merge that replaces those targets with host binds, external volumes, foreign
drivers or driver-backed host paths, or names outside the child's Compose project.
Other repository mounts keep their ordinary
semantics. The native owner intersects actual activated container mounts with
those reviewed named mount targets and Compose-labelled owned volumes. It records the exact Machine and volume names in
the receipt and successful deploy result as `previewCleanup`. Application,
external, anonymous and unrelated volumes supply no deletion choice. The existing
teardown Action consumes the retained explicit choices after copying and app
deployment; ordinary restricted deploys supply no automatic cleanup authority.

In 0.3 development, the app, credentialed CLI, Session Agent, MCP, and Workflow
dispatchers use the shared Environment placement resolver. An unplaced Action
that needs an Environment's controller uses the controller returned by one
Environment read with the requester's credential. The CLI preserves an explicit
execution Machine for Home admission. An Action that already carries its
controller can be placed without an Environment read. Restart addresses the
captured service Machine directly. A Target Link runs on its Environment
controller and retains the linked resource's Machine in the Action input.

Teardown mint and Domain Remove child admission keep the Environment's recorded
controller Machine authoritative. A request on another Machine returns
`credential_scope_denied` with reason `controller_placement_mismatch`, the
recorded `controllerMachineId` as its required fact, and a remedy to run on that
Machine or make it reachable. The existing Action failure fields carry this
refusal through HTTP; admission never substitutes a controller.

In 0.3 development, Environment and Domain writes use the deployment isolation
owner: Read Committed on PostgreSQL and Serializable on other providers. The
Environment row lock and revision CAS exclude competing writes while allowing
unrelated Account cursor publication; creation uses its existing intent lock.
Delete, unlink, explicit detach and signed receipt transitions retain their
Read Committed transactions. A confirmed Home rollback reports the missing
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

Repository template Apply runs its prepared write and temporary checkout cleanup
in the existing Action operation. Environment bindings and template metadata
advance after the repository steps succeed.

## Redeploy after teardown (0.3 development)

Native removal releases unused Compose project networks after removing the
witnessed containers. Service retirement, generation replacement, failed-deploy
cleanup and full Environment teardown share this network owner. It includes
stopped containers when checking network holders and preserves shared Caddy
attachments while another workload still needs them. It also retains Caddy's
primary network: Docker keeps that dependency in immutable `HostConfig.NetworkMode`,
so detaching and removing it would prevent Caddy from restarting. Service Stop deliberately
keeps its containers and networks available for Start or Restart; Detach with
keep-running also preserves the workload.

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

Configured Domain check transitions publish independent C1 conditions for probes
and certificate renewal. Each condition recovers only from its own successful
check; contributed monitor kinds use the same admitted Domain binding.

Native backup run, verification, retention and restore terminal outcomes publish
update notices, including in production Environments. Public operations,
pre-migration backups, restore safety snapshots and rollback with data share the
native settlement path. Environment and check identify the retained notice;
operation and configuration revisions remain evidence. Inventory, Test and a
successful restore preparation do not recover a failed execution check. Native
outcome uncertainty remains open until a successful execution of that check.
An explicit typed cancellation does not publish a failure. An uncertain native
outcome still publishes when the caller has stopped observing it.
The producer captures the Environment's saved health-source alert selection at
admission. If that read is unavailable, it retains the Inbox notice with the
safe reason and skips off-app delivery; it does not treat unavailable settings
as an absent selection. This source wiring awaits loaded-runtime verification.

Automation detail reads project the latest due occurrence for each current
schedule revision, with its actual start and approval hold, in one set query per
portable page. Backup freshness uses that exact trigger occurrence rather than
another trigger's Automation-wide last-start timestamp. Disabled schedules and
held approvals are distinct from never-started work. The precise
`workflow.trigger.list` backup-freshness selector opens the named Automation and
reuses the bound backup-target reader; it does not enumerate the Account.
An absent `scheduleOccurrences` fact makes this precise read unavailable;
generic lists omit `missedSchedules` rather than claiming no missed occurrence.
These optional read projections are current 0.3 development contracts, add no
persisted state, and require the current server and clients for exact freshness.

Domain health reads reuse `deployments.health.current` and the existing saved
Domain-bound HTTP and certificate checks. Reading a Domain starts no network
probe. The shared projection combines retained check evidence with the Domain's
DNS result and returns typed certificate and Needs-you facts for both people and
agents. Outside evidence remains distinct from a check on the serving Machine;
a local success cannot establish outside reachability. Missing checks and an
unreachable controller remain explicit rather than implying a healthy Domain.
For edge Caddy ingress, the edge Machine is the serving Machine: a different
runtime member can supply outside evidence. Without a separate edge, active
runtime members supply same-Machine evidence.

The native Domain Add form requires an explicit HTTP health path and expected
status, validated by `DeploymentDomainHealthCheckV1Schema`. It does not infer a
health endpoint from Compose argv or assume `/` and status 200. Provider-managed
addresses retain their provider routing input instead of native health fields.

Domain rows consume the successful native apply's `routedReplicas` snapshot: the
recorded count and complete Machine/container-name list. Missing snapshots remain
unknown; recorded routing does not establish current replica health or traffic.

Own-server member reviews retain the observed Docker engine kind in each existing
`approvedInputBasis.runtimeProjections` entry. Older receipts and generations
without that observation remain unknown. Native Domain acquisition consumes
`presentMachineAuthorityV1` and refuses Docker Desktop as `unsupported_platform`
before route setup, secret acquisition or other Domain effects. The Domains panel
uses the serving generation's same retained engine observation to show the
Desktop unavailability state before Add. Before any native observation, or for
older receipts, it keeps the engine unknown and relies on the native refusal.

Custom certificates become due for replacement at two thirds of their observed
lifetime. Known validity dates can advance the projected state when read, without
a new timer. Automatic certificates expose observed expiry without inventing a
Caddy renewal window. The underlying observation time remains visible.

Saved subject health checks keep their investigation choice in the existing
source configuration. Omitting that choice leaves failures in Inbox. Explicit
`auto_start` names an existing configured Triage Action, validated against the
live configured-Action catalog when the source is saved. Only a committed opening
can start that investigation, including an observation-only Event that creates no
Workflow Run; repeated evidence, recovery and rejected observations
do not start another Session. The subject remains the diagnosis target even when
another Machine observes it.

Host-health notice targets retain the portable Home identity, so another device
can resolve the same Environment or Machine without the observer's local server
profile name.

The same notice retains the investigation outcome, including a required placement
choice, pending approval, refusal or an uncertain start. An uncertain response is
shown as “may have started” and is not retried automatically. This source-local
choice does not change Account investigation defaults or create a second Session
launcher.

The committed Event retains its original host-stamped plugin caller for the
configured Triage Action hop. That Action uses the existing caller and target
admission owners; observing a health transition grants no Session or Machine
permission and does not reuse a scheduled Workflow Run's consent.

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

Preview Create materializes the template's explicit variable blueprints through
the existing reviewed bindings continuation. Fork previews retain only explicit
plain values and deployment facts; they inherit no Saved Secret references,
Environment references or data selections. Their exact commit is reviewed on
Create, with Deploy as its reviewed child, before allocating the child Environment
or preparing source and images. The same admission checks the actual build and
runtime Machines against their complete Environment inventories and refuses
Production workloads or incomplete placement facts.

The selected wildcard Domain supplies one expanded hostname and planned URL.
Explicit `domainUrl` and `primaryUrl` deployment facts may use that URL before the
child route exists. For fork Create and ordinary Deploy, the owning controller
captures the selected template Domain fact once when a dynamic preview binding
needs it, before initial remote preparation. Signed native preparation carries
the selected Domain id and URL before the candidate exists; the existing
candidate and receipt then carry that fact through review, build and member
execution. Retained snapshots reuse their captured fact, or the owning
operation's captured fact when absent; later roles do not reacquire the parent.
Route creation follows successful deployment through the
ordinary Domains Action; a planned URL alone does not establish serving, DNS or
TLS readiness.

In 0.3 development, saving a GitHub preview template also enrolls an ordinary
sibling Workflow for `deployment-receipt-changed`, alongside the PR lifecycle
source. It observes the template's preview children and passes the receipt's
Environment and Deployment ids to the existing Forge preview-status Action.
Its private Workflow retains the configured Account reference and repository
configuration, never credential material. Resaving refreshes that configuration
and reuses the Workflow identified by its qualified Action, Home and template.
Disabling new previews leaves both sources enabled for retained-preview cleanup
and status publication; removing the template configuration does not disarm them.

## Railway managed databases (unreleased 0.3)

Choose a Railway project and environment with the Railway Connected Account,
then create a PostgreSQL or MySQL template service. Railway returns a workflow
ID. Inspect the exact service and confirm the link to the Happier Environment
after creation. If the create outcome is uncertain, check the Railway
environment before trying again. You can link a service you confirm there.

For a Railway app in the same project and environment, the Variables flow adds
a private service reference using the linked database. Review the variable
name and any replacement before saving. Apply the app's Railway changes to
use the new value.

Workbench can list the linked database. Reads remain unavailable until
Workbench supports binding a limited Railway database login. For writes, bind
a separately reviewed login and an address the controller Machine can reach,
such as a Railway TCP proxy. Removing an adopted Link defaults
to unlinking. Explicit service deletion targets the selected Railway
environment. Review the service's volume separately in Railway.
[Railway database reference](https://docs.railway.com/databases/reference) ·
[Railway TCP proxy](https://docs.railway.com/networking/tcp-proxy)

## Database operations (0.3 development)

UI and agent SQL use the semantic `database.statement.run` Action. A selected
`deployment_service` target names the Environment, serving Deployment, target
Link, service and database. Its database name comes from that Deployment's
retained input basis, not a newer Environment draft or a neighbouring database.
SQL and parameter values stay in the protected Action input; the public admission carries only the
exact Environment, Deployment, target, Machine and installation references and
the Action's canonical read/write access class.

Workbench target discovery on a Machine uses the signed contributed Action to
read the serving Own Server receipt on its current runtime installation. The
Environment and Artifact routes apply the requester's existing access.

The existing service Exec owner supplies native container reachability to the
shared PostgreSQL or MySQL driver. Shared dialect modules own statement admission,
parameter binding and typed ordered result decoding. Reads use the dedicated
read-role credential and a read-only transaction; read operations never acquire an
administrator login. Results preserve duplicate labels, NULL versus empty text,
exact integers and binary values. Parameters are ordered typed values, with no
native-client named-variable translation. Cancellation reaches the driver and
the native service connection. Deployment size and restore checks call the same
shared operation functions in process and do not load the optional workbench
runtime.

Neon uses its selected branch/database read-only HTTP transport with native
PostgreSQL field metadata. Supabase's restricted management transport exposes
read statements with unknown native field types and explicitly unproven
completeness. Unsupported operations return typed unavailable results.

Managed writes bind an existing direct connection Saved Secret through
`deployments.bindings.set`, with `purpose: 'dataRole'`, the selected
`targetLinkId`, and `role: 'write'`. The existing credential owner opens only
that binding under the signed Action's write access class and checks its engine
and database against the selected contribution's declared engine and the admitted
database. A missing binding returns
`write_connection_setup_required`; setup does not acquire an administrator login
or create a new secret. Read-class work uses the target's dedicated read role or
restricted read-only endpoint. In 0.3 development source, a managed target
receives the daemon's existing database engine service for both read and write
opens. The target adapter selects its transport and supplies the credential for
the admitted access class. Direct managed MySQL uses the same native driver
as Worktree and manual MySQL. The shared drivers preserve native fields and
transaction commit and rollback for direct connections.

For a managed PostgreSQL or MySQL target that supplies a direct SQL endpoint to
the Workbench, a missing limited login returns `read_role_setup_required`.
The Workbench offers two Actions. **Attach read-only database login** selects the
exact revision of a Saved Secret containing the login's connection URL. The
controller checks the URL against the linked database and verifies the account's
read privileges before binding it. **Create read-only database login** opens the
admitted write connection to prepare the engine's role and grant statements.
Review those statements before applying them. The controller uses authenticated
TLS for the provider-selected endpoint and keeps generated authentication
material private. Both Actions use the existing managed data-role binding and
its Saved Secret custody. Agents use the same Actions and approval rules.

The canonical psql input admission API has explicit query and dump modes.
Dump mode accepts multiple SQL statements and PostgreSQL plain-text COPY data
through its exact physical `\.` terminator, using the same incremental scanner
for strings and byte streams. It refuses executable client commands and
`COPY PROGRAM`. The exact whole-line `\restrict` and `\unrestrict` directives
with alphanumeric keys are admitted only in dump mode, as emitted by
[PostgreSQL plain dumps](https://www.postgresql.org/docs/16/app-pgdump.html);
[psql owns their key matching](https://www.postgresql.org/docs/16/app-psql.html#APP-PSQL-META-COMMAND-RESTRICT).
Query mode continues to refuse client commands and additional statements.

Results use the existing public Action response envelope limit from
`actions/externalActionLimits.ts`. The shared result owner preserves the rows
that fit together with typed completeness and continuation information. It does
not claim that a restricted provider response is complete, introduce a separate
row-count cap or alter the person's SQL with LIMIT.

The dedicated `happier_ro` login is a database security boundary. Its Saved
Secret password is configured through the ordinary reviewed
`deployments.bindings.set` data-role effect. Bootstrap validates role authority
once, refuses privileged existing accounts before changing their password, and
keeps a newly created MySQL account locked until its grants are validated.
A refused new account remains locked for the database owner to reconcile.
PostgreSQL 14 installations whose PUBLIC schema grants CREATE require an owner
to configure schema privileges before setup; bootstrap does not change shared
PUBLIC privileges. Ordinary queries consume the admitted sealed read-role
credential and retain the read-only transaction on every fresh native session.

A controller can dispatch that reviewed setup to the serving Machine through
the existing signed deployment child. The exact admitted proof and executor's
local cancellation govern continuation; a prior deploy receipt does not stand
in for a bindings review. Query reads likewise retain their exact signed scope
without repeating Source permissions during the admitted finite operation.

In the 0.3 development Workbench, a watched own-server database keeps its
verified session while the view is open. The target daemon holds native
admission during session setup and each database operation through settlement.
An idle session leaves the native keys available to another operation.

Managed data targets declare their read-only query Action in the plugin's data
role contribution. The shared UI preserves the recorded credential principal
and dispatches to the Environment controller with the same result contract.
The admitted project, branch, and database identify the query target. Supabase uses its Management API's
[dedicated read-only query endpoint](https://supabase.com/docs/reference/api/v1-read-only-query),
with PostgreSQL positional parameters and JSON keys `"1"`, `"2"`, in order.
It verifies the endpoint's current database before submitting the person's SQL.
Its public response lacks completeness and empty-result column metadata, so
results explicitly report unknown completeness. Neon uses its SQL HTTP transport
with the `happier_ro` password from the managed target's `dataRole` Saved Secret
binding. The binding is opened through the ordinary Environment secret
materializer, never an Account Saved Secret lookup. The database owner must
provision the limited PostgreSQL role; Neon Management credentials alone are
insufficient. The shared PostgreSQL role-authority guard and the query execute
in one read-only HTTP transaction against the admitted branch and database.
Missing bindings or an unavailable endpoint produce an unavailable result;
database refusals fail the query without exposing credentials. Real Neon and
Supabase tenant journeys remain release checks. MariaDB native queries
return `mariadb_read_role_authority_unproven` while its implicit PUBLIC-role
bootstrap authority remains unsupported. Neither limitation falls back to a
writable credential.

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

The Store's Compose/image entries can choose an existing Project or open
`/deployments/new` with the shared Project choice and Environment draft. New
Project intent reaches `deployments.environments.create` through the ordinary
preview and confirmed invocation; mounting or editing the draft creates no
Source. The create result's `projectSourceId` addresses the resulting Environment
without a read-after-write discovery step.

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

Creating a Team-owned Source requires the Team's settings-management capability.
Ordinary membership and a ready Team Machine grant do not grant that authority.
In 0.3 development, Create preparation preserves the Source owner's existing
`source_access_denied` refusal through authorization and Action invocation;
the authorization endpoint returns HTTP 403 before dispatch or approval.

For a Team-owned Source, placement also requires an explicit Machine grant to
that Team. A member's personal Machine ownership does not supply the Source's
custody. In 0.3 development, missing Source custody returns `machine_unavailable`
with `diagnostic.requiredFact: source_machine_use` and
`diagnostic.remedy: share_machine_with_source_owner`. A definition admission
refusal records `effectAttempted: false`; prepared Environment-create approval
history retains that diagnostic bound to the reviewed Machine and role.

A stored Compose definition requires no requester checkout. For platform
targets that declare a repository requirement, the wizard and Use a platform
offer repository definitions, and Link returns
`deployment_target_requires_repository_definition` for a stored definition
before it creates a provider resource or associates a target. A repository
on the Project does not change how an Environment obtains its definition.
Stored definitions can run on an own server. Native repository
definitions retain repository and Compose selectors, but no
Manage-approved workspace root or commit, so their Use redeploy remains refused
with a typed result. Requester-chosen workspace roots remain physical-owner-only
at the shared native/upload source acquisition owner. Missing signed role never
grants Use deployment authority; existing owner/Manage behavior is retained.

In 0.3 development, native Compose resolves relative build contexts from the
first selected Compose file's directory. Dockerfiles resolve from their build
context, following [Docker Compose's path rules](https://docs.docker.com/reference/compose-file/build/).
`nativeComposeLifecycle.ts` supplies that project directory to native Compose
normalization for both build and runtime; source-manifest validation remains
relative to the immutable repository root.

`ownServerDeploymentTarget.ts#createOwnServerDeploymentTargetForHost` delegates
to one executor. Its host runtime borrows the daemon's mounted
`projectManagedServices` owner; it must not construct another supervisor.

In 0.3 development, an own-server Environment's Settings includes a migration
editor for its service, literal command arguments, optional pending check,
backup choice and existing failure-recovery policy. Commands use one argument
per line and run without shell interpretation. Save uses the ordinary
`deployments.environments.update` Action; removing the command sends
`ownServer.migration: null`. The canonical content patch removes that property
while retaining the other saved policies. Protocol owns the shared migration
policy schema, and deployment-protocol consumes it for stored content. Command
arguments remain private content and are omitted from the server-readable
metadata patch for an E2EE Environment.

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

Demanded Environments, Domains and data-services pages carry `projectSources:[{id,name}]`, projected
from the Sources already loaded by admission and deduplicated for the visible page.
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
The version-title projection stays with the latest-attempt header; the separate
serving receipt below supplies the address without changing that title contract.

The already batched latest-attempt body also supplies
`currentDeployment.commitSubject` and `currentDeployment.source` through the shared
receipt source-facts projection. They are omitted when its private content cannot
be opened; a captured body without a subject reports null. No per-row source or
receipt lookup is added. The existing `requestedByAccountId` identifies the Account
principal; it does not identify a Git author or distinguish a person from an agent.

Ordinary inventory pages also carry `servingDeployments` and `liveAddressDomains`
from the selected runtime link and current, nondeleted Domains. Their private
Artifacts join the same mode-aware batch as Environment content and latest-attempt
headers. The opened item's `liveAddress` uses the existing live-address resolver:
an older serving receipt remains authoritative after a failed latest attempt,
platform URLs come from its recorded observation, and native addresses come from
its matching current Domain. Missing legacy metadata or unreadable required content
leaves the address omitted; a known unresolved address is null. Exact-ID Environment
header demand reads no receipt or Domain content.
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
zero scheduled idle work. In unreleased 0.3, initial runtime Link enrollment
seeds `periodMs` from the plugin target's declared `statusIntervalMs`. Vercel,
Cloudflare Pages and Workers declare one second: Vercel's client starts status
polling at one second, as does Wrangler Pages' first status wait. Workers uses
the same Cloudflare plugin declaration. This is a plugin policy, not an API
minimum or a new global poll loop. The existing failed-receipt source alone
observes demanded unsettled receipts; sibling outcome sources consume receipt
invalidation. Terminal success, failure, cancellation and `outcome_unknown` end
scheduled observation. Settled history never invokes provider observation.
The person can still edit the saved period. Plugins without a declared interval
retain attention for pending work without a configured period.

The contribution and normalized catalog remain closed under the unpublished
0.3 direct cut: update plugin declarations/projections and their host readers
together. No released 0.2 format, database schema, timer or retry is added.
Cadence evidence: [Vercel client polling delay](https://github.com/vercel/vercel/blob/main/packages/client/src/utils/get-polling-delay.ts)
and [Wrangler Pages deployment status wait](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/pages/deploy.ts).

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
no second work queue or observation scheduler is introduced. A provider receipt
may settle directly from queued when its build finishes between observations;
the observer does not manufacture an intermediate running state. In current
development source, explicit observation also recovers retained `outcome_unknown` provider
receipts without reacquiring their released effect slot. Provider queued/running
progress updates protected receipt content while retaining `outcome_unknown`.
Observed terminal success uses the captured installation, receipt CAS and current
TargetLink revision, and is refused when a newer receipt exists for that target
or cancellation was requested. In current development
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

### Vercel token connections (0.3 development)

The existing Vercel Connected Account accepts a token with Team ID left empty.
It reads all pages of the token's teams, connects directly when there is one,
or offers named teams through the existing connection configuration step. That
step continues with the staged token rather than asking for it again. A
project-restricted token that cannot list teams retains exact Team/Project ID
setup and the existing project probe. Invalid tokens and unavailable provider
responses remain typed failures. Token storage is unchanged; restarting during
the pending choice requires a new connection attempt.

### Cloudflare token connections (0.3 development)

Workers Builds requires a **user-scoped** API token with **Workers Builds
Configuration (Edit)**; account-scoped tokens are not supported. Create the token
at [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens).
The Cloudflare connection reports `cloudflare_builds_user_token_required` when
Workers is selected with an account-owned token. Pages, Tunnel and DNS can still
use account-owned tokens. This API token is separate from the build-token UUID
used by Cloudflare's build system to deploy a Worker. Install and authorize the
Cloudflare Git app through Workers & Pages → Settings → Builds → Connect before
configuring repository connections. See the [Builds API reference](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/).

Pages creation supports hosted GitHub and GitLab repositories. Creation and
adoption share the same observed-source readiness result; `needsGitAccess`
includes the Cloudflare dashboard grant link when the selected repository is
not connected. A Pages project's source mode is final at creation. Git deployment
builds the latest commit on the selected branch: Review says so, the requested
SHA remains in the receipt, and the provider-observed `builtSha` is included in
its investigation source summary when available. Other forges use upload.
Before Create, the existing Cloudflare inspect Actions accept a source-choice
draft and return `preparedNative.reviewNotice` without discovering or creating a
provider resource. Inspect, Create and Prepare use one plugin-owned notice
builder for the chosen target and source method.
Workers creation currently declares upload only: its Builds connection/trigger
API needs native repository identifiers and a separate build-token selection
that the creation input does not yet supply. Existing linked Workers Builds
continue through the existing trigger and `observeBuild` owners.

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
step-to-operation log references and sink-recorded step ranges. Its typed restoration
consequence reconciles the recorded failure with all captured member outcomes:
a restore-phase failure cannot claim restoration succeeded, and a restored version
without verified health remains explicitly unverified. The receipt banner and
recovery choice consume that same consequence. Historical evidence
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

In development, preparation or admission for a different native request
reconciles an unfinished receipt on its captured controller installation for the
same requester. A retry of that receipt intent leaves its revision to the original
operation or its observer. The
existing operation owner decides whether work remains live. A missing or succeeded
operation settles as `outcome_unknown`; a retained failed or cancelled
operation settles in that state. For an unknown outcome without an existing failure,
the signed receipt writer atomically records `deployment_activation_not_observed`
in the existing private failure schema with phase `observe`, preserving the remaining
content and active deployment. The UI explains that interruption prevented confirmation.
A fresh signed root for the same requester and captured controller can perform this
terminal settlement, including its existing receipt Artifact update, but cannot stage,
activate or replace that Artifact. Receipt reads remain reads, and recovery never
replays interrupted native work.

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
When Compose starts a first candidate and then refuses activation under
rollback-all, its Machine uses the pre-activation inventory and source custody
to remove the candidate's containers and release directory. The receipt records
the cleanup result. On a removal refusal, the action carries the cleanup cause
alongside the activation failure, and the protected stage log retains the reason.
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
Home projects the compact Promote source Environment and receipt into the closed
native admission, admits their provenance at mint, and retains those operands in
the signed binding. Preparation reads consume that same admitted scope through
the existing ActionSpec transports.
The current native producer supports recorded-image promotion between stored
definitions; explicit rebuild remains typed unsupported until its producer lands.
Promote review names the source Receipt's version and the receiving Environment.
Destination is the first fact. Own-server reviews show the selected version
even when the destination assigns it a different Compose revision. For platform
receipts, the chooser shows the effect declared by the target's Promote Action,
and review names the provider target. A platform Rollback review shows which
provider deployment will serve and keeps its data.
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
key, Compose service, container port and scheme. A private-network entry uses
`exposure: 'privateNetwork'` with the selected exact network. An Iroh entry uses
`exposure: 'loopback'` and `transport: { kind: 'iroh' }`, without `privateNetwork`.
The same transport may also accompany an exact `privateNetwork` export; that
export publishes both the selected network address and a literal loopback TCP
address. `via: 'auto'` prefers the shared observed network publication, then
falls back to Iroh. Explicit `privateNetwork` retains the exact-network choice
for a network export. The receipt records the chosen route and network identity.
An empty list clears the declarations. This operand cannot author public exports
or loopback exports without the Iroh transport; existing declarations remain readable.
`patch.definition` accepts the existing
`from: 'compose'` source input, including document, public files and selectors;
the native source owner derives its digest and stored content revision. It edits
an existing stored definition, rather than converting a repository source.
Both operands stay in the private invocation and Account Artifact; Home receives
the prepared content reference. Signed private authoring publishes its invocation's
Artifact even when the selected content is unchanged. Neither an export
declaration nor a source save opens a firewall rule or deploys the change.

The 0.3 development `deployments.environments.moveToRepository` preview reviews
the stored Compose document and public supporting files at a selected admitted
workspace. A Source without a repository can preview an explicit repository
selector. Create previews include the initial README for a new Git checkout;
an existing committed checkout instead supplies its immutable file before-images
through the shared SCM file reviewer. A cold preview can reopen an existing PR
reference: an open PR stays pending, while a merged PR reviews the actual merged
commit's Compose document and public supporting files against the current stored
definition. Preview leaves the Source, Environment and hosted repository unchanged.
Captured continuations switch through the existing reviewed Environment update;
changed merged bytes or a changed stored definition require explicit acceptance
of that comparison. Repository creation, Source attachment and cold apply remain
under implementation; the owner-level continuation checks do not establish those
publication flows or a loaded native journey.

Move runs on the Machine that holds the selected checkout. After Home admits the
root once, every repository effect of preview, apply and the merge continuation
(status, file reads, worktree, file writes, commit, push, pull request, fetch)
runs through that Machine's own SCM and filesystem owners. Those owners are
narrowed to exactly the admitted checkout root (`createAdmittedCheckoutRepositoryFiles`),
so a path that leaves it through `..`, a symlink or a sibling checkout is refused.
Only the Environment switch returns to Home, as the reviewed Environment update.
A Move into a checkout on another Account's Machine is not supported: it is refused
as `checkout_owner_required` before any repository effect. Template instantiation
into a repository pull request uses the same scope.

The Iroh export contract is development-only. Activation requires one effective loopback
TCP publication for the exported container port, bound to a literal loopback
address with an actual host port. Host networking cannot establish that mapping.
`resolvePrivateServiceExportAdmissionForHost` selects the active member,
installation and current managed-service occurrence and derives the exact
`TcpTunnelServiceExportBindingV1`, including its generation and loopback destination.
The applied service owner derives the export generation from the deployment and
its exact native container identity. Re-observing those same containers after a
daemon restart preserves the binding. Replacing the containers changes it, even
when the deployment receipt is the same.
Home receives only the exact allowed port and a SHA-256 commitment to that binding
with A's random 256-bit nonce; Compose service names, export keys and the nonce
travel to B only in the encrypted Iroh tunnel open. Machine service rows and
metadata also remain encrypted from Home for E2EE Accounts. Home admits the
requester's access to both Machines when issuing the TCP grant;
the destination daemon runs that same occurrence selector against the declarations
retained on its applied Environment service and compares the resulting binding at
tunnel open. B does not fetch a newer saved Environment or use requester credentials.
A supplied port or membership alone does not authorize a connection.
The transport uses the existing Machine Iroh carrier and TCP framing. The stream
upgrade attaches the export tunnel and clears the pending stream deadline before
the first application connection. Iroh's own
relay fallback remains within that carrier; the user-socket server relay is not
a Machine service-forward fallback. The consuming service owns its local Node
loopback listener and disposes it with retained service custody. Ordinary API
reconnect leaves the Iroh carrier running. If a publisher daemon restart closes
the carrier, the next app connection acquires a new carrier and grant for the
unchanged applied export through the same listener and injected address.
Concurrent connections share that acquisition. Export withdrawal ends the
listener and its open streams. Cold consumer recovery rebinds the address
recorded in the receipt. A port conflict is visible and requires retry or
redeployment rather than silently changing a running container's environment.

In unreleased 0.3, Iroh references and host telemetry on native Linux Docker
use a pinned TCP relay on the admitted consumer network. The Compose lifecycle
prepares that network before it materializes runtime bindings. The consumer
dials the relay's Docker DNS alias. The relay accepts the inspected consumer
subnet except for the bridge gateway address, which Docker can use as the
source for traffic from another bridge. It connects to a route-specific Unix
socket in a daemon-owned directory.
The Caddy upstream for a host-backed telemetry Domain uses the same relay
on Caddy's selected network. These connections require no host TCP publication
or host INPUT allowance.
A same-Machine private share from another Environment instead attaches its
consuming Compose service to the source container's existing Docker network and
uses that container's native DNS name and container port. This `local` route
bypasses the host publication and host INPUT chain, so a normal default-deny
host firewall needs no exception. The native owner requires the same Docker
engine and retains each consumer's existing network membership. Separate host
and port bindings use the same selected source address. Same-Environment
references use Compose service DNS; host-network and build consumers retain
the original host endpoint.
Compose owns consumer network creation through its zero-replica projection.
The relay requires the local Linux engine and a common bridge network with
an IPv4 subnet and gateway in IPAM. Docker Desktop, remote engines, unavailable relay images and
unsupported network facts produce typed failures. Rootless operation is
unverified. Local source attachment requires a user-defined bridge with Docker
DNS on the same engine.
Receipt reference addresses retain `route.kind: 'iroh'`, the acquisition's
observed direct/relay/unknown path, and the relay alias and network ID for
container consumers. Cold Iroh recovery and installed Caddy route recovery
reacquire their recorded aliases. Local container receipts retain
`route.kind: 'local'` and the source network ID. Docker preserves those
attachments across daemon restarts. Redeploy older development workloads to
replace embedded gateway addresses. Reapply existing host-backed telemetry
Domains to replace their gateway upstreams.
Admission, destination connection and carrier failures use existing deployment
recovery and service diagnostics. A later successful new connection clears a
destination failure; an older connection's traffic does not prove recovery.
Accepting a declaration does not prove connectivity; managed two-Machine and
platform validation remain separate from these source contracts.

The unreleased 0.3 Environment Settings surface places Private sharing after
Servers & build. The editor reviews the selected service, container port, route,
and host port before calling that same update Action. Happier network publishes
TCP on `127.0.0.1` and declares the Iroh export. When the host port is unset, Docker
assigns it at deployment and Machine Services reports the bound endpoint to the
Iroh service resolver. A joined network requires a current network observation,
an address on that network, and a host port for the firewall permit installed
before the service starts.

The editor authors a stored definition for one native Machine. Connect opens
Private sharing when the source needs an export and writes an `auto` reference
to the chosen consuming Environment. Deploy the source to apply the publication
and deploy the consumer to materialize its reference. To withdraw an export,
update `serviceExports` to exclude it, then deploy the source to apply the revised
declarations. The target daemon checks those applied declarations on the next
tunnel open.

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
and presents a redacted copy diff. If the readable source changes before root
admission, Create refuses with `source_changed`; refresh the review and retry.
An unreadable or deleted source remains an authorization refusal.
The stored create retains source identity,
revision and an opaque host-produced copy-intent commitment, not private choices
or plaintext content. Prepared and stored copies require that commitment; ordinary
creation needs none. The existing create request-key owner compares this reviewed
intent without newly allocated Artifact identities: an equivalent retry returns
the recorded Environment, while changed source revision, choices or resolved
configuration conflict. E2EE equality uses the requester's Account-keyed commitment;
Plain Accounts use a keyless canonical digest. Neither branch creates another
result store or changes the existing request-key retention. The creation owner marks
a newly allocated copy with `replayed: false` and an existing matching allocation
with `replayed: true`. A copy with managed-data provisioning requires explicit
`false` before any binding or provider child. An existing allocation or an absent
fact returns the acknowledged Environment with inspection/configuration recovery
and no provisioning. If the Home omits the fact, align Home and client versions
for future copies and configure the acknowledged Environment through Overview.
Duplicate is never replayed to finish that Environment's data configuration.
Selected bindings use the ordinary reviewed `deployments.bindings.set` child on
the newly allocated Environment; secret references receive fresh audience/grant admission rather
than copied live grants. The generic reviewed-child HTTP carrier preserves the
original requester and create root. Running state, history, waivers, consent and
credentials are not implicitly duplicated. Missing E2EE custody returns
`client_required`; unavailable data/operational destinations return typed
unavailable results rather than silently reusing resources. A failed child leaves
the created Environment visible with acknowledged references and a safe current
continuation when available. Unattempted data choices are named for recovery;
Duplicate is never replayed to finish them.

For attached managed data, the draft defaults to Omit. Reuse requires explicit
selection of Saved Secret variable bindings and shares those connections through
the ordinary binding writer; the resource stays attached to the source Environment.
Create empty captures the target's declared `projects.provision` Action input and
an explicitly chosen credential principal. After creation, the host supplies the
new Environment coordinates, provisions the resource and attaches its returned
identity through `deployments.targets.link`. Configure fresh connections through
the existing managed-data editor before using the application. Managed backup
restore is unavailable because the current data capability declares no restore
Action. Failed or ambiguous provisioning preserves known saved references and
recovery instructions without offering a blind provisioning replay. From Overview,
open Add a service or database, then Managed database. Inspect the provider's
resources and link any resource already provisioned, or explicitly create and
configure attachments that were not attempted.

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

In development source, the effective Source audience also receives read-only
access to the private Artifacts held by its deployment defaults, Environments,
Links, Domains and deployment receipts. Artifact access and recipient census
derive this from the actual parent relation and Source custody; no Artifact grant
is copied. Independent Artifact grants retain their own lifetime. For E2EE
content, a keyholder must still supply current recipient envelopes before another
reader can open it; the server never creates or opens these keys. Two committed
changes deliver them through the existing Artifact recipient preparation (census
plus key-envelope commit), run by the keyholding app or CLI that made the change:
a Source owner or audience edit delivers every Environment's content, all of its
target links (retained ones included), its Domains and the Source's deployment
defaults; an Environment Permissions Save that changes deployers or data editors
delivers that one Environment's content, links and Domains to the audience already
present. `packages/deployment-protocol/src/v1/contentRecipients.ts` owns both
selections. Receipts are excluded, as described for receipt history. Delivery is
best effort after the commit: an audience member whose envelope is missing (the
editor is not a keyholder, a read failed, or the member has no content key yet)
still gets `deployment_content_unavailable` until a later trigger delivers it.
CLI and daemon deployment reads keep recipient preparation off; an app keyholder's
ordinary content open still prepares the recipients of what it opens.

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

In 0.3 development, Deploy an app reads the selected catalog item's declared
Domains with its template pin. Configure collects the addresses before Review
and sends them as `domainBindings` to the same template preparation. Preparation
refuses a missing required address for every caller.

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
field is saved through `deployments.environments.update`. Its host enrolls the
declared Forge lifecycle source through the existing Workflow trigger owner;
enrollment failure is reported alongside the successful save and can be retried.
Saving a template creates no database or child Environment.
The host preview-admission owner opens the private parent template before a fork
can create a child or acquire deployment runtime, provider or registry resources.
Forks with `forkPreviews: off` are refused. For `approveEachCommit`, the existing
preview Create is the exact-head person-approval root; Deploy executes as its
reviewed child through APPR-CHILD. No child Environment, source fetch, image build
or data preparation runs before that person approves the exact head commit.
Fork execution requires non-production placement, inherits no secrets and provisions
no data; standing Workflow approval does not substitute for the person's approval. This
uses the existing Actions and approval owner, without a new Action, store or hold,
for encrypted and plaintext Accounts alike.

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
saved admission definition. Standard Environments persist none of those four ids.
A standard data companion instead records one unique
`previewCompanionOfEnvironmentId` relation to the actual preview. Read-only
approval metadata derives its template id through that relation, so the companion
uses the template's approval scope without acquiring a second PR identity.
This storage relation does not establish current-head/fork approval. For
same-repository previews, the Workflow claimant reads current
`previewTemplate.data` for each PR occurrence. It creates
`pr-<number>` through the ordinary Environment writer, using fresh child runtime
and data links, then executes the selected data target's declared branch-create
Action with the saved parent reference. Neon declares schema-only initialization;
Supabase declares `withData: false`.
The existing link writer publishes the returned child branch identity.
Existing PR children are reused on synchronization. Production bindings, backup
settings and ingress are not copied into the child.

An own-server PostgreSQL selection records the original source backup capture
and an explicit destination backup choice. Child creation prepares the selected
template with fresh Saved Secrets and bindings. Template preparation keeps
selected database variables under that fresh template custody; saved parent
variable blueprints are retained only for other variables, for both placements.
The reviewed Create continuation
uses `deployments.backups.configure` with `initializeAndSave` to initialize and
save the explicit destination configuration under a child-owned prefix. The
repository's existing PostgreSQL service is used when its template metadata
declares the selected database and persistent-volume sites. Each repository
service serves one selection. Otherwise, ordinary Create derives one standard,
non-production companion data Environment from the pinned catalog template;
repeated selections use the existing Add composition to namespace their services,
variables and volumes. The exact PR checkout remains the sole repository Compose
source. Template preparation supplies fresh bindings and metadata without changing
repository content. The companion's catalog owns its stored Compose. The Workflow
first deploys only the child database, then runs the existing cross-Environment
restore prepare/confirm Actions. A provisioned database receives a safety backup
under the child's configuration before import. Source backup credentials stay
source-bound; the copy executes on the Machine that already holds that grant.
The app deploy runs only after verified restoration. A later PR event also checks
the original Run's immutable copy outcome before starting the app. An incomplete
copy requires review or closing and reopening the preview; synchronization does
not silently bypass it. This first native path uses one runtime Machine.
Companion database connections use ordinary private service references and fresh
child Secret references. The catalog publishes only an ephemeral loopback port;
the existing native observation and Iroh owners resolve its assigned port. After
all copies verify, the ordinary binding writer connects the main preview and the
app can deploy. Companion connections currently require native Linux Docker;
the existing container bridge refuses Docker Desktop and non-Linux hosts.
Saving template intent performs none of these effects.

The child's private content records its creation Workflow Run. On close, the
caller reads that Run's authenticated branch captures and invokes ordinary data
teardown before removing the runtime and Environment. Disabling new previews
keeps an existing lifecycle listener available for this cleanup. Native database
provision retains the exact observed PostgreSQL volume deletion operands in the
same Run. Close discovers the companion through its persisted relation and removes
it before the main preview, including when the main preview was already removed.
It passes the captured operands to ordinary teardown; other volumes retain
their existing default. This is
development source behavior; real GitHub delivery and managed-provider effects
still require the composed live journey on the reloaded development stack.

The GitHub plugin's development preview publication uses the single
`github/pull-request/preview-status` Forge Action for the enrolled receipt-change
Workflow, explicit publication Workflows and visible retry. The receipt-change
source also wakes on canonical Domain header changes, so an unchanged successful
receipt can publish Ready once its Domain becomes active. The Action derives the
publication from the current child, exact receipt and authoritative Domain URL;
historical receipts and caller URLs do not supply readiness. Retained successful
teardown receipts permit Removed publication after child deletion. Pending,
failed and removed publications carry no URL. The host admits the Environment
approval scope through the preview relation to the template; publication does
not grant deployment approval. Retrying publication does not redeploy, and a
publication failure leaves the ready application's URL available in PR Overview.

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

Settings and Move use the same Link Action to replace the selected own-server
runtime. A Move to disjoint Machines retains the predecessor link, its ordered
Machines and its serving receipt; selection neither stops the old workload nor
proves it drained. Failed attempts retain their native custody too. The existing
teardown and unlink owners require cleanup proof or explicit detach before
releasing that predecessor, excluding common Machines transferred to the selected
link.

In current development, a selective reduction that keeps common installations
requires `drainedDeploymentId` before dropping the removed members. It must name
the latest receipt for the exact Environment and predecessor link: a settled,
successful teardown whose signed proof names exactly the removed Machine and
installation pairs, and those installations must still be current. Selective
reduction and whole-target disposition share this proof verifier. A later
deployment attempt, including a failed attempt that
leaves the serving pointer unchanged, invalidates the older drain proof. Partial
teardown preserves the serving pointer and link revision, so its proof revision
must equal the current predecessor revision. Whole-target teardown instead clears
the pointer and advances the link revision once; its disposition owner consumes
that advanced revision before unlink or delete. A configured link with no prior
receipt and no serving pointer can still be edited without inventing a drain
receipt. An explicitly supplied `drainedDeploymentId` is always validated.
Older development servers can refuse this preparation with `deployment_conflict`;
there is no alternate Move or cleanup path.

Changing the selected runtime does not copy deployed application data. Move's
Workflow composes the existing deployment Actions for the supported source shape;
data movement requires its explicit backup/restore steps.

The public source port materializes the receipt's immutable commit through the
SCM backend's optional `exportCommit` operation and the existing manifest/blob
staging owner. Git object bytes, rather than HEAD/index/dirty workspace bytes,
supply the release. The P42 opaque execution-environment port supplies each
phase to canonical Exec; targets receive no secret-value map.

An approved target basis retains source/configuration fingerprints, current
Environment/link/installations, binding references/revisions, image pins and a
stable physical Compose project. No secret-interpolated-model digest is retained.
In 0.3 development, consuming approval binds the Account, Action and exact operands
once, with single-use consumption. Native execution does not compare that approval
with freshly rendered manifests, configuration fingerprints, tool versions or
template health policy. Backup destination opening likewise accepts a changed
trusted plugin occurrence. Environment/link revision CAS, captured input and
receipt identity, credential custody and native-generation identity still prevent
applying approved work to another target. Fingerprints retained in receipts serve
source provenance and observations rather than a second approval decision.
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
In development source, a fleet Environment's Settings → Servers & build edits
the existing ingress intent through `deployments.environments.update`: Cloudflare
Tunnel or a named Caddy edge. Settings has no selected Domain hostname, checked
Cloudflare zone or complete route observation, so it leaves an unset intent
unselected and explains the explicit choice. Domain setup retains eligibility
checks; review does not invoke its effectful discovery or gain a preparation-child
port merely to choose a default. Tunnel connectors provide backup rather than
load balancing; without a private network that covers host or connector loss
only. A Caddy edge balances over the private network and remains a single point
of failure.
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
exclusively and never recreate a missing retained log. First-deploy cleanup moves
the closed, log-only directory out of the runtime releases so the same receipt
and cursor can still read it. The normal log retention policy applies there too. The native Compose adapter
records repeated Volume/Network progress notifications once per resource transition
and command; ordinary diagnostics, application bytes and separate build/runtime
source progress remain unchanged. Cleanup removes only unchanged
manifest leaves and that pinned log under the source-root and native storage deletion
fence, preserving mounted paths, modified application files, shared data and other runtime bytes.
The latest attempt's operation log remains available for investigation even when
its failed release's source and images expire. Once another attempt becomes latest,
the older log follows the existing active and retained-release policy.
In 0.3 development, failed activation captures the candidate's masked runtime output
with the native log reader's byte budget before cleanup or predecessor restoration.
The failed receipt's runtime-log read uses its retained activation range, including
terminal stderr, rather than requiring the removed candidate or reading the restored
predecessor. Capture failure leaves the original activation stderr available and does
not prevent recovery. Previously deleted container output cannot be reconstructed.
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
semantic accepted-host continuity after controller changes still require their owning producers.
Joining restores the retained uniform artifacts onto every joining installation
and requires a successful native restore before the existing Domain owner enrolls
routes. When the requested source is exactly the serving release, the rollout
owner treats this as enrollment: it requires the same captured workload inputs,
restores only joining installations, and observes existing members without a
build, migration or activation. Serving-receipt source selection retains exact
repository or stored U even when the editor contains an undeployed B. Changed workload inputs refuse before native
effects. A mixed current-version vector or failed observation leaves the joining
receipt failed and membership unchanged; it does not redeploy existing members.
An explicitly different source remains an ordinary deployment to the full fleet.
Native health can be healthy or unverified when no health check is defined;
unknown and unhealthy results cannot enroll. Successful uniform settlement activates membership only after signed
Domain health is stored. Enrollment retains the serving receipt pointer and
native version IDs. The controller signs the retained pointer in the existing
transition body; the server compares it with the current locked link before
committing membership. Scoped teardown reconciles Domains to the surviving
members before native removal. Target-link replacement retains predecessor
custody independently; unlink consumes the completed teardown proof before
releasing the retired installation. These are development-source paths; the three-Machine join, rollback and
drain journey still needs live proof. The connected native journey and P45's typed
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
the Protocol role factories rather than maintaining a second grammar. A data
target's optional `dataV1.database.engineId` associates it with a database engine.
This development-source metadata is neither an Action reference nor an invocation
or credential grant. Neon and Supabase declare `postgresql`. Railway declares
separate `postgresql` and `mysql` targets. Selected-target resolution owns
transport selection and custody.
The parent branch reference is one strict provider-project/branch native-id pair,
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
The managed-data sheet reuses template Connect’s replacement review: each existing
runtime variable whose value changes must be selected independently before Bind.
A matching existing binding needs no replacement. Binding identities come from
the shared Environment binding owner, and its revision CAS retains write authority.
A Source manager reviews provider data-role bindings on the Environment's current
controller. The selected managed data Link determines the credential scope, and
the current controller installation receives its seal. A data-only Environment
can prepare this binding before it has a runtime Link.
The link’s optional private `data` leaf retains the native result’s engine, version
and provider-console link. The Data card and Database page share engine naming;
missing facts retain the target title and do not invent a console. These are
link-time facts, not live provider observations. Already-linked adoption preserves
the original content; it does not refresh or overwrite that stored presentation.
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

Production telemetry is being implemented for 0.3 development. The standalone
`happier.telemetry/telemetry` Machine role runs the collector only;
workspace-local capture belongs to the existing workspaces role. The host Action
`deployments.environments.telemetry.set` selects the collector and writes its
Machine ID together with the Environment bindings. Its ingest bearer is an
ordinary Account-mode Saved Secret delivered to application installations;
the collector receives only its SHA-256 hash after a successful runtime launch.
Changing collectors requires confirmation before deleting the old Environment
partition, including reconciliation when that Machine next comes online.

The same Action independently selects Metrics, App LLM cost and Exceptions in
private Environment content. Missing choices are off. Project and Source creation
defaults preselect new Environments only. One changed binding CAS also projects
the choices to the collector's authenticated assignments; a repeated selection
does no write. Disabling one takes effect at the next ingest admission while
traces, logs and the other choices remain independent. In unreleased 0.3 source,
arming the saved regression Workflow with Automatic authorizes its declared
`workflow.trigger.add` step. After a successful deployment, a read Action returns
the once schedule from the receipt's finish time and the configured observation
delay. The native step adds that schedule to the same Workflow. When the trigger
fires, the Workflow compares retained windows using the deployment history at
that time. Disarming the Workflow stops further automatic evaluations.

The Environment Telemetry tab is the deployment host's reader for this retained
data. Its Endpoints, Traces, Logs and Queries tabs use the selected time window
and the Environment's collector assignment. The tab retains results for the
selected collector, Environment and Account read lifetime. Trace selection opens
the shared request view, which follows the trace into query and correlated log
details.
Settings uses the Environment binding owner. The capture owner supports Clear
for the caller's Machine worktree and refuses it for an Environment source.
The Environment tab shows an unreachable collector as unavailable.

In the Services Apps list, the optional [Requests column](collection-presentation.md#model-and-presentation)
reads the same collector assignment. Its 24-hour number is scoped to the
Environment across emitting services.

Native launch preserves a project's authored telemetry values. Empty declared
slots receive the managed OTLP HTTP/protobuf endpoint, authorization header,
service name and resource attributes. The managed `OTEL_METRICS_EXPORTER` value is
`otlp` only when Metrics is selected,
and `none` otherwise. A same-Machine container reaches the
loopback receiver through `privateServiceContainerBridge`. Sampling variables
remain absent unless a person selects a ratio; explicit sampling uses the
standard `parentbased_traceidratio` sampler and argument through ordinary
Environment bindings. Public collector exposure for platform deployments still
requires the deployment ingress owner's in-process target integration.

The cross-Machine source path uses an ordinary Domain with
`target: { kind: 'telemetry' }`. The Domain owner captures the selected collector's
native placement and resolves its observed Caddy `privateOrigins` against the
workload Machine's shared private network. An absent route or unrelated network
returns a typed unavailable result. The admitted launch reads topology through
the existing Domain Verify child with its exact retained capture; it does not
repeat Source authorization. Native loopback collectors retain the existing
gateway bridge for the receiver's lifetime, restore it from the installed Caddy
route after receiver restart, and close it when the receiver is withdrawn.
This path still requires composed native reachability validation.

The in-development deployed collector App uses the existing own-server Compose
lifecycle and dev-box image owner. It runs the daemon with a dedicated volume
for the whole `HAPPIER_HOME_DIR`, retaining enrollment credentials, installation
identity, device-local keys and capture data together. Compose exec/putFile is
the native carrier for managed enrollment: the container creates an auth request,
the host approves through `approveTerminalAuthRequest`, and the container claims
and persists its own credential from Home. The enrolled container Machine is the
collector selected by `telemetryMachineId`.

For that App, its accepted deployment receipt identifies the native host while
Account-mode Machine metadata carries the private service name and declared
port. The same telemetry Domain routes to the observed service containers.
Service identity and port are excluded from Home's public Machine association.

When the controller host belongs to another Team member, the enrolled App keeps
a credential for the deployer's Account on that host, under the same
trusted-custodian model as the deployment secrets that host already receives.
Newly issued App credentials bind to the enrolled Machine and are revoked by
the existing Machine owner on App teardown or Environment deletion. That binding
survives redeploy and pairing-request retention. Live sockets subscribe to the
same terminal credential's withdrawal; an App first completes ordinary HTTP
Machine registration before it can open a live stream. Unbound pre-D39 App
credentials have the same signed shape as ordinary terminal credentials and retain
ordinary terminal behavior. Re-enrollment issues a bound credential that follows
the Machine lifecycle; it does not individually identify the old unbound bearer.

Only this App placement declares `HAPPIER_DEPLOYED_TELEMETRY_PORT`. The same
receiver uses that fixed container-interface port; all other placements retain
their localhost listener. The existing Domain/Caddy owner supplies TLS ingress,
and the existing ingest bearer still selects and authenticates the Environment
partition. Source-driven guest CLI installation uses Home's existing guest CLI
export and promotion owner; publishing a P6-capable dev-box image remains with
the image/release owner.

Telemetry content stays on the selected collector Machine; Home and the relay
do not store it. For a Team Environment without a collector, setup offers the
existing collector App deployment when no always-on Team Machine is known. It
does not implicitly select a personal Machine. Teammates read through the
existing transport under the Environment's data principals; collector Machine
ownership is separate from that read authority. The Environment's R16 access
list authorizes telemetry reads once; database agent access settings govern
database operations and add no telemetry read gate.

OTLP header values follow the [exporter configuration specification](https://opentelemetry.io/docs/specs/otel/protocol/exporter/);
resource attribute separators follow the [Resource SDK encoding specification](https://opentelemetry.io/docs/specs/otel/resource/sdk/).

In 0.3 development, Environment Settings also exposes registry bindings through
the ordinary `deployments.bindings.set` Action. A manager chooses an existing
target link, registry origin, pull-only or push-and-pull access, and a Saved
Secret reference with its selected revision. The editor does not open secret
material. An access or secret change at the same address replaces that binding;
changing its target or origin removes the old structured identity and sets the
new binding in one patch. Removing a binding uses the same canonical identity
projection. The Account mode, picker and Action owners retain their existing
custody and encryption decisions for plain and E2EE Accounts.

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
Stored App Presets can retain the same optional `domainBindings` alongside
`bindings` for a catalog App. Machine Setup forwards these selections into its
ordinary template child and binds the reviewed child to that saved intent.
The same preparer fills declared public defaults and omitted generator selections
through `buildCatalogAppTemplateBindings`, after explicit selections and retained
upgrade bindings. A preset's `bindings` carries public values or Saved Secret
references (with `resourceRevision`), never plaintext for a secret-typed variable.
Generated selections retain only the declared key; apply creates Saved Secrets
and sends their references through `deployments.bindings.set`. Preview generates
no bytes. Missing required variables without a default or generator return
`template_variable_required` with the variable key in `details.key`.
A required template Domain without a selection still returns
`template_domain_required`; Setup does not invent a hostname. These inert
selections survive preset source copies and capture; authored Compose App
intent does not accept template Domain selections.
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
In 0.3 development, the named Supabase Dokploy template can declare HS256 JWTs
using an independent generated signing secret and a typed Supabase role payload.
Hash helpers count hexadecimal characters, including odd lengths and literal
prefixes. Normal installs and preview companions create these through Saved
Secrets; descriptors, bindings and Action results retain references only. A
selected signing dependency must also be generated in that installation and
phase; using an existing Saved Secret as a signing input remains unavailable.
Secret-bearing mount content still requires review and is never published as a
public file. Other templates retain their existing helper admission.

Connection outputs remain Compose interpolation expressions; preparation never
creates a secret, resolves a credential URL, writes content or deploys a service.
Replacing an existing variable binding, including with a generated credential,
and conflicting application connection keys require explicit per-key Replace
choices before any secret creation.

The private Environment content's optional strict `template` leaf records the
exact registry pin, pristine selected `compose`, applied stored-definition
revision/digest and selected service/health/data/export/login hints. The retained
Compose precedes binding substitutions, companion and volume choices, and local
edits; it is the next three-way merge's baseline, not the applied definition.
Applied Compose stays in `definition`, credentials stay in `bindings`, and no
template catalog or secret-reference map is copied into this metadata. P45 owns template semantics at the existing Environment CAS owner;
the ordinary stored-content writer remains the sole Compose writer. Metadata,
binding and stored-definition changes retain their separate owning admissions.
Canonical initial creation may include prepared template provenance. For later
updates, the ordinary writer preserves `template`, the binding writer changes
only `bindings`, and the narrow template writer changes only `template`. The
template writer shares the existing Environment lock, revision CAS and
publication; its stored-definition revision/digest must match `definition`.
For encrypted content the authorized host must enforce the same leaf ownership
before sealing; the server does not reinterpret ciphertext as plain content.
The development `deployments.templates.instantiate` Action routes stored-content
requests to the persisted Environment controller, or the reviewed controller for
a new Environment. A repository proposal instead selects an admitted Project
workspace and executes on that checkout's Machine. Its runtime target may be
another installed Machine. Preview reads the exact ready registry pin and the
current definition without generating secrets or writing Artifacts. Repository
review includes the exact base commit, Compose path and before/after files; apply
uses the shared SCM worktree/commit/PR composition and returns the exact PR.
On the requester's own checkout Machine, repository Apply uses its admitted root
to look for a workspace association before retiring the scratch worktree. Home
scopes this read to the requester's workspace references at its portable Home ID.
Merge and deployment are separate Actions. Stored apply uses the ordinary Compose
writer. Both paths use normal agent Ask policy, P42 generation and binding custody
and the metadata-only CAS route. A later failure returns
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

The Environment's catalog update notice opens the same selected-item read and
template preview/apply flow. The review shows the proposed Compose and public-file
diff, preserves hand edits and Saved Secret refs through the pinned three-way
merge, and saves without deploying. Removed or unchecked sources offer the
existing source editor and an explicit retry; observing an update never changes
the running app. New installations retain the selected pristine Compose in that
existing private provenance, so replacing a mutable catalog entry does not remove
the merge baseline. Earlier records without it still use their immutable registry
pin when the original source remains available. If that original descriptor is
unavailable, update returns `template_source_unavailable` without writes; edited
Compose and retained applied Artifact revisions cannot reconstruct it. Restore
the exact original source and retry when available, or install the current
template as a new Environment and transfer desired edits explicitly. No baseline
is guessed for an existing installation. Matching unreleased 0.3 readers reload
together; older strict development readers do not accept the added private field.

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

Direct Machine Setup and applying a saved preset both install catalog Apps
through the Run admitted by Setup Apply. The installed native Setup leaf and
the signed remote leaf use that same accepted Run to associate the reviewed
App actions with the saved Machine setup. Setup Apply admits the selected
catalog App's deployment operands along with the Machine. The installed Run
dispatcher uses this admission to obtain an Action-specific proof from Home
before the deployment controller reads retention or prepares the App.

The strict template review retains the selected descriptor's optional
`firstRunSetup: true` hint, including inside the Machine setup parent's app
reviews. It describes first-visitor administrator setup; it does not report that
the app is configured or create a credential. In development (0.3), the
Environment Overview consumes that hint and the catalog's declared login fields.
It shows the runtime username, uses the shared Saved Secret disclosure controls
for secret values, and offers an admitted serving address for first-admin setup
or the Domains panel when no address is available. The guidance stays conditional:
an already configured app uses its existing administrator. Captured image
references and manifest digests identify the serving receipt; a new deployment
can resolve a newer tag, while an exact release keeps its captured digest.
Loaded-runtime verification of this presentation remains pending.

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
`needs_repository`; unverifiable Account mode refuses with `client_required`.
An end-to-end encrypted Account gets the same step: the binary's in-process SDK
seals the request when `HAPPIER_TOKEN` is an encryption-capable `hapc_v1`
credential, and a plain `hap_v1` bearer is refused at the controller with
`client_required` and `details.requiredFact: 'api_token_encryption_access'`.
The step uses the installed `happier` binary, the selected Home's canonical URL,
`secrets.HAPPIER_TOKEN`, the event SHA and the run id/attempt as its request key.
It does not embed a token value or select a deployment Machine.

Placement for an API token reads one content-free fact before submission:
`GET /v1/deployments/environments/:environmentId/controller?serverId=<Home>`
returns `{ serverId, environmentId, controllerMachineId }`. Home answers only when
the token's grant admits `deployments.deploy` on that exact Environment (checked
before any row read, so an ungranted Environment refuses the same way whether or
not it exists) and the Account may deploy it now. The answer is routing, never a
Machine grant; the submission is still admitted at Home against the current
controller. Its success also confirms the authenticated Home identity, so a fresh
CI runner needs no saved Home profile. The full Environment read stays closed to
scoped tokens.

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

In current development source, GitLab push and merged merge-request Events join
GitHub in the same Automation admission and deployment controller. GitLab setup
uses the existing catalog Action `gitlab/setup-repository-event`; its exact
Connected Account resolves the repository on the configured deployment. Configure
the returned source through the ordinary durable webhook endpoint Actions and
register that endpoint with GitLab for push and merge-request delivery. The host
verifies `X-Gitlab-Token` before persisting delivery, using the shared signed
webhook verifier boundary. The token remains in host credential custody.
Self-managed deployment base paths are part of repository identity. Real GitLab
tenant delivery remains an owed release check; this source description does not
establish a loaded or released integration.

For an opted-in trigger, the controller reads the normalized GitHub or GitLab push
or merged pull/merge-request occurrence. Its declared `sha` input receives `payload.after` for a
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
destination before creating private content or associating a new link. In the
development UI, Configure's Check uses the same comparison in the Project
Source's owner scope. An existing association offers to open the linked Environment.
Link repeats the comparison at write admission because the inventory can change
after Check. Requester keys and credential principals do not define that tuple. Incomplete coverage or
unreadable content refuses preparation without disclosing an existing destination;
replacing that same link skips its own prior tuple. Its link writer stores host,
plugin runtime and data identities in the same relational owner. Prepared Artifact
references still use that storage writer directly. This client-side comparison is
not a database uniqueness guarantee between concurrent preparations and does not
establish platform runtime readiness.

In development, a runtime target may also declare a create Action. The saved
Environment's platform editor reads that Action's fields and credential purpose;
the draft editor still prepares existing resources without creating them. Native
creation runs on the Environment controller through `deployments.targets.link`,
after admission into the existing encrypted Action operation record. Its original
request key prevents another native create, and the acknowledged provider identity
is retained before private Artifact publication or Home association. An incomplete
link returns that exact resource for an explicit association retry while the
Environment remains at that intent's expected revision. A later Environment write
supersedes that incomplete recovery; reopening Add platform offers a fresh choice
without rebasing or replaying the old intent. An unacknowledged native outcome
remains uncertain and is observed on its original controller; changing
future placement does not replay it elsewhere. Provider-console links use only a
destination supplied by the adapter. These development paths remain under integration
validation; real vendor tenants are release checks.

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
skip Account preferences. Its public core covers build/controller placement,
release retention, preview placement and database mode, and backup destination,
schedule and retention preferences. A backup destination stores its contributed
identity, never its credentials or destination configuration. Omitted setup
preferences leave the corresponding domain's defaults intact; an explicit null
destination or schedule means off. Creation/first-configuration writers must
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

In development source, `deployments.backups.test` proves destination write/read/delete
access through the same pinned native runner and credential custody. It writes a
nonsecret probe, verifies the exact snapshot's payload checksum and length, then
forgets only that snapshot. Probe snapshots omit Environment backup tags. Test
never runs Prune; unreferenced chunks remain for ordinary Prune. Failure evidence
retains the known probe identity and whether cleanup completed, failed or remains
unknown. Test does not prove durability or restore integrity.

Development-source backup metadata has one Protocol codec for source selection,
retention and normalized native manifests; deployment-protocol consumes that codec
for the Environment backup leaf. The manifest binds repository, snapshot/tree, source and configuration
revision; it is not a separate backup store. Source IDs remain unchanged in
configuration and operation receipts. At the native tag boundary, lossless IDs
keep their existing `src:` tags; IDs containing commas or trailing whitespace use
percent-encoded `src-v1:` tags because the pinned
[Restic parser splits commas and trims whitespace](https://github.com/restic/restic/blob/v0.19.1/internal/data/tag_list.go).
The manifest owner reads both forms for run, inventory, verification and restore.
Existing tags and retention groups are preserved; matching readers and writers
reload together before writing the encoded form. The semantic run owner consumes
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
Run uses the existing PostgreSQL producer-success-gated stream or the named-volume
adapter. Volume sources name the logical Compose volume and a declared writer;
the native generation owner resolves the actual mount, stops its declared
writers, mounts that volume read-only for restic, and resumes those writers after
success, failure or cancellation. Verify reads the
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
Development-source backup setup and retention editing use the controller Action
`deployments.backups.configure`. Its four intents are `test`, `save`,
`initializeAndSave` and `markNotNeeded`; each is admitted as a mutation. Setup
that does not require a source Machine can run before an Environment has a
deployment target. Generic Environment updates
cannot write backup configuration or retention.
The host resolves the installed destination and calls
`prepareDeploymentBackupConfigurationV1` to validate its nonsecret configuration,
source selection, ownership and credential-role identities and capture the current
occurrence. First setup resolves creation defaults through the Project defaults
owner; an unset retention policy means Keep everything, and no schedule is created
implicitly. Destination field labels and choices come from its descriptor's
`fieldHints`.
AnotherMachine setup consumes the Environment already read by Configure. Its
signed Configure admission derives `receiverMachineId` from the digested setup
input. Mint and each person-presented relay admit the requester's current
Machine use and the Environment owner's access to that receiver. Removing the
grant refuses the next start, restart or retry; reads of admitted work consume
the signed scope without repeating those checks. The selected runtime link's
sole member owns its data; the controller is not a fallback. With zero or several members, setup returns `source_unavailable`
before sender, credential custody or Machine Setup effects. The shared data
operand selector uses the same single-member owner for backup and restore.
Native multi-Machine backup and restore operands remain unavailable until an
admitted per-service placement fact exists.
Test acquires invocation-scoped credential material through the existing P42
owner and checks the selected repository with a write/read/delete probe. It does
not initialize a repository or persist configuration or bindings. Save requires
an existing repository; only `initializeAndSave` initializes one. For a missing
local destination, Test reports repository absence without creating directories.
Explicit initialization prepares the full repository directory as the daemon
before starting the pinned helper. Restic keeps its root identity for application
volume access and restore. After a local repository-writing command, the same
helper recursively returns only the selected repository to the daemon's host
UID and GID without following symlinks. This also repairs existing root-owned
repositories on their next backup. An unknown host identity skips ownership
repair with the structured native warning `backup_repository_ownership_unavailable`;
an ownership repair failure fails an otherwise successful command. SavedSecret
references remain on the canonical `deployments.bindings.set` writer with purpose
`backupDestination`, composed as a reviewed child after a successful probe. Home
receives prepared Artifact references and public metadata for the Environment
revision CAS, never credential values. A partial save or binding failure reports
the actual retained references and revisions without claiming readiness.
`markNotNeeded` requires no configured destination or enabled backup Automation;
it does not remove remote repository data. Retention changes preserve capture
`configRevision`, so existing snapshot verification remains valid.
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
scheduled snapshot with `source.kind: 'repository'`, `source.backupOperationId`
and the exact `source.snapshotId` from inventory or history. The host selects that scoped successful
run receipt; callers never provide a manifest or native capture. Omitting
`source.backupOperationId` retains pre-migration receipt selection. Confirm must repeat
the preparation's exact operands. Retained run selection spans deployment
generations within the same Account, Home, Machine installation, Environment
and target link. Callers keep the active `deploymentId`; the receipt retains its
original generation, and restore targets the active native deployment.

New backup runs retain optional `restoreCaptures` with their original PostgreSQL
database or named-volume identity, source, configuration and repository, without credential values. Older
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
operation-history age/count expiry. Read-only inventory/history results are
refreshable; these reads and destination probes retain ordinary history policy. Admission and terminal recovery
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
The Project home Readiness widget binds the Project itself without a checkout.
Its explicit Environment picker borrows the Project's existing paged deployment
collection; selection and Refresh invoke one composite read while presented.
Read failures retain the Action owner's diagnostic code; explicit Refresh retries
the finite read without creating a Session.
The widget selects one Environment. The public Action also accepts a batch of
Environments belonging to its admitted controller; a mixed-controller batch is
refused at admission and does not route implicitly to other controllers.
Opening Fix opens the existing owner setup or editor without writing configuration
or creating a Session. Ask agent uses the configured Triage owner
with the exact Project, Environment and fact. Its existing Environment subject
retains this optional Readiness context in reference evidence and verifies the
Environment's Project membership before choosing Agent placement. Different
facts retain different handoff outcomes; opening the widget reads no handoff catalog.
Its controller reads the exact Environment membership and revision. Health and
Alerts borrow the same saved Workflow source configuration. A whole finite refresh
performs one Account source census for its selected Environments and borrows one
readonly notification channel catalog when destination inspection is needed;
neither is persisted as Readiness state. Current health coverage
comes from the admitted observer's retained Domain observations, including their
original timestamp and same-Machine or outside vantage. Native service health is
not evidence of saved check coverage. Secret readiness exposes only counts of current
required grants for the exact Environment and installations, never values. Backup health
comes only from the backup owner's exact scoped operation records: the last successful
backup and last verification result, with their recorded completion times. Failed
verification retains only its safe code and step on the existing operation result.
When the caller selects only an Environment, its current runtime link supplies the
backup target through the shared data-target selector; an explicit target remains explicit.
Reading readiness or the daily digest never opens restic or acquires repository secrets.
No recorded backup reports `no_verified_backup_yet`; scheduled verification owns freshness.
The existing receipt query is daemon-local: a controller reports backup health as
`unavailable` for another target daemon until that owner exposes reachable recorded
facts. It never interprets inaccessible remote history as an empty backup history.
The result identifies each fact's owner and reports `ready`, `actionNeeded` or
`unavailable`. CI and security Source presence is projected by the selected repository
provider through the existing Forge CI and caller-scoped Triage owners; CI run results
and security finding counts do not decide source readiness. Saved alert destinations
are inspected by their own channel provider without sending a notification. Missing
owner projections remain explicitly unavailable. An older configuration's verified
backup does not establish current configured-source readiness. The backup owner
requires recorded verification for every currently configured source, without a
consumer-defined age threshold. Readiness does not mint another public admission or
acquire a separate credential. Backup starters use
the same public Actions and input builder. The daily digest reads selected Automations
through `workflow.trigger.list` and `workflow.run.summaries`, preserving native
next-due and actual started-run facts without a local scheduler.
Backup maintenance reads the current Environment at execution. A saved Nightly
schedule binds its Account, Home, stable Environment, destination and backup
policy. Each occurrence resolves one current exact target through the existing
Environment reader; run, verification and maintenance use that same capture.
A new deployment of the same Environment does not require rewriting the trigger.
Changing its bound identity or schedule/retention policy requires fresh automatic
approval. Without a current target, the occurrence reports unavailable and has
no backup effects. Environment-changing Actions, including restore, retain their
revision checks; explicit restore and drill source captures stay exact.
After Configure returns a captured nonnull `review.creationDefaults.backupSchedule`,
the UI or agent adds it through the existing public `workflow.trigger.add` Action.
Configure does not create a schedule implicitly. A failed follow-up retries only
schedule creation; the configured backup remains visible without a schedule.
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
`verified: true`. If the amcheck extension is absent, an otherwise correct restore
activates with `verified: false` and the typed integrity-unavailable remedy below. A rollback is not successful restoration. The approved native
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
standalone phases as `mode: 'prepare'`, `mode: 'confirm'` and `mode: 'recover'`. All are effectful
Environment-scoped writes with their own default Ask policy; a person confirms
the irreversible operation, and scoped agent policy can explicitly allow it.
Preparation selects `source: {kind: 'repository', snapshotId, backupOperationId?,
origin?}` or an opaque `source: {kind: 'upload', transferId}`, observes the
current destination, and takes the required safety backup before returning
nonsecret evidence in its existing Action operation. Confirmation names that
`prepareOperationId`; the installed host reads the succeeded preparation under
the same requester and Machine, checks that its operands match, and gives the
native lifecycle fresh P42 material. The existing operation runner rejoins repeat
confirmations for that preparation instead of swapping the database again.
If the daemon no longer retains the preparation, the caller must prepare again.
If a confirmation changes the prepared operands, start a new preparation rather
than reusing the rejected operation.
When volume activation and its automatic rollback both fail, the typed
`recoveryRequired` result includes a `recovery` Action reference for
`nextAction: 'restorePreviousVolume'`. Invoke that same Action with
`mode: 'recover'`, the failed restore's `operationId`, and its original target and
source operands. The scoped operation reader selects the exact preserved original
volume and running services; callers cannot supply native volume names. Recovery
uses the same Environment owner, Machine admission and default Ask as confirm,
without taking a fresh snapshot, reading backup credentials or reopening an upload.
It reuses native activation and health checks, publishes the original volume
binding on the serving generation, and returns `rolledBack` with the original
failure evidence, or `recoveryRequired` with both causes if recovery fails.
Follow the newly returned recovery reference after a failed recovery: its
operation retains the updated binding receipt even when health is unverified.
Recovery is admitted against the failed operation's recorded serving receipt and
revision. A later restore or deploy makes it `superseded`, with the newer
activation identified and no native changes. Historical receipts without this
activation reference remain readable but require `inspectStagingVolume` instead
of automatic recovery; a missing cause is not reconstructed. Database/SQLite inspection next actions remain
operator recovery instructions and do not advertise an automatic Action reference.
This is a development-source 0.3 contract: reload matching Home, CLI and client
sources before invoking the new mode; no released 0.2 restore input is migrated.
When that destination has meaningful data and its selected managed provisioner
supports a native snapshot, preparation also retains the provisioner's exact
snapshot offer when the admitted native launch has no remote Engine selector.
A remote Engine selector suppresses that offer with the typed review reason
`restore_snapshot_remote_engine`; ordinary restore remains available. This rule
uses the admitted launch selector and does not infer a remote host's enrolled
Machine identity. The current own-server runtime admits only its platform/PATH
environment and exposes no remote-selector input; setting an ambient Docker
selector does not select a remote Engine for this restore path. UI and agent
approval share coverage, billing source and
price when supplied, and observed running/stopped/unknown consistency. Snapshot
is selected by default for an eligible offer; a root-disk-only offer explicitly
excludes attached volumes and does not imply application quiescence. Confirmation
binds that retained offer as private `snapshotReview` and the selected `snapshot`
boolean; the clear admission projection omits the offer's native resource facts.
The existing signed child transport invokes the managed controller's qualified
snapshot role before native data replacement.

A failed, refused, unsupported or unknown snapshot stops the parent at its existing
`review_required` observation. Its receipt retains the typed snapshot outcome and
no data replacement begins. Repeating the same confirmation returns that held
outcome. Continuing changes only `snapshot` to `false` on the original public
input, goes through normal fresh approval, and resumes the same restore receipt;
other changed operands cannot reuse it. Successful or uncertain cloud effects
remain visible in the final result even when the person continues. Stop closes
the review; reopening Restore prepares a new review through the existing settings
entry. No second snapshot registry or continuation token is introduced.

The local-backup picker streams the chosen file through the existing encrypted
finite upload transport. The public restore input carries only its opaque
transfer ID. Uploaded PostgreSQL backups bind an exact service and database name;
the name is prefilled only from an actual retained capture or entered by the
person. Volume uploads choose a configured service and logical volume. Native
preparation validates the chosen destination and reports source format, byte
count and digest without publishing a daemon file path or inventing a backup
timestamp. The retained upload survives a held snapshot review under the finite
transfer owner's existing lifetime.

Standalone restore shares the rollback path's serving-generation runtime and
restore producers, and leaves deployment receipts and the active code pointer
unchanged. Its signed native admission admits the Source/deployer once and scopes
capture/current-generation reads and installed-secret acquisition to that job.
PostgreSQL integrity uses the engine's `pg_amcheck` default corruption checks
when the amcheck extension is already installed; it never installs extensions or
elevates the restore operator. Its supported object scope
is documented by [PostgreSQL](https://www.postgresql.org/docs/15/app-pgamcheck.html).
An absent extension returns `kind: restored`, `verified: false`, and
`integrity: { kind: unavailable, reason: amcheck_extension_missing,
nextAction: installAmcheckAndRunIntegrityCheck }`; the top-level next action is
the same. A database administrator can install amcheck in the restored database
and run `pg_amcheck` separately. This is a warning, not an executable recovery
Action or permission to escalate. An actual native integrity-check failure still
prevents activation or invokes the existing rollback path. Completed restores
retire their prepare receipt's temporary prune protection even when integrity
is unavailable; normal retention still governs their backups. Data-safe Move
continues to require `verified: true` before its separate connection cutover.
The matching Protocol, CLI and UI readers must reload together: the new strict
result arm is an unpublished 0.3 direct cut, with no migration or compatibility
adapter. The inspected clean `../0.2` deployment corridor at
`b4ed33827a0bbd1bb3afac7fd1b6833918e33e68` has no deployment restore contract.

The development PostgreSQL restore owner imports both uploads and repository
archives through an actual restricted login, preserving that non-superuser
object owner after activation. Successful import disables its login and removes
its password; restored `SECURITY DEFINER` objects never become administrator-owned.
Cancellation before retirement leaves the staged database and its restricted
LOGIN role for manual recovery. The result names `inspectStagingDatabase`;
inspect that operation's staged database and retire or remove its role as part
of recovery. Cancellation does not run a separate cleanup process or expire
the role automatically.
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
journey. Automatic pre-migration rollback recovery remains PostgreSQL-only;
SQLite and uploaded imports remain incomplete.

Development-source named-volume restore uses a fresh staging volume and restic's
verified restore. The native owner admits a volume that is unreferenced by both
running and stopped services, then activates its logical-to-physical mapping
through P41's existing rendered-generation and receipt owner. Docker volume
renaming is not involved. Activation preserves the original running service set;
a previously stopped service stays stopped. The original volume remains available
for the ordinary restore failure and recovery path.

The development-source `restore-drill` Workflow starter selects an existing
isolated Environment and keeps its volumes and sealed grants between runs. It
starts that Environment's current services, verifies the selected source
snapshot, prepares and confirms restore, and checks the restored data through the
restore owner's shared engine read operation. The selected target and statement
use ordered typed parameters. The installed backup or restore target executes
each Action under the Workflow's Home admission. Cleanup reads the current
service generations again and stops them after a definite success or failure.
A failed restore-and-check branch fails the Workflow after cleanup.
The starter uses an existing Environment and runs without an agent Session. Typed result rows,
completeness and
any diagnostic remain in the existing child result; incomplete output does not
claim a complete data comparison. The composed native drill and semantic host
integration remain under verification.
Exact-capture verification retains the original operation's repository and
configuration through the same restore/P42 credential owner. The current source
generation supplies native execution; its current backup configuration does not
retarget the selected historical snapshot. Run and prune continue to use current
configuration.
The retained configuration reopens the installed destination's nonsecret transport
through its ordinary Open Action. Local bind facts and SFTP host-key custody reach
P42 without adding fields to stored captures. The recorded repository locator wins
over Open's computed locator, including older root repositories whose capture has
a nonempty ownership prefix. Captured credential roles resolve the admitted source
Environment's current Saved Secret references at the next acquisition boundary.

Development-source stop-copy backups declare their exact admitted native service
IDs and retained Domain subjects on the existing Action operation before stop.
Confirmed resume withdraws those subjects. While that readable operation is
running, the existing health/Inbox projection presents the same open condition
as an Update with **Expected during backup**. After settlement or uncertain
observation, a still-down condition uses its ordinary attention policy. These
facts change neither health observations nor server-followed Machine presence.

The private `/v1/deployments/environments/:environmentId/backup` writer reuses
Source manage admission and the existing Environment/Artifact compare-and-swap.
For plain content it changes only the backup leaf; binding and template writes
preserve that leaf, and initial creation does not accept it. Ordinary Environment
updates preserve it except for the explicitly reviewed retention-only patch above. E2EE content
remains opaque to the server: the admitted client owns its content semantics,
while the server enforces the existing mode, envelope, authority and exact
Artifact-reference revision contract. There is no second credential or backup
status record at this storage boundary.

In current development source, standalone `deployments.backups.restore` selects
one `source`: a repository snapshot (`kind: 'repository'`, `snapshotId`, and
optional `backupOperationId` and `origin`) or a completed finite upload
(`kind: 'upload'`, `transferId`). Upload references are scoped to the requester
and destination Environment; callers never supply a daemon-local file path.
The optional `destination` selects a database or logical named volume. Native
execution support is separate from this input contract: SQLite and uploaded
imports remain incomplete.

Cross-Environment copy uses the repository source's explicit `origin`. Home admits Manage
on both Environments once and binds the source capture to the signed root's
`deploymentId`. The read-only `copySourceRead` purpose consumes that admission
for the exact source Environment, Link, receipt and installed executor. Complete
capture routing selects only the original backup Saved Secret grant ciphertext;
incomplete routing returns `secret_missing` for binding preparation. The existing
backup materializer opens only the source capture's declared bindings. Nothing is relabeled,
re-bound or sealed for another Machine. Version one executes on a source member
that already holds those grants and requires a reachable destination database;
cross-Machine credential transfer is not implemented. Ordinary restore retains
its same-Environment admission and generation rules.

The public copy consumer keeps the root Environment and Link as the destination;
`deploymentId`, `source.snapshotId` and optional `source.backupOperationId` select
the source capture. `source.origin` names its Environment and Link, while
`destination` names the destination service and database. The installed
executor must also serve the destination's existing native generation. Copy
uses the original capture receipt's operation for `copySourceRead`, including
a failed historical capture, rather than substituting the latest source deploy.
An existing destination database, including schema-only data, requires its own
configured backup. Copy's safety run uses that destination's ordinary bindings
and repository; the source purpose never writes a safety backup into the source
repository. A missing destination database needs no safety write. Copy creates
and verifies staging through the ordinary restore lifecycle; it does not change
either Environment's serving deployment pointer or the source database.

Private export references can select `component: 'host'` or `'port'`; omitting
it retains the complete endpoint. These are projections of the same admitted
export and forward, including its actual Iroh route. Database credentials do
not enter the export: the app binds the database administrator's Saved Secret
through ordinary Environment bindings and assembles its connection URL in the
reviewed Compose definition.

The development Database page's Move remedy selects an already provisioned,
dedicated PostgreSQL Environment with backups configured on the source executor. It runs a fresh backup
and the public restore prepare/confirm journey before offering app changes.
The destination supplies a private export, its template's public username and
database name, and its administrator Saved Secret. The review replaces the
app's connection URL with host and port reference variables and the ordinary
bound password variable, removes the old local database service and its
dependencies, and saves definition and bindings in one Environment revision.
A connection variable that cannot be rewritten is refused with its variable
name. A failed preparation or stale revision applies neither half. Saving this
review changes desired configuration; the person then runs the ordinary Deploy
to apply it. The original service remains running until that Deploy.

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

On systemd hosts, those setup declarations also install
`/etc/tmpfiles.d/happier-caddy.conf`. Early boot recreates the root-owned admin
bind directory with mode `0750` and the daemon group before Docker restarts the
container. Retained routes and certificate data stay under `/var/lib/happier/caddy`.

Current 0.3 development Domain get/list headers optionally expose
`routedReplicas: { source: 'recordedTopology', count, replicas }`. Each replica
contains only its Machine, installation and container dial identity. The native
installation signs this snapshot from the successful Domain apply; the server
retains it in the existing captured-placement JSON and deduplicates identities
across desired public/private listeners. Verification retains the snapshot.
Start-first route switches do not update it, so it describes the last recorded
Domain apply rather than live membership, traffic or health. Missing snapshots
remain unknown; known empty snapshots yield zero. Provider Domains, removed
placements and tombstoned Domains expose no replica snapshot. Private addresses,
networks, ports and route material remain outside this projection.

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
not Domain metadata; managed certificates leave issuer selection to Caddy's
native automation policy: public names use public issuers, while localhost,
`.localhost` and IP addresses use its internal issuer.
`target.redirectTo` accepts a canonical Domain (HTTPS by default) or an explicit
HTTP/HTTPS URL with an optional path prefix. Destination userinfo, query and
fragment are refused by this codec; the incoming path and query are preserved.
Public edge routes use admitted private-origin endpoints; private replica routes
use native Compose replica DNS names and the Environment's admitted source ranges.
The native Compose owner uses Docker's short container-ID DNS alias when the
container name exceeds the 63-character DNS label limit. Discovery and rollout
consume the same name decision. Only the private listener's exact GET health
request has the Basic Auth exemption.

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
not retire the incumbent until every affected leg is active. Ordinary Compose
redeploys use the same switch with the observed incumbent proxy as the expected
value. They settle after the local replica legs point to the replacement, for both
direct ingress and the Cloudflare tunnel origin.

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
unknown coverage counts down. A current native observation of a running service
without a readiness check contributes unverified liveness. It clears a prior
runtime outage when all the affected services recover and leaves authoritative
health recovery pending until a check succeeds. Stops, starts and restarts use
the same Machine Services push. The observer owns cross-call currentness and
withdrawal and supplies the projector with the current admitted snapshot. The read controller carries this one strict aggregate
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
For each list read, native disclosure resolves the candidate rows' distinct
Home aliases against one saved profile snapshot and authorizes the selected
Environment IDs as one set.

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
The Account authoring owner enrolls observation-only health checks on the existing
health-status Event so the same Notice receives failure and recovery. Explicit
workflow Actions retain their selected failed, recovered or status Event.

Opening setup again carries the plugin's canonical source identity. The existing
Account Automation inventory and private-definition reader resolve that exact
Event source before Configure, retaining its checks and selected monitoring
Machine. An unavailable or ambiguous saved source stays unavailable instead of
opening an empty replacement draft; a subject with no saved source starts a new
draft through the same writer.

Presented Account Checks borrow the existing Automation private-definition page
instead of issuing a detail read for each row. The authored Automation name stays
on `native.name`; `definitionFacts.checks[]` carries the current check-kind `name`,
human `targetLabel`, saved `periodMs`, `checkId` and nullable `domainId`.
These facts exist before a first observation. Domain targets use current Domain
content and the same HTTP/certificate target builder as the probe; row labels omit
URL queries and fragments. Unknown definitions or target content stay unavailable.
The existing `lastResults` projection remains the last-result owner. Hiding the
read releases private-page demand and opened Account material; reopening uses the
ordinary currentness read before disclosing facts again.

In 0.3 development, presented Environment collections, Overview and full
receipt pages share one current health observation for each admitted Environment
and runtime target. The observation uses the existing Machine Services Resources
and fetches current edge evidence for edge-backed Environments. Pending edge
reads leave the previous aggregate in place when one exists. Settled evidence
continues through the same Production health policy.

Collection rows and `detail.healthAggregate` receive the observation's same
aggregate. The detail `healthFeed` also exposes Service state, nullable
`observedAt`, reason and expected Stop evidence for active members. Record-only
consumers and Session receipt chips add zero health demand. A member installation
or Environment protection change rebinds current health. Hiding the last consumer
or retiring its Account releases the observation.
Historical receipt facts and L5's current URL/TLS remain separate projections.

Operations outcome links consume this existing Environment detail through
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

Failed Receipts and Environment Overview show a quiet reason and Retry while
their agent-action catalog is loading or unavailable. The Account investigation
owner supplies this state for the current subject and Controller, and Retry
uses the same catalog acquisition path.

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
condition from an already-readable running stop, restart, deployment, backup or reboot operation.
Native control publishes its exact service and generation before dispatch;
reboot captures running services and retained Domain placements for the admitted
Machine installation. Domain explanations require the exact Environment, link
and Domain probe subject, and never cover certificate failures. Aggregate
Environment health retains its ordinary condition policy. Recreate rollout
dispatch publishes the admitted member services and retained Domain subjects
before activation, then withdraws them on the child phase acknowledgement.
An unavailable, reconnecting, uncertain, foreign-Account or settled operation
supplies no explanation. The existing row renders **Expected during backup**
(or the matching operation); it keeps the same condition and read state. This
presentation changes neither the health observation nor server-followed presence,
and creates no second notice or separate expectation record.

For a contributed target whose installed descriptor declares no teardown role,
the development teardown Action prepares the existing plain detach disposition.
Agents use the same compact intents as the UI: rollback names the Environment
and retained `deploymentId`; teardown names the Environment and `reason` (plus
the target link when selecting one). Both include `serverId`. The preparation
owner supplies artifact and revision operands. CLI input refusals preserve the
canonical schema's typed issue paths, including a missing field inside a union.
Its review says remote resources, data and costs remain; an unavailable descriptor
is a typed refusal rather than evidence that the role is absent. Home executes
the same manager-only unlink owner and returns its typed `detached: true` result.
It creates no cleanup receipt or provider-absence claim. Explicit Detach keeps
that behavior. Stop and remove requests Environment removal and refuses this
keep-running fallback with a typed missing fact and a remedy naming Detach and
provider-side deletion. The Delete/Unlink dialog consumes the target's declared
teardown capability and omits Stop and remove when the target cannot perform it.
Its Detach copy names the provider where the workload stays running. It cannot claim
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
unless explicitly selected for data removal. Plain target teardown keeps
images available for rollback and leaves source files in place.
Stop and remove supplies `removeEnvironment: true`. Its native proof also
requires the absence of private receipt and activation image tags belonging to
that Environment on the admitted runtime Machines. Shared image tags, parent
images, unselected volumes, backups and history stay. Home admits the existing
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

Unreleased 0.3 public-listener Domain Add and Verify consume the finite DNS health
owner before signing the native observation. Draft preview resolves A and AAAA concurrently without
creating a Domain or requiring Caddy to be applied. Missing DNS reports `down`;
resolver failure reports `unknown`. When DNS resolves but the public Caddy
listener is absent or stopped, preview reports `unknown` with
`dns_public_listener_unavailable`. A configured public listener additionally
serves one exact temporary HTTP challenge through the native route owner, then
removes that challenge. This proves routing from the Machine's vantage, not
Internet reachability, TLS validity or application health. No DNS polling runs.
The native producer signs `warning` with the DNS evidence when applicable public
DNS is down or unknown; a successful public native route alone does not establish
DNS readiness. Private-origin observations, including Cloudflare Tunnel origins,
omit this public-listener proof and may settle active after native activation.
Home aggregates the signed states and retains the health owner's typed `cause`
(reason, vantage and available remedy) beside the display evidence;
membership readiness consumes the resulting Domain state. The semantic projection
consumes the same typed cause for saved Domains, retaining the historical finite
producer's JSON evidence only when no typed cause exists. Unknown DNS coverage
projects as unavailable with its original reason, without claiming failed
reachability.

Before public Caddy setup, the native port owner checks Docker publications and
host bind availability. On Linux, a denied privileged-port bind probe also reads
the existing listener inventory's kernel facts without process attribution.
A positive occupied-port observation returns `foreign_effect_conflict` with the
existing Tunnel-or-stop-the-other-proxy recovery before setup effects. It never
takes over a running listener. A port acquired after this finite check remains a
native-start failure with its reported recovery.

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
technical-details component. A settled active or warning observation supersedes
the retained Add failure; the original operation address still identifies
placement custody. A failed or cancelled Remove permits another
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

Before confirming native Domain Add, the controller asks the selected installed
Machines which Caddy placements need administrator setup. The review lists those
Machines and links the ones without administrator access to their Security
settings. The read-only child observes existing Caddy and Machine policy.
Domain Add prepares infrastructure only after admission.

In unreleased 0.3 source, Caddy setup preserves the elevation owner's typed
`native_protocol_invalid`, `native_check_unavailable`, `native_check_unsupported`
and `native_effect_failed` failures, optional closed native reason and existing
managed-CLI recovery. Domain presentation maps only proven administrator-policy
refusals to `machine_admin_access_required`; a generic denial does not establish
missing Admin Access. When a native Machine refuses, the Domain controller
reports that destination and the recovery opens its Administrator access
settings. An uncertain native effect remains `outcome_unknown`.
Own-server preparation also preserves `plugin_exec_system_tool_unavailable`
with the closed Docker details `kind: 'systemToolUnavailable'`, `toolId: 'docker'`
and `remedy: 'install_on_machine_and_add_to_daemon_path'`. Recovery is to install
Docker Engine with Compose on that Machine, put `docker` on the daemon PATH and
allow the daemon user to access Docker. Missing executable evidence does not
establish an Engine, socket-permission or Compose-version failure.

In unreleased 0.3 source, the existing `docker-engine` recipe accepts
`{mode: 'rootless', daemonConfig: {}}` for the recommended sandbox setup.
It installs rootless prerequisites, enables linger and a user Docker service,
then selects Docker's native `rootless` context for the Happier user. Docker
clients consume that context's socket endpoint; they do not construct a socket
path. Explicit `DOCKER_HOST` or `DOCKER_CONTEXT` selections still override the
user's default. The recipe uses the packaged `dockerd-rootless-setuptool.sh`
when its rootless script and Docker CLI share a directory, otherwise Docker's
documented user installer at
`https://get.docker.com/rootless`. Existing system Docker services are preserved.
On hosts restricting unprivileged user namespaces, the same reviewed step loads
an AppArmor profile for the Happier user's downloaded RootlessKit executable.
The host needs systemd and subordinate UID/GID ranges for that user, as required
by Docker's installer. Installer failure stays on the recipe step for Retry.
`{mode: 'group', daemonConfig: {}}` selects the compatible group setup, which
grants close to administrator power; existing inputs without `mode` retain that setup.
Shared-daemon configuration belongs to the group variant only.

Docker Buildx is also a prerequisite for registry and build image preparation.
Native `imagetools inspect` establishes immutable registry image index, manifest,
configuration and platform provenance before approval. Older Docker 29 engines
can attach a repository digest to a local image without recording where it came
from. When the anonymous registry denies access or has no such image, approval
can use the exact local tag on its single proved platform. The local archive
provides the image identity without making a registry provenance claim. A selected
registry binding, a pinned digest or a request for multiple platforms still needs
registry proof. Bake runs only for services with a build definition.
`docker_buildx_not_installed` retains
`kind: 'systemToolUnavailable'`, `toolId: 'docker-buildx'` and
`remedy: 'install_docker_buildx_plugin_on_machine'`. Install Docker Buildx on the
image preparation Machine (`docker-buildx-plugin` with Docker Engine packages;
the observed Ubuntu distribution package is `docker-buildx`) and verify
`docker buildx version` works for the daemon user. Installing Engine and Compose
alone does not establish that this plugin is available.

In unreleased 0.3 source, the deployment review names required build platforms
without claiming that emulation is in use. The native image builder observes
support when Bake runs. An explicit BuildKit execution-platform refusal becomes
`build_platform_unsupported`; a generic executable-format error remains
`native_build_failed`, since application binaries can cause it too. The failure
keeps a closed cause and exit code without exposing private Bake output.
Recovery opens the recorded build Machine's Setup, where the existing Build
emulation recipe can be reviewed, or directs the person to choose a capable
build Machine in Environment Settings. Emulated builds are slower.

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

Target-only teardown retires Domains attached to the selected target link and
keeps Domains on predecessor links, even when the selected link was the last
runtime. These retained records preserve custody and remain individually
removable. They are unattached unless their target link is the Environment's
current runtime link; an unattached Domain cannot supply a serving or admin
address. Removing the whole Environment captures Domains on every target link.

The existing Stop and remove confirmation lists the Environment's Domains and
approves one teardown operation. Receipt admission uses this inventory to capture
Domain retirement through the existing Domain removal owner, with the same
operation, controller and request binding. Its native calls spend that admission
and check only that the admitted job remains active. The controller retires the
captured Domains before target cleanup; it does not issue another Domain Remove
Action or ask for another confirmation. Native target cleanup then disconnects
the canonical shared Caddy container from exact Compose-owned networks before
removing them, preserving Caddy, its primary network dependency and sibling
attachments. Verification accepts the retained primary network only after
observing that the owned Caddy container is its sole holder. Other running or
stopped container holders still prevent verified target removal, and retry
can settle an already-retired target from that same observation. A failed
retirement returns a typed partial result naming the Domain, required fact and
remedy, records a cleanup failure, and leaves the Environment present. Environment removal is the
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
complete active set. Ordinary discovery also includes an exact Machine installation
whose incumbent receipt records a current release, even when a failed rollout
has left its TargetLink flag as joining. A joining installation without that
serving proof stays excluded. Admitted membership children consume their exact
desired installation set.
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
Prisma owns each snapshot transaction and its commit/rollback, so internally
chunked relation reads share the same snapshot. The adapter reads `query_only`
once when starting a transaction and chooses `BEGIN DEFERRED` for that connection;
writes retain `BEGIN IMMEDIATE`. Snapshot transactions reuse the existing
database transaction execution/acquisition budgets. Database shutdown drains and
disconnects the reader. This preserves row/cursor and access snapshots without a
writer lock. Other database providers retain their existing
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
start, using the existing transaction-attempt budget after setup. Each transaction
issues exactly one `SET LOCAL statement_timeout`: the stricter of that budget and the
operator's `statement_timeout`. The server reads the operator value once, in its first
PostgreSQL transaction, so restart the server after changing `statement_timeout` in
`postgresql.conf`, `ALTER ROLE`/`ALTER DATABASE` or connection options. Later
statements keep the same SQL limit. Prisma still owns
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

If the public S3 bucket is missing, denies access, or cannot be reached, the
Home still starts with sign-in, API and Sessions available. Check the public
S3 startup warning or `capabilities.server.fileStorage` in `/v1/features`. An
invalid configuration reports the setting name. Correct the reported issue
and restart the Home.

**Common**
- `PORT`: API server port (default `3005`).
- `METRICS_ENABLED`: set to `false` to disable metrics server.
- `METRICS_PORT`: metrics server port (default `9090`).
- `S3_PORT`: optional S3 port.
- `S3_USE_SSL`: `true`/`false` (default `true`).

**Development 0.3 private file storage**
- `S3_PRIVATE_BUCKET`: a separate provisioned S3 bucket for binary Artifact bytes and new Account Pet assets,
  using the existing S3 connection and credentials. It must differ from the public
  `S3_BUCKET` and have no anonymous-access policy. The server does not change bucket
  policies or fall back to the public bucket. Binary Artifact uploads return
  HTTP 503 with `private_storage_unavailable` when the private store is unavailable.
  The reason `s3_private_bucket_missing` identifies an unset or blank bucket.
- Pets imported to local storage keep their private disk paths. Keep the
  original private files volume attached when switching to S3 so the Home can
  read and erase those Pets.
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
- Logging format: `apps/server/sources/utils/logging/log.ts#resolveServerLogFormat` owns the default. An explicit `HAPPIER_SERVER_LOG_FORMAT` (Home settings or env) wins; otherwise `NODE_ENV=production` (every server Docker image stage) writes JSON stdout on the main thread, and development (source, stacks) keeps the `pino-pretty` transport worker, whose ring-buffer poll wakes about once a second while idle. The registry entry has no static default, so the Home setting stays editable in Docker.
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
  `HAPPIER_WEBAPP_URL` (for example `https://cloud.happier.dev`) and the public HTTPS ingress
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

Deployment HTTP read eligibility derives from each ActionSpec's declared read
effect and transport, within the mint's admitted purposes. Preparation receipt
reads require its admitted deployment-child intent; a template mint without
that intent cannot borrow history from its otherwise selected Environment.
The existing admitted operand scope then binds the Home,
Environment, Source, target and receipt; an eligible read is not a grant to
another resource. Writes retain their exact preparation and retained-child
purposes. Repository-backed template preparation carries its selected Workspace
key in the signed admission and reads only that key through the Project row
owner. These are matched 0.3 development Protocol/Home contracts; older strict
development readers may reject the added optional Workspace projection.

Backup capture reads the desired Domain placements retained for its selected
target, including their captured Artifact versions. Prune reconstructs history
through that target's predecessor lineage and opens only demanded receipt
Artifacts. Standalone restore can publish revised volume bindings on the
selected target's active generation through the existing receipt and Artifact
CAS; it preserves lifecycle state, settlement time and target activation.
Reviewed Backup Configure preparation reads the newly created preview child,
using the preparation scope rather than the parent Environment.

Create's own preview preparation reads its captured template before allocation;
reviewed storage children read the allocated Environment. Allocation comes from
the existing Account/request-key relation and does not require a Deploy intent.
Native service adoption uses this same Create preparation owner. Its managed
allocation lookup names the adopted Machine and Home. Reviewed Create binds its
canonical child role and full storage-input digest; optional bindings bind their
canonical child role and the Environment allocated by that root. An unreviewed
adoption root cannot allocate an Environment itself.

## Authored Domain and binding Actions (0.3 development)

A template install that has saved its definition but cannot save required secret
bindings remains partial. New development writes retain incomplete secret
requirements until `deployments.bindings.set` commits; Deploy returns Home's
existing `secret_scope_*` reason before native work. Complete binding saves
restore readiness through the same writer. See [Environment installation
grants](encryption.md#environment-installation-grants-03-development-source).

`deployments.domains.add` accepts either authored `content` or prepared Artifact
references. Both forms use the same canonical Domain content schema. The installed
Domain owner reads authored content for review without publishing it, then creates
the invocation's private Domain candidate after Action admission, before native
discovery opens it. Home permits only that signed candidate and binds the prepared reference
back to the admitted routing metadata. Team content uses the Environment owner's
existing Artifact grant path. Refused Action admission creates no private content.

Platform addresses use these same Domain Actions, records and private Artifacts.
Their desired target is `{ kind: 'provider' }`, with an explicitly selected zone
for a Worker, rather than a native service, port or Caddy placement. The selected
runtime target declares `actions.domains.read/add/verify/remove`; the installed
host invokes those roles through its existing reviewed-child port. Provider DNS
instructions stay in the private Domain Artifact. A controller-signed observation
settles the public Domain state without putting the hostname or DNS values in
server-readable metadata or the root Domain Action result.

Provider lifecycle observations separately retain optional `builtInUrls` in
unreleased 0.3. Vercel contributes confirmed assigned `*.vercel.app` aliases,
excluding the unique deployment URL and custom domains; Workers contributes its
provider-enabled script `workers.dev` route. Vercel Production uses the confirmed
alias for its serving URL because the unique deployment address can require sign-in.
If alias assignment is unconfirmed, the production serving URL is absent. Preview
deployment URLs remain in `urls`. Missing built-in facts mean unobserved, while
`[]` records observed absence. These facts create no Domain artifact or removal operand.
Domains consumes the already-opened serving receipt rather than making another
provider request. Workers traffic changes reuse the same optional address reader
after native activation; an unavailable address read preserves proven activation.

Cloudflare Pages custom domains apply to Production. An initializing or pending
provider result leaves the Domain in its warning state and retains the provider's
CNAME and, when supplied, TXT instructions. Check again reads the provider's domain status without adding or
retrying it. Workers custom domains require a Production script and an explicit
zone from the linked Cloudflare Account. Zone selection reuses the existing
Cloudflare selection owner with deployment custody and does not enumerate
tunnels or choose a zone from list order. Pages Preview and Workers Preview
custom domains return `unsupported_action`; neither request changes the
Production target. These are unreleased 0.3 source contracts.

Vercel Domain observations keep ownership and routing separate. Pending ownership
retains its TXT challenge alongside any routing instructions. Routing uses the
provider's preferred (rank 1) A records for an apex or CNAME for a subdomain,
without combining conflicting record families at the same name. A Domain is
active only when ownership is verified and routing is configured. These are
unreleased 0.3 source contracts.

Check again asks Vercel to re-check ownership with its verification POST. This
remains a safe, read-only role because it changes no user configuration. An
unverified Domain retains its TXT instructions and private native failure cause
when Vercel reports pending verification; a token denied Domain access remains
a typed refusal. The existing private provider observation carries the cause.

Cloudflare's Pages add and Workers attach responses return the Domain object,
and a successful Cloudflare or Vercel delete acknowledges removal. The adapter consumes those
responses directly. It does not re-read its own writes to demand a stronger
absence or visibility guarantee. A separate Check again remains a read of the
provider's current state. See the official [Pages domain API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/)
and [Workers domain API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/),
and Vercel's [project Domain removal API](https://vercel.com/docs/rest-api/projects/remove-a-domain-from-a-project).

Own-server teardown includes removal of retained provider Domains from earlier
runtime Links. Its review includes their provider children. The accepted job captures their private Domain,
Environment and Link references under the same controller and request proof.
Cleanup invokes those exact reviewed children and settles their signed Domain
observations through the existing removal owner. The bundled platform targets
use the explicit detach-and-keep-running path; their remote resources and Domains stay.

A Domain's reviewed Cloudflare Named selection also selects tunnel placement when
the Environment has no ingress setting. The Domain route-selection owner supplies
that effective ingress to both controller discovery and native setup. The selected
configure child must acknowledge the tunnel route and proxied DNS CNAME before
native activation can settle the Domain as active; a failed or unknown configure
result cannot be replaced by successful public Caddy activation.
The prepared body update carries the Artifact owner's matching revision provenance
and key envelope through the existing Artifact writer, keeping the new body readable
without changing the retained header.
If preparation fails after Cloudflare acknowledges a tunnel ID, the Domain saves
that ID before returning the failure when its content update succeeds. Its typed failure identifies the retained
tunnel and adoption recovery, preserving the provider's original cause and safe
response diagnostic. The Domain host settles preparation and subsequent native
failures through the same failure owner. Its closed public failure contract retains
these recovery facts in the operation and approval readers. After resolving the cause,
the address row's Adopt action reviews the existing Domain Add with the saved tunnel.
If the content update itself fails, Adopt authors that exact tunnel selection through
the same Add action. Neither recovery creates a replacement tunnel. Remove cleans only its owned routes;
the shared tunnel remains available for deliberate inspection or retirement.

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
For Cloudflare Tunnel, `patch.ingress.connectorsPerMachine` defaults to one.
On the next apply the existing Domain owner reconciles that many connectors
per serving Machine. Happier retains the first connector's name and appends
`-2`, `-3`, and so on for further replicas. They use the same sealed token.
Extra connectors cover a connector restart or crash. Use separate Machines
to cover Machine failure. [Cloudflare limits a tunnel to 25 replicas across
all Machines](https://developers.cloudflare.com/tunnel/configuration/#replicas-and-high-availability).

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


## Environment secret recovery and Compose use review (0.3 development)

An unavailable Saved Secret keeps its metadata-only binding notice. After withdrawal or
deletion, Overview and Variables offer the existing Machine service controls for the
Environment’s recorded native generations. Withdrawal leaves an admitted process running;
Stop is an explicit service control. Start controls the same generation without recreating a deployment. Native service
pushes decide when Start becomes available after Stop. The existing service Action owns
Environment approval and current-generation admission.

At deploy review, the native Compose normalizer supplies interpolation names from its merged
source model. The host compares those names with admitted Environment variable bindings and
projects optional name-only `variableUseWarnings`: bindings without an interpolation
reference, and interpolation references without an Environment binding. These are nonblocking
review warnings, not inferred missing or empty effective values: Compose may supply a default.
The UI does not parse Compose when the Variables page opens, and no source text, secret value,
reference address or guessed file/line location enters this fact. Unused extension definitions
are excluded after native expansion. The existing native interpolation-reference scanner also
protects secret build arguments; escaped `$$` remains literal in both consumers.

Reference address changes are compared with the serving receipt by the existing materialization
owner at deploy review. The review carries the binding name, phase and observed route when
available. A running release keeps its recorded address until a person deploys again.

### Retained check uptime (unreleased 0.3)

The machine-services health observer stores compact daily sample counts in each
check's existing encrypted Account KV checkpoint. `healthResultProjectionSchema`
adds optional `checks[].history`: `lastObservedAt`, `uptimePercent`, and `days[]`
with `dayStartAt` (UTC), `up`, `down`, `degraded`, `unknown` and `uptimePercent`.
The window is today plus the preceding 29 UTC calendar days. Percentages are
`100 × up / (up + down + degraded)`; unknown-only or empty windows return null.
This is sampled availability, not inferred wall-clock availability. Missing days
remain unobserved. Older checkpoints have no history until a new sample arrives;
there is no backfill or fabricated pre-install history.

`readConfiguredHealthResults` / `useConfiguredHealthResults` carry this projection
through the existing Account KV push subscription. The shared
`healthResultProjectionAt` owner expires buckets at read time even while the
observer is disconnected. Existing probes append samples and prune storage;
re-adopting the same observed timestamp does not append it again. No new probe,
timer, table, poll or alert transition is introduced. A held view crossing UTC
midnight refreshes on its next existing read or push.

## Database Move Workflow (0.3 development)

The data-safe Move starter uses the existing Workflow Run and Action owners.
It stops each reviewed source writer and observes its native stopped state before
capturing the final backup. Only the selected source's final snapshot is verified
and restored. Current destination health precedes the reviewed Connect change;
the app deploy and health check follow that change. Source data stays retained
unless the person explicitly supplies a separate resource-retirement request.

For a cross-Environment restore, `deploymentId` names the source capture receipt
under `source.origin`. The restore owner resolves the destination's active
generation independently; destination health uses that destination receipt.

A refusal before cutover offers a review that explicitly resumes the captured
source writers and abandons the Move. An uncertain child operation preserves its
receipt for recovery. After acknowledged or unknown cutover, the Run requires a
decision about the actual serving configuration; it never blindly restarts the
old writer or replays an unknown restore. Continuation uses the Workflow engine's
persisted invocations. The stateless Machine Move starter retains its existing
repository-only behavior.

## Database size observations (0.3 development)

`acquireDataServicePage` exposes `items[].databaseSizes`, keyed by the declared
service. The size-only `deployments.data.size` host read replaces the former
generic SQL path for this deployment feature; its input contains no SQL.
`readDeploymentDatabaseSizesV1` owns the projection and calls this semantic
read. The native deployment host uses its existing admission and calls the shared
engine operation in process. This deployment feature remains available with the
optional workbench disabled. The shared engine statistics compiler owns size SQL and decoding;
the projection retains growth and unavailable outcomes. PostgreSQL uses
`pg_database_size` for the connected database; MySQL sums the engine-reported
table data and index lengths.
The available size carries `measurement: database_bytes | table_bytes_estimate`.
MySQL table statistics are [approximate for InnoDB](https://dev.mysql.com/doc/refman/8.0/en/information-schema-tables-table.html).
These are engine measurements, not backup archive sizes. Unsupported engines,
missing role setup and failed/incomplete reads carry explicit unavailable reasons.

A demanded page reads placement headers once per Environment containing supported
databases and executes one query per supported service. Non-database and unsupported
rows cause no placement or native reads. No Artifact detail fanout, timer, new
credential scope, history store or server-readable database content is added.
The existing page controller retains the prior sample in its Account lifetime.
Growth reports signed bytes between two observations of the same service and
active deployment, with both timestamps; the first sample or a replaced deployment
reports `previous_sample_required`. This is not daily growth or durable history.
Database and Services composition consume these facts; UI composition remains
separate from this data contract.
