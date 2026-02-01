---
description: "Show raw session JSON"
edison-generated: true
edison-id: "session-show"
edison-platform: "claude"
argument-hint: "session_id"
---

# edison.session-show

Prints the session JSON record exactly as stored on disk.

```bash
edison session show <session_id>
```

## Arguments
- **session_id** (required): Session identifier (e.g., sess-001)

## When to use

To inspect the persisted session record (including git/worktree metadata)

## Related Commands
- /edison.session-status
- /edison.session-verify
