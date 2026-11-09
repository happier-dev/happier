---
name: attack-conclusion
description: One self-simplification pass over your own change, conclusion, or root-cause verdict before handoff — callers and machinery first (which owner already decides this, what can be deleted, net mechanism delta, flow shape, instant revocation, plugin self-protection), then one-sentence outcome/invariant/fix with every hunk traced to it, "would I still build this?", split-brain and provenance checks, falsifiers (alternative cause, hypothesis lock, environment gap, one neighbouring case, blast radius), tests that name their failure, and a fake-competence scan. Use as the compact author pass before non-trivial handoff and as the structured attack at substantial review or ship boundaries; pair with autoreview only when the selected boundary calls for it.
---

# Attack Your Conclusion — the self-simplification pass

Before handing over a change or a conclusion, switch roles completely: you are no longer the author defending it, you are the reviewer paid to break it and to shrink it, with the same energy spent building it. Full doctrine: `docs/agent-craft.md` §6 and §8. This one pass, in this order, is the author self-review that `happier-implement` and `happier-review` point to.

The test of whether you actually switched roles: did you go looking for evidence that would change your mind, or only re-inspect the evidence that formed the conclusion?

## 1. Callers and machinery (always first)


Over-building is the more frequent failure, so run these next, for every change (rules: root `AGENTS.md` "Choose good compromises"):

