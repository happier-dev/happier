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

## Page shape

One skeleton. Not every page needs every part, but a page that skips a part should skip it deliberately, and the parts it keeps should appear in this order:

1. **A lede naming the reader's outcome.** What they will be able to do when they finish. Not what the page contains — the frontmatter `description` already renders as a subtitle, so "This page explains…" is the third time they have been told what they are looking at.
2. **Availability**, when the behaviour is gated. See below.
3. **What you need first.** Prerequisites, stated once, at the top, where they can still save someone.
4. **The normal path.** The thing almost everyone is here for, unbranched.
5. **Limits and platform differences.** Kept next to the claim they qualify, not collected in a footnote.
6. **When it goes wrong.** The predictable failures with their exact fixes.
7. **Where to go next.** Under a `## Related` heading — that exact wording, so the site stops carrying three names for one thing.

The reason to have a skeleton at all is that a reader who has read one page should already know how to read the next one. A site of bespoke documents makes every page a fresh navigation problem.

## Product truth and release status

- Verify Happier behavior against reachable implementing code and the page's target release/channel. Existing docs, README files, changelogs, plans, PR descriptions, comments, and search results are orientation, not sufficient proof.
- Finding a symbol or string does not prove a feature is active. Trace how it is produced, gated, consumed, and exposed.
- Use present-tense availability only for the release/channel the page actually describes. Distinguish stable, preview, development-only, experimental, deprecated, planned, and merely possible behavior.
- Vendor behavior comes from current official vendor documentation and retains attribution. Do not assert a competitor's limitation in Happier's voice.
- Never invent product names, capabilities, support levels, dates, guarantees, quotes, or personal experience.
- Avoid superlatives and comparative claims unless current primary evidence proves them.

## What you must never hand-maintain

Some documentation is a restatement of structured data that already exists in this repository. Retyping it as prose is how it goes wrong: the data changes, the prose does not, and nothing connects the two.

These pages are generated. Do not hand-edit the output — change the generator or the data behind it:

- the agent capability matrix, from `packages/agents/src/manifest.ts`;
- the feature-flag reference, from `packages/protocol/src/features/catalog.ts`;
- the environment-variable reference, from the server's env parsers;
- the CLI command reference, from `apps/cli/src/cli/commandSurfaceManifest.ts`;
- the keyboard-shortcut reference, from the client's command registry.

Before adding a table of ids, flags, defaults, commands, models or capabilities to a hand-written page, check whether the same list exists in code. If it does, generate it or link to the generated page. A table a human maintains by hand is a table that will be wrong within a release.

## Availability

Roughly a sixth of what these docs describe is gated — behind a server feature flag, an experimental toggle, the account-level Experiments switch, a platform, or a release channel. A page that describes a gated capability without saying so is not incomplete; it is wrong, because the reader follows it and nothing happens.

State the gate where the reader meets the feature, not in a footnote. Name the specific thing they must turn on, using the label the app actually renders. Where a toggle is only visible once a parent switch is on, say that too — an instruction pointing at a control that is not on screen reads as a broken product.

Availability comes from the registry, not from memory. Check `apps/ui/sources/sync/domains/features/registry/uiFeatureRegistry.ts` and `packages/protocol/src/features/catalog.ts` before asserting that anything is simply "available".

## Voice

Write like a thoughtful builder helping another developer:

- warm, direct, specific, and technically honest;
- polished without sounding corporate or promotional;
- concrete about actors, actions, limits, and consequences;
- enthusiastic only where the facts earn it;
- candid about rough edges and unsupported cases.

Lead with the reader's outcome, then explain enough mechanism to make the behavior trustworthy. For an unfamiliar or substantial system, establish a small mental model before cataloguing settings or edge cases. Keep limitations, security boundaries, platform differences, and readiness close to the claim they qualify.

Use headings that name the subject in words readers recognize. Avoid slogans, generic announcement hooks, promotional fog, artificial urgency, definition by negation, and headings that only frame rather than describe. Treat these as prompts for editorial judgment, not mechanical grammar bans.

## Vocabulary

Consistent naming is most of what makes documentation feel maintained. The canonical terms, each verified against a shipped surface:

- **Agent** — an executable coding CLI Happier runs: Claude Code, Codex, Cursor, OpenCode, Gemini, Copilot, Qwen, Kimi, Auggie, Kilo, Kiro, Pi, Grok. This is the concept noun in prose.
- **AI backend** — the UI's label for the same thing. Use it only when naming a control: "the **Select AI Backend** step", "**Settings → AI & Agents → AI backends**".
- **provider** — reserved for model, identity, voice and SCM providers. Never bare, never for an executable agent. This distinction is not pedantry: first-class model providers are coming, and the word will be needed for them.
- **engine** — avoid, except when quoting the two settings that use it.
- **relay** — the sync service. Lowercase as a common noun; capitalised only inside a quoted UI label and in **Happier Cloud**, a real product name.
- **server** — the server process, `apps/server`, deployment topics, and identifiers that cannot change (`HAPPIER_SERVER_URL`, `happier server`). Say once per section that relay and server name the same thing.
- **daemon** — the running background process, managed by `happier daemon`.
- **service** — the OS autostart registration, managed by `happier service`. Do not introduce "background service" as a third name.
- **machine** — a computer that runs sessions. **device** — a client someone signs in on.

Titles are sentence case. No parenthetical qualifier unless it disambiguates two real things. Protocol and product names keep their own casing: ACP, MCP, mTLS, OIDC, GitHub, hstack, Tauri, Happier Cloud.

A vocabulary migration is a coordinated pass, not an opportunistic one. Half-migrated naming reads worse than consistently old naming, and the docs must not get ahead of the app — every instruction that names a real control has to match what is on screen today.

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

## Links, components, and what the build enforces

**Links are root-absolute and prefix-free**: `/features/permissions`. Not `./permissions`, not `../features/permissions`, not `/docs/features/permissions`. Relative links silently 404 from any section landing page — the page lives at `/features` with no trailing slash, so `./git` resolves to `/git` — and the `/docs` prefix costs a permanent redirect on every click. Never use a URL or a slug as link text.

**Use the components.** `fumadocs-ui` ships `Callout`, `Steps`, `Tabs`, `Accordion`, `Files` and `TypeTable`, and they are registered in `src/mdx-components.tsx`. A warning written as a bold sentence inside a bullet list is indistinguishable from the facts around it. Per-OS instructions belong in a `Tabs` group, not stacked as consecutive code blocks. Reach for a table when the reader is comparing things and prose when they are learning something.

**Two checks run before every build** (`scripts/checkContent.mjs`, wired into `scripts/build.mjs`, tested in `scripts/checkContent.test.mjs`):

- Every internal link resolves to a real page, and every `#fragment` to a real heading on it. Non-canonical link forms fail.
- Every `Settings → …` path names strings the app actually renders, checked against `apps/ui/sources/text/translations/en.ts`.

The second exists because sixteen pages spent months sending readers to a menu item that had been renamed after one day. If you write a navigation path, mark it up as a UI label so the check can see it. If the path belongs to another product — a GitHub console, an IdP — name that product on the same line; the check skips those deliberately, because it cannot adjudicate a UI this repository does not own.

Run them directly with `yarn --cwd apps/docs check:content`.
