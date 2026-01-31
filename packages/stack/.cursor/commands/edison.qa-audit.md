<!-- EDISON:GENERATED id=qa-audit platform=cursor -->

# edison.qa-audit

Workflow: audit Edison prompt/guideline content for quality issues:
- duplication across guidelines
- purity violations (project terms leaking into core/packs)

## Usage

```bash
edison qa audit --check-duplication --check-purity
```


## When to use

- You suspect duplicated/conflicting guidance across the composed stack
- You want to enforce prompt best practices (single source of truth)

## Related
- /edison.rules-current
