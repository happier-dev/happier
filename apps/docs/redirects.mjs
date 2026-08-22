/**
 * Every permanent URL move this site has made, in one place.
 *
 * These used to be `redirects()` in next.config.mjs. `output: 'export'` has no
 * server to run that hook on and DROPS IT SILENTLY — the build stays green and
 * 2 old URLs start 404ing in production, which is exactly the kind of failure
 * nobody notices until search traffic is already gone.
 *
 * So the list lives here as data, and scripts/generateRedirects.mjs turns it
 * into public/_redirects before every build. The Cloudflare Workers asset layer
 * applies that file natively, ahead of any asset match.
 *
 * ADDING A REDIRECT: add it here. Do not add a `redirects()` key back to
 * next.config.mjs — it would look correct in `next dev` and do nothing at all
 * once exported, which is the worst of both.
 */

/** @type {{ source: string, destination: string, permanent: boolean }[]} */
export const REDIRECTS = [
    // Historical: docs used to live under /docs. Keep old URLs working.
    { source: '/docs', destination: '/', permanent: true },
    { source: '/docs/:path*', destination: '/:path*', permanent: true },
];
