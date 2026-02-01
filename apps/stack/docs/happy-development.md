# Happier development (Hapsta)

Hapsta is the recommended workflow for developing **Happier** locally.

Key principles:

- Use **repo worktrees** under `<workspace>/.worktrees/<owner>/<branch...>`
- Keep `<workspace>/happier` as a stable default checkout
- Run feature work in isolated **stacks** (ports + dirs + env file)

Quickstart (dev profile):

```bash
npx --yes -p @happier-dev/stack hapsta setup --profile=dev
```

Common flows:

- Worktrees: `docs/worktrees-and-forks.md`
- Stacks: `docs/stacks.md`
- Paths/env precedence: `docs/paths-and-env.md`
