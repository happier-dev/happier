# Monorepo migration (legacy)

hstack is **monorepo-only** today, but it still ships a helper (`hstack monorepo port`) that can be used to port commits from legacy split repos into the Happier monorepo.

Current monorepo service layout:

- `apps/ui`
- `apps/cli`
- `apps/server`

If you’re migrating old work, start here:

```bash
hstack monorepo port --help
```

Notes:

- Prefer doing ports in a dedicated worktree (`hstack wt new ...`) and validating in an isolated stack (`hstack stack new ...`).
- If you don’t need this, you can ignore it; it exists only for historical migrations.
