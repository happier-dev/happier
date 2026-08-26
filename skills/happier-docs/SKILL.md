---
name: happier-docs
description: Create, update, reorganize, or review Happier internal technical documentation and published user/operator/contributor docs with evidence-backed product truth, exact release status, canonical-page ownership, human voice, minimal editing, and appropriate validation. Use whenever a change affects `docs/**`, `apps/docs/**`, or behavior that may make existing Happier documentation incomplete or false.
---

# Happier Documentation

Keep documentation truthful, useful, current, and owned without turning every code change into prose churn. Follow the root constitution and, for published docs, `apps/docs/AGENTS.md`. For an explicit deep review or QA request, use `skills/happier-review` as the orchestrator and apply this skill as the documentation-domain standard; this skill does not create a competing general review workflow.

## 1. Classify the documentation impact

For the changed behavior or contract, decide whether it affects:

- internal technical/product architecture under `docs/**`;
- published user/operator/self-hoster/contributor behavior under `apps/docs/content/docs/**`;
- both surfaces;
- neither surface, with a concrete reason.

A refactor that leaves every documented contract unchanged may need no docs edit. A behavior, command, setting, support status, workflow, failure/recovery path, protocol, persistence shape, compatibility rule, deployment requirement, or canonical owner change normally does.

## 2. Identify audience, page type, and canonical owner

Classify published pages as task guide, concept, reference, troubleshooting, or development documentation. Internal docs explain architecture, contracts, ownership, and contributor-facing implementation constraints.

Search by the feature, command, setting, route, schema, provider/agent id, UI label, error, and reader phrasing before creating a page. Update, move, consolidate, or retire the canonical page instead of adding a parallel explanation. Map links, navigation, related pages, examples, and translations or screenshots that depend on the changed documentation contract.

Placement is part of authorship, not cleanup afterwards. A published page belongs to exactly one section, is listed in that section's `meta.json` at the point a reader should meet it, and is linked from that section's `index.mdx`. A page missing from either is unreachable in a way that breaks no link and shows up in no diff. Moving a page is the same four edits in reverse. The section inventory is in `apps/docs/AGENTS.md`.

## 3. Establish product truth and release basis

Documentation is a claim, not proof. For Happier behavior:

- inspect the reachable implementing producer and consumer, not only a matching string;
- identify gates, defaults, platform/provider variation, failure/recovery behavior, and compatibility seams material to the claim;
- establish the page's target stable, preview, development, or explicitly future basis from immutable release/artifact evidence when availability is release-sensitive;
- distinguish shipped, preview, development-only, experimental, deprecated, planned, and merely possible behavior.

README files, existing docs, changelogs, plans, issues, PR descriptions, commit messages, comments, and generated summaries are orientation. They do not independently prove that behavior is reachable or released.

For vendor-owned behavior, use current official vendor documentation and keep attribution with the claim. Do not state a competitor's limitation as Happier's own conclusion. Never invent product names, capabilities, support levels, guarantees, dates, quotes, or personal experience. Cut unsupported superlatives and comparisons.

Use `skills/happier-compatibility` when documentation claims depend on released/predecessor formats, mixed versions, upgrades, rollback, migrations, or persisted historical data.

## 4. Choose the edit contract

Use the narrowest mode that serves the reader. Every added section or sentence must improve a decision, action, mental model, evidence boundary, or material caveat; prose that only restates another canonical owner does not earn its place:

- **Patch:** add or correct bounded material and preserve every unaffected claim, example, link, caveat, and structural choice.
- **Polish:** improve clarity and flow while preserving structure, information density, factual scope, and recognizable voice.
- **Rewrite:** redesign structure or framing only when explicitly requested or when the current document cannot serve its audience.

An approved or preferred version becomes the baseline for later edits. A high change count in a correction pass is a warning sign, not evidence of quality. Every correction is a new claim: verify it as carefully as the text it replaces and do not swap one unsupported absolute for its opposite.

Before a substantial rewrite, inventory every material claim involving behavior, commands, settings, support, platforms, providers, compatibility, security, failure/recovery, readiness, and exact names. Account for each in the result. Humanizing is not summarizing.

## 5. Prefer generating over writing

