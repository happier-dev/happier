<!-- EDISON:GENERATED id=qa-validate platform=cursor -->

# edison.qa-validate

Workflow: run QA validation for a specific task (creates a validation round).

## Usage

```bash
edison qa validate <task_id> --scope auto --execute
```

## Arguments
- task_id (required): Task identifier
- preset: Optional validation preset override (e.g., fast, standard, strict, deep)

## When to use

- The task is `done` and ready for validation
- You want Edison to run the validators (use `--execute`)
- You need cluster validation (use `--scope auto|hierarchy|bundle`)
- You want to override the validation preset (use `--preset <name>`)

## Related
- /edison.qa-round
- /edison.qa-promote
