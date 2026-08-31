---
name: attack-conclusion
description: Adversarial self-review of your own conclusion, fix, or root-cause verdict before handoff — alternative causes, neighboring cases, blast radius, environment gap, hypothesis lock, subtraction, and a scan for fake-competence patterns. Use as a compact author check before non-trivial handoff and as a structured attack at substantial review or ship boundaries; pair with autoreview only when the selected boundary calls for it.
---

# Attack Your Conclusion

Before handing over a conclusion, switch roles completely: you are no longer the author defending it, you are the reviewer paid to break it, with the same energy spent building it. Full doctrine: `docs/agent-craft.md` §6 and §8.

The test of whether you actually switched roles: did you go looking for evidence that would change your mind, or only re-inspect the evidence that formed the conclusion?

## The standard attacks — in order of cheapness, each as a runnable check

1. **Alternative cause or falsifier.** Ask what else could explain the same evidence. When the evidence supports a materially different candidate, name it and run the cheapest discriminating observation; when the mechanism is directly established, do not manufacture a second hypothesis—identify and run the cheapest observation that could falsify the conclusion instead.
2. **Neighboring cases.** The fix works for the reproduced case. Run the case next door: the empty list, the second invocation, the other platform, the resumed session, the concurrent caller.
3. **Blast radius.** What consumes what you changed? Search callers, readers, subscribers, tests, serialized forms. "Nothing else uses this" is a claim — re-derive it, don't assert it.
4. **Environment gap.** Does the conclusion survive where the code actually runs, or only in the harness? Host tests encode the same assumptions the author had. For user-visible behavior, use the risk-appropriate browser/device gate in `.agents/skills/happier-testing`.
5. **Hypothesis lock.** Are you explaining the evidence, or explaining your first hypothesis? Re-read the raw evidence pretending you just arrived and have no favorite.

Run the cheap attacks; an attack that is just worry is not an attack. If you cannot state what would falsify the conclusion, it is not a conclusion yet — it is a preference.

## Architecture-impact attack

Apply root **Scope-preserving solution economy** during this attack: preserve the complete feature outcome, challenge unsupported implementation machinery rather than the feature itself, and try folding behavior into the canonical owner before accepting a split-brain or parallel path.

Run this only when the change establishes or moves an owner, crosses package boundaries, introduces persistence or concurrency, materially changes a public interface, or performs a substantial refactor. Skip it for routine local and mechanical work.

Build a compact complexity ledger from the diff and affected callers:

- **Added:** domain concepts, interfaces or seams, dependencies, configuration, persisted state, modes or branches, failure paths, and facts callers must know.
- **Removed:** duplicate decisions, special cases, invalid states, compatibility paths, direct bypasses, lockstep edits, and operational failure modes.

Then test whether the change improves total system locality, leverage, and code health. Added structure is justified when observed domain variation, lifecycle, ownership, or invariants require it and the result removes greater distributed complexity. A large coherent diff can pass this attack; a small local patch can fail it. Report the evidence, not a line-count verdict.

Run a **subtraction attack** on every material new mechanism, dependency, mode, configuration value, wrapper, fallback, abstraction, or parallel path: try removing it while preserving the complete authorized contract. If the behavior already holds, the canonical owner can enforce it more directly, or a standard/platform/existing package facility satisfies every affected surface with lower lifetime cost, the addition is unsupported complexity. Compare concepts, ownership, caller knowledge, invalid states, and failure paths—not lines, files, or tests; this is an in-place lens, not a new lane, report, or gate.

For a changed domain concept, run a **split-brain attack**: search the touched corridor for another active owner, decision, registry, parser/normalizer, reader/writer, bypass, or similar-but-different implementation. Search by the defect's mechanism, not only its name — the fix you just wrote is the search key, and every sibling caller, instance, and platform build of that concept is either fixed or explicitly exempt in writing. A pre-existing same-concept split-brain is a finding, not grandfathered debt. Verify that any remaining compatibility adapter only translates a historical shape and delegates decisions to the canonical owner.

For compatibility-sensitive changes, run a **provenance attack** using `.agents/skills/happier-compatibility`: re-derive each retained path from an exact released artifact/tag or applicable predecessor worktree basis, check every claimed reachable old/new direction, and identify shims or tests that preserve only an undeployed intermediary. Reject speculative matrices and fallbacks that are not tied to a reachable seam.

## Fake-competence scan

Check the deliverable against the patterns that read as skill and aren't (`docs/agent-craft.md` §8). The highest-frequency ones:

- **Thoroughness theater** — exhaustive coverage of what was easy to check, presented as coverage of the risk. Where are the "if I'm wrong, it's here" spots in the report?
- **Green tests as proof** — green means "didn't break what we previously thought to check", not "correct". A test you have never seen fail proves nothing; break the behavior and watch it go red.
- **Defensive over-engineering** — fallbacks for impossible states are unexamined uncertainty made permanent, and future split-brains.
- **Silent recovery** — an error worked around and not mentioned discards the most informative event of the session.
- **Uniform hedging** — everything marked uncertain so nothing can be wrong; commit where the evidence commits.

## Self-check and independent review boundary

Schedule adversarial review with the work at the boundary defined by root `AGENTS.md` and `.agents/skills/happier-review`:

- The author runs this compact self-attack in place before every non-trivial handoff and when a hypothesis changes. It creates no separate reviewer, workspace, report, approval gate, or durable status update; mention only changes it caused and unresolved risk in the normal handoff.
- Formal independent review is normally batched at the fewest substantial integrated boundaries needed by the approved plan, plus explicit user-requested reviews and high-risk schema/data/security/user-visible/release triggers—not every lane, commit, gate, or microchange.
- The reviewer is different from the author at those gates. Its brief is to refute: attempt the failure the author says cannot happen and re-measure rather than re-read.
- Advisory review may inspect moving work. Before a boundary or ship verdict, reconcile only decision-material observations affected by concurrent changes. After accepted fixes, review the finding delta and affected corridor; repeat a full independent attack only when the approved contract, architecture, scope, boundary, or risk materially changed.

## Output

For a formal independent review, record each material attack, what was run, and what it showed or why it was skipped. For routine author self-check, keep the record compact and include only landed changes, failed/skipped decision-material checks, and residual risk in the normal handoff. Any attack that landed goes to the top of the handoff (see `.agents/skills/handoff-report`), not the bottom.

## Failure this prevents

Motivated reasoning shipping with a green checkmark on it — the review conducted by the same mind that made the mistake, finding nothing.
