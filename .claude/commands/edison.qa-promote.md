---
description: "Promote QA/task to validated"
edison-generated: true
edison-id: "qa-promote"
edison-platform: "claude"
argument-hint: "task_id"
---

# edison.qa-promote

Workflow: promote a task/QA record to `validated` after successful validation.

Only use when:
- Required validators are green
- Evidence is present for the round(s)
- There are no open blocking findings

```bash
edison qa promote <task_id>
```

## Arguments
- **task_id** (required): Task identifier

## When to use

- All validations passed and you want to finalize

## Related Commands
- /edison.qa-round
- /edison.qa-audit
