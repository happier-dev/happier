import { readPluginTranslationResources } from '../../../../../scripts/testing/readPluginTranslationResources.js';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../manifest.js';

const PACKAGED_UI_TRANSLATIONS = readPluginTranslationResources(new URL('../../', import.meta.url));

const LOCALES = Object.keys(PACKAGED_UI_TRANSLATIONS) as readonly
  (keyof typeof PACKAGED_UI_TRANSLATIONS)[];

type Messages = Readonly<Record<string, string | undefined>>;

function messages(locale: (typeof LOCALES)[number]): Messages {
  return PACKAGED_UI_TRANSLATIONS[locale];
}

const ENGLISH = messages('en');

function sourceCatalogKeys(): readonly string[] {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const referenced = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.tsx?$/u.test(entry.name) || /\.test\.|\.test-support\./u.test(entry.name)) continue;
      for (const match of readFileSync(path, 'utf8')
        .matchAll(/['"](plugins\.gitlab\.[A-Za-z0-9._]+)['"]/gu)) {
        if (match[1] !== undefined) referenced.add(match[1]);
      }
    }
  };
  walk(root);
  return [...referenced].sort();
}

function unkeyedLiteralProps(): readonly string[] {
  const source = readFileSync(fileURLToPath(new URL('./renderSurface.tsx', import.meta.url)), 'utf8');
  const failures: string[] = [];
  const openingTags = source.match(/<[A-Z][A-Za-z.]*\b[^>]*>/gu) ?? [];
  for (const tag of openingTags) {
    for (const [literal, key] of [
      ['title', 'titleKey'], ['description', 'descriptionKey'],
      ['fallback', 'valueKey'], ['accessibilityLabel', 'accessibilityLabelKey'],
    ] as const) {
      if (new RegExp(`\\b${literal}="`).test(tag) && !new RegExp(`\\b${key}=`).test(tag)) {
        failures.push(`${literal} without ${key}: ${tag.split('\n')[0]}`);
      }
    }
  }
  if (/\blabel:\s*field\.label\b/u.test(source)) failures.push('raw projected Metadata label');
  if (/\bvalue=\{field\.label\}/u.test(source)) failures.push('raw projected badge label');
  if (/\blabel=\{`\$\{field\.label/u.test(source)) failures.push('raw projected status label');
  return failures;
}

function confirmationKeys(): readonly string[] {
  return PLUGIN_MANIFEST.contributes.actions.flatMap((action) => {
    const confirmation = action.confirmation;
    if (confirmation === undefined) return [];
    return [confirmation.title, confirmation.body, confirmation.confirmLabel]
      .filter((value): value is { key: string; fallback: string } => (
        typeof value === 'object' && value !== null && 'key' in value
      ))
      .map(({ key }) => key);
  });
}

describe('the GitLab surface catalog', () => {
  it('ships the same keys in every supported locale', () => {
    expect(LOCALES).toContain('de');
    const englishKeys = Object.keys(ENGLISH).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(messages(locale)).sort(), locale).toEqual(englishKeys);
    }
  });

  it('defines every catalog key literal the provider UI asks for', () => {
    const referenced = sourceCatalogKeys();
    expect(referenced.length).toBeGreaterThan(70);
    expect(referenced.filter((key) => ENGLISH[key] === undefined)).toEqual([]);
  });

  it('does not leave literal component prose or projected labels without catalog ownership', () => {
    expect(unkeyedLiteralProps()).toEqual([]);
  });

  it('localizes the live Overview read and recovery chrome', () => {
    const overviewKeys = [
      'plugins.gitlab.ui.overview.showingLaunchObservation',
      'plugins.gitlab.ui.overview.showingLastRead',
      'plugins.gitlab.ui.overview.description',
      'plugins.gitlab.ui.overview.descriptionShortened',
      'plugins.gitlab.ui.overview.reread',
    ] as const;
    for (const key of overviewKeys) {
      expect(ENGLISH[key], `en/${key}`).toEqual(expect.any(String));
      for (const locale of LOCALES.filter((candidate) => candidate !== 'en')) {
        expect(messages(locale)[key], `${locale}/${key}`).toEqual(expect.any(String));
        if (key !== 'plugins.gitlab.ui.overview.description') {
          expect(messages(locale)[key], `${locale}/${key}`).not.toBe(ENGLISH[key]);
        }
      }
    }
  });

  it('translates every manifest confirmation instead of copying the English fallback', () => {
    const keys = confirmationKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of LOCALES.filter((candidate) => candidate !== 'en')) {
      for (const key of keys) {
        expect(messages(locale)[key], `${locale}/${key}`).toEqual(expect.any(String));
        expect(messages(locale)[key], `${locale}/${key}`).not.toBe(ENGLISH[key]);
      }
    }
  });

  it('localizes the mounted publication, mutation, file, and discussion chrome', () => {
    const localizedChromeKeys = Object.keys(ENGLISH).filter((key) => (
      key.startsWith('plugins.gitlab.ui.publication.')
      || key.startsWith('plugins.gitlab.ui.files.')
      || key.startsWith('plugins.gitlab.ui.discussion.')
      || key.startsWith('plugins.gitlab.ui.mutations.issue.')
      || key.startsWith('plugins.gitlab.ui.mutations.reviewers.')
      || key.startsWith('plugins.gitlab.ui.mutations.assignees.')
      || key.startsWith('plugins.gitlab.ui.mutations.labels.')
      || key.startsWith('plugins.gitlab.ui.mutations.discussion.')
      || key === 'plugins.gitlab.ui.paginationUnfollowable'
    ));
    expect(localizedChromeKeys.length).toBeGreaterThan(60);
    const englishAliases: string[] = [];
    for (const locale of LOCALES.filter((candidate) => candidate !== 'en')) {
      for (const key of localizedChromeKeys) {
        expect(messages(locale)[key], `${locale}/${key}`).toEqual(expect.any(String));
        if (messages(locale)[key] === ENGLISH[key]) englishAliases.push(`${locale}/${key}`);
      }
    }
    expect(englishAliases).toEqual([]);
  });
});
