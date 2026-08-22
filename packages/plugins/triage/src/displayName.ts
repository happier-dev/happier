/**
 * Customer-facing name for the aggregate surface. `Triage` names the program,
 * never the product: manifest, page header and Settings all read `PRs & Issues`.
 *
 * It lives in its own leaf because both graphs need it. `manifest.ts` is the
 * one `definePlugin` owner and therefore imports the whole daemon activation
 * spine; the mounted React Native surfaces must never reach that spine, so they
 * read the product name from here instead of from the manifest module.
 */
export const TRIAGE_DISPLAY_NAME = 'PRs & Issues';
