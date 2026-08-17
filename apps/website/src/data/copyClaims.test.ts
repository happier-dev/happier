import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { COMPARISON_ROWS, RC_SCOPE_LIMIT, RC_SECTION, RC_STRENGTHS } from './comparison';
import { FAQ_ITEMS } from './faq';
import { PRIMARY_FEATURES } from './features';
import { PROVIDERS } from './providers';
import { USAGE_LIMITS_SCOPE, USAGE_LIMITS_SWITCHING } from './usageLimits';
import { en } from '../i18n/messages/en';
import { LOCALES } from '../i18n/locales';
import { messagesFor } from '../i18n/messages/registry';
import { siteDataFor } from '../i18n/siteData';
import { HERO } from './pageProse';
import { ROUTES } from '../routes';

/**
 * Copy guards.
 *
 * These test the claims that would be most expensive to get wrong, and that a
 * future copy edit is most likely to break by accident:
 *
 *   1. The comparison table must never assert something about a competitor
 *      that isn't traceable to that competitor's own published docs. The cheap
 *      mechanical proxy for "traceable" is that every restriction row carries
 *      an explicit attribution, and that no row editorialises about quality.
 *   2. The account-pooling copy must never read as limit evasion. That framing
 *      is both a terms-of-service risk and a credibility risk, and it is the
 *      single sentence on the page most likely to drift back toward the old
 *      "sail past usage limits" wording under pressure to sound punchier.
 *
 * THE SWEEP AT THE BOTTOM OF THIS FILE READS RENDERED PAGES, NOT src/data.
 * Every guard here used to import from ./ and only from ./, which meant the
 * whole of src/sections and src/pages was unguarded — and that is where the
 * next overclaim shipped: "Four more minutes, and then it just works", an H2 on
 * the homepage, in the same family as the "Set it and forget it" line that had
 * already been removed from SelfHost for being unverifiable. A guard that reads
 * one directory protects one directory. This one renders the route table, so a
 * sentence is checked wherever it is written and however it is composed —
 * including sentences assembled from a data string plus JSX, which is where the
 * doubled article "the same a Claude subscription" came from.
 */

/**
 * Every route, rendered, with the markup reduced to the words a reader sees.
 *
 * Rendered rather than grepped, for two reasons. Grepping source would sweep
 * the comments too, and these files argue with themselves in comments — the
 * banned sentences are quoted all over them, deliberately, so nobody puts one
 * back. And a string that is only wrong once JSX has joined it to its
 * neighbours is invisible to any check that reads the string.
 */
const RENDERED_PAGES: ReadonlyArray<{ path: string; text: string }> = ROUTES.map((route) => ({
    path: route.path,
    text: renderToStaticMarkup(route.render())
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#x27;|&#39;/g, '’')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&[a-z]+;/g, ' ')
        .replace(/\s+/g, ' '),
}));

/** The offending phrase plus a little of what surrounds it, for the failure. */
function context(text: string, match: RegExpMatchArray): string {
    const at = match.index ?? 0;
    return `…${text.slice(Math.max(0, at - 70), at + match[0].length + 70).trim()}…`;
}

/**
 * The imperative that sends the reader to the competitor.
 *
 * Deliberately NOT swept site-wide: "the normal way to use it" in the FAQ and
 * "Can I use it on a work computer?" are about Happier, and a guard that failed
 * on those would be switched off within a week. It runs over the comparison
 * copy, where "it" is the other product.
 */
const COMPETITOR_IMPERATIVE =
    /\b(use it|use that instead|go and use|you should use|stick with (it|Codex|Remote Control)|just use)\b/i;

