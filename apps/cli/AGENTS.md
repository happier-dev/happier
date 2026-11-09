# Happier CLI Instructions

Package-specific instructions for `apps/cli` (`@happier-dev/cli`). These supplement the root constitution and override broader guidance where more specific.

## Ownership

The CLI owns local runtime, daemon control, provider execution, authentication, machine/session control, binary-safe tooling, and published CLI packaging.

- `src/index.ts` / `src/cli/**` — command parsing and dispatch.
- `src/agent/catalog/**` — generated executable Agent composition from plugin contributions.
- `src/agent/**` — Agent runtime, ACP, transports, adapters, and factories.
- `src/providers/**` — provider-agnostic model Provider resolution, probing, and materialization.
- `src/api/**` — server communication, encryption, queues, and RPC clients.
- `src/daemon/**` — daemon lifecycle, spawning, diagnostics, local control, and session tracking.
- `src/integrations/**`, `src/terminal/**`, `src/ui/**`, `src/features/**`, and `src/utils/**` — package-local runtime domains.

## Commands and validation

Use pnpm and the package scripts. TypeScript changes require:

```bash
pnpm --filter @happier-dev/cli run typecheck
```

Use the smallest relevant test slice while iterating and broaden before handoff. CLI unit tests must not force a full CLI `dist` build.

## TypeScript, logging, and secrets

- Keep types strict and prefer explicit exported types and named exports.
- Keep imports at file tops and modules cohesive.
- Do not emit debug output to stdout/stderr in agent-session paths; use package file logging so provider terminal UIs are not disturbed.
- Never log secrets, tokens, decrypted secret plaintext, or secret environment values.

## Agent and Provider architecture

- Agent runtime contributions belong in `packages/plugins/<agentId>/src/agent/**` and project through `src/agent/catalog/**`.
- Do not recreate the retired `src/backends/**` host tree.
- `src/agent`, `src/api`, `src/daemon`, `src/rpc`, `src/session`, and `src/terminal` stay generic outside plugin-owned leaves.
- Model Provider contributions belong in `packages/plugins/<providerId>/src/provider/**`; provider-agnostic CLI resolution/probing/materialization belongs in `src/providers/**`.
- Generic CLI code must not branch on Agent or Provider ids when a typed contribution, catalog hook, or provider-binding adapter can own the variation.

Details: [Agent catalog](../../docs/agents-catalog.md), [Providers](../../docs/providers.md), [runtime ownership](../../docs/runtime-core.md), and [plugin platform/SDK ownership](../../docs/plugin-platform.md).

## Generated bundled-plugin artifacts

`scripts/build-owned/generateBundledPluginEntries.ts` is the single producer and single owner of the generated bundled-plugin semantic, catalog, daemon, and bundled-Voice projection files. It does not read, render, write, or check app-preseed Plugin UI byte graphs; those are owned by the `apps/ui` prebuild. Its `…OutPath` declarations are the authority for the complete emitted set, which also reaches `packages/agents` and `packages/protocol`; the frequently touched outputs are:

- `src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts`
- `src/plugins/projection/registry/sources/generatedBundledPlugins.ts`
- `../ui/sources/agents/registry/generatedBundledPluginEntries.ts`
- `../ui/sources/text/bundledPluginTranslations.generated.ts`
- `../ui/sources/voice/registry/generatedBundledVoiceEntries.ts`
- `../ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ts`

Voice runtime `.ios.ts` / `.android.ts` siblings are emitted only when manifest-declared platform membership differs from the common file. Platform package exports select each plugin implementation; equal host projections share one file.

The normalized CLI manifest projections in `assets/bundled-plugin-manifests/*.json` are the tracked clean-checkout declaration source. The generated TypeScript locator module carries paths and metadata only; catalog consumers read declarations lazily through the bundled manifest reader. `packages/plugins/*/.happier-plugin/plugin.json` is an on-demand package artifact, produced alongside the runtime for distribution; some copies remain tracked. Source Agent preparation consumes the tracked JSON projections without requiring packaged artifacts. A `--workspace` write validates selected packages from current source and uses the last published catalog declarations for peers. Cross-plugin identity, reference and targeted-contribution checks involving the selection still apply; package artifacts are prepared only for selected packages. Unscoped writes and every `--mode check` continue to validate all current source.

