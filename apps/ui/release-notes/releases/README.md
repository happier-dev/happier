# Release Sources

One JSON file per release, named `<releaseId>.json` (e.g. `v0.2.7.json`).

The schema is enforced by `apps/ui/sources/scripts/parseReleaseNotes.ts`; running
`yarn ota` will regenerate the bundled manifest and fail the build on any
authoring error (missing translation key, missing asset, malformed JSON).

Image cards should reference a bundled story-deck image with `localAssetKey`.
Video cards must reference the remote video asset with `key` and should reference
a bundled poster with `localPosterAssetKey` so the runtime can show a fallback
when video playback is disabled or unavailable.

See the parent `../README.md` for the authoring workflow.
