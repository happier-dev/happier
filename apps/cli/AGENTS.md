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
