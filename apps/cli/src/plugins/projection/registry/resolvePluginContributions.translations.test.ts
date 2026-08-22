import { describe, expect, it } from 'vitest';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { buildPluginProjectionV2 } from './projection/v2';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from './resolvePluginContributions';

function loadedTranslationPlugin(locale: string, greeting = 'Hello'): LoadedPlugin {
  const pluginId = 'com.acme.translations';
  return {
    pluginId,
    pluginRootPath: `/plugins/${pluginId}`,
    manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
    daemonEntryPath: null,
    devDaemonEntryPath: null,
    sourceSpec: { kind: 'path', locator: `/plugins/${pluginId}`, trustPolicy: 'local_trusted', installPolicy: 'link' },
    manifest: normalizePluginManifestV2({
      schemaVersion: 2,
      id: pluginId,
      version: '1.0.0',
      displayName: 'Translations',
      engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
      contributes: { ui: { translations: [{ locale, messages: { greeting } }] } },
    }),
  };
}

describe('resolved plugin translation projection', () => {
  it('uses locale-scoped identity without pretending a BCP-47 locale is a contribution local id', () => {
    const projected = projectLoadedPluginContributes({
      loadResult: {
        loadedPlugins: [loadedTranslationPlugin('en-US')],
        diagnosticsByPluginId: {},
      },
      provenance: 'external',
    });

    expect(projected.uiTranslationsV2).toMatchObject([{
      pluginId: 'com.acme.translations',
      localeIdentity: { pluginId: 'com.acme.translations', locale: 'en-US' },
      definition: { locale: 'en-US' },
    }]);
    expect(projected.uiTranslationsV2?.[0]).not.toHaveProperty('identity');
    expect(projected.introspectionContributions).toEqual([{
      pluginId: 'com.acme.translations',
      pluginVersion: '1.0.0',
      source: 'localPath',
      family: 'ui.translations',
      identity: { kind: 'locale', locale: 'en-US' },
      registration: 'notRequired',
      runtimeRegistrationFamily: 'ui.translations',
      runtimeRegistrationHost: null,
      consumer: 'ui-i18n-host',
      platforms: ['cli', 'web', 'ios', 'android', 'desktop'],
    }]);
  });

  it('projects a schema-v2 external plugin translation into the runtime UI bundle without an aggregate digest', () => {
    const project = (greeting: string, legacyTitle = 'Legacy V1') => {
      const resolved = projectLoadedPluginContributes({
        loadResult: {
          loadedPlugins: [loadedTranslationPlugin('en-US', greeting)],
          diagnosticsByPluginId: {},
        },
        provenance: 'external',
      });
      const registry = createResolvedContributionRegistry({
        ...resolved,
        uiTranslations: [{
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'com.acme.translations',
          manifestPath: '/plugins/com.acme.translations/legacy.json',
          definition: { locales: { en: { title: legacyTitle } } },
        }],
      });
      return {
        entries: buildPluginProjectionV2({ registry, generation: 1 })
          .familiesById.pluginUi?.entriesById ?? {},
      };
    };

    const hello = project('Hello from V2');
    const updated = project('Updated from V2');
    const legacyOnlyUpdate = project('Hello from V2', 'Changed legacy V1');

    expect(hello.entries['translations:com.acme.translations']).toMatchObject({
      pluginId: 'com.acme.translations',
      contributionKind: 'translations',
      locales: ['en-US'],
      bundles: {
        'en-US': { greeting: 'Hello from V2' },
      },
    });
    expect(hello.entries).not.toHaveProperty('digest:com.acme.translations');
    expect(updated.entries['translations:com.acme.translations']).not.toEqual(
      hello.entries['translations:com.acme.translations'],
    );
    expect(legacyOnlyUpdate.entries['translations:com.acme.translations']).toEqual(
      hello.entries['translations:com.acme.translations'],
    );
  });
});
