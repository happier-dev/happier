<!-- EDISON:GENERATED id=task-relate platform=cursor -->

# edison.task-relate

**Guardrails**
- Use `related` for “keep in mind” coupling, not for ordering. If ordering matters, use `depends_on`.
- Keep `related` lists small (signal > noise).

**Steps**
1. Decide relationship type:
   - Blocking prerequisite → add `depends_on` in frontmatter.
   - Soft coupling → use `edison task relate`.
2. Add relation: `edison task relate <A> <B>`
3. If you later decide it is blocking, remove `related` and replace with `depends_on` explicitly.

## Usage

```bash
edison task relate <task_a> <task_b> [--remove] [--json]
```

## Arguments
- task_a (required): Task ID (A).
- task_b (required): Task ID (B).
- --remove: Remove relation instead of adding it.
- --json: Output JSON.

## When to use

- Two tasks touch the same subsystem but are not strict prerequisites
- You want the wave planner to keep tasks clustered (best-effort) without blocking

## Related
- /edison.task-link
- /edison.task-audit
- /edison.task-waves
