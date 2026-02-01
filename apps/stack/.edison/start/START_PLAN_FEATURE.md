# START_PLAN_FEATURE (Hapsta feature planning “slash command”)

Use this when you are asked to plan a new feature/change in **happier-dev**.

## Goal

Produce a plan that is:
- **worktree + stack enforced** (Hapsta discipline)
- decomposed into **parent → track → component** tasks
- ready for safe parallel work across multiple components/worktrees

## Steps

### 1) Clarify scope

- Feature title + success criteria
- Components affected (`happy`, `happy-cli`, `happy-server-light`, `happy-server`, etc.)
- Do we need **upstream PRs**, fork-only changes, or both?

### 2) Create the parent task (planning umbrella)

Parent tasks are not claimable. They define global scope only.

Frontmatter minimum:
- `hs_kind: parent`
- `components: [...]`

Recommended creation command (then edit the created file to fill frontmatter):

```bash
hapsta edison -- task new --id <id> --slug <slug>
```

Then open the created task file under `.project/tasks/todo/` and set:
- `hs_kind: parent`
- `components: [...]`

### 3) Choose tracks (one stack per track)

Common tracks:
- `upstream`: clean PR-ready changes against upstream (`slopus/*`)
- `fork`: fork-specific changes (if needed)
- `integration`: “test-merge” track when validating fork + upstream together

### 4) Scaffold everything (recommended)

```bash
hapsta edison task:scaffold <parent-task-id> --mode=upstream|fork|both --yes
```

This creates:
- one **track** task per track (each owns one stack)
- one **component** task per component per track
- component worktrees + stack pinning
- QA stubs

### 5) Delegation / execution rules for LLMs

- Only claim **component** tasks.
- Never edit default checkouts.
- Always run within stack context for evidence:
  - `hapsta edison --stack=<stack> -- evidence capture <task-id>`

### 6) “Definition of Done” for the plan

- Parent task exists and lists all components.
- Track tasks exist and each has:
  - `track`, `stack`, `components`, `base_task`
- Component tasks exist and each has:
  - `component` (exactly one), `stack` matching track, `base_task`, `base_worktree`
- Stacks exist and point to worktrees (no default checkouts).

