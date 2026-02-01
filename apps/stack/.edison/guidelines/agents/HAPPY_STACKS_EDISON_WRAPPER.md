# hstack: Edison wrapper (MANDATORY)

This repo (`happier-dev`) is a hstack project. Edison must be invoked via the hstack wrapper so stack/worktree context is enforced.

## Fail-closed rule

- **Do not run** `edison ...` directly.
- Always run Edison via:
  - `hstack edison -- <edison args...>`
  - `hstack edison --stack=<stack> -- <edison args...>` (recommended for tasks/evidence/validation)

## Copy/paste mapping

- `edison task list` → `hstack edison -- task list`
- `edison task status <id>` → `hstack edison --stack=<stack> -- task status <id>`
- `edison evidence capture <id>` → `hstack edison --stack=<stack> -- evidence capture <id>`
- `edison qa validate <id>` → `hstack edison --stack=<stack> -- qa validate <id>`

## hstack task model (MANDATORY)

- **Parent** (`hs_kind: parent`): planning umbrella (**not claimable**)
- **Track** (`hs_kind: track`): owns **one stack per track**
- **Component** (`hs_kind: component`): owns **one component** under a track

Recommended one-shot setup:

```bash
hstack edison task:scaffold <parent-task-id> --mode=upstream|fork|both --yes
```

