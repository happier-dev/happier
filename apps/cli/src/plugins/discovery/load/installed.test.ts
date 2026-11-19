import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadInstalledPlugins } from './installed';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import type { PluginStateFileV1 } from '@/plugins/store/state';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { admitLocalSettingsDeclarations } from '@/plugins/settings/localSettingsContributions';
import { readInstalledPluginCatalog } from '@/plugins/projection/catalog/installed';

describe('retained Settings declarations', () => {
  it('keeps healthy installed contributions and exposes skipped-declaration diagnostics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-tolerant-load-'));
    const pluginId = 'acme.tolerant-load';
    try {
      const pluginRoot = join(directory, 'plugin');
      await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
      await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}');
      await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
        id: pluginId, contributes: { actions: [
          { id: 'healthy', title: 'Healthy', scopes: ['session'], surfaces: ['cli'],
            execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' },
          { id: 'future', title: 'Future', futureRestriction: true },
        ] },
      })));
      const happyHomeDir = join(directory, 'home');
      await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: '1.0.0' });
      const loaded = await loadInstalledPlugins({ happyHomeDir });
      expect(loaded.loadedPlugins).toMatchObject([{ pluginId, manifest: { contributes: { actions: [{ id: 'healthy' }] } } }]);
      expect(loaded.diagnosticsByPluginId[pluginId]).toMatchObject([{ code: 'plugin_contribution_skipped' }]);
      expect(await readInstalledPluginCatalog({ happyHomeDir })).toMatchObject([{ enabled: true,
        diagnostics: [{ code: 'plugin_contribution_skipped' }] }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each([false, true])('keeps a physical committed installation discoverable (invalid default: %s)', async (invalidDefault) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-retained-settings-'));
    const pluginId = 'acme.retained-settings';
    try {
      const pluginRoot = join(directory, 'plugin');
      await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
      const manifest = createPluginManifestV2Fixture({ id: pluginId, contributes: { settings: [
        { id: 'preferences', title: 'Preferences', scope: 'daemon', target: { kind: 'plugin' },
          fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' }, default: invalidDefault ? 'true' : true }] },
        { id: 'healthy', title: 'Healthy', scope: 'daemon', target: { kind: 'plugin' },
          fields: [{ id: 'healthy', title: 'Healthy', schema: { type: 'boolean' }, default: false }] },
      ] } });
      await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest));
      await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}');
      const happyHomeDir = join(directory, 'home');
      // The generation testkit models bytes accepted by an earlier host.
      await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: '1.0.0' });
      const discovered = await loadInstalledPlugins({ happyHomeDir });
      const loaded = discovered.loadedPlugins.find(plugin => plugin.pluginId === pluginId);
      expect(loaded).toBeDefined();
      const admission = admitLocalSettingsDeclarations({ settings: loaded!.manifest.contributes.settings.map(definition => ({ pluginId, definition })) });
      expect(admission.declarations.map(row => row.definition.id)).toEqual(invalidDefault ? ['healthy'] : ['preferences', 'healthy']);
      expect(admission.errors).toEqual([]);
      expect(discovered.diagnosticsByPluginId[pluginId]).toMatchObject(invalidDefault
        ? [{ code: 'plugin_contribution_skipped', contribution: { pluginId, localId: 'preferences' } }] : []);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

async function writePluginManifest(rootDir: string, pluginId: string): Promise<void> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(rootDir, 'daemon.js'), 'export default function noop() { return null; }\n', 'utf8');
  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify({
      schemaVersion: 2,
      id: pluginId,
      version: '1.0.0',
      displayName: `Plugin ${pluginId}`,
      description: `Plugin ${pluginId}`,
      engines: {
        happier: '^0.3.0',
      },
      runtime: {
        apiVersion: 1,
      },
      entrypoints: {
        daemon: './daemon.js',
      },
      hostAccess: {
        required: [],
        optional: [],
      },
      contributes: {},
    }, null, 2),
    'utf8',
  );
}

async function writeDevelopmentOnlyPluginManifest(rootDir: string, pluginId: string): Promise<void> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(join(rootDir, 'src'), { recursive: true });
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(rootDir, 'src', 'daemon.ts'), 'export const version: string = "dev";\n', 'utf8');
  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify({
      schemaVersion: 2,
      id: pluginId,
      version: '1.0.0',
      displayName: `Plugin ${pluginId}`,
      description: `Plugin ${pluginId}`,
      engines: {
        happier: '^0.3.0',
      },
      runtime: {
        apiVersion: 1,
      },
      entrypoints: {
        development: './src/daemon.ts',
      },
      hostAccess: {
        required: [],
        optional: [],
      },
      contributes: {},
    }, null, 2),
    'utf8',
  );
}

