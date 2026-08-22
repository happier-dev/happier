# Agents catalog (CLI + app + `@happier-dev/agents`)

This doc explains how the **Agents catalog** works end-to-end in Happier and how to add a new executable Agent. Model sources such as OpenRouter, Ollama, and DeepSeek are **Providers** and are documented separately in [Providers](./providers.md).

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

#### One catalog-entry hook owner for bundled and contributed Agents

`apps/cli/src/plugins/projection/registry/agentCatalogEntryHooks.ts#createAgentRuntimeCatalogEntryHooks`
is the single builder of an Agent's catalog-entry hooks. It has two production callers:

- `sources/generatedBundledPlugins.ts` binds each bundled plugin's
  `AGENT_RUNTIME_CONTRIBUTION` module, which may carry host callbacks.
- `projectManifestAgentContribution.ts` builds the same contribution shape from the
  Agent's manifest for every projected Agent, bundled or installed.

A bundled Agent carries facts such as its vendor-resume level in the host's own
`@happier-dev/agents` tables. An installed Agent has no host table, so it declares
those facts in the manifest `catalog` block
(`PluginAgentCatalogV2Schema` in `packages/protocol/src/plugins/contributions/v2.ts`)
and reaches the identical catalog contract. `catalog.vendorResume.support` is the
Agent's declared level; without it the host infers `supported`/`unsupported` from
`capabilities.sessions.open`, which cannot express `experimental`. An Agent whose
level resolves to `experimental` without a catalog-owned resume hook fails closed at
`apps/cli/src/session/runtime/catalogHooks.ts#getVendorResumeSupport` and therefore at
the daemon spawn resume gate.

Do not add a second builder for a contributed Agent's catalog entry. Manifest-only
facts (id, CLI subcommand, CLI detect/auth spec, Connected Service ids) stay in
`agentCliMetadata.ts#createManifestAgentCatalogEntry`; every hook-shaped fact belongs to
the hook family.

### 4) App agents catalog: `apps/ui/sources/agents/catalog/catalog.ts`

This is the app’s single public surface for screens:
- screens import from the `@/agents/catalog` entrypoint backed by `apps/ui/sources/agents/catalog/**`
- it composes:
  - **core registry** (`registry/registryCore.ts`) for identity + app config
  - **UI registry** (`registry/registryUi.ts`) for assets/visuals (lazy loaded for Node-safe tests)
  - **behavior registry** (`registry/registryUiBehavior.ts`) for Agent-specific hooks projected from plugin descriptors

First-party Agent UI definitions live with their plugin under `packages/plugins/<agentId>/src/ui/**`. Generated descriptor projections under `apps/ui/sources/agents/registry/generatedBundledPluginEntries*.ts` feed the host registries; do not recreate the retired `apps/ui/sources/agents/providers/**` tree.

---

## Session current-Agent identity (one flat vendor key)

A Session declares exactly one current Agent, and its metadata must carry the flat vendor resume key
of **that Agent only**. A view holding two keys has no authoritative identity; before this rule had
an owner, such a Session could not be resumed at all.

The single pure projector is `projectCurrentAgentSessionView`
(`packages/agents/src/session/state/projectCurrentAgentSessionView.ts`). It seals three things every
writer used to re-derive:

1. **Declared identity** — `flavor` and the runtime descriptor name the Agent.
2. **One flat vendor key** — the `identity.providerSessionId` field is cleared first, which drops
   every Agent's flat resume key *and* its catalog-declared native session-log path; only then is the
   target's id written, through `writeProviderSessionIdSessionState`. An Agent whose catalog declares
   no log-path slot has none, so a path handed to the wrong Agent is dropped rather than left behind
   as an unowned local path.
3. **State disposition** — a `carry` / `clear` policy for Agent-scoped current projections.

The resume identity is `AgentNativeResumeIdentityV1 = { v, vendorResumeId }` — the Agent's own
conversation id and nothing else. There is no continuity proof (`AM-24`): resuming is what answers
whether a recorded id is usable, and both Agents that support native resume fail loudly rather than
silently starting fresh. The released bare-string form is accepted as the same identity.

### Where the id lives, for an Agent with no flat vendor key

The flat `<vendor>SessionId` keys are **generated for bundled Agents only**. A contributed Agent
declares no such slot, so its native conversation id lives in the one agent-agnostic carrier:
`runtimeDescriptorV1.agent.providerSessionId`. The descriptor already names exactly one Agent, so the
id is attributed to the Agent that produced it and is never lent to another.

Both slots have one writer and one reader:

- **Writer** — `providerSessionIdBinding`
  (`packages/agents/src/session/state/bindings/providerSessionId.ts`). A catalog-declared flat slot
  wins when the Agent has one; otherwise the id is written into the descriptor. It is never dropped,
  and a caller can never name an arbitrary metadata key.
- **Reader** — `resolveVendorResumeIdFromSessionMetadata`
  (`packages/agents/src/session/controls/vendorResumePolicy.ts`), in declared-authority order: the
  Agent's session-control adapter (Pi resumes from an absolute session-file path, not a bare id),
  then the catalog-declared flat field, then the descriptor slot. The descriptor tier is last, so it
  cannot change any bundled Agent's answer.

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

