# Tracked Action

This focused Developer Preview example opts one daemon Action into the
host-owned Activity lifecycle and reports phase and bounded numeric progress.
The handler only reports progress: returning or throwing settles the operation.

`operation.presentation.onStart` is required. This example uses `current`, so
invoking the Action keeps the user where they are; `detail` opens the
operation detail view immediately and `activity` collapses the invoking
surface instead.

Run the package-local checks with the standard authoring tools:

```bash
happier plugins dev typecheck .
happier plugins test .
```

Tracking is deliberately absent from the beginner scaffold. Use it for work
that benefits from Collapse and reopen behavior while the same daemon process
continues running, not as a default for every Action.
