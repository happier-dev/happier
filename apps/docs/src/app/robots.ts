import type { MetadataRoute } from 'next';

import { SITE_URL } from '@/lib/site';

/**
 * Required by `output: 'export'`. Next does NOT infer staticness for metadata
 * routes: without this marker the export fails to collect page data for this
 * route rather than emitting the file. Both this and its sibling are pure
 * functions of content known at build time, so static is also correct.
 */
export const dynamic = 'force-static';

/**
 * `docs.happier.dev/robots.txt` did not exist before this file. Neither did
 * `sitemap.xml`, which meant 146 pages had no discovery path other than being
 * linked from somewhere a crawler already knew about.
 *
 * The `sitemap` value is ABSOLUTE on purpose. A relative `/sitemap.xml` is
 * invalid per the sitemaps.org spec and is discarded silently — the file looks
 * right, the crawler ignores it, and nothing anywhere reports the miss.
 *
 * No `host` directive: it is a Yandex extension every other crawler ignores,
 * and Next emits it as a full URL (`Host: https://docs.happier.dev`) where the
 * directive wants a bare hostname. A line that is wrong and ignored is worse
 * than no line.
 *
 * `/api/` is disallowed because the only thing under it is the search index —
 * a 14 MB serialized blob that is data for the search box, not a page. Nothing
 * is hidden by this; it just keeps a crawler from spending its budget on it.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/api/'] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
