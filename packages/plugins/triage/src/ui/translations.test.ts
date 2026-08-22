import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TRANSLATED_TRIAGE_EMPTY_KINDS_V1, readTriageListEmptyStateKeys } from './shell/emptyState.js';
import { TRIAGE_UI_TRANSLATIONS } from './translations.js';


const LOCALES = Object.keys(TRIAGE_UI_TRANSLATIONS) as readonly (keyof typeof TRIAGE_UI_TRANSLATIONS)[];

describe('the Triage UI catalog', () => {
    it('carries the same keys in every locale it ships', () => {
        // A key present only in `en` renders English on every other device and
        // nothing fails, so the drift has to be asserted rather than noticed.
        const english = Object.keys(TRIAGE_UI_TRANSLATIONS.en).sort();
        expect(LOCALES.length).toBeGreaterThan(1);
        for (const locale of LOCALES) {
            expect(Object.keys(TRIAGE_UI_TRANSLATIONS[locale]).sort(), locale).toEqual(english);
        }
    });

    it('defines every catalog key the surfaces actually ask for', () => {
        // The parity test above compares locales against `en`, so a key missing
        // from `en` ENTIRELY is invisible to it: absent everywhere reads as
        // agreement. That is not hypothetical — five `surface.session.*` keys
        // shipped referenced-but-undefined and would have rendered untranslated
        // on all ten non-English locales, and no existing test failed.
        //
        // So the keys are read from the source that asks for them, not from a
        // hand-kept list that drifts the same way the catalog did.
        const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
        const referenced = new Set<string>();
        const walk = (dir: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) { walk(path); continue; }
                if (!/\.tsx?$/u.test(entry.name) || /\.test\.|\.test-support\./u.test(entry.name)) continue;
                const source = readFileSync(path, 'utf8');
                for (const match of source.matchAll(
                    /\b(?:title|label|value|description|placeholder)Key\s*[:=]\s*['"]([^'"]+)['"]/gu,
                )) {
                    if (match[1] !== undefined && match[1].startsWith('plugins.triage.')) referenced.add(match[1]);
                }
            }
        };
        walk(root);

        // A scan that finds nothing would pass this test without asserting
        // anything, so the scan itself is asserted first.
        expect(referenced.size).toBeGreaterThan(20);

        const english: Readonly<Record<string, string>> = TRIAGE_UI_TRANSLATIONS.en;
        const missing = [...referenced].filter((key) => english[key] === undefined).sort();
        expect(missing).toEqual([]);
    });

    it('translates every empty slot the list can resolve', () => {
        // The empty state decides its own catalog keys, so this is the one
        // place the kinds and the catalog are compared. A kind added without
        // copy is the invisible-filter failure again: the reader is told
        // something about their lens in a language they did not choose.
        for (const kind of TRANSLATED_TRIAGE_EMPTY_KINDS_V1) {
            const keys = readTriageListEmptyStateKeys(kind);
            for (const locale of LOCALES) {
                const messages: Readonly<Record<string, string>> = TRIAGE_UI_TRANSLATIONS[locale];
                expect(messages[keys.title], `${locale} ${kind} title`).toEqual(expect.any(String));
                expect(messages[keys.description], `${locale} ${kind} description`)
                    .toEqual(expect.any(String));
            }
        }
    });
});
