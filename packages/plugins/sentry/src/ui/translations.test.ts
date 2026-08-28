import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../manifest.js';

type Messages = Readonly<Record<string, string | undefined>>;

const TRANSLATIONS = PLUGIN_MANIFEST.contributes.ui.translations;

function messagesFor(locale: string): Messages {
  const entry = TRANSLATIONS.find((row) => row.locale === locale);
  if (entry === undefined) throw new Error(`manifest declares no ${locale} translations`);
  return entry.messages;
}

const LOCALES: readonly string[] = TRANSLATIONS.map((row) => row.locale);
const ENGLISH = messagesFor('en');

describe('the Sentry surface catalog', () => {
  it('ships the same keys in every locale the manifest declares', () => {
    expect(LOCALES).toContain('en');
    expect(LOCALES).toHaveLength(11);
    const english = Object.keys(ENGLISH).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(messagesFor(locale)).sort(), locale).toEqual(english);
    }
  });

  it('defines every key literal the plugin source actually asks for', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const referenced = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.tsx?$/u.test(entry.name) || /\.test\./u.test(entry.name)) continue;
        for (const match of readFileSync(path, 'utf8')
          .matchAll(/['"](plugins\.sentry\.[A-Za-z0-9._-]+)['"]/gu)) {
          if (match[1] !== undefined) referenced.add(match[1]);
        }
      }
    };
    walk(root);

    expect(referenced.size).toBeGreaterThan(80);
    expect([...referenced].filter((key) => ENGLISH[key] === undefined).sort()).toEqual([]);
  });

  it('does not leave authored metadata labels as raw literals in the renderer', () => {
    const root = fileURLToPath(new URL('.', import.meta.url));
    expect(readFileSync(join(root, 'renderSurface.tsx'), 'utf8')).not.toMatch(/\blabel:\s*['"]/u);
  });

  it('does not copy another provider name into Sentry status copy', () => {
    for (const locale of LOCALES) {
      expect(Object.values(messagesFor(locale)).join('\n'), locale)
        .not.toMatch(/PostHog|Azure DevOps/u);
    }
  });
});