describe('comparison table evidence discipline', () => {
    // Every row that states a Remote Control *limitation* must attribute it.
    // Rows that state a neutral fact (price, first-party) need no attribution
    // because they are not adverse claims.
    const ADVERSE = ['auth', 'baseUrl', 'clouds', 'zdr', 'transcript'];

    it('attributes every adverse Remote Control claim to Anthropic docs', () => {
        for (const id of ADVERSE) {
            const row = COMPARISON_ROWS.find((r) => r.id === id);
            expect(row, `missing comparison row: ${id}`).toBeDefined();
            expect(row!.rc, `row "${id}" states a limitation without attribution`).toMatch(
                /per Anthropic docs/i,
            );
        }
    });

    it('never editorialises about Remote Control quality', () => {
        const banned = /\b(worse|inferior|crippled|limited to|only works|useless|broken|toy)\b/i;
        for (const row of COMPARISON_ROWS) {
            expect(row.rc, `row "${row.id}" editorialises`).not.toMatch(banned);
        }
        for (const item of RC_SECTION.cases) {
            expect(item.rc, `case "${item.id}" editorialises`).not.toMatch(banned);
        }
    });

    it('concedes what Remote Control does well before qualifying it', () => {
        // A comparison section that never says the other thing is good is an
        // advertisement. This asserts the concession is substantive, not a
        // one-line nod.
        expect(RC_SECTION.concession.length).toBeGreaterThan(280);
        // It has to concede the specific thing Happier cannot answer — that
        // Anthropic's remote is made by the vendor of the agent — and it has to
        // name the setup Remote Control covers rather than gesturing at one.
        expect(RC_SECTION.concession).toMatch(/first-party/i);
        expect(RC_SECTION.concession).toMatch(/Remote Control already covers it/i);
        expect(COMPARISON_ROWS.some((r) => r.id === 'firstParty')).toBe(true);
    });

    /**
     * THE ASSERTION THIS REPLACES REQUIRED THE DEFECT.
     *
     * It read `expect(RC_SECTION.concession).toMatch(/use it/i)`, written when
     * the policy was "concede maximally", and it pinned the concession to a
     * sentence ending "…none of the conditions below describe your setup, use
     * it". Meanwhile codexRemote.test.ts banned exactly that imperative on the
     * other comparison page. Two guards, one demanding the sentence and one
     * forbidding it, and no way to satisfy both — so the page that had the
     * older guard kept the defect.
     *
     * The concession is still guarded, by the test above: substantive, and it
     * still says the thing that costs us something. What is banned now is the
     * INSTRUCTION. Stating that Remote Control covers a setup is a concession;
     * telling the reader to go and use it is the page arguing itself out of
     * existence, and it is the same rule both /vs pages now run under.
     */
    it('concedes without ever instructing the reader to go and use the competitor', () => {
        const rcCopy = [
            RC_SECTION.concession,
            RC_SECTION.turn,
            RC_SECTION.subline,
            RC_SCOPE_LIMIT.heading,
            RC_SCOPE_LIMIT.body,
            ...RC_STRENGTHS.flatMap((item) => [item.title, item.body]),
            ...RC_SECTION.cases.flatMap((item) => [item.when, item.rc, item.happier]),
            ...RC_SECTION.arguments.flatMap((item) => [item.title, item.body]),
            ...COMPARISON_ROWS.flatMap((row) => [row.capability, row.rc, row.happier]),
        ].join('\n');

        expect(rcCopy).not.toMatch(COMPETITOR_IMPERATIVE);
    });
});

const COMPARISON_PAGES = ['/vs/claude-code-remote-control', '/vs/codex-remote'];

describe('neither comparison page tells the reader to use the competitor', () => {
    it('renders both comparison pages', () => {
        for (const path of COMPARISON_PAGES) {
            expect(
                RENDERED_PAGES.find((page) => page.path === path),
                `${path} is not in the route table`,
            ).toBeDefined();
        }
    });

    // codexRemote.test.ts already runs this over the Codex DATA. This runs it
    // over the rendered PAGE, which is where the prose the components own lives
    // — the standfirst, the section intros, the CTA. That is the half neither
    // data guard could see.
    it('issues no instruction to go and set the other thing up', () => {
        for (const path of COMPARISON_PAGES) {
            const page = RENDERED_PAGES.find((entry) => entry.path === path);
            if (!page) continue;
            const match = page.text.match(COMPETITOR_IMPERATIVE);
            expect(match, match ? `${path}: ${context(page.text, match)}` : '').toBeNull();
        }
    });
});

