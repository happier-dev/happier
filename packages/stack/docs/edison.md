## Edison in Hapsta

This doc explains **what Edison is**, **how it works**, and **how we use it in Hapsta** to reliably manage feature work across multiple Happier services/packages while enforcing **stacks + worktrees** discipline.

This is intended to be handed to **any human or LLM** and be sufficient to work correctly in this repo.

---

## What Edison is (in one sentence)

**Edison is a task + QA + evidence + validation workflow layer** that standardizes how work is planned, executed, and verified, with generated role prompts (agents/validators/orchestrator) and trusted evidence capture.

Edison is **integrated** but **not responsible for isolation**; isolation is provided by **Hapsta** (worktrees + stacks).

---

## Big picture: what provides isolation here

In this repo:

- **Isolation is provided by Hapsta**
  - **Component worktrees** live under `components/.worktrees/<component>/<owner>/<branch...>`
  - **Stacks** live under `~/.happy/stacks/<stack>/...` and each stack has its own ports/db/cli-home/etc.
- **Edison worktrees are disabled**
  - We do **not** use Edison session worktrees in this repo; they would conflict with Happy Stacks’ worktree model.

This means:

- You must **never edit** default checkouts under `components/<component>` (treat as read-only “launcher defaults”).
- All work must happen in **component worktrees** and be tested/validated inside the correct **stack**.

---

## Sessions in `happy-local` (important)

Edison “sessions” still exist in `happy-local`, but **they do not create git worktrees** here because Edison worktrees are disabled (`.edison/config/worktrees.yml`).

Think of sessions in this repo as:

- **Ownership + safety gating** for task lifecycle transitions (claim/done)
- **Optional context** for validation bundling and session-scoped task queues

### What sessions do (and don’t) do here

- **Sessions do**:
  - allow safely claiming tasks into a session (`task claim`)
  - gate completing tasks (`task done` requires a session)
  - optionally move tasks/QA into session-scoped directories under `.project/sessions/...`
- **Sessions do not**:
- create/manage git worktrees (Hapsta handles worktrees)
  - persist “current session” via `.project/.session-id` (Edison only writes that inside a git worktree)
    - Outside worktrees, prefer passing `--session <id>` or setting `AGENTS_SESSION=<id>` for your shell.

### Commands that require a session vs not

- **Requires a session**:
  - `hapsta edison -- task claim <task-id> --session <session-id>`
  - `hapsta edison -- task done <task-id> --session <session-id>`
- **Does NOT require a session**:
  - Evidence capture: `hapsta edison --stack=<stack> -- evidence capture <task-id>`
  - Validation: `hapsta edison --stack=<stack> -- qa validate <task-id> --execute`

### Recommended flow (implementation)

Use sessions for ownership, and Happy Stacks for isolation:

- Create a session (no worktree will be created in this repo):
  - `hapsta edison -- session create --id <session-id>`
- Claim tasks into that session:
  - `hapsta edison -- task claim <task-id> --session <session-id>`
- Implement only in the stack’s pinned component worktrees.
- Mark done when finished:
  - `hapsta edison -- task done <task-id> --session <session-id>`

### Recommended flow (validation-only)

If you’re only validating existing tasks, you generally **do not need to create a session**:

- `hapsta edison --stack=<stack> -- evidence capture <task-id>`
- `hapsta edison --stack=<stack> -- qa validate <task-id> --execute`

Note: a **parent task is not a session**. Parent tasks are planning umbrellas; sessions are for “who is working on what right now” and guarded claim/done transitions.

---

## The one correct entrypoint: `hapsta edison`

**Do not run `edison ...` directly** in this repo.

Use:

- `hapsta edison -- <edison args...>`
- `hapsta edison --stack=<stack> -- <edison args...>` (recommended)

Why this wrapper is mandatory:

- **Stack-scoped execution**: exports `HAPPIER_STACK_STACK` + loads the stack env file
- **Multi-repo evidence fingerprinting**: evidence is keyed off the actual component repos the stack points at
- **Fail-closed guardrails**: hapsta guards require the right stack + task metadata
- **Convenience**: **stack auto-inference** from task/QA frontmatter when a task/QA id is present

Reference:

- `.edison/guidelines/agents/HAPPIER_STACK_EDISON_WRAPPER.md`

---

## Where Edison stores things in this repo

- **Config + overlays**: `.edison/`
  - Project config: `.edison/config/*.yml`
  - Project validator overlays: `.edison/validators/overlays/*.md`
  - Happy Stacks pack: `.edison/packs/happy-stacks/`
- **Generated content** (do not edit): `.edison/_generated/`
  - Agents/validators/constitutions/guidelines/start prompts, etc.
