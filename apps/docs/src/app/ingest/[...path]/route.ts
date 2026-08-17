/**
 * First-party analytics ingest for docs.happier.dev.
 *
 * `/ingest/*` is forwarded to PostHog Cloud EU; nothing else on the site makes a
 * third-party request. Same reasoning as the marketing site's proxy, and the
 * same answer to the obvious objection:
 *
 *   - The audience is developers. EasyPrivacy (uBlock Origin's default list)
 *     blocks `*.i.posthog.com`, so a direct integration measures the slice of
 *     our readership least like our readership.
 *   - With the proxy, the page can truthfully say it contacts no host but this
 *     one — which is the claim the privacy policy now makes.
 *
 * An ad blocker blocks trackers because trackers track people. This one does
 * not: no cookie, no stored id, no person profile, no session replay, no IP
 * retention. The signal that means "this human refuses" is DNT/GPC, and that is
 * honoured before posthog-js is even imported (src/analytics/analytics.ts).
 *
 * NOT in the request path of anything that matters: if this handler fails the
 * docs still render. Only measurement is lost.
 *
 * The marketing site does this in a Cloudflare Worker because it deploys to
 * Workers static assets. This app is a Next server, so it is a route handler.
 */

const API_ORIGIN = 'https://eu.i.posthog.com';
const ASSETS_ORIGIN = 'https://eu-assets.i.posthog.com';

async function proxy(request: Request, context: { params: Promise<{ path?: string[] }> }) {
    const { path } = await context.params;
    const url = new URL(request.url);
    const suffix = `/${(path ?? []).join('/')}`;

    // posthog-js fetches its lazily-loaded chunks from /static/*, which lives on
    // the assets host, not the API host.
    const origin = suffix.startsWith('/static/') ? ASSETS_ORIGIN : API_ORIGIN;
    const target = new URL(suffix + url.search, origin);

    const outbound = new Request(target, request);
    // PostHog derives the cookieless identity hash from the request, so the
    // forwarded Host must be its own.
    outbound.headers.set('host', new URL(origin).host);

    const response = await fetch(outbound);

    // Same-origin from the browser's point of view, so there are no CORS headers
    // to add; strip PostHog's own so they cannot contradict ours.
    const out = new Response(response.body, response);
    out.headers.delete('access-control-allow-origin');
    out.headers.delete('access-control-allow-credentials');
    return out;
}

export const GET = proxy;
export const POST = proxy;
export const OPTIONS = proxy;

/** The proxy must reach PostHog on every request, never a cached copy. */
export const dynamic = 'force-dynamic';
