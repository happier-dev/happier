import { describe, expect, it } from 'vitest';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { buildPluginMountedActionsProjectionV2, buildPluginProjectionV2 } from './projection/v2';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from './fullProjection';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';

function loadedTranslationPlugin(locale: string, resourceId = 'copy', inline = false, pluginId = 'com.acme.translations', greeting = 'Hello'): LoadedPlugin {
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
      contributes: {
        resources: inline ? [] : [{ id: resourceId, kind: 'asset', path: `assets/i18n/${locale}.json`, contentType: 'application/json' }],
        ui: { translations: [inline ? { locale, messages: { greeting } } : { locale, resourceId }] },
      },
    }),
  };
}

describe('resolved plugin translation projection', () => {
  it('bounds mounted Action copy bytes to the requested locale and English across 66 plugins', () => {
    const pluginId = 'com.acme.translations';
    const locales = ['en', 'fr', 'de', 'es', 'it', 'ja', 'ko', 'pt', 'ru', 'zh'];
    const target = loadedTranslationPlugin('en', 'copy', true);
    const loadedPlugins = [
      { ...target, manifest: normalizePluginManifestV2({ ...target.manifest, contributes: {
        ...target.manifest.contributes, ui: { ...target.manifest.contributes.ui,
          translations: locales.map(locale => ({ locale, messages: { greeting: `${locale}:${'x'.repeat(2048)}` } })),
        },
      } }) },
      ...Array.from({ length: 65 }, (_, index) => loadedTranslationPlugin('en', 'copy', true, `com.acme.unrelated${index}`, 'unrelated'.repeat(2048))),
    ];
    const resolved = projectLoadedPluginContributes({ loadResult: { loadedPlugins, diagnosticsByPluginId: {} }, provenance: 'external' });
    const registry = createResolvedContributionRegistry({ ...resolved, occurrenceIdsByPluginId: Object.fromEntries(
      loadedPlugins.map(plugin => [plugin.pluginId, createPluginRuntimeOccurrenceId(plugin.pluginId)])),
    });
    const projection = buildPluginMountedActionsProjectionV2({ registry, generation: 1, actions: [],
      callerPluginIds: [pluginId], requestedLocale: 'fr' });
    const family = projection.familiesById.pluginUi;
    const translations = family?.family === 'pluginUi' ? family.entriesById[`translations:${pluginId}`] : undefined;
    expect(translations).toMatchObject({ locales: [...locales].sort() });
    expect(Object.keys(translations && 'bundles' in translations ? translations.bundles ?? {} : {}).sort()).toEqual(['en', 'fr']);
    const bytes = Buffer.byteLength(JSON.stringify(projection));
    const unscoped = buildPluginMountedActionsProjectionV2({ registry, generation: 1, actions: [], callerPluginIds: [pluginId] });
    console.info('MOUNTED_LOCALE_BYTES', JSON.stringify({ allLocales: Buffer.byteLength(JSON.stringify(unscoped)), selected: bytes }));
    expect(bytes).toBeLessThan(Buffer.byteLength(JSON.stringify(unscoped)) - 8 * 2048);
    expect(JSON.stringify(projection)).not.toContain('com.acme.unrelated');
  });
  it('carries only mounted callers translation declarations and their locale Resources through the UI consumer', async () => {
    const pluginId = 'com.acme.translations';
    const otherPluginId = 'com.acme.unrelated';
    const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
    const resolved = projectLoadedPluginContributes({
      loadResult: { loadedPlugins: [loadedTranslationPlugin('en', 'copy-en'),
        loadedTranslationPlugin('en', 'other-copy', false, otherPluginId)],
        diagnosticsByPluginId: {} },
      provenance: 'external',
    });
    const registry = createResolvedContributionRegistry({ ...resolved,
      occurrenceIdsByPluginId: { [pluginId]: occurrenceId, [otherPluginId]: createPluginRuntimeOccurrenceId(otherPluginId) } });
    const projection = buildPluginMountedActionsProjectionV2({ registry, generation: 1, actions: [], callerPluginIds: [pluginId] });
    expect(projection.familiesById.pluginUi?.entriesById).toEqual({
      [`translations:${pluginId}`]: { id: `translations:${pluginId}`, pluginId, occurrenceId,
        contributionKind: 'translations', locales: ['en'], resourceIdsByLocale: { en: 'copy-en' } },
    });
    expect(Object.keys(projection.resourcesById)).toEqual([`${pluginId}/copy-en`]);
    const { parseDaemonContributionRegistryProjectionDescribeResponse } = await import(
      '../../../../../ui/sources/sync/api/daemon/daemonContributionRegistryProjectionProtocol');
    const { publishDaemonMergedProjectionInputs } = await import(
      '../../../../../ui/sources/agents/backendCatalog/daemonContributionRegistryProjectionAdapters');
    const response = parseDaemonContributionRegistryProjectionDescribeResponse({ protocolVersion: 1, projection });
    if (!response) throw new Error('Expected the canonical UI reader to accept mounted facts');
    expect(publishDaemonMergedProjectionInputs({ projection: response.projection }).pluginUiProjection
      .translationsByPluginId[pluginId]).toMatchObject({ occurrenceId, resourceIdsByLocale: { en: 'copy-en' } });
  });

  it('uses locale-scoped identity without pretending a BCP-47 locale is a contribution local id', () => {
    const projected = projectLoadedPluginContributes({
      loadResult: {
        loadedPlugins: [loadedTranslationPlugin('en-US', 'copy', true)],
        diagnosticsByPluginId: {},
      },
      provenance: 'external',
    });

    expect(projected.uiTranslationsV2).toMatchObject([{
      pluginId: 'com.acme.translations',
      localeIdentity: { pluginId: 'com.acme.translations', locale: 'en-US' },
      definition: { locale: 'en-US', messages: { greeting: 'Hello' } },
    }]);
    expect(projected.uiTranslationsV2?.[0]).not.toHaveProperty('identity');
    expect(projected.introspectionContributions).toContainEqual({
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
    });
  });

  it('projects an external plugin locale Resource reference without message bodies or an aggregate digest', () => {
    const occurrenceId = createPluginRuntimeOccurrenceId('com.acme.translations');
    const project = (resourceId: string, inline = false) => {
      const resolved = projectLoadedPluginContributes({
        loadResult: {
          loadedPlugins: [loadedTranslationPlugin('en-US', resourceId, inline)],
          diagnosticsByPluginId: {},
        },
        provenance: 'external',
      });
      const registry = createResolvedContributionRegistry({
        ...resolved,
        occurrenceIdsByPluginId: { 'com.acme.translations': occurrenceId },
      });
      expect(registry).not.toHaveProperty('uiTranslations');
      expect(registry).not.toHaveProperty('hostedWeb');
      expect(registry).not.toHaveProperty('hostedWebById');
      return {
        entries: buildPluginProjectionV2({ registry, generation: 1 })
          .familiesById.pluginUi?.entriesById ?? {},
      };
    };

    const hello = project('copy-en');
    const updated = project('copy-updated');

    expect(hello.entries['translations:com.acme.translations']).toMatchObject({
      pluginId: 'com.acme.translations',
      contributionKind: 'translations',
      locales: ['en-US'],
      resourceIdsByLocale: { 'en-US': 'copy-en' },
    });
    expect(hello.entries['translations:com.acme.translations']).not.toHaveProperty('bundles');
    expect(hello.entries).not.toHaveProperty('digest:com.acme.translations');
    expect(updated.entries['translations:com.acme.translations']).not.toEqual(
      hello.entries['translations:com.acme.translations'],
    );
    expect(project('copy', true).entries['translations:com.acme.translations']).toEqual({
      id: 'translations:com.acme.translations', pluginId: 'com.acme.translations',
      occurrenceId,
      contributionKind: 'translations', locales: ['en-US'], bundles: { 'en-US': { greeting: 'Hello' } },
    });
  });
});
