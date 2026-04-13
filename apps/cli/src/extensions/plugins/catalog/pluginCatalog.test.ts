import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/extensions/plugins/testkit/samplePluginFixture';
import { createPluginStateStore } from '@/extensions/plugins/store/pluginStateStore';

import { installLocalPathPlugin, readInstalledPluginCatalog } from './pluginCatalog';

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
      const installResult = await installLocalPathPlugin({
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
        hooks: ['backend.terminalRuntime.bindTranscript'],
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
});
