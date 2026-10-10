# Agents catalog (CLI + app + `@happier-dev/agents`)

This doc explains how the **Agents catalog** works end-to-end in Happier and how to add a new executable Agent. Model sources such as OpenRouter, Ollama, and DeepSeek are **Providers** and are documented separately in [Providers](./providers.md).

For the host-owned Session/turn lifecycle and the public native Agent seam, see [runtime core](runtime-core.md). Manifest admission, activation and projection belong to the [plugin platform](plugin-platform.md).

The goal is that both surfaces:
- stay **catalog-driven** (no screen-level `if (agentId === ...)`),
- stay **capability-driven** (runtime checks come from daemon/CLI capability results),
- stay **explicit and reviewable** (no filesystem scanning, no side-effect self-registration),
- share a stable **AgentId contract** across packages.

---

## Key concepts (shared language)

- **AgentId**: canonical routing id for an agent across packages (CLI + app + server).
  - Source of truth for bundled Agents: `@happier-dev/agents` (`packages/agents/src/manifest.ts`).
- **Durable Agent identity**: every contributed Agent is durably identified by `{pluginId, localId}` (`PluginContributionIdentityV1`), because two independently authored plugins may legitimately declare the same natural local id such as `assistant`.
  - The routing id is derived from that identity by the single owner `apps/cli/src/plugins/projection/registry/agentRoutingIdentity.ts#resolveContributedAgentRoutingId`.
  - A **bundled first-party** Agent keeps its unqualified released identifier (`claude`, `codex`, `ohMyPi`, …); those ids already travel in persisted Sessions, CLI subcommands and wire targets, and the bundled set is generated and collision-free.
  - An **installed** Agent is routed by its qualified key `"<pluginId>/<localId>"`, so its catalog entry, engine resolution, runtime lease, CLI subcommand and execution target are all plugin-scoped. Two plugins declaring `assistant` therefore both project and activate; neither displaces the other.
  - Consumers that need the author's local id read `contribution.identity.localId`. Never re-derive a local id from a routing id.
  - The inverse direction has one owner too: a consumer holding a durable identity resolves the routing id through the registry index `agentRoutingIdentity.ts#indexAgentRoutingIdsByContributionIdentity` / `#readAgentRoutingIdForContributionIdentity` (External Sessions durable records use `apps/cli/src/api/session/external/linking/qualifiedLinkIdentityRegistry.ts#resolveCurrentExternalSessionAgentRoutingId`). Never compare a routing id against a bare `localId`: that comparison only ever matches bundled Agents and silently rejects every installed one.
  - In 0.3 development, selectable Agent targets use `agent:<pluginId>/<localId>`. `packages/protocol/src/backends/targets/backendTargetRefV2.ts#buildBackendTargetKeyV2` owns key formatting for both durable targets and routing refs; Custom ACP selections append `:definition:<encoded definitionId>` so two definitions of the same contribution remain distinct. Predecessor configured keys are read at the compatibility boundary. The CLI Action inventory emits contribution identity, and Action options and UI engine readers share that key owner. Enumerating or parsing an option does not resolve a runtime routing id: dispatch carries the structured Agent target to the host catalog, and the existing Agent-start admission policy still applies.
- **CLI executable**: the Agent's manifest `cli.executable.binaryName` and declared alternatives feed the canonical CLI resolver used by detection and launch. `detectKey` is a legacy bundled-Agent projection, not a separate executable-resolution authority.
  - Source of truth: the admitted Agent contribution's `cli.executable`, projected by `agentCliMetadata.ts` into the CLI runtime descriptor.
- **cliSubcommand**: the primary CLI subcommand for this agent (usually the same as `AgentId`).
  - Source of truth: `@happier-dev/agents` (`AGENTS_CORE[agentId].cliSubcommand`).
- **flavorAliases**: extra strings we accept for parsing/migration (e.g. `codex-acp`).
  - Source of truth: `@happier-dev/agents` (`AGENTS_CORE[agentId].flavorAliases`).
- **Capabilities**: machine/runtime checks produced by the daemon (implemented by CLI) and consumed by the app.
  - Convention (CLI): `cli.<agentId>`, `tool.<name>`, `dep.<name>`.
- **Checklists**: higher-level groupings of capabilities that the app can render as guided setup steps.
  - Convention: `new-session`, `machine-details`, `resume.<agentId>`.

