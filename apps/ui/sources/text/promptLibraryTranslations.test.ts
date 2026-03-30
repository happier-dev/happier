import { describe, expect, it } from 'vitest';

import { ca } from './translations/ca';
import { en } from './translations/en';
import { es } from './translations/es';
import { it as itLocale } from './translations/it';
import { ja } from './translations/ja';
import { pl } from './translations/pl';
import { pt } from './translations/pt';
import { ru } from './translations/ru';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';

describe('prompt library translation keys', () => {
    it('ships the duplicate key in every locale', () => {
        const locales = [en, ru, pl, es, itLocale, pt, ca, zhHans, zhHant, ja];
        for (const locale of locales) {
            expect((locale as any)?.common?.duplicate).toEqual(expect.any(String));
            expect(String((locale as any).common.duplicate).trim().length).toBeGreaterThan(0);
        }
    });
});
