# Issue diagnosis report contract

Write for the primary maintainer. Put the plain-language decision first and the engineering audit second. The maintainer should be able to understand the user problem, the proposed outcome, and the next decision from the first screen without knowing the affected symbols or architecture.

### Maintainer brief

For every issue, state:

- **User-facing problem:** what the user does, what happens, and what they expected instead.
- **After the recommended response:** the concrete behavior users and operators will observe after implementation, release, guidance, or the requested evidence step, including an important unchanged or failure behavior when material.
- **Status today:** confirmed current defect, fixed but not shipped, needs evidence, intended behavior, feature/product decision, or no change justified, in ordinary language.
- **Recommended next move:** one concrete action and its owner: implement, validate, release, request specific evidence, provide guidance, make a product decision, consolidate a duplicate, or take no action.
- **GitHub disposition:** keep open until a named condition, request information, close after proof, retain as a product request, or another explicit recommendation. This is a proposal, not authorization to mutate GitHub.
- **Decision needed:** one explicit maintainer approval or choice, or `none yet` when evidence must come first.

Keep this brief to one readable screen. Do not lead with code paths, commits, internal status constants, `PRIVATE_DIAGNOSTICS_UNAVAILABLE`, or terms such as canonical owner, split-brain, producer/consumer contract, or version vector. Translate uncertainty into how it changes the recommended action.

For a multi-issue bundle, give every issue its own row or brief. Do not hide materially different actions behind one bundle conclusion. State whether each issue can be closed now and why.

### Disposition and established facts

State the three disposition axes in compact prose:

- behavior evidence;
- version/release status with named basis;
- recommended response.

Then separate:

- **Observed:** directly present in issue data, logs, diagnostics, source, artifacts, or reproduction.
- **Derived:** follows from named observed facts and the verified code/contract path.
- **Unverified:** reporter claims, plausible causes, version assumptions, or missing evidence.

### Root cause and owner

When verified, name the originating failure layer, failure mechanism, canonical owner, affected corridor, and why the behavior belongs there. If not verified, say `INCONCLUSIVE` or `LIKELY_NOT_VERIFIED` and identify the cheapest missing discriminator. Do not substitute a nearby error or suspicious function for a root cause.

Describe competing logic accurately:

- identify a **causal split-brain** when multiple decisions directly produced the failure;
- identify an **adjacent split-brain or bypass** when it would remain a reachable competing owner after the proposed fix;
- distinguish intentional bounded contexts and provenance-pinned compatibility adapters that delegate to the canonical owner;
- say that no competing owner was found when that is the supported conclusion rather than inventing one.

For every competing path, say whether to remove, migrate, consolidate, or intentionally retain it and why.

### Recommended change and solution shape

Explain the concrete before-to-after system behavior:

- what happens today and what will happen after the change;
- affected users, surfaces, component roles, platforms, and relevant lifecycle or recovery paths;
- important behavior that deliberately remains unchanged;
- how failure and recovery will work after the change.

Then explain the solution in ownership terms:

- the existing logic or owner to reuse, extend, refine, extract, or consolidate;
- duplicate decisions, workarounds, or bypasses to remove or migrate;
- why the change belongs at this choke point rather than at a consumer;
- why this is the smallest coherent systemic fix, not merely the smallest diff;
- what apparently smaller response would leave the defect or a competing path reachable;
- what broader machinery or adjacent work is unnecessary.

Apply the deletion test to each material proposed mechanism such as new state, registry, adapter, fallback, gate, background job, compatibility path, or decision point. Name the required outcome it serves and what fails if the mechanism is removed. If the existing owner can satisfy the outcome more directly, recommend that instead. If no required outcome fails, omit the mechanism. For a simple correction or non-code response, state briefly that no new mechanism is justified rather than manufacturing ceremony.

When multiple resolutions are genuinely viable, compare them in plain terms. For each option, explain:

- the user-visible and system behavior it produces;
- its owner and which existing logic it reuses or replaces;
- benefits, tradeoffs, risks, and failure modes;
- compatibility, migration, release, validation, reversibility, and follow-up implications when material.

Give one clear recommendation and explain why its tradeoffs best satisfy the established requirement. Explicitly reject options that create another owner, preserve the root cause, rely on unsupported requirements, or fail the deletion test. Do not manufacture alternatives after evidence has established one correct response. If the choice depends on an unresolved product decision, state the decision and recommend a default when evidence supports one.

Separate a narrow mitigation from the root-cause correction and state what remains unresolved if only the mitigation is chosen.

### Version and release basis

Name the reported, source, loaded, fix, and released-artifact bases that were actually established. Explicitly distinguish fixed-in-source from shipped.

### Evidence and validation

List only deciding issue fields, source/tests, private diagnostic categories, reproduction recipe/result, and artifact/release evidence. Redact sensitive data and state any checks that could not run. Keep supporting detail subordinate to the maintainer decision.

### Approval boundary and residual risk

End with the single recommended next action, not generic approval boilerplate. When action requires approval, ask for that exact implementation, GitHub preview, release operation, or product choice. When evidence must come first, state that no implementation approval is justified yet. End with what could still invalidate the conclusion.

Before presenting, verify that every issue number, title, and link belongs to the current bundle; every issue has a next action and GitHub disposition; excluded issues are not cited accidentally; and fixed-in-source is not described as released.

## GitHub-facing summary

If the user later authorizes a public comment, derive a short sanitized summary covering user-visible behavior and version basis, the verified or explicitly tentative cause, the next action or precise missing information, and public links to commits, releases, PRs, or canonical issues.

Never include private diagnostics, raw logs, credentials, machine identities, personal paths, or unsupported confidence scores.
