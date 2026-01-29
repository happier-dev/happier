# Agents catalog (CLI + app + `@happy/agents`)

This doc explains how the **Agents catalog** works end-to-end in Happy, and how to add a new agent/provider.

The goal is that both surfaces:
- stay **catalog-driven** (no screen-level `if (agentId === ...)`),
- stay **capability-driven** (runtime checks come from daemon/CLI capability results),
- stay **explicit and reviewable** (no filesystem scanning, no side-effect self-registration),
- share a stable **AgentId contract** across packages.

---

## Key concepts (shared language)

- **AgentId**: canonical id for an agent across packages (CLI + app + server).
  - Source of truth: `@happy/agents` (`packages/happy-agents/src/manifest.ts`).
- **detectKey**: CLI executable name used for detection UX and `command -v <detectKey>`-style probes.
  - Source of truth: `@happy/agents` (`AGENTS_CORE[agentId].detectKey`).
- **cliSubcommand**: the primary CLI subcommand for this agent (usually the same as `AgentId`).
  - Source of truth: `@happy/agents` (`AGENTS_CORE[agentId].cliSubcommand`).
- **flavorAliases**: extra strings we accept for parsing/migration (e.g. `codex-acp`).
  - Source of truth: `@happy/agents` (`AGENTS_CORE[agentId].flavorAliases`).
- **Capabilities**: machine/runtime checks produced by the daemon (implemented by CLI) and consumed by the app.
  - Convention (CLI): `cli.<agentId>`, `tool.<name>`, `dep.<name>`.
- **Checklists**: higher-level groupings of capabilities that the app can render as guided setup steps.
  - Convention: `new-session`, `machine-details`, `resume.<agentId>`.

---

## What lives where (sources of truth)

### 1) Shared manifest: `@happy/agents`

Where:
- `packages/happy-agents/src/manifest.ts`

What belongs here:
- canonical ids/types (`AgentId`, `AGENT_IDS`)
- CLI identity contract (`detectKey`, `cliSubcommand`, `flavorAliases`)
- resume contract (`resume.vendorResume`, `resume.runtimeGate`, `resume.vendorResumeIdField`)
- cloud-connect mapping (when applicable): `cloudConnect`

What does **not** belong here:
- app-only visual assets (images/icons)
- app navigation/routes
- CLI implementation details (argv/env/paths)

### 2) Cross-boundary contracts: `@happy/protocol`

Where:
- `packages/happy-protocol/src/*`

What belongs here:
- daemon RPC request/result shapes the app must interpret deterministically
- stable error codes (spawn/resume failures, capability errors, etc.)

Example:
- `packages/happy-protocol/src/spawnSession.ts` defines `SpawnSessionErrorCode` + `SpawnSessionResult`.

### 3) CLI agent catalog: `packages/happy-cli/src/backends/catalog.ts`

This is the CLI’s explicit assembly of backends into a deterministic map:
- `export const AGENTS: Record<CatalogAgentId, AgentCatalogEntry> = { ... }`
- helper resolvers such as `resolveCatalogAgentId(...)`

Backend folders live under:
- `packages/happy-cli/src/backends/<agentId>/**`

### 4) App agents catalog: `packages/happy-app/sources/agents/catalog.ts`

This is the app’s single public surface for screens:
- screens import only from `packages/happy-app/sources/agents/catalog.ts`
- it composes:
  - **core registry** (`registryCore.ts`) for identity + app config
  - **UI registry** (`registryUi.ts`) for assets/visuals (lazy loaded for Node-safe tests)
  - **behavior registry** (`registryUiBehavior.ts`) for provider-specific hooks

Provider code lives under:
- `packages/happy-app/sources/agents/providers/<agentId>/**`

---

## App registries (mental model)

There are three layers inside `packages/happy-app/sources/agents/`:

1) **Core registry** (`registryCore.ts`)
   - identity + app-facing config (translations, settings gating, permissions, connected service UX, resume config, etc.)
   - consumes canonical ids from `@happy/agents`

2) **UI registry** (`registryUi.ts`)
   - app-only visuals (icons, tints, avatar overlay sizing, glyphs)
   - imported lazily by `catalog.ts` so Node-side tests can import `@/agents/catalog` without loading native assets

