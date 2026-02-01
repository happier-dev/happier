# Hapsta: Edison wrapper (MANDATORY)

This repo (`happier-dev`) is a Hapsta project. Edison must be invoked via the Hapsta wrapper so stack/worktree context is enforced.

## Fail-closed rule

- **Do not run** `edison ...` directly.
- Always run Edison via:
  - `hapsta edison -- <edison args...>`
  - `hapsta edison --stack=<stack> -- <edison args...>` (recommended for tasks/evidence/validation)

## Copy/paste mapping

- `edison task list` → `hapsta edison -- task list`
- `edison task status <id>` → `hapsta edison --stack=<stack> -- task status <id>`
- `edison evidence capture <id>` → `hapsta edison --stack=<stack> -- evidence capture <id>`
- `edison qa validate <id>` → `hapsta edison --stack=<stack> -- qa validate <id>`

## Hapsta task model (MANDATORY)

- **Parent** (`hs_kind: parent`): planning umbrella (**not claimable**)
- **Track** (`hs_kind: track`): owns **one stack per track**
- **Component** (`hs_kind: component`): owns **one component** under a track

Recommended one-shot setup:

```bash
hapsta edison task:scaffold <parent-task-id> --mode=upstream|fork|both --yes
```

