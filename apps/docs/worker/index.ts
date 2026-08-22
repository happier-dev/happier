/**
 * Worker entry for docs.happier.dev.
 *
 * The site is a fully static Next export: every page is a real file under out/,
 * served by the Workers static-asset layer without ever invoking this script.
 * Those requests are free and unlimited. Only three things reach this code, and
 * `run_worker_first` in wrangler.toml names each of them.
 *
 * All three were server behaviours that `output: 'export'` cannot keep:
 *
 *   /ingest/*   the analytics proxy, `force-dynamic` by nature
 *   /health     liveness, which a cached file cannot report
 *   *.mdx       a Next `rewrites()` rule, and rewrites are a server feature
 *
 * ---------------------------------------------------------------------------
 * First-party analytics ingest
 *
 * `/ingest/*` is forwarded to PostHog Cloud EU; nothing else on the site makes
 * a third-party request.
 *
 * Why this exists rather than pointing posthog-js at eu.i.posthog.com:
 *   - The audience is developers. EasyPrivacy (uBlock Origin's default list)
 *     blocks `*.i.posthog.com`, so a direct integration measures the slice of
 *     our readership least like our readership.
 *   - With the proxy, the page can truthfully say it contacts no host but this
 *     one — which is the claim the privacy policy makes.
 *
 * The circumvention question, answered rather than dodged: an ad blocker blocks
 * trackers because trackers track people. This one does not — no cookie, no
 * stored id, no person profile, no session replay, no IP retention. The signal
 * that means "this human refuses" is Global Privacy Control, and it is honoured
 * before posthog-js is imported at all (src/analytics/analytics.ts).
 *
 * NOT in the request path of anything that matters: if this fails the docs
 * still render. Only measurement is lost.
 * ---------------------------------------------------------------------------
 */

const API_ORIGIN = 'https://eu.i.posthog.com';
const ASSETS_ORIGIN = 'https://eu-assets.i.posthog.com';

interface Env {
    ASSETS: { fetch: (request: Request) => Promise<Response> };
}

async function proxyToPostHog(request: Request, url: URL): Promise<Response> {
    const path = url.pathname.replace(/^\/ingest/, '');

    // posthog-js fetches its lazily-loaded chunks from /static/*, which lives on
    // the assets host, not the API host.
    const origin = path.startsWith('/static/') ? ASSETS_ORIGIN : API_ORIGIN;
    const target = new URL(path + url.search, origin);

    const outbound = new Request(target, request);
    // PostHog derives the cookieless identity hash from the request; the
    // forwarded Host must be its own, and the client IP must survive the hop or
    // the hash degrades to one bucket per Cloudflare colo.
    outbound.headers.set('host', new URL(origin).host);

    const response = await fetch(outbound, {
        // Static chunks are immutable and worth caching at our own edge.
        cf: path.startsWith('/static/') ? { cacheTtl: 3600, cacheEverything: true } : undefined,
    } as RequestInit);

    // Same-origin from the browser's point of view, so no CORS headers to add;
    // strip PostHog's own so they cannot contradict ours.
    const out = new Response(response.body, response);
    out.headers.delete('access-control-allow-origin');
    out.headers.delete('access-control-allow-credentials');
    return out;
}

/**
 * `/anything/here.mdx` → the exported `/llms.mdx/docs/anything/here.mdx` asset.
 *
 * This was `rewrites()` in next.config.mjs: appending `.mdx` to any docs URL
 * returns that page's Markdown source, which is what an agent asked to "read
 * the docs" should fetch instead of scraping HTML.
 *
 * It has to happen HERE and not in `_redirects`, because that file only emits
 * 3xx: a redirect would change the URL the caller sees, and the whole point is
 * that `<page>.mdx` IS the address of the source. So the Worker rewrites the
 * path internally and serves the already-exported file — same response, same
 * URL, no round trip.
 *
 * A 200 with the wrong body would be worse than a 404 here, so an unmatched
 * path falls through to the asset layer's `not_found_handling` rather than
 * being answered with something plausible.
 */
function mdxSourceRequest(request: Request, url: URL): Request {
    const rewritten = new URL(url);
    // The exported file keeps the extension (see the route's own note on why),
    // so this is a pure prefix — nothing to strip, nothing to re-append.
    rewritten.pathname = `/llms.mdx/docs${url.pathname}`;
    return new Request(rewritten, request);
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/ingest' || url.pathname.startsWith('/ingest/')) {
            return proxyToPostHog(request, url);
        }

        // Answered by the script on purpose. A static /health file would be
        // served by the asset layer whether or not this Worker deployed, so it
        // would report "ok" in exactly the situation worth detecting: assets
        // live, script missing, every analytics event 404ing in silence.
        if (url.pathname === '/health') {
            return Response.json(
                {
                    status: 'ok',
                    service: 'happier-docs',
                    timestamp: new Date().toISOString(),
                },
                { headers: { 'cache-control': 'no-store' } },
            );
        }

        if (url.pathname.endsWith('.mdx')) {
            return env.ASSETS.fetch(mdxSourceRequest(request, url));
        }

        // Anything else that reaches the script (it should not, given
        // run_worker_first) falls back to the asset layer, which applies
        // _redirects and not_found_handling exactly as configured.
        return env.ASSETS.fetch(request);
    },
};
