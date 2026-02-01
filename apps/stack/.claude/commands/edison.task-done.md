---
description: "Complete a task (wip→done) with evidence/TDD guards"
edison-generated: true
edison-id: "task-done"
edison-platform: "claude"
argument-hint: "task-id --session --skip-context7 --skip-context7-reason"
---

# edison.task-done

Workflow: complete a task (typically `wip` → `done`) while enforcing:
- Implementation report presence
- Required evidence presence
- Context7 markers (when detected)
- TDD readiness gates

Use this only when:
- Tests are green
- Evidence has been captured (see `edison evidence status <task-id>`)
- The task is claimed by your session (`--session`)

```bash
edison task done <task-id> [--session <session-id>] [--skip-context7 --skip-context7-reason "<why>"]
```

## Arguments
- **task-id** (required): Task identifier to complete (supports unique prefix shorthand like "12007")
- **--session** (required): Session completing the task (required)
- **--skip-context7**: Bypass Context7 checks (verified false positives only; requires --skip-context7-reason)
- **--skip-context7-reason**: Justification for Context7 bypass (required when --skip-context7 is set)

## When to use

- Implementation is complete and ready to validate

## Related Commands
- /edison.task-ready
- /edison.evidence-init
- /edison.evidence-capture
- /edison.evidence-status
- /edison.qa-new
- /edison.qa-promote
- /edison.qa-validate
