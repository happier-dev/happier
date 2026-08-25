import { describe, expect, it } from 'vitest';

import { ca } from './translations/ca';
import { de } from './translations/de';
import { en } from './translations/en';
import { es } from './translations/es';
import { fr } from './translations/fr';
import { it as itTranslations } from './translations/it';
import { ja } from './translations/ja';
import { pl } from './translations/pl';
import { pt } from './translations/pt';
import { ru } from './translations/ru';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';

const locales = {
  ca,
  de,
  es,
  fr,
  it: itTranslations,
  ja,
  pl,
  pt,
  ru,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
} as const;

describe('native Voice model option translations', () => {
  it('provides every built-in model title and description without English fallback copy', () => {
    const english = en.settingsVoice.local.models.nativeOptions;

    for (const [locale, translations] of Object.entries(locales)) {
      const localized = translations.settingsVoice.local.models.nativeOptions;
      for (const key of Object.keys(english) as Array<keyof typeof english>) {
        expect(localized[key].trim(), `${locale}.${key} should be present`).not.toBe('');
        expect(localized[key], `${locale}.${key} should be localized`).not.toBe(english[key]);
      }
    }
  });
});
