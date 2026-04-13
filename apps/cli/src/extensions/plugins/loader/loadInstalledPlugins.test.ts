import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadInstalledPlugins } from './loadInstalledPlugins';
import { createPluginStateStore } from '../store/pluginStateStore';

async function writePluginManifest(rootDir: string, pluginId: string): Promise<void> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: pluginId,
      version: '1.0.0',
      displayName: `Plugin ${pluginId}`,
      description: `Plugin ${pluginId}`,
      engines: {
        happier: '^0.2.0',
      },
      targets: {
        daemon: {
          entry: './daemon.js',
        },
      },
      contributions: {
        providers: [],
        backends: [],
        hooks: [],
      },
    }, null, 2),
    'utf8',
  );
}

async function writeStandaloneManifest(manifestPath: string, pluginId: string): Promise<void> {
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      id: pluginId,
      version: '1.0.0',
      displayName: `Plugin ${pluginId}`,
      description: `Plugin ${pluginId}`,
      engines: {
        happier: '^0.2.0',
      },
      targets: {
        daemon: {
          entry: './daemon.js',
        },
      },
      contributions: {
        providers: [],
        backends: [],
        hooks: [],
      },
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
            manifestDigest: null,
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
            manifestDigest: null,
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
            manifestDigest: 'sha256:abc123',
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
    expect(result.diagnosticsByPluginId['acme.archived']).toEqual([]);
  });

  it('records compatibility diagnostics for enabled plugins with missing manifests', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const missingPluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-missing-'));
    const store = createPluginStateStore({ happyHomeDir });

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.missing': {
          source: {
            kind: 'path',
            locator: missingPluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: missingPluginRoot,
            manifestPath: join(missingPluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            manifestDigest: null,
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
    expect(result.diagnosticsByPluginId['acme.missing']).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_missing',
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
            manifestDigest: null,
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

  it('rejects daemon entry paths that escape the plugin root', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-escape-'));
    const store = createPluginStateStore({ happyHomeDir });
    const manifestDir = join(pluginRoot, '.happier-plugin');

    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, 'plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'acme.escape',
        version: '1.0.0',
        displayName: 'Plugin acme.escape',
        description: 'Plugin acme.escape',
        engines: {
          happier: '^0.2.0',
        },
        targets: {
          daemon: {
            entry: '../../outside.js',
          },
        },
        contributions: {
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
            manifestDigest: null,
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

  it('records a semantic diagnostic and skips plugins whose manifests advertise unsupported descriptor targets', async () => {
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
          happier: '^0.2.0',
        },
        targets: {
          daemon: {
            entry: './daemon.js',
          },
          uiDescriptor: {
            entry: './ui.js',
          },
        },
        contributions: {
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
            manifestDigest: null,
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
    expect(result.diagnosticsByPluginId['acme.unsupported-targets']).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/uiDescriptor/i),
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
            manifestDigest: null,
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
