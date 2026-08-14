import type { ReactElement } from 'react';

import { AGENTS, AGENT_META } from './data/agents';
import { CODEX_COMPARISON_ROWS } from './data/codexRemote';
import { COMPARISON_ROWS } from './data/comparison';
import { ENTERPRISE_ACCESS, ENTERPRISE_DATA } from './data/enterprise';
import { SECURITY_HOPS, SECURITY_INVISIBLE, SECURITY_VISIBLE } from './data/security';
import { CONTROL_ROWS } from './data/terminalFeature';
import { SERVICE_SUPPORT } from './data/usageLimits';
import { AgentDetail } from './pages/AgentDetail';
import { AgentsIndex } from './pages/AgentsIndex';
import { CodexRemotePage } from './pages/CodexRemotePage';
import { EnterprisePage } from './pages/EnterprisePage';
import { Home } from './pages/Home';
import { SecurityPage } from './pages/SecurityPage';
import { TerminalPage } from './pages/TerminalPage';
import { UsageLimitsPage } from './pages/UsageLimitsPage';
import { VsRemoteControlPage } from './pages/VsRemoteControlPage';
import { preloadTagsFor } from './components/Picture';

/**
 * ONE route table for the whole site.
 *
 * Before this file the route list lived inside the sitemap build plugin, which
 * is exactly the drift that plugin's own docblock warned about: the sitemap, the
 * prerenderer and the client each had to be told separately that a page existed.
 * Now they all read this. Adding a page is one entry here.
 *
 * DELIBERATELY NOT A ROUTER LIBRARY. react-router costs ~12KB gzipped and a
 * hydration-mode change to buy client-side navigation on a site where every
 * navigation is a full page load anyway. Each route is prerendered to its own
 * real file (dist/agents/index.html, …) so Cloudflare Pages serves each one as a
 * genuine 200 asset, and public/_redirects keeps its catch-all-free stance —
 * see the 40-line argument in that file, which is correct.
 *
 * HEAD TAGS. Every route owns its own <title>, description, canonical, Open
 * Graph set and JSON-LD. scripts/assert-crawlable.mjs fails the build if two
 * routes share a title, or share a page-scoped JSON-LD `@id`, which was a live
 * bug the moment a second page existed: `@id` was hardcoded to
 * `https://happier.dev/#webpage`.
 */

export const SITE = 'https://happier.dev';

export type Route = {
    /** Origin-relative path. Always starts with `/`; only `/` ends with one. */
    path: string;
    /** ≤60 characters, unique across routes. Asserted at build time. */
    title: string;
    /** ≤155 characters. Google truncates past that and the tail is wasted. */
    description: string;
    /** The social headline. Written for a human reading a shared link. */
    ogTitle: string;
    ogDescription: string;
    /** Root-relative path to the card. */
    ogImage: string;
    ogImageAlt: string;
    /**
     * Page-scoped structured data. Site-scoped nodes (#org, #site, #app,
     * #source) stay in index.html and are shared by every page on purpose —
     * that is how a schema graph works, and the uniqueness assertion only
     * covers the nodes minted here.
     */
    jsonLd: ReadonlyArray<Record<string, unknown>>;
    render: () => ReactElement;
};

function webPage(path: string, id: string, name: string, extra: Record<string, unknown> = {}) {
    return {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        '@id': `${SITE}${path}#${id}`,
        url: `${SITE}${path}`,
        name,
        isPartOf: { '@id': `${SITE}/#site` },
        about: { '@id': `${SITE}/#app` },
        inLanguage: 'en',
        ...extra,
    };
}

const HOME: Route = {
    path: '/',
    // "Remote" is deliberately absent even though `claude code remote` is the
    // highest-CPC term in the set: it belongs to /vs/claude-code-remote-control,
    // and fighting for one term on two URLs loses both. "11 more" spends the
    // same characters on the count — the thing a vendor remote is not built to
    // do — instead of on "OpenCode", a navigational query owned by sst that
    // yields structurally zero here. (It does NOT claim no vendor will ship a
    // client for a rival's CLI: Zed already does, over ACP.)
    title: 'Happier — open-source app for Claude Code, Codex & 11 more',
    description:
        'Run Claude Code, Codex and 11 more agents from your phone, browser or desktop. Open-source, end-to-end encrypted, self-hostable. Your own subscriptions.',
    ogTitle: 'Happier — One client for every AI coding agent.',
    ogDescription:
        'Claude Code, Codex, OpenCode, Cursor and 9 more — in one end-to-end encrypted app, on every device, on your own subscriptions. Open-source and self-hostable.',
    ogImage: '/images/og.png',
    ogImageAlt:
        'The Happier wordmark over the words: One client for every AI coding agent. Claude Code, Codex, OpenCode, Cursor, Gemini, Copilot and 7 more.',
    jsonLd: [
        webPage('/', 'webpage', 'Happier — open-source app for Claude Code, Codex & 11 more', {
            primaryImageOfPage: `${SITE}/images/og.png`,
        }),
    ],
    render: () => <Home />,
};

