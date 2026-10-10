import { describe, expect, it, vi } from 'vitest';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';

const installedBoundary = vi.hoisted(() => ({
  readInstalledPluginCatalogSnapshot: vi.fn(async () => ({ revision: 8, entries: [] })),
}));

vi.mock('@/plugins/projection/catalog/installed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/catalog/installed')>();
  return {
    ...actual,
    readInstalledPluginCatalogSnapshot: installedBoundary.readInstalledPluginCatalogSnapshot,
  };
});

// Publication failures belong to the packaged runtime. Source execution has
// no publication claim and intentionally does not consume staged failures.
vi.mock('@/packagedRuntime/resolvePackagedRuntimeEntrypoint', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/packagedRuntime/resolvePackagedRuntimeEntrypoint')>(),
  isExecutingFirstPartySourceRuntime: () => false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import(
    '@/plugins/projection/registry/builtIn/locators.testkit'
  );
  return createBundledPluginPublicationFsFixture(actual, [{
    packageName: '@happier-dev/plugins-broken',
    pluginId: 'happier.broken',
    diagnostic: { code: 'plugin_package_build_failed', message: 'Missing staged export ./dist/index.js' },
  }]);
});

vi.mock('@/plugins/projection/registry/sources/generatedBundledPluginManifests', () => ({
  BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS: Object.freeze([Object.freeze({
    pluginId: 'happier.channels',
    manifest: {
      schemaVersion: 2,
      id: 'happier.channels',
      version: '0.0.0',
      displayName: 'Channels',
      engines: { happier: '^0.0.0' },
      runtime: { apiVersion: 1 },
      contributes: {},
    },
    manifestPath: 'bundled:happier.channels',
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: '/bundled/happier.channels',
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: '0.0.0',
    }),
  })]),
}));

import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { readCurrentDaemonPluginCatalogSnapshot } from './currentCatalog';

function runtimeLease() {
  const occurrenceId = createPluginRuntimeOccurrenceId('happier.channels');
  return {
    registry: {
      contributes: { tools: [], actionsById: new Map() },
      pluginDiagnosticsByPluginId: {
        'happier.channels': [{
          code: 'target_semantics_unavailable',
          message: 'Targeted contribution admission rejected (target_semantics_unavailable).',
          stage: 'normalization',
          contribution: { pluginId: 'happier.channels', localId: 'providers' },
          details: {
            targetPluginId: 'happier.channels',
            pointId: 'providers',
            protocol: { id: 'happier.channels/providers', version: 1 },
          },
        }],
      },
      pluginFinalPolicyCurrentRuntimesById: new Map([['happier.channels', {
        occurrenceId,
        sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'fixture-cli-root' } },
        desiredOccurrenceId: occurrenceId,
        appliedOccurrenceId: occurrenceId,
        applied: true,
        selectedAccess: [],
      }]]),
    },
    source: 'active' as const,
    durableRevision: 8,
    release: vi.fn(async () => {}),
  };
}

describe('current daemon bundled plugin catalog', () => {
  it('keeps a failed bundled plugin visible as a diagnostic without admitting its contributions', async () => {
    const reloadController = {
      tryAcquireRuntimeRegistry: () => null,
    } as unknown as PluginReloadController;
    const catalog = await readCurrentDaemonPluginCatalogSnapshot({ reloadController });
    expect(catalog.plugins.map((entry) => entry.pluginId)).toEqual([
      'happier.broken', 'happier.channels',
    ]);
    expect(catalog.plugins[0]).toMatchObject({
      enabled: false,
      manifest: null,
      compatibility: { status: 'load_error' },
      diagnostics: [{ code: 'plugin_package_build_failed', message: 'Missing staged export ./dist/index.js' }],
    });
  });

  it('retains an attributable bundled diagnostic in the one current catalog', async () => {
    const lease = runtimeLease();
    const currentRuntime = lease.registry.pluginFinalPolicyCurrentRuntimesById
      .get('happier.channels');
    if (!currentRuntime) throw new Error('Expected current bundled runtime');
    const occurrenceId = currentRuntime.occurrenceId;
    const reloadController = {
      tryAcquireRuntimeRegistry: () => lease,
    } as unknown as PluginReloadController;

    await expect(readCurrentDaemonPluginCatalogSnapshot({ reloadController })).resolves.toMatchObject({
      plugins: [{ pluginId: 'happier.broken' }, {
        pluginId: 'happier.channels',
        desiredGeneration: occurrenceId,
        appliedGeneration: occurrenceId,
        source: { kind: 'bundled' },
        contributionIntrospection: {
          diagnostics: [expect.objectContaining({
            data: expect.objectContaining({
              code: 'target_semantics_unavailable',
              details: {
                targetPluginId: 'happier.channels',
                pointId: 'providers',
                protocol: { id: 'happier.channels/providers', version: 1 },
              },
            }),
            plugin: { id: 'happier.channels', version: '0.0.0', source: 'bundled' },
          })],
        },
      }],
      tools: [],
    });
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it('keeps an installed local happier-prefixed plugin external instead of adding its bundled twin', async () => {
    const externalEntry = {
      pluginId: 'happier.channels',
      desiredGeneration: 'external-generation',
      appliedGeneration: null,
      admittedIntegrity: null,
      title: 'Local Channels',
      description: null,
      version: '0.0.0-dev',
      enabled: true,
      source: {
        kind: 'path',
        locator: '/plugins/happier.channels',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
        resolvedPath: '/plugins/happier.channels',
        manifestPath: '/plugins/happier.channels/plugin.json',
      },
      install: { mode: 'link', manifestVersion: '0.0.0-dev' },
      compatibility: { status: 'compatible', diagnostics: [] },
      manifestPath: '/plugins/happier.channels/plugin.json',
      manifest: null,
      contributionIntrospection: { version: 1, generation: 0, diagnostics: [], contributions: [] },
      diagnostics: [],
    } satisfies PluginCatalogEntry;
    installedBoundary.readInstalledPluginCatalogSnapshot.mockResolvedValueOnce({
      revision: 9,
      entries: [externalEntry],
    } as never);
    const reloadController = {
      tryAcquireRuntimeRegistry: () => null,
    } as unknown as PluginReloadController;

    const snapshot = await readCurrentDaemonPluginCatalogSnapshot({ reloadController });

    expect(snapshot.plugins).toHaveLength(2);
    expect(snapshot.plugins[1]).toMatchObject({
      pluginId: 'happier.channels',
      source: { kind: 'path' },
    });
  });
});
