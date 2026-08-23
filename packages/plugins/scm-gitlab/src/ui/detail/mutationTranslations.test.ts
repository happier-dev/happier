/**
 * Every string the write controls can show must exist in every locale this
 * plugin ships.
 *
 * The keys are extracted from the control's own SOURCE rather than listed here.
 * A hand-maintained list is a second copy of the same fact, and the copy that
 * goes stale is this one — a new `valueKey` added next to a fallback would keep
 * passing while the localized build showed English. Reading the source means the
 * guard fails the moment a key exists without its catalog entries.
 *
 * The fallback text beside each key is NOT a substitute for the catalog: it is
 * the last resort when a key is missing, so relying on it ships English into
 * every other locale.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { GITLAB_ADDITIONAL_UI_TRANSLATIONS } from '../additionalTranslations.js';
import { GITLAB_RENDER_UI_TRANSLATIONS } from '../renderTranslations.js';

const CONTROL_SOURCE = readFileSync(new URL('./mutationControls.tsx', import.meta.url), 'utf8');

/**
 * The two ways a key reaches the host from this file: as a `*Key` prop beside
 * its fallback, and as the first argument of a `text(key, fallback)` call.
 */
const KEY_PROP_PATTERN = /\b(?:value|title|label|placeholder|description)Key="([^"]+)"/gu;
const TRANSLATE_CALL_PATTERN = /\btext\(\s*'([^']+)'/gu;

function keysInControlSource(): readonly string[] {
  const found = new Set<string>();
  for (const match of CONTROL_SOURCE.matchAll(KEY_PROP_PATTERN)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  for (const match of CONTROL_SOURCE.matchAll(TRANSLATE_CALL_PATTERN)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * The same two carriers again, read as PAIRS this time: a key and the exact
 * fallback sentence written beside it.
 */
const KEY_FALLBACK_PROP_PATTERN =
  /\b(?:value|title|label|placeholder|description)Key="([^"]+)"\s*\n\s*fallback="([^"]+)"/gu;
const TRANSLATE_CALL_PAIR_PATTERN = /\btext\(\s*'([^']+)',\s*'([^']*)',?\s*\)/gu;

function keyFallbackPairsInControlSource(): readonly (readonly [string, string])[] {
  const pairs = new Map<string, string>();
  for (const match of CONTROL_SOURCE.matchAll(KEY_FALLBACK_PROP_PATTERN)) {
    if (match[1] !== undefined && match[2] !== undefined) pairs.set(match[1], match[2]);
  }
  for (const match of CONTROL_SOURCE.matchAll(TRANSLATE_CALL_PAIR_PATTERN)) {
    if (match[1] !== undefined && match[2] !== undefined) pairs.set(match[1], match[2]);
  }
  return [...pairs.entries()].sort((left, right) => left[0].localeCompare(right[0]));
}

const LOCALES = Object.keys(GITLAB_RENDER_UI_TRANSLATIONS) as
  readonly (keyof typeof GITLAB_RENDER_UI_TRANSLATIONS)[];

function messagesFor(locale: keyof typeof GITLAB_RENDER_UI_TRANSLATIONS): Readonly<Record<string, string>> {
  return {
    ...GITLAB_RENDER_UI_TRANSLATIONS[locale],
    ...GITLAB_ADDITIONAL_UI_TRANSLATIONS[
      locale as keyof typeof GITLAB_ADDITIONAL_UI_TRANSLATIONS
    ],
  };
}

describe('GitLab write control translations', () => {
  it('extracts the keys from the control source rather than trusting a list', () => {
    // The positive control for the extraction itself. If the patterns stopped
    // matching, every completeness case below would pass over an empty set.
    const keys = keysInControlSource();

    expect(keys.length).toBeGreaterThanOrEqual(20);
    expect(keys).toContain('plugins.gitlab.ui.mutations.merge.button');
    expect(keys).toContain('plugins.gitlab.ui.mutations.merge.scheduled');
  });

  it('ships more than one locale', () => {
    expect(LOCALES.length).toBeGreaterThan(1);
  });

  it.each(LOCALES)('resolves every write-control key in %s', (locale) => {
    const messages = messagesFor(locale);
    for (const key of keysInControlSource()) {
      expect(messages[key], `${locale}/${key}`).toBeTruthy();
    }
  });

  it('keeps every fallback identical to the English catalog entry beside it', () => {
    // The fallback and the key are two spellings of one sentence, and only the
    // fallback is visible in an English test. A key repointed without its
    // fallback — or a fallback edited without its catalog — leaves English right
    // and every other locale showing a DIFFERENT sentence: a scheduled merge
    // reported as merged, in Japanese only. This is the case that fails there.
    const english = messagesFor('en');
    const pairs = keyFallbackPairsInControlSource();

    expect(pairs.length).toBeGreaterThanOrEqual(20);
    for (const [key, fallback] of pairs) {
      expect(english[key], key).toBe(fallback);
    }
  });

  it('does not leave a non-English locale showing the English fallback', () => {
    // A catalog can be complete and still wrong: copying English into every
    // locale satisfies presence. This checks the two keys whose copy is longest
    // and most distinctive actually differ from English somewhere.
    const english = messagesFor('en');
    const translated = LOCALES.filter((locale) => locale !== 'en');
    for (const key of ['plugins.gitlab.ui.mutations.merge.scheduled', 'plugins.gitlab.ui.mutations.unconfirmed']) {
      const distinct = translated.filter((locale) => messagesFor(locale)[key] !== english[key]);
      expect(distinct.length, key).toBe(translated.length);
    }
  });
});