- Change the generator, never an emitted file. A hand edit to any emitted artifact is erased by the next run and is a review finding; the real defect is in the generator, in a bundled plugin's manifest, or in the bundled-plugin membership list.
- Regeneration is the **last** step of a batch and runs **once**. Adding, renaming or re-manifesting a bundled plugin invalidates every emitted artifact, and several programs do this concurrently. Land every manifest/membership source change first, then run one regeneration:

  ```bash
  node --conditions=happier-source --import ./packages/cli-common/registerSourceRuntime.mjs apps/cli/scripts/build-owned/generateBundledPluginEntries.ts --mode write
  ```

- The semantic drift gate already exists — do not add a second one. It runs the same publisher in `--mode check` and CI reaches it through `test:migration:governance`:
  - `pnpm run test:migration:bundled-plugin-projections` (`--scope projections`) compares the generated semantic projections against the bundled plugin sources. Every input is owned by `packages/plugins/*`, so a failure names a plugin-source or projection defect.
  - The same check compares every present packaged `plugin.json`, including tracked copies, against its normalized authored declaration and runner registrations. Missing ignored package artifacts are not required for a clean source checkout. A drift error includes the exact scoped `--mode write --package-artifacts --workspace <package>` regeneration command.
  - Byte equality across a shared-dependency rebuild is not a plugin-projection contract; only the semantic projection drift check is wired.
  - `--scope projections` is check-only; `--mode write` always publishes the full scope.
- **The producer and its tracked projections are one publication closure; land them in one commit.** The closure is the build-owned generator plus its helpers and test in `scripts/build-owned/` and **every tracked projection** it emits (not only the ones listed above). Installed `packages/plugins/*/.happier-plugin/**` bytes are materialized from those sources at publication; tracked `plugin.json` copies are part of the closure. Pack-time publication compares the current source package tree directly with the prepared package tree before replacement; there is no committed byte ledger or compatibility generator entrypoint. Establish tracked membership from `git ls-tree -r --name-only HEAD <path>` at the moment you commit — never from a filename or from an earlier note in this file.

## Terminal and integrations

- `src/terminal/**` owns provider-agnostic terminal runtime, attachment, metadata, and terminal UX/domain behavior.
- `src/integrations/**` owns concrete OS/tool integrations such as tmux, difftastic, proxy, tailscale, and watchers.
- Reuse an existing integration owner before adding a sibling. Add a new folder only for a real distinct integration domain.
- Agent-specific terminal runtime belongs in the Agent plugin leaf; shared terminal abstractions stay in `src/terminal/**` or the concrete integration owner.

## Daemon and process behavior

- Daemon lifecycle, state files, local HTTP control, backend sockets, spawn hooks, and session tracking are production behavior and require TDD.
- Preserve graceful shutdown, stale-process cleanup, authentication, and validation semantics.
- Reuse daemon-owned process/session helpers rather than adding ad hoc spawn or cleanup paths.
- A settled daemon or runner issues no recurring server reads except named liveness. Re-read server state on the live change signal, not per activity read, RPC or wake, and reuse context the daemon already holds for a tracked Session without turning it into a TTL cache. Prove it with requests per idle minute by caller.
- A startup budget or required-readiness wait applies only to dependencies the Session requires; optional and third-party integrations start on their own defaults and never hold the first turn.

## Binary-safe runtime and packaging

- Shipped runtime paths work without system Node or package managers and use managed runtime/tool abstractions.
- Do not directly spawn `node`, `npm`, `npx`, `pnpm`, `yarn`, or `bunx` in product runtime paths.
- Agent CLIs prefer user/system installs unless an explicit source preference says otherwise.
- Add dependencies to the package that imports them.
- When an internal workspace is used at CLI runtime, keep bundling metadata, dependency closure, and bundling tests in sync.

Details: `../../docs/binary-runtime.md` and `../../docs/cli-architecture.md`.
