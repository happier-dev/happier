import type { MetadataRoute } from 'next';

import { SITE_URL } from '@/lib/site';

/**
 * `docs.happier.dev/robots.txt` did not exist before this file. Neither did
 * `sitemap.xml`, which meant 225 pages had no discovery path other than being
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
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
