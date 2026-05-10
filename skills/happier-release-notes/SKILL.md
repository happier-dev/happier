---
name: happier-release-notes
description: Author, update, validate, and publish-ready Happier release-note story decks. Use when creating curated release notes, analyzing commits/diffs/tags to discover user-facing changes, brainstorming detailed and short release notes, adding story-deck cards, adding release-note images/videos/posters, validating translation keys and asset references, preparing happier-assets upload inputs, or updating onboarding showcase story content.
---

# Happier Release Notes

## Mission

Create curated, explicit story-deck content for Happier releases with offline-safe lightweight visuals. Bundle image-card artwork and video posters in the app when practical; keep heavy video files and optional remote fallbacks in `happier-dev/happier-assets`.

## Read First

1. Re-read repo `AGENTS.md`.
2. Read `apps/ui/release-notes/README.md`.
3. Read `apps/ui/release-notes/releases/README.md`.
4. Inspect the current card contract in `apps/ui/sources/changelog/releaseNotes/types.ts` and schema limits in `storyDeckCardLimits.ts`.
5. If editing UI behavior, follow TDD and use the canonical UI testkit.

## Author A Release

Use this path only after the user has approved the release-note content or has provided final content explicitly.

1. Determine the runtime release id. Current convention: `v<Constants.expoConfig.version>`, for example `v0.2.7`.
2. Create `apps/ui/release-notes/releases/<releaseId>.json`.
3. For image cards and video posters, prefer bundled assets: add the file under an app source asset folder and register it in `apps/ui/sources/components/ui/storyDeck/storyDeckBundledAssetRegistry.ts`.
4. For heavy videos and optional remote fallbacks, add media under `apps/ui/release-notes/assets/<releaseId>/`.
5. Add every translation key to all files in `apps/ui/sources/text/translations/`.
6. Run from `apps/ui`:

```bash
yarn tsx sources/scripts/parseReleaseNotes.ts
```

7. Confirm generated files changed only under `apps/ui/sources/changelog/releaseNotes/manifest.generated.json` and `asset-index.generated.json`.

## Analyze A Release From Git

Use this path when the user asks to create/propose release notes from commits, tags, a branch diff, or a specific comparison range.

### Determine The Range

Prefer an explicit user-provided range. If absent, infer the previous release tag conservatively and state the assumption before proposing content.

Useful commands:

```bash
git --no-pager tag --sort=-creatordate
git --no-pager log --oneline --decorate <from>..<to>
git --no-pager log --format='%H%x09%s' <from>..<to>
git --no-pager diff --stat <from>..<to>
git --no-pager diff --name-status <from>..<to>
```

For component tags, inspect the tag naming already present in the repo (`cli-v*`, `ui-v*`, `v*`, etc.) and match the component the user requested.

### Inspect Commit Contents, Not Just Messages

Commit messages are only the index. For every candidate user-facing cluster, inspect the actual changes:

```bash
git --no-pager show --stat --name-status <commit>
git --no-pager show --format=fuller --find-renames <commit> -- <relevant-paths>
git --no-pager diff <from>..<to> -- <relevant-paths>
```

Prioritize reading:
- changed app screens/components under `apps/ui/sources/app/**` and `apps/ui/sources/components/**`
- protocol feature/catalog changes under `packages/protocol/**`
- CLI user-facing commands, installer, doctor, daemon, and provider flows under `apps/cli/**`
- server API, feature gates, sync, notifications, and storage changes under `apps/server/**`
- tests that describe user-visible behavior
- docs/changelog entries only as corroborating context

If a commit is ambiguous, inspect neighboring commits in the same cluster, touched tests, changed feature flags, and runtime wiring. Do not surface an item until you can explain what changed for a user/operator and why it matters.

### Cluster And Filter

Cluster by user-facing outcome, not by commit count. Good clusters look like:
- a new product capability
- a visible UI/UX improvement
- a CLI command or workflow improvement
- a reliability fix that users would recognize
- a platform-specific support improvement
- a provider/model capability users can choose

Exclude or down-rank:
- pure refactors with no user-facing behavior
- internal test-only changes
- mechanical migrations
- dependency bumps unless they unlock visible capability or fix a user-visible bug
- duplicate commits that belong to a larger feature cluster

### Proposal Output

Before writing release JSON, propose content for discussion:

1. Detailed release notes in markdown:
   - `New Features`
   - `Improvements`
   - `Bug Fixes`
   - platform/provider-specific sections when useful
   - concise but concrete bullets based on inspected diffs
2. Short release-note StoryDeck proposal:
   - 3-6 high-impact cards by default
   - recommended card order
   - proposed `list`, `image`, and `video` cards
   - suggested row titles/body copy
   - suggested screenshots, diagrams, or videos to capture
   - any asset filenames to create under `apps/ui/release-notes/assets/<releaseId>/`
3. Confidence notes:
   - assumptions about the git range/tag
   - ambiguous items that need user confirmation
   - items intentionally excluded from prominent cards

