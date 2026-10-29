---
name: verify-claims
description: Audit a report, plan, or handoff by re-deriving every load-bearing claim from primary sources. Use before trusting subagent/lane reports, before building decisions on unverified claims, or when reviewing a conclusion written earlier (including your own). Distinct from running the app to verify behavior or reviewing a diff — this audits claims.
---

# Verify Claims

Take a report — a subagent's, a lane's, a plan's, or your own from earlier — and re-derive its load-bearing claims instead of trusting how they sound. Full doctrine: `docs/agent-craft.md` §4.

## Procedure

1. **Extract the load-bearing claims** — those whose falseness would change the decision being made. Ignore decoration; auditing everything dilutes the audit.
2. **Re-derive each from a primary source.** Source hierarchy: running code > tests > docs > comments > memory. Each step down the ladder is a step toward hearsay.
3. **Give an independent verifier the evidence and the question, not the diagnosis.** A verifier handed the proposed cause tends to confirm it; name the symptom, the primary sources and what would falsify each candidate.
4. **Use a different path than the claim arrived by.** Claim from reading code → check with a runtime observation. Claim from a test → read the code the test exercises. Two derivations sharing a path share that path's blind spot.
5. **Verify decision-material measurements against primary evidence.** Recompute derived counts from raw records. For test, coverage, and timing claims, inspect the actual command/workload, terminal output, and relevant source/environment basis; a summary or inherited counter is insufficient. Match a named commit/artifact exactly; for dirty work, inspect the relevant current paths and account for concurrent changes. Apply root **Validation** to reuse versus re-execution: rerun when evidence is missing, stale, contradictory, cannot establish the claimed result, or independent risk-selected verification requires it. A new handoff alone does not require repeating every successful suite. Decorative counts should be removed.
6. **Treat plausibility as zero evidence.** Narrative fit is what generated the claim, so "sounds right" is correlated with exactly the error being hunted. Check the best-fitting claims first, not last.
7. **Downgrade what you cannot verify.** If re-derivation is too expensive, do not skip and do not trust: relabel the claim as an assumption and carry it labeled.

For claims of backward, forward, mixed-version, upgrade, or rollback compatibility, use `.agents/skills/happier-compatibility`. Re-derive the claim against the exact released tag/artifact or applicable predecessor worktree basis, the real old/new component roles, and every claimed direction. A current-code fixture or mock that merely agrees with the current implementation is not independent compatibility evidence.

## Output

Each audited claim in one of three bins, with the evidence:

- **Confirmed** — how it was re-derived, via which independent path.
- **Refuted** — the contradicting observation. Lead the report with these; a refuted claim is the headline.
- **Assumption** — why it is unverifiable right now, and what would verify it.

## Failure this prevents

Confident propagation of a wrong premise: reasoning chains valid at every link and false in total because link one was hearsay.
