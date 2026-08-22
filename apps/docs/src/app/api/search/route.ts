import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

/**
 * The search index, built once at export time rather than searched per request.
 *
 * `createFromSource` returns two handlers. `GET` runs Orama on the server and
 * answers one query per keystroke — what this route used to export, and what a
 * Next server can do. This deployment has no Next server: the site is a static
 * export on the Cloudflare Workers asset layer, so a per-request handler has
 * nothing to run on.
 *
 * `staticGET` is that same index serialized into one response, fetched once by
 * the client and queried in the browser. It is exported AS `GET` because the
 * client still requests this URL; only what comes back changes. Its other half
 * is `search={{ options: { type: 'static' } }}` on RootProvider — change one
 * without the other and the search box quietly returns nothing.
 *
 * `force-static` is what makes the export emit this as a file; without it the
 * build FAILS here rather than shipping a dead route, which is the better of
 * the two failure modes.
 */
export const { staticGET: GET } = createFromSource(source, {
  // https://docs.orama.com/docs/orama-js/supported-languages
  language: 'english',
});

export const dynamic = 'force-static';
