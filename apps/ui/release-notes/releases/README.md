# Release Sources

One JSON file per release, named `<releaseId>.json` (e.g. `v0.2.7.json`).

The schema is enforced by `apps/ui/sources/scripts/parseReleaseNotes.ts`; running
`yarn ota` will regenerate the bundled manifest and fail the build on any
authoring error (missing translation key, missing asset, malformed JSON).

The release's public Markdown and bounded channel projection source live in the
matching `apps/ui/CHANGELOG.md` section, not in this StoryDeck JSON. Start that
section with the documented `happier-release-note-projections:v1` comment from
the parent README. This keeps every authored public release text variant with
the canonical changelog entry and lets the deterministic projector publish exact
approved strings without truncation or rewriting.

The StoryDeck JSON filename remains a runtime UI release ID (for example
`v0.2.7`). It is distinct from the unique project release ID in the changelog
heading (`## Release 2026-08-09.1 - <date>`), which selects the cross-component
release-note projection.

Image cards should reference a bundled story-deck image with `localAssetKey`.
Video cards must reference the remote video asset with `key` and should reference
a bundled poster with `localPosterAssetKey` so the runtime can show a fallback
when video playback is disabled or unavailable.

See the parent `../README.md` for the authoring workflow.