describe('account pooling is framed as visibility, never evasion', () => {
    // The scoping language used to live in the FAQ's terms-of-service answer.
    // It now lives on /features/usage-limits (src/data/usageLimits.ts), where
    // the reader has self-selected into needing it. The guard follows the copy;
    // it does not relax because the copy moved.
    const poolingCopy = [
        PRIMARY_FEATURES.find((f) => f.id === 'accounts')?.title ?? '',
        PRIMARY_FEATURES.find((f) => f.id === 'accounts')?.body ?? '',
        ...USAGE_LIMITS_SCOPE,
        ...USAGE_LIMITS_SWITCHING,
    ].join(' ');

    it('never promises to bypass, evade, or sail past a provider limit', () => {
        expect(poolingCopy).not.toMatch(
            /\b(bypass|evade|circumvent|get around|sail past|beat the|dodge|unlimited)\b/i,
        );
    });

    it('scopes pooling to accounts the reader owns', () => {
        expect(poolingCopy).toMatch(/accounts you own/i);
    });

    it('states the sharing prohibition rather than staying silent on it', () => {
        const scope = USAGE_LIMITS_SCOPE.join(' ');
        expect(scope).toMatch(/prohibit sharing/i);
        expect(scope).toMatch(/outside your provider’s terms/i);
    });

    // Switching copy must stay bounded by a real number rather than an
    // adjective. "Happier switches accounts when you run out" is the sentence
    // this copy drifts toward under pressure to sound punchier, and it promises
    // an unbounded rotation the product deliberately does not do:
    // `maxSwitchesPerTurn` defaults to 1 and `maxSwitchesPerSessionHour` to 3
    // (packages/protocol/src/connect/connectedServiceSchemas.ts:519-520).
    //
    // NOTE for anyone tempted to assert "off by default" here instead: don't.
    // The zod default is `autoSwitch: false`, but the create route overrides it
    // with `fallbackEnabled() && runtimeFallbackSupportedForService(serviceId)`
    // (apps/server/.../registerConnectedServiceAuthGroupRoutesV3.ts:264-268), so
    // a real pool on a default server starts with fallback ON. The schema
    // default is not what a user experiences.
    it('bounds the switching promise with a ceiling rather than an adjective', () => {
        const accounts = PRIMARY_FEATURES.find((f) => f.id === 'accounts');
        expect(accounts?.body).toMatch(/at most once a turn/i);

        const switching = USAGE_LIMITS_SWITCHING.join(' ');
        expect(switching).toMatch(/per turn/i);
        expect(switching).toMatch(/per session hour/i);
    });

    // A live mid-session account switch requires the agent to declare the
    // `same_connected_group` transition, and only Claude and Codex do
    // (packages/agents/src/manifest.ts:25,78). Copy that says "your sessions"
    // instead of naming them over-claims for the other eleven agents.
    it('scopes mid-session switching to the agents that actually support it', () => {
        const body = PRIMARY_FEATURES.find((f) => f.id === 'accounts')?.body ?? '';
        expect(body).toMatch(/Claude Code and Codex/i);
    });
});

/**
 * The FAQ answers that were rewritten because they were WRONG, not because they
 * were badly phrased. Each of these guards a specific sentence that shipped and
 * should not come back.
 */
