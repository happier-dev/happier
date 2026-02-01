# START_HAPSTA_NEW_SESSION

You are starting a new session in the **Happier** monorepo. This repo uses **Hapsta** for isolation.

## Critical: how isolation works here

- Edison session worktrees are **disabled** for this project.
- Isolation is achieved via:
  - **repo git worktrees** under `<workspace>/.worktrees/<owner>/<branch...>`
  - **stacks** under `~/.happier/stacks/<stack>/...` (each stack has isolated ports/db/cli-home/etc.)

## Non-negotiables

- **Never edit** the default repo checkout (typically `<workspace>/happier`).
- **Always run Edison via the wrapper**:
  - `hapsta edison -- <edison args...>`
  - `hapsta edison --stack=<stack> -- <edison args...>` (recommended)

## Recommended flow

1. Plan feature tasks: `hapsta edison -- read START_PLAN_FEATURE --type start`
2. Scaffold track/component tasks + stacks + worktrees:

```bash
hapsta edison task:scaffold <parent-task-id> --mode=upstream|fork|both --yes
```

3. Validate tasks: `hapsta edison -- read START_VALIDATE_TASK --type start`

## Role-specific constitutions

- `hapsta edison -- read AGENTS --type constitutions`
- `hapsta edison -- read ORCHESTRATOR --type constitutions`
- `hapsta edison -- read VALIDATORS --type constitutions`

## Repo ground truth

- `AGENTS.md` (Hapsta workflows + commands)
