---
description: "List composed artifacts (playbook)"
edison-generated: true
edison-id: "list"
edison-platform: "claude"
argument-hint: "type"
---

# edison.list

Workflow: list the canonical, composed artifacts under `.edison/_generated/`.

Use `--type start` to discover available `START_*.md` prompts.

```bash
edison list --type <type> --format detail
```

## Arguments
- **type**: Generated subfolder (e.g., start, constitutions, guidelines/shared, agents). Empty means root.

## When to use

- You need to discover which composed files are available
- You need to pick an appropriate start prompt / guideline / constitution

## Related Commands
- /edison.read