describe('the FAQ does not regrow the claims it was corrected for', () => {
    const answer = (id: string) => (FAQ_ITEMS.find((f) => f.id === id)?.a ?? []).join(' ');

    // "Happier's hosted realtime voice is paid" was false: RevenueCat is only
    // configured when EXPO_PUBLIC_REVENUE_CAT_* is set, `syncPurchases` returns
    // before `configure()` without a key, and the only supporter entry point in
    // the app is inside a `devModeEnabled` block. Nothing is paid — so the answer
    // must not hedge toward a future in which something is.
    it('answers "is Happier free" without a hedge', () => {
        expect(answer('free')).not.toMatch(
            /\b(for now|currently|at the moment|for the time being|free tier|paid tier|premium)\b/i,
        );
    });

    // The old ToS answer denied things nobody had asked about ("does not scrape a
    // web UI", "does not replay a browser session", "does not route your prompts
    // through anyone else's account"). Denial plants the idea it denies.
    it('does not answer the ban question with unprompted denials', () => {
        expect(answer('tos')).not.toMatch(/\bdoes not (scrape|replay|route)\b/i);
    });

    // "not a company with a support SLA" reads as a warning, not as candour.
    it('does not warn the reader off in the shutdown answer', () => {
        expect(answer('shutdown')).not.toMatch(/support SLA|one person’s work|solo/i);
    });

    // Plan is a SESSION mode, not a permission mode
    // (apps/docs/content/docs/features/permissions.mdx:19-33). The old answer
    // listed it alongside default/read-only as though it were a permission
    // choice, which is the single most repeated error about this feature.
    it('does not list Plan as a permission mode', () => {
        const permissions = answer('permissions');
        expect(permissions).toMatch(/session mode/i);
        expect(permissions).not.toMatch(/default, read-only, plan/i);
    });
});

describe('agent count claims match the shipped provider set', () => {
    // The hero names four agents and puts the rest in an aside: "OpenCode, Pi
    // & 9 more". 4 + 9 = 13. This is the only assertion of that arithmetic
    // anywhere, so adding a provider to providers.tsx must fail here and force
    // the hero to be re-counted rather than quietly becoming wrong.
    it('ships exactly thirteen provider marks', () => {
        expect(PROVIDERS).toHaveLength(13);
    });

    it('names four real providers in the hero headline', () => {
        const named = `${HERO.headlineLineOne}, ${HERO.headlineLineTwo}`
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);

        expect(named).toHaveLength(4);
        for (const name of named) {
            expect(
                PROVIDERS.some((p) => p.name === name),
                `hero names "${name}", which is not a shipped provider`,
            ).toBe(true);
        }
    });

    // Runs over EVERY locale, not just English. It used to read `en` only,
    // which is how zh-Hans came to assert a different number from the English
    // in the one translated string on the site that carries one — and pass.
    // Splitting on the CJK enumeration comma 、 matters for the same reason.
    it.each(LOCALES)('adds up in %s: named agents and the aside reach the provider count', (locale) => {
        // siteDataFor, not messagesFor: the hero moved to src/data/pageProse.ts
        // so that the overlay reaches it. Reading the old catalogue here would
        // check English nine times and report nine passes.
        const hero = siteDataFor(locale).pageProse.HERO;
        const named = `${hero.headlineLineOne}, ${hero.headlineLineTwo}`
            .split(/[,、，]/)
            .map((part) => part.trim())
            .filter(Boolean).length;

        const aside = hero.headlineLineTwoAside.match(/\d+/);
        expect(aside, `hero aside carries no number to check in ${locale}`).not.toBeNull();

        const claimed = Number(aside![0]);
        const total = hero.headlineLineTwoAsideCounts === 'total' ? claimed : named + claimed;

        expect(total, `hero in ${locale} claims ${total} providers`).toBe(PROVIDERS.length);
    });
});

/**
 * THE SWEEP THAT COVERS src/sections AND src/pages, NOT ONLY src/data.
 *
 * Two families, both of which shipped past every guard in this file because
 * every guard in this file read src/data:
 *
 *   1. THE UNVERIFIABLE PROMISE. "Set it and forget it" was removed from
 *      SelfHost for being a flourish the reader cannot check. "Four more
 *      minutes, and then it just works" then shipped as an H2 on the homepage —
 *      same family, different file, no guard in the way. The anti-polish rule
 *      is not a style preference: a promise the reader cannot verify is the one
 *      sentence they measure the whole page against, and the section under this
 *      particular heading goes on to list four steps and a failure mode.
 *   2. THE DOUBLED ARTICLE. `CONNECTED_SERVICE_LABELS` carries "a Claude
 *      subscription" because the first sentence needs the article; a second
 *      sentence dropped the same string in after "the same" and shipped "the
 *      same a Claude subscription is selectable" in the second paragraph of the
 *      flagship agent page, on all five connected-service pages. No string in
 *      the codebase contains that phrase — only the render does — which is why
 *      this reads rendered markup rather than source.
 */
