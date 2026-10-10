# Providers

Providers are model sources such as OpenRouter, DeepSeek, Z.AI, Ollama, or LM Studio. They are separate from **Agents**, the executable coding tools such as Claude Code, Codex, OpenCode, Gemini, and Pi.

This distinction is a product and architecture invariant:

- an **Agent** owns executable behavior, session lifecycle, authentication to its native CLI, and the protocols it can consume;
- a **Provider contribution** describes a model source supplied by a plugin;
- a **Provider connection** is an account-owned configuration of that source, including endpoint overrides and credential bindings;
- a **Profile** is an optional launch preset. Profiles do not own provider endpoints, provider credentials, or provider model catalogs.

See [Agents catalog](./agents-catalog.md) for executable-agent ownership.

## User experience

Users manage model sources under **Settings → Providers**. A provider connection may be a built-in plugin contribution or a custom OpenAI-/Anthropic-compatible connection.

The normal flow is:

1. Open **Settings → Providers**.
2. Enable a built-in provider or add a custom provider connection.
3. Bind an API key through Saved Secrets when the provider requires one.
4. Test the connection on the machine that will run the session.
5. Select one of the provider's models from the grouped model picker for a compatible Agent.

Provider setup is intentionally separate from session launch. Once configured, users choose a model rather than repeatedly choosing or re-entering a provider.

Local providers are machine-aware. A detected Ollama or LM Studio service appears for the machine on which it is running; using its models requires that target machine to be authorized and available. Account-only browsing can show declared static and manually entered models without asserting that a local service is running. A local/private endpoint must be enabled per machine before Happier resolves its secret or sends it network traffic.

The CLI mirrors the same ownership:

- `happier agents ...` manages executable Agents and their runtimes;
- `happier providers ...` manages model-provider connections, probing, and catalogs.

## Identity model

### Provider contributions

`ProviderContributionV1` is plugin-owned, declarative, and immutable at runtime. It contains provider facts:

- stable contribution id and display metadata;
- endpoint templates and their wire protocols;
- public, non-secret headers;
- credential requirements and permitted transports;
- static and/or probed model catalog declarations;
- compatibility capabilities and explicit overrides;
- safe local-process detection descriptors for local providers;
- optional legacy-profile migration descriptors.

The canonical schema is `packages/protocol/src/providers/contributions/v1.ts`. First-party contributions live in `packages/plugins/<providerId>/src/provider/contribution.ts` and are projected through the same plugin contribution registry used by third-party plugins. Built-in providers must not bypass this path.

### Provider connections

`ProviderConnectionV1` is user-owned account configuration. A contribution can have multiple connections—for example, personal and work OpenRouter accounts or two Azure deployments. A connection contains:

- a stable `providerConnectionId`;
- a contribution reference or a fully typed custom-provider template;
- a display name and default/named role;
- account-wide or per-machine endpoint overrides;
- optional model-id-keyed generation settings (`temperature` and `maxTokens`);
- a monotonic revision and timestamps.

Credential bindings, enablement, machine grants, visibility choices, and manual models belong alongside connections, not inside the immutable contribution. Raw credentials remain SavedSecret resources. The canonical schemas live under `packages/protocol/src/providers/connections/**` and `packages/protocol/src/providers/settings/**`.

