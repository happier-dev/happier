# Feature showcase art (source)

Full-resolution PNG source images for the alternating feature sections.

- **Name each file after the image basename referenced in `src/data/features.ts`**
  (the path basename — not the feature id). The current expected names are:
  `start-anywhere-continue-everywhere.png`, `existing-sessions.png`,
  `terminal.png`, `one-tap-away.png`, `connected-services.png`, `voice.png`.
  Features without an `image` block (subagents, queue, attention, mcp, accounts,
  customization, review, privacy) render the device mockup until you add art and
  wire an `image` entry in `features.ts`.
- Prefer PNG with the transparent/gradient background so the art composites
  over the page's ambient glows.
- These raws are **not** shipped. Run the optimizer to emit web assets:

```bash
npm run optimize:images   # from apps/website
```

That writes `<name>.png`, `<name>@2x.png`, `<name>.webp`, `<name>@2x.webp`
into `public/images/features/`. The renderer prefers `.webp`, falls back to
`.png`, and falls back again to the generic device mockup if the file is
absent — so it's always safe to add art incrementally.