const AGENTS_INDEX: Route = {
    path: '/agents',
    title: 'Every AI coding agent Happier runs — 13 and counting',
    description:
        'One open-source app for 13 command-line coding agents — Claude Code, Codex, OpenCode, Pi and nine more — on your own computers, with your own accounts.',
    ogTitle: 'Every AI coding agent Happier runs',
    ogDescription:
        'Thirteen command-line coding agents, one app on your phone, browser and desktop. Each runs on your own computer, under your own subscription or API key.',
    ogImage: '/images/og.png',
    ogImageAlt: 'The Happier wordmark over the words: One client for every AI coding agent.',
    jsonLd: [
        webPage('/agents', 'webpage', 'Every AI coding agent Happier runs'),
        {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            '@id': `${SITE}/agents#agent-list`,
            name: 'AI coding agents Happier runs',
            numberOfItems: AGENTS.length,
            itemListOrder: 'https://schema.org/ItemListUnordered',
            itemListElement: AGENTS.map((agent, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                name: agent.name,
                url: `${SITE}/agents/${agent.slug}`,
            })),
        },
    ],
    render: () => <AgentsIndex />,
};

const AGENT_ROUTES: Route[] = AGENTS.map((agent) => {
    const path = `/agents/${agent.slug}`;
    const meta = AGENT_META[agent.slug];
    if (!meta) throw new Error(`AGENT_META has no entry for '${agent.slug}'`);

    return {
        path,
        title: meta.title,
        description: meta.description,
        ogTitle: agent.h1,
        ogDescription: agent.standfirst,
        ogImage: '/images/og.png',
        ogImageAlt: 'The Happier wordmark over the words: One client for every AI coding agent.',
        // One WebPage node and nothing else. The capability ItemList that used
        // to be here was generated from the nine-column matrix and went with it.
        //
        // These pages each carry an FAQ and it is deliberately NOT marked up as
        // FAQPage: Google retired FAQ rich results for non-authoritative sites,
        // so the schema buys no SERP feature and only adds a surface that has to
        // stay in sync with the copy.
        jsonLd: [webPage(path, 'webpage', agent.h1)],
        render: () => <AgentDetail agent={agent} />,
    };
});

