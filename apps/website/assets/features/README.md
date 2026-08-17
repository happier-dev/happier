# Feature showcase art (source)

Full-resolution PNG source images for the feature panels.

- **Name each file after the image basename referenced in `src/data/features.ts`**
  (the path basename — not the feature id). The current expected names are:
  `anywhere.png`, `existing-sessions.png`, `terminal.png`, `one-tap-away.png`,
  `review.png`, `voice.png`, `mcp.png`, `sail-past-limits.png`,
  `subscriptions.png`.
  Features without an `image` block (subagents, queue, attention, customization,
  privacy) render as text-only panels until you add art and wire an `image`
  entry in `features.ts`.
- **Use a transparent background, cropped to the app UI itself.** The panel
  supplies the backdrop (a blended crop of the planet photograph) and the shadow
  (`--fp-art-shadow`). Art carrying its own baked plate reads as a sticker pasted
  onto the panel — the exact problem this generation of art replaced.
- Art is top-anchored and deliberately cropped by the panel's bottom edge, so
  keep the subject in the upper portion of the frame.
- These raws are **not** shipped (`assets/features/*.png` is gitignored). Run the
  optimizer to emit web assets:

```bash
npm run optimize:images   # from apps/website
```

That writes `<name>.png`, `<name>@2x.png`, `<name>.webp`, `<name>@2x.webp`
into `public/images/features/`, preserving alpha. The renderer prefers `.webp`,
falls back to `.png`, and falls back again to the generic device mockup if the
file is absent — so it's always safe to add art incrementally.

`_superseded/` holds the previous generation of baked-plate raws, kept only so
that art could be regenerated if ever needed. The optimizer ignores it.
