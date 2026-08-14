/**
 * First-party analytics ingest for happier.dev.
 *
 * Cloudflare Pages Function. `/ingest/*` on this origin is forwarded to PostHog
 * Cloud EU; nothing else on the site makes a third-party request.
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
 * NOT in the request path of anything that matters: if this Function fails, the
 * site still renders and the installer still downloads. Only measurement is lost.
 */

const API_ORIGIN = 'https://eu.i.posthog.com';
const ASSETS_ORIGIN = 'https://eu-assets.i.posthog.com';

export const onRequest: PagesFunction = async (context) => {
    const url = new URL(context.request.url);
    const path = url.pathname.replace(/^\/ingest/, '');

    // posthog-js fetches its lazily-loaded chunks from /static/*, which lives on
    // the assets host, not the API host.
    const origin = path.startsWith('/static/') ? ASSETS_ORIGIN : API_ORIGIN;
    const target = new URL(path + url.search, origin);

    const request = new Request(target, context.request);
    // PostHog derives the cookieless identity hash from the request; the
    // forwarded Host must be its own, and the client IP must survive the hop or
    // the hash degrades to one bucket per Cloudflare colo.
    request.headers.set('host', new URL(origin).host);

    const response = await fetch(request, {
        // Static chunks are immutable and worth caching at our own edge.
        cf: path.startsWith('/static/') ? { cacheTtl: 3600, cacheEverything: true } : undefined,
    });

    // Same-origin from the browser's point of view, so no CORS headers to add;
    // strip PostHog's own so they cannot contradict ours.
    const out = new Response(response.body, response);
    out.headers.delete('access-control-allow-origin');
    out.headers.delete('access-control-allow-credentials');
    return out;
};
