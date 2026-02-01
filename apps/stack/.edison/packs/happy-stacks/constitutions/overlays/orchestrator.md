<!-- EXTEND: pack-constitution -->
## hstack orchestration rules (MANDATORY)

- **Edison must be invoked through hstack**:
  - Do **not** run `edison ...` directly in this repo.
  - Always run:
    - `hstack edison -- <edison args...>`
    - `hstack edison --stack=<stack> -- <edison args...>` (recommended)
  - See: `.edison/guidelines/agents/HAPPIER_STACK_EDISON_WRAPPER.md`
  - Useful reads:
    - `hstack edison -- read START_PLAN_FEATURE --type start`
    - `hstack edison -- read START_VALIDATE_TASK --type start`
    - `hstack edison -- read START_hstack_NEW_SESSION --type start`

- **Task decomposition is mandatory**:
  - Create a **parent** task first (`hs_kind: parent`) that declares the overall `components: [...]`.
  - Create **one track task per track** (`hs_kind: track`) linked under the parent:
    - One stack per track: `stack: <name>`
    - `track: upstream|fork|integration`
    - `components: [...]` (the exact set pinned into that stack)
    - `base_task: <parent-task-id>`
  - Create **one component task per component** (`hs_kind: component`) linked under the track:
    - `stack` must match the track’s stack
    - `component: <one>`
    - `base_task: <parent-task-id>`
    - `base_worktree: edison/<task-id>`
  - Prefer assigning/claiming work at the **component task** level; validate at the **track task** level.
  - Recommended: use `hstack edison task:scaffold <parent-task-id> --mode=upstream|fork|both --yes`.

- **Upstream-first workflow**:
  - Implement in an upstream-based worktree (`--from=upstream`) when the change should be upstreamed.
  - Keep upstream PR branches clean and upstream-acceptable.
  - Validate on our fork via test-merge / cherry-pick workflow.

- **Do not repoint main stack by accident**:
  - Prefer creating a new stack for PR testing and repointing components there.
  - Use `--force` only when explicitly intended.

- **Evidence is stack-scoped by default**:
  - Run: `hstack edison --stack=<stack> -- evidence capture <task-id>`
  - This ensures evidence reflects the exact component repos/worktrees the stack uses.

## Happy component translations (MANDATORY where applicable)

When planning/scaffolding work across Happy components, you must explicitly account for whether the target repo is translated.

### Component: `happy` (translated UI — MUST translate)

- **Treat i18n as a required deliverable** for any user-facing UI copy changes.
  - If the task touches UI strings, the “definition of done” includes updating translations.
  - Do not accept “English-only now, translate later” for `happy`.

- **Orchestration expectations**:
  - Ensure the implementer knows to use `t('...')` from `@/text` (no hardcoded JSX strings for user-visible text).
  - Ensure the implementer updates:
    - `sources/text/_default.ts` (canonical keys + runtime English + types)
    - `sources/text/translations/<lang>.ts` for **every supported language**
    - and keeps `sources/text/translations/en.ts` in sync with `_default.ts`
  - If the work is large, explicitly allocate time/work to i18n review (tone, length, line breaks, pluralization).

### Component: `happy-cli` (not translated)

- Do not demand translations for this repo unless/until it adopts an explicit i18n system.
- If a task proposes adding i18n, treat that as an explicit architecture change and update the constitution overlays accordingly.

### Component: `happy-server` / `happy-server-light` (not translated)

- Do not demand translations for these repos unless/until they adopt an explicit i18n system.

{{include:constitutions/includes/HAPPY_CRITICAL_PRINCIPLES.md}}
<!-- /EXTEND -->