const VS_REMOTE_CONTROL: Route = {
    path: '/vs/claude-code-remote-control',
    // NOT "honest comparison", which is what this title said for one release.
    // Every comparison page on the internet calls itself honest, the reader
    // cannot check the claim, and the two words spend a SERP slot a specific
    // promise uses better. What makes the page honest is the sourcing rule in
    // src/data/comparison.ts, not an adjective in the <title>.
    title: 'Claude Code Remote Control vs Happier: what each covers',
    // Vertex is deliberately NOT in this list. Anthropic's named unavailability
    // list is Bedrock / Google Cloud's Agent Platform / Microsoft Foundry; a
    // Vertex session is turned away by the separate api.anthropic.com rule, and
    // Happier ships a first-party Gemini Vertex profile, so naming it here was
    // wrong twice.
    //
    // The tail used to read "What each does, per Anthropic's own docs." A meta
    // description has ~155 characters, and spending twenty-four of them naming
    // where the facts came from is evidence-as-prose in its SERP form: the
    // snippet has to state the thing. The sourcing is real and it lives where
    // sourcing belongs — the docblock at the top of src/data/comparison.ts, and
    // the attributed sentences on the page (RC_SECTION.turn, and the standfirst
    // and dek above the five-conditions list). Every unavailability named here
    // is Anthropic's own published behaviour, verified August 2026.
    description:
        'Remote Control is free and good. It is also unavailable for API keys, gateways, Bedrock, Foundry and ZDR orgs. What each one covers, side by side.',
    ogTitle: 'Claude Code Remote Control vs Happier',
    // The share card is not the place to send the reader to a competitor. "When
    // you should use it instead of Happier" was the old tail of this string and
    // it is what a link preview would have led with.
    //
    // "the five situations its documentation says it turns itself off in" was
    // the middle clause. The attribution belongs on the page, in body copy,
    // where it is made in full; in a share card it is nine words of provenance
    // in place of the thing itself. The on-page <h2> states it unattributed for
    // the same reason, so the two now agree.
    ogDescription:
        'What Anthropic’s own remote does well, the five situations it turns itself off in, and what one client for thirteen agents does instead.',
    ogImage: '/images/og.png',
    ogImageAlt: 'The Happier wordmark over the words: One client for every AI coding agent.',
    jsonLd: [
        webPage('/vs/claude-code-remote-control', 'webpage', 'Claude Code Remote Control vs Happier'),
        {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            '@id': `${SITE}/vs/claude-code-remote-control#comparison`,
            name: 'Claude Code Remote Control compared with Happier',
            numberOfItems: COMPARISON_ROWS.length,
            itemListElement: COMPARISON_ROWS.map((row, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                name: row.capability,
                description: `Claude Code Remote Control: ${row.rc}. Happier: ${row.happier}.`,
            })),
        },
    ],
    render: () => <VsRemoteControlPage />,
};

/**
 * The Codex half of the comparison pair.
 *
 * ONE TERM, ONE URL — the rule stated for the homepage above, applied to the
 * pair. This page owns "codex remote" and "codex mobile"; the Claude page owns
 * "claude code remote control" and neither title, description nor H1 borrows
 * the other's terms. They cross-link with descriptive anchors instead.
 *
 * NO PRODUCT NAMED "CODEX MOBILE" APPEARS ANYWHERE IN THIS ENTRY. OpenAI put
 * Codex inside the ChatGPT mobile app and named the feature Remote
 * (learn.chatgpt.com/docs/remote). The mobile intent is served by the reader's
 * own words — "from your phone" — not by a capitalised name we made up.
 *
 * NO /vs HUB. A parent page over exactly two children is a thin page whose only
 * content is two links, and it would sit between the query and the answer. The
 * pair links to each other directly; revisit if a third comparison lands.
 */
const VS_CODEX_REMOTE: Route = {
    path: '/vs/codex-remote',
    title: 'Codex from your phone — Codex Remote vs Happier',
    // "the conditions in OpenAI's own docs" was the middle clause, and it is the
    // same evidence-as-prose defect as the eyebrow this page used to carry: the
    // snippet named its source instead of naming the thing. Attribution is made
    // in full on the page — CODEX_SECTION.turn, the standfirst, and the dek
    // above the conditions list — and the sourcing rule is in the docblock at top
    // of src/data/codexRemote.ts. Every condition is OpenAI's own published
    // requirement, verified August 2026.
    description:
        'OpenAI pairs the ChatGPT app to a Mac or Windows PC running Codex. What Remote covers, the five conditions it runs under, and what Happier does instead.',
    // "…and where Happier fits" is gone from both the snippet and the share
    // card, for the reason it is gone from the H1: "fits" names no outcome, and
    // the phrase is legible only to a reader who already knows the product.
    ogTitle: 'Codex Remote and Happier, compared',
    // Not "why Codex Remote is not enough". The share card is read by people who
    // like Codex, and the page's whole method is conceding accurately first.
    ogDescription:
        'What OpenAI’s own remote does well, the five conditions it runs under, and what one client for every coding agent does instead.',
    ogImage: '/images/og.png',
    ogImageAlt: 'The Happier wordmark over the words: One client for every AI coding agent.',
    jsonLd: [
        webPage('/vs/codex-remote', 'webpage', 'Codex Remote compared with Happier'),
        {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            '@id': `${SITE}/vs/codex-remote#comparison`,
            name: 'Codex Remote and Codex cloud compared with Happier',
            numberOfItems: CODEX_COMPARISON_ROWS.length,
            itemListElement: CODEX_COMPARISON_ROWS.map((row, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                name: row.capability,
                description: `Codex: ${row.codex}. Happier: ${row.happier}.`,
            })),
        },
    ],
    render: () => <CodexRemotePage />,
};

