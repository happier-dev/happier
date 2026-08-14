import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { siteDataFor } from './siteData';
import { applyOverlay, walkStrings } from './overlay';
import { AGENTS } from '../data/agents';

/**
 * The failure this suite exists to catch is a SILENT one.
 *
 * If the extractor emits `agents.AGENTS.claude.lead.0` and the runtime looks the
 * string up under a different id — because the two walks disagree, or because a
 * module is missing from the registry in siteData.ts — nothing throws. The
 * override simply never matches and the string renders in English forever, in
 * every locale, with a green build and a full-looking catalogue.
 *
 * So: assert the ids round-trip, and assert that a substitution actually lands.
 */
describe('data-module translation overlay', () => {
    const catalogue: Record<string, string> = JSON.parse(
        readFileSync(path.join(process.cwd(), 'src/i18n/generated/en.json'), 'utf8'),
    );

    it('has a generated catalogue to work from', () => {
        expect(Object.keys(catalogue).length).toBeGreaterThan(500);
    });

    it('reaches every extracted id from the runtime registry', () => {
        const en = siteDataFor('en');
        const reachable = new Set<string>();
        for (const [ns, mod] of Object.entries(en)) {
            for (const [exportName, value] of Object.entries(mod as Record<string, unknown>)) {
                if (typeof value === 'function') continue;
                for (const visit of walkStrings(value, `${ns}.${exportName}`)) reachable.add(visit.id);
            }
        }

        const missing = Object.keys(catalogue).filter((id) => !reachable.has(id));
        expect(
            missing.slice(0, 5),
            `${missing.length} extracted ids are unreachable at runtime — the module is probably ` +
                'missing from MODULES in src/i18n/siteData.ts, so those strings would stay English ' +
                'in every locale with nothing failing',
        ).toEqual([]);
    });

    it('returns the English modules by identity, with no clone', () => {
        // This is what lets the locale dimension ship while every route is still
        // English-only: if `en` allocated a new object graph, dist/ could change
        // for reasons unrelated to any translation.
        expect(siteDataFor('en').agents.AGENTS).toBe(AGENTS);
    });

    it('substitutes a translated string and leaves the rest alone', () => {
        const id = 'agents.AGENTS.claude.h1';
        expect(catalogue[id], `${id} is not in the catalogue — pick another id for this test`).toBeTypeOf(
            'string',
        );

        const translated = applyOverlay(AGENTS, { [id]: '在手机上运行 Claude Code' }, 'agents.AGENTS');
        const claude = translated.find((a) => a.id === 'claude')!;
        const original = AGENTS.find((a) => a.id === 'claude')!;

        expect(claude.h1).toBe('在手机上运行 Claude Code');
        // Untouched siblings keep English, and the SOURCE is not mutated.
        expect(claude.standfirst).toBe(original.standfirst);
        expect(original.h1).not.toBe('在手机上运行 Claude Code');
    });

    it('never translates an identifier, a binary name or a URL', () => {
        // These are rendered but must survive byte-identical. The denylist in
        // overlay.ts keeps them out of the catalogue entirely, which is stricter
        // than shipping them and hoping a do-not-translate rule holds.
        const ids = Object.keys(catalogue);
        for (const agent of AGENTS) {
            expect(ids).not.toContain(`agents.AGENTS.${agent.id}.binary`);
            expect(ids).not.toContain(`agents.AGENTS.${agent.id}.id`);
            expect(ids).not.toContain(`agents.AGENTS.${agent.id}.slug`);
        }
        expect(ids.some((id) => catalogue[id].startsWith('https://'))).toBe(false);
    });

    it('keeps an unknown or blank override from blanking the page', () => {
        const withJunk = applyOverlay(
            AGENTS,
            { 'agents.AGENTS.nope.h1': 'x', 'agents.AGENTS.claude.h1': '   ' },
            'agents.AGENTS',
        );
        const claude = withJunk.find((a) => a.id === 'claude')!;
        expect(claude.h1).toBe(AGENTS.find((a) => a.id === 'claude')!.h1);
    });
});
