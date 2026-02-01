---
description: "Deep read-only backlog coherence review (tasks + waves)"
edison-generated: true
edison-id: "task-backlog-coherence"
edison-platform: "claude"
---

# edison.task-backlog-coherence

Workflow: synthesize `task audit` and `task waves` into a strict, read-only coherence report.

## Goal

Produce a strict, read-only **Backlog Coherence Review** for the current Edison backlog:
- Detect **overlaps, collisions, and competing ownership** (same modules/files touched by multiple tasks).
- Verify **dependency coherence** (frontmatter `depends_on` matches narrative mentions and intended sequencing).
- Verify **parallelization coherence** (topological waves vs. “parallel” claims in task prose).
- Extract **unification opportunities** (DRY/SOLID): where multiple tasks should share a single canonical API/module.

## Operating Constraints (NON-NEGOTIABLE)

- **READ-ONLY**: do not modify tasks, code, configs, or generated artifacts during this review.
- **No cleanup**: multiple sessions may have unrelated diffs; do not revert/clean anything.
- **Ask before edits**: if remediation is recommended, present a concrete patch plan and wait for approval.

## Inputs (required)

You MUST collect both signals:
1. Task audit JSON (`edison task audit --json`)
2. Wave computation JSON (`edison task waves --json`)

If either command fails, stop and report the error and what’s missing.

## Procedure

1. Run:
   - `edison task audit --json --tasks-root .project/tasks`
   - `edison task waves --json`
2. Read the outputs and build a single coherence view with these sections:

### A) Executive Summary

- Backlog size (# tasks)
- Wave distribution (# tasks per wave + unassigned)
- Top collision hotspots (top 5 overlapping file paths)
- Top drift risks (top 5 implicit references)

### B) Collision Hotspots (File/Module Ownership)

For each `file_overlap` path:
- List the tasks involved.
- Classify the hotspot as one of:
  - **Shared contract file** (expected overlap; require strict sequencing)
  - **Implementation collision** (undesirable; split or re-scope tasks)
  - **Wiring/export surface** (expected overlap; define canonical owner task)
- Recommendation (read-only): which task should own the canonical interface and which should become consumers.

### C) Dependency / Mention Coherence

For each `implicit_reference`:
- Show: (task → mentioned task)
- Decide: should this be `depends_on`, `related`, or removed as a non-actionable mention?
- If multiple mentions form a theme (e.g., “same subsystem”), propose a *single* canonical “owner task” and make others depend on or relate to it.

### D) Parallelization Coherence (Waves)

Compare:
- Topological waves from `edison task waves`
- Any “Wave:” markers / “parallel” notes in task bodies (if present)

Flag:
- Tasks placed in the same wave that share `file_overlap` hotspots (these should not run concurrently).
- Tasks in later waves that are referenced as prerequisites in earlier-wave tasks (missing `depends_on`).

### E) DRY/SOLID Unification Opportunities

Derive candidate “unification targets”:
- Repeated nouns/phrases across task titles/bodies (e.g. “mount resolution”, “vendor lock”, “task index”).
- Shared file hotspots and/or clusters of implicit references.

For each unification target:
- Proposed canonical module/API boundary (one sentence).
- Candidate owner task (one task ID).
- Consumer tasks (list).

## Output Format (STRICT)

Emit one Markdown report (no file writes) with:

1. **Executive Summary** bullets
2. A table of findings:
   - `ID` (stable: e.g. `C1`, `D2`, `P3`)
   - `Category` (`Collision`, `Dependency`, `Parallelization`, `Unification`)
   - `Severity` (`CRITICAL/HIGH/MEDIUM/LOW`)
   - `Evidence` (task IDs, file paths, wave numbers)
   - `Recommendation` (read-only)
3. A final **“Ask”** section:
   - Ask whether to propose edits to task frontmatter (add `depends_on` / `related`)
   - Ask whether to propose scope changes (split/merge tasks)
   - Do NOT apply edits unless explicitly approved

```bash
edison task audit --json --tasks-root .project/tasks
edison task waves --json
```


## When to use

- You are about to start a major implementation cycle and want to reduce competing work
- You want a Spec-Kit/BMAD-style structured backlog review before editing task files

## Related Commands
- /edison.task-audit
- /edison.task-blocked
- /edison.task-status
