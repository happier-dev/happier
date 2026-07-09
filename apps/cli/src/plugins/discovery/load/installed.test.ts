import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadInstalledPlugins } from './installed';
import { createPluginStateStore } from '@/plugins/store/state';

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
        happier: '^0.2.0',
      },
      uses: [],
      entrypoints: {
        main: './daemon.js',
      },
      permissions: {
        required: [],
        optional: [],
      },
      contributes: {},
    }, null, 2),
    'utf8',
  );
}

async function writePluginManifestWithEntrypoints(rootDir: string, pluginId: string): Promise<void> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(join(rootDir, 'dist'), { recursive: true });
  await mkdir(join(rootDir, 'src'), { recursive: true });
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(rootDir, 'dist', 'daemon.mjs'), 'export const version = "compiled";\n', 'utf8');
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
        happier: '^0.2.0',
      },
      uses: [],
      entrypoints: {
        main: './dist/daemon.mjs',
        dev: './src/daemon.ts',
      },
      permissions: {
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
        happier: '^0.2.0',
      },
      uses: [],
      entrypoints: {
        main: './daemon.js',
      },
      permissions: {
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

  it('carries the TypeScript dev daemon entry for enabled local trusted path plugins', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-entry-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writePluginManifestWithEntrypoints(pluginRoot, 'acme.dev-entry');

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.dev-entry': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
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

    expect(result.loadedPlugins).toHaveLength(1);
    expect(result.loadedPlugins[0]).toMatchObject({
      daemonEntryPath: expect.stringMatching(/dist[/\\]daemon\.mjs$/),
      devDaemonEntryPath: expect.stringMatching(/src[/\\]daemon\.ts$/),
    });
    expect(result.diagnosticsByPluginId['acme.dev-entry']).toEqual([]);
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

    expect(result.loadedPlugins).toEqual([]);
    expect(result.diagnosticsByPluginId['acme.spoofed-bundled']).toEqual([
      expect.objectContaining({
        code: 'plugin_source_kind_unsupported',
        message: expect.stringMatching(/host-derived bundled/i),
      }),
    ]);
  });

  it('preserves stored trust policy for linked path installs when reloading plugin state', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-prompt-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writePluginManifest(pluginRoot, 'acme.prompt-path');

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.prompt-path': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'prompt',
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

    expect(result.loadedPlugins).toEqual([
      expect.objectContaining({
        pluginId: 'acme.prompt-path',
        sourceSpec: expect.objectContaining({
          kind: 'path',
          locator: pluginRoot,
          trustPolicy: 'prompt',
          installPolicy: 'link',
        }),
      }),
    ]);
    expect(result.diagnosticsByPluginId['acme.prompt-path']).toEqual([]);
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

  it('rejects duplicate enabled plugin owner ids deterministically before projection', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-loader-'));
    const firstPluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-duplicate-first-'));
    const secondPluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-duplicate-second-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writePluginManifest(firstPluginRoot, 'acme.duplicate');
    await writePluginManifest(secondPluginRoot, 'acme.duplicate');

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
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
            manifestDigest: null,
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
    expect(result.diagnosticsByPluginId['acme.duplicate']).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_duplicate_id',
        message: expect.stringContaining(firstPluginRoot),
      }),
    ]);
    expect(result.diagnosticsByPluginId['acme.duplicate-shadow']).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_duplicate_id',
        message: expect.stringContaining(secondPluginRoot),
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
          happier: '^0.2.0',
        },
        uses: [],
        entrypoints: {
          main: '../../outside.js',
        },
        permissions: {
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
          happier: '^0.2.0',
        },
        uses: [],
        entrypoints: {
          main: './missing-daemon.mjs',
        },
        permissions: {
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
    expect(result.diagnosticsByPluginId['acme.missing-daemon']).toEqual([
      expect.objectContaining({
        code: 'plugin_source_missing',
        message: expect.stringMatching(/does not exist/i),
      }),
    ]);
  });

  it('records a semantic diagnostic and skips plugins with unsupported daemon entry plugins', async () => {
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
          happier: '^0.2.0',
        },
        uses: [],
        entrypoints: {
          main: './daemon.ts',
        },
        permissions: {
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
    expect(result.diagnosticsByPluginId['acme.bad-daemon-extension']).toEqual([
      expect.objectContaining({
        code: 'plugin_manifest_semantic_invalid',
        message: expect.stringMatching(/unsupported extension/i),
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
