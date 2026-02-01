---
description: "Inspect or update QA rounds for a task"
edison-generated: true
edison-id: "qa-round"
edison-platform: "claude"
argument-hint: "task_id"
---

# edison.qa-round

Workflow: inspect or update QA round history for a task (current round, list of rounds, record outcomes).

```bash
edison qa round <task_id> --list
```

## Arguments
- **task_id** (required): Task identifier

## When to use

- You want to see which round is current (`--current`)
- You want to list the round history (`--list`)
- You want to create a new evidence round directory (`--new`)
- You want to record the round outcome (`--status approve|reject|blocked|pending`)

## Related Commands
- /edison.qa-validate
- /edison.task-status
