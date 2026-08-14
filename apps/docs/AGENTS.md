# Happier Published Documentation Instructions

Package-specific instructions for `apps/docs`. These supplement the root constitution and apply to the published Fumadocs site, its content, navigation, and presentation.

## Ownership and audience

- `content/docs/**` owns published documentation for users, operators, self-hosters, provider users, and public contributors.
- `src/**`, `source.config.ts`, and package scripts own the documentation application, navigation, search, rendering, and content pipeline.
- Internal implementation and product-architecture documentation belongs in `../../docs/**`. Update both surfaces when both the internal contract and published behavior changed.
- Search for the existing canonical page before adding one. Extend, correct, move, or consolidate it rather than creating a similar-but-different explanation.

Classify the page before editing:

- **Task guide:** help a reader complete one real workflow.
- **Concept page:** teach the mental model, constraints, and tradeoffs.
- **Reference page:** state exact commands, settings, states, and contracts.
- **Troubleshooting page:** connect observed symptoms to evidence-backed recovery.
- **Development page:** explain public contributor workflows and repository mechanics.

Do not force every page into the same structure or voice.

## Product truth and release status

- Verify Happier behavior against reachable implementing code and the page's target release/channel. Existing docs, README files, changelogs, plans, PR descriptions, comments, and search results are orientation, not sufficient proof.
- Finding a symbol or string does not prove a feature is active. Trace how it is produced, gated, consumed, and exposed.
- Use present-tense availability only for the release/channel the page actually describes. Distinguish stable, preview, development-only, experimental, deprecated, planned, and merely possible behavior.
- Vendor behavior comes from current official vendor documentation and retains attribution. Do not assert a competitor's limitation in Happier's voice.
- Never invent product names, capabilities, support levels, dates, guarantees, quotes, or personal experience.
- Avoid superlatives and comparative claims unless current primary evidence proves them.

## Voice

Write like a thoughtful builder helping another developer:

- warm, direct, specific, and technically honest;
- polished without sounding corporate or promotional;
- concrete about actors, actions, limits, and consequences;
- enthusiastic only where the facts earn it;
- candid about rough edges and unsupported cases.

Lead with the reader's outcome, then explain enough mechanism to make the behavior trustworthy. For an unfamiliar or substantial system, establish a small mental model before cataloguing settings or edge cases. Keep limitations, security boundaries, platform differences, and readiness close to the claim they qualify.

Use headings that name the subject in words readers recognize. Avoid slogans, generic announcement hooks, promotional fog, artificial urgency, definition by negation, and headings that only frame rather than describe. Treat these as prompts for editorial judgment, not mechanical grammar bans.

## Editing discipline

Choose the narrowest edit that satisfies the task:

- **Patch:** correct or add a bounded fact while preserving unaffected text.
- **Polish:** improve clarity and rhythm without changing structure, factual scope, or recognizable voice.
- **Rewrite:** reconsider the document only when explicitly requested or when its current structure cannot serve the reader.

A refinement pass does not earn value by touching more prose. Preserve good explanations, examples, commands, links, caveats, and voice even when you would personally phrase them differently. A correction is a new claim and requires the same verification as the text it replaces; do not replace one unsupported absolute with its opposite.

Humanizing is not summarizing. Preserve exact commands, settings, flags, environment variables, UI labels, platform/provider distinctions, compatibility, fallback and recovery behavior, privacy/security boundaries, failure modes, release requirements, and other detail readers need to succeed.

Published product pages avoid repository paths and implementation trivia unless the page is explicitly contributor-facing. Do not expose secrets, tokens, private URLs, internal-only evidence, or sensitive information in prose, examples, logs, or screenshots.

## Documentation application and validation

- Use yarn and the package scripts; do not substitute npm or pnpm commands in repository instructions.
- Run `yarn --cwd apps/docs types:check` after content-schema, MDX, TypeScript, or generated-content changes.
- Run `yarn --cwd apps/docs build` when routing, navigation, generation, rendering, or the production build can be affected.
- Check every materially changed command and internal link through the narrowest reliable path.
- Use a small number of current, non-sensitive screenshots only when they materially improve a UI-heavy workflow.
- Changes to the documentation site's own UI, navigation, accessibility, responsive behavior, or meaningful loading/error states are user-facing web changes. Read `../../DESIGN.md` when the experience is materially affected and apply the relevant live-validation rules.

Use `skills/happier-docs` for the complete evidence, editing, validation, and handoff workflow.
