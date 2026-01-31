---
description: "Show next session steps"
edison-generated: true
edison-id: "session-next"
edison-platform: "claude"
argument-hint: "session_id"
---

# edison.session-next

Workflow: compute next steps for the current session.

Use this whenever you are unsure what Edison expects next. It reads
session/task/QA state and returns the recommended next actions.

```bash
edison session next <session_id>
```

## Arguments
- **session_id** (required): Session identifier (e.g., sess-001). If unknown, run `edison session status` first.

## When to use

- You just finished a step and want the next step
- You're resuming work after a break
- You suspect you're blocked by a guard/state mismatch

## Related Commands
- /edison.session-status
- /edison.task-status
