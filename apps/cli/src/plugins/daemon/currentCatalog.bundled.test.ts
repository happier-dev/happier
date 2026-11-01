import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BundledPluginPublicationFailure } from '@/plugins/validation/diagnostics/types';

const { publicationFailures } = vi.hoisted(() => ({ publicationFailures: [{
  packageName: '@happier-dev/plugins-broken',
  pluginId: 'happier.broken',
  diagnostic: { code: 'plugin_package_build_failed', message: 'Missing staged export ./dist/index.js' },
}] satisfies readonly BundledPluginPublicationFailure[] }));

// Filesystem publication is an external boundary; bundled manifest ingestion
// and the current catalog remain real. This source process does not admit dist failures.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import(
    '@/plugins/projection/registry/builtIn/locators.testkit'
  );
  return createBundledPluginPublicationFsFixture(actual, publicationFailures);
});

import { projectBundledPluginCatalogEntries } from '@/plugins/projection/catalog/installed';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { PLUGIN_MANIFEST_RELATIVE_PATH } from '@/plugins/store/paths';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import { withTempDir } from '@/testkit/fs/tempDir';
import { readCurrentDaemonPluginCatalogSnapshot } from './currentCatalog';

describe('current daemon bundled plugin catalog', () => {
  it('projects publication failures without admitting them in a source runtime', async () => {
    const bundled = loadCurrentBundledPluginLocatorResult();
    const publishedEntries = projectBundledPluginCatalogEntries({
      loadedPlugins: bundled.loadedPlugins,
      pluginFailures: publicationFailures,
    });
    expect(publishedEntries.find((entry) => entry.pluginId === 'happier.broken')).toMatchObject({
      enabled: false,
      manifest: null,
      compatibility: { status: 'load_error' },
      diagnostics: [{ code: 'plugin_package_build_failed', message: 'Missing staged export ./dist/index.js' }],
    });
    await withTempDir('happier-current-bundled-catalog-', async (happyHomeDir) => {
      const reloadController = createPluginReloadController({ happyHomeDir });
      try {
        const catalog = await readCurrentDaemonPluginCatalogSnapshot({ reloadController, happyHomeDir });
        expect(catalog.plugins.some((entry) => entry.pluginId === 'happier.channels')).toBe(true);
        expect(catalog.plugins.some((entry) => entry.pluginId === 'happier.broken')).toBe(false);
        expect(catalog.tools).toEqual([]);
      } finally {
        await reloadController.shutdown();
      }
    });
  });

  it('retains an attributable bundled diagnostic in the one current catalog', async () => {
    // Discord targets Channels. Selecting only Claude makes the real target
    // unavailable; the admission owner, rather than a fake registry, diagnoses it.
    const fixture = await createAdmittedPluginRuntimeFixture({
      runtimeOptions: { pluginIds: ['happier.agent.claude'] },
    });
    try {
      const snapshot = await readCurrentDaemonPluginCatalogSnapshot({
        reloadController: fixture.controller, happyHomeDir: fixture.happyHomeDir,
      });
      const discord = snapshot.plugins.find((entry) => entry.pluginId === 'happier.channel.discord');
      expect(discord).toMatchObject({ source: { kind: 'bundled' } });
      expect(discord?.contributionIntrospection.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'target_retired',
            details: expect.objectContaining({
              target: expect.objectContaining({ pluginId: 'happier.channels', pointId: 'providers' }),
            }),
          }),
          plugin: expect.objectContaining({ id: 'happier.channel.discord', source: 'bundled' }),
        }),
      ]));
      expect(snapshot.plugins.filter((entry) => entry.pluginId === 'happier.channel.discord')).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it('projects installed catalog identity without also adding its bundled catalog twin', async () => {
    await withTempDir('happier-current-installed-catalog-', async (directory) => {
      const happyHomeDir = join(directory, 'home');
      const pluginRoot = join(directory, 'channels');
      const manifestPath = join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH);
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, JSON.stringify(createPluginManifestV2Fixture({
        id: 'happier.channels', version: '0.0.0-dev', displayName: 'Local Channels',
        entrypoints: {},
      })), 'utf8');
      await seedCurrentLocalPathPluginFixture({
        happyHomeDir, pluginRoot, pluginId: 'happier.channels', manifestVersion: '0.0.0-dev',
      });
      // The durable catalog can be read before a serving lease exists. This
      // does not claim that a same-identity external runtime is admitted.
      const reloadController = createPluginReloadController({ happyHomeDir });
      try {
        const snapshot = await readCurrentDaemonPluginCatalogSnapshot({ reloadController, happyHomeDir });
        expect(snapshot.plugins.filter((entry) => entry.pluginId === 'happier.channels')).toEqual([
          expect.objectContaining({ title: 'Local Channels', source: expect.objectContaining({ kind: 'path' }) }),
        ]);
        const store = createPluginRegistryStateStore({
          happyHomeDir,
          runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController }),
        });
        const disabledChange = await store.setEnabledWithResult('happier.channels', false);
        expect(disabledChange?.transaction).toMatchObject({ status: 'committed' });
        expect(reloadController.getState().lastResult?.runningSessionDisposition).toBe('retainRunningSessions');
        expect((await store.readSnapshot()).bundledPluginEnabledById['happier.channels']).toBe(false);
        const disabled = await readCurrentDaemonPluginCatalogSnapshot({ reloadController, happyHomeDir });
        expect(disabled.plugins.filter(entry => entry.pluginId === 'happier.channels')).toEqual([
          expect.objectContaining({ source: expect.objectContaining({ kind: 'path' }),
            accountEnabled: true, machineEnabled: false, enabled: false }),
        ]);
        expect(disabled.plugins.find(entry => entry.pluginId === 'happier.channels')?.appliedGeneration).toBeNull();
        await store.setEnabledWithResult('happier.channels', true);
        expect((await store.readSnapshot()).bundledPluginEnabledById['happier.channels']).toBe(true);
        expect((await readCurrentDaemonPluginCatalogSnapshot({ reloadController, happyHomeDir }))
          .plugins.find(entry => entry.pluginId === 'happier.channels'))
          .toMatchObject({ accountEnabled: true, machineEnabled: true, enabled: true });
      } finally {
        await reloadController.shutdown();
      }
    });
  });
});
