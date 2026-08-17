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

Do not create a dedicated stack merely because testing or QA involves stack services. When a human explicitly requests a dedicated, isolated, stable, controlled, snapshot-backed, or manual-restart QA stack, invoke `skills/happier-controlled-stack-qa`; that skill owns creation, session-wide reuse of one remembered stack, runtime selection, reload boundaries, borrowed Expo, and teardown. Additional or replacement stacks require an explicit human request.

When a human has already authorized or named a stack, use that exact stack for the session rather than creating a replacement because its identity was forgotten.

Prefer stack env files and `hstack stack env ...` over hand-editing `env.local`.

Keep the default `main` stack stable and do not commandeer a human-owned development stack or another agent's mutable QA stack.

## Repo-local development database reconciliation

- The deterministic `repo-<checkout>-<id>` stack resolved from the current checkout is its repo-local development stack. Resolve it from current stack metadata and verify its `repo.dir` matches the current checkout; never guess from a similar stack name or mutate every stack that references the checkout.
- Its managed database contains retained development data and is not disposable. Never delete, reset, recreate, replace, truncate, clean, or discard it to fix migration drift.
- When an agent edits a local-only/development-exposed migration already applied to that database, the same task automatically owns in-place reconciliation and canonical migration deployment. No separate confirmation or backup/snapshot/clone is required for this one target.
- If its writers are running, quiesce only stack-owned processes through `hstack`, record whether the stack was running, reconcile, and restore the prior running state. Never kill by port or stop another stack.
- Before handoff, verify current migration bytes against the ledger, run the canonical deploy twice, and run provider integrity/foreign-key checks. A later migration edit invalidates that evidence and makes the later editor responsible for reconciliation again.
- Fail closed for ambiguous identity, `main`, shared, staging, production, external, another checkout's/named QA stack, or otherwise user-owned databases; their normal approval and backup requirements remain in force.

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

Use Conventional Commits as defined in the root `AGENTS.md` under **Adversarial review and handoff**.
