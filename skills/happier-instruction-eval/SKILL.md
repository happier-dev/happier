---
name: happier-instruction-eval
description: Evaluate two or more Happier instruction, constitution, or skill variants with blinded organic tasks, controlled context, behavior-based scoring, privacy-safe evidence, and an advisory synthesis. Use only when the user explicitly asks to compare/evaluate instruction variants or an approved instruction program names an evaluation boundary.
---

# Happier Instruction Evaluation

Evaluate whether instruction wording changes agent behavior without telling the agents they are being evaluated. This workflow is advisory: it produces evidence for a human decision and never edits the canonical instruction owner by itself.

## 1. Establish the decision

Name:

- the instruction owner and variants being compared, including the current baseline;
- the concrete behavior the change is meant to improve or failure it is meant to prevent;
- one organic task or a small risk-selected set of tasks that can expose that difference;
- a rubric of observable outcomes fixed before any run;
- the user decision the evidence will inform.

Do not evaluate prose elegance in isolation. A useful task forces the instruction to affect routing, investigation, ownership, implementation shape, validation, stopping, or reporting. Skip evaluation when a source inspection or deterministic check can decide the question directly.

## 2. Control the comparison

Hold constant everything except the instruction variant when practical:

- use the same task prompt, repository basis, allowed tools, permissions, time/effort budget, and available evidence;
- give each run only the ordinary context an agent would receive for that task;
- label variants and output locations neutrally so neither runner nor judge sees “baseline,” “preferred,” model identity, or another run's existence;
- isolate writes in separate temporary directories or authorized worktrees; never switch, clean, reset, stash, or overwrite the primary shared checkout;
- prevent external mutations, destructive actions, secrets, and sensitive-data access unless the user separately authorizes that exact evaluation surface.

Do not freeze or package a release representation. Temporary instruction variants and isolated outputs are test inputs, not release artifacts.

## 3. Keep runners blind

Each runner receives an organic-looking engineering request, not an evaluation brief. Do not mention the rubric, competing variants, expected lesson, or favored outcome. Do not ask the runner whether it followed the instruction.

Use minimal inherited conversation context. Never expose private transcripts, credentials, customer data, or unrelated work. Prefer synthetic tasks, public evidence, or bounded repository tasks. Historical conversations require explicit sensitive-data authorization and sanitization.

If an assigned tool or model differs between runs, record that as a confound rather than treating model agreement or disagreement as proof. Use repeated trials only when outcome variability is decision-material; never manufacture a fixed sample count.

## 4. Measure behavior, not self-report

Inspect what each run actually did:

- sources and instruction owners read;
- questions asked versus empirical facts investigated;
- canonical owner and affected corridor identified;
- split-brains, unsupported requirements, or scope drift introduced or prevented;
- edits and artifacts produced;
- tests, live checks, and falsifiers actually run;
- unsafe, irrelevant, or ceremonial work avoided;
- final claims, uncertainty labels, and residual risk.

Score each rubric item from the artifacts and tool evidence. A polished explanation or claimed compliance is not evidence. Mark unavailable observations and confounds explicitly.

## 5. Judge under neutral labels

Give one judge all outputs under neutral labels and the same precommitted rubric. The judge must:

1. score each outcome criterion independently;
2. cite the behavior or artifact supporting each score;
3. identify regressions, omissions, confounds, and ties;
4. recommend retain, revise, combine, reject, or run one discriminating follow-up;
5. avoid inferring variant identity, author intent, or model quality.

The orchestrator re-derives decision-material claims from the underlying artifacts. Agreement between runners, judge, and orchestrator raises a question's priority; it does not replace evidence.

## 6. Synthesize without automatic mutation

Report:

- decision and tested behavior;
- task and controlled basis;
- anonymized rubric results with evidence pointers;
- confounds and unobserved surfaces;
- which wording or structural change earned its place and why;
- the smallest recommended canonical-owner edit, or that no change is justified.

Use the final response unless the user requested durable evaluation tracking. Do not create a new report file, update `AGENTS.md`, or propagate a variant to another repository or release line without explicit change authority and the owning compatibility workflow.
