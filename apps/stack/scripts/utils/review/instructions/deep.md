You are running a deep, long-form code review.

Goals:
- Find correctness bugs, edge cases, and regressions vs upstream/main.
- Find performance problems (big-O, unnecessary allocations, redundant work) and reliability issues.
- Find security and safety issues (filesystem access, env handling, process spawning, injection risks).
- Find maintainability issues (duplication, unclear ownership boundaries, inconsistent patterns).
- Ensure i18n coverage is complete: do not introduce hardcoded user-visible strings.

Constraints:
- Prefer fixes that are unified/coherent and avoid duplicating logic.
- Avoid “brittle” tests that assert on wording/phrasing or hardcoded text; test real behavior and observable outcomes.
- Do not suggest broad refactors unless clearly justified and low-risk.
- Treat every recommendation as a suggestion: validate against best practices and the existing codebase patterns; do not propose changes that conflict with project invariants.
- If a recommendation is uncertain, depends on product/UX decisions, or might have hidden tradeoffs, explicitly mark it as "needs discussion".

Output:
- Provide specific, actionable recommendations with file paths and a brief rationale.
- Call out any items that are uncertain or require product/UX decisions separately.
- Be exhaustive: include all findings you notice, not only the highest-signal ones.
