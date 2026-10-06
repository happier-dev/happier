import { describe, expect, it } from 'vitest';

import { flattenTranslationLeaves } from '../../../tools/i18n/translationAudit';

import { sessionAgentActivityTranslations } from './sessionAgentActivityTranslations';

describe('sessionAgentActivityTranslations', () => {
    it('carries the Agent-activity status and attention vocabulary in every supported locale', () => {
        const { en, ...localesByCode } = sessionAgentActivityTranslations;
        const locales = Object.entries(localesByCode).map(([code, root]) => ({ code, root }));
        const expectedLeaves = flattenTranslationLeaves(en)
            .map((leaf) => `${leaf.key}:${leaf.kind}`)
            .sort();

        expect(locales.map((locale) => locale.code).sort()).toEqual([
            'ca', 'de', 'es', 'fr', 'it', 'ja', 'pl', 'pt', 'ru', 'zhHans', 'zhHant',
        ]);

        const shapeMismatches = locales.flatMap(({ code, root }) => {
            const actualLeaves = flattenTranslationLeaves(root)
                .map((leaf) => `${leaf.key}:${leaf.kind}`)
                .sort();
            return JSON.stringify(actualLeaves) === JSON.stringify(expectedLeaves)
                ? []
                : [`${code}: Agent-activity translation shape differs from English`];
        });

        expect(shapeMismatches).toEqual([]);
    });

    it('localizes the spoken row summaries instead of reusing the English composition', () => {
        const { en, ...localesByCode } = sessionAgentActivityTranslations;
        const sample = { title: 'Delegate', status: 'X', attention: 'Y' };

        // Every locale must compose its own spoken row; a locale that returned the English
        // composition verbatim would read the English separator/order aloud.
        const inherited = Object.entries(localesByCode).flatMap(([code, root]) => [
            root.summaryA11y(sample).includes(sample.title) ? null : `${code}: summaryA11y drops the title`,
            root.summaryAttentionA11y(sample).includes(sample.attention)
                ? null
                : `${code}: summaryAttentionA11y drops the attention phrase`,
        ].filter((failure): failure is string => failure !== null));

        expect(inherited).toEqual([]);
        expect(sessionAgentActivityTranslations.ja.summaryA11y(sample)).not.toBe(en.summaryA11y(sample));
        expect(sessionAgentActivityTranslations.zhHans.summaryA11y(sample)).not.toBe(en.summaryA11y(sample));
    });
});
