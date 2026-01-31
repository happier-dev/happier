# START_HAPPY_STACKS_NEW_SESSION

You are starting a new session in **happy-local**, which uses **Happy Stacks** for isolation.

## Critical: how isolation works here

- Edison session worktrees are **disabled** for this project.
- Isolation is achieved via:
  - **component git worktrees** under `components/.worktrees/<component>/...`
  - **stacks** under `~/.happy/stacks/<stack>/...` (each stack has isolated ports/db/cli-home/etc.)

## Non-negotiables

- **Never edit** default checkouts under `components/<component>`.
- **Always run Edison via the wrapper**:
  - `happys edison -- <edison args...>`
  - `happys edison --stack=<stack> -- <edison args...>` (recommended)

## Recommended happy-local flow

1. Plan feature tasks: `happys edison -- read START_PLAN_FEATURE --type start`
2. Scaffold track/component tasks + stacks + worktrees:

```bash
happys edison task:scaffold <parent-task-id> --mode=upstream|fork|both --yes
```

3. Validate tasks: `happys edison -- read START_VALIDATE_TASK --type start`

## Role-specific constitutions

- `happys edison -- read AGENTS --type constitutions`
- `happys edison -- read ORCHESTRATOR --type constitutions`
- `happys edison -- read VALIDATORS --type constitutions`

## Repo ground truth

- `AGENTS.md` (Happy Stacks workflows + happys commands)

