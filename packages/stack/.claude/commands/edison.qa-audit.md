---
description: "Audit prompt/guideline hygiene (duplication, purity)"
edison-generated: true
edison-id: "qa-audit"
edison-platform: "claude"
---

# edison.qa-audit

Workflow: audit Edison prompt/guideline content for quality issues:
- duplication across guidelines
- purity violations (project terms leaking into core/packs)

```bash
edison qa audit --check-duplication --check-purity
```


## When to use

- You suspect duplicated/conflicting guidance across the composed stack
- You want to enforce prompt best practices (single source of truth)

## Related Commands
- /edison.rules-current