Ask the user to approve or revise the proposed detailed notes and StoryDeck before baking them into files. Do not create or overwrite authored release JSON from commit analysis without user approval, unless the user explicitly asked for direct implementation.

## Brainstorm With User-Provided Content

When the user provides rough notes instead of asking for Git analysis:

1. Normalize the notes into user-facing outcomes.
2. Ask clarifying questions only when a missing decision materially changes the output.
3. Propose detailed markdown release notes and a short StoryDeck candidate.
4. Recommend which items deserve images/videos and which should stay in detailed notes only.
5. Bake the approved version into release-note files.


## Detailed Markdown Style

Match this shape when proposing detailed release notes from Git analysis. This is the quality bar, not a rigid copy template.

```markdown
## New Features

### Source Control — Pull Requests, Branches & Remote Operations

Source control is now interactive inside Happier sessions. Create pull requests, manage branches, push to remotes, and review changed files without switching to another tool.

- Pull-request open-or-reuse action available on SCM surfaces; Happier checks for an existing PR before creating a new one
- Repository publish controls let users push a branch to a remote or create a new remote repository directly from the session
- Selected changed-files review mode in the diff viewer helps focus on just the files that matter in large changesets

### Adaptive New Session Wizard

Starting a session is now more context-aware, with model favorites, per-section defaults, and server-aware preflight.

- The wizard reads account and server-scoped settings to pre-fill model, workspace path, and backend target
- Favorites-first model grouping is available across picker surfaces
- Backend targets are preserved across wizard steps

## Improvements

### Desktop Shell Refinements

The desktop app gets a more polished shell with safer layout around notched displays and clearer update status placement.

- Chrome-safe-area insets keep controls out of the menu-bar notch area
- App update status is relocated into the sidebar shell so it no longer takes up space in the main session area

## Bug Fixes

**Claude sessions resumed from an assistant UUID instead of a user turn** — Resume logic now starts from the last user turn, avoiding immediate provider errors when a transcript ended on an assistant message.

**Windows `HAPPIER_HOME_DIR` paths rejected by config** — Windows-shaped home paths are now accepted throughout CLI and UI path handling.
```

Detailed notes rules:
- Use `##` for top-level groups and `###` for feature/improvement clusters.
- Each cluster starts with one user-outcome paragraph in plain language.
- Bullets are concrete and evidence-backed; avoid vague words like "improved", "various", or "better" unless followed by specifics.
- Keep implementation details only when they explain visible behavior, compatibility, reliability, or operator value.
- Bug fixes should usually be bold one-liners: `**Problem users saw** — Fix and outcome.`
- Prefer product language over internal folder/package names.
- Group platform/provider-specific items when it helps scanning: `Windows Support Improvements`, `Codex`, `Voice`, `MCP`.
- Do not promote every cluster into StoryDeck cards; detailed notes can be comprehensive, StoryDeck must be curated.

## StoryDeck Extraction From Detailed Notes

After drafting detailed notes, propose a short deck from only the highest-impact outcomes:

1. First card: broad release headline with 3-5 flagship outcomes.
2. Middle cards: one visual card per feature that benefits from a screenshot/video.
3. Optional list card: grouped quality-of-life improvements.
4. Last card: concise wrap-up with `View full release notes` available.

For each proposed card include:
- card kind (`list`, `image`, or `video`)
- title/body draft
- list rows if any
- asset suggestion (`screenshot`, `short demo video`, `diagram`, or `none`)
- why this belongs in the short deck instead of only the detailed notes


## Wording Examples To Emulate

Use this tone: product-led, concrete, user-facing, and confident. These examples capture the desired style.

Feature intro examples:
- `Happier ships a live ambient companion — Pets — that sits in your macOS menu-bar tray and on mobile, showing real-time activity at a glance.`
- `A new compact session chrome designed for monitoring long-running agent tasks from your phone without the full compose UI in the way.`
- `Agents that generate images, diagrams, or other file artifacts now have a first-class pipeline from generation to your screen.`
- `Source control is now interactive inside Happier sessions. Create pull requests, manage branches, push to remotes, and review changed files without switching tools.`
- `The transcript renderer has been rebuilt with a streaming markdown pipeline, richer formatting, and smooth live updates.`
- `Starting a session is now a context-aware flow with model favorites, per-section defaults, and server-aware preflight.`
- `Voice sessions now run on the latest real-time SDK with improved stability and lower connection latency.`
- `Happier on Windows is faster to start, handles more installation edge cases, and correctly resolves Windows-specific paths throughout.`

Feature bullet examples:
- `Full companion UI with animated desktop overlay and shared activity tray wired across desktop and native mobile.`
- `Generated media is ingested by the agent runtime, transferred via the chunked relay, and rendered inline in the session transcript.`
- `Pull-request open-or-reuse action checks for an existing PR on the branch before creating a new one.`
- `Model selection popover shows favorites first across picker surfaces.`
- `Chrome-safe-area insets keep sidebar controls from underlapping the menu bar on notched Macs.`
- `Packaged binary is preferred over Node.js for session startup on Windows, reducing cold-start latency.`