---

## Capabilities + checklists contract (CLI ↔ app)

### Capability id conventions (CLI)

Defined/used in the CLI capability system:
- `cli.<agentId>`: base “agent detected + login status + (optional) ACP capability surface” probe
- `tool.<name>`: tool capability (e.g. `tool.tmux`)
- `dep.<name>`: dependency capability (e.g. `dep.codex-acp`)

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

## External Sessions auxiliary

External Sessions is an optional Agent auxiliary registered through the same manifest Agent identity and plugin generation as the primary runtime. The canonical public SDK owner is `@happier-dev/plugin-sdk/sessions/external`.

`api.agents.registerExternalSessions(localId, contribution)` registers exactly six bounded source operations: `resolveSource`, `listCandidates`, `resolveLinkIdentity`, `resolveLinkedIdentity`, `pageTranscript`, and `readAfterTranscript`. It provides discovery, linking, and transcript source semantics; it does not own hosted runtime lifecycle, follow demand, materialization, or takeover admission.

Each of those six callbacks receives the host's bounded invocation controls
(`signal`, `deadlineAtMs`, and `maxSerializedBytes`) plus the existing
`managedEndpointRead` and required `exec` (`ExecService`) services. `exec`
remains governed by the Agent manifest's declared process/tool host access and
the current plugin generation. Reuse its existing process and protocol-client
facilities; External Sessions does not add a process subsystem, HTTP bridge,
callback, registry, or Agent-id host branch. Codex uses this seam to reuse its
existing app-server JSON-RPC `thread/list` client for native candidate
discovery.

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

- `registerExternalSessionObservation` supplies resource-scoped status evidence and content-free transcript-change signals. `watch_file_changes` and `observe_resource` can support live follow through the host owner; `reconcile_only` cannot.
- `registerExternalSessionHooks` supplies installation variants plus bounded installation resolution and event mapping. The host owns consent, configuration mutation, durable cleanup custody, target resolution, and linking policy.
- `registerExternalSessionTakeover` supplies only bounded launch hints after current linked-identity resolution. The host retains target selection, authority transfer, admission, environment authorization, and spawn.

`services.sessions.external` is the opposite direction: an authorized plugin-to-host mapping to the canonical product operations. It is not an Agent capability declaration or a second source registry.

### Built-in registrations in the current source tree

These rows describe registered source capabilities, not a promise that the Agent executable, source, hook installation, platform path, or a live session is available on a particular machine.

| Agent | Six source operations | Observation mode | Takeover launch hints | Session hooks |
| --- | --- | --- | --- | --- |
| Claude | Supported | `watch_file_changes` | Supported | Supported |
| Codex | Supported | `watch_file_changes` | Supported | Supported |
| OpenCode | Supported | `observe_resource` | Supported | Not registered |
| Oh My Pi | Supported | `reconcile_only`; no live follow | Supported | Not registered |
| Pi | Supported | `reconcile_only`; no live follow | Not registered | Not registered |
| Antigravity CLI | Supported | `watch_file_changes` over CLI print transcripts | Not registered | Not registered |

Auggie exposes no External Sessions registration in the current release and is intentionally reported unsupported until a stable vendor history/page/read-after contract exists. Cursor and Copilot also expose no External Sessions registration in the current source tree; do not present them as supported until their feasibility decisions and consumed implementations land. Absence of an auxiliary registration fails closed and must not be replaced by Agent-id branches or inferred from generic resume/ACP capability.

---

## Adding a new Agent (end-to-end)

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
- add its built-in metadata in `@happier-dev/agents`
- let `apps/cli/src/agent/acp/catalog/**` instantiate it generically

Configured user-defined ACP backends/presets do not become `AgentId`s.
They live in:
- `packages/protocol/src/acpCatalog/*`
- account settings `acpCatalogSettingsV1`
- CLI generic ACP catalog loaders under `apps/cli/src/agent/acp/catalog/configured/**`

Tool normalization (if the Agent emits tools):
- Ensure the CLI normalizes Agent tool calls/results into canonical V2 tool shapes (so the app can render them).
- See: `docs/tool-normalization.md` (V2 schemas + normalization entrypoints + trace/fixtures workflow).

### Step 3 — export plugin contributions and let the CLI catalog project them

For Agent-specific runtimes, export a contribution from the plugin package, typically from:
- `packages/plugins/myagent/src/agent/definition.ts`
- `packages/plugins/myagent/src/agent/contributions/runtime.ts` when runtime hooks are needed

Pattern:

```ts
export const AGENT_DEFINITION = Object.freeze({
  id: 'myagent',
  core: {
    id: 'myagent',
    cliSubcommand: 'myagent',
    detectKey: 'myagent',
    resume: { vendorResume: 'unsupported', vendorResumeIdField: null },
    // other shared Agent facts...
  },
  runtimeContributions: {
    agentCatalogEntry: {
      importName: 'MYAGENT_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/runtime',
    },
  },
});
```

The CLI catalog reads generated/resolved plugin contributions through
`apps/cli/src/agent/catalog/registry.ts`; do not add filesystem-scanned or side-effect
registration paths.

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
