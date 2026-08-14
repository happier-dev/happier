/**
 * The canonical origin this site is served from, and the helpers that turn a
 * page URL into an absolute one.
 *
 * This exists because Next resolves every relative metadata URL against
 * `metadataBase`, and when `metadataBase` is unset it silently falls back to
 * `http://localhost:3000`. Nothing fails, nothing warns in production, and the
 * broken value is baked into every prerendered page's `og:image` at build time
 * — 225 social cards pointing at a machine that is not on the internet. One
 * constant, used by the root layout, the canonicals, the sitemap and robots.txt,
 * is the only way that stays fixed.
 *
 * `NEXT_PUBLIC_DOCS_URL` exists so a preview deployment can advertise itself
 * honestly instead of claiming to be production.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_DOCS_URL ?? 'https://docs.happier.dev').replace(
  /\/+$/,
  '',
);

export const SITE_NAME = 'Happier Docs';

export const SITE_DESCRIPTION =
  'Reference documentation for Happier — the open-source client that runs Claude Code, Codex, OpenCode and ten more coding agents from your phone, laptop or a server you own.';

/** `https://docs.happier.dev/features/inbox-and-approvals` from `/features/inbox-and-approvals`. */
export function absoluteUrl(pathname: string): string {
  return `${SITE_URL}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}
