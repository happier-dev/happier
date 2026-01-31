<!-- EDISON:GENERATED id=task-similar platform=cursor -->

# edison.task-similar

**Guardrails**
- Treat similarity matches as hypotheses. Confirm by reading the candidate tasks before merging/scoping changes.
- Prefer merging tasks when they share the same “canonical owner module/API”, and split when they bundle unrelated concerns.

**Steps**
1. If you’re about to create a task, run: `edison task similar --query "<proposed title>" --json`.
2. If you’re consolidating, run: `edison task similar --task <task_id> --json`.
3. For top matches:
   - Decide **merge**, **re-scope**, or **keep separate**.
   - If keeping separate, add explicit relationships (`depends_on` / `related`) to reduce drift.

**Reference**
- For a deterministic, backlog-root-only scan, run `edison task audit --json --tasks-root .project/tasks`.

## Usage

```bash
edison task similar --query "<title or description>" [--threshold <f>] [--top <n>] [--json]
edison task similar --task <task_id> [--threshold <f>] [--top <n>] [--json]
```

## Arguments
- --query: Free-text query (usually a title) to match against existing tasks.
- --task: Find similar tasks to an existing task id.
- --top: Maximum matches to return (default from config).
- --threshold: Minimum similarity score (default from config).
- --only-todo: Only consider tasks in todo state.
- --states: Comma-separated list of task states to search (overrides --only-todo).
- --json: Output JSON.

## When to use

- Before creating a new task (dedupe-first)
- When consolidating a backlog and trying to remove overlap

## Related
- /edison.task-audit
- /edison.task-new