- **Tasks/QA state** (gitignored here):
  - Global tasks: `.project/tasks/<state>/*.md`
  - Global QA: `.project/qa/<state>/*.md`
  - Session-scoped tasks/QA (optional): `.project/sessions/**/{tasks|qa}/...`

Note: `.project/` is gitignored in this repo by design (task/QA state is local for now).

---

## Happy Stacks task model (MANDATORY)

We enforce a strict structure so stacks/worktrees are never “forgotten”:

### Parent → Track → Component

- **Parent task** (`hs_kind: parent`)
  - Planning umbrella for a feature
  - Declares: `components: [...]`
  - **Not claimable**
- **Track task** (`hs_kind: track`)
  - Child of a parent
  - Owns exactly **one stack** (one stack per track)
  - Declares: `track: upstream|fork|integration`, `stack: <name>`, `components: [...]`, `base_task: <parent-id>`
- **Component task** (`hs_kind: component`)
  - Child of a track
  - Targets exactly **one component**: `component: happy` (or `happy-cli`, etc.)
  - Declares: `stack: <same as track>`, `base_task`, `base_worktree`

This is enforced by happy-stacks guards:

- `.edison/packs/happy-stacks/guards/task.py`

---

## Planning a feature (recommended workflow)

### 1) Read the “planning slash command”

Use:

- `hapsta edison -- read START_PLAN_FEATURE --type start`

### 2) Create a parent task

Create the task, then fill mandatory frontmatter:

- `hapsta edison -- task new --id <id> --slug <slug>`

Edit the created task file to set:

- `hs_kind: parent`
- `components: [...]`

### 3) Scaffold everything (preferred)

Use:

- `hapsta edison task:scaffold <parent-task-id> --mode=upstream|fork|both --yes`

This will (idempotently):

- create track + component subtasks
- create stacks for tracks
- create component worktrees
- pin the stack to those worktrees

---

## Implementing a component task (agent workflow)

### Non-negotiables

- Work only inside `components/.worktrees/...`
- Run validation/evidence **stack-scoped**
- Use `hapsta` commands (not raw `yarn/expo/docker`)

### Evidence capture (trusted runner)

Evidence must be captured via Edison (snapshot-based, fingerprinted):

- `hapsta edison --stack=<stack> -- evidence capture <task-id>`

For reviewing evidence, prefer the CLI (it is staleness-aware):

- `hapsta edison --stack=<stack> -- evidence status <task-id> --preset <preset>`
- `hapsta edison --stack=<stack> -- evidence show <task-id> --command <ci-command>`

Evidence commands are configured in:

- `.edison/config/ci.yml`

They call stack-scoped commands like:

- `hapsta stack typecheck <stack> [components...]`
- `hapsta stack lint <stack> [components...]`
- `hapsta stack build <stack>`
- `hapsta stack test <stack> [components...]`

### Validation presets (project policy)

Configured in:

- `.edison/config/validation.yml`

Presets:

- **fast**: typecheck + build + lint + **track drift review**
- **standard**: typecheck + build + lint + tests + **track drift review** (implementation evidence)
- **standard-validate**: **standard** + **CodeRabbit review evidence** (validation-only)
- **fast-ui**: fast + **browser UI validation** + **track drift review** (for tasks that include component `happy`)
- **standard-ui**: standard + **browser UI validation** + **track drift review** (implementation evidence)
- **standard-ui-validate**: **standard-ui** + **CodeRabbit review evidence** (validation-only)
- **quick**: docs-only (no command evidence)

#### CodeRabbit evidence policy (Happy Stacks)

- CodeRabbit runs as **command evidence** (`command-coderabbit.txt`), not as an Edison validator.
- It is **mandatory for execute-mode task validation**:
  - `hapsta edison --stack=<stack> -- qa validate <task-id> --execute --preset standard-validate`
- It **does not run automatically**. When preflight reports it missing, capture it explicitly:

```bash
hapsta edison --stack=<stack> -- evidence capture <task-id> --preset standard-validate --only coderabbit
```

Note: `qa run` (single-validator execution) also enforces validation-only evidence in happy-local:

- `hapsta edison --stack=<stack> -- qa run <validator> <task-id>`
- If required evidence (including CodeRabbit for the `*-validate` presets) is missing, the wrapper will refuse and tell you exactly which `evidence capture` command to run.

Track drift review is intentionally fast:

- `track:coherence` is captured as **command evidence** (`command-track-coherence.txt`).
- The `track-drift-review` validator should **read that evidence** and should not re-run `track:coherence` unless evidence is missing/broken.

Additionally, for “what changed?” review:

