# START_VALIDATE_TASK (Happy Stacks validation “slash command”)

Use this when you are asked to validate a task in **happy-local**.

## Golden rule

Validation must be **stack-scoped** and must reflect the *actual* component worktrees pinned into the stack.

Always run via:

```bash
happys edison --stack=<stack> -- <edison args...>
```

Tip: if the command includes a task id / QA id, `happys edison` can often infer the stack from frontmatter, so this also works:

```bash
happys edison -- evidence capture <task-id>
```

## What to validate (recommended)

- Validate the **track task** to validate the whole stack integration.
- Component tasks can be validated for quicker iteration, but track validation is the integration gate.

## Steps

1. Confirm the task kind:
   - `hs_kind=parent` → do not validate directly (validate track/component tasks)

2. Ensure the correct stack:
   - The task `stack:` must match the wrapper `--stack=<stack>` (fail-closed).

3. Capture required evidence:

```bash
happys edison --stack=<stack> -- evidence capture <task-id>
```

Presets:
- **fast**: type-check + build + lint
- **standard**: fast + tests
- **standard-validate**: standard + CodeRabbit review (validation-only)
- **standard-ui-validate**: standard-ui + CodeRabbit review (validation-only)

Validation-only requirement (MANDATORY):

- To run `qa validate --execute`, you MUST use a `*-validate` preset.
- CodeRabbit evidence is required for those presets and will be surfaced by the preflight checklist.
- CodeRabbit does NOT run automatically; you must capture it explicitly when missing:

```bash
happys edison --stack=<stack> -- evidence capture <task-id> --preset standard-validate --only coderabbit
```

4. If the validator needs a running server:
   - Use the configured Edison web server profile (`happy-stack`) via validator workflow.
   - Do not manually start/stop random daemons or kill all stacks.

5. Mark outcome (depending on workflow):
   - If you are a validator, follow the QA workflow (`qa validate`, `qa done`, etc.) via `happys edison`.

## Getting to a “validatable” state (quick checklist)

- Task frontmatter is filled (no placeholders):
  - `hs_kind`, `stack`, and `component/components`
- Stack exists and points at worktree paths
- Evidence capture passes for the selected preset (fast/standard)

## Common failure modes (and fixes)

- **Stack mismatch**: rerun with the correct stack.
- **Missing worktree pinning**: rerun scaffold or repoint stack component dirs to worktrees.
- **Auth missing**: `happys stack auth <stack> copy-from main`