/**
 * FEATURE PAGES own EVALUATION intent and nothing else.
 *
 * The division of labour, decided once so the next feature page does not have
 * to relitigate it:
 *   - a feature page answers "can Happier do X, for which agents, what is the
 *     catch". It links to its docs page exactly once, labelled "configuration
 *     reference", and never repeats the step list.
 *   - docs.happier.dev owns PROCEDURE.
 *   - guides.happier.dev owns the JOB ("I ran out of quota at 4pm, now what").
 *
 * Two of them, not three. /features/permissions was considered and dropped: the
 * permission model is answered in one FAQ paragraph and a docs page, and a
 * third URL competing for the same handful of queries would have split them.
 */
const USAGE_LIMITS: Route = {
    path: '/features/usage-limits',
    // The title and the share card both used to sell the pool — "pool the
    // accounts you own", "a running session that moves to another account you
    // own" — which is the smaller half of what this page is about and the half
    // that needs a second subscription before it means anything. The larger
    // claim holds with one account: the session waits out the reset and carries
    // on.
    //
    // "load-balance" was briefly here as an SEO term and has been removed. A
    // pool is FAILOVER, not load balancing: above the soft threshold
    // (default 15% remaining) `resolveSoftSwitchPreferredCandidate` returns the
    // ACTIVE member unchanged and the caller bails, so nothing is ever
    // distributed off a healthy account — see
    // apps/server/.../selectConnectedServiceAuthGroupCandidate.ts:593,811 in the
    // shipped tree, and the product's own UI string "Automatic fallback"
    // (apps/ui/sources/text/translations/en.ts:2748). If the query is worth
    // targeting, target it as a disambiguation in body copy, never as an
    // assertion of mechanism in metadata.
    //
    // Neither the title nor the share card may promise an UNATTENDED resume:
    // accountSettings.ts:276 defaults the recovery mode to 'ask'. Waiting and
    // resuming is what Happier does; doing it without being asked is one
    // setting ("Always wait and resume"), and the page body is where that is
    // sold. See the evidence block at the top of UsageLimitsPage.tsx.
    title: 'Claude Code and Codex usage limits without losing work',
    description:
        'Hit a Claude Code or Codex usage limit and the session waits out the reset, then carries on — automatically, if you like. Or pool accounts and fall back.',
    ogTitle: 'A usage limit should not end your session.',
    ogDescription:
        'The session holds its place through a usage limit, waits out the reset and picks the work back up — on one account, or across the accounts you pool.',
    ogImage: '/images/og.png',
    ogImageAlt: 'The Happier wordmark over the words: One client for every AI coding agent.',
    jsonLd: [
        webPage('/features/usage-limits', 'webpage', 'Usage limits and account pooling in Happier'),
        {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            '@id': `${SITE}/features/usage-limits#services`,
            name: 'Provider accounts Happier can pool, and where it can switch between them',
            numberOfItems: SERVICE_SUPPORT.length,
            itemListElement: SERVICE_SUPPORT.map((row, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                name: row.service,
                description: `Usable by ${row.agents}. Switches inside a running session for: ${row.autoSwitch}. Quota meter: ${row.meter}.`,
            })),
        },
    ],
    render: () => <UsageLimitsPage />,
};

const TERMINAL: Route = {
    path: '/features/terminal',
    // "Happier keeps your terminal" and the share card's "Keep your terminal. Or
    // never open one." are both legible only to a reader who already knows what
    // Happier is. The agents are the nouns people search for, so the agents are
    // in the title; tmux is in the description for the same reason.
    title: 'Claude Code and Codex in your terminal, and in the app',
    description:
        'Run Claude Code, Codex or OpenCode in their own TUI and follow the same session from your phone. Attach over tmux, or hand control back to the app.',
    ogTitle: 'Keep your Claude Code, Codex and OpenCode terminals, or work from the app',
    ogDescription:
        'One session, two front ends: the provider’s own TUI in your shell and Happier on your phone. Same session id, same transcript, same queue on both sides of the switch.',
    ogImage: '/images/og.png',
    ogImageAlt: 'The Happier wordmark over the words: One client for every AI coding agent.',
    jsonLd: [
        webPage('/features/terminal', 'webpage', 'Terminal and TUI control in Happier'),
        {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            '@id': `${SITE}/features/terminal#local-control`,
            name: 'Agents whose sessions move between a terminal TUI and the Happier app',
            numberOfItems: CONTROL_ROWS.length,
            itemListElement: CONTROL_ROWS.map((row, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                name: row.agent,
                description: `Terminal and app together: ${row.topology}. Reattaches through ${row.attach}.`,
            })),
        },
    ],
    render: () => <TerminalPage />,
};

