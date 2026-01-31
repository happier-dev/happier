---
description: "Link parent/child tasks (frontmatter is the source of truth)"
edison-generated: true
edison-id: "task-link"
edison-platform: "claude"
argument-hint: "parent_id child_id --unlink --force --json"
---

# edison.task-link

**Guardrails**
- Prefer **parent/child** for decomposition (ownership / integration hierarchy).
- Prefer `depends_on` for **blocking sequencing**, and `related` for **non-blocking coupling**.
- Avoid `--force` unless you are repairing an already-corrupt graph and you understand the consequences.

**Steps**
1. Confirm whether the relationship is:
   - Decomposition (use `task link`)
   - Blocking prerequisite (use `depends_on` in frontmatter)
   - Soft coupling (use `edison task relate`)
2. If decomposition: run `edison task link <parent_id> <child_id>`.
3. Re-run `edison task audit --json --tasks-root .project/tasks` to ensure coherence signals remain clean.

**Reference**
- A task can have only one parent; if a child already has a parent, you’ll need to decide which task truly owns it.

```bash
edison task link <parent_id> <child_id> [--unlink] [--force] [--json]
```

## Arguments
- **parent_id** (required): Parent task ID.
- **child_id** (required): Child task ID.
- **--unlink**: Remove the parent/child link instead of creating it.
- **--force**: Allow overwriting existing links or creating cycles (dangerous; avoid unless repairing corrupted graphs).
- **--json**: Output JSON.

## When to use

- You split a task into subtasks and want explicit parent/child structure
- You want a tree view (parent task owns integration; children own subcomponents)

## Related Commands
- /edison.task-split
- /edison.task-relate
- /edison.task-status
