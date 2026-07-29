---
name: decompose-gates
description: Decompose a hard or multi-part task into independently checkable pieces with explicit verification gates and risk-weighted ordering. Use when planning corridor-sized work, writing lane briefs for subagents or Codex, or whenever a task is too large to verify as a whole.
---

# Decompose With Gates

Turn a hard task into pieces that can each pass or fail on their own, ordered so the riskiest assumption is tested first. Full doctrine: `docs/agent-craft.md` §2–§3.

## Procedure

1. **Split along verification boundaries, not implementation convenience.** Each piece must have its own pass/fail check that does not depend on the other pieces being right. If checking B assumes A is correct, A+B is one piece, not two.
2. **State each piece as a falsifiable claim, not a task.** "The watermark advances only after server ack" (checkable) — not "update watermark logic" (a task). Attach to each claim the concrete check that decides it: a test slice, a log observation, a live replay, a measurement.
3. **Name the risk spots before sequencing.** Write the two or three "if I'm wrong anywhere, it's here" spots — silent failure modes, irreversible steps, boring mechanical stretches — and design a specific verification for each. Generic suite runs are uniform effort against non-uniform risk.
4. **Order by information yield.** Run first the piece whose failure invalidates the rest (e.g. "the event fires before layout"). A ten-minute check beats three days built on a false premise.
5. **Write down inter-piece assumptions.** What each piece assumes from the others is itself a piece to check; most integration failures live at those interfaces, not inside the pieces.
6. **Right-size.** A piece owns a whole responsibility end to end: analysis, change, tests, validation. Too small to fail meaningfully is overhead — micro-slicing (one-boolean extractions) provably grew the god-files it was meant to shrink. Too big to check independently is not decomposed yet.
7. **Prefer consumed verticals over horizontal spines.** The first implementation slice should connect a real entry point through its canonical owner to an observable outcome. Do not split protocol/schema/producer/consumer into weeks of dormant layers whose correctness can only be known after activation. When compatibility forces phases, each phase names its active reader/consumer and removal condition.
8. **Firewall live-path corrections.** If gated or dormant work exposes a live dispatch, lifecycle, persistence, migration, or startup defect, handle that correction as its own complete vertical at the live owner. Do not partially activate the dormant design to fix the production path.

For compatibility-sensitive work, use `skills/happier-compatibility` and decompose the transition into independently falsifiable prepare/read, activate/write, migrate/backfill, mixed-version or rollback, and contract/removal claims only where those phases are reachable. Every such claim names its exact released/predecessor baseline and old/new producer-consumer direction; do not create empty phases for an additive or internal-only change.

## When pieces become lane briefs

- Coordinate conceptual seams, overlapping edit hunks, generated outputs, and exclusive runtime resources; do not treat file dirtiness or a prior edit as ownership. Keep an advisory integration map for live seams/resources when useful. Lanes may layer compatible changes onto the same current file, but must not overwrite concurrent work or independently make incompatible decisions for the same seam.
- For cross-program work, name the seam authority and each lane's `Supersedes:`, `Extends:`, or `Consumes:` relationship. A dependent lane consumes a typed contract; it does not repair the owning seam from the wrong program.
- Every brief carries its gate (the falsifiable claim plus its check). Update durable state only when plan-gate readiness, dependency availability, blocker state, approved authority/contract, substantial review-boundary state, or the final verdict changes. Ordinary closed subchecks, landed fixes, RED/GREEN iterations, and lane-local validations belong in command output and the concise lane handoff.
- Hard gates are measured, not merely reported. Re-measure decision-material claims through their deciding test, source inspection, runtime observation, or artifact check; do not create decorative count gates.
- A lane brief plus the existing canonical plan/tracker and concise handoff must let a fresh agent continue without the lost transcript. Use a lane report only when an approved workspace already assigns one or durable/bulky evidence genuinely requires it; do not create a per-lane report or parallel ledger solely for restartability.
- Include exact paths/symbols, observed evidence, in-scope and out-of-scope surfaces, success criteria, required validation, expected output, and stop/fallback conditions. For compatibility lanes, include baseline tags/commits/artifacts and component roles.
- Schedule formal independent review at the fewest substantial integrated boundaries needed by the approved plan, plus explicit user-requested or high-risk triggers. Every lane performs a compact author self-attack without a separate workspace, report, or reviewer. Advisory review may inspect moving work; boundary/ship verdicts reconcile current decision-material paths. See root `AGENTS.md` → "Adversarial review and handoff".

## Output

A short plan listing: the pieces as claims, each with its deciding check; the named risk spots with their specific verifications; the ordering and why; the inter-piece assumptions.

## Failure this prevents

The monolithic change where something works but you cannot say which part, and something fails but you cannot say where.
