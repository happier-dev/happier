<!-- EDISON:GENERATED id=task-waves platform=cursor -->

# edison.task-waves

**Guardrails**
- Waves are computed from `depends_on`, not from task prose. If prose disagrees with waves, fix the task metadata.
- Default behavior plans the **global backlog**. Use `--session <id>` for session-scoped planning.

**Steps**
1. Run `edison task waves --json`.
2. Review:
   - Wave sizes (parallelism)
   - Blocked tasks (external missing/unsatisfied dependencies)
3. Cross-check with `edison task audit --json --tasks-root .project/tasks`:
   - If two tasks in the same wave touch the same files/modules, re-scope or add sequencing.
4. If you have a cap, use `--cap <n>` (or read `maxConcurrentAgents` in the JSON output) to create safe batches.

**Reference**
- If a task you expect to be schedulable is missing, run `edison task blocked`.

## Usage

```bash
edison task waves [--cap <n>] [--json] [--session <session_id>]
```

## Arguments
- --session: Optional session scope for planning (filters to tasks with matching session_id).
- --cap: Optional max parallel cap override (defaults to orchestration.maxConcurrentAgents when available).
- --json: Output JSON.

## When to use

- You want to schedule work into safe parallel batches
- You want to validate that `depends_on` encodes the intended sequencing

## Related
- /edison.task-audit
- /edison.task-blocked
- /edison.task-backlog-coherence
