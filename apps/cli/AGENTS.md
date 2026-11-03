# Happier CLI Instructions

Package-specific instructions for `apps/cli` (`@happier-dev/cli`). These supplement the root constitution and override broader guidance where more specific.

## Ownership

The CLI owns local runtime, daemon control, provider execution, authentication, machine/session control, binary-safe tooling, and published CLI packaging.

- `src/index.ts` / `src/cli/**` — command parsing and dispatch.
- `src/backends/catalog.ts` + `src/backends/<provider>/**` — executable provider wiring.
- `src/agent/**` — provider-agnostic agent runtime, ACP, transports, adapters, and factories.
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

## Provider/backend architecture

- `src/backends/catalog.ts` and `src/backends/<provider>/index.ts` are the canonical executable provider registry.
- Provider-specific execution belongs in `src/backends/<provider>/**`.
- `src/agent`, `src/api`, `src/daemon`, `src/rpc`, `src/session`, and `src/terminal` remain provider-agnostic outside provider-owned leaves.
- Cross-provider variation extends `AgentCatalogEntry` in `src/backends/types.ts` and is implemented in provider entries.
- Declarative provider support/capability facts belong in `packages/agents/*`.

Details: `../../docs/agents-catalog.md`.

## Terminal and integrations

- `src/terminal/**` owns provider-agnostic terminal runtime, attachment, metadata, and terminal UX/domain behavior.
- `src/integrations/**` owns concrete OS/tool integrations such as tmux, difftastic, proxy, tailscale, and watchers.
- Reuse an existing integration owner before adding a sibling. Add a new folder only for a real distinct integration domain.
- Provider-specific terminal runtime belongs in the provider leaf; shared terminal abstractions stay in `src/terminal/**` or the concrete integration owner.

## Daemon and process behavior

- Daemon lifecycle, state files, local HTTP control, backend sockets, spawn hooks, and session tracking are production behavior and require TDD.
- Preserve graceful shutdown, stale-process cleanup, authentication, and validation semantics.
- Reuse daemon-owned process/session helpers rather than adding ad hoc spawn or cleanup paths.
- A settled daemon or runner issues no recurring server reads except named liveness. Re-read server state on the live change signal, not per activity read, RPC or wake, and reuse context the daemon already holds for a tracked Session without turning it into a TTL cache. Prove it with requests per idle minute by caller.
- A startup budget or required-readiness wait applies only to dependencies the Session requires; optional and third-party integrations start on their own defaults and never hold the first turn.

## Binary-safe runtime and packaging

- Shipped runtime paths work without system Node or package managers and use managed runtime/tool abstractions.
- Do not directly spawn `node`, `npm`, `npx`, `pnpm`, `yarn`, or `bunx` in product runtime paths.
- Backend CLIs prefer user/system installs unless an explicit source preference says otherwise.
- Add dependencies to the package that imports them.
- When an internal workspace is used at CLI runtime, keep bundling metadata, dependency closure, and bundling tests in sync.

Details: `../../docs/binary-runtime.md` and `../../docs/cli-architecture.md`.