/**
 * /enterprise is a FIRST-CLASS page, not a feature page.
 *
 * A feature page persuades a developer; this one has to survive a security
 * review. Its claims are therefore scoped harder than anywhere else on the
 * site — see the docblock in src/data/enterprise.ts for the three things the
 * repository README advertises that this page deliberately does not.
 */
const ENTERPRISE: Route = {
    path: '/enterprise',
    title: 'Self-hosted Happier for teams — SSO, mTLS, your data',
    description:
        'Run the Happier relay yourself: GitHub org and OIDC group gating, forwarded mTLS, offboarding re-checks, storage policy, retention, Docker with Postgres.',
    ogTitle: 'Self-host the Happier relay behind your own SSO',
    ogDescription:
        'A relay you host, locked to your GitHub org or OIDC groups, with client certificates, offboarding re-checks and a storage policy you choose. MIT-licensed, all of it.',
    ogImage: '/images/og.png',
    ogImageAlt: 'The Happier wordmark over the words: One client for every AI coding agent.',
    jsonLd: [
        webPage('/enterprise', 'webpage', 'Self-hosting Happier for an organisation'),
        {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            '@id': `${SITE}/enterprise#controls`,
            name: 'Server controls available on a self-hosted Happier relay',
            numberOfItems: ENTERPRISE_ACCESS.length + ENTERPRISE_DATA.length,
            itemListElement: [...ENTERPRISE_ACCESS, ...ENTERPRISE_DATA].map((item, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                name: item.title,
                description: item.body,
            })),
        },
    ],
    render: () => <EnterprisePage />,
};

/**
 * /security is the individual reader's page; /enterprise is the buyer's.
 *
 * They are a PAIR, and the pairing is the reason this entry exists at all: the
 * footer used to send "Security & encryption" straight to docs.happier.dev,
 * which took the single most evaluative visitor off the site before they had
 * read a sentence we wrote. Encryption is the load-bearing claim of this
 * product; a redirect is not a position.
 *
 * The split, decided once so neither page grows into the other:
 *   - /security  — the architecture and what it means for one person. Which key
 *                  is made where, what the relay holds, what it can still see.
 *                  No environment variables anywhere on it.
 *   - /enterprise — what an operator can enforce, in the operator's vocabulary.
 * The storage policy is the one subject both must cover, and it is written from
 * opposite ends on each. They link to each other exactly once, in each
 * direction, and nowhere else.
 *
 * NO CERTIFICATION IS CLAIMED HERE OR ON THE PAGE. SOC 2, ISO 27001, HIPAA and
 * GDPR compliance are absent because none is evidenced in the tree, and no
 * wording implies an audit. The description sells the specificity instead,
 * which is the thing the page actually has.
 */
const SECURITY: Route = {
    path: '/security',
    title: 'End-to-end encryption in Happier — what the relay sees',
    description:
        'Session content is sealed on the device that wrote it. The keys, the columns a relay can still read, and what changes under a plaintext storage policy.',
    ogTitle: 'End-to-end encryption, with the keys on your own devices',
    ogDescription:
        'Your session is encrypted under a per-session key on the device that made it, and the relay is handed a sealed copy it has nothing to open. Here is what it can still see — named, not glossed.',
    ogImage: '/images/og.png',
    ogImageAlt: 'The Happier wordmark over the words: One client for every AI coding agent.',
    jsonLd: [
        webPage('/security', 'webpage', 'Encryption and the Happier relay'),
        {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            '@id': `${SITE}/security#message-path`,
            name: 'The path a message takes through a Happier relay',
            itemListOrder: 'https://schema.org/ItemListOrderAscending',
            numberOfItems: SECURITY_HOPS.length,
            itemListElement: SECURITY_HOPS.map((hop, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                name: `${hop.label} — ${hop.verb}`,
                description: hop.body,
            })),
        },
        {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            '@id': `${SITE}/security#relay-visibility`,
            name: 'What a Happier relay holds, and what it does not',
            numberOfItems: SECURITY_VISIBLE.length + SECURITY_INVISIBLE.length,
            itemListElement: [
                ...SECURITY_VISIBLE.map((item) => ({ item, holds: true })),
                ...SECURITY_INVISIBLE.map((item) => ({ item, holds: false })),
            ].map((entry, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                name: `${entry.holds ? 'Holds' : 'Does not hold'}: ${entry.item.title}`,
                description: entry.item.body,
            })),
        },
    ],
    render: () => <SecurityPage />,
};

