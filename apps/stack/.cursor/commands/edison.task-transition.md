<!-- EDISON:GENERATED id=task-transition platform=cursor -->

# edison.task-transition

Workflow: transitions are state-machine guarded by default. Use `--dry-run` to preview and `--force` only when you must bypass guards.

## Usage

```bash
edison task transition <task_id> --to <state>
```

## Arguments
- task_id (required): Task identifier (e.g., 150-wave1-auth-gate)

## When to use

To explicitly transition a task state (clearer mental model than "status")

## Related
- /edison.task-status
- /edison.qa-promote
