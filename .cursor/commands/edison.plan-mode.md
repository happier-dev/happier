<!-- EDISON:GENERATED id=plan-mode platform=cursor -->

# edison.plan-mode

**Guardrails**
- Ask clarifying questions before writing plans if requirements/scope are ambiguous.
- Stay **read-only** until the plan is approved: do not edit code, tasks, or configs in Plan Mode.
- Prefer small, verifiable steps; avoid bundling unrelated concerns.

**Steps (Brainstorm → Refine → Approve)**
1. **Ground in reality**
   - Run `edison task audit --json --tasks-root .project/tasks`.
   - Run `edison task waves --json`.
   - Identify collisions, missing relationships, and parallelism constraints.
2. **Draft a plan**
   - Goals, non-goals, acceptance criteria.
   - Proposed milestones (waves) with clear ownership boundaries (files/modules).
   - Risks + mitigations (testing, migration, compatibility).
3. **Refine**
   - Split any step that cannot be validated in one round.
   - Merge any step that duplicates another step’s canonical module/API ownership.
4. **Approve**
   - Ask for explicit approval before applying any edits to task frontmatter or code.

**Output format**
- Emit a single Markdown plan with:
  - Executive summary
  - Milestones (ordered)
  - Dependencies (explicit)
  - Validation strategy
  - “Ask” section (approval gate)

## Usage

```bash
edison task audit --json --tasks-root .project/tasks
edison task waves --json
```


## When to use

- You want to plan a multi-step change before implementing
- You want to turn a vague request into an executable, coherent task sequence

## Related
- /edison.task-audit
- /edison.task-waves
- /edison.task-backlog-coherence
