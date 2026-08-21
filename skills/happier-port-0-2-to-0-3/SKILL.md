---
name: happier-port-0-2-to-0-3
description: Port a complete Happier change from the 0.2 source line into the evolved 0.3 destination line by intent, including every later refinement and accepted review fix, without copying predecessor architecture or consuming unrelated work. Use when a 0.2 PR, branch, commit, or dirty change must be represented correctly in 0.3 with destination-owner discovery, compatibility analysis, related-only commits, validation, and verified contributor co-authorship.
---

# Happier Port 0.2 to 0.3

Own the forward-port lifecycle from the 0.2 release line to the 0.3 development line. Treat checkout paths as runtime inputs, never as product or release identities.

## 1. Load the owning workflows

Use:

- `skills/happier-compatibility` for released and prospective wire, persistence, semantic, and operational contracts;
- `skills/happier-implement` and `skills/happier-testing` for destination changes and RED -> GREEN proof;
- `skills/happier-commit-worktree` for a large or actively dirty destination;
- `skills/verify-claims` before relying on source reports, reviews, or delegated conclusions;
- `skills/attack-conclusion` and `skills/handoff-report` for closeout.

Read [port-workflow.md](references/port-workflow.md) before acting.

## 2. Resolve source and destination explicitly

Obtain or discover two independent Git checkouts:

- the 0.2 source line containing the complete validated change;
- the 0.3 destination line that must preserve its intent.

Verify repository identity, branch/commit basis, dirty state, and current bytes. Do not infer a release line from a directory name, assume a sibling path exists, create or clone a checkout without authorization, or switch a primary checkout. If the destination is unavailable, continue source-side analysis and report only the port as blocked with the exact missing location or authority.

## 3. Freeze the source intent after source validation

Port only after the source change is coherent and has passed its required validation. Record the source basis and express every change independently of filenames:

- user-visible or operational outcome;
- defect mechanism or invariant;
- canonical source owner and affected callers/readers/writers;
- tests and compatibility behavior that prove it;
- exclusions and intentionally unchanged behavior.

Include the whole source change, not only the latest follow-up commit. Refresh this intent set after every accepted review or CI-driven correction.

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

## 6. Commit only the port

Treat the 0.3 checkout as shared and dirty. Inspect inherited staging, select exact related paths or hunks, and preserve all unrelated bytes uncommitted. Use a Conventional Commit message.

For a PR-derived port, every destination commit carrying the PR's intent or an accepted follow-up must include the PR author's verified `Co-authored-by: Name <email>` trailer. Preserve other material contributors under the repository attribution rules. Stop before committing if a required identity cannot be verified; never guess or expose an email.

## 7. Verify completeness after every follow-up

After each later source refinement or accepted review finding, repeat the intent classification and destination audit. A test-only source follow-up may require no destination code when 0.3 already proves the contract; record that evidence instead of creating a ceremonial commit.

Finish only when every source intent has an evidence-backed destination disposition, all applicable changes are committed without unrelated bytes, deciding checks have run, and remaining gaps or unavailable validation are explicit.