async function writeStandaloneManifest(manifestPath: string, pluginId: string): Promise<void> {
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(join(dirname(manifestPath), 'daemon.js'), 'export default function noop() { return null; }\n', 'utf8');
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      id: pluginId,
      version: '1.0.0',
      displayName: `Plugin ${pluginId}`,
      description: `Plugin ${pluginId}`,
      engines: {
        happier: '^0.3.0',
      },
      runtime: {
        apiVersion: 1,
      },
      entrypoints: {
        daemon: './daemon.js',
      },
      hostAccess: {
        required: [],
        optional: [],
      },
      contributes: {},
    }, null, 2),
    'utf8',
  );
}

describe('loadInstalledPlugins', () => {
  it('loads only enabled compatible local-path plugins from the canonical state file', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const enabledPluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-enabled-'));
    const disabledPluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-disabled-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writePluginManifest(enabledPluginRoot, 'acme.enabled');
    await writePluginManifest(disabledPluginRoot, 'acme.disabled');

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.enabled': {
          source: {
            kind: 'path',
            locator: enabledPluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: enabledPluginRoot,
            manifestPath: join(enabledPluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
        'acme.disabled': {
          source: {
            kind: 'path',
            locator: disabledPluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: disabledPluginRoot,
            manifestPath: join(disabledPluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            installedPath: null,
          },
          state: {
            enabled: false,
          },
        },
      },
    });

    const result = await loadInstalledPlugins({ happyHomeDir });

    expect(result.loadedPlugins.map((plugin) => plugin.manifest.id)).toEqual(['acme.enabled']);
    expect(result.diagnosticsByPluginId['acme.enabled']).toEqual([]);
    expect(result.diagnosticsByPluginId['acme.disabled']).toBeUndefined();
  });

  it('selects the TypeScript dev entry from local link mode without treating source trust text as authority', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-entry-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writeDevelopmentOnlyPluginManifest(pluginRoot, 'acme.dev-entry');

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.dev-entry': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'prompt',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'compatible',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    const result = await loadInstalledPlugins({ happyHomeDir });

    expect(result.loadedPlugins).toHaveLength(1);
    expect(result.loadedPlugins[0]).toMatchObject({
      daemonEntryPath: null,
      devDaemonEntryPath: expect.stringMatching(/src[/\\]daemon\.ts$/),
      sourceSpec: { kind: 'path', locator: pluginRoot, trustPolicy: 'prompt', installPolicy: 'link' },
    });
    expect(result.diagnosticsByPluginId['acme.dev-entry']).toEqual([]);
  });

  it('does not misclassify a managed development-only plugin as descriptor-only', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-entry-managed-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writeDevelopmentOnlyPluginManifest(pluginRoot, 'acme.managed-dev-entry');
    await store.write({
      t: 'happier_plugin_state_v1', schemaVersion: 1,
      plugins: {
        'acme.managed-dev-entry': {
          source: {
            kind: 'archive', locator: 'https://example.invalid/plugin.tgz',
            trustPolicy: 'local_trusted', installPolicy: 'managed_install',
            resolvedPath: pluginRoot, manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: {
            mode: 'managed_install', manifestVersion: '1.0.0',
            installedPath: pluginRoot,
          },
          state: { enabled: true },
        },
      },
    });

    const result = await loadInstalledPlugins({ happyHomeDir });

    expect(result.loadedPlugins).toEqual([]);
    expect(result.diagnosticsByPluginId['acme.managed-dev-entry']).toEqual([
      expect.objectContaining({ code: 'plugin_source_kind_unsupported' }),
    ]);
  });

  it('loads managed-install plugins from the installed payload path even when their source is archived', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const installedPluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-installed-'));
    const archivePath = join(tmpdir(), 'acme-archive-plugin.tar.gz');
    const store = createPluginStateStore({ happyHomeDir });
    const canonicalInstalledPluginRoot = await realpath(installedPluginRoot);

    await writePluginManifest(installedPluginRoot, 'acme.archived');

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.archived': {
          source: {
            kind: 'archive',
            locator: archivePath,
            trustPolicy: 'local_trusted',
            installPolicy: 'managed_install',
            resolvedPath: archivePath,
            manifestPath: join(installedPluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'compatible',
            diagnostics: [],
          },
          install: {
            mode: 'managed_install',
            manifestVersion: '1.0.0',
            installedPath: installedPluginRoot,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    const result = await loadInstalledPlugins({ happyHomeDir });

    expect(result.loadedPlugins.map((plugin) => plugin.manifest.id)).toEqual(['acme.archived']);
    expect(result.loadedPlugins[0]).toMatchObject({
      pluginRootPath: canonicalInstalledPluginRoot,
      sourceSpec: {
        kind: 'archive',
        locator: archivePath,
        installPolicy: 'managed_install',
      },
    });
    expect(result.loadedPlugins[0]?.sourceSpec).not.toHaveProperty('resolvedDigest');
    expect(result.diagnosticsByPluginId['acme.archived']).toEqual([]);
  });

  it('rejects installed state that claims host-derived bundled provenance', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const installedPluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-installed-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writePluginManifest(installedPluginRoot, 'acme.spoofed-bundled');

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.spoofed-bundled': {
          source: {
            kind: 'bundled',
            locator: '@acme/spoofed-bundled',
            trustPolicy: 'local_trusted',
            installPolicy: 'managed_install',
            resolvedPath: installedPluginRoot,
            manifestPath: join(installedPluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'compatible',
            diagnostics: [],
          },
          install: {
            mode: 'managed_install',
            manifestVersion: '1.0.0',
            installedPath: installedPluginRoot,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    const result = await loadInstalledPlugins({ happyHomeDir });

    expect(result.loadedPlugins).toEqual([]);
    expect(result.diagnosticsByPluginId['acme.spoofed-bundled']).toEqual([
      expect.objectContaining({
        code: 'plugin_source_kind_unsupported',
        message: expect.stringMatching(/host-derived bundled/i),
      }),
    ]);
  });

  it('records a semantic diagnostic when the manifest id does not match the canonical plugin-state id', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-mismatch-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writePluginManifest(pluginRoot, 'acme.actual');

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.expected': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    const result = await loadInstalledPlugins({ happyHomeDir });

    expect(result.loadedPlugins).toEqual([]);
    expect(result.diagnosticsByPluginId['acme.expected']).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
      }),
    ]);
  });

  it.each(['healthy-first', 'shadow-first', 'shadow-only'] as const)('refuses a mismatched shadow without withdrawing its correctly keyed plugin (%s)', async (entryOrder) => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const firstPluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-duplicate-first-'));
    const secondPluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-duplicate-second-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writePluginManifest(firstPluginRoot, 'acme.duplicate');
    await writePluginManifest(secondPluginRoot, 'acme.duplicate');

    const plugins = {
        'acme.duplicate': {
          source: {
            kind: 'path',
            locator: firstPluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: firstPluginRoot,
            manifestPath: join(firstPluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
        'acme.duplicate-shadow': {
          source: {
            kind: 'path',
            locator: secondPluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: secondPluginRoot,
            manifestPath: join(secondPluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      } satisfies PluginStateFileV1['plugins'];
    const pluginIds = entryOrder === 'shadow-only'
      ? ['acme.duplicate-shadow'] as const
      : entryOrder === 'healthy-first'
        ? ['acme.duplicate', 'acme.duplicate-shadow'] as const
        : ['acme.duplicate-shadow', 'acme.duplicate'] as const;
    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: Object.fromEntries(pluginIds.map((pluginId) => [pluginId, plugins[pluginId]])),
    });

    const result = await loadInstalledPlugins({ happyHomeDir });

    expect(result.loadedPlugins).toMatchObject(entryOrder === 'shadow-only' ? [] : [
      { pluginId: 'acme.duplicate', pluginRootPath: await realpath(firstPluginRoot) },
    ]);
    expect(result.diagnosticsByPluginId['acme.duplicate']).toEqual(entryOrder === 'shadow-only' ? undefined : []);
    expect(result.diagnosticsByPluginId['acme.duplicate-shadow']).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
      }),
    ]);
  });

  it('rejects daemon entry paths that escape the plugin root', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-escape-'));
    const store = createPluginStateStore({ happyHomeDir });
    const manifestDir = join(pluginRoot, '.happier-plugin');

    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, 'plugin.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'acme.escape',
        version: '1.0.0',
        displayName: 'Plugin acme.escape',
        description: 'Plugin acme.escape',
        engines: {
          happier: '^0.3.0',
        },
        runtime: {
          apiVersion: 1,
        },
        entrypoints: {
          daemon: '../../outside.js',
        },
        hostAccess: {
          required: [],
          optional: [],
        },
        contributes: {},
      }, null, 2),
      'utf8',
    );

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.escape': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    const result = await loadInstalledPlugins({ happyHomeDir });

    expect(result.loadedPlugins).toEqual([]);
    expect(result.diagnosticsByPluginId['acme.escape']).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
      }),
    ]);
  });

  it('records a source-missing diagnostic and skips plugins whose daemon entry file is missing', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-missing-entry-'));
    const store = createPluginStateStore({ happyHomeDir });
    const manifestDir = join(pluginRoot, '.happier-plugin');

    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, 'plugin.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'acme.missing-daemon',
        version: '1.0.0',
        displayName: 'Plugin acme.missing-daemon',
        description: 'Plugin acme.missing-daemon',
        engines: {
          happier: '^0.3.0',
        },
        runtime: {
          apiVersion: 1,
        },
        entrypoints: {
          daemon: './missing-daemon.mjs',
        },
        hostAccess: {
          required: [],
          optional: [],
        },
        contributes: {},
      }, null, 2),
      'utf8',
    );

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.missing-daemon': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    const result = await loadInstalledPlugins({ happyHomeDir });

    expect(result.loadedPlugins).toEqual([]);
    expect(result.diagnosticsByPluginId['acme.missing-daemon']).toEqual([
      expect.objectContaining({
        code: 'plugin_source_missing',
        message: expect.stringMatching(/does not exist/i),
      }),
    ]);
  });

  it('records a manifest diagnostic and skips plugins with unsupported daemon entry plugins', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-extension-'));
    const store = createPluginStateStore({ happyHomeDir });
    const manifestDir = join(pluginRoot, '.happier-plugin');

    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, 'plugin.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'acme.bad-daemon-extension',
        version: '1.0.0',
        displayName: 'Plugin acme.bad-daemon-extension',
        description: 'Plugin acme.bad-daemon-extension',
        engines: {
          happier: '^0.3.0',
        },
        runtime: {
          apiVersion: 1,
        },
        entrypoints: {
          daemon: './daemon.ts',
        },
        hostAccess: {
          required: [],
          optional: [],
        },
        contributes: {},
      }, null, 2),
      'utf8',
    );
    await writeFile(join(pluginRoot, 'daemon.ts'), 'export default () => "nope";\n', 'utf8');

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.bad-daemon-extension': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    const result = await loadInstalledPlugins({ happyHomeDir });

    expect(result.loadedPlugins).toEqual([]);
    expect(result.diagnosticsByPluginId['acme.bad-daemon-extension']).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_invalid',
        message: expect.stringMatching(/unsupported extension/i),
      }),
    ]);
  });

  it('rejects predecessor manifests that advertise retired descriptor targets', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-unsupported-targets-'));
    const store = createPluginStateStore({ happyHomeDir });
    const manifestDir = join(pluginRoot, '.happier-plugin');

    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, 'plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'acme.unsupported-targets',
        version: '1.0.0',
        displayName: 'Plugin acme.unsupported-targets',
        description: 'Plugin acme.unsupported-targets',
        engines: {
          happier: '^0.3.0',
        },
        targets: {
          daemon: {
            entry: './daemon.js',
          },
          uiDescriptor: {
            entry: './ui.js',
          },
        },
        contributes: {
          providers: [],
          backends: [],
          hooks: [],
        },
      }, null, 2),
      'utf8',
    );

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.unsupported-targets': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    const result = await loadInstalledPlugins({ happyHomeDir });

    expect(result.loadedPlugins).toEqual([]);
    expect(result.diagnosticsByPluginId['acme.unsupported-targets']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'plugin_manifest_invalid',
          message: expect.stringMatching(/targets/i),
        }),
      ]),
    );
  });

  it('records a source-kind diagnostic when plugin state source kind is non-path for non-managed installs', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const store = createPluginStateStore({ happyHomeDir });

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.unsupported-source-kind': {
          source: {
            kind: 'package',
            locator: '@acme/unsupported-plugin',
            trustPolicy: 'prompt',
            installPolicy: 'link',
            resolvedPath: '@acme/unsupported-plugin',
            manifestPath: '@acme/unsupported-plugin/.happier-plugin/plugin.json',
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    const result = await loadInstalledPlugins({ happyHomeDir });

    expect(result.loadedPlugins).toEqual([]);
    expect(result.diagnosticsByPluginId['acme.unsupported-source-kind']).toEqual([
      expect.objectContaining({
        code: 'plugin_source_kind_unsupported',
        message: expect.stringMatching(/unsupported for non-managed installs/i),
      }),
    ]);
  });

  it('reloads explicit manifest-file installs from the stored manifest path instead of the parent directory', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-standalone-'));
    const manifestPath = join(pluginRoot, 'standalone-plugin.json');
    const store = createPluginStateStore({ happyHomeDir });

    await writeStandaloneManifest(manifestPath, 'acme.standalone');
    const canonicalManifestPath = await realpath(manifestPath);

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.standalone': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath,
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    const result = await loadInstalledPlugins({ happyHomeDir });

    expect(result.loadedPlugins.map((plugin) => plugin.manifest.id)).toEqual(['acme.standalone']);
    expect(result.loadedPlugins[0]?.manifestPath).toBe(canonicalManifestPath);
    expect(result.diagnosticsByPluginId['acme.standalone']).toEqual([]);
  });
});
