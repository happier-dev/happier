<!-- EDISON:GENERATED id=qa-round platform=cursor -->

# edison.qa-round

Workflow: inspect or update QA round history for a task (current round, list of rounds, record outcomes).

## Usage

```bash
edison qa round <task_id> --list
```

## Arguments
- task_id (required): Task identifier

## When to use

- You want to see which round is current (`--current`)
- You want to list the round history (`--list`)
- You want to create a new evidence round directory (`--new`)
- You want to record the round outcome (`--status approve|reject|blocked|pending`)

## Related
- /edison.qa-validate
- /edison.task-status
