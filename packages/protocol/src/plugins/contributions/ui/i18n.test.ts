import { describe, expect, it } from 'vitest';

import {
    PluginUiLocaleCodeV1Schema,
    PluginUiTranslationsContributionV1Schema,
} from './i18n.js';

describe('PluginUiLocaleCodeV1Schema', () => {
    it('accepts base language codes', () => {
        for (const locale of ['en', 'es', 'ca', 'it', 'pt', 'pl', 'ru', 'ja']) {
            expect(PluginUiLocaleCodeV1Schema.safeParse(locale).success).toBe(true);
        }
    });

    it('accepts BCP-47 script subtags the app actually ships (zh-Hans / zh-Hant)', () => {
        // The host app ships `zh-Hans` and `zh-Hant`; a plugin must be able to
        // localize for the exact locale codes the UI resolves against, or those
        // users silently fall back to English.
        expect(PluginUiLocaleCodeV1Schema.safeParse('zh-Hans').success).toBe(true);
        expect(PluginUiLocaleCodeV1Schema.safeParse('zh-Hant').success).toBe(true);
    });

    it('accepts region subtags (uppercase / numeric)', () => {
        expect(PluginUiLocaleCodeV1Schema.safeParse('en-US').success).toBe(true);
        expect(PluginUiLocaleCodeV1Schema.safeParse('pt-BR').success).toBe(true);
        expect(PluginUiLocaleCodeV1Schema.safeParse('es-419').success).toBe(true);
    });

    it('rejects malformed locale codes', () => {
        for (const locale of ['EN', 'english', 'zh_Hant', 'zh-hant', '', 'zh-Hanti']) {
            expect(PluginUiLocaleCodeV1Schema.safeParse(locale).success).toBe(false);
        }
    });
});

describe('PluginUiTranslationsContributionV1Schema', () => {
    it('accepts a contribution localized for the full shipped app locale set', () => {
        const result = PluginUiTranslationsContributionV1Schema.safeParse({
            defaultLocale: 'en',
            locales: {
                en: { 'a.title': 'A' },
                'zh-Hans': { 'a.title': 'A' },
                'zh-Hant': { 'a.title': 'A' },
            },
        });
        expect(result.success).toBe(true);
    });
});
