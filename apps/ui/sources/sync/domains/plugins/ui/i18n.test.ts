import { describe, expect, it } from 'vitest';

import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
} from './projection';
import {
    createPluginLocalizedTextResolver,
    resolvePluginLocalizedText,
} from './i18n';

const pluginId = 'acme.review';

const projection = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    translationsByPluginId: {
        [pluginId]: {
            id: `translations:${pluginId}`,
            pluginId,
            contributionKind: 'translations' as const,
            locales: ['en', 'fr'],
            bundles: {
                en: {
                    'review.dashboard.title': 'Review dashboard',
                },
                fr: {
                    'review.dashboard.title': 'Tableau de revue',
                },
            },
        },
    },
} satisfies PluginUiProjectionModel;

describe('resolvePluginLocalizedText', () => {
    it('uses the preferred plugin locale, then English, then the developer fallback', () => {
        const value = {
            key: 'review.dashboard.title',
            fallback: 'Review dashboard fallback',
        };

        expect(resolvePluginLocalizedText({ projection, pluginId, value, locale: 'fr' }))
            .toBe('Tableau de revue');
        expect(resolvePluginLocalizedText({ projection, pluginId, value, locale: 'de' }))
            .toBe('Review dashboard');
        expect(resolvePluginLocalizedText({
            projection,
            pluginId,
            value: { key: 'review.dashboard.missing', fallback: 'Developer fallback' },
            locale: 'fr',
        })).toBe('Developer fallback');
    });

    it('binds locale-specific resolvers without changing authored literals', () => {
        const french = createPluginLocalizedTextResolver({ projection, locale: 'fr' });
        const english = createPluginLocalizedTextResolver({ projection, locale: 'en' });
        const keyed = { key: 'review.dashboard.title', fallback: 'Review dashboard fallback' };

        expect(french(pluginId, keyed)).toBe('Tableau de revue');
        expect(english(pluginId, keyed)).toBe('Review dashboard');
        expect(french(pluginId, 'Authored literal')).toBe('Authored literal');
    });
});
