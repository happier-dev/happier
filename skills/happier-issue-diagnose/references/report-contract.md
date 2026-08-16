# Issue diagnosis report contract

`docs/agent-craft.md` and `skills/handoff-report` own voice, ordering, epistemic clarity, and handoff style. This reference protects issue-specific content from omission; it is not an outline or field list.

## Give the maintainer the answer

Open naturally with your judgment: what users experience, whether the report is valid, how firmly the cause is established, and the recommended response or next discriminator. Include the largest release, validation, or evidence caveat when it changes the action.

Do not lead with code paths, commits, internal status constants, capability names, or architecture vocabulary. Translate those facts into their consequence. Avoid separate `Problem`, `Status`, `Disposition`, `Can close?`, and `Decision needed` fields when one paragraph communicates the decision.

For several issues, organize by maintainer decision rather than issue count. Issues sharing one correction or release operation may share one explanation with issue-specific closure conditions. Different evidence requests, owners, product choices, or actions need separate briefs even when they share a code area.

## Tell the causal story

Explain the shortest auditable chain from the user's action through the relevant input or state, owning decision, failure or divergence, and visible outcome. Make observed, derived, and unverified claims distinguishable without automatically turning them into three sections.

Name the originating failure layer, canonical owner, affected corridor, and why the correction belongs there. Discuss competing logic only when it caused the failure or would remain a reachable bypass. State whether each material competing path should be removed, migrated, consolidated, or intentionally retained. Do not mistake an intentional bounded context or provenance-backed compatibility adapter for a split-brain.

If the cause is not established, say so and name the cheapest observation that would decide between the plausible owners. Do not design a complete fix for an unverified cause.

## Explain only the response that is justified

For a verified defect, cover the user-visible before and after, important unchanged failure or recovery behavior, the existing owner or logic to reuse, and why the response is the smallest coherent systemic correction. Name a tempting smaller workaround only when it would leave the failure or a competing path reachable. Say what broader machinery is unnecessary when that prevents overengineering.

Apply the deletion test internally to every proposed mechanism. Surface it only when it explains a design decision. Compare alternatives only when more than one is genuinely viable or a product choice remains open; do not manufacture an option matrix around an established owner-level correction. Distinguish mitigation from root correction when it affects the decision.

Let the disposition determine the emphasis:

- **Confirmed defect:** causal mechanism, owner-level correction, and deciding validation.
- **Needs evidence:** what is ruled in or out, the cheapest discriminator, and why implementation is premature.
- **Fixed in source but not shipped:** first proven corrected artifact or remaining release operation.
- **Release or artifact defect:** immutable provenance and the release authority, without private operational details.
- **Product choice:** the real options and a recommended default when justified.
- **Guidance, intended behavior, or no change:** the user-facing resolution and why code change is not justified.

## Keep evidence subordinate and end once

Include only evidence that proves or limits a load-bearing claim: deciding issue facts, source/tests, private diagnostic categories, reproduction results, and relevant artifact provenance. Name unavailable checks when they constrain confidence. Exact version vectors and commit tables belong after the explanation and only when they change status, compatibility, release, or closure.

End with one next maintainer action and what could still invalidate the conclusion. Collapse implementation approval, GitHub disposition, closure condition, and release action when they are the same decision. Ask for approval only when the next action requires it. Verify issue numbers, titles, links, and release claims before presenting.

Read [report-examples.md](report-examples.md) when the disposition is unfamiliar, the bundle contains more than one decision, or the draft is becoming form-like or repetitive.

## GitHub-facing summary

If the user later authorizes a public comment, derive a short sanitized summary of the user-visible behavior and version basis, verified or tentative cause, next action or missing information, and public provenance links. Never include private diagnostics, raw logs, credentials, machine identities, personal paths, or unsupported confidence scores.