The 0.3 development storage contract groups connections, grants, bindings,
manual models, visibility/confirmation choices and unresolved migration conflicts
in one private Account catalog owned by `connections/connectionRowsV1.ts`.
`defaultsByAgentTargetKey` is deliberately excluded: the genuine preference is
`providerDefaultModelSelectionsByAgentTargetKeyV1`, with its typed shape owned by
`selection/v1.ts`. A missing connection does not erase selected intent or imply
native fallback. Catalog revision and Account Settings revision are separate
authority facts. Retained `providerSettingsV1` is an import source, not a second
current persistence contract; consumer contraction and composed conversion are
still being integrated. See [private catalog encryption](encryption.md#private-agent-provider-and-connected-account-catalogs-03-development).

In 0.3 development, Account-scoped connection CRUD, Account endpoint and SavedSecret
bindings, manual models, visibility and confirmation persistence use the shared
`connections/accountProviderActionV1.ts` semantic owner. UI and CLI adapters capture
the Account catalog and write through its revision-checked CAS boundary; these
operations do not require a selected machine or fall back to machine-RPC writes.
Machine-scoped grants and bindings, detection, DNS/network checks, probing, loading
and execution still require their machine authority. A successful Account write
does not prove runtime access or endpoint health.

An Account-only description of an admitted vendor gateway reports process status
and peer reachability as `not_checked`. These facts are separate from endpoint
probe health; a saved placement or an online computer does not prove a running
gateway or that another computer can reach it. The G1 live-custody producer and
its UI wiring are still being integrated in 0.3 development.

The development connection update Action accepts a validated replacement
template only for an existing custom connection, with its captured connection
revision. It keeps SavedSecret bindings and manual models, retains endpoint
overrides whose template ids still exist, and advances the connection revision
through the same catalog CAS writer. Security changes withdraw affected Account
and machine grants; a name-only template edit retains them. A built-in
connection cannot be rewritten as custom through this operation, and a stale
revision refuses without committing the draft.

Agent Models can browse compatible static and manual Provider models without a
machine. `catalog/accountModelProjectionV1.ts` merges the stored Account catalog
with admitted Provider declarations and the selected Agent's actual manifest
`providerRequirements`. The bundled UI declarations come from the existing
bundled-plugin generator; the CLI uses its admitted manifest registry. Missing
Agent requirements refuse the projection rather than assuming compatibility.
These rows are `account_unverified`, with unknown load state, unchecked health,
no probe observation and no runtime confirmation. Their declaration fingerprint
is not executable-adapter evidence and cannot prompt runtime confirmation.

In 0.3 development, retained 0.2 Voice OpenAI-compatible Chat settings import
into the connection's `modelSettings`, not per-prompt Voice configuration. The
spawn resolver passes only the selected model's settings to an adapter that
declares support; otherwise it returns `provider_incompatible_with_agent` rather
than silently dropping them. OpenCode writes `maxTokens` as the native model's
`limit.output` and temperature into its `build`/`plan` Agent configurations,
enabling the model's temperature capability. `limit.context: 0` preserves
OpenCode's existing unknown-context default for these custom models; it is not
an invented context allowance. These are native configuration fields, not model
`options.temperature` or unsupported V2 per-prompt overrides. See the
[OpenCode Agent configuration](https://opencode.ai/docs/agents/#temperature)
and [native schema](https://opencode.ai/config.json).

Distinct imported Chat and commit models retain Chat temperature and the
predecessor commit temperature of 0.2, respectively. When their model ids are
identical, the one model settings entry retains the user's Chat temperature;
the native per-model binding cannot also express a different commit-only
temperature. OpenCode's native output-token ceiling still applies to
`limit.output`. This does not claim arbitrary custom native Agents inherit
the `build`/`plan` temperature setting.
Non-positive predecessor token values remain stored, but OpenCode materialization
refuses them explicitly: its native zero means “use the default”, not a zero-token
request. Unset values leave native defaults unchanged.

### Source discovery policy (0.3 development)

`modelPickerVisibilityByConnectionId` is an optional sparse map in that private
catalog. Only explicit choices are stored. The Protocol policy in
`catalog/modelPickerVisibility.ts` defaults frontier, cloud, local and custom
sources on, and aggregators off. This is presentation policy, not authorization:
it changes neither connection revision, credentials, grants nor an applied route.
Deletion clears the override; duplication carries an explicit choice without grants.

The shared Protocol picker projection in `catalog/pickerProjectionV1.ts`, consumed
by the CLI and Account projection, distinguishes ordinary discovery from explicit source browsing,
management and route consumers. An off source retains exact current, default and
favorite model refs; that exception never reveals its unrelated models or bypasses
the narrower per-model hide policy. Team/broker consumers do not inherit discovery
filtering. Ordinary picker projections also return `hiddenSources` for off
sources with withheld rows or retained exception rows. `modelCount` counts only
withheld rows and can be zero when every row is retained; source-off is the
visibility owner's fact, not an inference from that count. The UI names them
under the model grid and browses one in place through
the same projection with `sourceConnectionId`; browsing never writes a selection.
Rows carry their source as data; the picker shows "· via <source>" only where a
heading cannot (a name present under more than one source, or a Provider/Team row
in Favorites), so identical names are never merged.

`providers.models.source_visibility.set` is an Account Action with no machine input.
In 0.3 development, the UI and CLI use their captured Account catalog read/CAS writer;
frontends without that writer refuse the operation before transport. A source
switch also needs the stored connection and its declared kind, never a guessed
default from runtime model counts. No machine-RPC write fallback exists.
An uncertain catalog write requires current-state review rather than automatic
replay; a catalog CAS conflict retains the existing connection-changed recovery.
The shared `resolveSessionRoutePresentation` selector accepts the exact draft or
runtime-applied selection, separately presents pending intent, preserves Team V2
identity and leaves missing applied facts unknown. `presentSessionRouteChip` is the
one owner of the composer chip's words ("Runs through <source>", or "Now via
<applied source>" plus a pending mark); without applied evidence it yields nothing
and the incumbent label stays. Child Run headers read R2's `resolvedSelection`
("Inherit session · <route> · <model>"). Composed live validation is still pending.

Persisted selections, favorites, drafts, session metadata, fork/resume state, and model-switch requests must use `SessionModelSelectionV1`. A provider model is identified by the exact tuple:

```text
{ agentTargetKey, providerConnectionId, modelId }
```

Native models use the same shape with `providerConnectionId: null`. Never infer a connection from a model id, concatenate provider/model ids into a wire id, or silently fall back to a native model when a connection is stale or unavailable.

In 0.3 development, Usage contributions retain the applied Provider contribution
key as `providerId` and its connection identity as `providerConnectionId`, separately
from `agentId`. The Session publisher takes these facts from the validated runtime
binding only when its model matches the observation. Work consumes this accounting
projection; it does not infer a Provider from an Agent logo or model name. Historical
observations without that witness, native captures and unattributed cumulative
remainders return null identities. Custom connections can have a connection identity
without a contributed Provider key. This projection carries no endpoint or credential.

When a caller names a model id but omits the connection, the Session itself completes the tuple: an active Session from the Provider binding actually applied to its running runner, an inactive Session from its persisted canonical intent. That completion has three outcomes, not two. Absent state means native. Valid state means the connection it names. State that is **present but unreadable** means unknown, and the operation is refused with `model_selection_session_provider_state_unreadable` before any transition RPC, metadata CAS, or prompt admission — a corrupted binding or intent is never reported as an explicit native selection.

## Attached child selection (0.3 development)

Attached Happier execution runs use one host-owned selection decision at launch
admission, before Provider and Connected Service materialization. An omitted
model/source choice inherits the parent Session's actually-applied selection;
pending model changes and Account defaults do not replace it. Explicit native,
Provider, Team, Workflow and role choices retain precedence. An explicit native
reset is distinct from omission.

Attached omissions, structured model references and explicit native resets use
the existing Provider-safe ensure/start method with no retained run id. The host
applies inheritance as part of ordinary launch admission, without a separate
inheritance capability flag. The one-way 0.3 upgrade updates all components
together; older Session processes and mixed 0.2/0.3 operation are unsupported.

Native Connected Service inheritance retains the selected account or pool
identity, including a pool rather than its currently active member. It never
copies credentials, activation handles or capabilities. The child rematerializes
that choice under current admission. A different Agent must admit the inherited
source/model through its compatibility adapter; unavailable applied state or an
incompatible choice returns a typed refusal requiring a choice, without changing
models or billing sources.

Detached and scheduled runs keep their own explicit choices or Account defaults.
Resuming a run keeps its retained selection even after the parent or defaults
change; fork keeps its separate explicit inheritance path. Voice's Session model
choices are omitted until this admission, while configured chat and commit
choices remain explicit. Agent-native child definitions retain their Agent's
own model rules.

The execution-run host projects `resolvedSelection` from its admitted launch
record for child summaries. That projection contains only source, exact
model references and account/pool binding identities; it is presentation data,
not a second persisted route or credential owner. Drafts read the applied-model
projection for an inherited-choice preview, never the pending selection as proof.
This is unreleased development behavior; composed runtime validation remains
part of the Providers integration journey.

## Protocol and capability matchmaking

The generic Anthropic-compatible catalog parser and Claude's static model catalog
share the Protocol-owned model-name and effort-option projection at
`packages/protocol/src/providers/catalog/anthropic.ts`. Custom compatible
connections therefore retain catalog parsing independently of Claude plugin
availability.

Providers declare the protocols their endpoints speak. Agents declare accepted protocols and a provider-binding adapter in their plugin-owned runtime. The host computes compatibility; it does not contain provider-by-agent special cases.

Protocol intersection is necessary but not sufficient. Compatibility also accounts for the minimum behaviors an Agent needs:

- streaming;
- tool-call round trips;
- stateful Responses continuation where required;
- reasoning controls.

The compatibility result is `verified`, `experimental`, or `incompatible`:

- **verified** bindings may be used normally;
- **experimental** bindings require an explicit per-Agent confirmation and remain visibly badged;
- **incompatible** bindings are not selectable.

Provider plugins may declare narrow compatibility overrides for known endpoint quirks. Generic host code must not branch on provider ids.

Compatibility and Connected Account suppression use the qualified contributed identity, not a
provider-local scalar id. Legacy built-in scalar declarations are normalized once at Protocol ingress;
they cannot suppress or authorize another plugin's same-named binding.

Codex integrations use the OpenAI Responses protocol unless a separately tested adapter is introduced. Emitted Codex `model_providers` fields are allowlisted for the verified Codex version; unsupported or newly documented fields are never emitted accidentally.

## Credentials and endpoint safety

GitHub forge credentials are Connected Service credentials, not model Provider
connections. In 0.3 development, GitHub consumers may use the executing machine's
GitHub CLI login through the existing native materialization path; an explicit
Connected Account selection still takes precedence. This does not add a
command-produced credential transport to custom model Providers. See
[machine-native GitHub credentials](plugin-platform.md#machine-native-github-credentials-03-development).

Version 1 supports unauthenticated and API-key credentials. Raw secrets remain in Saved Secrets and are resolved by the daemon only after all non-secret checks pass. Plugins receive credential descriptors/materialization inputs, not unrestricted access to the secret store.

An unauthenticated Provider remains credential-free through managed-runtime authorization and Agent
materialization: the host carries an explicit no-credential result and never synthesizes a bearer.
A Provider-managed runtime may use a declared `systemTool` only through the existing tool authority:
the operation, immutable Provider declaration, same-plugin tool declaration, executable, and allowed
environment must all match before the daemon resolves or launches it.

The spawn/probe order is security-sensitive:

1. resolve feature gates, the exact connection, and the target machine; reject tombstoned or missing definitions;
2. realize endpoint templates/overrides, resolve DNS/locality, and derive the endpoint and binding-security fingerprints;
3. verify Agent/protocol/capability compatibility and select the credential transport/materialization kind;
4. validate the exact account/machine grant or short-lived authorization ticket against the realized fingerprints;
5. resolve the Saved Secret as late as possible;
6. materialize the credential into the scoped child environment/config;
7. revalidate the resolution immediately before use;
8. atomically commit the prepared binding and spawn or probe.

The endpoint/security fingerprints must exist before an endpoint-bound grant can be validated. No path may authorize by connection id alone and derive the endpoint afterwards.

Session admission runs that whole sequence before it does any irreversible setup work. Daemon and foreground admission both reach the complete Provider decision — feature gate, Agent/target compatibility, malformed settings, a changed binding, the cold catalog rejection, and the `agent.resolvePrerequisites` hook — before the requested workspace is created, runner bootstrap material is written, or the Agent Session is opened. A prerequisite hook therefore receives the requested workspace path as a value and must not assume that directory already exists on disk.

Provider data must never mutate the daemon's global `process.env`. Agent adapters materialize provider settings into the existing scoped child-spawn environment/configuration choke point.

Custom-provider forms do not support arbitrary query-parameter credentials or inline bearer tokens. Rich cloud authentication such as AWS Bedrock signing, Google Vertex credentials, Azure Entra, and command-produced tokens requires explicit typed transports and is outside the V1 custom-provider contract.

Endpoint validation rejects credentials in URLs, unsafe metadata destinations, ambiguous encodings, unsafe redirects, and oversized responses. Redirects are revalidated hop by hop, and credentials are not forwarded across an origin change. DNS is resolved on the daemon for probes, but the spawned Agent may resolve independently; endpoint-bound machine grants remain the authorization boundary for local/private endpoints.

A catalog probe is bounded end to end, not per hop: one wall budget covers pre-dispatch resolution, request establishment and the complete response body across every redirect, and one idle budget bounds the gap between body chunks. Both apply identically to a public endpoint and to a Provider the daemon supervises — a managed probe reaches its service through that service's own supervised request handle, so a response that returns headers and never finishes its body cannot hold a Provider probe slot.

## Account scope and machine grants

Public provider connections can be enabled account-wide. Loopback and private-network endpoints are machine-scoped by default because `localhost` and RFC1918 addresses identify different services on different machines.

Locality is derived by the endpoint-safety owner, not selected by the user. A machine grant binds:

- `providerConnectionId`;
- `machineId`;
- a normalized endpoint fingerprint;
- grant metadata/revision.

Changing a local endpoint invalidates the previous grant. The daemon must refuse before secret resolution with an actionable error when the grant is absent or stale. A connection definition may sync across devices; authorization to use a local endpoint does not silently transfer to another machine.

In 0.3 development, revoking a machine removes that machine's grants, endpoint overrides, and machine secret bindings from the private Provider catalog. Revocation can remove the last reachable machine, so the client captures the Home/Account before revoking it and performs cleanup through the catalog's revision-checked writer, without requiring that machine's daemon or rewriting Account Settings. Plain and E2EE Accounts use their own admitted catalog envelope. An incomplete catalog, stale revision, or unknown receipt leaves cleanup pending; retry reads the current catalog rather than blindly replaying the mutation. The recovering display projection never authorizes a rewrite, and cleanup does not erase default-model intent from its separate preference.

Health, detected processes, discovered model catalogs, and model load state are machine-local runtime observations. They are not synced as account truth.

## Local discovery and process ownership

Local discovery extends the daemon's canonical local-services inventory. A provider contribution may supply a bounded declarative detector using executable basenames and argv tokens. Plugins do not receive raw process inventories, arbitrary callbacks, or regex execution over every process.

A process match creates only a **candidate**. Availability requires a provider-owned GET probe, such as Ollama `/api/tags` or LM Studio `/v1/models`/native model endpoints. Generic `HEAD /` success is not evidence that the expected provider is present.

Runtime observations are scoped to the machine and exact provider connection, and are additionally bound to endpoint-template/catalog identity plus the relevant authorization fingerprints. Model-load state binds to the exact `catalogObservationId`. A PID-bearing inventory id is provenance only, so a process restart cannot become connection identity or authorize stale catalog state.

Happier distinguishes:

- **adopted processes**, started by the user or another app, which Happier may observe but never stop or restart;
- **owned processes**, started through the Provider managed-runtime service, which may be supervised according to that owner’s lifecycle contract.

Installed-but-stopped detection and managed start are separate capabilities. Provider managed start is authorized by the Provider feature and connection policy; it does not depend on the Local Services UI gate or daemon inventory snapshot. Discovery alone never grants process ownership.

### Managed subscription-backed gateways

In unreleased 0.3 development, a Gateway is the existing managed Provider
connection. Connected-services listing data and Providers refer to the same
connection id and detail route; there is no separate Gateway catalog. Pools
remain single-vendor. Gateway vendor slots use the connection's existing
`purposeBindingDefaults` and revision-checked update Action. Disabling a pool's
gateway use clears its slot only while that exact pool still owns it; replacing
a slot preserves other vendors. An empty saved configuration is allowed, but
does not authorize an unbound runtime.

The connection stores optional `gatewayPlacement`: omitted or
`{ kind: 'sessionMachine' }` means the Session machine, while
`{ kind: 'machine', machineId }` names an explicit hub. Saved placement does not
prove hub readiness or local/private model inference. Shared gateway execution
and hub transport are integrated by the daemon managed-services owner; this
configuration contract alone is not evidence that that live journey ran.

The development managed-runtime declaration can opt into
`sharing: 'connectionMachine'`. The daemon's existing managed-services owner
then owns one subscription gateway per admitted Home, Account, connection and
execution machine. Sessions, catalog probes and an explicit Start retain
separate consumer claims; they do not transfer the process to a Session runner.
Each consumer receives opaque access bound to its exact Connected Account
request-auth capability and qualified purposes. A physical management bearer
cannot authorize inference. Releasing one consumer withdraws only its access;
the final consumer and its in-flight requests must settle before idle stop.

The runner keeps its own loopback access endpoint across daemon replacement.
Each new request re-admits the captured binding before obtaining fresh access;
transport failure does not replay inference or substitute another source.
An unavailable exact executable source remains unavailable: retained declaration
attestation alone does not load an older plugin runtime. The chosen-hub path
uses the existing machine carrier and broker with a personal Account-connection
source, not a fabricated Team resource. Its distinct protocol epoch signs the
Home, Account, initiator, target, consumer and application, while the target
daemon admits the current private catalog and purpose bindings. Unsupported
negotiation or hub failure cannot fall back to local execution. These are
development-source contracts; composed live validation remains pending.

The consumer's published loopback base path comes from the admitted hub runtime
endpoint, through the same signed application's private metadata operation. It
does not infer `/v1` from the protocol or disclose the hub origin or credentials.
CLIProxyAPI therefore retains `/` for Anthropic and `/v1` for Responses/Chat;
unavailable or invalid metadata retires the unpublished consumer access.

Run source preparation uses the admitted controller occurrence and its issued
Account reader, not the process-global Account snapshot. The existing catalog
owner projects that exact Account and purpose context with `current_only`, using
the same scheduler and store; static declarations do not require a fabricated
probe. A missing owned reader or withdrawn source refuses rather than consulting
another Account. Launch preparation does not trigger a cold upstream catalog
refresh before admission: an unavailable dynamic observation requires a normal
picker/probe and retry. Direct materialization rechecks its source before final
commit as well as its existing authorization ticket.

Issued credentials for the same Account can have a different cache scope from
the daemon's token. The trusted credential/context producer supplies the Account
identity; the source compares that identity and reads the issued scope exactly.
A cache path or token digest is not proof of Account identity. The signed target
source continues to read its own credential-bound Account catalog.

Managed connections can also store `claudeHelperModels` with optional `fast`,
`default`, and `strongest` model ids. Claude's Provider adapter maps these into
the Session's scoped Haiku/Sonnet/Opus model-pin environment; omitted pins use
the actual selected Session model. Explicit full-id native Agent definitions
retain Claude's own precedence. External/custom connections reject these
managed configuration fields. Edits affect future materialization, not a
silent rebinding of running Sessions. See [Claude configuration precedence](agents-catalog.md).

Managed subscription-backed routing is experimental and explicit. Upstream policy or enforcement can change and may make the route stop working. Happier surfaces an upstream policy or authentication rejection as an ordinary failure and does not conceal it, manufacture entitlement, or silently fall back to another credential.

This product-risk posture is not a legal-compliance determination. It does not authorize request cloaking, prompt replacement for client impersonation, identity confusion, tracking-identity disguise, or other enforcement-evasion behavior. Managed gateways remain fail closed, and their security, privacy, credential-handling, platform, and correctness gates still apply.

### Team credential resources (development only)

Current 0.3 development source contains the protocol, server routes, and UI foundations for
sharing an existing Connected Account, Connected Service Pool, or Provider Connection as a
Team credential resource. This is not a released capability. It is bounded by
`teams.credentialResources`, which depends on `teams` and is enabled by default with
`HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED=0` as the operator opt-out; the
independently exposed Internet API additionally requires
`teams.credentialResources.externalApi`, on the same default-on shape. Those bits are Home
capability boundaries, not rollout stages, and an enabled bit proves nothing about the
end-to-end broker, direct-delivery, selection, usage, recovery, and revocation journeys.

The source Account keeps credential custody. A Team resource stores a typed reference to the
current source plus audience and use policy; it does not copy a Provider definition or create a
second credential store. Resource access has two intentionally different privacy contracts:

- **Brokered** access keeps usable credential material on one exact broker Machine. A custodian
  can configure that Machine directly or choose a personal Machine Pool. For a genuinely new
  Pool-backed open, the source-owning daemons return only current eligibility status, the Home
  applies the canonical Pool selector once, and the ordinary exact-Machine broker path continues.
  An external API key's retained operation must stay on its selected exact Machine. Pool tier
  reordering, disabling and removal affect future opens only. Lost presence, unavailable source
  readiness or a failed RPC is not proof of retirement and must not trigger reselection.
  **Development completion gap:** the current admission UsageEvent anchor cannot establish
  operation lifetime or arbitrate requests before first admission. The approved correction
  extends the existing external-key/admission aggregate with a private current-operation binding
  and compare-and-clear retirement from actual daemon custody cleanup. That integrated path is
  not yet complete; read-only model listing must not establish an operation. The Home admits the current Account, Team resource, Session or execution run, policy, limits,
  and placement for each request; the broker then performs the Provider request. Recipients do
  not receive credential bytes, the private Pool roster, or Pool-management authority.
- **Direct** access deliberately discloses usable current material to an authorized recipient for
  a source that supports export. Future revocation can stop new retrieval, but cannot recall
  material already delivered or enforce later out-of-product requests.

Broker placement has one interpreter. The resource row carries two nullable columns,
`brokerMachineId` and `brokerPoolId`, and `readTeamCredentialBrokerPlacement` in
`apps/server/sources/app/teams/credentials/brokerPlacementResolver.ts` is the only code that
reads them: exactly one set names the broker location, neither set is an unplaced resource,
and both set is `resource_corrupt` rather than a silent preference for one column. Every
placement, eligibility and selection decision starts there, so no caller compares the raw
columns, and `teamCredentialBrokerPlacementPinsMachine` is the one answer to "is this
resource pinned to this Machine" — a Pool placement never pins. Saving a Pool placement
mirrors the saved exact-Machine rule: the Pool must be the custodian's and carry at least
one enabled member that is a compatible persistent broker. Presence is not required to save,
because an offline Pool is repairable while an empty or incompatible one is simply not a
broker location.

The resource `revision` is an **authority** revision, not a row version. Every durable Session
binding and signed broker open compares it, so `resourceUpdate.ts` advances it only when an
authority fact changes: the source binding, disclosure ceiling, placement, enabled state,
Session use policy, request policy, audience, or usage limits. A presentation-only edit — a
display-name change — keeps the current revision, so renaming a resource does not invalidate
live bindings. The optimistic-concurrency precondition is independent of that: `expectedRevision`
is still required and a stale value still answers `resource_changed`, whichever kind of edit it
was. Direct delivery tracks its own narrower authority set and clears stored direct source
versions when the source, the disclosure ceiling, or the direct audience changes, or when the
resource is disabled.

For normal Sessions and execution runs, the runtime admission owner supplies the authenticated
accountable Account independently of message authorship. Background work must not guess that
authority from Machine ownership, the last human message, or Session storage ownership. External
API keys identify one resource and accountable API client; they do not let a caller select a
Machine, source member, Pool member, internal bearer, or loopback endpoint.

The assigned member is also the external key's authentication principal. A self-assigned key
captures that Account's current authentication evidence at creation. A key created for another
member carries no manager proof: the assignee authorizes the exact resource/key through
`teams.credentials.externalKeys.authorize`. The existing key row stores the canonical Lane 03
evidence snapshot; bearer verification and broker admission recheck it against current identity,
Team policy, membership, and resource entitlement. Authorization never returns or replaces the
bearer. Qualified managers list all safe key summaries; entitled assignees can list their own
summaries to repair authentication, without source or audience internals.

Recipient catalogs expose only selection and recovery facts. Source identity, broker placement,
grant internals, revisions, limits, and encrypted material remain manager/source-owner data.
Readiness and failures use the typed Team-credential result unions; clients must preserve the
reported recovery action and must not silently fall back to a personal connection or from direct
to brokered delivery.

The development Temporary-computer flow resolves its Team credential before a Session exists. It
authorizes the named resource through the planned-Session admission owner before it discovers any
broker, because Pool selection reads the custodian's Machine presence and asks their daemon whether
it can run the source. A caller who is not entitled to the resource reaches neither step and cannot
tell a resource that does not exist from one they may not use: both refuse with the same reason.
The reviewed `RunnerCredentialSelectionBindingV1` pins the exact resource, broker Machine, resource
revision, Provider application binding, and source/catalog revision. For direct placement that is
the configured Machine. For Pool placement, the server intersects current generic Pool availability
with source-specific content-free eligibility, selects once, and emits the same exact binding; the
Runner never lists, joins, manages, or reranks the Pool. It deliberately does not own the chosen
model or initial prompt: those remain inside the creator-reviewed sealed launch manifest. Resolution
creates no Session, sends no paid inference request, exports no credential, and retains no broker or
managed-service lease.

Readiness does not turn that review result into durable authority. Immediately before materializing
the Machine and Session, the activation owner revalidates the signed readiness statement, reviewed
selection, current resource and source, exact broker Machine and endpoint, application protocol,
Agent installation, and current creator consent. Any mismatch returns a typed unavailable or
conflict result before Session creation; it never substitutes a newer model, source, or Machine.
Pool membership changes after exact selection do not become a new Runner ACL. Resource relocation
or Pool deletion changes the resource revision and invalidates the binding; source, Machine,
endpoint, policy, and usage controls remain current through their existing owners.

## Model catalogs, visibility, and stale references

The canonical model catalog merges sources in this order:

1. user-entered manual model metadata;
2. verified static plugin metadata;
3. external catalog metadata;
4. live probe observations;
5. unknown metadata, which remains unknown rather than guessed.

The merger preserves provenance. A model that disappears from a current probe leaves normal picker results but remains renderable when referenced by a favorite, draft, or historical session. Missing definitions and tombstoned connections produce explicit stale states and actionable errors; they never trigger a native fallback.

Model visibility has one owner, keyed by structured model reference:

- native models can be hidden per Agent;
- provider models can be hidden per Agent or for all Agents using that connection;
- an intentional all-hidden state remains an honest empty state with **Show hidden** and **Reset visibility** actions.

Visibility affects discovery in the picker, not the validity of an already-running session.

Large catalogs must use the app's virtualized option-list path. OpenRouter-scale catalogs must not render hundreds of model rows through a direct `.map()` of pressables.

Catalog and health refresh is demand-driven. Enabling a connection, a semantic connection-detail or model-picker read, an explicit Test/Refresh, or an eligible read of expired cached data may schedule work through the canonical Provider probe scheduler. Cache expiry makes that read schedule a refresh; it does not create a timer, background crawler, lease, or global refresh budget. The scheduler owns single-flight execution, concurrency, retry/backoff, and freshness. UI and plugin code must not add a second polling path.

An Agent may declare a native credential source for that same catalog observation. The host reads only the declared secret file under the Agent's declared native home and routes the credential into the existing Provider catalog observer; native authentication does not create a second HTTP probe, catalog parser, cache, or refresh scheduler. Claude uses this path for its native Claude Code OAuth login when no selected Connected Service supplies the catalog credential. Its account setting and environment kill switch are evaluated before either credential source, cache, or network is touched.

A model-picker read waits for the demand it schedules only when a connection is **cold**: it has no catalog observation yet and would therefore contribute no row at all. Answering that read immediately would be a silently empty picker with nothing to follow it, because the projection response is the only completion signal the client has. A connection that already holds an observation—even an empty, stale, or failed one—renders from that observation and keeps its refresh advisory, so an unreachable endpoint never blocks a later read. Waiting does not change work ownership: the demand still goes to the one probe scheduler, which keeps its single-flight execution, admission concurrency, typed local-capacity refusal, and failure backoff. Demand the scheduler refuses for capacity is left for a later read; no caller retains a second queue for it.

## Session lifecycle

At launch, Happier persists the structured model selection plus exact non-secret resolution metadata: connection revision, chosen protocol, `compatibilityFingerprint`, `bindingSecurityFingerprint`, and the materialization kind. It does not persist a transient compatibility status, a derived materialization fingerprint, or credentials in session metadata.

In the development Session-creation Action path, a daemon Provider rejection retains its validated `ProviderErrorV1` in the `spawn_failed` result, including the Provider's retryability. The ordinary New Session composer uses that result for its existing inline recovery controls. Recovery stays bound to the original launch context; changing the Home, Machine, or Provider selection must not retry the previous request against the new target.

Agent plugins own model-switch policy. A same-session switch may be permitted only when the adapter can apply the new provider/model safely. Otherwise the UI offers restart/fork semantics. Resume and fork re-resolve the exact stored connection and refuse actionably when it was deleted, disabled, changed incompatibly, or lost its required grant/secret.

Deleting a connection creates a tombstone. Existing running child processes are not retroactively rewritten, but new spawn, resume, fork, probe, or model-switch operations must not resolve the deleted connection. Secret access is revoked for future operations.

## Feature gates

Provider surfaces use the canonical feature system:

- `providers` gates first-class provider settings, registry, and resolution;
- `providers.localDiscovery` depends on `providers` and `localServices.inventory`;
- `providers.localModelManagement` depends on `providers`;
- `localServices.managed` gates the daemon Local Services UI product (inventory launch actions, previews, and related controls), not Provider managed-runtime start or supervision.

Dependencies are declared in `packages/protocol/src/features/catalog.ts` and applied centrally. Missing or malformed server bits fail closed before settings, secrets, network, or processes are touched. See [Feature gating](./feature-gating.md).

## Migration and retained compatibility

The migration from overloaded launch profiles is versioned and atomic through account-settings compare-and-swap updates.

In development 0.3, remembered profile evidence comes from the Account authoring-memory row, not the Settings document. After a successful Settings migration, its removal disposition conditionally clears that row only if the remembered profile still matches the captured choice. A repeat run repairs an interrupted clear without overwriting a newer choice. The three shipped 0.2 authoring-memory keys are imported destination-first and retired with exact Settings CAS; unrelated Settings roots are preserved.

- legacy DeepSeek, Z.AI, and OpenAI routing profiles migrate to provider connections;
- Anthropic, Codex, and Gemini machine-login placeholders collapse to **Default Environment**;
- Azure OpenAI remains a legacy V1 launch profile until its richer endpoint/auth model has a dedicated typed provider contract;
- Gemini API-key and Vertex profiles remain Agent-auth configurations, not generic model-provider connections;
- ambiguous user-created routing profiles remain visible and enter a guided migration flow rather than being guessed or deleted.

Migration descriptors are plugin-owned provider facts. New writes use provider connections; compatibility readers are boundary-owned and narrowly preserve the deployed legacy shapes.

## Adding a provider plugin

1. Create `packages/plugins/<providerId>/src/provider/contribution.ts` and a schema-validation test.
2. Declare stable identity, endpoint templates, wire protocols, capability facts, credential transports, and catalog sources. A wire protocol is the rendezvous key between this Provider's endpoint and an Agent's `acceptsProtocols`; both sides are contributed, so declaring a protocol Happier does not bundle is ordinary — the host matches the two declarations and never interprets the value.
3. Keep an ordinary Provider descriptor-only. For a local descriptor-only Provider, add only bounded declarative detection facts and a provider-specific availability probe. A command-output catalog fallback names its own output format the same way an HTTP catalog probe does, and the declaring plugin implements it with the same registered parser.
4. When the Provider owns a supervised local runtime, declare its single cold `managedRuntime` facet and register exactly one matching runtime with `api.providers.register(localId, runtime)`.
   In 0.3 development source, a managed Connected Account purpose may declare `endpointTemplateIds` for its broker routes. Each endpoint must belong to that managed runtime and select exactly one purpose. The broker resolves the signed implementation, endpoint and protocol from the current Provider registry before selecting the declared account; missing declarations make the route unavailable.
5. When the Provider's catalog endpoint answers in a wire format Happier does not bundle, name that format in the catalog probe's `parser` and register its implementation with `api.providers.registerCatalogParser(localId, format, parse)`. Happier bundles `openai-models`, `anthropic-models`, `ollama-tags`, and `lmstudio-native-models`; every other declared format is implemented by the declaring plugin, and a format with no reachable implementation fails the probe with `provider_contribution_unavailable` rather than being read by another Provider's parser. Set the probe's `reportsModelLoadState` when the format carries per-model load state, which is what makes model loading available — not whether the host bundles the format.
6. Register every arm the contribution declares. Activation validates the complete declared-vs-registered composite: a Provider that declares a managed runtime and a contributed catalog format must register both, and registering a managed runtime or catalog format the contribution does not declare is refused. A partial registration fails activation instead of silently publishing the half that registered.
7. Add explicit compatibility overrides only for verified pair-specific quirks.
8. Add a legacy-profile migration descriptor only when a deterministic built-in legacy profile exists.
9. Export the contribution through the plugin's generated contribution descriptor path; never register it by filesystem scanning or host-core branching.
10. Test schema invariants, registration correspondence where applicable, endpoint safety, compatibility, catalog merging, connection identity, secret/grant refusal ordering, and any real external integration behind an opt-in lane.

Third-party plugins use the same `contributes.providers` family. Built-ins receive no privileged host path, and the bundled vocabularies below name what the host already implements rather than what a plugin may contribute (the two exceptions that are still closed are listed after them):

- **wire protocols** — `anthropic`, `openai-chat`, `openai-responses`, and `ollama-native` are the protocols Happier bundles an implementation for. Any other protocol id is contributable by a Provider plugin and an Agent plugin together;
- **catalog formats** — `openai-models`, `anthropic-models`, `ollama-tags`, and `lmstudio-native-models` are the HTTP catalog formats Happier bundles, and `ollama-list-table` is the bundled command-output format. Any other format is declared and implemented by the contributing plugin;
- **credential transports** — a plugin declares an HTTP header or query parameter of any validated name in `raw`, `bearer`, or `{secret}`-template form. The five `credentialStyle` presets and three protocol presets in the in-app *custom provider* form are a person-facing authoring vocabulary for endpoints with no plugin behind them, not a plugin ceiling.

Two optional declarations still carry a bundled-only vocabulary. Both are narrow, both are recorded here so an author is never surprised by them, and both name the condition that reopens them:

- **local-readiness shortcut** — `discovery.presenceCheck.parser` accepts `exit-zero-running` or `lms-status-json`. `exit-zero-running` is the general mechanism and is available identically to every Provider plugin, while `lms-status-json` exists for one CLI whose exit code is not a readiness signal. It only refines a discovery status label (`app_running_server_off` versus `installed_not_running`); readiness itself is decided by the required, open-format `availabilityProbe`. Replace the pair with a declarative success criterion if a plugin needs a readiness signal that neither an exit code nor an availability probe can express.
- **model loading** — `modelLoad.request` accepts only `json-model-id-v1` and `modelLoad.confirmation` only `refresh-catalog-load-state`, so a local Provider whose load API takes a different request shape cannot declare model loading today. Everything around it is already open: the endpoint protocol, the catalog format, and the `reportsModelLoadState` fact that makes loading *available* are all contributable. Open the request vocabulary the same way catalog formats were opened — a plugin-registered load requester keyed by the declaring plugin's own id — when a Provider needs a load call the bundled shape cannot express.

`packages/plugins/*/src/provider/verification/*.json` is a first-party review record asserted at build time, not a runtime capability: an external Provider declares the same `compatibilityOverrides` evidence inline and is not subject to that assertion.

External third-party Provider authoring is experimental until a packed plugin completes the generic install, trust, projection, runtime-use, reload/update, collision, and uninstall graduation suite. This does not make bundled Providers or in-app custom Provider connections experimental.

## Validation map

Provider tests are distributed by owner:

- protocol schemas, settings, migrations, selection, compatibility, and catalog merge: `packages/protocol/src/providers/**/*.test.ts`;
- daemon resolution, probing, discovery, materialization, catalog projection, and lifecycle: `apps/cli/src/providers/**/*.test.ts`;
- provider UI/settings/picker behavior: `apps/ui/sources/providers/**/*.test.ts(x)` and provider-focused UI E2E;
- built-in facts: `packages/plugins/<providerId>/src/provider/contribution.test.ts`;
- real end-to-end flows: `packages/tests/suites/core-e2e/**` and `packages/tests/suites/ui-e2e/**`, gated with the canonical provider feature ids.

Tests mock only system boundaries. Security-sensitive refusal tests must prove that failing enablement, grant, compatibility, or endpoint checks happen before secret lookup and network/process activity. See [Testing](./testing.md).
