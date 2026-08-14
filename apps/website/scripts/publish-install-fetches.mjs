#!/usr/bin/env node
/**
 * Counts installer-script fetches from Cloudflare's own request logs.
 *
 * THIS IS THE ANSWER TO "DID THE WEBSITE PRODUCE AN INSTALL?" AND IT INVOLVES
 * NO NEW COLLECTION WHATSOEVER.
 *
 * The conversion this site is built to cause happens in a terminal on a machine
 * that has no browser. The obvious way to close that loop — a source token in
 * the copied command and a beacon in install.sh — is the one thing this product
 * must not do, and the reasons are not squeamishness:
 *
 *   1. `curl … | bash` is the highest-trust act a user ever performs for us. A
 *      beacon inside it is the single most reputation-damaging line a
 *      privacy-first, open-source, E2EE product could ship, and the audience
 *      reads the script — that is why we publish it at a stable URL.
 *   2. A per-visitor token makes the copied command different for every visitor.
 *      Users paste that command into blog posts, Dockerfiles, READMEs and issue
 *      threads. The token propagates and becomes a real tracking identifier
 *      attached to third parties who never visited us. That is not audience
 *      measurement; it is tracking, and no opt-out flag makes it not that.
 *   3. It runs in CI. A beacon there measures build agents.
 *   4. It does not even close the loop. What we want to know is whether they
 *      PAIRED and SENT A MESSAGE, and both of those are already visible at the
 *      relay, which necessarily sees them to route them.
 *
 * So the chain is measured as two halves joined by a RATIO, not by an identity:
 *
 *   visit ─┐
 *          ├─ PostHog (this site)      $pageview → section_viewed → install_command_copied
 *   copy  ─┘
 *   fetch ──  THIS SCRIPT              GET /install*  (Cloudflare, already logged)
 *   run   ─┐
 *   pair  ─┤─ relay-side, server events on data the server must already hold
 *   msg   ─┘  (apps/ui/sources/track/index.ts already emits connect_attempt /
 *             message_sent from the client side of the same journey)
 *
 * `install_command_copied ÷ install fetches` and `install fetches ÷ machines
 * paired` are the two numbers that tell you where the funnel leaks. Neither
 * needs to know who anyone is. Copy-then-fetch happens within seconds on the
 * same day, so day-grain aggregates line up well enough to steer by — and a
 * ratio you can defend beats a join you cannot.
 *
 * OUTPUT: writes installs.json, to be published next to downloads.json and
 * discord.json on stats.happier.dev (see src/components/publicStats.ts).
 *
 * ENV: CLOUDFLARE_API_TOKEN (Zone → Analytics → Read), CLOUDFLARE_ZONE_TAG.
 * USAGE: node scripts/publish-install-fetches.mjs [days=30] > installs.json
 */

const ZONE = process.env.CLOUDFLARE_ZONE_TAG;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;

if (!ZONE || !TOKEN) {
    console.error('CLOUDFLARE_ZONE_TAG and CLOUDFLARE_API_TOKEN are required.');
    process.exit(1);
}

const days = Number(process.argv[2] ?? 30);
const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const until = new Date().toISOString().slice(0, 10);

/**
 * Only 2xx counts. A 304 is a re-run on a machine that already has the script,
 * and a 4xx/5xx is a fetch that produced no install — counting either would
 * inflate the denominator of every ratio built on this number.
 */
const QUERY = `
query InstallFetches($zone: String!, $since: Date!, $until: Date!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      httpRequestsAdaptiveGroups(
        limit: 5000
        filter: {
          date_geq: $since
          date_leq: $until
          clientRequestPath_like: "/install%"
          edgeResponseStatus_lt: 300
        }
        orderBy: [date_ASC]
      ) {
        count
        dimensions { date clientRequestPath }
      }
    }
  }
}`;

const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: QUERY, variables: { zone: ZONE, since, until } }),
});

const payload = await response.json();
if (payload.errors?.length) {
    console.error(JSON.stringify(payload.errors, null, 2));
    process.exit(1);
}

const groups = payload.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? [];

const byDate = new Map();
const byPath = new Map();
let total = 0;

for (const group of groups) {
    const { date, clientRequestPath } = group.dimensions;
    total += group.count;
    byDate.set(date, (byDate.get(date) ?? 0) + group.count);
    byPath.set(clientRequestPath, (byPath.get(clientRequestPath) ?? 0) + group.count);
}

process.stdout.write(
    JSON.stringify(
        {
            // Same shape discipline as downloads.json: a flat integer at a
            // stable key, so readCount() in src/components/publicStats.ts can
            // validate it without a bespoke parser.
            installFetches: total,
            windowDays: days,
            since,
            until,
            // `/install` vs `/install.sh` vs `/install.ps1` vs `/install-dev` is
            // the only channel split available without changing the command, and
            // it is a genuine one: the site hands out `/install`, the docs hand
            // out `/install.sh`, Windows gets `/install.ps1`.
            byPath: Object.fromEntries([...byPath].sort((a, b) => b[1] - a[1])),
            byDate: Object.fromEntries([...byDate].sort()),
            generatedAt: new Date().toISOString(),
        },
        null,
        2,
    ) + '\n',
);
