import { afterEach, describe, expect, it } from 'vitest';

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

    it('falls back to canonical English for bundled keys missing from the active locale', () => {
        i18n.setPreferredLanguageFromSettings('es');

        expect(i18n.t('plugins.inspector.title')).toBe('Plugin Inspector');
        expect(i18n.t('agentInput.connectedServiceLabel.gemini')).toBe('Google Gemini');
    });
});
