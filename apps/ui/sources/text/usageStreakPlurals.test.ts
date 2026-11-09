import { describe, expect, it } from 'vitest';

import { ca } from './translations/ca';
import { de } from './translations/de';
import { en } from './translations/en';
import { es } from './translations/es';
import { fr } from './translations/fr';
import { it as itLocale } from './translations/it';
import { pt } from './translations/pt';

// "Longest streak: 1 days" (Usage r10): a count of one takes the singular in every locale that inflects it.
describe('Usage longest-streak plurals', () => {
    it.each([['en', en], ['de', de], ['fr', fr], ['es', es], ['it', itLocale], ['pt', pt], ['ca', ca]] as const)('inflects the day count in %s', (_name, locale) => {
        const line = locale.usage.board.howYouWork.longestStreak;
        expect(line({ count: 1 })).not.toBe(line({ count: 2 }).replace('2', '1'));
    });
});
