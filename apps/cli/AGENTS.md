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

Use yarn. TypeScript changes require:

```bash
yarn workspace @happier-dev/cli typecheck
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

Details: `../../docs/agents-catalog.md` and `../../docs/providers.md`.

## Generated bundled-plugin artifacts

`scripts/build-owned/generateBundledPluginEntries.ts` is the single producer and single owner of the generated bundled-plugin and bundled-Voice projection files. Two live here and the remaining outputs live in `apps/ui`:

- `src/plugins/projection/registry/sources/generatedBundledPluginArtifacts.ts`
- `src/plugins/projection/registry/sources/generatedBundledPlugins.ts`
- `../ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.ts`
- `../ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.web.ts`
- `../ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.ios.ts`
- `../ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.android.ts`
- `../ui/sources/agents/registry/generatedBundledPluginEntries.ts`
- `../ui/sources/text/bundledPluginTranslations.generated.ts`
- `../ui/sources/voice/registry/generatedBundledVoiceEntries.ts`
- `../ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ts`
- `../ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.ios.ts`
- `../ui/sources/voice/registry/generatedBundledVoiceRuntimeEntries.android.ts`

- Change the generator, never an emitted file. A hand edit to any emitted artifact is erased by the next run and is a review finding; the real defect is in the generator, in a bundled plugin's manifest, or in the bundled-plugin membership list.
- Regeneration is the **last** step of a batch and runs **once**. Adding, renaming or re-manifesting a bundled plugin invalidates all six artifacts, and several programs do this concurrently. Land every manifest/membership source change first, then run one regeneration:

  ```bash
  node --experimental-strip-types scripts/migrations/extensions/generateBundledPluginEntries.ts --mode write
  ```

  (that path is a thin compatibility entrypoint that re-exports `main` from the build-owned generator).
- The drift gate already exists — do not add a second one. It runs the same publisher in `--mode check` under one of two scopes, and CI reaches both through `test:migration:governance`:
  - `yarn test:migration:bundled-plugin-projections` (`--scope projections`) compares the generated projections against the bundled plugin sources and the bundle bytes **as installed**. Every input is owned by `packages/plugins/*`, so a failure names a plugin-source or projection defect.
  - `yarn test:migration:bundled-plugin-runtime-determinism` (`--scope all`) additionally re-stages every bundled daemon runtime with esbuild and requires the installed bytes to equal that fresh build. The stage runs `bundle: true, packages: 'bundle'`, so the current `plugin-sdk`/`protocol` output is inlined into every bundle: rebuilding one shared workspace dependency changes all bundled runtimes at once, and the recorded artifact digests with them. That is whole-repo build determinism, not a plugin fact, and it is why the two questions no longer share one name.
  - `--scope projections` is check-only; `--mode write` always publishes the full scope.
- **The producer is mid-relocation; commit both halves atomically (observed 2026-08-19).** At `HEAD` the producer is still `scripts/migrations/extensions/generateBundledPluginEntries.ts` (5,546 lines, emitting only the two `apps/cli` artifacts). In the working tree that tracked file has been rewritten into a 14-line re-export shim, and the real producer moved to `scripts/build-owned/` — where it and its siblings (`generateBundledPluginEntries.test.ts`, `bundledImmutableArtifactEligibility.ts`, `bundledProviderVerification.ts`, `readTypescriptModule.mjs`), plus `scripts/verifyBundledPluginArtifacts.mjs`, are untracked and not gitignored. Committing the shim rewrite without that directory breaks `test:migration:governance` in CI, because the tracked entrypoint would re-export a file CI does not have. All six emitted artifacts are already tracked and already reflect the relocated generator — the four UI artifacts have no producer at `HEAD` at all — so the tracked artifact set and the tracked producer are already out of correspondence.

## Terminal and integrations

- `src/terminal/**` owns provider-agnostic terminal runtime, attachment, metadata, and terminal UX/domain behavior.
- `src/integrations/**` owns concrete OS/tool integrations such as tmux, difftastic, proxy, tailscale, and watchers.
- Reuse an existing integration owner before adding a sibling. Add a new folder only for a real distinct integration domain.
- Agent-specific terminal runtime belongs in the Agent plugin leaf; shared terminal abstractions stay in `src/terminal/**` or the concrete integration owner.

## Daemon and process behavior

- Daemon lifecycle, state files, local HTTP control, backend sockets, spawn hooks, and session tracking are production behavior and require TDD.
- Preserve graceful shutdown, stale-process cleanup, authentication, and validation semantics.
- Reuse daemon-owned process/session helpers rather than adding ad hoc spawn or cleanup paths.

## Binary-safe runtime and packaging

- Shipped runtime paths work without system Node or package managers and use managed runtime/tool abstractions.
- Do not directly spawn `node`, `npm`, `npx`, `pnpm`, `yarn`, or `bunx` in product runtime paths.
- Agent CLIs prefer user/system installs unless an explicit source preference says otherwise.
- Add dependencies to the package that imports them.
- When an internal workspace is used at CLI runtime, keep bundling metadata, dependency closure, and bundling tests in sync.

Details: `../../docs/binary-runtime.md` and `../../docs/cli-architecture.md`.
