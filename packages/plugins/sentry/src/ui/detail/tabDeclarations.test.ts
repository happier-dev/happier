import { describe, expect, it } from 'vitest';

import { SENTRY_UI_TRANSLATIONS } from '../translations.js';

import {
  SENTRY_DEFAULT_DETAIL_TAB_V1,
  SENTRY_DETAIL_TABS_V1,
  sentryDetailTabDeclaration,
  sentryResolveSelectedTab,
  sentryVisibleDetailTabs,
} from './tabDeclarations.js';

const LOCALES = Object.keys(SENTRY_UI_TRANSLATIONS) as (keyof typeof SENTRY_UI_TRANSLATIONS)[];

describe('Sentry detail tab declarations', () => {
  it('states a lifetime and a scroll owner on every tab', () => {
    // The shared tab primitive treats an omitted retention as `discard`, so a
    // panel that says nothing acquires a lifetime by accident.
    for (const tab of SENTRY_DETAIL_TABS_V1) {
      expect(['retain', 'discard'], tab.id).toContain(tab.retention);
      expect(['scrollArea', 'list'], tab.id).toContain(tab.scrollOwner);
      expect(tab.retainedState.length, tab.id).toBeGreaterThan(0);
    }
    expect(sentryDetailTabDeclaration('stack-trace').scrollOwner).toBe('list');
  });

  it('names every tab through a catalog key that exists in every locale it ships', () => {
    // A tab title reaches `Tabs.Item` as a plain string, so an untranslated
    // declaration renders English on ten of the eleven locales this plugin
    // ships and nothing fails. That silence is the whole defect.
    expect(LOCALES.length).toBe(11);
    for (const tab of SENTRY_DETAIL_TABS_V1) {
      expect(tab.titleKey, tab.id).toMatch(/^plugins\.sentry\.ui\.tab\./u);
      for (const locale of LOCALES) {
        const messages: Readonly<Record<string, string>> = SENTRY_UI_TRANSLATIONS[locale];
        expect(messages[tab.titleKey], `${tab.id} @ ${locale}`).toBeTypeOf('string');
        expect(messages[tab.titleKey], `${tab.id} @ ${locale}`).not.toBe('');
      }
      // English is the fallback a locale with no entry degrades to, so the two
      // must not be allowed to drift into two different English words.
      expect(SENTRY_UI_TRANSLATIONS.en[
        tab.titleKey as keyof typeof SENTRY_UI_TRANSLATIONS.en
      ], tab.id).toBe(tab.title);
    }
  });

  it('translates every tab into a locale that is not English', () => {
    // A catalog whose non-English entries were copied from the English column
    // would satisfy presence and still ship an untranslated strip.
    const japanese: Readonly<Record<string, string>> = SENTRY_UI_TRANSLATIONS.ja;
    for (const tab of SENTRY_DETAIL_TABS_V1) {
      expect(japanese[tab.titleKey], tab.id).not.toBe(tab.title);
    }
  });

  it('gives every tab a distinct key and every plane one owning tab', () => {
    const keys = SENTRY_DETAIL_TABS_V1.map((tab) => tab.titleKey);
    expect(new Set(keys).size).toBe(keys.length);
    const planes = SENTRY_DETAIL_TABS_V1.map((tab) => tab.readPlane);
    expect(new Set(planes).size).toBe(planes.length);
  });

  it('opens on a tab no condition can remove', () => {
    const bare = sentryVisibleDetailTabs({
      hasReleaseAssociation: false,
      hasTraceEvidence: false,
    });
    expect(bare.some((tab) => tab.id === SENTRY_DEFAULT_DETAIL_TAB_V1)).toBe(true);
    expect(sentryResolveSelectedTab('stack-trace', bare)).toBe(SENTRY_DEFAULT_DETAIL_TAB_V1);
    expect(sentryDetailTabDeclaration(SENTRY_DEFAULT_DETAIL_TAB_V1).conditional).toBe(false);
  });
});
