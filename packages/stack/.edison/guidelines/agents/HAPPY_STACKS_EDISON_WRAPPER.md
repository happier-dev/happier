# Happy Stacks: Edison wrapper (MANDATORY)

This repo (`happy-local`) is a Happy Stacks project. Edison must be invoked via the Happy Stacks wrapper so stack/worktree context is enforced.

## Fail-closed rule

- **Do not run** `edison ...` directly.
- Always run Edison via:
  - `happys edison -- <edison args...>`
  - `happys edison --stack=<stack> -- <edison args...>` (recommended for tasks/evidence/validation)

## Copy/paste mapping

- `edison task list` → `happys edison -- task list`
- `edison task status <id>` → `happys edison --stack=<stack> -- task status <id>`
- `edison evidence capture <id>` → `happys edison --stack=<stack> -- evidence capture <id>`
- `edison qa validate <id>` → `happys edison --stack=<stack> -- qa validate <id>`

## Happy Stacks task model (MANDATORY)

- **Parent** (`hs_kind: parent`): planning umbrella (**not claimable**)
- **Track** (`hs_kind: track`): owns **one stack per track**
- **Component** (`hs_kind: component`): owns **one component** under a track

Recommended one-shot setup:

```bash
happys edison task:scaffold <parent-task-id> --mode=upstream|fork|both --yes
```

