import { mkdir, mkdtemp, realpath, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPluginStateStore } from '@/plugins/store/state';

import { installPluginFromLocator, readInstalledPluginCatalog } from './installed';

async function materializeCatalogPluginFixture(rootDir: string, pluginId: string): Promise<void> {
  await mkdir(join(rootDir, '.happier-plugin'), { recursive: true });
  await writeFile(join(rootDir, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
  await writeFile(
    join(rootDir, '.happier-plugin', 'plugin.json'),
    JSON.stringify(createPluginManifestV2Fixture({
      id: pluginId,
      displayName: `Plugin ${pluginId}`,
      description: `Catalog fixture for ${pluginId}`,
      entrypoints: {
        main: './daemon.mjs',
      },
    }), null, 2),
    'utf8',
  );
}

describe('pluginCatalog', () => {
  it('uninstalls only the selected local plugin state without deleting linked source files', async () => {
    const home = await createTempDir('happier-plugin-catalog-uninstall-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const firstSourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-uninstall-source-a-'));
    const secondSourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-uninstall-source-b-'));
    await materializeCatalogPluginFixture(firstSourceRoot, 'acme.remove-me');
    await materializeCatalogPluginFixture(secondSourceRoot, 'acme.keep-me');
    const catalog = await import('./installed') as typeof import('./installed') & {
      uninstallPluginFromCatalog?: (params: Readonly<{
        pluginId: string;
        happyHomeDir?: string;
      }>) => Promise<unknown>;
    };

    try {
      await installPluginFromLocator({
        locator: firstSourceRoot,
        happyHomeDir: home,
        skipIfInstalled: true,
      });
      await installPluginFromLocator({
        locator: secondSourceRoot,
        happyHomeDir: home,
        skipIfInstalled: true,
      });

      expect(catalog.uninstallPluginFromCatalog).toEqual(expect.any(Function));
      if (!catalog.uninstallPluginFromCatalog) return;
      const result = await catalog.uninstallPluginFromCatalog({
        pluginId: 'acme.remove-me',
        happyHomeDir: home,
      });

      expect(result).toMatchObject({
        ok: true,
        pluginId: 'acme.remove-me',
        removedInstalledPath: null,
        entry: {
          pluginId: 'acme.remove-me',
          source: {
            kind: 'path',
          },
        },
      });

      const entries = await readInstalledPluginCatalog({ happyHomeDir: home });
      expect(entries.map((entry) => entry.pluginId)).toEqual(['acme.keep-me']);
      await expect(readFile(join(firstSourceRoot, '.happier-plugin', 'plugin.json'), 'utf8')).resolves.toContain('acme.remove-me');
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('rejects host-derived bundled plugin state as not uninstallable', async () => {
    const home = await createTempDir('happier-plugin-catalog-uninstall-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();
    const store = createPluginStateStore({ happyHomeDir: home });
    const bundledRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundled-state-'));
    const catalog = await import('./installed') as typeof import('./installed') & {
      uninstallPluginFromCatalog?: (params: Readonly<{
        pluginId: string;
        happyHomeDir?: string;
      }>) => Promise<unknown>;
    };

    try {
      await materializeCatalogPluginFixture(bundledRoot, 'happier.agent.bundled');
      await store.write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          'happier.agent.bundled': {
            source: {
              kind: 'bundled',
              locator: '@happier-dev/plugins-bundled',
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedPath: bundledRoot,
              manifestPath: join(bundledRoot, '.happier-plugin', 'plugin.json'),
            },
            compatibility: {
              status: 'compatible',
              diagnostics: [],
            },
            install: {
              mode: 'link',
              manifestVersion: '1.0.0',
              manifestDigest: 'bundled:@happier-dev/plugins-bundled@0.0.0',
              installedPath: null,
            },
            state: {
              enabled: true,
            },
          },
        },
      });

      expect(catalog.uninstallPluginFromCatalog).toEqual(expect.any(Function));
      if (!catalog.uninstallPluginFromCatalog) return;
      const result = await catalog.uninstallPluginFromCatalog({
        pluginId: 'happier.agent.bundled',
        happyHomeDir: home,
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostics: [
          {
            code: 'plugin_source_kind_unsupported',
            message: expect.stringMatching(/bundled/i),
          },
        ],
      });
      expect((await store.read()).plugins['happier.agent.bundled']).toBeDefined();
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('marks workspace-local path dev installs as watched local trusted sources', async () => {
    const home = await createTempDir('happier-plugin-catalog-dev-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const workspaceRoot = await createTempDir('happier-plugin-dev-workspace-');
    const sourceRoot = await createTempDir('happier-plugin-dev-source-', workspaceRoot);
    await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    await writeFile(join(sourceRoot, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
    await writeFile(join(sourceRoot, 'src', 'daemon.ts'), 'export function activate() {}\n', 'utf8');
    await writeFile(
      join(sourceRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify(createPluginManifestV2Fixture({
        id: 'acme.dev-install',
        displayName: 'Acme Dev Install',
        description: 'Dev install source metadata',
        entrypoints: {
          main: './daemon.mjs',
          dev: './src/daemon.ts',
        },
      }), null, 2),
      'utf8',
    );

    try {
      const installResult = await installPluginFromLocator({
        locator: sourceRoot,
        happyHomeDir: home,
        skipIfInstalled: true,
        dev: true,
        workspaceRoot,
      });

      expect(installResult.ok).toBe(true);
      if (!installResult.ok) return;

      expect(installResult.entry.source).toMatchObject({
        kind: 'path',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
        devWatch: true,
      });

      const store = createPluginStateStore({ happyHomeDir: home });
      const state = await store.read();
      expect(state.plugins['acme.dev-install']?.source).toMatchObject({
        kind: 'path',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
        devWatch: true,
      });
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(workspaceRoot);
      await removeTempDir(home);
    }
  });

  it('does not silently trust arbitrary local dev installs outside the workspace', async () => {
    const home = await createTempDir('happier-plugin-catalog-dev-');
    const workspaceRoot = await createTempDir('happier-plugin-dev-workspace-');
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-outside-workspace-'));
    await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    await writeFile(join(sourceRoot, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
    await writeFile(join(sourceRoot, 'src', 'daemon.ts'), 'export function activate() {}\n', 'utf8');
    await writeFile(
      join(sourceRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify(createPluginManifestV2Fixture({
        id: 'acme.dev-outside-workspace',
        displayName: 'Acme Dev Outside Workspace',
        description: 'Dev install trust-policy source metadata',
        entrypoints: {
          main: './daemon.mjs',
          dev: './src/daemon.ts',
        },
      }), null, 2),
      'utf8',
    );

    try {
      const installResult = await installPluginFromLocator({
        locator: sourceRoot,
        happyHomeDir: home,
        skipIfInstalled: true,
        dev: true,
        workspaceRoot,
      });

      expect(installResult.ok).toBe(true);
      if (!installResult.ok) return;

      expect(installResult.entry.source).toMatchObject({
        kind: 'path',
        trustPolicy: 'prompt',
        installPolicy: 'link',
      });
      expect(installResult.entry.source).not.toHaveProperty('devWatch');
      expect(installResult.entry.diagnostics).toEqual([
        expect.objectContaining({
          code: 'plugin_trust_approval_required',
          message: expect.stringContaining(sourceRoot),
        }),
      ]);
      expect(installResult.entry.diagnostics[0]?.message).toContain(workspaceRoot);
      expect(installResult.entry.diagnostics[0]?.message).toMatch(/install from within the workspace/i);

      const state = await createPluginStateStore({ happyHomeDir: home }).read();
      expect(state.plugins['acme.dev-outside-workspace']?.source).toMatchObject({
        kind: 'path',
        trustPolicy: 'prompt',
        installPolicy: 'link',
      });
      expect(state.plugins['acme.dev-outside-workspace']?.source).not.toHaveProperty('devWatch');
      expect(state.plugins['acme.dev-outside-workspace']?.compatibility.diagnostics).toEqual([
        expect.objectContaining({
          code: 'plugin_trust_approval_required',
          message: expect.stringContaining(sourceRoot),
        }),
      ]);
    } finally {
      await removeTempDir(sourceRoot);
      await removeTempDir(workspaceRoot);
      await removeTempDir(home);
    }
  });

  it('installs a local-path plugin and reads it back as a catalog entry', async () => {
    const home = await createTempDir('happier-plugin-catalog-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    await materializeSamplePluginFixture(sourceRoot);
    const canonicalSourceRoot = await realpath(sourceRoot);

    try {
      const installResult = await installPluginFromLocator({
        locator: sourceRoot,
        happyHomeDir: home,
        skipIfInstalled: true,
      });

      expect(installResult.ok).toBe(true);
      if (!installResult.ok) return;

      expect(installResult.alreadyInstalled).toBe(false);
      expect(installResult.entry.pluginId).toBe(SAMPLE_PLUGIN_ID);
      expect(installResult.entry.contributionIds).toEqual({
        agents: ['acme.sample.provider'],
        agentRuntimes: ['acme.sample.provider'],
        hooks: ['agent.resolvePrerequisites'],
      });

      const entries = await readInstalledPluginCatalog({ happyHomeDir: home });
      expect(entries).toHaveLength(1);
      expect(entries[0].pluginId).toBe(SAMPLE_PLUGIN_ID);
      expect(entries[0].title).toBe('Acme Sample');
      expect(entries[0].enabled).toBe(true);
      expect(entries[0].source.kind).toBe('path');
      expect(entries[0].source.locator).toBe(canonicalSourceRoot);
      expect(entries[0].manifest?.id).toBe(SAMPLE_PLUGIN_ID);
      expect(entries[0].contributionIds.agents).toEqual(['acme.sample.provider']);
      expect(entries[0].contributionIds.agentRuntimes).toEqual(['acme.sample.provider']);
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('surfaces a diagnostic when an enabled plugin declares a missing daemon entry file', async () => {
    const home = await createTempDir('happier-plugin-catalog-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
    await writeFile(
      join(sourceRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify(createPluginManifestV2Fixture({
        schemaVersion: 2,
        id: 'acme.missing-daemon',
        version: '1.0.0',
        displayName: 'Acme Missing Daemon',
        description: 'Plugin manifest declares a daemon entry that is missing on disk',
        engines: { happier: '^0.2.0' },
        uses: [],
        entrypoints: { main: './missing-daemon.mjs' },
        permissions: { required: [], optional: [] },
        contributes: {},
      }), null, 2),
      'utf8',
    );

    try {
      const installResult = await installPluginFromLocator({
        locator: sourceRoot,
        happyHomeDir: home,
        skipIfInstalled: true,
      });

      expect(installResult.ok).toBe(true);
      if (!installResult.ok) return;

      const entries = await readInstalledPluginCatalog({ happyHomeDir: home });
      expect(entries).toHaveLength(1);
      expect(entries[0].pluginId).toBe('acme.missing-daemon');
      expect(entries[0].diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'plugin_source_missing',
            message: expect.stringMatching(/daemon entry does not exist/i),
          }),
        ]),
      );
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('surfaces a missing-install-path diagnostic for archive-backed entries without dropping the entry', async () => {
    const home = await createTempDir('happier-plugin-catalog-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const store = createPluginStateStore({ happyHomeDir: home });

    try {
      await store.write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          'acme.descriptor-only': {
            source: {
              kind: 'archive',
              locator: '/plugins/acme.descriptor-only.tar.gz',
              trustPolicy: 'local_trusted',
              installPolicy: 'managed_install',
              resolvedPath: '/plugins/acme.descriptor-only.tar.gz',
              manifestPath: '/plugins/acme.descriptor-only/.happier-plugin/plugin.json',
            },
            compatibility: {
              status: 'compatible',
              diagnostics: [],
            },
            install: {
              mode: 'managed_install',
              manifestVersion: '1.0.0',
              manifestDigest: null,
              installedPath: '/plugins/acme.descriptor-only',
            },
            state: {
              enabled: true,
            },
          },
        },
      });

      const entries = await readInstalledPluginCatalog({ happyHomeDir: home });
      expect(entries).toHaveLength(1);
      expect(entries[0].pluginId).toBe('acme.descriptor-only');
      expect(entries[0].title).toBe('acme.descriptor-only');
      expect(entries[0].enabled).toBe(true);
      expect(entries[0].manifest).toBeNull();
      expect(entries[0].diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'plugin_source_missing',
          }),
        ]),
      );
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('surfaces an unsupported-source-kind diagnostic for non-managed installs that are not path-backed', async () => {
    const home = await createTempDir('happier-plugin-catalog-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const store = createPluginStateStore({ happyHomeDir: home });

    try {
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

      const entries = await readInstalledPluginCatalog({ happyHomeDir: home });
      expect(entries).toHaveLength(1);
      expect(entries[0].pluginId).toBe('acme.unsupported-source-kind');
      expect(entries[0].manifest).toBeNull();
      expect(entries[0].diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'plugin_source_kind_unsupported',
            message: expect.stringMatching(/unsupported for non-managed installs/i),
          }),
        ]),
      );
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });
});
