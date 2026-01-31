## Edison invocation (MANDATORY in Happy Stacks projects)

- **Do not run** `edison ...` directly.
- Always use the Happy Stacks wrapper:
  - `happys edison -- <edison args...>`
  - `happys edison --stack=<stack> -- <edison args...>`

Why:
- The wrapper loads the correct stack env (`HAPPY_STACKS_STACK` + `HAPPY_STACKS_ENV_FILE`).
- Evidence capture fingerprints the actual component repos/worktrees used by the stack.
- Guards fail-closed to prevent editing default checkouts or running against the wrong stack.

