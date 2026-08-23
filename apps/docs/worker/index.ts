/**
 * Worker entry for docs.happier.dev.
 *
 * The site is a fully static Next export: every page is a real file under out/,
 * served by the Workers static-asset layer without ever invoking this script.
 * Those requests are free and unlimited. ONE path reaches this code — /ingest/*,
 * named in `run_worker_first` in wrangler.toml — and it is the only billable
 * invocation the site can produce.
 *
 * Two other paths used to live here and deliberately no longer do:
 *
 *   *.mdx     was a Worker rewrite onto the exported source. The sources are
 *             now MOVED to those URLs at build time (scripts/exportMdxSources.mjs),
 *             so they are plain static assets and cost nothing to serve.
 *   /health   reported liveness of this script. Nothing consumed it — the
 *             deploy job already asserts the artifact is real — and a monitor
 *             polling it every 60s would have spent 1,440 free-tier requests a
 *             day to learn what the deploy already proved.
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

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/ingest' || url.pathname.startsWith('/ingest/')) {
            return proxyToPostHog(request, url);
        }

        // Anything else that reaches the script (it should not, given
        // run_worker_first) falls back to the asset layer, which applies
        // _redirects and not_found_handling exactly as configured.
        return env.ASSETS.fetch(request);
    },
};
