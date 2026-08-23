import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GITHUB_ADDITIONAL_UI_TRANSLATIONS } from './additionalTranslations.js';
import { GITHUB_RENDER_UI_TRANSLATIONS } from './renderTranslations.js';
import { GITHUB_DETAIL_TABS_V1 } from './detail/tabDeclarations.js';
import {
  GITHUB_DETAIL_FIELD_LABELS_V1,
  GITHUB_REVIEW_STATE_LABELS_V1,
  GITHUB_REVIEW_STATE_UNKNOWN_KEY_V1,
  GITHUB_REVIEW_STATE_UNKNOWN_LABEL_V1,
  GITHUB_TIMELINE_HEADLINES_V1,
  githubDetailFieldLabelKey,
  githubReviewStateKey,
  githubTimelineHeadlineKey,
} from './detail/vocabulary.js';

/**
 * The GitHub surface catalog, guarded.
 *
 * `src/manifest.ts` merges both catalogs per locale, so a key defined in only
 * one locale renders English on the other ten and nothing fails. That failure
 * is silent by construction, which is why it has to be asserted rather than
 * noticed.
 */

const LOCALES = Object.keys(GITHUB_RENDER_UI_TRANSLATIONS) as readonly
  (keyof typeof GITHUB_RENDER_UI_TRANSLATIONS)[];

type Messages = Readonly<Record<string, string | undefined>>;

function messages(locale: (typeof LOCALES)[number]): Messages {
  return {
    ...GITHUB_RENDER_UI_TRANSLATIONS[locale],
    ...GITHUB_ADDITIONAL_UI_TRANSLATIONS[locale],
  };
}

const ENGLISH = messages('en');

describe('the GitHub surface catalog', () => {
  it('ships every locale the manifest declares, and the same keys in each', () => {
    expect(LOCALES).toHaveLength(11);
    const english = Object.keys(ENGLISH).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(messages(locale)).sort(), locale).toEqual(english);
    }
  });

  it('defines every key literal the surfaces actually ask for', () => {
    // The parity case above compares each locale against `en`, so a key missing
    // from `en` ENTIRELY is invisible to it: absent everywhere reads as
    // agreement. The keys are therefore read from the source that asks for
    // them, not from a hand-kept list that drifts the same way a catalog does.
    const root = fileURLToPath(new URL('.', import.meta.url));
    const referenced = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { walk(path); continue; }
        if (!/\.tsx?$/u.test(entry.name) || /\.test\./u.test(entry.name)) continue;
        // Both shapes the surfaces use: `titleKey="..."` props and direct
        // `text('plugins.github…', 'fallback')` calls. Matching any catalog-key
        // literal covers both, and anything added later.
        for (const match of readFileSync(path, 'utf8')
          .matchAll(/['"](plugins\.github\.[A-Za-z0-9._]+)['"]/gu)) {
          if (match[1] !== undefined) referenced.add(match[1]);
        }
      }
    };
    walk(root);

    // A scan that found nothing would pass while asserting nothing.
    expect(referenced.size).toBeGreaterThan(40);
    expect([...referenced].filter((key) => ENGLISH[key] === undefined).sort()).toEqual([]);
  });

  it('defines the keys the surfaces COMPUTE, which no literal scan can see', () => {
    // Three key families are built at the call site from a provider value — a
    // fact id, a timeline event kind, a review state — so the scan above cannot
    // see any of them. They are the keys most likely to be added without copy,
    // because adding one is adding a row to a table.
    const computed: readonly (readonly [string, string])[] = [
      ...GITHUB_DETAIL_TABS_V1.map((tab) => [tab.titleKey, tab.title] as const),
      ...Object.entries(GITHUB_DETAIL_FIELD_LABELS_V1)
        .map(([factId, label]) => [githubDetailFieldLabelKey(factId), label ?? ''] as const),
      ...Object.entries(GITHUB_TIMELINE_HEADLINES_V1)
        .map(([kind, headline]) => [githubTimelineHeadlineKey(kind), headline ?? ''] as const),
      ...Object.entries(GITHUB_REVIEW_STATE_LABELS_V1)
        .map(([state, label]) => [githubReviewStateKey(state), label ?? ''] as const),
      [GITHUB_REVIEW_STATE_UNKNOWN_KEY_V1, GITHUB_REVIEW_STATE_UNKNOWN_LABEL_V1] as const,
    ];
    expect(computed.length).toBeGreaterThan(35);

    for (const [key, declared] of computed) {
      // English must match the declared fallback exactly. A catalog entry that
      // said something else would make one word mean two things depending on
      // whether the key resolved.
      expect(ENGLISH[key], key).toEqual(declared);
      for (const locale of LOCALES) {
        expect(messages(locale)[key], `${locale} ${key}`).toEqual(expect.any(String));
      }
    }
  });
});
