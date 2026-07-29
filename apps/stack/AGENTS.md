# Happier Stack Instructions

Package-specific instructions for `apps/stack` (`@happier-dev/stack`). These supplement the root constitution and override broader guidance where more specific.

## Ownership

`@happier-dev/stack` provides local stack/worktree/dev orchestration for the Happier monorepo.

- `scripts/*.mjs` — setup/bootstrap, run/dev/build, stacks, worktrees, service, tailscale, mobile, tools.
- Default home: `~/.happier-stack`.
- Default workspace: `~/.happier-stack/workspace`.
- Main checkout: `<workspace>/main` (stable launcher/default state).
- Dev checkout/worktrees: `<workspace>/dev`, `<workspace>/pr/**`, `<workspace>/local/**`, `<workspace>/tmp/**`.
- Stack storage: `~/.happier/stacks/<stack>/**`.

## Command discipline

Use `hstack` for stack-managed workflows:

- `hstack start` / `hstack dev`
- `hstack typecheck` / `hstack lint` / `hstack test` / `hstack build`
- `hstack stack ...`
- `hstack wt ...`
- `hstack tailscale ...` / `hstack service ...`
- `hstack tools ...` for maintained stack tools

Do not run stack-scoped commands directly inside monorepo checkouts when a stack command exists (`yarn dev`, `yarn start`, raw `expo`, raw `tsc`/`eslint`, raw `docker compose`, raw `git worktree`). If a low-level command is needed repeatedly, prefer adding or using a stack command.

## Worktrees

- Do not develop directly in `<workspace>/main`; treat it as stable launcher state.
- Make changes in `<workspace>/dev`, `<workspace>/pr/**`, `<workspace>/local/**`, or `<workspace>/tmp/**`.
- Use `hstack wt ...` for worktree operations.
- Do not switch branches in the primary checkout.

Common commands:

```bash
hstack wt new pr/my-feature --from=upstream --use
hstack wt pr 123 --use
hstack wt use pr/123-fix-thing
hstack wt list
hstack wt status
```

## Stacks

Test feature/PR work inside an isolated stack when stack services are involved:

```bash
hstack stack new exp1 --interactive
hstack stack wt exp1 -- use <owner/branch|/abs/path>
```

Prefer stack env files and `hstack stack env ...` over hand-editing `env.local`.

The default `main` stack should stay stable. Prefer creating a new stack and pointing it at the worktree under test.

## Safety invariants

Preserve these unless the task explicitly redesigns stack behavior:

- Never kill by port in stack mode.
- Stack stop/restart kills only stack-owned processes recorded in runtime state or stack markers.
- Non-main stacks pick ports at start time; runtime ports are recorded in `stack.runtime.json`.
- `--restart` should reuse previous runtime ports or fail closed if occupied.
- Watcher restarts must be stack-owned and PID-verified.
- Do not auto-enable/repoint Tailscale Serve for non-main stacks by default.
- Multiple daemons are expected across stacks; never fix stack issues by killing all daemons.

## Auth and secrets

- Configure a seed stack once, commonly `dev-auth`.
- New stacks can reuse auth with `hstack stack auth <name> copy-from dev-auth`.
- If the seed is unknown, fall back to copying from `main` only when appropriate for the local setup.

## Testing

- Keep stack tests on native `node --test`; do not migrate stack tests to Vitest or Playwright.
- Unit tests use `*.test.mjs`.
- Integration tests use `*.integration.test.mjs` and remain serial.
- Real integration tests use `*.real.integration.test.mjs`, remain serial, and require `HAPPIER_STACK_RUN_REAL_INTEGRATION_TESTS=1`.
- Canonical runner/discovery helpers live under `scripts/utils/test/**`.
- Canonical stack-local testkit primitives live under `scripts/testkit/core/**`.
- Prefer existing helpers over ad hoc tempdir/env/spawn wrappers.

Validation lanes:

```bash
yarn --cwd apps/stack test:unit
yarn --cwd apps/stack test:integration
```

If `yarn` is not on PATH, use `corepack yarn ...`.

## Commit messages

Use Conventional Commits as defined in the root `AGENTS.md` ("Commit messages").
