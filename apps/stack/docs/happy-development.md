# Happier development (hstack)

hstack is the recommended workflow for developing **Happier** locally.

In the 0.3 development checkout, `hstack-exec` places explicit tracked-source writers, including their preparation, on the authoritative checkout; checks, typechecks and builds of ignored outputs stay AUTO even when they regenerate compilation inputs.

Run a sibling historical or clean basis with `hstack-exec --repo=/absolute/path/to/basis --cwd=. -- <command>`. Placement and admission use the live executor; dependency bootstrap and workspace preparation use the basis's own scripts so they stay paired with its package tools.

Key principles:

- Use **repo worktrees** under `<workspace>/{pr,local,tmp}/...`
- Keep `<workspace>/main` as the stable checkout (treat it as read-only)
- Use `<workspace>/dev` as the default dev checkout (created by `hstack setup-from-source --profile=dev`)
- Run feature work in isolated **stacks** (ports + dirs + env file)

Quickstart (dev profile):

```bash
npx --yes -p @happier-dev/stack hstack setup-from-source --profile=dev
```

Common flows:

- Worktrees: `docs/worktrees-and-forks.md`
- Stacks: `docs/stacks.md`
- Paths/env precedence: `docs/paths-and-env.md`
