---
name: happier-release-notes
description: Validate and project canonical Happier release-note source, StoryDeck cards, translations, and media assets without making editorial or release-policy decisions.
---

# Happier Release Notes

This skill owns only source-coupled release-note mechanics: the canonical
changelog section schema, bounded-channel projection, StoryDeck cards,
translations, assets, and generation. It does not choose release scope, group
changes, write editorial prose, recommend patch/minor/major, approve content,
or dispatch a release.

For those decisions, start with the private maintainer release authority:

```bash
hmaint release bootstrap --repo <absolute checkout> --json
```

## Read first

1. Read `apps/ui/release-notes/README.md` and
   `apps/ui/release-notes/releases/README.md`.
2. Inspect `apps/ui/sources/changelog/releaseNotes/types.ts` and
   `apps/ui/sources/components/ui/storyDeck/storyDeckCardLimits.ts` before
   changing card data or limits.
3. If UI behavior changes, use the canonical UI testkit and TDD.

## Canonical changelog and bounded projections

`apps/ui/CHANGELOG.md` is the single authored authority for one release's
public Markdown and exact bounded channel text. Put this JSON comment at the
start of the matching `## Release <project-release-id> - <date>` section. The
project release ID is a unique lowercase identifier such as `2026-08-09.1`,
independent of every component version. Use the date plus an ordinal, increase
the ordinal for another release on that date, and keep the same ID from preview
through stable. The heading is the only authored source; a workflow
input only selects and verifies it:

```markdown
<!-- happier-release-note-projections:v1
{
  "expo": { "message": "Approved Expo text." },
  "appStore": { "whatsNew": "Approved App Store text." },
  "playStore": { "whatsNew": "Approved Play Store text." },
  "storyDeck": { "summary": "Approved StoryDeck text." }
}
-->

## Public heading

Approved public Markdown follows here.
```

The comment is removed from the GitHub/rolling Markdown projection. The script
publishes every bounded string exactly as authored—there is no truncation,
translation, synthesis, or AI rewrite. Expo is the currently consumed required
projection. App Store, Play Store, and StoryDeck projections are optional until
the selected release surfaces consume them; when present they are validated.
Limits are: Expo 1,024; App Store 4,000; Play 500; StoryDeck 280. The section
must contain meaningful public Markdown after the comment.

Project the release with its source identity and independently versioned
components:

```bash
node scripts/pipeline/release/release-notes/project-release-notes.mjs \
  --release-id <project-release-id> \
  --source-sha <40-lowercase-git-sha> \
  --component-version ui=<ui-semver> \
  --component-version cli=<cli-semver> \
  --component-version stack=<stack-semver> \
  --component-version server=<server-semver> \
  --component-version plugin_sdk=<lockstep-plugin-sdk-and-ui-semver> \
  --component-version sdk=<sdk-semver> \
  --changelog apps/ui/CHANGELOG.md
```

The v2 bundle records `{ id, sourceSha, components }`; it does not treat the UI
version as a project-wide release identity. Workflow callers must pass the
human-authored project ID, the release source SHA they already verified, and
every applicable component version, then validate the v2 bundle before use. The
`plugin_sdk` component is the one lockstep `@happier-dev/plugin-sdk` /
`@happier-dev/plugin-ui` release pair, so record its shared version once; do
not add a separate `plugin_ui` component.

## StoryDeck source and assets

1. Add or update `apps/ui/release-notes/releases/<releaseId>.json` only with
   already-approved card content.
2. Add each referenced translation key to every locale under
   `apps/ui/sources/text/translations/`.
3. Register image-card and video-poster local assets in
   `sources/components/ui/storyDeck/storyDeckBundledAssetRegistry.ts`.
4. Put remote video and optional fallback media in
   `apps/ui/release-notes/assets/<releaseId>/`.
5. Run from `apps/ui`:

```bash
yarn tsx sources/scripts/parseReleaseNotes.ts
```

6. Confirm only the generated release-note manifest/index outputs changed.

For remote assets, build and publish only through the canonical scripts:

```bash
node scripts/pipeline/release/release-notes/build-release-notes-assets.mjs
node scripts/pipeline/release/release-notes/publish-release-notes-assets.mjs --dry-run
```

Do not upload or modify a GitHub release unless separately authorized.

## Validation

```bash
node --test scripts/release/release_notes_projection.contract.test.mjs
cd apps/ui && yarn vitest run --config vitest.config.ts \
  sources/changelog/releaseNotes/schema.test.ts \
  sources/scripts/parseReleaseNotes.test.ts
```

These checks validate structure, source identity, selected bounded fields, and
asset/translation references. They must not judge editorial wording or release
selection.

Issue `stage:*` labels and issue comments are not release-note source. The owning release workflow reconciles availability after verification according to `docs/issue-triage.md`; keep editorial projection and issue lifecycle as separate consumers of the same proven release.
