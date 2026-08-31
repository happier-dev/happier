---
name: handoff-report
description: Output contract for substantive deliverables — outcome first, evidence-pointed reasoning, observed/derived/assumed labels, residual risk last, failures never buried, and an optional evidence-backed retrospective for explicit requests or major program closeout. Use when reporting completed work, findings, diagnoses, reviews, lane results, or a requested retrospective.
---

# Handoff Report

Structure any substantive report so the reader can act on the first paragraph and audit the rest. Full doctrine: `docs/agent-craft.md` §5 and §7.

## Order

1. **Outcome first.** The first sentence answers what the reader would ask for if they said "just the TLDR": what happened, what was found, or what is blocked. Not the journey, not the setup.
2. **Failures and scope changes in the first block.** A failed check, a skipped step, a scope change, an error worked around — these go up front even when embarrassing, never mid-report. The most informative event is the one you are tempted to smooth over.
3. **Reasoning, auditable.** Evidence pointers with every load-bearing statement: `file.ts:line`, the log excerpt, the measurement, the command that produced the number. Trust should rest on checkable references, not on tone.
4. **Residual risk last, explicitly.** What remains unverified, what to check next, what would invalidate the conclusion. If there is genuinely no residual risk, say that — the reader cannot distinguish "no risk" from "risk section omitted".

## Labeling

- Every load-bearing statement is sortable by the reader into **observed** (ran it, read it, saw it) / **derived** (follows from observations by stated reasoning) / **assumed** (plausible, unverified) — without asking you.
- Use cheap explicit markers: "verified:", "inferred from X:", "assumption:". Never let sentence confidence do the labeling; fluent prose reads as fact regardless of bin.
- For derived claims, state the derivation ("X because A + B") so the reader can audit the step and see which assumptions it inherits.
- Hedging is not labeling. "Probably" makes every sentence equally gray; a label says exactly what is known and what is guessed.
- Distinguish "I didn't find X" (an observation about your search — say which search) from "X doesn't exist".

## Style

- Brevity comes from selecting what matters, not compressing the writing. Complete sentences, terms spelled out, no codenames or shorthand invented mid-task.
- Write for the teammate who stepped away and is catching up — they did not watch the process unfold.
- Report faithfully: if tests failed, say so with the output; if a step was skipped, say that; if something is done and verified, state it plainly without hedging.

## Optional retrospective for major programs

Add a compact retrospective only when the user requests one or an approved substantial program designates it. Do not make it a routine handoff artifact.

Capture only evidence-backed learning:

- decisions confirmed or changed and the evidence that changed them;
- assumptions disproved;
- patterns that worked and the conditions where they apply;
- process that consumed time without changing a decision;
- surprises and future triggers;
- a promotion recommendation: keep local, refine a skill, or propose repository doctrine.

One incident normally remains a local lesson. Promote it into a reusable skill or `AGENTS.md` only when it reflects a stable repository property, repeats across materially distinct work, or the user explicitly approves the rule. Do not collect model mix, turn counts, task counts, or other decorative metrics unless they change a future decision.

## Failure this prevents

The reader acting on a misread, and caveats surfacing after the decision they should have informed.
