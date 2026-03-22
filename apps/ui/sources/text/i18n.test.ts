import { describe, expect, it } from 'vitest';

import { en } from './translations/en';
import { hasTranslation, t, tLoose } from './i18n';

describe('text/i18n', () => {
    it('translates the default language and nested function entries', () => {
        expect(t('tabs.inbox')).toBe(en.tabs.inbox);
        expect(t('promptLibrary.profileStacksSubtitle', { count: 2 })).toBe(en.promptLibrary.profileStacksSubtitle({ count: 2 }));
        expect(tLoose('tabs.inbox')).toBe(en.tabs.inbox);
    });

    it('reports missing keys without throwing', () => {
        expect(hasTranslation('tabs.inbox')).toBe(true);
        expect(hasTranslation('not.a.real.key')).toBe(false);
        expect(tLoose('not.a.real.key')).toBe('not.a.real.key');
    });
});
