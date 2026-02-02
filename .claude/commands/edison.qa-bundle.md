---
description: "Inspect validation cluster scope and evidence layout (playbook)"
edison-generated: true
edison-id: "qa-bundle"
edison-platform: "claude"
argument-hint: "task_id"
---

# edison.qa-bundle

Workflow: compute the validation cluster manifest for `--scope auto|hierarchy|bundle`.

```bash
edison qa bundle <task_id> --scope auto
```

## Arguments
- **task_id** (required): Task identifier (root or bundle member)

## When to use

- Before running validators, to confirm which tasks are in scope
- To see the resolved bundle root and evidence directories

## Related Commands
- /edison.qa-validate
- /edison.qa-promote
