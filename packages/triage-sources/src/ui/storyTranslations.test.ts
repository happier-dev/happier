import { describe, expect, it } from 'vitest';

import { TRIAGE_STORY_PLURAL_KEYS_V1, triageDetailStoryTranslations } from './storyTranslations.js';

const LOCALES = ['en', 'ru', 'pl', 'es', 'fr', 'it', 'pt', 'ca', 'zh-Hans', 'zh-Hant', 'ja', 'de'] as const;

describe('the shared story catalog', () => {
  it('defines every plural form a locale selects for a whole count', () => {
    for (const locale of LOCALES) {
      const messages = triageDetailStoryTranslations(locale);
      const rules = new Intl.PluralRules(locale);
      for (const base of TRIAGE_STORY_PLURAL_KEYS_V1) {
        expect(messages[`plugins.triage.detailStory.${base}.other`], `${locale} ${base}.other`).toBeTypeOf('string');
        for (const count of [0, 1, 2, 3, 5, 11, 21, 22, 25, 101, 112]) {
          const form = rules.select(count);
          expect(messages[`plugins.triage.detailStory.${base}.${form}`], `${locale} ${base}.${form}`).toContain('{count}');
        }
      }
    }
  });
});