Before drafting a reference table, check whether the same list already exists as structured data. Agent capabilities, feature flags, keyboard shortcuts, rate limits, download links and — where the plugin platform is present — runtime events, bundled plugins and the SDK's public surface all do. `apps/docs/scripts/generateReference.mjs` is the registry of what is generated today. Hand-maintained restatements of code are the single largest source of documentation drift in this repository, because nothing connects the data changing to the prose describing it.

Generate it, or link to the generated page. A generated page is compared against a fresh render on every build, so drift fails instead of shipping. Reserve hand-written prose for what a generator cannot produce: the mental model, the reason the mechanism exists, the failure modes, the judgement calls.

Two traps live inside the generators themselves. A hand-kept map of display names inside a generator drifts exactly like one inside a page — read the names from the source the app reads. And a declared field is not behaviour until you have found its consumer: publishing a flag whose value contradicts what the product does is worse than publishing nothing.

Where a capability is gated — a server feature flag, an experimental toggle, the account-level Experiments switch, a platform, a channel — the gate is part of the claim. Read `uiFeatureRegistry.ts` and `features/catalog.ts` rather than assuming availability, and state the gate where the reader meets the feature.

## 6. Draft for meaning and human voice

Write like a thoughtful builder helping another developer: warm, direct, concrete, and technically honest.

- Start with the reader's intent or outcome, not the implementation or a promotional hook.
- For a substantial unfamiliar system, establish the mental model, normal path, important limits, and why the mechanism matters before cataloguing controls.
- Lead with the user consequence, then include enough implementation detail to make the behavior trustworthy.
- Keep commands, exact product terms, security boundaries, platform/provider differences, fallbacks, recovery, and readiness close to the claims they qualify.
- Use topic headings that remain meaningful without the body and contain words readers recognize.
- Follow the page skeleton in `apps/docs/AGENTS.md` — outcome lede, availability, prerequisites, the normal path, limits, failure modes, `## Related`. A reader who has read one page should already know how to read the next.
- Use the vocabulary in `apps/docs/AGENTS.md`: agents are Agents, `provider` is reserved for model/identity/voice/SCM providers, and a quoted UI label must match what the app renders today.
- Avoid promotional fog, artificial urgency, generic importance, invented slogans, repetitive field-label bullets, and definition primarily by negation.
- Preserve warmth, useful detail, and natural rhythm. Treat anti-slop patterns as diagnostic signals, not forbidden grammar.
- Keep repository paths and implementation trivia out of user/operator prose unless the page is explicitly development-facing.
- Never expose secrets, tokens, private URLs, internal-only evidence, or sensitive screenshots.

## 7. Validate the documentation contract

Run the narrowest checks that can falsify the edit:

- inspect materially changed commands, links, examples, settings, defaults, and support statements;
- run `yarn --cwd apps/docs check:content` — it resolves every internal link and `#fragment`, verifies that each documented `Settings → …` path names strings the app renders, and enforces the structural rules a reader feels but no compiler sees: every page listed in a `meta.json`, every section hub linking the pages beneath it, no cross-reference written as an unclickable code span, and no code-derived list drifting from its source. It runs inside the build, so these fail rather than ship; `apps/docs/AGENTS.md` lists what each check rejects;
- run `yarn --cwd apps/docs test` for the guardrails themselves;
- run `yarn --cwd apps/docs types:check` for published MDX/schema/TypeScript/generated-content changes;
- run `yarn --cwd apps/docs build` when routing, navigation, generation, rendering, or production build behavior can be affected;
- use current non-sensitive screenshots only when they materially improve a UI-heavy workflow;
- for substantial published UI instructions, use the risk-appropriate live product check when runnable and authorized.

Do not add wording-policing tests. Validate parsing, generation, routing, links, commands, and factual behavior rather than exact prose.

When you find a class of breakage that no check can see — not one broken page, but a shape of defect that could recur silently — add the check rather than only fixing the instances. Every check in `checkContent.mjs` exists because its defect shipped and then stayed shipped. Give the new check a hard failure when its own input goes missing from inside this package: a check that skips on a missing directory is indistinguishable from a check that passes, and will read green through the next rename.

## 8. Handoff

Report:

- canonical pages created, updated, moved, consolidated, or intentionally left unchanged;
- audience/page type and target release/channel basis;
- implementing evidence for decision-material claims;
- materially affected surfaces and related pages checked;
- validation actually run and anything unavailable;
- remaining stale, uncertain, or intentionally deferred documentation and the next action.
