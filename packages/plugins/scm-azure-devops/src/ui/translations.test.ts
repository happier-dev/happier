import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../manifest.js';
import { AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS } from '../triage/mutationActions.js';
import { AZURE_DETAIL_TABS_V1 } from './detail/tabDeclarations.js';

type Messages = Readonly<Record<string, string | undefined>>;

const TRANSLATIONS = PLUGIN_MANIFEST.contributes.ui.translations;

function messagesFor(locale: string): Messages {
  const entry = TRANSLATIONS.find((row) => row.locale === locale);
  if (entry === undefined) throw new Error(`manifest declares no ${locale} translations`);
  return entry.messages;
}

const LOCALES: readonly string[] = TRANSLATIONS.map((row) => row.locale);
const ENGLISH = messagesFor('en');

describe('the Azure DevOps surface catalog', () => {
  it('gives every detail tab a catalog key', () => {
    for (const tab of AZURE_DETAIL_TABS_V1) {
      expect(tab.titleKey).toMatch(/^plugins\.azureDevops\.ui\.tab\./u);
    }
  });

  it('ships the same keys in every locale the manifest declares', () => {
    expect(LOCALES).toContain('en');
    expect(LOCALES).toContain('de');
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
          .matchAll(/['"](plugins\.azureDevops\.[A-Za-z0-9._-]+)['"]/gu)) {
          if (match[1] !== undefined) referenced.add(match[1]);
        }
      }
    };
    walk(root);

    expect(referenced.size).toBeGreaterThan(100);
    expect([...referenced].filter((key) => ENGLISH[key] === undefined).sort()).toEqual([]);
  });

  it('does not leave authored metadata labels as raw literals in the renderer', () => {
    const root = fileURLToPath(new URL('.', import.meta.url));
    expect(readFileSync(join(root, 'renderSurface.tsx'), 'utf8')).not.toMatch(/\blabel:\s*['"]/u);
  });

  it('localizes every field of every write confirmation', () => {
    const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]));
    const fields = Object.values(AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS).flatMap((id) => {
      const confirmation = actions.get(id)?.confirmation;
      return [confirmation?.title, confirmation?.body, confirmation?.confirmLabel];
    });

    expect(fields).toHaveLength(Object.keys(AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS).length * 3);
    for (const field of fields) {
      expect(field).toEqual({ key: expect.any(String), fallback: expect.any(String) });
      if (
        typeof field !== 'object'
        || field === null
        || !('key' in field)
        || typeof field.key !== 'string'
      ) continue;
      for (const locale of LOCALES) {
        expect(messagesFor(locale)[field.key], `${locale}/${field.key}`).toBeTruthy();
        if (locale !== 'en') {
          expect(messagesFor(locale)[field.key], `${locale}/${field.key}`).not.toBe(ENGLISH[field.key]);
        }
      }
    }
  });
});
