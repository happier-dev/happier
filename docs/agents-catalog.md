# Agents catalog (CLI + app + `@happier-dev/agents`)

This doc explains how the **Agents catalog** works end-to-end in Happier, and how to add a new agent/provider.

The goal is that both surfaces:
- stay **catalog-driven** (no screen-level `if (agentId === ...)`),
- stay **capability-driven** (runtime checks come from daemon/CLI capability results),
- stay **explicit and reviewable** (no filesystem scanning, no side-effect self-registration),
- share a stable **AgentId contract** across packages.

---

## Key concepts (shared language)

- **AgentId**: canonical id for an agent across packages (CLI + app + server).
  - Source of truth: `@happier-dev/agents` (`packages/agents/src/manifest.ts`).
- **detectKey**: CLI executable name used for detection UX and `command -v <detectKey>`-style probes.
  - Source of truth: `@happier-dev/agents` (`AGENTS_CORE[agentId].detectKey`).
- **cliSubcommand**: the primary CLI subcommand for this agent (usually the same as `AgentId`).
  - Source of truth: `@happier-dev/agents` (`AGENTS_CORE[agentId].cliSubcommand`).
- **flavorAliases**: extra strings we accept for parsing/migration (e.g. `codex-acp`).
  - Source of truth: `@happier-dev/agents` (`AGENTS_CORE[agentId].flavorAliases`).
- **Capabilities**: machine/runtime checks produced by the daemon (implemented by CLI) and consumed by the app.
  - Convention (CLI): `cli.<agentId>`, `tool.<name>`, `dep.<name>`.
- **Checklists**: higher-level groupings of capabilities that the app can render as guided setup steps.
  - Convention: `new-session`, `machine-details`, `resume.<agentId>`.

---

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

### 3) CLI agent catalog: `apps/cli/src/backends/catalog.ts`

This is the CLI’s explicit assembly of backends into a deterministic map:
- `export const AGENTS: Record<CatalogAgentId, AgentCatalogEntry> = { ... }`
- helper resolvers such as `resolveCatalogAgentId(...)`

True provider-specific backend folders live under:
- `apps/cli/src/backends/<agentId>/**`

Generic ACP runtime/catalog machinery lives under:
- `apps/cli/src/agent/acp/**`
- `apps/cli/src/agent/acp/catalog/**`

That split is intentional:
- `apps/cli/src/backends/**` is for provider-owned implementations
- `apps/cli/src/agent/acp/**` is for provider-agnostic ACP plumbing
- built-in generic ACP agents such as Kiro are declared in `@happier-dev/agents` and consumed by the generic ACP layer

### 4) App agents catalog: `apps/ui/sources/agents/catalog/catalog.ts`

This is the app’s single public surface for screens:
- screens import from the `@/agents/catalog` entrypoint backed by `apps/ui/sources/agents/catalog/**`
- it composes:
  - **core registry** (`registry/registryCore.ts`) for identity + app config
  - **UI registry** (`registry/registryUi.ts`) for assets/visuals (lazy loaded for Node-safe tests)
  - **behavior registry** (`registry/registryUiBehavior.ts`) for provider-specific hooks

Provider code lives under:
- `apps/ui/sources/agents/providers/<agentId>/**`

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
   - provider-specific hooks for:
     - experimental resume switches,
     - runtime resume gating/prefetch,
     - preflight checks/prefetch + issues,
     - spawn/resume payload extras,
     - spawn env var transforms,
     - new-session UI chips + options.

---

## Capabilities + checklists contract (CLI ↔ app)

### Capability id conventions (CLI)

Defined/used in the CLI capability system:
- `cli.<agentId>`: base “agent detected + login status + (optional) ACP capability surface” probe
- `tool.<name>`: tool capability (e.g. `tool.tmux`)
- `dep.<name>`: dependency capability (e.g. `dep.codex-acp`)

### Agent CLI updates (`cli.<agentId>`)

Every `cli.<agentId>` capability is wrapped by `apps/cli/src/capabilities/cliUpdate/providerCliUpdates.ts`, so update behavior is provider-agnostic and driven by catalog facts in `packages/agents/src/providers/providerCliRuntime.ts` (`managedInstall`, `npmPackageName`, `nativeUpdate`):

