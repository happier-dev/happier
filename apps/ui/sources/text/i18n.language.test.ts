import { afterEach, describe, expect, it } from 'vitest';

import { es } from './translations/es';
import { en } from './translations/en';
import * as i18n from './i18n';

describe('text/i18n language state', () => {
    afterEach(() => {
        i18n.setPreferredLanguageFromSettings(null);
    });

    it('reports the active preferred language after settings changes', () => {
        expect(typeof i18n.getPreferredLanguage).toBe('function');
        expect(i18n.getPreferredLanguage()).toBe('en');

        i18n.setPreferredLanguageFromSettings('es');

        expect(i18n.getPreferredLanguage()).toBe('es');
    });

    it('resolves a non-default language from its own tree and reverts when cleared', () => {
        // Locale trees are materialised lazily; this is the case that breaks if a deferred tree is
        // never resolved and the lookup silently falls through to English.
        expect(es.tabs.inbox).not.toBe(en.tabs.inbox);

        i18n.setPreferredLanguageFromSettings('es');
        expect(i18n.t('tabs.inbox')).toBe(es.tabs.inbox);

        i18n.setPreferredLanguageFromSettings(null);
        expect(i18n.t('tabs.inbox')).toBe(en.tabs.inbox);
    });

    it('resolves the host-owned form submit label from the active locale', () => {
        expect(en.common.submit).toBe('Submit');
        expect(es.common.submit).toBe('Enviar');

        i18n.setPreferredLanguageFromSettings('es');
        expect(i18n.t('common.submit')).toBe(es.common.submit);
    });

    it('keeps translations when the requested language is not supported', () => {
        i18n.setPreferredLanguageFromSettings('kl');

        expect(i18n.getPreferredLanguage()).toBe('en');
        expect(i18n.t('tabs.inbox')).toBe(en.tabs.inbox);
    });

    it('falls back to canonical English for bundled keys missing from the active locale', () => {
        i18n.setPreferredLanguageFromSettings('es');

        expect(i18n.t('plugins.inspector.title')).toBe('Plugin Inspector');
        expect(i18n.t('agentInput.connectedServiceLabel.gemini')).toBe('Google Gemini');
    });
});
