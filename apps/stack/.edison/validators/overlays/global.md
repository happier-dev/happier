<!-- EXTEND: tech-stack -->
## Hapsta evidence-first policy (CRITICAL)

When validating tasks in `happier-dev`, do **not** run ad-hoc `git` commands such as:

- `git status`
- `git diff`
- `git log`
- `git range-diff`

This repo is an orchestration workspace and may be dirty with unrelated work. **Validation must be based on stack-scoped Edison evidence** instead.

### Use these evidence artifacts (authoritative)

- **`command-task-diff.txt`**: canonical per-component PR diff for the task’s pinned worktrees
- **`command-track-coherence.txt`**: upstream/fork/integration patch coherence output
- **`command-type-check.txt`, `command-lint.txt`, `command-build.txt`, `command-test.txt`**: automation results required by the preset

### Scope rule (fail-closed only on target repos)

- Do **not** reject solely because the `happier-dev` root repo is `gitDirty`.
- Only fail-closed based on **task-scoped evidence** and issues in the **target component worktrees**.
<!-- /EXTEND -->

