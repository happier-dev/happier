---
description: "List tasks ready to be claimed"
edison-generated: true
edison-id: "task-ready"
edison-platform: "claude"
argument-hint: "record_id --skip-context7 --skip-context7-reason"
---

# edison.task-ready

Workflow: list tasks that are ready to be claimed (derived from dependency readiness).

Use this only when:
- You want to pick your next task in the session

Note: `edison task ready <task-id>` is a deprecated alias for task completion.
Prefer `edison task done <task-id>`.

```bash
edison task ready [--session <session-id>] [<task-id> [--skip-context7 --skip-context7-reason "<why>"]]
```

## Arguments
- **record_id**: (Deprecated) Task identifier to complete (use `edison task done <task>`). Omit to list.
- **--skip-context7**: (Deprecated completion path only) Bypass Context7 checks (requires --skip-context7-reason)
- **--skip-context7-reason**: (Deprecated completion path only) Justification for Context7 bypass

## When to use

- You want to find the next claimable task (todo + deps satisfied)

## Related Commands
- /edison.qa-new
- /edison.qa-validate
- /edison.task-done