3) **Behavior registry** (`registryUiBehavior.ts`)
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

### Checklist id conventions

Checklist ids are treated as stable API between daemon and app:
- `new-session`
- `machine-details`
- `resume.<agentId>`

### ACP runtime-gated resume (`runtimeGate: 'acpLoadSession'`)

Some agents are resumable only when ACP `loadSession` is supported on the machine.

In `@happy/agents`, this is represented as:
- `AGENTS_CORE[agentId].resume.runtimeGate === 'acpLoadSession'`

In the app, default behavior (see `registryUiBehavior.ts`) will:
- prefetch `cli.<agentId>` with ACP capability info when needed
- gate resumability on the runtime result (fail-closed)

---

## Adding a new agent/provider (end-to-end)

### Step 0 — pick the id contract (critical)

Choose a new canonical id (example): `myagent`.

Prefer:
- `AgentId === cliSubcommand === detectKey`

If you need variants, use `flavorAliases` (and keep canonical ids stable).

### Step 1 — add/extend the canonical manifest (`@happy/agents`)

Edit:
- `packages/happy-agents/src/manifest.ts`

Add/update:
- `id`, `cliSubcommand`, `detectKey`
- `flavorAliases` (if needed)
- `resume.vendorResume` (`supported | unsupported | experimental`)
- `resume.runtimeGate` (optional, e.g. `'acpLoadSession'`)
- `resume.vendorResumeIdField` (optional)
- `cloudConnect` (optional)

### Step 2 — add the CLI backend folder

Create:
- `packages/happy-cli/src/backends/myagent/`

Common files (as needed):
- `cli/command.ts` (subcommand handler)
- `cli/detect.ts` (version/login probe spec)
- `cli/capability.ts` (override for `cli.myagent`, if needed)
- `daemon/spawnHooks.ts` (daemon wiring tweaks, if needed)
- `acp/backend.ts` (ACP backend, if applicable)
- `cloud/connect.ts` (cloud connect, if applicable)

### Step 3 — export one catalog entry and wire it into the CLI catalog

Create:
- `packages/happy-cli/src/backends/myagent/index.ts`

Pattern:

