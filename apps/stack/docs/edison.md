## Edison in hstack

This doc explains how we use **Edison** with **hstack** for task/QA/evidence/validation, while keeping isolation strictly enforced via **stacks + repo worktrees**.

---

## What Edison is (in one sentence)

Edison is a **task + QA + evidence + validation workflow layer** with generated role prompts and trusted evidence capture.

Edison is **not** responsible for isolation in this repo; isolation is provided by **hstack**.

---

## Isolation model in this repo

- **Repo worktrees** live under `<workspace>/.worktrees/<owner>/<branch...>`
- **Stacks** live under `~/.happier/stacks/<stack>/...` and each stack has its own ports/db/cli-home/etc.
- Edison worktrees are **disabled** for this project (to avoid conflicting with hstack worktrees)

Practical implications:

- Do **not** edit the default repo checkout (typically `<workspace>/happier`).
- Do all implementation work in a worktree under `<workspace>/.worktrees/...`.
- Run evidence/validation in the correct stack context.

---

## The one correct entrypoint: `hstack edison`

Do not run `edison ...` directly in this repo.

Use:

- `hstack edison -- <edison args...>`
- `hstack edison --stack=<stack> -- <edison args...>` (recommended)

Why this wrapper is mandatory:

- Loads the correct stack env (`HAPPIER_STACK_STACK` + `HAPPIER_STACK_ENV_FILE`)
- Enforces fail-closed guardrails (right stack + right repo worktree)
- Makes evidence capture deterministic (fingerprints the actual repo checkout the stack uses)

Reference:

- `.edison/guidelines/agents/HAPPIER_STACK_EDISON_WRAPPER.md`

---

## Task model (hstack)

We keep a strict structure so stacks/worktrees are never “forgotten”.

- **Parent task** (`hs_kind: parent`)
  - planning umbrella (not claimable)
- **Track task** (`hs_kind: track`)
  - owns exactly one stack (`stack: <name>`)
  - declares track (`track: upstream|fork|integration`) and scope (`components: [...]`)
- **Component task** (`hs_kind: component`)
  - child of a track task
  - targets exactly one area (`component: ...`)

Note: “component” here means a **service/package scope** in the monorepo (apps/ui, apps/server, packages/*), not a separate git repo.

---

## Where Edison stores things

- Config + overlays: `.edison/`
  - Project config: `.edison/config/*.yml`
  - Validator overlays: `.edison/validators/overlays/*.md`
  - Packs/guards: `.edison/packs/**`
- Generated content (do not edit): `.edison/_generated/`
- Local task/QA state (gitignored): `.project/**`
