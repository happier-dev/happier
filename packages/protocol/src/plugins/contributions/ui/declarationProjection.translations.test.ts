import { describe, expect, it } from 'vitest';
import { projectPluginUiDeclarationEntriesV1, projectPluginUiTranslationsV1, type PluginUiProjectedEntryCandidate } from './declarationProjection.js';
import { ingestPluginManifestV2 } from '../../manifest/ingest.js';

describe('translation Resource reference projection', () => {
  it('preserves inline producer bundles and locale narrowing during the migration', () => {
    const entries: Record<string, PluginUiProjectedEntryCandidate> = {};
    projectPluginUiTranslationsV1({ uiTranslationsV2: [
      { pluginId: 'acme.copy', definition: { locale: 'en', messages: { title: 'Title' } } },
      { pluginId: 'acme.copy', definition: { locale: 'fr', messages: { title: 'Titre' } } },
      { pluginId: 'acme.copy', definition: { locale: 'de', messages: { title: 'Titel' } } },
      { pluginId: 'acme.copy', definition: { locale: 'ja', resourceId: 'copy-ja' } },
    ] }, entries, 'fr');
    expect(entries['translations:acme.copy']).toEqual({
      id: 'translations:acme.copy', pluginId: 'acme.copy', contributionKind: 'translations',
      locales: ['de', 'en', 'fr', 'ja'], resourceIdsByLocale: { ja: 'copy-ja' },
      bundles: { en: { title: 'Title' }, fr: { title: 'Titre' } },
    });
  });

  it('carries every locale reference without reading or projecting message values', () => {
    const entries: Record<string, PluginUiProjectedEntryCandidate> = {};
    projectPluginUiTranslationsV1({ uiTranslationsV2: ['fr', 'en', 'de'].map(locale => ({
      pluginId: 'acme.copy', definition: { locale, resourceId: `copy-${locale}` },
    })) }, entries, 'fr');
    expect(entries['translations:acme.copy']).toEqual({
      id: 'translations:acme.copy', pluginId: 'acme.copy', contributionKind: 'translations',
      locales: ['de', 'en', 'fr'], resourceIdsByLocale: { de: 'copy-de', en: 'copy-en', fr: 'copy-fr' },
    });
    const admitted = ingestPluginManifestV2({
      schemaVersion: 2, id: 'acme.copy', version: '1.0.0', displayName: 'Copy',
      engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
      contributes: {
        resources: ['en', 'fr', 'de'].map(locale => ({
          id: `copy-${locale}`, kind: 'asset', path: `assets/i18n/${locale}.json`, contentType: 'application/json',
        })),
        ui: { translations: ['en', 'fr', 'de'].map(locale => ({ locale, resourceId: `copy-${locale}` })) },
      },
    });
    if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
    expect(projectPluginUiDeclarationEntriesV1({ registry: {
      uiTranslationsV2: admitted.manifest.contributes.ui.translations.map(definition => ({ pluginId: 'acme.copy', definition })),
    } })).toEqual(entries);
  });
});
