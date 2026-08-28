import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../manifest.js';
import { GITLAB_ADDITIONAL_UI_TRANSLATIONS } from './additionalTranslations.js';
import { GITLAB_RENDER_UI_TRANSLATIONS } from './renderTranslations.js';

const LOCALES = Object.keys(GITLAB_RENDER_UI_TRANSLATIONS) as readonly
  (keyof typeof GITLAB_RENDER_UI_TRANSLATIONS)[];

type Messages = Readonly<Record<string, string | undefined>>;

function messages(locale: (typeof LOCALES)[number]): Messages {
  return {
    ...GITLAB_RENDER_UI_TRANSLATIONS[locale],
    ...GITLAB_ADDITIONAL_UI_TRANSLATIONS[locale],
  };
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
    expect(LOCALES).toHaveLength(11);
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
