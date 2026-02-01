# Monorepo migration (legacy)

Hapsta is **monorepo-only** today, but it still ships a helper (`hapsta monorepo port`) that can be used to port commits from legacy split repos into the Happier monorepo.

Current monorepo service layout:

- `apps/ui`
- `apps/cli`
- `apps/server`

If you’re migrating old work, start here:

```bash
hapsta monorepo port --help
```

Notes:

- Prefer doing ports in a dedicated worktree (`hapsta wt new ...`) and validating in an isolated stack (`hapsta stack new ...`).
- If you don’t need this, you can ignore it; it exists only for historical migrations.
