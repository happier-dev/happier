/**
 * Canonical identity for the documentation site.
 *
 * Everything that needs an absolute URL or the site's own name reads this, so
 * there is one place to change when the origin moves. This mirrors the guides
 * site's `src/lib/site.ts` deliberately — the two Next apps are siblings and
 * diverging on something this basic is how a preview build ends up publishing
 * production URLs.
 *
 * Why this file exists at all: without a `metadataBase`, Next resolves the
 * root-relative `openGraph.images` path against its own `http://localhost:3000`
 * fallback and bakes that into every prerendered page. Every share to Slack,
 * Discord, X or iMessage then renders a broken card.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://docs.happier.dev').replace(
  /\/+$/,
  '',
);

export const SITE_NAME = 'Happier Docs';

/**
 * Used as the site-wide `<meta name="description">` and the fallback share
 * description. It names agents on purpose: the single most common way people
 * arrive here is searching for one of them plus "from my phone".
 */
export const SITE_DESCRIPTION =
  'Documentation for Happier — run Claude Code, Codex, Cursor, OpenCode and ten more coding agents on your own machines, and drive them from your phone, a browser, or anywhere else.';

/** Join the site origin with a fumadocs page url (`/`, `/code/git`). */
export function absoluteUrl(pathname: string): string {
  if (!pathname || pathname === '/') return `${SITE_URL}/`;
  return `${SITE_URL}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}
