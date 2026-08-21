---
name: happier-port-0-2-to-0-3
description: Port a complete Happier change from the 0.2 source line into the evolved 0.3 destination line by intent, including later source refinements, without copying predecessor architecture or overwriting unrelated work. Use whenever committed, staged, or unstaged 0.2 behavior must be analyzed for 0.3 applicability, adapted through 0.3's canonical owners, and validated without propagating 0.3 changes backward. This skill does not stage or commit changes.
---

# Happier Port 0.2 to 0.3

Own the forward-port lifecycle from the 0.2 release line to the 0.3 development line. Treat checkout paths as runtime inputs, never as product or release identities.

## 1. Load the owning workflows

Use:

- `skills/happier-compatibility` for released and prospective wire, persistence, semantic, and operational contracts;
- `skills/happier-implement` and `skills/happier-testing` for destination changes and RED -> GREEN proof;
- `skills/verify-claims` before relying on source reports or delegated conclusions;
- `skills/attack-conclusion` and `skills/handoff-report` for closeout.

Read [port-workflow.md](references/port-workflow.md) before acting.

## 2. Resolve source and destination explicitly

Obtain or discover two independent Git checkouts:

- the 0.2 source line containing the complete validated change;
- the 0.3 destination line that must preserve its intent.

Prefer an explicit destination supplied by the user or calling workflow. Otherwise, try the optional sibling alias `../v0.3.x`, then verify that it is a Git checkout for the intended Happier repository before using it. If the alias is absent or resolves incorrectly, ask for the destination location; do not create or repair filesystem aliases implicitly.

Verify repository identity, branch/commit basis, dirty state, and current bytes. Do not infer a release line from a directory name, assume a sibling path exists, create or clone a checkout without authorization, or switch a primary checkout. If the destination is unavailable, continue source-side analysis and report only the port as blocked with the exact missing location or authority.

## 3. Freeze the source intent after source validation

Port only after the source change is coherent and has passed its required validation. Record the source basis and express every change independently of filenames:

- user-visible or operational outcome;
- defect mechanism or invariant;
- canonical source owner and affected callers/readers/writers;
- tests and compatibility behavior that prove it;
- exclusions and intentionally unchanged behavior.

Include the whole current source change: committed, staged, and unstaged bytes in scope. Refresh this intent set after every later source refinement or correction.

## 4. Re-discover the 0.3 owner

Search 0.3 by domain identifiers, symbols, state shapes, routes, provider or feature ids, persistence keys, and the defect mechanism. Identify its current canonical owner, expanded sibling paths, compatibility seams, tests, and active split-brains.

Classify each source intent as:

- already satisfied in 0.3, with evidence;
- applicable through an adapted 0.3-owned implementation;
- applicable to a broader 0.3 corridor because the architecture expanded;
- not applicable because the path is unreachable or deliberately replaced, with evidence.

Never use matching filenames as completeness proof. Do not cherry-pick blindly, copy whole files, overwrite evolved logic, restore a 0.2 owner, or add a predecessor exclusion that contradicts an intentional 0.3 generalization.

## 5. Implement the smallest coherent destination change

Apply every applicable intent at the 0.3 canonical owner. Reuse and extend existing 0.3 abstractions and tests; sweep sibling consumers for the same gap. Production behavior changes require destination-specific RED -> GREEN evidence.

Preserve released compatibility where the changed seam can cross versions, but do not retain unreleased 0.2 internal architecture or create speculative adapters. Never port 0.3 changes backward into 0.2 under this skill.

## 6. Preserve unrelated destination work

Treat the 0.3 checkout as shared and dirty. Inspect current bytes and inherited staging before editing, layer compatible changes onto the live worktree, and preserve all unrelated bytes unchanged and uncommitted.

Do not stage or commit. Report the exact changed paths or hunks and validation to the calling workflow; that caller owns any later commit authority, grouping, message, and attribution.

## 7. Verify completeness after every follow-up

After each later source refinement, repeat the intent classification and destination audit. A test-only source follow-up may require no destination code when 0.3 already proves the contract; record that evidence instead of making a ceremonial edit.

Finish only when every source intent has an evidence-backed destination disposition, all applicable changes are present in the destination worktree without overwriting unrelated bytes, deciding checks have run, and remaining gaps or unavailable validation are explicit.
