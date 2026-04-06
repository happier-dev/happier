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
});
