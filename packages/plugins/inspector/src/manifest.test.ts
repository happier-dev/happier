import { readFileSync } from 'node:fs';

import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import * as inspectorManifest from './manifest';
import {
  INSPECTOR_NATIVE_BUNDLE_ID,
  INSPECTOR_PLUGIN_ID,
  INSPECTOR_SETTINGS,
  INSPECTOR_SETTINGS_ID,
  INSPECTOR_SHOW_DIAGNOSTICS_SETTING_ID,
  INSPECTOR_UI,
  PLUGIN_MANIFEST,
} from './manifest';

describe('Plugin Inspector manifest', () => {
  it('authors against the public plugin SDK only', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const manifestSource = readFileSync(new URL('./manifest.ts', import.meta.url), 'utf8');
    const dependencyFields = [
      packageJson.dependencies,
      packageJson.devDependencies,
      packageJson.peerDependencies,
      packageJson.optionalDependencies,
    ];
    const forbiddenProtocolPackage = '@happier-dev/' + 'protocol';
    const forbiddenAgentsPackage = '@happier-dev/' + 'agents';

    for (const dependencies of dependencyFields) {
      expect(dependencies ?? {}).not.toHaveProperty(forbiddenProtocolPackage);
      expect(dependencies ?? {}).not.toHaveProperty(forbiddenAgentsPackage);
    }
    expect(manifestSource).not.toContain(forbiddenProtocolPackage);
    expect(manifestSource).not.toContain(forbiddenAgentsPackage);
  });

  it('round-trips its public manifest through canonical object and JSON ingestion', () => {
    const objectIngestion = ingestPluginManifestV2(PLUGIN_MANIFEST);
    const jsonIngestion = ingestPluginManifestV2(JSON.parse(JSON.stringify(PLUGIN_MANIFEST)));

    expect(objectIngestion).toMatchObject({ ok: true });
    expect(jsonIngestion).toEqual(objectIngestion);
  });

  it('rejects a view whose renderer does not exist', () => {
    const manifest = JSON.parse(JSON.stringify(PLUGIN_MANIFEST)) as {
      contributes: { ui: { views: Array<{ renderer: string }> } };
    };
    manifest.contributes.ui.views[0]!.renderer = 'missing-renderer';

    expect(ingestPluginManifestV2(manifest)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_dangling_reference',
        path: ['contributes', 'ui', 'views', 0, 'renderer'],
      })],
    });
  });

  it('rejects predecessor host-method vocabulary in the strict renderer declaration', () => {
    const manifest = JSON.parse(JSON.stringify(PLUGIN_MANIFEST)) as {
      contributes: { ui: { renderers: Array<{ requiredHostMethods: string[] }> } };
    };
    manifest.contributes.ui.renderers[0]!.requiredHostMethods = ['dispatchAction'];

    expect(ingestPluginManifestV2(manifest)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_invalid',
        path: ['contributes', 'ui', 'renderers', 0, 'requiredHostMethods', 0],
      })],
    });
  });

  it('rejects duplicate translation locales', () => {
    const manifest = JSON.parse(JSON.stringify(PLUGIN_MANIFEST)) as {
      contributes: { ui: { translations: unknown[] } };
    };
    const duplicateIndex = manifest.contributes.ui.translations.length;
    manifest.contributes.ui.translations.push(
      JSON.parse(JSON.stringify(manifest.contributes.ui.translations[0])),
    );

    expect(ingestPluginManifestV2(manifest)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_invalid',
        path: ['contributes', 'ui', 'translations', duplicateIndex, 'locale'],
      })],
    });
  });

  it('declares canonical settings without a declaration-only runtime hook', () => {
    expect(PLUGIN_MANIFEST.id).toBe(INSPECTOR_PLUGIN_ID);
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activation');
    expect(PLUGIN_MANIFEST.entrypoints).toEqual({ daemon: './.happier-plugin/daemon.js' });
    expect(PLUGIN_MANIFEST.hostAccess).toEqual({ required: [], optional: [] });
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('hooks');
    expect(PLUGIN_MANIFEST.contributes.actions).toEqual([
      expect.objectContaining({
        id: 'self-check',
        execution: { target: 'daemon' },
      }),
    ]);
    expect(INSPECTOR_SETTINGS).toMatchObject({
      id: INSPECTOR_SETTINGS_ID,
      target: { kind: 'plugin' },
      scope: 'daemon',
    });
    expect(INSPECTOR_SETTINGS.fields).toEqual([
      expect.objectContaining({
        id: INSPECTOR_SHOW_DIAGNOSTICS_SETTING_ID,
        schema: { type: 'boolean' },
        default: true,
      }),
    ]);
  });

  it('retains one React Native renderer across direct app-tab and full-page destinations', () => {
    expect(INSPECTOR_UI).toEqual({
      // Two DESTINATIONS, ONE renderer (EU-5b dogfood). A second renderer here
      // would be a duplicate surface implementation, not a second destination.
      views: [{
        id: 'inspector-app',
        container: 'rightSidebarTab',
        target: { kind: 'app' },
        renderer: 'inspector-renderer',
        title: { key: 'plugins.inspector.title', fallback: 'Plugin Inspector' },
      }, {
        id: 'inspector-page',
        container: 'appPage',
        target: { kind: 'app' },
        renderer: 'inspector-renderer',
        title: { key: 'plugins.inspector.title', fallback: 'Plugin Inspector' },
      }],
      renderers: [{
        id: 'inspector-renderer',
        kind: 'reactNative',
        artifact: INSPECTOR_NATIVE_BUNDLE_ID,
        requiredHostMethods: ['executeAction'],
      }],
      translations: expect.arrayContaining([{
        locale: 'en',
        messages: expect.objectContaining({
          'plugins.inspector.title': 'Plugin Inspector',
          'plugins.inspector.settings.showDiagnostics': 'Show diagnostics in Plugin Inspector',
        }),
      }]),
    });
    expect(PLUGIN_MANIFEST.contributes.ui).toEqual(INSPECTOR_UI);
    for (const view of INSPECTOR_UI.views) {
      expect(view).not.toHaveProperty('placement');
      expect(view).not.toHaveProperty('binding');
    }
  });

  it('keeps every Inspector UI declaration in the canonical manifest graph', () => {
    expect(inspectorManifest).not.toHaveProperty('INSPECTOR_APP_SURFACE');
    expect(inspectorManifest).not.toHaveProperty('INSPECTOR_UI_TRANSLATIONS');
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('hostedWeb');
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('uiArtifacts');
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('surfacePlacements');
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('reactNativeBundles');
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('uiTranslations');
  });

  it('packages a generic inventory illustration separately from the brand mark', () => {
    expect(PLUGIN_MANIFEST.contributes.resources).toEqual(expect.arrayContaining([
      {
        id: 'brand-icon',
        kind: 'asset',
        path: 'assets/brand.png',
        contentType: 'image/png',
      },
      {
        id: 'inventory-illustration',
        kind: 'asset',
        path: 'assets/inventory.png',
        contentType: 'image/png',
      },
    ]));

    const inventoryBytes = readFileSync(new URL('../assets/inventory.png', import.meta.url));
    const brandBytes = readFileSync(new URL('../assets/brand.png', import.meta.url));
    expect([...inventoryBytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(inventoryBytes.equals(brandBytes)).toBe(false);
  });
});