describe('every rendered page, swept for the two things a data-only guard cannot see', () => {
    it('renders every route in the table', () => {
        expect(RENDERED_PAGES).toHaveLength(ROUTES.length);
        for (const page of RENDERED_PAGES) {
            expect(page.text.length, `${page.path} rendered almost nothing`).toBeGreaterThan(400);
        }
    });

    /**
     * "out of the box" is deliberately absent from this list. "Gemini ships a
     * Vertex AI profile out of the box" is a checkable fact about a shipped
     * profile, not a promise about how the reader will feel. The test is
     * whether a claim can be disproved, not whether it is cheerful.
     */
    const UNVERIFIABLE_PROMISE =
        /\b(just works?|set it and forget it|effortless(ly)?|seamless(ly)?|magical(ly)?|zero[- ]config\w*|no configuration needed)\b/i;

    it('promises nothing the reader cannot check', () => {
        for (const page of RENDERED_PAGES) {
            const match = page.text.match(UNVERIFIABLE_PROMISE);
            expect(
                match,
                match
                    ? `${page.path} makes a promise nothing on the page can verify: ` +
                      `"${match[0]}" — ${context(page.text, match)}`
                    : '',
            ).toBeNull();
        }
    });

    /**
     * The same sweep, over the SOURCE of every section and page component.
     *
     * Rendering the route table is the better check — it sees composition — but
     * it only sees what a route reaches, and a component reached by nothing is
     * invisible to it. That is not hypothetical: the "and then it just works"
     * H2 was found in src/sections/AfterInstall.tsx, a section written for the
     * homepage and never mounted in src/pages/Home.tsx, so a guard that only
     * read rendered routes went green on the one file the line was in. (That
     * component has since been deleted — its four steps were the four steps
     * <GetStarted /> already renders — but the hole it exposed is permanent, so
     * this sweep stays.)
     *
     * Comments are stripped first. These files argue with themselves in
     * comments — every banned sentence is quoted in one, on purpose, so nobody
     * puts it back — and a guard that failed on its own explanation would be
     * deleted rather than obeyed.
     */
    it('promises nothing unverifiable in a section or page that is not mounted yet', () => {
        const roots = ['../sections', '../pages'].map((dir) => path.resolve(__dirname, dir));
        const files = roots.flatMap((root) =>
            readdirSync(root, { withFileTypes: true })
                .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
                .map((entry) => path.join(root, entry.name)),
        );
        expect(files.length, 'no components found to sweep').toBeGreaterThan(10);

        for (const file of files) {
            const code = readFileSync(file, 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, ' ')
                // Only whole-line `//` comments: a bare `//` rule would eat the
                // second half of every https:// URL in the file.
                .replace(/^\s*\/\/.*$/gm, ' ');
            const match = code.match(UNVERIFIABLE_PROMISE);
            expect(
                match,
                match
                    ? `${path.basename(file)} promises "${match[0]}", which nothing on the page ` +
                      `can verify — ${context(code, match)}`
                    : '',
            ).toBeNull();
        }
    });

    /**
     * "the a", and also "the same a" — the one that actually shipped. A
     * determiner phrase can carry a modifier before the noun slot ("the same",
     * "the very", "that exact"), and the label being interpolated into that
     * slot brings its own article. Matching only adjacent articles would have
     * let the live defect through, which it did while this regex was being
     * written.
     */
    const DOUBLED_ARTICLE = /\b(a|an|the)(\s+(same|very|exact|identical|only))?\s+(a|an|the)\b/i;

    it('never renders two articles in a row', () => {
        for (const page of RENDERED_PAGES) {
            const match = page.text.match(DOUBLED_ARTICLE);
            expect(
                match,
                match
                    ? `${page.path} renders "${match[0]}" — a determiner in the sentence meeting ` +
                      `one baked into a label. ${context(page.text, match)}`
                    : '',
            ).toBeNull();
        }
    });
});
