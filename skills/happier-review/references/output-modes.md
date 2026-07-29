# Output Modes And Finding Contract

Select one mode from the user's requested deliverable. Do not mix review-only and implementation authority.

## `report` — review only

Inspect, run safe checks/QA, triage, and report. Do not modify source, configuration, tests, or product documentation. Review workspace artifacts are allowed when tracking was requested or useful for a substantial review.

## `comment` — concise review output

Use the same read-only evidence and triage standard as `report`, but emit only high-confidence actionable PR-style comments, normally at most two sentences each. Keep detailed proof in the tracking/report workspace. Zero comments is correct when no qualifying issue exists.

## `staged` — report, then approval

Complete the same review as `report`, including claim, impact, proposed-response, and authority dispositions plus coherent proposed fix lanes. Stop for explicit approval before source changes. After approval, apply only the authorized lanes; stop again if new evidence materially changes an approved fix's ownership, scope, or risk.

## `fix` — review, fix, validate, re-review

Use only when the user explicitly requests implementation. Verify findings first, cluster them by originating failure/root cause/canonical owner/seam, and execute coherent clusters through `skills/happier-implement` rather than one patch per symptom. Preserve unrelated work, validate proportionately, rerun failed QA, and re-review the changed corridor until no accepted in-scope actionable finding remains.

## `qa` — behavior validation only

Exercise requested flows and investigate failures without source edits. Runtime actions remain within the user's authorized environment and resource rules. Recommend fixes with evidence; do not apply them.

## Finding gate and format

Only high-confidence, objective, actionable, decision-relevant issues become findings. Style preferences and generic best-practice suggestions do not.

```markdown
### <ID> — <severity>: <short title>
- Provenance: introduced | exposed | pre-existing-touched-corridor
- Location/surface:
- Observation (verified):
- Impact:
- Root cause (derived from):
- Canonical fix direction:
- Validation required:
- Confidence:
```

Use severity from realistic impact, reachability, exploitability, reversibility, and silence of failure—not category labels. Keep inline PR-style comments to roughly two sentences; put detailed proof in the evidence packet/tracking report.

Potential issues without enough evidence stay under `Suspected issues` only when resolving them could change the decision. Otherwise discard them. Record rejected proposed findings with the reason so they are not repeatedly rediscovered.

## Self-contained fix recommendations

Whether fixes are proposed for later or delegated now, group them by canonical owner/root cause and make each lane executable by a fresh agent. Include the exact evidence/finding IDs, current owner and relevant paths/symbols, in/out scope, ordered change strategy, duplicate/legacy paths to migrate or remove, TDD expectation, deciding focused and broader validation, risks, dependencies, and stop conditions. Do not prescribe speculative implementation detail that the evidence has not justified.

## Final report order

1. Outcome/verdict.
2. Failed, blocked, skipped, or decision-material checks requiring reconciliation, plus material scope changes.
3. High-confidence findings ordered by impact; say explicitly when there are none.
4. Accepted fixes and current status when applicable.
5. Target/change/corridor coverage, plan-completeness status, QA results, and evidence basis.
6. Rejected/dismissed findings when decision-relevant.
7. Unexamined or deferred surfaces and residual risk.
8. Exact next action and readiness for merge/release when asked.

Distinguish observed, derived, and assumed claims. “I did not find X” names the search basis; it does not claim universal absence.