1. **Which owner already decides this?** For each check, state, code, retry, cache, timer or guard you added, find the existing owner of that fact. If one exists, use its result and delete yours; a second place deciding the same fact is the defect.
2. **What can I delete?** Name what the change makes obsolete (old guards, fallbacks, codes, states, copies of a check in other processes) and remove it in the same change. Delete-test every guard found during QA before narrowing it: does admission already cover it? Before deleting or skipping a check, list every fact it computes besides yes or no (selected identity, custody, ceiling, scope, target) and name where each one comes from afterwards. Skipping a repeated authorization must not skip a fact selected there (2026-11-05: an "already admitted" skip also skipped requester identity selection, so a Use member's SCM ran as the Machine owner; an earlier "replays are duplicates" subtraction did the same to live CLI decisions).
3. **Net mechanism delta.** Count, from the diff rather than from memory, checks, states, error codes, timers, retries and files as `+added / −removed`. Each addition carries its one line: harm prevented, how it is reachable, evidence, owner. The delta goes in the handoff and names the machinery that disappeared, not only what was added.
4. **Does each touched flow keep its shape?** Run its shape-contract count tests (`.agents/skills/happier-performance/references/flow-budgets.md`) where they exist. A count that now multiplies with layers, hops, retries or per-step re-checks is a finding. There are no numeric targets.
5. **Did you build instant revocation?** Withdrawal takes effect at the next natural boundary. Mid-operation re-checks and kill-on-revoke belong only to open-ended interactive access (a live terminal, an open stream).
6. **Did you protect against a plugin, or the user against themselves?** Plugins are trusted, unsandboxed code. The protections that stay are against other people, secrets out of transcripts and logs, and E2EE toward the server.

## 2. One sentence each; every hunk traced

Write the outcome, the invariant that must hold afterwards, and the fix, one sentence each. Trace every hunk of the diff to one of them. A hunk that serves none is deleted; a hunk that serves a worry rather than the invariant moves to residual risk.

## 3. Would I still build this?

Apply root **Scope-preserving solution economy**: preserve the complete feature outcome, challenge unsupported implementation machinery rather than the feature itself, and fold behavior into the canonical owner before accepting a split-brain or parallel path.

For every material new mechanism, dependency, mode, configuration value, wrapper, fallback, abstraction, or parallel path, ask: knowing what I know now, would I still introduce it? Try removing it while preserving the complete authorized contract. If the behavior already holds, the canonical owner can enforce it more directly, or a standard/platform/existing package facility satisfies every affected surface with lower lifetime cost, the addition is unsupported complexity and goes.

When the change establishes or moves an owner, crosses package boundaries, introduces persistence or concurrency, materially changes a public interface, or performs a substantial refactor, compare what it adds (domain concepts, interfaces or seams, dependencies, configuration, persisted state, modes or branches, failure paths, facts callers must know) with what it removes (duplicate decisions, special cases, invalid states, compatibility paths, direct bypasses, lockstep edits, operational failure modes). Added structure is justified when observed domain variation, lifecycle, ownership, or invariants require it and the result removes greater distributed complexity. Test whether the change improves total system locality, leverage, and code health; a large coherent diff can pass this attack, a small local patch can fail it, and you report the evidence, not a line-count verdict. Compare concepts, ownership, caller knowledge, invalid states, and failure paths—not lines, files, or tests. Skip this comparison for routine local and mechanical work; it is an in-place lens, not a new lane, report, or gate.

## 4. Split-brain and provenance

For a changed domain concept, search the touched corridor for another active owner, decision, registry, parser/normalizer, reader/writer, bypass, or similar-but-different implementation. A pre-existing same-concept split-brain is a finding, not grandfathered debt. Verify that any remaining compatibility adapter only translates a historical shape and delegates decisions to the canonical owner.

For compatibility-sensitive changes, use `.agents/skills/happier-compatibility`: re-derive each retained path from an exact released artifact/tag or applicable predecessor worktree basis, check every claimed reachable old/new direction, and identify shims or tests that preserve only an undeployed intermediary. Reject speculative matrices and fallbacks that are not tied to a reachable seam.

## 5. Falsify the conclusion — cheapest first, each as a runnable check

1. **Alternative cause or falsifier.** Ask what else could explain the same evidence. When the evidence supports a materially different candidate, name it and run the cheapest discriminating observation; when the mechanism is directly established, do not manufacture a second hypothesis—identify and run the cheapest observation that could falsify the conclusion instead.
2. **Hypothesis lock.** Are you explaining the evidence, or explaining your first hypothesis? Re-read the raw evidence pretending you just arrived and have no favorite.
3. **Blast radius.** Beyond the callers traced in §1: readers, subscribers, tests, serialized forms. "Nothing else uses this" is a claim — re-derive it, don't assert it.
4. **One neighbouring case.** The fix works for the reproduced case. Run the case next door: the empty list, the second invocation, the other platform, the resumed session, the concurrent caller. A neighbouring case that fails is fixed at the owner the cases share, not with a guard per case.
5. **Environment gap.** Does the conclusion survive where the code actually runs, or only in the harness? Host tests encode the same assumptions the author had. For user-visible behavior, use the risk-appropriate browser/device gate in `.agents/skills/happier-testing`.

Run the cheap attacks; an attack that is just worry is not an attack. If you cannot state what would falsify the conclusion, it is not a conclusion yet — it is a preference.

An attack never adds code by itself. A gap you reproduce, or a concrete reachable scenario, becomes a fix at its owner. A gap you only imagine ("a race might", "in case it is revoked") goes into residual risk as a note.

## 6. Each test names its failure

For each test the change adds or relies on as evidence, name the plausible wrong implementation it catches (`happier-testing`'s two-edit check). A test that would pass both the fix and that wrong version is not evidence.

## Fake-competence scan

Check the deliverable against the patterns that read as skill and aren't (`docs/agent-craft.md` §8). The highest-frequency ones:

- **Thoroughness theater** — exhaustive coverage of what was easy to check, presented as coverage of the risk. Where are the "if I'm wrong, it's here" spots in the report?
- **Green tests as proof** — green means "didn’t break what we previously thought to check", not "correct". Check that the regression assertion has applicable meaningful RED evidence; use the testing skill’s sensitivity check when it does not, rather than repeating every prior mutation.
- **Defensive over-engineering** — fallbacks for impossible states are unexamined uncertainty made permanent, and future split-brains.
- **Silent recovery** — an error worked around and not mentioned discards the most informative event of the session.
- **Uniform hedging** — everything marked uncertain so nothing can be wrong; commit where the evidence commits.

## Self-check and independent review boundary

Schedule adversarial review with the work at the boundary defined by root `AGENTS.md` and `.agents/skills/happier-review`:

- The author runs this compact pass in place before every non-trivial handoff and when a hypothesis changes. It creates no separate reviewer, workspace, report, approval gate, or durable status update; mention only changes it caused and unresolved risk in the normal handoff.
- Formal independent review is normally batched at the fewest substantial integrated boundaries needed by the approved plan, plus explicit user-requested reviews and high-risk schema/data/security/user-visible/release triggers—not every lane, commit, gate, or microchange.
- The reviewer is different from the author at those gates. Its brief is to refute: independently exercise the decision-material high-risk claims, inspect applicable primary evidence for the rest, and follow root validation-reuse rules rather than automatically repeating all suites.
- Advisory review may inspect moving work. Before a boundary or ship verdict, reconcile only decision-material observations affected by concurrent changes. After accepted fixes, review the finding delta and affected corridor; repeat a full independent attack only when the approved contract, architecture, scope, boundary, or risk materially changed.

## Output

For a formal independent review, record each material attack, what was run, and what it showed or why it was skipped. For routine author self-check, keep the record compact and include only landed changes, the net mechanism delta, failed/skipped decision-material checks, and residual risk in the normal handoff. Any attack that landed goes to the top of the handoff (see `.agents/skills/handoff-report`), not the bottom.

## Failure this prevents

Motivated reasoning shipping with a green checkmark on it — the review conducted by the same mind that made the mistake, finding nothing — and machinery shipping because nobody asked whether it was still needed.
