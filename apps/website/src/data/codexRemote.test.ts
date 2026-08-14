import { describe, expect, it } from 'vitest';

import { AGENTS } from './agents';
import { CODEX_COMPARISON_ROWS, CODEX_SCOPE_LIMIT, CODEX_SECTION } from './codexRemote';

/**
 * Copy guards for /vs/codex-remote.
 *
 * These mirror the discipline in copyClaims.test.ts for the Remote Control page,
 * plus the three failures that are specific to writing about OpenAI's surface:
 *
 *   1. INVENTING A PRODUCT NAME. There is no "Codex Mobile". OpenAI put Codex
 *      inside the ChatGPT mobile app and named the feature Remote. A visitor who
 *      uses Codex daily knows this, and a made-up capitalised product name is
 *      the fastest way to be dismissed by exactly the reader this page is for.
 *   2. RECOMMENDING THE COMPETITOR IN THE IMPERATIVE. Conceding accurately is
 *      the job. Telling the reader to go and set the other thing up is a
 *      different act, and it shipped once already.
 *   3. CLAIMING HAPPIER FIXES SOMETHING IT ALSO SUFFERS. The sleeping-computer
 *      condition applies to both, and the copy has to say so.
 */

const ALL_CODEX_COPY = [
    CODEX_SECTION.concession,
    CODEX_SECTION.turn,
    CODEX_SCOPE_LIMIT.heading,
    CODEX_SCOPE_LIMIT.body,
    ...CODEX_SECTION.strengths.flatMap((item) => [item.title, item.body]),
    ...CODEX_SECTION.conditions.flatMap((item) => [item.when, item.codex, item.happier]),
    ...CODEX_SECTION.arguments.flatMap((item) => [item.title, item.body]),
    ...CODEX_COMPARISON_ROWS.flatMap((row) => [row.capability, row.codex, row.happier]),
].join('\n');

describe('Codex comparison evidence discipline', () => {
    // Rows stating a CONSTRAINT on OpenAI's surface must attribute it. Rows
    // stating a neutral fact (price, first-party, agent count) need no
    // attribution because they are not adverse claims.
    const ADVERSE = ['hostOs', 'setup', 'workspace'];

    it('attributes every adverse Codex claim to OpenAI docs', () => {
        for (const id of ADVERSE) {
            const row = CODEX_COMPARISON_ROWS.find((r) => r.id === id);
            expect(row, `missing comparison row: ${id}`).toBeDefined();
            expect(row!.codex, `row "${id}" states a constraint without attribution`).toMatch(
                /per OpenAI docs/i,
            );
        }
    });

    it('attributes every documented condition to OpenAI’s own documentation', () => {
        for (const item of CODEX_SECTION.conditions) {
            expect(item.codex, `condition "${item.id}" is unattributed`).toMatch(/OpenAI’s (docs|setup steps|remote-connections page)|OpenAI’s documentation/i);
        }
    });

    it('never editorialises about Codex quality', () => {
        const banned = /\b(worse|inferior|crippled|limited to|only works|useless|broken|toy|clunky)\b/i;
        for (const row of CODEX_COMPARISON_ROWS) {
            expect(row.codex, `row "${row.id}" editorialises`).not.toMatch(banned);
        }
        for (const item of CODEX_SECTION.conditions) {
            expect(item.codex, `condition "${item.id}" editorialises`).not.toMatch(banned);
        }
    });

    it('concedes substantively before qualifying anything', () => {
        expect(CODEX_SECTION.concession.length).toBeGreaterThan(280);
        // The concession has to name the setup the vendor surface fully covers.
        expect(CODEX_SECTION.concession).toMatch(/complete answer/i);
        // …and the table must keep the rows the vendor wins.
        expect(CODEX_COMPARISON_ROWS.some((r) => r.id === 'firstParty')).toBe(true);
        expect(CODEX_COMPARISON_ROWS.some((r) => r.id === 'cloud')).toBe(true);
    });
});

describe('the page never invents a product name', () => {
    // "Codex Mobile" / "Codex Phone" / "Codex App" as a capitalised product.
    // "the ChatGPT mobile app" and "from your phone" are descriptions and stay.
    it('does not christen a Codex mobile product', () => {
        expect(ALL_CODEX_COPY).not.toMatch(/\bCodex (Mobile|Phone|App|Remote Control)\b/);
    });

    it('uses OpenAI’s own name for the feature it is describing', () => {
        expect(ALL_CODEX_COPY).toMatch(/\bRemote\b/);
        expect(ALL_CODEX_COPY).toMatch(/ChatGPT (mobile )?app/i);
    });
});

describe('the page concedes without recommending the competitor', () => {
    // The failure mode is an IMPERATIVE — "use it", "go and set it up", "you
    // should use Codex Remote". Indicative statements of fit ("that is a
    // complete answer") are the honest form and must survive.
    it('issues no instruction to go and use the other product', () => {
        expect(ALL_CODEX_COPY).not.toMatch(
            /\b(use it|use that instead|go and use|you should use|stick with (it|Codex)|just use)\b/i,
        );
    });

    it('does not hedge a true present-tense fact with speculation about the future', () => {
        expect(ALL_CODEX_COPY).not.toMatch(/\b(for now|at the moment|for the time being)\b/i);
    });
});

describe('the page does not claim Happier fixes what Happier also suffers', () => {
    it('says plainly that a sleeping computer runs nothing, on both sides', () => {
        const asleep = CODEX_SECTION.conditions.find((item) => item.id === 'awake');
        expect(asleep, 'the sleeping-computer condition was removed').toBeDefined();
        expect(asleep!.happier).toMatch(/does not solve this/i);
    });

    it('does not claim a cloud capability Happier has no equivalent of', () => {
        const cloud = CODEX_COMPARISON_ROWS.find((row) => row.id === 'cloud');
        expect(cloud!.happier).toMatch(/not offered/i);
    });
});

describe('agent-count claims track the shipped registry', () => {
    // Hardcoding "13" here is how the count goes stale in one file while
    // /agents renders another number. Both strings are generated.
    it('counts agents from AGENTS rather than from a typed number', () => {
        expect(CODEX_SCOPE_LIMIT.body).toContain(`${AGENTS.length} vendors’ agents`);
        expect(CODEX_COMPARISON_ROWS.find((row) => row.id === 'agents')!.happier).toContain(
            `${AGENTS.length} agents`,
        );
        expect(CODEX_SECTION.turn).toContain(`${AGENTS.length - 1} other agents`);
    });
});
