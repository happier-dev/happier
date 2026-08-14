import type { MetadataRoute } from 'next';

import { contentLastModified } from '@/lib/content-last-modified';
import { absoluteUrl } from '@/lib/site';
import { source } from '@/lib/source';

/**
 * `docs.happier.dev/sitemap.xml` was a hard 404 before this file existed. 225
 * pages of reference material, no machine-readable index of any of it.
 *
 * ON `priority`
 * -------------
 * Google has said publicly that it ignores `<priority>`. It is emitted anyway,
 * for two reasons that survive that: Bing does not ignore it, and the table
 * below is the only place in the repo that states, in one screen, which parts of
 * the docs are meant for a reader arriving from a search engine and which are
 * contributor tooling. `<changefreq>` is NOT emitted — it is ignored by
 * everyone and asserts a cadence nobody here controls.
 */

/**
 * Section → priority for that section's landing page. Pages nested below a
 * landing page get one step less. Anything unlisted falls back to
 * `DEFAULT_PRIORITY`, so adding a section never silently drops it.
 *
 * The ordering is intent, not size: `hstack` (24 pages) and `development` sit
 * low because they document how to hack on Happier, not how to use it, and
 * `getting-started` (3 pages) sits highest because it is where a stranger lands.
 */
const SECTION_PRIORITY: Record<string, number> = {
  'getting-started': 0.9,
  features: 0.8,
  clients: 0.8,
  providers: 0.8,
  platforms: 0.8,
  deployment: 0.7,
  server: 0.7,
  security: 0.7,
  advanced: 0.6,
  plugins: 0.6,
  protocol: 0.6,
  releases: 0.6,
  architecture: 0.5,
  development: 0.5,
  hstack: 0.5,
  legal: 0.3,
};

const DEFAULT_PRIORITY = 0.5;
const NESTED_PENALTY = 0.1;
const MIN_PRIORITY = 0.3;

/**
 * URL prefixes to keep out of the sitemap because the page should not be
 * indexed.
 *
 * It is deliberately empty. Every one of the 225 pages is public reference
 * material a reader is allowed to find, including `/legal/*` (the canonical
 * Terms and Privacy Policy — happier.dev does not serve its own copies) and
 * `/hstack/*` (contributor docs, uninteresting to most searchers but not
 * secret). The hook exists so that the day a staging or duplicate route is
 * added, excluding it is a one-line change in a place someone will look —
 * rather than a discovery six months later that it has been indexed all along.
 *
 * A page listed here must ALSO get `robots: { index: false }` in its metadata.
 * Omitting a URL from a sitemap does not deindex it; it only stops advertising
 * it.
 */
const NOINDEX_PREFIXES: readonly string[] = [];

function priorityFor(slugs: readonly string[]): number {
  if (slugs.length === 0) return 1;

  const section = slugs[0];
  const base = SECTION_PRIORITY[section] ?? DEFAULT_PRIORITY;
  if (slugs.length === 1) return base;

  return Math.max(MIN_PRIORITY, Number((base - NESTED_PENALTY).toFixed(2)));
}

export default function sitemap(): MetadataRoute.Sitemap {
  return source
    .getPages()
    .filter((page) => !NOINDEX_PREFIXES.some((prefix) => page.url.startsWith(prefix)))
    .map((page) => ({
      url: absoluteUrl(page.url),
      lastModified: contentLastModified(page.path),
      priority: priorityFor(page.slugs),
    }))
    .sort((a, b) => a.url.localeCompare(b.url));
}
