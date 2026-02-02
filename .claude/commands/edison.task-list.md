---
description: "List tasks (and QA) with optional status/session filters"
edison-generated: true
edison-id: "task-list"
edison-platform: "claude"
argument-hint: "--type --status --session --json"
---

# edison.task-list

**Guardrails**
- Don’t create new tasks until you’ve confirmed there isn’t already a task covering the same scope.

**Steps**
1. List todo tasks: `edison task list --status todo`
2. If you’re working in a session, filter: `edison task list --status wip --session <session_id>`
3. If you need QA inventory: `edison task list --type qa --status todo`

```bash
edison task list [--type task|qa] [--status <state>] [--session <session_id>] [--json]
```

## Arguments
- **--type**: Record type to list (`task` or `qa`).
- **--status**: Filter by state (validated against WorkflowConfig).
- **--session**: Filter by session id.
- **--json**: Output JSON.

## When to use

- You need a quick inventory of tasks/QA in a given state
- You want to confirm what exists before creating a new task

## Related Commands
- /edison.task-status
- /edison.qa-new