Bug-fix examples:
- `**Subagent completion triggered a spurious ready notification** — Subagent completions are now excluded from the ready-notification path.`
- `**Claude sessions resumed from an assistant UUID instead of a user turn** — Resume logic now starts from the last user turn.`
- `**Terminal connections dropped across server switches** — Terminal connections now survive active-server changes.`
- `**New-session pickers opened outside their modal scope** — Pickers are now scoped to the modal boundary so they no longer appear behind overlays.`
- `**Windows scheduled task state read incorrectly** — State is now read from the correct field so running tasks no longer appear stopped.`

Wording rules:
- Start feature sections with what the user can now do or what the app now feels like.
- Prefer `now` for direct capability changes: `Sessions now...`, `The wizard now...`, `Happier now...`.
- Prefer active verbs: `ships`, `shows`, `renders`, `preserves`, `survives`, `checks`, `syncs`, `stabilizes`.
- Avoid raw implementation phrasing as the headline. Convert `wired protocol field X` into `users can now choose Y` when possible.
- Use implementation details inside bullets only when they explain reliability, compatibility, or why the change matters.
- Keep bug fixes problem-first: name the visible failure, then the outcome.

## Card Guidance

Use `list`, `image`, and `video` cards in a deliberate sequence. Prefer a list card first, then media cards for the most visual changes, then another short list only if needed.

List cards:
- Use 3-5 rows for the best Notelet-style feel.
- Up to 6 rows render statically.
- More than 6 rows render in a vertical scroll region with edge fades and chevron hints.
- Do not cram dense changelog prose into one list card; split into multiple cards when the story would read better.

Image cards:
- Use square-friendly images.
- Provide an `altKey`.
- Prefer `media.localAssetKey` for offline-safe bundled artwork.
- Add `media.key` only when a remote fallback is useful.
- Prefer `.webp` for screenshots and illustrations.

Video cards:
- Keep `media.key` as the remote video file.
- Prefer `media.localPosterAssetKey` for the bundled poster image.
- Add `media.posterKey` only when a remote poster fallback is useful.
- Keep videos short, silent/muted by default, and optimized.
- Video plays only while the card is active and falls back to poster under reduced motion or load failure.

## Example Release JSON

```json
{
    "releaseId": "v0.2.7",
    "versionLabel": "v0.2.7",
    "publishedAt": "2026-05-09T00:00:00.000Z",
    "titleKey": "releaseNotes.v0_2_7.title",
    "subtitleKey": "releaseNotes.v0_2_7.subtitle",
    "cards": [
        {
            "kind": "list",
            "titleKey": "releaseNotes.v0_2_7.cards.overview.title",
            "rows": [
                {
                    "iconId": "sparkles",
                    "titleKey": "releaseNotes.v0_2_7.cards.overview.rows.one.title",
                    "bodyKey": "releaseNotes.v0_2_7.cards.overview.rows.one.body"
                }
            ]
        },
        {
            "kind": "image",
            "titleKey": "releaseNotes.v0_2_7.cards.hero.title",
            "bodyKey": "releaseNotes.v0_2_7.cards.hero.body",
            "media": {
                "localAssetKey": "v0_2_7.hero",
                "key": "hero-fallback.webp",
                "altKey": "releaseNotes.v0_2_7.cards.hero.alt"
            }
        },
        {
            "kind": "video",
            "titleKey": "releaseNotes.v0_2_7.cards.demo.title",
            "bodyKey": "releaseNotes.v0_2_7.cards.demo.body",
            "media": {
                "key": "demo.mp4",
                "localPosterAssetKey": "v0_2_7.demoPoster",
                "posterKey": "demo-poster-fallback.webp",
                "accessibilityLabelKey": "releaseNotes.v0_2_7.cards.demo.accessibilityLabel"
            }
        }
    ],
    "actions": {
        "viewFullReleaseNotes": true
    }
}
```

## Validation

Run targeted validation after authoring:

```bash
cd apps/ui
yarn tsx sources/scripts/parseReleaseNotes.ts
yarn vitest run --config vitest.config.ts sources/changelog/releaseNotes/schema.test.ts sources/scripts/parseReleaseNotes.test.ts
```

For UI behavior changes, also run the relevant story-deck tests and `yarn typecheck`.

## Publishing Boundary

Do not upload release-note assets or modify GitHub releases unless the user explicitly asks for that external side effect. The normal release pipeline uploads assets to `happier-dev/happier-assets` under the rolling `release-notes` tag.

## Onboarding Showcase

For first-open onboarding story content, edit `apps/ui/sources/onboarding/showcase/manifest.ts` and the same translation files. It uses the same StoryDeck card model, but ships bundled with the app instead of coming from per-release JSON.
