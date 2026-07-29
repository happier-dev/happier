---
name: verify-claims
description: Audit a report, plan, or handoff by re-deriving every load-bearing claim from primary sources. Use before trusting subagent/lane reports, before building decisions on unverified claims, or when reviewing a conclusion written earlier (including your own). Distinct from running the app to verify behavior or reviewing a diff — this audits claims.
---

# Verify Claims

Take a report — a subagent's, a lane's, a plan's, or your own from earlier — and re-derive its load-bearing claims instead of trusting how they sound. Full doctrine: `docs/agent-craft.md` §4.

## Procedure

1. **Extract the load-bearing claims** — those whose falseness would change the decision being made. Ignore decoration; auditing everything dilutes the audit.
2. **Re-derive each from a primary source.** Source hierarchy: running code > tests > docs > comments > memory. Each step down the ladder is a step toward hearsay.
3. **Use a different path than the claim arrived by.** Claim from reading code → check with a runtime observation. Claim from a test → read the code the test exercises. Two derivations sharing a path share that path's blind spot.
4. **Re-measure every decision-material number.** Re-run test results, coverage, timings, counts, or measurements only when that numeric claim changes the decision. Use the exact immutable commit/artifact when the claim names one; for current dirty work, measure the relevant current paths and acknowledge concurrency. Decorative counts are not evidence and should be removed from the conclusion.
5. **Treat plausibility as zero evidence.** Narrative fit is what generated the claim, so "sounds right" is correlated with exactly the error being hunted. Check the best-fitting claims first, not last.
6. **Downgrade what you cannot verify.** If re-derivation is too expensive, do not skip and do not trust: relabel the claim as an assumption and carry it labeled.

For claims of backward, forward, mixed-version, upgrade, or rollback compatibility, use `skills/happier-compatibility`. Re-derive the claim against the exact released tag/artifact or applicable predecessor worktree basis, the real old/new component roles, and every claimed direction. A current-code fixture or mock that merely agrees with the current implementation is not independent compatibility evidence.

## Output

Each audited claim in one of three bins, with the evidence:

- **Confirmed** — how it was re-derived, via which independent path.
- **Refuted** — the contradicting observation. Lead the report with these; a refuted claim is the headline.
- **Assumption** — why it is unverifiable right now, and what would verify it.

## Failure this prevents

Confident propagation of a wrong premise: reasoning chains valid at every link and false in total because link one was hearsay.