- `command-task-diff.txt` captures the **full per-component diff** computed inside the stack-pinned component repos.
  - It detects the correct base ref per repo (using the stack’s configured remote default branch, e.g. `upstream/<defaultBranch>`).
  - Validators should treat this as the canonical “PR diff” view for code review.

---

## Browser “E2E” validator (MCP-driven UI validation)

In this repo, the `browser-e2e` validator is **not** “run Playwright test files”.

It is:

- **Start stack if needed** (Edison web server lifecycle)
- **Navigate the real UI** and validate flows using **Playwright MCP browser tools**

Key wiring:

- Validator prompt is composed from the core `e2e-web` pack plus a Happy overlay:
  - Overlay: `.edison/validators/overlays/browser-e2e.md`
- Stack lifecycle config:
  - `.edison/config/validation.yml`:
    - `validation.web_servers.happy-stack` (and alias `browser-e2e`)
    - `validation.validators.browser-e2e.web_server.ref: browser-e2e`

Important behavior:

- Edison probes the stack URL (`/health`) and starts the stack if unreachable.
- Edison stops the stack **only if Edison started it**.

---

## Validation workflow (validators / humans)

Start with:

- `hapsta edison -- read START_VALIDATE_TASK --type start`

Common commands:

- **Show task / QA**:
  - `hapsta edison -- task show <task-id>`
  - `hapsta edison -- qa show <qa-id>`
- **Evidence status**:
  - `hapsta edison --stack=<stack> -- evidence status <task-id>`
- **Run validators**:
  - `hapsta edison --stack=<stack> -- qa validate <task-id> --execute --preset fast|standard`

---

## How stack auto-inference works (wrapper convenience)

If you run `hapsta edison -- ... <task-id-or-qa-id> ...` without `--stack`,
the wrapper will try to infer `stack:` from frontmatter by searching:

- `.project/tasks/**`
- `.project/qa/**`
- `.project/sessions/**/{tasks|qa}/**`

If inference fails, prefer explicit `--stack=<stack>`.

---

## Operational commands you’ll use a lot (Happy Stacks)

- **Pick worktrees**:
  - `hapsta wt new ...`
  - `hapsta wt pr ... --use`
  - `hapsta stack wt <stack> -- use <component> <owner/branch>`
- **Health / diagnosis**:
  - `hapsta stack doctor <stack>`
- **Auth repair (non-interactive)**:
  - `hapsta stack auth <stack> copy-from <seed>`

- **Dev UI login key (agents should only consume, not create)**:
  - `hapsta auth dev-key --print`
- **Stop stacks (safe)**:
  - `hapsta stop --except-stacks=main --yes`

See `AGENTS.md` for the full, canonical Happy Stacks discipline.

---

## Customization points (where to change behavior safely)

### Project configuration

- Evidence commands: `.edison/config/ci.yml`
- Validation presets + web server profiles: `.edison/config/validation.yml`
- Enabled packs: `.edison/config/packs.yml`
- Edison worktrees disabled: `.edison/config/worktrees.yml`
- Task/QA templates used for creation (project-owned): `.edison/config/tasks.yml`

### Project templates (task/QA creation)

These are used by Edison when creating new task/QA markdown files:

- `.edison/templates/happy-stacks/TASK.md`
- `.edison/templates/happy-stacks/QA.md`

### Happy-local overlays

- Validator overlay (adds Happy-specific rules): `.edison/validators/overlays/browser-e2e.md`
- Happy Stacks pack overlays + guards: `.edison/packs/happy-stacks/**`

---

## Common failure modes (and what to do)

- **“Do not run `edison ...` directly”**
  - Fix: use `hapsta edison -- ...` (or `--stack=<stack>`)
- **Auth missing / machine not registered**
  - Fix: `hapsta stack auth <stack> copy-from <seed>` (recommended seed: `dev-auth`)
- **Stack port collisions / foreign component paths**
  - Fix: `hapsta stack audit --fix-workspace --fix-paths --fix-ports`
- **Browser validator can’t reach server**
  - Fix: run stack doctor, ensure you’re in the correct stack context, and re-run validation:
    - `hapsta stack doctor <stack>`
    - `hapsta edison --stack=<stack> -- qa validate <task-id> --execute`

---

## Appendix: quick “start here” for an LLM

1. Read repo discipline: `AGENTS.md`
2. Start prompt: `hapsta edison -- read START_HAPSTA_NEW_SESSION --type start`
3. Plan feature: `hapsta edison -- read START_PLAN_FEATURE --type start`
4. Scaffold: `hapsta edison task:scaffold <parent-task-id> --mode=upstream|fork|both --yes`
5. Implement only in component worktrees + validate via stack-scoped evidence:
   - `hapsta edison --stack=<stack> -- evidence capture <task-id>`
