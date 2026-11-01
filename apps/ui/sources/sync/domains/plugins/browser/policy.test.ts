import { describe, expect, it } from 'vitest';

import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginBrowserProjectionEntry } from './targets';
import { resolvePluginBrowserPolicyDecision } from './policy';

const disabledBrowserAction = {
    id: 'browserAction:acme.preview:open-preview',
    pluginId: 'acme.preview',
    contributionKind: 'browserAction',
    availability: {
        disabledWhen: {
            fact: 'host.platform',
            operator: 'equals',
            value: 'web',
        },
        disabledReason: {
            key: 'browser.preview.desktopOnly',
            fallback: 'Open preview is available on desktop only.',
        },
    },
} satisfies PluginBrowserProjectionEntry;

describe('resolvePluginBrowserPolicyDecision', () => {
    it('resolves a keyed disabled reason through the plugin locale before falling back', () => {
        const projection: PluginUiProjectionModel = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            translationsByPluginId: {
                'acme.preview': {
                    id: 'translations:acme.preview',
                    pluginId: 'acme.preview',
                    contributionKind: 'translations',
                    locales: ['fr'],
                    bundles: { fr: { 'browser.preview.desktopOnly': 'Ouvrir l’aperçu est disponible uniquement sur ordinateur.' } },
                },
            },
        };
        const localize = createPluginLocalizedTextResolver({ projection, locale: 'fr' });
        expect(resolvePluginBrowserPolicyDecision(disabledBrowserAction, { platform: 'web' }, localize).unavailableReason)
            .toBe('Ouvrir l’aperçu est disponible uniquement sur ordinateur.');

        const english = createPluginLocalizedTextResolver({ projection, locale: 'en' });
        expect(resolvePluginBrowserPolicyDecision(disabledBrowserAction, { platform: 'web' }, english).unavailableReason)
            .toBe('Open preview is available on desktop only.');
    });
});
