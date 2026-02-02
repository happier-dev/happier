---
description: "Approval-gated remediation from deterministic audit"
edison-generated: true
edison-id: "task-remediate-audit"
edison-platform: "claude"
argument-hint: "--tasks-root --dry-run"
---

# edison.task-remediate-audit

Workflow: turn deterministic audit signals into safe, approval-gated task remediations.

## Goal

Transform `edison task audit --json` output into a structured remediation plan with:
- **Stable finding IDs** (R*, C*, D* taxonomy)
- **Minimal, targeted edits** (frontmatter patches + "Files to Create/Modify" adjustments)
- **Explicit approval gate** before any edits are applied

## Halt Conditions (BMAD-style)

**STOP and report if any of these conditions are met:**

1. `edison task audit --json` fails or returns invalid JSON
2. Tasks root directory not found or empty
3. Audit output is missing required fields (`implicit_reference`, `file_overlap`, `similar`)
4. Unable to parse task frontmatter for any affected task

If halted, emit:
```
HALT: <condition>
Action required: <what the user needs to do>
```

## Operating Constraints (NON-NEGOTIABLE)

- **NEVER apply edits without explicit approval**
- **READ-ONLY until approval**: only analyze and propose
- **Concurrent sessions are normal**: unrelated diffs may exist; do not "clean up" anything
- **Minimal patches**: only touch frontmatter and "Files to Create/Modify" sections
- **No broad rewrites**: never rewrite entire task files

## Remediation Taxonomy (Stable IDs)

### R* (Relationship Fixes)
For `implicit_reference` findings:
- `R1`, `R2`, ... for each implicit reference that should become explicit
- Propose: add `depends_on`, `related`, or `blocks_tasks` to frontmatter

### C* (Collision Fixes)
For `file_overlap` findings:
- `C1`, `C2`, ... for each unordered file collision
- Propose: add ordering via `depends_on` OR refactor file ownership in "Files to Create/Modify"

### D* (Duplicate Candidates)
For `similar` findings above threshold:
- `D1`, `D2`, ... for each duplicate candidate pair
- Propose: unify/scope split/merge with rationale

## Relationship Heuristics

When choosing relationship types:

| Scenario | Relationship | Rationale |
|----------|--------------|-----------|
| Task B requires artifact from Task A | `depends_on` | True prerequisite |
| Unordered `file_overlap` with competing edits | `depends_on` | Ordering resolves collision |
| Same subsystem, independent implementation | `related` | Conceptual link, not blocking |
| Non-actionable mention (historical/FYI) | No link | Remove or ignore |

## Procedure

### 1. Collect Audit Data

```bash
edison task audit --json --tasks-root .project/tasks
```

Optionally also collect:
```bash
edison task waves --json
```

### 2. Parse and Classify Findings

For each audit finding, assign a stable ID:
- Implicit references → `R1`, `R2`, ...
- File overlaps → `C1`, `C2`, ...
- Similar tasks → `D1`, `D2`, ...

### 3. Generate Remediation Plan

For each finding, produce:

#### A) Frontmatter Edits (Preferred)

Propose minimal YAML fragments (not full-file rewrites):
```yaml
# Task: <task-id>
# Finding: <R1/C1/D1>
relationships:
  - type: depends_on  # or: related, blocks_tasks
    target: <target-task-id>
```

#### B) Body Edits (Only When Needed)

If remediation requires changing file targets:
```markdown
## Files to Create/Modify
- path/to/file.py  # REMOVED: ownership transferred to <other-task-id>
+ path/to/other.py # ADDED: new scope
```

### 4. Emit Structured Report

#### Executive Summary
- Total findings: N
- By severity: CRITICAL=X, HIGH=Y, MEDIUM=Z, LOW=W
- Affected tasks: [list]

#### Findings Table

| ID | Severity | Category | Evidence | Recommendation |
|----|----------|----------|----------|----------------|
| R1 | HIGH | Relationship | Task A mentions Task B | Add `depends_on: B` to Task A |
| C1 | MEDIUM | Collision | Tasks A, B both touch `file.py` | Add `depends_on` to sequence |
| D1 | LOW | Duplicate | Tasks A, B are 85% similar | Consider merging |

#### Proposed Edits

For each affected task:

```
Task: <task-id>
Finding: <R1/C1/D1>
Why: <cite audit evidence: mentioned_ids, file_paths, similarity_score>

Proposed frontmatter patch:
---
relationships:
  - type: depends_on
    target: <target-task-id>
---

Proposed body patch: (only if needed)
## Files to Create/Modify
- <change description>
```

### 5. Approval Gate (MANDATORY)

**DO NOT proceed without explicit approval.**

Emit:
```
## Approval Required

The following edits are proposed but NOT YET APPLIED:
- <count> frontmatter edits
- <count> body section edits

Do you want me to apply these task edits now?
- [Yes] Apply all proposed edits
- [Partial] Select specific edits to apply
- [No] Do not apply any edits
```

If approved:
1. Apply edits one task at a time
2. Verify each edit succeeded
3. Report summary of applied changes

## Output Format (STRICT)

The command output MUST be a single Markdown report containing:

1. **Executive Summary** (counts, top risks)
2. **Findings Table** (ID, Severity, Category, Evidence, Recommendation)
3. **Proposed Edits** (per-task patches in machine-reviewable format)
4. **Approval Gate** (explicit yes/no/partial question)

No file writes until approval is granted.

```bash
edison task audit --json
edison task waves --json (optional)
```

## Arguments
- **--tasks-root**: Override tasks root (defaults to config-driven `.project/tasks`).
- **--dry-run**: Show proposed edits without applying them.

## When to use

- You want to convert audit findings into concrete task edits
- You need approval-gated remediation (safe, reversible edits)
- You want Spec-Kit/OpenSpec/BMAD-style structured remediation

## Related Commands
- /edison.task-audit
- /edison.task-backlog-coherence
- /edison.task-blocked
