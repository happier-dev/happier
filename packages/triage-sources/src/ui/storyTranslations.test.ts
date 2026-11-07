import { describe, expect, it } from 'vitest';

import { readPluginTranslationResources } from '../../../../scripts/testing/readPluginTranslationResources.js';

const SOURCE_CATALOGS = ['linear', 'jira', 'scm-github', 'scm-gitlab', 'scm-bitbucket', 'scm-azure-devops', 'posthog', 'sentry']
  .map(id => ({ id, messages: readPluginTranslationResources(new URL(`../../../plugins/${id}/`, import.meta.url)) }));
const STORY_PLURAL_KEYS = ['inFiles', 'files', 'smallerFiles', 'moreFiles', 'failing', 'passedCount', 'runningCount', 'allPassed', 'allPassedLatest', 'failingSoFar', 'runningSoFar'];

const LOCALES = ['en', 'ru', 'pl', 'es', 'fr', 'it', 'pt', 'ca', 'zh-Hans', 'zh-Hant', 'ja', 'de'] as const;

describe('the shared story catalog', () => {
  it('defines every plural form a locale selects for a whole count', () => {
    for (const { id, messages: catalog } of SOURCE_CATALOGS) {
      for (const locale of LOCALES) {
        const messages = catalog[locale];
        const rules = new Intl.PluralRules(locale);
        for (const base of STORY_PLURAL_KEYS) {
          expect(messages[`plugins.triage.detailStory.${base}.other`], `${id} ${locale} ${base}.other`).toBeTypeOf('string');
          for (const count of [0, 1, 2, 3, 5, 11, 21, 22, 25, 101, 112]) {
            const form = rules.select(count);
            expect(messages[`plugins.triage.detailStory.${base}.${form}`], `${id} ${locale} ${base}.${form}`).toContain('{count}');
          }
        }
      }
    }
  });
});
