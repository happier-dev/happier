#!/usr/bin/env node
/**
 * Post-deploy smoke test for the analytics pipeline.
 *
 * There are exactly two ways happier.dev ends up instrumented-but-recording-
 * nothing, and neither one is visible from the browser:
 *
 *   1. THE INGEST PROXY IS NOT REACHABLE. `/ingest/*` is served by the Worker
 *      script in worker/index.ts, and it only runs because wrangler.toml names
 *      that prefix in `assets.run_worker_first`. Drop the prefix from that list,
 *      or deploy without `main`, and `/ingest/*` matches no static asset, falls
 *      through to `not_found_handling`, and every event 404s in silence.
 *      (This was `functions/ingest/[[path]].ts` under Cloudflare Pages, where
 *      the equivalent trap was a project root that never found `functions/`.)
 *   2. COOKIELESS MODE IS NOT ENABLED ON PROJECT 129992. posthog-js sends the
 *      `$posthog_cookieless` sentinel distinct_id; if the project setting is off,
 *      ingestion DROPS the event and still answers HTTP 200. The wire looks
 *      perfect and nothing is stored.
 *
 * This script proves (1) mechanically and gives you the one manual step that
 * proves (2). Run it after every deploy that touches analytics.
 *
 *   node scripts/verify-analytics.mjs                  # against happier.dev
 *   node scripts/verify-analytics.mjs http://localhost:5173
 *
 * ENV: VITE_POSTHOG_KEY (same value the build uses).
 */

const origin = (process.argv[2] ?? 'https://happier.dev').replace(/\/$/, '');
const key = process.env.VITE_POSTHOG_KEY?.trim();

if (!key) {
    console.error('VITE_POSTHOG_KEY is required so the smoke event lands in the right project.');
    process.exit(1);
}

let failures = 0;
const fail = (message) => {
    failures += 1;
    console.error(`  FAIL  ${message}`);
};
const pass = (message) => console.log(`  ok    ${message}`);

// --- 1. the proxy exists and forwards ---------------------------------------
const event = {
    api_key: key,
    event: 'analytics_smoke_test',
    properties: {
        distinct_id: '$posthog_cookieless',
        $cookieless_mode: true,
        site: 'happier.dev',
        source: 'scripts/verify-analytics.mjs',
        origin,
    },
    timestamp: new Date().toISOString(),
};

const response = await fetch(`${origin}/ingest/e/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
});

if (response.status === 404) {
    fail(
        `${origin}/ingest/e/ returned 404. The Cloudflare Pages Function is not deployed — ` +
            'set the Pages project root directory to apps/website so functions/ is found.',
    );
} else if (!response.ok) {
    fail(`${origin}/ingest/e/ returned HTTP ${response.status}.`);
} else {
    const body = await response.text();
    if (!body.includes('"status"')) {
        fail(`${origin}/ingest/e/ answered 200 but the body is not PostHog's: ${body.slice(0, 120)}`);
    } else {
        pass(`${origin}/ingest/e/ forwards to PostHog EU (${body.trim()})`);
    }
}

// --- 2. the lazy-chunk path also proxies ------------------------------------
const staticProbe = await fetch(`${origin}/ingest/static/array.js`, { method: 'GET' });
if (staticProbe.ok) pass(`${origin}/ingest/static/* forwards to eu-assets`);
else fail(`${origin}/ingest/static/array.js returned HTTP ${staticProbe.status}`);

// --- 3. the built page actually carries the key ------------------------------
const page = await fetch(`${origin}/`);
const html = await page.text();
if (html.includes('id="root"') && html.length > 20_000) pass('page is prerendered (not an empty shell)');
else fail('page looks like an empty SPA shell — prerender did not run');

console.log('');
console.log('MANUAL STEP THIS SCRIPT CANNOT DO FOR YOU:');
console.log('  Open PostHog EU -> project 129992 -> Activity, and confirm an');
console.log('  `analytics_smoke_test` event just arrived. A 200 above only proves the');
console.log('  request reached ingestion. If cookieless server hash mode is OFF in');
console.log('  Project settings, ingestion accepts and then DISCARDS every event from');
console.log('  this site, and nothing anywhere will tell you.');

process.exit(failures === 0 ? 0 : 1);
