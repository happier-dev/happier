---
description: "Allocate the next available task ID (stable + collision-free)"
edison-generated: true
edison-id: "task-allocate-id"
edison-platform: "claude"
argument-hint: "--parent --prefix --json"
---

# edison.task-allocate-id

**Guardrails**
- Prefer stable, human-readable IDs over ad-hoc names. IDs are coordination primitives (relationships, waves, audit).
- Do not hand-pick IDs when parallel work is happening; use this to avoid collisions.

**Steps**
1. Decide whether this is a **top-level** task or a **child** task.
2. Allocate:
   - Top-level: run `edison task allocate-id --prefix <slug>`
   - Child: run `edison task allocate-id --parent <parent_id> --prefix <slug>`
3. Use the returned ID as the canonical record ID when creating the task.

**Reference**
- If you suspect duplicates, run `edison task similar --query "<title>" --json` before creating the task.

```bash
edison task allocate-id [--parent <task_id>] [--prefix <slug>] [--json]
```

## Arguments
- **--parent**: Parent task ID for child allocation (e.g., 150-wave1 or 201).
- **--prefix**: Optional suffix/prefix to append to the allocated ID.
- **--json**: Output JSON.

## When to use

- You want to create a new task and need a stable, unused ID
- You are about to split work and want child IDs that won’t collide

## Related Commands
- /edison.task-new
- /edison.task-split
