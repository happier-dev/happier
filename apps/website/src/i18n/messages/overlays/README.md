# Locale overlays for `src/data/*.ts`

One file per locale, named for the locale code: `zh-Hans.json`, `es.json`, …

```json
{
  "usageLimits.USAGE_LIMITS_SCOPE.0": "…",
  "agents.AGENTS.claude.lead.0": "…"
}
```

The keys are the ids in [`../../generated/en.json`](../../generated/en.json), which
`yarn i18n:extract` regenerates on every build. An id that is not in this file
renders in English — that is the designed behaviour, not a gap, and it is why a
locale can be shipped one page at a time.

Three things that will bite otherwise:

- **An id that no longer exists is silently ignored.** Re-run `yarn i18n:extract`
  after re-wording English and diff `en.json` to find what moved.
- **The tokens in `../../generated/dnt.json` must survive byte-identical.**
  Those are inline code spans, `happier <subcommand>` invocations, paths and
  shell one-liners — 101 of the 754 strings carry one. A translator that
  localises `happier attach <session-id>` produces a command that does not run.
- **A locale file alone changes nothing on the site.** A page appears in a
  language only when its route lists that locale in `Route.locales`
  (`src/routes.tsx`), which is also what emits the hreflang and the sitemap row.
  Translating first and declaring second is the intended order.

Route titles and descriptions are **not** here. They cannot be translated into
their character caps — the English is authored at 143–155 against a 155 ceiling —
so they are re-authored per locale in `Route.i18n` instead.
