<!-- EDISON:GENERATED id=task-audit platform=cursor -->

# edison.task-audit

Workflow: run a deterministic, read-only audit of the backlog under `.project/tasks`.

## Goal

Perform a deterministic, read-only audit of Edison tasks under `.project/tasks` to surface:
- **Implicit references**: tasks that mention other tasks but do not encode the relationship via frontmatter (`depends_on`, `related`, `blocks_tasks`).
- **File overlap risks**: multiple tasks declaring the same file under “Files to Create/Modify”.
- **Likely duplicates**: tasks with high similarity (title/body) above threshold.

## Operating Constraints (STRICT)

- **READ-ONLY**: Do not modify any files during this audit.
- **Concurrent sessions are normal**: unrelated diffs may exist; do not “clean up” anything.
- **Report first, ask before edits**: if you believe tasks should be updated (e.g., add `depends_on`), propose a patch plan and ask for explicit approval before applying edits.

## Procedure

1. Run `edison task audit --json` (optionally set `--threshold`/`--top-k`).
2. Interpret the JSON output:
   - Treat `file_overlap` as a *collision risk*, not necessarily a bug: it usually means tasks should be sequenced or scoped to avoid competing edits.
   - Treat `implicit_reference` as a *planning drift risk*: either add an explicit relationship or remove the mention if it is non-actionable.
3. Produce a structured report:
   - **Summary**: task count, wave distribution (if present), top tags.
   - **Hotspots**: the top N `file_overlap` paths with task IDs.
   - **Missing links**: grouped by task, list all `implicit_reference` mentions.
   - **Duplicates**: list candidate duplicates with score, and explain whether they should be merged, re-scoped, or kept.
4. End with:
   - “Next actions” (read-only recommendations).
   - “Optional remediation” (explicitly ask whether you should propose or apply edits).

## Usage

```bash
edison task audit [--json]
```

## Arguments
- --tasks-root: Override tasks root (defaults to config-driven `.project/tasks`).
- --threshold: Similarity threshold override for duplicate detection.
- --top-k: Max duplicates per task.
- --json: Output as JSON.

## When to use

- You want fast, deterministic signals about backlog collisions and drift
- You want evidence before doing a deeper, prompt-based backlog review

## Related
- /edison.task-blocked
- /edison.task-ready
- /edison.task-status
