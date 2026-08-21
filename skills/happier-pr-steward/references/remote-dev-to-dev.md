# Remote Dev to Dev Intent Port

Remote Dev is the predecessor preview line; `../dev` is the evolved next version that will eventually replace it. Never assume matching paths, APIs, target identities, ownership, or lifecycle.

## Required port audit

After the Remote Dev PR and after every accepted follow-up:

1. state the behavior, invariant, defect mechanism, and user-visible outcome independent of filenames;
2. identify every changed Remote Dev owner, caller, reader, writer, test, and compatibility seam;
3. search Dev by domain identifiers, symbols, state shapes, routes, feature/provider ids, and the defect mechanism;
4. identify Dev's current canonical owner and any evolved, expanded, replaced, or removed paths;
5. classify each Remote Dev intent as already satisfied, applicable with an adapted implementation, applicable more broadly because Dev expanded the corridor, or not applicable with evidence;
6. implement the smallest coherent Dev-owned correction and sweep sibling paths for the same gap;
7. prove Dev-specific behavior with tests and broader validation appropriate to Dev's architecture.

Do not cherry-pick, copy whole files, overwrite evolved Dev logic, or reintroduce Remote Dev owners and assumptions. An identical patch is acceptable only when inspection proves the relevant Dev owner and contract are still identical.

## Completeness rules

- Port the whole PR intent, not only steward-authored refinements.
- Re-run the audit after every later review fix; a follow-up can change Dev applicability.
- Do not omit a Dev issue merely because the exact Remote Dev file or symbol no longer exists.
- Do not add a Remote Dev exclusion or special case when Dev intentionally generalized that path.
- Prefer Dev's centralized owner and extend its existing tests over recreating the predecessor structure.
- Record every non-applicable item and why it is unreachable or already satisfied.

## Dev commit safety and attribution

Treat Dev as a shared dirty checkout. Inspect its current bytes and inherited index, stage only exact related paths or hunks through the repository's safe commit workflow, and leave all unrelated changes untouched and uncommitted.

Every Dev commit carrying the PR's intent or an accepted follow-up must use a Conventional Commit message and include the PR author's verified `Co-authored-by: Name <email>` trailer. Do not guess the identity. Report residual uncommitted paths without cleaning them up.
