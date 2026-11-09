import { readPluginTranslationResources } from '../../../../../scripts/testing/readPluginTranslationResources.js';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TRANSLATED_TRIAGE_EMPTY_KINDS_V1, readTriageListEmptyStateKeys } from './shell/emptyState.js';

const PACKAGED_UI_TRANSLATIONS = readPluginTranslationResources(new URL('../../', import.meta.url));


const LOCALES = Object.keys(PACKAGED_UI_TRANSLATIONS) as readonly (keyof typeof PACKAGED_UI_TRANSLATIONS)[];
const CATALOGS = [
    { id: 'triage', root: new URL('..', import.meta.url), messages: PACKAGED_UI_TRANSLATIONS },
    ...[
        { id: 'linear', root: new URL('../../../linear/src/', import.meta.url) },
        { id: 'jira', root: new URL('../../../jira/src/', import.meta.url) },
    ].map(({ id, root }) => ({
        id, root, messages: readPluginTranslationResources(new URL('../', root)),
    })),
];

describe('the Triage UI catalog', () => {
    it.each(CATALOGS)('$id carries the same keys in every first-party locale', ({ messages }) => {
        // A key present only in `en` renders English on every other device and
        // nothing fails, so the drift has to be asserted rather than noticed.
        const english = Object.keys(messages.en!).sort();
        expect(LOCALES.length).toBeGreaterThan(1);
        expect(Object.keys(messages).sort()).toEqual([...LOCALES].sort());
        for (const locale of LOCALES) {
            expect(Object.keys(messages[locale]!).sort(), locale).toEqual(english);
        }
    });

    it.each(CATALOGS)('$id defines every catalog key the surfaces actually ask for', ({ id, root: sourceRoot, messages }) => {
        // The parity test above compares locales against `en`, so a key missing
        // from `en` ENTIRELY is invisible to it: absent everywhere reads as
        // agreement. That is not hypothetical — five `surface.session.*` keys
        // shipped referenced-but-undefined and would have rendered untranslated
        // on every non-English locale, and no existing test failed.
        //
        // So the keys are read from the source that asks for them, not from a
        // hand-kept list that drifts the same way the catalog did.
        const root = fileURLToPath(sourceRoot);
        const referenced = new Set<string>();
        const walk = (dir: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) { walk(path); continue; }
                if (!/\.tsx?$/u.test(entry.name) || /\.test\.|\.test-support\./u.test(entry.name)) continue;
                const source = readFileSync(path, 'utf8');
                // Two shapes, because the surfaces use both and the narrower one
                // alone missed a real defect: `titleKey="..."` props AND direct
                // `text('plugins.triage...', 'fallback')` calls. Matching any
                // catalog-key literal covers both and anything added later,
                // rather than enumerating call shapes that keep growing.
                for (const match of source.matchAll(/['"](plugins\.[A-Za-z0-9._-]+)['"]/gu)) {
                    if (match[1]?.startsWith(`plugins.${id}.`)) referenced.add(match[1]);
                }
            }
        };
        walk(root);

        // A scan that finds nothing would pass this test without asserting
        // anything, so the scan itself is asserted first.
        expect(referenced.size).toBeGreaterThan(id === 'triage' ? 20 : 0);

        const english = messages.en!;
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
                const messages: Readonly<Record<string, string>> = PACKAGED_UI_TRANSLATIONS[locale];
                expect(messages[keys.title], `${locale} ${kind} title`).toEqual(expect.any(String));
                expect(messages[keys.description], `${locale} ${kind} description`)
                    .toEqual(expect.any(String));
            }
        }
    });
});
