# Plugin platform and SDK ownership

## Channel Session status (unreleased 0.3)

The Channels outward projection consumes accepted input provenance and the
host's pushed Session activity, alongside the existing pending-permission
projection. A provider may implement the optional `sessionStatus` operation:
its closed input carries connection/endpoint facts, a status enum and an
optional native message id. It never carries transcript text or tool arguments.
The Slack adapter posts a native message and edits that message for subsequent
changes, including waiting for approval and terminal idle. Unsupported providers
retain their existing reply behavior.

This is best-effort presentation within the current activation, with no durable
job state, activity polling or refresh timer. A restart or uncertain native write
may leave an older status visible; delivery diagnostics identify unavailable
status writes without logging conversation content. Session lifecycle and
permission decisions remain with their existing owners.

## Connected Account request headers (unreleased 0.3)

`lookupConnectedAccountRequestAuth({ purpose })` returns `RequestAuthHeadersV1`:
the complete `headers` map, scalar `facts`, optional real `expiresAt`, and
`credentialContext` for the existing failure and recovery association. A purpose
can require Basic authorization or API-key headers without a Bearer token.

Service runtimes return `httpHeaders` material with optional `facts` and
`expiresAt`. The daemon's plugin adapter validates the result once, supplies an
empty facts map when omitted, and preserves it through the existing request-auth
cache and SDK transport. Only plugin adapters interpret fact keys; the host and
SDK carry strings, finite numbers and booleans. Facts are request-local data.

The consuming purpose declares one `origin` and `headerNames`. The managed gateway
keeps its private family origins list for the existing final outbound destination
check. Native adapters that require a
Bearer token extract it from the returned header map at their own codec boundary.

## Input options Resource queries (unreleased 0.3)

`action.options.resolve` remains the options discovery owner. Its partial
`draftInput`, `fieldPath`, search `query` and `cursor` are the single typed query
passed to a dynamic Resource callback as `options.query`. A Resource can return
an options array or `{ options, nextCursor? }`; the same Action returns the
continuation. The input-type owner validates option values before disclosure.

Query operands never select Resource authority. Headless reads use the admitted
global or Session scope and the existing read-only `readAction` custody binding.
Each query is a finite read with its own callback signal; it neither joins nor
publishes ordinary context snapshots, preventing account and page requests from
sharing bytes. UI row reuse and equal-page publication suppression remain in
`inputFieldOptionsStore`, independently of Resource transport.

Bundled and installed plugins contribute through the same manifest, registration and projection contracts. The host owns installation, admission, currentness, invocation and cleanup; a plugin owns its integration's declarations and executable leaves. The SDK exposes that boundary without becoming another runtime or persistence owner.

### Partial runtime adoption (unreleased 0.3)

Cold startup, registry preparation and prepared-registry adoption share the
readiness owner in `apps/cli/src/plugins/runtime/reload/readiness.ts`. An activation,
source or trust failure makes that plugin unavailable with its diagnostic code.
The manifest reference resolver identifies and excludes its dependent plugins,
including transitive dependents, through the existing manifest admission exclusion
and activation-failure projections. The admission exclusion also marks dependents
without daemon entrypoints unavailable in the catalog.
Healthy plugins remain admitted. Logs name the blocking plugin ids and codes;
dependent diagnostics retain those causes. Static declarations remain available
for diagnosis and repair. Existing predecessor retirement and lease custody still
govern changed plugins.
An unpublished composition records its own exclusion without changing a borrowed
incumbent activation component; existing component leases own its cleanup.

Stored `approvedAuthorityManifest` values retain the person's consent across host
schema and SDK projection changes, including rollback and ordinary publication.
The installation-state owner validates their object framing and matching plugin
identity, preserving the historical bytes. New installation and development
approval candidates still pass strict current-manifest admission.
Consumers use Protocol load admission for the usable declaration projection;
unsupported contributions are withdrawn with diagnostics, without withdrawing
trust or affecting healthy peers. The update comparator consumes that projection
only as a baseline, never as a new grant. A withdrawn authority-bearing contribution
can therefore cause an extra delta prompt on the next update. Plugin-wide baseline
failure keeps consent but refuses updates with `plugin_update_trust_unavailable`;
a reviewed install repairs it. Baseline admission does not enforce engine ranges,
so an update can repair an older engine requirement. Runtime admission retains
its compatibility checks. Unreadable JSON, mismatched revision/plugin identity,
or invalid registry framing remain whole-registry failures.

Registry-wide integrity failures remain errors: inconsistent or duplicate
contribution identities are rejected by `createResolvedContributionRegistry.ts`;
superseded durable/development candidates and missing predecessor retirement
support are rejected by `reload/controller.ts`. A single optional activation
diagnostic does not reject its peers.

### Health setup client activation (0.3 development source)

Machine services declares `health/open-setup` as a client Action on its existing
`health-setup` artifact, whose `activate` export registers the bound opener.
The ordinary Automation Event authoring route carries the watched `subject`
from `setupInput.subject` into the native renderer's `initialInput.subject`;
observer selection remains independent. Opening setup does not enroll a check
or execute a service effect.
Reopening a saved Event merges its existing `sourceConfig` with the renderer launch
intent in `initialInput`. The exact subject's canonical source id makes page and
Machine entries reopen that same source. Domain setup intent names its Domain and
target link; the renderer asks for cadence before returning complete saved checks.
Launch intent stays outside the setup Action's input. The plugin returns complete
Action input through the existing form owner, which validates it and resolves its
connected Account; the host does not assume saved, launch and Action shapes match.

## Cold Bot template declarations (unreleased 0.3)

The canonical contribution family registry admits `botTemplates` entries as
closed `{ id, path }` descriptors. `definePlugin` authors supply a keyed
`botTemplates` record, projected through the same manifest admission. Several
entries are allowed. Paths address portable package-relative JSON files whose
contents remain BT2's `BotTemplateReleaseV1`; template format and release
validation belong to that owner. The selected-package reader supplies registry
provenance separately. Its contribution-registry projection carries descriptors only;
the family has no runtime registration, startup scan or activation demand. Generic `resources.kind: 'template'` does not
declare a Bot template. The [public fixture](../packages/plugin-sdk/examples/public-authoring/botTemplates.ts)
demonstrates this development contract; the generated SDK capability matrix
records product availability.

Registry lists may select `contributionFamily: 'botTemplates'` without fetching
package bodies. Selected detail reads `listing.summary.botTemplates` through
`readBotTemplateContributions(pointer)`. `readBotTemplate(pointer, contributionId)`
uses the existing npm acquisition and archive ingress, reads only that declared
JSON file, and delegates release validation to BT2. UI callers use the existing
Account-scoped `template.preview` Machine Action, preserving registry credential
placement. Preview never installs dependencies, runs package scripts or activates
the plugin. Missing discovery descriptors require an updated package format;
there is no list-time archive fallback.

Explicit updates use `readBotTemplateUpdate(pointer, contributionId)`: the existing
unpinned plugin metadata read supplies the offered version and `allowed | pinned`
policy, then the same cold reader resolves the selected exact version. A pinned
listing keeps the current package. The Bot update owner retains the accepted
transport source when settling, so Info opens that accepted package. Registry
refresh remains with its existing owner; templates add no polling or update cache.

## Session Skills presentation (unreleased 0.3)

Skills extensions consume the existing Session `rightSidebarTab` target and
typed host Actions, without a Bot-specific rail registry. The generated SDK
Action DTOs project Protocol's selected `skills.list` input, private creator
projection and acknowledged `skills.create` summary/inclusion result. Existing
Action policy and Artifact/Session access own each call; card presentation does
not evaluate consent, grant access or decide runtime application.

`HappierSavedSkillCard` is a shared semantic presentation component exported to
plugin authors by `@happier-dev/plugin-ui` and its `/components` entry. Core uses
the host-only `/presentation` entry for the same implementation. Callers supply its
name, description, maker, status and host-routed controls. It performs no I/O or
application inference. The maintained public-authoring companion demonstrates
the Session slot and a requested `skills.read` result, explicitly leaving
application unknown. Immutable transcript snapshot rules remain unchanged;
shared presentation does not create a host-card override, live-resource seam or
second transcript persistence path. See [skill runtime ownership](runtime-core.md#session-path-and-owners)
and [private creator attribution](encryption.md).

## Desktop destination presentation (unreleased 0.3)

`PluginUiHostApi.openSurface(destination, input, { presentation: 'window' })`
requests the same destination in a desktop window. The Protocol request owns this
optional field; omission preserves the destination's ordinary container. The
mounted navigation binding resolves the exact contribution once and dispatches
to that container owner's window adapter. Page routes and scoped pane addresses
then use `desktop.windows.open`, sharing its availability, reuse and lifecycle.
An owner or host without window support returns `unsupported_method`; it never
silently opens an ordinary container. `Action.OpenSurface` in plugin-ui exposes
the same presentation option.

Window movement and relaunch restore the existing page or pane state. Runtime
launch input remains one-shot and does not become a portable draft; the existing
restoration fallback applies. Unpersisted dirty work uses the existing departure
guard. This adds no plugin checkpoint API, native-window SDK or second destination
registry. See [SDK evolution](compatibility.md#sdk-protocol-evolution).

## Built-in plugin enablement (0.3 development source)

Built-in plugins default to enabled in both Account and Machine scope. The
bundled contribution admission owner combines those intents: a plugin is
available on a Machine only when both are enabled. It withdraws the disabled
plugin's contributions from admission; required host-import packages remain in
the distribution for packaging, without making those contributions available.
Enabling both scopes restores the contributions. Disablement retains plugin data
and credentials, and already admitted work finishes at its natural boundary.

A failed Account enablement census withdraws new admission with
`plugin_account_census_failed`, preserving the code-only failure cause, phase,
HTTP status and available Request ID in the catalog diagnostic and file log.
An unclassified read failure is not an authoritative Account execution refusal.
The daemon does not reuse last-good Account enablement for new admission;
already admitted work still finishes at its natural boundary. The next runtime
lease or catalog read retries a failed census through the existing admission
refresh; a successful read re-admits all withdrawn plugins without waiting for
an Account change. A relevant Account availability signal or successful
Account-feed reconnect uses that same refresh. Healthy reads and ordinary
unchanged live pages do not trigger census requests. Admission compares the full
bundled enablement result and republishes only changed plugins. Session creation
preserves the catalog's typed refusal while Account execution is unavailable.
New Session, CLI creation and runner bootstrap refusals carry the original
Account census cause through Action settlement, including a typed usage-limit
cause when supplied by the census producer. Pool usage alone does not classify
a failed Account census.

In 0.3 development, bundled plugin locators exclude disabled plugins before loading their manifests. Before the daemon has an active registry, the synchronous built-in snapshot reads the persisted Machine intent once through the admitted registry reader; it excludes disabled declarations and their UI artifact indexes. Runtime admission still combines Account and Machine intent. Exact selections retain their enabled entries; an enabled dependent keeps healthy sibling contributions while admission prunes references to unavailable plugins. The daemon constructs its Workflow runtime at the existing `isWorkflowRuntimeEnabled` reconciliation boundary: disabled startup performs no Workflow assignment reads, and later enablement uses the next lifecycle recovery or claim boundary.

The `plugins.enable` and `plugins.disable` Actions accept an optional `scope` of
`account` or `machine`; omitted scope selects the Machine. Plugin administration
exposes both switches for the selected Machine. A Session whose Agent plugin is
disabled reports the typed `plugin_disabled` issue and offers **Manage plugin**
for recovery. These are development-source contracts, not a 0.2 release claim.

In the unpublished 0.3 author contract, hook declarations provide `on` plus
optional filters, priority and HostAccess requests. Protocol manifest admission
stamps category, scope and execution kind from its canonical hook catalog;
`definePlugin` projects through that same owner. Hook API versions are
host-owned. Runtime ABI version 1 is defaulted by authoring and manifest
admission, and `engines.happier` remains an optional host-range restriction.
The retired hook version, hook/Action open bags and generic backend-surface bags
are not extension points. Typed attach metadata retains its dedicated schema.

## Health check kind declarations (0.3 development source)

External monitor inputs use the existing capability URL webhook handler delivery,
then the saved health source observer. The handler reads its admitted source and
maps only the configured monitor identity and endpoint to a check. Raw provider
bags stay in webhook custody; a normalized retained result supplies the declared
finite check Action. Its local observed Event wakes the same observer, whose
failure threshold and transition cursor remain the sole health notice producer.
Changing the source configuration withdraws results retained for its old basis.

`healthCheckKinds` is a declarative family in the existing Protocol contribution
catalog. A local kind id projects as the plugin-qualified identity; its local
Action reference is resolved by ordinary same-plugin reference admission.
Configuration schemas are recursively closed. Integrity requires a daemon
Action with explicit closed input and the exact canonical `HealthCheckResultV1`
result and no tracked `operation`. Safety and read-only labels do not restrict
trusted plugin code; invocation still follows the person's ordinary Action policy.
Invocation presentation scopes do not choose Environment or Machine authority;
the admitted subject's owner derives that scope at execution.

The SDK's authored `definePlugin` adapter projects these descriptors without a
registration API, scheduler or additional registry. CLI normalization and daemon
projection carry the descriptor with its existing supplying occurrence and
execution origin. Declaration presence grants no invocation, network or subject
authority. Observer adoption and transition publication remain separate existing
source-lifecycle consumers; this development declaration contract alone does not
claim an installed observer or released availability. See the public
[finite-kind author guide](../apps/docs/content/docs/plugins/guides/background-services.mdx#health-check-kinds-development-source).

For service handles held by the observer's managed-service owner, saved finite
checks publish their admitted results through `machineServiceRowProjection`. The
publication binding resolves a saved check's local profile against the service's
portable Home identity through the existing server-profile identity owner; another
Home's result cannot bind to the service. The exact service
generation retains those results for the supplying observer's lifetime. Native
failure takes precedence; otherwise the least healthy retained check supplies the
service row's health. Finite Action completion leaves the result available, while
observer retirement, source withdrawal or service retirement removes it. Service
reads and existing pushed row updates consume that same projection; no UI health
inference or additional polling is involved.
Successful source adoption reconciles retained service and Domain health after
the adopted snapshot changes. An earlier invalidation signal alone does not
establish that a source has been withdrawn.

The development daemon service `services.healthChecks.read({ sourceInstanceId,
checkIds }, { signal })` spends saved selectors against the existing adopted
Automation source projection once per finite batch. It accepts no endpoint or
observer override. The first-party Machine-services HTTP/certificate observer
consumes this binding through the shared checkpointed Event runner; generic
Environment and Machine-service checks also share the finite HTTP, certificate,
TCP, DNS and heartbeat owners. Qualified contributed kinds validate their saved
configuration against the admitted declaration and invoke its finite Action
through ordinary Action dispatch. `services.healthChecks.listKinds({ signal })`
projects that same admitted catalog; `readSource({ sourceInstanceId }, { signal })`
reads the current adopted source of the Machine-services observer. Configure uses
that same `health/setup` Action with `mode: 'preview'` before saving. Its readonly
branch returns a draft with effective P40 Account/Project alert defaults only when
the alert leaf is absent; explicit empty channels remain Off. It enrolls no
endpoints, writes no source and sends no notification. Its optional
`destinationSelectionContext` is the existing Machine target of the admitted
Environment controller or service owner, including first Configure. Destination
selection waits for this address instead of borrowing the editor's observer.
An optional `testContext`
contains only a real saved source revision and its current service owner or
Environment controller, addressed through the invoking Home profile; changed
alert choices do not borrow that saved selector. Full Save retains the existing
validation and capability enrollment. Manifest admission retains the exact
canonical Save result branch and accepts a disjoint strict `mode: preview` branch
only with the corresponding readonly Action predicate. Event enrollment still
parses only the canonical Save result. A contributed
producer uses that source to resolve its exact saved `checkId`, rather than
accepting replacement endpoint or monitor configuration from the caller. P30 admits
the live service reference and the existing HTTP owner retains network/cancel
policy. Its cursor retains effective status and pending first-observation
evidence, not a tick history. Equal results emit and persist nothing. The current
health result continues to refresh on the saved check's existing due
schedule while Event admission is pending. Replays retain the first Event's
result, occurrence identity and observation clock; fresh probes do not replace
that Event. Once it settles, the next due observation can admit a recovery.
The binding is daemon-only. Machine-services bundled activation still requires its
package membership and generated locator; source/testkit registration alone is
not installed availability.

In development source, the same saved observer contributes selectable
`happier.machine.services/health-check-failed` and `health-check-recovered`
Events through the ordinary plugin Event catalog and admission path. Their closed
payload contains only `sourceInstanceId`, `subject`, `checkId`, `transition` and
`observedAt`; probe evidence and endpoints stay on the daemon. Down and degraded
are one failed condition. The existing source configuration, failure threshold,
pending checkpoint and occurrence identity govern both Events, so equal failed
observations and restart replay do not create another run. The incumbent
`health-status` enrollment remains supported by that same producer. Certificate
and Domain-bound checks use these Events too; they have no second alert sampler.
Observation-only enrollment retains its existing marker. Executable enrollment
uses an ordinary Workflow target and the existing per-Action approval policy.

The shared checkpointed observer retains a source attempt's safe typed error
code in the existing source-status `code` field; exception messages, details and
provider payloads are not published. A provider-owned retry deadline reports
`backingOff` with that deadline. An unavailable attempt with no deadline settles
as `attention`, with no timer. The existing authenticated source wake or
`@happier/automation/event-sources-invalidated` event (for example, reconnect or
changed source configuration) admits the next attempt. A removed source requires
its enrollment owner to replace or retire it; a wake cannot restore an absent
adapter.

In development source, adopted Event catalogs refresh on initial need or the
existing Event-source invalidation/reconnect push. Provider observation deadlines
reuse the adopted catalog. After a catalog failure, observers pass their existing
provider retry deadline to the occurrence-local adopted owner; subscribers share
one pending retry and its result. The observer also reaches its existing wait
before retrying, so transports that fail immediately cannot bypass the deadline.
One expired-deadline retry may run immediately; if it fails with another expired
deadline, the observer waits for invalidation/reconnect. A relevant push expedites
the wait. Healthy empty scans publish source status only
when its acknowledged semantic state changes; successful probe deadlines are
liveness rather than durable retry state. Failed status reports remain eligible
for publication on the next natural provider cycle.

An unsettled admission carries its safe failure code and known retryability in
the SDK disposition. A nonretryable refusal parks the source even when its
provider supplied a later observation time; it neither advances the checkpoint
nor retries until the existing authenticated wake. Missing retryability remains
unclassified, and the provider's existing eligibility still owns retry timing.

The canonical status reader adds a typed explanation to list/detail projections
without storing new facts. It exposes the retained reason, required source
availability and the restore-registration-or-admission remedy. Legacy `admissionUnavailable`
rows explicitly identify their underlying cause as not recorded. Historical
`backingOff` rows with that code and no retry deadline project as `attention`:
no automatic retry was scheduled. This does not change the retained row or
promise that reconnect can restore a removed registration. This explains
the saved status; it does not repair the underlying source or admission failure.
See [source-status compatibility](compatibility.md#event-source-failure-codes-unreleased-03).

The shared automation Event catalog retains keyed titles and descriptions in
optional `event.localizedPresentation`, alongside its string fallbacks. UI
consumers pass those descriptors to the existing plugin translation resolver;
they do not map Event ids to copy keys. Machine services declares title and
description resources for all supported locales through its ordinary plugin
translation contributions.

The same Machine-services catalog contributes `managed-machine-setup-failed`
and `mcp-update-available`. The first reads `machines.managed.get` and the
server-retained failed operation's `settledAtMs`; the second reads
`mcp.servers.read` and the MCP registry tracker's `upstreamObservedAt` plus exact
upstream fact. The tracker stamps only changed observations in its existing row
CAS, retaining a monotonic observation time even within one clock tick.
Unchanged observations keep their identity. These finite sources share the
existing checkpointed runner; ordinary Event admission owns replay deduplication.
An enrollment start excludes older settlements; older rows without a retained
clock do not fabricate historical Events. Sources consume the latest retained
fact, not a transition history, and do not claim to recover overwritten facts.

The daemon forwards committed Account entity ids through the content-free
`@happier/account/entities-invalidated` Host hint. Each source selects its row and
reads through its existing Action; reconnect uses the existing source invalidation
hint. There is no observer polling or new timer. Closed payloads expose operation
ids and error codes for setup, or installed/upstream reference digests for MCP;
scripts, configuration, registry URLs and private evidence remain outside Events.
`machine-offline` and `machine-online` consume the existing presence owner's
committed timeout and recovery decisions. The nullable `Machine.presenceTransitions`
field retains the latest offline/online pair with stable revision identities;
enrollment captures the current revision and emits no initial-state Event.
`machines.presence.read` uses existing Machine access for owners and grantees.
The source stack database owner must deploy the append-only
`20261102101034_add_machine_presence_transitions` migration before loading the
producer and catalog. The retained pair does not recover overwritten cycles.
Backup failure/missed
production remains with P45.

Environment/Domain checks use that same saved-check admission owner. Setup
requires the Environment's existing management capability; finite reads open the
current Domain Artifact for its hostname, path and expected status instead of
copying those values into observer configuration. The same observer's HTTP result
feeds the runtime-only current edge projection and the P40 aggregate alongside
native workload facts. The shared Environment read feed consumes it through the
existing Action/Resource transport (`deployments.health.current` /
`deployments.health.edge`). Missing proof, a changed controller/link, or a stale
Resource cannot prove recovery. A Domain result proves edge reachability only,
not every runtime member behind it. This is development-source wiring, not a
claim of installed activation or completed security/loaded-runtime validation.

### Record-only heartbeat (0.3 development source)

Explicit saved-check setup enrolls each heartbeat through the existing webhook
endpoint owner. The runtime binding uses its captured Account/Home credentials
and installation publisher proof; source configuration retains the endpoint id,
not its secret capability URL. The saved-check setup surface reveals the URL
only after the person chooses Reveal address, with Copy URL and GET/POST curl
commands. The whole URL is a secret. The existing endpoint-read flow owns that
disclosure; it remains unavailable to agent and MCP surfaces.
`healthChecks.manageHeartbeat` admits the exact endpoint/source/check and current
observation host, then delegates rotation or revocation to the endpoint owner.
It returns only status, revision or a typed unavailable/conflict result. Rotation
retires the old route and preserves the stable check's latest receipt; the person
reveals the replacement address explicitly. No new token store is introduced.
GET and POST to that URL record only the endpoint's monotonic `lastAcceptedAt`;
they create no delivery, Action run, health result, content or Account change.
Only the assigned Machine receives a compact receipt hint. Adoption/reconnect
reads the exact endpoint/source/check tuple through the same finite binding.

Heartbeat is the named liveness contract: null remains unknown with no timer;
a timestamp stays current through period plus grace, and the existing observer
owns the first strictly-late wake and the configured consecutive-failure
observations. Once settled late it parks until a receipt hint or source change.
Hints enter that same observer loop; no second timer, polling loop or receipt
store is introduced. The endpoint retains the exact saved `checkId` (up to
2,000 characters); its existing source uniqueness index uses the endpoint
owner’s `checkIdDigest`, avoiding MySQL key-width and PostgreSQL B-tree limits.
The digest is an index operand, not a public identity or authorization proof.
The append-only `20261101151500_plugin_webhook_check_identity` migration adds
the digest nullable, backfills existing identities, then replaces the index and
requires the digest. PostgreSQL uses its built-in SHA-256 with JSON string
encoding; MySQL uses SHA2 with JSON_QUOTE. SQLite uses the existing canonical
migration preparation hook and `createPluginWebhookCheckIdDigestV1`, shared
with the endpoint owner. Deploy through the canonical migration runner before
loading the matching generated client. Historical migrations remain unchanged.
Loaded UI and actual MySQL engine checks remain unverified.

## Finite HTTP metadata (0.3 development source)

The shared Fetch transport revalidates HTTP cache entries for finite and streaming
reads. A browser can reuse a validated response, but cannot satisfy an explicit
native re-observation solely from a fresh cached response after an Action writes
to a different provider URL. This uses Fetch's `no-cache` mode at the transport
owner; callers keep their existing read and post-mutation completion paths.

The public Account-purpose credential binding carries the issued `origin` and
required `method: HttpMethod` alongside `purpose` and `headerNames`. Finite
snapshots preserve these fields; streaming requests reuse the same binding arm.
The credential host owns comparison with the actual request before injection;
this does not widen the HTTP-header materialization schema or establish loaded
host availability.

The existing HTTP request/snapshot/redirect/transport owner consumes optional
`responseBody: 'discard'` and `observeTlsPeer: true`. Metadata-only reads release
the body without consuming it; requested TLS metadata comes from the same native
validated connection, with native chain and hostname checks retained on Node and
Bun. Missing peer capture does not turn an HTTP success into an HTTP failure.
The public response keeps peer metadata separate from status and body. Existing
invocation currentness still precedes disclosure; metadata is not authority.
Saved-source health-check admission and observer integration remain distinct
consumers, not capabilities established by these HTTP request options.

### HTTP attempt attribution (0.3 development source)

Set `HAPPIER_WEB_LATENCY_TRACE=1` in the daemon's launch environment to enable
the existing file-only `[external-action-stage]` sink. The daemon must load this
source; changing another shell's environment does not enable an existing daemon.
File logging must allow warnings (`HAPPIER_LOG_LEVEL` must not be `silent`).
No extra service, timer, endpoint or persistence is involved.

The shared plugin HTTP owner emits one `contributed.http.transport.end` per
transport attempt, including failed attempts, redirects and retries. Preparation
without dispatch emits none. Finite and streaming requests use the same metadata
projection; a stream's transport event settles when the response opens, not when
its body finishes. Count only `.end`, not the accompanying `.begin`.

The event contains `pluginId`, the existing bound contribution's qualified id as
`operationId` when available, `method`, `routeTemplate`, and `httpStatus` when a
response exists. The explicitly selected `x-ratelimit-remaining`,
`x-ratelimit-reset`, and `x-ratelimit-resource` response headers become
`rateLimitRemaining`, `rateLimitReset`, and `rateLimitResource` when valid.
Numeric quota values remain digit strings; resources use the known GitHub bucket
names. Unknown or malformed quota values are omitted. These are request counts,
not charged quota: a conditional response can have a different quota cost.

Known `api.github.com` routes use literal templates such as
`/repos/{owner}/{repo}/pulls/{number}`. Other routes, including GitHub Enterprise,
replace every path segment with `{segment}`. No origin, raw path segments,
queries, URL credentials, auth headers, bodies or error text are recorded.
URL userinfo remains rejected before transport and produces no attempt event.

The local daemon log uses this single-line format (action/root request context
and absent response fields vary):

```text
[HH:MM:SS.mmm] [WARN] [external-action-stage] {"actionId":"action.invoke","stage":"contributed.http.transport.end","pluginId":"happier.scm.forge.github","operationId":"happier.scm.forge.github/actions/scan","method":"GET","routeTemplate":"/repos/{owner}/{repo}/pulls/{number}","httpStatus":200,"rateLimitRemaining":"4356","rateLimitReset":"1793496661","rateLimitResource":"core","elapsedMs":12.3}
```

For a log window within one day, count terminal attempts by daemon-local minute,
plugin and operation (replace `daemon.log` with the existing daemon log path):

```bash
python3 -c 'import sys,json,collections; c=collections.Counter((l[1:6],d.get("pluginId","unknown"),d.get("operationId","unattributed")) for l in sys.stdin if "[external-action-stage] " in l for d in [json.loads(l.split("[external-action-stage] ",1)[1])] if d.get("stage")=="contributed.http.transport.end"); [print(*k,n) for k,n in sorted(c.items())]' < daemon.log
```

## Manifest admission (0.3 development source)

HostAccess request declarations and their Action, Hook and dynamic Resource
references share one request-id grammar. Request ids such as `deploy.manage`
are not contribution local ids. Ordinary reference admission still rejects
undeclared requests and duplicate references; a declared purpose is available
to an Action only when that Action selects its HostAccess request.

The manifest contract is **strict author, tolerant load**. `definePlugin`, pack,
and doctor keep strict schemas. Host admission uses the same Protocol ingester
in load mode: invalid individual contributions and unknown families are skipped.
An unknown field anywhere inside a contribution skips that whole contribution:
ignoring a newer restriction could widen authority. Known fields are never coerced.
Skipped declarations and their invalid dependants appear through the existing
plugin diagnostics projection while healthy sibling contributions remain usable.

The manifest envelope, plugin identity, source integrity, runtime ABI and declared
`engines.happier` range remain plugin-fatal. Every source kind uses the same host
range check; local or bundled custody does not exempt an incompatible declaration.
Omitting the optional range does not create a host-version requirement. Authors
must narrow the range when new behavior cannot safely be ignored by an older host.
Unknown or invalid plugin-wide fields refuse the entire plugin. Activation rights
come exclusively from the admitted set: registering a skipped or undeclared
contribution fails activation under the existing registration contract.

In unreleased 0.3 source, a keyed `PluginLocalizedStringV2` may include optional
`params` with string or number values for `{name}` placeholders in its fallback.
Protocol's `resolvePluginLocalizedStringV2Text`, also projected through the SDK
`/manifest` facade, substitutes plain text after the host selects its locale.
Immutable displays omit locale selection and resolve the authored fallback.
Missing or malformed values use the author's fallback without throwing.
Catalog copy must retain the supplied placeholders. Literal strings
remain literal. Older strict hosts reject `params`, so external authors must
use `engines.happier` to require a host release that supports it; this source
change does not establish a released version floor. Bundled plugins and the
host update together.

In 0.3 development source, an Action is also the declaration owner for its
named tool and friendly CLI command. `actions.<id>.tool` carries tool name,
optional localized presentation, examples and prompt guidance;
`actions.<id>.cli` carries path, aliases, visibility and tmux policy. The Action's
`surfaces` selects `agent`, `mcp` and `cli` exposure. Both projections consume
the Action's input/result schemas, input hints, danger level, availability and
approval policy. There are no separate `tools` or `commands` contribution
families or executable registrations. See the
[Action author guide](../apps/docs/content/docs/plugins/api/actions-tools-commands.mdx).

In current 0.3 development source, Protocol's Action input-hint owner derives
uncovered top-level operands from the declared input schema for both built-in
and contributed Actions. Authored fields retain their order, localized text,
widgets and semantic rules; authored nested fields suppress a competing parent
editor while uncovered siblings are derived. Primitive types and string choices get matching controls. Structured,
union and opaque operands use the existing `json` widget, and root-object unions
mark a field required only when every arm requires it. The unchanged input
schema remains the validation authority. Literal dotted property names and
non-object roots cannot be represented by the existing field-path grammar.
Confidential paths, contextual choices and consequence descriptions still need
authored hints; derivation never infers secret handling or execution authority.

A contributed Action that opens its own editor can declare exactly
`inputHints: { fields: [] }` to omit the host input form. Hints containing only
form title, description or submit-label copy still derive fields. The input
schema continues validating operands supplied by programmatic callers.

Stored/installed declaration readers, including Account Availability release
and Machine declarations, use canonical load admission rather than the strict
author schema. Empty retired tool/command defaults are silently removed; other
retired declarations are withdrawn with ingestion diagnostics. See
[manifest load compatibility](compatibility.md#manifest-load-compatibility-03-development-source)
for the compatibility arm's removal condition. New publication and reporting
remain strict. Invalid Availability response shapes settle as non-retryable
failures; an actual Availability change can trigger a fresh read. Initial HTTP
or transport failures also settle pending acquisition through scoped readiness,
while retaining the existing retry lifecycle. Reads still pending under HTTP
recovery, Account retirement and request supersession are not outages. Neither
failure withdraws last-good Account facts.

Actions participate in generic Agent/MCP discovery by default under the
canonical per-Action exposure policy. Optional named-tool and CLI metadata
customizes those entry points; its absence does not hide the Action from
generic discovery. `getDefaultActionToolExposureMode` and
`resolveActionToolExposureModeForSurface` own `discoverable_only` versus
`direct`; the Action's top-level `toolExposure` supplies per-surface overrides,
and Account per-Action settings remain authoritative. Schemas and policy never
move into nested `tool` metadata.

In the unpublished 0.3 Agent runtime context, `session.executionRunId` identifies
the existing host Run using a provider-native Session. Both finite and retained
Session-owned Run adapters supply it; interactive Sessions omit it. The field
preserves Session identity and grants no additional host service authority.
The closed context/session contract requires matching development host and
plugin source under the [SDK direct-cut ruling](compatibility.md#sdk-protocol-evolution);
this is not an older-plugin compatibility promise or a persisted format.

## Store kind contributions (0.3 development source)

The host-defined `browserExtension` Registry kind describes ordinary MV3 Chrome
extensions. A Happier catalog's optional `browserExtensions` entries select a
Chrome Web Store extension ID. The existing Registry host reads these entries;
Chrome Web Store package acquisition verifies the CRX3 developer identity and
production Store publisher signature before the archive owner extracts it with
links forbidden. Loading an unpacked folder copies it from the execution Machine.

Installation and enablement belong to a persistent managed-browser profile.
The profile owner retains its metadata, extension records and acquired packages
under the existing profile retention/purge root. Session and ephemeral profiles
return `persistent_profile_required`. Extension mutations use the existing
Action admission and require Machine Manage; listing and opening declared popup
or options pages require Use. Those pages are browser-owned views because a
screencast does not include Chrome's toolbar. Native desktop webviews expose a
managed-browser handoff instead of extension support.

The existing Registry update tracker and Store presentation own extension update
discovery and its cadence. Applying a version with added manifest permissions
first returns `needs_review`. Mutating a running profile then requires explicit
restart confirmation: the engine stops and its views close; reopening the managed
browser loads the new enabled package set. There is no separate extension checker
or automatic update application. These are unreleased 0.3 contracts; a selected
new item kind requires a matching current host.

`storeKinds` binds an item kind to a same-plugin app-page view and declared
`list`, `read`, `installed`, `prepare`, `acquire` and `manage` Actions. Local
record keys become plugin-qualified kind identities. The existing contribution
catalog admits these references; the ordinary Action owner retains validation,
approval, execution and cancellation. This adds neither a Registry parser
service nor a server plugin realm. The built-in Registry formats and kinds keep
their existing contracts.

Store navigation retains a `storeKind` reference containing the qualified kind,
source id, item id and optional version. A missing contribution keeps that
selection available for the normal Manage plugin recovery. The selected view
receives `launchInput.store`: browse, search, listing or installed mode, query or
selection when present, current directory filters, and qualified operation references. Its Action schemas
own plugin-specific parsing and preparation data; the common item descriptor
contains identity, presentation, installed status and an opaque JSON value.

Kind descriptors are metadata. Browsing Store destinations does not acquire or
evaluate their renderers. A selected kind uses the existing surface host and
loader; its view performs reads only while presented and mutations only from
explicit intent. App uses the Store kind dispatch owner with its lazy native
adapter, retaining the Registry read, deployment preparation, acquisition
Actions and Environment inventory owners. See the
[authoring example](../apps/docs/content/docs/plugins/manifest/contributions.mdx#store-item-kinds-03-development-source).
This is an unreleased source contract; the generated SDK availability report
owns availability for a particular artifact.

## Machine setup declarations (unreleased development contract)

The development `machineRecipes` and `machineSetupPresets` families use the
existing Protocol contribution catalog, manifest admission, public SDK authoring
and normalized projections. Both are data-only, with `activationDemand: 'none'`;
neither introduces a runtime registration or privileged plugin callback.
Recipes bind exact plugin/local-id/revision references and strict inputs to
typed setup effects. Bundled Presets carry the same `MachineSetupV1` setup part
as the existing Account/Team Preset record, without another record or CRUD owner.

The bundled Docker recipe declaration and deployment-host setup selection share
Protocol's `DOCKER_ENGINE_RECIPE_REF_V1`, also exposed from the SDK root. Its
plugin id, recipe id and revision are declared once and consumed by both paths.

The bundled backup receiver accepts a reviewed `endpoint: { host, port }` for
sender reachability, separately from its sender connection Match context. Its
native SSH file probe opts into public host-key evidence from the same effective
`sshd -T` policy check. Only the selected host key's `.pub` sibling is read.
Setup Plan and settled Apply expose optional `backupReceivers` results bound to
the receiving Machine, daemon installation and source item. Ready evidence
contains the endpoint, login, chroot-relative SFTP path, known-host line and
fingerprint; it does not establish repository readiness. The successful parent
Setup Run retains its native child's settled evidence. Apply never substitutes
an earlier Plan witness when the native child returns no evidence.

Setup scripts are an ordered `scripts` list of exact `body` values with optional
`affects` and `check` on each entry. The stored reader translates a retained
single-script record to a list of one; new writes emit only the list, without a
database rewrite. Machine setup capture uses the same source merge owner, keeps
all scripts verbatim in attachment order, and saves through existing Preset
creation rather than introducing another capture Action or resolving old refs.

Recipes may declare a literal `script` step in `steps` and `removeSteps`, with
`shell: 'sh' | 'bash'`, exact `body`, optional `check: { body,
unsatisfiedExitCodes }` and optional `affects`. These bytes are disclosed by the
same Plan, covered by its digest, and executed on stdin through the existing
elevated native interpreter and ordinary approval. They are not input bindings
or plugin callbacks. A script check does not establish installation ownership;
the existing native footprint and first-presence owner decide eligibility for
declared removal. Windows reports POSIX script steps unsupported. The matching
Protocol, daemon, managed CLI, review client and bundled recipes must load
together; older strict readers reject this new union arm.

The host owns checking, effect review, admission, elevation, execution and
observation. Bootstrap enrollment remains a host-owned flow behind the existing
system-task runners; a generic serialized bootstrap recipe language is retired.
See [Machine setup and bootstrap ownership](cli-architecture.md#machine-setup-and-bootstrap-ownership)
for that boundary. The [published contribution guide](../apps/docs/content/docs/plugins/manifest/contributions.mdx)
owns matching author examples. This development contract establishes neither
released availability nor native package/service support. The maintained
[capability matrix](../packages/plugin-sdk/capability-matrix.json) remains the
author-facing family and realm availability authority. Its `preview` rows
retain implemented APIs without a current production consumer and are usable
by external plugins; the label adds no registration restriction. `deferred`
means the lifecycle is incomplete in its applicable realm. The matrix describes
0.3 development source, not released availability or loaded-runtime proof.

Software options use recipes explicitly marked `software: true`; old declarations
without that optional marker remain valid recipes. Selection carries the same
exact plugin/id/revision reference and closed inputs, not another software DTO.
The existing `action.options.resolve` source `machines.setup.software.available`
accepts an empty draft for inert browsing without a Machine. Its ordinary option
values retain recipe references or native toolchain identities; labels, icons
and short descriptions come from those owners. The UI demand-loads the enabled
Account recipe declarations through the existing availability reader; the CLI
uses its admitted bundled declarations and a receiving daemon its own registry.
These descriptors establish neither installation nor target support. A draft
with both `homeId` and `machineId` retains target-qualified choices; partial
targets and Plan/Apply recipe fields still require their target operands.
Inert reads omit executable recipe details. Consumers hold one existing options
subscription per open, with no idle refetch, and request target facts only when
selecting a Machine. This changes no Action, wire shape or persisted format.
Package declarations retain manager-specific identity and optional version pins;
compact observations retain the exact observed manager, package and version.
These fields do not establish native support for a package manager or pin.
Optional recipe `inputHints` reuse the shared localized input grammar and resolve
only declared input-schema paths. Static choices remain supported. The sole
admitted semantic `inputType` is `{ hostType: 'savedSecretReference' }`, which
uses the existing SavedSecret picker scoped to the target Home. Other host/plugin
input types, dynamic option sources and Connected Account inventories remain
excluded.
Declarations without hints retain their existing input contract.

The same `action.options.resolve` source accepts picked recipe refs in `values`.
It returns `machineRecipeDetails` using canonical projected recipe entries for
only those exact software revisions; unavailable revisions are not replaced by
the latest declaration. Ordinary options browsing omits this detail payload.
The existing input-field demand store carries the selected declarations, so
clients do not create another recipe loader or catalog. These are declared
inputs and optional `removeSteps`, not native support or presence observations;
without removal steps there is no inferred inverse operation. The same read
may carry the selected Machine's published platform/architecture to the
canonical toolchain-choice owner, without probing the Machine or substituting
the caller's operating system.

Newly selected items in `machines.setup.plan` bind reviewed inputs through
`machineRecipeV1` before native observation. Supported declaration fields accept
`{kind:'input',path:'receiver.username'}` using the shared Action input-path
owner. Only own reviewed JSON fields resolve; a referenced value must exist even
when its destination field is optional. File templates render once through the
existing ValueRef renderer. Bound text is data, never another reference or
template. Template variables accept reviewed strings and finite numbers; numbers
render as text. Secret-backed files retain `secretGrant` references, and their
`grantRef` can bind a reviewed input without exposing secret bytes.

Authored `secretGrant` content can instead declare `credentialSelection` using
the shared `AccessProviderSelectionV1` provider/config/credentialRefs contract,
exclusive with `grantRef`. Only saved-secret `ref` and `resourceRevision` leaves
accept input references; their reviewed value uses the shared
`{ ref, resourceRevision }` selection. `prepareMachineRecipeProgramV1` validates
the bound selection and reuses the exact Machine/installation connector subject.
Plan acquires no credential bytes. Approved Setup Apply currently consumes the
`network.join` saved-secret purpose through requester-aware
`withReachabilityJoinCredential`, existing SavedSecret custody and encrypted Home
grant set/read/remove. The `invocation.credentialFile` target fact supplies the
host-generated installation path rather than a caller-selected path or key.

Authored fields and template variables can also bind target facts. The
`daemon.primaryGroup` and `daemon.username` facts retain P10's existing
daemon-identity observation, once per Plan request. OS security-update facts
(`os.packageManager`, `os.automaticUpdatesPackage`, `os.automaticUpdatesTimer`
and `os.securityOrigins`) come on demand from `nativeSecurityTargetFacts`;
they do not change daemon identity or become caller-selected inputs. Missing
requested evidence blocks Plan with `machine_recipe_target_fact_unavailable`,
never guessed values. Resolved facts and rendered content enter the existing
effect-plan digest, and Apply replans through the same owner. Credential bytes
remain outside target facts and template plaintext.

`serviceUnit` declarations accept `.service` and `.timer` units. Omitting
`enabled` preserves native enablement while `running` still declares the desired
active state, allowing static units such as journald to retain their native
registration. File `iniKeys` content delegates section/key updates to the native
file owner. Typed file probes include fail2ban jail settings and audit rules;
their declaration alone does not establish backend support.

Structured `sshd` contexts may declare expected effective values. The native SSH
file owner validates the candidate in the main configuration's full Include
graph with `sshd -t` and context-specific `sshd -T` before activation or removal.
Contexts without expectations preserve their existing effective configuration;
effective probes check declared expectations after application. File `onChange`
references the recipe's declared service step for reload or restart.

Secret-backed files may declare `lifetime: 'invocation'`. The native file owner
requires root ownership and mode `0600`, refuses an unrelated pre-existing file,
and unlinks invocation-owned files as the finite native invocation unwinds after
success, failure or cancellation, including an unconfirmed child stop. Unlinking
preserves already-open file descriptors and the original invocation error remains
reported. The process owner separately retains custody of an unconfirmed child
until exit is established.

Optional recipe `checks` are observe-only package or checked-command
declarations. A step's `when` list is an ordered conjunction of shared
`{input: InputPredicate}` guards and declared check-id/status sets. Unreached
branches neither bind nor probe. Satisfied readiness can therefore select zero
effects without reading unrelated package facts. The exact selection, reviewed
inputs, demanded checks and captured check facts enter the existing effect-plan
digest. Privileged CHECK/APPLY reobserves checks before mutation and never
applies them as effects. `packageUnavailable` matches only the native package
owner's explicit package-availability refusal; missing managers, permissions,
pins and unavailable metadata do not authorize installer fallback.

`packageManagerUnavailable` separately matches that owner's exact missing-manager
fact. A check guard's optional `ifInput: InputPredicate` skips the guard before
binding or observation when false, allowing an omitted earlier manager choice.
Demanded checks and the subset used by selected effects remain in the digest.
The planner and interpreter share `findMachineSetupBlockingObservationV1`:
unsupported unselected alternatives do not block a valid selected program;
unavailable checks and an unresolved empty selection still refuse.

Current-copy-only reads retain zero catalog/native work. Source-list Plan
expands supplied manager alternatives through this same owner. Full source-list
Apply still requires its consuming integration; declaration expansion does not
establish unsupported backends.

The `journalReadGroup` prerequisite verifies the reviewed group's numeric GID
against actual system-journal files and their effective ACL/traversal route.
Group existence alone is not journal-read evidence. The bundled `journal-reader`
binds `journalGroup` to an existing-only group step with literal `happier`
membership, disclosing all-system-log access without adding the agent. Its
declared removal revokes exact supplementary membership, never the group or
journal data. New-process effective access and supervised restart remain the
dedicated daemon lifecycle's integration proof, not a declaration-time claim.

The development daemon describe selection `machineRecipes` reads only that
family from the current admitted runtime lease. It reuses the canonical family
projector and occurrence retirement, without an installed-package scan, other
cold families, native/UI feature checks, Environment reads or execution-origin
resolution. A present `familiesById.machineRecipes` with empty `entriesById`
means the family is available but has no current entries; an absent family means
unavailable. Consumers must not turn an absent family or a refused describe into
an available-empty software catalog. Full discovery remains a separate request.

Software options reuse the catalog's optional source/brand presentation and the
recipe's optional icon token. Their `version` is the declaring plugin version,
not a native installed version or the recipe revision. The cold family reads
only its declaring metadata and already-admitted resource descriptor; logo bytes
and other catalog families are not listing demand. These facts confer no source
custody, trust or execution authority. Package input references may bind a whole
array or one identity entry, with the same concrete validation after binding;
ordinary forms write declared object paths rather than inventing package arrays.

## Deployment execution custody (0.3 development source)

`DeploymentExecEnvPortV1` is a public opaque invocation facade. Its materializer,
grant admission and process environment remain host-private. The existing
own-server executor composes it with source custody; canonical SDK Exec consumes
source-backed and single-binding operational attachments once and rechecks current
source, binding and invocation before spawn. Trusted plugin code chooses the Exec service and launch directory and may
add process environment values; admitted binding values retain precedence.
AM-9 still separates application values from sanctioned Docker/Compose controls,
selects receiving services and sanitizes secret-bearing output.

Source-backed build/runtime requests carry the exact source handle and phase.
Stored Compose uses the same source policy before Environment create/update and
materialization. Its document digest covers uninterpolated bytes; repository-only
sidecars refuse before native reads. The native Compose normalization owner checks
the observed tool version before rendering inline configs (Compose 2.23.1+), while
ordinary stored documents keep their existing tool support.
Source-less operational requests carry only `bindingIdentity`, produced by
deployment-protocol's `environmentSecretBindingIdentityV1` from the admitted
binding. The host compares this opaque identity, without parsing another binding
grammar, and derives purpose, slot, installation and material from its current
admission. Operational adapters deliver only their admitted slots through
protected files, stdin or process env; plugins receive no map. These request
shapes and the grouped backup-destination request are closed and mutually exclusive.
A backup/restore job prepares `{ backupDestination: { configKey: 'destination' } }`
once with its job signal, passes that same opaque attachment to its sequential
commands, and disposes it in the job's `finally`. Each command borrows the existing
material and redaction values; it does not materialize credentials again. Job
disposal or cancellation refuses further use immediately. An active command keeps
the protected files until its existing finite settlement releases the last loan;
an idle job cleans up immediately. A stale, cancelled, cross-invocation or
foreign-source attachment fails before spawn. Source-backed and single-binding
operational settlement still clears their material/redaction lease, and Compose
generation custody retains its existing detached lifetime. Production backup job
construction/finalization must consume this owner contract; the facade alone is
not proof of that integration.

This is an unpublished V1 author contract, separate from package SemVer.
An admitted daemon `uploadDeploy` role, or a runtime effect role with captured
execution placement and workload admission, can acquire its exact receipt's source with
`context.services.deploymentSource.materialize({ environmentId, deploymentId },
{ signal: context.signal })`. The host consumes the existing role admission's
captured Environment, receipt and selected execution placement, then uses the exact-commit
source producer; plugins supply neither a source path nor admission credentials.
Further acquisition ends with that invocation. Uncommitted custody is cleaned
up by the existing invocation cleanup owner; native committed-release retention
is unchanged. Upload handlers leave custody uncommitted so cleanup removes the
temporary source. Trusted plugins are not sandboxed by checking their saved
handles: retaining a root path does not create a separate access-control boundary.
The runtime effect role can prepare that same source through
`context.services.deploymentExecEnv.prepare({ source, phase: 'runtime' },
{ signal: context.signal })` and pass the opaque attachment as `deploymentEnv`
to SDK Exec. Admission selects the Machine, installation and phase; the plugin
receives no binding-value map. These custody services remain unavailable for
observe, cancel and portable Account invocations. Existing build jobs retain their receipt-provided
execution port. Runtime service references reuse the existing forward custody;
invocation cleanup awaits its release, while synchronous disposal uses its
caught retirement path. Provider upload behavior is established by each adapter,
separately from this host capability. See the [author example](../apps/docs/content/docs/plugins/services/exec.mdx#deployment-environment-custody-03-development-source).

For checkout-backed acquisition, the shared deployment source reader consumes
the physical host's existing `isHostRequesterUnrestrictedOwner` decision. Verified
host automation retains its admitted requester identity through reviewed children
and durable approval replay. Genuine Agent/Session execution retains its own
requester identity. A requester that fails that decision refuses with
`agent_isolation_unavailable` before workspace or Git effects. The typed
`deployment_source_admission` diagnostic records the reason, required fact and
remedy in the Action result and the receipt's `sourceAdmission` failure detail;
approval settlement retains that same closed detail. This source-authority check
does not read native isolation readiness.
Stored definitions and workspace-free provider Git integration are unaffected.

## Portable Connected Account materialization (0.3 development source)

`packages/cli-common/src/connectedAccounts/` owns the shared purpose admission,
metadata inventory, established credential/configuration snapshots and provider
callback dispatch. The daemon's former modules are adapters to that owner, not
parallel implementations. Account hosts use the same owner without importing
daemon services or Node crypto.

`createConnectedAccountPurposePort(...).bind(...)` consumes the declared purpose,
authorized `serviceRefs` and launch-bound `purposeBindings`; an Action's exact
selected Account is supplied as `expectedAccount`. It does not select a durable
default or expose a raw credential endpoint. Its choice facade reads metadata
only. The materializer is `createConnectedAccountPurposeMaterializer(owner)`,
where `owner` is `createConnectedAccountEstablishedRuntimeOwner(...)` over the
host's admitted Account operation, registry, transport, configuration and cipher
ports. The host runtime adapter uses
`createConnectedAccountEstablishedRuntimeDispatcher(...)` for the same target,
currentness and callback policy before invoking the provider's
`runtime.materialize`. A decrypting credential reader is not a materializer.

Account and daemon Action hosts consume `connectedAccountPurposeBindings` through
the shared declared-operand reader. An explicit Account operand binds that
Action's purpose for the invocation; it does not require a separate saved default.
An omitted optional operand inherits its purpose default, while an explicit
native-service operand clears Account selection and retains Machine admission.
The purpose port still resolves the selected ref against the invoking Account's
inventory and declared service scope before credential acquisition. A captured
host-admitted operation binding takes precedence over authored operands.

Saved Secret references remain in the credential envelope and are resolved by
the incumbent resource opener on acquisition. Account-mode custody, provider
formatting, refresh mutation preparation and recipient policy keep their
existing owners; portability adds no store, selector or consent mechanism.

Declared cloud manual credential fields use explicit `credentialFieldKeys` rather
than guessing credential keys from matching values. Entered fields are promoted
into Saved Secret resources in the credential transaction; selected fields keep
their existing `{ref, resourceRevision}` and are checked by the resource owner at
commit. Reconnect updates an owned held resource in place before the ordinary
credential compare-and-set, retaining its identity and grants. A conflict is
visible and deliberately retried; an uncertain resource update is not blindly
replayed. Account/app authentication construction consumes the same settlement
ports, including selected-secret acquisition and resource-ID production.

Authentication settlement retains its admitted configuration and credential
basis; the server credential compare-and-set decides write currentness. Lost
acknowledgements stay retryable: the shared settlement owner opens the committed
payload and completes reconnect health before considering another write. This
also avoids comparing freshly sealed ciphertext with an earlier create. Remove
settles the admitted remote outcome using the captured credential revision even
if its runtime retires meanwhile. Cancellation, Account-mode validation and
Saved Secret promotion keep their existing owners. Credential refusals retain
the server's closed error and revision reason in the existing UI Details code.

For finite native HTTP invocations, the purpose host captures the first admitted
materialization per invocation seed and exact purpose/origin/header tuple. Later
fragments spend that capture; unlinking refuses the next invocation rather than
interrupting admitted work. The existing refresh owner requires a current
revisioned snapshot, refresh lease and credential write-back, so it cannot refresh
an unlinked capture without changing the admitted revision. The accepted fallback
keeps that material and turns a later HTTP 401 into “Sign in again, then retry.”
It adds no refresh timer, alternate credential selection or provider-specific mode.

The established runtime owner privately classifies admitted nonsecret
configuration strings for the invocation redactor and materialization receipt.
Credential endpoint attestations stay public only when they equal an origin or
base projected from the descriptor's configured endpoint fields. Host, plugin,
portable Account and staged credential reads consume that same classification.
Public scope identifiers are
not registered as secrets merely because a provider returns them in environment
material. Credential and configuration-secret collisions remain redacted; unknown
material stays conservatively secret. This classification is host-only, not an SDK
result field or an instruction to undo an existing redaction.

## Shared secret save and registered reads (0.3 development source)

Connected Account service-configuration saves return the record committed by
the catalog writer. When saving also promotes new Saved Secrets, the promotion
owner returns the final shared references and acknowledged catalog revision.
The daemon publishes those facts locally without rereading storage after its
own write. A retired local Account or failed local publication cannot turn an
acknowledged commit into a failed save; a missing write acknowledgement retains
the existing outcome-unknown result and never authorizes replay.

`secrets.usedBy({ ref })` is an Account-placed metadata read for managed Saved
Secret references, using the existing `secrets.list` read policy. Both hosts
reuse their existing selected-secret Used-by callback and the Protocol
`listAccountSettingsSavedSecretReferences` census over the caller's Settings
and reference catalogs. The shared projection also includes a value-free
Environment marker from the Saved Secret catalog's binding census; it reveals
neither private Environment identities nor binding names. Incomplete retained
capture metadata leaves coverage unknown unless a known capture proves usage.
It computes the census at most once and returns only
`{ references }`: owner/path/referrer metadata, an empty array for unused, or
`null` when coverage is unavailable. No operand selects another Account, and
recipient visibility never exposes the resource owner's reference inventory.
Matching Protocol, SDK and Account execution hosts must reload to discover this
unreleased 0.3 Action; it adds no Home endpoint or persisted format.

`SecretsService.saveShared(id, { label, bytes, audience }, options?)` uses the
invocation's captured Account custody; declarations and save opt-ins are not
permission gates for trusted plugins. A same-id daemon binding stays separate.
The host retains the parent Action's exact reviewed
id, purpose, audience and currentness witness; caller-proposed recipients cannot
grant that authority. Creation stays with the Saved Secret resource owner and
returns only a shared reference and resource revision. Saving does not write
Environment bindings. Plain mode remains keyless; unmet E2EE custody refuses
with `secret_save_client_required` before creation.

Linking or selecting one's own Saved Secret for a plugin or Setting is the
approval for that plugin's `credentials.materialize.raw` use. The materializer
reads the link and lists no permission grant, so built-in and external plugins
behave identically and a personal secret works offline after admission.
Inspection reports this as `grantRequirement: 'linked'`. Unlinking applies at the
next acquisition. A Saved Secret owned by another person, a resource row that
does not name the reader as owner, and a Connected Account keep
`approval_required` and the grant list.

Host-mediated Voice acquisition consumes that same custodian grant record for
the selected Saved Secret and declared recipient header tuple. The existing
grant inspection/request flow accepts mediated-only declarations for this
review; it does not enable raw materialization. The linker's recipient-contract
receipt is never another person's consent, and mediated execution keeps the
source secret inside the host.

`SecretsService.readSavedSecret(ref, { resourceRevision?, signal? })` acquires a
Saved Secret through that same captured Account router and canonical materializer.
It enforces current audience, revision and Account mode before returning the raw
value to trusted plugin code, and registers its representations with the existing
invocation redactor. The plugin owns serialization into an ordinary HTTP byte
body. There is no JSON-pointer injection grammar or response-echo veto.

The HTTP redirect owner strips headers carrying registered secret representations
on cross-origin hops and refuses cross-origin 307/308 resends when the actual body
contains one. Same-origin hops retain those headers; ordinary-body cross-origin
redirects can still follow with credentials removed. Successful Action results and finite
registered MCP results (tools, catalogs, resources and prompts) reaching agents
use one result sanitizer and the same invocation redactor, including JSON-escaped
echoes, before that scope completes. Secret acquisition is a natural authority boundary,
not a new Account/resource recheck on every HTTP send.

Scoped Account
execution forwards the existing `SavedSecretOperationContextV1`; absent scoped
custody cannot borrow the daemon's active Account. Controller Account-service
projection, reviewed-save admission production and role-tagged offline relay
remain separate co-landing requirements; these source extensions do not establish
their loaded availability. See the [author examples](../apps/docs/content/docs/plugins/services/secrets.mdx).

## Other contribution and host contracts

### Machine ingress facts (0.3 development source)

The Protocol root (`@happier-dev/protocol`) exports the closed P21
`AccessProviderRefV1`, `AccessProviderSelectionV1`, `MachineIngressCapabilityV1`,
`MachinePrivateNetworkObservationV1`, and their schemas. Their canonical
sources are `plugins/contributions/accessProviders.ts` and
`machines/reachability/machineReachabilityPostureV1.ts`. The development
`machines.reachability.inspect` and `machines.reachability.configure` Actions
consume installed plugin and built-in descriptors through the ordinary Machine
executor. Join and leave are Configure intents, not separate host Actions.
Built-in codecs resolve through the existing `cli-common/relayAccess` catalog;
plugin roles retain their genuine contribution identity and reviewed child
execution. Neither path supplies a new Action issuer.

Home relay configuration now consumes the same portable selection:
`{provider, config, credentialRefs}`. `RelayAccessConfigV1` aliases that
Protocol schema; a task snapshot keeps the safe selection separately from its
observed/display `providerId`. The descriptor's `homeRelay` target selects the
Home subset; native Machine Tailscale membership and Caddy are not Home methods.
Configuration is validated against the selected descriptor, and credentials are
purpose-bound Saved Secret or Connected Account references, not raw values.
Cloudflare's Home selection carries the hostname and a `tunnel.manage`
Connected Account reference. A desired hostname/reference is not connector,
DNS, route or health evidence; the leaf reports unknown pending its admitted
controller's verification.

Task observations redact sensitive configuration fields and URL values without
changing private execution input. The canonical relay URL projection removes
userinfo, query and fragment while retaining the port and path. These are
unreleased 0.3 source contracts, not evidence of released availability or
completed security and loaded-runtime validation.

Authors use `@happier-dev/plugin-sdk/access-providers` for the descriptor types
and `defineAccessProviderSchemas`. A descriptor's optional `membership.join`
and `membership.leave` declare finite Machine recipes. Configure executes those
programs through the reviewed root P20 interpreter, not a daemon-user join
Action. A join credential is materialized by the canonical connector-grant
owner into a root-owned 0600 file beneath protected root-owned ancestors;
the recipe receives its path, never the secret in Action input or review data.
Provider observation Actions use the executor's exact active-parent reviewed
child port. They do not issue their own admission or borrow the daemon's
Account policy. The built-in Tailscale descriptor now supplies finite join and
leave programs through that same reviewed interpreter; no-key adoption of an
already-ready profile must not change native state. A selected new key on a
ready profile reviews Switch (down, then up with forced authentication), even when the observed
profile id stays the same. Native profile identity is part of the parent's
reviewed basis; changed observations require a new review before effects.
Caddy inspection consumes the existing native listener observation, not a
configured hostname or a new endpoint-health probe. A built-in reference alone
does not establish ingress readiness.

An access ref is either `{kind:'builtin', id}` (resolved by the host's existing
catalog) or the existing `PluginContributionIdentityV1`; a flat string is not
identity. Ingress carries revision, exposure, inbound port/protocol/scope,
optional HTTPS hostname/port/path constraints, and
`ready|needsSetup|needsAuth|conflict|unavailable|unknown`. Stable remedies are
`inspect|configure|authenticate|resolveConflict|chooseProvider`: ready has
none, other states require an explicit remedy. Codes remain producer-owned.

`MachineReachabilityObservationV1.privateNetworks` is demand-only native
observation, never a Network entity or endpoint-health assertion. Its
`sourceRanges` uses the single exported
`MachinePrivateNetworkSourceRangesV1Schema` (IPv4/IPv6 CIDRs only). P41's
existing route/capability preparation receives those ranges from the
Environment's exact admitted provider/network identity and current observation;
it must bind them into the reviewed input and recheck currentness before
effects. An empty, missing, unobservable or changed scope cannot be widened
to all sources or replaced with another selected network. Parsing an array
does not confer admission or health authorization.

P41 alone combines exact Domain/GET/health-path matching with native
`remote_ip` inside those admitted ranges. Forwarded headers, fallback markers,
the connector container network, admin-socket access and firewall exposure
never confer the exemption. P20 remains the sole private host-exposure owner;
P41 remains the sole route/auth/listener/TLS codec. This contract adds no
range store, polling, second ingress model or authorization classifier.

### Plugin HTTP trust and redirects (0.3 development source)

Native plugins are trusted, in-process code with ambient socket access.
`privateNetwork` in a network declaration is an installation disclosure, not a
network restriction. Plugin HTTP and WebSocket services use the platform's DNS
and transport without a separate private-address classifier or address pinning.
Provider endpoint safety and webhook destination checks have independent owners
and retain their own locality rules.

Manifest network origins, methods and `network.client` capabilities do not fence
trusted plugin HTTP or WebSockets. Trusted request interceptors receive the URL
and headers and may rewrite either, including bound credential headers and the
request method. Their declarations select which requests invoke them; they do
not constrain the rewritten destination. The SDK interceptor request remains
bodyless, and transcript/diagnostic redaction stays with its existing owner.
The HTTP service binds host credentials once
per call through their credential owner. Redirects use the shared release-runtime HTTP policy
(also exposed through the Home facade): same-origin hops retain
credentials; cross-origin hops drop Authorization, cookies and host-filled secret
headers. Cross-origin redirects that would replay a filled secret body, including
307/308, return the non-retryable `credential_request_redirect_refused` failure
before sending that hop. Diagnostics retain only the status and fixed message,
never the Location, request headers or body. Explicit manual mode returns the
redirect response, and explicit error mode refuses it. Credential-free requests
retain fetch method/body semantics and the host's redirect bound. Fetch transports
delegate following to browser and Node Fetch for bodyless requests whose only credential
header is Authorization (or has none).
Browser and Node Fetch retain Authorization on same-origin hops and remove it
across origins; the platform owns that chain's redirect bound. UI native hosts
(Expo iOS/Android and Tauri) return manual responses to the shared HTTP redirect
loop, which retains same-origin credentials and strips them across origins without
depending on the native platform's automatic redirect behavior. Other credential
headers and request bodies keep the inspected-hop path above. A browser
cannot expose a manual redirect's Location, so that path returns the existing
`plugin_fetch_redirect_refused` failure instead of forwarding credentials.
The Bitbucket raw-diff client requests following through this owner and consumes
the final 200/555 response; it does not implement a second redirect policy.
Finite calls admit current authority once and finish after withdrawal; the next request
re-admits. Explicit cancellation still aborts the call. Open streams and
WebSockets close when their bound access is withdrawn.

Plugin HTTP requests use the containing invocation's cancellation and any explicit
request timeout through response-body completion. The shared host adapter disables
Node's header/body deadlines and Bun's default fetch timeout, so a native image pull
or other long-running call can wait beyond five minutes without a competing
transport cutoff. This is development behavior and requires an updated controller
CLI, including the darwin payload when that Machine hosts the provider.

The CLI `HttpService.requestStream` extension accepts bodyless GET/HEAD reads
through this same owner. `executeFetch` shares interception, redirect admission,
retry eligibility and explicit deadlines with buffered requests; the native
adapter uses the same platform fetch/dispatcher. Stream reading remains
consumer-driven, without the buffered-body ceiling or a whole-body accumulator.
EOF, iteration return, caller cancellation, network retirement and explicit
disposal release the body and its listeners. The Account-purpose HTTP credential
bridge is not yet implemented: its public request/materialization contract must
identify the exact purpose and header names, rather than infer credentials from
an Action declaration. Its stream integration must retain credential custody,
withdrawal and redaction through disposal. No body-secret substitution or Voice binding is exposed
on this read-only method. Containing log operations own window/lifetime and
normalized row publication; an iterable never crosses Action JSON, and a reopened
vendor stream establishes no historical cursor or gap-free replay guarantee.

Trusted in-process filesystem callers may supply their own read/page budgets;
the service does not impose an additional byte or page-size ceiling. MCP
adapters likewise preserve valid results under their owning protocol contracts,
without local count/JSON-size clamps or cursor eviction. Wire, storage,
diagnostic projection and presentation boundaries remain with their owners.
Logger values are redacted without arbitrary size, depth or secret-count
truncation; cycle detection and failure isolation remain. Resource producers
are admitted independently without an aggregate in-process byte/concurrency
cap, while manifest read and brand-image presentation budgets remain.
In-process event listeners retain ordered delivery without a generic queue
ceiling. The UI Resource watch transport alone supplies its existing delivery
budget to the same event broker.
Connected Account metadata follows explicit caller limits and otherwise returns
the full authorized inventory; storage elision remains observable as
`truncated`. UI Action-form inventory and display-label budgets stay at their
presentation producer.

Custom ACP composition in 0.3 development can provide
`AgentAcpRuntimeDefinition.sessionUpdates`: a plugin-owned native metadata codec
and optional stop-reason translation. The host consumes explicit tool provenance
through its single ACP accumulator and publishes diagnostics through the bound
Session transcript event owner. This adds no runtime event discriminator,
lifecycle state, retry owner or polling. Unknown prompt reasons retain an
unclassified end and their raw value. ACP remains wire v1; this unpublished
executable SDK contract requires matching host/plugin source under the direct-cut
ruling, independently of npm SemVer. The codec output and its nested MCP identity
are closed known-field projections; diagnostic admission retains its existing
strict schema and informational transcript messages keep their existing reader
contract. See the [author example](../apps/docs/content/docs/plugins/agent-runtimes/acp.mdx#native-update-metadata).

The existing `AgentAcpToolNameResolver` also accepts a `{ toolName, input }`
projection when a native wrapper needs both fields decoded. The same plugin
codec supplies updates and permissions, including the awaitable runtime bridge;
ordinary string-returning resolvers remain supported. Shared normalization
receives the admitted runtime's qualified `ToolNormalizationSourceV3`, as
described in [tool normalization](tool-normalization.md).

The 0.3 development `backupDestinations` family is a cold descriptor with a
recursively closed nonsecret configuration schema, canonical credential roles,
restic transport/locality facts and `test` / `open` Action references. Open remains
a qualified contributed Action; test can instead name the native repository probe.
Protocol's contribution catalog owns admission and reference extraction;
`definePlugin` uses its existing descriptor adapter. CLI projection and the UI
catalog/fleet union carry the supplying occurrence and execution origin through
their existing retirement and enabled-supplier rules. There is no destination
registration ABI, backup runner, credential store or scheduler in this family.
Local storage remains local recovery; `offHost` requires admitted configuration
proof and does not assert durability. The development destination plugin supplies
S3, SFTP and local descriptors, each with an ordinary read-only open Action.
Descriptor-owned `fieldHints` use the canonical input hints schema. The closed SDK
`BackupDestinationOpenV1` result contains a repository locator, canonical
credential-binding identities and optional transport facts: S3 region/addressing,
SFTP endpoint/user/pinned OpenSSH host-key line, or an executing-Machine directory.
The SDK's `BackupDestinationOpenInputV1` carries `config`, selected
`credentialRoles` and optional `ownershipPrefix`. The shared host opener supplies
the captured ownership prefix unchanged; each provider joins it inside its own
authored repository namespace once. Empty or omitted ownership preserves the
authored location. Bundled destinations require exact relative ownership segments
with forward slashes, without empty/dot segments, absolute paths or control characters;
authored configuration retains its existing transport grammar.
Native path operations are supplied by the SDK's existing `/fs` runtime facade
(`joinNativePath`, `joinPosixPath`, `isWindowsAbsolutePath`); the public destination
declarations do not import Node built-ins or choose another path normalizer.
Scoped local output retains the final host `path`, optional
existing-base `mountPath`, and the joined repository locator inside the fixed
container mount. Native custody mounts the base without creating the final
directory; restic's explicit initialization creates the repository. The bundled
receiver composition selects `SFTP_BACKUP_DESTINATION_REF_V1`, rather than an
arbitrary contributed SFTP configuration schema.
The own-server host invokes
the configured descriptor's Action from its retained registry, then P42 resolves
the exact database binding and lends destination credentials through its existing
attachment. The first-party descriptors bind `test` to the mutating
`deployments.backups.test` Action through `{ kind: 'hostAction', actionId }`.
It reads the selected repository configuration, writes a nonsecret probe, verifies
the exact snapshot's payload checksum and length, then forgets that snapshot through
the existing restic 0.19.1 runner and P42 custody. Probe snapshots omit Environment
backup tags and require no capture history. Test never runs Prune; unreferenced
chunks remain for ordinary Prune. Failures retain the known probe identity and
cleanup outcome; native output and credential values remain private. Successful
Test proves write/read/delete access, not durability or restore integrity.
The read-only `deployments.backups.history` Action returns retained operation
facts for the exact target, including failed attempts, pruned snapshot ids and
the last verification. It does not open the repository and is not a permanent
audit log; the existing operation store owns retention.
SFTP uses operation-private protected SSH identity/configuration/known-host files,
strict host-key checking and no ambient agent or password fallback. Local access
mounts the daemon's canonical directory writable into the same restic runtime;
source data stays read-only. Scheduled backups remain outside this slice. See the
[public contribution guide](../apps/docs/content/docs/plugins/manifest/contributions.mdx#backup-destination-declarations-03-development-source)
and maintained SDK external-author descriptor fixture.

The development `ui.listExtensions` declaration uses the existing UI contribution
catalog, manifest integrity pass and UI projection. It carries P6's canonical
filter-field constituent and an optional neutral field-reference mark; it grants
no runtime registration or Resource demand. Public `definePlugin` maps local ids
to manifest arrays. Existing `activate(api)` registers ordinary declared Actions
and Resources only. See [collection presentation](collection-presentation.md)
for the held-fact evaluator and deferred host-row loading boundary.

The prepublication `@happier-dev/plugin-ui/components` filter adapter and shared
condition model are usable by plugin-owned pages with admitted held facts.
Registry-declared `list`/`daemonRule` support controls editor choices and write
admission; the plugin-field adapter is list-only. Sharing these controls does
not authorize list-only fields in Follow or matching-session routing rules.
These are 0.3 development-source contracts, not a published-package availability
claim; the installed public inventory remains the authoring basis.

Files & Editor's development hunk actions, review-unit table, selection Ask and
Track caret remain host-private. The public `HappierDiffViewer` stays a read-only
presentation; it gains no review actions, editor controls or contribution family.
The host caret consumes the existing cursor-motion seam without extending the
public Agent cursor into a text-caret API.

The unreleased Files & Editor SCM extension adds an optional `blameFile` read
leaf to the existing SCM-backend family. Capability projection owns `readBlame`;
an absent leaf remains unsupported. Results describe working-tree line ranges
and a deduplicated commit table, with null commit references for uncommitted
lines. The host routes the typed operation without selecting a Git-specific
path. Session/turn attribution is a client derivation over the current Session's
evidence, not a backend author claim. An expected raw-byte file hash lets a
backend refuse stale line coordinates before returning attribution. This source
contract still requires the program's generated SDK and loaded-runtime checks.

In 0.3 development source, merged CLI contribution reads reuse the existing
immutable built-in registry for bundled declarations. Installed-plugin discovery
still runs on each merged read; it cannot overwrite that built-in snapshot or
retain an installed generation across reloads.

Managed guests place installed plugin code under their external managed-tools
root selected by `HAPPIER_FIRST_PARTY_INSTALL_HOME`. Generation directories and
code are member-readable; registry state, credentials and configuration remain
in the custodian's private Happier home. Provisioning removes the selected
member's former plugin-ancestor ACL entries through the existing `pathTraversal`
effect with `state: 'absent'`, preserving other ACL entries and the mask.
In 0.3 development source, personal Linux separate-user setup creates a code-only
tools directory under the Machine state root and records its location in the
private `install-layout.json`. The next daemon start selects that location and
re-stages reviewed current and available rollback generations through the existing
generation store. Registry authority, settings, storage and secrets stay private;
the CLI payload location is unchanged. There is no home-ACL fallback. A missing
conversion offers managers the existing Machine Security setup and restart route;
Use requesters receive guidance to ask their manager. macOS and Windows retain
their existing unavailable behavior.
Traversal for an explicitly admitted shared Workspace remains part of that
Workspace's reviewed sharing effects.

The CLI contribution registry admits cross-plugin references before projecting
declarations or activation targets. An optional plugin with an unresolved or
wrong-family reference is excluded with `plugin_manifest_invalid`; the existing
diagnostic details retain the typed reference reason and manifest path. Its
catalog row is `load_error`. Admission also removes the dependent plugin closure,
while unrelated plugins remain available. Missing or invalid bundled Agent
manifests follow the same exclusion rule; executable registration identities
cannot recreate an excluded Agent. Bundled admission is retained for the process,
and installed generations are admitted against that bundled reference graph.
Cleanup and other consumers use the admitted projection without a second fatal
reference decision. Required host package build/import failures remain fatal;
their runtime Agent declarations still follow Agent manifest exclusion. This describes
0.3 development source; loaded-daemon verification is separate.

Local CLI read-only help, Agent listing and static completion instead consume
the installation writer's existing `approvedAuthorityManifest`. The canonical
registry pointer and revision readers validate their supported framing once.
Protocol load admission projects each accepted declaration for the current host,
with contribution diagnostics, without reopening a live plugin source or
reconsidering consent.
A supported installation without that accepted manifest retains its installation
identity and `plugin_manifest_missing` diagnostic, but contributes no read-only
metadata; there is no live-source fallback or new persisted projection. These
readers share command admission and selected-family field projectors with the
executable registry. Invocation, activation and remote dynamic completion retain
their existing full validation, approval and occurrence-currentness boundaries.

The daemon's current catalog also retains the process-immutable bundled
declaration projection. Each read still discovers installed entries, applies
their bundled-id overrides, and joins generations, diagnostics and executable
tools from the current matching runtime lease. This is not a cached serving
catalog: changing installed or runtime state remains visible on the next read.

In 0.3 development source, executable tool consumers request `selection: 'tools'`
from that same authenticated catalog owner. It compares the controller's current
in-memory durable revision with the serving runtime lease, then returns occurrence-bound tools with an empty
`plugins` projection. Display declarations and introspection are not constructed.
The tools path does not reopen the installed administrative snapshot. A durable
adoption observed before publication, including a failed publication, suppresses
tools until a matching lease serves that revision.
Omitting the selection preserves the full administration catalog. An older daemon
that ignores the selection still supplies its full reply; tool consumers use its
tools and retain the existing freshness checks.

This is the standing reference for **0.3 development source / Developer Preview authoring**. Source availability is distinct from registry publication and loaded-platform verification. Exact public exports and capability facts come from the package-owned generated API and capability reports, not a hand-maintained list in this page.

Executable Plugin UI mounts expose their existing physical renderer identity as
`useSurfaceContext().mountId` (also `RenderContext.surface.mountId`). Native/RNW
and hosted renderers retain it through rerenders, resizing and retained
hide/reveal; a replacement renderer has a new identity. Unsupported contexts
omit it rather than deriving one from a view, container, or React id. This is
identity, not execution authority. An author binding mounted Actions releases
its registration on component cleanup and on the existing `RenderContext.signal`
abort, so host retirement also clears a callback in a retained tree. Hosted
frames still have no in-process ephemeral shared-scope bridge. This is an
unpublished current-source addition, not a compatibility promise for stale
independently bundled development SDKs with an earlier strict context grammar.

The development `openAutomationEvent` UI host method opens the existing Account trigger
popover and its Event editor. Plugins supply a qualified Event and source-specific setup
input, optionally a monitoring Machine and qualified Connected Account. Omitted choices
remain unselected: the existing watcher chooser admits an explicit current Machine before
loading its Event catalog, and the Event's Action form owns Connected Account selection. Only an opaque,
Account-scoped temporary seed handle enters the Workflows route. The Event's current
setup Action owns input validation and account selection; contradictory seeded account
references are refused. Opening performs no source setup, enrollment or trigger write.
The person explicitly configures the source, then completes the incumbent trigger form,
including its Runs on and Then selections. The current Event editor serves the active
Account only; an addressed nonactive Account is refused before navigation. Both native
and hosted transports negotiate the method, and an older host reports unsupported.
Generated SDK governance and loaded-runtime verification remain separate checks.

The development `openDeployment({ environmentId, serverId?, receiptId?, tab?, section? })` UI
host method opens a deployment Environment on Happier's Deployments page: its Overview, one
receipt, a tab or a Settings section, the same destinations the page's own tabs use. It is
navigation only and grants nothing. The host reads the Environment with the viewer's own
`deployments.environments.get` to find its Project, then routes; an Environment the viewer
cannot read, another Home than the mount's active one, or a retired mount navigates nowhere
and settles `unavailable` or `stale_surface`. Unknown tab or section ids open Overview or the
Settings landing. Owner: `apps/ui/sources/components/plugins/surfaces/pluginSurfaceOpenDeployment.ts`
over `deploymentEnvironmentRoute`; consumer: the GitHub PR Overview Preview step.

The development `revealSessionInput({sessionId, localId})` UI host method opens one
committed main user input in the Session transcript. The mounted Account supplies
Home authority; the exact-input reader resolves its opaque local ID without an
inventory scan, and the existing scoped message route and transcript jump owner
load, scroll and highlight it. The host refuses unavailable or non-input rows,
another active Home/Account, retired mounts and cancelled requests before navigation.
Successful settlement means navigation was requested, not that a row already
rendered. Both native and hosted clients negotiate the method through the existing
host-method vocabulary; an unsupported host remains unsupported. This is an
unreleased 0.3 author capability, with no new server or persistence format.

The development `readMachineDisplayName({serverId, machineId})` UI host method
reads the mounted active Account's exact `machineDisplayById` entry and reuses
the canonical Machine display-name formatter. Unknown or revoked Machines,
another Home, and a mismatched active Account return typed unavailable.
Native and hosted clients negotiate this read through the existing method
vocabulary. It adds no store, inventory scan, network read, or cross-Home
fallback; only the viewer's already-admitted display projection is visible.
This is an unreleased 0.3 source contract.

The development executable participant picker is a controlled Plugin UI
presentation, not another participant catalog or setup service. Core's modal
and installed same-realm native/RNW surfaces delegate through the existing
presentation-host binding to one SelectionList presenter. Callers retain
admitted display inventory, readiness, selection, confirmation eligibility,
native setup and commit authority. Unsupported presentation hosts show an
explicit unavailable state; they do not construct an alternate choice list.
The external-author reference mounts the public component without host imports.
Optional `searchText` carries canonical Agent/model names to the same query matcher
without changing a row's label or treating search metadata as launch availability.

The unreleased 0.3 shell uses Plugin UI's resize primitive for both host panes and collection
rails. Public `ListDetailLayout` and `Collection` expose controlled rail widths and an optional
`resizeKey`; the presentation host supplies device-local sizing with plugin-namespaced keys.
Installed plugins consume the host-provided runtime and share the same geometry and accessible
handle. Controlled collection widths govern the collection's own split; a host details pane retains
its own width, placement and shared pane handle. Plugins do not import app pane internals or create
their own persistence record. App pages
also inherit their host's main-column visibility; their declared page identity supplies the hide/show
wording. See [Collection presentation](collection-presentation.md) and
[App shell panes](app-shell-panes.md) for the canonical owners.

The capability row anatomy (status words, tone, fix and blocking order; the source · trust · cost facts
line; the detail header's speak decision; the blocking notice; the `Collection` row anatomy) is owned by
Plugin UI `presentation/capabilities/**`. Happier's Skills, MCP and Agents surfaces bind their words and
primitives to it, and plugins reach it through the public `components` adapters (`CapabilityStatusChip`,
`CapabilityFacts`, `CapabilityDetailHeader`, `CapabilityBlockingBanner`, `capabilityCollectionAnatomy`).
The Where-it's-on control (its sentence, rule rows, add menu, consequence and words) is also composed by
Plugin UI `presentation/capabilities/**` (`HappierWhereItsOnControl`, `sayHappierWhereItsOn`). It is
engine-agnostic: it takes the computed state (Everywhere on or off, the stated rules, optionally the sentence) and
says the person's choice as an intent (`everywhere`, `add`, `remove`, `narrow`). Happier's binding in
`components/capabilities/where/**` turns its reach rules into that state and each intent into one `replace` through
the protocol rule engine (`whereItsOnReach` over `reachRulesChangeV1`, `resolveCreateReachV1` for add flows), and
passes the pruned sentence. Plugins use the public `WhereItsOnControl` adapter with their own state; no reach engine
is published through Plugin UI or the SDK.

The Add dialog's body (the ways to add as tabs, the catalog list with details beside it or pushed on a phone, the
install action and the registry selector) is owned by `presentation/capabilities/CapabilityAddBody.tsx`
(`HappierCapabilityAddBody`). Happier's Add a skill, Add a server, Add an agent and Plugin Add dialogs bind their primitives in
`components/capabilities/add/CapabilityAddModal.tsx` and keep the modal frame (card, header, back link); plugins render
the public `CapabilityAddBody` in their own page or sheet. No public dialog is added. The reach map remains
host-only.

In 0.3 development source, Add configs may use `onCatalogDemandChange` to
suspend catalog acquisition while an input mode or source-management level is
presented. The shared body owns that presentation decision; `onModeChange`
remains a mode-intent notification, not a second visibility classifier.

In 0.3 development source, My plugins is installed management for the explicitly
selected administration Machine. Its Add entry opens that shared body over the
Account Registry catalog; selecting Review closes onto the existing exact
listing continuation with source, native item id and reviewed version intact.
Agent plugin payloads use this same continuation rather than a separate trust
decision. The listing/Action/daemon owners retain target revalidation, credential
profile selection, optional access, ordinary approval and unknown-outcome
reconciliation. Browsing requires no Machine. Settings legacy Browse URLs
delegate to the canonical app-host discovery route, preserving selection and
source; Settings does not render another discovery collection.

Management capability/projection acquisition follows focus, layout presentation
and actual management/detail demand. Hiding a surface withdraws acquisition,
not an already-admitted operation's authority or exact-target reconciliation.
The Account update-review preference remains target-independent and key-scoped;
the existing device-local grid/list value uses its declared settings Action.
Contributed app pages, including hidden and unavailable recovery destinations,
remain in the canonical compact destination/activation catalog. Plugins column
and phone Pages menus expose that recovery without rewriting saved placements;
native panel search/navigation stays with its existing owner. The duplicate
Settings app-page inventory is removed. Loaded-runtime and full-page validation
remain separate from these development-source contracts.

In 0.3 development source, the Add body lands on the first displayed catalog
item once a measured split can show its detail, including delayed results.
`initialItemKey` supplies a deliberate identity; implicit landing never opens a
phone detail. Explicit selection and each input mode's selection remain local to
the open flow. A late Add acknowledgement belongs to its original item.
`renderLayout({ modes, level, body })` places the one mode control in the caller's
existing header during rendering; `onLevelChange` remains available for frames
that use the incumbent callback. Neither API transfers mode ownership to the
frame. Input `renderFound` uses the same list/detail owner and can keep a batch
footer without declaring a competing per-item operation.
`catalog.empty` can render from `({ selectMode })` when its recovery offers an
input mode, keeping that transition at the same mode owner.

The public Collection's `headerPlacement: 'list'` puts a collection-scrolling
header over its list pane; the default `'across'` spans both panes, while page
scrolling retains the page's own header flow. Add uses list placement for its
search/source tools.

The selected Add detail places its single primary immediately after identity
and purpose through `CapabilityAddDetailAction` (presentation:
`HappierCapabilityAddDetailAction`). `detailFooter` supplies the operation,
consequence and post-add steps; the slot is its required presentation point.
Input batch footers retain their own operation scope.

The body reports mode changes to its caller; data acquisition stays with that caller. The skill and MCP
callers demand registry item lists only while their catalog mode is shown. Opening Link, Upload or Paste
does not load a never-presented catalog; returning to Browse uses the existing registry reader and its
retained results and freshness checks.

## Declaration, activation and projection

### Bundled manifest admission (0.3 development source)

Account Availability reads admit current declarations and portable releases at
HTTP ingress because AppShell discovery consumes them. Lists retain only closed
Machine, installation and digest envelopes for per-Machine release-less
declarations. Guided Automation setup demands the exact plugin through the
incumbent Availability loader; its exact read supplies opaque Machine bodies.
The Event reader admits its selected body through the same Protocol load
ingester before using its Event declaration. Earlier full-body lists remain
readable. Publication and claim admission remain strict.

The server captures the Account cursor and intent page in one SQL statement.
On PostgreSQL, lists capture compact declaration identities first. The existing
declaration owner applies envelope validation and Machine consensus to those
identities; one set query fetches only the selected Account-current bodies in
the same snapshot. Exact reads retain full Machine bodies. SQLite and MySQL
retain their full-text capture path. Full-body decoding and response projection
occur after the snapshot closes; archive link reads acquire only the Artifact
identity they consume. A Collection declaration
claim or intent update names its plugin in the existing scoped refresh queue;
initial bootstrap, structural recovery and explicit Retry retain full discovery.

Collection writer rejoins use the same compact identities and declaration merge
owner, without fetching Machine bodies or taking the Account publication lock.
Changed claims capture and encode the complete Machine store before Account
admission. A revision-only read after admission detects a changed incumbent and
uses the existing transaction replay; the intent CAS writes the captured JSON
without returning or decoding those manifests under the lock. Account-before-
Collection lock ordering, quota admission and candidate-stage retirement remain
with their existing owners.

Bundled first-party file declarations are admitted by the bundled-plugin publisher
and serialized inside the same shipped CLI closure. Runtime locator and packaged
activation readers consume that result through the canonical ingester's typed
build-admitted input, with zero repeated manifest admissions. Generic inline
`manifest: unknown`, installed, development and foreign inputs retain full admission.
Managed-runtime publication may remove an unavailable provider facet from that
admitted declaration; locator identity, entrypoint agreement and contribution-graph
reference resolution remain enforced by their existing owners.


Generators, projections, catalogs and registries built from independent contributions isolate per contribution. An invalid or unprojectable contribution fails alone, with a diagnostic naming the plugin and the field, while host faults still propagate. Policy for one caller's intent stays at that caller; the shared reader returns facts.

Machine describe admission applies this rule to optional projection-family entries:
the Protocol owner omits an unadmitted entry and publishes the existing
`plugin_compatibility_projection_invalid` diagnostic, preserving unrelated entries.
Known fields and enum values remain strict; admission never coerces or ignores a
bad field to enable that contribution. Invalid response/family envelopes, package
custody and top-level execution facts still refuse the complete response. The wire
digest continues to identify the producer response, before read normalization.

In 0.3 development source, activation owns registration correctness. Catalog
introspection projects its admitted status without traversing required or bound
registrations again. Retained facts for plugins absent from the current catalog
are ignored; version/source mismatches and disposed occurrences remain unavailable.

In 0.3 development source, the existing Machine registry projection carries
the admitted Agent's optional `providerRequirements` and each Provider's typed
definition, provenance and source kind. These are declarations, not execution
grants. Targeted UI catalog readers consume the exact qualified identity through
this projection; a missing declaration remains unknown. No plugin activation,
second registry, or bundled-name inference supplies these facts. Account-scoped
Connected Account declaration agreement has one narrow generated-bundle exception,
described in [the Agent catalog](agents-catalog.md); external installed declarations
retain their own supplier-agreement rule.

In 0.3 development source, the existing daemon projection describe request accepts
`selection: 'settings'` or `selection: 'connectedAccountAdmission'`. Settings reads
build the settings projection directly. Admission reads reuse the full projection's
installed-package, Action, Resource, Machine-provisioner and Connected Account
builders under the same registry lease, without constructing unrelated model, SCM,
UI or Event payloads. Selection is part of the transport request identity. These
partial replies never populate the complete UI projection cache; omitted selection
still builds the full catalog.
This describes source behavior, not a loaded-runtime performance result.

In 0.3 development source, Workflow materialization requests
`selection: 'workflowMaterialization'` from this same Describe owner. It projects
only Agents and Actions, including current Action availability, occurrence,
execution origin and authorization facts from the same runtime lease. Action
schemas remain exact, occurrence-fenced reads. This selection builds no Settings,
UI models, installed-package catalog or other contribution families, and does
not populate the complete UI catalog cache.

The shared UI loader retains admitted whole-Machine sections for the same Home,
Account, locale and projection revision across repeated demand, including Search
query windows. Registry changes and daemon replacement invalidate those answers
through the existing Machine state writer. Reconnect reconciles that state;
an unchanged socket gap does not invalidate the catalogue. Explicit Home refresh
also includes directly read scopes whose surface has unmounted. Elapsed time alone
does not repeat Describe or Machine admission; explicit fresh callers retain
their requested freshness boundary. Deferred reads gather selected section
indexes, then their disclosed body digests, through the existing bounded frame
transport. This is 0.3 development-source behavior, not a loaded latency result.

Mounted surfaces use `selection: 'mountedActions'` at the same Describe owner
in 0.3 development source. The request names current caller occurrence/source
custody for the target and its prepared children, plus exact qualified Action
identities for additional callees. The leased producer includes each caller
plugin's own admitted Actions even when cold UI discovery has no Action
dictionary; an explicit callee identity adds only that Action, not all of its
plugin's Actions. It reuses the held registry and canonical Action index,
availability/authorization projection and package/form adapter; it builds no
unrelated contribution family. The existing UI projection family also carries the
matching client Action Artifact facts for exactly this selected registry. The
mounted-target owner pairs these selected facts with its target publication and
publishes ready, matching-occurrence client Action demand to AppShell's existing
executable activation owner. AppShell reconciles the complete ambient plus
mounted demand set once, retaining exact Home/Account, Machine, Artifact and
generation authority. Unmount, admission withdrawal and routed Account retirement
release that demand; pending activation cannot attach after withdrawal. The
existing shared invocation/observer readiness waiter consumes this same demand
and committed registration, without a second readiness state or retry loop.
The canonical UI loader shares one in-flight
read and settled result across mounted surfaces for the same Home, Account,
Machine, caller/Action identities, locale and projection revision, in a separate
slot from the whole-Machine answer. Unrelated supplier updates and cache age do
not reissue this question; a real revision change or explicit Retry does. A
cancelled read creates no automatic retry. The same selected reply carries those plugins' translation
declarations and referenced locale Resources, so another replica's ambient copy
cannot replace the mounted source's text. Locale bytes remain demand-loaded by
the existing translation runtime. Transitional inline translations carry only
the requested locale and English fallback, using the full projection's locale
owner. Targets without contribution points skip the
points read and retain Resource completeness already admitted by their exact supplying occurrence;
the selected Action reply does not withdraw that namespace. Action
schemas and effect admission remain exact occurrence-fenced operations.

Exact targeted-contribution replies share each demanded point/protocol/role
input contract and each contributor's own targeted snapshot once within the
reply. Mounts retain their exact identities, renderer selection, execution
origin and Resource capability. The Protocol decoder reconstructs the inline
mount facts and admits them through the existing strict mount schema; missing,
duplicate, unused or mismatched bodies are refused. It also accepts the inline
reply shape. This is an unreleased 0.3 host transport change under the direct-cut
contract, without a new cache, paging layer or SDK authoring surface.

In unreleased 0.3 source, a cold Account-mounted target publishes its admitted
Account contributions through the mounted target's existing publication owner
before waiting for Machine declarations, child mounts or Action facts. Machine
arrival uses the same declaration merge and publication: Account-owned operations
retain Account custody, while current Machine-only copies replace their Account
declarations. That visible, recoverable replacement can briefly follow the initial
Account result because Machine precedence cannot be known before its declarations
arrive. Unchanged contributors and their nested values keep identity, including
when a new Machine contributor sorts before them. Refreshes retain the last
complete snapshot while the next combined answer is read. An optional Machine
Action-facts failure keeps the admitted Account snapshot ready and exposes the
Machine failure separately. Account Actions still
await the complete declaration read; this changes mounted presentation timing,
not Action admission or execution authority.

Settings projection isolates a malformed contribution using the existing
`PluginDiagnosticRecordV1` channel. Full and Settings-only reads omit that
contribution and retain healthy peers, including other families from the same
plugin. Diagnostics carry the plugin version/source, contribution identity,
typed Settings error code and field id. Notification-channel Settings use the
same projection. The shared Settings admission owner in
`apps/cli/src/plugins/settings/localSettingsContributions.ts` reuses the field-schema,
default and editable-control validators. Author-module evaluation (including
`plugins doctor`) refuses invalid groups before publication, with the typed
plugin/contribution/field diagnostic. Canonical host admission and installed reads
use tolerant load: invalid Settings groups are omitted with an attributed
`plugin_contribution_skipped` diagnostic while healthy siblings remain usable.
The manifest envelope and declared engine range remain plugin-fatal, as described
under Manifest admission. Retained declarations pass through the same Settings owner:
projection, runtime Settings services, declarative models and daemon Get/Set
exclude invalid groups while retaining healthy siblings. This is demand-scoped
Settings admission, not whole-registry compilation. Actual Settings values remain
strictly validated on writes; opaque stored field ids survive healthy writes.
Strict authoring failures and tolerant-load skips use the shared manifest
diagnostic projector without exposing authored values. An invalid Settings group
alone does not refuse an npm installation; the healthy admitted declarations
continue through the ordinary installation review.
Missing host attribution or unexpected host
failures remain errors. This is development-source behavior; loaded-runtime
validation is a separate check.

The daemon's existing generation-scoped build cache retains these selected
registry projections separately from full replies. It shares output-equivalent
host contexts, but full replies still distinguish locale, Host UI API and
effective renderer availability. Current source, brand and applied-policy facts
must match before reuse; changed facts replace the previous body for that
context. Full construction reads SCM backend and hosting-provider declarations
without activating their native runners. The existing SCM operation owner demands
those runners when repository work begins and retains its authoritative registry
lease through completion; named startup background services remain startup consumers.
After asynchronous miss preparation, execution origins are read again and the same
prepared snapshot supplies both the cache witness and response. Skill
content remains a fresh filesystem read, not a generation-cached payload. This
does not introduce a fleet-wide declaration cache or share Machine authority.

In 0.3 development, `definePlugin` projects an Agent's
`connectedAccountLaunch.stateSharingDescriptor` into
`capabilities.providerStateSharing`. This cold declaration carries configuration
and state support, modes, unavailable reasons and the named privacy-consent fact;
native-home paths and sharing entries remain in the runtime descriptor. These
declaration facts apply to bundled and admitted external Agents alike.
An unavailable or retired catalog cannot authorize a shared-state change. The
existing Settings Action approval and Account CAS writer retain admission and
mutation ownership.

Agent policy, usage and outcome projections are available through the public
SDK Agent runtime domain. Native Lima operations use the daemon-only
`machine-provisioners/lima` subpath, and Git index operations use daemon-only
`scm/git`. The comparison parser stays in the pure SCM domain; path identity uses FS.
These projections retain the existing canonical implementations; plugin leaves
do not import the private Protocol or CLI-common packages. The bounded Claude
predecessor message-metadata build translation remains a build-only exception.

In 0.3 development source, a missing or wrong-tier generated UI artifact has no
verified release slot. Its declaration remains visible with the UI projection's
typed unavailable reason; neighbouring valid slots and daemon startup remain usable.

In 0.3 development source, dynamic Resources and Composer References do not
activate an otherwise undemanded daemon plugin during serving startup. Resource
reads, watches and prompt preparation demand the selected producer through the
existing activation owner. An activated plugin's asynchronous invocation boundary
settles its Resource descriptors before supplying synchronous `describe` and
`watch` services. Composer inventory comes from admitted declarations; search
and resolution demand the exact declared reference before reading registrations.
In a presented Discussion, installed manifests declaring Discussion controls or
regions establish their narrow UI/Composer projection through Administration's
existing Home-qualified demand owner before executable supplies are available.
This discovery read does not select or authorize a source. Hidden Discussions,
unrelated online Machines and reference-only plugins do not acquire that projection.
Explicit startup activation remains unconditional. Continuous background services
and Event subscriptions retain their startup lifecycle unless the declaration
selects configuration demand below. Source custody, exact occurrence checks and retirement
continue to govern both bundled and installed plugins.

In 0.3 development source, optional `activation.configuration` selects positive
startup demand from `accountCollections: [{ pluginId, collectionId }]` or
`automationEventSources: true` for the declaring plugin's enrolled Event sources.
Either source suffices. The host reads only physical Collection presence across
retained schema versions or the existing exact publisher/materialization source
census; it does not load the plugin to discover configuration. Existing Account
Collection and Automation source invalidations wake the same contribution-demand
owner immediately. Read failures retain eager activation and the plugin's existing
recovery behavior. Presence grants no Collection read/write or effect authority;
enabled state, credentials and currentness remain with the activated domain owner.
Declared Event subscriptions may bind an admitted dormant publisher; actual
emission still requires a current executable invocation.

Configuration observation starts through the serving registry after its Machine
materialization Availability publication attempt, not inside registry construction.
The daemon's initial runtime join includes configured activation admission, but
does not wait for unrelated release-less declaration claims or retained-row
preparation. Those claims remain background work and retain the same registry
lease until settlement; failures are observed immediately. Publication failure
still reaches the same unknown-read/eager recovery path. Retiring serving
subscriptions disposes this observer even when an unchanged activation lease
keeps the predecessor registry alive.

In 0.3 development source, the Automation definition API also accepts a V1
`contributedAction` target with qualified Action identity and a private
`actionInput` program (`literal` JSON or `eventPayload`). Schedule, plugin Event
and admitted webhook occurrences share existing Run admission, frozen recipes,
assignments, claim/reclaim and terminal settlement. The daemon's `execution`
claim scope consumes these and Workflow Runs; the `workflow` scope retains its
existing filtering. Claims label Action recipes `action-v1` without another
database discriminator. The assigned Machine opens Account-mode content and
invokes its canonical Action executor, which owns placement and Action policy.
Later effects use the existing active-Run lookup and local cancel signal. There
is no server plugin runtime, synthetic Workflow or second scheduler. Reclaim
retains inputs, not exactly-once effect guarantees; cancellation of a running
Action uses the existing uncertain-outcome state. Authoring examples live in
the [Action API guide](../apps/docs/content/docs/plugins/api/actions-tools-commands.mdx).

When configuration activates a dormant plugin, the existing activation owner
prepares its declared Event subscriptions and Automation adopted-definition
owner before starting its background service. The Automation assembly keeps
the same lookup when initially empty and adds the newly activated occurrence
through that owner; it does not create a parallel source registry.
The manager captures serving custody before awaiting module activation and
checks it before and after consumer preparation, so a held predecessor cannot
start a service after its serving custody moves.

Daemon declaration/source composition may overlap Account settings warming in
0.3 development source. Executable activation still joins settings warming and
the dependent ACP catalog refresh before capturing Account policy or lifetime.
The existing daemon readiness join remains; background registry checks construct
their Account-bound store only after that join.

The authenticated own-Account `/v1/plugins/data/presence` read supplies only
existence facts for requested Collection identities and that snapshot's Account
change cursor. Collection observation starts from this cursor, including changes
that arrived during the read. It neither opens row bodies nor claims a writer;
ordinary Data operations still enforce their current contracts and admission.

Author capture preserves Protocol-admitted immutable schema graphs; caller-owned
schemas still pass capture and admission. In 0.3 development, native Protocol
constructors retain executable parsers without building JSON documents; their
first `jsonSchema` read memoizes plain, frozen, structured-cloneable data.
`definePlugin` captures mutable author data immediately and projects its manifest
once when `manifest` is read, including descriptor validation at that point.
Runtime activation and Action identity references do not require that projection.
SDK-owned contribution protocols and points likewise retain captured executable
contracts and compact identities; their first descriptor read materializes the
plain protocol documents once. Structural or cross-copy author input keeps its
existing admission path.
Triage's runtime imports its definition owner; its public manifest entry remains
the explicit descriptor consumer. Unused exported JSON-schema aliases carry pure
annotations so portable bundle compilation can omit their document reads.
Resolved lazy definitions and their
concrete native references share one stored-read projection at the existing
schema owner unless the concrete schema has a distinct explicit read contract.
Writer-claim admission retains its declaration identity and result;
complete serialized manifests live only with their transport attempt. These are
0.3 development-source lifetimes, not a measured process-memory guarantee.

Account Action discovery retains selected manifests and exact source custody,
including daemon-only targeted source declarations. Only Account-placed Actions
receive Account activation targets; retaining a declaration grants no daemon
execution rights. Dynamic Resources explicitly select their executable placement:
omitting `execution` keeps the daemon owner, while
`execution: { target: 'account', account: { artifactId, exportName } }` uses the
same portable artifact and `definePlugin.activateAccount` registration owner as
Account Actions. Resource scope selects its host context, not its execution
placement. Account Resource reads and observations use the selected Account
without requiring a Machine; daemon-only declarations remain discoverable but
receive no Account execution rights. Actual module or activation failures return
their plugin-scoped typed refusal to the demanding operation while healthy peers
remain discoverable. The next explicit operation may retry preparation. This
applies to bundled and external plugins in 0.3 development source.

On the browser HTTP host, the surface Action dispatcher prefers an own connected
Machine for finite Account Actions through the existing Account `action.invoke` relay.
An invocation about a subject with its own Machine carries that subject's Machine
in the existing `externalActionTarget`; an Environment uses its controller Machine.
The placement owner preserves this target. Subject-less invocations retain the
first reachable own Machine, with no preference list or retry on another Machine.
An Account Action that uses the invoking UI declares `execution.invokingUi: true`;
`accountActionPlacement.ts` keeps that invocation on the invoking host so its UI
capability reaches the handler. Headless hosts still run the same Account Action
without UI. Client-only Actions already declare `execution.target: 'client'` and
need no additional field. This optional Account execution declaration is an
unreleased 0.3 author-contract extension: matching Protocol, SDK, plugin and UI
readers reload together; older strict development readers reject it. Omission
retains the existing relay behavior. No wire epoch or persisted format changes.
The receiving daemon runs the Account plugin runtime and resolves selected
Connected Account credentials through the incumbent purpose owner. Native mobile
and desktop HTTP hosts retain direct Account execution when no subject Machine is
addressed. Placement applies to every
provider, without a provider list, retry or fallback after relay selection. A browser
without an eligible own Machine retains local execution. Account
read observers retain their local dependency subscriptions; their finite Action
reads follow the same placement rule. Authentication and established credential
runtimes are separate from this Action placement contract.

In 0.3 development, a person's settled Account Action confirmation travels with
that relay in the existing private invocation context. It binds the exact
`action.invoke` operand, Account, Home,
request and selected execution target. The receiving
target consumes that consent while retaining the Plugin caller and its automation
authority; placement does not ask the person again. This does not confer host
authority or consent to another Action or changed input. Native execution and
mounted daemon Actions retain their existing confirmation paths. Consumption is
single-use. The admitted invocation retains its original operands and does not
ask again or compare them with a recomputed policy, plugin declaration, source or
version. Policy changes apply to the next admission.

In development, `plugin_action_current_intent_mismatch` carries
`details.currentIntentMismatch.field` in the existing PluginError detail envelope.
The admission owner names the failed comparison category without including either
value. The retained `fingerprint_source` category identifies an exact-operand
digest mismatch; plugin source and declaration are no longer consent inputs. The Account relay
and UI retain this detail for a traced replay. Admission and single-use consent
remain at the approval consumption boundary.

The daemon's target admission owner also writes the comparison category to its
local file log before error projection. Carried Account confirmation refusals
name that lookup branch and record confirmation and parent-approval presence
only. Neither the diagnostic payload nor the file log includes compared
values, proofs or digests.

Failure projection also retains the canonical dispatch owner's `notStarted`
proof through Account and mounted daemon Action carriers. Callers can classify
that definite refusal as not saved. Without that proof, an unknown outward
outcome remains uncertain; the error code alone does not establish whether the
provider ran.

An own host UI press admitted by the canonical Action policy also retains that
private parent intent without requiring a separate confirmation. The UI dispatcher
and receiving Account host use the existing reviewed-child port: child Actions
invoked by the handler receive proofs bound to their actual operands, rather than
an advance enumeration of nested effects. The plugin caller keeps its Account
automation authority. For example, Triage's
Save defaults click admits its Profile and Prompt writes without a second Apply
dialog. Explicit per-Action Ask settings still require their normal consent;
automated callers do not inherit this direct UI intent.

Raw host repair controls retain their already-confirmed target occurrence through
the same Account carrier. The canonical `action.invoke` operand carries optional
`expectedContributorOccurrenceId` to the target's existing occurrence admission;
settled consent cannot approve a replacement target selected after the prompt.

The UI admits Account Action and Resource descriptors without acquiring or
evaluating their executable artifact. The first invocation, Resource read or
observation prepares that exact Account target through the existing executable
host and registration scope; concurrent consumers share its preparation and
activation. Action preparation completes before the dispatcher reads executable
parsers or observation metadata. The captured Account lifetime owns cleanup.
Mounted renderers and daemon background services retain their own demand.

Dynamic Resource callbacks in the 0.3 development source can compose admitted
Action reads through `options.readAction(ref, input, { signal })`. The canonical
Action executor retains the Resource's owning plugin caller, captured Account,
occurrence and host-stamped Session context. The target must declare
`readOnly: true` or a matching predicate in the existing input-predicate grammar;
`dangerLevel: 'safe'` alone does not establish a read. Admission validates the
actual input before invoking the target, so one mixed read/write Action can
admit its read operands while refusing its mutation operands. The result keeps
the ordinary Action success/failure envelope and existing permission checks.

`options.observeAction(ref, input, invalidate, { signal })` installs dependencies
without running the read handler. The target registers `observeRead` beside
`run` in `definePlugin`, or through
`api.actions.register(id, handler, { observeRead })`. Its observer receives the
same admitted target context and owns its qualified dependencies, such as the
selected Session's Collection query; the calling Resource receives invalidation
and a disposable rather than another plugin's private storage. Cancellation,
Account or occurrence retirement disposes the observation and fences late
callbacks. A target or transport without read observation reports a typed
unavailable failure; it does not silently substitute polling or execute a native
read to establish a watch. These source extensions are under integration;
package publication and loaded-runtime validation are not yet established.

In unreleased 0.3 source, the mounted Resource store settles unsupported and
non-retryable watch-admission refusals for that binding. A transient admission
failure retains admitted bytes and waits for the existing Machine-scoped
projection push/reconnect signal, explicit Refresh, or renewed live demand;
it does not reopen an unchanged Resource on a timer. Recovery signals stop
when admission succeeds or demand ends. Established daemon subscriptions keep
their transport-owned resynchronization and invalidation delivery.

In 0.3 development source, an Account Action's admitted read of a selected
Machine Action uses the existing daemon Resource watch open/next/close transport
for dependency observation. Its private `actionRead` request retains the original
Account Action caller and enters the same structured Action admission as the
ordinary read, with `requiredReadOnly`. The daemon installs `observeRead` only;
it does not run the handler to establish the subscription. Private
`readInvalidated` signals carry no fabricated Resource digest and never enter the
public Resource event union. A delivery gap retires this dependency rather than
reopening it as a potentially unchanged read. Direct Resource callers without
the supported Account Action provenance remain typed unavailable at this seam.

The app's Resource watch pump follows runtime activity (0.3 development source).
Hiding the page or backgrounding the app cancels the parked `next` poll at once,
so it never holds the socket's user-request lease, and nothing is polled,
re-opened or retried while inactive. On return the pump re-opens the
subscription and delivers `invalidated` only when the digest moved. A
read-authority or `actionRead` watch treats that interval as a delivery gap and
retires, as above.

An executable Plugin UI can observe the authority of its own Machine read Action with
`host.watchResource({ readAuthority: { consumer: { pluginId, localId }, purpose,
input } }, listener, { signal })`. This development-source extension enters the
canonical Action admission path with the actual operands and installs only the
authorized Connected Account purpose watch. It runs neither the Action handler
nor a plugin dependency observer, and materializes no credentials. A foreign
consumer, undeclared purpose, non-read operand, stale occurrence or unavailable
Machine is refused by the existing owners. The mounted Account, Machine and
Session context remain host-owned.

The acknowledgement contains only its subscription id; there is no credential
digest, fingerprint, account selector or revision token. Exact authority
withdrawal delivers the existing terminal `expired_resource` event. Metadata
resync and unrelated-purpose changes do not retire the observation. Unbound
native authority follows the purpose owner's source invalidation contract:
store-only null-to-null refresh is silent, while native source invalidation
retires without probing credentials. A transport gap also retires the watch;
there is no proof of unchanged authority across an unobserved interval and no
automatic replay. Native and hosted Plugin UI use the same subscription and
disposal transport; the external SDK UI testkit supplies
`retireReadAuthority(reference)` for this terminal event.

A retained read controller can withdraw its exact shared value through the
optional `lease.retire()` operation. It disposes that value for all borrowers;
an old lease cannot evict a replacement or another purpose. Combine it with
`acquireExecutionBound` and establish the authority watch before exposing cached
bytes. If either operation is absent, or the watch is refused or lost, keep the
retained controller unavailable and reacquire cold. Stop or clear retained read
state before abandoning observation; a displayed Account and an execution origin
do not establish credential currentness. Forge's `useGithubCiBindingV1` is the
named consumer of this seam. Generated SDK publication and composed loaded-runtime
verification remain owned by the integration boundary.

An Account Collection observer can select one intrinsic row with
`collection.watch({ kind: 'row', rowId }, invalidate)`, using the same physical
identity as `get(rowId)`. The host filters the existing content-free AccountChange
row identities before fan-out; unrelated live row changes cause no callback or
read. Full invalidations and cursor resets still wake the observer. Catch-up
between an initial read and registration may conservatively wake that exact-row
reader, without retaining a second row cache or requiring another index.

In matching 0.3 development host and Plugin UI source, Data clients expose
`watchAccountData(selection, invalidate, { signal })` for a logical Account KV
key, an Account Collection, or core internal Tasks. It registers with the same
AccountChange dispatcher and lifetime used by Collection queries, performs no
read, and returns a disposable observation. The existing Sync change plan owns
hinted KV-key/full normalization; Data consumes that typed result for Task
invalidation. Native and hosted-web clients share that owner, with content-free
change notifications carried on the existing Data bridge. Projection owners
perform their ordinary read after invalidation; they add no polling or second
subscription system.

In 0.3 development source, ordinary Collection mutations also publish the
changed rows' old and new encoded index keys. An index watch narrows wake-ups
to its admitted equality prefix or prefix set; range bounds remain conservative.
Payload-only changes still invalidate matching members. The canonical
AccountChange publisher stamps the previous Collection cursor into each precise
hint: only a reader that observed that predecessor may narrow it. A missed or
unknown predecessor or a different retained reader contract forces broad catch-up,
including when the coalesced hint
replaced an earlier full invalidation. Genuine full hints, physical retirement,
relation-nullification fallback and cursor resets retain their existing rereads.
This matching 0.3 host/Home source contract adds no row cache or polling and
does not skip checkpoint writes, fresh Account admission or effect authority
checks. Loaded-runtime validation remains separate.

In 0.3 development source, `collection.query({ index, prefixes, order })`
selects the union of exact index prefixes in one authorized read, with one
set-shaped storage selection per page. A nonempty `prefix` and `prefixes` cannot
be combined. The query owner merges overlapping prefixes, preserves the existing
page limit and total index order, and binds continuation cursors to the normalized
set. An empty set returns no rows. Daemon, native/RNW and hosted Account Data
adapters share the same operand grammar and retain ordinary Account currentness,
encryption and cancellation checks. This unpublished SDK extension requires the
matching 0.3 host and Home; it adds no inventory-read fallback for older hosts.

In 0.3 development source, Collection read refusals retain their exact typed
codes through daemon and direct Account UI readers. Resource refresh owners
preserve the producer's nonretryable decision: a refused read settles, and an
already-admitted observation waits for a real producer change rather than
retrying the read or reopening the watch. Transient failures retain their
existing recovery. `collection_update_required` means the exact reader contract
is missing or cannot safely read the current writer; compatible retained readers
still receive read-only access. This refusal carries no required application
version or schema-version remedy. A plugin can surface the update code once;
it must not infer a version from it. These are source contracts, not loaded
runtime verification.

When an observed Action's admitted source or credential authority retires, the
host withdraws the affected Resource bytes through the existing
`expired_resource` watch failure. For an established watch, the shared client
store clears both raw content and typed reconciliation baselines before freshly
admitting the still-demanded read and watch. Expiry before watch acknowledgement
settles that opening as ended and releases its late physical handle; it does not
reopen automatically. A refused replacement stays unavailable. Ordinary dependency
invalidation retains the admitted value while refreshing. For revisioned
selected credentials, metadata-only Connected Account updates do not retire
credential authority.

Natural reads of a retained, settled `expired_resource` acquire again through the
existing Resource entry loader. An already-pending replacement is joined rather
than queued again. Established-watch expiry withdraws raw content and typed
baselines immediately, but leaves replacement pending until fresh admission or
refusal settles it; dependent reads do not settle the transient expiry. Permanent
refusals remain settled, with no automatic retry or consumer fallback.

The observer's `PluginActionReadInvalidation` is callable for ordinary refresh
and exposes `invalidate.retire()` for loss of the authority behind an admitted
read. A plugin uses retirement only after observing an actual replacement or
removal of its previously admitted source authority, not for a generic wake-up
or a presentation-only change. Both forms use the same qualified observer and
host-owned cancellation lifetime; retirement adds no public credential identity
or reason protocol.
The captured-observer reader `readPluginActionReadObserver` belongs only to
the private `cli-common` registration owner. Plugin authors register
`observeRead` through the existing Action definition or registration options;
the reader is excluded from the author API.
For a standalone Resource read that installs such an observation, retirement
aborts that captured acquisition and refuses its late response; ordinary
invalidation does not abort or reacquire it.

An Action observer can compose another contributed read through
`services.actions.observe(ref, input, invalidate, { signal })`, returning the
same asynchronous disposable contract. This accepts contributed references,
not host Action ids, and retains caller, read-only and registered-observer
admission without running the read. Declared Session operands must already be
exact host-resolved string ids, not selectors or reserved shorthand. Expected
execution-origin/routing pins are preserved; a transport unable to enforce them
or retain callbacks returns typed observation-unavailable rather than dropping
authority or substituting polling. The retained process Runner currently has no
observation callback transport.

Mounted consumers can declare one stable `PluginUiResourceProjection<T>` with
`decode(content, previous)` and consume it through
`useLivePluginResourceProjection(ref, projection, selector, { enabled })`.
The existing shared Resource entry admits each new content value once for that
descriptor, supplies the preceding typed value for domain reconciliation, and
notifies a selector only when its selected value changes by `Object.is`.
Freshness, pending work, errors and subscription state remain separate snapshot
dimensions available to the selector. Disabled bodies acquire nothing; typed
projection does not add a second reader, watch or polling lifecycle.
In unreleased 0.3 source, a same-process host producer can supply its reconciled
immutable content identity to this same store. The store then compares that
identity without requesting transport bytes or a digest; the typed producer
remains responsible for retaining unchanged facts. Usage uses this path and
materializes exact JSON bytes and their SHA-256 digest only when a byte consumer
requests them. Remote Host API content keeps its existing byte-digest contract.
The returned `getSnapshot()` synchronously reads the same selected, admitted
projection. Event handlers can use it to recheck a choice against current facts
before dispatch, even before React has rendered a notification. It does not
acquire a Resource, authorize an Action, or preserve authority after retirement.

The development PR-glance placement contract follows successful explicit link
Actions only. Relation refresh, Session remount and reopen never add a glance;
after personal removal, only the next successful link Action may add it again.
Channels' binding `attach` owns the one-shot
`session-pull-request-link-completions-v1` targeted contribution point. It invokes
current admitted operations after acknowledged attach/rejoin and disposes the
observation. Triage's daemon `complete` operation resolves its bound Account via
the existing profile Action and uses the exact verified Session/Home with the
incumbent widget Actions and Companion preferences. Native open/reuse, generic
PR links and snapshot links converge there; caller-only placement callbacks are
removed. Accepting a retained Watch offer changes Watch only, not placement.
Unavailable, approval-held or uncertain placement cannot rewrite the known link
result and is not replayed. Existing client selection and no-client/ambiguity
refusals remain authoritative; the daemon does not write device preferences.
There is no removal history, relation observer, deferred placement or
hidden/collapsed presentation override. The registered three-plugin CLI
composition exercises this path in source tests; package publication and the
loaded placement journey remain separate integration boundaries.

Mounted surfaces may read the optional, readonly `SurfaceContext.accountScope`
(`serverId`, `accountId`) supplied only by their admitted current Account lifetime.
It is an identity hint, not a grant; each Action retains its own scope and lifetime
admission. Older or unadmitted mounts without it do not infer an Account from a
Session or the globally focused Home. Current consumers include qualified PR
navigation, Local Act form context and release-read authority keys. This public
hint remains independent of the acknowledged-link placement operation; removing
an old caller callback does not remove those consumers or grant them authority.

In 0.3 development, an Agent's Account settings can contribute an inline
`ui.views` surface with role `agentSettings`, App target and content presentation.
The existing scoped settings section mounts it inside its one Account projection.
Launch input carries the selected Agent identity, that contribution's declared
nonsecret Account values and revision/state, and narrow pushed machine facts for
that Agent. It does not expose other plugins' settings, secret values or the full
machine record. The contribution uses the existing scoped settings Actions with
the expected revision; acknowledged writes invalidate the existing projection.
The Claude retention control consumes this slot. Core owns the generic mount and
settings lifecycle; the Claude plugin owns the control and retention semantics.

The development SCM cards bind contributed PR presentation through the existing
`ui.views` inline role `scmPullRequest`, with Session or App context and content
presentation. Launch input is `{homeServerId,pullRequest?: ScmPullRequestSummary,origin?: 'createdHere'}`;
the physical host stamps `homeServerId` from the same admitted runtime as the
mount's Home. The optional PR is SCM's branch hint, including the exact create/reuse
result with `origin:'createdHere'`; carrying this origin does not itself attach a
relationship. Triage consumes that origin after the exact Session's linked PR
Resource settles, and attaches an unmatched created PR through the existing
Channels Link Action once per mount. A linked Resource entry prevents another
attach after remount; a failed attempt keeps the existing Link control for retry.
New attachments keep Watch off by default. The Session slot mounts without a
branch hint and the contribution renders its linked PR Resource alongside any unmatched hint. Branch hints offer
the existing Link action; the composer remains linked-only. The public SDK `/scm`
entrypoint owns `ProtocolScmHostingProviderKind`, `ScmHostingRepositoryIdentityV1`
and `ScmPullRequestSummary`; `/protocol` exposes their composable repository
identity and summary schemas, with matching Node/browser exports. Those schemas
project SCM's current normalized field grammar. A Session mount supplies its exact host-stamped
Session separately. The contribution owns matching an explicit relationship and
displaying its status. An App mount has no implied Session and stays cold after
its explicit picker-and-attach flow; that choice does not retarget the mount.
Actual Session navigation and mounting own Session-status demand. Missing or ambiguous contributors
leave the existing discovery card in place. The shared PR bodies and their visual
validation remain under integration.

In 0.3 development, resource opening is a core decision. Callers submit one typed
`{kind: 'pullRequest' | 'issue' | 'ciRun' | 'securityAlert', url}` intent; plugins
offer destinations through optional `resourceLinks` on a destination or the existing
`scmPullRequest` `ui.views` contribution. A resource-only integration declares these
on its real destination instead of claiming an SCM card slot. Each entry declares its `kind`, anchored
`urlPattern`, and local view `destination`. Session and App declarations name
their own destinations; they do not introduce another host point or opening
policy. Core matches available admitted contributions and selects the destination
for the caller's context. A URL alone never implies a Session or attaches a PR.
Session destinations restore the exact resource through the existing instance
key disclosed as optional `context.surface.mount.instanceKey` on destination
mounts in Host API 1.1. Launch input remains transient; this disclosure reuses the
pane's retained identity. App destinations restore through their existing route
parameters. Channels retains an optional canonical resource intent beside a
provider event URL; unknown external URLs remain URL-only.

The Account preference `scmResourceOpenLocation` defaults to `happier`; `github`
requests the external destination. **Open GitHub links** appears in Files & source
control settings when an in-app contributor is available. Core keeps the external
URL fallback for unsupported links or an unavailable/ambiguous destination.
After navigation accepts a destination, an unavailable renderer instead offers
an explicit **On GitHub** action. The current GitHub contributor supports
Dependabot and code-scanning alerts; secret-scanning alert links stay external.
`scmPullRequestPlacement` separately controls where the new-PR creation form
opens; it does not decide where existing resource links open. These are
development-source contracts, not a released-availability claim.

Chat links also honor the deliberate device preference `chatLinkOpenLocation`
(Settings → Session → Transcript): **Your browser** by default, **Embedded** on
desktop/native hosts, or **Managed**. The existing `settings.get` / `settings.set`
Actions expose it as `transcript.chatLinkOpenLocation`; it is not Account-synced.
Transcript Markdown supplies its Session and destination-instance scope to core
`openResource`, which delegates a Browser open through `browser.workspace.open`.
Explicit SCM resource intents retain their contributed destinations and Account
preference. Machine localhost addresses always
stay in the app: Browser's shared address resolver prefers a running Service
preview, otherwise the managed Browser on the Machine. This is development-source
behavior; it does not claim released availability.

The presented Session Git pane demands the existing branch list operation on
mount, branch change, successful push/publish and explicit Refresh. Snapshot
refreshes do not demand another list read. The existing bounded SCM cache keeps
last-known branch observations across selected PR bases after its request-reuse TTL, projecting their original
`checkedAt` and zero remaining TTL; a demanded list can replace them. This adds
no PR discovery poller.

In development source, the Git snapshot takes its default branch from the
remote HEAD, then from repository metadata retained in that same SCM observation
cache. When no default is known, the demanded branch read asks the hosting
provider's existing repository adapter; snapshot refreshes make no metadata
request. Discovery filters by head and only applies a base filter when explicitly
requested. An unknown default remains unknown: the Session header opens the
existing PR form with “Choose a base branch” rather than treating the branch's
upstream tracking ref as its PR base.

For that explicit choice, `selectActionInput({hostAction: {
action: 'session.transcript.get', projection: 'sessionAddress'}})` opens the
existing native Session picker in reference-only mode. The admitted Account
supplies the Home; plugins cannot provide a Home override or Session inventory.
The result is `{kind:'sessionAddress',session:ActionSessionAddressV1}` or the
existing cancellation/typed Host API failure. It creates and sends nothing and
grants no Action authority; the subsequent Action rechecks its chosen target.
Account retirement and cancellation close the picker. These are development
source contracts, pending package and loaded-runtime validation.

The unreleased notification destination selection uses the same finite form
owner: `selectActionInput({hostAction:{action:'notifications.notify_me',
projection:'notificationDestination'},channelId?,target?})`. Without `channelId`, the
form first chooses from the current notification channel options. It then
opens the Channels-owned input-type picker and returns
`{kind:'notificationDestination',channel}` or cancellation. The result contains
saved addressing only; provider operations resolve it through the current
connection owner. Selection never sends, changes a connection or saves the
subject. Source setup and Account/Project creation preferences borrow this
same presenter. The mounted Home and Account lifetime remain bound throughout
selection; retirement closes the form. Source Configure supplies its readonly
preview's controller address as `target:{serverId,machineId}`, including when
the observer hosts the form. Selection stays disabled until that address is
available; the existing preview Retry recovers a failed preparation. An explicit
target must remain in the mounted Account's Home. Creation preferences use their
bound host. Explicit Test remains the separately
confirmed `notifications.test` Action.

The callback's `options.resources` binds the ordinary Resource service to its
own plugin, occurrence and exact host context. A composed Resource can read or
watch another Resource through this owner. `resources.watch(id, invalidate)`
returns `Promise<Disposable>`; dynamic `runtime.observe(invalidate, options)`
may likewise return its disposable asynchronously. The existing host awaits
dependency admission before reporting a live subscription, propagates the
original typed failure, and disposes an attachment that settles after its
captured lifetime has ended. This avoids treating a pending or refused
dependency as an established watch. An invocation read reuses a current
snapshot held by live demand, and concurrent acquisitions share their in-flight
read; the owner releases retained bytes when that demand ends or authority
retires. An ordinary external read or explicit refresh still acquires a fresh
snapshot. Recursive dependency chains fail with
`plugin_resource_dependency_cycle` rather than reading another plugin or
constructing a second cache.

In 0.3 development source, mounted plugins call `hostApi.admitAction(action, input, options)`
before a caller-owned Account KV or Collection mutation. The existing surface Action
dispatcher applies Account enablement before its normal approval presenter, without
requiring a reachable daemon. Off rejects with `denied`, a user decline returns `false`,
and cancellation or mount retirement rejects without authorizing the writer. After
`true`, the plugin invokes its existing domain writer with the same signal; admission
does not run that writer, retain a grant, or replace Account authorization and CAS.
Unvalidated input cannot waive an input-conditional declaration default: this path uses
its conservative no-input default. Both physical SDK transports advertise and consume
the same optional host method, so an older host refuses it as `unsupported_method`.
Action-bound `confirm` also consults enablement, but remains a presentation helper.

In 0.3 development source, an Action may declare `approvalScope: 'environment'`
independently of its contextual `scopes`. The normalized input names `serverId`
and `environmentId`; the deployment admission owner resolves the Environment,
using a preview child's template Environment for per-Action preferences. Missing
or unavailable provenance refuses before the handler. Daemon Actions admit this
policy at the receiving daemon; client and Account Actions admit it in the UI.
The admitted invocation retains that choice through confirmation and execution;
a separate retry or replay is a new admission. Actions without this declaration
retain their existing approval behavior.

In 0.3 development source, an Action may declare `confirmationWhen` using the
shared input predicate grammar. The host evaluates it against the parsed input
passed to the handler: non-matching inputs do not inherit that declaration's
default confirmation, while explicit per-Action approval settings still apply.
Catalog reads without input retain the declaration's conservative default.
This does not change execution authority, Agent permission policy, or durable
approval replay checks. Bundled and installed plugins use the same rule; Channels
uses it to read Session pull request bindings without asking by default while
retaining automated confirmation for attaching links and removing triggers.

In 0.3 development source, `confirmation.inputFields` declares reviewed
`{path, title}` operands. Each dot-separated path (with `[]` array segments)
must resolve in the declared input schema; conditional union operands may be
absent. Client fingerprint custody and daemon request custody pass the exact
invocation input to the existing native/hosted Action confirmation owner. That owner
uses approval review's field traversal, formatting and confidential-input
projection, then appends only the declared operands to the static consequence.
Titles are statically localized declarations; plugins supply neither executable
text templates nor a second dialog. Missing operands add no line. The manifest
and each nested field remain closed declarations; older unsupported strict
hosts refuse this unreleased addition through normal compatibility admission.

The same `confirmationWhen` declaration accepts
`{ presentUserUi: false }` for a uniformly reversible own-UI operation such as
completing or reopening a review. That scoped value also accepts an input
predicate for input-dependent UI consequences. It applies only with
host-stamped present-user authority on the UI surface; other requesters retain
their surface default. On CLI, `writesLocal` defaults to Direct unless an
applicable `cli`, `default`, or flat input predicate declares confirmation.
Destructive and outward operations, and confidential reads with confirmation
metadata, retain Ask. Explicit user Ask
still wins, and a waiver changes confirmation without granting human authority.

The scoped form's optional `default` input predicate preserves conditional
defaults for requesters outside that present-user UI scope. Channels combines
its non-list predicate with `presentUserUi: false`: reads remain direct,
reversible person-operated binding changes skip the default dialog, and
automated writes retain their approval floor. This is an unreleased development
manifest extension; unsupported strict readers refuse it through the existing
compatibility admission rather than dropping the policy.

The scoped form also accepts optional `cli: false` or a CLI input predicate.
This changes the CLI default only; it does not grant present-user authority.
Channels uses the predicate for own-Account PR attach (not trigger changes),
and Triage uses `false` for reversible Session link/unlink. Agent and MCP
defaults remain unchanged, and explicit per-Action Ask still wins. A CLI Ask
on an Account-target Action retains live custody and waits for a decision or
cancellation; ordinary link calls no longer enter that wait by default.
This is an unpublished manifest-V2 author extension, not a new wire epoch or
package-version guarantee. The declaration and nested predicate remain closed;
an unsupported load reader skips the whole contribution, never only its policy.
The inspected moving 0.2 predecessor at
`a7cfad84168f21b364b37d431175f50c311acb7e` and immutable `cli-v0.2.17`
have neither this scoped declaration nor its SDK author owner, so no adapter
or reverse-development rollback path is introduced.

In 0.3 development source, bundled client-only declarations receive the same
process-local occurrence and source custody as other plugins. The executable
registry census includes declarations with no daemon entrypoint; final policy
admits their current declaration without synthesizing a daemon activation.
Consumer retirement fences their Voice provider lifecycle through the existing
occurrence owner.

Action discovery also admits a cold daemon declaration through the shared final
policy facts owner. Declaration policy requires the selected current occurrence
and source custody, and still enforces inactive activation facts and actual host
service availability. HostAccess declarations remain consent metadata. Discovery
does not claim an applied handler or activate plugin code.
Invocation demands activation and uses applied execution policy; declaration
facts cannot become present-user execution authorization.

Exact Action execution and inspection select the qualified declaration from
the admitted registry's existing Action index; only discovery enumerates the
catalog. Prepared invocation bindings share that registry's plugin lifetime.
Static HostAccess and Event-recovery references belong to the admitted Action
row; declaration registration rights belong to its deduplicated activation
target. Demand reads neither rebuild these facts nor rescan whole manifests.
Current occurrence, authority, service availability and approval are still
checked for each demanded Action, never reused as cached authorization results.
This lookup contract is the same for bundled and externally installed plugins.

For a client-placed Action, the client executable composition supplies the applied
occurrence from its exact committed SDK registration. The daemon's projected
desired occurrence and access facts remain authoritative; its daemon-entrypoint
application state does not describe client application. The dispatcher feeds
those combined facts to the same current-generation policy. Cold daemon
activation therefore cannot block an already applied client handler, while a
missing, replaced or retired client registration still refuses execution. This
applies to bundled and installed plugins in 0.3 development source.

Contributed client Action delivery consults the authenticated live RPC registry, not the absence of
a positive reconnect hint. A definitive missing-handler refusal, including the UI's decoded
retirement receipt, preserves `actionHandlerInvocation: notStarted` through the existing settlement
owner. An issued effect with a lost or malformed receipt retains unknown outcome and is not retried.

### Background-service placement (unreleased 0.3)

Background startup consumes the invocation-service owner's binding. HostAccess
declarations are metadata, so absent grant decisions do not prevent a trusted
runner from starting. Actual service operations report their own unavailability.

Each `backgroundServices` declaration selects `placement: 'daemon' | 'process'`
and `activation: 'continuous' | 'demand'`. Omitting them preserves the existing
daemon/continuous behavior. The
[`background-service lifecycle owner`](../apps/cli/src/plugins/runtime/lifecycle/contributions/backgroundServices.ts)
owns start, demand coalescing, settlement and retirement for both placements,
including host-owned services. A demand runner is finite; daemon-realm Actions,
Event handlers and runners of the declaring plugin request it through
`services.backgroundServices.demand(localId, reason?)`. The returned
`{ settlement, cancel }` handle belongs to that caller. Successful Action
completion does not withdraw an accepted demand. Callers that need cancellation
forward their signal to `cancel()` and await `settlement`. Cancellation rejects
only that caller's handle without waiting for shared cleanup; it does not cancel
other callers. Demands accepted during a run join one sequential
follow-up run.

Process placement uses a supervised Happier child through the existing binary-safe
launch and process-custody owners. The daemon admits the plugin's source and policy;
the child loads that exact source to activate the selected runner and any consumed
reader surfaces. It starts no sibling services or subscriptions and becomes no
catalog, installation, Action-admission or public-database migration authority.
For demand activation, a real demand starts a child for its finite batch. Demands
accepted during a run coalesce into one follow-up in that child. Successful
settlement joins the runner, invocation cleanup and child exit; the next demand
starts a fresh child. Replacement, disable/uninstall and shutdown join child exit
through the same abort-and-settle retirement path. An unexpected exit fails the
demand visibly as `background_service_failed`; only a new demand starts a
replacement. There is no automatic restart or host-owned idle timer.

A request-serving runner may own an idle grace inside its run. Memory uses
the existing process service bridge to wake its child-owned 57-second grace
immediately on demand and exposes the expiry through its existing status.
This does not change the shared lifecycle's exit-after-run-settlement contract
or add a host timer; see [Memory placement](search.md).

The process runner rebuilds `logger`, `fs`, `http` and `exec` locally under admitted
policy. One bridge reaches the daemon's bound `storage`, `settings`, `events`,
`sessions` and `actions` owners, retaining cancellation, callback and watch
lifetimes. In particular, public daemon databases keep their host-owned migration,
transaction and incumbent-query callbacks; the child does not reopen their SQLite
files. Other services are unavailable in this first process-service contract,
including `backgroundServices` itself and UI. Availability reports the bindings
actually supplied; a missing binding yields a typed unavailable service. This is
process placement for trusted plugin code, not a sandbox.

Consumed Agent reader operations bind the available subset of that same service
set through the ordinary invocation owner. An Agent manifest can also require
interactive runtime services, such as terminal control; those unrelated
requirements do not prevent a native transcript read from binding its available
Exec service. Unsupported services remain unavailable; manifest HostAccess
declarations do not add a separate admission veto.

The maintained public example is
[`background-indexer`](../packages/plugin-sdk/examples/background-indexer/src/index.ts).
Its refresh Action demands the process runner through the same SDK boundary used
by installed external plugins. These declarations are unreleased 0.3 contracts;
the generated SDK inventory and capability matrix remain the public export and
availability authorities.

### Portable Account Actions (0.3 development source)

`ActionsService.execute` and `PluginUiHostApi.executeAction` return an Action's
domain result and reject host admission failures with `PluginError`. For
`session.spawn_new`, a thrown `target_unavailable` refuses the target before
creation; it is not an unknown Session outcome. Session-start callers consume
that refusal separately from returned creation settlements. Unclassified
exceptions still require the existing same-creation-key recovery: a missing
reply alone does not prove that no Session was created. Triage handles this at
its shared Session-start owner for initial starts and resumes.

The optional Account Action `services.machineConnectorSecrets` sink spends the
owning controller's existing Domain admission. The host captures its controller,
every target installation/public key and operation; an author supplies only token
bytes and `{ provider, connectorId }`. The existing installation-grant writer
seals separately for each receiver and returns only
`{ grants: [{ machineId, installationId, grantRef }] }`. The controller and
receivers may differ. No Saved Secret, second grant writer or token-bearing
Action result is involved. This is an invocation capability, absent without
that admitted controller parent and in portable UI execution; it is not a new
catalog service, policy issuer or Machine-selection operand. The existing
writer owns cancellation, HTTP failure and byte cleanup; uncertain writes are
not replayed automatically. The Domain owner retains each acknowledged grant
in its private prepared content before dispatching native work, including when
a later target write fails. One vendor operation serves the admitted target set.
This describes unreleased 0.3 development source.

The existing reviewed-child issuer carries this service in its typed,
host-private `invocationServices` operand, not in Action input or results. The
admitted child projects only its supplied connector service into Account
services; omitting it clears an inherited parent's connector service. The
child retains the existing target and active-parent lifetime.

The development Cloudflare configure Action returns `prepared` after remote
configuration and sealed connector custody, not after Machine activation.
An unknown result retains acknowledged tunnel/DNS coordinates and any opaque
grant reference so the controller can preserve them through the existing
protected Domain content writer. Neither result proves the root-only file,
container reader or active ingress; the native owner supplies that evidence.

Action permission-policy disclosure is owned by Protocol's Action specification:
optional literal `permissionChanging: true` wins over the host-private pure
`permissionChangingForInput` resolver. `resolveActionPermissionChangingV1` is the
single derivation; mixed Settings mutations read the canonical setting declaration,
not ids or `sensitive`. Public Action discovery and generated SDK DTOs carry only
the resolved optional scalar. Settings control-state data supplies the shared
Allowed notice and exact Action/audience/scope Ask-first revert intent. This is
unreleased 0.3 source metadata, not an authority or nonwaivable approval floor;
visual notice composition and loaded-runtime validation are separate work.

An Action may declare `execution: { target: 'account', account: { artifactId,
exportName } }`. It runs in the invoking UI or CLI process, without a Machine,
from the Account's current enabled release or the host's trusted bundled
declaration. Account scope alone does not select this placement. Daemon Actions
retain their selected Machine occurrence; client Actions retain their UI target.

For a plugin that supports Account credentials and machine-native credentials,
the plugin owns selection between separately declared roles. In 0.3 development,
GitHub's public HTTP read roles select Account execution for an Account binding
and dispatch the shared implementation's native child role for a native `gh`
binding. Discovery uses the selected purpose binding. The generic host still
executes each declared realm normally; it has no GitHub placement rule or native
credential fallback. The Account artifact registers established credential
materialization through the existing Connected Account custody and host HTTP
ports. Importing a credential with `gh` does not make its stored Account custody
machine-native. Workspace and Session relationship roles remain native.

A restricted agent process without Account credentials reaches that CLI host
through its existing authenticated Session Action capability. The credentialed
host checks the current Session owner and requester Home, resolves the actual
current Action placement, and invokes the same Account executor. Account keys
remain in that host; this is not execution in the restricted child process and
does not add a transport, loader or Machine occurrence. Ordinary client and
Machine Actions retain their existing authorization and transport.

The existing Account Availability selection and executable registration index
own custody and currentness. Explicit disablement and a selected release take
precedence over bundled declarations. Replacement, disablement or Account
retirement withdraws the old registration and pending capabilities. Invocation
uses the same declaration schema, registration rights, schema compiler, input
validation, final policy, approval and post-decision currentness checks as other
placements. There is no Account-specific invocation or settlement engine;
refused, applied, uncertain and failed outcomes retain their existing meaning.
An uncertain write is not automatically replayed.

In 0.3 development source, bundled discovery and a selected Machine can supply
the same client executable module. Compatible declarations share that module's
registration rights, while the existing index publishes each exact target,
execution origin and occurrence separately. Retiring one occurrence withdraws
its registrations without withdrawing another current occurrence. Executable
byte identity does not substitute for invocation authority or currentness.

In 0.3 development source, a host's bundled Account declaration is identified by
package, plugin id and version. Its process-local occurrence owns retirement;
manifest or artifact hashes do not grant authority. A mounted Account caller
carries its package version and declared contribution, which the receiving host
checks against its current enabled Account selection. Portable releases retain
their exact selected archive identity. Byte digests still identify fetched
artifacts and resources; they do not prompt for trust or replace Account policy.

Availability validates and normalizes declarations at claim/release publication.
Its stored-declaration readers check the identifying envelope rather than
re-parsing the full server-written contribution graph on each admission. Fresh
Account intent, exact Machine installation/materialization and selected-release
correspondence checks remain authoritative. Release-less Event digests still
bind retained definitions to their exact schema; they are not trust grants.

In 0.3 development source, release ingress parses once, then prepares an
immutable snapshot with canonical Collection and UI-slot order. Hosts publishing
already-admitted facts prepare that snapshot without another schema admission.
First-publication conflicts compare the prepared facts structurally; no
per-object admission cache or cached signing string determines agreement.

An Account Action's request census admits its selected release; a handler that
started without an approval wait does not read Home custody again. An answered
approval is the one later boundary: the host re-reads the Account selection and
credential before the handler starts.

A successful Collection writer claim is retained for its declaration and live
Account across a daemon's registry replacements and plugin re-activations. Equal
rebuilt manifests reuse that admission; a changed declaration or independent host
claims anew. An unrelated change-stream reset is not a new writer declaration.
Refusals retain their occurrence/Account recovery inputs and can retry on
availability hints; transient failures remain retryable. Every read/write still
passes server authorization. This is unreleased 0.3 development behavior.

`definePlugin(...).activateAccount` exports the same `activate(api)` ABI, limited
to the declared Account Action ids for that artifact/export. Its context exposes
`services.storage.account`, Account-only `services.settings.forScope({ kind: 'account' })`
reads and watches, `services.actions.execute`,
`services.actions.executeAdmittedTargetedOperation`,
`services.actions.observeAdmittedTargetedOperation` and
`services.targetedContributions`, together with the invocation surface, signal
and host-stamped caller. Authenticated hosts may supply `accountScope` and the
same exact `sessionTargetsV1` operands admitted by the Action executor. Neither
comes from plugin input or selects a Machine. An invoking UI may supply the
ordinary optional `ui` authoring capability on finite invocations, never read
observations; headless handlers must refuse a
UI-only compose operation when it is absent. The context exposes no Machine
filesystem, process or credentials. Storage remains with the existing Account KV and
Collection authorization/CAS owners; nested Actions independently pass the
ordinary host policy and approval gate.

In 0.3 development source, an aggregate Account read can pass
`machineAvailability: 'current'` to Action execution or admitted targeted
execution. Nested Actions inherit this latency hint: a pending optional Machine
returns its existing unavailable result rather than holding available Account
sources behind connection settlement. It changes neither placement nor admission.
Omitting the hint preserves ordinary Machine connection settlement. Account
targeted declarations publish independently of optional Machine readiness.

CLI and UI Account contexts expose `services.http` and `services.secrets` through
the same portable service contracts. The shared HTTP owner lives in
`cli-common/plugins/http`; CLI and browser/native UI transports adapt that owner
rather than deciding credential or redirect policy separately. Finite requests
admit authority once, retain local cancellation, and release response bodies and
redaction custody on completion. Open-ended access retains its withdrawal
lifecycle. Secrets remain declaration-bound to the captured Account; an explicit
SavedSecret read uses that Resource's encryption mode, not the Home Account's.
These ports neither select an executor nor add native process/filesystem authority.
Account Actions also expose portable `connectedAccounts.getBinding`, `materialize`,
`listAccounts`, and `materializeListedAccount` through the shared purpose and
established-runtime owners. In unreleased 0.3, `getBinding(purpose, { observation: true })`
also projects the selected credential/configuration revisions and recorded Pool
identity when available, without selecting a member or acquiring credentials.
Omitting the observation option preserves the ordinary binding read's cost.
Listing exposes only the selected direct Account or
enabled members of its selected Pool, with host-normalized configured endpoints;
listed materialization refuses a different target or configured origin at
credential acquisition. Finite listing and materialization retain their admitted
selection and reuse that resolution's profile/Pool observation rather than
reading the same inventory again. They do not perform fresh metadata or
authorization reads after the effect. Local cancellation and the established
materializer's lifecycle remain. Account
Actions have no watch port: the live binding-store watch producer is daemon-owned.
The unreleased 0.3 daemon event carries `authorityChanged`: initial delivery and
presentation-only updates are `false`, while the canonical purpose owner marks
authority changes `true`. The host and runner bridge preserve that discriminator
and coalesce pending authority changes without replacing them with presentation
updates. Consumers refresh presentation without retiring runtime work; changed
authority applies at the next acquisition/admission, and admitted finite work
retains its snapshot until completion or explicit cancellation/disposal.
Acquired credentials and Saved Secrets register with the same invocation
redaction lease; Account dispatch projects successful results and failure
diagnostics through the shared Action projector before returning them.
The loaded cloud-creation journey remains a separate integration obligation.

Managed role dispatch carries the incumbent host-private
`ConnectedAccountInvocationPurposeBinding`, never a public Action operand.
The shared capture owner binds its qualified consumer once; both physical hosts
use the exact captured purpose bindings rather than mutable Account defaults.
Retained configuration revisions preserve explicit `null` versus omission and
reach the same established materializer. This adds no credential selector,
runtime registry, refresh owner or native credential fallback.

Connected Account descriptors may declare `authentication.account: { artifactId,
exportName }` using the existing Account artifact reference. The same
`activate(api)` ABI exposes `api.connectedAccounts.register` for a
`ConnectedAccountPortableRuntime`. Authentication callbacks receive admitted HTTP,
attempt/configuration and staged credential ports. Its optional `materialize`
callback receives `ConnectedAccountPortableReadContext`: the established Account,
configuration, selected read-only credentials, invocation identity, cancellation
and HTTP. Both use the existing registration lifecycle; materialization runs
through the shared established runtime dispatcher and purpose owner. Existing
authentication-only registrations remain valid, and unsupported operations return
a typed refusal. The ordinary full daemon registration remains available for
native import, refresh, exec and filesystem operations. Declaration and
registration rights do not themselves activate the UI authentication lifecycle;
that lifecycle is owned by the existing Connected Accounts coordinator.

Service description reads the current cold Connected Account declaration and
Account profile metadata without acquiring an authentication runtime. Native-only
modes such as Codex `native-import` remain discoverable when no portable Account
registration exists. In 0.3 development source, placement is decided per mode:
`credentialOrigin: 'native_import'` always requires the selected Machine, including
native apps and services that also declare an Account artifact. The shared
Protocol mode-placement policy feeds host routing and the existing Machine
chooser; browser sign-in support is required only for browser-unreachable modes.
Selecting such a mode still uses the existing selected-Machine
native authentication path and ordinary Action approval.
GitHub's `native-import` method appears in that same Connected Services setup.
It reads `gh auth token` locally through the shared system/managed GitHub CLI
resolver, confirms the GitHub numeric user id once through `/user`, then stages
`token` with `providerIdentity` in the existing authentication attempt. The
attempt owner reuses a connected profile for the same qualified service and
provider subject; otherwise it assigns an opaque Account id and uses its existing
Plain/E2EE connected-credential envelope. No credential is returned to the UI;
the original sign-in time remains unknown. A successful health observation fills
a missing retained provider subject through the existing credential writer.
Ordinary metadata reads do not fetch identity. Missing or
signed-out `gh` settles with `github_import_credentials_unavailable` and local
sign-in guidance. This is 0.3 development source.
Credentialed core and daemon Actions that do not carry a retained journey host
compose that same Account authentication host after Action admission and dispose
the one-shot runtime on settlement. Continuations carry only the attempt ID;
the authentication host reads its addressed Home attempt to select the native
Machine. The native RPC adapter does not infer that Machine from an omitted
continuation operand or from the executing daemon's own identity.
In 0.3 development, a manual or OAuth mode declares
`browserReachability: 'unreachable'` only with decisive evidence that its actual
authentication request is blocked in the browser. The authentication host routes
that mode through the selected Machine and refuses before begin if none is
selected. Omitted reachability preserves browser execution; native apps retain
local execution. This describes authentication, while a provisioner's
`browserReachable` describes its complete creation and bootstrap recipe.
Environment relay retains the exact resolved controller and original draft;
an offline controller returns `machine_unavailable` with `role: 'controller'`
without borrowing another Machine or Home.

The ordinary `session.status.get` read carries an optional exact `agentTarget`
projected from readable owner metadata by the shared Agent resolver. Its
explicit accepted-workspace read remains the checkout authority; display paths
and unreadable or older status responses supply neither proof. Portable
configured Triage uses these existing reads and Session creation/input Actions,
not a separate launcher. This is development source, not released availability.

Dynamic host requests use the SDK `parsePluginHostActionInvocation` facade over
Protocol's canonical plugin-surface identifier/input schemas, then ordinary
`services.actions.execute`. Parsing grants no policy admission. Its result
retains the canonical approval-deferral envelope, distinguished with
`isPluginActionApprovalRequestCreated` before consuming a domain result.
Headless configured handoff reads the public status result; it does not
manufacture a partial UI `SessionStateV1`.

App-scope confirmation retains the admitted runtime occurrence unchanged,
including the canonical Account-release custody string. The requester uses
the shared runtime-occurrence schema; its invocation identity may include that
occurrence and remains bounded by the existing whole-interaction JSON budget.
Short request/question identifiers retain their own bounds. The same transient
owner still refuses a retired occurrence before presentation or settlement.

Portable Settings expose the existing declaration-bound `snapshot`, `get`,
`describe` and `watch` operations. Snapshots contain persisted non-secret values;
`get` also applies the declared default. Daemon Settings and direct Settings
mutation methods are unavailable in this context. Mutations retain the existing
Settings Actions, and observation retires with the invoking Account/generation.

In the finite CLI Account Action host, declared Account Settings bind to the
existing Account plugin-settings record adapter with the invocation's captured
credentials and Home URL. The production
Settings host factory admits those declarations only with that scoped producer;
it does not substitute the daemon's active Account when the producer is absent.
The same composition handles operation-specific declarations. Credentials are
captured once at admission; subsequent local checks observe cancellation and the
scoped material lifetime without rereading the credential file. The receiving
server authenticates each call. This restores the declared read-only
binding for bundled and external plugins without changing its storage format.

The CLI Account plugin-settings adapter retains a typed failure when storage is
unavailable. The Settings owner forwards that error's code; Run error projection
keeps the code and the adapter's content-free phase and HTTP status in its message.
Response bodies, request configuration and setting values are excluded. This is
0.3 development behavior; it does not establish a loaded-runtime replay result.

Portable artifacts use the SDK's existing universal CommonJS compiler (including
its Node-builtin rejection), the UI's existing client executable module host,
and the CLI's existing plugin module loader. Hermes compiles the app evaluator's
`new Function` with one function-scoped binding per `let`/`const`, so the compiler
lowers block-scoped closures in the emitted artifact: otherwise a loop's closures
share their last value, including esbuild's namespace getters over host modules.
The same pass lowers classes: Hermes's dynamic evaluator rejects small class
bodies and can fail constructing a class in a large artifact with an undefined
prototype error. Plugin-authored class semantics remain portable through the
compiler rather than requiring individual plugin rewrites. The compiler also
lowers async functions to generators: the same dynamic evaluator can turn async
arrows in a large artifact into undefined callbacks. A package exports its portable
entry under `./happier-plugin-ui/<artifactId>`; it must not import host internals.
See the [SDK author reference](../packages/plugin-sdk/README.md#portable-account-actions-03-development)
and [separately authored fixture](../packages/plugin-sdk/fixtures/account-actions/src/index.ts).

In unreleased 0.3 development source, that compiler and the app evaluator share
Protocol's [exact host-runtime external list](../packages/protocol/src/plugins/ui/hostRuntimeExternals.ts).
The app's [same-realm module map](../apps/ui/sources/components/plugins/reactNative/hostModules.ts)
provides the consumed portable public SDK entrypoints and Zod import forms in
addition to the framework and Plugin UI modules. SDK namespaces resolve lazily
through Metro's existing module owner, including its browser/native source
conditions; this does not eagerly import the Protocol root at app startup.
Plugin-authored schemas reach Protocol through the existing SDK domain facades,
so each artifact keeps its own plugin code while sharing host schema identities.
The map remains exact, with no prefix fallback or second registry. Unlisted
dependencies and hosted-web artifacts retain their existing bundling behavior.

The CLI supplies the portable SDK/Zod subset through its existing plugin module
loader's demand-loaded CommonJS adapter. Its static host bindings remain visible
to native payload bundling, so an acquired artifact does not need adjacent SDK
packages. Other dependencies keep the native artifact-relative resolver and
the incumbent module/generation cache; ordinary CLI startup does not initialize
this portable executable graph.

In 0.3 development source, the UI's existing executable host shares pending
activation work and reuses a current activation for its exact authority,
contribution, export and Artifact identity. After real activation retirement,
a later activation evaluates a fresh CommonJS namespace, even for unchanged
bytes and the same Account. Different concurrent authorities or activation
targets also receive separate namespaces: a plugin may capture its activation
API in module-level state. There is no process-global executable namespace
cache. Installed and bundled Artifacts share this loader. The separate surface
module registry retains only modules owned by active scoped projections and
rejects late writes after retirement. Byte admission, activation/currentness
checks, registrations and cleanup retain their existing owners; module reuse
grants no authority.

In 0.3 development source, mounted renderers supplied by the app inventory
use the app's current Plugin UI inventory, including direct Session and embedded
mounts. Account Availability's app/Account-release package census decides which
plugins use that selection; Machine-only external plugins retain their exact
Machine renderer even when AppShell's merged inventory contains another version
or omits its renderer. Machine execution custody does not select a separate bundled renderer
generation. Physical mounts and cache lifecycle reconciliation consume
the current Account projection before admitting its graph and digest, including
retained selections without a source-custody stamp. AppShell's installed merge
owns explicit development overrides; an automatically selected Machine's
execution origin does not override the current app renderer. Before AppShell
publishes, Availability supplies the current app declarations. The existing
app-exact and persistent byte sources remain digest-addressed. Explicit
development selections and installed Account releases retain their selected
artifacts through that same projection. Loading a new app inventory requires an app
reload; updating these bundled renderer bytes does not require a daemon restart.

In this unreleased UI path, Account Availability projects current page caller
custody and standalone targeted renderer facts. The app projection merge admits
Account and client Actions without a Machine. Client execution retains its
client API and UI context while the selected Account declaration supplies its
artifact, schema, and exact custody; execution realm does not select custody.
Action scopes name supported invocation contexts. An Action declaring `global`
alongside `session` can run without a Session; a Session-only Action still requires one.
Mounted Account targets reuse SDK declaration
admission and the shared Protocol semantic projection; each contributor child
receives its own custody and contribution snapshot rather than the parent's.
Account execution retains an explicitly selected Machine for nested daemon
Actions. Without an explicit Machine, an Account or nested Action's declared single
Session operand supplies its Machine through the host's existing Session read owner;
an unrelated ambient Session Machine is not used when that target has none.
The UI resolves the Account Action's Session placement when Machine sources are
first used, before their operation handles are admitted, and loads that Machine's
nested Action declaration through its existing projection cache. Account execution
itself remains on the client; Account-only work does not require a Machine.
The declaration merger keeps a declaration's physical `sourceCustody` separate
from the selected Machine's `targetSourceCustody` for target-operation selection.
The bound UI dispatcher validates a selected-input carrier against that admitted
target-operation custody; it stamps the mounted caller's independent custody
on the invocation. Account caller custody is never substituted for the Machine
target or vice versa.
The Machine source-declaration response includes the requested target's current
custody and native daemon Action declarations even when it contributes no operations
to itself. An Account Action can therefore delegate to its own native helper without
declaring that helper as a targeted operation. This projects declarations; the selected
Machine's existing executable admission and handler registry still own execution.
The shared closed V1
validator admits that target row; other source rows must contribute to the
requested target, and duplicate plugin identities remain invalid. This lets
Machine-placed operations retain their current daemon occurrence when mounted
on an Account page. The mounted parent also receives its Machine Resource census
when contributors supply operations without an embedded child Surface.
Self-contributed Account Actions and renderers retain their Account provenance;
the target selection and admitted-operation currentness checks still fence the
selected Machine. This is host-owned, in-process declaration state, not an
additional manifest or wire field. Delivery of those Machine selection facts
does not retire an unchanged Account renderer or its entered read; replacing the
captured Account origin still does. Native children continue through the exact
target/contributor rematch, without a fallback bypass.
The current-context Action front door uses that same committed Account
registration and its captured Home/Account/custody, without requiring a Machine
origin. Its on-demand schemas come from the admitted Account declaration;
Machine-placed Actions retain their existing exact-occurrence schema transport.
Cancellation, Account retirement and replaced registration still refuse entry.
Ordinary host read dependencies use that same current-context registration and
the shared read-observation dispatcher, with input-sensitive read-only admission.
They do not execute the Action handler or fabricate a Resource caller. The
Session trigger hook observes the public Channels Watch Action rather than its
private collection name; cancellation and Account retirement release the observer.

In 0.3 development source, the native Host API adapter consumes immutable surface snapshots from the host
context factory. Equal content retains the existing surface and nested-object
identities; changed content publishes through that adapter's existing watchers.
There is no schema-admission sidecar or serialized semantic key on a native
snapshot. Hosted transport context results and events still validate at their
actual wire ingress. Negotiation carries the version, methods and nonce-bound
mount identity, not an unused initial surface. Context reads and watches use the
current host snapshot through their ordinary methods.

An explicitly selected Machine, when supplied, provides transport for
Machine-placed source roles. It grants an Account child neither Machine
execution authority nor readable or dynamic Machine Resources. Missing Machine
transport produces a typed requirement for the affected source while Account
rows remain available. These source mechanics do not establish loaded-runtime
or release readiness.

In 0.3 development source, Triage's aggregate data Actions and credentialless
personal source use Account placement while the existing `tasks.internal.*`
Actions remain the task data/CAS owner. The aggregate merges sources through its
existing targeted-source owner. Its pull request status read retains daemon
placement.
Provider-backed source Actions remain Machine-placed: without their required
Machine, they report `plugin_action_machine_required` per source without hiding
personal rows. Account placement grants neither provider credentials nor Machine
execution. This is an unreleased source contract, not evidence that a currently
loaded UI or CLI has been updated.

In 0.3 development source, a client Action declared for `message.menu` receives
the same optional `context.messageAction` bounded snapshot as a daemon Action.
The existing contributed-Action controller stamps the selected row's opaque
reference. CLI, Agent and MCP callers can supply that same committed
`messageActionReference` beside `action` and `input` to `action.invoke`; the
generic daemon-to-client delivery preserves it outside plugin-authored input.
After client input, policy and confirmation admission, dispatch sends
that reference through the existing structured Action RPC with
`resolveClientMessageContext: true`. This preparation mode checks the current
client Action occurrence and message placement, then reuses the daemon's exact
access/revision/content resolver. It returns the snapshot without running a
daemon handler. The client validates its identity and revision and rechecks
invocation currentness before calling the registered handler. Automated callers
retain their actual execution surface and a daemon-validated client Action
binding; an opaque reference grants no present-user intent.

This is one Message carrier, not Action input or a plugin transcript reader.
It works for installed external plugins through `PluginClientActionContext` in
the public SDK. Other placements and nested Action calls receive no implicit
Message context; a palette/composer declaration alongside `message.menu` does not cause
those placements to inherit a row. Existing persisted-reference and daemon
legacy placement semantics remain unchanged. Missing, stale, inaccessible or
invalid snapshots refuse the message invocation. Older daemons reject the new
preparation field through the existing strict request parser, so no client
handler runs with an unverified snapshot. Account-origin client Actions retain
Account placement: the dispatch owner resolves the same durable reference with
captured Home/Account authority, opens only the exact current row through the
Session encryption owner, and consumes the shared Session-core snapshot resolver.
They require no Machine transport; Machine-origin Actions retain their Machine
admission and RPC path. A selected Message never changes the Action's placement. Triage's existing Tasks launcher uses
`visibleText` only as an omitted body seed; explicit drafts remain authoritative
and opening the draft performs no task write. Loaded-runtime verification and
registry publication remain separate from this development-source contract.

[`definePlugin`](../packages/plugin-sdk/src/definePlugin.ts) is the code-defined author path. It projects a portable manifest and compiles registration callbacks into the named `activate(api)` ABI declared in [`activation.ts`](../packages/plugin-sdk/src/activation.ts). Raw host-generated `contributes` is not an additional `definePlugin` author input. In 0.3 development, `projectDefinedTargetedContributionPoints` from `@happier-dev/plugin-sdk/contributions` derives routing refs from the same plugin id and contribution-point declarations passed to `definePlugin`. Keep those declarations in a lightweight module so readers need not import the plugin activation or handlers.

The canonical manifest schema and normalizer remain Protocol/platform-owned. [`manifest/v2.ts`](../packages/protocol/src/plugins/manifest/v2.ts) admits runtime API version 1 and an **optional** non-wildcard `engines.happier` range. Host/runtime ABI admission and package SemVer are separate contracts; do not infer a host compatibility range from a package version or source build identity. See [protocol evolution](compatibility.md#sdk-protocol-evolution).

In 0.3 development source, an `appPage` View may declare `description` as a literal
or `{ key, fallback }`. Protocol admits it only on that container, and the SDK
surface helper retains it in the manifest. The shared declaration projection
carries it in `display.description`; the app-page catalog localizes it before
passing it to the existing identity header during surface loading. Omission stays
valid. It is presentation data, not execution or routing authority. Published
declarations targeting an older strict parser use the existing SDK/toolchain
engine-compatibility admission; no undeployed 0.3 shape gets a stripping adapter.
The loaded plugin page should use the same purpose in its own header.

An `appPage` View may also declare `headerStyle: 'toolbar'` when its loaded page draws a Collection toolbar that
leads with the page's name instead of a page header (the default, `'page'`). The projection carries it in
`display.headerStyle`; while the surface loads, the plugin page identity is that toolbar row (the name, with the
route's Run on control trailing it) so the title keeps its size and place when the surface arrives, and the loading
frame is the Collection's own (`CollectionLoadingRows` in `@happier-dev/plugin-ui`: ruled column band, table rows,
footer band) filling the whole content area rather than the page column. On a phone, the host
leaves such an app page's name to the page, as the Inbox tab does: the navigation row carries Back
and the page's controls without a title, the identity while the surface loads is the name at the
display (hero) title step, and the internal page chrome's `largeTitle` fact tells the loaded
`Collection` that carries `title`, and a public `PageHeader` without a leading mark, to lead with that same
large title. The large title is part of the Collection's header, so it stays above virtualized rows and
scrolls only with a page-scrolling Collection. Plugins declare nothing new for it and cannot choose a title
size: `HappierPageHeader` draws the page title everywhere else (DESIGN.md "One title rule"); `headerStyle:
'toolbar'` is the signal. Other phone app pages keep their title in the navigation row.

### Page views a lens apart (0.3 development source)

The page location owner writes ordinary host history: opening a detail from the current `backLocation`
pushes one entry, and further selection changes within that detail replace it. Filters and ordering
without a detail declaration replace the current entry. Back and Forward traverse that same history.
Plugin pages register no internal-Back replacement callback with the workspace.
The request shape and wire version are unchanged.

One page may present several of its plugin's declared `appPage` views a lens apart (Triage's Tasks and
PRs & Issues). `replacePageLocation(subPath, { view })` names the declared page local id the new location
presents. The page's location owner (`pluginPageLocation.ts`) holds it with the settled location, and
`PluginPageContent` titles the route chrome (phone header, workspace tab) with that view's declared title.
Absent `view`, and any location the owner did not settle (deep link, reload, history walk), name the
mounted page. The request stays closed; matching development host and SDK source is required.

### Unsaved plugin page edits (0.3 development source)

Mounted `appPage` surfaces may negotiate `setUnsavedChanges(isDirty)` through
the same native/hosted Host API. Its closed request carries one boolean; the
page/Account/target mount owns that ephemeral dirty fact, not the plugin text or
a durable draft. Equal declarations publish nothing. `PluginPageContent` binds
the fact to `useUnsavedDraftNavigationGuard`; `runUnsavedChangesGuard` remains
the sole discard/keep decision and serialization owner. The active/tab and
native-removal hooks are registration/transport layers. `RouteRemovalStepConsumer`
spends an embedded guest's document history and makes no independent dirty decision.
Plugin page URL history uses ordinary workspace Back and Forward.

Back (including native hosted guest history) and page close use the existing host
confirmation. Catalog activation and `openSurface` settle that same decision before
staging a replacement launch input or navigating. The page-location owner
also asks that guard before replacing a different subpath, so an editor retires
its selected target only after consuming the settled location. Keep editing
returns the incumbent location; a same-location Back declaration does not retire
the editor. Native/RNW pages can declare `preserveUnsavedChanges: true` on a
same-editor layout replacement and its Back step. The page-location owner lends
that fact to the same guard, which keeps the dirty boolean armed and admits only
the accepted synchronous navigation stack. Hosted document replacement refuses
that option because it replaces the document. Browser unload retains the platform
confirmation. Account/credential
retirement still erases private state without asking, and stale facades cannot
publish into a replacement mount. No plugin callback participates in navigation
admission. Non-page mounts do not advertise the method. This is an unreleased
Host API V1 operation, not a new persistence format or released SDK guarantee.

### Plugin Project pages (0.3 development source)

`appPage` also admits `target: { kind: 'project' }` through the same surface
registry, portable declaration projection and page catalog as app pages. The SDK
surface shorthand accepts that explicit target; omitting the target still means
an app page. Project pages share description, header style and header Actions;
app columns, app-rail placement and personal `widgetAreas` remain app-target-only.
Installed external plugins use the same declaration and renderer chain.

The accepted Project context is `{kind:'project',projectKey,source?,checkout?,repository?,branch?}`.
`source` is the qualified accepted Source, `checkout` is the accepted Workspace
reference and `repository` is the canonical credential-free hosting identity.
The existing Project/widget context producer supplies these facts and
`project.repository.kind` policy evaluation. An absent kind stays unknown,
including under negation; a present literal `unknown` is an ordinary kind value.
Reading context neither probes SCM nor selects a Run-on Machine. A page can
render with no Source, an offline checkout and no execution Machine selected.

In unreleased 0.3 source, a mounted Project surface that needs Machine-backed
capabilities supplies its accepted checkout as the initial contextual Runs-on
target. Route controls and the physical host use the same mounted-surface
adapter and shared projection acquisition, even before that Machine contributes
an installation candidate. Acquisition pending is carried to mounted read
admission; a settled absence or failure withdraws that wait. Administration
still selects and freshly admits the actual source, occurrence and execution
authority. As with a Session-contextual panel, an explicit choice belongs to
that mounted target and Account lifetime rather than changing the device's
plugin preference. Machine-free Project presentation does not acquire a daemon.

Contextual dynamic Resources receive that same strict target as
`options.context.target`, including when only unopened navigation chrome needs
the Resource. Project targets expose the admitted repository and observed named
branch; Session targets expose `repository?`, `branch?` and `headOid?` from the
existing exact-Home SCM observation. Session Resource targets must match the
context's `sessionId`. Unknown facts are omitted and a detached checkout does
not fabricate a branch. These are context facts, not execution or credential
authority. Branch/HEAD changes replace Resource demand without replacing the
surface's physical page/frame lifetime. Global Resource context is unchanged.

In unreleased 0.3 source, daemon dynamic Resources may provide a
`createProducer` factory returning flat `read`, `observe` and `dispose` callbacks.
The existing admitted Resource context owns that producer's signal and
read-only Action ports; settling one read does not retire an overlapping
observer. Context retirement aborts and disposes the producer, including an
asynchronous factory result that arrives after retirement. Other placements
reject the factory explicitly rather than silently ignoring its lifecycle.
The ordinary direct callbacks remain required and must fail explicitly when
they cannot honor that lifecycle. Domain reads and dependency observation still
use the canonical Action/Resource owners, not a consumer-owned transport or timer.

The host owns `/projects/<workspaceRefId>/plugins/<pluginId>/<localId>` and its
encoded local subpaths, preserving qualified Home and checkout route context.
Private launch input stays in the existing ephemeral, target-qualified handoff.
Only the selected presented page mounts executable content. Primary pages share
the device-local `projectTabBar` placement on desktop and phone; companion rails
and panes retain their separate selection and lifetime.

Sidebar destinations and Project pages can declare one labelled count binding:
`counts:{resourceId,items:[{field,label}]}`. It references one declared dynamic
JSON Resource; labels are declaration-owned localized strings, not Resource
output. The atomic value has exactly the declared fields, each a nonnegative
integer or `null` (unknown). Malformed, missing or extra fields make the entire
record unknown. Running and failed counts stay separate; no sum or priority
scalar is inferred. The existing count owner shares read/watch demand for a
matching destination/body context, while explicit Hidden withdraws badge demand.
Explicit instance/input handoffs retain their distinct contextual identity. Legacy sidebar
`countResourceId` with strict `{count}` remains supported and cannot be combined
with `counts` on the same declaration.

Public `Collection`/`DetailsPane` uses the existing Project details column (push
on phones). `DetailsPaneOpenAsPageButton` is the shared Open as page control;
authors put it in `DetailsPane.actions` and bind it to the existing
`host.replacePageLocation(subPath, {backLocation})`. Pane/page/return locations
belong to the plugin's validated local grammar. The host supplies the Project
prefix; authors never concatenate a route or change pane-column preferences.
See the [author recipe](../apps/docs/content/docs/plugins/ui/configuration-pages.mdx#project-pages).
These are Developer Preview source contracts; publication and loaded-platform
validation are separate evidence.

### Plugin Machine pages (0.3 development source)

The same Surface Registry admits `appPage` with `target: {kind:'machine'}`.
The public mounted target is closed, with required `{kind:'machine',serverId,machineId}`
and optional host-known `homeId`/`installationId`: both routing identifiers identify the addressed Machine, not
the plugin's separately selected execution origin. A Services-panel target
remains `services`; it cannot stand in for a Machine page. The existing portable
declaration projection and shared page catalog carry this destination without
a second registry or mount engine.

An admitted current Machine mount with verified Home and installation facts
can advertise `openManagedMachineConfiguration({provisioner:{pluginId,localId}})`.
The host derives the controller from that target, revalidates the Account,
installation and exact provisioner through the existing provisioner list Action,
then uses the picker's single route builder to open its existing configuration
draft/review. It performs no acquisition or native effect. The public request
cannot supply a controller, Home or route; ordinary final acquisition admission
still belongs to the existing configurator and Action owners.

`useMachinePagePluginCatalog` lends the addressed Machine shell the Account
declarations through the existing localization, policy and page-catalog owners.
It does not activate a renderer or discover native services. Missing, retired
or wrong-Home Account authority yields no admitted pages. Page target keys and
the existing ephemeral launch handoff distinguish both Home and Machine.

The host route builder encodes Machine plugin selection and local subpath in
the existing Machine page query; authors do not own routes. The Machine shell's
consumed tab composition and Docker Sandboxes renderer are still in progress,
so target admission alone is not a claim that this page is available in a
published release or that loaded first-party/installed-plugin QA has passed.

In 0.3 development source, `registrySources` is a descriptor-only manifest
family. `definePlugin.registrySources` projects plugin-local declarations;
the admitted lazy catalog supplies them without activation or a new runtime
registry. The registry source owner merges these with built-ins and the
Account `registry-sources` row, retaining supplier identity and read-only
plugin ownership. Declarations contain credential-free HTTPS locations and
format/item-kind facts, never tokens or npm profiles. Source enablement does
not grant execution or credential authority.

In 0.3 development source, `skills` is a descriptor-only declaration family
through that same lazy catalog. Authors use
`definePlugin({ skills: { '<localId>': { directory: './resources/skills/<name>' } } })`;
the portable `PluginSkillContributionV1` contains only `id` and `directory`.
The directory is confined to the package and contains `SKILL.md`; the canonical
`readSkillFrontmatterV1` owns name, description and invocation flags rather than
duplicating them in manifest metadata. There is no skill activation callback,
second registry or independent loader.

The canonical skill list/read owners project these declarations into the
library with provenance `{ kind: 'plugin', pluginId, occurrenceId }`, using
[`readReadOnlySkillContentV1`](../packages/protocol/src/prompts/library/promptBundleSchemas.ts)
for both built-in and plugin skills. Reach and Session delivery remain with the
existing skill owners; durable installation seeds default reach once, without
overwriting later rules. Disable or uninstall retires the projection while
retaining inert rules. Content updates follow the plugin version, not a skill
registry update. The existing `skills.duplicate` Action makes a person-owned,
editable copy through the canonical
[`skillActionOperations`](../packages/protocol/src/prompts/library/skills/skillActionOperations.ts)
owner; rules and Session selection use their ordinary Actions. The Skills UI
owner supplies the byline and read-only controls; this source contract does not
establish their rendered or loaded-runtime verification.
Agent-native plugin skill folders remain a separate Found input. Public
authoring guidance lives in [Contributions](../apps/docs/content/docs/plugins/manifest/contributions.mdx#library-skills-in-development);
generated SDK API and capability reports remain the availability authority.

First-party skills in 0.3 development use the protocol's
`resolveSkillReachV1` owner for Session selection and UI reach. With no matching
rule, they are on by default; an explicit Off rule is preserved. An optional
`requiresFeature` on `FirstPartySkillV1` admits a skill only when the canonical
effective feature decision is enabled, including for Session includes.
`happier:deploy` requires `deployments`, and `happier:workflows` requires
`workflows`; `happier:happier` has no feature requirement. Reading these defaults
or re-enabling a feature writes no reach rules, so later built-ins also work for
existing Accounts. Existing seeded rules remain valid. This field does not
extend the plugin skill descriptor ABI or change plugin-install seeding.

In 0.3 development source, each MCP discovery source declares
`loadedInHappierSessions`. Detection carries that fact into its server rows, and
session previews omit sources that declare `false`. Discovery can therefore find
native configuration for adoption without claiming that a Happier Session loads
it. The declaration schema owns the fact; the host does not infer it from an Agent
id.

Native MCP discovery in 0.3 development source returns `detectedServers` through
the registered discovery contribution. Agent leaves read their native config
files; the host keeps the declared Agent and `loadedInHappierSessions` authority
and normalizes the rows for Found/adoption. Stdio commands/arguments, remote URLs,
enabled state, source paths and env/header names survive; env/header values and
unknown config fields do not. Credential-bearing remote URLs are refused through
the canonical MCP URL schema. The existing remote `endpoints` projection remains
available to discovery sources that publish remote endpoints rather than native
configuration rows.

Plugin-declared MCP servers in 0.3 development source project from the lazy
contribution catalog, not a runner-owned manifest loader. Their metadata carries
`source: { kind: 'plugin', pluginId, pluginName }` for the MCP page's
"From <plugin>" presentation. These are declaration-owned servers: Account
rules and tool settings may change, but catalog configuration/removal Actions
do not take ownership of the declaration. Durable plugin installation seeds a
missing Everywhere-On rule through the existing MCP catalog CAS owner and
`resolveCreateReachV1`; publication never overwrites an existing Off rule.
Startup and development reload do not invent defaults. Removed declarations
leave stored rules inert. Visible page integration and live validation remain
separate capabilities-program work.

In 0.3 development source, an Agent's optional `mcpToolControl`,
`mcpToolLoading` and `mcpToolCallIdMetaKey` facts project from its own definition through the same tools
capability owner. Absence is not inferred support. The host supplies the
Protocol-resolved, data-only `mcpToolPolicy` beside `mcpServers` on Session and
Run opens; the shared Run-to-Session adapter preserves both. Native Session
policy changes use `AgentSessionConfigurationUpdate`, not a plugin-owned policy
reader or a second permission engine. A declaration still requires proof through
the actual Agent's launch and permission path.

`mcpToolCallIdMetaKey` declares which opaque MCP request `_meta` field contains
the native transcript call id. The generic host reads only that declared field
and passes the optional string to its existing approval-origin writer. Agent
code owns vendor interpretation; no host vendor table or Agent-id branch is
involved. A missing key/value retains exact contextual-operand fallback, not
JSON-RPC-as-native identity. This optional development V2 declaration changes
no authority, execution outcome, stored format or wire epoch; the tools object
and its children remain closed at admission.

In 0.3 development source, OpenCode's session-scoped MCP namespace retains its
isolation prefix and uses a compact digest. The remaining 64-character model
tool-name budget is supplied to the host-owned Happier stdio transport. Its
optional naming projection reads the actual admitted inventory on discovery
and dispatch, including plugin-tool changes; the canonical HTTP inventory keeps
original names. The native Agent MCP service's `resolveToolNaming` supplies that
same current projection for original transcript and approval identities. It
does not change `enabledTools` visibility or create another tool registry.
Unresolved or removed aliases retain their raw evidence instead of acquiring a
new canonical identity. The OpenCode V2 unsupported-registration path remains
unchanged. These are development-source contracts, not release availability.

Persistent MCP tool grants use the Account catalog Actions. The unpublished
permission decision's unused `persistAllowRule` field and scope aliases have
been removed in place; native Session permission updates retain their existing
carrier. The host's permission decision does not introduce another Account or
workspace rule writer.

The development MCP tool-policy testing contract extends the existing launch
observer. It checks secret-free effective Agent and tool-shell environments,
native knob artifacts, fixture-server receipts, approval ordering, same-mode
revocation and server/tool identity. A missing declaration remains unsupported;
an explicitly tested candidate is characterization, not admission. Native Allow
requires live revocation through the existing configuration-update carrier;
host approval requires a real leaf call reaching the host before the server.
The public testing barrel is published by the SDK's canonical API producer,
and source declarations do not substitute for successful publication or vendor
validation.

For development-source MCP tool control, Claude, Codex and Gemini keep human
display titles separate from permission identity. Gemini's plugin decodes its function-name correlation id
and translates it to the host's canonical MCP name. Codex's plugin selects
the native `requestUserInput` approval mode, whose item id joins the existing
tool lifecycle projection. Codex 0.162.1's default tool-approval elicitation
omits that identity and supplies a human title, so it cannot replace this
correlated path. Actual server elicitation retains its existing handler.
Injected Codex servers share the existing app-server startup budget for
discovery before the first turn; they remain optional.

In 0.3 development source, Happier-tool auto-approval consumes the generated
`tools/autoApprovedNames.generated.ts` leaf through `tools/happierToolAutoApprovalV1.ts`.
The [Action catalog producer](actions.md) derives and drift-checks that leaf from
safe Action specs, the four Action meta tools and the existing title bridge;
permission imports do not evaluate the full Action catalog. Native projections request
their actual server prefix: Claude uses `mcp__happier__`, OpenCode/Kilo use
`<server>_`, and Codex's per-server config uses bare tool names. Host permission
recognition retains transport/title aliases separately. Native launch rules do
not enumerate those aliases. OpenCode's policy remains in `OPENCODE_PERMISSION`
and Kilo's in `KILO_PERMISSION`, preserving native environment precedence.

The host derives registration rights from the admitted manifest. [`registrationRightsHost.ts`](../apps/cli/src/plugins/runtime/api/registrationRightsHost.ts) wraps the SDK registration scope with occurrence currentness and diagnostics; a retired occurrence cannot register. The reload lifecycle owns the serving occurrence in [`runtimeSlots.ts`](../apps/cli/src/plugins/runtime/runtimeSlots.ts). A consumer does not reconstruct currentness from an id, callback or manifest snapshot.

In 0.3 development source, activation composition reuses a retained component
when its occurrence matches the admitted occurrence, including repeated explicit
activation or validation scopes. Reusing that component preserves its handlers,
activation facts and existing lease-owned cleanup; it does not call the module's
`activate` export again. A different occurrence still activates independently.

In 0.3 development source, a plugin can declare one `workItems` client contribution,
with local id `work-items`, and register its live reader through `api.workItems.register`.
The [public work-item contract](../packages/protocol/src/plugins/contributions/workItems.ts)
supplies titles, tracker categories, optional parents and qualified Session links;
the plugin remains their owner. `resolve` reads demanded stable item ids,
`findLinked` returns `{ itemIds, complete }` for a Board's filtered Sessions:
known accessible items remain usable when another source cannot be read, while
`complete: false` explicitly preserves incomplete membership and prevents pruning.
An empty partial result does not prove there are no linked items. Optional
`watch` invalidates those reads. The host validates returned facts and retires
subscriptions with the existing executable registration. There is no task mirror.
The Account-stage UI projector carries `workItems`, `dragSources` and `dropTargets`
from that same selected manifest, including their existing client executable
graphs and Account custody. The build-owned first-paint manifest retains client
registration families from the contribution catalog, and the AppShell merge
preserves those Account declarations. They do not wait for a Machine projection;
the client executable owner activates them through the existing registration path.
Read and watch callbacks receive the incumbent `PluginAccountActionContext`,
including Account storage, settings, Actions and targeted contributions. The UI
host assembles that context through its existing Action constructor; the client
registration preserves it while composing callback cancellation. Board reads and
native transitions bind the existing Action front door to that Account lifetime,
so Session operand preparation and host Actions use the admitted Home and Account.
`watch` takes
the context as its third argument and its signal ends with the subscription.
Boards qualify item identity by Home and plugin, preserve unavailable explicit
picks, and collapse a linked sourced Session only while its task is readable;
an explicitly picked Session remains. Linked Session status uses the shared work
status owner. A declared `transitionAction` names an ordinary same-plugin Action,
not a direct write callback; a contribution without it is read-only. Category/parent
grouping and transition-drag presentation remain integration work, not released UI.
The SDK's public `PluginWorkItemTransitionInputV1Schema` is the composable
projection of Protocol's incumbent transition parser. Use it as the named
Action's `inputSchema`; its closed operands are `serverId`, `itemId` and
`transitionId`. The public root and browser facade expose the same value.

In 0.3 development source, a committed candidate whose publication reconciliation
fails re-enters the existing idempotent Connected Account purpose reconciliation
before the reload controller disposes it. Successful publication serves that
committed occurrence; a committed successor or shutdown prevents older recovery,
and a persistent failure remains explicit. Source-only development candidates
retain their incumbent on failure and do not use this committed recovery.

Automatic Connected Account purpose pruning reobserves the current catalog after
an unknown write outcome. Startup and registry publication defer that prune when
the effect or boundary remains uncertain; the next publication reconciles current
declarations again. Purpose reads retain their authorization checks throughout.
Explicit user mutations still report `outcome_unknown` even if readback finds
their intended value, because readback is not a write acknowledgement.

In 0.3 development source, scoped executable registries retain global declarations,
but contribution demand and validation activate only plugins in the composition
owner's admitted occurrence set, including retained peers. The executable source
admission owner requires real source custody before publishing daemon Actions.
An uncustodied source becomes a plugin-attributed unavailable activation, while
healthy plugins remain usable. Action refresh still checks the host occurrence
and source custody; plugins cannot supply those facts through their manifests.

In 0.3 development source, on-demand Agent catalog acquisition projects the
selected Agent through the runtime registry's existing activation/currentness
owner. It shares the Agent projection used during whole-registry assembly, but
does not rebuild other contribution families or re-admit their portable schemas
for each lookup. No separate catalog or cross-occurrence cache is introduced.

Standalone Agent-command dispatch also selects the exact Agent identity through
the merged registry. Bundled locator admission and installed source discovery
read the selected plugin, then the shared semantic projector reads its Agent
declaration. Manifest, publication, graph and source checks remain authoritative;
a cross-plugin reference demands the ordinary complete reference universe.
Full command discovery still requests the whole registry. These are development
source paths, not a loaded-stack latency claim.

The descriptor catalog owns schemas and reference metadata. Full semantic
projection loads the Workflow normalizer before publishing its definitions;
exact Agent and Provider reads use the same projector's family gate without
loading Workflow or Action-input semantics. The full built-in snapshot remains
one synchronous, lazy authority in its own module, loaded on full demand. This
separation also preserves the CLI's CommonJS sidecar build contract.
The admitted Agent CLI command passes its currentness-checked options composer
directly to the runner command owner; an explicit absence does not trigger a
second global catalog lookup. Daemon-authoritative foreground options keep their
existing service boundary.
Shared daemon metadata scalars and connected-account compatibility decisions use
their Protocol leaf owners; reading them does not load published Machine content
or a connected-account API transport.

In 0.3 development source, roster Actions read `selection: 'agents'` through
the existing contribution-projection describe RPC. The same leased registry
and Agent projector supply `agentsById`, while UI feature fetches, assets,
translation bundles and unrelated contribution families are skipped. Omitting
the selection retains the full display catalog; its UI readers request their
display locale. The response envelope and Agent metadata remain unchanged.

In 0.3 development source, admitted targeted Actions use the existing contributor-materialization and target-occurrence checks in [`executeContributedAction.ts`](../apps/cli/src/plugins/runtime/invocation/actions/executeContributedAction.ts) before demanding activation, after activation settles (including failure), and after awaited bindings before starting the handler. A stale admitted occurrence returns its retirement result without demanding activation; retirement during activation takes precedence over activation-failed or handler-missing errors, and no handler starts.

For retained targeted-operation input, the same admission projection retains
the Action's declared `connectedAccountPurposeBindings` field path even when
it has no UI form hints. Reconstruction accepts only that one selected Account
identity; ambiguous paths and a different Account are refused before the
handler. Configuration replacement keeps the qualified Account identity and
the credential owner materializes its current configuration for each operation.

In 0.3 development source, a targeted role's declared danger level is a ceiling:
`safe < writesLocal < writesRemote < externalSideEffect < destructive`.
Canonical targeted admission applies it to ordinary and mixed-source roles;
the bound Action retains its own danger level and approval default. A role
expecting a remote write can therefore use a safe Account-data implementation
without converting that Action into an outward write or an Ask default.

In 0.3 development source, one purpose binding can declare `alternativePaths`
when different input arms carry the same Account selection at different paths.
The declaration validator preserves nested union correlation and requires
exactly one qualified Account or native-service operand in each arm. The shared
Account and daemon extractor refuses missing or multiple selections; the
existing purpose port still authorizes the selected service before acquisition.

For an optional Account operand without `nativeServicePath` or `alternativePaths`, omission or null
keeps the incumbent Session/global purpose selection. The operation binder
creates exact custody only when a ref is supplied; an empty operation subject
must not hide the incumbent binding. A declaration with `nativeServicePath`
still requires exactly one explicit Account or native-service selection.

Contribution-family membership and normalization are Protocol-owned. In development source, the CLI's [`projection/families.ts`](../apps/cli/src/plugins/projection/families.ts) asserts its descriptors against that catalog, adds current occurrence facts and validates each projected entry with the existing Protocol schema. The daemon omits an invalid entry and publishes a plugin-attributed diagnostic identifying its family and entry, while retaining healthy entries in the same projection. Agent catalog and UI registries consume that projection; a feature must not scan Actions, invent conventional ids or install a second registry to discover its contributors.

The development-only `machineProvisioners` family declares native launch and resource schemas and same-plugin Account or daemon Action roles through its [Protocol owner](../packages/protocol/src/plugins/contributions/machineProvisioners.ts). Discovery reads descriptors without importing provisioner leaves; selected or retained contribution demand activates only the needed leaf through the existing `activate(api)` Action ABI. Roles receive raw declared launch choices or resource values, and options receive the provider-declared query value. The host retains qualified resource references, controller and occurrence identity, current-row custody and captured credentials separately. Effectful roles require that private admission; ordinary contributed Action calls cannot supply it. Retained reads may use the same row custody, while initial checks and options can pin a private captured-account lease without inventing a managed row. Native enrollment accepts buffered argv/private-stdin execution through the same ordinary enrollment recipe; live output is optional. Buffered pairing uses the existing auth request, controller approval and auth wait producers, not another installer or enrollment authority. Only the selected guest process receives any invocation-private output observer and inherited task budget; captured preflight processes do not.

An explicit managed guest diagnostic read sends `allowWake: false` on the existing
native exec role. The provisioner must execute only on an already reachable running
guest or refuse; it must not wake, resume or activate one to service that request.
Omitting the operand retains ordinary installer exec semantics. Older closed role
schemas may reject the read, which returns typed unavailable without a waking retry.

In 0.3 development source, a provisioner may declare the optional `snapshot`
role with its native disk coverage and billed-cost evidence. The existing
database restore review offers that role for a managed destination containing
data. Its controller invokes the retained provisioner through the admitted child
transport; a missing role offers no snapshot. Hetzner and DigitalOcean snapshots
cover the root disk and exclude attached volumes. Running snapshots report
`running` consistency, without promising application consistency; an absent
numeric storage price remains unknown in review. The native Action is observed
to completion using the host's existing managed observation cadence and cancel
signal. Its confirmed native snapshot id is retained in restore evidence. Failed,
refused or unknown results hold restoration until the person explicitly reviews
continuing without a snapshot. There is no snapshot engine, deletion policy or
automatic resubmission.

In unreleased 0.3 source, provider observations and reviewed retention capabilities
share `ProviderDeletionNoticeV1`: a native `stopped-storage` rule with
`consequence: 'disk-deleted'`. Its `after-stop.afterMs` is nonnegative: `0` means
the disk is deleted as soon as the Machine stops; a positive value is the native
retention delay after Stop. An omitted `at` retains that rule without inventing a
Stop time or deletion deadline. The existing reminder resolver schedules only
an explicit native `at`; it does not start a timer from `afterMs`.

The private managed-operation binding retains any admitted credential-configuration
revision for its exact qualified Account. The purpose owner forwards that basis
to the existing materializer: explicit `null` means no configuration was admitted,
while an absent entry supplies no configuration-revision precondition. It does
not select another Account or introduce a configuration reader.

Portable discovery consumes the invoking host's existing Account selection,
including bundled declarations on an Account with no Machines or plugin intents.
Each `machines.provisioners.list` entry projects `acquireExecutionTarget`
(`account` or `daemon`) from its acquire Action's validated execution declaration;
callers consume that fact independently of browser eligibility.
An explicit controller selects installed native discovery. The same input
placement owner routes check, options and reviewed acquire to Account execution
when the controller is absent. Mixed native and portable operations declare
separate daemon and Account roles sharing one implementation.
An explicit Machine controller still executes an Account-declared provider role
through the canonical Account runtime and that runtime's exact credential-purpose
lease. The controller retains native bootstrap, Home admission and installation
custody; selecting a Machine does not turn a portable role into a daemon Action.
The contribution's optional `browserReachable` fact qualifies the complete
endpoint and bootstrap path. Browser acquisition requires `true` before admission
or allocation; native adapters keep their own prerequisite checks. Desktop's
`web` platform string does not make its native adapter a browser.
In development source, the shared provisioner host-availability owner selects
the chosen Machine controller when a browser cannot run the complete Account
recipe. The picker and configurator retain that placement for check, options and
acquire through the existing Machine transport; the Account role and credential
owner stay the same. Without a selected controller, the browser offers the app
handoff. Browser-reachable recipes continue to run on the invoking Account host.

Account-owned Delete and Cancel continue the same Home-admitted cleanup intent
through the invoking host's reviewed destroy roles. A failed or canceled
installation keeps Delete available while its native resource remains bound.
Each issued cleanup handle is reported before continuing; a leaf's confirmed
absence settles the retained record even when the resource was removed directly.
The shared native enrollment recipe downloads the published guest payload on
the guest; browser hosts do not require a local CLI payload directory.
All self-download hosts resolve release metadata through the shared GitHub owner
and read the checksum and signature through the existing guest command transport.
The invoking host verifies Minisign before passing the archive digest to the
guest installer, which verifies the downloaded archive's SHA-256 before extraction.
Account acquisition uses the app's canonical public release-ring selection, as
do the other machine setup flows; a Home URL does not select a release channel.
Development and preview bootstrap require a published guest build that supports
the current enrollment protocol. A released CLI that ignores descriptor stdin
still receives the selected Home's explicit server selector, but its legacy
pairing response is refused with `remote_cli_update_required`.
Browser release metadata requests are unauthenticated GitHub API requests.
An exhausted API quota remains the typed `github_rate_limited` bootstrap failure,
including GitHub's reset time when supplied; no automatic quota retry is added.
The shared `executeManagedMachineAcquire` port consumes
`readMachineProvisionerHostAvailability` once at that admission boundary.
Ineligible descriptors remain discoverable so the caller can explain that the
app is needed without making a vendor request. Portable Action handlers register
through the existing `definePlugin(...).activateAccount` callback only when their
declarations explicitly select the matching Account artifact/export; exporting
the callback does not turn daemon Actions into Account Actions.

When a controller executes an Account provisioner role, the containing operation
supplies its held native registry for connected-account credential materialization.
The requester Account still owns the credential reads and purpose bindings; the
same purpose owner serves both the Action and managed acquisition. This allows
native-only authentication materializers, such as Boat's, to serve the Account
role without another action or client. Account execution without a controller
continues to use its own registry.

#### Vendor-native credential delivery (0.3 development contract)

The existing provisioner contribution has an optional `nativeCredentialDelivery`
descriptor: a same-plugin daemon `apply` Action, `transports: ['https_headers']`,
`preservesEndpoint: true` and `perBindingMatching: true`. Omission declares no
support. The existing check result can separately report
`nativeCredentialDelivery: {status: 'supported' | 'unsupported' | 'unknown', code?}`;
an omitted check fact is unknown. A declaration alone never proves tenant
entitlement, exact-resource authority or an installed binding. This source seam
does not establish loaded or released native delivery.

The public SDK `/machine-provisioners` entrypoint exposes the typed complete
apply input/result. Authors declare the apply Action with
`defineMachineProvisionerSchemas({launch, resource}).nativeCredentialApplyInput`,
which validates `resource.value` against the declared resource schema while
retaining the full managed-resource envelope. The generic exported
`MachineProvisionerNativeCredentialApplyInputV1Schema` is a parser, not a
manifest Action authoring schema. Optional `attributionHeaders` uses closed
`{name, value}` array entries, not an arbitrary header map.
The host owns current binding selection, exact managed
placement, serialization and complete-policy composition; the provisioner leaf
owns vendor encoding and IO. Only an admitted apply invocation can call
`context.services.machineProvisioners.materializeNativeCredentialHeaders({bindingKey})`.
It returns rendered headers for that invocation's admitted binding, or
`{ok:false, code:'native_credential_binding_unavailable'}`. The binding key is a
lookup within private invocation custody, never permission to select a source.
Ordinary invocations and unknown bindings refuse. Rendered headers must not enter
Action operands/results, retained operations, presets, diagnostics or guest files.
The separate managed-purpose lease authenticates the cloud operation; it never
grants access to an inference key.

`machine-vercel` is the first adapter target. Its leaf must apply the full policy
to both running and saved sandbox configuration, preserve sibling bindings and
the existing egress posture, and retain partial or unknown IO as unconfirmed.
Current-state reconciliation and awaited cleanup stay with the host's existing
binding/lifecycle owners. Other provisioners remain unsupported until they
implement and qualify this seam. Enrollment role and guest OS do not imply
credential-delivery support. See [Provider delivery](providers.md#vendor-native-team-delivery-development-contract).
The explicit Action/composer source path does not yet wire automatic first
installation or owning-Session terminal cleanup; their authority integration is
pending, and loaded integration remains parked.

The optional descriptor `enrollmentRole` declares `server`, `personal` or
`sandbox`. An options base or dimension entry may supply the same optional role;
the selected configuration's role overrides the descriptor role. Options declare
the guest OS through optional
`guestPlatform` (`linux`, `darwin` or `windows`) on their base or
selected dimension entries; the existing selection projector carries that fact
with the selected configuration. The descriptor's `platforms` instead describes
where the controller can run the provisioner. A macOS controller can therefore
create a Linux guest; its own OS is never the guest-platform default.
The shared [Add draft owner](../apps/ui/sources/components/settings/machines/managed/managedConfiguratorModel.ts)
uses declared server plus Linux to draft the dedicated
`happier` user-service and editable Preauthorized administrator access. Personal
uses the existing user and sandbox uses the guest process. Missing role, or a
server role without guest-platform facts, retains the existing personal-user path.
Declared server guests on macOS/Windows retain that path with an explicit
unsupported dedicated-user explanation.
Explicit enrollment identities remain intact. These are initial review defaults,
not proof of observed guest capabilities or permission to skip bootstrap checks;
provisioners do not choose identity from their id, transport or image label.

In 0.3 development source, Machine role authors use the public SDK's canonical
schemas and native-schema helpers. Packaged Actions retain portable JSON Schema
snapshots. Admission accepts older result snapshots that omit optional properties,
including nested option facts, while retaining required fields, declared constraints,
closed objects and the canonical union arms. Descriptor-owned native Resource and
operation value schemas, like input schemas, remain exact. This lets
optional result facts evolve without invalidating every previously packaged leaf;
it does not make unknown runtime fields valid or permit incompatible contract changes.

The public `observeMachineProvisionerNativeRead` helper owns the mapping from a
typed native read (`present`, `absent`, or `unknown`) to the existing observation
availability. Native adapters qualify exact identity and all owned attachments
before reporting `absent`; authorization, transport, malformed replies and
ambiguous vendor errors remain `unknown`. Native power, storage, billing and
expiry facts stay with their adapters. This is a 0.3 development source helper,
with no new observation wire format.

In 0.3 development source, the bundled `machine-agent37` leaf offers Ubuntu VMs
and coding containers, plus dedicated Performance instances, through the existing
image, size and location dimensions. All explicitly disable automatic sleep;
Agent37 documents that this keeps instances running until an explicit lifecycle
action. Containers are US-only; VMs and Performance are offered in the US, Europe
and Mumbai. One per-type table owns these region constraints and launch admission.
Running prices vary
by kind, and retained disk remains billed while stopped. Stop/start is a cold
boot with disk retained. Native HTTP exec and chunked binary writes feed the
canonical portable-binary bootstrap; the supplied detached daemon process
configuration starts the daemon again after Start. VM GUI uses the existing
virtual-display Machine recipe. The generic contract has no typed per-option GUI
capability or kind dimension, so descriptions carry that distinction. See
[Agent37 auto-sleep](https://www.agent37.com/docs/agents-api/instance-auto-sleep),
[sizing](https://www.agent37.com/docs/agents-api/instance-sizing) and
[lifecycle](https://www.agent37.com/docs/agents-api/instance-lifecycle).
The API-key field uses the standard Connected Account secret field, including
host-owned Saved Secret references. An unconfirmed create with no returned
native identity remains unknown with a console recovery link; reconciliation
does not replay allocation. Android is not a Happier Machine guest.
Experimental Burstable is deferred until Agent37 publishes its rate and the
workspace can enable it; then it can join the same per-type options table.

In 0.3 development, SDK `createMachineProvisionerFetch` owns the native-fetch
bridge to host HTTP for captured Connected Account purposes and explicit
credential-attempt headers. `createMachineProvisionerMaterializedFetch` retains
the existing once-per-role materialization for leaves that separately address
API and guest origins; API headers never accompany guest requests. Both bridges
preserve request/response bytes and combine role and request cancellation.
Vendor endpoints, header names, token formatting, DTOs and lifecycle decisions
remain in each leaf. Neither bridge adds retries, polling or permission checks.
`buildMachineProvisionerShellCommand` owns the shared private binary-output
shell envelope for text-only native exec APIs; vendors with a separate stdin
channel omit its optional base64 stdin argument.
`buildMachineProvisionerDaemonStartScript` renders the host-provided environment
and argv for retained startup files; native staging and startup registration
stay with the vendor adapter.

A Destroy result of `confirmed` means the native adapter has proved complete
cleanup of that exact managed resource and its owned attachments. The managed
intent reconciler uses that proof to settle Delete without another native read.
Asynchronous command acceptance and uncertain cleanup are not confirmation;
they retain custody until an exact qualified read or completed native operation
proves absence. Power-command confirmation does not imply resource absence.

Lume's native destroy adapter observes the recorded storage and VM name, stops a
running VM, and confirms that exact VM is stopped before issuing Delete. A failed
or unsettled Stop/readback retains cleanup custody. A native Delete HTTP400 is a
typed refusal to complete deletion, not proof that no preceding side effect
occurred. The pinned [Lume controller](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/LumeController.swift#L934)
and [HTTP handlers](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/Server/Handlers.swift)
establish those native semantics. Fly uses its documented
[`force=true` Delete option](https://docs.fly.io/machines/api/machines-resource/#delete-a-machine-permanently) to stop and remove the
exact Machine, then confirms absence before cleaning up owned attachments.
These prerequisites stay with the native adapters; the shared host does not
impose a uniform Stop operation on every provisioner.

In 0.3 development source, Lume host preparation runs in the existing effectful
acquire Action before pulling an image. It reads `GET /lume/config` and, only
when caching is disabled, sends `POST /lume/config` with `{cachingEnabled:true}`.
No directory fields are sent, preserving an explicitly configured cache directory.
The pinned [configuration handler](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/Server/Handlers.swift#L750)
returns an acknowledgement; a subsequent GET must confirm enablement. A failed or
unconfirmed enable emits the closed `lume_cache_enable_failed` warning and does
not block acquisition. Check stays read-only and reports cache state as enabled,
disabled or unknown through its existing code and localized status. Options and
Inspect stay read-only; native pull and digest verification are unchanged.

Lume Stop sends storage in the JSON body of `POST /lume/vms/:name/stop`.
The pinned [route matcher](https://github.com/trycua/cua/blob/3350f504014c85416009a90fcb339fe556ce02fc/libs/lume/src/Server/Server.swift)
compares raw URL segments, so appending a storage query to the literal `stop`
segment returns HTTP404. GET and DELETE retain their storage query on the
parameter segment; run, configure and pull use their documented JSON bodies.
The [official HTTP API](https://cua.ai/docs/lume/reference/http-api), checked
2026-10-26 for 0.6.1, specifies the same storage placement. A lifecycle route404
is a typed refusal carrying `native_route_not_found`, the static route kind and
exact HTTP status; it retains the resource and is never native absence proof.

In 0.3 development source, rejected, unknown and pending acquisition outcomes
and check/options/observation results and refused or unknown native-control
results can retain `nativeCause` through the public
machine-provisioner schemas. The [provider-facts owner](../packages/protocol/src/machines/managed/providerFactsV1.ts)
admits only a status class and allowlisted vendor code, a gRPC status code, a
documented Modal SDK error class, or a closed local qualification cause
(`native_options_changed`, `native_ssh_network_unavailable`,
`native_route_unavailable`, `native_lease_ended`, or
`native_configure_refused` or `native_delete_refused` with exact HTTP status 400,
or `native_route_not_found` with a closed route kind and exact HTTP status 404). It excludes native messages, bodies and
credential material. The controller preserves this fact in the existing
operation's `managedNative` failure detail; the receipt displays that diagnostic.
For Hetzner `invalid_input` and `uniqueness_error`, the HTTP fact can also carry
deduplicated `fields` from the documented create-request vocabulary, restricted
to fields submitted in that request. Dynamic label paths and reflected values
are omitted. This 0.3 development extension requires matching diagnostic readers;
the native request, SDK/controller and app bundles must be loaded together.
Roles without a failure-result arm use the existing `PluginError.details.nativeCause`
slot. Both native-effect and safe check/options dispatch validate that fact through
the same controller error owner before preserving it; unrelated error details stay private.
An options failure carries `code: 'provider_unavailable'`, so consumers retain
the draft and show the failure rather than treating it as no available choices.
The native contracts were checked on 2026-10-25 against
[Hetzner REST v1 errors](https://docs.hetzner.cloud/reference/cloud),
[DigitalOcean's official OpenAPI responses](https://github.com/digitalocean/openapi/tree/main/specification/shared/responses),
[Fly's Machines OpenAPI](https://docs.fly.io/api/machines/openapi.json), and
[Modal JS 0.11.0 error classes](https://github.com/modal-labs/modal-client/blob/8f5ea792ad7310e0f76ef96e0418b92529a18063/js/src/errors.ts)
with the [standard gRPC status codes](https://grpc.io/docs/guides/status-codes/).

In unreleased 0.3, native installer delivery reads the staged archive in sequential
fragments through the existing `bootstrapTransport.putFile` Action. The shared
role schema bounds its base64 field by the incumbent 32 MiB public Action body
budget; the host subtracts the actual serialized resource/path metadata before
deriving the raw fragment size. Private role dispatch remains in-process: this
reuses that real protocol budget as its memory boundary rather than introducing
an installer-size quota. The Action writes exactly the supplied fragment to the
host-selected private guest path and returns `confirmed` only after native IO
settles successfully. The host appends each confirmed fragment to its private
archive staging file and atomically renames that file only after EOF. Cancellation,
typed refusal or an uncertain write cannot publish a partial archive. The existing
installer owns progress and removes staging after extraction; cancellation can
leave private staging without authorizing further guest IO. First-party and externally installed
provisioners consume the same schema and assembly recipe; no Lima-specific path,
new Action role, retry, timer, or development compatibility shim is required.
The shared role schema is the base64 authority. Native adapters decode admitted
fragments once without roundtrip re-encoding or a vendor base64 grammar; Fly
passes the encoded fragment to its guest decoder. Fly's public direct native
client reuses the same role schema at that ingress, while retaining its native
path, mode and timeout checks.

For an asynchronous native deletion, a reconciling provisioner's destroy Action may return the canonical `accepted` result with its declared native-operation reference. The managed-machine row remains the custody owner: it persists that reference with the submitted Delete intent, re-supplies it to the same destroy role, and clears the resource only after a `confirmed` result. Legacy provisioners may keep returning the synchronous power-result shape; an `unknown` result never discards retained deletion custody or proves absence.

A newly approved Delete after cancellation or daemon loss resumes that retained
handle through the same operation-owned observation loop as a fresh accepted
Delete. A positive native pending result keeps observation active; absence,
typed native failure or cancellation settles it. An ambiguous fresh destroy is
never replayed to enter this loop.

In 0.3 development source, Hetzner, DigitalOcean and Fly retain the exact resource
as that Delete handle when accepted primary deletion is still pending. Their
continuation rechecks primary absence before deleting recorded owned attachments,
without repeating the primary DELETE. Hetzner also retains the returned
`deleteActionId` in that handle and observes `/servers/actions/{id}` until
success before attachment cleanup: its [server Delete](https://docs.hetzner.cloud/reference/cloud#tag/servers/DELETE/servers/{id})
immediately removes account visibility while attachments detach asynchronously,
so server absence alone does not establish detachment. Native inspection remains read-only, and
native read or mutation failures remain failures rather than proof of pending or
completed cleanup. Initial and continued Delete replies use the same host failure
classification: while cleanup remains unconfirmed, a named native failure settles
the operation with its typed cause and stops automatic observation, retaining the
resource and submitted intent for explicit recovery. A later Check now can confirm
absence without rewriting that failed operation as a success. Existing acquisition
handles retain their original shapes.
The policy supervisor keeps bound work attached to its resource identity when
that same Delete publishes a cleanup handle. Unbound acquisition/cleanup still
uses its native handle as identity; publishing bound cleanup progress does not
replace the active policy observer.

In current development source, a native reply that remains uncertain can be
resolved by an exact inspection. Once Home confirms absence and clears the
submitted Delete, the shared reconciler completes that Delete. A later Inspect
also settles its original uncertain operation through the existing scoped request
lookup, matching the managed resource and controller installation. Native cleanup
uncertainty and another resource's operation cannot supply that confirmation.

A freshly admitted Delete can retry a bound resource after a lost or uncertain
reply. The current controller first observes that same retained resource. Fresh
presence retires the earlier submission only for a newer explicit Delete on the
same unarchived, active or canceled-cleanup row and installation, without a retained native-operation handle;
normal submission then admits one new effect. Absence settles without another
Delete. Same-admission replay, mere policy changes, unavailable or stale facts,
controller replacement and native-operation cleanup custody do not grant retry.
Power intents retain their existing fresh-state reconciliation; rebuild requires
its provider's exact replacement result rather than presence alone.

In current 0.3 development source, the shared configurator consumes the options Action's explicit `inputHints.fields` and current occurrence-pinned input schema through the existing Action form owner. A schema alone does not declare rendered fields. A field's optional JSON `defaultValue` seeds a missing initial form value; an explicit retained value, including `false`, `0` or an empty string, takes precedence. Defaults are applied once when the form opens, survive hint localization, and do not replace later edits or final Action validation. Editable selector paths must match the executable launch paths so retained recipes can revalidate through that same options role; the UI does not guess native wrappers or merge launch fragments. Selected native prices retain every line in the canonical configuration facts' `prices` vector, including optional localized labels, exact amount, currency, unit, source and observation time. The shared receipt renders that vector without adding totals, currency conversion or guessed monthly rates. Missing native declarations remain unavailable rather than implying UI support.

An Action-created machine without UI-reviewed facts captures its configuration
once when the initial native acquisition returns a bound resource or pending
handle. The shared reconciliation owner reads the selected installed
contribution's check/options roles, projects the admitted choices through the
options input schema, and uses the same facts builder as the configurator. It
reports the snapshot into the existing `reviewedFacts` field without changing
signed admission. Existing reviewed snapshots remain intact. Failed optional
options reads retain the authored choices with `optionStatus: unavailable`;
inspection and acquisition recovery do not repeat configuration discovery.

Machine billing's `stoppedBilling` describes compute, not the entire provider bill. Retained disks, volumes and snapshots can bill separately. Their published rates belong in the existing `billing.storageCharges` facts, with resource labels, currency, unit, source and observation time; these are rates before applicable included usage, not an invoice or an estimate of stored bytes. The shared configuration receipt must preserve those labels and disclose declared storage rates even when compute pricing is unavailable. For example, Vercel publishes snapshot-storage rates for Pro/Enterprise, and Fly publishes stopped-rootfs, volume and snapshot rates. Local/no-provider-bill and unknown billing remain distinct; missing storage rates do not establish free storage.

When billing differs by native selection, options declare `billing` on their base or dimension option. `projectMachineProvisionerSelectionV1` applies the selected declaration over the base; contradictory selected declarations make the selection invalid without publishing an arbitrary billing fact. Configuration, retention policy, receipts and current policy resets consume that selected billing, falling back to the descriptor when no override is declared. Declare unknown until a variant is known when its compute billing differs (for example, Maritime boxes versus Linux computers); hosts display unknown rather than infer billing from retained storage or provider identity.

Full and scoped/aggregate bundled publication share the same admitted Machine descriptor renderer in the [canonical publisher](../apps/cli/scripts/build-owned/generateBundledPluginEntries.ts). The UI machine catalog must receive current billing, enrollment-role and guest-platform declarations alongside the CLI catalog; preserving unrelated executable/UI runtime bindings must not retain stale machine facts.

In that development family, a returned native choice may supply `retention` using the descriptor's existing capability schema. The shared configuration input uses the selected choice's capabilities, falling back to the descriptor when absent; the sole retention resolver qualifies policy, and admission consumes those validated reviewed capabilities for the matching launch. Native duration facts remain separate from Happier's unused rule and observed expiry. Cua BYOC uses this seam for finite Modal launches and durable no-TTL AWS/GCP launches without separate provisioner ids or cloud-specific UI decisions.

In the same development source, an absolute Stop/Delete deadline is a reviewed, interrupting choice for one-off creation or a live machine, never a default. The shared Keep control owns its date/time and interruption review. [Reusable retention](../packages/protocol/src/machines/managed/managedMachineV1.ts) derives Keep and unused rules from the same retention schema; [preset writes](../packages/protocol/src/machines/managed/managedMachinePresetV1.ts) and [Account category defaults](../packages/protocol/src/account/settings/machineRetentionDefaultsV1.ts) reject absolute deadlines through their canonical input schemas, including Actions. Saving a deadline-bearing creation draft as a preset preserves its other settings, omits the deadline with an explicit disclosure, and leaves the deadline in the one-off draft. This is development behavior, not a claim of released cloud support.

Team presets in 0.3 development can record the explicit `teamAcquireDelegated`
opt-in through their existing create/update Actions and revision. Omitted and
existing values are off. The Team's current management/authentication policy and
controller Manage approve the opt-in; changes to an opted-in recipe retain that
controller approval. Withdrawal still requires Manage when its credential is
unavailable. An Account preset cannot enable Team delegation.

Signed automatic setup uses the canonical prepared targets-only Apply builder;
the delegation construction refusal is removed after its composed source checks.
Fresh custodian-only native lease acquisition is source-tested separately.
The development acquire owner admits a qualified current Team member without
controller Manage only for an explicitly delegated, current, unarchived preset.
It revalidates the simultaneous limit, provider declaration, exact controller
installation and active custodian credential. Launch and credential references
come from the stored preset; delegated retention and wake use its values through
the existing policy resolver, without caller overrides. One-off creation still
requires Manage. Preset visibility alone grants no spending authority.

Native cloud execution and credential custody stay on the controller and its
existing managed-purpose lease. Requester-owned enrollment uses the admitted
`enrollmentAccountId` and the requester's existing authenticated pairing client;
it must never fall back to custodian sealing for a member-owned guest. Creator
progress/cancel/recovery is scoped to that exact admitted resource, not every
resource using its preset. The member's Team-preset projection omits credential
references and supplies public installation/configuration facts without requiring
the controller in their Machine list; withdrawal remains credential-free and
unavailable. Existing controller management and cleanup authority are unchanged.
Collection projection gathers selected credential references per controller
Account and reads only those profiles through the credential repository's
body-free projector. Identical references share that transaction's read; each
new read still checks current active/expiry facts, without an inventory scan or
cross-request cache.
Foreign-controller Action envelopes carry a fresh invocation codec key sealed to
that installation, not a copy of the requester's bearer or Account content key.
The daemon retains custodian settings/execution and derives operation requester
scope from verified Home authority; it does not create requester Account custody.
The existing Settings Create navigates to the exact managed-resource detail;
its requester sees and answers the transient pairing request through the existing
bootstrap response Action. Prompt discovery and waiting use exact-resource
operation observation, not controller inventory access or polling. Session-composer,
Script and Workflow use the shared creation runner's existing installer question
presenter and that same bootstrap response Action for requester consent. Only a
delivered answer advances the existing event-backed operation wait; declining or
retiring the entry does not resume creation. The same shared runner
also answers a fresh delegated dedicated-daemon-user `adminAccessAtCreation: 'ask'`
administrator question: the installer Modal (`managedCreationPrompt.ts`) asks the
named administrator's new password as a secure entry and sends it once through
`machines.managed.bootstrap.respond` with `purpose: 'establish'` and the exact
`promptId`; declining cancels the creation through `machines.managed.cancel`. The
password is never kept in progress state, observations or logs, and no
controller grant or approval authority is added. The Team-preset opt-in is a
switch row on the preset page (`MachinePresetDetail` `memberCreate`) over the
existing revisioned `machines.presets.update`; it is read-only, with the reason,
for a viewer without Manage.

Guest setup and Agent-start continuation seal fresh child-invocation codec
material to the exact enrolled installation under current Home authority; the
guest keeps its own Account custody. Native devcontainer bind prepare/release
uses existing prepared workspace records and exact controller mapping. This is
not permission to run commands or read arbitrary files in another person's
Machine namespace; ordinary isolation requirements still apply.

For a requester-owned guest, native unused-retention reads/drains use only the
exact retained `managedTarget` and the existing content-free guest activity RPCs.
This is not a company grant to read the guest Machine or its keys. Guest readiness
and real activity changes wake the existing managed policy feed; a nonpersisted
activity-change hint is not activity authority. The rule still reads a current,
installation-signed activity proof before native effects. Equal/stale state and
ordinary liveness do not publish managed-resource changes.
Runtime demand, Pending activation and retained-power presentation consume
`resolveManagedMachineRuntimeV1` in Protocol's managed domain for native
availability, guest readiness and whether wake needs Inspect. Native power owns
that fresh provider Inspect; passive reads do not wake. Home's admitted Pending
record owns input activation: retiring the scheduler's compute-wake job cannot
fail that independently admitted input. Public `newSessionWake` comes from the
finite owner's controller selection: an assigned controller is available;
controllerless resources report `no_controller`. The custodian Account daemon's
existing Pending wake authority does not extend pre-Session finite custody.
These are unreleased 0.3 source contracts. Final integrated validation,
loaded-stack validation and final UI composition remain tracked in the VD-DELEG
and VD-GUEST lane reports; no released availability is claimed.

The same development declaration can bind `nativeDurationInput:{path,unit}` to one ordinary numeric field in its existing options Action. Units are milliseconds or seconds; the field's schema and editor remain owned by that Action. Canonical manifest admission requires the field in every input arm with one identical numeric schema and exactly one numeric hint. This lets the shared Ends owner use that real field without guessing native names or adding a second lifetime input. The binding is not an observed expiry timestamp. Modal declares `timeoutMs` in milliseconds; loaded single-editor UI behavior remains subject to the shared configurator's integration check.

In unreleased 0.3 source, a finite resource's Ends receipt uses the retained creation
record's `reviewedFacts.nativeFacts.duration.afterMs` and optional `idleAfterMs` to
describe its configured maximum lifetime and idle termination limit. Modal's options
owner produces these from the same `timeoutMs` and optional `idleTimeoutMs` forwarded
to `modal@0.11.0` creation. Omission leaves the idle clause absent. The existing text
receipt explains that the sandbox's files are lost when it ends; it never derives a
clock deadline from creation, readiness or observation time. An observed
`nativeExpiry` takes precedence. A record missing both facts has no invented limit.

A provisioner may also declare `resourceIdPath`, the path of the provider's own id inside its resource value (the id its console shows). Admission requires that path to name a text or number field in every resource arm. It is display-only, never an identity or a lookup key: a created machine's header shows it after the kind ("Hetzner server 58213904"), and an undeclared or absent value shows nothing. The first-party leaves declare Hetzner `serverId`, DigitalOcean `dropletId`, Fly `machineId`, Modal and Cua `sandboxId`, Lume `vmName`, Lima `instance`, Docker Sandboxes `sandboxName` and Crabbox `leaseId`.

Fly's development options query accepts known inactive app/volume draft fields retained by the generic form. Crabbox backend selectors and Lume image-kind selectors follow the same boundary rule. Each leaf's schema-owned candidate codec selects only its active fields and validates the complete result through the unchanged closed executable launch or image schema. Unknown draft fields remain rejected; an incomplete active branch supplies discovery facts, not an executable launch. Neither the form nor the options role rewrites the saved recipe or grants acquisition before revalidation.

Private native exec carries the containing task's `timeoutMs` unchanged; `null` means no timeout, not a leaf-selected fallback. The host supplies that budget under current retained-row custody. Modal forwards a finite budget to its native exec API and omits the native timeout for `null`.

The development daemon acquire installer reads its generated guest-host OpenSSH
private key through `machineProvisioners.materializeGuestHostCredential()`.
This is distinct from the person's bootstrap/login credential. The host supplies
the reader only to the retained SSH acquire invocation; other invocations refuse
through the existing unavailable-service result. The returned bytes lease uses
the incumbent redaction and zero-on-dispose/settlement lifecycle. Private key
bytes never belong in public operands, results, retained operations or logs.

Each declared credential purpose uses the existing qualified Connected Account owner. The launch's `credentials` array selects one Account per distinct purpose; BYOC can therefore select its cloud and Cua Accounts without a composite connection. Before durable acquisition submission, the controller captures each selection's configuration revision. The managed row retains those individual bases with the first submitted allocation; replay cannot replace them. Subsequent native admission checks each configuration rather than a rotating bearer-token revision, so changing a selected coordinator cannot redirect an old resource. An already-issued acquisition can still report its validated paid identity for cleanup after configuration withdrawal, without authorizing another native effect. Configuration bases are retained-row state, not public launch choices or receipt fields.

In development source, the machine-provisioner projection publishes the acquire Action's Connected Account HostAccess purposes under the provisioner's qualified contribution identity. The existing Connected accounts setup reads those declarations on the captured Home/controller, uses its manual/OAuth descriptor owner, and returns an explicitly selected active account to the same configurator draft. Cancel preserves that draft; Reconnect uses the exact existing account. The configurator refreshes the controller's purpose options before admitting the returned reference. This flow does not write a Resource default or introduce a provisioner credential store. Agents use the existing Connected account authentication Actions and pass the selected qualified references to the existing provisioner/preset/acquire Actions.

A contribution can qualify a purpose with `credentialPurposeRequirements` and
the existing launch-input predicate grammar. Only a positively observed
`optionalWhen` selector waives that purpose; missing selectors keep it required.
The shared requirement owner serves configuration, preset/acquire admission and
retained native roles. Crabbox's direct local-container launch therefore needs
its retained SSH key, while coordinator transport requires the captured
coordinator Account. This qualification does not grant additional HostAccess.

The development `machines.provisioners.list` Action publishes its exact controller and each current provisioner's `credentialPurposes`, qualified by the contribution and occurrence. These come from the acquire Action's declared Connected Account purposes, matching the existing save/acquire admission owner. Each purpose carries labelled exact Account choices from the qualified Connected Account form-choice owner. Listing neither opens credentials nor activates native leaves; occurrence retirement during choice loading refuses the result. Missing selection facts are unavailable, never inferred from saved credentials or general Account inventory. Later native roles revalidate their captured selections against their own declarations without disclosing private authorization scopes in this catalog. This is a source contract; mounted selection and loaded-runtime verification remain separate.

The same Action accepts an optional qualified `contribution` filter. The controller applies it before credential-choice discovery, so reading one existing machine's retention parent or Rebuild review does not wait for unrelated provisioners' accounts. An omitted filter still lists the complete catalog; an absent contribution returns an empty list. Reset and Rebuild continue checking the current selected native variant and reading current parent settings rather than treating the creation receipt as current authority. This is unreleased 0.3 source behavior.

Development managed Move is admitted through the reviewed destination installation, not a network round trip through an offline retained controller. The destination still belongs to the resource custodian and must admit the current recipe and credential selections; the server preserves revision checks, retained resource identity and outstanding native-effect custody. The UI can discover the current policy parent through an available qualified controller and offers Move from admitted cloud billing while destination checks decide reachability. Other retained native operations continue through the current controller.

A provisioner may declare `bootstrapCredential:{kind:'native-token'}` when its native guest transport needs a retained resource-specific token. The existing bootstrap SavedSecret owner creates it before submission and reopens the same reference for retry; SSH credentials keep their existing default. The invocation's private `services.machineProvisioners.materializeBootstrapCredential({kind:'bytes'|'file'})` port selects only that admitted resource's credential, never a plugin-supplied Account or secret reference. Byte and protected-file leases are invocation-owned and disposable. No private token is added to a launch, receipt, resource, or Action input. This is a development source contract, not a claim of released provider availability.

Managed bootstrap requires a fresh minimum-version Settings read. The canonical SavedSecret importer owns source compare-and-swap and exact readback; its own acknowledged Settings-version advance does not retire Account identity, mode/key or controller custody. Retained resource revision and access are still admitted through the SavedSecret catalog on each private material demand.

Native tools requiring a fixed SSH-key path can use the same implicit credential through `withBootstrapCredentialFile({ relativePath }, callback)`. The protected, plugin-scoped file owner delivers the private key and derived `.pub` file under its existing generic file lock, awaits the callback's native reader, and removes only those files, preserving native claim and recovery state. A queued invocation reopens the retained credential after acquiring custody; cleanup retries use that same lock. Invocation completion joins unawaited callbacks, and only the existing validated paid-result completion path can preserve an acquisition result despite reported cleanup failure. This is temporary delivery, not another secret store. If a dead host's lock is reclaimed while an orphan native reader survives, its operation may fail; uncertainty proceeds through ordinary reconciliation/recovery rather than a new native-reader custody protocol.

The same admitted credential-role contract covers retained inspect, reconcile
and destroy consumers. Every invocation reopens the exact retained key under
current row custody and releases its temporary delivery; no native key is kept
between invocations.

Safe checks may return an optional prerequisite `repairAction` containing a qualified Action reference and JSON invocation input. The host validates that reference and input against the current Action catalog without activating or running the repair. The fact is descriptive, not installation authority: an explicit repair uses the ordinary Action front door and its current approval and execution policy. A missing system tool does not imply a managed installer exists.

In 0.3 development, an options result can also attach prerequisites to its
selected `base` launch. When present, that complete snapshot replaces the check
prerequisites in the existing receipt and repair flow; an empty list clears them.
When absent, the check prerequisites remain in use.

In unreleased 0.3 development source, the Docker container provisioner defaults
to an image, with an optional setup script and optional `workspaceFolder`. Without
a host workspace it uses a container-owned volume. The image path invokes the
managed Docker dependency directly, with Podman as a runtime choice; the Dev
Containers CLI is used for advanced file or inline configuration. Remote Docker
hosts and contexts are outside this flow. Presets, Team presets, pools and retention
remain on the existing managed Machine owners.

Devcontainer presets save only the author operands accepted by the options
Action: image and setup script, runtime, workspace and file or inline build
configuration. Saving or editing these operands does not require a controller or
native acquisition. Image-only acquisition can use the saved operands without a
native review digest: they fully specify child setup, and image metadata cannot
add Dev Containers hooks. Acquire observes the image through the existing native
review owner and retains those executable facts for reconciliation; this is not
requester-supplied approval authority. If an acquisition carries an admitted
digest, image drift still refuses it. Advanced file and inline sources require
an admitted digest before any native configuration runs. Delegated Team members
cannot supply that digest; advanced delegated creation remains unavailable.

For reviewed acquisition, native options compute the effect review and its
digest once for the selected operands. The receipt builder puts only the digest
in `reviewedFacts.reviewedEffectDigest`, outside the saved launch choices; the
ordinary acquisition approval signs those facts with the request. The controller
passes that admitted digest to native acquire. The provider retains its existing
effect-time drift check before execution and stores executable facts in the
retained resource. Resize consumes that resource and size, not a preset launch.

Local acquire/rebuild role inputs can carry the transient `guestHome` fact:
the selected application origin and controller-resolved IP addresses. The
controller uses the existing Home carrier policy and OS resolver; these addresses
are not settings or retained resource identity. The image provider consumes this
fact through Docker/Podman `--add-host`, preserving the hostname for TLS and the
native bridge network. Advanced native configuration retains its reviewed
networking authority. Home reachability still belongs to guest enrollment,
not the native bootstrap transport.

For advanced configuration, Devcontainer options accept the controller
`workspaceFolder` and `configPath`, or a saved `configuration` with `kind: inline`
and JSON/JSONC `config`. The provider writes embedded
sources into `.devcontainer/happier-<content digest>.json` in that workspace;
relative configuration paths resolve from `.devcontainer`. Distinct sources
keep separate files so presets sharing a workspace do not overwrite each other.
The launch and retained resource keep the embedded source for later realization
and rebuild. Existing file launches continue to read the authored file. The same
options Action fields drive agents and the preset editor, and native effect
review discloses workspace and additional bind mounts. Existing Machine labels
and Compose namespaces select a separate primary container per managed Machine.
This is an unpublished plugin schema change: reload matching Protocol, SDK,
controller declarations and clients together. Existing retained resources keep
their executable facts; editing an earlier development preset projects its
saved values through the current author-input schema before saving.

In 0.3 development source, native options return one optional `base` launch/query projection and independent `dimensions` arrays for size, image, location, network and duration. Each entry declares its executable selector `assignments` as input paths and JSON values, with its localized native facts and prices. Empty arrays mean no control; a missing base means the query is incomplete. Complete launch combinations are not enumerated. The public SDK's machine-provisioner entrypoint exposes `projectMachineProvisionerSelectionV1`, the single Protocol selection owner. It applies the declared paths with the shared input writer, checks compact directed native adjacency constraints, and accepts an executable selection only when every offered dimension is selected and the contributed closed launch schema validates. Native acquire still revalidates current availability. Form-qualified providers can return the reviewed complete launch with singleton dimensions and empty assignments. Devcontainer's effect review remains bound to the exact unchanged author operands in that base launch; its computed digest travels separately in acquisition review facts. Stored recipe/receipt `choices` holds the launch operands rather than an options catalog or a native review digest. During the CD31 QA/dev daemon transition, one UI parse-boundary adapter accepts the earlier complete-choice result and retains each exact launch as one selectable row; producers write only the dimension shape. Remove that old reader once every QA/dev daemon runs a bundle with CD31 producers, after the orchestrator confirms reloads. Reader removal is the last migration step; source publication alone does not establish loaded-runtime compatibility.

An unavailable options base or selected dimension can carry closed
`unavailableReason: { code, status, fieldPath? }`: a native reason code, localized
copy and optional input path. The selection projector retains that presentation
through unavailable and invalid results; the configurator consumes it for Create
and the named field without attributing the refusal to another dimension.
Lima emits its native driver code with leaf-owned copy and `vmType`. This is an
unpublished 0.3 V1 extension requiring matching controller/UI readers; older
strict development readers reject it. No acquisition authority, executable
launch schema, persisted format or compatibility adapter changes.

In unreleased 0.3 source, provisioners with a renewable native wall deadline may
declare optional `actions.renew`. Its closed input carries the retained resource
and an optional deadline selected by the existing managed retention owner. The
closed result is `unnecessary`, or `renewed` with the observed `nativeExpiry` and
an optional vendor-derived `renewAt`. The same policy lifetime uses its existing
wait for activity changes and the next renewal; there is no plugin idle policy.
Until-delete retention keeps a running resource's native deadline renewed too.

Boat trial accounts remain available. Create and Resume use its mandatory
two-hour TTL; renewal restores that window while work is busy or unknown, or
shortens it to the selected unused/deadline expiry. Its next renewal is halfway
through the observed TTL window; the selected retention deadline can wake sooner.
Stop retention then lets the
native timer lapse and reports the ordinary stopped observation through Inspect.
The same unused-retention activity wait remains active until that observation;
new work restores the TTL while Boat still accepts renewal, then waits for unused again.
Boat documents a one-second minimum TTL and approximately five seconds between
expiry and native Stop; Happier waits for the observation rather than treating
the deadline as confirmation. These vendor bounds come from
[Boat auto-stop](https://docs.boat.dev/long-running-tasks/auto-stop.md) and its
[OpenAPI contract](https://docs.boat.dev/openapi/boat-v1.yaml), checked 2026-11-06.
Paid-account creation keeps its existing disabled native TTL.

Known account-plan refusals still use the shared unavailable options fact.
An acquire role reports a definite refusal as `kind: 'rejected'` with its own
nonempty code. The controller records confirmed absence and preserves that
reason. Only an explicitly typed pre-effect refusal establishes no allocation;
an ordinary handler failure or lost create reply remains uncertain and needs
the existing reconciliation path.

Native facts retain labelled size, image, location and network identities through the public SDK's `MachineProvisionerNativeOptionFactsV1` and `MachineProvisionerOptionsResultV1`. A size can include observed CPU cores, memory bytes and disk bytes; omitted dimensions and measurements remain unknown. Images may include a localized `description` and a declarative `preview` naming an exact packaged PNG Resource (`resource: {pluginId, localId}`) with an optional localized `accessibilityLabel` for the existing public Image renderer. Locations may include the native ISO alpha-2 `countryCode`; no country is inferred from a label or region id. A `network` fact labels which public addresses a server gets and remains its own row beside size, image and location; the configurator keeps the provider's first declared variant selected until the person picks another. Hetzner projects its returned image description and location country code; DigitalOcean projects its returned image description and leaves country absent. Both omit previews because their native catalogs supply none.

In 0.3 development source, the shared managed configurator warns on cloud sizes below its evidence-based memory recommendation for Happier and an Agent. It reads native size facts for every provisioner and keeps those sizes selectable; this advice does not affect availability or acquisition. Missing memory facts and local sizes receive no cloud warning. The owner constant records the measured boundary and its evidence; the recommendation is not a guarantee for every workload.

Price lines stay with their native owner: size rates appear once, and separate location/network charges use explicit dimension applicability. The shared projector selects the applicable returned lines for size comparisons and the receipt without totals, currency conversion or fabricated zero. DigitalOcean retains size/image-to-region adjacency; Hetzner retains architecture groups and size/location prices without expanding their product. Missing constraints express independence, not guaranteed native availability. An explicit `monthlyCapStatus: 'none'` reports a native absence of a monthly cap; `unknown` or omission never becomes a cap inferred from a monthly rate. These facts are disclosure, not acquisition authority. The shared reviewed-configuration builder snapshots supplied native facts for later receipt presentation. Retention declarations separately expose optional `finiteOnly`: omission is unknown, and neither native expiry nor the absence of power operations supplies that fact. Policy qualification remains at the sole retention resolver.

In 0.3 development source, Hetzner normalizes orderable size/location prices from the native server type's `locations` entries: the location must be listed, currently available, and before its own deprecation removal date. Retained prices and the retired global server-type deprecation field do not establish orderability. Public options and the fresh acquire check consume that same normalization; a withdrawn choice returns `native_options_changed` before any server POST. This follows the [Hetzner per-location contract](https://docs.hetzner.cloud/changelog), checked on 2026-10-26; availability remains a vendor observation rather than a capacity reservation.

Provisioners that return pending acquisition handles declare an optional `reconciliation` hook with a closed native-operation schema and a safe same-plugin daemon Action. The public `defineMachineProvisionerReconciliationSchemas` constructor consumes the launch schema and supplies a strict input union: the retained native handle, or the original managed-row/request correlation with its declared launch. The shared acquire/reconcile result validates pending handles and eventual bound resources. The same constructor supplies the destroy input for either a bound resource or proven-owned partial attachments identified by the retained native handle. Ordinary resource inspection remains unchanged. Reconciliation requires private retained-row custody and performs read-only lookup; it cannot repeat acquisition. Without the hook, strict acquire writes cannot emit pending, while retained generic row data remains readable for unavailable/manual recovery.

`reconciliation.continueAcquire` can opt the incumbent acquire role into an
exact retained-resource input. After recovering and recording that identity,
an admitted installation retry completes the reviewed acquisition recipe on
the same resource before bootstrap. Inspect performs only observations. Lume
uses this to finish sizing and startup after a lost reply without another pull;
a running VM must already prove the reviewed sizes. On a stopped VM, Lume sends
only changed CPU/memory and strictly larger disk sizes, skips an unchanged PATCH,
and re-inspects all reviewed hardware before Start. A native configure refusal
retains the exact resource for recovery because earlier settings may have applied.

Fly's native process configuration skips an update when a running Machine already
has the requested command and environment, avoiding the API's reboot side effect.
A stopped Machine still needs the update's startup effect; changed configuration
is round-tripped through the existing full native configuration owner. Native
autostart/autostop settings do not prevent bootstrap; Inspect discloses them as
`native_autonomous_power`.

An optional safe `reconciliation.cleanup` role observes exact pending attachment
cleanup without first binding a Machine. Its closed result distinguishes
confirmed cleanup, native-qualified idempotent retry, and uncertainty. The
retained-operation owner can settle a lost Delete reply from confirmed absence;
only an explicit current Delete can consume retry qualification through the
existing destroy role. Observation does not itself authorize another effect.

The development destroy result distinguishes `{ kind: 'pending' }`, positive
native evidence that accepted deletion remains unfinished, from `unknown`
delivery or failure. `accepted` additionally returns the exact retained
`nativeOperationRef`; the declared reconciliation destroy-result schema
validates its native value. Pending carries no diagnostic code or native cause.
The host's existing Delete observer consumes these kinds and confirms absence;
diagnostic observation reasons do not establish pending deletion.

In 0.3 development, managed native roles consume the finite operation's admitted
Home custody and local cancellation, without another managed-row read per role.
For null-controller Account power, the same custody owner consumes the admitted
Home descriptor and exact selected-purpose binding through the original reviewed
child port. The descriptor travels in private invocation services, never in the
public power operand. UI and CLI reuse the shared native power/inspection engine;
neither invents a controller, selects another credential, or treats a Home intent
acknowledgement as native completion. Installed-controller execution keeps its
existing operation and custody path.
The existing present-user gate still checks selection, availability, surface and
authorization. Only an exact host-admitted reviewed child reuses its original
current-intent review instead of presenting a second confirmation; unreviewed or
mismatched calls retain the ordinary gate.
For unused Stop/Delete, Home admission precedes the final guest idle
confirmation, so accepted guest work arriving during preparation is still
observed. A controller change during an admitted drain does not retroactively
revoke it: the drain completes under
its captured controller, and the next request refuses. FIN source retirement
is separately checked through the requester source projection after final guest
confirmation, without another managed-row read. Fresh and recovered accepted
Delete use the same observer, with one authoritative row read per deadline wake.

Cancellation still revokes process IO and current effect authority. Once an admitted native acquire has actually entered its handler, the host privately retains its validated settlement so the original creation can record paid identity for cleanup. This grants no bootstrap or stale start authority; ordinary Actions and read-only reconciliation keep their existing cancellation behavior.

After a confirmed native rebuild, the managed enrollment owner retains the previous Machine as `replacementEnrollment` until the current native identity proves its replacement enrollment. Ordinary registration, including unique-insert rejoin, cannot bypass that same active, unarchived row's proof requirement or substitute a valid proof from another managed row. The binding owner consumes the retained reference when exact enrollment succeeds. Manual Retire ends managed enrollment authority without deleting the native resource, ordinary Machine or retained recovery history; it does not permanently block ordinary registration.

The public machine-provisioner author surface also prepares [persistence-only launch, resource and optional native-operation readers](../packages/protocol/src/plugins/contributions/machineProvisionerStoredSchemas.ts). Preparation demands the existing portable-schema compiler; cold discovery does not load it. The shared stored projection drops unknown nested fields and then re-admits known values through the declared typed schema. These read-only hooks cannot be supplied as Action input or result schemas: new acquisition stays strict, and native reports and enrollment validate their native identity or handle.

In 0.3 development, the Home's stored managed-row owner preserves declared
launch normalization when compatible, but a republished declaration cannot
invalidate an already admitted launch. An incompatible launch declaration uses
the protocol-owned retained grammar while native values still use their declared
projection. Raw stored snapshots are preserved. This keeps retained allocations
readable for recovery and cleanup without relaxing new acquisition; see
[managed-row compatibility](compatibility.md#managed-machine-query-selection-03-development).

An acquire invocation can receive the host-populated managed-row id as a native naming/correlation tag beside its raw launch value. That tag grants no authority, does not select another resource or leaf, and promises no native exactly-once behavior; the private admitted-row custody remains authoritative.

In 0.3 development source, the Lima leaf's creation template explicitly ignores
all automatic guest-to-host TCP/UDP port forwarding on every guest address.
Lima's separate SSH port still carries native guest commands and bootstrap IO;
Domain routes and service probes execute on their selected Machine or observer.
Existing guests retain their saved configuration until edited or recreated;
Inspect, Start and recovery do not retrofit this template policy.

Lima derives its native name from that opaque row id. The launch recipe has no
separate instance-name input; the managed Machine's name is its human label.
An untouched configuration reads its store, image and sizing defaults from the
controller's native `limactl info` facts through the existing SDK Lima adapter.
Explicit fields and complete retained recipes keep their chosen values. The
shared configurator displays that returned launch in its fields and explains
why Create is unavailable through the same decision that disables it.
Stored launch readers drop a previously saved instance-name field, while new
Action inputs remain closed. Acquisition cannot adopt an existing VM: the shared native helper's
`created: false` is a refusal, while same-row recovery uses the row-derived exact
identity. Retained Lima resources continue using their recorded store and instance;
owner edits to CPU, memory or disk do not prevent Inspect, Stop, Delete or native
bootstrap IO. Creation still verifies the newly allocated guest's reviewed facts.
There is no rename or adoption migration. DigitalOcean likewise retains a positive
create-response Droplet id before decoding readiness, so malformed ancillary facts
cannot discard paid-resource custody or imply readiness.

Crabbox recovery after a lost first acquisition report derives the exact lease
from the managed-row id and the original launch's backend, namespace and transport.
It uses the existing coordinator GET or direct native inspect, preserving a selected
local-container runtime. Recovery never repeats acquire or warmup; unavailable
observations retain uncertainty, and native identity mismatches still refuse.

Docker Sandboxes and direct Crabbox use the installed dependency's readiness and
executable without requiring an exact researched version. Native output and
resource identities still pass through their existing parsers; a routine CLI
update alone does not disable managed operations. Version references in native
contract comments identify the research basis, not runtime equality checks.

In 0.3 development source, Crabbox's missing native command is a managed-dependency
prerequisite with a repair Action. The shared prerequisite presentation launches
that Action; it delegates installation to the existing dependency service. The
dependency's capability read uses the same service's selected status, including
whether an executable is present, so an already available system command is not
reported missing merely because a managed archive has not been installed. The
managed Crabbox archive retains the accompanying runtime directory; it does not
install a lone executable.

An SSH bootstrap invocation may also receive the public key derived from that row's retained bootstrap credential. A leaf can install this public key through its qualified native setup path and return the existing credential reference with observed host-key evidence. The private key never becomes launch, resource, preset or native command-argument data. Lume uses the managed-row id for its unique VM name and inspects the recorded storage before Stop/Delete. Cua local leaves share one native adapter: private stdin is uploaded into a private guest directory, executed through the exact local sandbox and deleted. Unconfirmed cleanup fails the operation; cancellation can prevent further host-admitted native effects and must not be reported as confirmed cleanup.

In 0.3 development source, Lume bootstrap tries the retained controller key first;
only a failed key connection uses the image's SSH askpass to install its public
key. macOS guests disable password and keyboard-interactive SSH by default after
a fresh key proof, independently of isolation. The existing Create options expose
**Keep password login**, default off, retained through launch, native operation,
resource and recovery. Missing retained fields also mean off. The bootstrap owner
writes an sshd drop-in using `sudo -n` first, or the published image password on
the same SSH session's private stdin to `sudo -S -p ''`. Effective sshd settings
and a second fresh key connection must succeed before keeping the drop-in;
failures restore its prior state and surface a typed bootstrap failure. Retry
uses the same key-first path. No account locking or password rotation occurs.
Prepared private Linux images retain their existing password-login behavior.

The development guest-host credential codec keeps an independent Ed25519 guest
identity beside the login key inside the same Saved Secret value. Public role
operands contain only the derived public keys; guest address plus retained public
key supplies SSH host-key evidence before pairing. The native SSH acquire seed
has a distinct host-private `readGuestHostCredential()` callback for the installer;
ordinary bootstrap byte/file readers still return only the login key. Both open
the retained resource/revision through the incumbent Saved Secret owner. Legacy
scalar credentials remain readable and refuse the new guest reader as unavailable.
The development SSH bootstrap writer now creates this bundle through the same
Saved Secret owner. DigitalOcean and Hetzner acquire installers consume the
distinct private SDK service before purchasing a guest, install that identity
through canonical cloud-init, and derive their bootstrap pin from its public key.
Their SSH carrier declares `hostKeySource: 'retained-credential'`; shared enrollment
uses the retained generated pin only for that declaration. An observed scanner
key remains evidence, including for native images such as Lume that do not install
the generated host identity. Native controller enrollment stores approved trust
under `ssh/managed/<Home-and-managed-row-hash>/known_hosts`, independent of the
reusable guest address and the ordinary app/system host stores. A new resource
asks for its own trust approval; retry pins its previously approved key and refuses
a changed key before remote execution. Existing address-only trust does not
silently authorize a managed resource's first connection. This development-only
carrier extension is closed: older readers refuse the new generated-source field
rather than dropping its trust meaning; the bundled producer and host update together.
DigitalOcean and Hetzner acquire/bootstrap are Account Actions using the existing foreground
Account recipe and its private provisioner service. Native SSH performs installation;
retained credentials without a guest pin use the native host's existing trust prompt.
The leaf advertises no browser SSH support and needs no local key scanner.
Native-token credentials remain scalar. This is a source contract under security
review, not evidence of a loaded or released provisioning path. Account mode
continues to decide Saved Secret custody.

In current 0.3 development source, Cua local Sandbox and Space options report gVisor choices as unavailable and omit their executable launch, even when native doctor reports gVisor ready. Happier has no qualified detached guest-daemon bootstrap carrier for that runtime. Acquisition reuses those options and refuses gVisor before native creation. Native readiness remains observable, and retained gVisor resources keep their exact inspect, recovery and cleanup paths; this does not remove the native runtime from stored resource readers.

Hetzner and DigitalOcean development leaves use the admitted managed-row id for
native naming and recovery correlation, and inject only that row's public SSH
key. For newly created cloud-init guests, SDK `buildMachineProvisionerCloudInit`
creates the key-only `happier-bootstrap` user with a home directory, bash and passwordless
sudo, and disables SSH password authentication. Both leaves select that same
user for bootstrap. For dedicated-daemon enrollment, the host creates the separate locked
`happier` daemon account, installs its payload and user service, and owns its
None/Ask/Preauthorized administrator policy. Cloud-init grants no daemon-user
sudo authority. The vendor's root password and first-login password-change policy
are not part of bootstrap, and no account-level SSH-key resource is created.
This create-time configuration does not retrofit an already retained guest
created by an older development build; retry never purchases a replacement.
The SDK `machine-provisioners/ssh` adapter uses the daemon's declared system tool
when an exec service is supplied. Without exec it returns the portable SSH
carrier for the native host to connect. New cloud-init guests use the retained
guest public key as explicit `hostKeyEvidence` before the first connection.
The Account recipe keeps both private keys in the incumbent Saved Secret owner
and exposes invocation-scoped byte leases only to the reviewed provisioner role.
Its native bridge runs the shared remote installer and pins every SSH command
before pairing or sealing Machine keys. Browser hosts refuse providers marked
`browserReachable: false` before allocation.

Retained guests without a guest public key keep the existing native
Trust/Replace-host-key prompt. Retry never generates a replacement identity or
retrofits a pin onto that guest; this first-connect trust decision retains its
named MITM risk. Key observation is not trust approval. The ordinary daemon
path retains known-host persistence. Boat, direct Crabbox and Lume use the same
scanner; Lume retains its native public-key installation after key observation.
Cloud API requests use the Action's captured
Connected Account purpose through host HTTP, rather than reselecting an account
or accessing a plugin-owned secret.
Hetzner Account roles materialize that purpose's HTTP headers once per invocation;
their portable token authentication registers the same materializer in the Account artifact.

The managed operation retains a task's open trust question even when the task
asks before its id is returned to the controller. Answering clears that same
question. Its single Protocol bootstrap-prompt union carries provisioning consent,
SSH trust or replacement trust with host/fingerprint facts, and remote service
replacement. The existing installation presentation renders those questions;
`machines.managed.bootstrap.respond` binds its answer to the exact displayed
question so a stale Trust click cannot approve subsequent Account sign-in.
Managed SSH uses its generated keyfile; ordinary SSH setup retains password entry.
Native bootstrap leaves report `native_not_ready` only from an exact native
creation, startup or connection observation. The managed reconciler publishes
“Waiting for machine” and retries that same bootstrap through its existing
readiness loop. Each leaf re-reads its native facts; the host adds no duplicate
inspection in this phase. The bound identity stays retained, and waiting never
repeats allocation or starts a second provider-owned loop. Malformed facts,
ended resources and native refusals remain terminal with their safe reason or
native cause. Cancellation interrupts either readiness phase.
Stopped, stopping, deleting and unknown power do not establish pending startup;
only an explicit outstanding native start can qualify a stopped observation.
Historical action records or unrelated native work cannot extend this wait.
Only providers whose native start returns before boot (currently Lume HTTP202)
may return a bound acquire result with
`startPending: true`. This transient producer fact lets the host wait through
exact-resource inspection until the first Running observation, using the same
CD32 cadence. Absent/unavailable observations and cancellation still settle it.
The fact is not stored on the managed row, reconstructed by read-only reconcile,
or reused after Running; a later stopped bootstrap remains terminal.
Lima awaits its native start command and emits no such fact; a non-Running
guest after that awaited command remains a typed terminal bootstrap refusal.

In unreleased 0.3, Lume projects the host-wide native inventory through one
macOS capacity owner. A stopped macOS guest at the platform's two-running-guest
limit settles Start and bootstrap retry with
`native_macos_vm_limit_reached`; macOS image choices disclose the running count
before Create. Linux and already-running guests do not consume a new macOS slot.
Generic Inspect preserves the target's observed power, including stopped power
while sibling guests fill capacity, so retained Stop intent can settle.
The limit follows [Apple's macOS licence §2B(iii)](https://www.apple.com/legal/sla/docs/macOSTahoe.pdf)
and [Cua's platform documentation](https://cua.ai/docs/spaces/guides/add-a-computer).
Lume 0.6.1 returns HTTP202 before boot and logs detached start failures without
returning them to the caller, so this is an inventory-derived capacity refusal,
not a recovered framework error. An external VM absent from Lume's inventory
remains outside that projection. Matching development Protocol, Home, controller
and UI must load the new closed native-cause member together; no migration,
retry, timeout or additional readiness loop is introduced.

The SDK reports an unavailable or unusable host-key scan with
`native_ssh_host_key_unavailable`. The managed reconciler keeps a visible
“Waiting for SSH” phase while exact native inspection confirms the resource is
present and running. This same loop includes the live enrollment trust scan for
carriers with a provisioner-generated host-key pin, such as Hetzner. The live
command boundary supplies a closed `ssh_keyscan_failed` native cause:
`empty` and `command_failed` wait, while `invalid` and `spawn_failed` are terminal.
No command output enters this diagnostic. It re-scans after 5 seconds, doubling the delay to at most
60 seconds, without a boot deadline or another purchase. Cancellation interrupts
the wait; during this SSH phase, absent, off, unknown or unavailable native observations settle with
`native_resource_unavailable` and retain the provider's closed native cause, or
the last keyscan cause when the provider supplies none. Successful
evidence continues to the existing host trust comparison and approval prompt.
The live SSH command boundary maps expired-password and host-key verification
failures to `ssh_password_expired`, `ssh_host_key_changed` or
`ssh_host_key_unverified`; other command
failures use `ssh_command_failed`. Messages are fixed and contain no native
stdout/stderr. Protocol's `ssh/commandFailure` vocabulary supplies the same
fixed messages to the host and Action error normalizer, preserving the code
through operation settlement without trusting thrown diagnostic prose.
Internal first-party text results still reach the enrollment
owner's released-command compatibility parser, which emits its existing typed
update requirement rather than forwarding that text.
Native exec/file carriers do not enter this SSH wait. These are development-source
fixes and still require loaded-controller and native-provider validation.

Fly's development leaf declares native buffered exec/file roles through this same
family. Its native JSON stdin channel accepts UTF-8; unrepresentable byte input
is refused, while file upload preserves arbitrary bytes. Acquisition uses the
selected image, defaulting to Ubuntu, with a volume mounted at the declared guest
home. The native bootstrap carrier supplies that home and Happier state directory
to the incumbent binary installer and ordinary enrollment recipe. After enrollment,
the same admitted exec role accepts an explicit process-config request to set Fly's
boot command to the installed foreground daemon. This confirms configuration,
not daemon connectivity; a failed update can be retried on the already enrolled
Machine without another installation or pairing. Stop resets rootfs while the
volume retains home, Happier state and workspace. Fly, Hetzner and DigitalOcean retain uncertain purchases as
declared pending native correlations. The shared source reconciler invokes their
read-only reconciliation role to bind the same resource; it never buys again.
When a declared reconciliation hook supports retained-row lookup, an unknown
allocation without a native handle can be inspected using its original
managed-row/request correlation and launch. Missing or ambiguous evidence stays
unknown/manual; it is never another acquisition attempt. Pending cleanup may
confirm absence only when all exact proven-owned attachments are absent, not
merely when no eventual Machine can be found. Provider-specific lookup and
cleanup remain leaf responsibilities. These source contracts do not establish
released cloud support.

The 0.3 development `machine-vercel` implementation is in progress and is not
available for managed creation. Its planned leaf consumes this same managed
acquisition, Connected Account, native transport and retention boundary. The
vendor Connected Account is `happier.machine.vercel/vercel-account`, shared with
the deployment plugin's `deploy.manage` purpose. Its manual mode accepts a
personal token, team id and optional project id; developer OIDC tokens are not
retained credentials. Connection, status and refresh verify the exact project
when configured, or the team otherwise, without requiring a project token to read
team resources. The sandbox consumer still requires both ids and reads the team
plan through the native client's limits owner before offering or acquiring a
sandbox. Vercel's [token-scoping contract](https://vercel.com/docs/accounts/access-tokens)
means a project-only token may connect for deployments while sandbox use remains
unavailable. These reads do not prove mutation rights. The planned deployment
consumer checks its exact selected project; Vercel enforces permission on each operation.
In current development source, the HTTP check/options/acquire/reconcile/bootstrap,
inspect/power/delete/cleanup and native transport Actions explicitly register on
the Account artifact, sharing their existing native client and invocation-bound
Connected Account materializer. Nonsecret team/project identifiers remain in
retained resource and operation values; credential redaction still belongs to
the host. The distinct native-credential `apply` Action remains daemon-bound to
its Machine-only secret capability. Vercel's `browserReachable: true` admits the
browser path: its Account artifact uses fetch for control, native exec, file
transfer and command output, and the required API routes permit browser CORS.
Providers that require SSH or whose required headers fail CORS require a selected
Machine or the app through the same provisioner host-availability decision. These source
bindings do not enable null-controller writes or establish the composed app
creation journey; reviewed launch bindings and security approval are still
required at the managed host boundary.
The retired development `happier.deploy.vercel/vercel` connection is no longer
offered. Its stored data is left untouched; reconnect and select the shared
vendor account. No alias or identity migration is provided for that unreleased id.
The planned host HTTP adapter uses
`POST /v4/sandboxes` for named persistent creation and
`GET /v2/sandboxes/{name}?resume=false` for passive reads. Check, options and inspect
must not execute guest IO or wake a stopped sandbox. Planned recovery retains the
scoped name and verified creation facts; a missing or expired snapshot cannot
authorize a replacement purchase. See Vercel's [named sandbox API](https://vercel.com/docs/rest-api/sandboxes/get-a-named-sandbox).

The planned intents are Start, Stop, Resume and Delete, without Suspend. Vercel
restores files, not processes; the native command carrier must restart the installed
daemon using the retained guest home and enrollment. The shared owner will probe
the guest and install the Linux x64 standalone payload. The guest must reach its
Home outbound over the public internet; a private Home can fail through ordinary
enrollment. No Vercel-specific reachability owner is added.

The development options owner defaults an omitted native timeout to the selected
team's already-read plan ceiling (45 minutes on Hobby; 24 hours on Pro/Enterprise),
not Vercel's five-minute API default. The form may leave duration empty for that
maximum or explicitly request a shorter run. It is a VM-run deadline,
separate from Happier's Keep policy. The planned projection treats timeout as a
resumable stop only while a usable snapshot remains; it does not preserve an
in-flight turn. There is no planned automatic extension or rotation. The leaf must
set snapshot expiration explicitly, rather than inheriting differing API defaults.
Planned deletion retains exact source-proven snapshot ids before submitting
`DELETE /v2/sandboxes/{name}?deleteOrphanSnapshots=true`, then observes those ids
through retained pending custody. Vercel preserves snapshots referenced by another
sandbox; surviving or unobserved snapshots keep cleanup incomplete. This does not
authorize unconditional snapshot deletion or project-wide cleanup.
Vercel bills retained snapshots separately. See [persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes)
and [runtime limits](https://vercel.com/docs/sandbox/pricing#runtime-limits).
The native stdin carrier follows the [official v2 response schema](https://raw.githubusercontent.com/vercel/sdk/main/src/models/writesessioncommandstdinop.ts):
a successful write returns the matching command, while `bytesWritten` is optional.
When supplied, the counter must agree with the cumulative fragment end. An omitted
counter does not replay the write; sequential byte offsets and final command exit
confirmation remain required. The five-hour explicit command-timeout ceiling in
the [OpenAPI](https://vercel.com/openapi.json) is distinct from the 24-hour VM-run
ceiling; current enrollment uses shorter task budgets or omits an explicit timeout.
Same-Machine restoration, confidential enrollment IO and billed-attachment cleanup
still need the authorized Vercel release journey. These are implementation targets,
not functional development support, released support or credentialed
live-validation claims.

In development source, Account erasure, Saved Secret removal, credential deletion,
Account plugin-data erasure and Account plugin-intent disable consult the same
[retained-row read owner](../apps/server/sources/app/machines/managed/managedRead.ts).
Review includes archived and unavailable resources whose allocation is `may-exist`
or `bound`, with native recovery references, controller identity and observed
cost/cleanup facts rather than captured secrets. Every retained credential
purpose participates in this preflight; matching several purposes still projects
one dependency per managed row. Explicit manual responsibility
binds the reviewed intent revision and material allocation, resource, native
operation and recovery facts; observation-only updates do not invalidate it.
Unknown cleanup never establishes that a resource is absent or free. Emergency
credential deletion remains an exact authenticated local credential CAS, without
requiring provider availability or claiming a remote revoke. A changed native
identity during Account blob deletion stops final erasure after access has been
revoked; the existing independently authorized Home administrator owns retry.
The shared development Delete Action also discloses its current captured Machine
reference census on early acceptance and terminal semantic results. Known Board,
Profile, pool and committed-assignment references stay unchanged; partial coverage
is explicit and does not prohibit an explicitly reviewed native Delete. Account
plugin-data erasure settles its Data arm before removing plugin Secret bindings,
using the original captured Home and Account for both arms. A review or unknown
Data outcome preserves those bindings, and retired Accounts cannot disclose late
native review facts.
These are source-owner contracts, not evidence of a completed client approval
flow or loaded-runtime qualification.

In 0.3 development source, the daemon's existing plugin-registry invalidation
bridge advances `daemonState.contributionRegistryProjectionRevision`. The machine
store publishes that change through its existing projection-invalidation
subscription. Workspace, transfer and local-service state updates retain the
revision, so they do not trigger another full projection read. Daemon replacement,
reconnect, Account or locale changes and explicit invalidation still revalidate.
Each projection invalidation names its reason; the parameter is required. A `refresh` (a changed registry
revision on the same daemon, settings changes, a Machine or connected-services
Retry) re-reads while
the last-good projection stays current, and an equal answer publishes nothing. An
`authority` change (daemon identity or endpoint replaced, an observation without
the explicit revision, a replaced plugin occurrence, a stale-generation or retired
dispatch) demotes the Machine's supplies to establishing until the new answer.
Invocation still refuses a stale occurrence, which raises that authority change.
A mounted target read follows the same rule: a `refresh` keeps its last answer
`ready` (so `machineConnectionPending` does not flip and surfaces do not re-acquire)
while it re-reads; an `authority` change withdraws it to loading until the new answer.
Its cross-mount custody is last-good per Account and target: every re-open draws it
at once and revalidates it, `ready` under the same authority and loading (rows kept)
after an authority change. Machine reachability and transport are not custody's
decision; the projection currentness owner decides them and gates interaction.
A real transport loss withdraws Machine presence, which already demotes those
supplies without an invalidation. The app's own supervision restart (a hidden web tab, a
reachability invalidation) is not a transport loss: the last online verdict stands,
supplies stay current, and the next connection re-reads with the last-good answer kept.
The same owner exposes the fact synchronously to the authenticated daemon catalog
reply and publishes a content-free `session.pluginCatalog.invalidate.v1` hint over
the existing Session RPC socket. The reply pairs the revision with the existing
daemon runtime id, so a replacement cannot reuse a retained occurrence's identity.
Session MCP inventories retain their admitted catalog until this fact changes or
the Session socket's existing connection epoch advances. A reconnect rereads once;
concurrent requests share that read. A hint during a pending read cannot mark its
older snapshot current. Retention requires the relay's positive handler-registration
acknowledgement; disconnected or unsupported relays and old replies without the
fact keep per-request reads. Becoming ready rereads rather than admitting a
snapshot taken before the signal channel was established.
Neither the hint nor the retained inventory grants executable authority: plugin
Actions still pass the daemon's occurrence admission at execution time.
Retained Machine state without the optional revision uses the existing broader
daemon-state-version signal until the current daemon publishes its revision.
Projection build inputs include generation and client context;
`web:domIframe` is a browser capability, not evidence of a mounted plugin iframe.

The UI's shared Machine projection acquisition owner classifies an answered
malformed or mismatched reply as `invalid-response`. Automatic currentness readers
settle that typed failure without a retry deadline, including newly mounted readers
of the same Account, locale and projection revision. Real invalidation, reconnect,
locale or Account replacement, and explicit fresh demand may acquire again.
Transient transport failures keep the existing shared recovery cadence; a successful
acquisition leaves no currentness retry timer. Account encryption currentness HTTP
reads are a separate before-disclosure authority check, not projection polling.
Cancellation supplies no new projection fact and does not start an automatic
retry; renewed presentation or a real authority change may acquire again.
AppShell observes retained presentation and already-acquired Machine answers
without initiating describes for the Home's Machine census (including an idle
configured Voice target). Presented Machine surfaces and explicit operations
create demand through the same shared loader; successful answers publish back
to AppShell through the loader's existing scoped subscription.
The presented Machine detail page acquires declarations from its addressed
Machine even when that Machine's plugins are absent from the viewer's Account
installation census, including a Machine shared with Use access. This exact
Machine discovery neither expands the Account census nor selects a plugin's
execution origin; contributed Actions retain Administration's selected origin.
An exact Machine-local installed occurrence can supply that origin through its
real materialization reference when its admitted custody explicitly identifies a
development root or a managed local-path install. It does not need a duplicate
installation in the viewer's Account census. Portable and unknown-custody
materializations retain Availability's release admission.
An authenticated Home reconnect invalidates only that Home's mounted Machine
projections. Their fresh Machine key/access admission shares the existing exact-row
batch reader; another Home's unchanged projections retain their authority.

Full Machine describes in development source accept the optional
`knownProjectionDigest` of the caller's held, Account- and locale-qualified
answer. The daemon resolves current authority through the same build owner and
returns only `protocolVersion`, `unchanged: true` and `projectionDigest` when
the complete response is unchanged. A full response includes its digest; a
changed response still replaces the held inputs normally. The digest identifies
content and never grants currentness or skips Machine key/access admission.
Older daemons ignore the optional argument and return full responses; callers
without a digest also receive full responses. The shared UI loader coalesces
in-flight reads per Account/Home/Machine, locale and requested section set:
newer revisions of that question wait for the issued read to settle, then share
one fresh read of the latest revision. Independent section demands settle
separately, so a cold Agent inventory does not wait for unrelated catalogues.
Results for the same admitted manifest merge into one held answer; a late
partial result retains sections already admitted by another demand. An unchanged
reply reuses the existing admitted inputs and does not serialize the retained
snapshot again. Ready-cache freshness starts at publication after the describe
and its required section reads settle.

Current development clients opt into `deferredSections`: the cold answer is a
digest-only section manifest. First paint requests only its consumed catalogues;
Resume capability readers need Agents, while presented Plugin UI needs UI/browser
destinations, Connected Account descriptors and translation Resource declarations.
Visible Composer chips additionally demand Actions and Composer selections.
Settings, Voice, Automation and other catalogues load at their consuming readers.
The shared loader records section completeness; a full reader cannot reuse a
partial answer. New demand hydrates the held current manifest without another
describe only when its caller permits fresh-cache reuse. Explicitly fresh Action
readers still revalidate with the daemon before hydrating. Each admitted section
still uses the existing strict projection schema.

In 0.3 development source, an open Runs-on picker acquires its presented Machine
projections through the addressed page's `PluginPagePresentation` owner. Its
Account/plugin/page identity survives a loading or unavailable body replacement;
temporary candidate withdrawal does not close that read intent. A physical
presenter can still revalidate a settled failure through the same shared loader.
Closing the picker or leaving the visible page releases demand, and canonical
Account retirement fences every read. Selected-target acquisition remains owned
by the mounted-surface adapter; neither picker custody nor descriptive bytes
grant selection or execution authority.

The same immutable daemon build and per-plugin body spans own these reads.
Machine values also travel by digest, through `sectionRead`; large bodies page
without truncation. A response packs other explicitly requested small bodies only
while the complete JSON frame stays within 48 KiB. This budget comes from ORC's
observed 3.15 MB / 34.4 s ordered transfer and its 1–2 s ping acceptance; it is not
a declaration-size limit. Each request lets the socket service other traffic.
Digests identify bytes and never grant authority or freshness.

Every manifest also carries the narrow `searchProviders` section through the
same deferred body owner. Its Action bodies are selected by the providers' exact
references; it claims only narrow coverage. The existing loader merges it with
other demands and expands to full catalogue coverage when requested. This is
unreleased 0.3 source behavior.

Every manifest carries `sectionFrameVersion: 2`: index frames travel as raw index
text, and body pages as their JSON span array. A manifest without that version,
or a body that fails its digest, settles as `invalid-response` with a
content-free `deferredHydrationRejection` branch name. There is no full-describe
compatibility read and no automatic retry. The span digest, bounded paging and
strict reconstruction owners are shared.

A section digest is the lowercase hex SHA-256 of the body's JSON span array
encoded as UTF-8; the protocol owns that encoding. The daemon hashes with
Node's `node:crypto`; the app verifies with the platform digest owner
(`@/platform/digest`: WebCrypto on web, `expo-crypto` natively on iOS and
Android). The address is byte-identical on every engine.

In 0.3 development source, section pages consume the last complete build for
their daemon handler and client context. Generation or activation-diagnostic changes
do not rebuild that response midway through hydration. A new manifest request
rebuilds from current inputs and replaces that context's complete build.
Explicit reload invalidation forces the next manifest to rebuild while preserving
the completed build for pages already advertised.
If another manifest has superseded the requested section and it is unavailable,
the daemon returns RPC code `plugin_projection_section_stale`. The transport
re-establishes once with a fresh unconditional manifest and hydrates through the
same section reader. A second replacement settles as `projection-stale` until
fresh demand or invalidation, without a retry timer. Cancellation and Account
retirement fence recovery; no history of superseded builds is retained.

Cold Machine reads admit their own manifests independently. Within the existing
Home/Account/locale inventory, readers share verified bytes and pending reads only
for the same content digest, including bodies packed into another requested frame.
A failed or cancelled byte issuer does not withdraw another Machine's authority;
that reader can fetch the digest through its own Machine. Section demand does not
queue behind unrelated Machine hydration. Only bodies referenced by current
Machine answers are retained after pending reads settle; replacement and Account
retirement release them. Unchanged reconnects retain the 124-byte reply.
Corrupt or missing bodies settle as `invalid-response`, never an empty
catalogue.

In 0.3 development source, the active Account Availability reader first reads
machine materializations, then requests `account.plugins.availability.intents.list`
with those plugin ids and previously observed ids as `knownPluginIds`. The list
pages the persisted intent census plus canonical `intent.read`
projections (intent, release, UI Artifact links, package assets and hosting
capability), including explicit null intents for removed or machine-only ids.
The server delegates each projection to the same exact-read owner; bootstrap
does not issue one HTTP request per plugin or maintain another freshness cache.
Individual unreadable projections appear in `failedPluginIds`. A caller that consumes
only intent and release facts sends `omitDeclarations: true`: the CLI execution-selection
reads get no `currentDeclaration` or `machineDeclarations` (11 KB instead of 8.3 MB for 29
plugins on a scratch Account), and exact `intent.read` is unchanged. The reader follows
`nextCursor` before treating the census as complete and sends only the current
page's known-id window plus one lookahead, using the same server page-size owner.
A failed or non-advancing
page preserves admitted materializations and successful reads and publishes
`intentCensusIncomplete` through the existing retry owner. This includes failure
of the first intent page after a successful materialization read. Retained rows
remain stale rather than becoming absent; no total plugin-count or census-byte
ceiling substitutes for paging. Account lifetime,
server generation and superseded-request fences still apply before adoption.
Interactive managed-resource review retains the exact `intent.read` action.
That complete read serves the first load, structural requests (Sync bootstrap,
gap/long-offline snapshot refresh, a declaration claim) and any refresh without
named plugins. An Availability AccountChange names its plugin, and while the UI
holds a complete projection (every Machine readable, census complete) it reads
only the named plugins: `materializations.read` with `pluginIds` (every current
Account Machine, filtered to them) plus one `intent.read` each, merged into the
held projection by its single writer. Other plugins keep their last-good facts;
a held Machine the filtered answer omits has left the inventory, as a complete
read would show. An incomplete filtered answer falls back to the complete read.
Named plugins stay pending until their read is adopted, so a superseded or
failed row-level read keeps them for the trailing refresh.
This is an undeployed 0.3 source contract, not a released wire transition.

Catalog-scale Action, contribution-projection and Account-settings schemas in
development source use Protocol's internal
[`lazyZodSchema`](../packages/protocol/src/lazyZodSchema.ts) construction owner.
Referencing a definition or deriving another schema does not construct its
concrete validator until use; parsing and schema inspection still use the
existing Zod schema and validation rules. Nested JSON Schema traversal delegates
to the concrete schema through Zod's reference handling, preserving references through
optional and lazy wrappers. This is not a second parser or a public
SDK flavor change. The private neutral-to-Zod Action bridge uses Zod's native
lazy combinator because its contract is the base `ZodType`, including recursive
JSON Schema projection, rather than a concrete fluent schema type.
The internal JSON Schema validator reuses compiled validators by admitted schema
identity, separately for draft-07 and draft-2020-12. Each new identity owns a
disposable AJV engine, so retiring that schema and its validator also releases
its generated-code scope. AJV's `removeSchema()` alone does not release that
scope. Unrelated schemas can reuse local identifiers without sharing them.
Normalization re-reads a caller's mutable schema on every use. A schema whose
whole graph is frozen data (an admitted manifest declaration) is proven once,
on its first admission, and later reads of that identity return the admitted
schema; per-dispatch Action invocations then reuse the same validator and parser.
Persistence-only projections use the same internal definition lifetime at
[`json/storedReadSchema.ts`](../packages/protocol/src/json/storedReadSchema.ts).
Recursive derivation waits for the first read or schema inspection, retains
Core/Mini support and the existing known-field checks, and drops unknown stored
object fields. This reader is not request, Action, event or write admission.

An app page's optional shell column has the same destination as its page but a distinct physical mount and renderer binding. The CLI's [UI projection producer](../apps/cli/src/plugins/projection/registry/ui/projection.ts) admits that column binding through the existing Protocol destination normalizer. UI projection and the app-page catalog carry it unchanged; the surface mount reader rejects renderer or plugin identity mismatches rather than retargeting the page's binding.

In 0.3 development source, generated hosted-web renderers keep the server-issued
opaque frame for plain Accounts. E2EE web instead consumes the selected
`hostedWebArtifactLease`: exact app bytes, verified persistent cache, daemon
sources, then encrypted Account hosting, in the existing source order. Account-hosted
bytes need no Machine and are opened only on the client. The verified graph feeds
the existing multi-file HTML document/frame owner; its lease still owns selection,
Account retirement and pushed revocation. Portable declarations and the CLI share
one Protocol hosted Artifact-entry projector. A compatible selected Artifact with
unknown physical frame support may reach mount admission; a client's known-absent
adapter still selects its declared renderer fallback, including React Native.
The physical host does not add a hosted-web feature gate to these existing
transports; plain Account server-frame admission remains unchanged. Existing
producer-owned feature decisions still apply to their declared renderers.

Artifact content integrity is checked when external bytes are acquired or
written to the admitted local store. App-bundled and already admitted persistent
bytes are not rehashed on each lease, descriptor, native registration or serve.
Readers retain selected-graph correspondence, Account/path confinement, required
file presence and size checks. Raw daemon/Account-hosted acquisition and native
current-load registration still verify their incoming content before adoption.

That generated document uses a separate nonce profile at
`artifacts/artifactHtmlDocumentV1`: the host mount nonce authorizes its trusted
bootstrap/import map and the HTML script elements backed by verified JavaScript
assets. It intersects that execution policy with the existing no-network content
CSP, whose data-only script URL ceiling also constrains nonce-bearing requests
and module descendants. Neither policy can bypass the other. Authored markup
without an authorized nonce, inline event handlers and literal `eval`/`new Function`
are denied. **Known, accepted difference from the plain server frame:** E2EE web
generated plugin frames permit runtime code creation inside their own opaque
sandbox. Authored code can read the nonce, create nonce-bearing scripts and import
`data:` modules. Trusted plugin server frames have no script-source restriction; these
code-execution policies are not equivalent. This grants no frame, network or
host-storage escape: workers, forms and network egress remain
denied, the trusted frame shell denies guest document-navigation egress, and Host
API access stays limited to the plugin's own grants. Data URLs carry local
resources or sandbox-local code, not a network grant. Generated input qualification
preserves compiler-owned portable filenames
and exact URL decoding; caller-authored HTML's path grammar and CSP are unchanged.
The sandbox stays opaque and the existing exact-window/document-channel bridge
remains mount-scoped. This is a source contract, not release or loaded-page proof.

Plugins are trusted, unsandboxed code (owner ruling 2026-10-29): Happier puts
no egress, endpoint or DNS ceiling on plugin-authored pages. Remote plugin entry URLs still require HTTPS or
loopback HTTP to protect the bridge from network attackers. Plugin declarations
may enable eval, data/blob resources, connects and navigation without a separate
restrictive-policy admission gate or a native development-channel exception.
Served plugin assets keep the host-derived `frame-ancestors` boundary and mixed
transport protection, without plugin resource restrictions; declared source maps
are ordinary assets. Bridge origin, nonce and instance validation stay intact. Artifact HTML written
by agents or other people additionally gets an egress ceiling, because that
content must not exfiltrate E2EE plaintext. The `buildArtifactHtmlDocumentV1`
owner applies it by default, and only plugin UI opts out (`pluginAuthored`, set
by the plugin hosted-web pane for both inline documents and the plugin's own
bundler-built generated UI). Generated plugin documents retain the separate nonce
profile described above; they are not agent-authored or shared Artifact HTML.
Trusted plugin pages also retain nested browsing contexts; the nested-frame refusal belongs only to untrusted Artifact and caller
HTML. The ceiling removes native RTC peer/data-channel
entry points before authored code and makes their bindings non-writable and
non-configurable. It removes static `dns-prefetch`/`preconnect` link hints
during parsing, and synchronous DOM admission refuses their creation, insertion
and later relation mutations (including attribute nodes and token lists). Every
markup producer (`DOMParser`, contextual fragments, HTML setters,
`document.write`, editing commands, XHR documents, XSLT, customized built-ins)
also refuses nested-frame elements, so no nested realm regains RTC. CSP alone is
not an ICE/DNS no-network boundary; neither a DNS-prefetch opt-out header nor
meta markup blocks explicit DNS or preconnect hints. URL-served plugin pages
(the plain-Account Artifact frame and the daemon's loopback static-asset server)
are served byte-for-byte without this ceiling.

In 0.3 development source, native surface loading awaits the Artifact loader's
outcome. Acquisition can await persistent storage before the daemon byte RPC,
then verify and materialize those bytes; the renderer does not impose that
RPC's deadline on the whole composition. Actual loader failures retain Retry,
and retired mounts or Artifact identities cannot adopt late results. A pending
load is not evidence of a plugin crash or of an unknown Action outcome.
The surface disclosure fence distinguishes a pending Account-mode read from a
terminal refusal: it shows loading while withholding context, and shows an error
only after refusal. An ineligible or retired mount reports unavailable, not a
pending read. The shared surface and Composer scope hooks reconcile currentness
on each render, including transitions behind a stable callback; a ready scope
does not need a catalog refresh or callback replacement to start disclosure.
This adds no deadline to the canonical Account-mode reader. A cancellable
Account-selected Artifact acquisition also
waits for the initial Availability projection before reading bytes. The existing
Account lifetime and mount signal retire that wait; a retired native load cannot
quarantine healthy bytes or latch an error onto its successor mount. A loaded
projection's actual selection refusal remains fail-closed.

In 0.3 development source, the selected Artifact lease owner shares in-flight
acquisition by digest within the captured Account lifetime and removes each
flight when it settles. Inventory refresh, occurrence replacement and surface
remount recheck admission and read retained bytes through the existing byte
custody owner. React Native acquisition also reads the complete verified file
set already held by the existing executable cache, qualified by Account and
digest, including on hosts without persistent storage. Exact byte eviction,
projection withdrawal and Account retirement still invalidate that cache;
missing bytes are acquired again through the canonical source order. Retiring one reader cancels only its
work; a surviving reader can supply the same digest through its own current
source. Cached bytes do not grant execution or let a contradictory declared
file graph pass integrity.
Surface-only Artifacts are acquired by mounted surfaces; client Action and Voice
bundles also serve AppShell executable activation. This is source behavior,
not a claim that an already-loaded client has received the change.

Daemon UI Artifact bytes in development source use the existing prepared finite
export, with `plugin_ui_artifact_download_v1` carrying the exact family and digest
request. The canonical carrier prefers usable Iroh direct/relay and otherwise
uses Home encrypted RPC phases. Artifact downloads explicitly retain their
existing Home reachability on native and desktop hosts through that same route
owner; other transfer families retain their existing host policy.
Preparation returns metadata; the complete file
set travels in the transfer owner's bounded encrypted chunks, rather than a
whole-artifact socket ACK. Chunk sizing remains with
[`transferRuntimeConfig.ts`](../apps/cli/src/machines/transfer/transferRuntimeConfig.ts),
and the existing destination downloader verifies the declared total size and
transfer digest before the Artifact reader admits its strict response. The
whole-artifact byte RPC has no live handler. Account-partitioned digest custody,
Artifact integrity and current selection admission retain their existing owners;
retained browser bytes survive reloads without a TTL or a new transfer/cache path.

In 0.3 development source, the app-preseed publisher retains one UI-only
declaration per first-party plugin together with its exact compiled Artifact
graphs. Account Availability admits those bundled Account destinations without
a daemon report or a prior release-less Collection claim. Explicit Account
disablement or a portable release selection takes precedence; a current trusted
development source retains its existing authoring selection. AppShell publishes
the selected host digests through the existing scoped cache projection owner and
uses the canonical Plugin UI feature decision. Cache and app-package bytes still
pass exact graph and digest verification. Machine Actions and Resources remain
bound to Administration's admitted daemon origin; the host declaration grants
neither machine execution nor a Collection writer.

Rendering and execution placement are separate in 0.3 development source.
Portable installed UI uses the Account-selected release/digest, bundled Account
pages use the admitted app declaration/digest, and explicitly selected trusted
development UI keeps its source. A development byte supplier alone cannot replace
the bundled Account UI: that requires the explicit device-local Administration
choice matching the current development origin. A missing Run-on Machine or a pending optional
contribution-point inventory does not make the Account page inert. The mounted
controller continues to fence Machine Actions and Machine-owned Resource reads
with the current exact operation origin. Byte suppliers are independent: the
existing daemon Artifact source can ask other suppliers of the selected digest,
and all returned files still pass the same lease verifier. A supplier never
becomes execution authority.

Account-mounted Views, Settings pages and targeted source contributions retain
their Account caller custody when invoking through an admitted Run-on Machine. Both daemon Action ingresses
validate that caller against the current Account declaration; host Action
delivery preserves the declaration version and digest. The authenticated
requester's Account selection remains separate from the Machine custodian's.
The daemon reads bundled Account declarations from the canonical bundled manifest
catalog, independently of any development or path source on the Run-on Machine.
That Machine source still owns the target's Action and Resource execution.
The existing supplier projection carries each surface's Resource capability,
and Administration's selected supplier supplies both that capability and the
Resource transport occurrence. An Account renderer or an unselected sibling
cannot grant Machine Resource access. These are 0.3 development-source mechanics;
loaded-runtime validation still requires the updated UI and daemon.

The surface's existing machine-requirement owner decides which capabilities
need Run-on. An unavailable explicit local target retains its Machine name in
those states. Optional setup and contribution-point reads may be unavailable
while the enclosing Account Collection remains interactive; renderer interaction
and Account Data admission do not inherit Machine reachability.
In 0.3 development source, Machine inventory retains the eligibility of its
last opened live content while a newer content hint is pending. This preserves
the selected producer and its in-flight targeted read through pending-to-opened
updates when the origin and occurrence remain valid. Fresh invocation still
requires current opened content; locked, missing, revoked, replaced or offline
Machines do not gain eligibility from this presentation retention.
A structurally supported native Host API method reaches that controller for its
current unavailable result and target explanation; the renderer adapter does not
replace that decision with an early generic refusal.
In development source, a failed mounted-target read also carries its deciding
code and explicit retry classification through that same Host API boundary.
A target-read timeout keeps `targeted_contributions_timeout`, with the existing transport explanation and diagnostic;
it does not claim that the selected Machine lacks the operation. The Account
renderer remains interactive, and successful target discovery removes that
failure without replacing its controller. This adds no retry or RPC deadline.
The closed mounted error payload retains layer, phase and retryability. Both
physical transports project layer and phase into the existing SDK
`PluginError.details`, preserving the deciding code and the shared reason copy.
Resource snapshots retain those SDK details as well. Contextual and mounted
Resource read/watch request failures preserve the transport owner's code and
retry decision; a Resource RPC timeout is an invocation failure, not an Action
receipt-loss marker. A nonretryable Resource read settles without re-polling.
Absent retry evidence is conservative; a lost receipt after issue never proves
that repeating an effect is safe. Ordinary Action JSON with a `code` member is
still domain data, distinguished by the producing owner rather than its shape.

The existing ephemeral UI sharing scope also remains available without an
execution occurrence. In that case it uses the selected immutable Artifact digest
under the current Account/plugin lifetime; this is presentation identity, not
fabricated execution custody. Machine-owned reads can therefore leave loading
and show their unavailable state while the Account shell stays mounted.
Client Action registrations retain that same admitted Artifact digest from their
activation. Renderer and Action acquisitions use the shared-scope owner's one
identity rule, so borrowing an editor's state cannot retire its renderer scope
by substituting the executable occurrence. The raw occurrence remains the
registration and Action currentness authority; the digest is only sharing identity.

In 0.3 development source, that same scope advertises optional
`acquireExecutionBound` for values that must share only within one admitted
execution authority. Within an Account-admitted plugin generation that authority
is the generation itself: a mount placed through a Session's Machine projection
and an Action resolved from the Account catalog find the same value. Without an
admitted generation, sharing is qualified by the full host-held origin, including
source custody or materialization. Renderer and client registration occurrences may
differ; sibling Artifacts share executable bindings through that admitted plugin
generation even when both their occurrence ids and byte digests differ. Without
an admitted plugin generation, sharing stays confined to the raw occurrence. A facade
carrying both identities binds each namespace when it is first acquired, so an
Action borrowing a mounted callback does not replace the renderer's presentation
scope. Triage's mounted operations and source-panel callbacks use this
execution-bound acquisition. It discloses no
credential material and refuses mounts without an admitted origin. Consumers
requiring this operation stay unavailable when an older scope omits it; hosted
frames without a sharing scope retain their own local lifetime. Credential
selection and its invalidation remain the invoking domain's admission contract;
execution-origin equality alone does not prove credential equivalence.

Optional Account hosting no longer waits for its network upload before verified
React Native or native hosted content can render. The existing publication helper
first captures the complete verified file snapshot, then the existing Account
publisher retains that snapshot until publication or cancellation. Disposing the
renderer lease cannot invalidate those files. Actual mount cancellation and
Account retirement still reach the publisher; a short acquisition/adoption owner
does not cancel a successful renderer's upload. Hosting failure appears separately
from the usable content. Account encryption and qualified publication remain
client-owned; no E2EE publication custody moves to a daemon. These are development
source contracts, not evidence of release availability or loaded-platform QA.
Both RN acquisition and native hosted acquisition pass the outer mount's signal
to publication separately from the short acquisition lifetime, and expose the
publisher's completion through their existing Artifact handles.

In 0.3 development source, the projection contract uses the canonical
`executionOrigin` envelope for rows, package occurrences and embedded mounts.
Installed releases use the install registry's materialization reference;
bundled/development occurrences use exact runtime source custody. Administration
resolves that exact identity for an operation while its persistent device-local
Run-on preference retains only Home and Machine. Protocol equality does not equate a source with a
materialization. The UI reads producer identity without reconstructing it from
custody metadata. Projection and invocation share the CLI's canonical origin
composer. Daemon plugin callers also carry the host-resolved `executionOrigin`
when available. Channels projects that host-stamped origin to Home/Machine/plugin
routing for provider callbacks and retains only Home/Machine placement alongside
its separate provider plugin/contribution. Retained connections follow the current
admitted same-ID provider there, including reinstall or source substitution;
custody-only changes require no transfer, setup rerun, or authority-epoch bump.
Endpoint and principal resolution obtain each operation handle from that current
contribution owner. Same-ID reloads preserve native identity proof; exact
connection revisions, placement, credentials and selected recipients still apply.
Setup resolves the current connection-test role after the setup operation and
keeps its proved transport placement. Retest retains a completed native readiness
observation across a same-ID reload, and resolves the current role before any
subsequent setup; it does not repeat the observation in a reload retry loop.
The generic Action executor enforces `expectedExecutionRouting` before provider
handlers through Protocol's shared routing projection/equality. Origin, routing
and caller currentness are decided once at admission: an executed handler's
result is returned with the origin it was admitted on, even if that origin or
the caller retires while it runs, and the next call naming the retired origin is
refused before any effect. A callback needs a complete host-stamped origin,
because a materialization alone supplies no Home proof. Full `expectedExecutionOrigin`,
approval/terminal admission, and durable webhook endpoint exact-materialization
contracts remain unchanged. Routing continuity does not automatically repair
an endpoint's physical target; real placement/transport/credential/config changes
retain Channels' transfer and endpoint-convergence owners.

The unreleased 0.3 Channels provider descriptor optionally declares `pullRequests`:
native repository kind/deployment, URL template (`{repository}` then `{number}`),
repository connection-key prefix and publication instructions. The single admitted
PR-capable contribution supplies these facts to link, relation and Watch paths;
GitHub owns its native reply Action guidance. Native credential calls still require
the host-stamped plugin execution origin and exact selected contributor identity.
Channels retains relation storage, Session admission and Watch orchestration.

In unreleased 0.3 source, Channels reconciliation derives shared-content demand
without requiring equal Account change cursors across connection and binding
pages. Placement and per-admission authority remain the deciding boundaries;
the next existing reconcile pass repairs a raced demand projection. Delayed input
reads current binding policy at dispatch, including the sender allowlist, bot and
addressing rules, endpoint and target. Its own obligation CAS retains admission
custody; unrelated connection or binding revisions do not revoke admitted work.
Each outward send claim reads current connection and binding policy once, and
its native chunks finish without repeating that policy read. The binding epoch
remains part of the exact `connection:binding` permission-mediation source stamp,
so retained pending requests and grants keep their existing identity. Retained
Session-projection deliveries also keep that binding stamp because their stored
semantic item identity cannot establish replies-only eligibility after a delivery
mode change. Other dispatch and outward-route checks use current policy rather
than a frozen revision or epoch. Labels, sender feedback, debounce and link-preview
changes retain the stamp.
Durably captured input waiting for its debounce deadline is checkpoint-safe;
the existing ingress due-work owner dispatches it without another provider poll.
A locally cancelled outward claim before provider I/O returns to ready while its
host storage lifetime remains admitted. Custody settlement does not borrow that
local cancellation signal; lookup and admission reads remain cancellable. Actual
host retirement aborts storage's lifetime before cleanup: attempting claims use
the existing visible outcome-unknown recovery and are never automatically resent.
Discord and Slack keep their existing socket workers through transient list/read
failures and retry through the incumbent reconciliation deadline.
Discord also retains a healthy worker when publishing its queued transport fact
fails; the existing reconciliation owner retries the fact without replacing the socket.
Pairing freezes the connection's existing authority epoch with its selected
endpoint, principal proof, route and target. Finalization rereads that authority
and asserts the latest Collection row. Freshness, presentation and gap-notice
revisions do not invalidate proof; credential, principal or route changes do.

The approved, unreleased Channels c0.78 history-recovery contract keeps
`ConnectionHistoryGapFact` at that connection lifecycle/CAS owner. The first
current-epoch reason, timestamp and bounded diagnostic remain visible as a
notice; they do not fence provider list/read reconciliation, observation
admission or checkpointed polling. Account, credential, route, recipient,
trust and invocation-currentness checks still apply. An actually invalid
provider cursor automatically uses the existing core ingress/checkpoint
baseline path to start from the current point and skip existing items,
retaining the notice. `stream/notice-dismiss-v1` dismisses the notice
without changing the cursor; it is not permission to resume ordinary work.
If that recovery attempt returns another history gap or a replay batch,
the canonical poll-failure owner records a retryable
`channels_checkpointed_poll_baseline_required` failure and uses its existing
backoff before attempting recovery again. It does not block polling until an
owner intervenes or poll the rejected cursor every second. An ordinary batch
without an established first baseline remains a separate permanent refusal.
Untyped poll Action exceptions use the same automatic backoff; they establish
no permanent provider refusal. Retained generic Action-failure blocks resume
through this poll owner, including after a daemon reload. Typed permanent
refusals still require the existing repair/Retry Action. A successful native
history-gap baseline clears the poll failure while retaining the visible notice.
Compatible checkpointed-pull transfers preserve both the saved cursor and any
existing notice; the notice alone does not require a new baseline.
The notice states that earlier items may have been missed and offers dismissal
only. Providers report native continuity facts and never own a second checkpoint
or gap policy.
Routine Slack Socket Mode refreshes are not gaps; Telegram checkpoint age or
clock skew preserves a valid saved offset with a notice, while an invalid or
new-sequence offset requires the automatic baseline. GitHub timestamp ties
and page traversal retain `since` plus immutable-ID ordering; only a lost
ordering boundary requires that baseline. IMAP UIDVALIDITY changes and
UIDNEXT regression likewise invalidate the old cursor. Dismissing the notice
does not recover the missing interval. These are development-contract statements,
not released availability or loaded-provider evidence.

Session transcript projection follows the same notice-only contract. Its sole
projection owner automatically walks the existing external-shareable transcript
to the current tail without delivering old items, retains the first gap notice
with the recovered cursor, and projects future items normally. The
`binding/session-projection-notice-dismiss-v1` Action only unwraps that current
cursor under the binding/frontier CAS; it never reads a newer tail or authorizes
recovery. A retained notice without a recovered cursor stays visible while the
projection owner attempts recovery; dismissal reports recovery pending instead
of inventing a cursor. During recovery, transient read failures and publication
barriers retain the supervisor's existing recovery deadline; a nonretryable host
refusal keeps its reason code and does not create a timed retry. Outward replies
check owner settings at their send claim;
already-claimed native chunks finish unless cancelled or refused by host Action
admission. Later owner changes apply at the next delivery claim.

Channels' outward supervisor in 0.3 development source carries the bound
Session's binding identities from its existing observation into the delivery
cycle. Activity-only events do not request permission or transcript reads;
message and changed events select only that Session's bindings. Subscription
membership holds identities only, never binding policy or admission decisions.
Connection and binding changes, including Collection reset, retain structural
discovery. Input-publication hints use the existing Session/kind index to wake
the affected bindings; projection-frontier writes do not feed discovery back
into itself. Delivery hints still scan durable custody, including externally
written work, without requesting unrelated binding projection. Recovery carries
the affected binding ids through the same existing wake/deadline owner.

In unreleased 0.3 source, the Session conversations Resource also publishes
typed `externalConversations` display facts: binding identity, channel plugin
and conversation display name. It reuses the already-read connection projection;
these facts confer no routing or posting authority. New inbound conversations,
including unbound ones, submit a stable conversation-keyed item through the
existing notifications service and private Inbox notice store. The new
`inbound-conversations` category is distinct from the published
`external-conversations` Session-info section. The item opens Channels, carries
no message or principal content, and requests no native notification channels.
Equal submissions remain the notice owner's deduplication responsibility. A
notice-write failure is logged without reopening admitted ingress. The
notifications owner replays the same request's result within an occurrence;
a later message after occurrence replacement can retry the same item. Channels
adds no retry store or timer. This is not released or loaded-runtime evidence.

In unreleased 0.3 source, thread observations first select exact endpoint
bindings, including disabled bindings; otherwise they select same-audience
parent mailbox/channel bindings for every target. Session, Discussion and
Workflow targets receive the thread message directly. Only a thread-router
parent creates a Session and child binding. Outward replies retain the input's
thread endpoint and message relation through the existing delivery custody;
Email's explicit start operation still creates a new thread from its mailbox.
`ingress.ts#bindingsForEndpoint` owns exact-before-parent selection and
`bindingEndpoints.ts#matchesConversationBindingEndpoint` owns the endpoint
relationship. A router only spawns for a child `thread` whose `parentId` matches
its endpoint; top-level channel messages do not launch Sessions. The
[published binding support matrix](../apps/docs/content/docs/extending/channels.mdx#binding-support-in-development-source)
records the target/integration combinations and their content, start and command
limits. These are composed adapter behaviors, not a generated manifest capability
list: Slack files and new-thread starts are refused, Telegram ordinary replies
are not topics, and GitHub issue/PR endpoints do not produce router child threads.

In the same unreleased source, PR attach/rejoin resolves endpoint and principal
using the current attach's admitted credential and execution origin, including
when another Machine already owns the repository connection. The request-local
`resolutionConnection` in `management.ts#manageSessionPullRequestBindingForInvocation` leaves
the persisted connection's credential, transport placement and Watch unchanged;
Channels remains the binding writer. The native CLI Account-to-Machine Action
adapter cannot present a live-only child confirmation while waiting on that
same RPC. It withholds that presenter, so the existing current-intent owner
returns `plugin_action_current_intent_unavailable` before publishing an approval
or running the handler. Present-person UI confirmation and ordinary deferred
approval paths retain their existing owners.

In unreleased 0.3 source, a Channels binding can also target a Discussion.
Settings creates and edits that target through the existing binding Actions;
Session, Workflow and thread-router targets retain their own policies. Channels
admits the external sender at dispatch before calling `discussion.post` under
the binding Account's existing Discussion access and Action approval settings.
The normal Discussion writer seals the optional `externalSource` display fact
inside the message content envelope; display provenance grants no authority.
Mixed and file-only input fetches bytes through the existing Channels file-input
owner and supplies native `attachmentSources`; the Discussion writer owns binary
upload and E2EE sealing. The native plugin Actions adapter retains its existing
approval continuation for local upload sources, so cleanup follows the approved
writer rather than leaving detached approval with expired temporary paths.
Workflow admission currently accepts text only, so any
file input is refused in full with `unsupportedContent` and sender feedback.
Successful native acceptance releases the occurrence's message content only
after all its destinations settle. Retry uses the same Discussion local id.
External threads use an exact native local-id lookup: the first input is the root
and later inputs name it with `replyTarget`. Its sealed `externalSource.inputLocalId`
retains original ingress correlation for outward replies; it is never access
authority. Other threads retain separate roots, without a Channels thread store.
Discussion replies rooted in that binding's inbound message use the normal
Discussion reader and the canonical message-parts projection exposed by
`@happier-dev/plugin-sdk/protocol`, then the existing Channels outward custody
owner; unrelated and inbound messages are not echoed. The shared projection
also retains Workflow result summaries and Doc reply text instead of silently
discarding those message variants.
There is no second Discussion writer, delivery pipe or message archive. Source
composition tests are separate from the QA-owned live connection journey.

Discussion posting access also permits an outward reply through another
participant's Channel when replying to that Channel's imported thread (owner
ruling, 2026-11-10). View-only access gains no posting authority. The Channels
destination reader distinguishes presentation from routing: the server keeps
foreign message local IDs private, so shared approval presentation follows
readable sealed `externalSource` provenance and uses the imported author's public
Account profile and admitted integration descriptor where available. Own-Account
messages use the same readable provenance; only historical messages without it
retain the exact local binding/connection name reader. Shared presentation never
reads another Account's bindings or connection names. Both page and inline
approval cards consume the same destination result. Missing names show
Unavailable while optional display reads are pending or fail; no projection
grants send authority.
Pending imported `discussion.post` approvals use the shared approval title owner
in Inbox, Needs you, the review page and retained views. The title reads sealed
conversation provenance before publication, with public integration package and
Account names from their scoped presentation owners; it never reads Channel
bindings or copies message bodies into the row. Authored titles remain authored.

Channel Session inputs carry the immediate sender's readable name separately
from an optional source `displayNameSnapshot` (Channel kind and conversation
title). The shared Channels ingress producer reads the admitted provider
descriptor and binding endpoint name for both ordinary input and a new Session's
initial prompt. The host copies this descriptive snapshot into durable
`pluginSession` provenance. Transcript bylines consume that snapshot and use a
generic integration label when it is absent; raw plugin ids remain technical
identity. These names neither select a destination nor grant approval authority.

In unreleased 0.3 source, `actions.getCurrentExecutionRouting()` reads the
invoking plugin's own current Home/Machine/plugin routing through that same
caller-origin owner. It returns null when current origin evidence is unavailable;
older hosts omit the optional read. Channels fails closed in both cases and
compares this stamp with the retained connection placement before polling,
projecting Session replies, or claiming, reconciling or settling outward custody.
Retirement also checks placement while the connection exists. After connection
deletion, the existing retention owner retires only eligible terminal custody at
the unchanged thirty-day cutoff, using the same exact-revision CAS.
The provider Action's target-routing check still runs before provider
effects. Account-wide visibility alone does not place work on a daemon.

Outward recovery in 0.3 development source reconciles the original attempt;
elapsed time never replaces its identity or proves completion. Missing or
inconclusive provider evidence keeps outcome-unknown attention and releases
automatic ordering without resending. A late original completion can settle
that same attempt as delivered, partial, or known no-effect. Only a completed
known-no-effect result may restore its still-held admitted content for safe
retry, through the existing custody CAS and exact keyed-fingerprint comparison.
An owner resolution or a different attempt cannot be overwritten by that
completion. No recovery timer, attempt registry or second delivery owner is used.
The private deliveries Collection keeps the bounded original attempt id while
that completion remains possible; completed ambiguity may retain null. Its
version-4 schema uses the canonical version-3-to-4 identity migration so existing
rows remain unchanged while installed Collections adopt the corrected schema.

Discord's explicit worker stop awaits actual Gateway teardown. Caller cancellation
returns `pending`; the existing exact-predecessor completion/report path can still
confirm stop afterward. Elapsed stop time supplies no quiescence evidence.

In unreleased 0.3 source, background services invoke provider Actions through
the same host-stamped caller and currentness checks as other plugin callers,
including installed plugins. Registry shutdown, occurrence retirement and
invocation cancellation interrupt a checkpointed poll without persisting a
connection block. The next daemon or eligible poll resumes normally. Existing
stored blocks still use the connection's **Retry polling** Action; they are not
cleared merely by restarting. If an approval decision was saved but its reread
was temporarily unavailable, target Action settlement returns
`approval_context_unavailable`. Replaying that same approved Artifact while its
admitted source and authority remain current reuses the decision and claims
execution before any effect; it does not create a new approval. An existing
execution claim retains its unknown-outcome protection.

In unreleased 0.3 source, checkpointed observers share
`runCheckpointedPluginEventObserverV1` at the daemon-only SDK
`background-services` entrypoint. The runner compares current source assignment
with the background context's own host-stamped `materialization`; absence or a
mismatch refuses provider and checkpoint effects. A plugin caller's
materialization is not that execution stamp. The runner owns catalog adoption,
one interruptible eligibility wake, invalidation/cancellation and all-safe
checkpoint progression. Finite adapters retain provider clients, pagination,
closed codecs and existing cursor/CAS storage. Equal/no-event observations do
not launch user work, and a healthy empty catalog has no polling timer.

In continuous mode, an admission awaiting person approval retains its original
observation and checkpoint. An adapter may set `observeWhileAdmissionPending`
when further observations preserve that candidate until save; otherwise that
source waits for admission settlement. The health adapter opts in so advancing
provider deadlines may publish current health without opening a second admission
or replacing the retained candidate. For an opted-in source, admission settlement wakes
the same runner, which saves that candidate before the next observation; removal
or cancellation discards late checkpoint effects. A buffered immediate drain that
cannot advance before admission settles waits for settlement or an authenticated
wake. Finite `once` mode still awaits admission and checkpoint completion.

The Account change-feed producer marks credential/settings-only Host Event wakes
with `definitionsChanged: false`. The observer retains its existing adopted
catalog for those wakes and provider eligibility cycles; it confirms definitions
on initial adoption, definition/release/endpoint changes and reconnect or gap
recovery. Failed catalog reads retain the refresh obligation for the existing
retry owner. An omitted flag retains full invalidation semantics. This optional
closed Host Event field is an unreleased 0.3 same-daemon Protocol/SDK contract;
matching development readers are required, with no server wire or stored-format
change. Credential wakes still unpark unavailable sources without shortening a
numeric provider deadline, and withdrawals apply at the next catalog boundary.

Catalog reconciliation reports `current` or `reconciling` with its actual scan
start and adapter-owned retry eligibility. Elapsed scan time adds no diagnostic
deadline. The existing server projection reads retained development
`reconciliationLate` rows as `reconciling`, preserving their scan and retry
facts without rewriting storage.

The same finite processor, `processCheckpointedPluginEventAttemptV1`, runs
inside GitHub's incumbent Account-bound target Action so provider credentials,
notices and checkpoint commits retain that operation's custody. It does not
introduce another loop or checkpoint store. Finite reset Actions reuse the
catalog pager through `readCheckpointedPluginEventSourcesV1`. See the
[author guide](../apps/docs/content/docs/plugins/guides/background-services.mdx#observe-a-checkpointed-event-source).

The existing Event disposition retains each exact server admission result
with its observation identity, selector and transport scope through that same
processor/save path. Checkpoint-safe skipped Events may persist notice or cursor
facts, but only a matching actual `admitted` or `rejoined` result authorizes
admitted-only work. Missing metadata and unsettled attempts fail closed; the SDK
does not create a second launcher or infer admission from checkpoint safety.

A plugin module runtime failure while decoding provider content surfaces as
that provider's retryable failure, never as a fabricated anonymous observation;
only content the codec rejects becomes a terminal non-admission. The Email
channel's behavior is documented in `apps/docs/content/docs/extending/email-channel.mdx`.

In unreleased 0.3 source, Channels' existing testkit also owns the reusable
`defineProviderConformanceJourneys` suite in
`packages/plugins/channels/src/testkit/providerConformance.ts`. The native
Telegram, Discord and Email adapters are exercised by
`packages/plugins/channels/src/providerConformance.test.ts`; Slack uses
`slackProviderConformance.test.ts` beside it. A new adapter
(including Slack Socket Mode) supplies its registered provider, retained
connection fixture and host execution origin; native message constructors and
captured outbound request fields; parent/thread endpoints and immutable actors;
baseline, continuity-loss and recovery drivers; and its declared native text
limit, if any. `receive` must pass native events through real provider codecs
and the existing journey fixture's poll or authenticated ingress entry. `gap`
must derive provider continuity-loss evidence rather than write core status.
The suite owns admission, replay, router children, reply projection, native
chunking/currentness, mention suppression and provenance assertions. Adapters
never reproduce those decisions. Optional native adapter facts distinguish a
thread-root reply relation from the source message ID and bodyless unsupported
shared attachments from providers with authenticated forwarding provenance.
Native acceptance hooks permit authority
revocation between chunks. Extra topic vectors supply only native inputs and
expected addressing; provider-specific edge cases remain in their owner suites.
An unmet fix dependency must stay explicitly pending with its lane pointer,
never disappear behind a silent skip. Email declares no native text limit, so
its journeys prove a single long delivery and pre-effect revocation instead of
inventing a chunk size. The existing protocol `testing/v1` manifest/schema
checks and CLI host-composition fixtures keep their own distinct boundaries.

In 0.3 development, connection management projects the connection-owned
`configurationRevision` as `revision`. Owner edits and transfers guard that
logical subject. Retry and Retest take only the connection ID and operate on
the current saved connection; the caller supplies no revision or authority epoch.
Transfer takes the existing revision witness without a second generation witness.
Poll failures and
readiness observations preserve it; actual configuration changes and changes to
history-gap recovery advance it. Disabling or transferring a connection does
not wait for provider stop proof. Deletion retains `finalizingDelete` only to
resume bounded relation cleanup and settle already-attempted sends honestly.
Every storage write still uses the
latest exact physical Collection revision. The channel-state V8→V9 migration
seeds retained connections from their physical source row revision; fresh
connections start at 1. No first-write capture or parallel revision owner exists.
The daemon producer and UI consumer must use the same envelope
contract; a moving development UI paired with a pre-migration daemon rejects
old flat artifact stamps as an invalid response until the daemon is reloaded.
Availability materializations qualify source admission independently of source
identity and do not require plugin activation. A targeted detail whose origin cannot be stamped
returns the existing typed mount-unavailable result and a daemon diagnostic,
rather than publishing its handle with no executable mount.
A daemon-selected plugin's release-less Account
declaration supplies server currentness for Collections, webhooks, Events and
Machine provisioners. In development source, Availability retains these
declarations per authenticated Machine installation in the existing intent
record. A claim replaces only that Machine's declaration, including equal-version
localPath edits; plugin version does not order declarations across Machines.
Webhook and Event currentness reads select the executing Machine's declaration.
Account reads derive `machineDeclarations` from those entries; a single
`currentDeclaration` exists only when they agree. Account enablement changes
preserve the entries, while selecting a portable release displaces them.
The daemon's Availability publication lifecycle claims
these admitted declarations through the existing Account Data host after
reporting materializations, including native-only plugins without Account storage
HostAccess. Startup, reload and reconnect reuse that claim owner without activating
native leaves or granting storage access. Declaration currentness is
not install-registry projection authority. The runtime's current-materialization
getter retains that declaration identity for Account operations. In 0.3 development
source, app UI visibility is the Account union of proven installed declarations,
independent of execution selection. Availability owns the installation census;
the UI projection union retains each supplying installation. Execution conflicts
compare current supplies with execution authority, excluding retained offline,
establishing, disabled or untrusted copies. The execution owner prefers supplies
matching the rendered release; differing versions require a choice when none is
compatible. Content and renderer compatibility admission remain enforced before
automatic selection. While a required choice is unresolved, an otherwise available page
has host-derived resolving availability and uses the shared loading presentation;
it is not a terminal installation-conflict denial. This host state is not a daemon
wire availability value.
An exact origin selected by Administration resolves that conflict by publishing
the selected producer's whole declaration and package facts. Shared contributions
retain their supplying origins; entries exclusive to another replica are excluded.
The selected occurrence and release version also bind renderer bytes to that
producer. Machine-local sources remain selectable from their own currentness and
trust facts even when another Machine reports different web artifacts; portable
release content admission remains Availability's responsibility. In 0.3
development source a republication of one `pluginId@version` must carry the same
archive digest and facts. Differences in empty contribution lists are ignored, and
a compiler graph for an existing UI slot is added and never removed; any other
difference stays `plugin_release_content_conflict`.
Missing portable descriptors remain preparing while their immutable release is
read. In the unreleased 0.3 installed reader, omitted release-less manifest and
UI declarations settle as unavailable: the persisted census has no producer for
that source-bound content. This does not prove absent capabilities or an empty
UI declaration, and later live daemon declarations remain usable. Reporting an
installation does not enable Account intent, establish trust, or grant execution.
With an explicit absent-intent read, UI Availability can admit an exact trusted,
enabled portable installation against its immutable census release. Renderer
Artifact requests carry that installation's complete execution origin; the same
reader verifies release correspondence and the platform slot before the existing
Artifact lease verifies bytes. Missing custody, mismatched digests, replacement,
disablement and retirement refuse admission. This does not select an Account
release, admit Account-hosted publication or grant Account Data access; an explicit
Account intent retains precedence.
Before an installation supplies its declaration, first-party installed-plugin
names and descriptions come from the manifest presentation generated by the
canonical bundled-plugin publisher. This presentation carries no installation
or execution authority.

The AppShell union's current phase does not wait for unrelated Machines to finish
describing their catalogs. Each published contribution retains its own exact
Machine currentness and interaction authority. Catalog completeness is a separate
fact: a missing selected page or sidebar destination stays pending while an
eligible origin is establishing, rather than becoming an unavailable tombstone.
In 0.3 development source, ordinary contributed-Action observation acquisition
also waits on AppShell's scoped declaration phase and establishing-member fact
when its target has not been projected or its executable target is being replaced.
The first source-basis publication is not discovery settlement. Publication wakes
the existing acquisition subscriber, which follows the current declaration until
it borrows an exact executable registration. A generation retiring across that
acquisition's await or during initial read-observer attachment rejoins the same
push-driven settlement. The failed opening releases its old observer, including
a handle returned after retirement; ordinary Action handlers are not replayed.
An installed successor still requires exact-target activation
admission; settled absence or disablement refuses once. Already-resolved targets
do not wait for unrelated discovery or activation. Caller cancellation and Account
retirement release pending acquisitions. This adds no catalog read, timer or retry
owner.
In development source, a passive Machine projection with no admitted answer is
unavailable, rather than establishing: that observer does not request a catalog,
so it cannot promise a forthcoming answer. It retains the shared cache subscription
and adopts a later genuinely demanded read. The first Account Availability census
has its own Sync producer and stays establishing until that producer publishes
its census or typed failure. Missing Session execution placement does not prevent
Account-scoped Habit reads; PR observation refusal settles through the existing
failure/Retry presentation without discarding readable trigger sets.
Machine presence updates that leave the resolved target set unchanged do not
republish the installed/runtime catalog.
Availability cursor and observation-time changes also leave the catalog snapshot
intact when its prepared declarations and availability facts are unchanged.
Availability's reader store publishes a separate cursor-free descriptive UI
snapshot, retaining equal materialization, declaration and Account-model inputs.
Its UI inventory is ordered by the complete materialization identity, and plugin
and installation rows reconcile by identity rather than arrival position. Equal
reordered reports therefore publish no new UI input. Ingress admits a shared
materialization once for its flat and per-Machine views; later observations carry
the owner's immutable admitted declarations without parsing them again. New
external declarations still pass the canonical schemas.
Cold declaration acquisition owns contribution-point schema bytes without
constructing executable parsers for unopened surfaces. The existing canonical
decoder prepares those parsers on first demand and reuses its admitted immutable
schema on subsequent reads; unsupported semantics remain point-local refusals.
AppShell subscribes to that semantic snapshot; live observation subscribers and
invocation policy readers still see current cursors and authority. Declaration
edits, revocation and Account retirement withdraw or replace the publication.
The origin-report owner changes its immutable selection maps only when a
selection, stored-choice status or admitted membership changes; the union uses
those published references without comparing equal selection maps again.
Origin reports that leave the UI union unchanged do not rebuild it. This includes
native-only package selections and additional controller checks that cannot
change an agreed or explicitly selected declaration. A changed UI or Resource
selection derives only that plugin's slice, sharing unrelated published rows.
One reporter per plugin reports from the same commit, so the owner derives a
burst of changed reports once: in a microtask, or earlier when a synchronous
reader asks for the snapshot. Listeners hear one notification per burst.
Administration and Connected Account facts remain separate; actual source,
trust and currentness changes still invalidate the affected composition.

In the unreleased UI implementation, the existing Availability reader store,
Machine execution-origin producer and Account-lifetime AppShell publisher prepare
their descriptive slices when their actual source inputs change. Union and
Connected Account descriptor publications structurally share unchanged rows;
React and imperative readers consume the retained snapshots rather than rebuilding
or serializing them. Source identity includes the relevant Account lifetime,
Home, platform and ready locale, not only a daemon generation or changes cursor.
Heartbeat callbacks still reach the Machine producer even when the storage root
reference is unchanged. Declaration-only consumers do not subscribe to executable
activation diagnostics.

The full-describe and selected-reply adapter owns its admitted declaration
snapshot once per arrival. It retains equal keyed families and rows in that
existing snapshot, so unchanged presentation rows do not repeat their decoders,
native JSON ownership requests or execution-origin preparation. Metadata-only
arrivals preserve nested identity; a changed or withdrawn row replaces only its
affected declaration output, including same-generation edits. Specific typed
Registry families use their ingress-admitted fields directly; generic serialized
contribution bags still use their actual decoder when their row changes. This
sharing adds no second registry or permission cache, and public raw replies do
not become mutable aliases of the privately owned publication.

Raw Registry replies retain their current numeric generation. Semantic UI
publications do not change merely because that unrelated catalog counter advances;
the nullable UI-model generation records source readiness, not an aggregate
invocation authority. Exact origin, occurrence, version, artifact, selection and
Account lifetime remain authoritative at their existing owners. Palette forms and
their pending acquisitions follow their admitted Action row and exact host binding,
rather than the identity or generation of the whole merged catalog.
The AppShell producer routes its existing committed readers only on declaration,
candidate, Account or availability changes. Raw Browser/Voice subscribers still
observe fresh Machine reports through that same owner; they do not create another
projection loader or currentness store.

Prepared declarations are not cached permission decisions. Account intent,
currentness, exact target custody and invocation admission remain fresh on access;
new untrusted data is validated at its acquisition boundary. A frozen wrapper is
not proof that nested input was validated or made immutable. Retirement and
same-generation replacement must still withdraw the affected published slices.

In 0.3 development source, AppShell origin reporting includes bundled and
registered development occurrences without an Account materialization. Their
Home identity comes from the canonical routing-profile identity owner. Page
headers and mounted surfaces resolve the plugin's complete supply set through
Administration; the page narrows only the selected supply. Equivalent page or
picker presentation updates retain the selection state. A loaded renderer is
not proof that a daemon origin was selected: several eligible origins without
a declared default or saved selection still require the existing explicit
choice before daemon-backed operations can run.

Run-on's remembered local-source target and its open picker demand the Machine's
UI declaration sections through the existing one-shot projection reader.
The passive AppShell observers publish that admitted answer into the source
inventory; an installation census alone cannot supply source custody. Demand
continues across pending and failed presentation states, so opening a picker
can reacquire a failed answer. Failures schedule no picker retry; a new demand
or canonical currentness change owns the next read. Portable-release admission
and exact source, occurrence, trust and Account fences remain unchanged.

An Account's plugin-delivered Voice conversation adapters come only from the
selected Voice execution Machine's plugin projection. Voice readiness
(`apps/ui/sources/voice/registry/readiness.ts`) therefore requires that Machine
for every non-built-in conversation provider, so Settings never reports Ready
while Start would fail with `voice_provider_adapter_not_registered`.

AppShell reconciles client Action and Voice executables against the latest exact
target set before waiting for Artifact preparation or foreign plugin cleanup.
Each admitted target prepares and publishes independently, with its complete
declared registration rights committed atomically. An unrelated parked target
does not hold a fresh registration behind its bytes or a preceding shell update.
Equivalent inventory publications preserve an executable already claimed by the
composition, including one whose foreign activation is still preparing, and its
pending Actions. Cancellation fences acquisition until the composition creates
the exact registration scope; claimed execution then follows its composition
controller, Account lifetime and Artifact lease. An actual target withdrawal still
prevents unfinished adoption. A host-created replacement scope claims its
activation and controller before commit checks retained leases. It is fresh
preparation even for unchanged bytes, as when the Voice runtime host is replaced;
only an actual host reuse keeps the incumbent scope and its pending Actions.
Machine currentness, occurrence, bytes or
registration-rights withdrawal fences the incumbent immediately, even while an
unrelated preparation is pending. Closed Artifact refusals publish through the
same executable index with the affected target's identity; unexpected host faults
still propagate. This is 0.3 development source behavior, not a claim
about an already-loaded client.

In 0.3 development source (not yet released), a populated release-less Collection
upgrade uses the existing portable-release preparation and promotion owners.
Availability's `collectionWriters.claim` can return exact incumbent declarations
and manifest-bound target bindings with `prepare:true`, without moving intent.
The daemon loads the declaring module through the canonical activation loader
and passes its exported `collectionMigrations` to Account Data's existing
candidate executor. Each pure callback receives the opened value and readonly
`{ currentRevision }` from the host-validated source row. Every step in a chain
receives that same physical source revision; the context supplies no storage or
writer authority. Existing callbacks may ignore it. Data stages against source revisions; `transitionIntentTx`
re-censuses and atomically promotes those rows with the writer. Empty Collections
still advance immediately; failed preparation retains rows and the incumbent
writer. A schema-proven compatible widening can adopt a different digest at the
same schema version without rewriting payload bytes or row revisions. Data's
Protocol predicate proves nested optional additions and wider value domains while
preserving projection, index, query, relation, identity and quota semantics.
The predicate follows corresponding `allOf` constraints and accepts appended
`oneOf` arms only when each addition is proven disjoint from every existing arm.
A retained `oneOf` arm may change only by appending branches to unions, adding
optional properties, widening finite enums, or removing required fields at fixed nested paths inside it (a
single schema may become the first branch of a new union). Enum inclusion uses
the same scalar proof: the current
reader's enum must contain every retained writer value, and its required fields
must be a subset of the writer's (an omitted `required` means no requirements).
New properties also pass ordinary inclusion: a closed writer object forbids the
previously absent field; an open writer's catchall must imply its new schema.
Existing property schemas remain subject to the retained-arm proof.
Every other keyword at every path, including `type` and `not`, stays
byte-identical, and the changed arm must still be proven disjoint from its sibling
arms. Disjointness comes from literal or enum discriminators, a required field
that a sibling closed object forbids, or an enclosing schema that already requires
an object. An overlapping append can invalidate an old exactly-one match and is
refused. Other unproved union or intersection changes require a new schema version
and the existing migration path. Local `$ref` pointers are accepted only when each
one resolves to identical bytes in both schemas; unchanged `$ref` text can
otherwise change meaning when its referenced schema changes, including under `not`.
New required fields and narrowed types remain typed contract conflicts; lagging
claims cannot reclaim the writer. Retained compatible contracts receive read-only
access through tolerant stored readers; mutations still require the exact current
digest. Portable Account release selections still outrank
daemon claims. This adds neither a migration registry nor a second executor.

In 0.3 development source, Data's persisted-contract reader shares one admitted
preparation across reads, mutations, readiness and migration declarations for
each qualified plugin, Collection, schema version and digest. These immutable
global declaration versions remain retained independently of Account writer
pointers. The server retains their preparations for its process lifetime, with
no expiry timer. Each read still selects the current Account, intent and exact
persisted contract; it compares the stored declaration representation before
reusing preparation. Changed bytes must pass the original parser and recomputed
digest check, and a new version receives its own preparation. Write ingress
continues to validate new declarations. This shares static schema work, not
Account admission or row content.

In 0.3 development source, the direct UI Collection client still reads
`/v1/plugins/data/contract` once per operation to admit the exact ref and learn
its current access. A contract is immutable per digest, so once a server answer
has delivered the contract for a digest, later reads send `omitContract: true`
and the server answers `{ access }` only, after the same exact-ref admission.
Refusals are unchanged. A new digest (plugin upgrade or reinstall) is not held
and receives the full contract. Before this, every operation re-downloaded and
re-compared the whole contract (about 0.5 MB for Channels `channel-state`).

The client compiles the contract schema when an operation first materializes a
row or validates a value, not when it is created, so an absent get, an empty
page or a watch never compiles it. In 0.3 development source, Channels
`channel-state` V21 publishes the V20 document with each repeated subschema
once under root `$defs` (about 130 KB instead of 500 KB). Inlining those
references reproduces the V20 document exactly, so validation is unchanged;
V20→V21 is an identity migration. Root properties, `$ref` targets and
subschemas holding a `$ref` stay inline.

### Plugin Collection tables

The Account Collection query owner accepts both `asc` and `desc` keyset order.
The `order: 'asc'` restriction in `collectionsV1.ts` belongs only to relation
mutation restrictions; it does not limit ordinary UI queries. A plugin UI table
declares the index for each sortable `CollectionField` with `collectionIndex`,
then uses `createPluginCollectionTableQuery` from
`@happier-dev/plugin-ui/data`. That connector maps the Collection sort
direction to the SDK query, resets the cursor when the field or direction
changes, and appends later pages with the returned cursor. The table remains a
consumer of this one query owner; it does not sort a loaded page locally.

Constructing a dormant Account storage binding does not prepare retained rows.
A real Collection operation promotes its provisional declaration refusal through
the same Account Data claim owner; concurrent operations share its preparation.
The daemon's background declaration publication retains upgrade recovery for
direct Account UI readers that never issue a daemon Collection operation. The
daemon readiness owner keeps that preparation outside its readiness dependency.
Preparation reads source rows and stages target rows in pages, preserving the
exact source revisions and server-advertised stage limits. Encryption admission
belongs to the authenticated source page and the final stage: target rows are
encoded together after all asynchronous callbacks and a fresh mode/key check.
Additional stage chunks revalidate that sealing authority after the previous write.
This avoids per-row currentness requests without dropping final write admission.

Collection item sharing is being integrated in 0.3 development source. An Account
Collection handle exposes `sharing.setGrant`, `listGrants`, `revokeGrant`,
`sharedWithMe`, `get` and `put`. Shared reads and edits carry the owner's Account
identity; edits assert the observed row revision. Account, Team and Group grants
reuse the existing resource-grant owner. They do not create a second Collection,
writer, or content row. The shared edit enters the ordinary Collection mutation
owner, preserving its projection, index, relation and quota contracts. Revocation
takes effect on the next request.

Editors may change content while retaining existing relations. Changing a
Collection or host relation field is owner-only; grantee attempts return
`collection_relation_unavailable` for both existing and missing targets, without
querying private targets or uniqueness collisions.

Sharing discloses the whole logical item to its grantee. Its declared
`serverReadable` fields remain the same plaintext projection the server already
indexes for the owner; sharing does not introduce extra projected fields or hide
those fields from an authorized reader. References inside an item grant no access
to the referenced resource. Plain-owner sharing requires no encryption material.
E2EE first-share conversion and recipient wraps are described in
[encryption.md](encryption.md#shared-collection-items-03-development-integration).
The CLI, installed UI and hosted UI bind the same logical sharing client; the
host retains credentials and keys. Plugin-owned pages list shared items through
`sharing.sharedWithMe` and open them through the SDK themselves. Collection
sharing ships with this SDK-only entry contract. Existing host surfaces that
list plugin content retain their missing-plugin presentation naming `pluginId`
when the plugin is absent or disabled. A future Inbox share notification with a
host link is the missing consumer for host-address navigation; it is not part
of this integration. This follows Coordination's later 2026-11-02 ruling,
which withdraws the proposed optional page declaration and address resolver.

Logical deletion ends sharing: the same transaction removes the item's grants
and recipient key wraps. Recreating the same row id creates a private item with
no earlier audience. Recipients observe its disappearance on their next read or
invalidation. Physical forget keeps its existing cascade. These entry and delete
semantics follow Coordination's 2026-11-02 rulings. Security review and
loaded-runtime replay remain integration prerequisites, not claims of released
availability.

In development native PostgreSQL deployments, candidate-stage quota admission aggregates
retained live-row and staged-row byte measurements in the database. It transfers
compact usage and immutable policies, then inserts the admitted stage batch in
the same Account-fenced transaction. The stored-row byte metric, limits and
typed quota refusals remain shared with the existing quota owner. SQLite, MySQL
and PGlite retain their existing census adapters.

In 0.3 development source, ordinary Collection mutations use persisted Account
and Collection row/encoded-byte totals, live immutable-contract membership counts,
and declared index-prefix counts. The existing Account fence serializes their
updates with row, projection, index and relation changes in the same transaction.
Per-row size checks measure only changed rows, including relation nullifications;
candidate promotion, compatible contract adoption, Account encryption transitions
and plugin data erasure maintain the same totals. The stored-row byte metric and
quota transition rules are unchanged. Activation and candidate-stage admission
retain their separate census projections.
Mutation prefix deltas cover only the index states whose entries are physically
replaced; historical states retained after materializing promotion keep their
unchanged entries and counts, including through row forgetting and recreation.

Canonical database deployment backfills these totals once. A mixed window with
older servers that do not maintain them can temporarily produce incorrect quota
credit or typed quota refusals. This is an accepted, recoverable transition;
after those servers are gone, the database owner unconditionally reruns the same idempotent repair
against the selected database from the server workspace:

```sh
node ./scripts/runTsx.mjs --tsconfig ./tsconfig.json ./scripts/pluginCollectionUsageBackfill.ts
```

The command uses the selected `HAPPIER_DB_PROVIDER` and `DATABASE_URL`, recomputes
from canonical live rows and stored index entries, and commits one Account at a
time under its existing fence. It does not run on mutation arrival or introduce
a background reconciliation loop. This describes unreleased source behavior;
shared development database migration and attached-server reloads are batched by
the database owner.

A release-less writer upgrade retains already committed candidate stages after
a retryable preparation failure. Its next real declaration publication or
Collection operation resumes only revisions not already staged; it does not
schedule a retry. Terminal, cancelled and stale preparations still retire
their exact stages. Existing candidate HTTP diagnostics identify the declared
plugin, Collection and initiating trigger without row identities or content.

In 0.3 development source, the public SDK Collections entrypoint exposes
`projectPluginAccountCollectionDeclaration(localId, definition)` for author
tooling and the hosted Collection Data bridge. It shares the `definePlugin`
projection: executable schemas become static schema declarations and migration
callbacks become their declared identities. Manifest parsing remains the
validation and admission owner.

Portable Collection migration artifacts use the same captured canonical manifest
that the Plugin UI build reads for artifact discovery. The build binds it around
the authored zero-argument `collectionMigrations()` export, which returns only
the Collection-id-keyed callback map. Collection definitions and that entry share
pure migration modules; the artifact does not import the daemon plugin definition.
The resulting payload remains `{ manifest, collectionMigrations }`, validated by
the existing candidate loader. The universal compiler still rejects Node built-ins
in callback dependencies. This is 0.3 development source behavior, not a released
authoring contract or proof that an already-loaded artifact has been rebuilt.

The CLI Account Data claim owner retains a typed
`plugin_collection_contract_conflict` for the exact admitted manifest digest,
Account lifetime, plugin occurrence and Availability change cursor. Repeated
Collection mutations return that refusal with a schema-version/migration remedy,
without resending the manifest. Reads still ask the server to admit the caller's
exact retained contract; compatible callers can read without reclaiming the writer.
If reader admission fails, the typed claim refusal remains visible rather than
presenting the Collection as empty. A changed
declaration, occurrence, Account or Availability hint (including a changes-feed
reset) permits a fresh claim; the hint grants no writer authority. Network and
5xx failures retain the existing next-operation retry behavior. Dependency-owned
JSON Schema changes use the same compatibility decision. Incompatible changes require a new schema version and the existing
candidate-preparation/migration path.

In 0.3 development source, both daemon and direct Account Collection clients
preserve the Home's confirmed transaction rollback as
`database_transaction_conflict_exhausted`. They consume the shared strict
HTTP 503 rollback parser; a failed transport, malformed acknowledgement or
unqualified database failure remains outcome-unknown. This acknowledgement
classification does not retry the mutation or change Collection CAS or approval
execution custody. The daemon marks a confirmed rollback retryable so existing
idempotent callers, including Channels polling, can recover on their ordinary
retry path. Uncertain mutation outcomes retain their separate custody.

Both Account Collection realms also project the shared logical codec's exact
private-envelope size refusal as `collection_quota_incompatible`, with
`{ dimension: 'maxRowEncodedBytes', effectiveMaximum }` in `PluginError.details`,
before issuing a mutation. The content-envelope schema owns the unchanged
512 KiB encoded JSON bound; its size issue supplies the exact measured bytes
and maximum to the codec. Measurement and writes use that same outcome.
Malformed private payloads and crypto failures retain invalid-value errors;
unavailable E2EE material retains Account unavailability. No wire or persisted
envelope shape changes.

Channels checkpoints in 0.3 development source use this same Collection size
owner, with no separate checkpoint byte quota. The poll input, batch result and
checkpoint-only result preserve the complete opaque JSON token. A real storage
overflow retains `collection_quota_incompatible` in the existing poll failure
evidence and leaves the committed checkpoint unchanged; GitHub does not drop
native revision identities to fit a feature-local ceiling.

In unreleased 0.3 source, thread Session creation uses the Session owner's
canonical creation key and persisted birth facts. Launching a runner for an
already committed row does not require a second fresh-create settlement.
Direct recovery failures and background failures expose the same content-free
Session failure codes through the existing diagnostic classifier; launch
messages and conversation content remain excluded.

In 0.3 development source, an app-bundled UI inventory retains the exact
Collection reader references compiled from its manifest. Availability passes
those references to Data unchanged, including for static queries; it never
substitutes a newer daemon writer's schema or digest. Data admits compatible
retained readers through its existing access resolver. Missing or incompatible
reader contracts return `collection_update_required` (HTTP 409), preserved as a
typed Collection rejection through the app Data adapter. The affected Collection
requires an app update; unrelated operations remain available. This introduces
neither an older-schema writer nor a compatibility shim for unreleased intermediates.

In 0.3 development source, Channels `channel-state` V18 projects finalizing
connections and bindings into the existing `by-ingress-due` index using their
lifecycle update time. Its V14→V15 callback preserves private payloads and
authority while backfilling that selector. Each outward wake selects only
finalizing candidates; healthy rows have no due key and their bodies stay
unopened by delete finalization. The finalizer still rereads current lifecycle
and execution placement before cleanup, and resumes retained work after a
conflict or restart through the existing outward wake.

In unreleased 0.3 source, Channels `channel-deliveries` V6 adds the
`by-terminal-updated-at` index through an identity V5→V6 migration. Retention
selects expired terminal rows in the Collection query and reads one future row
to schedule its exact 30-day deadline. Ordinary delivery writes preserve that
deadline; an empty terminal history reopens only on a terminal-index change.
Unresolved partial and unknown outcomes remain in terminal history and are
never retired; a future one can cause one deadline wake before the next anchor.
Paginated retention keeps its cutoff fixed for the Collection cursor; the
existing retry index continues to own live delivery discovery. The bundled
manifest and UI reader declarations publish V6 with the writer; a V5 stored
row keeps its payload and physical revision through candidate promotion.

The Channels connections Resource owns its observed projection through the
existing context-producer lifecycle. It watches each connection's attention
bucket; healthy delivery writes do not invalidate it. Attention changes read
only the affected connection ids through one paged set-prefix query, while
connection metadata changes retain their existing structural observation.
Unobserved reads remain fresh and producer disposal releases its watches.

V15→V16 preserves each logical row while preparing the optional nested PR
fix-resolution evidence added by Channels Protocol. That state-schema union
change requires a forward version transition under Data's existing compatibility
decision. The corresponding optional delivery-schema addition is a proven
widening, so `channel-deliveries` remains V3. Candidate preparation and writer
promotion remain owned by generic Account Data; no retained row repair is needed.

V16→V17 replaces retained configured-Fix `request.head` with
`expectedHeadSha = head.sha`. It preserves the original obligation, delivery
idempotency key, request revision, result and lifecycle facts, without sending,
charging or releasing a Fix round. Absent attachments stay absent; native
repository/ref verification remains with the existing Watch reader. Other rows
pass through unchanged. V16 requires a nonempty SHA: malformed source custody
is refused by Data, not repaired with invented head evidence. This is a
development-only forward transition; deliveries remains V3.

V17→V18 preserves every logical row while preparing the optional Action
`effectAttempted` evidence embedded in configured-Fix Session-send fanout
results. That nested strict-union change needs a forward contract version;
generic Account Data owns preparation and writer promotion. It does not
replay a send or infer whether an earlier effect occurred.

Channels' generation-owned supervisors settle `collection_update_required` at
their admitted Collection access boundary, before recovery adapters can reduce
it to transient unavailability. They cancel their dependent work, join started
work, and emit one content-free update diagnostic per supervisor activation.
That activation performs no later Collection reads or writes; ordinary row
changes and retry deadlines cannot make its compiled contract current. A new
activation obtains fresh admission. The existing `connections-v1` management
Resource projects `{status:{kind:'updateRequired',code:'collection_update_required',
collectionId,retryable:false,recovery:'updateHappierOnThisMachine'}}` when either
required Collection refuses its reader. It omits the connections list because
an unreadable list is not empty. The Channels presentation owner consumes that
state to render “Update Happier on this Machine” without a Retry action; the
Resource does not claim which application version is required.
The Session Collection membership observer likewise retires after this refusal.
Discord and Slack settle the same typed refusal from core reconciliation,
ingress and transport-fact Actions, stop their existing workers, and do not
reconcile again on row or credential hints until a new provider activation.

App-scoped plugin UI does not use `plugins.home` as catalog authority. That named
Administration target remains responsible for install, installation settings,
Secrets and Browse operations. Machine-bound plugin effects use Administration's
per-plugin execution selector: an explicit device-local, Account/Home-scoped Machine pin,
then automatic selection among admitted compatible installations on this Home.
In unreleased 0.3 source, presented plugin surfaces use that same placement
ranking to choose one Machine projection read from available Account installation
descriptors. Presented Connect surfaces discover installed packages and UI on
their selected Machine through their existing loader request, including installs
absent from Account metadata. This read intent carries coordinates only; it does
not admit an executable source. The Store requests every installation it presents. Unopened
input pickers retain available presentation without acquiring Machine sections;
opening a picker requests its descriptors, and picking acquires the current
exact producer. Presented origin rows request package facts without unopened
UI bodies. The existing loader shares admission across section consumers on
one Account/Machine/locale and widens missing coverage from its held manifest;
invalidation still requests a fresh generation and boundary validation remains.
In current 0.3 development source, a scoped row whose content has opened may be
selected while unrelated Machine hydration continues. Fleet consumes the inventory
owner's row qualification; presence alone does not admit execution. With no qualified
compatible candidate, incomplete coverage (including an online row still opening
after list settlement) stays pending rather than reporting no
installation or a version conflict. An unopened explicit pin stays pending without
falling back. Auto-pick prefers the rendered release's version,
then greater coverage of Machine-scoped contributors whose declared native tool
has an already-published authenticated capability, then greater coverage of this plugin's enabled Machine-scoped targeted
contributors, then the Machine last used for this plugin on this device, this device's own
Machine when known, and the most recently active eligible Machine (stable identity
breaks ties). In unreleased 0.3 source, that ranking chooses the initial or replacement
Auto origin. The mounted Administration publication retains its choice across
equivalent declarations and presence heartbeats. A compatible peer can replace it
when that peer's known Machine-scoped contributor set strictly contains the
incumbent's known set and preserves every contributor with observed native authentication.
Unrelated unknown declarations on either Machine do not erase known contributors.
An incomplete installation census or an incumbent with unknown zero coverage
retains the incumbent; first-paint presentation-only declarations cannot prove
absence. Contributor coverage remains a placement preference, not proof that
every configured source can execute on that Machine.
Coverage and passive native-tool observations consume Availability's
resolved installation declarations, including admitted release or bundled declarations
for thin Machine census rows; they do not require a manifest on the census row.
A compatible replacement source or materialization on the same Machine retains
that Machine preference; the replacement still passes normal admission.
Coverage counts distinct targeted contributions whose bound Actions
need Machine execution, using existing enabled, trusted installation declarations
on each Home/Machine. Account-only contributions do not affect placement.
Native hints consume the existing Account-scoped capability cache for declared
tools in the canonical built-in installables registry. They observe published changes
without issuing probes, and missing facts remain unknown. These are preferences,
not execution authority or proof that an exact configured connection works.
No plugin-private configured instances are read: Accounts with different active
instances but identical published contributor and native facts rank the same. A missing source
remains visible in the plugin and the person can change **Runs on**.
Fresh execution and execution-origin Action reads revalidate that
same choice. An explicit Machine pin takes precedence, including when unavailable;
an unpinned operation re-picks when its current origin becomes ineligible.
`executionTarget: { autoPick: false }` opts a Machine-dependent plugin into asking
when several candidates remain; a sole candidate still works automatically.
The existing optional `default: 'installation'` hint breaks otherwise equal
source preferences; it cannot override a pin, version compatibility or this ranking.
An unavailable saved choice stays
visible and is never silently substituted on those uncontextual App surfaces.
In 0.3 development, the selected surface member's readable daemon
Resource declaration requires that execution origin even when the renderer's
`requiredHostMethods` compatibility minimum is empty. Account-owned borrowed
reads without a readable daemon Resource declaration remain machine-free;
dynamic observation alone cannot grant an unreadable snapshot transport.
In 0.3 development source, an App panel presented beside a Session uses that
Session's exact Home and Machine as its initial execution context, on desktop and
phone. Missing or unavailable contextual supply does not select another Machine.
An explicit pick in that mounted panel is local to its Session target and Account
lifetime; opening or picking there does not rewrite the device's per-plugin preference.
The panel keeps its App binding and AppShell supply projection, and the same
Administration owner resolves and freshly revalidates its execution origin.
The existing `plugins.execution_origin.list/set/clear` Actions expose the same
choice to Agents, MCP and CLI through the answering app. The optional
`clientId` addresses that exact connected app socket; list results include
`answeringClientId` and eligible `answeringClientIds` for subsequent calls. All
three operations use the shared client-choice rule: exact `clientId`, a sole
eligible app, or a unique latest focus transition from the existing push. With
unresolved ambiguity they return `client_ambiguous` and candidate socket ids in
`details.clients`, allowing an exact retry. A disconnected
selected client is unavailable and never substituted. Socket addresses expire
on reconnect; list again to obtain the current address. This routing uses the
canonical reverse RPC transport, not an Account preference or another Run-on store.
In unreleased 0.3 source, list refusals carry a closed diagnostic reason with
`phase: 'selection'` and `retryable: false`, distinguishing an unavailable
Account scope, an unmounted current UI context and a retired contextual address.
Callers recover by restoring that scope, opening the intended UI or listing its
current contextual addresses again. The reason survives the Action result parser
and client relay; it carries no content or execution authority.
A list with
`contextual: true` discovers current opaque command addresses; `contextualTarget:
{ commandId }` reads or changes that exact mounted choice. The current-UI
command owner retires the address with its mount, target or Account lifetime.
Within the same mount and unchanged entity descriptor, republishing an unchanged command retains its
opaque address: title, description and the declared `executeAction` or
`openSurface` payload must stay equal. Updating other context details does not
retire that command. Changing its meaning or removing it retires the old address;
the existing mount, target and Account retirement rules still apply.
In unreleased 0.3 source, a handled `ui.current_context.command.invoke` returns
the current-UI owner's positive settlement. Its Action result is
`{ ok: true, result: null }` when the command has no result value; commands with
a JSON result retain that value. Native and external MCP serialize that payload
with `isError: false`; their failure path carries the typed refusal with
`isError: true`. CLI retains the Action settlement, and Voice retains `ok`
while its provider-result redactor omits private command data. Null is therefore
a successful empty payload, not an instruction to read the context again.
Unknown or retired commands, disabled Actions and unavailable clients return
their existing typed refusals; callers must inspect the transport's settlement.
An `executeAction` command keeps its authored input bound. When it has no authored
input, invocation JSON reaches the Action as described by the mounted command.
Command retirement cancels pending admission, including confirmation. Once the
finite Action is admitted, closing or replacing its publishing surface preserves
the Action's settlement. Explicit caller cancellation and executable-generation
retirement retain their own cancellation behavior.
Read and invoke share the current-context reverse-RPC address and the socket/focus
selection rule above. A Session caller does not select a different room. The
answering App's command owner resolves the opaque id and refuses a retired
command; a separate command registration does not decide client availability.
`account.home_continuation.invoke` uses the same per-Machine address. An opaque
command id is never its own reverse-RPC room, so a command-set change or a
reconnect costs no per-command registration frames; per-command addresses stay
local to desktop window selection.
UI picks use those same Actions and freshly admitted candidates. Calls without
a contextual target read or change the answering device's current Account/Home
preference, including Agent, MCP and CLI requests. They do not use Account CAS.
The existing local Administration target owner stores only the Home-qualified
Machine. A source root or materialization id belongs to the freshly dispatched
operation, never the preference. An unavailable explicit Machine keeps its name
and blocks effects rather than silently running elsewhere. In 0.3 development,
explicit Run-on choices remain device-local Account/Home preferences. Automatic
last-use observations use the existing keyed device UI-state persistence owner,
with the same exact Account/Home scope and no Settings publication. Stored
`plugin.lastRunOn:*` entries are copied out of the old target map before removal;
an already-current observation wins, and a refused copy retains its source.
Automatically initialized Administration targets use that same navigation owner;
choosing a target deliberately still records a preference.
`plugins.execution_origin.list` reports
`selectionSource: 'auto' | 'pinned' | null`, also available in the chip's selection
data. Retired
`machineAdministrationSelectionsV1.pluginExecutionOriginsByPluginId` values
remain inert stored data: no migration ledger, pruning or dual writer.
A source-backed occurrence carries its
real source custody instead of an invented portable materialization. Invocation
freshly resolves the same exact target and revalidates after approval. Machine-free
UI uses admitted presentation/artifact facts without an execution resolver or picker;
descriptors and cached bytes alone never grant daemon authority. Session contribution
families remain scoped to their exact Session host, not the app union.
Home Search consumes those already-selected per-Action origins across Machines;
it does not require a single Machine for the whole catalog. Each opened Action
form retains its own origin, while Session Search retains its Session's Machine.
While Home Search is presented, its Action catalog requests the existing shared
projection acquisition for installed Machines declaring global UI Actions with
`commandPalette` placement. Source-bound installations whose declarations are
unknown are discovered through that same read. Closing Search releases the
demand; passive AppShell observers do not acquire catalogs while Search is idle.

In 0.3 development source, machine-bound Settings and App pages place that exact
execution-origin selector once in the route's header actions.
Input-less `openSurface` navigation admits both page routes before execution-origin
selection, matching direct catalog navigation and keeping selection/recovery reachable.
This grants neither execution authority nor launch-input custody; Settings pages
still reject launch input, and pane destinations retain their exact-origin requirement.
Desktop plugin `PageHeader` claims it through the same header-actions owner as core pages;
loading and unavailable bodies leave it in the existing actions band. Phone page
actions compose beside the route context instead of overwriting it, and withdraw
with their destination. Account fields do not imply a separate “Manage on” control:
the canonical daemon Settings target is still passed independently to the mount.

### Mounted Plugin Account root carrier

Mounted Plugin UI calls to Machine-owned host Actions use the existing Account
root Action carrier in 0.3 development source. Its strict V1 plain and V2
encrypted envelopes accept an optional `pluginInvocation`, restricted to the
canonical mounted-surface or client-plugin-Action binding. The binding carries
plugin, contribution, occurrence, source custody and any materialization; the
root envelope retains the request id and exact Machine target. It carries no
plugin credential or claimed publisher signature. This is an unreleased
extension; envelopes without a plugin claim retain their existing contract.
Native host requests use the existing opaque UUID correlation owner, not the
potentially long adapter/lifecycle key; the root request-id limit is unchanged.
The mounted claim is an Account-carrier contract, not an API-token, terminal or Session
origin override; those other principal families cannot use it to change surface
or bypass their grants. Home also refuses it on a managed creation child, whose
envelope another person's daemon may author for the guest Account.
The signed-root catalog includes provenance-only Action shapes for this carrier,
but the API-token catalog still excludes them. Initial Account ingress requires
the claim for those operations, and daemon execution independently refuses an
unclaimed or locally unverifiable caller. The existing signed envelope digest
binds the exact claim; there is no second claim in the authorization binding.

The daemon leases its current executable registry and reuses the mounted-caller
admission owner to match the receiving Machine, live occurrence, admitted
contribution, source custody and materialization. It derives the plugin caller
from those local facts and executes with the `plugin` surface and caller policy,
retaining the Account authority ceiling, grants, approval and cancellation.
An unverifiable or stale claim returns `plugin_mounted_caller_unavailable`;
it never falls back to a host caller. Publisher proof, when the domain owner
requires it, comes from the daemon's installation owner. Inspector's
`plugins.list`/`plugins.reload` and Channels' conversation target reads use this
carrier; the latter reach the CLI Automation conversation owner, including its
effect-time occurrence/materialization checks and publisher proof.
Reload still requires the existing approval flow before any effect. A signed
Account approval origin retains its narrower plugin surface and source-qualified
caller; its durable projection does not persist a runtime occurrence or
materialization. Existing exact-daemon replay revalidates source custody and
domain admission rather than borrowing host authority.

In 0.3 development source, the catalog control client preserves the daemon's
typed refusal code even when the HTTP response is service-unavailable.
Inspector distinguishes a semantic `plugins.list` refusal from a successful
empty inventory: it retains the previous rows and diagnostic metadata for
Retry. Inspector asks for `projection: 'summary'`, which answers each plugin
without its per-contribution introspection (`contributions`); omitting the
field keeps the full entry for Agents, the CLI and other callers. An unknown SDK failure does not establish an origin or daemon diagnosis;
its code remains diagnostic metadata, not explanatory user-facing prose.

Plugin code can use the public SDK's `projectPluginFailureText(error)` to retain
a known failure sentence through the canonical credential and local-path
redactor. This 0.3 development-source export delegates to Protocol's existing
failure projection; bundled and externally installed plugins use the same owner.

In 0.3 development source, Lima power-command and Cua/Docker Sandboxes/Devcontainer acquisition-command failures carry the typed
`native_command_failed` cause: command, exit status (or interruption), and an
optional stderr excerpt projected through that redactor before bounding it to
the existing Action-error text envelope. Managed Machine Details displays this
cause without exposing argv, local paths, or credentials. The closed command names include `create`, `run` and `up` for these native acquisition paths. Docker Sandboxes verifies the selected template remains in its native catalog before creation; Cua local and cloud acquisitions and Modal creation require a Running observation before binding. Lume keeps its explicit accepted-start `startPending` contract, with Running awaited by the shared host before bootstrap. Acquisition requires
the native post-start observation to be Running. Lima options resolve native
template selectors to the selected architecture's disk-image location before
saving a recipe; an old recipe containing a template selector must be reviewed
again before acquisition. Native template memory defaults are not image minima.

The daemon's final-policy runtime projection enumerates admitted source custody,
including bundled development sources and packaged first-party runtimes that have
no managed installation generation. Each row still comes from the same exact
occurrence and activation owner; a legacy generation alone supplies no authority.

Manifest-authored declarative roots reuse the canonical declarative projector for
installed presentation without a runtime occurrence; their machine effects remain
inert. Resource-backed documents still require their actual live or retained Resource
data. Hosted/native Artifact bytes use their existing admitted source and integrity
owner: a descriptor is not proof that an offline client can acquire those bytes.

The declarative `workflows` family uses the canonical Workflow definition schema. Bundled and installed contributions reach `workflow.definition.list` through the existing plugin catalog projection; the library, Work tab picker and composer consume that same read. Plugin workflows are read-only and can be duplicated into the user's library through the existing create path. A start names the qualified `plugin:<pluginId>/<localId>` reference and the observed plugin version; the Workflow admission owner resolves and freezes the definition in the accepted Run snapshot.

In current development source, an Agent step's `engine` can reference a declared
input (`{kind:'input', name, path?}`) or its admitted item
(`{kind:'item', field:'value', path?}`). The selected value uses the same strict
role-or-Agent/model engine schema as a literal selection. Contributions pass
through the canonical validator and accepted-snapshot materializer; plugins do
not supply a separate binding resolver or gain authority from a reference.
Generated SDK bindings and composed live validation close at the integrated
Workflow boundary.

The [workflow contribution-family normalizer](../packages/protocol/src/plugins/contributions/workflows.ts)
qualifies plugin-local Action ids, including nested blocks and evaluators, through
the existing contribution identity owner. Explicit host and qualified Action ids
retain their meaning. The family runs `validateWorkflowDefinition` and refuses
invalid graphs with `plugin_workflow_invalid`, carrying the plugin, workflow and
canonical path-level issues. Reference availability stays at run admission;
normalization does not discard references to unavailable contributions or grant
the workflow additional Action authority.

The CLI reads the current serving occurrence from its contribution registry. The UI's Account Workflow Action owner reads the serving machine through the existing Account-scoped daemon projection cache and shares the same descriptor projection and reference resolver. A failed or retained projection is not a current plugin source; saved Account workflows remain readable without a serving machine. Closed Work menus do not subscribe to or load the detailed Workflow library.

### Atmosphere pictures and scene planets (0.3 development source)

Plugins declare `atmospherePictures` in `definePlugin`, keyed by local id. Each
entry supplies its title, credit, full/thumbnail source URLs, crop and horizon,
theme grades, optional adjustments, and release look. The
[closed picture schema](../packages/protocol/src/plugins/contributions/atmospherePictures.ts)
owns admission. This data-only family has no registration callback: the existing
manifest catalog and occurrence projection own its publication and retirement.

The host [picture catalog](../apps/ui/sources/components/atmosphere/pictureCatalog.ts)
merges the built-in pictures with admitted contributions. Plugin ids are qualified
as `pluginId/localId`, including in the existing picture selection and remembered
look keys. Selecting one downloads and caches its full and thumbnail URLs through
the existing device-local picture store. While the first local read is pending,
the selected Picture stays selected and the opaque page remains usable; an already
shown picture remains visible during replacement. On Home and Projects, a settled
absence or a removed contribution falls back to the Home default. Authors
must provide image hosts usable by the client, including browser CORS support,
and credit the picture's licence; no Happier image proxy is added.

The development profile-copy boundary reuses that presentation, catalog and Look
logic, without inheriting Home moments, Session activity or global glass. A private
profile preview reports unavailable selected pixels instead of substituting Home
or a previous image. The shared picker acquires through `settings.invoke`; its
captured Home, Project or profile-draft owner selects the result. Project and
profile acquisition never selects Home as a side effect.
The [local preparer](../apps/ui/sources/components/atmosphere/preparePublicProfileAtmosphere.ts)
retains a lossless PNG and frozen effective Look/credit/crop metadata without an
upload or library write. The [selected-copy contract](../packages/protocol/src/account/publicProfileAtmosphere.ts)
also admits already-prepared WebP; the media owner normalizes stored copies to PNG.
The descriptor captures the existing adaptive-haze decision as a render input,
not another editable preference: released builtin Looks adapt legibility, while
own pictures and customized Looks remain as composed. The copy shape omits local
picture addresses, plugin ids, source-URL fields and inactive remembered Looks;
this does not inspect or redact text authored into the selected pixels or credit.
Publish/Update keep selected pixels in the existing live-only approval invocation;
the durable Approval Artifact and observations omit picture content. A lost live
invocation cannot replay the pixels from approval history. Only reviewed
Publish/Update may send the copy;
public delivery must bind it to the applied edition and recheck current profile
admission before bytes or validators. Visitors never load the plugin or fetch its
image URLs. Later plugin/default changes, device deletion and facts refresh must
not re-resolve or alter the copy. The preparer, custody and static-raster seams
are implemented; their profile consumer and public route integration remain open.
These are development contracts, not a claim of released profile availability.

Plugin UI scenes use their existing `planetAt` declaration for placement (`x`,
`y`, `r`, and `rise`) and optional `style: 'airy' | 'balanced' | 'rich'`,
`fullness`, and `digits`. The host's
[SceneArt](../apps/ui/sources/components/ui/surfaces/SceneArt.tsx) renders authored
looks through PlanetCanvas's Brand scene core, preserving explicit `0` and
`false`. Omitting all look fields retains the existing scene mark calibration.
Placement, ground clipping and the one-shot rise remain scene-owned; rendering
stays with the same host canvas, with no additional SDK planet component.

### Language servers (0.3 development source)

`definePlugin.languageServers` is a descriptor-only record keyed by local id.
It projects to the strict `contributes.languageServers` family. The Machine
that holds the workspace reads its current admitted registry through
`lsp/languageServerDefinitions.ts`; installed external and bundled declarations
use the same projection and qualified identity. Discovery does not activate
plugin code. The host owns on-demand startup, document state, queries,
diagnostics and disposal in `lsp/languageServerHost.ts`.
Document sync acknowledgements report only that document's selected servers and
capabilities; workspace-root watches still aggregate the root's live servers.
For an acknowledged document, the next explicit query after daemon replacement
resynchronizes its retained text, reopening its lost lease only when the host
reports that it is missing. An acknowledged root-generation change also rebases
diagnostic delivery; an old root's revision or late query cannot supply the new
answer. This does not restart a crashed language server automatically.

In this development catalog, `appliedGeneration` is a runtime-application fact,
not an installation or descriptor-readiness flag. For a plugin with a daemon
entrypoint, only descriptor contributions and no startup activation event,
install validation may evaluate that entrypoint and report an applied
generation. A fresh daemon leaves that target dormant, so its applied generation
is `null`; language-server queries can still use its current admitted declarations
and managed executable without activating plugin code. The contribution's
`activation: notRequired` and projection state describe that path.
A null applied generation alone proves
neither healthy availability nor activation failure; inspect the affected
contribution and its diagnostics.

Each declaration supplies `title`, a `languageIds` map from UI/highlighter ids
to LSP ids, `executable` and `args`. Optional `filePatterns` provide matching
fallbacks. For a language unknown to the app, declare its own language key and
file patterns, with one distinct LSP id in `languageIds`; the host uses that id
when the pattern matches. Multiple keys may map to that same id. A pattern-only
match with several distinct LSP ids is unavailable rather than guessing.
Mapping the generic `text` key would also select unrelated plain-text files.
Omitted or empty `rootMarkers` select the workspace root; markers
are for servers that require a narrower root. `initializationOptions` are
opaque JSON sent at initialization, while optional `settings` answer the
server's dotted-section configuration requests. These configuration bags carry
server options, not host authority.

`settings` are also sent once through `workspace/didChangeConfiguration` after
`initialized`, before documents open, for servers that consume notifications.
An optional `initializationOptionsSetting: { scope, field }` reads one declared,
non-secret setting from that plugin's canonical Account or daemon settings
service at startup, including descriptor-only plugins without executable
activation. Its value replaces `initializationOptions`; unavailable
settings fail startup instead of selecting a different scope or falling back.
Changing initialization options takes effect on Restart. No query-time read or
settings watcher is added. The binding and executable declarations remain closed.

The development `lang-web` plugin uses this binding for JSON schema protocols:
only local `file` schemas are enabled by default. Explicitly adding `https` or
`http` in its Machine-scoped Schema loading setting permits those downloads
after Restart. The server handles `$schema` and local schema references itself;
the host adds no JSON-specific request handler or parser.

Native completion edit positions are projected against the held document before
the shared response reaches either editor, including an exclusive EOF position
past the final line. The host indexes the document once per completion list;
completion resolution uses the same projection. Explicit server-backed hover
keeps the caret even when the fallback lexer has no identifier there (for
example, a schema-backed JSON property string); fallback searches remain lexical.

An optional `projectCheck` contribution declares `executable`, `args`, a
workspace-relative `projectFile`, and `output: { kind: 'typescript' }`. It uses
the same managed-dependency/system-tool reference admission as the server.
The Machine executes it only for an explicit project diagnostics request when
the server does not advertise workspace pull diagnostics. The output codec
accepts file diagnostics, continuation lines and source-less configuration
errors (attributed to `projectFile`). Unknown output or a failing process
without diagnostic evidence is a failed check, never an empty success.

Executable declarations reuse `PluginDeclaredExecutableRefSchema`: a reference
to `managedDependencies` or `systemTools`. The manifest reference owner rejects
missing dependencies. There is no command string, project-local executable,
resolver callback, environment override or separate timeout policy. The bundled
`lang-typescript` plugin uses the pinned native TypeScript archive with automatic
type acquisition disabled. The archive keeps the standard-library declarations
beside its executable; see [binary runtime](binary-runtime.md#native-language-server-acquisition-03-development-source).

JavaScript language servers can declare a `managedJavaScriptPackage` source in
`managedDependencies`, with an exact `packageName`, `version`, and `installId`.
The dependency's `executable` names a bin in the installed package's metadata.
The shared managed package installer retains its dependencies and disables
lifecycle scripts. The resolver runs the JavaScript entry through the existing
managed runtime, without a system-Node or shell-shim launch. Acquisition is an
explicit install operation, not a document-open side effect. This path is shared
by bundled and installed external plugins.

The approved 0.3 delivery starts a server for an explicit language query or on
entering Edit; View and Changes keep query-driven activation. A plugin supplies definitions only on
the Machine where it is installed and enabled. Public source availability,
loaded-runtime proof and released SDK availability remain separate facts in the
generated capability matrix. See the [author declaration](../apps/docs/content/docs/plugins/manifest/contributions.mdx#language-servers-in-development).

## Native ingress ordering (0.3 development source)

Host-scoped JSON-RPC clients expose `onNotificationReceived` for synchronous
observation of parsed native notifications before ordered `onNotification`
dispatch. It supplies the original `receivedAtMs`; observers do not transform
frames or perform asynchronous work. The existing bounded callback queue still
owns ordinary notification processing. This observes admitted messages, not
unparsed bytes waiting behind a stream reader.

OpenCode's subscription owner feeds normalized live SSE events through one
connection-owned Promise tail that preserves semantic order. Cancellation retires that connection and
skips its remaining callbacks, while a normal stream end drains admitted work
before reconnecting. The single SSE parser and connection provenance classifier
remain the admission owners.

### Shared usage row (0.3 development source)

`@happier-dev/plugin-ui/presentation` owns `UsageMeterRow`, `UsageMeterStack`
and their typed props and column metrics. The author-facing `/components` and root exports supply
the mounted plugin theme to those same owners. Core's connected-services
`UsageMeterRow` is its domain adapter: percentage normalization, quota tone,
estimated/unavailable wording, reset phrases and accessible descriptions stay
in the host. The public presentation owns inline/stacked anatomy, shared name
measurement, responsive reset columns and the existing progress/capacity
geometry. Uncapped amounts retain their value without a bar; unknown and zero
remain distinct. Neither row acquires usage or schedules time updates. The
public-import example is `packages/plugin-ui/fixtures/external-authoring/src/usageMeterSurface.tsx`;
the [author guide](../apps/docs/content/docs/plugins/ui/react-native.mdx#usage-meter-rows-03-development)
shows the same public seam.

The same public presentation entry point exports `OfferedChoices` and `OfferedChoiceFeedbackInput`.
`PermissionFooterOfferedChoices` projects permission refusal, availability and localized scope descriptions
into this shared adaptive row/list/feedback owner; `PermissionFeedbackInput` binds the same field for
plan-change prompts. Native decision refs and app TextInput are host renderer bindings, without local
geometry. Primary selection and permission submission remain host/domain responsibilities.
The public authoring fixture is `packages/plugin-ui/fixtures/external-authoring/src/offeredChoicesSurface.tsx`.

## Public seam and authority

The unpublished 0.3 SDK exports author contracts and `/testing` testkits.
The retired `/host/*` and `/first-party/*` facades are absent. Host registration,
filesystem and UI implementation remain private to `cli-common`; bundled Agent
and Provider facts use their canonical Protocol leaves. No released SDK
compatibility adapter or alternate host registration owner is introduced.

CLI Actions capture credentials once at admission. Subsequent local credential
checks observe cancellation; they do not reread the login file before each
effect. The server authenticates each call and refuses a revoked bearer on the
next call. New targets, transformed input and domain revisions retain their
own admission checks. UI Account retirement still withdraws old-scope results.

Managed-Machine plugin pages in matching 0.3 development builds observe the
existing active inventory with the closed Resource reference
`{ hostRead: 'machines.managed.list', input: { homeId } }`. The mounted host
prepares that exact Action read before borrowing the canonical inventory's
demand, currentness and Home-change observation. Plugins filter admitted rows;
they do not create another list loader or timer. Explicit Retry reaches the
same reader, and Account retirement withdraws visibility. The public
`classifyManagedMachineAllocationV1` helper on SDK `/machine-provisioners`
shares allocation/progress classification with the host while leaving
operation correlation, translated labels and recovery at their domain owners.
The [Machine page example](../apps/docs/content/docs/plugins/examples/action-resource-ui-plugin.mdx#observe-managed-machines-in-development)
shows the public Resource usage.

The development Provider SDK projects Protocol's canonical endpoint and credential
types through `@happier-dev/plugin-sdk/providers`; it does not keep an independent
author schema. Required endpoint overrides, address/model constraints and required
public routing headers are authority-bearing declarations. Localized policy hints
and credential authority descriptions explain their consequences without granting
authority. Public policy uses connection Actions and inherited layers; secret
custom-header and additional-slot values stay in the existing credential custody.
See [Providers](providers.md#credentials-and-endpoint-safety) for the effective
endpoint owner and [the Provider-author guide](../apps/docs/content/docs/plugins/guides/providers.mdx)
for the external author contract. The maintained public-import fixture is
`packages/plugin-sdk/fixtures/authoring-inference/providerEndpointPolicies.ts`.

### Workflow patterns and Run presentation (0.3 development source)

In unreleased 0.3 source, Workflow step editing uses the shared Session model
picker: its heading is Model, without an Effective row. Thinking choices use
the shared choice-control rule, with a select for larger or long-labelled
sets and segments for short sets. Fresh named-step Sessions receive the authored
step title through `formatWorkflowStepSessionTitle`; existing Sessions keep
their titles. Human Wait/review answers resolve **Answered by** through the
captured-Home People projection, never the Run starter. Session Info mounts
the shared Habits section for Starts here and Writes here.

Patterns are ordinary `definePlugin({ workflows })` descriptor contributions,
resolved by the existing Workflow catalog and admitted materializer. Participant
inputs and qualified Discussion context references use the canonical Workflow
types and generated Action DTOs. Plugins invoke `workflow.run.start`, its
read/control Actions and `workflow.definition.capture` through the existing
typed Actions service; capture returns a reviewable draft and ordinary
definition create/edit owns persistence. There is no plugin-only start path,
participant resolver, pattern registry or result publisher.

`WorkflowRunFoldHeader` on plugin-ui's existing public components surface binds
the same presentation renderer as core's Session fold and Discussion Run row.
It accepts already-projected words, disclosure state, slots and callbacks;
it neither interprets Run lifecycle nor reads, controls or navigates by itself.
The host retains exact Run data, current control eligibility and navigation.
Existing public typed Form/field components remain the field owner. API census,
declaration preparation and external-authoring checks are package-owned; source
exports do not establish publication or loaded-platform acceptance.

In the 0.3 development SDK, shared Session target authoring belongs to
`@happier-dev/plugin-sdk/sessions`: import the target schema and its target,
selector and declaration types there. The schema delegates to Protocol's
`actions/sessionTargetV1` owner. Existing `/actions` type imports for this
unpublished surface must move to `/sessions`.

In 0.3 development source, Session-targeted Action declarations project the
same `sessionTarget` operand/cardinality metadata through built-in and contributed
catalogs. Plugin callers submit selector intent to the Actions front door;
they do not enumerate recipients, choose a first match or expand an approval
again. The prepared concrete addresses retain their normal Home/access checks.
A Discussion selector means executable Session participants, never people;
membership does not grant transcript access or create a model Session. Declared
selectors without current backing refuse as unavailable. See
[Actions](actions.md) for the resolution owner and current support boundary.

Installed external Actions retain this public declaration through the admitted
runtime's discovery projection. `action.invoke` projects the declared path
under its `input` operand and enters the existing shared resolver before plugin
input parsing and approval. The read-only inspection Action accepts the same
canonical qualified id advertised by discovery. SDK calls inside the runtime
consume that same declaration projection; they do not create another resolver.
Read signatures retain the admitted wrapper root, and approval retains concrete
targets rather than re-expanding selector intent.

Session send, exact reply and Post update also share those host contracts.
An Agent plugin supplies native accepted-input/turn/result facts; the host owns
the original input's reply fulfillment, informational return, receiver admission
and autonomous check-in. A public destination field does not itself authorize a
return route or protected source facts; present-person admission must bind it. The
[Pending delivery contract](pending-delivery.md#correlated-session-answers-03-development)
keeps exact-input observation separate from Run-lifetime waiting and Channels'
external effect custody. SDK declarations and generated references do not prove
that a loaded host, composer or Voice journey has passed integration validation.

Plugins use the same `session.message.send` reply modes and
`session.message.reply` answer/pass arms through typed `actions.execute`.
`session.targets.resolve` previews the intended Action's selector without an
effect. A preview is neither executable approval custody nor an access grant;
the eventual Action prepares its own concrete targets. There is no separate
SDK ask or message-followers operation to implement.

The public client SDK negotiates non-`none` replies and supplied structured input by reading the selected
executor's actual `action.spec.get` projection over the same captured transport
and target. The existing `readCompleteActionSpecV1` reader restores advertised
schema sections before validation. The shared Protocol `supportsSessionMessageInputJsonSchema` predicate
uses the canonical Action JSON Schema compiler to accept the request and reject
an invalid value for each requested semantic; a passthrough schema does not attest support.
A human return destination and structured-input envelope must also be validated rather than ignored. Missing
support refuses before the send. This adds no capability cache, alternate schema
parser or observation deadline; ordinary unstructured information and predecessor boolean
wait inputs retain their existing ingress behavior.
The shared predicate also checks explicitly forwarded model, Provider-connection,
attachment, source and idempotency operands. It never changes the actual caller's
public-versus-Plugin input schema or grants authority to author protected fields.

In 0.3 development source, Session-primary Agent factories may expose
`executionRunContextV1.openConversation(request, context)` alongside finite
`open`. It returns the existing `AgentExecutionRunConversationRuntimeV1` with
send/watch/dispose and optional cancellation, under the same truthful detached
Run context. Retained host Runs discover this optional operation on installed
factories as well as bundled ones; absence refuses retained execution rather
than opening a finite or fresh conversation. Existing finite callers keep `open`
and its terminal semantics. ACP Agent leaves forward through the optional host
operation `context.protocols.acp.openExecutionRunConversationV1`; an older host
without it cannot supply retained ACP execution. Existing finite requests,
authority envelopes and event unions retain their V1 contracts. This is an additive
operation under the [SDK evolution doctrine](compatibility.md#sdk-protocol-evolution),
not an ignorable retention input or a new Session identity.

Implementing this new conversation operation guarantees that a supplied send
option `permissionIntent` is enforced before native input effects, or the input
is refused. It is the host-resolved public native policy for that input, not
private caller metadata and not a replacement for its immutable causal witness.
Use the Agent's existing configuration owner; an unsupported native mapping must
not silently retain the opener's broader policy. Older finite operations are
unchanged and do not receive this authority-bearing option. The guarantee belongs
to the new optional operation, not to an ignorable extension of a previously
supported finite path.

In 0.3 development source, `/components` and the package root form one Plugin UI author layer. They expose themed adapters and domain-neutral shared producers from their existing implementation owners. `/presentation` remains the host app's implementation entrypoint, including mounted host controls; plugin UI artifacts cannot import that entrypoint or its nested subpaths, and author API governance excludes them. The package-owned generated reports describe the author exports.

The 0.3 development Agent SDK adds `AgentSessionSkillDelivery` on
`AgentSessionOpenRequest.skills` and `AgentExecutionRunOpenRequest.skills`.
It names the host-owned `pluginRoot`, its `skillsRoot`, delivered
`{ name, skillId, digest, directory }` items and native `{ name, path }` disables.
Each required `directory` is the absolute skill folder admitted by the daemon
materializer. Imported source folders can differ from frontmatter `name`, including
after a rename; path reads, private-home copies and catalog identity matching consume
`directory` rather than reconstructing it from `skillsRoot` and `name`. Copies retain
the directory's basename so selected siblings' relative references still resolve.
The closed delivery schema and daemon response carry this same current-development
shape, without a fallback for the unpublished predecessor shape. The shared
Run-to-Session adapter preserves this delivery alongside MCP bindings. Plugins
receive resolved delivery only through the open request, without a pull service
or composer dependency carrier. `AgentSessionRuntime.skillsDelivered` can report
an unsupported launch path; `refreshSkills` is reserved for Agents declaring
`capabilities.skills.liveReload: 'supported'`. The development delivery vertical
resolves skill selection in the host, materializes read-only content through
the daemon, and gives Claude and Codex their session-only native path. The shared
`testing` launch observer and skill delivery contract exercise native launch,
disable overlays and unsupported variants; they also serve tool-policy tests.
K0/K1 uses a source folder different from the declared name to reject plugins that
ignore the admitted location.
For Gemini's private-home launch, the same kit reads the delivered bundle and
copied disable settings from that home, including supporting files and native
home preservation; an argv directory reference is not required for this layout.
Agents without a native knob receive the index only through a declared Action
channel and read content with the safe `skills.read` Action. These are current
development-source contracts, not release or vendor-tenant certification.

An Agent whose native plugin scanner rejects links can declare
`capabilities.skills.materialization: 'copy'`. The host forwards this to the
daemon's existing skill-store copy path; absence keeps the platform's normal
layout. Auggie's custom ACP leaf consumes that same daemon-owned `pluginRoot`
as a local marketplace, with no second materializer or native-folder write.

Skill catalog facets use Protocol's `SkillCatalogItemV1` directly; there is no
parallel SDK item shape. Agent facets produce their native catalog facts, while
the host annotates native rows that match current delivered identities; it does
not fabricate availability for skills omitted by the native catalog. The shared
delivery owner preserves source folders and publishes a regular `SKILL.md`
entrypoint, including on POSIX: Codex skips file-symlink entrypoints. Supporting
children retain their existing cache links unless the Agent requires full copies.
Claude's SDK reload waits for
both its successful `reload_skills` control response and `commands_changed`;
Codex's app-server reload waits for the repeated `skills/extraRoots/set`
response. Their terminal and shared-proxy launch paths retain their explicit
restart requirement. The shared contract kit checks native-home preservation
after refresh as well as at launch.

Plugins declaring `capabilities.skills.usageEvidence: 'reported'` publish native
invocations through the closed `skill-usage` runtime event. Its items report
native names and optional paths; only the host maps those observations to
delivered library identities. K13 in the shared delivery contract validates the
real producer output against the runtime schema. The Account timestamp recorder
and its failure semantics belong to [runtime core](runtime-core.md#session-path-and-owners).

The fallback index contains delivered skill names and frontmatter descriptions,
omitting skills marked `disable-model-invocation`; it does not paste bodies or
truncate the item count. The safe `skills_read` tool reads full instructions and
supporting file bytes through the same bundle validator as native delivery.
Session-bound tools default an omitted `sessionId` through the `skills.read`
Action declaration. Its canonical strict input schema also supplies the MCP
advertisement and validation; `includeFileContents: true` returns supporting
files with their content kind and executable modes. A name read still requires
a current delivered Session identity before content is disclosed.

The 0.3 Export retirement removes executable prompt-asset adapters and their
registration/generator conventions. Static `promptAssets` system-prompt
contributions remain declaration-owned. Native skills are read through the
Agent catalog's `capabilities.skills.nativeRoots` and the host scanner;
`skills.machine.install` is the explicit outside-Happier writer. The existing
`daemon.promptAssets.download.*` ids remain the scanner-backed Found byte
transport, rather than an adapter API. They do not restore asset-type discovery,
upload or prompt-document-to-command export. Legacy receipts and stored generic
bundle readers remain data compatibility, not competing delivery owners.
Create and Update validate supplied skill names with the frontmatter owner's
name schema at Action admission, before offering approval.
The Protocol frontmatter owner decodes YAML before checking skill names and
invocation flags; quoted scalars and block descriptions have their YAML meaning,
and nested metadata cannot replace top-level fields. Create and Update edit that
same YAML document, preserving retained metadata and the instruction body;
frontmatter decoding, writing and cost projection share delimiter framing.
The stored bundle reader first decodes YAML. On YAML syntax failure only, it
uses the exact 0.2 `readSkillBundleFrontmatter` line projection for retained
name/description, then validates those fields at the same owner. The 0.2 writer
persisted Markdown verbatim, so unquoted description colons and unmatched scalar
brackets are retained inputs, not whole-library failures. Valid YAML block
scalars and nested metadata keep their decoded YAML meaning; semantic failure
of valid YAML does not enable the fallback. Current imports and writes stay
strict and `writeSkillFrontmatterV1` emits valid YAML. This read-only adapter
remains while predecessor-written stored bundles are supported.
New skill imports and writes require portable paths. Stored bundles retain the
predecessor's safe relative POSIX paths, including Windows-reserved names; the
Windows materializer refuses only that item through `materialize_failed`. Name
catalogs omit malformed stored items while retaining healthy neighbours. Full
`skills.list` reads expose those identities through `unavailableItems` with a
public title when known and the item-level refusal reason, never invented
description, trust or cost. The UI data hook retains these diagnostics alongside
last-known healthy items through a failed refresh. Found joins native scans only
to readable library content: a refused item supplies no membership or masking
fact and does not withdraw unrelated native skills. A
failed or incomplete Artifact inventory still withholds the whole catalog and
blocks GC, as does unreadable Artifact-library content. GC retains first-party
content and live Session/Run pins; unpinned plugin delivery caches are evictable
without complete Account-wide plugin coverage (see [runtime ownership](runtime-core.md)).
Name reads require a Session and resolve against its current delivered identities
and digests. UI and remote CLI name reads reach that Session's owner through the
existing Session Action RPC; an explicit `skillId` without a Session reads the
Account library directly. Supporting files retain their byte sizes and `unixMode`.

In 0.3 development, SDK `fs#createSecureTempDirectorySync({ prefix, tmpDir? })`
keeps its existing `{ path, cleanup }` contract and delegates to
`@happier-dev/cli-common/tempDirs`. Runtime temporary directories live beneath
the caller's root (or OS temporary directory) in a private `happier-<uid>`
parent; Windows uses a user-home identity hash where no numeric UID exists.
The existing trusted temp parent is resolved to its physical filesystem path
(including macOS's `/var` alias), while the private user-root leaf still rejects
symlinks. An unavailable parent remains unresolved until creation makes it available.
Each directory has a private sibling `.owner.json` marker containing its
purpose, creator PID and the canonical process-start fingerprint. The marker
does not alter payload contents. The returned directory handle's cleanup removes
both directory and marker. Existing string-returning secure file writers keep
their established payload cleanup contract; sibling markers left by those
callers remain non-collectable own data pending the storage maintenance owner,
not evidence of a collectable temporary directory.
An unavailable fingerprint means unknown ownership, never proof that the
creator has exited; retained recovery payloads also require their lifecycle
owner's facts before storage cleanup can consider them disposable.

Development Connected Account manual modes may have no credential fields when
they select existing native setup through configuration. Cua's native setup path
is Account configuration with reconnect-on-change, not a rotating credential:
the captured configuration revision prevents it from redirecting retained
resources. BYOC's separately selected cloud and Cua references must identify the
same existing native setup.

In 0.3 development, a manual authentication mode may declare
`setup: { url, checklist, permissions?, createKeyTitle?, billingNote?, shapeHint? }`.
`url` is a credential-free HTTPS console destination; `checklist` and the optional
text use `PluginLocalizedStringV2`. The sheet renders `checklist[0]` as the link to
`url`, so write it as the sentence that opens the console, with no URL in it.
`permissions: [{ feature, items[] }]` lists what the credential must allow, per
feature, beneath the steps; it is a list to pick from, not more steps. Any field of
a credential form may set `presentation.advanced: true` to fold under one Advanced
row: closed by default, open when a field holds a value, kept open while one is
required, and reopened when one fails validation. This presentation data travels through the
existing Connected Account projection with that mode. The generic Connect sheet
shows manual fields before authentication starts; submitting the draft enters
the existing configuration and authentication flow. Merely opening a sheet does
not begin authentication. Guidance belongs to the mode, with no descriptor-level
`ui.manual` alternative or service-specific UI guide.

In 0.3 development, Connected Account authorization-code modes declare their
own `callbackUrl`. Manifest admission rejects a code-flow descriptor without
one; the generic OAuth attempt and persistence owners have no vendor callback
default. Codex declares its loopback callback in its own manifest.

Authorization-code begin results may supply `issuer` and
`issuerResponseParameterRequired`. The generic attempt owner seals these facts
with its PKCE transaction. Completion carries the callback's optional `iss`;
when present it must match the sealed issuer exactly, and when required it may
not be omitted. Rejection happens before the runtime's token exchange and does
not disclose the callback's provider error text. OAuth state is the attempt id,
a dot, and the existing random nonce; the prefix routes a callback, but only
the complete sealed state authorizes completion.

The development host service `happier/mcp-sign-in` uses the same Connected
Account registry, attempt, configuration and credential owners. Its closed
host custody is not a plugin identity or HostAccess grant. Host discovery may
stage validated account configuration during `beginOAuth`; it is sealed with
the attempt and written only by the existing credential/configuration
settlement. Plugin identity grammar and plugin invocation authority are
unchanged.

In 0.3 development, the existing `mcp.servers.create` Action projects four
Cloudflare choices from the MCP catalog's data-only `catalogSuggestionsV1`
records through static `suggestionId` options. `action.options.resolve` serves
the same choices to clients and agents without vendor requests. Selecting one
creates one ordinary Account row with explicit reach; it adds no Registry
provenance, update subscription, credential or vendor resource. Registry-backed
creation remains a separate input to that same catalog owner.

HTTP import/install links may carry only the closed credential-free
`auth: { kind: 'oauth' }` intent. The encoder, parser, preview and materializer
preserve it into the saved row, whose existing Sign in Action owns consent.
Omission preserves public/no-auth behavior. Invalid or credential-bearing auth,
or auth on stdio/SSE imports, is refused rather than discarded. Export never
includes tokens, issuer registrations or a previous grant.

The shared MCP Action owner requests operation-specific peer admission when
describing this service: credential writes for sign-in and credential deletion
for removal. UI and CLI adapters transport that same command rather than
reconstructing it. The daemon supplies its v4 operation-transport fact only
for an explicitly requested operation; an unqualified description is not
authorization to begin a grant.

MCP OAuth discovery, registration, token exchange, refresh and revocation use
the host runtime's HTTPS-only transport; the browser authorization endpoint is
checked before publishing a redirect. An HTTP endpoint is refused with
`mcp_oauth_endpoints_require_https`, including an HTTP localhost authorization
service. The [MCP 2025-11-25 communication-security contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#communication-security)
permits localhost only for redirect URIs. The host's existing redirect refusal
also prevents a redirect from forwarding exchange or registration secrets.

The development MCP callback controller consumes the stable
`https://app.happier.dev/oauth/mcp/callback` response and strips its query before
any browser handoff or asynchronous work. It forwards code, full state and
optional issuer to an opener, or uses the existing Connected Account Actions
on the retained or discovered same-Account machine. Account retirement aborts
completion; a signed-out client or an attempt without a reachable owner keeps
the full callback URL for paste. The state prefix selects an attempt, never
authorizes it. Callback rendering and installed-app return remain separate
UI and release obligations.

The host MCP grant is available only to its daemon-issued request-auth subject,
bound to the exact current server resource and captured Session/Run authority.
Generic Plugin purpose selection, activation and materialization cannot select
this host grant, even by claiming the same purpose address. The private subject
uses the existing purpose, capability and refresh owners; it is not another
public SDK target or an executable Plugin declaration.

In 0.3 development, a late 401 for a replaced credential remains a stale
context. For the same admitted account and group generation, the request-auth
owner may ask the existing refresh coordinator to check the replacement's
independent expiry; a still-fresh replacement is reused even inside the normal
early-refresh window. An expired MCP token with refresh material reports
`expired`, while missing refresh material requires reconnect. Freshness checks
and current-token rejection recovery share the existing operation owner but
cannot absorb each other's result when revisions reuse the same bearer.

In 0.3 development source, MCP capability issuance shares the admitted
requester's proof across nested catalog and grant readers within each existing
currentness checkpoint. It rechecks requester authority after grant reads and
again around the staged capability's final authority commit. Every later broker
validation starts a fresh checkpoint; neither another issuance nor a credential
request can reuse a settled proof. File-only phase diagnostics separate catalog
admission, initial admission, capability-directory preparation and final commit
without recording resource URLs, capability paths or credential content.
Legacy catalog transfer and source maintenance leave preparation reuse while
they capture source, promote Secrets, activate the catalog or clean retained
source/history. Their existing effect checks stay fresh, and returning to
preparation invalidates its earlier requester observation.

The remote bridge's existing lifetime redaction lease covers per-request OAuth
bearers and supplied static-header credential representations, including Basic
credentials. Its Agent-facing output projection preserves SDK-owned protocol
fields and correlation facts while redacting private dictionary keys and
string payloads. The same lease protects diagnostics through rotation and late
responses; static authentication policy is unchanged.

MCP discovery sources also declare `loadedInHappierSessions`. Discovery retains
this fact in each detected definition; session previews omit sources that the
Agent does not load in Happier. This keeps native configuration discovery
separate from delivery without host decisions keyed to an Agent id.

The OpenCode Agent's Provider-binding and Connected Account auth producers
return structured configuration parts. Its single deep merger composes those
parts with ambient configuration; the shared spawn owner writes
`OPENCODE_CONFIG_CONTENT` for both managed-server and ACP launches. Nested
fields and array entries survive composition, while later scalar values win.

- Plugin leaves import public SDK entry points and their owning public feature protocol. They do not import host internals or private Protocol validators. SDK `*.public.ts` files own each named export list; ordinary package entrypoints forward that same list to runtime consumers and the API census. Browser entrypoints project only the exports available in that realm. Package `exports` maps own subpath resolution, and generated reports are never hand-edited.
  In 0.3 development source, an authored type-only re-export list can delegate
  Action family names to the DTO producer. The inventory resolves those names
  to their canonical leaf declarations; runtime wildcard publication remains
  forbidden. Adding a family does not require a second handwritten export list.
- Host services bind the invocation's admitted plugin, generation, scope and authority. Caller identity, selected credentials, Session ownership and machine routing cannot be supplied as renderer or Action input. In unreleased 0.3 development source, the service descriptor constructor creates each service and derives public availability from that result; a missing host binding returns `plugin_service_unavailable`. There is no separate binding availability bitmap or manifest-scope service veto. HostAccess fields remain accepted installation-consent metadata; Connected Account purpose references still select compatible services and the host-owned binding.
- In 0.3 development, daemon Action handlers receive `PluginInvocationContext.invocationId`, the existing host correlation identity. An approved operation uses its durable approval-request Artifact ID across replay; fresh independent Actions receive distinct identities. Other callback kinds may omit it. Plugins can forward it as an external idempotency key, but it grants no authority and does not change approval replay eligibility or ambiguous-effect recovery.
- A feature Action may accept an admitted source address for selection while deriving caller provenance from the host invocation. In 0.3 development, Triage reads let any same-Account caller name an admitted source. Source-less plugin reads retain their own-source default. Publish and source administration retain caller-bound write provenance; a nested plugin call cannot change that provenance by claiming a host origin surface.
- In 0.3 development, Machine `action.invoke` admission requires Manage, including
  for another Account's Machine. Manage can run and install native plugin code;
  Can use cannot invoke this Machine-wide entry. The existing Action confirmation
  and Account custody owners remain in force. Native Connect authentication/control,
  private Provider connections and connected-service pool selection retain their
  own custodian-only routes. Admission is decided once
  at the existing Home Machine admission owner, not again for each native step.
- In 0.3 development, structured-message daemon ingress accepts bound plugin
  invocations and host-presented Composer/Message Actions. The shared socket
  transport projects the target Machine, invocation kind and distinct referenced
  Session IDs into `structuredMessageRouting`, outside encrypted content. Home
  uses the existing `action.invoke` Manage policy for `mountedPluginSurface` and
  `clientPluginAction` claims; matching a live registry declaration does not prove
  that a client mounted it. Host-presented Composer/Message kinds retain Use and
  their Session admission. Consequently, Use grantees cannot execute Actions from
  session-less mounted plugin views. Home admits the required Machine role and each
  Session once, stamps that projection in `machineAdmission`, and the daemon
  binds it to the decrypted request before dispatch. For E2EE Accounts, Action
  inputs, message IDs and Composer contents remain encrypted. Resource watch open
  applies the same admission to a nested Action-read invocation; ordinary watches
  retain their behavior. The separate direct peer route accepts only the verified
  Machine custodian, with Manage and Home verification; it retains daemon-owned
  invocation provenance checks and is not shared Machine Use ingress.
  Missing invocation provenance is refused before structured dispatch; unbound
  host repair controls use the same Manage-only `action.invoke` entry.
- Actions own request/response and effects; Resources own reads and invalidation; Events carry facts. Keep their different cancellation and lifecycle semantics. [Actions](actions.md) owns invocation surfaces, placement and confirmation rules.
- The [runtime core](runtime-core.md) owns Session/turn admission and transcript/lifecycle state. [Providers](providers.md) owns model sources, connections and materialization. SDK projections do not transfer those domains to plugins.
- In 0.3 development, Agent Provider-binding environment declarations distinguish required `authIsolation.ownedEnvKeys` from `optionalOwnedEnvKeys`. Materialization must cover every required key exactly once and may emit only a declared optional subset, without duplicates or overlap. This lets managed-only native configuration leave external bindings unchanged. The adapter's optional `modelRoles` consumes connection-owned `roleModels`; the plugin's portable Provider requirements project the same declared roles to editors. Only the selected adapter's declared roles are admitted and materialized.
- Trusted daemon and native plugin code is executable code. Managed services provide portable APIs, resource custody, cancellation and diagnostics; they are not a malicious-code sandbox. Per-plugin network targets, filesystem scopes, Exec environment keys and system-tool argument lists do not restrict trusted code. Account and Team authorization, credential-origin handling, secret redaction and OS permission boundaries still apply.
- Capability declarations, runtime registration and lifecycle must exist in the applicable realm. A daemon declaration does not establish browser or native support. Registry publication and a loaded invocation are separate evidence, not substitute availability authorities.

In 0.3 development source, Plugin UI `readResource` and `watchResource` also
accept the closed host-read reference `{ hostRead: actionId, input }` for
`usage.query`, `connectedServices.quota.get`, `connectedServices.pools.selection.get`,
`discussion.get`, `action.operations.get` and `deployments.environments.list`. The deployment
collection observes every matching page, including current receipt state, through the
existing deployment controller and Account change subscription while presented. Its
JSON projection includes canonical controller availability, observed through the
existing keyed Machine presence owner; a controller pause or reconnect changes the
Resource digest independently of receipt readiness. An exact repository and pull
request query may include deleted children to retain cleanup and publication history.
The operation read is qualified by
Home, custodian Machine and operation id, and retains the existing operation
owner's `available`, `reconnecting` or `unavailable` observation beside its
snapshot (or null). It selects a host snapshot, not
a plugin contribution or an authority. The canonical Action preparation owner
admits the current plugin caller, input, settings and captured Account before
the mount can join the existing Resource store. A safe read still obeys an
explicit plugin-caller policy. One-shot `executeAction` remains available.

Mounted `executeAction` inputs use the canonical strict-JSON reader and the
invoked Action's schema. The containing Action transport owns its byte budget;
the surface-navigation launch-input budget does not limit Action data. This
0.3 development correction also applies to external plugins and retains closed
Action references, Session addresses and request envelopes.

Embedded targeted surfaces likewise carry strict JSON validated by the admitted
role's normalizer and input schema. Their presentation data is not an
`openSurface(view, input)` navigation operand, so the navigation launch-input
byte limit does not apply. The containing transport retains its own bounds;
full typed detail data need not be fetched again merely to fit a navigation input.

Preparation must establish read admission, not merely prepare remote delivery.
The current API-token preparation path defers server grant checks until
execution, so mounted host Resources refuse that path rather than borrow
already-open Account bytes or execute a read solely to discard its result.
One-shot Action execution keeps its existing server admission path.

The unreleased native Machine host integration also has a closed
`machines.services.logs` Resource reference. Its `input` is the strict input of
`machines.services.logs.read`; `expectedGeneration` selects the observed service
owner and `sourceRevision` selects the existing native log source. The canonical
Resource identity includes both fields, so a replacement never borrows an
earlier owner's bytes. It uses the
incumbent Resource read/open/next/close RPCs, log cursor and invalidation lifecycle,
not a plugin contribution or another log transport. The receiving daemon invokes
that same logs Action before reading or installing the native watcher; reopening
repeats admission. Native owner retirement terminates the subscription and releases
its watcher before the retirement response settles. This reference does not add a
plugin caller policy: arbitrary mounted plugins remain refused. In 0.3 development
source, the original-Account UI transport carries these protected operands through
the existing Home-admitted logs Action. READ and OPEN retain normal approval;
the preceding finite page is a separate admission, and subscribe/resume revalidates
the current Account and service owner. Blocking approval retains the same private
requester and executor for the Resource lifetime, without persisting those private
ports in the approval Artifact. NEXT and CLOSE bind the captured Account and complete
reference, including generation, source and cursor. Cancellation or native-owner
retirement releases that exact watcher. Plain and E2EE composed checks exercise this
path through Home and an installed test adapter; they do not establish bundled native
activation or a loaded development-daemon logs journey.
Generic Machine Resource RPC does not supply the original Action provenance
and fails closed. The finite reference selects a page after its existing cursor;
the native data hook does not itself append pages or advance a viewer's cursor.

The unreleased Machine Services list uses the same host Resource transport with
`{ hostRead: 'machines.services.list', input: { serverId, machineId } }`.
The input may narrow demand with `environmentId`, or with `environmentId` and
`composeService` for one Compose service. The daemon filters admitted handles
before projecting rows, and the same selector scopes invalidations. The full
Machine Services view omits both selectors.
The original list Action—not the logs Action—admits READ and OPEN and applies
the existing requester/Environment disclosure rules. Native observation publishes
only semantic changes to exact Machine rows; unchanged observations do not reread
the list. Watch-intent changes use the Machine metadata reconciliation wake.
Hidden demand releases the same watcher. The list reference grants no mounted
plugin authority and introduces no SDK callback, polling loop or native query.
The invalidation-only transport forwards a digest of the changed producer fact;
the client then performs one admitted list read for the current bytes. Resource
reads project retained accounting, while an explicit list Action samples the
visible services through their native accounting readers. Equal observations
publish no change; hidden demand reads nothing. An unscoped Machine-wide invalidation can
wake a reader whose current Environment access hides the changed row; the
admitted list read still applies that reader's disclosure rules.
A failed Environment-access read remains a failure, not a successful empty
list. Ordinary transport/runtime failure ends with `unavailable` diagnostics
and preserves admitted last-good rows as stale; actual read-authority retirement
uses the existing withdrawal channel. A successful empty access set or an
explicit Environment read denial removes those unreadable Environment rows.
These are development-source contracts; source tests do not prove a loaded journey.

Native Resource hooks and hosted bridge subscriptions retain the same read,
invalidation, last-authorized-value and retirement semantics.
Static retention lets an already admitted finite read finish after live demand
withdraws. A watch-only replacement queued behind that read withdraws with its
last live subscriber; a queued explicit Refresh Action keeps its own waiter.
Host identity
includes the Action and its canonical resolved input under the captured
Account; it never fabricates a plugin id. An invalidation carries no snapshot
bytes: rereading remains the single snapshot authority. Unsupported older
bridge ceilings refuse the new reference without changing incumbent plugin
references. Source contract tests do not certify a loaded native/hosted journey.

The development Discussion host read projects only `{discussionId, revision}`.
Its revision is the observed AccountChange cursor, initially zero before an
observation, and is not a Discussion content version or replay frontier. The
Account/Home-qualified Discussion repository owns the shared exact summary read
and rechecks resource access through the Discussion Action on refresh. Each plugin
mount retains its own Action preparation admission, then borrows that repository's
content-free observation. Core readers and several plugin mounts share one summary
read per changed Discussion; content remains behind the ordinary Discussion Actions.
The repository's mounted AccountChange observer supplies exact IDs and revisions
to the incumbent Resource subscription owner, so unrelated Discussions and Accounts
produce no read or publication. Closing a consumer releases its demand; the shared
observer closes after the last consumer. No polling or content cache is added.
Native and hostedWeb carry the same digest-only invalidation.

Daemon plugins observe the same Account feed through the existing Host Event
broker as `@happier/session/discussion-invalidated`, scoped to the invoking
Account. The closed payload permits only `discussionId` and an optional
`revision`. It is a refresh hint, including access changes, not a message,
authored content channel or exactly-once occurrence stream. Plugins cannot emit
it through the reserved host namespace. These are unreleased 0.3 source contracts.

In unreleased 0.3 source, an existing `ui.views` right-sidebar tab may declare
`defaultPlacement: 'pinned' | 'overflow' | 'auto'` and `countResourceId` naming
its own declared dynamic `application/json` Resource. Omission keeps overflow.
The public SDK's `PluginRightSidebarCountV1Schema` validates exactly
`{ count: number | null }`: a number is a nonnegative safe integer, zero is
empty, and null is unknown. A positive count supplies the numeric badge and
pins an automatic tab; zero, unknown, denied or invalid data leaves automatic
placement in overflow. Static badge text is the fallback and never proves
content. The person's saved placement still wins. Counts use the existing
Resource read/watch owner while an admitted enabled tab is in a presented
rail or its overflow, with no pane renderer or polling. Hidden or unavailable
tabs and static previews add no demand; retirement releases the last read/watch
lease. Global Resources stay global, Session Resources require a Session tab,
and surface Resources use the pane's same host-derived singleton context and
launch input, including for App tabs appended to a Session or Project rail.
Authors register their Resource leaf through the existing `activate(api)` ABI;
this adds no contribution family, Resource scope, or Host API method.

The existing Resource entry admits independent Usage source revisions while
its read remains pending: current accounting does not wait for comparison or
another query, and refreshes do not wait for private Work/activity or a later
quota-history page. Qualified profile sources initiate the canonical quota
Action even without an opened cache row; that Action reads admitted Home
records, not a provider refresh. Each accepted history prefix keeps its cursor
and explicit incompleteness. Accounting observation times come from the
response's witnessed coverage sources, never the client read clock. The
advanced Plugin UI Resource client's optional `onProgress` callback is a
package construction seam; the public Host API and bridge wire stay unchanged.

In 0.3 development source, public Resource hooks and contextual controls expose
`refresh({ supersede? })`. Their explicit `refresh()` recovery cancels an
unresolved read and starts a replacement through the existing Resource entry;
`supersede: false` retains queued refresh behavior. Typed projections and the
permission facade preserve this option. Automatic watch invalidations continue
to coalesce behind the current read; no transport or Host API method changes.

### Mounted host Action controls (0.3 development)

An installed plugin can bind `hostApi.actionControl({ action, presentation }, controller)`
or mount the public Plugin UI `Action.Control`. The mounted surface host renders its
existing accessible button in the surface's host action slot, outside the author tree
and outside hosted-web's iframe. Native and hosted surfaces, including Session and
Project `detailsPane` destinations, use the same mounted presentation owner.

On a physical host press, the host requests one fresh `controller.prepare({signal})`.
The controller returns `{input}` or `null` to cancel; it receives no executor or token
with person authority. Only the host's pending gesture can consume the correlated
preparation, and the host checks the original Account, mount and execution binding
before invoking the canonical Action executor as `ui` / `present_user` / `host`.
Contributed references enter the same canonical `action.invoke` owner. The original
Action execution envelope, including pending approval, operation custody and failure
details, returns to that invocation's controller through `onSettled`.

Raw `executeAction`, `useExecutePluginAction` and `Action.Execute` retain
`plugin` / `account_automation` authority. This capability adds no approval waiver:
explicit Settings → Actions Ask and setup consent still apply. An Allow preference
control and a Run control remain separate gestures; registering, updating or allowing
does not launch a command. Disposal and mount retirement cancel preparation, and an
unknown execution outcome never causes an automatic replay. The UI host's shared
Action failure owner uses the declared input-sensitive `readOnly` effect to make
unknown or timed-out reads manually retryable. Unknown mutations remain
non-retryable because their effect may already have happened. Plugin surfaces
consume this retryability without classifying the Action again.
Unsupported hosts omit the negotiated
`actionControl` method; authors retain an unavailable explanation rather than falling
back to a person-stamped raw call. This is an unreleased source contract.

### File viewers and media (0.3 development)

Plugins open workspace files through `workspace.tabs.open` with its `file` arm,
using the same host navigation owner as transcript links, the tree and Search.
`file.target` addresses either `{ kind: 'session', sessionId, serverId? }` or
`{ kind: 'project', workspaceRefId, serverId, machineId?, rootPath? }`.
`file.path` is workspace-relative; `anchor` uses `WorkspaceAnchorV1` and
`anchorSource` selects file or diff coordinates. Optional `view` selects
`view`, `changes` or `edit`, and `blame` requests the blame view. The outer
Action `mode` still controls preview, kept-tab or split placement.
`changesScope` consumes the shared `FileChangesScope` selector, preserving the
selected review turn rather than deriving another scope vocabulary. Plugins must
declare the Action in their manifest capabilities; this does not grant file
access or make paths outside the workspace openable. `workspace.files.link.get`
returns the same canonical link without opening a tab. The `href` arm remains
available for other destinations; no plugin-specific file opener is added.

File viewers use the existing `contributes.openableContentViewers` family. The
host's `resolveFileViewerKind` supplies both built-in body selection and plugin
openable-content metadata: SVG is `image/svg+xml` with image content class; PDF,
audio and video keep their specific MIME with binary content class. Markdown is
`text/markdown`; HTML is `text/html` with text content class; code remains `text/plain`. A Markdown viewer that previously
matched `text/plain` should match `text/markdown` or a Markdown extension instead.
The existing plugin read budgets are unchanged, and the built-in viewer remains
available in the chooser. Every matching, currently available installed viewer
is offered in the existing horizontally scrollable chooser; viewer count does
not truncate the choices. Matching and runtime admission still apply to each
viewer, including externally installed plugins.

The File page hosts those viewers on phones as well as desktop/tablet. Runtime
admission uses the same destination Registry predicate: the chooser identifies
the existing viewer family, and the mounted singleton `detailsTab` receives its
File-host purpose only from an exact current private `openableContent` handoff.
Persisted destination/input and a viewer declaration do not supply that custody.
Session and Project `detailsTab` destinations also use the existing pushed phone
detail host. Other pane destinations retain their desktop/tablet admission policy;
no author phone opt-in, new manifest field or transport shape is introduced.

Public `StoredImage` supports the host's shared Media stage through an optional
private presentation-host `mediaStage` port. When supplied, pressing a loaded
image forwards its URI to that port. `expandable={false}` keeps the
author-supplied `onPress` behavior; hosts without the port retain that behavior
as well. Image admission and reads still belong to the existing Session-image
owner. The plugin API's loaded data URI is forwarded directly, without another
transfer or a new URI custodian. Hosted-web realms receive no stage port. The
viewport, gesture runtime and PDF implementation are host-owned and are not
exported to plugin bundles. The canonical stage surface and its physical mount
binding are still under integration; the optional port alone does not establish
mounted availability.

Markdown's optional `images` resolver follows the same presentation binding.
Absent a resolver, images retain the existing alt-text-only policy. Workspace
image paths resolve through the host's workspace-reference owner, while remote
image loading requires the person's explicit document-level consent; plugin
Actions cannot grant that privacy choice.

These are unreleased development-source contracts. Generated declarations and
API reports must be refreshed by their owning integration lane before package
publication; source availability does not attest a loaded-platform pass.

For collection-based plugin pages, the public Plugin UI `Collection` composes one headless model, item anatomy and detail renderer across presentations and containers. `Step`, controlled `Tabs` (including host-rendered strips) and `HappierDisclosure` belong to that public UI/presentation boundary, rather than feature-local replacements. See [Collection presentation](collection-presentation.md) and the [public author composition](../apps/docs/content/docs/plugins/ui/react-native.mdx).

In 0.3 development source, `CollectionToolbar.refine` supplies a wide `render()`
and a folded `sheet.render` that draw the same narrowing form (Triage: the shared
`CollectionConditionEditor`), so a page has one filter UI at every width; the
folded form applies its edits and closes the sheet itself. Pickers beside Filters
(Order) fold into ⋯ through `foldedChoices`. Public `SheetMenu` shares the menu
owner and adds a sheet title/footer (`header: 'none'` for self-titled content),
an optional trigger count, and a `content` slot in place of menu rows. `Item.titleEllipsizeMode="middle"` preserves a long title's suffix
and full accessible name. See the [author example](../packages/plugin-ui/README.md#collection-filters-and-long-titles-03-development-source)
and generated [public declarations](../packages/plugin-ui/api-declarations.md).

A public `Popover` takes `floatingRole` (`'menu'`, the default, or `'panel'`). The role rides the
public material request (`HappierMaterialSurfaceRender` input, `HappierSurface.floatingRole`) to the
host's `GlassSurface`, which owns the coat: a large anchored panel takes the dialog coat, while menus,
tooltips and small popovers keep the hair coat. `Menu` and its variants stay menus; there is no opacity
or paint prop.

In 0.3 development source, the public themed `ApprovalPrompt` and core approval
adapter share the neutral interaction presentation's title, subtitle, icon, body
and footer anatomy. Callers supply reviewed facts and decisions; admission,
approval state, focus and request lifetime remain with their existing owners.
Changing between card and inline presentation retains the mounted facts. This
is development-only composition, not a new approval authority or released API
availability claim.

The arguments inside an approval card have one owner too: `HappierApprovalFields`
(`presentation/interaction/ApprovalFields.tsx`) draws the inset label-beside-value
table, the stacked form behind a "Details" line and a structured value's entries
(`HappierApprovalFieldEntries`). Public `ApprovalFields` binds it for plugin
authors; core's `ActionApprovalFieldsCard` binds it with the app's `Text`, theme
steps and a `Resolve` slot that names Session, Home and other references. Core
keeps the protocol-row projection (localized options, timestamps, readable entries,
Technical details) and the approval page's own row anatomy.

In 0.3 development source, the mounted host projects that same pending approval
as `SurfaceContext.pendingApproval` (`artifactId`, `href`) through its existing
context publisher on native and hosted-web surfaces. The public
`useExecutePluginAction` controller exposes `pendingApproval` while its execution
is pending and otherwise returns `null`. This is the mount's current presentation
fact, so concurrent controls can observe the same review; it grants no approval
or replay authority and adds no Artifact observer. The host's mount notice is the
one approval notice and link for every plugin Action; while `pendingApproval` is
set, `Action.Execute` only disables its button as "Waiting for approval" and draws
no notice or link of its own. Authors can still compose the public
`ApprovalPendingNotice` with the hook field in their own layouts.

In 0.3 development source, `SurfaceContext.machineConnectionPending` reports
the mounted host's positive observation that Machine-backed execution is still
establishing or its mounted target is loading. Account/local operations and public surface activity
keep their own availability. A Machine-owned refusal during that phase retains
its original diagnostic and adds `plugin_surface_connection_pending` through the
existing Host API error carrier. Once loading settles, the same refusal is an
outage; missing targets and failed reads do not imply pending. A retained selected
source also stays pending while its Home's live Machine census is loading; a
failed or signed-out census is settled. Selection does not prove execution readiness.

The host-private UI union also carries each known, enabled and trusted Account
installation's establishing Machine target before its first runtime description
or contribution supply arrives. Administration consumes that fact for the exact
selected, remembered or contextual Machine, or the current Home's unavailable
unpinned selection. An unrelated Home/Machine and an explicitly targetless
context cannot keep it pending; a terminal description failure ends the fact.
This remains presentation readiness, not source custody or execution admission.

`SurfaceContext.machineExecutionReady` separately reports whether the exact
mounted target has fresh execution admission, reachable daemon interaction and
its required target snapshot. Loading can settle before this fact becomes true.
The UI's app-bundled and installed declaration projections retain their declared
daemon-Action and contribution-point requirements before any runtime supplier
arrives. These presentation facts keep cold Machine reads on the same loading
path; they supply no occurrence, source selection or execution authority.
Plugin UI owns the shared projection in `usePluginHostReadiness`: `pending`
defers a Machine read while loading, and `ready === false` prevents acquisition
even when loading has settled. Omitted `ready` retains the older host's loading-only
observation. Its `revision` changes when prerequisites settle or
execution is re-admitted. Resource hooks consume it automatically; custom mounted
read lifecycles, including Triage's aggregate, detail and fix-PR links, use that
same projection. The existing pane bridge carries it to host-rendered details.
The same context owner projects `requesterExecutionReady`: an app-union requester
waits for scoped Availability and, when its destination has Account custody, for
that exact admitted origin. Loaded absence of an Account destination leaves a
legitimate Machine requester available; a withdrawn Account origin is not ready.
Development renderer bytes are selected separately from physical declarations.
An existing real Account destination retains its Account custody when explicit
development bytes are selected. A retained Machine descriptor waits until that
exact Account destination reaches its mount; selecting bytes cannot admit the
interim requester. Genuine Machine-owned or new development destinations without
an Account declaration retain Machine custody.
An optional cached Machine binding does not establish physical execution
authority until the controller's same can-interact fact admits it. Pending
binding churn keeps an admitted Account controller; real replacement or
withdrawal after Machine admission retains the existing fencing.
Account-local reads use `usePluginHostReadiness(false)` to ignore unrelated
Machine admission, not requester admission. Their readiness and revision remain
independent of Machine-only changes. Account reads on Settings and other surfaces
defer while `ready === false` and acquire after requester admission. Readers retain their own data,
cancellation and single-flight/pacing owners; Triage no longer classifies host
refusal diagnostics or maintains a separate readiness state in its aggregate.
An undemanded reader stays cold, and a settled source outage remains terminal
without another host transition or explicit Retry. This
optional, read-only development fact grants no execution authority; every
invocation still passes the host's fresh guards. Omission supplies no readiness
edge. Both native and hosted transports use the same context producer.

In unreleased 0.3 source, ordinary workspace title, focus and history publications
retain the navigation adapter and mounted plugin controller when their owners are
unchanged, so pending Resource reads can finish. Navigation commands read current
focus and history when invoked. Account, Machine and occurrence replacement keep
their existing controller retirement rules.

In 0.3 development source, public `WidgetFrame` and the core widget adapter share the same frame and controlled `disclosure` contract. The frame's `source` slot takes a name, or a bound-source descriptor (`binding: 'pin' | 'follow'`, `text`, optional `compactText` and `accessibilityLabel`): the frame draws the pin or follow glyph, keeps the short form when it narrows, and names the line for assistive tech, so a group's pinned value and a follower's "Following group · value" are one recipe for core and plugin frames. `HappierSegmentedChoiceRow` and its model `resolveHappierSegmentedChoiceRow` (public `/components`) own the "label + inline segmented choice" row, where an unavailable option stays visible and says why; core's configuration and menu rows resolve their segments through the same model. Collapse belongs to the current viewer; it keeps the body mounted and hidden without changing widget layout, input or Resource identity. Public `/components` also owns tree keyboard/focus semantics (`HappierTreeNode` and `useHappierTreeInteraction`), using explicit parent keys rather than filesystem path spelling. Filesystem trees translate their domain rows into that owner.

The rows inside a widget body and the lines-added/removed readout have one neutral owner each in public `/components`: `HappierWidgetGlanceRow` (mark, name, tag, quiet or attention fact, one trailing element; one pressable when it leads somewhere) and `HappierDiffStat` with its formatter `formatHappierDiffStat`. The root adapters `WidgetGlanceRow` and `DiffStat` supply the plugin theme and faces; core's `components/widgets/glance/WidgetGlanceRow.tsx` and `components/workspaces/scm/DiffStat.tsx` supply core's text owner (font scale), glyphs, density-aware spacing and inks. The version-control inks travel as the optional same-realm palette facts `versionControlAdded` / `versionControlRemoved`; a hosted frame without them draws the snapshot's success and danger inks. A plugin's glance row lays out on the regular spacing steps, because the public snapshot carries no density fact for them.

The inline command/flag/identifier chip has one neutral owner in public `/components`, `HappierInlineCode` (mono face, the elevated-surface fill, one unbroken unit on the web). The root adapter `InlineCode` supplies the plugin theme's code face, inks and `xsmall` inset; core's `components/ui/text/InlineCode.tsx` supplies core's text owner (font scale), mono face, inks and density-aware `s4`. Public `ItemGroup.description` admits rich content (a localized sentence around `InlineCode`) set in the shared `HappierPageSectionText` description step; a string or `descriptionKey` keeps `resolveAuthorText` localization.

In 0.3 development source, four more presentation concepts have one neutral owner in public `/components`, a themed author adapter at the package root, and a core adapter that binds only typography, buttons and glyphs: the full state composition `HappierSurfaceState` (root `SurfaceState`, `LoadingState`, `ErrorState onRetry`; core `SurfaceStateCard`), the section action cluster `HappierFormActions` with its far-edge `trailing` slot and consequence/refusal `footnote` (root `Form.Actions`; core `SectionButtonRow`), the link handover `HappierLinkDelivery` (root `LinkDelivery` over the host clipboard, external-link and QR owners; core `TeamLinkDelivery`), and the settings-row value slot and status line `HappierSettingValueSlot` / `HappierSettingStatusLine` (root `SettingRow`, `SettingValueSlot`, `SettingStatusLine`; core `SchemaFieldRow`). Lifetimes, translations, announcers, schema drafts and writes stay with the core adapters and their domain owners. The Team adapter keeps a one-time invitation bearer in its own props: the neutral renderer never fetches, stores or reports a link, and plugin surfaces get no path to invitation secrets. `WorkosMark` and the Inbox approval card stay host-only.

Composer-rail buttons use the public `/components` `HappierComposerChip` shell in both core and plugin adapters. The host continues to supply rail theme chrome and responsive placement; the shared shell owns button/toggle semantics, disabled and selected state, and native touch-target geometry, so plugin controls do not maintain a similar-but-different chip implementation. The chip also forwards the intent signals `onPressIn`, `onFocus` and `onHoverIn` (a host may warm a popover's content when the chip is about to be used) and the web-only `webAttributes` (`title` and `data-*` hooks); the rail declares its real gaps through `hitReach`.

Measured `FrameRect` placement and `resolveFloatingFrameRect` share companion geometry with core. The geometry helper retains optional measured `avoidRects` so Voice presence can stay clear of the pet and Session action rail, and reports whether a non-overlapping placement fits. Floating viewers do not supply obstacles: their only bounds are the live viewport and safe areas, and a smaller viewport shrinks the frame to fit. Docking is an explicit host control. Pointer listeners, native gestures and measurements remain host adapters. These foundations do not create a viewer registry or assert that every capture/viewer shell is integrated.

Public `/components` exports `HappierFloatingFrame` / `HappierFloatingFrameProps`: one controlled neutral frame (`floating`, `expanded`, `docked`, `closed`) with a controls band and one body. It owns only geometry and shell mode: drag, velocity and release use the shared companion interaction owner, settling uses `resolveFloatingFrameRect` to stay within `availableRect`, arrow keys snap corners and the grip resizes with the body's aspect. Docking stays an explicit host control; the frame never requests it automatically. `moveInput` decides whether the body or only the controls band and grip move it; the host decides that from its own control facts. While the body moves the frame, a double-click on it expands (and restores) the frame, and Escape restores an expanded frame. An optional `footer` stands one presence capsule below the body (`HAPPIER_FLOATING_FRAME_METRICS.footerHeight` is that capsule's height); `aspectRatio` is the body's own shape, so placement (`resolveFloatingFrameRect` with `chromeHeight`) shrinks both axes together, and `minWidth` is the host's measured usable minimum below which manual resizing stops. A smaller viewport still shrinks the frame to fit. A frame's chrome is public beside it, so an author's frame matches the viewer's without copying it: `FloatingFramePicture` is the body's material (the picture rounded to the frame's body radius and lifted on the host's `elevationStyle`, never a card; `drivenRingColor` draws the thin ring that says the person drives it; `framed={false}` draws the same element tree flush in a pane so a body is not remounted when it moves), `HappierControlCapsule` holds a group of controls on the floating material for the `controls` slot (`HAPPIER_CONTROL_CAPSULE_METRICS`, `HAPPIER_CONTROL_CAPSULE_BUTTON_SIZE`; the material is a backing, not a clip, so a control's touch target may overhang the band without the capsule growing), and `HappierIdentityCapsule` names what the frame shows (a Machine, with a `leading` status dot) as plain text, never a live region. `HappierStatusCapsule` remains the announcing capsule for a state that is not normal. `resolveFloatingFrameSettleTransition` returns the duration, critically damped `linear()` curve and transitioned properties a released frame travels on, and `resolveFloatingFramePlacementStyle` places a rectangle the way the frame does (on the web a compositor `transform` for its position, so only a size change lays out), for a host that draws the body in another layer and must move it in step; `HAPPIER_FLOATING_FRAME_METRICS.resizeStep` is the one resize step for the grip's keys and a host's Larger/Smaller. On the web the controls reveal on hover and focus for a pointer that hovers and stay shown for one that cannot (`(hover: none)`, or once a touch reaches the frame). The platform pointer boundary comes from the `pointer` prop or the presentation host's `companionPointer`; without one the frame moves by keyboard and menu only. It has no target, Session, network or trust props. In 0.3 development source the Session viewer is its first consumer: it frames the retained Computer or Browser body above page content, including the composer, Voice presence and pet, without moving or resizing them or publishing viewer geometry into their placement. The person chooses where it sits. Phone viewers retain their sticky reading-flow composition. Development-only until 0.3 ships.

The public root and `/components` export the themed `FloatingFrame` adapter and
its props over that same neutral owner. It supplies host theme and accessibility
defaults, including reduced motion, without another geometry or interaction
engine; `/presentation` retains the neutral primitive for host composition.

Native finger movement in 0.3 development source uses the optional same-realm
`nativeBinding` component (`HappierFloatingFrameNativeBindingProps`), otherwise
the presentation host's `companionNativeFrame`. Happier supplies the app-owned
`NativeFloatingFrame` adapter over `useCompanionNativePanGesture`; Plugin UI
does not import Gesture Handler, Reanimated or host internals. Floating frames move
from chrome backgrounds in either input mode; body drag is admitted only while
watching (`moveInput="surface"`). Registered no-drag controls keep their presses,
and control-mode content keeps its own touches. The binding receives the frame's
existing `grip` element and uses the same companion pan owner for its aspect-locked
resize. Web and native grip geometry comes from `resolveFloatingFrameResizeRect`.
The frame and its route-stable retained body share native position and size values;
the grip is carried above an interactive retained body in that same portal. No
per-frame React or settled-geometry publication occurs. Release or interruption settles through
`resolveFloatingFrameRect` (including projection, aspect/chrome and minimum
width), then publishes the rectangle clamped to the live viewport and safe areas.
Native frames follow the same free-float rule, with no obstacle avoidance or
automatic docking.
Keyboard/menu placement remains available, and phone viewers retain their sticky
slot. Without either native binding, frames retain keyboard/menu placement only.
This is a React presentation seam, not a serialized Host API or wire-epoch change;
real-device feel remains a separate QA check.

The app shell supplies plugin-column physical focus eligibility through the existing presentation provider, using its dock visibility and peek focus facts. Hover previews may remain presented without receiving programmatic focus; deferred or exiting peek content cannot receive it. Columns explicitly do not publish semantic current UI context: that authority remains with the active page's existing owner.

### Composer control placement (0.3 development)

Composer-opened plugin surfaces bind the existing mounted Composer reference
at the host handler owner. Their `activeComposer` lookup, reads and edits remain
bound to that opener even when focus moves into the plugin or another Composer.
The captured Account/Home scope and surface currentness still govern admission;
retiring the opener cannot fall back to a different focused document. Non-Composer
mounts retain the global focused-Composer lookup, including `null` for absence.
The physical renderer waits until that exact scoped mounted document is ready,
so an author's first `activeComposer` lookup cannot consume transient Account
hydration as permanent absence. The stable document adapter publishes scope
arrival and withdrawal through the existing per-Composer registry push; no
author retry, polling, or unscoped fallback participates in admission.
Scope readiness is separate from visual presentation: a hidden retained view
keeps its controller, while presented-only document operations keep their own
checks. Physical admission subscribes only to mounted registry changes, not
the persisted Session fallback or broad storage updates.
This is host-side binding through the existing API, not a new wire field.

`composer.regions` also admits `placement: 'statusStrip'` in development source.
The shared Composer presentation owner filters scopes and orders the same region
catalog, then mounts its occurrence-bound surfaces in `SessionInstrumentStrip`
after host badges. Items use public `ComposerStatusBadge`; the existing strip
owns compact/collapsed layout. A status region declares `emphasis: 'quiet' | 'prominent'`
to match its badge (default `prominent`); admission carries that fact so quiet
plugin items yield width before prominent items, just like host badges.
Before/after slots continue to select only their
own placements. Mounted surfaces retain the qualified Session/Home and borrow
the existing contextual Resource store, with demand governed by presentation.

Composer membership is device-local presentation, stored in the `composer`
slice of `navigationSurfacePlacementsV1`. The existing navigation-placement
resolver applies saved order and placement to one lightweight descriptor
inventory; the row, overflow menu and field accessories consume that result.
Protected placement and already-held pending facts affect the effective result
without rewriting saved preferences. Physical wrap/scroll remains separate.

`composer.controls` declarations accept optional `defaultPlacement: 'pinned' |
'overflow'` from the shared Protocol UI placement schema. Omission means
overflow; saved user placement wins. Actions retain their existing
`composer.primary` / `composer.more` bindings, deduplicated by qualified Action
id with primary taking precedence. Host preference ids distinguish
`plugin:control:<qualified-id>` from `plugin:action:<qualified-id>`, including
when the local ids match. Catalog projection reads descriptors, not control
Resources; existing contextual Resource demand still owns mounted details.
This is an undeployed 0.3 declaration extension, not an older-host compatibility
promise. See the [public composer guide](../apps/docs/content/docs/plugins/guides/composer.mdx).

### Session send attachment identity (0.3 development)

Plugin `SessionHandle.send` attachments use the local-only author shape
`{ attachmentLocalId, value }`. The host qualifies each local id to the sending
plugin when that plugin declares it. Otherwise, it uses the immediate
host-stamped initiating plugin caller only when that plugin declares the id.
When both declare it, the sender wins. An unrelated intermediate caller ends
that delegation: grandparent callers, attachment content and authored identity
claims cannot select a declaring plugin. Missing declarations refuse before
persistence through the existing typed input refusal.

The same declaration-only draft owner serves fresh admission, persisted-input
retry correspondence and pending-first-input handoff. Preparation, value
validation, dispatch resolution and accepted-message callbacks remain with the
declared attachment's existing lifecycle. Triage can therefore delegate its
final send to Channels while retaining `happier.triage/entry`; Channels remains
the sender and delivery-custody owner. This is an unreleased host implementation
rule, with no new SDK option, protocol field or grant.

### Composer inline references and decorations (0.3 development)

The host's composer document is the one owner of text, selection, typed
reference ranges, attachment identity and revision. References selected from
the picker or inserted through a drop or **Mention in composer** become atomic
inline chips. The shared
[`composerReferenceInsertion.ts`](../apps/ui/sources/components/sessions/composer/composerReferenceInsertion.ts)
plans insertion at the active word, caret or release-point offset; all JS-facing
offsets refer to token-bearing composer text. Chips require typed bindings;
plain pasted text never creates one. Discussions use those same ranges rather
than a second mention-span model. The [Session input owner](runtime-core.md#session-input-and-inline-references)
defines token grammar, readable markers and the single Agent reference block.

In 0.3 development source, the Discussion binding also consumes declared
`composerReferences` through the existing execution-origin selection and
reference search/resolve owners. Reference-only plugins acquire their producer
when a query demands it, not on composer mount. The captured Account/Home and
installed occurrence must still be current when results arrive. Public composer
transactions retain those typed references in the existing document; core Send
serializes them as `t: 'reference'` through the Discussion content owner, and
message readers retain their identity. This is not executable addressing:
only the committed Account/Session participant projection of `t: 'mention'`
parts can address a receiver. Pasted markers or contributed reference labels
cannot create that projection. Follow input carries selected reference identity
through the existing structured-input metadata and contributed context resolver,
not another reference parser. Loaded-runtime validation is distinct from this
unreleased source contract.

`composer.transaction.apply` retains expected-revision admission. Its
`attachment.add` operation accepts optional `mentionAt: { start, end }` in the
captured snapshot's text. The host first mints or reuses the attachment instance
through the existing attachment-add owner, then inserts its bound token in the
same transaction. Omitting the range attaches without mentioning. Authors do
not supply an instance identity or reconstruct one from text. Removing a chip
keeps its attachment; removing the attachment removes its chips. Submission
drops orphan attachment tokens. Image ordinals are derived from tray/message
image order, keyed by id, rather than persisted in tokens or attachment records.

Mounted `setDecorations(key, decorations)` ranges are revision-bound presentation over the same
text: highlight, muted, warning, success, code or link treatment, with optional
accessible labels. Web draws them through editor decorations; native draws
them through text spans. The input-lock notice remains a separate state.
A decoration supplies neither
reference identity nor submission authority. See the [public composer guide](../apps/docs/content/docs/plugins/guides/composer.mdx)
for the mounted API and attachment insertion example.

### Entity drag sources and drop targets (0.3 development)

`definePlugin` declares `dragSources` and `dropTargets` through the existing contribution catalog. Each source has a declared JSON reference schema and a client execution reference; each target declares accepted built-in or qualified `plugin:<pluginId>/<localId>` kinds and an explicit host/contributed Action allowlist. `activate(api)` registers only admitted local ids through `api.dragSources.register` and `api.dropTargets.register`. These families have client occurrence rights, not daemon or Session runtime rights.

A source may select its own declared `composerAttachment` local id and register `toComposerAttachment(reference)`, returning the incumbent `ComposerAttachmentAuthorValueV1` or `null`. Composer admission validates the reference and current source registration, then matches the attachment declaration in the same occurrence of the mounted composer's composition. `composer.transaction.apply` accepts an optional exact `attachmentContributor` selection; the mounted owner derives authority and mints attachment identity through the existing revision-bound transaction core. The selection carries no generation, provenance or staged-media custody. Triage maps its actual entry/source-instance reference through its existing attachment builder; its resolver still reads the current entry at dispatch.

The development `reviewComment.add` composer operation adds host-owned anchored
review context using the canonical review-comment draft schema. It applies only
to a Session composer with a known current Account and workspace, derived by the
host rather than selected by the plugin. It shares the editor/diff Ask workspace
draft writer and submitted `review_comments.v1` shape. This operation grants no
plugin attachment identity: `attachment.add`, update and removal retain their
existing contributor admission and custody checks.

Protocol owns the [portable entity contracts](../packages/protocol/src/plugins/ui/entityDragDrop.ts) and [declaration admission](../packages/protocol/src/plugins/contributions/entityDragDrop.ts). The mounted UI's [treeDragDrop runtime](../apps/ui/sources/components/ui/treeDragDrop/entityDragDropRuntime.ts) owns carry, current geometry, target selection, release revalidation and cancellation. The plugin binding validates custom references and Action allowlists against the current occurrence; it supplies host-built identity for built-in references. A reference selects an item and grants neither access nor execution authority.

Public Plugin UI `DragSource` and `DropTarget`, declarative `dragSource`/`dropTarget` nodes, and SDK hosted DOM bindings join that same runtime. Authors supply declared local ids, JSON references and target-local input. The host supplies scope, measurements, currentness and caller provenance. Hosted methods `readEntityDragItem`, `updateEntityDragDrop` and `watchEntityDragDrop` are negotiated through the existing Host API; frame coordinates are converted at the host boundary. Retired or hidden mounts cannot begin an effect.

Real mounted targets, including plugin targets, retain an exact Home/Account scope. A host-owned collection catchall may explicitly use the admitted source's scope when its geometry spans several Homes, as the Session list does. Its domain resolver still refuses foreign-Home destinations, and dispatch uses that source's captured credential lifetime through the ordinary mounted Action owner. This host-private geometry mode is not an SDK authoring option and grants no cross-Home mutation authority.

`DragSource` may observe its settled `onDropOutcome` to refresh a read-only
projection, as Tasks does for its existing Account index. This notification is
not an effect retry or an additional writer; the Action owns the result.

The portable item union is closed, including the development `work-board-widget` and `widget-area-instance` arms. Native WorkBoard sources build their qualified Board/instance reference from current membership; Project/plugin areas carry an exact `WidgetInstanceRefV1` whose surface matches the captured Home/Account. Widget-shaped JSON supplied as a plugin reference stays within the contributed `plugin` arm; it cannot manufacture a built-in reference or select its authority.

A target's synchronous `resolve` returns an allowed Action request with release preview, or a typed refusal with a reason. The preview declares `verb`, `target`, optional `consequence` and optional `glyph` from the closed `EntityDropPreviewV1` vocabulary. Core and plugin targets declare their marks through that same field; the shared outcome presenter never derives a mark from Action ids or inputs. An omitted mark retains the generic `add` presentation. Pending and settled feedback retain the released effect's declared mark; refusal chrome uses the refusal mark. A mark grants no effect authority. Hover performs no mutation. Completed release resolves again before the ordinary Action front door applies current admission and approval policy; a dispatched unknown result stays with that effect owner. Core and plugin sources use the same release preview, Organize grip, staged keyboard and chooser primitives. OS Files retain boundary-local acquisition handles and never enter serialized plugin references. See [Actions](actions.md#entity-drop-effects-development) and the [authoring guide](../apps/docs/content/docs/plugins/ui/react-native.mdx#entity-drag-and-drop-development).

When an Action's successful transport can carry a domain refusal or uncertain write,
its target registers the pure `PluginDropTargetRuntime.settle(result)` projection.
The domain parses its own declared result schema and returns `EntityDropOutcomeV1`;
the mounted executor preserves host transport, approval and reorder failures first.
This projection never writes, retries or confirms. Without it, successful execution
means Applied and the result remains opaque plugin data. Triage uses this seam for
task transitions and Session links, so a refused or uncertain domain result cannot
be presented as an applied drop.

The shared outcome presenter uses localized refusal vocabulary for action previews: a refused "Move to Project" becomes "Can’t move to Project", while allowed previews keep their action phrase. A domain-authored denial declares the existing `glyph: 'refused'` and retains its complete translated title, including group, Session relation and pane refusals. Hosts without a specific refusal formatter use their localized generic denial. Silent and unchanged outcomes retain their existing treatment. These are presentation decisions; admission, reasons and effects remain domain-owned.

The shared `HappierDragGrip` presentation accepts optional `revealed` pointer chrome. Omission retains visible chrome; `false` quiets only the glyph surface, not the host's mounted focus/gesture target or its geometry. Active and touch-density grips remain visible. Canvas work cards reveal this existing grip on hover, focus or an open Organize chooser; touch and widget grips retain discoverability. This presentation input changes no carry, measurement, release or effect authority.

Interactive grips use `HappierDragGripTrigger`, including the core `EntityDragGripTrigger` binding and hosted Plugin UI sources. It composes the shared pressable and grip chrome, carries domain-owned accessibility actions, and exposes the existing focus registration and keyboard-consumption seam. Gesture-only phone handles retain chrome-only `HappierDragGrip`; they do not create a second interactive trigger.

These are development / Developer Preview authoring contracts. Source tests and generated exports do not certify a published SDK or a loaded browser/native journey.

### Configured widgets (0.3 development)

In 0.3 development source, widget Views and reusable definitions may declare
`publicPresentation: { kind: 'declarative', document }` through this same
declaration/projection owner. `widgets/widgetPublicSnapshotV1.ts` specializes the
existing declarative grammar to inert nodes and a symbolic public-profile data
source. The public projector validates field paths against the closed disclosure
schemas, applies current consent, then freezes only visible values. Its generated
schema rejects executable nodes and literal precomputed metrics too. An unknown
optional stored presentation is skipped; malformed known content is rejected.
`widgetPublicSnapshotPreparationV1.ts` resolves the selected private area once
and copies its admitted templates into the reviewed public layout. The external
authoring fixture contributes a template through an installed View, selects it
from the projected inventory, compiles the copy and renders its masked output.
Public-profile destinations use the same copy/setup and widget Actions, with
snapshot-only presentation inputs; private Usage queries and network overrides
are refused. Selecting a destination saves a private draft. Public Apply has
its own reviewed Action admission, and later definition/plugin changes cannot
change the applied edition. These source contracts do not certify a loaded
browser journey or released package availability.
The development profile editor retains one admitted snapshot through the
Protocol projector's page lifetime. Consent changes produce masked data views;
placement and Look edits do not readmit the snapshot. Placement explanations
use the projector's symbolic field dependencies, including optional figures in
multi-field blocks. Public page and individual-widget adapters receive the same
admitted metadata. A composed page shares its chart models with child widgets;
standalone setup can establish that same lifetime through the public
`HappierPublicProfileDataProvider`. Sharing is scoped to the same snapshot,
metadata and record formatter, so another disclosure projection uses its own
models. No wire format or publication authority changes.
Resource-free HTML and frozen literals do not prove revocable public field
provenance. Host-private `/presentation` is not an author API; external
authors use admitted public `/components` exports. The
[public-profile page](../apps/docs/content/docs/accounts/public-profiles.mdx)
records current availability and the draft/disclosure distinction.

Widget Views use the same contribution catalog and Surface Registry as other plugin UI. Their App/Session/Project target is an executable data context, not a physical placement allowlist. Each configured instance has its own identity and closed field bindings, defined by [`widgets`](../packages/protocol/src/widgets/widgetInstanceV1.ts); field descriptors, predicates and options reuse the neutral [`inputs`](../packages/protocol/src/inputs/index.ts) owner. The shared [`WidgetSurface`](../apps/ui/sources/components/widgets/surface/WidgetSurface.tsx) body consumes that admission and the incumbent installed-surface controller. Host layouts retain their own frames and persistence.

A Session widget selects its exact Home-qualified Session through its declared input path. Following a host context and pinning a different Session are distinct intents. The selected Session supplies current access, policy, machine and projection; neither the physical Home/Session host nor launch-input routing fields grant authority. Missing, ambiguous, lost or denied targets remain repairable and never fall back to the visible Session.

In unreleased 0.3 source, any plugin can declare `container:'widget', target:{kind:'project'}` with the required `sizeDeclaration` and optional ordinary repository applicability. The existing Project Overview/widget-area owner supplies its admitted Project target through host-only surface context, not editable widget inputs or launch input. The configured binder checks the exact Home, Project identity and current authority; the same inline host receives repository/checkout context and Project policy. A missing, mismatched or retired Project is unavailable or denied, never an App-target fallback. This adds neither a placement store nor a separate widget renderer, and does not make a Project page's personal `widgetAreas` capability app-independent.

While that exact Session's detail is hydrating, configured widgets consume the existing Session-route hydration lifecycle and show loading without offering input repair. A settled missing or denied target retains its refusal; an available target proceeds through the same access and runtime admission.

An installed widget whose plugin projection is still establishing also remains loading. A settled missing installed descriptor retains the host's supplied plugin-management action; loading does not offer that action.

The existing Summary, Plan, Changes and Local Services metadata/body owners project into that same catalog and admission path as native definitions, without fabricated plugin identities or a parallel creation registry. Configured copies retain independent bindings. Their native bodies use the selected Session's existing data/action owners; a configured Summary's work destination opens that Session's Agents view rather than borrowing the visible Session's local status popover.

The Home atmosphere's "Your Home" widget (`your_home`) is a native App definition with no inputs: it reads the active Home's machines and the Activity summary's session classification. It is also an atmosphere moment, so the widget catalog's one decision, `isBuiltinWidgetSwitchedOff` in `apps/ui/sources/components/widgets/widgetCatalog.ts`, follows its `homeAtmosphere.moments.yourHome` switch: while off, no creation path offers it, and Home and widget areas leave a placed copy undrawn without changing its layout. A body can also lend its one live header fact to the frame's meta slot (`useWidgetFrameBodyMeta`), next to the existing caption lending.

In unreleased 0.3 source, native definitions declare Session, Machine and Workspace values
through the shared field `inputType` host reference. `readWidgetInputTargetV1`
derives target admission from those declarations; installed/authored declarations
retain their existing explicit Session-path ABI. A declaration describes a value,
not a read grant: Session admission still resolves the exact qualified Session,
and Workspace admission requires the host-admitted checkout. An app-read definition
requires neither a fabricated Session nor machine/credential material. Account or
containing-document retirement removes its admitted content.

Machine inputs carry the strict Home-qualified `{ serverId, machineId }` target.
Their UI choices reuse the current Home machine inventory, including offline machines,
and remain separate from spawn-ready choices. Voice discovery uses the existing
privacy-controlled inventory projection, including through typed widget options.
Companion and Session Board fill the `machine` context slot from the readable
Session owner metadata; an unavailable owner view does not guess a launch target.
`machines.volumes.available` depends on the selected `machine` and reads its
volumes through the existing vitals Action. These values do not extend the public
plugin host-read enum or grant machine access. Native machine definitions and
their per-id supported sizes live in the shared
[`builtinWidgetDescriptorV1`](../packages/protocol/src/widgets/builtinWidgetDescriptorV1.ts)
owner; placement and native bodies consume that declaration.

Host preset groups may retain a presentation-only `titleKey` in the canonical
[`widget layout group`](../packages/protocol/src/widgets/widgetLayoutItemV1.ts).
The shared UI title reader resolves it in the current language, including after
the preset is saved or copied. The group rename intent removes that key, so a
person's title remains literal; older literal-only groups remain literal too.
An unavailable translation uses the saved title. Strict write admission and the
existing tolerant stored-data reader retain their separate contracts.

The shared field `contextMode` defaults to follow-able; `own` fields retain only
their ordinary bindings or declared defaults and reject context bindings. Group
input collection excludes those fields and credentials. Page/group composition
uses the same resolver for every widget family, and group values cannot promote
a saved Workspace reference into host read authority.
Followed values remain schema-checked under their admitted host context; choice
inventories constrain own selections, not the followed context. Empty multiselect
collections select nothing and do not require choices discovery. Builtin field
metadata on a core page uses captured Account admission independently of whether
its preset has a saved layout; choice sources still enforce their data authority.

In development, `visibleWhenContextSlot` lets a field appear only when a
surface-aware editor receives that named host slot. A declared slot stays visible
while its value is unavailable; an absent slot hides the control. Ordinary forms
without a surface-slot contract keep their usual fields. This visibility rule
does not change validation or retire an existing pin. Usage declares it on its
Session scope input; core-page areas host app-target accounting widgets, while
Home, Project and plugin areas retain their explicit Session-target pin flows.

Declared `optionsSourceId: 'sessions'` uses the neutral options resolver and returns qualified `{ serverId, sessionId }` choices from current Session discovery. Admitting a picked value asks `action.options.resolve` for that value (`values`) rather than for the inventory: `sessions` answers a pick with one `session.status.get` read (a locked Session stays a disabled option, a Session the Home reports gone has none) and falls back to the inventory scan when that read cannot answer; every other source, including a contributed input type's Resource, is read in full and narrowed to the values. Plugins declare no per-value source seam, so none is added to the SDK. Setup previews resolve the same declared bindings as saved instances without writing them. The surface's `onRepairInputs` callback exposes its typed unresolved binding outcome to the existing setup composition, without creating another input writer.

Widget Views can declare `resources` as qualified same-plugin Resource references at the existing manifest/Surface Registry owner. These references identify refresh dependencies, not permissions. The daemon projection retains each admitted Resource's actual `global`, `session` or `surface` scope; dynamic Resources have no fabricated packaged-file path. `widgets.item.refresh` admits the current instance and resolved target, then awaits each declared Resource's existing store read. The store's `refresh()` returns the settled snapshot, including a truthful error or retirement outcome; stale last-known content does not make a failed refresh successful. An opened About panel retains the same Machine projection discovery demand as the presented installed-widget body, including when the body is deferred offscreen or bundled presentation metadata already makes AppShell current. The existing shared acquisition owner supplies executable Resource declarations; Refresh consumes that publication without a separate resolver. Union composition retains a current selected source's complete Resource coverage even when an unselected replica has divergent declarations; an unresolved conflict still has no complete publication.

Same-realm widget mounts bind their ephemeral shared scope to the physical
surface's admitted plugin occurrence, captured Account lifetime and execution
origin. Targeted-contribution metadata is not required for sharing. The existing
shared-scope owner reuses values across current mounts of that occurrence and
refuses access after mount, occurrence or Account retirement. Independent routed
credential readers of the same Home/Account participate in that one scope;
retiring one reader fences its own facade without disposing a surviving reader's
values. The final current binding's retirement disposes the Account scope.

Native mounts, hosted read/watch bridges and this Action share the existing contextual Resource owner under the captured canonical Account and exact machine/occurrence/context. Declared global Resources share across physical hosts; Session Resources retain the selected Session identity. Final-consumer release or Account retirement disposes the store. Canceling an Action releases its wait rather than canceling another mount's shared read. Headless/client-only execution, missing declarations/scope or unavailable surface provenance returns typed unavailable, without child capability registries or current-UI routing. Native builtin definitions have no plugin Resource declaration; they retain their native data subscriptions/Retry and this Resource Refresh Action is unavailable for them.

In 0.3 development source, a dynamic JSON Resource can declare
`sessionInbox: { detailResourceId }`. The index has `scope: 'surface'`; the
same plugin declares a JSON detail Resource with `scope: 'session'`. This is
Resource metadata, not a second producer registry or permission grant.
`PluginSessionInboxRowPageV1Schema` owns the closed ready/unavailable response:
ready carries `rows` and nullable `nextCursor`; each row has `id`, canonical
`session: { serverId, sessionId }`, `title`, nullable `detail`, and
`detailResource: { pluginId, resourceId }`. Optional row `controls` uses the
existing `PluginDeclarativeButtonsV1Schema`, shared with notification-category
buttons: each control has an arbitrary nonempty, row-unique `id`, localized
`label`, and a closed `effect`. `open` optionally names the producer plugin's
exact `page: { pageId, subPath? }`; without a page it opens the row's normal
destination. `action` contains `invocation: { action: { pluginId, localId },
input }`, with required strict JSON input. Cross-plugin Action references are
valid here; notification categories' own-manifest Action restriction belongs
to notification declaration admission, not this shared binding. Unavailable carries exactly one of
`locked`, `unavailable`, `denied`, or `sourceUnavailable` as `reason`.
The author surface is `@happier-dev/plugin-sdk/resources` (source exports in
`resources/index.public.ts`; publication uses the canonical SDK generator).

An optional closed row `landing` carries `{ number, url, state, title?, observedAt? }`
from the producer's retained PR observation. State is `open`, `merged`, `closed`,
or `unknown`; the host offers the existing Landing row only for `open`. It never
infers merge state from a URL, watch policy or local Session state. The same
contract serves external plugins. It extends the unpublished V1 presentation
contract and requires a matching development host; old rows may omit it.

The mounted, presented Inbox reads pages through its existing Resource store,
using host surface context `mountInstanceKey: 'happier:session-inbox'` and
`launchInput: { cursor: null | string, serverId: string }`, with the Home id
captured from the admitted Account lifetime. Row identity is qualified by plugin,
index Resource and stable row id. Admission requires the declared same-plugin
detail and captured Home/Account; the host stamps the detail's exact Session
context. Rows join the existing Session/request item and open its Session route.
The row exposes the admitted detail binding for the Session detail composition;
index discovery never reads detail bodies. Visible detail consumers use the same
contextual Resource store, not an Inbox-owned loader. Hidden Inbox, declaration
withdrawal and Account retirement release demand; unrelated Account arrivals do
not reread the index. Failed/unavailable producers do not mean “caught up”.

The host projects current Action availability before offering a row control;
an absent or disabled Action supplies no affordance. A press uses the shared
declarative-button dispatcher and contributed-Action front door with the
viewer's `ui` authority, normal policy and in-app confirmation, the captured
Home/Account/Session, and current registration admission. The Action validates
its input; stale/replay protection belongs to that Action's own contract, such
as revision CAS. Resource bytes grant
no authority, plugin JavaScript initiates no press, and no global exactly-once
store is introduced. Two localized open-only controls, Allow and Deny, may both
carry the same `deployment-review` page/subPath destination: neither label implies
a deployment decision or permission Action. Host control-row visual composition
remains separate from this development-source data and dispatch contract.

Triage's 0.3 development declaration is `session-pull-request-inbox-v1`, paired
with the same-plugin Session detail `session-pull-request-status-v1`. Both execute
in the portable Account artifact `triage-account-runtime`. The index consumes
Channels' public `session-pull-request-watch-v1` `list` Action: one page of
admitted Session addresses and retained binding/watch/latest-update metadata,
without native PR status reads. Exact-Session metadata uses the same Action's
`get` arm. Channels owns selection, paging and binding/link semantics; Triage
projects one landing per returned Session, using the canonical distinct-link
projection and latest retained summary. Demanded detail alone acquires native
status through its existing configured-source owner. The host folds landings
into existing Session/request rows, honors the existing explicit settled
standing, and uses loaded Session title/privacy and update time when available.
The index selects the first open distinct retained PR for that Session's Landing
row; all links remain available through its existing detail Resource. The Inbox
uses already-admitted Session list rows without opening transcripts or fetching
PRs per row. Landing keeps the existing PR-URL opener and explicit Settle control;
`inbox.get` carries that same URL/state in its Landing group. Settle invokes
`session.attention.set { standing:false }` and `session.read_state.set { state:'read' }`
through the normal front door. Automatic settlement remains Channels' single
owner at retained PR observation: after every linked PR becomes merged or closed,
it invokes those same Actions once for that terminal transition. This runs
without a mounted Inbox; unknown or still-open links prevent settlement.
The former Channels Inbox/detail declarations and private host collection
reader are retired rather than retained as competing producers. SDK/package
publication and composed runtime validation remain integration boundaries;
this describes development source, not a released availability claim.

Configured PR Fix sends in 0.3 development use the same Channels Watch Action's
`deliverConfiguredFix` arm. The caller retains choice, source preparation,
linking and recovery; it supplies the exact Session, binding revision, PR,
head and resolved SDK forge evidence with its delivery idempotency key and text.
Channels checks the current native PR head, retains the configured cause on its
existing input obligation, and reserves the same binding `activeRound` used by
ingress. Channels sends and reads its own original input result; only an exact
host start witness charges the shared fixing allowance. Accepted replay returns
the retained canonical send result. Uncertain delivery retains the same host
idempotency key for recovery; outstanding or exhausted work returns a typed
hold. Compose-only drafts stay with the caller and never enter this send arm.
The Action retains its existing UI/agent policy and confirmation.

In development, exhausted Watch bindings contribute localized Continue/Stop
controls on that same Triage row through the shared declarative button contract.
Continue declares the existing Channels Watch `retryFix`; Stop declares
`configure` with the retained policy changed only to Off. Each carries the exact
Session, binding and expected revision. The host, not plugin JavaScript,
dispatches the press with the viewer's captured Home/Account and ordinary Action
policy/confirmation. Watch's binding CAS owns stale/replayed refusal and grants
the current effective finite allowance once. This AM-QC1 continuation is not a
C1 question or answer consequence; no second Inbox producer or answer writer is
introduced. Current controls remain an incomplete presentation contract:
the shared localized label accepts only a string or `{key,fallback}`, without
interpolation values or per-control PR context. Showing an unambiguous PR and
"Continue N more" therefore requires the shared label/presentation owner to
publish a consumable generic contract; the host must not parse Action input or
branch on a plugin id to recover that context. This source producer is not
complete rendered continuation UX.

The retained PR ingress leader sends push-only `update` attention through C1's
existing notifications service, using its stable leader id and the authorized
Session summary's exact Home address. It creates no notice/item id and does not
replace question, approval or Follow consequence delivery. Notify/status-only
updates retain retry custody for a transient unavailable destination or sender;
canonical quiet/suppressed delivery can settle without waking the Session.
Already-accepted agent input settles first: its subsequent push is best-effort,
and a failed/unknown push is logged without reopening or resending that input.
Retained live PR context is independent of phone delivery.

The development Watch-at-open offer reads the existing `plugins.settings.list`
Action for Channels' Account scope/target. That Settings owner supplies declared
effective values in one snapshot; Triage validates the policy and fix limit with
the public Watch schemas rather than maintaining another default policy. Its
reader hook performs no mount-time fetch: the actual open/link offer explicitly
requests the values with its cancellation signal. Unavailable or malformed
Settings remain unavailable, not an invented Notify choice, and canonical
pending approval is preserved. Reading defaults never configures a binding.

A newly committed provider-credential failure updates the existing connection
readiness and sends best-effort `blocked` attention through that same C1 helper
to its captured, still-current watched PR Sessions. Repeated blocked polls do
not republish the transition or push again. The helper rechecks the caller's
captured connection/binding admission after resolving the exact Session/Home;
retargeted, Off and ordinary chat bindings do not receive this attention.
Delivery failure is logged and never rolls back truthful credential health.

The development targeted-contribution reply carries optional
`resourceDeclarationsByPluginId` alongside its handles. A present plugin key is
that plugin's complete Resource declaration set, including `{}` for known-empty;
an absent key or field means that reply supplied no census. The controller uses
a complete Account namespace first, including known-empty. When Account coverage
is unknown, it uses the selected Machine's complete targeted set in preference
to the full describe, retaining that Machine's occurrence and each Resource's
declared context scope. The full-describe producer marks each included plugin's
installed-package row with the host-private `resourceDeclarationsComplete` fact. Its complete set includes
known-empty; a witnessed occurrence mismatch or noncurrent/conflicted source
does not supply coverage. A plugin absent from both complete sources remains
unknown and retains ordinary Resource transport. Selected Action replies,
partial installed-UI declarations and restored presentation cannot establish
coverage; a numeric or aggregate generation is not evidence of it. Only a
complete set can establish withdrawal. Coverage is descriptive, not an
additional permission decision or RPC/SDK field, and installed external plugins
use the same path.

Home layout and setup dismissals use one Account Artifact; shared Session instances use Board records and revisions; direct Companion instances remain viewer/device-local presentation preferences. The widget instance Action family delegates mutations to those owners. Personal Companion changes do not edit Board content. Viewer bindings consume only the viewer's own existing Connected Account purpose selection; there is no per-instance viewer override, Action or local selection setting. A widget declaration without correlation to an admitted existing purpose consumer fails closed; it does not guess another consumer or change a global binding. Pinned Connected Account references are allowed on personal surfaces only.

In 0.3 development, Home's Sections switch stores a widget or group's visibility in the layout's existing `hidden` list. Hiding retains the item, bindings, size and position; the row remains available to show the same copy again. Hidden sections do not mount widget data subscriptions and do not contribute to Add's “N on Home” count. Explicit Remove remains a separate item mutation. Agents use the same `visibility` intent through `home.hub.layout.update`.

The declaration correlates a viewer field through `connectedAccountPurposeBindings: [{ path, purpose, consumer: { pluginId, localId } }]`. The consumer must identify an explicitly declared current Resource whose purpose advertises the permitted services. The existing purpose admission/materialization owner admits that Resource consumer and uses the viewer's own qualified purpose selection, including an admitted member of a selected group. Changing that selection uses the existing Connected Account preference and lifetime, and can affect other viewer bindings for the same qualified purpose; it is not an instance-only connection edit. Personal pinned references, by contrast, remain instance bindings. The exact target supplies current Resource and service-authentication declarations; a Session pin is resolved before its full credential binding, without granting execution from the pin. Missing connection is a typed Connect requirement; missing declaration or read authority remains unavailable/denied. Shared content retains viewer intent, not the selected private ref or credentials.

`widgets.item.move` accepts `{ ref, toIndex, area? }` for current-view widget-ordinal reordering, or `{ ref, to: { surface, tabId?, area?, index } }` for owner-native insertion. Project `area` selects main or aside within the same dashboard document; it does not create another Artifact. Board view changes use its existing layout owner. Cross-surface movement admits both authorities, adds through the destination and conditionally removes through the source; refused/unknown outcomes report observed owner state rather than promising a transaction across independent stores. Add retains the caller's instance id and returns the acknowledged qualified reference.

For a widget `select` field marked `connectedAccountOptions: true`, the existing
`action.options.resolve` widget-consumer dispatch returns credential-free pin
choices from the viewing Account's active qualified profiles, filtered by that
same declared Resource purpose's permitted services. A personal pin does not
require an existing purpose selection. A declared, admitted `viewer` binding can
be saved before the author chooses a connection; evaluating it still requires
that viewer's selection, and a missing selection remains Connect. Shared pins remain refused. The marker
cannot be combined with static options, `optionsSourceId` or `inputType`; these
constraints belong to the neutral field grammar, not a widget-specific options
registry or public host service.

These are development-source contracts, not release or loaded-platform certification. WorkBoard, Project/plugin-area layouts, reusable declarative definitions and setup/edit composition consume the same identities through their respective program owners. Home includes built-in visibility and setup dismissals in its layout Artifact. WorkBoard widget intents use its existing `work-board.v1` Artifact reducer/CAS writer alongside work references and smart sections. Project/plugin areas share the [`widget-area-layout.v1` owner](../packages/protocol/src/widgets/widgetSurfaceArtifactV1.ts); changing page context does not create a new layout. Project areas use order and a Plain default.

Each Project dashboard has one layout Artifact containing both main and aside.
The omitted `layoutId` retains the default Overview identity; an explicit
Project `layoutId: 'overview'` normalizes to that same owner reference rather than
creating a second Artifact. Other named documents add
their `layoutId` to the stable private Project key, qualified by Home and owning Account.
The existing Artifact header inventory supplies names and owner-only scalar
ordering, without reading inactive bodies or creating an inventory store. The
default of an existing Project cannot be deleted. Forget preserves its bytes;
after the last accepted private Project reference is forgotten, its owner may
explicitly delete the retained Overview through `widgets.area.layout.delete`
with the existing destructive acknowledgement. The private Project-row owner
decides whether it is referenced; unavailable rows do not authorize deletion.
Named rename, reorder and delete operate on their
selected document and expected revision. Missing default content is a render-only
state, distinct from a persisted empty document.

The default Overview's builtin placements come from
`builtinWidgetDescriptorV1#projectOverviewDefaultPlacementsV1`, shared by the
Artifact owner and the UI projection. Reading a missing default writes nothing;
its first explicit layout or dashboard metadata edit materializes that whole
default layout through the existing Artifact writer. Present empty documents
never restore defaults.
The Project Overview adapter reads the selected document once for both areas.
On phones it merges their current heads while preserving each saved area's
order, without a persisted phone layout. Controlled frame disclosure is
viewer-local for editors and view recipients alike; README starts collapsed
and toggling it sends no layout Action.

#### Layout groups and saved fragments (unreleased 0.3)

[`widgetLayoutItemV1`](../packages/protocol/src/widgets/widgetLayoutItemV1.ts)
owns one `widget | group` union and placement reducer shared by Home and area
layouts. Persisted `items` include widget children inside groups; ids are unique
across top-level items and all children, and groups cannot nest. WorkBoards,
Session Board and direct Companion do not admit groups. The host-owned
`corePage` surface uses the same area Artifact transport, rather than a page-local
store; its consumers remain responsible for mounting their page.

Groups default to Card with hairline dividers. Their width is `half | full`;
[`resolveWidgetGroupWidthFitV1`](../packages/protocol/src/widgets/widgetPresentationV1.ts)
reports both choices and the child blocking an unavailable width. Placement
admission reuses that result. Children retain their own saved frames; the
approved rendering contract projects them as Plain inside the group. Ungroup preserves the children, and
moving out restores their saved frame; removing the last child dissolves the
group. Group removal removes its children explicitly through the same reducer.

Group bindings compose at the existing
[input resolver](../packages/protocol/src/widgets/widgetActionInputResolverV1.ts):
a following child reads group context before surface context, while a pinned
child retains its own value. Viewer intent continues through the existing
purpose-selection owner. A group conveys values, never access, and each child
still passes exact-target, input and read-authority admission.
Group input discovery uses the child that declares each follow-able field;
child-owned and credential fields are not group inputs. The editor and saved-group
Add pane send that child's definition to the ordinary options admission owner.

Home and widget areas render groups through one UI owner,
`apps/ui/sources/components/widgets/group/**`: `WidgetGroupFrame` draws the
group in the shared widget frame (no header row when untitled) and packs the
children with `packWidgetGroupBands` (shorter-column packing; a full-width
child takes its own band; a lone child fills its row in view mode and keeps
its half beside an empty slot while customizing; one column on phones and at
half width). The group draws ink dividers; children draw plain without their
own hairline. `widgetGroupMenu` builds the group ⋯ and each widget's group
entries (Move to group, Remove from group, Ungroup, Group with…) through the
frame menu's order, and every width choice shows unavailable widths with the
blocking widget. Drag refusals for width and nesting take their words from the
shared `widgetMovementRefused` owner. A whole group lifts by its grip as a
`widget-layout-group` carry; a group target admits into-group or beside-group
drops, and each card target draws the line between cards, inside its group when
grouped (`widgetGroupDropTarget`). A group's empty slot opens the surface's Add
aimed at that group (`widgets.item.add` with `groupId`). Save group asks for a
name and writes a private fragment; Add to… copies the group to Home or a Project
through `widgets.group.add`. Add lists only widgets the surface can host
(`isWidgetTargetHostableV1`: a checkout target needs a Project), and
`widgets.catalog.list` filters the same way.

[`widget-layout-fragment.v1`](../packages/protocol/src/widgets/widgetLayoutFragmentArtifactV1.ts)
stores reusable group options, declared inputs, provenance and each child's
definition reference or inline definition, bindings and size through the
mode-aware Account Artifact transport. Stored readers tolerate additive fields;
new writes remain strict. Capture removes physical placement ids and areas.
Instantiation allocates fresh group and child ids, and `widgets.group.add`
applies one atomic `group_add` intent. These are copies: a fragment update does
not change an existing group or introduce a live link to its saved source.
Children that reference a reusable widget definition retain that definition's
normal reference semantics. The
[Artifact kind policy](../packages/protocol/src/artifacts/artifactSharingV1.ts)
keeps fragments out of the generic document browser, people sharing and public
links; their port admits only the owning Account's library.

Area layouts share one `layoutId` across Project, plugin and core-page owners.
Host presets supply named `items`; personal views use the same Artifact writer
and `widgets.area.layout.*` Actions. Project Overview uses that preset contract.
Reading missing defaults causes no write. The first explicit edit persists the
defaults plus the edit through CAS; an explicitly empty saved layout remains
empty. Create with `fromSurface` copies current content into an independent view.
Preset state and the layout inventory's `isEdited` bit compare the same name and
items with host defaults. The area read's preset state also carries `changes`,
a typed summary (added, removed, moved, changed, renamed, each with its item)
derived from that same comparison; the edited preset's line words it and no
consumer diffs layouts itself. Inventory opens personalized presets at the Artifact
owner; tab consumers do not issue extra per-preset reads. Every area owner draws
its named layouts through one tab bar
(`apps/ui/sources/components/widgets/area/WidgetAreaLayoutBar.tsx`). Native and
declarative plugin areas expose user-created named layouts through that same
bar and page-local host port. An area declaration still supplies only its name
and readable context schema, not authored presets or persistence callbacks.
A saved group records where it was saved from (`origin`) beside
its provenance date; a fragment saved before that fact existed reads without it. Reset requires the
current revision, replaces the items immediately and returns the prior layout
with its acknowledged revision; Reset/Undo refuse intervening edits. These
owner-level contracts do not certify the loaded controls or visual acceptance.

In 0.3 development, an admitted selected layout renders independently of the
named-layout inventory; that inventory gates the view switcher. Inventory read
failures settle offline, retaining acknowledged names unless authority is lost. A canceled
surface read returns `cancelled`. If a surface read throws while its captured
Account remains current, admission returns `widget_area_unavailable`, and the
area offers Retry through its existing layout reader without resetting edits.
Missing, changed or retired Account authority still refuses; the area directs
the viewer to reopen the page under the current Home and Account instead of
retrying the old authority.

An attached shared dashboard binds the owner's exact Artifact, while the actor
remains the viewing Account. Current Artifact access and key readiness admit
each read or write; view access cannot edit and retirement never creates a
personal replacement. Source membership and independent Artifact grants are
separate authorities. Dashboard and WorkBoard sharing delegate private-selection
and inline Resource-literal checks to the same
[widget privacy owner](../packages/protocol/src/widgets/widgetSharedInputAdmissionV1.ts)
as Session Board. Private definition references on dashboards and WorkBoards
retain unavailable placeholders rather than granting definition access.
Generic key-holding WorkBoard edits and retained-body restores enforce that
same content policy before encryption and CAS; changing the candidate header's
kind does not bypass the current document's policy. Personal writes remain
personal, and safe shared writes retain their existing Artifact owner.
In 0.3 development source, audience admission combines actual people grants and
access with `publicAudience` from the authenticated exact Artifact read, independently
of the feature-gated public-link management list. `retained` means shared exposure;
`none` rules out only public exposure. Missing or unfamiliar values normalize to
`unknown`, never private.
Publication expiry or deletion ends that audience; an exhausted issuance limit
or disabled public-sharing feature is not proof that retained links were deleted.
An unavailable audience read stays unavailable, rather than becoming a personal
write admission. Content already proven safe for either audience needs no
privacy-specific audience lookup.
Shared widget writes consume admitted sharing facts through the canonical
configurable Action approval policy. Selective input set/reset intents merge or
remove exact paths against the writer's current bindings, preserving unrelated
concurrent choices; omitted paths retain whole-set/whole-reset behavior.

The same policy treats benign personal presentation edits on admitted private
Projects, plugin areas and core-page areas as safe: rename, size/frame,
same-surface order, group width/dividers and named-layout create, rename,
reorder, Reset and Undo. Privacy for these Artifact-backed areas requires a
positive admitted `isShared: false` fact. Shared writes, destructive layout deletion and reusable
definition updates/deletion retain danger; an explicit Ask first preference
still requires approval for safe personal edits.

The [widget presentation owner](../packages/protocol/src/widgets/widgetPresentationV1.ts) defines semantic size names, deterministic order and surface-specific width × height footprints. Definitions, builtin descriptors and plugin widget Views declare `sizeDeclaration: { sizes, defaultSize }`; the default must belong to the nonempty, unique declared set. Protocol resolves the declaration against the surface-supported set once, in canonical size order. `widgets.catalog.list` exposes each entry's resulting `presentation.sizes` and optional `presentation.defaultSize`; a supported declared default wins, otherwise the first admitted size is used.

Home, plugin areas and WorkBoards consume those footprints through their existing layout reducers. Session Board resolves them into its existing native width and item-height owners, including Auto height; it has no second saved-height writer. Existing custom native width/height combinations keep their actual footprint and omit a semantic size when no named rectangle matches. Project aside and Companion remain linear and carry no size operand. Native layout owners retain pixel geometry and responsive reflow: narrowing to a phone changes rendered spans without rewriting saved size intent. Cross-surface moves preserve an admitted size or normalize to the destination's declared/supported default.

`widgets.item.size.set` accepts `{ ref, size }` through the existing instance Action dispatch; it replaces the undeployed width-only Action in place. `widgets.item.add` accepts the chosen `size` in the same atomic Add intent. More than one admitted grid size opens the existing setup step for selection/preview even for inputless or fully bound widgets; zero/one size or a linear surface retains the existing direct Add path when inputs are ready. Setup, Customize, frame menus and bracket-key stepping consume the same choices through the shared public [`WidgetSizePicker`](../packages/plugin-ui/src/presentation/layout/WidgetSizePicker.tsx) and canonical Actions. Resolved size and measured geometry reach native and declarative bodies through the existing presentation/RenderContext seam; they describe composition space, never data identity or execution authority. Bodies can adapt compact versus richer content, while an absent compact renderer retains the existing framed full-view fallback.

Reusable Account definitions use `widget-definition.v1` Artifacts through the existing mode-aware Artifact transports and the [definition owner](../packages/protocol/src/widgets/widgetDefinitionArtifactV1.ts). Definition Actions create, edit, duplicate, delete and copy admitted Session content into the Account library. Placements reference the Artifact and retain their own bindings; duplicating creates an independent definition. Deleting a definition retains unresolved placements for repair. `saveFromSession` copies rather than removes the Session item and makes its declared Session input configurable. An explicit shared Session Board add copies a private definition into the instance's inline definition before approval; the Session Board never receives the private Artifact pointer. Its grammar rejects private Connected Account selections in copied definitions and bindings.

In unreleased 0.3 development source, mounted saved definitions hydrate their exact Artifact through the shared UI Artifact body reader and project the canonical Artifact store with the Protocol definition parser. They do not wait for Account inventory or the enriched definition Action's cross-placement census. The shared reader acknowledges its own store publication, renews demand with the active Account lifetime, and obtains HTTP owner/grant facts for content-only socket rows before admission. Socket edits and deletions then invalidate that same row instead of a widget-local copy. The enriched Action retains placement metadata for management consumers.

In unreleased 0.3 development source, saved bodies are declarative documents,
HTML bundles, installed surface references or strict built-in references
`{ kind: 'builtin', id: BuiltinWidgetIdV1 }`. Built-in promotion captures the
canonical descriptor's declared inputs, input schema and sizes, the admitted
instance bindings and its effective policy. Saving freezes that definition
content rather than data from a live Resource. Account placements and inline
Session copies render through the existing native built-in renderer; current
viewer input, target and Resource admission still decide what can be read.
Neither saving nor sharing supplies the author's credentials or freezes a live
widget into a snapshot. Anonymous public links open the saved definition but
show the canonical live-widget unavailable state for built-in or installed
bodies and Resource-backed declarative content. Static declarative and HTML
bodies use the existing public renderers. Unknown built-in ids are invalid
content, not an executable extension point.

Declarative metric, table and chart nodes use [typed data-source references](../packages/protocol/src/plugins/contributions/ui/declarativeDataV1.ts). They draw through one presentation owner, [`presentation/data/**`](../packages/plugin-ui/src/presentation/data/), which core's declarative renderer and the public `Metric`, `DataRows`, `DataTable` and `Chart` components share: tabular locale numbers, a proportion column as a share of its largest value, table columns dropped by measured width (`secondary` first, never the name) while every row stays and each row still reads every column to assistive technology, and a chart that is one labelled image naming every point. A live widget document keeps its last authorized content through refresh, a sleeping machine or a failed read, with one freshness line (as of, cause, Retry); `Post a snapshot` freezes exactly the frozen nodes on screen when the confirm opens ([`projectWidgetSnapshotPreviewV1`](../packages/protocol/src/sessions/board/declarative/snapshot.ts)). A Resource reference identifies a current declared Resource, not access authority; its scope, current occurrence and resolved input are admitted by the incumbent Resource owner. `widgets.snapshot.post` publishes the exact previewed inert document, as-of time and provenance through the existing Board item upsert. Snapshot content contains no live Resource, launch input or executable control. The Action never re-queries after approval. Definition edits/deletion, shared Board content upsert and snapshot publication use the existing consequential approval defaults and configurable waivers.

The development public `@happier-dev/plugin-ui/components` palette (also exported from the package root) exposes finite neutral series, grids, intervals, capacity, composition, ranked rows and outcome forms from that same data owner. Callers supply identities, exact values, labels, units and any qualified projections; charts do not fetch Usage, infer accounting totals or decide status. A missing observation remains distinct from zero. Compact presentation retains exact accessible values rather than truncating the dataset. Composition takes an explicit whole, so overlapping categories retain their supplied denominator instead of becoming a misleading stacked total. App tooltip and scrolling-frame adapters may wrap shared visuals, but own no second plot geometry. Capacity and row proportions reuse the existing progress primitive; ledgers remain `DataTable`. The declarative and native chart paths share `StackedSeriesChart`, including the single-series `Chart` adapter. Visible ink may be compacted through a caller formatter (`317M`, `$1,555`) while assistive technology keeps the exact value: `Metric` adds `hero`/`stat` sizes with a visible label and caption, `RankedRows` takes an explicit whole for share chips and leading identity marks, and a series takes one labelled reference level (a typical day) drawn as a quiet rule. Stacked areas part on a thin paper seam rather than an outline.

In 0.3 development source, `formatHappierDataValue` keeps every integer digit in
locale-formatted tables and accessible readings. Fractional readings retain the
existing fifteen-significant-digit suppression of binary accumulation noise
(`0.1 + 0.2` reads as `0.3`). Caller-provided visible abbreviations remain separate
from these shared readings; a number alone does not declare a different precision.

In 0.3 development source, `StackedSeriesChart` uses the optional semantic theme
token `theme.colors.dataAccent` for series without an explicit `color`, deriving
their ordered ramp against `theme.colors.surface`. Older theme snapshots omit
that token; the same renderer falls back to `theme.colors.accent`. Use
`usePluginTheme()` to consume the mounted theme rather than copying host colors.

Private Usage and public profiles also share the original Daily, Rhythm, Period
summary, Breakdowns, Outcomes, Recap, Footprint and Coverage bodies in
[`presentation/usage/charts`](../packages/plugin-ui/src/presentation/usage/charts/).
External authors use their theme adapters from public `/components`. Private app
adapters retain queries, hooks, drill actions, disclosures and sharing; public
adapters supply only policy-projected models and host-localized labels. Public
Daily and Rhythm use ordinal activity levels, Outcomes uses the admitted merged
count, and Footprint retains its insufficient-basis state with tokens shown only
when independently shared. The server's cold renderer consumes these same bodies.

For bounded lists, public `/components` and root exports
`leadHappierListRows(rows, expanded)` and `HappierListOverflowFooter` share the
existing collection presentation owner. The helper preserves caller order,
returns all rows for an expanded or short list, and otherwise returns leading
rows plus `hidden`. Pass that count, the held `total`, `expanded`, `onToggle`,
the theme and an accessible list `label` to the footer. It draws Show all / Show
less and an optional `unlisted` explanation once; `complete={false}` says Show
available rather than claiming the source is complete. The caller owns expansion
and source paging; opening the footer does not acquire missing rows. Supply
localized `labels` where needed. These are development-source author contracts.

In 0.3 development source, declarative charts declare `rows` and typed `x`, `series` (string) and `value` (number) fields over neutral long rows. `style: 'bar'` stacks bars, `'area'` stacks ribbons, and `'line'` draws independent lines. Each x/series pair is one observation; duplicate pairs are rejected, and an absent observation stays missing rather than becoming zero. The existing `style: 'bar' | 'line'` with `x`/`y` remains accepted as N=1. Both paths render through public `StackedSeriesChart`; `Chart`/`HappierDataChart` only adapt one series. Resource schemas must declare the displayed paths and types. Snapshots retain only those displayed x/series/value scalars (or legacy x/y), with no Resource reference, hidden output, expressions, scripts, remote URLs or arbitrary chart options. The labelled chart, bucket controls and exact-value table use the same values as native charts; full charts offer their table through the host-localized Details control unless the caller supplies its own wording. Existing occurrence, Resource, literal-content and audience admission still apply.

Native callers can control the same exact-values disclosure with
`valuesExpanded` and `onValuesExpandedChange(expanded)`. The shared chart emits
the requested next state and renders the supplied value; without the prop it
retains its own initially collapsed state. Host UI and mounted agent commands
can therefore share one caller-owned disclosure without a second chart path.

Dense line and area charts retain every supplied SVG point and exact value. When
hit ranges are narrower than a pixel, the web chart uses one plot control with
exact Arrow/Home/End traversal and pointer selection, including compact charts
without a Details toggle. Its label reads the selected sample; Details, when
offered, still exposes all values. Native plots tall enough for the existing
minimum target use one plot control with exact increment/decrement accessibility
actions; shorter plots retain full-size Details controls. Native inline charts
retain their complete accessible image description without mounting empty
per-point views. This changes mounted interaction work, not the facts or scale.

In development source, `StackedSeriesChart` line appearance and `BurnUpChart` can fill a band between two caller-supplied series on the same scale. Missing, non-finite or inverted bounds break the fill; an isolated point has no area. Bounds retain their exact values in the chart's accessible readout and table. The caller supplies any range meaning and sample-count disclosure; the renderer does not infer confidence or forecast facts.

Bar charts also accept caller-selected `bucketShading` by semantic bucket id and labelled `barRanges` comparison outlines on the observed scale. Missing buckets and non-finite, inverted or out-of-scale bounds have no outline. An all-unknown bar slot has an explicit gap mark, while a known zero retains its original value; neither shading nor an outline adds an observation or changes the exact-value table. Reference levels and comparison bounds retain exact numbers in the accessible chart label.

In 0.3 development, byte readouts share
[`formatHappierDataBytes` / `formatHappierDataBytesParts`](../packages/plugin-ui/src/presentation/data/dataModel.ts).
Callers must declare the quantity kind: file, disk and transfer sizes use decimal
`storage`; RAM, process memory and swap use binary `memory`, labelled GB rather
than GiB. Values at or above one unit retain three significant figures, with
trailing zeroes omitted. Consumer-specific sentences compose these readouts;
they do not implement another byte formatter.

The unreleased machine-vitals forms extend this same neutral owner rather than
adding app-owned chart geometry. `StackedSeriesChart` accepts a caller-labelled
warning/error threshold, clipping its semantic ink to the values above that
level. A caller-supplied mean/max band can expose a bucket's upper edge without
discarding either exact value. Mirrored series use signed coordinates around
zero while their readouts retain absolute magnitudes; callers choose direction
and units. [`CoreLoadBars`](../packages/plugin-ui/src/presentation/data/CoreLoadBars.tsx)
reuses the series/bar owner, orders declared performance/efficiency clusters,
wraps by measured width and keeps each core's exact accessible label. Unknown
observations remain unknown. These forms decide no machine pressure, polling,
sample cadence or alert status; those belong to the
[machine-vitals owner](cli-architecture.md#machine-vitals-03-development).

`IntervalTimeline` also accepts point events: one known coordinate, without an inferred duration or end. The shared owner places caller-supplied marker ink and retains exact rows when the plot cannot fit. With `layout="lanes"` it groups intervals by `lane` (a machine, an agent) and packs each lane's runs (intervals sharing a `track`) into the fewest non-overlapping tracks under one shared axis, with optional caller `ticks`; every run stays selectable and listed exactly behind Details. Web keeps dense per-run pointer controls. Native uses one adjustable scrub target per track at the platform minimum (44 pt iOS, 48 dp Android): pressing or dragging selects the nearest run, and accessibility increment/decrement steps through its runs. Packed runs therefore do not create overlapping native press targets. Both layouts draw the same domain projection: the in-domain part of a witnessed span (including one that crosses either boundary), only an in-domain start for an unknown or reversed end, and nothing for coordinates outside the domain, which the exact rows still state. `CapacityBar` can draw a remaining-capacity projection using the same progress owner, with the projected solid remainder bounded by the current remainder. `CompositionStrip` offers a compact static/export legend; art may supply palette and type ink, but every series keeps its supplied whole and exact accessible share. Usage Reset, paced meters and recap cards consume these seams rather than owning private timeline, overlay or segmented-bar geometry.

Metric comparisons project a typed value and authored label with explicit
`good`, `bad` or `neutral` meaning; numeric sign does not choose semantic color.
Rows and tables can project a boolean mark with separately authored true/false
labels and meanings. The same declared fields are validated against Resource
output and copied when freezing a snapshot, so comparison/mark presentation
does not copy undisplayed structured output.

Resource-only plugins do not need an unrelated View to supply app-scope widget data. The existing daemon projection stamps the Resource's actual execution origin and occurrence; the app union admits it only against Administration's exact selected origin and the matching enabled package occurrence. Older unstamped rows retain only their existing admitted-UI context, not independent app read authority. Demand and explicit Refresh use the Resource origin's own currentness: another current machine in the union cannot start reads on an offline origin. Retained authorized data may still display while reads are paused.

Client-targeted Actions receive the bounded [`PluginClientActionUi`](../packages/plugin-sdk/src/actions/contracts.ts) subset, not a mounted `SurfaceContext`. Its `context(options?)` returns current `targetedContributions` for the Action's plugin (or `null`) and the optional `accountScope` from its admitted Account lifetime. The scope identifies private evidence; it grants no Action authority. `version()` and `selectActionInput(...)` reuse the canonical host method advertisement and selected-input admission/custody; `executeAction` and `openSurface` remain the effect seams. An Action gets no page, mount, layout or UI-selection owner from this capability.

In 0.3 development source, that capability also exposes `readSession`,
`readComposer` and `applyComposer` through the incumbent Account and Composer
owners. Composer operations require the exact mounted draft in the invoking
Account; an absent Composer returns its ordinary unavailable result. The
ordinary New Session seed accepts an optional canonical `agentTarget`, which
the authoring draft retains alongside its profile selection.

Configured Triage's composed `newSessionDraft` result acknowledges its completed
`openNewSession` request. That request uses the ordinary seed/navigation owner;
callers preserve the result without opening another draft. Health investigation
seeds carry the selected Agent/profile, exact Machine and managed-directory
intent into that same draft.

Session reads expose that exact `agentTarget` independently of the catalog's
display identity. Their optional `acceptedWorkspace` contains an accepted
`checkout` address and known `repository` from the invoking Account's admitted
Project census. Private, incomplete, ambiguous or unmatched facts stay absent;
the host does not derive repository authority from the Session's displayed path.
The existing `session.status.get` Action exposes the same optional proof when
`includeAcceptedWorkspace: true` is requested. Ordinary status reads perform no
Project-row acquisition. The daemon opens the invoking Account's private rows
under its captured requester custody and applies the canonical Session checkout
resolver; unavailable proof stays absent without changing the status envelope.
`SessionAcceptedWorkspaceV1Schema` owns both projections' strict value shape.

For an Agent asked to inspect “this checkout”, Action discovery directs it to
`session.status.get({sessionId: "self", includeAcceptedWorkspace: true})`, then
to pass `result.acceptedWorkspace.checkout` unchanged as the `workspace` input
to `projects.inspect`. If the proof is absent, the Agent reports the checkout
identity unavailable rather than inferring identifiers from a folder name or
Session path. Both Actions retain their existing approval policy.

In 0.3 development source, `projects.inspect` reports setup readiness through
the same requester-bound review used by Scripts. Signed-root CLI/MCP reads,
including Agent `action_execute` calls through `/actions/root/execute`, acquire
the same Home-authorized requester custody before the Machine reads private
setup inputs. Local placement does not bypass that admission. A Session can
read the readiness fact without gaining permission to execute or approve setup.
Unavailable requester inputs remain `unknown`; a failed inspection preserves
its typed reason code and records a content-free diagnostic. Unexpected failures
use `project_setup_inspection_failed`, never `notRequired`.

The shared Session recipe composer resolves saved Home aliases through the same
server-profile identity owner as New Session before looking up its Machine and
Agent catalog. Host targets, recipe seeds, offered candidates and returned drafts
use that canonical scope. An unknown identifier remains unresolved; the composer
does not infer Home identity from an ambient selection or a matching Machine id.

In 0.3 development source, a declarative contributed Action control with omitted
input presents its declared `inputHints.fields` through the existing Action form
modal. Its exact occurrence, input schema and the control's UI invocation surface
remain authoritative. Submission uses the same mounted Host API binding,
and cancellation or mount retirement sends nothing. Explicit declarative input
and SDK `executeAction` calls retain structured execution semantics; a schema
alone does not declare a form.

Feature-specific caller contracts belong in their public feature package. For PRs & Issues, [`@happier-dev/triage-protocol/v1`](../packages/triage-protocol/src/v1/index.ts) publishes source detail-tab declarations, qualified fix-link Action schemas/references, and the `agent-actions` point (`TriageAgentActionsContributionProtocolV1`) where a plugin declares agent action records with the same declaration schema as Happier's own subject owners; Triage's catalog owner qualifies, merges and offers them ([configured Session actions](triage-sources.md#configured-session-actions-03-development)). Triage retains its private relationship writer and resolver; callers receive the owner-resolved read projection. These contracts add no Triage policy to the generic SDK or host. See [Triage source ownership](triage-sources.md).

Hosted CI's 0.3 development-source contracts use the same protocol-only
`@happier-dev/triage-protocol` package's explicit `/ci/v1` and
`/ci/testing/v1` domain entries. Releases use `/releases/v1` and
`/releases/testing/v1`; the existing root, `/v1` and `/testing/v1` retain their
source-author contract. The [SDK evolution doctrine](compatibility.md#sdk-protocol-evolution)
governs each domain epoch. Shared CI adapters and presentation belong to
`@happier-dev/forge-ci/runtime`, `/ui` and `/translations`; native clients,
credentials and provider writes remain in the forge plugin. The runtime entry
does not load UI. These are public Developer Preview source contracts, not an
npm availability claim. The canonical CLI-managed authoring path delivers
declared public package dependencies; external publication requires release-owner
approval.

The development-source mounted UI API `host.downloadFile({ action, input }, { signal })`
runs an admitted daemon-placed contributed Action through the ordinary plugin-surface
dispatcher. The host supplies `input.destination: { destinationId }`; authors supply
neither destination paths/URLs nor bytes in Action JSON. The Action publishes acquired
bytes with `context.services.fs.prepareDownload({ name, bytes, destination }, { signal })`
after its normal caller admission, without a nested filesystem Action. A present
person's direct download and an agent's approval-by-default therefore remain the
same declared Action with their existing caller policies. The client requires the
accepted receipt to match its held destination, then uses the shared platform sink
and direct-export receiver for integrity, close and acknowledgement. An accepted
receipt is not saved-byte success, and a lost final acknowledgement remains unknown.
Headless Voice does not gain mounted-person or device-destination authority. This
is a Developer Preview source contract; generated package and loaded-runtime gates
still apply before claiming availability.

Mounted target surfaces receive locale-resolved translation bundles from their admitted contributors through the existing `SurfaceContext.translations` projection. Contributor keys retain their authored namespaces; the mounted plugin's own bundle takes precedence on a collision, followed by framework-owned chrome. Unadmitted plugins' bundles are not included. Each bundle uses the same preferred-locale and English fallback owner.

Plugin authors operate on widgets through qualified `widgets.*` Actions and
embed declared native page areas through public plugin-ui `WidgetSurface`, or
declarative page areas through `widgetArea` nodes. Hosted HTML pages use the
ordinary widget Actions without embedding host areas. The SDK's
current-Session presentation types expose only the
[`author subset`](../packages/protocol/src/sessions/presentation/currentSessionPresentationV1.ts)
of the canonical presentation validator. Built-in, shared Board-item and pane
references can be arranged through reversible presentation intents. Direct
Companion instance records, instance input/rename intents and conditional
removal captures stay inside the host transport. They are not author DTOs or
an alternative widget mutation API.

### Typed input extensions (0.3 development)

The `savedSecretReference` host input uses the incumbent Saved Secret picker and
catalog with metadata-only demand. `SharedSavedSecretReferenceSelectionV1Schema`
admits exactly a `shared_resource` ref and positive `resourceRevision`; pending
person selection, personal ids and material are not completed input. Both the
host picker and exact Action form submission use the canonical host input
validator, independently of an author's possibly permissive JSON schema. The
captured Account lifetime retires the picker. This selects a reference only;
the deployment binding Action's input and approval-narrowing owner must supply
the separate pending-choice continuation before that journey is available.

Personal usage has one host-owned `UsageQuery` at
[`inputs/usageQuery.ts`](../packages/protocol/src/inputs/usageQuery.ts). A field
declares `inputType: { hostType: 'usageQuery' }`, not a fabricated plugin
identity. Its generic host picker and headless validation use that same schema.
The independently follow-able scope and cost-basis paths consume the general
field `contextMode`; metric and breakdown retain their own presentation values.
Accounting Usage builtins declare their consumed inputs against the canonical
query schema: shared scope and cost basis, plus metric or grouping only when the
body uses them. Period summary does not declare Group by. Sources declares only `agents`, `machines`
and `sources`, through the inventory projection of that same schema. Its inventory
widget can be admitted without accounting period, metric, project, Session or
cost-basis selections. The Sources host preset also contains Coverage and Unpriced
accounting widgets; those follow the ordinary query scope and cost basis through
the same batched Resource. They do not add native discovery or capture demand.
Period and Session declare the narrow
`{ hostType: 'usageQuery', field: 'period' | 'session' }` projections, so Add and
Edit invoke the same typed picker owner without a raw JSON editor. Period uses
semantic relative choices (`period: { relative: '7days' }`, for example); the
query owner resolves their numeric accounting range at the read clock and selected
calendar offset. Named multi-day periods include today and exactly that many local
calendar dates; their exclusive end is the read clock. Copies pin that intent, not
the copying clock's start timestamp. Older open-ended accounting responses draw
only through witnessed observations or buckets, preserving unknown gaps rather
than substituting the viewer's clock or zero usage.
Existing absolute `{ startMs, endMs }` ranges remain readable and unchanged until
a choice is made; their duration never implies a relative preset. Session uses the existing
qualified Session inventory for the captured Home and projects its selected ids
into the canonical query; an empty selection means all Sessions. The native
qualified Session input type is unchanged.
Own-value Agent, machine and project choices use the same admitted accounting
inventory projection as the Usage toolbar, including on Home without Usage
context slots. Machine names come from that captured Home's authorized inventory;
empty scope arrays mean all. Widgets that consume grouping declare a single-choice **Group by**
whose values remain arrays: existing multi-dimension pins stay readable and
selectable until edited. The Breakdowns widget explicitly declares multiselect
because it draws several dimensions. The advanced UsageQuery API continues to
admit all supported breakdown dimensions.
Add, Edit and copies consume the same declaration defaults without replacing saved
bindings or missing followed slots. Group by labels come from the canonical
array-valued choices even while discovery is pending; its empty default is not
the cost-basis “Best available cost” choice.
Previously saved in-program Usage copies may still carry unconsumed query
bindings. The canonical binding projection ignores those known query paths when
the builtin no longer declares them, preserves its consumed selections and edits,
and still rejects unrelated undeclared paths. That read projection does not rewrite
the saved Artifact or add a persistence migration.
Usage's original eight core-page presets plus Agents are portable layout fragments,
instantiated by the shared widget platform with Card groups and Lines children.
Their view selection and user copies use `owner.layoutId` and the ordinary
`widgets.area.layout.*` Actions, not a Usage-specific view store. The page
supplies the seven scope/cost values for runtime binding; its Account editor
offers no Session slot, even when an Account query narrows to a Session. Only the
admitted Session route declares that editor slot. The unfiltered Session value remains admitted for
saved followed bindings, while Add, Edit and copy field visibility use the host's
offered-slot projection. A declared temporarily unavailable slot remains offered.
Metric and breakdown remain own values where consumed.
Native optional period bounds enter this context through Protocol's JSON
projection; undefined object members are omitted without changing relative or
absolute period intent.
The Project adapter's plural `projects` slot comes from admitted Project
identity, while the Session consumer must supply an already admitted
Session id, not treat a route parameter as authority. The logic seams are in
development source; their visual consumer
and loaded-runtime validation are separate from catalog admission.
Batch normalization sorts and deduplicates complete resolved query identities.
`usage.query` takes `{ queries: [query] }` and returns independently keyed current
snapshot slices; a pending source does not delay available accounting.

In 0.3 development source, `includeQuotaHistory` is a host projection clause,
defaulting to `true` and included in the canonical query identity. It is omitted
from accounting HTTP requests. Capacity widgets explicitly demand current quota
without history; the Reset-start picker explicitly retains history because it
needs the exact reset witness. Default, detail and Plans readers retain their
history demand. Mixed batches derive the history range only from queries that
request it. Current-only replies cannot settle a richer history demand or replace
its retained history with an empty result. The existing authorized quota reader
owns this acquisition choice; the server never removes encrypted/private fields
from a stored history document. This is not a loaded byte-reduction claim.

Best-available money resolves reported, API-priced, then estimated facts for each
contribution through the shared cost owner. Buckets, rankings and Work sum those
selected amounts in one currency and label mixed kinds; unknown money remains
unavailable rather than zero. Explicit cost modes do not fall back. Raw reported,
estimated, invoice and API-price facts remain separate in the facts band.

`usage.export` takes a query, JSON/CSV/text format and explicit accounting section
keys. The single [`usageExport.ts`](../packages/protocol/src/usage/usageExport.ts)
serializer returns strict file bytes and a selected-field manifest, preserving
unpriced monetary absence and the selected cost basis. The file's `asOfMs` is
the accounting source timestamp or `null` when unknown, never the export clock.
It performs no upload,
clipboard or filesystem effect; local Save, Copy and Share remain explicit client
operations. These contracts describe development source, not a loaded-client or
release certification.

The existing contribution catalog admits data-only [`inputTypes`](../packages/protocol/src/plugins/contributions/inputTypes.ts)
descriptors. A qualified type declares semantic identity and a normalized,
self-contained value schema, optionally referencing one declared options
Resource and an existing `ui.renderers` picker. `definePlugin` projects the
descriptor; `activate(api)` registers the referenced executable leaves through
their ordinary Resource/renderer rights. There is no input-type callback registry.

Actions, Workflow input adapters and widgets consume the neutral
[field owner](../packages/protocol/src/inputs/inputFields.ts) and
[options resolver](../packages/protocol/src/inputs/inputOptions.ts). A field has a
noun `title` and an optional localized `prompt` for its setup question. Widget
setup, group Inputs, saved-group Add and shared Action/Workflow fields show
`prompt ?? title`; summaries and value descriptions keep the noun title. The
prompt is presentation-only: it changes neither value admission, requiredness
nor authority. A typed consuming field can declare static choices that narrow
its type's schema; choices never admit values rejected by that schema. For new
own selections, static choices also intersect the type's declared Resource
choices when it has them; an unavailable Resource fails closed. Neutral fields can also declare an
explicit source whose resolved choices intersect both the type schema and its
declared Resource choices. Workflow input declarations retain their
existing domain exclusion between a type and an explicit source or enum, and
public plugin Action hints still do not admit arbitrary `optionsSourceId`.
The shared
[value admission](../packages/protocol/src/inputs/inputTypeRuntime.ts) intersects
the type schema with resolved choices for new own selections, picker results and
headless contributed Action submissions, failing closed when a declared dynamic
constraint is unresolved. Followed values use schema admission and the canonical
binder rather than a choice inventory. An empty multiselect selects no values
(Usage's All), so it also needs no choice inventory. Already stored own values remain readable
when dynamic choices are unavailable; available choices can still invalidate a
value they no longer include. Choices are compared with the submitted value
before host normalization, and disabled choices are refused.
Native Session and Workspace schemas confer no read authority
and unconstrained exact references add no discovery prerequisite. Discovery
admits the current consuming descriptor and grants before reading choices.
The picker uses the incumbent ephemeral renderer mount and
[`invokeInputTypePicker`](../packages/protocol/src/inputs/inputTypePicker.ts):
schema/options validation also applies to its result, cancellation causes no
mutation, and an answer from a replaced occurrence is refused. Removed types
leave saved values available for repair rather than silently rewriting them.
See the generated [SDK surface](../apps/docs/content/docs/plugins/api/surface.mdx)
and [host Actions](../apps/docs/content/docs/plugins/api/host-actions.mdx) for the
exact public projection; source declarations alone do not prove publication or
loaded all-consumer validation.

The [production picker provider](../apps/ui/sources/components/sessions/actions/InputTypePickerHostProvider.tsx)
now connects Action fields, Workflow inputs, widget setup and native plugin
Forms to admitted projected picker mounts. It captures the actual Account and
machine/Session context, invokes the same picker validator and opens the
incumbent ephemeral-input presenter on demand. Source wiring is present;
focused integration checks and loaded all-consumer validation remain separate
evidence, and this documentation does not claim a completed live journey.

### Coach evaluator authoring (0.3 development)

An external evaluator uses ordinary manifest-declared dynamic Resources and
Actions, registered in `activate(api)` with
`api.resources.registerDynamicResource(localId, { read, observe })` and
`api.actions.register(localId, handler)`. There is no separate public detector
registration family, and registering a Resource does not add a detector to the
built-in Coach. The maintained
[author example](../packages/plugin-sdk/examples/public-authoring/usageCoach.ts)
returns the public `UsageCoachFinding` type from `@happier-dev/plugin-sdk/actions`;
its detector ids and summary codes use the existing closed vocabulary.

Use only authorized witnessed facts. A finding identifies its `queryKey`,
`evidenceKey`, half-open `period`, observation `asOfMs`, `currentness` and
`coverage`; include evidence references and times, measurements, and a `basis`
with dated citations, limitations and advice. `current` requires a witnessed
observation time; stale or unknown evidence cannot expose Apply. A remedy and
its Action must occur together, identify the same detector/evidence key and
still pass ordinary Action admission. Leave both null for an informational
observation; a repeated read alone is not a measured saving. Resource reads and
Action handlers honor their invocation signal; changing producers invalidate
through `observe` and dispose their subscriptions on retirement. These source
contracts do not establish registry publication or loaded-client verification.

### Personal widget areas (0.3 development)

An `appPage` View declares named `widgetAreas` with a readable context schema.
Public plugin-ui `<WidgetSurface area="pinned" context={…} />` and declarative
`widgetArea` nodes reach the same [core area composition](../apps/ui/sources/components/widgets/area/WidgetArea.tsx)
through the mounted host port. The host derives captured Home/Account,
plugin/page/area identity, Artifact transport and access; author context is
validated data, never routing or authority. The Add surface
(`components/widgets/add/WidgetAddSurface.tsx`), Edit inputs, frames and
mutations reuse the Home/widget owners. Declarative area nodes
require a mounted plugin page and are excluded from Session Board documents
and transcript projection.

The page-local request's optional `layoutId` selects a document within that
declared area; the host continues to supply its Home, Account, plugin and page
identity. The carrier admits the existing `widgets.area.layout.*` operations,
so native and declarative areas share create, copy, rename, reorder, delete,
Reset and Undo with Project and core pages. Reset requires a host preset;
ordinary plugin declarations do not provide one, so Reset remains typed
unavailable for those layouts. `widgets.area.layout.select`
changes the answering mounted area's selection through its current selection
owner. Without that mounted owner it returns typed unavailable; reading a
document independently uses `widgets.item.list`. In unreleased 0.3, successful
selection returns `{ surface }`, acknowledging the applied selection even when
the best-effort document read fails or its scope retires afterwards. The mounted
area owns acquisition errors and Retry. Selection stays with the
page's existing route or local state, rather than an Account-wide preference.

Native/declarative page ScrollAreas and the Project ItemList pass the incumbent
near-viewport admission to area cards. In current 0.3 development, proximity
defers only bodies that have never approached the viewport. Once expanded near
the viewport, a body stays mounted with its content and Resource demand when
scrolled away and back. Usage uses the shared viewport margin. Route focus and
the containing page's presentation lifecycle still govern hidden-page demand.

The same private presentation host also binds a plugin surface's primary
vertical `ScrollArea` to the containing pane header's scroll-linked shade
(`paneHeaderScroll.useReporter`): the outermost vertical area reports its
distance from the top, nested and horizontal areas never do, and author
`onScroll` callbacks and viewport tracking are unchanged. It is presentation
only, absent outside a header-owning pane, and not part of the public SDK.
Installed plugin panes take the host's header band and edge unchanged.

Area copies use the shared pointer grip, staged keyboard and Move-to chooser.
Current membership and anchors become requests to `widgets.item.move`;
its incumbent surface ports own admission, approvals and persistence. Canonical
Artifact publication refreshes both mounted ends of a transfer. An injected
Project area binds preview and execution to its existing host movement owner;
that component seam neither grants authority nor supplies a Project Source.

Hosted HTML pages do not embed host widget areas: the plugin owns the whole
iframe. They manage widgets through ordinary `widgets.*` Actions, not a hosted
widget-area API, helper or renderer. Native and declarative page composition
remain the embedding surfaces. The [Project adapter](../apps/ui/sources/sync/domains/widgets/projectWidgetAreaContext.ts)
provides stable personal Project identity independently of its optional portable
Source input. A matching-Home exact checkout supplies checkout context; it does
not stand in for a Source or grant plugin access. Source-free layouts remain
usable. In 0.3 development, the existing Source controller reads the accepted
ref's provenance with the captured viewer's same-Home Account authority and
refreshes on the incumbent Home wake. Authorized current Source metadata fills
only the portable project slot; missing, revoked or retired reads leave that
slot unavailable without replacing the exact checkout or disabling personal
layouts. Provenance revision is not an eligibility gate. The Project shell owns desktop and phone
composition of the same acknowledged document.

### Find and Search presentation (0.3 development)

Trusted same-realm RN/RNW surfaces register their mounted Find controller with
`useFindSurfaceRegistration` from `@happier-dev/plugin-ui/hostApi`. The mount's
existing presentation binding forwards registration to the app's one
`findSurfaceRegistry`; keyboard commands and `ui.find` address that same model.
Use a plugin-qualified surface id. Hidden or retired mounts are unavailable,
including explicitly addressed Actions. Matching, reveal, cancellation and
coverage remain surface-owned; the hook does not create a matcher or index.
Unhosted and hosted-web surfaces have no registration binding and the hook
returns false.

In 0.3 development source, `FindController.refold` optionally refolds context
temporarily revealed for the current match. `ui.find` with `op: 'refold'` and
the review's **Fold again** button use the same mounted renderer operation,
preserving the query, match decorations and folding preferences. A surface
without folding returns `unavailable` with `reason: 'unsupportedOperation'`;
an available folding surface with no revealed region returns
`reason: 'noRevealedFold'`.

`HappierFindBar`, `matchFindText`, `HappierFindHighlightedText` and
`sliceFindRanges` are shared `/presentation` exports. Core's highlighted-text
adapter supplies theme marks and its text renderer to the same UTF-16 range
renderer. Conversation rows and machine-coverage copy remain host domain
composition, not public layout APIs. Universal Search sources use the existing
manifest `searchProviders` Action contribution and SDK search-result schema;
Find registration is not a new search contribution family.

Portable and daemon search-provider descriptors share the same Protocol
presentation projector. In unreleased 0.3 source, Account Availability projects
providers whose query Action has Account execution, binding them to that
Action's selected Account custody. The app union and Universal Search consume
that origin without requiring a Machine description. Machine-owned providers
retain their runtime origin. A client execution target alone does not declare
that its reads are Account-owned or admit Account execution authority.
Account queries launched by semantic controls bind the existing scoped Home
Action executor to their captured Account, so nested host reads retain ordinary
plugin caller policy and Account automation authority.

In 0.3 development source, `HappierFindBar` can omit `host` inside a mounted
RN/RNW surface to use the existing native text, input, glyph and spinner
adapters. Explicit host adapters remain supported. Registration alone does not
draw a search field: the consuming surface renders this shared bar when its
controller opens and binds its query, options, navigation and close callbacks.

In 0.3 development source, a search result may carry an optional closed
`failure: { code }` alongside `items` and `truncated`. The canonical search
schema owns the cause vocabulary. A `root_not_found` result uses the same
folder-level failure line as workspace search; unrelated and untyped failures
retain their own group line and Retry. Plugins report acquisition facts, not
host copy or a workspace inferred from the selected Session. Triage's search
reads its Account-scoped shared window and preserves known acquisition causes.

`HappierTextLinkButton` owns the shared inline note-and-action presentation used
by Find notes and core's `TextLinkButton` adapter. Hosts bind their text renderer,
theme ink and pointer target floor through the public presentation props. A note
and its action share one wrapping text run. The action is a `HappierPressable`:
it draws exactly its line height and reaches a finger's target through the shared
invisible hit frame (see below), never through physical padding or compensating
margins, and never sideways over the neighbouring words. `verticalReach` bounds the
free space above and below the line (the container's padding, or half the gap to a
neighbour); omitted, it reaches the whole target. Find passes it so a note's link
stops at the bar's padding and the adjacent field. The keyboard focus ring stays on
the action's ink rather than its hit frame.

Touch targets are hit areas, not drawn sizes (0.3 development source).
`HappierPressable` never grows a control's drawn box or layout to reach a touch
target. Under a finger — iOS (44), Android (48), or a web or desktop browser
whose primary pointer is coarse (44) — its hit area reaches the target past the
drawn box: native `hitSlop` on iOS/Android, and on the web, whose `Pressable`
ignores `hitSlop`, an invisible absolutely positioned `[data-happier-hit-area]`
frame inside the control. A precise pointer keeps the caller's own `hitSlop`.
`hitTarget` asks for a larger hit area; `hitReach` bounds how far it may reach
on each side (half the gap to a neighbour, or the free space to a clipping
edge; `0` keeps it on the drawn box), so adjacent hit areas split their gap
instead of overlapping. The policy is `resolveHappierHitInsets` and
`useHappierTouchTargetSize` in `./environment`. Plugin authors use the governed
`HappierPressable` export from the package root or `/components`, with
`hitTarget` and `hitReach`. The raw-control `useHappierHitArea` hook in
`/presentation` is host-only; plugin UI artifacts cannot import that entrypoint.
`Button`, `IconButton`, menu triggers, tabs, links, composer chips
(`HappierComposerChip` takes `hitReach`), share actions and the native switch
use this policy; menu rows and tabs stay on their drawn rows inside their clipping
surfaces. `useHappierNativeMinimumInteractiveTargetSize` remains exported for
plugins that read the platform floor, but no shared control draws at it.

In 0.3 development source, `useHappierTouchPrimaryPointer(platform)` owns the
reactive primary-pointer fact. Its shared media listeners attach with the first
subscriber and detach with the last; pointer changes update mounted hit areas,
density and reveal policies without polling. Fine pointing or hover wins over
coarse pointing or no hover; touch points are the fallback when media queries
give no answer. Native iOS and Android remain touch platforms. The synchronous
`isHappierTouchPrimaryPointer` and `isHappierCoarsePrimaryPointer` exports remain
current reads for non-render code, rather than module-lifetime snapshots.

Rows, form fields and data marks follow the same rule. A list, page, tree,
collection work row or interval row draws at its density's height under every
pointer: a full-width row is its own hit area and rows stack flush, so the row
never grows to a finger's size or reaches over its neighbour.
`resolveHappierPageRowMetrics` no longer applies a touch floor (its `touch`
input is accepted and ignored), and `List.Item`'s `minimumTouchTarget` is the
host's row height, not a hit area. Field wells, single-line inputs (which fill
the drawn field box), stepper buttons, select options, compact choice tiles,
Find bar buttons and condition-editor controls keep their drawn sizes; their
hit areas reach into the gaps around them (`HappierSearchFieldBox` and
`HappierTreeDisclosure` take `hitReach`; `minimumTargetSize`,
`minimumTouchTarget` and `touchTargetPx` ask for a hit area, not a drawn
size). Heatmap and dot-grid cells keep their drawn slot and stride, interval
tracks keep the dense bar, and scatter points draw a small ring, each reaching
only half the gap to its neighbours; focus, arrow keys, the readout and the
values list remain the exact-value alternative.

### Cursor native conversation stores (0.3 development)

This section covers the Cursor plugin's External Sessions reader. Cursor's on-disk formats are undocumented and change between versions. The facts below come from Cursor CLI `2026.11.05-86047df`, captured on 2026-11-11.

Cursor has two conversation stores, and the plugin labels each row with its source (`linkData.cursorSource`):

- **CLI (`cli`), built.**
  - Location: each chat has its own SQLite `store.db`. Interactive chats live under `~/.cursor/chats/<md5 of workspace path>/<chatId>/` and ACP sessions under `~/.cursor/acp-sessions/<sessionId>/`.
  - `meta` table: key `0` holds hex-encoded JSON with `agentId`, `name` (the title), `createdAt`, `latestRootBlobId` and `subagentInfo`. A store with `subagentInfo` is a subagent of `rootParentAgentId`, so it is not listed as its own row.
  - `blobs` table: content-addressed by SHA-256. The root blob is a protobuf whose repeated field 1 lists the message blob ids in order. Each message blob is AI-SDK-style JSON `{role, content}`.
  - Rows produced: user and assistant text become transcript rows, and tool calls and results become events. System prompts and reasoning are skipped.
  - An unrecognised store still appears as a row. Opening it fails with the shared `format_unsupported` failure and token `cursor_cli_store_format_unsupported`; the host answers `agent_format_unsupported`.
  - Stores are opened read-only through `@happier-dev/plugin-sdk/fs` `openSqliteDatabaseSync`, never `immutable`, because uncheckpointed commits live in `store.db-wal`. Like any SQLite reader, it takes WAL read marks and creates empty `-wal`/`-shm` files when they are absent. Bun's SQLite also rejects URI filenames.
  - Follow watches `store.db` and `store.db-wal`. readAfter settles unchanged stores from file identity alone; a changed message-id prefix reports `source_replaced`.
  - Content search does not yet cover these stores (`contentCoverage: partial`).
  - The CLI has no machine-readable listing or export. `agent ls` is a TTY-only interface. One run without a TTY created a `meta.json` in all 24 chat directories of a workspace.
- **App (`app`), built as its own source `cursorApp`.** Its facts come from Cursor app 3.27.22 on macOS, captured on 2026-11-11 as structure only. The format is undocumented and version-sensitive.
  - **Location:** one global SQLite `User/globalStorage/state.vscdb` under Electron's `appData`. That is `~/Library/Application Support/Cursor` on macOS, `$XDG_CONFIG_HOME/Cursor` (default `~/.config/Cursor`) on Linux, and `%APPDATA%\Cursor` on Windows. The source's optional `dataDir` overrides it.
  - **Size:** the file can be several GB; the captured one was 5.9 GB. Every read is a point lookup or key-range read on the unique key index of `cursorDiskKV`, so the reader never scans the table and never reads the whole file.
  - **Listing:** the `composerHeaders` table (`composerId` PK, `createdAt`, `recency`, `isSubagent`, `isArchived`, `value` JSON) is the conversation index.
    - The title is `value.name`. `updatedAtMs` is `recency`; `lastUpdatedAt` is mostly null.
    - cwd is `value.workspaceIdentifier.uri.fsPath`. A multi-root (`configPath`) workspace has no single cwd, so cwd is omitted.
    - A subagent row (`isSubagent`, `value.subagentInfo.parentComposerId`) is a `subagent` thread, listed only with `includeThreads`.
    - A conversation whose `composerData:<id>` has no visible messages is not a row. Its message count is cached in the host's `candidateIndexState`, keyed by a fingerprint of the header row, so unchanged rows never re-read their conversation.
  - **Transcript:** `composerData:<id>`'s `fullConversationHeadersOnly` orders the visible messages. Each message is the `bubbleId:<id>:<bubbleId>` JSON row; type 1 is user and type 2 is assistant.
    - Only the needed fields are extracted with `json_extract`, then mapped to the AI-SDK message shape and decoded by the same decoder as the CLI store.
    - Thinking-only, empty and app-simulated bubbles are skipped.
    - Bubble rows that are not in the header list are not part of the visible chat.
    - `composerData.conversationState` (protobuf, with refs into `agentKv:blob:<sha256>`) is the compacted model context, not the chat, so it is not read.
  - **Follow:** Follow watches `state.vscdb` and its `-wal`. readAfter settles from file identity alone when nothing was written.
    - Otherwise it re-reads one `composerData` row and returns only the new bubbles.
    - A bubble listed in `generatingBubbleIds`, and everything after it, waits until the app finishes writing it.
    - A changed bubble-id prefix (edit or revert) reports `source_replaced`. A write elsewhere in the app reports `already_current`.
  - **Unrecognised store:** a store without `composerHeaders` or `cursorDiskKV`, or with unreadable conversation JSON, fails with `format_unsupported` and token `cursor_app_store_format_unsupported` instead of an empty list. A missing `state.vscdb` (no Cursor app) lists nothing.
  - **No content search:** content search does not cover the app store.
  - **No resume:** an app conversation id is not a Cursor CLI/ACP session id, so the CLI cannot resume it.
    - Cursor declares no takeover contribution and `writerSafety: 'unsupported'`, so the footer never offers a resume or takeover.
    - Continuing it means a new session seeded by the existing replay owner: Import (materialize, which reads this source's `pageTranscript`/`readAfterTranscript`), then a Replay fork.
    - The footer's one-step "Continue in a new session" does both. It is generic, not Cursor-specific: `resolveSessionViewExternalControlFooter` offers it when the status is known, the outside Agent is not running and neither `canTakeOverDirect` nor `canTakeOverPersist` holds, and only while `sessionReplayEnabled` is on. `useExternalSessionContinueInNewSession` calls the existing materialize owner when the transcript is machine-only, waits for the published snapshot, then opens the fork strategy modal with `autoSubmitRoute: 'replay'`, which stays the one progress/approval/failure surface.

### External Session JSONL read progress (0.3 development)

The shared SDK file-store scanners preserve source byte boundaries. When the
existing read allowance cannot complete the next record and no source has been
consumed, they fail with a nonretryable `PluginError` whose code is
`JSONL_RECORD_TOO_LARGE`. Raw byte-cursor reads use the same progress check.
Transcript adapters preserve this failure through their existing operation result;
they must not return an unchanged continuation or report `already_current`.
A caller with a larger supported allowance can read the record intact. The
scanners do not skip or truncate it, and incomplete parsed EOF records remain
pending for the writer to finish.

Accounting frontiers advance only past applied records. A projector exception
returns `read_failed` without publishing a new cursor, so retrying the previous
cursor can apply that record. Malformed or unsupported content retains explicit
incomplete coverage. Backward history treats only a missing file (`ENOENT`) as
empty; other filesystem failures propagate as read errors.

Advisory Codex title and Claude working-directory scans may stop at this boundary,
with a default stderr warning, retaining metadata already read. Claude's indexed
title reader still fails instead of marking unread source as verified.

### Imported Session images (0.3 development)

External Session source records may carry transient `raw.media` standard ACP
image blocks (`type`, `mimeType`, base64 `data`). The closed source envelope
grants no path or network authority. Native file layouts and artifact-handle
validation belong to the Agent's reader. Missing or unsupported images retain
an explicit unavailable placeholder and partial source coverage.

The host consumes these blocks through the existing Session media extractor,
private historical staging and media adoption before durable transcript writes.
Only the incumbent `session_media.v1` references or failures reach persistence;
there is no separate import media store. Image-only user rows retain their role.
ACP history capture similarly retains standard image/resource content for the
same media owner instead of allowing replay suppression to discard it. Replayed
file references still need the media bridge's scoped read authority; HTTP image
ingestion remains unavailable.

This is an unpublished author-contract extension requiring the matching host,
not an ignorable field for older strict development readers. Persisted Session
media shapes and supported older transcript readers are unchanged.

### External Session content search (0.3 development)

External Session source declarations opt into transcript search with
`contentSearch: true`. Consumers require that positive declaration before sending
`searchTarget: 'content'` to `sessions.external.candidates.list`; omission keeps
the existing metadata-search behavior. This matters with the 0.2 predecessor,
whose candidate-list reader can ignore an unknown search selector. The host
also refuses unsupported content scans rather than presenting metadata matches
as transcript results.

Content producers return decoded-text matches as `{ snippet, sourceItemId,
messageIndex }` and page-level `contentCoverage` (`complete`, `partial` or
`unsupported`). `messageIndex` is a zero-based presentation ordinal, not a
Session sequence number. Protocol owns strict admission of the match shape;
the host publishes these query-local facts without writing transcript text or
match snippets into the candidate metadata index.

The daemon-realm SDK entry point `@happier-dev/plugin-sdk/sessions/file-stores`
exports `createExternalSessionContentSearchControl`,
`searchExternalSessionContent`, `prefilterExternalSessionContentPaths`, and
`ExternalSessionContentSearchYield`.
File sources provide their existing decoder and source-scoped paths plus
invocation `ripgrep`; the helper prefilters safe queries, then uses Protocol's
decoded-text `contentSearchMatch` as the match/snippet authority. Unicode,
escaped and NUL text retain decoded fallback. Client-backed sources can omit
paths and ripgrep, as OpenCode does. Kilo's characterized CLI 1.0.25 JSON
reader also supplies decoded records without a prefilter, joining its native
ordered parts. Claude, Codex, Pi, OhMyPi and Antigravity use the file path;
these bundled sources and Kilo declare positive content search.
The prefilter recognizes literal and mixed JSON-escaped spellings of an ASCII
query, including JavaScript's ASCII-producing Unicode folds. Unicode fallback
uses only escape codes from the query's case-folded alphabet, so unrelated
escape codes alone do not require decoding a file. Claude batches physically
admitted, unvisited top-level native files using the caller's result-page size.
It prefilters the next batch on demand, so completed files and later history do
not delay every page. An unfinished transcript resumes decoding from its saved
position without repeating the prefilter. Nested sidechains remain excluded by
the native candidate enumerator.
Non-ASCII/process-unsafe queries and truncated prefilter output exclude no files.
Native decoders still reauthorize and re-match every published hit.
Decoders still own branch/rollback selection and native item identity. The
control inherits caller cancellation and the cooperative scan deadline and yields;
plugins publish partial coverage with a continuation for unfinished work.
The control's `prepare` operation schedules native steps after their results and
resume positions have been retained. Source admission or metadata discovery can
consume the scan budget before decoding starts; a resumed native page still
commits its first indivisible unit before yielding. Cancellation remains hard
before and after that unit. The native owner supplies and validates its cursor
state; the helper adds no process-wide scan registry or separate time budget.
The control yields at the caller's actual scan deadline rather than predicting
the duration of another native step. Prefilter admission normalizes each file's
candidate offsets once into unique ascending row positions; resumed sparse
scanner pages traverse those positions directly. Codex retains query-local
native enumeration/metadata progress in its opaque continuations;
selected references are reauthorized against native storage, never treated as
authority for file paths or transcript text. The existing serialized-result byte
budget also applies to this progress and fails explicitly if it cannot fit.
The decoder can report source-bound EOF through `isScanComplete`; the shared
helper then assembles verified matches under cancellation without reopening the
cooperative scan budget. A previously yielded decoder still yields. Forward and
backward JSONL diagnostic callbacks preserve incomplete-source evidence before
a consumed row yields.
The canonical forward JSONL scanner can hand each parsed line to a decoder
without retaining source bodies. Codex consumes that path and shares root-family
discovery across its requested candidate page; complete native rollback selection
still precedes publication of a match.

File-backed content continuations retain source-bound native progress. Codex
keeps its stream frontiers, rollback selection and semantic correlation; Pi and
OhMyPi keep their existing branch-page cursors; Antigravity keeps its byte frontier
and tool correlation. Pi and OhMyPi use the shared helper's `pageProgress` to
accumulate older pages and compute the earliest match's full transcript ordinal.
The helper retains the matching page/item locator and re-decodes that page before
returning its snippet. Native source verification and hard invocation cancellation
remain at each codec. Interrupted or unreadable source ranges stay partial.

Pi candidate continuations carry generation-checked directory offsets and native
branch progress. Each invocation closes its directory handles on settlement,
including cancellation and failure. Abandoned queries retain no plugin scan state;
starting another query cannot evict an existing continuation. Resuming replays
directory entries to the cursor position and decodes candidate text from storage.

Claude uses the existing backward JSONL scanner to retain in-transcript progress
across equally budgeted candidate pages. Its continuation binds row locations and
branch-selection progress to the observed file identity; returned text is decoded
from the source, not trusted from the cursor. A native row is decoded and its progress
retained before a cooperative yield, so a row can cross the scan deadline; native
reads and finalization still observe cancellation. Content pages relist metadata
and retain a compact recent-first frontier rather than an inventory or ordering
suffix. The [search owner contract](search.md) defines the main and final
changed-file passes. Other transcripts' appends cannot reset that frontier;
changing the unfinished transcript's source identity still invalidates its
continuation through the existing `cursorReset` result.

Opt-in native indexing is a separate consumer of the same External Sessions
contribution's existing `pageTranscript` / `readAfterTranscript` readers, not
a new contribution family or a content-search index owned by the plugin.
The host Memory worker reads normalized transcript records and shares the
existing accounting/file-change observation resource. Source declarations
advertise standard search with `contentSearch`; readable transcript facets
supply indexing when selected in daemon-local Search settings. A declaration
alone creates neither an index nor user consent. Per-source readiness is a
worker projection, and native windows resolve through `pageTranscript`.

In 0.3 development, observation reconciliation and transcript reads may receive the host's optional
`observation: { lifetime, changedFiles? }` read hint. The lifetime ends with the
physical observation demand, separately from each invocation's cancellation.
An omitted file list requires full native freshness checks; an empty list means
the host's attached directory observation has reported no changes. Plugins may
ignore the hint and perform those checks. It grants no path or Session authority.
Codex retains directory, filename and stripped metadata facts only for that demand,
invalidates named writes and structural changes, and releases them on retirement.
Transcript refreshes reuse that same demanded inventory instead of reopening
unrelated rollout heads. Without a dirty-file hint they still revalidate native
file versions. Memory ingestion receives the same physical observation lifetime
from its accounting demand; retiring the demand releases its facts. Calls without
observation demand use fresh discovery. A root-family inventory reads rollout heads
only from the root's start through the family's latest write, widened by the
filename time-zone window: Codex creates a subagent rollout while an earlier family
member is still being written, and resume appends to the thread's existing rollout.
Rollouts named for the root and `<thread>_<rollout>` revert rollouts are always read,
and each member found widens the window. Dated `sessions/YYYY/MM/DD` directories that end
before that window are not listed. A resumable preparation scan and non-UUIDv7 ids
still read every head.
Source-wide file consumers share the existing directory attachments for content
delivery; exact-file observation remains for paths outside those admitted trees.

[Search](search.md#memory-index-and-native-ingestion-03-development) owns the
index, settings, privacy and cross-machine coordination contracts.

The optional `hydrateCandidates` operation enriches only an already-selected
Browse page, including a partial preparation page. The host supplies the admitted
source, selected candidates and the existing invocation controls. Count, order,
identity, timestamps, thread classification and link/index data remain unchanged;
only `title`, `cwd` and `messageCount` may change. The bounded owner validates both
sides and advertises the facet positively. Providers without it retain existing
listing and selected-row hydration. Enrichment is a response projection, never an
index writer; existing titled indexes still pass through it on each selected page.

The External Sessions surface inherits caller cancellation and any caller deadline;
the host does not add a shorter auxiliary-operation cutoff. Serialized-result
budgets are optional for source and identity resolution, and required for paged
candidate/transcript reads. Explicit caller paging budgets are preserved rather
than clipped to a second host ceiling. Wire and persisted-data schemas still own
their declared limits.

In 0.3 development, bounded transcript refresh, import and takeover capture
their Account partition and exact source at admission. Selecting another Account
or withdrawing permission does not re-admit or cancel that work between phases.
The next request admits afresh. Explicit Stop remains effective, and an ongoing
follow stream closes when its source authority retires. Cursor, link and source
custody checks preserve attribution; they do not renew permission for an admitted
bounded read.
Captured credentials remain in process, separate from the existing Account scope;
they bind both Home publication and the private record, acknowledgement and
compaction partition. Passive repair captures the current Account once per repair
request. Credentials are not persisted in that scope or sent over the operation
wire, and the next independent repair admits the then-current Account.

Manual background-follow changes persist the deliberate preference first. The
existing passive observation owner then reconciles that exact Session, including
when automatic restoration after daemon restart is disabled. It owns native
acquisition and release; the Action does not acquire a second resource or roll
one back on a failed preference write. Viewer expiry still releases demand whose
old Account can no longer send its detach request.

The daemon owns the viewer lease TTL. The UI renews halfway through the remaining
`expiresAtMs` lifetime and retries a failed renewal halfway through that remaining
lifetime, stopping at expiry. It adds no requested TTL, fixed renewal lead or
periodic retry delay. An initial attach failure has no producer expiry to renew;
foreground, remount and accepted-cursor changes remain its existing demand wakes.
Typed `retryable: false` ends automatic renewal recovery, including the released
daemon refusal whose retired raw follow data plane cannot serve this viewer.

Durable import and takeover outcomes compact only after their existing progress
acknowledgement and private-resource cleanup settle. Compact receipts retain exact
idempotent replay without an age-based expiry or an Account inventory ceiling;
elapsed time does not authorize the same key to execute again. Shared Stop names
the exact Account, Session and operation. The cancellation owner decides against
the current locked record, so an intervening progress revision does not require
the caller to retry Stop. Other revision-bound updates retain their CAS checks.

The existing `pageTranscript` request optionally carries a selected
`sourceItemId` for an exchange preview. This is an opaque presentation selector,
not source authority; contributions may safely ignore it and use their ordinary
reader. A reader serving only locally available history must mark the page
truncated and omit an authoritative tail. Full-history and follow consumers do
not set this selector.

In 0.3 development, qualified transcript continuation cursors count toward that
same reply budget. When qualification alone makes a valid native transcript page
too large, the host repeats the stateless `pageTranscript` or
`readAfterTranscript` read at the same cursor with the producer allowance reduced
by the measured qualification overhead, retaining the caller's cancellation and
deadline. A producer that exceeds its own allowance still fails admission.

Historical terminal follow retains the complete native correlation baseline and
requested display history without a separate aggregate replay ceiling or display
eviction. All replay pages follow the caller's admission lifetime with per-page transport budgets and
cursor-progress checks, without a total-page or total-item cutoff. Backward JSONL
continuations always end at complete row boundaries: a row beyond the existing
scanner allowance yields explicit incompleteness rather than a cursor inside UTF-8
text or a claim that history is complete.

Native transcript readers tolerate Agent CLI record evolution in 0.3 development
source. An unknown or malformed native record becomes the shared SDK file-store
projection's fixed unsupported-content message, using the existing canonical
transcript row shape. It preserves source ordering and item identity for paging
without disclosing the native payload. The page stays readable and reports the
unsupported record through the daemon's safe diagnostic channel. Explicitly known
non-transcript bookkeeping still produces no row. Replacement, changed anchors
and unread source boundaries remain discontinuities; a parser mismatch alone
must not discard surrounding history. See [linked transcript paging](search.md).

For 0.3 content-candidate pages, optional `budgetMs` is charged from RPC receipt
through source preparation and scanning. The host forwards it as
`scanDeadlineAtMs`, separate from the invocation's hard `deadlineAtMs` and abort
signal. Scan exhaustion yields partial coverage; it does not retire the invocation
before decoding and terminal delivery finish. The client uses the existing
operation-owned terminal wait and explicit cancellation, as filename search does.
Other RPCs retain their full receipt-anchored hard lifetime; no global transport
margin is deducted from valid work.

Link/import annotation enriches an already-found candidate page. If cancellation
interrupts its Account reads, the annotation owner stops further reads and retains
the candidates, any verified positive annotations, and the native continuation;
`annotationsIncomplete: true` prevents treating absent annotations as negative facts.
Other annotation failures still propagate. Explicit client cancellation still stops
the caller's wait and does not publish a cancelled result into the UI.

External Sessions contributions can also declare optional `readAccounting` in
0.3 development. This source-wide auxiliary read uses the same occurrence,
cancellation and execution-service admission as transcript reads; older facets
return `unsupported`. Strict Protocol admission accepts normalized numeric usage,
explicit counter-inclusivity evidence and a source-owned frontier, never transcript
content. Optional exact native project-directory evidence remains machine-local;
the host resolves it to opaque project identity and Account-mode labels before
publication, and never includes that path in usage ingest. Only an `advanced` result
acknowledges a new cursor; replacement and expired-cursor outcomes do not.
`resolveSource.accountingSource` supplies canonical root and change-observation
metadata without reading transcript records. Its optional `discoveredFileCount`
reports files already enumerated by metadata discovery. Watch targets alone do
not establish a count, and file counts do not establish distinct Sessions or
tokens. Claude, Codex and Pi supply this fact from their existing JSONL inventory;
other sources omit it when unavailable. The host projects it through
`usage.sources.discover` without persisting it in capture custody or retaining a
second cache. Later source reads may omit the count when no discovery was run.
Token counts require consented accounting, so pre-consent UI cannot estimate them.
Consented machine/source accounting
demand shares the incumbent resource reconciler with real Session links and can
retain its watches without creating a Session identity.
For a host-materialized native home, the host retains the state links it actually
created with that Session's private custody and accepted-spawn marker. The one
observation path validator admits those physical roots only for the matching
Agent, plugin source and native home, while the current link still points to the
captured source. Declarations and arbitrary symlinks do not grant additional
roots. Missing, retired or mismatched custody remains refused. This applies to
bundled and installed Agent plugins through the same materializer; it adds no
plugin DTO, Session metadata or public filesystem grant.
The optional `changedNativeSessionIds` read input carries complete correlated
invalidations from that shared observer through the collector. Absent evidence
requests coarse reconciliation; an empty list with a retained cursor has no new
message work. Readers may ignore this optimization safely. OpenCode rereads only
the named Sessions after initial capture, including late message settlement with
an unchanged Session timestamp. Connection boundaries and uncertain reads still
reconcile the source. Observation refresh callbacks can carry native Session
evidence without making a linked Happier Session a prerequisite for capture.

SDK inventory paging retains one snapshot per live query demand. `list` returns
an opaque, serializable, single-use `nextCursor`; every successor belongs to
the same demand. `closeList(cursor)` releases that demand using any cursor it
issued, including a consumed cursor, and cancels a pending continuation.
Consumers close abandoned queries in their cleanup path. Exhaustion, caller
cancellation and source retirement also release retained pages. Opening another
query does not evict a live continuation. The runner uses the same owner through
its serializable daemon service operation; no callable continuation crosses RPC.
This is an approved unreleased 0.3 SDK source-contract cut. Authors must update
and rebuild list consumers to close pagination they stop before exhaustion.

Configured-source admission isolates malformed source data and malformed
connected-profile identifiers as typed source refusals. Valid sources, including
other sources for the same Agent, remain available; the owning plugin receives a
non-blocking `plugin_external_session_source_refused` diagnostic. Host-integrity
failures such as an unreadable Account, undeclared source kinds or duplicate
Agent-scoped source identities still make the whole configured-source service
unavailable. This is current 0.3 development-source behavior, not loaded-runtime
or released availability evidence.

This required-to-optional invocation-bound change is an unreleased 0.3 SDK
source-contract cut. External Session authors must update and rebuild callbacks
that assumed every request carried a deadline or serialized-result budget;
no synthetic deadline or byte ceiling is supplied for those older assumptions.

The public External Sessions invocation supplies required
`ripgrep.run({ args, paths, signal? })`. The generation-bound host wrapper delegates
to the packaged ripgrep integration, combines cancellation with the invocation,
and uses that operation's existing byte budget. Plugins supply their source-owned
file set and decode native records; they do not resolve `rg` on PATH or import
the host integration. Empty paths do not scan the host working directory. This
is a development-source SDK contract, not a claim of released plugin or loaded
runtime availability. See the [SDK evolution contract](compatibility.md#sdk-protocol-evolution).

The development External Sessions invocation also offers optional `logger.debug`
through the host file logger. Readers can attribute failures with exception
class, identifier-shaped error code or errno, reader phase, stable source item
identity, basename and byte offset. Transcript text, absolute paths, exception
messages and stacks must stay out of these diagnostics. An absent logger does
not change read results or failure semantics.

### Voice schema composition (0.3 development)

Conversation provider declarations remain discoverable before their executable modules load. Saved selection stays descriptor-only; Start admits executable demand and retains the attempt's provider through preparation, cancellation and recovery; a deliberate provider change during a stoppable attempt also demands its handoff target. Generated first-party Voice entries import only a demanded provider; its import settles before the existing synchronous public `activate(api)` registration transaction. The lifecycle owner remains mounted after its first activation to handle media cleanup and Account retirement. Speech model catalogs acquire only for presented setup/settings/read-aloud controls or an active speech operation, through the shared catalog owner. This describes 0.3 development source; live web, Hermes and desktop replay remains separate validation.

Realtime Voice runtimes may implement optional `playHostText({text, signal})`
from `@happier-dev/plugin-sdk/voice/client`. This plays the host's exact prepared
Action summary; it must return `completed` only for that utterance's natural
playback completion, `cancelled` for interruption/clear/End, or typed
`host_text_playback_unavailable` when it cannot establish completion. Model speech,
transcript equality and generation completion alone are insufficient. The host
uses the existing spoken Action binding and confirmed front door; an absent or
unavailable capability retains ordinary Ask. PCM `captureOutputPlayback()` is
captured before requesting the utterance; its `waitForDrain(signal)` reports
`cancelled` if output was cleared, stopped or suspended during that interval,
even before the drain wait began. A legacy host without this capture, or a void
drain result, supplies no confirmation proof. These
are unreleased 0.3 source contracts and need native playback validation.

Voice schema exports at `@happier-dev/plugin-sdk/voice` and its client entry
are native `zod/mini` schemas with the exact runtime identity of their Protocol
owners. `VoiceSchema<T>` names the native Mini schema type. Compose them with
functional Mini APIs such as `z.optional(schema)` and `z.array(schema)`.
The existing record and field-composition helpers also return native Mini schemas;
field composition retains absent fields and forwards canonical issue paths.
This is an unreleased 0.3 author-contract cut: update and rebuild Voice consumers
that used fluent methods or depended on Zod-free declarations. No compatibility
wrapper or second validator is supplied.

MCP SDK DTO objects remain supplier-owned. The CLI composes native Mini host
containers around their existing child validators, preserving the supplier
field policies and validation issues. Supplier-owned Classic child schemas do
not require a first-party Classic container or namespace import.

### Standalone Voice attempt policy (0.3 development)

Realtime `provider_error` events keep their closed host category and may carry
an optional content-free `providerCode` for diagnostics. Provider messages and
payloads never cross this field. `terminal` ends the current Happier attempt
through its existing lifecycle and recovery policy; it does not assert that the
provider closed its socket. Grok request errors use this path so a rejected
answer stops capture, preserves the admitted transcript and offers Retry instead
of continuing to show Connected. The controller keeps the provider code as
diagnostic metadata; the closed category still owns recovery policy and the
displayed failure reason. This is an additive same-realm 0.3 development contract: earlier
events without the optional code still use their category, and matching SDK,
plugin and host source load together. It adds no persisted or wire format.
The generic failure status is the translated **Error** label. Only explicit connection-failure
reasons supply **Couldn't connect** through the shared attempt presenter;
an established conversation's rejected answer does not claim connection failed.
The retained reason selects the existing machine-error copy, including a provider
turn error or the Machine's required Happier reload, without exposing raw provider messages.
Protocol's `normalizeVoiceFailureCode`, projected through SDK `/voice/client`,
owns the existing code-shaped diagnostic boundary shared by provider events,
host failure logging and mediated credential causes; unsupported strings retain
their caller's generic fallback without exposing provider prose.

Voice contribution declarations may carry an optional `mark`, projected identically
for installed and bundled providers. `VoiceServiceMarkSchema` and `VoiceServiceMark`
are public at `@happier-dev/plugin-sdk/voice`: `connected_service` names a known
Connected Service, `agent` names an Agent identity, and `icon` names a public Plugin
UI icon token (including `waveform`). These are decorative identity facts, never
credential, execution or Agent access. The service gallery and pipeline use one
renderer; first-party UI metadata has no separate mark privilege. OpenAI, xAI,
ElevenLabs and Codex declare their marks in the same public manifests.

Conversation declarations may also carry an optional localized `description`
(a string or `{ key, fallback }`) through the public `/voice` author types and
schema. The declaration-driven registry preserves it for the Service gallery,
independently of billing-option subtitles. Missing descriptions remain valid
and retain the existing option-subtitle presentation; the host never substitutes
a plugin identifier. This is an additive 0.3 development presentation field; executable
declarations and localized text objects remain closed to unknown fields.

Plugin UI's public `VoiceMarkArt` and labelled generic `StatusCell` are thin
requests through the incumbent same-realm presentation host. The mark supplies
explicit pose/size/theme/light/still facts, never attempt or energy inputs;
the private adapter selects presentation-only rendering on the one Brand
owner. `still` defaults true; false admits event-only pose transitions, not
ambient or microphone-driven motion. Status cells retain the host's motion,
reduced-motion and presentation rules. `SetupBlockTile` and `SetupBlockGrid`
delegate to the existing setup owners. `HappierSetupSteps` is the one ordered
composition over `HappierStep`, consumed by both the app and author `SetupSteps`:
setup states (done/current/upcoming) and reported progress
(running/waiting/failed/cancelled) in a numbered rail, a glyph checklist or
compact lines. The app's former private progress checklist is deleted; system
tasks, imports, plugin transcript activity, machine setup and creation progress
all render it. `HappierLocalDateTimeField` is the one typed-or-picked local
date and time; the host supplies its platform picker through the presentation
host's `localDateTimePicker` (absent, the field is typed alone), and the app's
`LocalDateTimeEditor` only binds its theme and that picker.
Author `SelectionTiles` forwards the shared owner's useful geometry controls,
bare mark, badge, test identity and footer; the app no longer synthesizes mark
glyph tokens. Optional host bindings have explicit author fallbacks; they do
not add a wire capability or another renderer.

In 0.3 development source, same-realm plugin surfaces can call
`useHostTaskShareSheet()` from `@happier-dev/plugin-ui/hostApi`. It returns
`null` when the host lacks the optional presentation binding; authors hide the
Share entry then. Otherwise `open({ taskRef, title, anchor })` opens the existing
task ShareSheet through `showTaskShareSheet`/`presentShareSheet`. `taskRef` carries
`{ taskId, ownerAccountId, scope: { serverId, accountId } }`, where scope identifies
the viewer's Home and Account. `anchor` is the menu trigger's `anchorRef` (optional).
The host retains task reads, grants, and responsive sheet placement. This adds
no wire method, registry, plugin-id exception, or second share UI.

In 0.3 development source, public `SelectionTiles` also exposes operation tiles
through `variant: 'action'` and `onPress`. `HappierSelectionTiles` owns their
measured narrow-page recomposition into one contained sheet of rows; the app
and plugin adapters supply their presentation context and theme. Standalone
groups and footer-bearing actions retain cards. Public `CountedDisclosureItem`
binds the shared `HappierCountedDisclosure` fold state and count/summary header;
the app wrapper binds its existing `ExpandableItem` disclosure/reveal frame.
No second motion or lazy-body owner is introduced. Public `TechnicalDetailsDisclosure`
binds `HappierTechnicalDetailsDisclosure` (label-over-mono-value reference lines, nothing
when empty) over that same counted fold; the app's approval and Run step binding passes its
counted row, section inset and typography. Balanced two-line wrapping of centred state copy and
capsule titles is one web-only fact, `HAPPIER_BALANCED_TEXT_WRAP`, applied by `HappierInfoTile`'s
string slots and the capsule title runs; core's own tile text spreads the same constant.
Public `List` expansion remains
the controlled collection-item capability. Authors import these adapters from
`@happier-dev/plugin-ui/components`; shared `presentation` implementations are
host-internal. Field-box presentation and segmented radio choices remain available through `Select`;
tab navigation retains its distinct tab semantics through `Tabs`.

In 0.3 development source, same-realm public `VoicePresence` binds one existing
`useVoiceAttemptControl` projection for its children. Public `VoiceMark`,
`VoiceStatusLine`, `VoiceCompactTranscript` and `VoiceTransport` delegate to the existing host components;
the binding adds no layout. `useVoiceAttempt` exposes only the typed, sanitized
attempt presentation, including its failure sentence and exact runtime recovery
target. A connected attempt without a provider-reported phase presents `live`
(Connected); microphone capture remains a separate fact, and the shared status
clock retains the original attempt start across phase changes.
Raw provider errors, prompts, transcripts and credential configuration
do not cross this read seam. Controls retain the host's ordinary Action approval
and attempt binding. Hidden presentation withdraws the binding and its animation
demand; mounting it starts no media. Hosts without these optional same-realm
bindings use the author's fallback. This is an unpublished author addition,
not a hosted-web media bridge or a change to the app's presence composition.
`VoiceCompactTranscript` binds that same attempt to the app's compact-caption
renderer, which owns transcript visibility and latest-word selection. Its public
props contain only `testID` and `fallback`; it exposes no transcript read API.

The same binding subscribes to the existing `VoiceReadAloud` presentation owner.
`useVoiceReadAloudPhase` exposes only `idle | preparing | speaking`, or null
outside a supported binding. The host's existing standalone-reading decision
selects its speaker glyph, preparation/reading status and Stop for the public
parts. During a conversation the existing transport retains its independent
read-aloud Stop alongside conversation controls. This adds no playback runtime,
spoken-text projection, Action or provider lifecycle.

Realtime declined and thrown safe failure codes use the same canonical machine
classifier as Local Voice. Agent authentication, provider credential review and
service setup therefore retain their distinct recoveries. The public
`VoiceAttemptFailureKindSchema`, `VoiceAttemptRecoveryActionSchema` and
`VoiceAttemptPresentationSchema` project that host taxonomy; plugins supply
codes and never author recovery labels or routes.

Public `TextField.dictation` composes `DictationButton` with the existing field,
binding capture admission to field editability. Authors may also use the public
button beside a custom controlled input. Both deliver editable text only and
leave insertion and submission with the author. The private host binding uses the incumbent
Dictation button, `useTextInputDictation` delivery/error adapter and
`useVoiceDictation` / `VoiceDictationController` engine. Session authoring uses
that same delivery adapter. An opaque mount-local control id is not a Session:
plugin fields explicitly pass null transcription Session context. Canonical
Dictation settings, language, permissions, capture admission and cancellation
apply independently of conversation selection. Host/tab visibility narrows
activity, and disable/unmount prevents late delivery. Live Voice subscriptions,
consent and attempt binding remain host-internal. No hosted-web capture or
second STT service is introduced.

Voice-callable plugin commands are ordinary Actions admitted on the `voice`
surface, discovered through `action.spec.search`/`action.spec.get` and dispatched
through `action.invoke`, or mounted semantic commands published with
`publishCurrentUiContext`. The current-context Protocol owner preserves the
complete mounted command inventory without a separate command-count or
aggregate-byte ceiling. Context detail and references use strict JSON; executable
command inputs retain their own semantic-operation boundary. Invalid optional
context is withheld, and opaque descriptors never carry executable payloads.

In 0.3 development source, Ask Happier captures this same strict snapshot into
`session.authoring.open`'s `seed.currentUiContext`. The New Session seed owner
converts it to the manifest-declared `happier.app-context/current-screen`
composer attachment. Its ordinary badge, removal, draft persistence and accepted
submission use the existing Composer owners. Screen data stays out of editable
prompt text; release notes remain editable. Agent callers use the same typed seed.
The attachment resolver supplies captured data to the normal dispatch context
block and never executes its opaque command descriptors or reads a later screen.
Ask entry points borrow the incumbent mounted Action reader at the press (or
palette inventory capture), so reparented workspace pages and sheets do not
depend on receiving that reader through their local React ancestry.
Existing attachment value and instance bounds apply before the seed is written;
an invalid attachment rejects the seed rather than silently dropping its context.

`VoiceClientToolDefinition` describes the sanitized,
attempt-bound host tools supplied to providers; it is not an author registration
owner, and effects still deliver canonical `tool_calls` through the Action barrier.
In development, the shared realtime host publishes only Voice hot-path Action
schemas, discovery (`searchActionSpecs`/`getActionSpec`), and the transport tool
`action_execute`. Built-in non-hot-path Actions remain reachable as
`{actionId, input}` through the same Voice handlers and Action executor. This is
not a new Action id or a replacement for contributed `action.invoke`. Generic
results retain the MCP executor envelope (`{ok:true,result}` or
`{ok:false,errorCode,error}`), with target-specific Voice privacy redaction.
Current-UI and contributed invocation remain hot-path tools. Providers without
stable effect custody, and all direct SDK callbacks, remain read-only; attached
Agents receive only current-UI tools, never this generic executor. No transport
budget is increased. OpenAI, xAI, Codex and ElevenLabs consume this host projection.

The client-local `ui.voice_global.*` conversation and Brief Action family is
consumed through the public typed `executeAction` Host API. Its microphone/Brief
approvals, captured attempt identities and typed unavailability are unchanged.
See [Actions](actions.md#client-local-voice-controls-development) and the
[published author guide](../apps/docs/content/docs/plugins/guides/voice.mdx).

The UI host composes the optional realtime `prepare.attemptPolicy` through the
Agents-owned Voice prompt composer. It includes guidance for the attempt's
admitted client tools, reply language, greeting preference, and Voice prompt-stack
blocks. The host retains that immutable policy through reconnect and releases it
with the attempt; it is not safe metadata. OpenAI and xAI translate it into native
session instructions alongside custom instructions captured for that attempt;
unrelated native configuration retains its existing preparation transitions. ElevenLabs maps
it to the SDK prompt and language overrides. OpenAI and xAI request an immediate
welcome only after the initial connection's session update, not on reconnect.
In development, the shared attempt-policy owner carries an optional `welcome.text`
for Right away or After I speak. A selected welcome Doc is read afresh through the
captured Home/Account's qualified Artifact reader; its markdown remains byte-exact,
including whitespace, and an unavailable selection refuses preparation. Without a
selected Doc, the app translation owner resolves the default in the admitted Reply
in language and names the exact bound target; deliberate global mode uses the
ordinary global default. Automatic or unsupported reply languages have no default
literal; the UI language is not a substitute. The prompt carries an After I speak
literal on the first user reply, without requesting an immediate greeting.
ElevenLabs consumes a Right away literal as its native `firstMessage`.
Shared preparation sets `firstMessage: ''` for Off and After I speak;
provisioning and actual-configuration admission require the corresponding
`first_message` override permission. A reused Agent missing it needs the existing
update action before credential minting. Without a literal, ElevenLabs sends an
empty first message alongside the attempt prompt and waits for the user; its
Greeting row explains this through the contribution's `immediateRequiresLiteral`
presentation fact. Local and model-driven realtime greetings retain their
reply-language instructions when a literal is unavailable.
ElevenLabs BYO actual-configuration admission also requires the client-event
subscriptions authored by provisioning, including `agent_response`. A reused
Agent missing these subscriptions needs the same update action before credential
minting; receiving remote audio alone does not establish transcript delivery.
Attached Agent realtime sessions do
not receive this standalone policy: their native Agent prompt scope remains the
authority. In development, each native start prepares the current bound Voice
stack through the shared Account → target Profile → Project/Source → Session
reader and conversational Role formatter. Codex receives those admitted facts
through additive developer context before its unchanged V3 realtime start;
this does not replace the Agent's operational instructions or add prompt,
initial-item, model or output-voice start fields. Session Memory Off is consumed
by the existing Agent base-prompt and tool-availability owners: automatic recall
guidance and memory writes are withdrawn without disabling explicit memory reads.
Native Voice does not introduce a separate operational prompt or tool
policy. The SDK's optional
`systemAppendBlocks` input is host-private, not a public RPC override. Missing
required content or a retired target refuses native admission; a later start
can reread current content. Omitting the optional input preserves existing
plugin callers.

The development Voice status/glance model carries optional
`preparedInstructionsFor` for the exact Session whose Instructions entry
the supported carrier accepted. Standalone realtime retains the shared
resolver's admitted entry with its attempt policy and publishes it only after
provider preparation succeeds and that attempt connects. Attached Agent realtime
carries the host's preparation fact in its successful native-start response and
passes it through a host-private callback; a plugin's arbitrary metadata cannot
assert it. Local/daemon Voice carries the fact through its existing successful
bootstrap/welcome results and turn-stream reads only after native prompt delivery
succeeds. The current-attempt owners retire
the fact on replacement, failure or End; global mode, absent Instructions and
unknown or unsupported delivery omit it. Resolving prompt text alone does not
establish carrier success. The UI may render “Speaks from” from this fact using
the exact Session's admitted display name, without another Voice lifecycle state.

Standalone Local Agents admit the same reply-language and greeting preference
through `intentInput.voicePolicy`. The existing Voice launch config retains it
for recovery, and the shared Agents prompt owner consumes it on READY bootstrap,
first-user-turn seeding and replacement-runtime reseeding. READY is a warm-up,
so After I speak applies to the first user reply; a completed greeting is not
repeated when replaying retained conversation context. Recognition settings do
not supply reply instructions. Immediate Local welcome sends the same admitted
literal through the existing `welcomeText` RPC input when available. Adopting an
existing run consumes its retained policy rather than newly edited preferences.

In 0.3 development, standalone Voice Agent provisioning uses the same native
runtime lifetime and transport budgets as other Execution Runs. The UI does not
derive a startup cutoff from its network timeout or inject a 60-second bootstrap
default. After prompt admission, READY uses the daemon's ordinary Voice response
budget. Existing explicit `bootstrapTimeoutMs` RPC values remain supported as
READY response overrides; they do not bound credential, MCP or native runtime
preparation. Stop and caller cancellation retire the same start occurrence.

Recognition, reply instructions and output voice are distinct provider contracts;
do not publish a universal independent language control when a provider couples
them or leaves language session-owned. Conversation controls, search and direct
settings-route access consume the same page decision; independent Dictation is not
disabled by the conversation gate. Presence selection is device-local, and the
containers cannot choose an attempt's target or media lifecycle.

Registered STT transcription carries only an optional capture purpose, not a
client-selected language or provider configuration. Omitted purpose uses the
admitted Conversations configuration. For Dictation, the daemon reads the
independent language preference from the same Account snapshot and validates an
invocation-local override against the contribution's declared `language` field;
null uses that field's declared default. Contributions without that field retain
their engine-owned behavior. Neither path writes provider settings or aliases
reply language. Changing a captured Dictation language invalidates the existing
speech settings snapshot before its result can be published.

### Voice settings presentation (0.3 development)

Plugins own curated controls through the strict
`voice.provider-settings.v1` presentation in their existing Voice contribution.
The shared UI renderer consumes that declaration; provider-specific layout does
not require provider-id branches in the host. Settings schemas still own accepted
configuration and persistence. Presentation metadata does not admit arbitrary
configuration paths or loosen those schemas.

Numeric fields can declare optional `valueSuffix` and `fractionDigits` for their
display value. The shared renderer presents bounded `range` fields as sliders
with a Default reset; nullable resets retain the settings owner's unset value.
Formatting does not change stored units or the configuration accepted by Settings
Actions. Services own these facts in their contribution, not host id branches.

Optional `groups` arrange the declared top-level fields into sections. Each group
has a unique `id`, localized `titleKey`, optional `descriptionKey`, and
`fieldPaths`. When groups are present, every top-level presentation field must
appear exactly once, and unknown or repeated paths are rejected. At most one
group can set `includeCredentials: true`; without an explicit credential group,
the renderer puts credential controls in the first group. Omitting groups retains
the existing single-section presentation.

A `voice_catalog` field can declare `valueShape: 'string'` when its settings owner
stores a scalar voice ID. Omitting `valueShape`, or choosing `'selection'`, retains
the existing `{ kind: 'catalog' | 'custom', id }` representation. Catalog selection
and custom entry both pass through the provider's settings owner; the renderer
does not migrate stored configuration or infer the shape from a provider ID.
The `welcome` control presents the shared Greeting preference and uses its
canonical settings declaration rather than publishing a second provider field
for the same preference.

In development source, the contributed credential and Connected Account rows
also expose typed `settings.invoke` operations. `voice_connected_services`
selects existing accounts or pools in the provider's declared configuration
field; it does not change Account purpose defaults. `voice_saved_secret`
selects an existing reference, inspects its recipient disclosure, reviews that
exact binding, or removes it, including for API-key-only services and machine
overrides. Pickers use these same operations. Inputs carry references and the
captured Settings version, never credential values or caller-created trust
approval. The host resolves the current recipient contract, presents the
existing confirmation, and rechecks reference and contribution currentness
before the canonical mutation. Creation and rotation remain with the Saved
Secret resource Actions and their existing plain/encrypted custody rules.

Development Session voice preferences use that same declared field and provider
schema. The qualified contribution and exact setting path identify one voice
override; catalog/custom/string values keep their native shape. The shared
resolver rejects unrelated settings and a preference for another contribution
instead of silently changing provider or credentials. A selected preference may
retain the catalog's `displayName` for its closed Work row; this is presentation
only and never enters provider configuration or admission. Settings and Work
share the catalog owner: provider-declared static options are available without
a fetch, while fetched names are retained under the same Home/Account/provider
target and credential reset clears them. Closed rows do not fetch a catalog on
mount. An admitted current-attempt
voice label belongs to the host snapshot, not to a later catalog lookup or saved
preference. Unknown application remains null. Providers retain their actual
preparation/application boundary; this contract does not promise universal
mid-conversation updates or completed bound-instruction integration.

Optional `language` facts describe the service's actual conversation-language
contract. `automatic_recognition` keeps recognition automatic and admits the
independent reply preference; `independent_reply` admits only that preference,
without claiming how recognition works. `single_language` publishes the native
`supportedLanguageCodes` and couples listening and replies to one root choice.
The native leaf, UI and settings Actions share the same language normalization;
unset means the service default, not promised auto-detection. Omitted facts do
not imply that the service consumes a mutable language preference. No additional
language preference is persisted by this presentation metadata.

These are development author-contract additions, not opaque UI-only payloads:
the manifest serializes `settings.presentation`, and the Protocol reader checks
its nested strict schema. Current readers accept declarations without these
optional facts. Pre-addition strict development readers reject new declarations;
that reverse direction is not promised by the SDK direct cut. The inspected 0.2
predecessor uses host-owned Voice settings and has no plugin manifest reader for
this seam. These additions therefore do not introduce a host version floor,
rollback adapter, or persisted settings migration. Public plugin leaves consume
`resolveVoiceProviderLanguagePreference` through the existing SDK Voice export.

OpenAI Manual preparation marks the exact admitted session as requiring input
commit. The existing host turn-control owner submits that input and then the
provider-encoded response request on the same still-owned connection. Send is
separate from End Voice; automatic turn detection does not expose Send. Ending
the attempt during submission prevents its later response request. This same
turn-control entry point owns opt-in one-turn held input as well. Admission seals
and clears prior input before temporarily opening capture; release seals capture,
commits once and requests the response, then restores the capture owner's policy.
Cancel, release before admission, and a retired selection or connection cannot
commit. User Mute and lifecycle input suspensions remain separate policy facts;
applying either retires held admission, even when Mute was already applied.
Capability requires prepared Manual input, declared clear-input support, encoded
response controls and a concrete capture boundary. The host WebRTC microphone
supports that boundary; PCM/provider-managed capture does not advertise hold
without its own proven admission. A device-local default-off preference exposes
the composer's secondary press; tap and the keydown-only shortcut remain Start/End.
There is no second commit sender, capture owner or gesture-owned session state.

Identified client-tool calls enter the host's canonical Action barrier, which
owns authorization, approval, cancellation, replay custody and current privacy
redaction. Direct tool-definition callbacks remain read-only. The ElevenLabs
adapter associates its SDK's public incoming event with the matching callback
parameters, preserves the actual provider call ID, and settles each callback
only from a host result; it does not execute or cache effects. Approval origin
uses the connected attempt's captured Home/Session binding, not later navigation
or target selection. SDK-reported client-tool refusals return a safe error result
without ending Voice; terminal session, media and result-transport failures
still end the connection, and retired callbacks cannot re-enter the host.

In unreleased 0.3, ElevenLabs provisioning adapts the host's full JSON Schema
to the vendor's restricted client-tool parameter model using one string field,
`arguments_json`. Its description carries the original argument schema; the
adapter decodes that JSON before entering the same host validation and approval
barrier. Retained agents using native arguments remain readable. This avoids
dropping unions, references or arbitrary JSON inputs to satisfy the vendor
model (ElevenLabs OpenAPI API 1.0, retrieved 2026-11-06). The mapper authors the
vendor's neutral readback defaults so reconciling an unchanged selected agent
reuses its tools instead of creating replacements.
After an update is read back, reconciliation deletes replaced dependencies that
belonged to the selected `happier_voice_config_v1`-tagged agent and are absent
from its updated tool list. The vendor's `force=false` DELETE preserves other
agents' and branches' references; refusal remains visible as incomplete cleanup.
Matching workspace tool names never authorize a cleanup sweep.

The xAI realtime session projection uses the same argument envelope and shared
Protocol codec through the public Voice SDK. A loaded November 10 comparison
returned `internal_error` for `spawnSession` with recursive Workflow branches
under `initialTriggers`, while the full schema carried in the string description
completed a response. Neither adapter removes host inputs or changes the host's
validation and approval authority; decoding unwraps one envelope only.

Host-mediated JSON HTTP 422 failures may retain validation locations and known
validation categories within the operation's existing response-byte budget.
Provider messages, input values, context and registered credentials are excluded;
Settings Actions project those structural facts into the existing failure alert.

In unreleased 0.3, a recipient operation declares no response body with
`response: { maxBytes: 0, contentTypes: [] }`; both values must appear together.
The shared UI/daemon response owner accepts empty successful responses without
a Content-Type and preserves empty bytes. Operations declaring a representation
still require their declared media type and valid JSON; bodyless operations
reject nonempty bodies. Declaration readers and hosts update together under the
existing unpublished 0.3 direct cut.

Permission-request sharing controls context disclosure, not approval authority.
In 0.3 development, **Voice agent can approve requests** (`voice.canApproveRequests`)
defaults on for Local Voice and realtime modes exposing host decision tools. It
delegates approval or denial of pending requests to the Voice agent acting on
the person's behalf. Prompt guidance tells it to read the request,
ask, and follow the answer. With the setting
off, a tap in the request UI is required. Provider plugins cannot create approval
tokens or bypass the canonical decision owner, and other automated callers retain
their existing authority floors. End Voice leaves pending requests reachable.
Native Codex Realtime is explicitly excluded. It uses `current_ui_only` host tools
and app-server-owned native delegation; its runtime emits no host client-function
calls. Its existing developer context tells the agent to read the request within
the sharing policy, say that it cannot approve or deny there, and direct the person
to tap the request or switch to Local Voice. The preference does not widen its
tool surface or the attached Agent's authority.
ElevenLabs still declares `effectCalls: 'none'` until
the loaded approval/effect-custody proof is complete; callback identity alone is
not permission to enable effects.

### Batch speech output (0.3 development)

Protocol's `voice/speechText.ts` owns semantic sentence and clause boundaries for
Kokoro synthesis, daemon synthesis and streamed Voice output. Token
punctuation in filenames, domains, URLs and times is not a sentence boundary.
The first useful streamed sentence can publish before the steady-state event
batch target; subsequent output remains coalesced under the existing event budget.
Accepted speech segments enter the ordered playback queue immediately; downstream
synthesis batches only to the selected provider's actual input limits. Local
Voice's `ttsChunkChars` preference is admitted once as the producer's latency
target, not a second semantic lookahead or provider ceiling.

Protocol's output-event owner packs those semantic segments into the existing
speech-event wire envelope without discarding the remaining text. The daemon
producer and legacy client adapter share that packing policy; only the canonical
turn-output budget marks the reply incomplete.

Daemon output and the retained legacy-output translator consume the serialized
byte/event budget in `voice/outputEvents.ts`, reserving the repeated terminal
text and any incompleteness notice during admission. A clipped reply keeps its
accepted text and effects and publishes a final transcript notice; it does not
fail terminal ingestion after speech has already played.

Speech declarations distinguish `maxInputCharacters` from `maxInputUtf8Bytes`.
An endpoint may bind its character cap to a declared positive integer setting
with `maxInputCharactersSettingId`; the setting cannot exceed the declaration's
ceiling. `resolveVoiceSpeechSynthesisInputLimits` resolves that cap from the same
immutable settings snapshot used for synthesis. The UI batches whole and
incremental replies in order, and the daemon checks the effective cap before
calling the plugin. Cancellation prevents remaining batches and late playback.
Google Cloud declares its actual UTF-8 byte limit; OpenAI-compatible endpoint
settings default to OpenAI's character limit and allow a custom endpoint cap.

Fresh Local Voice settings select Device STT and Device TTS. Existing explicit
and predecessor selections remain unchanged. The existing device-readiness
owner determines whether capture is runnable or requires setup; empty compatible
endpoints are not selected as the fresh pipeline. Local-neural Auto follows the
platform execution policy, without an inert latency-demotion state.

### SCM filesystem authority (0.3 development)

The host command result marks failed executable resolution with the optional
`executableMissing: true` field. Git and Sapling repository detectors translate
that fact to `BACKEND_NOT_INSTALLED`; the host selection registry treats that
detector as inapplicable. Installed-tool failures remain unavailable when no
detector answers. Diagnostic prose carries no executable-absence meaning.

Entry-history backends may declare the optional `read.historyEntries` operation
and its handler-backed capability through the existing SCM contribution. The
public SDK projects the strict Protocol request/result; registration and the
host dispatcher enforce the same operation as the `scm.history.entries` Action
and SCM RPC. Absence means unsupported, not a host branch on the backend id.
See [demanded entry history](scm-diff-summary.md#demanded-entry-history-unreleased-03)
for captured-HEAD, literal-path and unavailable-history semantics.

The backend command service's optional `runCommandStreaming` operation feeds
admitted stdout bytes to a consumer without retaining complete stdout. The same
host command owner enforces executable admission, resource budgets, cancellation
and process cleanup. `runBackendCommand` selects this operation when supplied a
`stdoutConsumer`; an older buffered-only host refuses that request. A consumer's
`stop` acknowledges a settled read, and `stoppedEarly` distinguishes that
successful settlement from cancellation while preserving the actual process
exit code. Git entry history consumes this seam; plugins do not spawn a parallel
history process owner.

SCM Action and RPC entry points share the host dispatcher. Worktree removal
authorizes the target with the host's filesystem policy and forwards the resolved
path. For worktree creation and prepared review workspaces, the host supplies
`context.assertFilesystemPathAuthorized`; the Git checkout materializer calls
it on each derived destination before creating a branch or checkout, including
the temporary sibling used for a populated destination before any scratch
cleanup. Review preparation checks those same mutation paths before fetching
the source tip or creating its branch, and checks an existing registered
checkout before reusing it. Reuse does not require permission for an unused
scratch sibling. This also checks symlinked destination ancestors. Repository backends
derive placement;
the host remains the filesystem-policy owner. Policy refusal returns
`INVALID_PATH` and does not mutate the rejected target.

The development storage catalog consumes this same SCM contribution's optional
`worktree.retire` / `worktree.reinstate` handlers and `worktreeRetention` capability.
Git retirement moves a registered linked checkout and locks it with its Trash entry
identity; restore unlocks and moves it without replacing an occupied destination.
Submodule linked worktrees support Delete now only. Nested registered linked checkouts
settle child-first, each with its own Trash entry. In the 0.3 development implementation,
main checkouts, their common Git directories and proved registration-gone orphans
instead use SCM-owned, same-volume no-replace rename through the public SDK's host
filesystem services. Orphans retain their exact `.git` back-reference, including
relative paths; Undo resolves that reference at the retained original path without
rewriting it. Orphans remain Caution and collectable. Main/common retirement preserves
contained checkout bytes and registrations in one payload rather than retiring them
independently. Indexed children of a common Git directory cannot bypass this whole-item
SCM lifecycle. Dependent worktrees become unavailable while their common authority is
in Trash; restoring the original path restores that authority.

In development source, trusted folder-scan roots consult this same SCM owner even
when no Project or Session census contains them. The detector's optional
`includeRetainedWorktrees` read resolves a proved orphan to its live repository
anchor; ordinary SCM detection remains unchanged. Storage binds the resulting
enrichment and lifecycle adapter before review or effects. An absent or failed
classifier leaves Git-marked roots at Check, rather than enabling filesystem cleanup.

SCM enrichment supplies main/common loss facts: local unpushed branches, stashes,
tracked/untracked changes and dependent worktrees. The existing Storage review carries
these facts for explicit person confirmation; Agent callers use the existing per-Action
approval policy. There is no separate approval or Trash path. Project/workspace
references use the existing Account row/topology owner and CAS, scoped to the admitted
custodian Account and Machine. Sync endpoints, including paused ones, refuse retirement. Reference
receipts fence Undo/recovery by exact row revisions, and reference-bearing Undo must
restore the original path. The host-only
`context.beforeFilesystemMutation` callback revalidates captured facts inside the
repository's mutation queue immediately before the filesystem effect.
Interrupted Trash moves and deletions complete only through this trusted guard
and exact retained identity or current linked-worktree registration; the guarded
`context.retainedSourcePath` supplies the original basis for relative orphan
back-references during Empty. Recovery does not broadly prune
registrations. Ordinary
`scm.worktree.remove` approval and request semantics remain unchanged. Optional
`read.ignoredPaths` supplies Git ignore evidence through the same contribution,
and additive worktree enrichment supplies cleanup facts; older contributions
that omit these operations remain unsupported or unknown, never implicitly safe.
Draft reviews retain their open-review protection; an unknown review state stays
unknown rather than becoming evidence that no review exists.
The host's private `scmWorktreeMutationActivity` projects accepted worktree and
checkout-creation handlers through settlement, including their native queue wait.
Maintenance consumes its idle read and subscription; the projection neither
serializes operations nor interrupts Git, and adds no plugin SDK contract.

The [SCM comparison contract](scm-diff-summary.md) keeps Git mutation and hosting
evidence at their contributed owners. Git's ordinary, stacked and accepted-plan
consumers share one writer and advertised capabilities; the public SCM backend
command seam carries its native ref-transaction acknowledgement. Shared private
index setup is a filesystem-only `cli-common` subpath, not a plugin UI dependency.
GitHub comparison evidence uses its existing configured-source Action and
validated continuations; display projections do not become authority or select
credentials. Missing backend/model capabilities fail closed rather than enabling
an id-based host fallback.

Repository publishing selects concrete deployments through the hosting registry,
not static declarations. Routing contributions may enumerate admitted deployments
using the same Connected Account bases as remote detection. The registry also
resolves the snapshot-selected Git remote through its canonical detector and keeps
its repository coordinates. Publish targets carry the qualified provider id and
base URL; an unavailable or ambiguous selection is refused before provider writes.
GitHub supports cloud target discovery without a remote. Configured GitHub
Enterprise origins are admitted, but the current publishing adapter still refuses
Enterprise provisioning. Azure DevOps and Bitbucket publishing retains coordinates
from an existing recognized remote; empty-repository target discovery is not
implemented for those providers.

In 0.3 development source, hosting registry resolution inherits the current SCM
operation's cancellation signal through the existing SDK service scope. Configured
Connected Account metadata reads use that same signal; cancellation refuses a late
listing and stops discovery before the next provider. Registry callers outside an
operation can supply the optional signal explicitly. No additional timeout is added.

Forge throttling uses the canonical `REMOTE_RATE_LIMITED` failure and, when the
forge supplies one, `retryNotBeforeMs`. PR and repository-provisioning responses
share the validated failure fields. Git publishing, PR reads, checkout, clone and
stacked actions preserve that retry instant without inventing a fallback deadline.

In 0.3 development source, repository provisioning also retains the existing Action
`failureCause` through Project Open. Authentication failures identify credential
materialization, a required account, rejected HTTP credentials, clone-target auth
state, or Git authentication by phase; remediation carries the repair instruction.
GitHub uses the host purpose owner's selected account or declared native CLI login,
without a separate adapter-owned credential fallback. Unbound public reads remain
anonymous only when the provider observes public repository visibility.

### Connected Account purpose setup (0.3 development)

Home public OAuth clients are deliberate non-secret `serverConfig` entries
(`editable: 'home'`). Connected Services feature delivery carries optional
qualified-service client IDs and mode-specific registered scopes. The existing
daemon configuration owner exposes `getPublicOAuthClient()` only for its bound
service/mode, returning null for absent, conflicting or unavailable metadata.
Cloudflare selects it at begin and retains the ID/scopes in existing attempt
and credential custody for callback, status, refresh and revoke; changed Home
defaults cannot retarget an existing grant. BYO client configuration and scoped
tokens remain available. The daemon owns PKCE and every token request; this
adds no server exchange, credential resolver, polling or lifecycle owner.

An OAuth mode can bind its own-client configuration with
`clientConfiguration: { clientIdFieldId, scopesFieldId }`, referencing distinct
declared public string fields without connection-origin semantics. The
configuration owner resolves the Home client once per operation: a configured
Home makes these optional Advanced fields;
an absent Home makes them required visible fields. Its control view supplies the
effective `mode`, while the admitted snapshot retains the same public client.
Field `presentation.advanced` uses the shared disclosure, opening for required,
populated or invalid fields and preserving drafts when folded.

Authorization-code modes can declare optional Account configuration fields in
`postAuthenticationFieldIds`. Initial attempt forms omit those fields from the
display mode while normalization retains their full schema and stored values.
Established Account forms show them; provider-discovered replacements clear
their deferred IDs and use the same configuration owner for selection and
validation.

After exchanging an authorization code, a provider can stage its grant in
`attemptCredentials` and return `{ status: 'configurationRequired', fields }`.
The fields replace matching Account configuration fields in the admitted mode;
the existing configuration form validates the selection. Continuing invokes the
provider's `reconcile` with the retained grant and selected configuration, even
when uncertain-outcome reconciliation is disabled. It never exchanges the code
again. The existing sealed OAuth attempt retains the choices, grant and observed
authentication provenance through restoration; cancellation disposes them.

When no choice is needed, the provider can call
`context.stageAccountConfiguration({ values, fields })` during completion or
reconciliation and then return `connected`. The same configuration owner
normalizes this staged replacement, which settles with the credential. Providers
keep the optional fields in the static Account schema so established records
remain editable without persisting provider-discovered field declarations.

The optional feature leaf drops malformed metadata without withdrawing sibling
Connected Account capabilities. Its presence is configuration, never operation
authority or proof of granted provider permission. This is unreleased 0.3
source; real registered-client consent remains a release check.

Source discovery Actions select Connected Accounts through the same host purpose
setup as Resources. The Action projection carries its declared qualified purpose
scopes from the existing registry authorization owner. A plugin's
`openConnectedAccounts` request can include that qualified `purpose`; the host
captures the invoking Account and any explicit Machine and opens the existing chooser.
In 0.3 development source, it resolves with `{ kind: 'connected' | 'selected',
account }` or `{ kind: 'dismissed' }`. The account contains only its qualified
service and account id, never credential material. Existing plugins may ignore
the result. An older host's empty acknowledgement resolves to `undefined` so
the caller can re-read its existing account options.
The host also forwards that Machine as the chooser's initial target for ordinary
Connected Account requests and empty Account-option repair from an Action form.
The existing target-selection owner gives this explicit target precedence over
the chooser's remembered Machine; an unavailable target stays unavailable.
`connectedServices.purposes.default.set` admits either installed consumer. With
`machineId` omitted, the existing Account execution selection supplies its
enabled, admitted manifest without requiring an online Machine. An explicit
Machine requires that exact Machine's current projection and never falls back
to Account declarations. Both origins use the same declaration and active
personal target resolver, then write the canonical purpose catalog under the existing approval policy, also
serving agent/MCP/CLI callers. Creating an account does not bind a purpose, and
read-only discovery never selects one. Machine-provisioner setup still returns
an explicit launch-input selection rather than writing a default.

### Machine-native GitHub credentials (0.3 development)

GitHub's Connected Service declares `authentication.native: { systemTool: 'gh' }`.
This is the existing native source, not a new credential kind or account store.
An authorized consumer requests `materialize(purpose, request, { nativeService })`
through the ordinary Connected Account purpose owner. Only an unbound purpose
can use that service: an explicit account selection, including an unavailable
or invalid selection, takes precedence and never silently falls back to `gh`.
Resolution reads do not erase that intent; only explicit clear/reselection or
removal of the declared purpose contracts it. Scope or credential failure still
refuses disclosure.
The host validates the qualified service, declared scope and current invocation
before materialization and rechecks binding intent before disclosure.

The executing daemon resolves `gh` through its canonical dependency owner and
runs `gh auth token --hostname <host>` with cancellation. GitHub's API origin
maps to `github.com`; an admitted Enterprise origin retains its host. Tokens are
ephemeral HTTP authorization material, not Connected Account records or synced
configuration. They must not enter logs, events, diagnostics or plugin storage.
Unavailable authentication produces a typed failure with the remedy to sign in
with the GitHub CLI on that machine.

Action declarations can pair an account selection `path` with
`nativeServicePath`; the canonical extractor admits exactly one credential
selection. Triage's shared settings and administration Action persist only the
native service identity. Source and review metadata retain that identity rather
than inventing an account id. See [Triage source ownership](triage-sources.md).

### Shared provider reads (0.3 development)

The required `HttpService.prepareRead` method admits and snapshots one GET
or trusted-plugin-declared GraphQL query without sending it. Its single-use
handle keeps the exact URL, headers, body and original host policy while its
`request({ signal })` uses the shared request owner's cancellation. The host
checks occurrence, retained network binding and final policy before sending;
an admitted finite response may finish after authority withdrawal. Invocation cancellation does not cancel a peer's
admitted read. Dispose unused handles and dispose the executing handle when its
flight settles; invocation-bound credential injection remains on ordinary
`http.request`. All current 0.3 invocation hosts provide this method; an
unavailable HTTP service refuses it through the ordinary service diagnostic.
The Session runner transports preparation to that same daemon HTTP producer,
retains its single-use handle in the existing invocation custody, and transports
execution and disposal by handle. Closing the invocation disposes unused and
executing handles; preparation sends no provider HTTP and preserves typed
admission refusals.
The public SDK testkit's `createPluginHttpFixture` supplies the same immutable,
single-use and request-owner cancellation behavior at the HTTP transport boundary.
It does not simulate host policy admission or credential currentness.

GitHub's account request owner in
[`githubApiClient.ts`](../packages/plugins/scm-github/src/observations/githubApiClient.ts)
uses this capability for simultaneous equivalent safe reads. Its occurrence
retains only in-flight requests and the maximum provider rate-limit deadline,
partitioned by admitted Account, credential materialization and execution origin.
An exhausted primary bucket reported on a successful response also parks later
demand until its provider reset, without changing the successful result or
decoding its body.
Channels, Automation, Triage and SCM adapters borrow this owner after their own
credential admission. Before publishing a shared response, each native API caller
re-admits its exact request under its own current HTTP binding and disposes that
unused handle, without sending another HTTP request. Connected Account purpose
membership is admitted by the Connected Accounts materialization owner, not
inferred from the HTTP binding. Unidentified native credentials and anonymous public
repository reads cannot borrow an identified Account. Settled requests are
removed; throttled demand returns the existing typed failure without provider
HTTP, a timer or mutation replay. These are development-source contracts;
loaded-runtime and release validation remain separate evidence.

The development GitHub Channels comment/PR poll producer supplies the existing
`retryHint` on successful baselines and batches from GitHub's poll/retry headers
and primary REST budget headers. Without `x-poll-interval`, it spaces the next
cycle's REST acquisitions over the remaining reset window and request budget;
when fewer requests remain than one cycle needs, the reset is the next wake.
GraphQL's separate points budget does not replace the REST budget. Conditional
304 reads count toward the next cycle's potential acquisition cost because
that cycle may return changed 200 representations. Explicit provider waits
remain lower bounds, normalized to the existing Channels retry carrier bound.
This policy lives in `scm-github/src/observations/githubChannelPollCadence.ts`;
the existing Channels supervisor owns scheduling and the Account request owner
still owns rate parking. It adds no polling timer, persisted cache, or fixed
comments interval. If a transport omits all usable provider timing and budget
headers, the same admitted client makes one documented `GET /rate_limit` read
and derives cadence from that account's `resources.core.remaining` and `reset`.
The overview's own headers remain authoritative when present. This endpoint
does not consume the primary REST bucket, so it does not inflate the next
cycle's primary acquisition cost; it can still consume secondary capacity.
An unreadable overview uses the existing provider failure classifier; malformed
or expired budget facts use the existing `github_api_response_invalid` refusal
instead of committing a successful unpaced poll. No interval is invented and
no budget cache, retry owner or scheduling timer is added. This follows GitHub's
[rate-limit endpoint contract](https://docs.github.com/en/rest/rate-limit/rate-limit).

The development GitHub deployment observer retains waiting-list page validators
and compact run facts in its existing source checkpoint. Each page is read
conditionally, so an unchanged first page cannot hide a changed later page.
Retained 304 and identical 200 pages cause no run or pending-deployment reads
or notices; unchanged validators and facts cause no checkpoint writes.
Changed run facts are re-read at their exact ids;
a previously pending run leaving the waiting list is read before resolution.
The existing observer scheduler consumes `x-poll-interval`. Failed reads or
unsettled publication do not advance the conditional baseline.

The development source configuration retains delivery mode (`automatic`,
`webhook`, or `polling`; omitted means automatic), the optional user polling
interval and monitoring Machine in the Automation enrollment, never Account
settings. The existing durable-push transport carries the Home endpoint identity
and its target materialization; it uses that same selected monitoring origin,
not another Machine picker or source-config transfer declaration. The provider's `x-poll-interval`
floors the user interval. A verified current endpoint parks automatic monitoring
without a polling timer; source/route changes wake the same observer through the
existing host invalidation event. Webhook-only mode remains parked when a verified
route is unavailable. Polling-only mode uses the conditional owner above.

The monitor reads verification through the existing plugin-safe endpoint
correspondence Action, not present-user endpoint administration. Attachment
availability (`kind: ready`) remains distinct from provider confirmation. The
canonical endpoint readiness projection supplies verification plus nonsecret
contribution, source-instance and target facts; the observer retains exact
binding and revocation checks. Missing observations remain unverified. Route
revocation withdraws delivery permission without discarding the existing
background monitoring placement, allowing the same observer's conditional
fallback; changing or retiring the target withdraws its old Machine's source.

Verified `deployment_review` and `workflow_run` deliveries wake that same
observer under background source custody. It reads only the delivered run's fresh
`pending_deployments` and reconciles the existing notice identity; a signed
approval/rejection event is not itself evidence that pending review resolved.
Unchanged facts publish no notice, and denied reads do not resolve a notice.
These source contracts do not establish completed generic endpoint enrollment or
loaded closed-app delivery; the observation-only Automation arm and its setup
integration are verified separately.

### Connected Account refresh and quota identity (0.3 development)

Authentication completion may return a secret-free `completionObservation` of
type `ConnectedAccountCompletionObservation`: `ProviderAccountUsageSnapshotV1`
with `recordId`, `recordKey`, `accountSubject` and `staleAfterMs` supplied by the
host. The observation stays in the current process through successful credential
settlement. The daemon quota owner attaches the settled qualified Account and
credential/configuration revisions, resolves usage identity, and applies its
existing freshness cadence before using the existing usage writer and
`recordSnapshot` store. It performs no additional provider quota request and
stores no observation in credential KV, configuration or durable attempts.
Existing writer/store deduplication suppresses unchanged samples; publication
failure leaves the settled connection successful. A completion without an
observation retains the existing unloaded-source initialization behavior.

Static Connected Account credentials receive one scheduled health observation
when their credential or configuration changes. Health-status publication and
idle scheduler wakes do not request another observation, including after a
failure. Explicit checks and request-failure recovery remain available; OAuth
credentials retain their renewal and recovery deadlines. GitHub identity checks
share the Account request owner's provider-directed rate parking with ordinary
API reads, and expiry of that parking alone does not issue a request.

Claude subscription usage identifies a provider user and organization together.
The Claude plugin attests that context through the profile endpoint with the same
access token and preserves it in the existing credential KV and public
`providerIdentity.organizationId` metadata. The descriptor declares
`usageIdentity: { providerId: 'claude', requiredContext: 'organization' }`;
shared usage projection and source admission apply that declaration rather than a
second provider list. Native and polled observations use the same declared
semantic provider identity. Codex declares `providerId: 'openai-codex'` without an
organization requirement; undeclared plugin usage retains its qualified service
identity.
Different organizations never share a global usage alias solely because the user
UUID matches. Missing organization leaves global usage provisional.

Verified native or HTTP usage can still serve the exact selected profile without
an organization: the existing runtime quota entry carries the actual access-token
fingerprint that produced the observation. Current user and token must match;
replacing that token invalidates unscoped local evidence. Known user/organization
context survives ordinary token rotation. Local observations use the coordinator's
existing freshness and polling policy and do not create global aliases.

For native-home materialization, the host supplies the Connected Account runtime's
optional `existingFiles` input with a byte snapshot of the prepared home's declared
secret files. Missing files and credential-store directories have no entry; other
materialization paths omit this input. The snapshot stays machine-local and grants
no arbitrary-path reads. The host retains home serialization, binding/currentness
checks and protected writes; bundled and external runtimes use the same callback.
An Agent can declare `nativeHome.materializedRootOverlay.privateEntries` when its
selected Account needs a private root such as `XDG_CONFIG_HOME`. The host keeps
those top-level entries private and links every other existing top-level source
entry through the SDK filesystem owner (Windows directory junctions and file
symbolic links; POSIX symbolic links). Plain native/default launches keep their original home. New
top-level entries created in the selected root stay private; this recoverable
difference is accepted rather than adding directory watchers. Revocation removes
the selected Account's materialized homes after already-admitted runtimes release
them, preserving unrelated Accounts and the original native root. For the daemon's
Account, cleanup covers both ordinary and admitted Account-qualified requester
roots through the same scheduler.

Purposes declare all credential uses, while the Connected Account runtime returns
only leaves applicable to its credential mode. Empty environment or file results
make that use inapplicable. The generic materializer requires usable credentials
for each selected purpose across its uses; another purpose's credentials cannot
satisfy it. A native home is prepared only when native file leaves are returned
or the admitted Provider/member launch explicitly requires that home. An Agent
may also name `nativeHome.purposes` for selected purposes whose native serializer
writes configuration into its home despite receiving credentials through
environment or request auth. Those purposes use the same account/group root,
state sharing and cleanup lifecycle as file materialization.

Claude reconciles user, email and organization into that home's `.claude.json`,
invalidates account caches, and preserves workspace approvals, project trust and
unrelated private preferences. Unreadable or malformed retained config refuses
materialization instead of replacing private state with an empty config.
Reset-credit debit verifies the current user and any known
organization before posting. Metadata-only context enrichment joins the existing
refresh lease, staging, CAS and distribution lifecycle; it neither rotates tokens
nor provides positive authentication/quota evidence. A successful rotation without
fresh attested context removes old organization metadata instead of preserving it.

Credential settlement removes old profile and pool usage aliases when context
changes. The UI's canonical qualified quota store checks current public credential
metadata before presenting quota, invalidates the exact binding after a changed
connection and rejects late results from retired requests. Ordinary metadata
transport failures retain accepted cached observations; a successful replacement
whose new context cannot be established does not retain the old context's quota.
Fresh authentication results use explicit null identity fields when a replacement
cannot attest them; omitted fields retain the existing partial-update contract.
The existing identity-change approval guard still protects an established user,
while unknown null facts can be enriched by later attestation.
These are development-source contracts, not a claim of release availability or a
diagnosis of every provider 429.

Usage surfaces select exact qualified services through the connected-service
registry's usage capability: a descriptor may declare `usage`, and bundled
services retain their generated quota-read declaration. An e-mail connection
without that capability does not become a Usage account. Observed accounts and
accounts awaiting their first observation are separate projections; the read
count includes only observations admitted by the quota observation owner.

Native credential resolution, Session authentication switching, daemon bootstrap
and refresh read through the qualified established credential owner and V4
transport. That owner validates the exact account reference, revision semantics
and persisted Account mode before opening content. It still decodes retained
0.2 credential payloads; that data compatibility does not authorize a current
client to select scalar V2/V3 HTTP transport. Missing or uncertain V4 capability
evidence refuses negotiated operations instead of selecting an older wire path.

The refresh coordinator treats plugin-reported access-token expiry as recoverable,
not as evidence that the user must reconnect. Scheduled refresh uses that status
even when the qualified profile has no legacy credential-kind or expiry projection,
then rotates through the existing exact-revision lease and credential CAS. Expiry
alone does not latch `needs_reauth`; an explicit reconnect-required or rejected
result still does. Provider or transport outcomes that remain uncertain stay retryable. CLI `--auth cs:`
selection resolves account identity and leaves credential admission to this owner.
In 0.3 development, a selector naming the supported service, group/profile kind
and exact id projects that identity without an inventory discovery request.
Shorthand still uses inventory to resolve ambiguity. Missing groups/profiles,
membership, revisions and credential health are admitted by the daemon before
materialization and launch; a qualified selector cannot establish those facts.
Once the current profile requires reconnect, automatic and foreground credential
checks preserve that status rather than downgrading it from an expiry-only plugin
observation and retrying the rejected grant. After an acknowledged or reconciled
reconnect, the shared native/app credential settlement owner clears that persisted
status against the committed credential and configuration revisions before
reporting success. An uncertain health write is not blindly replayed.

Within one daemon, scheduled, quota, request-auth, spawn and configuration refreshes
join the coordinator's in-flight exchange for the exact qualified account and
credential revision. They share the provider result and credential CAS; native-home
distribution retains its existing completion owner. Spawn preflight consults the
established plugin status when profile expiry is absent, so an expired native grant
is refreshed before launch and a rejected grant follows the existing reconnect-required
failure path. A missing expiry projection is not evidence of usable credentials.

New Session admission uses credential usability rather than the account's display
severity: `refresh_failed_retryable` can reach daemon preparation, while the exact
selected `needs_reauth` profile offers Reconnect. A healthy sibling or native login
does not authorize that rejected selection. Spawn preflight refreshes an expired
grant before writing its final health; a failed intermediate expiry-health write
cannot prevent recovery. Successful status observation clears retryable health at
the same revision-fenced owner. A current provider rejection keeps its reconnect
reason even if its health write fails. Successful refresh clears health against
the exact new credential revision returned by its CAS; credential replacement
itself retains health metadata. The creation Action retains that diagnostic
code and retryability in the existing launch-error result, which the UI presents
with the same reconnect guidance.

Manual authentication inputs are admitted against the service contribution's
field schemas by both the form and the daemon attempt owner, before provider
invocation or credential settlement. Anthropic declares its API-key shape in
the Claude plugin and verifies new keys with `GET /v1/models` through the
origin-scoped host HTTP service. Provider 401/403 responses reject the attempt;
transport failures and other unsuccessful responses leave verification
unavailable. Neither path stages a key or creates an account. Retry after a
terminal refusal opens a fresh editable form. Retained credentials remain
readable and materializable without imposing these new-input checks. This is
a development-source admission contract, not release or loaded-runtime proof.

The canonical Connected Account attempt owner retains the admitted authentication
runtime, mode and configuration basis through cleanup. Manual submission, OAuth
completion and device polling use the runtime and mode selected at attempt admission;
publishing a replacement afterward cannot send captured inputs to its changed callbacks.
Initial lazy activation resolves the current daemon registry when the old occurrence
proves it did not start provider work. Entered callbacks keep their registry lease
until completion even if local cancellation closes the attempt. Exact configuration and
credential checks still protect settlement, and uncertain provider effects retain
their existing reconciliation. UI, CLI and Agent Actions use this same daemon owner.
Manual attempts have no fixed host count or lifetime ceiling. Waiting OAuth and
device challenges follow the provider's expiry; entered effects and prepared
settlements retain their exact recovery custody rather than expiring on a host timer.
Local cancellation is authoritative immediately; the best-effort provider cancellation
callback follows the invocation lifetime without a separate host timeout.

Unsubmitted manual attempts retain their Account, mode, source custody and
configuration/credential revision basis in the existing Account-mode attempt
transaction envelope. A fresh CLI, app or approval executor can restore that draft through
the shared attempt owner; manual input and resolved Saved Secret values are supplied
only by the submitting invocation. Before provider work starts, the owner advances
the existing address to `starting` and removes its resumable draft. Another host
then reports an unknown outcome requiring reconnection rather than replaying the
pending submission. Machine-addressed continuations still route to that daemon.
Older development records containing no manual basis require a fresh connection;
this changes no released protocol or database schema.

In the development UI, selecting a declaration without `authentication.account`
returns an available, empty Account-mode set without admitting Account execution.
The native submission retains its existing Machine admission. Declarations with
Account authentication retain their existing enabled/disabled selection policy.

Terminal replies remain readable for lost-reply recovery until the consumer closes
the attempt through the existing cancellation command. The setup controller closes
that demand after connection, when retry replaces a finished form, or when the user
discards the flow. A terminal retry refreshes the daemon's description before
starting the next attempt, so a changed form is presented rather than reused.
The interactive CLI journey acknowledges its consumed terminal
reply too, while lost replies and uncertain effects retain their resumable custody.
Closure releases terminal retention without a host count or timer.

The bundled Cloudflare deployment Connected Account in 0.3 development source
uses the existing attempt, configuration, staging and credential-settlement owners.
One API token method verifies user- or account-owned tokens through their
documented endpoints; the account ID is required by the account-token endpoint.
The vendor's Builds API requires a user-owned token. Pages, Tunnel and DNS also
support account-owned tokens. The plugin reads active-token identity, matching
token policies and permission IDs from Cloudflare's catalog. Workers requires
Scripts Write plus CI Write; Pages requires Pages Write. Tunnel and DNS use their
own permission groups, and DNS verifies the selected zone and account. The
checklist includes token-policy read access and account identity read access for
Workers and Pages. The connected result reports enabled features.
Policy permission IDs and resources are evaluated
together, with relevant denies refusing connection. No provider mutation or
parallel credential owner is added. Zone-route/DNS admission remains separate.
Manual refresh rechecks authority, known expiry refuses materialization, and
remote token revocation stays on the documented vendor token page.

Vercel manual tokens and Cloudflare OAuth use identity and granted-scope
validation at setup; neither claims proof of effective write rights. Every
provider operation retains its typed missing-permission refusal. No role
heuristic or undocumented permission query replaces provider enforcement.
Cloudflare manual tokens retain the policy probe described above.

Cloudflare OAuth uses the same daemon attempt/configuration/staging owners,
the generic callback and required S256 PKCE. A configured registered public
client supplies exact API scope IDs; Cloudflare's authenticated global scope
catalog maps them to Account Settings Read and the supported feature permission
names. Only the exchange/refresh response establishes actual grants,
not that catalog or requested scope labels. After consent, the plugin lists
authorized accounts through the paginated provider API: one is selected
automatically, while multiple accounts produce a required named choice through
the existing configuration continuation. The exchanged grant remains in attempt
custody and reconciliation verifies the selected account without replaying the
code exchange. A retained reconnect account is preserved. Subject identity,
grants and exact account access must validate before settlement.
The existing credential owner settles
refresh replacements; expiry refuses materialization, revoked grants require
reconnect, cancellation cannot commit, and uncertain revocation is not replayed.
This adds no attempt, refresh scheduler, credential resolver or settings state.

In 0.3 development source, an established Connected Account invocation admits its
configuration and credential revision once, before its first callback. Later
callback and field fences read cancellation, occurrence retirement and observed
configuration revocation. A `materialize` result alone qualifies remotely again
before the credential leaves the host, and credential settlement keeps its own
revision check. A rotation during `status` or `quota` applies to the next call.

The 0.3 development Connected Account callback at
`https://app.happier.dev/oauth/connected-account/callback` and the unchanged MCP
callback share `connectedAccountOAuthCallback.ts` and one callback page. Capture
and query stripping run synchronously before credential-binding effects or
Action readiness. The page relays accepted OAuth response fields only to an
exact-origin opener, or uses existing same-Account authentication Actions to
read the exact attempt and complete it on its daemon. The state prefix is only
a routing hint; full state, issuer, PKCE and settlement remain with the attempt
owner. MCP keeps its service/message identity and retained return path through
a thin protocol adapter. Generic discovery reads exact attempts without
inventing a service selector. Signed-out, unavailable and unfinished callbacks
retain their full original URL for explicit paste; a denial never cancels a
guessed attempt. Neither the UI nor the built-in server exchange gains vendor
OAuth work. The public authoring example is in the
[Connected accounts guide](../apps/docs/content/docs/plugins/services/auth-connected-services.mdx).

In 0.3 development source, the host records sign-in provenance only from an
observed authentication success. OAuth completion and device authorization supply
that event; manual methods declare `credentialOrigin: 'authentication'` only
when their completion actually verifies authentication. Methods importing an
existing login declare `credentialOrigin: 'native_import'`. An older or unmarked
manual declaration leaves the original sign-in unknown. Neither reconciliation
nor credential refresh turns its observation time into a new sign-in.

Manual modes may declare `apiKey: true`; the public catalog preserves it as an
input to successful authentication settlement. The runtime may also return an
established `accessMode: 'subscription' | 'apiKey'` fact. The authentication owner
persists this optional fact in PresentationMetadataV4 and publishes it on account
and attempt projections. Credentials, account details and quota summaries consume
that metadata through one presenter-ready selector. An observed subscribed status
can fill unknown mode; explicit key metadata wins. Stored credential `kind`,
sign-in provenance, direct-save eligibility and missing usage do not establish
mode. Observed usage owns subscription status and plan labels.

Authentication attempt responses normalize released diagnostic aliases through
the existing Protocol ingress before publishing their service-neutral refusal
code. The original plugin diagnostic remains available for safe details; UI
recovery presenters consume the public code rather than recognizing private
service aliases.

Manual methods may separately declare `accountDirectSave: true` when their form
field ids/values already are the canonical credential payload, or
`accountDirectSave: { fieldKeys: { token: 'apiKey' } }` when only a declared
field-name projection is needed. The source fields and unique canonical keys
are validated by the same descriptor owner; this does not run arbitrary
transformation code. No daemon verification or configuration may be required
to save these values. The optional Account
`connectedServices.accounts.credentials.save` Action uses the existing credential
writer, legacy-compatible plaintext projection and Account-mode crypto without selecting a Machine or creating an
authentication attempt. Its applied receipt acknowledges storage, not provider
authentication. Machine-backed submission keeps the existing attempt contract;
Team `directExport` does not grant this Account-save eligibility.

The Codex and Claude token-exchange owners classify HTTP 429 and unsuccessful
server responses as `outcomeUnknown`, preserving the host's retryable health
path. Authentication rejection still requires reconnecting. Codex stages a
replacement access token only when the response contains a fresh `access_token`
or `id_token`; retained identity and refresh metadata cannot establish a fresh
access token.

Codex Connected Account native materialization uses one access-only serializer
for launch/resume homes and hot-auth persistence. It writes
`auth_mode: "chatgptAuthTokens"`; the required `refresh_token` fields are empty,
not copies of host-held rotation material. Rematerialization replaces historical
native credentials rather than sharing `auth.json` or `accounts` from the user's
Codex home. The app-server runtime registers `account/login/start` with external
access tokens before opening or resuming a thread, including after client
recreation. Its refresh request handler delegates to the daemon's existing
Connected Service refresh coordinator and lease/revision checks. An app-server
that rejects external auth produces `codex_refresh_free_auth_unsupported`, not a
refresh-bearing fallback. Qualified launch selections and predecessor local
selections normalize at the same plugin boundary; refresh-wire selections remain
local. Connected Account ACP launches also return that typed unsupported code:
the current ACP composer has no host-managed token-refresh bridge. Personal
native login and API-key ACP launches are unchanged. The canonical detached
app-server Run host provides bounded native-home reads and a Run-scoped refresh
callback through its materialization control channel. It shares the Session
host's refresh core and daemon authority, but carries no Session identity.
The daemon settles refresh only after updating the exact native home; Codex
decodes the access material through its existing host-bounded file reader.
Callback-less app-server hosts still cannot open a Connected Account thread.
Claude's native OAuth file contains access material, expiry, scopes and any
existing nonsecret subscription type/rate-limit tier, never a refresh token.
Those plan facts survive historical credential normalization and host-managed
refresh; native and Connected Account quota probes use one Claude plan resolver.
These are 0.3 development contracts, not a claim about older shipped
native materializations or already-running sessions.

Claude subscription recovery credits use the declared Connected Account
`recoveryCredits` facet. The host composes its read alongside quota through the
same admitted runtime lease and credential context; an undeclared field in a
quota response cannot grant recovery capability. Ordinary meters survive an
ancillary inventory failure, with sanitized diagnostics and no stale actionable
inventory. Claude's ordinary usage and reset reads share the plugin's HTTP and
native CLI identity owners. Version-aware readiness requests reuse the host's
canonical installed-CLI probe rather than spawning a plugin-owned version check.

Legacy reset RPC ingress maps the account alias and delegates to the established
qualified consume owner. It does not reopen scalar credential transport or retain
another debit path. Automatic requests carry the current exhausted provider-limit
identities and check them against fresh provider usage and grant applicability.
Manual requests use the same provider preflight. Named recovery keys include the
quota observation for later legitimate uses; explicit caller keys remain opaque.
Unknown debit receipts hold all further reset attempts for that profile through
the existing receipt lifecycle, including changed observations and manual actions.
Definitive automatic no-effect refusals do not block a waiting manual request or
a request for a different exhausted allowance: those requests re-enter the same
consume owner after settlement. Successful or uncertain debits remain shared.

Inventory status and count remain the sole action authority. Optional
`recoveryCreditDetails` supplies saved quantities, applicability and reasons to the
canonical usage projection; the existing supplemental-facet transport carries it
without expanding strict predecessor base bodies. These are development-source
contracts. The provider basis is the OAuth read/reset implementation in
[OMP at `ca18a903`](https://github.com/can1357/oh-my-pi/blob/ca18a903c5d7c946c26c728a66d3a9151f0c26b1/packages/ai/src/usage/claude-reset.ts).
Authenticated read discovery was verified; live redemption and provider request-id
idempotency guarantees remain unverified.

Connected Account quota results may carry a provider-declared `planLabel`.
The host snapshots the trusted SDK result and preserves it in the canonical
usage projection; external wire and persistence readers retain their schemas. An absent
plan is not inferred from limit sizes. Connected Services identity presentation
uses an assigned name, provider name or email, then a service-account label;
provider/internal ids are never automatic primary names. Historical id-valued
display names stay readable as a short secondary disambiguator when no human
fact exists. Codex's credential owner projects available name/email claims
from its existing id token during connect, status and refresh.

In the development Connected Services rail, bundled service titles come from the
same admitted declaration before and after the Machine projection arrives; that
identity fallback grants no execution authority. Saved accounts retain their
identity order as credential health settles, while their status, attention target
and counts continue to update. Assigned account names and newly published rows
remain live.

Connected Account quota limits carry optional `providerLimitId` separately from
their window `id`. The host result snapshot preserves that
family, and the quota projector uses it for pool allowance selection. Omitting
it retains id-based selection. Pre-turn pool probes use the same credential
eligibility predicate as candidate selection. Known-unusable members need no
quota probe and count as resolved; missing targets and failed probes still make
the group observation incomplete.

Quota limits also retain parsed labels, units, window durations, model ids,
scope and confidence through the SDK result and canonical usage projection.
Window presentation consumes those facts rather than interpreting provider ids
through another name classifier. Claude and Codex unsuccessful HTTP reads use
the SDK `QuotaFetchError`; the shared timing parsers preserve Retry-After and
provider reset evidence for the daemon's existing backoff. Claude's immediate
5xx retry is skipped when the response supplies a future provider retry boundary;
the final response, including a retried 429 or 503, preserves that delay without
adding a leaf minimum. The containing quota coordinator retains its own backoff
policy.

In 0.3 development, UI Usage acquisition currentness is owned by
`sync/api/account/usageQueryInvalidation.ts`. Retained qualified quota and
Provider Account Usage rows consume the existing Home persisted-usage change
wake, connected wake and foreground recovery through that owner. A change
received during a read or manual refresh is drained after settlement; read
failures retain their existing retry backoff and last-known-good presentation.
Observation aging updates presentation at its deadline without another GET;
native timer chunks preserve long observation and acquisition deadlines.
Qualified source admission and provider-record content remain separate
authorities, with Account credentials, encryption mode and Home generation
checked at their existing boundaries. Negotiated predecessor V2/V3 transport
retains its acquisition cadence because the 0.2 usage writer does not publish
these usage changes; its finite manual-refresh catch-up also remains.

In 0.3 development, daemon qualified-account health and quota work share the
existing quota scheduling loop when both are active. Health-only operation
retains the refresh loop. After initial health discovery, unchanged healthy
credentials park until their refresh deadline.
Claude and Codex established health and refresh results expose the known OAuth expiry
as optional `expiresAt` metadata (Unix milliseconds). The refresh coordinator
uses it with its existing refresh window even when the V4 profile listing has
opaque kind/expiry fields; a successful refresh supplies the next deadline.
Codex preserves numeric `expires_in` and otherwise reads the access-token JWT
`exp` as expiry metadata, shared with native import; this decoding does not verify
the token. A qualified quota resource 401 invokes the refresh coordinator once
through its existing lease and credential CAS, then repeats the quota acquisition
once after successful refresh. A repeated resource 401 stays a quota failure.
Codex refresh requires reconnection for token-endpoint `invalid_grant` (including
`refresh_token_reused`, `refresh_token_expired` and `refresh_token_invalidated`);
a bare HTTP rejection remains retryable.
An omitted expiry does not create a polling fallback. After the initial quota read,
known notice opt-out Accounts without an active group consumer wait for a real
quota reset or invalidation. Opted-in notices, active groups and unknown Settings
retain observation-freshness acquisition (60 seconds by default); that remaining
sampling is not zero-poll. Opted-in background usage alerts consume successive
live observations even without a Session; removing sampling requires an explicit
alert-policy decision or a real provider change signal. Canonical Account-scoped
Settings publications wake the existing scheduler when demand changes. The established runtime
owner prepares one exact credential/configuration pair for an account's due
status/quota work, without retaining it for later calls. Each operation keeps
its own fresh credential, Account and effect/disclosure checks. A credential or
configuration change rearms the existing deadlines rather than adding a poll.

Manual V4 Refresh commits its marker and an exact Provider Account Usage record
hint in the existing Account feed. The daemon drains that feed page by page and
delivers the hint before acknowledging its cursor; page length alone does not
invalidate unrelated catalogs or Collections. Reconnect and cursor-gap recovery
still invalidate the affected observations. Negotiated legacy transports retain
their existing cadence because their producers do not emit this refresh hint.

After credential settlement, the daemon checks the established runtime's actual
quota contribution and initializes an absent PAU source before returning
`connected`, without calling the provider quota API. An initialization failure
does not undo committed credentials; the existing quota owner repairs the source.
Before admitted qualified quota work enters the plugin, the daemon also creates
an absent source as `not_loaded`, with no fetched observation. Scheduled reads, group
probes and post-recovery refreshes share this admission/failure owner. A failed
read writes `error_last_known_good`, keeping prior meters and their observation
times; safe provider status/code and the existing retry time travel in optional
diagnostics. Failure rows cannot hydrate as fresh successful observations.
Explicit V4 Refresh admission checks the current executable quota leaf before
requesting server refresh. A missing leaf returns the existing typed unsupported
operation result; absent publication and retired runtime generations retain
their distinct unavailable results. Ordinary service discovery remains a cold
descriptor read and does not activate the plugin.
The UI distinguishes an absent observation from unsupported quota admission,
allows Refresh while capability is unknown, and shows localized failure/status/
retry information without displaying provider messages or headers. These are
0.3 development-source contracts, not proof of an already-loaded runtime.

The daemon quota coordinator has no implicit operation deadline.
`HAPPIER_CONNECTED_SERVICES_QUOTAS_FETCH_TIMEOUT_MS` opts into an explicit deadline;
operations already carrying a caller signal follow that containing operation's cancellation.
The daemon quota coordinator retains the latest in-band observation through retryable transport
failures using the shared scheduler's backoff; it has no implicit pending-age or
retry-count cutoff. `HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MAX_CONSECUTIVE_FAILURES`
opts into a retry budget. Non-retryable failures retain same-material suppression.
Same-account fanout indexes exact identity by the session binding lifecycle and
group generation, not a guessed age. Production fanout re-probes live identity;
an exact account mismatch always vetoes an indexed candidate.
The persisted-identity fallback uses the canonical session and qualified credential
readers without a shorter local deadline; unavailable or unfenced proof stays suppressed.

In 0.3 development source, refresh and quota coordinators share the purpose-binding
runtime's credential-free qualified-account inventory. The root daemon retains this
projection while its Account changes observer and plugin registry are current;
Connected Services hints and reconnect invalidate it before waking quota work.
Registry replacement and invalidation during a read prevent stale publication.
Requester contexts without that observer share only in-flight reads and otherwise
read fresh. Group-effect and credential admission still use their current authoritative
readers; this inventory is not an authorization cache or a second polling policy.

The same coordinators now return their next work deadline to the existing
single-flight loop. Initial admission, Account inventory invalidation, runtime
target registration or update, plugin reload and reconnect wake that loop; a wake during work
is retained until settlement. Quota observations select the next freshness or
provider reset boundary, while failed probes retain their provider-directed or
existing recovery backoff. Credential refresh uses token expiry and its refresh
window together with the existing external health-probe policy. An empty owner
parks rather than scanning on the former inventory tick. External acquisition,
credential leases and publication throttling remain separate policies. Loop
retirement detaches its wake subscriptions and joins current work. These are
0.3 source contracts; loaded-runtime performance is separate evidence.

Targeted feature composition uses public `defineContributionProtocol` / `defineContributionPoint` values and typed handles. A feature protocol keeps explicit versioned exports, validator-neutral schemas and source-neutral DTOs; it excludes host runtime, provider clients, credentials and persistence. The SDK's [`featureProtocolPackagePolicy.test.ts`](../packages/plugin-sdk/src/featureProtocolPackagePolicy.test.ts) owns the allowed dependency classification. [Triage sources](triage-sources.md) is one current consumer.

In unreleased 0.3 source, `happier.channels/providers` V1 requires the presentation
descriptor `{ v: 1, displayName }` through that same SDK mechanism. Its outer
schema is additive-open/drop; the required known fields remain strict. Channels
names providers from the admitted descriptor, with plugin branding as a fallback
when the surface has no descriptor. This evolves the undeployed V1 in place and
adds no provider registry or compatibility adapter.

### Project-native definitions (0.3 development source)

`definePlugin({ projectNativeAdapters: { localId: { declaration, runtime } } })`
projects one manifest family with contained file names and the implemented
`detect`, `resolveCommand`, `prepareToolchain` and/or `nativeServiceLifecycle`
roles. The ordinary `activate(api)` registration must match those declared
roles. Saved native commands and toolchain selections retain the qualified
plugin/local contribution reference; an installed occurrence is resolved at use,
not persisted into the project file.

A lifecycle-only Machine adapter declares `files: []`; it does not manufacture
a Project file or Workspace to receive native IO. Any declaration with a
Project detection, command or toolchain role still requires contained files.
This is a manifest V2 development-contract refinement, not a new contribution
family or a reverse-development-host compatibility adapter.

Passive detection receives readonly contained file contents and produces strict
definition references, coverage and diagnostics. It receives no execution,
credential or mutation service. Command and toolchain callbacks receive the
existing admitted `PluginInvocationContext` for managed-tool/native IO and
produce managed-tool references, arguments, cwd and review inputs. Toolchain
preparation returns the complete process environment, not a patch; the host retains
tool resolution, secret materialization, effect review, final authorization and
process custody. Native service lifecycle uses the existing managed-services
contract rather than another supervisor.

The development SDK captures optional `discover`, `start`, `restart` and
`accounting` callbacks on that same lifecycle. Discovery receives an exact
Home/Machine, not a fabricated Project; native-adapter failures stay typed and
unobserved accounting facts stay null. Registration does no native reads and
keeps absent callbacks absent. Host capture accepts an exact Machine target
without a Workspace root. A null instance captures adapter-wide discovery;
an instance-bound capture confines controls and accounting to that qualified
native identity. Workspace filesystem access remains unavailable in a
Machine-only invocation. The Machine Action/Resource consumers remain under
integration; this SDK contract alone does not establish their readiness or
built-in adapter availability.

The development Machine service row carries optional `nativeInstance`
(`adapter`, `nativeResourceId`) facts for an adopted native watch, including
retained intent whose adapter is unavailable. A current handle carries nullable
`baseUrl` and `port` facts from the same canonical endpoint-URL owner used by
supervision: one admitted service endpoint, not a complete listener inventory.
An unavailable watch omits those unobserved endpoint facts. These are pure
list/detail projections. An explicit list read samples each visible service through
its existing native accounting reader; it adds no polling. Optional row
`accounting.memoryBytes` is the total reported memory only when every replica
reports a value, and `accounting.startedAtMs` comes from the native start clock
(the newest member for a replicated service), never supervisor startup. Missing
counters and clocks stay absent. Optional `health.since` is a source-reported
transition: Docker health events supply their event time, while systemd supplies
`ActiveEnterTimestamp`. Docker probe-log times are not transitions; a missed event
or unavailable source timestamp leaves the field absent.

The development `machines.services.detail` result also carries optional
`runtimeFacts` from the selected native capture: `configuration`, `observedAt`
and `freshness` (`current` or `unavailable`), with optional native `accounting`
and `healthSince` facts used by the row projection. Configuration uses the same strict,
redacted service schema as deployment review, preserving every reported port's
`target`, `published`, `bindAddress` and `protocol`, plus its existing mount and
resource facts. Unavailable observations retain their last admitted facts and
timestamp; missing captures do not invent them. Lists carry only the configuration's port projection; detail retains the full
redacted structure for every Compose service, including services without a
healthcheck. Detail accounting uses the same explicit native reader as the list.
In 0.3 development source, Compose samples also carry optional nullable
`networkReceivedBytes`, `networkSentBytes` and `restartCount` per immutable
container ID. Network values are Docker CLI humanized lifetime totals decoded
to bytes, not rates or exact raw-byte measurements; restarts come from the
existing native observation for that ID. Missing values stay unknown and a
replacement invalidates the pending sample. Machine → Services → Usage and
`machines.services.detail` expose the same sample. Opening detail or choosing
Measure again requests it; this extension adds no background sampling.
A person's log page carries `secretMasking: 'incomplete'` when masking custody
is unavailable until redeploy; that notice is metadata, never a synthetic log
line. The existing automation refusal remains unchanged.

Current Machine Services Resources retain their last-known bytes across a
consumer remount through the existing Account-scoped Resource store. A resumed
watch confirms the retained digest; matching admission performs zero Resource
READs, while a changed or unavailable admission refreshes through the same
reader. Watch OPEN remains one separate subscription operation and does not
sample native accounting. Environment headers and Source names likewise retain
their existing controller/catalog values; hidden relevant changes mark them
stale without fetching. Credential replacement retires retained projections.

The same development service-identity owner accepts either the existing
deployment identity or an adopted watch identity (`kind: 'adopted'`, `machineId`,
`serviceId`, `watchId`, `watchRevision`). Infrastructure is a watch's purpose,
not another identity kind. C1 Machine-service pages retain the complete watch
revision for exact routing checks; occurrence identity excludes that mutable
configuration revision. Adopted pages have no Environment operand. Deployment
health, drift, logs and Environment launchers remain deployment-only; this
identity arm grants no access or mutation authority. These are unreleased 0.3
direct-cut shapes, not a claim that older strict development readers accept
new fields or identity kinds. Existing detail results without `runtimeFacts`
and existing deployment identities remain accepted.

The first-party Machine services source declares `happier.machine.services/systemd`
through this same family and activation ABI. On Linux, explicit discovery reads
visible user and system service units with finite
[`systemctl list-units`](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html) calls;
inspection reads `LoadState`, `ActiveState`, `SubState`, `MemoryCurrent`,
`ExecMainStartTimestamp` and `ActiveEnterTimestamp` in the same `show` request.
Unknown counters and unparseable timestamps remain absent. The adapter maps those facts conservatively to native phase and
readiness: active liveness alone does not establish application readiness.
Discovery preserves a healthy manager's candidates when the other manager
refuses its query. Watch and unwatch change retained intent, not native state.
User-unit start, restart and stop run as the daemon user with
`--user --no-ask-password`; system-unit mutations return unsupported until an
actual host elevation admission exists. Other native platforms return typed
unsupported results. Row counters come from `show`; a separate accounting
callback is not advertised. Source
declaration alone does not establish bundled publication or loaded availability.

The unreleased `machines.services.control` Action consumes the mounted native
service owner by exact Home, Machine, service id and generation. Its approval
scope is the owner's Environment for deployed services, or Machine for adopted
services; caller fields cannot substitute a different scope. A person's direct
UI control uses the shared direct-gesture policy, while automated callers keep
the default Ask policy. Environment controls additionally require current
deployment permission. Native effects retain the host Action operation receipt;
reported unconfirmed native-process settlement is an unknown outcome, not a
successful stop. Native Stop preserves the adapter's stopped, accepted,
unsupported or termination-incomplete outcome. An accepted receipt identifies
the Action operation without claiming an observed stopped state. Observation
retirement does not erase an admitted effect's settlement: withdrawn read
authority suppresses service state and generation, returning only the opaque
operation receipt. New effects and reads still require current admission.
An unknown receipt retains the same operation's uncertainty; it does not
authorize automatic retry.
LocalServices Environment rows use this same Action from the launcher's admitted
occurrence witness. The unpublished legacy LocalServices stop/restart path is
Workspace-only: Environment targets are refused before nonce validation or any
native effect. A manually submitted legacy Action can still reach its generic
Ask policy before the daemon resolves that target; it does not gain control
authority. This direct cut adds no compatibility alias or second native owner.

In 0.3 development, the exec host applies `HAPPIER_PROCESS_OWNER` after all
plugin/native/Provider environment layers. Plugins cannot override or unset this
host-private marker; child ownership is resolved by the canonical daemon process
owner, not a plugin process registry. See [machine processes](cli-architecture.md#machine-processes-03-development).

Public invocation exec `run`/`spawn` options in 0.3 development source include
`descendantDisposition: 'preserve-on-success'` for native commands that daemonize.
The existing process supervisor hands off descendants only after an unrequested
root exit with code zero; later disposal or invocation retirement settles the
handle without stopping those descendants. Cancellation, timeout and disposal
while the root runs, and unsuccessful exit retain tree termination. Omission or
`'terminate'` preserves ordinary supervision. The native tool owns subsequent
stop/delete; this does not establish a host-managed service or release native Job
custody. Preserved launches do not inherit `HAPPIER_STACK_*` lifecycle markers:
those identify the spawning Stack daemon, not the native supervisor. They retain
their own POSIX session/process group and use the existing Linux native scope
escape so a daemon unit's control-group stop does not own them. macOS uses the
POSIX detachment; Lima is unavailable on Windows. Lima selects this disposition
for `start` and `restart`. Cua selects it for embedded local sandbox/Space
creation and local sandbox resume, whose runtime can start a background QEMU.
Stop/delete, observations, cloud calls and guest IO stay supervised.
Native daemons must redirect inherited streams so captured output can close.

A resolved native command can return `nativeInstance` using the existing
managed-services `{adapter, nativeResourceId}` shape. The selected adapter must
declare and register `nativeServiceLifecycle`, and the identity must match that
selected contribution. Only service usage accepts the witness; finite script
or setup resolution refuses it. The service owner captures the exact lifecycle
from that same lease and passes the instance to existing native supervision.
This witness identifies the resource; it is not a stopped/readiness fact and
does not turn launcher exit into native resource settlement.

In the development SDK, `ManagedServices.supervise` accepts an owned spawn with
`endpoint: { kind: 'none' }`. Its snapshot can be `running` with no URL: the host
does not allocate a port, invent HTTP health or publish a preview address.
Declared command health remains available; without health or reported native
readiness, `waitUntilHealthy` returns typed unavailable. HTTP requests require
an observed, validated endpoint. Existing HTTP spawn and attach modes retain
their endpoint and health contracts.

In 0.3 development source, declarative launches of a plugin's own system tools
use its invocation-bound system-tool resolver, including an Agent's selected
managed CLI or override. Local and same-plugin qualified references consume
the same launch, environment and argument policy as `exec.systemTools.resolve`.
An unavailable selection refuses the launch. Foreign-plugin tool references
retain their qualified executable resolver; retained physical Provider launches
and runner-preauthorized launches retain their existing custody owners.

In unreleased 0.3 source, omitting `startupTimeoutMs` and the healthy-wait
`timeoutMs` leaves establishment pending for the owning lifetime; the host does
not inject a startup deadline. An explicitly authored startup deadline also
applies to the default healthy wait, and an explicit healthy-wait deadline can
override it. Endpoint discovery retires on caller cancellation, actual process
exit or observation failure, or that authored deadline; a late OS scan cannot
publish into a successor attempt. Per-probe health budgets and watchdog policy
remain separate from the lifetime of establishment.

Managed HTTP requests have no implicit deadline when
`ManagedServiceRequest.timeoutMs` is omitted in 0.3 development source.
An explicit request deadline bounds validated response headers. Admission is
the natural authority boundary for a finite request: credential or scope
revocation refuses its successor without cancelling admitted response work.
Caller cancellation and explicit Stop or disposal still end the request.
Open-ended event subscriptions set `interactive: true` and additionally close
with the existing scope and handle retirement signals. A native prompt that
waits for inference is ordinary request work, not server startup; the host
transport disables inherited header and body deadlines rather than imposing
a five-minute cutoff on that turn. Node retains Undici's default connection
establishment budget, including TLS negotiation; Bun retains its native
transport behavior. Transport failures retain their original exception as the
typed error's non-serialized cause; request
bodies and credentials are not added to its public diagnostic data.

The managed endpoint transport carries that finite/interactive choice through
HTTP open; next-read consumes the admitted response without repeating policy
checks. Concurrent endpoint reads and durable endpoint
projections remain under their admitted lifecycle owners rather than a global
stream or projection census. Native process-assignment acknowledgement consumes
the process-custody owner's handshake budget and caller cancellation.

Managed Provider contributions may opt into `sharing: 'connectionMachine'` in
unreleased 0.3 source. This selects the incumbent daemon managed-services and
process-custody owner, not a plugin-owned supervisor or public lifecycle API.
The managed-service request-auth union has a
`connectedAccountConsumerAccessPath` arm for a host-owned consumer-access
document. Each opaque consumer token selects one exact admitted request-auth
capability and qualified-purpose set; neither the document nor the physical
management bearer grants combined inference authority. Plugins retain their
ordinary `activate(api)` registration and scoped Connected Accounts services.
An admitted broker operation without a Provider Connection uses this same
consumer-access mechanism within its existing operation scope; the document
does not itself authorize connection-wide process sharing or retained-source
custody. Connection-backed consumers still require their admitted shared
gateway placement.
Providers without that sharing declaration retain their existing custody.
See [managed gateways](providers.md#managed-subscription-backed-gateways) for
consumer settlement, recovery and the personal Account broker boundary.

The 0.3 development native lifecycle's optional `logs` method has read and watch
overloads over Protocol's closed bounded `page | source-changed | unavailable`
result. The same supervisor read path serves explicit service log demand and
new failure diagnostics; healthy or equal observations do not read logs. The host
supplies its incumbent diagnostic byte budget and sanitizes before disclosure.
An unavailable result may carry a closed qualified `recipeRemedy` reference for
the existing setup review flow. It carries no inputs or approval and must never
cause automatic setup or elevation.
Machine-native journal follow consumes metadata-only `fs.observeMachinePath`
for valid native paths in a Machine-native invocation. Manifest locations are
disclosure metadata. The existing filesystem invoker owns path/currentness
admission and shares the host file watcher;
guarded metadata reads and awaited disposal add no content or write authority.
The journal adapter still owns bounded export parsing, native source revision
and redaction. Generic `PluginPath` and command cwd do not gain Machine access.
Compose captures retain immutable admitted container ids, report a source change
after member replacement and consume the generation's P42 redaction lease.
The supervisor owns current-generation checks and watch cleanup: retirement
suppresses late bytes and joins disposal before releasing the native capture.
The Machine logs Resource binding and original-Account follow transport are implemented
in development source, with composed plain/E2EE approval and watcher-lifetime coverage.
Bundled native activation and the loaded-daemon user journey remain separate from that
source evidence. This primitive grants no approval or Account read authority: front doors
must use the existing logs Action's actual-owner scope and current captured Account
before native IO. See the [public log example](../apps/docs/content/docs/plugins/guides/background-services.mdx#read-bounded-native-logs-in-development).

The native mode names a qualified adapter and exact `nativeResourceId`, alongside
the starter launch. Inspection reports native phase, readiness and an optional
loopback endpoint independently of the starter's exit. Native lifecycle is
daemon-owned; the Session runner custody bridge refuses native supervision with
typed unavailable instead of encoding an unsupported transport arm. Unsupported
Stop, accepted-only Stop without definitive inspection, and unknown or incomplete
termination retain custody. The public handle reports these failures through
typed errors rather than returning `stopped`: unsupported native Stop reports
`plugin_managed_service_unavailable`, while accepted-only or incomplete Stop
without a definitive stopped observation reports
`plugin_managed_server_termination_incomplete`. Local Services controls preserve
that distinction in their result and audit `reasonCode`; see
[runtime custody](runtime-core.md#managed-service-custody-03-development).

Host consumers call the selected lease's `resolveCommand(request, options?)`
and `prepareToolchain(request, options?)`, not the author callbacks directly.
The incumbent invocation owner binds the exact occurrence, source custody,
admitted Project workspace and invocation lifetime, then
settles that lifetime after the awaited result. Only passive detection remains
on the lease's runtime view. The incumbent managed-service admission captures
`captureNativeServiceLifecycle(instance)` while that occurrence is current.
Inspection remains currentness-checked; Stop retains only that exact adapter
and native resource after retirement so the existing supervisor can settle it.
An accepted-only retired Stop remains typed termination-incomplete and retains
custody. When the adapter becomes current again, existing Project-owner recovery
inspects the exact resource through the current lease before replacement or
control retry; only a definitive stopped witness settles native custody.
Retirement cannot admit a new service or transfer the captured Stop capability
to another native instance.

The existing lifecycle manager demand-activates the selected contribution and
checks admission/currentness after activation and awaited results. Removed or
retired occurrences refuse invocation without rewriting saved references or
falling back to a built-in adapter. `toolchainApplied` identifies the exact
toolchain selection already applied by native command semantics, including
its configuration path; executable names are not activation evidence. These
are development-source contracts, not released availability or proof of a
completed final-launch journey.

### External Saved Secret sources (0.3 development)

`secretSources` is a manifest-backed daemon contribution on the existing
`definePlugin` / `activate(api)` registration ABI. Its cold declaration contains
the local id, title, and optional capabilities derived from runtime methods.
Its runtime exposes asynchronous `acquire({ account, reference }, context)` and
optional `list({ account, vaultId?, itemId? }, context)` and
`store({ account, vaultId, title, value }, context)`. The executable registry
keeps `secretSources.list()` as cold declaration discovery and dispatches native
enumeration with `listFields(...)` through the same exact-demand registrations. Listing returns
only vault/item/field names, identities and kinds. Its successful result is
`{ ok: true, fields, vaults? }`: the independent `vaults` metadata array includes
empty destinations for Store-in and export. Field-only plugins remain supported;
the picker derives their destinations from fields at its existing read owner.
The 1Password source uses `op vault list` independently of item enumeration.
Store returns an Account and
field reference; it never returns the written value. The SDK's public schema
and activation ABI also serve external plugin authors.

The existing `secrets.list` Action exposes Saved Secret names and metadata,
plus optional native field discovery when the person selects a source. UI source
options retain their installation Machine identities; the vault choice hook carries
an explicit Machine selection, or the source's sole installation, into both list
queries and store/export targets. Multiple installations require an explicit selection.
Bulk
`secrets.link` creates one SavedSecretResource per external field in one
`secrets.shared.promote` transaction. A whole-vault selection expands to that
same batch; it does not create a second vault resource or discovery model.
The optional `storeIn` on `secrets.create` and confidential Remember writes to
the selected vault before creating a resource containing its reference.
`secrets.export` uses the existing resource storage-conversion writer: store
first, then compare-and-swap the original revision to an external source.
Each failed export leaves that resource unchanged and returns a typed outcome;
selected exports use the same operation. No separate host registry or model
Provider is introduced.

Saved Secret admission acquires external material through the already-held
executing runtime's source projection. Values remain operation-private and do
not enter the Account catalog snapshot. The 1Password leaf uses captured native
`op read` output and returns closed unavailable/repair outcomes for missing,
locked, denied, absent-field and cancelled reads. It adds no value cache, poll,
retry or timeout. Its optional service account token comes from an inline Saved
Secret linked to its existing declarative plugin setting; the canonical secret
read owner enforces `sourceKind: 'inline'` before native acquisition. The token
is supplied only in the invocation command environment. Native enumeration
projects metadata from `op item list` / `op item get` JSON. Writes use managed
exec argument arrays and `op item create -` with a JSON template on stdin;
secret values never enter argv. A vault write whose response is lost may leave
an orphan vault item: the operation reports uncertainty and never replays it.
Connected-account configuration `secretRefs` keep their identity through
export and acquire live material at use time, including typed vault repair.
OAuth credential records with rotating refresh tokens stay in Happier and
are outside this conversion flow. These are unreleased
0.3 source contracts; package publication and native tenant QA remain separate
evidence.

### Capture viewing and Session images (0.3 development)

Browser and Computer recording share `apps/cli/src/daemon/recording`: lifecycle,
stream encoding, Session-media persistence, retention and attachment. Computer
supplies its existing registered screen source and target identity; Browser
supplies its view-specific admission and frame adapters. Additive
`computer.recording.*` Actions use Computer capture consent and Session media
custody, while shipped `browser.recording.*` contracts remain unchanged. Recording
start requires a Session-bound Computer source and a media target in that Session.
The shared media host resolves the workspace and commits the attachment using
the admitted requester’s Account and Home, including a Machine Use grantee’s own
Session. Capture retains that private custody until its recording reaches a
terminal state; credentials never enter recording records or Action input.
Browser starts may omit the optional media target: the runtime uses the invoking
Session (or the Browser Session for direct runtime calls) and recording ID as the
message local ID. An explicit media target keeps its existing meaning. Missing
target input does not change the canonical recording feature decision.
An unavailable encoder returns the shared recording unavailable result rather
than starting another recorder. No recording work runs while idle.

Manifest-owned `captureSources` register through the same activation rights and
occurrence lifecycle as other executable contributions. The existing daemon
capture registry owns exact sources and retirement; replacement aborts viewers
of the old occurrence. Capture-only plugins stay dormant at ordinary daemon
startup unless they explicitly declare startup activation. Resolving a declared
source activates its existing occurrence on first real capture demand; an
undeclared source never activates it. This applies to installed external plugins
as well as first-party contributions. The mounted UI binds a typed reference to
its own plugin, machine, server and lifetime. Plugin authors never choose a transport address.
Viewing another plugin's source is refused. Each host-source viewing requires
the existing `capture.view` Action's blocking approval, unless the user has
waived that approval for this plugin in the existing Actions settings document.
A plugin's own declared source needs no additional viewing consent. Viewing
does not transfer input or takeover authority.

Native Computer sources use the same Machine capture registry, Session selection
and control owner as the shared Browser/Computer viewer. A provisioned graphical
guest is an ordinary enrolled Machine; its provider cannot grant viewing or input,
select a display, wake the guest from a passive viewer, or supply a second viewer
transport. The source owner validates the exact window/display identity and
capture geometry before pointer input. Source removal or current Account access
refusal retires the UI's selected source and control projection. OS capture
permission loss withholds pixels and input while retaining the owner-confirmed
share and its Stop sharing control; opening a privacy settings page does not
grant either OS permission.

Capture and input readiness are independent current native facts. On macOS these
correspond to Screen Recording and Accessibility. Picker enumeration and the
retained source's `computer.control.status` read supply their observed state;
control refresh does not request picker thumbnails. Unknown grants refuse the
affected operation. Whole-display selection remains explicit and the existing configurable
approval presents its consequence: other visible apps and notifications are
included. Registration, target-schema membership and native archive availability
are not evidence of a usable screen. The current pinned native contract qualifies
only the logical primary display; it does not supply arbitrary physical-monitor
identity or verified confidential field delivery. Native secure fill therefore
retains `field_verification_unsupported` until that producer is qualified. See
[binary runtime](binary-runtime.md) and [Computer Actions](actions.md) for the
development native support and admission contract.

For stored images, public `StoredImageRefV1` carries the canonical native
Session-image reference, including required file facts. References may survive
surface remounts or be handed to another plugin; Action-result delivery and
mount-local membership do not grant or restrict image access. The daemon
rechecks the current caller plugin occurrence and the host's actual Account and
Session authority, without a manifest `sessions` scope veto. The Account mode must agree with the
media representation before bytes are disclosed. The existing linked-Session
UI scope is intentionally not an image-read authority. Thumbnail ingress
accepts strict file-backed native image artifact references,
including those in Session-event and contributed Action results. The mounted
host and component preserve cancellation and reject retired disclosures. Producer
identity is not another permission gate: the daemon's existing artifact
verifier confines reads to the authenticated Session's exact bucket and real
path, then verifies size, digest and image encoding. Generated-media publisher
status/items are a distinct shape, not a native artifact reference. The app player and
thumbnail are bindings over Plugin UI's shared presentation; transport,
decoding, media verification and approval remain host-owned. These are source
contracts, not evidence of package publication or a loaded-platform pass.

Artifact preview cards, HTML reading frames, public-link cards and revision
lists likewise have one presentation owner under Plugin UI's `/presentation`
entrypoint. App bindings supply localized text, typography, theme facts and
typed rendering leaves. Artifact loading, authenticated publication, fragment
secret custody, audit reads and revision restoration stay with their existing
host owners. The shared HTML frame owns geometry and loading/error presentation,
not sandbox admission: the app retains isolated-URL validation, credentialless
web framing and private native WebView/navigation policy. These are 0.3
development source contracts, not evidence of publication or live visual parity.

Caller-authored HTML in 0.3 development uses only `ArtifactHtmlBundleV1`,
including the Session Board's `hostedHtml` source and its entrypoint editor.
The protocol's `artifactHtmlDocumentV1` owner resolves declared local resources
and builds the document and admitted-policy CSP for both hosted surfaces and
Artifact readers. The app wrappers provide mount bootstrap facts; they do not
maintain another HTML parser or document policy. Legacy `text/html` Artifact
ingress normalizes to a one-file bundle at publication. Directory publication
declares an entrypoint and uses the existing workspace-file acquisition owner,
with confinement, symlink refusal and cancellation. Native frame transport
loads process-local bytes through an isolated URL rather than submitting an
expanded document to a WebView2 HTML-string API. Network requests use the admitted
effective policy (none, exact origins or open); a requested origin is not a grant.
Caller native responses carry `Content-Security-Policy: sandbox allow-scripts`;
the guest's opaque origin does not grant bridge admission. Android admits only
the current registered document URL in the active view's main frame, then the
existing host bridge validates the mount nonce and identity. Its caller-only
wildcard injection leaves installed-plugin origin policy unchanged. Native
WebView enforcement and callbacks still require device validation.

Each finite caller-hosted Action or Resource read is admitted when requested.
An admitted read may finish across an unrelated projection refresh or authority
withdrawal; the next request uses the current authority. Caller cancellation or
physical mount disposal still aborts delivery. Open Resource watches retain
their revocation and disposal lifetime.

Caller documents with a mounted bridge receive the SDK's existing guest client
before authored scripts. `packages/plugin-sdk/scripts/buildHostedHtmlGuestBootstrap.mjs`
derives its self-installing browser form from source. SDK `build:compiled`, also
used by ordinary workspace/UI dependency preparation, regenerates this payload
before compilation. A complete SDK typecheck generates it once before its source
and test compiler passes; standalone source/test checks still prepare it. The
writer atomically replaces changed bytes only. The separate `generated:finite` CI lane verifies committed
projection currentness with `check:hosted-html-guest`.
The injected guest and SDK-authored bundles share one controller per browsing
realm through the non-enumerable, immutable
`Symbol.for('happier.pluginUi.hostedWebGuestController.v1')` property on that
realm's global. The first installation owns ready, the document port, bootstrap
and retirement; later SDK copies attach without sending another ready. The
guest transport owns opening Host API negotiations per requested semantic range.
Concurrent or later clients with the same range share that range's reply. Different
SDK generations negotiate separately over the existing document port; the bridge's
request sequence delivers each reply only to that range's clients. An uncorrelated
negotiation reply retires the controller. Invalid addressed negotiation results
settle as `invalid_negotiation` rather than leaving the client pending.
In 0.3 development, the host selects the oldest supported semantic generation
matching the requested range: an installed `^1.0.0` client receives exactly 1.0.0,
while the current SDK requests `^1.1.0`. The Protocol-owned method introduction
facts project each reply's method set; 1.1 adds `actionControl`,
`openManagedMachineConfiguration`, `openDeployment` and `openResource`. The latter submits a typed
resource intent to core's Account preference, contributed-handler selection and
external-URL fallback; plugins do not choose that opening policy. The method-free pre-negotiation bootstrap
retains its 1.0.0 shape. Semantic version is a per-client representation and
advertisement fact, never a dispatch grant. The document's installed methods
intersected with transport support and its mounting ceiling remain the one
request/subscription authority, including after ready and before negotiation.
Because current presentation and older authored SDKs share one wire identity,
the latest client's range must not narrow a sibling's installed operations.
Withheld methods and unknown wire or operation payload fields remain refused.
Wire epoch 1, mount identity and installed-handler
authority are unchanged. A 1.1 wire negotiation request reaching a 1.0-only
Host API receives `incompatible_api_version`; there is no silent downgrade.
An older host's injected single-range controller can instead refuse a later
1.1 client locally after its presentation client negotiated 1.0. Safe refusal
is retained; that historical controller path is not covered by the direct-wire
typed-reason guarantee and can surface `transport_unavailable`.
The same guest delivery seam projects `context` results and registered
`watchContext` events for each client's negotiated generation. Protocol owns
the presentation projection: 1.0 omits the later optional theme `statusTint` and
destination mount `instanceKey`, whose closed installed readers reject them;
1.1 retains both.
Resource results and observations, even with context-shaped JSON, are not
context presentation and remain unchanged. Existing mount identity, target,
Account scope and execution-readiness facts remain unchanged by this projection.
Host API request/subscription correlation also uses a realm-wide sequence at
the non-enumerable `Symbol.for('happier.pluginUi.hostApiCorrelationSequence.v1')`
slot, rather than a counter in each SDK copy: operations in the same clock tick
must not collide on the shared transport. This private counter does not carry
mount identity or admission authority.
In 0.3 development source, UI `executeAction` and `openNewSession` accept an
optional caller `requestId` for that existing envelope. The SDK otherwise mints
it as before. This is correlation only: an admitted daemon operation can be
looked up with the public `action.operations.list` `requestIdentity` filter
(`actionId` plus `requestId`) through the existing V2 operation transport. A
mounted plugin may omit both Home and Machine only for this exact-request
lookup; the Action's plugin input binding supplies its captured runtime target.
Fully qualified calls and the existing state, Session and cursor filters remain
available. Bulk Triage Stop uses the returned operation id with the existing
`action.operations.cancel`. An operation not published by the one lookup is a
visible unavailable result; the person can retry Stop. There is no polling or
broader operation matching. Prepared New Session requests correlate the selected
source Action, rather than the semantic navigation method.
V1's private cross-copy contract is `awaitReady({ signal? }?)`, returning the accepted
`PluginUiHostApiClientBootstrap`. Its private
`Symbol.for('happier.pluginUi.hostedWebGuestAccountData.v1')` bootstrap property
is a live zero-argument transport lookup: presence identifies hosted Data
admission, and an undefined result means Data is unavailable. Both carriers
remain non-enumerable and outside public RenderContext and the wire. SDK copies
using these V1 contracts interoperate independently of package version;
incompatible carrier semantics require a new versioned key and an explicit
transition. Pre-contract authored bundles must be rebuilt; the unreleased
module-local registry is not retained as a compatibility owner.
The generated string works in both Metro/Expo and native document transports
without fetching a script or compiling one at runtime. As on plugin surfaces,
`context` is baseline presentation and `watchContext` is advertised when the
transport can push, even without an authored capability request. Other methods
remain request-intersect-admitted/approved, with network policy unchanged.
Caller presentation uses
the existing context/watch transport and `themeCssVariables.ts` mapping, reports
intrinsic height with `ResizeObserver`, and forwards trusted HTTP(S) link activation
through the existing browser external-open channel. Native WebViews retain their
gesture-validated navigation handoff instead: native bridge messages carry no
transient-activation receipt. The caller adapter enables these existing link
paths without adding a Host API method. Retirement removes those listeners
and observers. This changes neither the caller host-method ceiling nor admitted
network policy. Unbridged public Artifact documents consume the same document
producer without receiving authenticated host authority.

Public authors consume `ArtifactHtmlBundleV1`, the bundle convenience/document
helpers and producer-derived `PluginUiActionInputFor` through
`@happier-dev/plugin-sdk/ui`. Session visual creation uses the existing
`session.board.item.upsert` Action (transcript by default); Pin/Unpin uses the
same item through layout operations. The external-author source fixture at
`packages/plugin-ui/fixtures/external-authoring/src/sessionVisuals.ts` exercises
these contracts without host imports. Shared presentation remains in public
Plugin UI: U4 owns `StackedSeriesChart`, U5 owns Usage widgets and `usage.query`,
and Protocol owns declarative chart admission/freezing. The source fixture also
authors a typed multi-series chart through the same surface/item Action input;
transcripts and Boards consume that admitted document and shared renderer. These are current
0.3 development contracts, not publication or loaded-platform QA evidence.

Notification channel authors must account for the development sender signature's
[optional-category migration](compatibility.md#notification-channel-sender-source-migration-development)
when upgrading a category-dependent sender; the plugin send service and host
Activity path have distinct category contracts.

In 0.3 development source, `services.notifications.send` accepts `type` without
`itemId`. The existing attention policy evaluates that type; the sender retains
the supplied routing data, but creates no Account notice. Both parsed admission
and replay identity retain the type. `page` and `resolved` still require
`itemId`; adding either without notice identity is invalid. Supplying `itemId`
continues to use the existing notice custody and delivery policy, not a second
notification path.

In 0.3 development source, `itemId` sends return an optional acknowledged
`notice: { artifactId, changed, opened }` from the same C1 writer. Only a
successfully committed new/recovered opening reports `opened: true`; evidence
updates, equal writes and replay report false. This is an ephemeral result,
not a delivery queue or an authority grant. Enrolled plugin health notices may
carry `healthPhase: 'open' | 'recovered'` through that writer, sharing the host
health recovery/read lifecycle. Ordinary plugin notices omit the marker and
use the ordinary open/resolve lifecycle. Source-local automatic Investigate consumes that
acknowledgement and current source admission through the existing configured
Triage Action; it adds no Session launcher or Account setting.

The C1 store separately decides a push-worthy transition from its committed
notice: a new opening, or an open ordinary notice changing from a quiet type to
an actionable type under the existing Inbox attention policy. Thus a deployment
changing from `update` to `approval` can push once while `opened` remains false.
Equal re-deliveries and evidence-only updates do not push. The host consumes
this internal receipt; producers do not decide the transition. Channel settings,
quiet hours and health recovery retain their existing delivery policy.

The same C1 record may retain one optional, closed `investigation` alertEntry
operand: a bounded source-qualified entry reference and target-minted configured
source instance UUID. Its sender plugin must match the notice source. The
operand is paired in the existing header/body and contributes to send replay
identity. It supplies no native push routing. The Inbox data owner passes it to
the same configured Triage Action after current Account/ownership admission;
Session, Agent, placement and permission decisions remain with that Action.
Stored readers accept absent operands, older readers ignore the extra top-level
field, and readers recognizing it reject unknown nested routing fields.

In 0.3 development source, a default plugin notification send also joins the
host Activity dispatcher's configured native push channel. The same attention
policy selects needs-you push, quiet updates/mentions and quiet hours; explicit
`channelIds` continue to select only those contributed transports. A stored
notice pushes its admitted Artifact/page reference. Its default tap opens the
same page as the Inbox, after saved Home and Account admission, and never
submits a decision. Plugin notification categories may declare their own
`buttons`, each with an arbitrary nonempty `id`, a localized `label`, and a
closed shared declarative `effect`: `{kind:'open', page?}` or
`{kind:'action', invocation:{action:{pluginId,localId}, input}}`. Button ids are
unique within a category. The Action binding admits strict Protocol JSON,
including null, scalar, array and object inputs; it carries no execution
authority. Notification manifest admission requires the Action and any page
reference to belong to that plugin's declared contributions. Generic consumers
of the shared binding retain their own reference-admission rules.

Native category ids and button identifiers are plugin-qualified. The native app
projects the committed shell category catalog and resolves labels through the
existing plugin translation runtime; catalog, active-language and relevant copy
changes refresh registration. Unrelated projection arrivals do not rescan or
rewrite categories. These foreground controls do not reuse the Session-permission
Allow/Deny category or its background execution owner.

`services.notifications.send` may supply `buttonInputs`, keyed by a declared
Action button id, to replace that button's default `invocation.input` for one
notification. It cannot choose another Action, button, label or effect. Those
operands enter the native push payload and must contain no secrets or
credentials. A changed override under the same `clientRequestId` conflicts with
the already-bound send, like other changed notification content.

A press re-admits the saved Home and Account, current plugin occurrence and
declaration, then invokes the canonical Action front door with the viewer's UI
authority and the Action's normal input validation and policy. A press requiring
interactive approval or unavailable execution opens the notification's exact
page for review; it does not synthesize a prompt or bypass approval. Cached launch
responses remain navigation-only. The target Action's own revision/currentness
contract protects consequential stale or repeated requests; the button supplies
no additional authority or global exactly-once guarantee. These are Developer
Preview source contracts. Signed iOS/Android device delivery and OS presentation
remain release checks.

Typed push-only sends retain no `itemId` and create no notice. For a bound
Session, obtain `const session = await services.sessions.get(id)` and then
`const address = (await session?.summary())?.address`. This is the optional exact
`{sessionId, serverId, serverUrl}` projection. The existing authorized Session
reader supplies the Session; its captured Home feature observation supplies
portable identity and its public Home URL supplies routing. The local HTTP
carrier and a plugin connection's transport identity supply neither. Missing
Home identity or an unroutable public URL omits the address while retaining the
Session summary. Native delivery re-admits that exact Session under the captured
Account and suppresses only push when its destination is unavailable; it does
not copy or retire the plugin's live source. This describes source contracts,
not signed-device delivery or SDK publication evidence.

## GitHub checks observation (development source)

Automation Event catalog-status summaries are qualified by Account, plugin,
reporter Machine, Machine-local materialization id and observation scope.
Bundled `daemon-selected:<pluginId>` materializations on different Machines keep
independent summaries. The current watcher/endpoint target selects the visible
summary; fresh installation and materialization admission still precedes writes.
Equal semantic reports do not advance revisions or publish Account changes.

In the 0.3 development source, the Account change-feed projects a content-free
`@happier/automation/event-sources-invalidated` Host Event through the existing
SDK Events broker. Automation definition changes and completeness recovery wake
the GitHub observation owner; source-status reports do not feed back into catalog
invalidation. A healthy empty pull catalog parks rather than taking a periodic
census. Provider eligibility and failure-recovery deadlines still drive explicit
pull/check observations. Explicit source-list Actions remain authoritative;
provider cycles use the observer's already adopted catalog until the producer
invalidates definitions.

Exact `SessionHandle.watch` observations also wake on AgentState revision changes
(including permission-only updates). A failed retained read keeps its frontier
and retries at the Session observation owner's recovery cadence; successful
reads return to event-only waiting. These source contracts do not establish
loaded-runtime or performance validation.

In 0.3 development source, plugin `sessions.watch` inventory subscriptions share
one demanded projection per authenticated Home and credential. The existing
requester Account observation owns its socket and change-feed cursor. Session
changes read only their exact identities; activity pushes update runtime
availability directly. Initial capture, reconnect and cursor loss rebuild one
shared snapshot, preserving unchanged row identities and the public filtered
snapshot/upsert/remove events. Settled watches install no inventory timer or
periodic currentness read. The final watcher releases the projection. Disclosure
still checks the occurrence, captured credentials and live Account encryption
identity; Session reads and effects retain their existing admission owners.

The `scm-github` plugin extends its existing Automation observation owner with
pull-request checks completed, failed and passed Events. Setup binds an exact
repository, pull-request number, chosen head SHA and `all`/`required` selection.
The current GraphQL rollup uses GitHub's `isRequired(pullRequestNumber:)` evidence
for both check runs and commit statuses; it walks every page before deciding.
See GitHub's [Checks](https://docs.github.com/en/graphql/reference/checks) and
[Commits](https://docs.github.com/en/graphql/reference/commits) contracts.
No checks is explicit, not success. Completion may include failed or neutral
checks; passed requires every selected check to pass. A moved head supersedes
the observation instead of accepting green checks for another commit.

For retained Session PR bindings, the 0.3 development Channels poll reconciles
native state against its admitted endpoint baseline. Equal state retains its
semantic observation time and endpoint identity; a successful poll's clock
alone does not revise the binding. Checkpoint progress remains separate and
captured checkpoint/binding revisions fence obsolete results. Disabled link-only
bindings still supply exact-PR terminal refresh demand.

Direct linked-PR input renders external text and labels through the shared
`renderSessionInputContextPromptV1` forge-evidence block. Repository-write
evidence admits unmarked feedback even from the connected principal; canonical
Reviews publication markers suppress reflected posts before direct or scoped
Workflow routing. PR text cannot supply chat approval, answer, stop or
new-session authority, including when an older frozen obligation is replayed.
The actual Session send clamps remote approval scope to Off. Partial Reviews
publication retries mark each new native review body using the newly dispatched
entries' canonical markers without duplicating a settled verdict's marker.
These are development-source corrections, with integrated runtime validation
still pending; they do not establish availability of the planned watch modes.

Acquisition uses the plugin's existing credential-bound API client and
checkpointed-pull observer. The client joins the Account request owner for
shared backoff and simultaneous safe reads, including Channels polling. Its current snapshot is stored
in the existing Automation checkpoint Collection; this is state recovery, not
a claim of complete check-event history. The first observation establishes a
baseline without retroactive trigger admission. The declared history-gap reset
Action reports no history gap for this state source.

The plugin's `wait/pull-request-checks-v1` Action accepts that admitted source's
opaque checkpoint row id, `checks_complete`/`checks_passed`, and an optional
observation deadline. It reads, subscribes to Collection invalidation, re-reads
and parks without provider requests or recurring reads. Cancellation/deadline
ends only the observation. It rechecks current source authority before matching.
The development-source generic `wait` connects this leaf through its admitted
Action declaration. A `plugin_source` target carries the existing checkpoint
id; `{kind:'plugin', actionLocalId:'wait/pull-request-checks-v1',
condition:'checks_passed'}` selects its declared predicate. The host uses the
existing contributed-Action invoker and exact Action grant admission, not a
GitHub-specific dispatcher or conventional-id discovery. The leaf admits CLI,
MCP, Agent and plugin surfaces. Publication and loaded-runtime validation are
not established by source tests; passive plugin watching remains unsupported.

## Linked Session Work presentation (0.3 development)

In unreleased 0.3 source, the same mounted Session snapshot also supplies
`hasUnreadMessages` from the canonical Session-list viewer/read-state owner and
`latestActivity`. Activity is a closed `ready` (`text`, `createdAt`), `empty`,
`hidden`, or `unavailable` result. An older host may omit these fields; omission
establishes neither an empty Session nor read state. Reading or watching never
marks a Session read.

The host reads the existing exact-Account external-shareable transcript witness,
opens content under its Session mode, and uses the Protocol semantic projector
shared with the CLI. Only approved user/final-assistant text can become activity;
private list previews, drafts, tool content and permission summaries are not
fallbacks. Time comes from the approved item's exact source row, not Session
update time. Missing witnesses, unresolved publication or a partial semantic page
that cannot establish the latest item yield `unavailable`. This extends the
existing admitted `readSession`/`watchSession` methods for installed plugins as
well as bundled plugins; it creates no additional content grant or preview store.

The mounted UI host's `readSession`/`watchSession` contract includes a required
closed `workStatus: { bucket, tone, word }` projection beside the closed Session
awareness facts and pending permissions. The canonical
[`pluginSurfaceSessionState.ts`](../apps/ui/sources/components/plugins/surfaces/pluginSurfaceSessionState.ts)
producer reuses `sessionWorkStatusFactsFromStatus` and `resolveWorkStatusTone`.
Those owners preserve report-aware settlement and offline priority; a plugin
does not classify host Session facts independently. Existing watches digest the
complete snapshot, so reports-only Work changes invalidate the same subscription.

The public `useSessionStates` hook can select the serializable facts its mounted
consumer needs with a stable `select` function. It retains the selected snapshot
when those facts are equal, so a list following Work facts does not render again
for a Session title or workspace change. Omitting the selector keeps the complete
Session snapshot. Both forms use the same host reads, watches and activity
lifecycle; selection adds no transport or Session-state owner.

In this development contract, a successful null snapshot is the hook's terminal
`missing` state (absent or inaccessible), distinct from `unavailable` after a
failed read. Failed reads preserve an explicit `retryable: false` refusal.
An initial watch refusal does not override the subsequent snapshot; an established
watch's terminal event triggers one final snapshot read without reopening the
watch or starting a retry loop. Relationships remain domain-owned and are not
removed by either snapshot state.

The Session `title` uses the host's canonical `getSessionName` projection, including
its Home-qualified retained title and untitled fallback. The same watch observes
that Session's list-row title changes. Plugins use the public snapshot for linked
Session labels; an unreadable Session uses the shared untitled label rather than
a stored relationship title or raw Session id.

The optional `agent: { agentId, displayName, brand?: { pluginId } }` comes from
the existing Session presentation identity reader and Agent catalog projection.
The host reuses Account-scoped cached machine contributions and the canonical
cold catalog loader for installed Agents, with the generated
bundled Agent contribution identity as the built-in package reference. An
unidentified Session has no `agent`; an Agent with no known package has no
`brand`. Neither path selects a default Agent or borrows a backing Agent's logo.
Plugins draw `brand.pluginId` through public `BrandMark`, not a host registry.
The host brand adapter reuses canonical Agent artwork for exact generated
bundled package identities without PNG brands; declared packaged bytes retain
precedence. Public package targets never infer backing-Agent artwork.
In development source, the app's existing UI byte publisher also projects
manifest-declared bundled PNG marks, including packages without UI entries.
The same presentation owner admits these exact bytes for bundled package
identity in host chrome and public `BrandMark`; an available runtime brand must
match its Resource and digest. Installed local and portable packages retain
their contextual Resource and selected Account Package Asset readers.
`watchSession` also invalidates on the linked machine's contribution changes.

Host chrome and public `BrandMark` consume the same installed-package
presentation owner. In development source, it shares pending and settled mark
reads within the captured Account and exact package/target identity. Active
consumers reuse the canonical sync Account lifetime. Routed credential bindings
are view-owned, so their shared presentations instead retire on the existing
exact-Home credential-change fanout. Retiring a view withdraws only that
observation; Account retirement or credential replacement/removal aborts
acquisition and releases retained presentations. Package replacement or a changed
portable reader/protected source rereads through the incumbent Resource or Package
Asset owner. Cached bytes never bypass current portable admission. Actions uses
one mark in each plugin section header; the Triage picker uses the contributing
package mark on each entry row, with the existing text fallback.

The shared Plugin UI Work presentation owns the status treatment, including
`HAPPIER_WORK_STATUS_SEMANTIC_TONE` for status labels and badges. Plugins may
retain domain story copy while consuming the host bucket and tone. This is a
development source-contract extension, not a released API or a persisted-data
migration. See [linked Session authoring](../apps/docs/content/docs/plugins/ui/index.mdx#linked-session-state-and-permission-answers).

## Collection cards, catalog rows and marks (0.3 development)

In unreleased 0.3 development source, public `Collection` supplies one anatomy to
list, table, grid and Board. Its existing `CollectionCards` owner composes the
portable `HappierWidgetFrame` chrome; core and plugin consumers share that drawing.
`CollectionAnatomy.card` offers bounded `headerRight`, `facts`, rendered `description` and
`body: { render, heightAtNormalText? }` slots. The optional body height is a
text-scaled minimum. The Collection retains identity, framing, activation,
selection and focus; rich bodies retain their domain data and demand owners.
Stable `Collection.useRowItem` and `useDetailHeader` hooks subscribe to plugin-owned
row and selected-header facts below the container. `CollectionAnatomy.titleMinWidth`
reserves the readable width of short-code table titles. A plugin's detail header
can supply root-first `breadcrumb` labels through Collection or `DetailsPane`;
`Step.onPress` opens the full story from its title, and `Tabs.lead` places a detail's
title and facts above its tabs. These are author props consumed by bundled plugins
or promised by the [authoring guide](../apps/docs/content/docs/plugins/ui/react-native.mdx).
The host's Workflow interaction anchors use `HostCollection.retainedRowKeys`
through the host entry, excluded from the governed author barrel; the renderer is
the same Collection owner. Author `Form` hints omit `allowCustomValue`; the host's
shared input controls retain that canonical Action hint for custom-entry choices.
Cards show only supplied descriptions and have no divided footer band. Truly
title-only cards remain compact. Existing `WidgetFrame` exposes independent
header/body controls, quiet `facts` and optional `onOpen`/`openTarget`, retaining
disclosure, plain/grouped/headerless modes and Resource lifetimes.

Described collections select `catalogRow` through the shared role resolver,
including narrow columns and peers without their own description. Explicit
`item`/`menu` roles preserve title-only navigation, work and preference contracts.
`capabilityCollectionAnatomy` binds the same canonical status table in public
and core UI: count/scope with title, speaking status before description, fixes
outside open/check targets. No separate rail classifier is exposed.

Public `BrandMark` selects manifest-owned package artwork; `HappierBrandMark`
accepts admitted PNG bytes and `Image` accepts a packaged PNG Resource. Public
wrappers explicitly forward those inputs and expose no remote URI/source prop
or `HostCatalogMark` type. Host catalog URLs enter a private admitted projection
feeding the same internal drawing/fallback owner. Supplied theme variants are
retained; only declared monochrome art is tinted. Missing/refused/broken media
uses a bare single-grapheme fallback in secondary ink and a later valid source
can recover. Selected-URI platform acquisition remains allowed; there is no
extra image preflight, body fetch, downloader, credential forwarding or timer.

The obsolete development frame-replacement callbacks have been removed in
place. `wrapItem` remains an interaction/presence decorator; `destination`
supplies qualified plugin or `{ href }` navigation metadata through the existing
host menu/open binding. Public author examples use package entrypoints, and
API/declaration records are generated through API governance. These changes do
not add Store layouts, kind registrations, an installed-status SDK, contribution
families, settings, persistence formats or Action authority. See
[Collection presentation](collection-presentation.md) and the published
[card authoring guide](../apps/docs/content/docs/plugins/ui/react-native.mdx#card-slots-and-rich-bodies-03-development).

The same development capability kit exposes `CapabilityListingSections` for
Versions and Source and licence. Its presentation owner,
`presentation/capabilities/CapabilityListingSections.tsx`, consumes held optional
facts, omits absent sections and chooses the first valid HTTP(S) repository or
website link. The app and public component bind their own primitives and words
to that owner; they do not repeat its section or URL policy. App MCP, Skill,
Agent and Software detail bodies consume the app binding in Add and standalone
listings. Data acquisition, installation and navigation remain with the caller.
`HappierCapabilityListingDetail` reuses Add's detail and primary-operation
feedback outside the Add body; it does not introduce a Store layout API.

## Work and consent presentation (0.3 development)

Plugin UI's public `/components` entrypoint owns Work row shells and summary
leaves, section empty/start and disclosure lines, update-card frames, fact lines,
breadcrumbs and the decision bar. Core binds identity lookup, localization,
navigation and Action handlers to those same components; it does not redraw
their generic anatomy. The role-mark adapter retains the host Agent catalog
lookup and delegates portable glyph presentation to `HappierRoleMark`.

In 0.3 development source, trigger rows and Badge-based provenance chips also
share neutral Plugin UI presenters. Trigger callers supply qualified summaries,
status, accessible labels and callbacks; the app adapter retains schedule clocks,
event projection, Item/column bindings and trigger writes. Provenance callers
supply the source label and optional destination; Account reads, transcript
isolation and scoped routes stay with their existing host owners. These are
presentation exports, not new trigger or sharing contribution families. Exact
names and props come from the generated Plugin UI API reports.

Memory fact rows also share one controlled Plugin UI content presenter in 0.3
development source. The public `/components` export accepts fact text,
caller-formatted metadata, optional source navigation, retired-state facts and
trailing actions. Core's `MemoryDocumentBody` binds its existing Item and text
leaves to that presenter. Qualified document reads, expiry decisions, arrival
animation, topic navigation and memory Actions stay with their existing callers;
the renderer introduces no memory service, parser or contribution family. The
[typed author example](../packages/plugin-ui/fixtures/external-authoring/src/memoryFactsSurface.tsx)
composes a fact and a topic row using public package imports.

Share sheets, expanded grants, level controls and their help legend also use
neutral Plugin UI presentation in 0.3 development source. Callers supply the
roster body, supported levels in their domain order, translated labels,
confirmation facts and callbacks. The app's sharing adapters bind these
presenters for Sessions, documents, Saved Secrets, machines and project sources;
their existing SelectionList retains search, directory steps, keyboard selection
and focus recovery. The shared pressable owns keyboard activation and visible
focus for level and grant actions. Directory reads, permission decisions,
mutation/confirmation state, modal lifetime, clipboard and scoped routes remain
with the caller. The sheet keeps its content mounted as its footer recomposes
on phones. This adds public presentation composition, not a share-adapter
contribution family or a new access authority.

Work page sections pass event groups directly to the shared page sheet, which
draws the group boundaries. Trigger rows suppress their own dividers so the
section has one separator between events and none between triggers in an event.

`HappierWorkSectionEmptyLine` is a section-description invitation at the Work
text edge, optionally actionable as a whole sentence. The generic `EmptyState`
line remains the informational list-row composition with optional glyph and
separate trailing actions. These are distinct consumed anatomies, not competing
decisions about whether a source is empty; each source supplies that fact and
retains its own add/start operation.

Protocol owns executable role kinds through `resolveRoleRunsAsKindV1` and the
default background intent through `DEFAULT_ROLE_BACKGROUND_INTENT_V1`. Plugin UI
owns their glyph/label presentation. Plugin
role sources carry the manifest's display name through the existing projection
and `roles.list` source reader; a client does not print a raw plugin id or create
another plugin-name registry. The declarative family needs no activation
registration. See [role authoring](../apps/docs/content/docs/plugins/guides/roles.mdx).

The optional `RoleArtifactV1.canDelegateToOtherRoles` trait is resolved per field
through the same role overrides and snapshots. Only explicit `true` includes
the callable-role list in coding instructions and the Settings role preview;
the built-in Orchestrator enables it. This is descriptive guidance, not start
or permission authority. Orchestrator's current-session execution and rail
placement retain their separate role-specific rules.

The client-placed `session.work.get` and `inbox.get` Actions read the existing
mounted Session Work source and Inbox model. They add answering-client addresses,
not another projection, subscription or storage owner. Invocation is exact-Home
and Account-bound, with currentness checked before and after disclosure. Without
one current mounted owner they return `unavailable`, not an empty snapshot;
first reads can return `loading`. DTOs whitelist presentation facts and identities,
not transcript content, raw operation snapshots or callbacks. The canonical
App Shell Action family and SDK Action generators own their public contracts.

These statements describe development source ownership, not package publication
or loaded-runtime certification.

## Plugin publication (0.3 development source)

The generic publisher is a development-project flow under Settings → Plugins →
Development. Its `plugins.dev.publish` Action and `plugins.dev.publication.*` helpers share the Protocol
[publication contract](../packages/protocol/src/actions/specs/pluginPublication.ts)
and CLI [publication controller](../apps/cli/src/plugins/authoring/publish.ts).
Inspection reads the selected project, selected Machine's public npm profile
summary and selected package history. Preparation returns the actual archive
inventory and check outcomes. It does not publish or add a second Agent Ask.
The public publication Action owns the single reviewed admission and defaults
to Ask for Agents; selected SCM children consume its admitted context.
Mounted publisher commands retain the initiating caller and policy context at
that same Action owner, and return its typed refusal to the invoking agent.

The existing pack/staging owner applies reviewed metadata once. Its operation
copy produces matching package, cold-manifest, runtime-manifest and discovery
metadata without rewriting author source. A changed candidate returns
`review_required` before an npm request. The prepared report is not a durable
publish job, and closing the form does not promise cross-restart recovery.

The Bot template editor opens this same form after saving its private draft.
The optional `botTemplate` input carries that draft's reviewed revision and BT2
release projection; a generated package needs no source folder. The form's one
version and changelog feed both the package and the canonical template release.
Opening reads the addressed existing release through `template.preview`; its
timestamp seeds that same version after reopening. A different version uses the
new publication timestamp. BT2 still decides whether content and notes permit
reuse; unavailable reads remain visible and retryable. Opening, inspecting and
preparing create no release. After archive review, the
parent's declared `template.release` child creates or reuses the exact reviewed
release before npm upload. An npm failure leaves that release available for an
explicit retry. Draft identifiers and source Session provenance stay out of the
generated package. A supplied real source folder remains the context for optional
GitHub source operations; release-only publication needs no local Git working copy.

The selected Machine's existing npm profile service owns private credential
acquisition. Connect reuses the private presenter and shared-Machine visibility
disclosure; public Action inputs/results contain profile identities and outcome
facts, never credentials. Existing Manage authority admits this publication
path; Use-only access cannot borrow a Machine's npm profile. The npm HTTPS
transport performs the upload in-process, without spawning system npm.

The npm adapter owns direct/staged/authentication/challenge/conflict/unknown
classification. A stage is `awaiting_maintainer`, with npm-owned identity and
review URL, rather than public success. Explicit `plugins.dev.publication.status`
reads the exact version and expected upload integrity; neither staging nor an
ambiguous upload starts polling or automatic upload replay. History is scoped
to the selected package. Search indexing is separate from confirmed upload.

The same Machine-local profile owner offers pasted-token login, a reference to
the selected registry's project/user/global npm configuration, and npm's browser
login. Machine npm configuration is read in place with environment substitution;
its token is not copied to Account credentials. Browser login uses npm's HTTP
contract, characterized against published `npm-profile@13.0.1`
([immutable implementation](https://github.com/npm/npm-profile/blob/67b32d049d41dac10b8ccba96208af522d1c8f40/lib/index.js)):
the private completion URL stays at the Machine, and only the login URL is
presented to the person. Vendor-directed pending completion follows npm's
Retry-After response and the sign-in's cancel signal; this is separate from
publication status, which remains an explicit read. These methods share
Connect/Credentials and existing profile Actions, without an npm executable,
new Connected Account service, OAuth exchange or credential store.

Optional GitHub publication composes existing SCM source and GitHub release
Actions only after confirmed npm publication. Its separate outcome retains npm
success and any pushed ref. An explicit GitHub-only retry checks npm status
without uploading again. The SCM and GitHub release owners retain their own
conflict and uncertain-outcome decisions. Ordinary project publication remains
independent of Store Bots and template authoring. The
[author guide](../apps/docs/content/docs/plugins/packaging/authoring-cli.mdx#publish-a-plugin)
owns the contributor workflow; this section describes current source, not
released availability or loaded-runtime certification.

## Generated ownership

In 0.3 development source, Agent UI descriptors own their mark through
`assets.svgIcon`. A packaged `{ path: 'assets/agent-mark.svg' }` preserves the
complete SVG, including masks and filters; `{{text.primary}}`,
`{{accent.orange}}` and other color paths resolve against `theme.colors`.
The existing structured `{ viewBox, paths }` declaration remains supported.
The CLI bundled publisher emits both forms into the standalone
`generatedAgentLogoSvgXml.ts` map consumed by Agent icons and the README strip.
Hosts do not select vendor-specific assets or parse generated UI source to
discover marks.

Connected Account descriptors own setup presentation in `ui.setup`:
`order` sorts the setup catalog, `firstRun` selects its initial offers, and
`catalogDescription` uses the existing localized-string contract. `ui.shortName`
supplies compact brand copy. Bundled services with a distinct service mark name
their same-plugin packaged SVG Resource in `ui.iconResourceId`; the same
publisher emits the qualified service mark map. Released scalar service ids
reach that map only through the existing generated legacy identity adapter.
These fields carry presentation and grant no authentication or execution
authority.

The canonical Workflow schema types both authored input and parsed output as
`WorkflowDefinitionV1`, including inline Workflow and Session trigger inputs
and triggers at Session birth. The Action DTO generator derives that contract
directly; its neutral SDK support projection closes recursive block types in
their input or output context, preserving the canonical JSON projection.
The external-author fixture in
`packages/plugin-sdk/fixtures/authoring-inference/workflowTriggers.ts` checks
valid definitions and rejects unknown block kinds. This changes development
source typing without changing the trigger runtime validator.

The CLI publisher [`generateBundledPluginEntries.ts`](../apps/cli/scripts/build-owned/generateBundledPluginEntries.ts) owns bundled semantic/catalog/daemon projections. Its build-owned [`uiDeclarations.mjs`](../apps/cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs) projects the semantic declarations for app-bundled UI. The UI publisher [`generateBundledPluginUiArtifacts.mjs`](../apps/ui/scripts/generateBundledPluginUiArtifacts.mjs) emits their discovery index beside the app-preseed byte inventory and exact per-plugin declaration modules. In development source, the index retains UI descriptors, referenced navigation copy, Account Action/Resource presentation, value-free Saved Secret source declarations, compiler graphs and Collection reader references. Installed bundled-first-party rows reuse the app-bundled declaration at the same plugin/version coordinate for source discovery; Machine census reports remain free of live manifests and this presentation does not grant execution. Full manifests, schemas and remaining copy load on plugin demand. Availability owns acquisition and rechecks current Account policy after loading; presentation manifests cannot authorize execution. Source preparation and retention follow those module references through the same inventory owner. Installed external releases retain their existing Availability path. Loaded-runtime latency and recovery remain separate validation. Finding a digest in the byte inventory does not admit a declaration, and no compiled custody hash joins the two. Change their inputs or producer, never an emitted projection; do not add handwritten Agent/Provider lists beside generated facts.

Full per-plugin declaration bodies are JSON `.bundle` assets read through the existing Expo asset byte transport. Their schemas and copy remain available on demand without becoming JavaScript modules or source-map inputs, including in the single-graph development web bundle. The first-paint discovery index remains JavaScript. Last-good inventory retention can still read previously emitted declaration modules while new inventories reference content-addressed JSON assets.

In 0.3 development source, the CLI publisher emits locator paths and metadata,
with normalized declarations under
`apps/cli/assets/bundled-plugin-manifests/`. The catalog reads these files on
demand through its bundled manifest reader and retains its process-admitted
catalog. The emitted locator shape lets daemon and Session-runner consumers import
metadata without parsing all bundled declarations. Clean-checkout Agent preparation reads these tracked JSON
files without requiring packaged plugin manifests; published CLI runtimes
include them as runtime assets. The locator and JSON files form one publication
closure and must be regenerated together before loading the changed locator shape.

Source-runtime and native daemon code builds use that same CLI publisher to derive
their locator and JSON closure into private build output from their plugin sources.
They neither require fresh checkout projections nor rewrite them. Invalid optional
plugin declarations are omitted from that closure and carried through the existing
publication-failure inventory to unavailable catalog rows; required host plugins
and generator failures still stop the build. Committed projections retain their
strict freshness check in CI and package/release builds. That existing check also
compares present packaged `plugin.json` files, including tracked copies, with
their source-derived normalized declarations and reports a scoped regeneration
command on drift. A `--workspace` write validates the selected packages from
current source against peers' last published, admitted catalog projections. It
checks identity conflicts and incoming/outgoing reference and targeted-contribution
contracts involving the selection, including its previous published identities.
Foreign in-flight source does not participate. Package artifacts are prepared
only for the selected packages. Unscoped writes and every `--mode check` retain
full current-source validation.
This describes 0.3 development source.

Bundled prompt-library adapter descriptors are projected as data. The Claude
predecessor message-metadata bridge binds the Protocol-owned writer to defaults
projected from the plugin's existing settings contribution. These host projections
do not import executable plugin packages; excluding a failed optional plugin
omits its descriptors and compatibility binding in the same publication.

Public author toolchain facts have one strict carrier, [`PublicToolchainCompatibilityV1`](../packages/protocol/src/plugins/publicToolchainCompatibilityV1.ts). Authoring/scaffold consumers use its package and runtime facts rather than inventing a second compatibility table. Feature validation uses current source, ordinary package checks and the loaded development runtime. Packaging, registry publication and exact release-byte checks remain release-owned.

In 0.3 development source, Settings submits, tests, packs and unregisters explicit
plugin development roots through the same machine-placed Actions as the CLI and
Agents. Submit registers the daemon-owned watcher; unregister stops that exact
explicit root. The selected machine and Home remain fixed for each invocation,
and Action policy owns approval. Protocol owns the shared development status
schema used by the daemon and Settings; capability snapshots retain status as a
read projection. The retired development mutation methods are no longer served
through `tool.plugins`.

In 0.3 development source, the authoring source-module owner selects a folder's
`src/index.ts` or `index.ts`, rejecting roots containing both. If neither exists,
the folder's explicit `package.json.main` selects a `.ts`, `.mts`, `.js`, or
`.mjs` author module. Conventional TypeScript source takes precedence over a
built package main; package `exports` remain package-import declarations.
The selected directory retains its real package root for dependency and UI
preparation. Explicit descriptor locators and folders without an author entry
retain static manifest discovery; generated manifests do not override source.

The CLI's development module evaluator uses one Jiti configuration for author
sources and generation-scoped runtime loads. Asynchronous static and dynamic
CommonJS imports receive Node's native namespace, including `default` and the
named exports detected by Node's lexer; a CommonJS `__esModule` flag does not
unwrap that default. Ordinary `require()` still returns the raw exports.
Repeated imports retain namespace and default identity. Forced candidate
evaluation shares its already-evaluated exports with Node, and replacing that
candidate's Module retires its namespace so source edits remain visible.
Mutable JavaScript author entries use the asynchronous transform as TypeScript
entries do. Native-oracle fixtures cover source, cache, candidate replacement
and compiled ESM; fully bundled payloads also exercise the consumed lazy-import
APIs, since esbuild's synthetic namespace objects have different key and
namespace-identity behavior from native Node. Jiti's current format classifier
still misclassifies import/export text inside CommonJS comments; that candidate
path remains a known namespace-parity gap. This is 0.3 development behavior.

In 0.3 development, daemon preparation evaluates a code-defined plugin once and
passes that canonical manifest to the managed UI compiler through a temporary
manifest input. The author root needs no emitted `plugin.json`; artifact paths
still resolve against that root. Cold-manifest builds keep their existing input.
Selecting a development source enters that preparation directly. The ordinary
installation review owns approval of the evaluated candidate and its declared
access; there is no separate permission to evaluate trusted plugin code.
Development replacements compare authority against the incumbent's accepted
manifest and optional grants, including an admitted bundled incumbent with no
persisted installation. Equal or narrower authority needs no new review;
expanded authority follows the shared Account update-review policy. Code bytes
and source custody do not themselves expand authority. A later same-root source
observation needing no new grant automatically cancels its obsolete development
review and releases pending custody; an enclosing Action's explicit approval
remains required. A registry change during development preparation refuses that
stale candidate with `plugin_dev_conflict`, retaining any active incumbent. The
development-root owner re-enters preparation against the current registry once
per stale-base refusal. Each further refusal requires another intervening registry
commit; there is no timer, backoff or retry budget. Status can show that preparation
is continuing. Failed authoring phase file logs carry the available typed code or
Error name without error messages, stacks or payloads.
Other pending decisions remain until an explicit decision,
handoff or shutdown retires them; settled rejoin results remain for the daemon lifetime. Candidate
cleanup is awaited through that lifecycle and reports failures without a shorter
phase timeout. The daemon starter's readiness wait bounds only its observation
of startup. It does not cancel source preparation, module loading, required
startup activation or initial Resource admission. Reload uses the same startup
activation predicate as cold start, so demand-only Agents remain dormant.
Primary Agent construction belongs to first use, with no eager construction
before publication. A valid update adopts the new version; a constructor failure
then reports that version's error to its caller rather than restoring the prior
version. Those operations stay
pending under their existing occurrence lifetime and can finish without a daemon
restart; elapsed startup time is not a plugin load failure. Required synchronous
consumers still wait for their registrations before the serving registry is
published. Actual activation failures remain diagnosed and isolated at the
canonical runtime owner. Retirement retains its explicit cleanup budget when
supplied; otherwise trusted asynchronous cleanup is awaited.
Hosted plugin UI readiness, guest bootstrap and SDK negotiation have no implicit
wall-clock cutoff in 0.3 development. The same frame/document attempt can accept
a late valid handshake; explicit caller readiness/negotiation budgets, caller
cancellation, transport failure and occurrence retirement retain their existing
meaning. This does not change the separate caller-HTML frame readiness policy.
Client executable retirement withdraws the old scope's registration authority
before waiting, then joins actual host-scope disposal and returned plugin cleanup
without separate five-second races. Real disposal failures remain diagnosed;
late work cannot restore retired authority.
Composer reference and attachment callbacks likewise have no host-invented
five-second budget. Their existing caller and occurrence-retirement signals
still cancel the exact invocation, and real callback failures remain failures.
Their full service contexts bind through the current declared contribution and
actual host service owners, as do Event subscription, request-interceptor and
MCP callbacks. Manifest HostAccess scopes do not veto these bindings. Account mode,
currentness and invocation/occurrence retirement remain enforced by those
owners. Composer and Event callbacks retain their admitted source custody for
nested Action calls. This describes 0.3 development source; loaded-runtime
verification is separate.

In 0.3 development source, `SessionHandle.materializeAttachment` copies a
trusted plugin-local file through the incumbent Session attachment upload
owner. It requires admitted Session write access and a locally hosted Session;
the host derives the destination from that Session's workspace, not the plugin
filesystem scope. The daemon binds this upload and composer-media staging to
the host-local carrier returned by the same upload lifecycle. It retains the
filesystem owner's transfer store and handlers independently of the public
Machine method table, whose chunk/finalize/abort methods accept prepared-transfer
envelopes after daemon startup. Composer-stage release still uses its existing
Machine handler. The peer-mediation adapter
requires a verified peer Account grant and cannot carry these host-local calls.
Materialization returns the path and exact source bytes. It does not transfer provider-local paths
across machines. Channels' declared `channel-file` attachment consumes this
adapter through its ordinary dispatch callback with its required `bound-session`
read+write grant; attachment observations hold descriptors rather than file
bytes or paths. The Channels input
owner extracts text once on the connection machine and includes it in the
ordinary message before `session.send`, independently of Session placement.
For a remote Session, the dispatch callback performs no fetch and reports typed file
unavailability in the existing ready result's `data.file` (`kind: 'unavailable'`,
`reason: 'attachmentNotAvailableOnThisMachine'`). The context names the missing
file without exposing the provider-local path, so inline text and the original
message remain dispatchable. Text and PDF text-layer context uses the attachment
context contract, not the separate reference-preview ceiling. These are source
contracts, not a claim of a verified composed loaded-runtime journey.

In unreleased 0.3 Email content shaping, named `message/rfc822` parts remain
original decoded `.eml` files even when their MIME disposition is `inline`
and their transfer encoding is 7bit, 8bit or binary. The same Email parser
adds their readable content as untrusted forwarded text and retains nested
files; unnamed inline messages remain readable body content. Polling and
attachment fetch share that parser for first-party and external raw transports,
and the existing Channels descriptor/fetch/Session-upload path carries the files.
Existing native MIME part identities, including flattened inline descendants,
remain stable.

In unreleased 0.3, Email parser/module exceptions produce content-free
`email_parser_module_not_found`, `email_parser_syntax_error` or
`email_parser_runtime_failed` Action evidence. The existing Channels poll
settlement honors the Action's retryable bit and schedules its normal backoff;
genuine transport failures retain provider `network` evidence. Parsing failure
returns no partial observations or checkpoint, and reply parsing refuses SMTP
submission with a safe retry result. MIME content-limit rejection remains a
content non-admission rather than a runtime failure.

Channels' unreleased 0.3 ingress compares attachment identity through the
shared attachment codec. Email's retained slash-joined MIME part paths and
their portable encoding name the same native parts. This leaves the existing
comparisons of descriptor order, names, media types, lengths and occurrence
content unchanged.
Channels applies current sender and command policy once at dispatch, not at
capture and again at dispatch. For a PR batch, that boundary admits each
original event against its current binding before forming the update; a refused
sender neither joins the update nor suppresses another sender's admitted event.
Polling reuses the connection, binding inventory and provider selection acquired
for that finite poll; dispatch retains the cross-person recipient and binding
checks. A later due dispatch is a new natural admission boundary.
Scoped Automation batches carry ordered, identity-only per-event actor evidence
to native admission, which applies its existing repository permission policy to
each sender. Display labels and message content do not enter server-readable
E2EE host evidence; the full native input remains sealed.
Channels is not a message archive. Each pending obligation holds input only
while an actual destination still needs delivery. Native Session or Discussion
idempotent acceptance owns the accepted history; after the last destination
settles, Channels drops its retained content before the invocation returns.
Unfinished accepted input is never expired merely because it is old. Minimal
dedupe/reply metadata and actual per-binding lifecycle relations remain for
their readers, without census-completeness or frozen-policy proofs. Retained
historical row shapes remain readable; no data reset or rewrite is required.
The historical census rows remain stored but have no runtime reader; current
obligations carry their own pending input. Unreleased 0.3 publishes this changed
Collection contract as V20. One inert historical `censusId`-only obligation arm
lets existing development rows survive promotion without reconstruction or
deletion; the 0.3 migration consolidation removes that transition arm under the
2026-10-31 owner ruling. Connections have no message-age
setting, common age cutoff or expansion floor. A healthy reconnect admits unseen
catch-up still returned by the provider; only first-connect and actual continuity
gaps establish the provider's from-now baseline and history-gap notice.
Once content has been dropped, native message and principal identity deduplicate
replay without reconstructing the body or creating another input.
Connection, binding and checkpoint invalidations affect that connection's
schedule only; unrelated connections retain their deadlines and failure backoff.

In unreleased 0.3 source, Channels retains a Discussion delivery through the
person's pending approval and native settlement. Consent returns to the
requesting Machine; approve resumes that publication once, while reject,
cancel or `discussion_post_denied` settles terminal `targetUnavailable`
attention without scheduling another attempt. Plugin-update continuity belongs
to the [approval creation owner](actions.md#approval-is-decided-in-one-place).
Retryable poll failures use the existing shared growing backoff, including
retained untyped poll failures that older code left blocked. A provider history
gap asks that same provider for a checkpoint-only, from-now baseline. Email's
UIDVALIDITY change or regressed UIDNEXT therefore skips the replacement
mailbox's existing messages, keeps a visible notice and admits later arrivals;
dismissing the notice does not reset the recovered checkpoint.

In current 0.3 development source, UI and CLI plugin Action, Resource, Settings and
Secret requests use the canonical transport setup budget without an implicit
operation deadline. Explicit caller deadlines and cancellation still apply;
the direct peer HTTP route preserves that distinction. The daemon continues to
own bounded watch waits, and losing an issued effect's acknowledgement does not
make replay safe.
Local daemon plugin-change and development calls follow the same caller-owned
wait. Explicit deadlines are honored without a shorter HTTP-phase clamp.
Settings administration forwards its lifetime through target lookup and daemon
RPC; cancellation after a write is issued preserves `outcomeUnknown`, while an
acknowledged write receipt remains authoritative. Cancelling one shared read
does not cancel another reader.

Remote and npm acquisition no longer impose implicit download/socket deadlines
or shorten an explicit enclosing deadline. Their acquisition signal covers DNS,
redirect assessment and body consumption. Destination, credential, signature
and digest checks remain independent of plugin trust. Both acquisition owners
detect repeated redirect URLs instead of rejecting a finite chain after five
hops. Streamed archives and extraction have no implicit payload, file-count,
depth, compression-ratio or wall-clock ceiling; explicit caller/operator quotas
remain enforceable. Extraction joins its owned file writes before cleanup,
preserves executable modes and retains path containment, portable segment and
collision checks, integrity verification and the bounded parser metadata buffer.
Buffered catalog, npm metadata, key and attestation reads follow explicit
caller/operator byte budgets without separate implicit defaults or clamps.
These JSON reads still materialize their values in memory; this policy is not a
streaming JSON or hostile-input memory-isolation guarantee.
Archive staging reads complete `package.json` and `ui-artifacts.json` documents
without a separate 1 MiB ceiling, while retaining strict JSON and semantic
validation. The tar parser's bounded PAX metadata buffer remains: oversized
metadata is ignored by that parser, not treated as a staging JSON quota. npm
resolution retains all blocked newer versions needed to explain its selected
version, without a 32-version evidence ceiling.
Accepted daemon installation changes retain their existing drain/status recovery
contract; ending a caller's observation does not cancel an accepted effect.

Availability reporting and removal preflight use their captured owner signal,
not the session-control HTTP deadline. Plugin store and registry lock contention
wait for ownership or caller cancellation rather than failing after ten seconds.
Unknown lock bytes are not reclaimed merely because they are old. Exact dead
owner recovery, successor protection, compare-and-swap and atomic publication
remain at the existing lock/publication owners.

The daemon's server report projects only persisted installation facts. Fresh
reporter lifetimes rejoin an unchanged materialization without a revision or
change event; a real semantic change still replaces it. Release-less manifest
and UI declarations stay on live daemon/device custody paths and are not
persisted. Older descriptor-bearing reports remain accepted through the same
persisted-fact projection.
Within a reporter lifetime, observation-time changes alone also suppress a new
materialization request. Real installation updates retain their observation
time on the wire; only the no-op comparison omits that provenance.

Executable startup has no implicit handshake or WebSocket-connect deadline.
In unreleased 0.3 development source, `exec.withSpawnAdmission(admit, effect)`
provides a scoped Exec service that runs admission after all launch preparation,
including setup consent and materialization, immediately before each OS spawn.
The admission callback receives the launch's combined cancellation signal.
Admission refusal releases the prepared launch; cancellation settles without a
late spawn. The required in-process method fails before the effect on older hosts
that lack it. Existing connections are forwarded unchanged; no callback enters
the daemon protocol or changes its wire ABI.
Authored budgets are honored without a shorter host clamp; cancellation and
actual process/transport terminal facts settle pending startup, including an
asynchronous handshake decoder. Plugin tool readiness similarly waits under
its operation signal rather than borrowing diagnostic probe timeouts. Elapsed
time alone does not make a plugin persistently unavailable.

Executable RPC request/handler/write queues, callback queues and plugin
WebSocket backlogs have no implicit count or aggregate-byte ceilings. Explicit
authored budgets remain enforceable; this is not a bounded aggregate-memory
guarantee. In 0.3 development source, managed JSON-RPC process clients accept
`jsonLines`, `contentLength` or `webSocket` framing. WebSocket framing negotiates
over the launched process's private byte streams before public process-output
redaction; the native Codex raw proxy uses this path without a second transport
owner. `exec.clients.connectJsonRpc` uses that same engine for an existing Unix
WebSocket endpoint and returns `client`, `closed` and `dispose`, without a child
process or server-start authority. It preserves trusted native code's existing
local socket access and OS permissions, with invocation cancellation and
occurrence guards. It does not add TCP endpoint access.
The public client's `onNotificationReceived` subscription admits synchronous
native notification facts before ordered notification callbacks. Request
responders and response correlation keep their independent dispatch; a blocked
domain notification handler does not block an approval response. Codex uses
this receipt to populate its existing item-identity approval subject projection
before an immediately following MCP approval request. Occurrence retirement
prevents further callback effects and response publication from either managed
connection form.
Below the WebSocket driver's existing transport allocation ceiling, the JSON-RPC
byte budget rejects only a correlated oversized response so a caller can recover
with a lean request. Exceeding the driver ceiling instead fails the connection
from the frame header without waiting for its body. Application byte checks run
on completed messages. Shared JSON-RPC process clients also have no default payload-size
cap; a caller can supply an explicit `maxFrameBytes` budget. Content-Length
framing still requires exactly one valid non-negative safe-integer length and
fails malformed or truncated frames closed. Local LSP uses this same uncapped
client, with process supervision and request cancellation unchanged. Explicit
frame budgets for other protocol kinds, encoded-header byte contracts, RFC
protocol-token validation and the WebSocket driver's peer-security defaults
remain. In particular, the driver retains its fragment/chunk allocation
protections documented in
[GHSA-96hv-2xvq-fx4p](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p),
without Happier's former tighter 1,024-fragment override.

Plugin KV and Secrets owner locks wait for ownership or operation/occurrence
cancellation, without an age-based stale-owner deadline. Permission-grant
reads, requests and execution no longer borrow the session-control HTTP
deadline; a cold grant read waits for its authoritative result instead of
substituting an empty local projection. Grant security checks remain unchanged.
Account Settings/Data HTTP requests likewise use their Account/operation
cancellation without a descendant deadline, including Account Data's real
encryption-currentness preflight. Currentness and mode checks still fail closed
before disclosure or mutation.

In 0.3 development source, the Account's `registry-sources` row is the source
authority for skill and plugin browsing and ordinary plugin exact-install
lookup. Clients no longer send configured source lists to the daemon. Public
plugin discovery shares Protocol parsing with daemon install admission;
listing data contains no machine admission or artifact-access decision. npm
credential profiles remain machine-local. A fresh Temporary-computer endpoint
instead supplies its already verified, sealed reviewed source as readonly
input to that same exact-install owner; it neither creates a writable source
registry nor obtains the creator's Account credentials or npm profile.

Ordinary plugin Action preparation admits that row through its captured Home and
Account source host. The CLI sends an exact listing pointer; daemon preparation
acquires its listing and source binding once, then stages the verified bytes.
Apply retains the installation CAS without reacquiring the listing or registry
profile. The next installation observes source and profile changes. Machine
placement does not supply a foreign requester's private source
catalog: without that custody, the Action returns the existing
`approval_context_unavailable` refusal before reading sources or preparing code.

Exact catalog acquisition also honors the source-bound npm profile's existing
`allowPrivateNetwork` permission when the catalog and profile have the same
origin. An unbound profile, a different origin or a remote catalog's profile
field cannot grant this permission. HTTPS, same-origin redirects and assessed
address pinning still apply. The profile must pass its ordinary Test before
artifact access is available; creating or binding it alone does not establish
availability.

An explicitly source-bound profile can install an unscoped package without being
the default registry. `useAsDefault` controls automatic registry selection; an
explicit selection still checks the exact origin and any package scope. Binding
a profile therefore does not redirect unrelated unscoped installs to that registry.

The development `plugins.install` Action accepts an exact marketplace source,
plugin and version plus the selected Machine, without public trust fields.
For an installed plugin, `source: { kind: 'installed', pluginId }` asks the
same daemon owner to choose its update from the retained channel and policy;
`plugins update <pluginId>` is a CLI projection of that Action. The caller
does not reconstruct a locator or override a pinned policy.
Install review uses the ordinary `ApprovalRequestV2` Artifact and Inbox
presentation. The public `approval.request.decide` Action serves UI, Agent,
MCP and CLI decisions under the user's approval policy, using the approval
Artifact ID rather than the daemon pending change ID. The daemon retains
candidate custody and applies those evaluated bytes through the installation CAS.
Compatibility comes from the staged manifest; differing metadata enrichment is
not a second compatibility authority. Archive containment, signature and
integrity verification remain with their distribution owners.
Failed install preparation returns its domain error before creating an approval
Artifact; a source operand alone cannot stand in for the evaluated disclosure.
Direct development install first registers its exact source through the same
daemon development-root owner before retaining a review. Observer-created
development reviews publish through this same owner. In 0.3 development source,
`plugins dev` hands a review-required registration to the ordinary install Action
and returns its approval Artifact ID. An explicit
`plugins install <exact-source> --dev --json` remains an alternative way to rejoin
the retained candidate and same Artifact while its registered source observation
is current. If a newer observation has already superseded that candidate, a new
request expires the stale candidate and prepares current facts; approving an old
review still cannot adopt superseded source. A managed-to-development transition
removes only that plugin's managed generation selection. Its serving occurrence
keeps its original custody until development adoption, and restart rebuilds the
registered source. A managed manifest-authority-only update keeps its generation
selection and existing rollback behavior. Rollback metadata remains bound to the
selected distribution lineage; unrelated plugins' retained history is unchanged.
`plugins change status` only inspects pending
daemon custody. Restart expires that custody, so the original source flow must
prepare new facts; `outcome_unknown` requires installed-state inspection before
replay. Optional resource and credential grants retain their canonical owners.

Enable, disable, rollback, forget trust and update-policy controls use semantic
Actions in this same plugin change family on UI, CLI, Agent and MCP. Reversible
enable/disable, retained trusted-version rollback and update-policy edits are
direct own-UI defaults. Forgetting trust also drops rollback retention and
retains confirmation. Agent/MCP lifecycle writes keep their configurable danger
default; waivers never supply human authority or bypass daemon trust admission.
The marketplace capability no longer provides a competing lifecycle mutation
path; retained catalog reads and change-status inspection do not execute changes.

Source registries and npm profile, scope and paused-source inventories have no
independent count ceilings. Mutation receipts remain for the npm registry file's
lifetime, so a later retry cannot replay an old mutation after newer writes or a
restart. Marketplace diagnostics and installation review retain their complete
evidence; item pagination stays with the canonical query owner. Exact marketplace
installation in 0.3 development source acquires its listing once at daemon
admission through the existing Account-bound Registry host and format adapters.
Its HTTP memo revalidates reads;
failed acquisition never supplies stale installation facts from disk.
Listing, configuration and review text and arrays have no guessed presentation
ceilings. Review JSON uses the existing iterative finite/cycle-checking plugin
JSON owner rather than a local depth/count policy. The canonical 100-item
Marketplace processing page retains total/cursor continuation; it is not a
maximum catalog size or an inferred npm service quota. Existing unique finite
review sets retain their enum cardinality, as do real npm naming, digest,
storage-identity and numeric representation contracts.

Resource descriptors retain size/digest metadata, not aggregate payload bytes;
their former 512-entry/context and 64 MiB descriptor-accounting caps are removed.
The incumbent 16 MiB per-read envelope, four concurrent admission readers and
brand-image decode protections remain. Package Asset archives still materialize
payload copies/base64, so they retain the coupled 16 MiB per-asset and 64 MiB
aggregate memory controls while dropping their independent 512-entry cap.
Compatibility metadata no longer has separate 1 MiB/128-artifact caps. Actual
Artifact hosting quotas and HTTP admission remain server-owned. Immutable source
generations no longer impose an independent 16,384-file/512 MiB ceiling;
filesystem errors, path containment, integrity and atomic publication still
govern staging. Replacing retained buffer controls requires a consumed streaming
or resource-budget contract, not a larger guessed number.

Installed catalog and runtime discovery consume the same validated manifest
projection committed with each accepted development candidate, rather than
parsing or re-evaluating its source entrypoint. Until a new candidate is accepted,
discovery retains the accepted declarations; a missing projection fails closed.
JSON-manifest and managed-artifact discovery retain the canonical JSON reader.
The change service logs failures locally before projecting their redacted public
diagnostics, retaining filesystem paths while removing credentials. Managed
dependency preparation may reclaim an empty workspace file or one whose first
line identifies Happier's transient configuration; author-owned configurations
remain protected.

In 0.3 development source, module-load and activation diagnostics carry a closed,
content-free `details.cause`: `phase` (`resolve`, `transpile`, `evaluate`, or
`activate`), `code`, and `retryable`. Recognized Node codes and JavaScript error
classes survive loader wrappers; missing named imports and temporal dead zones
retain distinct classifications. Only validated package specifiers are included;
absolute paths, exception prose and arbitrary plugin error codes are omitted.
Unknown causes explicitly report `UNKNOWN` and unknown retryability. Retryable
module-not-found failures require dependency/source refresh, not background polling.
The existing diagnostic details slot carries these facts through target activation,
engine resolution and daemon introspection, without a new wire envelope.
Daemon change preparation, development-root status/control, CLI JSON and developer
Actions retain the same cause. Their human presenters share the closed-cause
formatter. Non-retryable preparation failures settle without the package-isolation
retry or a later lazy-demand retry; unknown and refreshable preparation failures
retain the existing recovery policy.

In 0.3 development source, managed author installs select `@happier-dev/*`
declarations from dependencies, dev dependencies, optional dependencies and peer
dependencies when the bundled prepublication version (`0.0.0`) satisfies their
semver specifier, including ranges such as `>=0.0.0 <1.0.0`. The shared package
resolver owns this selection; scaffold output and SDK policy fixtures exercise
the same rule. Other specifiers retain normal package-manager resolution, and an
explicit SDK registry origin retains registry resolution. Selected packages must
still satisfy the existing bundled public-author package classification.
The selected packages' satisfying public runtime dependencies and peers follow
the same rule, so a declared helper package can bring its public UI dependency
without asking npmjs for an unpublished version. Explicit bundled dependencies
keep their existing nested package closure; package development tools do not
become author dependencies.

Prepublication dependency preparation uses a content-addressed file override
for the complete SDK package closure. When the CLI runs from the source
workspace, preparation first asks the canonical source-development publisher to
prepare the requested public packages and their dependencies; copying an older
`dist` tree into a new author root does not establish source freshness.
Packaged hosts and admitted source bundles use their supplied package closure.
Repeated preparations reuse its pnpm
virtual-store identity; the transient workspace config selects pnpm's native
immediate orphan pruning when the closure changes. Both temporary package roots
and the workspace config are released after preparation. Published registry
resolution keeps its existing policy.

The generated cold manifests of the external-author QA scaffolds under
`packages/plugin-sdk/fixtures/qa-plugin-authoring/created/qa-*` are worker-local
build outputs. Source replication excludes their `.happier-plugin` directories
so it cannot remove a manifest between daemon bundling and UI compilation;
authored SDK example and descriptor manifests elsewhere still synchronize.

In 0.3 development, a first-party plugin at its canonical source-workspace path
uses that repository's installed dependencies. The author toolchain checks the
declared package identities and versions without running a package manager or
refreshing the shared dependency tree. Missing or incompatible required packages
fail preparation. External author roots retain managed dependency preparation
and the public-author package policy.

The host SDK-resolution owner identifies those canonical workspace roots for
dependency preparation, candidate evaluation and UI compilation. Candidates feed
the source runtime's authored export aliases into the existing generation-scoped
module evaluator, so the SDK and feature protocols use current source together.
Only the plugin's declared workspace runtime-dependency closure contributes
aliases (including its public subpaths); dev-only and unrelated packages do not.
Canonical first-party candidates use package-source prefixes with exact entries
for root, irregular and shadowed exports. Their Bundler-mode package typechecks
reject undeclared package subpaths before shipping; development prefixes do not
themselves enforce that export boundary. External author resolution is unchanged.
Absolute terminal aliases are normalized once before entering the evaluator,
not quadratically again for every nested module-loader construction.
The managed UI-compiler child consumes that same source-export authority and the
SDK's existing universal compiler. Only packages in the workspace inventory use
source-export resolution; third-party imports use the compiler's ordinary package
resolution. External author projects retain their installed package exports;
hoisted or linked tool packages are valid, with executable entrypoints contained
inside the resolved package and compiler identity/version checks retained. This does not rebuild
SDK `dist` or replace the development module loader.

Live Expo's bundled UI preparation selects the same `happier-source` condition
for manifest evaluation, including synchronous dependency loads, and reuses the
source compiler above. Its inventory owner retains the last validated declaration
and complete byte graph when preparation fails, even without compiler-reuse
metadata. The preparation diagnostic marks retained UI as stale; only a plugin
without a usable prior graph becomes unavailable, while healthy peers advance.
Metro's existing change feed observes plugin and compiler inputs, including the
preparation launcher and source preload, so repairing an input triggers another
preparation without restarting Expo. This describes 0.3 development source;
loaded-stack confirmation remains separate.

The shared authoring source observer excludes that marker-owned configuration
and remembers the last attempted input signatures separately from the adopted
baseline. A retained or failed candidate therefore waits for a real input edit
or an explicit reload, while its unadopted dependency changes remain part of the
next candidate. Preparation output events cannot replay an unchanged candidate.

The in-development GitHub local-workflow path declares installed act through
the existing system-tools service. Safe inspection uses the admitted executable
for version/help only; actual runs delegate to the primary-constrained Project
compute Action, preserving preference, setup/trust, requester-secret and operation
admission. Local form editing uses the same mounted `{mountId,operation}` intent
shape as other plugin forms. Its safe open operation requires the producer-known
`seed.target`: `{kind:'session',sessionId}` for a6/c3 or
`{kind:'project',projectId}` for workflow/job entries. The corresponding declared
`github-local-act` / `github-local-act-project` view uses the existing details
pane; the explicit target also qualifies the opening rendezvous and form
lifetime. No navigation-state query or fallback chooses a target.
Its controller owns no terminal, container lifecycle,
hosted-CI projection or output poller. Selected terminal evidence delegates to the
configured Triage handoff and its canonical external-content framing. Person Run
uses the host client to invoke ordinary compute directly; agent/MCP uses the
plugin local-run Action with incumbent approval policy. Neither path grants the
other's caller authority. The compute declaration's direct policy suppresses
confirmation only for the present person's own UI invocation; automated callers
retain the dangerous-Action default and explicit Settings choices still win.
The plugin adds no confirmation. The form's nullable Machine display name uses
the public qualified `readMachineDisplayName` host read, backed by the existing
Machine display owner, not a plugin store or inventory scan.
Rendered integration and loaded-runtime evidence remain
pending; these source declarations do not establish released availability.

## Deployment target declaration boundary

In 0.3 development source, `deploymentTargets` is one descriptor-only family
with strict runtime and data alternatives. Runtime keeps its required Actions;
data has optional closed `dataV1` groups/leaves, with missing capabilities
unsupported and no runtime Actions required. Protocol owns strict manifest
admission, same-plugin declared Action/dynamic Resource references, schema
closure, placement and effect metadata checks. Declaration and normalized
catalogs share its role factories and kind-aware reference traversal. The SDK
projects `definePlugin` author records into that family; CLI normalization and
the canonical daemon projection retain the supplying occurrence and withdraw
the entry when that occurrence retires. The family grants no runtime registration
or invocation authority.

Protocol's `deploymentTargetRolesV1` source owns the strict runtime and qualified
data-role inputs and normalized runtime results. Data
project preparation does not fabricate a resource id; selected branch and secret
operations require the current data link, not a runtime Deployment receipt.
Dynamic data Resources use their declared backing Actions through the existing
Resource `readAction` bridge, so those reads share the same role map and admission
route as directly invoked Actions. Its existing
contribution exports and the deployment-protocol host facade reuse those same
validators. The SDK's readonly target declaration derives from that same contribution type.
Deployment outcomes use the Machine-services generic `deployment-failed` and
`deployment-succeeded` Events for every target, including Cloudflare. Runtime
target declarations do not select a separate failure-transition Event or payload.
The platform's finite `deployments.receipts.observe` Action dispatches the target's
declared observe Action; provider-specific notice enrichment stays in the host
platform adapter.
The finite `deployments.logs.read` Action likewise invokes the selected target's
optional `actions.logs.build` or `actions.logs.runtime` through the reviewed-child
role owner. Those roles use the shared native-log cursor/result schemas and the
retained receipt's provider deployment id; they do not settle or replay a deploy.
A log read retains the receipt's Link id, Account and provider identity; a later
revision of that same live Link does not invalidate its historical logs. Deleted,
detached or replaced Links retain typed identity/ownership refusals.
Own-server stage logs retain their native receipt reader. A missing target log
role returns `unsupported_action` naming `deploymentTarget.actions.logs.<kind>`.
The receipt projection supplies the existing UI's build-log reference for a
platform receipt with a provider deployment id and recorded controller.
Vercel declares build logs only. Its Account Action uses the existing
`deploy.manage` connected-account HTTP binding and a finite JSON snapshot from
[deployment events v3](https://vercel.com/docs/rest-api/deployments/get-deployment-events)
(`follow=0`, forward order, documented `limit=-1` for all available events).
Both Production and Preview use the retained deployment id and linked team scope.
Cloudflare Pages exposes a finite build-log snapshot through the same declared
log role and receipt reader, using the provider's
[deployment history logs](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/subresources/history/subresources/logs/methods/get/).
That API has no pagination parameters: the result has no continuation cursor,
and reports truncation when the provider's total exceeds the returned lines.
Health-check kinds, statuses and results likewise use the existing health owner,
not a deployment-private or SDK-recreated schema.
Private link content keeps the recorded Account/Team principal and
purpose selection separate from the provider's normalized identity tuple and
operational native scope. A Workers Preview identifies both its script and
preview; a generic Git Preview is a different closed shape. Receipt-free
preparation and source-free lifecycle reads do not invent a receipt or source.
Platform receipts carry real source provenance without a fabricated native
builder or member; own-server receipts retain their native proof requirements.

In 0.3 development, a Direct Team platform principal uses the same requester-scoped Connected Account purpose owner as the admitted deploy. The private host carries the actual Deployment receipt, Environment and operation identity into material acquisition. The requester's existing signed execution headers bind that acquisition to the Home's accepted, active receipt; an Account bearer or an arbitrary operation label supplies no platform authority. Home consumes the existing accepted-receipt lookup once and passes its typed result to the Team material route. Receipt-free platform Actions remain unavailable for Direct Team material. Session and Run purpose bindings retain their existing owners and lifetimes, and finite deploy material ends with the operation's existing cancellation and disposal paths.

In unreleased 0.3 source, Vercel promotion and rollback observe the acknowledged
alias operation, including its selected deployment and operation kind. An old
deployment's ready build does not establish that traffic moved. Workers traffic
changes select a native version, retaining that version for the existing finite
observer. Promotion and rollback succeed when that version serves all traffic;
an ordinary upload succeeds when its version has a positive serving allocation.
A Git Build must resolve to one version, and a native Preview is not a
production rollback source. Pages rollback selects an existing Production
deployment; Preview promotion is unsupported. These adapters add no separate
observer lifecycle. Real-tenant traffic changes remain release checks.

In unreleased 0.3 source, Connect and Check again invoke the same qualified
inspection Action: `happier.deploy.vercel/actions/targets-inspect-v1` or
`happier.deploy.cloudflare/actions/targets-inspect-v1`. These replace the former
`project-prepare`, `workers-prepare` and `pages-prepare` registrations. Inspection
reads provider facts without creating or deploying a target. Both plugins'
declared input types use a global, non-surface `target-options` Resource through
the existing `action.options.resolve` partial-draft query contract above.
Its read-only backing Action retains credential custody; draft account, product,
project and environment selections do not grant authority. This is source
wiring, not a claim that the platform-link UI or a real tenant journey is complete.
Vercel account choices use the selected Connected Account's configured Team
scope and connection label. They do not enumerate personal or unrelated Team
identities, so project-scoped tokens need no user or Team metadata access.

The optional closed `preparedNative` operand retains the captured native project
name, GitHub repository id, optional Cloudflare build-trigger UUID and captured
Preview id, actual Git branch (using the canonical SCM branch-source-ref grammar),
Worker tag and script name in protected link
content, candidate and receipt provenance, and qualified lifecycle input. The host also retains the link's
repository-access observation. Lifecycle handlers consume those captured facts
with the canonical source intent and environment; they do not re-probe Connect
or use plugin storage to recover them. Host role admission compares this operand
against the selected protected link and receipt at its existing boundary.

Vercel Inspect retains its production-branch Preview refusal. For other Preview
selections it performs one existence GET to
[`/v7/deployments?target=production&limit=1`](https://vercel.com/docs/rest-api/deployments/list-deployments)
scoped to the selected project and Account. With no Production deployment, it
returns the Production environment and a captured `preparedNative.reviewNotice`
explaining the first-Production behavior. Generic approval preparation displays
that provider-owned notice in its existing summary; lifecycle actions consume
the reviewed Production environment. This follows
[Vercel's own first-deployment rule](https://github.com/vercel/vercel/blob/main/packages/cli/src/util/deploy/process-deployment.ts#L284).
The optional notice extends the unreleased closed V1 preparation object under
the 0.3 direct cut: current readers accept older objects without it, while older
strict development readers must reload before new link content is written.
No option, epoch, refusal or request override is added for an empty project.
For Account-backed roles, that same admission requires the immutable link's
author Account to equal the recorded credential principal, so another Team
manager cannot redirect that person's credential by replacing a link.
This is an unreleased 0.3 source contract; the SDK facade/publication and product
preparation/lifecycle consumer must land together before claiming the full flow.

The unreleased Cloudflare plugin contributes the `cloudflare-workers` runtime
through Account Actions for preparation, linking, deploy, observe and cancel.
Preparation captures the selected script's repository access and build-trigger
UUID; deployment consumes that protected operand with the reviewed commit SHA.
Recovery with a retained native build id observes it rather than submitting
another build. Build success alone does not establish serving: the native
adapter requires the retained build to account for the current traffic-bearing
versions, and reports unknown when that evidence is unavailable. The selected
Connected Account's existing `deploy.manage` purpose supplies HTTP credentials;
there is no plugin-local credential or link store. These source paths do not
establish Pages support, installed-controller readiness,
package-build completion, credential-review clearance or a real tenant journey.

The same Workers target's public Account Actions also consume native Preview
preparation, Git build, observation, cancellation and retained-build recovery.
Preview preparation resolves the
exact name beneath the documented Worker name, keeps the Builds Worker tag
distinct, requires a successful exact Builds identity read, and captures the
provider's Git branch independently of that name. It projects repository access,
not Base configuration or secret values; a missing Preview never falls back to
production. Preview builds consume the captured native identity, independently
observed Git branch and reviewed commit. A successful build is serving only
when its artifact URL belongs to the exact native Preview's latest immutable
deployment URLs; the stable Preview alias alone is not that evidence. Missing
serving proof remains unknown, and retained build recovery never resubmits the
write. Workers and Previews share Builds status normalization while retaining
their distinct native serving proofs. Preparation captures the Preview id,
actual branch, Worker tag and script name in the same protected `preparedNative`
operand. Linking performs no provider read; lifecycle Actions consume those
admitted coordinates rather than re-running Connect. The existing host admission
rejects substituted native operands before credential acquisition. Production
Workers still require their native trigger UUID; Previews do not invent one.
The Pages target adopts an existing project through its Account prepare/link
Actions. The closed `preparedNative.pages` carrier records its project mode,
production branch and non-secret build configuration; it never copies provider
environment variables. The daemon `uploadDeploy` Action materializes the reviewed
source through `services.deploymentSource` and uploads prepared assets and
Functions. Its pinned foreground container uses the existing public Exec
run/spawn and process disposal owner,
with Docker `--rm` and an invocation-specific container name. Per the O-DEPLOY/
O-OPS ruling of 2026-11-02 responding to OPS-P43's 13:30 ASK, cancellation may
briefly leave the container visible in `docker ps` until Docker reaps it; this
is an accepted, recoverable delay, not a prerequisite for another Exec cleanup
seam. A container actually surviving disposal requires a reproduction before
escalation to the Exec owner. Only sanitized staged source enters the build
container; the full reviewed repository is staged, with `rootDirectory` selecting
the build working directory so monorepo sibling imports remain available. The
container runs as the staging directory's owner so generated files remain
removable by invocation cleanup. Account credentials and project-issued upload
JWTs remain outside it.
The existing purpose-bound HTTP owner obtains the project JWT and sends the
final deployment; asset requests use that derived JWT without the Account token
binding. Source custody stays uncommitted for invocation cleanup.
The observer distinguishes build success from deployment success and projects
only the canonical status, retained id and valid public URL. A retained id skips
source acquisition, build and upload. The upload invocation returns the accepted
deployment id without a local status loop. Per the O-DEPLOY ruling of
2026-11-03, the one-link P50 enrollment owns both unattended receipt settlement
and failure notices through the public SDK checkpointed observer. It invokes
`deployments.receipts.observe`, which performs the finite descriptor observe
Action and writes through the existing signed receipt transition owner.
Pages has no advertised native cancel Action. A finite observation never repeats
deployment creation or exposes project configuration. Provider eligibility and
authenticated wakes belong to that source; unavailable observation remains
visible rather than introducing a local cadence or reporting deployment success.
The source's optional `periodMs` is chosen explicitly in its existing setup form
and retained in the same private enrollment. It supplies SDK eligibility only
while receipts remain pending; there is no default interval, and an unconfigured
pending source reports attention. Once receipts settle, the source parks until
the existing authenticated receipt or reconnect wake. This policy is owned by
P50-PLATFORM-WATCH (2026-11-03 configured-eligibility contract), with no Pages timer.
Its setup and settled-change reads use the machine-placed native
`deployments.observation.get` Action. The deployment owner admits the exact
Environment, target Link and optional receipt from Account-authorized metadata
before opening private content, and returns the recorded credential principal
reference and optional receipt provider deployment id. Its ordinary metadata
read exposes no credential material or Artifact body and performs no provider
request or settlement effect.
In development source, an explicit `variables: true` read on the selected
platform Link spends the existing reviewed `variables.read` child once and
returns `providerVariables` metadata: presence, ownership, secrecy and drift,
without values. It does not settle a receipt or synchronize variables. Ordinary
observation reads retain their zero-provider-request behavior.
Original callers retain installed requester custody through Home admission;
native metadata reads spend the signed Environment scope, and private storage
reads retain the requester's Account and Artifact authorization.
Generic Artifact reads continue refusing internal deployment kinds. The source
retains its principal binding for enrollment and C1 notice admission, and consumes
the Environment protection returned by the same native projection.
Cancellation or a typed credential/host refusal follows the
existing Action failure path: the reviewed-child host currently persists the
failure phase, not a newly accepted id carried only in error details. Recovery
in that case may require finding the deployment in Cloudflare; the adapter never
replays deployment creation to guess the outcome.
The documented Pages Git endpoint deploys branch HEAD; associated commit metadata
does not establish immutable checkout. Exact-source Pages upload remains a
separate explicitly selected controller operation, not a Git failure fallback.

In unreleased 0.3 source, Workers Upload uses that same reviewed-source and
foreground controller-build path. Pinned Wrangler emits executable modules;
Static Assets use the helper version declared by that Wrangler installation,
then the existing purpose-bound HTTP owner opens the asset upload session and
publishes the compiled script. Provider credentials stay outside the build
container. Native Preview uploads require an explicitly configured Preview and
publish to its captured identity; they never publish the parent script. The
accepted native version or Preview deployment id feeds the existing finite
observer rather than a second status loop. Source, build-toolchain and output
fingerprints remain receipt provenance. Container execution and real-tenant
publication still require release validation; source tests alone do not prove
either environment.

Vercel Inspect accepts an absent Source repository at Action admission and
returns the non-retryable `repository_required` prerequisite before provider
HTTP. The platform link sheet presents that result with a remedy to connect a
repository to the Source. This differs from `needsGitAccess`, which observes
Vercel's access to an existing repository and may offer a provider Git grant.
Both supported deploy modes consume a reviewed repository commit; upload skips
Vercel's native Git integration, not the repository-backed Source requirement.
Provider Git builds can prepare a compact Deploy from a repository Source with
no Workspace attachment. The Source's hosting provider declares an optional
`resolveRefAction`: a safe, read-only Account Action accepting `{repository,
ref}` and returning `{kind:'value', value:{repository, branch, headSha}}`, or a
typed unavailable failure. The host invokes it through the original requester's
Account executor, checks that the returned repository and branch match, and pins
the immutable commit before approval. The Environment's repository definition
`ref` selects that source branch; provider environment labels do not change it.
GitHub uses its existing repository and
commit-by-ref reads with the configured GitHub Account purpose. Missing provider
support, credential selection or ref refuses preparation; it never substitutes
a default branch. Explicit immutable SHA inputs do not acquire SCM credentials.
Approval shows the selected branch and the first seven characters of that SHA.
The reviewed candidate, receipt and provider execution retain the full exact SHA
if the branch advances.
Upload mode and own-server Compose still require a registered local Workspace.
These are unreleased 0.3 preparation semantics; the deployment Source intent
continues to store an immutable SHA.

Its Inspect form submits `providerAccountId`, native `projectId`, and
`providerEnvironment`; the plugin constructs the normalized comparison identity
in its provider preparation. Complete `providerIdentity` inputs remain supported
for existing CLI/reinspection callers. The options Resource and Inspect share
the plugin's coordinate reader, so choice admission supports both forms.
Hosts do not synthesize that tuple from
the environment selector, and stored link identity requirements are unchanged.

The unreleased 0.3 hosting-provider descriptor also accepts
`projectReadinessAction`, a safe, read-only Account Action accepting
`{repository}` and returning that repository with independent `ci` and
`security` facts (`status` and `reason`). These facts describe current source
presence, rather than successful CI runs or an absence of security findings.
Providers compose these facts with the SCM owner's
`ScmHostingProjectReadinessSourceFactV1ProtocolSchema` from the SDK's `/protocol`
facade; the Project readiness composite derives its base fields from that owner.
An optional `setupSurface` is the provider's existing native destination;
GitHub offers its Project Actions page and its Triage source-settings page.
The provider owns its private source configuration and credential access.
GitHub reads workflow presence through its existing CI reader and security
coverage through Triage's caller-scoped configured-source reader. Retired or
other-repository sources do not establish coverage; an All-repositories source
must be able to read this repository through its own configured credential.

The Vercel target also declares a controller-daemon `uploadDeploy` Action. It
acquires the approved receipt's source through `services.deploymentSource`,
uploads binary-safe file bytes and native modes to Vercel, and starts the remote
build through the files arm, never `files` plus `gitSource`. It does not run a
project build or require native Git access on the controller. Local environment
and credential files are excluded; application configuration remains source.
Upload custody stays uncommitted so invocation cleanup can remove it. A retained
provider deployment id is observed without materializing or uploading again.
The portable Account activation entry stays separate from this daemon's native
filesystem code; artifact export/publication remains its own integration step.
Provider build acceptance is progress, not terminal serving proof. Cloudflare
upload uses that same existing Exec process lifecycle for its pinned foreground
build container, with the brief Docker reaping delay accepted above.

These are unreleased source contracts, not executable target certification.
Installed-role admission and host-child review inheritance, platform upload and
failure-Event consumption, and native managed-data execution still require their
composed integration evidence. An admitted or projected descriptor alone does
not establish those capabilities.

## Host-admitted retained workloads (0.3 development)

`context.services.managedServices.observeWorkload({ serviceId })` returns an
opaque handle only within the host's admitted retained resource. The handle's
`snapshot()` and pushed `observe(...)` use the existing Machine Service row,
including health, endpoint and projected native ports. `control('start' | 'stop' |
'restart')`, `readLogs(...)` and `watchLogs(...)` use the incumbent native adapter
and exact generation. An observation-only admission returns unsupported for
mutation. No plugin-authored Machine, Account, source receipt or native effect
operand grants authority.

Daemon deployment-role admission supplies the initial Environment consumer.
It joins existing Machine Environment recovery, including after daemon restart;
the returned handle itself is process-local. `dispose()` and invocation cleanup
detach observation and log following without stopping the serving resource.
Explicit admitted Stop or deployment teardown remains the effect owner. Existing
Compose/systemd and plugin native adapters retain their platform contracts;
unsupported adapters/platforms and absent host admission return typed unavailable.
This is an unreleased source contract, with loaded-runtime replay tracked separately.

## Bot identity and page layout adapters (0.3 development source)

Plugin UI's public `BotFace` accepts the saved face value already exposed by
the public template Action DTOs and a caller-owned stable seed. The private
presentation host delegates it to `SessionBotFace`, retaining the app's saved
face resolution, Account defaults and motion owner. It acquires no Session or
Resource. Public `PageAsideColumns`, `PagePinnedBar` and `KeyboardStickyFooter`
delegate to the existing app components through the same bridge; no second
layout, chrome-clearance or keyboard policy is introduced. DetailsPane retains
its existing keyboard-footer port.

These are same-realm native/RNW presentation capabilities, not new HostApi RPCs
or a runtime ABI revision. Unsupported hosts use the author's optional fallback
for the face, columns and pinned bar; the keyboard wrapper keeps ordinary-flow
children. `BotTemplateHeader` remains an app-owned template release/recipient
composition. Plugin authors use `PageHeader` and `BotFace` without adopting that
screen's release, sharing and provenance model.

## Generated-output maintenance in development

Bundled executable packages declare their generated daemon, runner leaves and chunks
under `.happier-plugin-build/`, outside compiler-owned `dist/` and author source.
The internal `.happier-daemon-outputs.json` ownership record lives there too and
is excluded from portable plugin archives. The fixed public manifest remains
`.happier-plugin/plugin.json`; the loader follows its declared entrypoints, including
older packages whose runtime remains under `.happier-plugin/`. Hosted-web author
source stays under `.happier-plugin/ui/hosted-web/`. Package `files` inventories
include the generated runtime directory when shipping these executable leaves.

The canonical bundled-plugin publisher isolates per-plugin source and artifact
failures in development writes. Healthy packages publish their new manifests;
failed packages retain their last published catalog/UI declarations and installed
artifact. Artifact inventory validation precedes replacement. The command returns
`publishedPackageNames` and typed `failures` naming each package and its diagnostic;
the existing publication-failure file supplies runtime diagnostics. Catalog-wide
identity/reference admission remains strict. Required host packages may retain
an existing publication; a cold required-package failure still refuses the build.
Check mode still rejects failures, and release preparation still requires its complete
runtime closure. No batch revision is shared across plugin manifests.

To republish Triage through this same owner without preparing unrelated plugins,
run `node --conditions=happier-source --import ./packages/cli-common/registerSourceRuntime.mjs apps/cli/scripts/build-owned/generateBundledPluginEntries.ts --mode write --package-artifacts --workspace plugins-triage`.
The lifecycle owner then reloads the consuming stack before a live replay.

The lane changing a generator's inputs runs its canonical writer under the
writer's publication lease. Integration owns package-wide validation, rather
than being the only publisher. Consumer-only edits do not require republishing
unrelated DTOs, toolchain fixtures, or documentation.

For a coherent Plugin SDK public-surface batch, run
`pnpm --dir packages/plugin-sdk run api-governance` once. Preserve its source
materialization, compilation and post-build source/declaration governance phases.
A subsequent declaration check reuses that result through
`check:api-governance:prepared`; do not repeat `check:prepare:api-governance`
after that successful preparation. The full batch still checks emitted
declarations, signature/realm closure and the capability matrix. Ordinary Plugin
UI and client SDK typechecks consume prepared inputs; they do not publish
toolchain fixtures or API records. Changes to the toolchain's own facts still
require `generate:public-toolchain` and `check:public-toolchain`.

Source Agent preparation and live UI preparation retain their source-first
owners. Request `--package-artifacts` only when publishing the executable
package/runtime closure, including a CLI runtime build. A source-only check or
manifest/UI preparation does not require that package publication.

`pnpm --dir apps/docs run generate:reference` owns the reference-page batch,
including the Protocol-rendered Action reference. Use `--only=host-actions.mdx`
for an Action-only change, and `--check` to verify selected pages without writing
them. Protocol's reference script aliases delegate to this registry; do not run
both aliases and the complete docs batch for the same inputs. The renderer uses
canonical Protocol freshness and a fresh subprocess module cache.

## Page Tabs navigation (0.3 development source)

Public `Tabs` can declare `presentation="page"` with a qualified `pageKind`. Its Items remain the declaration for panels, labels, badges, disabled state and portable navigation metadata. The installed HostApi `setPageNavigation(descriptor | null)` lends that declaration to the physical page mount; it adds no Resource read or backend request. Nested `tabList="host"` Tabs retain their panel behavior and do not publish another declaration.

The host validates the closed Protocol request and resolves Items through the existing detail-navigation owner. The optional `SurfaceContext.page.navigation` projection returns saved strip order, desktop overflow ids, presentation and a transient selection request through `watchContext`. The strip stays in the document's detail column. Its strip and desktop More select through the existing `shell.column.set` Action; hosted desktop Customize invokes the existing `appearance.navigationPlacements` settings anchor to open the shared host customizer for the mounted kind. An absent mounted kind is unavailable. Phone top mode leaves overflow in the single host bottom More. Phone bottom chrome follows the same descriptor's controlled value. Tabs calls its existing `onValueChange` once for a request and republishes the controlled descriptor even on rejection; the host clears that request on the next publication. Clearing the request, changing placement or changing theme does not select again. Mount retirement withdraws its declaration.

The operation belongs to HostApi 1.1.0's installed method set. A host without it retains ordinary local Tabs; the 1.0.0 context projection omits `page.navigation` for its closed reader. This does not change the runtime ABI or introduce a new transport. The schemas live in `packages/protocol/src/plugins/ui/pageNavigation.ts`; public SDK types derive from them.

### Page companions

A `companion` or `both` Item names a destination that opens beside the page. For an App page that destination is an App `rightSidebarTab` view declaring `reach: 'pageItems'`: it is never listed among the App-wide side tabs (nor in a Session's or Project's App tabs) and exists as a tab only while the presented page names it in its own Items. Selecting the Item opens it through the ordinary `openSurface` resolver with the page's launch input as its own. The companion also reads its opener through `SurfaceContext.openedFrom` (`pageKind`, the page's `launchInput` and its current `subPath`), kept current while that page stays presented. `openedFrom` is a read of the opener, not navigation and not authority: a pane still refuses a `subPath` on `openSurface`, and the 1.0.0 context projection omits the field. The page keeps its chrome while a companion is open: a detail drawn in the side column (a Session the companion embeds) never takes the presented detail chrome, which belongs to the main column (`createPresentedDetailContext` reads `usePaneRegion()`). Owners: `pluginDetailNavigation.tsx` (opener and published opener facts), `rightSidebarPluginTabs.ts` (listing rule), `AppScopeRightSidebar.tsx` (provides `openedFrom` around a page companion), `pluginSurfaceContext.ts` (context field). Triage's entry Session is the first consumer.

## Related

[Runtime core](runtime-core.md), [Agent catalog](agents-catalog.md), [Providers](providers.md), [Actions](actions.md), [feature gating](feature-gating.md), [encryption](encryption.md), [binary runtime](binary-runtime.md), [Collection presentation](collection-presentation.md), [surface states](surface-states.md).

## Standing rules for agents (moved from root AGENTS.md)

Root `AGENTS.md` "Runtime core, plugin platform, and SDK seam" points here.

- The centralized host runtime owns executable session and turn lifecycle, prompt admission/queueing/custody, canonical lifecycle projection, effective activity/thinking, work-state arbitration, pending-queue pumping, message streaming, transcript writes, and the process-terminal fact. Plugins provide provider-native codecs, correlation, authoritative evidence, and typed contributions; they do not become parallel owners of host state.
- Plugins register behavior through the single `activate(api)` ABI and only for manifest-declared ids in the matching contribution family. Plugin leaves reach the host through the public SDK/services seam and must not import host internals. These rules keep catalogs and projections consistent; they are not a security boundary.
- Retired escape hatches must not gain new consumers: `registerProviderRuntime`, parallel Agent/runtime registries, `RuntimeControlContribution`, `getSession*ControlAdapter` caches, whole-metadata state patching, `initialRuntimeState`, post-construction `startOrLoadSession`, method-presence fallbacks, provider-written applied-rollback events, and provider-owned `setThinking`. Existing migration-only uses require a named positive-consumer migration and are removed atomically after the canonical replacement is proven; do not delete a compatibility seam while first-party plugins still depend on it.
- `packages/plugin-sdk/` is the only public host↔plugin interface and stays minimal. `RuntimeCoreV1`, `AcpSessionRuntimeV1`, raw lifecycle controls, and agent-meaning `provider`/`backend` are transitional or retired vocabulary: do not add uses or publish them as graduated API. Remove predecessor exports, factories, and host adapters only after native `AgentRuntime` consumers have replaced every reachable first-party use.
- Runtime events converge on one canonical strict-schema union. Stable events use bounded strict schemas and reject unknown top-level fields; provider-native bags and generic `{ kind, data }` streams are not public ABI. Any compatibility period with two unions names the active producer/consumer directions and the contraction condition. `@happier/runtime/*`, `@happier/lifecycle/*`, and `@happier/session/*` are host-emit-only namespaces.
- Each contribution family has one catalog/normalizer/projection owner, generated projections are authoritative, and feature/availability/confirmation decisions use the shared policy owner. Do not add a second registry, catalog, loader, or decision engine for a concept the platform already centralizes.

## Runtime core, plugin platform, and SDK seam

Read [runtime ownership](runtime-core.md) before changing runtime core, the plugin platform, or the SDK. These tracked pages own standing architecture guidance. When executing an approved plan, also read that plan and its assigned specialist as the execution contract; plan history, status and evidence do not become standing implementation rules. The older plugin-platform and SDK convergence corpora remain historical/extraction evidence only and cannot supply current status, restart authority, gates, or implementation authority.

- The host runtime owns session/turn lifecycle, prompt custody, transcript writes and work-state; plugins contribute through the single `activate(api)` ABI and the public `packages/plugin-sdk/` seam only.

### Installed update discovery (unreleased 0.3)

The CLI registry update checker includes installed plugins on its existing check
cadence. The plugin lifecycle's `readInstalledPluginUpdateCandidate` reuses the
trusted-channel selector and source resolvers used for update preparation. Npm
checks read metadata; archive checks stage temporary bytes and remove them after
reading the manifest. Discovery never prepares an installed generation or applies
an update. Store consumes these finite observations and opens the existing plugin
update review; installed trust and update policy remain lifecycle-owned.

### Usage observations (unreleased 0.3)

Session and finite-Run usage carriers consume the shared payload in
`@happier-dev/protocol/runtime/agentUsageObservedPayloadV1`; the SDK derives its
Session usage type from that payload. A child reports its own witnessed
`accounting.nativeSessionId`, even when it has no counted prompt or total.
Omit unavailable measurement objects, or use `null` for unavailable numeric
fields within a supplied token/cost object. Keep measured raw, output and cache
categories without adding them into a guessed total. Missing counter semantics
remain absent. The host retains that source identity separately from parent
accounting, and Usage presents missing measurements through its existing coverage
and unpriced-facts paths.

### Idle compaction (unreleased 0.3)

Claude's SDK adapter uses one launch-options builder for foreground, transient
control and resumed compact queries. `compact()` keeps operation identity and
requested trigger outside foreground input state; native boundary/result/exit
and cancellation settle it. The shared Claude assistant usage builder retains
the native cache-creation duration split. A matching live main-chain request
start supplies `promptCache.lastUseAtMs`; one-hour writes additionally supply
the canonical vendor lifetime. Short/unknown classes omit `ttlMs`, and neither
replay nor result accounting reconstructs a live request clock. Unified terminal
shares the usage builder and measured-count reader but owns native idle
scheduling; it does not acquire an SDK resume dialog.

An Agent opts in through the canonical Session compaction descriptor, not an
Agent-id allowlist or a plugin settings field. Author it once with the Agent
definition, then publish the opened runtime's resolved capability through the
existing runtime-kind projection. `manual` requires a real `compact()` control;
`idle.mode: 'host'` requires that control to accept `trigger: 'idle'`. A native
mode declares the supported defaults it can honor and receives them through the
host's existing Session-open input. Unsupported modes remain explicitly absent.

Plugins report `usage-observed.promptCache.lastUseAtMs` from live request facts
and add `ttlMs` only when the last request's route/lifetime class is known.
Codex, Pi and OpenCode use the public SDK's
`resolvePromptCacheLastUseAtMs({ turnStartedAtMs, lastNonModelItemCompletedAtMs })`:
the last non-model item completion wins, otherwise turn start, otherwise no
clock. They do not substitute receipt/model completion, reconstruct a live clock
from historical usage, or copy the selection rule into each plugin. Durations
come from the shared vendor-facts export, never a local TTL table. A GPT-5.6+
model qualifies for Codex's detected lifetime only with positive route-probe
evidence; model/auth identity and cache totals alone are insufficient.

The host owns preference resolution, the effective window, one Session timer,
idle admission and quiet transcript projection. A clock-only observation can use
the person's cache-window override; missing clock cannot. The three host defaults
are exposed through existing settings Actions and apply to new Sessions, not
through plugin-specific Actions or setting subscriptions. See
[runtime ownership](runtime-core.md#idle-compaction-unreleased-03) and the
[public author guide](../apps/docs/content/docs/plugins/agent-runtimes/index.mdx#idle-compaction-unreleased-03).
This is an unreleased development contract; a declaration alone does not prove a
loaded native operation or provider cache lifetime.
### Project starter registry items

Plugins may contribute a `starter` registry source alongside app sources. A starter names an HTTPS forge repository, an optional repository subpath, human-facing title and description, tags, an optional preview image, and a build goal. It deliberately carries no commit pin: project creation resolves the repository's current release or default branch through the SCM owner and records the resolved checkout commit on the created Project.

## Plugin UI Action failure presentation (unreleased 0.3)

Native and hosted-web plugin UIs share `hostApi.presentActionFailure(failure)`.
The closed input projects the Action failure envelope (`errorCode`, optional `error`,
optional `failureCause`, `details` and `requestId`, plus optional authored
`message` and `remediation`). The authored reason and recovery take precedence;
code copy is the fallback. The host delegates to
`resolveActionExecutionFailureMessage`; it does not maintain another code map.
The result carries `reason`, `nextStep` and `technicalDetails` lines compatible
with TechnicalDetailsDisclosure. Today the presenter combines reason and recovery
in one message, so `nextStep` is null. Details reuse the safe-detail projection
and the typed cause; opaque producer data is not disclosed.

This is an optional method in semantic Host API 1.1, wire epoch 1. Authors check
`version().methods`, or use the SDK's `presentActionFailure(hostApi, failure)`
helper, which retains the producer message, code and request ID on older hosts.
Existing closed envelopes and older-host methods are unchanged. Caller-authored
HTML's existing restricted method ceiling is unchanged.
