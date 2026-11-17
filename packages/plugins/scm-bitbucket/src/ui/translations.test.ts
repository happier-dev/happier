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
        .matchAll(/['"](plugins\.bitbucket\.[A-Za-z0-9._]+)['"]/gu)) {
        if (match[1] !== undefined) referenced.add(match[1]);
      }
    }
  };
  walk(root);
  return [...referenced].sort();
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

describe('the Bitbucket Cloud surface catalog', () => {
  it('ships the same keys in every supported locale', () => {
    expect(LOCALES).toContain('de');
    const englishKeys = Object.keys(ENGLISH).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(messages(locale)).sort(), locale).toEqual(englishKeys);
    }
  });

  it('defines every catalog key literal the provider UI asks for', () => {
    const referenced = sourceCatalogKeys();
    expect(referenced.length).toBeGreaterThan(40);
    expect(referenced.filter((key) => ENGLISH[key] === undefined)).toEqual([]);
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
});
