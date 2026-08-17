/**
 * Worker entry for happier.dev.
 *
 * The site itself is fully prerendered: every route is a real file under dist/,
 * served by the Workers static-asset layer without ever invoking this script.
 * Those requests are free and unlimited. The only thing that reaches this code
 * is /ingest/*, because `run_worker_first` in wrangler.toml names that prefix.
 *
 * ---------------------------------------------------------------------------
 * First-party analytics ingest
 *
 * `/ingest/*` on this origin is forwarded to PostHog Cloud EU; nothing else on
 * the site makes a third-party request.
 *
 * Why this exists rather than pointing posthog-js at eu.i.posthog.com:
 *   - The audience is developers. EasyPrivacy (uBlock Origin's default list)
 *     blocks `*.i.posthog.com`, so a direct integration measures the slice of
 *     our market least representative of our market. That is not a rounding
 *     error on a developer tool.
 *   - The page can then truthfully say it contacts no host but happier.dev.
 *
 * The circumvention question, answered rather than dodged: an ad blocker blocks
 * trackers because trackers track people. This one does not — no cookie, no
 * localStorage, no client identifier, no person profile, no session replay, no
 * IP retention. The signal that means "this human refuses" is Do Not Track and
 * Global Privacy Control, and those are honoured before init in
 * src/analytics/analytics.ts (posthog-js cannot honour them in cookieless mode —
 * see the note there). A proxy that recovers blocked *aggregate* measurement
 * while obeying the explicit refusal signals is a defensible line; one that also
 * ignored DNT/GPC would not be.
 *
 * NOT in the request path of anything that matters: if this fails, the site
 * still renders and the installer still downloads. Only measurement is lost.
 * ---------------------------------------------------------------------------
 *
 * This was `functions/ingest/[[path]].ts` when the site targeted Cloudflare
 * Pages. Workers static assets has no file-based function routing, so the same
 * proxy lives here behind an explicit path check instead.
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
        // _headers, _redirects and not_found_handling exactly as configured.
        return env.ASSETS.fetch(request);
    },
};
