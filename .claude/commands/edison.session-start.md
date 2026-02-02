---
description: "Start/resume: pick a START_* prompt (playbook)"
edison-generated: true
edison-id: "session-start"
edison-platform: "claude"
argument-hint: "PROMPT_ID"
---

# edison.session-start

Workflow: choose the correct START_* prompt based on what the user wants,
then print the selected prompt text in-chat.

Important:
- Do NOT run `edison compose ...` from chat. Composition is a developer responsibility.
- Prefer a minimal catalog: treat START_* as composable/extensible and discover them dynamically.

```bash
edison list --type start --format detail
edison read --type start START_<PROMPT_ID>
```

## Arguments
- **PROMPT_ID** (required): Prompt ID suffix (e.g., NEW_SESSION, RESUME_SESSION, AUTO_NEXT)

## When to use

- The user says “start a new session”, “resume”, “what next?”, “validate”, or “cleanup”
- You need the canonical bootstrap instructions before acting

## Related Commands
- /edison.session-status
- /edison.session-context
- /edison.session-next