- Detect, when the CLI is available, adds `installSource` (`managed | native | npm | pnpm | bun | brew | other`), `updateSupported` and `updateCommand`. The single classifier is `classifyProviderCliInstall` (`packages/cli-common/src/providers/update.ts`): it attributes the exact executable the capability reports, using its real path. `native` requires the path to lie under a catalog `nativeUpdate.installPaths` entry. `npm`/`pnpm`/`bun` require the vendor npm package in the path (or a Windows npm shim next to `node_modules/<pkg>`). `brew` requires a `Cellar`/`Caskroom` keg. Anything unproven is `other`, with no command.
- `includeLatestVersion: true` adds `latestVersion: string | null`: the newest version this install's owner would install now. The source is the managed owner's source (GitHub latest release for `github_release_binary`, npm for `managed_package`), else the vendor npm package. For a Happier-managed `managed_package` install, it follows the managed pnpm's release-age rule (`readManagedPnpmMinimumReleaseAgeMs`: the configured `minimumReleaseAge`, else that pnpm's built-in default, 1 day from pnpm 11). That makes it the newest stable version up to npm `latest` that is at least that old. npm, native and other installs report the registry's own `latest`. `null` means there is no source or the lookup failed. The cache is keyed by that policy. Successes are cached per daemon for the installables update-check interval (`HAPPIER_INSTALLABLES_AUTO_UPDATE_CHECK_INTERVAL_MS`). Failures are not cached, and `bypassCache` refetches.
- Update action: `install` with `{ intent: 'update', allowVendorRecipeExecution? }`. A `managed` install is reinstalled through the managed install owner. A `native` install runs the vendor updater (`claude update`, `codex update`, `opencode upgrade`, `agent update`) on the resolved executable, and only with `allowVendorRecipeExecution: true` (the UI's confirmation). Every other owner returns `update-not-available`, and its message includes the owner's command. Happier never spawns a package manager. The action succeeds only when a fresh detect reports a different version. That re-read uses the snapshot's slow-probe budget (`verifyVersion`), so a slow `--version` is not mistaken for "no version". If the version is unchanged because the managed installer's release-age rule still holds the newer version, the error is `update-held-by-release-age` (for example "0.24.6 is less than a day old; Happier installs it once it's a day old."). Otherwise it fails with `update-not-verified`.
- Old daemons do not report these fields. Clients must offer the update action only when `updateSupported === true` is present, because an old daemon ignores `intent` and runs a plain install.

### Checklist id conventions

Checklist ids are treated as stable API between daemon and app:
- `new-session`
- `machine-details`
- `resume.<agentId>`

### ACP resume (static policy, runtime negotiation)

We do **not** launch an ACP subprocess merely to probe `loadSession` support in normal UI/CLI flows.

Instead:
- resume eligibility is driven by the selected backend's static agents-catalog `supportsLoadSession` declaration
- when a declared-capable backend is actually resumed, its ACP `initialize` response must also negotiate `agentCapabilities.loadSession`; a mismatch fails before `session/load`
- explicit “resume inactive session” is **fail-closed**: if `loadSession` fails, we surface the error instead of silently starting a fresh vendor session
- any ACP capability probing (e.g. `includeAcpCapabilities`) is reserved for opt-in diagnostics / e2e probes, not day-to-day UX

Kimi Code discovery is a development exception for executable identity: current Kimi Code and legacy Python `kimi-cli` share the command name and cannot be distinguished by version ordering. Its provider-owned discovery uses a no-auth `initialize` fingerprint (including close/delete/fork and SSE), honors explicit executable overrides, and refuses unknown or legacy launches. This does not create a second resume policy. Probe cache identity includes the effective process environment, hashed in memory to avoid retaining credentials in cache keys.

Built-in ACP `supportsModes: 'no'` disables mode projection and both mode mutation paths at the shared backend. Kimi uses that policy until authenticated live mode behavior is verified; model controls remain available.

### ACP session listing (resume-only candidates)

Agents whose ACP server advertises `session/list` expose their own sessions as **resume-only** candidates through the existing direct-sessions RPC family, using the generic `{ kind: 'acpSessionList', cwd? }` source instead of a provider-owned session store.

- Static policy: `isAcpSessionListingDeclared(agentId)` in `packages/agents/src/acp.ts` — true only when the manifest declares both `sessionCapabilities.sessionListing: 'supported'` and `sessionListingSource: 'acp'` (currently Auggie, Qwen, Kimi, Kilo, Devin, Copilot, and FX). Generic and provider-owned ACP catalog entries project that same declaration into `getDirectSessionProviderOps`; the UI default behavior adds the browse source under the same declaration. No shared code branches on agent ids.
- Runtime authority: `AcpBackend.listSessions` checks the negotiated `agentCapabilities.sessionCapabilities.list` from `initialize` and fails with `AcpSessionCapabilityNotNegotiatedError` before dispatching `session/list`; the daemon reports it as `provider_unavailable`.
- UI/daemon compatibility: before sending the new `{ kind: 'acpSessionList' }` source, the canonical UI machine-direct-sessions operation probes `daemon.directSessions.acpSessionList.capability.get`. A missing method on the released `cli-v0.2.12` daemon degrades only this browse source to `provider_unavailable`; the UI never sends that daemon a source its released schema rejects. The capability is explicitly `resumeOnly: true` and grants no adjacent direct-session operation.
- Candidates are opaque provider identifiers preserved byte-exactly after nonblank validation, plus title/cwd/updatedAt. They feed the new-session **resume** picker only. Transcript paging, activity, follow leases, linking and takeover are intentionally absent for this source (optional members on `DirectSessionProviderOps`), and `listDirectBrowseProviderIds()` excludes `resumeOnly` browse sources so the link/open browse list never offers them.
- `session/close` is dispatched at `AcpBackend.dispose()` for the active session when negotiated, so agents that own session resources beyond the local process release them. When the live handshake also negotiates `session/delete`, the resume picker advertises a provider-owned candidate action and dispatches exactly one generic delete request after destructive confirmation. Agents that omit the capability remain valid and see no delete action; deleting a persisted Happier session never deletes the provider-owned candidate.

### Dynamic model lists

Whether a provider's model list is resolved at runtime is one catalog fact:
`AGENT_MODEL_CONFIG.<agentId>.dynamicProbe` in `@happier-dev/agents`.

- `'static-only'` — the curated `staticModels` list is the whole truth. The app does not run the
  preflight models probe and ignores any `sessionModelsV1` the session publishes.
- `'auto'` (default when omitted) — the app runs the preflight models probe on the new-session
  screen and on demand in an existing session's engine details, and consumes the runtime's
  `sessionModelsV1` list. These readers share this flag.

Model discovery is owned by `apps/ui/sources/sync/ops/modelDiscovery.ts`, shared by the picker
hook and voice catalog requests. Its existing persistent probe cache serves stale choices while
revalidating; failed refreshes retain the last successful observation and its timestamp. Discovery
is scoped to the machine/server, backend target, working directory, profile, runtime and connected
service context. Existing-session details probe only while mounted, including inactive sessions;
refreshing choices does not resume the session or claim that a requested model has been applied.

Manual refresh passes `bypassCache` through the capability RPC and generic probe to provider-owned
caches. Results distinguish the successful observation time (`observedAt`) from a failed latest
attempt (`refreshError`). This prevents a daemon cache hit or failed refresh from acquiring a new
24-hour success lifetime in the UI. Older daemons safely ignore the optional bypass parameter but
cannot guarantee a forced provider refresh; both client and daemon must support it for that behavior.
Successful empty catalogs remain authoritative, while an unavailable observation retains previous
choices or the curated fallback. A stale catalog's omission is not rejection of an already requested
or applied model.
Runtime catalog timestamps describe model-list observations. Current-model-only updates preserve
that timestamp, so applied-model telemetry cannot make an old list override a newer probe.

A provider that publishes `sessionModelsV1` from its runtime and is left on `'static-only'` has an
active producer with its consumer gated off — the published list is silently discarded. Flipping
that flag is a user-visible change: the app switches to the dynamic row builder, which carries less
per-model metadata than the static one, so audit what the dynamic path drops before flipping.

Dynamic providers whose runtime starts lazily (Pi starts its process on the first prompt) publish
`sessionModelsV1` only after that first prompt, so the in-session model picker would offer nothing
but the current model and freeform custom until then. To close that window, the new-session screen
seeds the server-persisted `sessionModelsV1` from the wizard's own preflight probe at spawn
(`sync.publishSessionModelsSeedToMetadata`, wired in `useCreateNewSession`). The seed is
deliberately seed-only: if the runtime has already published for this session, the write is a
no-op, and the runtime re-publish stays authoritative. It only applies to `dynamicProbe !==
'static-only'` agents with no curated static list, and to built-in-agents spawns (not ACP custom).

Pi's preflight probe waits for its asynchronous registry refresh within the
existing probe deadline. A pending request is not an empty successful catalog. Session refresh uses
the same machine probe, so discovering choices does not require sending the first prompt to Pi.
When an agent provides a raw preflight models hook, that hook owns discovery and its fallbacks;
failure retains the last good result instead of starting another generic backend probe. Cursor's
CLI fallback lives inside its raw adapter. Agents without a raw hook retain generic discovery.

ACP publication distinguishes a complete catalog (including `[]`) from a current-model-only
update. Complete observations replace membership in both metadata aliases; partial current-model
updates preserve the existing catalog and its observation time. Producers can supply the original
`observedAt` when reprojecting options in a previously observed catalog; this does not renew its
freshness. Config-derived model catalogs use
the same distinction. Cursor's backend owns its merged standard/proprietary catalog, so the generic
config publisher does not publish a competing standard-only list.

Pi catalog discovery (development source) runs through a shared extension inside the selected Pi
process. Preflight uses a no-input, no-session print invocation; runtime refresh runs in the background
on Pi's session-start event. Both await the same authenticated Pi model registry refresh before
publishing structured descriptors, preserving upstream names and reasoning support. The runtime's
early `get_available_models` snapshot is not a new catalog observation. Explicit refresh passes
`force` to Pi's existing registry; ordinary refresh retains Pi's cache policy. Only providers with
configured auth are refreshed, and the preflight uses the same broker-extension arguments as the
session launcher. No Happier-side provider catalog HTTP client or extra catalog cache is added.
Offline or failed discovery does not create a fresh observation. Older Pi refresh APIs without a
completion receipt return structured local choices through the existing static/error fallback;
these cannot replace a previous successful dynamic observation. The shared discovery resource
retains its last good result and exposes the failure.
The preflight subprocess remains bounded by the containing probe deadline and cannot send a prompt
or resume the user's session.

The installed Pi 0.84.4 registry has an upstream limitation: a refresh superseded by another internal
refresh can return a successful receipt before its replacement completes. Happier uses the public
registry contract and cannot detect that case reliably; no private-registry workaround or additional
retry loop is added. Correcting that receipt at Pi's refresh owner is required for a complete freshness
guarantee under concurrent internal refreshes.

OpenCode preflight, runtime selection and compaction share the provider's model-eligibility rule:
an active text-input model is selectable without requiring tool support. Successful empty inventories
replace old choices; failed or malformed inventories retain the last successful observation.

A provider with both surfaces needs **one owner** for the model list. Claude's is
`apps/cli/src/backends/claude/models/resolveClaudeModelCatalog.ts`: the preflight probe adapter and
the in-session `sessionModelsV1` publisher both read it, so the two pickers cannot disagree about
which models exist or which effort tiers they report. Its provider-owned cache identity is the
normalized endpoint, credential kind, and full SHA-256 credential hash. A warm cache entry avoids a
network request; a cold session start may fetch the catalog before publishing the resolved models.
For Claude, a successful account response is authoritative for membership and API capability/context
facts; curated rows only enrich matching ids and serve as the fallback before the first success. A
later failed refresh retains the bounded last successful account snapshot, serves it during the
failure cooldown, and retries discovery after that cooldown without replacing it on repeat failure.
The session publisher combines the latest catalog contribution with the latest Agent SDK
contribution; historical persisted unions do not establish current membership. Replacing a
contribution removes its withdrawn rows and optional controls.
Effective-current-model observations supply the selected model's context facts through that same
reconciler without granting historical catalog rows membership again.
In development source, observed reasoning effort follows that same current-model contribution:
statusline reports, verified terminal-control results, and explicit SDK/legacy launch effort after
successful provider initialization update the active control value. Catalog refreshes preserve that
observation without renewing catalog freshness or treating a pending metadata request as applied.
When no effort has been observed, the existing catalog default remains a control fallback rather
than a verified runtime observation. Override retirement uses the same alias-aware model support
policy as launch, so a missing bare-alias catalog row cannot erase a supported request.
Effort tiers are resolved once when the session mode is built and travel on the mode, so spawn-time
resolution and launch-option hashing see the same value and hashing stays pure.

Claude dynamic discovery is one canonical allow/deny decision at that catalog owner. The account
setting `claudeDynamicModelProbeEnabled` defaults to `true`; setting it to `false`, or setting
`HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED=0` in the CLI/daemon environment, returns the static
catalog before resolving any credential or reading the provider-owned cache. The environment value
is a local kill switch and cannot re-enable discovery after the account setting disables it.

Provider-owned probing:
- The CLI capability RPC resolves the selected backend profile once before any model, mode, or
  config-option or native-catalog probe. It uses the same profile environment and Saved Secret resolver
  as session startup, layers selected session environment overrides, then prepares connected-service
  materialization. A native-catalog request with an explicit GUI-materialized environment map uses
  that map as the profile authority, including an empty map for machine-environment secret choices.
  Provider adapters consume the
  resulting `processEnv`; they must not rebuild a competing profile environment from ambient state.
- Implement the probe in `apps/cli/src/backends/<provider>/preflight/**` and register it through
  `getPreflightSessionControlsProbeAdapter`. Type it as `PreflightSessionControlsProbeAdapter` —
  that is the shape the caller invokes, and its params carry `connectedServices` and
  `accountSettings`. Typing it as the narrower `PreflightModelsProbeAdapter` compiles but silently
  drops those inputs.
- Set `resolveModelsProbeVariant` on the catalog entry whenever the probe result depends on
  something other than the agent id — runtime flavor, auth method, or the bound connected account.
  The returned string partitions the probe cache; without it, results computed for one account or
  runtime mode are served to another. Codex uses this generic cache variant; Claude instead declares
  provider-owned caching and keys its catalog by the effective endpoint and credential identity.
- Model probes fail closed to the static catalog. A probe that cannot authenticate returns `null` rather than
  probing with whatever credential happens to be in the daemon's environment.

In development source, `capabilities.invoke` exposes `probeCatalogs` on each CLI capability through
the same preflight adapter. Its `PreflightSessionCatalogsV1` result separates native slash commands
from typed skills, with explicit support flags and normalized items. Codex app-server reads
`skills/list` without starting a thread; OpenCode V1 server reads native command and skill endpoints
using a temporary managed server; Claude initializes its native command catalog; Pi uses
`get_commands` in ephemeral RPC mode. ACP transports observe `available_commands_update` after
an ephemeral provider session opens, without submitting a prompt. A slash skill is still a slash
command unless the transport exposes a typed skill catalog. Unavailable discovery returns
`preflight-catalog-unavailable`, allowing recovery rather than presenting it as unsupported.
Concurrent requests share one preflight launch only when their complete resolved launch scope
matches; the composer lifecycle owns the successful selection snapshot.

Catalog requests use one deadline for account settings, profile and connected-account preparation,
backend readiness, and native discovery. Expired or cancelled preparation cannot start a native
probe. A cancelled caller leaves a shared launch running for its remaining callers; the final caller
awaits cleanup of native resources and authentication materialization already acquired. A fresh
request can start a new ephemeral launch while an aborted launch finishes cleanup. Malformed
connected-account bindings fail at catalog ingress rather than falling back to ambient credentials.
A selected connected account also fails before native discovery when its adapter cannot materialize
that scope; explicit native-only bindings continue to use native authentication.

The new-session composer demands discovery only for `/` or `$` suggestions and scopes that snapshot to the selected machine,
server/account, backend, project, profile, and authentication context. Local slash rows remain
available while discovery is pending. A selected native skill retains any agent-supplied identifier
and its source reference through structured input rather than becoming a library import. Catalog
reference identifiers synthesized for lookup are not native invocation identifiers; entries without
a native identifier retain name/source-path resolution.

Pre-session discovery requires managed prerequisites to be ready: the canonical launch installable
owner runs in readiness-only mode and does not install or start background updates. Actual session
launch retains its configured installation policy.
Gemini readiness-only backends set the native `CI` control to suppress OAuth browser launch;
cached authentication remains usable, while missing authentication reports discovery unavailable.

In development source, the OpenCode V2 native catalog client waits for the selected project's
plugin activation through `GET /api/integration` before reading commands or skills. The released
2.0.15 and 2.0.20 integration-list handlers await activation; command and skill readers alone can
return a cold, empty registry. Pre-session discovery, existing-session catalogs, refresh, and legacy
skill lookup use that same client owner. Discovery creates no Happier session and sends no native
prompt or inference request; readiness failures propagate instead of publishing an unverified empty
catalog. OpenCode V1 retains its direct native catalog reads.

In development source, an existing OpenCode server session publishes its native command catalog
through the same slash-command metadata owner. Known names execute through OpenCode's command
endpoint with their arguments preserved; unknown slash text remains an ordinary prompt. Structured
skill selection still resolves through the shared prompt finalizer, while native commands skip
replay and fresh-system-prompt seeding. OpenCode V1 command requests accept file attachments and
wait for command completion; unsupported structured extras or in-flight delivery fail explicitly
before submission. V2 command requests preserve native skill and agent selections and support
in-flight delivery. The semantic skill reader honors the newer catalog's
`idSource: 'generated'` marker: generated composer references use native name/path lookup,
while provider-supplied IDs retain their exact bytes.
A successful V2 command response completes the callback, which can produce a parent
turn, a subtask, or no inference. Actual provider status and assistant events keep resulting parent
work visible and steerable through the existing stream and transcript owners. Built-in V2 config
subtasks deliver their completion into the parent as internal synthetic input and resume its
normal assistant continuation.
The same catalog is also refreshed after a real prompt is accepted. V2 catalog reads await the
same read-only activation barrier before the first prompt and after refresh.

## Adding a new agent/provider (end-to-end)

### Step 0 — pick the id contract (critical)

Choose a new canonical id (example): `myagent`.

Prefer:
- `AgentId === cliSubcommand === detectKey`

If you need variants, use `flavorAliases` (and keep canonical ids stable).

### Step 1 — add/extend the canonical manifest (`@happier-dev/agents`)

Edit:
- `packages/agents/src/manifest.ts`

Add/update:
- `id`, `cliSubcommand`, `detectKey`
- `flavorAliases` (if needed)
- `localCli.ts` metadata when the agent has a local CLI/auth surface
- `auth.ts` declarative probe metadata when the auth status can be described centrally
- `acp.ts` built-in ACP metadata when the built-in agent runs through generic ACP
- `resume.vendorResume` (`supported | unsupported | experimental`)
- `resume.vendorResumeIdField` (optional)
- `cloudConnect` (optional)

### Step 2 — choose between provider-specific backend code and generic ACP

If the agent needs provider-specific behavior, create:
- `apps/cli/src/backends/myagent/`

Common files (as needed):
- `cli/command.ts` (subcommand handler)
- `cli/detect.ts` (version/login probe spec)
- `cli/capability.ts` (override for `cli.myagent`, if needed)
- `daemon/spawnHooks.ts` (daemon wiring tweaks, if needed)
- `acp/backend.ts` (ACP backend, if applicable)
- `cloud/connect.ts` (cloud connect, if applicable)

If the built-in agent is generic ACP-backed, do not add a bespoke backend folder just to shell out to ACP.

Instead:
- add its built-in metadata in `@happier-dev/agents`
- let `apps/cli/src/agent/acp/catalog/**` instantiate it generically
- when provider-owned ACP behavior needs the live Happier session, expose it through the catalog entry's `getAcpRuntimeBackendOptionsResolver`; the generic catalog runner is the single place that resolves and passes those backend options. Do not branch on the agent id in the generic runner or create a second session-notification path.
- keep static ACP differences on the built-in ACP definition: model config-option application, permission-intent-to-agent-mode mapping, and whether Happier MCP descriptors are passed through the standard ACP request. A `null` permission mapping is an intentional no-op, not a fallback mode. When an agent ignores the standard ACP MCP field but has a native MCP config model, keep that wire fact as `drop` and use one provider-owned, process-scoped config adapter rather than disabling Happier tools or mutating the user's files.
- For catalog ACP agents with permission-mode mappings, the backend owns applying that mapping on start, load, replay-load, and explicit mode-override clear. The runtime applies an explicit session-mode override after the initial mapping; permission-triggered restarts preserve that precedence. Clearing uses the latest permission intent through the same mapping function, with failures handled by the existing override synchronizer. A null mapping retains provider policy. The UI reuses negotiated mode metadata to describe the reported native policy separately from selected permission intent and pending overrides.

Configured user-defined ACP backends/presets do not become `AgentId`s.
They live in:
- `packages/protocol/src/acpCatalog/*`
- account settings `acpCatalogSettingsV1`
- CLI generic ACP catalog loaders under `apps/cli/src/agent/acp/catalog/configured/**`

Tool normalization (if the agent emits tools):
- Ensure the CLI normalizes provider tool calls/results into canonical V2 tool shapes (so the app can render them).
- See: `docs/tool-normalization.md` (V2 schemas + normalization entrypoints + trace/fixtures workflow).

### Step 3 — export one catalog entry and wire it into the CLI catalog

For provider-specific agents, create:
- `apps/cli/src/backends/myagent/index.ts`

Pattern:

```ts
import { AGENTS_CORE } from '@happier-dev/agents';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.myagent.id,
  cliSubcommand: AGENTS_CORE.myagent.cliSubcommand,
  vendorResumeSupport: AGENTS_CORE.myagent.resume.vendorResume,
  getCliCommandHandler: async () => (await import('./cli/command')).handleMyAgentCliCommand,
  getCliDetect: async () => (await import('./cli/detect')).cliDetect,
  // other hooks as needed...
} satisfies AgentCatalogEntry;
```

Then edit:
- `apps/cli/src/backends/catalog.ts`

Add:

```ts
import { agent as myagent } from '@/backends/myagent';

export const AGENTS = {
  // ...
  myagent,
};
```

### Step 4 — add the app provider folder + registries

Create provider modules:
- `apps/ui/sources/agents/providers/<agentId>/core.ts`
- `apps/ui/sources/agents/providers/<agentId>/ui.ts`
- `apps/ui/sources/agents/providers/<agentId>/uiBehavior.ts` (optional; only if you need overrides)

Wire them into registries:
- add `*_CORE` to `apps/ui/sources/agents/registry/registryCore.ts`
- add `*_UI` to `apps/ui/sources/agents/registry/registryUi.ts`
- add `*_UI_BEHAVIOR_OVERRIDE` to `apps/ui/sources/agents/registry/registryUiBehavior.ts` (only if you have overrides)

### Step 5 — update `@happier-dev/protocol` only when the boundary truly changes

If you need new daemon/app fields, add them to:
- `packages/protocol/src/*`

Then update both sides (CLI implementation + app consumer) to match the new stable contract.

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
- if a provider behavior needs a React Native component (e.g. action chips), lazy-require it inside the hook.

---

## Anti-patterns (please don’t)

- Don’t “auto-discover” backends by scanning the filesystem. We want deterministic bundling and explicit reviewable changes.
- Don’t do side-effect self-registration (“import this file and it registers itself”). It makes ordering brittle and behavior hard to audit.
- Don’t hardcode agent-specific logic in generic screens; add a typed hook in the provider’s `uiBehavior.ts` instead.
- Don’t import native assets from code that must run in Node tests (keep assets in `registry/registryUi.ts` and lazy-load).
