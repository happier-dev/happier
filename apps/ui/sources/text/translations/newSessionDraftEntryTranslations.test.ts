import { describe, expect, it } from 'vitest';

import { ca } from './ca';
import { de } from './de';
import { en } from './en';
import { es } from './es';
import { fr } from './fr';
import { it as itTranslations } from './it';
import { ja } from './ja';
import { pl } from './pl';
import { pt } from './pt';
import { ru } from './ru';
import { zhHans } from './zh-Hans';
import { zhHant } from './zh-Hant';

const locales = {
    ca,
    de,
    es,
    fr,
    it: itTranslations,
    ja,
    pl,
    pt,
    ru,
    'zh-Hans': zhHans,
    'zh-Hant': zhHant,
} as const;

describe('new session draft entry translations', () => {
    it('provides localized copy rather than English fallbacks in every supported non-English locale', () => {
        const english = en.settingsSession.newSessionDraftEntry;

        for (const [locale, translations] of Object.entries(locales)) {
            const localized = translations.settingsSession.newSessionDraftEntry;
            for (const key of Object.keys(english) as Array<keyof typeof english>) {
                expect(localized[key].trim(), `${locale}.${key} should be present`).not.toBe('');
                expect(localized[key], `${locale}.${key} should be localized`).not.toBe(english[key]);
            }
        }
    });
});
