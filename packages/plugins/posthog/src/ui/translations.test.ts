import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../manifest.js';

/**
 * The PostHog surface catalog, guarded.
 *
 * Every key this plugin's surfaces ask for is resolved against the mounting plugin's own
 * declared bundle, never a merged host catalogue. A key present in `en` and missing from
 * the other ten locales therefore renders the author's English fallback for those
 * readers, and a key missing everywhere renders whatever fallback the call site happened
 * to inline — both silently. Nothing fails, no test notices, and the first report comes
 * from a reader who cannot read their own settings page.
 *
 * That is why this is asserted from two directions at once: the locales are compared
 * against each other, and the key set is read out of the source that ASKS for the keys
 * rather than out of a hand-kept list that drifts exactly the way a catalog does.
 */

type Messages = Readonly<Record<string, string | undefined>>;

const TRANSLATIONS = PLUGIN_MANIFEST.contributes.ui.translations;

function messagesFor(locale: string): Messages {
    const entry = TRANSLATIONS.find((row) => row.locale === locale);
    if (entry === undefined) throw new Error(`manifest declares no ${locale} translations`);
    return entry.messages;
}

const LOCALES: readonly string[] = TRANSLATIONS.map((row) => row.locale);
const ENGLISH = messagesFor('en');

describe('the PostHog surface catalog', () => {
    it('ships the same keys in every locale the manifest declares', () => {
        expect(LOCALES).toContain('en');
        expect(LOCALES.length).toBeGreaterThan(1);
        const english = Object.keys(ENGLISH).sort();
        expect(english.length).toBeGreaterThan(40);
        for (const locale of LOCALES) {
            expect(Object.keys(messagesFor(locale)).sort(), locale).toEqual(english);
        }
    });

    it('defines every key literal the surfaces actually ask for', () => {
        // The parity case above compares each locale against `en`, so a key missing from
        // `en` ENTIRELY is invisible to it: absent everywhere reads as agreement.
        const root = fileURLToPath(new URL('..', import.meta.url));
        const referenced = new Set<string>();
        const walk = (dir: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(path);
                    continue;
                }
                if (!/\.tsx?$/u.test(entry.name) || /\.test\./u.test(entry.name)) continue;
                // Both shapes the surfaces use: `titleKey="…"`/`valueKey="…"` props and
                // direct `text('plugins.posthog…', 'fallback')` calls. Matching any
                // catalog-key literal covers both, and anything added later.
                for (const match of readFileSync(path, 'utf8')
                    .matchAll(/['"](plugins\.posthog\.[A-Za-z0-9._-]+)['"]/gu)) {
                    if (match[1] !== undefined) referenced.add(match[1]);
                }
            }
        };
        walk(root);

        // A scan that found nothing would pass while asserting nothing.
        expect(referenced.size).toBeGreaterThan(40);
        expect([...referenced].filter((key) => ENGLISH[key] === undefined).sort()).toEqual([]);
    });

    it('does not leave authored metadata labels as raw literals in renderers', () => {
        const root = fileURLToPath(new URL('.', import.meta.url));
        for (const relative of ['renderSurface.tsx', 'settings/renderSettingsSurface.tsx']) {
            expect(readFileSync(join(root, relative), 'utf8'), relative).not.toMatch(/\blabel:\s*['"]/u);
        }
    });
});
