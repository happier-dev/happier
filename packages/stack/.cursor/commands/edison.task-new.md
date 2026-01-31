<!-- EDISON:GENERATED id=task-new platform=cursor -->

# edison.task-new

Workflow: create a new task with a stable ID and clear scope.

Recommended:
- Keep the task small enough to validate in one round.
- Put acceptance criteria into the task description.

## Usage

```bash
edison task new --id <id> --slug <slug>
```

## Arguments
- id (required): Numeric id (e.g., 100)
- slug (required): Short slug (e.g., implement-auth)

## When to use

- You're about to start a new unit of work
- You want a canonical task record for Edison workflows

## Related
- /edison.task-claim
- /edison.task-status
