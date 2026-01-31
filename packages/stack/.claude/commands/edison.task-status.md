---
description: "Show current task state"
edison-generated: true
edison-id: "task-status"
edison-platform: "claude"
argument-hint: "record_id"
---

# edison.task-status

Workflow: inspect a task's current state, owner, session linkage, and recent activity.

```bash
edison task status <record_id>
```

## Arguments
- **record_id** (required): Task or QA identifier (e.g., 150-wave1-auth-gate)

## When to use

To check current task progress and state

## Related Commands
- /edison.task-claim
- /edison.session-status
