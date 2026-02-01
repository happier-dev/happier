# Happier development (hstack)

hstack is the recommended workflow for developing **Happier** locally.

Key principles:

- Use **repo worktrees** under `<workspace>/{pr,local,tmp}/...`
- Keep `<workspace>/main` as the stable checkout (treat it as read-only)
- Use `<workspace>/dev` as the default dev checkout (created by `hstack setup --profile=dev`)
- Run feature work in isolated **stacks** (ports + dirs + env file)

Quickstart (dev profile):

```bash
npx --yes -p @happier-dev/stack hstack setup --profile=dev
```

Common flows:

- Worktrees: `docs/worktrees-and-forks.md`
- Stacks: `docs/stacks.md`
- Paths/env precedence: `docs/paths-and-env.md`
