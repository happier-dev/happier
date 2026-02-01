---
description: "Print hook-safe session context"
edison-generated: true
edison-id: "session-context"
edison-platform: "claude"
---

# edison.session-context

Prints a small, deterministic context refresher intended for:
- Claude Code hooks (SessionStart/PreCompact/UserPromptSubmit)
- Quick in-chat refresh without running full `session next`

```bash
edison session context
```


## When to use

- After context compaction
- When you want a quick refresh without full orchestration output

## Related Commands
- /edison.session-next
- /edison.session-status
