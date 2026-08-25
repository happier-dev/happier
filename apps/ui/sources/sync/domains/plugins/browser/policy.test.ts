import { describe, expect, it } from 'vitest';

import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
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
        let locale: 'en' | 'fr' = 'fr';
        const localize: PluginLocalizedTextResolver = (_pluginId, value) => {
            if (typeof value === 'string') return value;
            const fallback = value && typeof value === 'object' && !Array.isArray(value)
                && typeof value.fallback === 'string'
                ? value.fallback
                : '';
            return locale === 'fr' ? 'Ouvrir l’aperçu est disponible uniquement sur ordinateur.' : fallback;
        };
        expect(resolvePluginBrowserPolicyDecision(disabledBrowserAction, { platform: 'web' }, localize).unavailableReason)
            .toBe('Ouvrir l’aperçu est disponible uniquement sur ordinateur.');

        locale = 'en';
        expect(resolvePluginBrowserPolicyDecision(disabledBrowserAction, { platform: 'web' }, localize).unavailableReason)
            .toBe('Open preview is available on desktop only.');
    });
});