```ts
import { AGENTS_CORE } from '@happy/agents';
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
- `packages/happy-cli/src/backends/catalog.ts`

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
- `packages/happy-app/sources/agents/providers/<agentId>/core.ts`
- `packages/happy-app/sources/agents/providers/<agentId>/ui.ts`
- `packages/happy-app/sources/agents/providers/<agentId>/uiBehavior.ts` (optional; only if you need overrides)

Wire them into registries:
- add `*_CORE` to `packages/happy-app/sources/agents/registryCore.ts`
- add `*_UI` to `packages/happy-app/sources/agents/registryUi.ts`
- add `*_UI_BEHAVIOR_OVERRIDE` to `packages/happy-app/sources/agents/registryUiBehavior.ts` (only if you have overrides)

### Step 5 — update `@happy/protocol` only when the boundary truly changes

If you need new daemon/app fields, add them to:
- `packages/happy-protocol/src/*`

Then update both sides (CLI implementation + app consumer) to match the new stable contract.

### Step 6 — verify (repo-local and happy-stacks)

Repo-local:

```bash
yarn typecheck
yarn test
```

Scoped:

```bash
yarn --cwd packages/happy-cli typecheck
yarn --cwd packages/happy-app typecheck
```

If you’re running this repo via happy-stacks, prefer:
- `happys typecheck happy`
- `happys test happy`

---

## Node-safe imports (tests)

Some tests import `packages/happy-app/sources/agents/catalog.ts` in a Node environment. Avoid importing native/icon modules from code that executes during those imports.

Patterns we use:
- `catalog.ts` lazy-loads `registryUi.ts` via `require('./registryUi')` to avoid loading image files in Node.
- if a provider behavior needs a React Native component (e.g. action chips), lazy-require it inside the hook.

---

## Anti-patterns (please don’t)

- Don’t “auto-discover” backends by scanning the filesystem. We want deterministic bundling and explicit reviewable changes.
- Don’t do side-effect self-registration (“import this file and it registers itself”). It makes ordering brittle and behavior hard to audit.
- Don’t hardcode agent-specific logic in generic screens; add a typed hook in the provider’s `uiBehavior.ts` instead.
- Don’t import native assets from code that must run in Node tests (keep assets in `registryUi.ts` and lazy-load).
# Agent Catalog - CLI

This doc explains how the **Agent Catalog** works in Happy, and how to add a new agent/backend without guessing.

---

## Terms (what each thing means)

- **AgentId**: the canonical id for an agent, shared across CLI + Expo (+ server).
  - Source of truth: `@happy/agents` (`packages/happy-agents`).
- **Agent Catalog (CLI)**: the declarative mapping of `AgentId -> integration hooks` used to drive:
  - CLI command routing
  - capability detection/checklists
  - daemon spawn wiring
  - optional ACP backend factories
  - Source: `packages/happy-cli/src/backends/catalog.ts`
- **Backend folder**: provider/agent-specific code and wiring.
  - Source: `packages/happy-cli/src/backends/<agentId>/**`
- **Protocol**: shared cross-boundary contracts between UI and CLI daemon.
  - Source: `@happy/protocol` (`packages/protocol`).

---

## Sources of truth

### 1) Shared core manifest: `@happy/agents`

Where: `packages/happy-agents/src/manifest.ts`

What belongs here:
- canonical ids (`AgentId`)
- identity/aliases for parsing or migration (e.g. `flavorAliases`)
- resume core capabilities (e.g. `resume.runtimeGate`, `resume.vendorResume`)
- cloud connect core mapping (if any): `cloudConnect`

What does **not** belong here:
- UI assets (icons/images)
- UI routes
- CLI implementation details (argv, env, paths)

### 2) Cross-boundary contracts: `@happy/protocol`

Where: `packages/protocol/src/*`

What belongs here:
- daemon RPC result shapes that the Expo app needs to interpret deterministically
- stable error codes (e.g. spawn/resume failures)

Example:
- `packages/protocol/src/spawnSession.ts` defines `SpawnSessionErrorCode` + `SpawnSessionResult`.

### 3) CLI agent catalog: `packages/happy-cli/src/backends/catalog.ts`

Where the CLI assembles all backends into a single map:
- `export const AGENTS: Record<CatalogAgentId, AgentCatalogEntry> = { ... }`
- helper resolvers like `resolveCatalogAgentId(...)`

---

## CLI backend layout (recommended)

Each backend folder exports one canonical entry object from its `index.ts`:

- `packages/happy-cli/src/backends/<agentId>/index.ts` exports:
  - `export const agent = { ... } satisfies AgentCatalogEntry;`

The global catalog imports those entries and assembles them:
- `packages/happy-cli/src/backends/catalog.ts`

This keeps backend-specific wiring co-located, while preserving a deterministic, explicit catalog (no self-registration side effects).

---

## AgentCatalogEntry hooks (CLI)

Type: `packages/happy-cli/src/backends/types.ts` (`AgentCatalogEntry`)

### Required

- `id: AgentId`
- `cliSubcommand: AgentId`
- `vendorResumeSupport: VendorResumeSupportLevel` (from `@happy/agents`)

### Optional hooks (what they do)

- `getCliCommandHandler(): Promise<CommandHandler>`
  - Provides the `happy <agentId> ...` CLI subcommand handler.
  - Used by `packages/happy-cli/src/cli/commandRegistry.ts`.

- `getCliCapabilityOverride(): Promise<Capability>`
  - Defines the `cli.<agentId>` capability descriptor, if the generic one is not sufficient.

- `getCapabilities(): Promise<Capability[]>`
  - Adds extra capabilities beyond `cli.<agentId>`, typically:
    - `dep.${string}` (dependency checks)
    - `tool.${string}` (tool availability)
  - Example: Codex contributes `dep.codex-acp` etc.

- `getCliDetect(): Promise<CliDetectSpec>`
  - Provides version/login-status probe argv patterns used by the CLI snapshot.
  - Consumed by `packages/happy-cli/src/capabilities/snapshots/cliSnapshot.ts`.

- `getCloudConnectTarget(): Promise<CloudConnectTarget>`
  - Enables `happy connect <agentId>` for this agent.
  - The preferred source-of-truth for connect availability + vendor mapping is `@happy/agents` (and this hook returns the implementation object).

- `getDaemonSpawnHooks(): Promise<DaemonSpawnHooks>`
  - Allows per-agent spawn customizations in the daemon, while keeping the wiring co-located with the backend.

- `getHeadlessTmuxArgvTransform(): Promise<(argv: string[]) => string[]>`
  - Optional argv rewrite for `--tmux` / headless launching.

- `getAcpBackendFactory(): Promise<(opts: unknown) => { backend: AgentBackend }>`
  - Provides an ACP backend factory for agents that run via ACP.

- `checklists?: AgentChecklistContributions`
  - Optional additions to the capability checklists system.
  - Prefer data-only contributions (no side-effect registration).

---

## Capabilities + checklists contract (CLI ↔ Expo)

### Capability id conventions (CLI)

Defined in `packages/happy-cli/src/capabilities/types.ts`:
- `cli.<agentId>`: base “agent detected + login status + (optional) ACP capability surface” probe
- `tool.${string}`: tool capability (e.g. `tool.tmux`)
- `dep.${string}`: dependency capability (e.g. `dep.codex-acp`)

### Checklist id conventions (CLI)

Checklist ids are strings; we treat these as stable API between daemon and UI:
- `new-session`
- `machine-details`
- `resume.<agentId>` (one per agent)

### ACP resume runtime gate

Some agents don’t have “vendor resume” universally enabled, but can be resumable depending on whether ACP `loadSession` is supported on the machine.

In `@happy/agents`, this is represented as:
- `resume.runtimeGate === 'acpLoadSession'`

In the CLI, this is implemented by making `resume.<agentId>` checklists include an agent probe request that sets `includeAcpCapabilities: true`.

So UI logic can treat “ACP resume supported” as:
- the daemon’s `resume.<agentId>` checklist result contains a `cli.<agentId>` capability whose `acpCapabilities.loadSession` indicates support (shape defined by the CLI capability implementation).

---

## Adding a new agent/backend (CLI)

### Step 0 — Pick the id contract

Decide a new canonical id (example): `myagent`.

We strongly prefer:
- `AgentId === CLI subcommand === detectKey`

### Step 1 — Add the agent to `@happy/agents`

Edit:
- `packages/happy-agents/src/manifest.ts`

Add:
- `AgentId` entry
- any `flavorAliases`
- `resume.vendorResume` (`supported|unsupported|experimental`)
- optional `resume.runtimeGate` (e.g. `'acpLoadSession'`)
- optional `cloudConnect` mapping if it participates in cloud connect UX

### Step 2 — Create a backend folder in the CLI

Create folder:
- `packages/happy-cli/src/backends/myagent/`

Add whatever you need (examples):
- `cli/command.ts` (subcommand handler)
- `cli/capability.ts` (optional override for `cli.myagent`)
- `cli/detect.ts` (version/login probe spec)
- `daemon/spawnHooks.ts` (if needed)
- `acp/backend.ts` (if it’s an ACP backend)
- `cloud/connect.ts` (if it supports connect)

### Step 3 — Export the catalog entry from `index.ts`

Create:
- `packages/happy-cli/src/backends/myagent/index.ts`

Pattern:
```ts
import { AGENTS_CORE } from '@happy/agents';
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

### Step 4 — Add it to the catalog assembly

Edit:
- `packages/happy-cli/src/backends/catalog.ts`

Add:
```ts
import { agent as myagent } from '@/backends/myagent';

export const AGENTS = {
  // ...
  myagent,
} satisfies Record<CatalogAgentId, AgentCatalogEntry>;
```

### Step 5 — Verify

Run:
```bash
yarn --cwd cli typecheck
yarn --cwd cli test
```

---

## What not to do (anti-patterns)

- Don’t “auto-discover” backends by scanning the filesystem. We want deterministic bundling and explicit reviewable changes.
- Don’t do side-effect self-registration (“import this file and it registers itself”). It makes ordering brittle and behavior hard to audit.
- Don’t leave long-lived “stubs” (re-export shims) as an architectural layer. Prefer canonical entrypoints and direct imports.


