<!-- EDISON:GENERATED id=qa-transition platform=cursor -->

# edison.qa-transition

Workflow: use this to move QA through the validation lifecycle (e.g., `waiting → todo`, `todo → wip`, `wip → done`, `done → validated`).

## Usage

```bash
edison qa transition <task_id> --to <state>
```

## Arguments
- task_id (required): Task identifier (or QA id ending with -qa/.qa)

## When to use

To explicitly transition a QA record state (alias of `qa promote`)

## Related
- /edison.qa-promote
- /edison.qa-validate
- /edison.task-transition