export const ROUTES: ReadonlyArray<Route> = [
    HOME,
    AGENTS_INDEX,
    ...AGENT_ROUTES,
    VS_REMOTE_CONTROL,
    VS_CODEX_REMOTE,
    USAGE_LIMITS,
    TERMINAL,
    SECURITY,
    ENTERPRISE,
];

export function findRoute(pathname: string): Route | undefined {
    // Cloudflare Pages serves /agents and /agents/ from the same file, so the
    // client has to accept both or a trailing slash breaks hydration.
    const normalised =
        pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    return ROUTES.find((route) => route.path === normalised);
}

function escapeAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * `</script>` inside a JSON string would close the surrounding <script> tag and
 * turn structured data into an XSS vector. The content here is all ours, but
 * the escape costs nothing and the day someone interpolates a user string is
 * not the day to discover it was missing.
 */
function escapeJsonLd(json: string): string {
    return json.replace(/</g, '\\u003c');
}

/**
 * The exact `<head>` fragment a route ships, as a string.
 *
 * Returned as a string rather than as React nodes because it is spliced into
 * index.html by scripts/prerender.mjs, which is a plain Node script working on
 * text. Keeping it here means the head and the page are edited in one file.
 */
export function headTagsFor(route: Route): string {
    const url = `${SITE}${route.path}`;
    const ogImage = route.ogImage.startsWith('http') ? route.ogImage : `${SITE}${route.ogImage}`;

    const tags = [
        `<title>${escapeAttr(route.title)}</title>`,
        `<meta name="description" content="${escapeAttr(route.description)}" />`,
        `<link rel="canonical" href="${escapeAttr(url)}" />`,
        `<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1" />`,
        `<meta property="og:url" content="${escapeAttr(url)}" />`,
        `<meta property="og:title" content="${escapeAttr(route.ogTitle)}" />`,
        `<meta property="og:description" content="${escapeAttr(route.ogDescription)}" />`,
        `<meta property="og:image" content="${escapeAttr(ogImage)}" />`,
        `<meta property="og:image:type" content="image/png" />`,
        `<meta property="og:image:width" content="1200" />`,
        `<meta property="og:image:height" content="630" />`,
        `<meta property="og:image:alt" content="${escapeAttr(route.ogImageAlt)}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${escapeAttr(route.ogTitle)}" />`,
        `<meta name="twitter:description" content="${escapeAttr(route.ogDescription)}" />`,
        `<meta name="twitter:image" content="${escapeAttr(ogImage)}" />`,
        `<meta name="twitter:image:alt" content="${escapeAttr(route.ogImageAlt)}" />`,
    ];

    if (route.path === '/') {
        tags.unshift(preloadTagsFor('heroBackdropDark'));
    }

    for (const node of route.jsonLd) {
        tags.push(
            `<script type="application/ld+json">${escapeJsonLd(JSON.stringify(node))}</script>`,
        );
    }

    return tags.join('\n        ');
}

/**
 * Everything the build scripts need about a route, with no React in it.
 *
 * scripts/prerender.mjs imports this from the SSR bundle. Keeping it a plain
 * serialisable list means the sitemap, the prerenderer and the crawlability
 * assertion all consume the same object.
 */
export type RouteManifestEntry = {
    path: string;
    title: string;
    description: string;
    head: string;
    /** dist-relative file the route must be written to. */
    file: string;
};

export function fileForRoute(path: string): string {
    if (path === '/') return 'index.html';
    return `${path.replace(/^\/|\/$/g, '')}/index.html`;
}

export function routeManifest(): RouteManifestEntry[] {
    return ROUTES.map((route) => ({
        path: route.path,
        title: route.title,
        description: route.description,
        head: headTagsFor(route),
        file: fileForRoute(route.path),
    }));
}
