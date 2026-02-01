## Edison invocation (MANDATORY in Hapsta projects)

- **Do not run** `edison ...` directly.
- Always use the Hapsta wrapper:
  - `hapsta edison -- <edison args...>`
  - `hapsta edison --stack=<stack> -- <edison args...>`

Why:
- The wrapper loads the correct stack env (`HAPPIER_STACK_STACK` + `HAPPIER_STACK_ENV_FILE`).
- Evidence capture fingerprints the actual component repos/worktrees used by the stack.
- Guards fail-closed to prevent editing default checkouts or running against the wrong stack.