In 0.3 development, an Agent's manifest `providerRequirements` also supports
Account-only Provider model browsing. The existing bundled-plugin generator
publishes those requirements alongside qualified Agent identity and admitted
Provider declarations; CLI readers obtain the same declaration facts from the
merged manifest registry without activating a plugin. Protocol's canonical
compatibility policy consumes these requirements, so browsing does not invent
an Agent protocol default or treat another plugin's matching local id as the
selected Agent. Missing declarations remain unavailable. Declared compatibility
is separate from executable adapter version, authorization, endpoint health and
runtime confirmation; Account-only rows do not prove that the Agent can run on
any machine. See [Providers](providers.md#provider-connections) for the Account
catalog writer and declaration-only model projection.

---

## Configured ACP definitions (0.3 development)

The configured ACP storage contract has one private Account catalog owned by
`packages/protocol/src/acp/catalog/catalogRowsV1.ts`, with a strict definitions
record and the `account_acp_catalog` envelope domain. Definitions are instances
of one declared **Custom ACP Agent** contribution, owned by
`packages/plugins/custom-acp/src/agent/**` and declared by that plugin's manifest.
Its identity is `{ pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }`;
each strict authored Agent target also carries its `definitionId`. A definition
does not create another Agent identity or runtime registry. The tolerant stored
target reader maps the 0.2 `{ kind: 'configuredAcpBackend', backendId }` selection
to this contribution and the same definition id; new requests and writes use the
strict current target.

The definition id survives picker selection and draft persistence/reopening,
then the daemon admits the installed contribution and the exact catalog row.
The host's existing runtime descriptor carries the selected definition into the
runner. `accountConfiguredAcp.ts` owns captured Account custody and configured
command, arguments, environment, authentication metadata, runtime options and
capability resolution; the contribution uses the public ACP runtime. There is
no configured-only host runtime or synthetic per-definition identity. A deleted
definition or unavailable catalog refuses launch and requires selection repair;
it never silently selects another definition or a bundled Agent.

The Account row is authority only for those configured definitions. Bundled and
plugin Agent projections remain available while that row is absent, loading,
partial or unavailable; configured entries appear only from a ready scoped
catalog. New Session waits for this readiness only when its selected entry is a
configured backend. A genuinely empty Account can become ready-empty, but a
failed read or envelope admission must retain its unavailable reason rather than
publish an empty success.

Retained authored transport semantics use the existing typed ACP `stderrRules`
contribution seam. The predecessor Kiro recipe's status command/parser is retained
as closed compatibility data, not promoted into a new executable authentication
runner. Private SavedSecret references remain under the shared reference and
resource mutation owner. Consumer cutover and composed runtime validation are
still being integrated; the row contract alone does not certify Agent startup.
See [private catalog encryption](encryption.md#private-agent-provider-and-connected-account-catalogs-03-development).

## What lives where (sources of truth)

### 1) Shared manifest + runtime metadata: `@happier-dev/agents`

Where:
- `packages/agents/src/manifest.ts`
- `packages/agents/src/localCli.ts`
- `packages/agents/src/auth.ts`
- `packages/agents/src/acp.ts`

What belongs here:
- canonical ids/types (`AgentId`, `AGENT_IDS`)
- CLI identity contract (`detectKey`, `cliSubcommand`, `flavorAliases`)
- local CLI UX metadata (`machineLoginKey`, login support, docs URL, login launch defaults)
- declarative auth probe metadata
- built-in generic ACP launcher/runtime metadata
- resume contract (`resume.vendorResume`, `resume.vendorResumeIdField`)
- cloud-connect mapping (when applicable): `cloudConnect`

What does **not** belong here:
- app-only visual assets (images/icons)
- app navigation/routes
- CLI implementation details (argv/env/paths)

### 2) Cross-boundary contracts: `@happier-dev/protocol`

Where:
- `packages/protocol/src/*`

What belongs here:
- daemon RPC request/result shapes the app must interpret deterministically
- stable error codes (spawn/resume failures, capability errors, etc.)

Example:
- `packages/protocol/src/spawnSession.ts` defines `SpawnSessionErrorCode` + `SpawnSessionResult`.

The retained CLI library's Claude `RawJSONLinesSchema` and `RawJSONLines` exports
share `packages/protocol/src/agents/claude/rawJsonLines.ts` with native transcript
ingress. Claude's settings policy and predecessor outbound message-metadata
normalization live in the same Protocol domain; the plugin owns the settings
contribution and its derived defaults.

### 3) CLI agent catalog: `apps/cli/src/agent/catalog/**`

This is the CLI’s deterministic projection of Agent plugin contributions into catalog entries:
- `apps/cli/src/agent/catalog/registry.ts` exposes `AGENTS` from the resolved contribution registry
- helper resolvers such as `resolveCatalogAgentId(...)` live under `apps/cli/src/agent/catalog/**`

First-party Agent-specific runtime leaves live under:
- `packages/plugins/<agentId>/src/agent/**`

Generic ACP runtime/catalog machinery lives under:
- `apps/cli/src/agent/acp/**`
- `apps/cli/src/agent/acp/catalog/**`

That split is intentional:
- `packages/plugins/<agentId>/src/agent/**` is for Agent-owned implementations
- `apps/cli/src/agent/acp/**` is for Agent-agnostic ACP plumbing
- built-in generic ACP agents such as Kiro are declared in `@happier-dev/agents` and consumed by the generic ACP layer
- `apps/cli/src/backends/**` is retired host-backend residue and must not be recreated

#### One catalog projection for bundled and contributed Agents

`apps/cli/src/plugins/projection/registry/projectManifestAgentContribution.ts`
projects each manifest Agent into the canonical catalog entry. Focused executable
fields from the matching `definePlugin({ agents: { <localId>: ... } })` entry are
bound by generated activation and supplied to the catalog's existing hook owners;
there is no broad Agent-runtime contribution object or parallel catalog path.
Bundled and installed Agents therefore enter through the same manifest and
registration contracts.

In 0.3 development source, a bundled Agent's `nativePermissionModes` definition
projects the same native permission vocabulary used by its execution code.
Claude's runtime and shared presentation both consume its plugin-owned mapping;
the UI does not reconstruct native labels from the Agent's mode group. Explicit
native tokens such as `acceptEdits` remain distinct from canonical permission
intent aliases. This does not change persisted intent normalization or make
`plan` a permission: the shared permission layer still falls back to Read-only
for that legacy selection.

A bundled Agent carries facts such as its vendor-resume level in the host's own
`@happier-dev/agents` tables. An installed Agent has no host table, so it declares
those facts in the manifest `catalog` block
(`PluginAgentCatalogV2Schema` in `packages/protocol/src/plugins/contributions/v2.ts`)
and reaches the identical catalog contract. `catalog.vendorResume.support` is the
Agent's declared level; without it the host infers `supported`/`unsupported` from
`capabilities.sessions.open`, which cannot express `experimental`. An Agent whose
level resolves to `experimental` without a catalog-owned resume hook fails closed at
`apps/cli/src/session/runtime/catalogHooks.ts#getVendorResumeSupport` and therefore at
the daemon spawn resume gate. In the current development runtime, asynchronous
Session resume and runtime-preference lookups use
`apps/cli/src/agent/catalog/runtimeEntry.ts#readCurrentCatalogHook`, shared with
Connected Account catalog lookups. It acquires the current runtime lease and
its demanded Agent entry before reading executable hooks; the initial declaration
snapshot alone cannot establish whether a lazy hook is available.
Connected Account launch projections qualify declaration-local state-sharing service IDs
with their owning plugin ID before host continuity decisions compare account selections.

Connected Account generation application uses the explicit launch continuity contract.
`continuity.generationApplicationScope` distinguishes per-session process authentication
from a genuinely shared live auth surface; declared request-time auth uses retain their
own application scope. A native credential directory does not establish live adoption.
Qualified credential revisions use the existing refresh/distribution owner and preserve
the exact service, profile and revision through rematerialization. Each Session or Run
still needs its own application evidence.

The current plugin-preview source contract also keeps two narrowly data-only
facts in that same `catalog` declaration without routing them through a runtime
aggregate or catalog-entry hook. `codingPromptBehavior.blocks` is an ordered,
strictly validated list of bounded prompt text; the only conditional form is
`when: 'disableTodos'`, which the canonical coding prompt composer evaluates.
`resumeChecklist` is equally closed: its sole allowed declaration is
`{ includeLoginStatus: true }`, which the existing checklist merger translates
into that Agent's `cli.<agentId>` resume probe. An Agent cannot declare an
arbitrary callback, prompt hook, checklist id, or host capability list through
either field.

Runtime Activity is declared the same way, through the Agent's own Session
capability rather than the `catalog` block: `capabilities.sessions.runtimeActivitySnapshots`
projects to the catalog entry's `runtimeActivityApplicability`, and the host binds a
Session's agent-runtime Activity slot only when that resolves to `supported`. Declare
it only for an Agent whose runtime actually emits `runtime-activity-snapshot` runtime
events — an Agent that claims the slot and never emits one leaves `runtime.activity`
pinned at `unknown` for the whole Session instead of settling at `idle`. Claude is
currently the only bundled Agent that emits them.

Session token accounting has its own positive declaration,
`capabilities.sessions.usageReporting: true`. The bundled definition projects
this fact through the same manifest as an installed Agent. Omission does not
promise reporting, and usage-limit recovery is a separate capability. The UI
reads the current declaration through `supportsAgentLifecycleCapability` with
`capability: 'usageReporting'`; an opened runtime's published support refines
that answer, so an unverified runtime mode cannot inherit another mode's promise.
This is a 0.3 development source contract, not a claim of released availability.

In the 0.3 development source, Claude usage observations retain the native
record UUID, so transcript replay keeps the same ingest key. Available native
timestamps also retain a replayed row's original coverage position. Observations without a
native record, including freshly fetched Pi usage snapshots, receive a UUID
instead of a counter that restarts on reopen. The server counts the latest final
snapshot plus subsequent turn deltas; total contribution IDs name only counted
rows. The CLI usage publisher returns a sent, skipped, or failed result and logs
sanitized warnings for transport failures, including a disconnected legacy transport.
It does not retain a retry outbox.

Plugin authors bind executable Agent behavior through one
`definePlugin({ agents: { <localId>: ... } })` entry. Current public fields on
a custom Agent entry include `providerBinding`, `sessionRunnerFactory`,
`daemonSpawnHooks`, `providerCliAttach`, `cliSessionCommand`, `cliAuth`,
`connectedAccountLaunch`, `preflightSessionControls`,
`terminalPromptSubmitVerification`, `sessionStartup`, and
`vendorResumeSupport`. Generated activation registers only the selected
focused fields together with the factory. `cliSessionCommand` is the public
owner for Agent-native `happy <agent>` argument projection: its optional
builder receives parsed Agent arguments plus host-resolved settings,
environment, and start origin, and returns bounded JSON Session options.

In the current development source, the admitted Session factory's asynchronous
`resolveTerminalPresentation` selects `runner`, `managed_terminal`,
`provider_attach`, or `none` using the requested host and admitted settings and
features. It captures its Agent-owned runtime descriptor before Session creation;
the private runner bootstrap carries that launch intent separately from Agent
authority. Fresh Session metadata and the selected opener consume the same
descriptor. An existing Session's accepted descriptor wins over fresh process
defaults. An explicit Workflow launch choice for the same Agent goes through the
canonical inactive-Session runtime snapshot: it may select a different driver
while retaining native Session recovery identities and handles. A different
Agent is refused, and adoption of a retained live process keeps its actual
descriptor. Current feature admission still fails closed.

The opened Session's `prepareTerminalPresentation` then prepares its exact native
identity and returns an optional-client attach target, a terminal launch plan, or
the actual managed terminal handle. The host never substitutes a static terminal
launch for a missing selected-session operation. ACP-only runtimes without a
presentation surface remain headless. Bare terminal authoring remains a distinct
service, not a second selected-session launcher.

Session-control preflight uses one host-owned environment boundary. The capability RPC resolves
the selected launch profile through the same profile and Saved Secret owners as Session launch,
then layers selected Connected Account materialization on top. The cold-probe sanitizer still
removes unrelated ambient credentials; only explicitly selected profile/account material is added
back before the Agent contribution runs. Model, mode, config-option, and passive-setup probes all
consume that same environment and include the selected profile identity in their cache scope.


In development source, native composer discovery uses `probeCatalogs` through the same host
preflight boundary and each Agent's `preflightSessionControls` contribution. Agent-native leaves
live in `packages/plugins/<agentId>/src/agent/**`; host consumers receive separate native command
and typed skill catalogs. A slash command remains a command unless the Agent exposes a typed
skill catalog. The new-session composer demands discovery only for `/` or `$`, retains the
successful snapshot for its mounted launch scope, and leaves local slash rows available while
native discovery is pending. The scope includes machine/server/account, operational backend and
runtime descriptor, project, profile, Connected Service bindings, and selected authentication.
Profile selections carry the strict V2 `SecretReferenceOverlay`; the daemon materializes those
references through the launch secret owner rather than receiving GUI-decrypted profile values.
Explicit Connected Account selections require a declared native credential destination and usable
materialized credentials; unsupported selections fail before native discovery. Native-only and empty
bindings continue to use native authentication without account materialization.
Catalog cancellation waits for native cleanup and already-started host filesystem work before
returning, removing acquired temporary authentication artifacts. Pending credential retrieval is
not joined; cancelled preparation cannot start further host artifact work.
Selected native skills retain any agent-supplied identifier and source reference through structured
input. Catalog reference identifiers synthesized for lookup are not native invocation identifiers;
entries without a native identifier retain name/source-path resolution. An older daemon without
`probeCatalogs` contributes no native pre-session rows.

Pre-session discovery requires managed prerequisites to be ready: the canonical managed-dependency
executable resolver requires readiness and does not install missing dependencies. Actual session
launch retains its configured installation policy.
Gemini pre-session probes receive the host's native `CI=1` control to suppress OAuth browser launch;
cached authentication remains usable, while missing authentication reports discovery unavailable.

In development source, the OpenCode V2 native catalog client waits for the selected project's
plugin activation through `GET /api/integration` before reading commands or skills. The released
2.0.15 and 2.0.20 integration-list handlers await activation; command and skill readers alone can
return a cold, empty registry. Pre-session discovery, existing-session catalogs, refresh, and legacy
skill lookup use that same client owner. Discovery creates no Happier session and sends no native
prompt or inference request; readiness failures propagate instead of publishing an unverified empty
catalog. OpenCode V1 retains its direct native catalog reads.

The current development Copilot plugin probes `copilot --acp` through that host-owned JSON-RPC
client, passing the host-selected working directory to `session/new`. It projects observed effort
choices onto the current model only; it does not infer other models' reasoning support. Model
selection uses the existing `projectSetModelResponse` seam on the config-option path, retaining
previously observed controls on unselected models. A complete authenticated per-model probe walk
remains separate follow-up work.

In the current development source, daemon model, mode and config probes demand the exact Agent
registration from the authoritative plugin runtime and retain its lease for the operation.
`withAgentPreflightCatalog` serves both capability RPCs and in-process Action inventories. The
acquired catalog entry owns the settings, native/selected authentication context, probe variant and
executable adapter together; reading
only the cold manifest projection cannot discover a lazily registered adapter. Cache scope includes
the existing plugin occurrence, so replacing that occurrence cannot reuse the predecessor's probe
result. Standalone CLI probing without an authoritative runtime retains its declaration-only
behavior. Capability ingress normalizes current V2 and predecessor V1 backend targets through the
canonical target normalizer before resolving probe context.

Native model discovery in the app shares `sync/ops/modelDiscovery.ts` between the existing preflight
hook and voice catalog requests. The same hook serves new-session details and the current session's
deferred model picker, including inactive sessions. Opening the detail demands discovery; refreshing
uses the existing machine capability RPC and does not resume the conversation. The native results
remain integrated with the session picker's existing Provider groups and exact model-selection
action. Display and native selection admission consume the same resolved catalog context.

In the current development source, a custom native Session publishes its live model and mode
facts through `context.session.services.models.bind(source)` and
`context.session.services.modes.bind(source)`. The Session publication scope owns one binding
per catalog and retires subscriptions with that scope. The host projects modes through the
existing current-publisher metadata writer into `sessionModesV2`; plugins do not write owner
metadata. Mode inventory is distinct from model Provider membership and selection policy.
`null` inventory means unknown or unbound, while a successful `[]` is an authoritative withdrawal.
Current mode facts come from native observation or accepted application, never a desired override.
The canonical V2 catalog permits an unknown current mode while preserving known selectable
options. Readers prefer it over retained V1/ACP aliases; the same writer projects strict
`sessionModesV1` compatibility only when the accepted current mode is known.

Host-managed ACP Sessions use those same model and mode bindings at startup, on
resume and for live ACP updates. Initial selections are applied before publishing
the accepted startup state. Execution runs do not overwrite their parent Session
catalog. The UI compatibility reader derives a legacy implicit `plan` mode only
when the advertised or static catalog offers it; explicit requested mode IDs retain
their pending state even when discovery has not confirmed them.

OpenCode server Sessions observe their location-scoped native inventories at startup and on
connection/catalog events. Failed reads retain the previous inventory and emit a default-on
diagnostic; successful empty reads clear it. V2 zero-turn model, agent and reasoning selections
use the exact native Session writers before reporting application. V1 selections remain deferred
until the next prompt. A fresh V1 Session seeds only its initial native default from the ordered,
visible-primary Agent inventory; a resumed Session does not guess that default or treat staged
intent as accepted current state. V1's local TUI selection is not an ongoing server observation.

In development source, OpenCode publishes native commands through the SDK `available-commands`
event and the host's existing slash-command metadata owner. Known names use the native command
endpoint with their arguments preserved; unknown slash text remains an ordinary prompt. Native
commands resolve structured selections while skipping replay and fresh-system-prompt seeding.
V1 accepts file attachments and waits for completion; unsupported extras or in-flight delivery
are rejected before dispatch. V2 preserves native skill and agent selections and supports steer.
Skill catalog normalization marks synthesized reference IDs with `idSource: 'generated'` and
preserves legacy `location` as `path`. Those reference IDs remain composer identities; native
V2 dispatch resolves their name/path against OpenCode's skill inventory. Supplied opaque IDs
remain unchanged, including values that resemble generated references.
A successful V2 command response completes the callback, which can generate parent work,
a subtask, or no inference.
Actual execution and assistant events supply provider-origin lifecycle and streaming evidence;
the response alone supplies neither a native user message ID nor proof of parent inference.
Built-in V2 config subtasks deliver internal synthetic input to the parent and resume its normal
assistant continuation. Commands are also refreshed after a real prompt is accepted; V2 catalog
reads await the same read-only activation barrier before the first prompt and after refresh.

The existing dynamic-model cache owns stale-while-revalidate, in-flight sharing and exact-key
subscriptions. Scope includes the machine, server, target, working directory, selected profile,
connected-service selection and probe context. A successful observation retains its `observedAt`;
failed attempts expose failure while retaining that data and timestamp. Successful empty lists are
authoritative. Noncacheable results stay in memory, and disabled/closed detail consumers do not
start probes or retry timers. Manual refresh forwards `bypassCache` to the owning daemon/Provider
probe rather than only clearing UI state. An older daemon can ignore the optional force input,
so forced freshness requires compatible app and daemon implementations.

For existing sessions, the UI forwards the canonical opaque `runtimeDescriptorV1` through the same
probe context. The host validates its Agent identity and passes it to the Agent's existing probe
variant and adapter callbacks. Agent-owned readers interpret runtime settings; generic UI/host
code does not parse Agent-specific descriptor fields. This lets Codex probe the session's actual
runtime even when the current account default selects another runtime.

A successful capability response acknowledges a supplied descriptor with
`runtimeDescriptorV1Accepted: true` after validating and using that context. The shared app
discovery operation requires this acknowledgement for descriptor-scoped requests. A predecessor
daemon that ignores the descriptor therefore follows the existing refresh-failure path, retaining
last-known choices rather than promoting an account-default result into the session's cache.
Requests without a descriptor keep their existing compatibility behavior.

The supported 0.2 predecessor also sends the scalar `runtimeKindOverride`. The host forwards it
unchanged through the existing preflight input and cache scope. Agent-owned mode readers interpret
it without rewriting generic account settings. Codex gives the current descriptor precedence,
then a valid predecessor scalar, then the account default; its variant and actual probe use that
same decision. OpenCode's existing CLI catalog is mode-independent and needs no extra mode branch.

The shared runtime model publisher treats a complete Agent snapshot, including an empty list, as
replacement membership. Canonical and legacy ACP metadata are observations of that same catalog;
the newer observation wins instead of unioning historical rows. Current-model or context-only
facts preserve the catalog timestamp; `observedAt: 0` denotes facts without a catalog observation.
Failed discovery retains the last successful observation at its producer. Static descriptors may
enrich names and descriptions of an authoritative Provider probe, but cannot restore omitted
capabilities or controls. Native requested/applied model facts remain separate from catalog
membership, so catalog refresh does not silently change a saved selection.


Pi model discovery (development source) uses one plugin-owned extension to read structured model
names and reasoning support from Pi's registry. Preflight runs a no-input, no-session print command;
the host materializes its declared temporary extension and selected request-auth extension arguments
through the existing scoped execution lifecycle. Runtime discovery runs in the background on Pi's
session-start event. Both use Pi's registry refresh and cache; explicit refresh forwards `force`,
and only configured providers are selected. Current-model and thinking-value updates preserve the
catalog observation time rather than reporting new membership.

Older Pi APIs without a completion receipt expose their structured local choices as a static/error
fallback. That fallback cannot replace a previous successful dynamic observation. Offline, failed,
or malformed discovery retains the last good list. Pi 0.84.4 can incorrectly report a successful
receipt when another internal refresh supersedes it; this upstream limitation prevents a complete
freshness guarantee in that case. Happier does not inspect private registry state or add retries to
hide the missing receipt semantics.

Installed external Agent plugins and bundled Agent plugins are peers at the public Plugin SDK
boundary. A manifest declaration is admitted by the same host policy and receives the same public
services; bundled code does not prove external-plugin support when it reaches through a private host
import. In particular, Agent preflight and launch must resolve personal or shared Saved Secret
references through the canonical catalog/materializer before entering the plugin callback. A plugin
receives only the scoped materialization inputs declared for that operation, never unrestricted
secret-store access or authority derived from being bundled.

The Plugin SDK and external Agent authoring surface remain a Developer Preview until an installed,
external-style packed plugin proves the relevant activation, launch, reload/update, failure, and
uninstall journeys. Source-level registration or a built-in-only test is not that proof.

Do not add a second builder for a contributed Agent's catalog entry. Manifest-only
facts (id, CLI subcommand, CLI detect/auth spec, Connected Service ids) stay in
`agentCliMetadata.ts#createManifestAgentCatalogEntry`; every hook-shaped fact belongs to
the hook family.

The CLI detect spec and static auth facts are manifest-owned for **every** Agent,
bundled or installed. `createManifestAgentCatalogEntry` projects executable
resolution from `cli.executable`; `cli.auth` declares login support, bounded login
arguments, credential environment keys or JSON credential paths, and whether a
status command is noninteractive. These fields never select an Agent parser or
transfer process, environment, filesystem, or credential custody to plugin code.

In 0.3 development source, `cli.commandPolicy` also carries the closed
`daemonAutostartDefault: 'preferLocalTui'` declaration. The same manifest
projector supplies the command descriptor consumed by CLI dispatch for bundled
and installed Agents. Codex declares its existing direct-terminal default here:
an unset daemon-autostart preference stays disabled in a TTY, while an explicit
preference, a daemon-started invocation, or malformed start-origin arguments keep
their existing admission behavior.

In the development daemon inventory, `installed` means the Agent's own resolved
CLI executed successfully; a version string alone or an installed server dependency
does not establish that fact. Required setup dependencies come from the selected
runtime transport, not the list of executables a plugin is permitted to invoke.
Inventory cache scope includes the manifest-declared executable lookup environment,
including vendor bin roots and alternative-binary fallback controls, independently of
whether the request also probes sign-in status.

When static credential presence is insufficient, the same Agent entry may provide
the focused `cliAuth.detectAuthStatus` callback. The host gives it only
`runDeclaredSystemToolCommand`, restricted to the plugin's manifest-declared system
tools, and continues to own command resolution, process lifetime, cancellation,
environment, and bounds. Claude, Codex, Kiro, and OpenCode are current positive
consumers; no host table or private aggregate selects this behavior.

Background consumers run only probes explicitly declared safe for noninteractive
checks. Spawn admission supplies the final child environment to the host-owned
credential and command probes, after profile, Connected Service and Provider
overlays and unsets. Neither that environment nor credential contents are passed
to the plugin callback. A successfully authorized and materialized Provider
binding uses its own credential transport rather than requiring native CLI login.

#### Claude plugin runtime contracts (development)

The Claude plugin owns the native JSON-stream Agent SDK protocol integration with
the Claude Code CLI. It does not depend on the `@anthropic-ai/claude-agent-sdk`
npm package; the SDK changelog below documents the upstream message contract.

Managed Provider bindings in 0.3 development carry per-connection Claude helper
pins through the Agent provider-binding adapter. `fast`, `default`, and
`strongest` map to `ANTHROPIC_DEFAULT_HAIKU_MODEL`,
`ANTHROPIC_DEFAULT_SONNET_MODEL`, and `ANTHROPIC_DEFAULT_OPUS_MODEL` in the
session-owned launch environment and the existing single `--settings` overlay,
since native settings `env` can override inherited process values. External
bindings preserve native alias configuration. Each unset pin uses the selected Session
model; explicit pins use the same admitted connection catalog and freeform
policy as that model. Changing the effective pins requires a process restart
through the existing binding apply policy; three unchanged explicit pins do
not independently prevent a live Session-model change.

This characterizes Claude Code 2.1.295 against its official
[model configuration](https://code.claude.com/docs/en/model-config) and
[subagent precedence](https://code.claude.com/docs/en/sub-agents): an invocation
model or an explicit Agent definition still wins. Happier does not set a forced
subagent model, rewrite Agent definitions, or write global settings. Native
settings follow the documented [environment precedence](https://code.claude.com/docs/en/env-vars#precedence),
including managed policy above session settings. Native
helper request/application evidence remains part of the composed Provider QA
journey; launch-environment assertions alone do not prove that evidence.

In development source, the existing native effective-model evidence feed also
projects observed effort onto admitted model controls. SDK initialization
acknowledges the explicit effort captured for that actual query launch;
statusline and verified terminal-control results report native effective truth.
Pending configuration, deferred controls, and unverified delivery do not supply
an observed effort. Context-only evidence and model catalog enrichment retain
the last observation without advancing catalog freshness. When no effort has
been observed, the existing catalog default remains a fallback, not proof of
native application. Known aliases continue to use the plugin's canonical
effort-support policy rather than catalog membership.

##### Internal transcript event classification (development)

`packages/plugins/claude/src/agent/transcripts/internalEventTypes.ts` owns the closed
classification used by native transcript projection. The Claude Agent definition declares
its released `output`-record exclusions through `releasedOutputTranscriptRecordReader`,
using that same private constant. The bundled-plugin generator publishes the declaration
into `@happier-dev/agents`; its `readReleasedOutputNonTranscriptRecordTypes()` reader
supplies the union of declared types to agent-neutral session-core normalization.
The classifier file remains plugin-private; it has no public package subpath.
Command lifecycle frames are known non-transcript records:
current projection emits no message, and the legacy reader hides rows stored by older
0.2 writers. Unknown native record types still report unsupported content rather than
being declared safe to skip. Progress and system records retain their separate native
lifecycle handling; the UI omits their informational rows. Raw observers remain available
to task and queue lifecycle consumers.

This is a read-forward seam for retained 0.2 `output` rows, including the envelope
written by `cli-v0.2.11` (`98ea8fb76733b1dd785d38c31360179cafa84824`). Remove the
declaration and reader when those writers and their retained data leave support.
The union is intentionally un-attributed: an unrelated Agent's legacy `output` row
with an exactly matching declared native type would also be omitted. If observed,
attribute the row at this reader rather than adding consumer-specific classifiers.

##### Queued SDK result boundaries (development)

The SDK runtime in `packages/plugins/claude/src/agent/runtime/remote/sdk/session.ts`
retains the submitted turn when a result reports a positive integer
`queued_turn_count`. Both successful and failed results can precede queued user
work; their transcript and usage evidence remain visible, and earlier failures are
logged without completing the submitted turn. The final result keeps its normal
success or failure behavior, while explicit cancellation still ends the turn. This
follows the optional result field introduced in the
[Claude Agent SDK 0.3.243 contract](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.243/CHANGELOG.md);
results without the field retain the existing completion behavior.

##### Permission hook input changes (development)

The shared permission hook handler in
`packages/plugins/claude/src/agent/runtime/shared/permissionHookHandler.ts` serves
both SDK and unified terminal runtimes. A `PermissionRequest` approval includes
`updatedInput` only when the approved JSON input differs from the original tool
input. This preserves real tool interception changes and permission updates while
avoiding Claude's rewrite-specific rule recheck for an unchanged approval.
`PreToolUse` continues to carry interaction answers in its input. See the
[Claude hook decision contract](https://code.claude.com/docs/en/hooks#permissionrequest-decision-control).

### 4) App agents catalog: `apps/ui/sources/agents/catalog/catalog.ts`

This is the app’s single public surface for screens:
- screens import from the `@/agents/catalog` entrypoint backed by `apps/ui/sources/agents/catalog/**`
- it composes:
  - **core registry** (`registry/registryCore.ts`) for identity + app config
  - **UI registry** (`registry/registryUi.ts`) for assets/visuals (lazy loaded for Node-safe tests)
  - **behavior registry** (`registry/registryUiBehavior.ts`) for Agent-specific hooks projected from plugin descriptors

First-party Agent UI definitions live with their plugin under `packages/plugins/<agentId>/src/ui/**`. Generated descriptor projections under `apps/ui/sources/agents/registry/generatedBundledPluginEntries*.ts` feed the host registries; do not recreate the retired `apps/ui/sources/agents/providers/**` tree.

In 0.3 development source, `contributes.agents[].ui.identityColor` optionally
declares a display-only `{ light, dark }` pair of six-digit hex hues. Bundled
UI configs consume the first-party plugin's `src/ui/descriptor.ts` value through
the canonical generator; bundled manifest UI declarations remain forbidden.
`getAgentIdentityColor` at the public app catalog reads installed declarations
through the existing Account/Machine-scoped projection and uses one shared neutral
when no valid hue is declared. Usage Agent series consume this owner; magnitude
ramps remain presentation-owned. Hue accompanies the Agent's mark and name and
never establishes Agent identity or routing.

In 0.3 development source, full bundled-plugin generation publishes Agent ids,
contribution identities, shared definitions, and UI cores from the current authored
Agent set. A package preparation failure aborts full publication before replacing
these projections and reports the package diagnostic. Correct the failed source
and rerun the canonical generator. Bounded compiler-input and static-definition
preparation still unblock dependency builds, and scoped/aggregate publication
retains its existing recovery contract. Shared identity facts can retain an
optional Agent that is absent from the admitted UI maps; identity recognition
does not establish the presence of its UI core.

`getAgentCore(...)` and `getAgent(...)` are nullable even for a bundled id.
`AGENT_IDS` and `AGENT_CORE_CONFIGS` enumerate the admitted UI subset, rather than
every shared bundled identity. The canonical Agent catalog projection owns title,
channel and presentation-backing resolution when a core is absent. Selectable
backend rows omit a missing local Agent unless the selected machine projects it;
that machine's declared presentation remains usable without a local core.
Retained Session identities use neutral presentation, and shared model facts
continue to come from `@happier-dev/agents`. Consumers must not infer UI-core
presence from `isBundledAgentId(...)` or borrow another Agent's configuration.

#### Selectable Agent targets are seeded from the machine's agents projection

`apps/ui/sources/agents/backendCatalog/getResolvedBackendCatalogEntries.ts` is the single
owner of the selectable Agent/backend target rows every picker consumes (New Session, the
in-session Agent picker, Profiles, Sub-Agents, the execution-run launcher, and the Voice
Agent-catalog tools). It seeds from three sources:

- **Bundled seed** — `getEnabledAgentIds(...)` over the closed `CANONICAL_AGENT_IDS` set.
  This owns bundled-Agent selection policy and is applied exactly once.
- **The machine's agents projection** — every non-bundled Agent id in
  `mergedProviderProjectionById`, which the daemon builds from `agentsById`. This is the
  only place a standalone installed Session Agent appears: the daemon's projection
  carries no backend map, so an installed Agent that contributes no configured backend
  has no other route into the client.
- **Configured ACP definitions** from the ready, Account-scoped private ACP
  catalog, projected as definition-qualified instances of Custom ACP Agent.
  `backendEnabledByTargetKey` supplies enablement, not missing definitions.

Every row is then filtered by `readBackendTargetEnabled(...)`, so a user's Settings →
Agents toggle is the one enable/disable authority for bundled and installed Agents alike.

`ResolvedBackendCatalogEntry.agentId` is the **operational** runtime Agent identity, and
`catalogAgentId` is optional bundled presentation/default backing only. A consumer that
needs the Agent behind a selected target reads `agentId` (or
`resolveBackendTargetOperationalAgentId(...)`); collapsing it to `null` because the Agent
is not bundled is what makes model, mode, configuration and resume probing silently
disappear for an installed Agent.

Behavior facts — including New Session transcript storage modes — are read through
`getAgentBehavior(agentId)`, which resolves a bundled Agent's build-time projection and an
installed Agent's projected `plugin.ui.v1` descriptor through the same interpreter, with a
fail-closed neutral floor for an Agent that declares nothing. Do not gate a behavior fact
on `isBundledAgentId(...)`.

In development, machine UI projections are locale-qualified by the shared
`loadDaemonMergedProjectionInputs.ts` cache/request owner. Both
`useDaemonMergedProjectionInputs` and `usePluginUiProjectionCurrentness` subscribe
to the existing `preferredLanguage` Settings value. A local or remote language
change refreshes the projection without remounting its consumers, including when
the daemon registry generation is unchanged; an unrelated Settings update does
not invalidate the projection. An old-language response cannot replace the
current-language cache or retained admission snapshot.

---

## Session current-Agent identity

A Session declares exactly one current Agent. Bundled Agents carry only that Agent's released flat
vendor resume key; contributed Agents use the generic native-resume identity carrier. A view holding
multiple bundled keys has no authoritative identity; before this rule had an owner, such a Session
could not be resumed at all.

The single pure projector is `projectCurrentAgentSessionView`
(`packages/agents/src/session/state/projectCurrentAgentSessionView.ts`). It seals three things every
writer used to re-derive:

1. **Declared identity** — `flavor` and the runtime descriptor name the Agent.
2. **One native resume identity** — the `identity.providerSessionId` field is cleared first, which
   drops the generic `nativeResumeIdentityV1`, every Agent's flat resume key, and every catalog-declared
   native session-log path. `writeProviderSessionIdSessionState` then writes the target Agent's id to
   its declared flat field when one exists, or to `nativeResumeIdentityV1` otherwise. A caller can
   never choose an arbitrary metadata key.
3. **State disposition** — a `carry` / `clear` policy for Agent-scoped current projections.

The resume identity is `AgentNativeResumeIdentityV1 = { v, vendorResumeId }` — the Agent's own
conversation id and nothing else. There is no continuity proof (`AM-24`): resuming is what answers
whether a recorded id is usable, and both Agents that support native resume fail loudly rather than
silently starting fresh. The released bare-string form is accepted as the same identity.

### Where the id lives, for an Agent with no flat vendor key

The flat `<vendor>SessionId` keys are **generated for bundled Agents only**. A contributed Agent
declares no such slot, so its native conversation id lives in the one agent-agnostic carrier:
`nativeResumeIdentityV1`. The runtime descriptor names exactly one Agent and attributes the generic
identity to it; the Agent-owned descriptor payload remains opaque and is never treated as a resume
carrier.

Both slots have one writer and one reader:

- **Writer** — `providerSessionIdBinding`
  (`packages/agents/src/session/state/bindings/providerSessionId.ts`). A catalog-declared flat slot
  wins when the Agent has one; otherwise the id is written to `nativeResumeIdentityV1`. The runtime
  descriptor is not changed.
- **Reader** — `resolveVendorResumeIdFromSessionMetadata`
  (`packages/agents/src/session/controls/vendorResumePolicy.ts`), in declared-authority order: the
  Agent's session-control adapter (Pi resolves an absolute session-file path as its launch selector),
  then the catalog-declared flat field, then the descriptor slot. The descriptor tier is last, so it
  cannot change any bundled Agent's answer.

An Agent-native resume identity and its launch selector are different facts even when most Agents
use the same string for both. Pi launches with an absolute session-file selector, then validates and
publishes the native provider Session id reported by the opened runtime. The host must not compare
that native id to the path or replace the canonical identity with the launch-only selector.

The host publishes the id through the public `provider-session-id` runtime event and through the
runtime-descriptor publication; the absence of a flat slot no longer suppresses either. Everything
that decides whether a Session can resume — the daemon spawn/respawn path, the CLI listing, and the
client's resume affordance — goes through that one reader, so they cannot disagree about whether a
Session is resumable.

The Agent's own **session-log path** is a separate, still-live fact. It rides the same
`identity.providerSessionId` write as `nativeSessionLogPath`, because the path names exactly one
conversation and an id write that inherited the previous id's path would point a reader at the wrong
log. Both key names come from the manifest resume contract (`resume.vendorResumeIdField` and the
log-path key, still spelled `vendorResumeContinuityProofField` pending a generated-projection
rename), so the projector stays Agent-agnostic. The path is a POINTER offered to a successor Agent on
the same machine; it gates nothing.

`carry` versus `clear` is the difference between the two Session-level moves:

- **Session handoff** moves the *same* Agent to another Machine, so work state, commands,
  capabilities and intents are still true and are carried.
- **Agent transition** replaces the Agent in place and passes `clear`, so the incoming Agent
  republishes its own slash commands, tools, capabilities, facets, mode/model/config catalogs and
  activity headlines, and the `runtime.*` / `intent.*` session-state fields are dropped.

Session-global facts — identity, workspace, permission intent, history, cursors, terminal — survive
both. The projector is pure and applies no intent of its own: a selected target model, mode or
config is applied afterwards through the canonical intent writers, and the cleared state *is* what an
omitted selection means.

See `agent-transition.md` for the transition flow that consumes this projector.

---

## App registries (mental model)

There are three layers inside `apps/ui/sources/agents/`:

1) **Core registry** (`registry/registryCore.ts`)
   - identity + app-facing config (translations, settings gating, permissions, connected service UX, resume config, etc.)
   - consumes canonical ids from `@happier-dev/agents`

2) **UI registry** (`registry/registryUi.ts`)
   - app-only visuals (icons, tints, avatar overlay sizing, glyphs)
   - imported lazily by the catalog entrypoint so Node-side tests can import `@/agents/catalog` without loading native assets

3) **Behavior registry** (`registry/registryUiBehavior.ts`)
   - Agent-specific hooks for:
     - experimental resume switches,
     - runtime resume gating/prefetch,
     - preflight checks/prefetch + issues,
     - spawn/resume payload extras,
     - spawn env var transforms,
     - new-session UI chips + options.

   In 0.3 development, descriptor-owned per-Home launch URL preferences resolve
   the selected local routing id through `resolvePortableServerIdentityForRoutingId`
   before reading the Account map. A present portable Home entry wins, including
   a blank or rejected value. Only an absent portable entry falls back to the
   original routing-key carrier written by the 0.2 UI. An explicit launch target
   does not borrow the active Home's override; resume retains its existing
   no-active-Home-fallback policy.

In 0.3 development, the canonical bundled-plugin publisher also projects each
admitted bundled Agent's identity, CLI declaration, Connected Account purposes
and Account Settings declarations. Agent detail and the Connected services index
can read these facts without a selected daemon or plugin activation. The existing
Account Settings projection normalizes the groups and excludes daemon-custodied
secret fields. These declarations supply neither an installed version nor a
runtime generation; a current daemon row remains authoritative, including when
it removes a declaration. An external Agent with the same local id never borrows
bundled declarations.

---

## Capabilities + checklists contract (CLI ↔ app)

### Capability id conventions (CLI)

Defined/used in the CLI capability system:
- `cli.<agentId>`: base “agent detected + login status + (optional) ACP capability surface” probe
- `tool.<name>`: tool capability (e.g. `tool.tmux`)
- `dep.<name>`: dependency capability (e.g. `dep.codex-acp`)

### Machine Agent inventory (0.3 development)

`packages/protocol/src/capabilities/machineAgentInventory.ts` owns projection of
the complete native Agent probe request. A missing, failed or invalid Agent result
appears in the optional `unavailable` list with its Agent id and reason; valid
results remain in `items`. Invalid whole-response envelopes still fail the inventory.
The app consumes this projection once through `machineAgentCapabilityObservation`.
Only the affected Agent becomes unknown and stale, retaining any last-known facts
for display; a successful probe clears that reason. Session admission continues to
require the canonical fresh ready state. Latest-version lookup failure alone yields
`latestVersion: null` and does not invalidate installation or readiness facts.

Inventory and daemon-scoped system-tool capability caches use the existing
machine contribution-registry currentness revision. Unrelated workspace-sync or
local-service publications do not move these readers to empty cache namespaces.
A failed projection read retains available descriptors and last-good facts for
display, but marks inventory error/stale; retained facts do not authorize launch.
Projection RPCs retain the shared connection/setup budget without imposing an
operation deadline on daemon projection work.

Machine and Agent rows describe aggregate authentication availability: a healthy
accepted Connected Account can satisfy sign-in while the native CLI is signed out.
The New Session launcher instead projects the credential in its emitted binding
through `machineAgentModel#projectMachineAgentForCredential`, using the same
inventory sign-in and readiness owners. Native selection uses the retained native
probe; a selected personal account uses that exact account's health, and an account
group uses its active account. A selected Provider route consumes the same admitted
source and Agent-adapter Connected Account suppression as route disclosure. Only an
authorized, selectable exact model whose adapter replaces all of the Agent's accepted
authentication services removes the native sign-in requirement; native probe facts
remain unchanged. Missing or refused Provider routes cannot authorize launch, and
explicit Native still requires its own credential. The inline signed-out state keeps Sign in and offers
a healthy connected account through the existing launch-binding writer. This changes
only the draft selection, never the Agent's stored default. An empty admitted
purpose-default catalog remains Native; availability alone does not select a default.

### Agent CLI install and update jobs (0.3 development)

Agent software acquisition has one owner:
`packages/cli-common/src/agents/install.ts#installAgentCliForRuntime`. The daemon's
`apps/cli/src/capabilities/installJobs/agentInstallJobOwner.ts` adds a job lifecycle around
that installer and the existing update owner, rather than implementing another installer.
It resolves the Agent's `runtimeSpec` from the contribution registry, so declared install
paths apply to installed plugin Agents as well as bundled Agents.

A job installs the Agent CLI, its declared executable managed dependencies, and then checks
that the CLI runs and reports a version. Progress includes step transitions and transferred
bytes where the source supplies them; an unknown total stays `null`. Antigravity's CLI and
managed ACP server are steps of the same job. Vendor-recipe execution requires explicit
consent, enforced by the canonical install/update path.

V2 managed dependencies can declare a `githubReleaseBinary` source through that
same projection. Release asset targets and archive layout are data consumed by
the existing installables owner; Codex ACP also declares its explicit launch
policy, including environment override and configuration arguments. The portable
`@happier-dev/plugin-sdk/managed-services` entry point remains declarative. Native
command and release-selection helpers are confined to the daemon-realm
`@happier-dev/plugin-sdk/managed-services/native` entry point, shared by the plugin
and host instead of imported from a bundled plugin package.

Codex's configured native-home policy lives in
`packages/protocol/src/agents/codex/nativeHomePolicy.ts`. Its state-sharing
declaration and standalone pet discovery consume the same policy. The SDK's
`fs/nativeHome.ts` owns shared configured-path resolution and physical custody
for connected-service profile/group enumeration. Custody stops at the home:
intentional shared-state symlinks inside it remain supported. This does not add a
second native-home catalog or require a daemon merely to discover local pets.

The process singleton admits one active job per Agent; another start returns that job id.
Machine RPCs use `daemon.agents.install.start/read/cancel/list`:

- `start({agentId, intent: 'install' | 'update', consent: {vendorRecipe: boolean}, force?})`
  returns `{ok: true, jobId}`. `force` requests reinstall rather than skip-if-installed.
- `read({jobId, cursor})` returns `{ok: true, steps, progress, events, nextCursor, done, outcome}`. Events are
  `step`, `progress`, or `log`; the cursor advances through that job's event stream.
  The step/progress snapshots also serve Action status callers without replaying events.
- `cancel({jobId})` requests cancellation and waits for the running operation to settle.
- `list({})` returns active jobs and the latest completed attempt for each registered Agent.

The authenticated local daemon control transport exposes the same operations at
`/agents/install/{start,read,cancel,list}`. Actions `machines.agents.install`,
`machines.agents.install.status`, and `machines.agents.install.cancel` consume this same
owner. Terminal outcomes are `succeeded {version}` or `failed {code, stepId, message,
guideUrl?}`; unavailable automatic installs can carry the Agent's installation guide.

Jobs and their recent history live in daemon memory. Closing an app surface or disconnecting
its caller does not own the running operation. The module-scope app store in
`apps/ui/sources/agents/machineAgents/installJobs/` keeps per-Agent subscriptions and cursor
reads, and discovers jobs with `list` when reconnecting or reloading. A daemon restart loses
job state; re-detect installed software to recover rather than treating the missing job as
proof of success or failure. Cancellation stops the active operation and cleans its partial
staging; software installed by a completed step and vendor-script side effects may remain.
If process cleanup cannot be verified, cancellation reports failure and the daemon refuses
another install for that Agent. Stop the installer process manually before restarting the daemon.
Completion invalidates CLI detection snapshots so inventory can re-detect current software.

#### Update source and verification

Update facts are manifest facts. An Agent plugin declares them in `cli.install`:
- `npmPackageName`: the vendor's npm package, when it is not already the managed package. It
  attributes npm/pnpm/bun installs and names the latest-version source.
- `nativeUpdate: { args, installPaths }`: the vendor's own updater, verified from vendor sources
  (Claude `update`, Codex `update`, OpenCode `upgrade`, Cursor `update`). The host runs it against
  the executable it resolved, and only when that executable or its real path sits under one of the
  home-relative `installPaths`.

`packages/cli-common/src/agents/update.ts#classifyAgentCliInstall` is the one classifier. The
detect of every `cli.<agentId>` capability (wrapped by
`apps/cli/src/capabilities/cliUpdate/agentCliUpdates.ts`) adds `installSource`
(`managed|native|npm|pnpm|bun|brew|other`), `updateSupported` (true only for managed and for a
native install with a declared updater) and `updateCommand` (the copyable command, or null).
With `includeLatestVersion: true` it also adds `latestVersion` (null = unknown), read from the
managed GitHub release or npm `latest` over HTTP and cached for the installables update-check
interval; failures are not cached and `bypassCache: true` refetches.

The job's `intent: 'update'` targets the executable detect reported:
managed → managed reinstall; native → the vendor updater, which needs
`allowVendorRecipeExecution: true` after the app's confirmation (else
`install-confirmation-required`); any other owner → `update-not-available` whose message carries
the command. Verification uses a fresh detect: a changed reported version succeeds, and an
unchanged version also succeeds when it is at least the freshly observed latest version
(`alreadyCurrent: true`). Otherwise the updater returns `update-not-verified`; the job retains
the updater's explanation when the managed package's release-age policy holds an update.
Vendor commands run asynchronously through `execFileWithDeadline`, so the daemon keeps serving
while an updater downloads. Update availability and latest-version knowledge are separate:
an Agent without an npm or managed GitHub release source has an unknown latest version, even
when its vendor updater can run. A vendor recipe alone does not establish a latest-version source.

### Agent native sign-in (0.3 development)

Native status checks acquire the current Agent catalog entry before invoking its
CLI auth contribution. Spawn preflight supplies the fully materialized child
environment; on-demand sign-in status and machine inventory use the same native
probe owner. A startup manifest-only entry is not executable auth authority,
and inventory does not retain an auth hook across runtime generations.

Inventory passes its existing login-status probe budget to the native command
boundary. On-demand sign-in uses the same budget policy; an omitted command
timeout does not introduce a shorter cutoff. A valid Claude `loggedIn: false`
result with exit code 1 is signed out, while failed or malformed command evidence
remains unknown.

Native sign-in uses the existing daemon terminal owner through
`packages/protocol/src/daemon/startAgentSignIn.ts`. Its start result carries the
acquired `terminalId` alongside `terminalKey`. Cancel and Restart Actions require
that acquired ID and verify it against the sign-in terminal key before closing;
an old request cannot close a replacement process. They use the same authenticated
machine transport and Action admission as Start. In the app, Actions and presenters
share `agents/machineAgents/signIn/useAgentSignIn.ts`'s Account-scoped custody.
Closing a presenter does not transfer process ownership to its terminal renderer.
This is current development behavior, not a released availability claim.

### Checklist id conventions

Checklist ids are treated as stable API between daemon and app:
- `new-session`
- `machine-details`
- `resume.<agentId>`

### ACP resume (no runtime probes)

We do **not** runtime-probe ACP `loadSession` support in normal UI/CLI flows.

Instead:
- resumability is driven by the static agents catalog + the selected backend (e.g. `codexBackendMode`)
- explicit “resume inactive session” is **fail-closed**: if `loadSession` fails, we surface the error instead of silently starting a fresh vendor session
- any ACP capability probing (e.g. `includeAcpCapabilities`) is reserved for opt-in diagnostics / e2e probes, not day-to-day UX

After an ACP connection initializes, runtime-only list, fork, close, and delete operations fail closed
against the capabilities negotiated on that exact connection. Two of them have product consumers.
Disposing a Session's ACP runtime cancels the active turn and then, when that handshake negotiated
`session/close`, releases the Agent-owned session before the transport goes away; an Agent that did
not negotiate it is never asked, and a refused or silent close never blocks transport teardown
(`apps/cli/src/agent/acp/AcpBackend.ts`). `session/delete` is reachable only through the
host-synthesized resume-only External Sessions source described below. Provider model projection preserves declared
context-window limits, and ACP reasoning and token-count notifications project through the canonical
reasoning-delta and usage-observation events. Standard ACP steer preserves the admitted structured
content blocks; it does not by itself prove that an Agent accepts concurrent steer. A manifest may
advertise steer only when that Agent has a real capability contract rather than merely because the
shared composer can encode a prompt.

A declarative ACP definition may also name a model config option, map Happier permission intents to
provider modes, and pass or drop Happier MCP descriptors. The host applies that data through the same
session composer used by normal Sessions and Session-adapted execution runs. A `null` permission
mapping deliberately performs no mode request, preserving the Agent's own configured default; this
policy remains plugin-owned data rather than an Agent-id branch in the host.

`createPublicAcpSession` is the single configuration owner for create, resume,
fork and live updates. It resolves the merged native-mode override before the
permission mapping: explicit mode wins, clearing selects the current mapped
permission intent, and a null mapping leaves the reported native policy intact.
Mapped live permission changes use ACP `session/set_mode`; launch-only permission
arguments still require restart. Host-mediated tool permission enforcement stays
separate. The bundled UI generator derives the same mapping from the admitted
Agent runtime declaration, and the existing permission description consumes that
fact with the canonical current/requested/pending session-mode projection.

Two further declarations stay data-only for the same reason as the rest: a Session opened by the
out-of-process Session runner rebuilds its runtime from the attested manifest and never loads plugin
code, so behavior expressed as a plugin callback would silently disappear on that path.

- `mcp.nativeSessionConfig` covers an Agent whose CLI reads MCP servers only from its own config
  file. Before launch the host materializes a session-private config root, links the user's real
  provider directory and declared config-root siblings into it, writes the merged server map, and
  points the declared config-root variable at that root for one launch; the root is removed when the
  Session ends or the launch fails. The declaration resolves against the effective launch
  environment — host process environment, then launch overrides, then Session unsets — so the host
  reads the same config root the Agent will. `policy` stays `drop` because the same servers are
  already delivered natively and must not also be sent in `session/new`; the schema rejects the
  declaration beside `pass_through`. A project-scoped provider config that would shadow a Session
  server fails the launch instead of silently replacing a Happier tool. Devin is the current
  consumer.
- `models.suffixOption` covers an Agent that advertises one model per option value and encodes that
  value in the model id (`<model>-high`, `<model>-high-fast`). The host presents one model plus the
  declared canonical option and expands a selection back to the exact advertised id. A family
  collapses only when that is reversible: the projected id must not already be an advertised model,
  the variants must share one projected name, and each must carry a distinct value.

The public ACP transport declaration includes stdio, WebSocket, and TCP shapes. All three feed the
same host-owned ACP session lifecycle. WebSocket and TCP connect to the declared endpoint without
automatic reconnect; connection loss fails an admitted turn and ends the runtime as retryable, while
session disposal closes the owned connection. A transport declaration still does not by itself prove
that an installed Agent's endpoint is reachable or implements the negotiated ACP capabilities.

## External Sessions auxiliary

External Sessions is an optional Agent auxiliary registered through the same manifest Agent identity and plugin generation as the primary runtime. The canonical public SDK owner is `@happier-dev/plugin-sdk/sessions/external`.

An ordinary author places `externalSessions: contribution` on the matching
`definePlugin` Agent entry. Generated activation registers six bounded
source operations: `resolveSource`, `listCandidates`, `resolveLinkIdentity`,
`resolveLinkedIdentity`, `pageTranscript`, and `readAfterTranscript`. The
contribution provides discovery, linking, and transcript source semantics; it
does not own hosted runtime lifecycle, follow demand, materialization, or
takeover admission.

In 0.3 development, an optional `readAccounting` facet on that same contribution
reads normalized numeric accounting with a source-owned cursor. Its strict result
distinguishes unchanged, advanced, replacement, gap, unavailable and failure.
`resolveSource` may supply source-accounting observation metadata. The host shares
the existing source/watch demand and finite-work budget; plugins retain native
format codecs, not consent or publication authority. Accounting is parsed before
transcript projection can discard its native evidence, and live usage consumes
the same Agent codec. Pi's canonical `piAgentDir` source pins the actual
`sessionsRoot` separately from `agentDir`; that physical root participates in
source identity and remains fixed when ambient settings change. Old unpinned
inputs are accepted and normalized at the shared Pi source resolver. Retained
accounting custody whose admitted source key no longer matches that resolved
root cannot acquire a reader or watcher; already-captured numeric pending facts
can still publish. Discovery exposes the current root for explicit new consent.
Older contributions without this facet are explicitly
unsupported for machine-wide accounting. See
[actions.md](actions.md#native-usage-sources-development) for source consent and
history controls.

A declarative ACP Agent may instead mark every declared External Sessions source
`resumeOnly: true`, but only when the same Agent is an ACP, Session-primary Agent whose
`capabilities.sessions.open` explicitly includes `resume`; the Protocol contribution schema, the
Plugin SDK authoring gate, and the host's runtime synthesis all reject that declaration otherwise,
so a source can never advertise resume candidates the Agent cannot fulfill. In that narrow case the
host supplies the contribution from standard negotiated
ACP `session/list`; the plugin must not register a competing contribution. The resulting candidates
are available only to the existing “resume in Happier” picker, which routes the selected opaque
session id through the same ACP `session/load` path. This declaration does not establish native
link identity, transcript paging or following, live takeover, terminal attachment, writer safety, or
identity equivalence with an interactive CLI session.

The same host-synthesized owner also carries the one destructive control that deliberately stays
outside the plugin contribution: deleting an Agent-owned session record. The contribution family
owns discovery, linking, and transcripts, never Agent session lifecycle, so a plugin cannot supply
or reach this control. The host advertises it on a candidate listing only when the connection that
served that listing negotiated ACP `session/delete`
(`ExternalSessionsCandidatesListResponse.capabilities.deleteCandidate`), an absent capability is
never inverted into an offer, and the `sessions.external.candidate.delete` Action re-checks
negotiation on its own connection before acting. The opaque candidate id crosses unchanged, the
Happier Session store is untouched, and nothing is removed from the listing until the Agent commits
the deletion. Gating is generic: it follows the negotiated capability and the resume-only source
declaration, never an Agent id. This is current source-tree behavior proven by owner tests; no live
Agent round trip has exercised it on a released build.

Each of those six callbacks receives the host's bounded invocation controls
(`signal`, `deadlineAtMs`, and `maxSerializedBytes`) plus the existing
`managedEndpointRead` and required `exec` (`ExecService`) services. `exec`
remains governed by the Agent manifest's declared process/tool host access and
the current plugin generation. Reuse its existing process and protocol-client
facilities; External Sessions does not add a process subsystem, HTTP bridge,
callback, registry, or Agent-id host branch. Codex uses this seam to reuse its
existing app-server JSON-RPC `thread/list` client for native candidate
discovery.

For an active native runtime, `session.services.transcripts.followSource` binds
that same ordered source-follow owner to one provider Session. The runtime names
whether this is fresh-session catch-up or historical resume; the host binds the
Agent identity and owns durable publication, generation lifetime, and failure.
Runtime and local terminal consumers share the same provider binding. Providers
that use native consumption evidence receive it through their runtime's
`observeSourceTranscript` method after preceding output has acknowledged delivery.

This development-only terminal path requests `projection: 'terminal'` on
`readAfterTranscript` and `pageTranscript`: forward for fresh catch-up, backward
for historical resume. Historical display rows retain their source selection
and chronological order. Ordered native observations reach the current runtime
with `phase: 'initial_replay'` to establish provider correlation without admitting
historical work or lifecycle activity. Their delivery continues even when the
corresponding display row already has durable custody. Omitted phase retains
live observation semantics.

The closed `source_observation` envelope carries an item identity, timestamp,
and strict JSON native row. It is not a visual transcript record or user
`source_fact`, and it is admitted only for that explicit projection. Ordinary
browsing and author-facing transcript operations keep the user/agent transcript
schema. Provider code retains interpretation and matching authority; the host
only preserves source order and rejects observations without a current observer.
The optional replay phase is a development SDK source-contract change; Agent
authors must handle replay as correlation-only context before rebuilding against
this source cut.

`resolveSource`, `resolveLinkIdentity`, and `resolveLinkedIdentity` may return
bounded `transcriptMediaReadRoots` as transient producer evidence. The host
normalizes and validates these absolute roots, then uses them only to authorize
concrete media files referenced by transcript items through the existing
exact-file media allowance/adoption path. Roots are never copied into
`linkData`, persisted or shared state, or transcript records; they grant no
directory-enumeration or write authority.

This is a development/preview authoring contract from the current source tree;
it does not claim that loaded or packaged release artifacts expose the same
surface. Bundled and externally loaded plugins use the same contribution,
invocation, and host-access contract. The six callback methods and the six
`services.sessions.external` operations remain unchanged; `exec` is an
invocation input, not a seventh method or service operation.

Three optional same-Agent siblings add narrower capabilities without creating another Agent or Provider catalog:

- `externalSessionObservation` supplies resource-scoped status evidence and content-free transcript-change signals. `watch_file_changes` and `observe_resource` can support live follow through the host owner; `reconcile_only` cannot.
- `externalSessionHooks` supplies installation variants plus bounded installation resolution and event mapping. The host owns consent, configuration mutation, durable cleanup custody, target resolution, and linking policy.
- `externalSessionTakeover` supplies only bounded launch data after current linked-identity resolution. Its resolver receives the host-selected `direct` or `persisted` transcript authority so the Agent can select a compatible runtime without a second host-side Agent policy. A launch plan may set `applyConnectedAccountDefaults: true` when takeover creates a new runtime that should use the Account’s configured authentication default; the host still resolves that default through the canonical Session spawn owner, after preserving any binding already recorded for the linked Session. Its optional `runtimeDescriptorV1` is the sole Agent-owned runtime selection and identity carrier to the target Session opener; the generic host validates and copies it without interpreting or mutating its Agent-specific payload. The closed launch-plan/result DTOs accept only own enumerable data properties on plain or null-prototype objects. The descriptor is not a private resume carrier or generic metadata bag. The host retains target selection, authority transfer, admission, environment authorization, and spawn.

In the current development takeover flow, the server's existing admission transaction owns
live publisher and Pending state. It fences the exact publisher before reading that state,
retains queued messages, and checks the operation claim, metadata version, transcript
sequence, and storage/publication identity before admitting the new runtime. The daemon
uses the publication-filtered Session response for source and publication identity only;
that viewer response deliberately omits live facts for external and snapshot storage.

Persisted takeover retains its verified stopped-process identity in the operation's private
canonical owner evidence before importing. After daemon restart, the existing quiescence
inspector rechecks that identity against current OS process state when its marker is absent.
Every current matching marker takes precedence over retained evidence. All matching
processes must be verified stopped; a newer stopped marker cannot hide another live
owner. Running, reused, unknown, or mismatched process/source identity cannot be
admitted using an earlier observation. This
evidence is omitted from owner progress and shared presentation; marker cleanup remains
owned by the daemon lifecycle. An unreadable or malformed marker inventory fails
this destructive admission check closed rather than being treated as an absent marker.

`services.sessions.external` is the opposite direction: an authorized plugin-to-host mapping to the canonical product operations. It is not an Agent capability declaration or a second source registry.

### Built-in registrations in the current source tree

These rows describe registered source capabilities, not a promise that the Agent executable, source, hook installation, platform path, or a live session is available on a particular machine.

| Agent | Six source operations | Observation mode | Takeover launch hints | Session hooks |
| --- | --- | --- | --- | --- |
| Claude | Supported | `watch_file_changes` | Supported | Supported |
| Codex | Supported | `watch_file_changes` | Persisted takeover is supported. Linked takeover is supported only when the session is loaded in Codex's shared app-server daemon; Happier attaches through the official daemon proxy. | Supported |
| OpenCode | Supported | `observe_resource` | Supported | Not registered |
| Oh My Pi | Supported | `reconcile_only`; no live follow | Supported | Not registered |
| Pi | Supported | `reconcile_only`; no live follow | Supported for persisted takeover; linked takeover remains unavailable because writer safety is `unsupported` | Not registered |
| Antigravity CLI | Supported | `watch_file_changes` over CLI print transcripts | Not registered | Not registered |

Auggie exposes no External Sessions registration in the current release and is intentionally reported unsupported until a stable vendor history/page/read-after contract exists. Cursor and Copilot also expose no External Sessions registration in the current source tree; do not present them as supported until their feasibility decisions and consumed implementations land. Absence of an auxiliary registration fails closed and must not be replaced by Agent-id branches or inferred from generic resume/ACP capability.

---

## Adding a new Agent (end-to-end)

### Step 0 — pick the id contract (critical)

Choose a new canonical id (example): `myagent`.

Prefer:
- `AgentId === cliSubcommand === detectKey`

If you need variants, use `flavorAliases` (and keep canonical ids stable).

### Step 1 — author the shared Agent definition in its plugin

For a bundled Agent, edit `packages/plugins/<agentId>/src/agent/definition.ts`.
The bundled-plugin generator projects that definition into `@happier-dev/agents`;
`packages/agents/src/manifest.ts` consumes the projection and is not an authoring
table. Do not hand-edit generated definitions or add a parallel resume-key list.

Declare the applicable shared facts:
- `id`, `cliSubcommand`, `detectKey`
- `flavorAliases` (if needed)
- local CLI/auth metadata when the agent has that surface
- declarative auth probe metadata when the auth status can be described declaratively
- ACP metadata when the bundled agent runs through generic ACP
- `resume.vendorResume` (`supported | unsupported | experimental`)
- `resume.vendorResumeIdField` (optional)
- `cloudConnect` (optional)

### Step 2 — choose between Agent-specific plugin runtime code and generic ACP

If the Agent needs executable behavior beyond the generic ACP path, create:
- `packages/plugins/myagent/src/agent/`

Common files (as needed):
- `cli/command.ts` (subcommand handler)
- `cli/detect.ts` (version/login probe spec)
- `cli/capability.ts` (override for `cli.myagent`, if needed)
- `daemon/spawnHooks.ts` (daemon wiring tweaks, if needed)
- `acp/backend.ts` (ACP backend, if applicable)
- `cloud/connect.ts` (cloud connect, if applicable)

If the built-in agent is generic ACP-backed, do not add a bespoke plugin runtime leaf just to shell out to ACP.

Instead:
- declare its shared definition and ACP transport in its plugin, then regenerate the bundled projections
- let `apps/cli/src/agent/acp/catalog/**` instantiate it generically

Configured user-defined ACP backends/presets do not become `AgentId`s.
They run through the single declared `custom-acp` contribution and live in:
- `packages/protocol/src/acp/catalog/**`
- the private Account ACP catalog row, not a writable Settings root
- CLI configured launch materialization under `apps/cli/src/agent/runtime/registry/engineRegistry/accountConfiguredAcp.ts`

Tool normalization (if the Agent emits tools):
- Ensure the CLI normalizes Agent tool calls/results into canonical V2 tool shapes (so the app can render them).
- See: `docs/tool-normalization.md` (V2 schemas + normalization entrypoints + trace/fixtures workflow).

### Step 3 — author the plugin once with `definePlugin`

Keep serializable shared Agent facts in
`packages/plugins/myagent/src/agent/definition.ts` when the bundled package needs
them, then compose the actual plugin through its public `definePlugin` entry. Put
each executable behavior on the matching focused Agent field instead of exporting
a runtime aggregate.

Pattern for a custom Session Agent:

```ts
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createMyAgentRuntime } from './agent/runtime.js';

export const MYAGENT_PLUGIN = definePlugin({
  id: 'happier.agent.myagent',
  version: '0.0.0',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  agents: {
    myagent: {
      declaration: {
        title: 'My Agent',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: {
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn'],
            cancel: true,
          },
        },
      },
      factory: createMyAgentRuntime,
      sessionRunnerFactory: {
        module: './agent/runtime.js',
        export: 'createMyAgentRuntime',
        runtimeApiVersion: 1,
      },
      // Add focused cliAuth, preflightSessionControls, or other public seams
      // only when this Agent owns that behavior.
    },
  },
});

export const PLUGIN_MANIFEST = MYAGENT_PLUGIN.manifest;
export const activate = MYAGENT_PLUGIN.activate;
```

The CLI catalog reads resolved plugin declarations and their generated focused
registrations through `apps/cli/src/agent/catalog/registry.ts`; do not add
filesystem-scanned, side-effect, private-overlay, or raw registration paths.

### Step 4 — add plugin-owned UI descriptors

Keep Agent UI facts with the plugin:

- `packages/plugins/<agentId>/src/ui/descriptor.ts` for serializable UI metadata;
- `packages/plugins/<agentId>/src/ui/uiBehavior.ts` only for behavior that cannot be expressed declaratively;
- `packages/plugins/<agentId>/src/ui/settings/**` for Agent-owned settings descriptors/components when needed.

Run the bundled-plugin projection generator so the descriptor is represented in `apps/ui/sources/agents/registry/generatedBundledPluginEntries*.ts`. Host registries consume generated projections; do not hand-maintain an Agent-specific branch in a generic screen.

### Step 5 — update `@happier-dev/protocol` only when the boundary truly changes

If you need new daemon/app fields, add them to:
- `packages/protocol/src/*`

Then update both sides (CLI implementation + app consumer) to match the new stable contract.

For External Sessions, keep Agent-native source parsing, cursor/revision semantics, media roots, observation evidence, and launch-hint derivation in the plugin leaf. Reuse the public auxiliary registrations above; do not add a host Agent-id branch, another source catalog, or a seventh source method.

### Step 6 — verify (repo-local and happy-stacks)

Repo-local:

```bash
yarn typecheck
yarn test
```

Scoped:

```bash
yarn --cwd apps/cli typecheck
yarn --cwd apps/ui typecheck
```

If you’re running this repo via happy-stacks, prefer:
- `happys typecheck happy`
- `happys test happy`

---

## Node-safe imports (tests)

Some tests import the app agents catalog in a Node environment. Avoid importing native/icon modules from code that executes during those imports.

Patterns we use:
- the catalog entrypoint lazy-loads `registry/registryUi.ts` to avoid loading image files in Node.
- if an Agent behavior needs a React Native component (for example action chips), lazy-load it inside the hook.

---

## Anti-patterns (please don’t)

- Don’t “auto-discover” backends by scanning the filesystem. We want deterministic bundling and explicit reviewable changes.
- Don’t do side-effect self-registration (“import this file and it registers itself”). It makes ordering brittle and behavior hard to audit.
- Don’t hardcode Agent-specific logic in generic screens; add a typed hook in the Agent plugin's `uiBehavior.ts` instead.
- Don’t import native assets from code that must run in Node tests (keep assets in `registry/registryUi.ts` and lazy-load).
