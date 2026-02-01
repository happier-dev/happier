---
description: "Claim and move task to wip"
edison-generated: true
edison-id: "task-claim"
edison-platform: "claude"
argument-hint: "record_id"
---

# edison.task-claim

Workflow: move a task from `todo` → `wip` and associate it with the active session.

After claiming:
- Follow your agent constitution + mandatory workflow (TDD, no mocks, config-first).
- Work only inside the session worktree (no git checkout/switch in primary).

```bash
edison task claim <record_id>
```

## Arguments
- **record_id** (required): Task or QA identifier (e.g., 150-wave1-auth-gate)

## When to use

- You are ready to start implementation on a specific task
- You want Edison to lock/track ownership to prevent parallel edits

## Related Commands
- /edison.task-status
- /edison.session-next
