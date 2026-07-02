import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
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

describe('pluginCatalog', () => {
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
        providers: ['acme.sample.provider'],
        backends: ['acme.sample.backend'],
        hooks: ['backend.resolveRuntimePrerequisites'],
      });

      const entries = await readInstalledPluginCatalog({ happyHomeDir: home });
      expect(entries).toHaveLength(1);
      expect(entries[0].pluginId).toBe(SAMPLE_PLUGIN_ID);
      expect(entries[0].title).toBe('Acme Sample');
      expect(entries[0].enabled).toBe(true);
      expect(entries[0].source.kind).toBe('path');
      expect(entries[0].source.locator).toBe(canonicalSourceRoot);
      expect(entries[0].manifest?.id).toBe(SAMPLE_PLUGIN_ID);
      expect(entries[0].contributionIds.providers).toEqual(['acme.sample.provider']);
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
        runtime: { apiVersion: 1, capabilities: [] },
        targets: { daemon: { entry: './missing-daemon.mjs' } },
        permissions: [],
        contributes: [],
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
