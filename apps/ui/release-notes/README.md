# Release Notes (Story Cards)

Curated, slide-based release notes shown in the in-app **Story Deck** surface.
Distinct from `CHANGELOG.md`, which remains the long-form history view.

## Authoring a release

1. Create a JSON file under `releases/<releaseId>.json`. The release id should
   match the convention `v<semver>` (e.g. `v0.2.7`) — the runtime resolves the
   current release id from the installed app version.
2. Reference content via translation keys (e.g. `releaseNotes.v0_2_7.cards.0.title`).
   Add the keys to all 10 locale files under `apps/ui/sources/text/translations/`.
3. Image cards should reference a bundled story-deck image via `localAssetKey`.
   Register the asset in
   `sources/components/ui/storyDeck/storyDeckBundledAssetRegistry.ts` with a
   static `require(...)` so it ships with the app and works offline. You may also
   provide `key` as a remote fallback.
4. Video cards keep the video file remote via `key`, but should reference a
   bundled poster via `localPosterAssetKey`. You may also provide `posterKey` as
   a remote poster fallback.
5. Place remote video and fallback media files under `assets/<releaseId>/`.
   Release workflows upload those files to
   `happier-dev/happier-assets@release-notes`; bundled image/poster assets are
   not uploaded and are not included in the remote asset index.
6. Optionally provide `media.mobile` or `media.desktop` overrides when a card
   needs different artwork or video per surface. Base media remains the fallback;
   tablet and desktop widths use the `desktop` override, phone-width sheets use
   `mobile`.
7. Run `npx tsx sources/scripts/parseReleaseNotes.ts` to validate and regenerate
   `sources/changelog/releaseNotes/manifest.generated.json`.

## Card kinds

- `list`: title + icon rows. Icons must come from `storyDeckIconRegistry`.
  Lists with up to 6 rows render as a static Notelet-style card. Longer lists
  become vertically scrollable with edge fades and chevron hints; prefer splitting
  content into multiple cards when a list becomes dense.
- `image`: square bundled media + title + body. Prefer `localAssetKey`; keep
  optional `key` only when you want a remote fallback.
- `video`: square media (looped, muted) + title + body. Video `key` remains
  remote; prefer `localPosterAssetKey` for the poster. Unsupported playback,
  reduced-motion/data-friendly modes, or media failures fall back to the poster
  instead of blocking the story.

## Surface-specific media

Image and video card `media` can include optional `mobile` and `desktop`
overrides. Use this when a phone crop and a wide modal/tablet crop should be
different:

```json
{
  "kind": "image",
  "titleKey": "releaseNotes.v0_2_7.cards.hero.title",
  "bodyKey": "releaseNotes.v0_2_7.cards.hero.body",
  "media": {
    "localAssetKey": "v0_2_7.hero",
    "altKey": "releaseNotes.v0_2_7.cards.hero.alt",
    "desktop": {
      "localAssetKey": "v0_2_7.heroWide"
    }
  }
}
```

Overrides replace only the source group they provide. For example, a video
`desktop.key` keeps the base poster unless `desktop.posterKey`,
`desktop.posterUrl`, or `desktop.localPosterAssetKey` is also provided.

## Local preview

`scripts/release-notes/serve-local-assets.mjs` serves the `assets/` directory at
`http://127.0.0.1:4173`. Set
`EXPO_PUBLIC_HAPPIER_RELEASE_NOTES_LOCAL_ASSETS_BASE_URL=http://127.0.0.1:4173/`
in your local environment to preview without uploading to GitHub.

The local server accepts the same flat file names used in production:
`release-notes__<releaseId>__<path-with-__>`. This lets the app exercise the
asset index and URL resolver without publishing.

## Publication

Release pipelines build `dist/release-notes-assets/` with:

```bash
node scripts/pipeline/release/release-notes/build-release-notes-assets.mjs
```

The bundle contains:

- `release-notes__manifest.json`
- `release-notes__assets-index.json`
- `release-notes__<releaseId>__<logical-path>` media files

Publishing is a separate, explicitly scoped step:

```bash
node scripts/pipeline/release/release-notes/publish-release-notes-assets.mjs \
  --repo happier-dev/happier-assets \
  --tag release-notes
```

Use `--dry-run` locally. Do not upload release-note media to product app release
tags or `dist/release-assets/**`; the dedicated `happier-assets@release-notes`
tag is the publication contract.
