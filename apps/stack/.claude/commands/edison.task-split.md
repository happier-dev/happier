---
description: "Split a task into child subtasks (creates task + QA; links parent/child)"
edison-generated: true
edison-id: "task-split"
edison-platform: "claude"
argument-hint: "task_id --count --prefix --dry-run --force --json"
---

# edison.task-split

**Guardrails**
- Split only when you can define clean boundaries (files/modules owned by each subtask).
- Prefer `--dry-run` first to confirm naming and count.
- After splitting, update the parent task to focus on integration/wiring + acceptance criteria across children.

**Steps**
1. Decide the split boundaries (by file/module ownership and acceptance criteria).
2. Preview: `edison task split <task_id> --count <n> --prefix <label> --dry-run`.
3. Create: rerun without `--dry-run`.
4. Re-run `edison task audit --json --tasks-root .project/tasks` to confirm no new overlaps/drift.

```bash
edison task split <task_id> [--count <n>] [--prefix <label>] [--dry-run] [--force] [--json]
```

## Arguments
- **task_id** (required): Task ID to split.
- **--count**: Number of subtasks to create (default: 2).
- **--prefix**: Label appended after '<parent>.<n>-'.
- **--dry-run**: Preview split without creating tasks.
- **--force**: Skip pre-create duplicate checks (if configured).
- **--json**: Output JSON.

## When to use

- A task is too large to validate in one round
- You need parallelizable subtasks with explicit ownership boundaries

## Related Commands
- /edison.task-link
- /edison.task-audit
- /edison.qa-new
