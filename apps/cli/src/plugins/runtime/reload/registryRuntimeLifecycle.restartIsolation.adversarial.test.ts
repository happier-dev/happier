import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import {
  createPluginRegistryStateStore,
  type CommitPluginRegistryInstallationInput,
} from '@/plugins/store/registry/currentState';
import { prepareOwnedImmutablePluginGeneration } from '@/plugins/store/registry/generationStore';
import {
  createLocalPathPluginDistributionIdentity,
  createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import { PluginStateFileV1Schema } from '@/plugins/store/state';

import { createPluginReloadController } from './controller';
import { createDaemonPluginRegistryRuntimeLifecycle } from './registryRuntimeLifecycle';

vi.mock('@/plugins/projection/registry/resolveBuiltInContributions', () => ({
  resolveBuiltInContributions: () => Object.freeze({
    agents: Object.freeze([]),
        providers: Object.freeze([]),
  }),
}));

type FixtureInstallInput = Omit<CommitPluginRegistryInstallationInput, 'preparedGeneration'> & Readonly<{
  sourceRootPath: string;
  manifestRelativePath: string;
}>;

async function installFixtureCandidate(
  store: ReturnType<typeof createPluginRegistryStateStore>,
  input: FixtureInstallInput,
) {
  const { sourceRootPath, manifestRelativePath, ...installation } = input;
  const preparedGeneration = await prepareOwnedImmutablePluginGeneration({
    paths: store.paths,
    pluginId: input.pluginId,
    sourceRootPath,
    manifestRelativePath,
    distribution: input.trust.distribution,
    updatePolicy: input.updatePolicy,
    createdAtMs: Date.now(),
  });
  try {
    return await store.install({ ...installation, preparedGeneration });
  } finally {
    await preparedGeneration.cleanup();
  }
}

async function createPluginFixture(
  happyHomeDir: string,
  pluginId: string,
  activation: 'startup' | 'demand' = 'startup',
) {
  const pluginRoot = join(happyHomeDir, `${pluginId}-source`);
  const counterPath = join(happyHomeDir, `${pluginId}-executions.log`);
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  const writeManifest = async (version: string, actionId = 'identity') => {
    await writeFile(
      join(pluginRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify(createPluginManifestV2Fixture({
        schemaVersion: 2,
        id: pluginId,
        version,
        displayName: pluginId,
        description: 'Restart-isolation fixture',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        ...(activation === 'startup' ? { activation: { events: [{ kind: 'startup' as const }] } } : {}),
        hostAccess: { required: [], optional: [] },
        contributes: {
          actions: [{
            id: actionId,
            title: actionId,
            scopes: ['global'],
            surfaces: ['cli'],
            execution: { target: 'daemon' },
            placementBindings: ['commandPalette'],
            dangerLevel: 'safe',
          }],
        },
      })),
      'utf8',
    );
  };
  await writeManifest('1.0.0');
  await writeFile(join(pluginRoot, 'daemon.mjs'), `
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(counterPath)}, 'module\\n');
    export function activate(api) {
      appendFileSync(${JSON.stringify(counterPath)}, 'activate\\n');
      api.actions.register('identity', async () => ({ pluginId: ${JSON.stringify(pluginId)} }));
      return async () => appendFileSync(${JSON.stringify(counterPath)}, 'cleanup\\n');
    }
  `, 'utf8');
  const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
  const trust = createPluginTrustRecord({ pluginId, distribution, approvedAtMs: 1 });
  const createInput = (version: string) => ({
    pluginId,
    sourceRootPath: pluginRoot,
    manifestRelativePath: '.happier-plugin/plugin.json',
    catalogRecord: PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        [pluginId]: {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'prompt',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: version, trust, updatePolicy: 'manual' },
          state: { enabled: true },
        },
      },
    }).plugins[pluginId]!,
    trust,
    updatePolicy: 'manual' as const,
    optionalAccess: Object.freeze([]),
  });
  return { counterPath, createInput, writeManifest };
}

async function count(path: string, value: string): Promise<number> {
  return (await readFile(path, 'utf8')).trim().split('\n').filter((line) => line === value).length;
}

describe('daemon plugin restart isolation', () => {
  it('does not reactivate or retire a healthy peer during a post-restart update', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-restart-isolation-'));
    const first = await createPluginFixture(happyHomeDir, 'acme.restart.first');
    const peer = await createPluginFixture(happyHomeDir, 'acme.restart.peer');

    const firstController = createPluginReloadController({ happyHomeDir });
    const firstStore = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({
        happyHomeDir,
        reloadController: firstController,
      }),
    });
    await firstStore.initialize();
    await expect(installFixtureCandidate(firstStore, first.createInput('1.0.0')))
      .resolves.toMatchObject({ status: 'committed' });
    await expect(installFixtureCandidate(firstStore, peer.createInput('1.0.0')))
      .resolves.toMatchObject({ status: 'committed' });
    await firstController.shutdown();

    const restartedController = createPluginReloadController({ happyHomeDir });
    const restartedStore = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({
        happyHomeDir,
        reloadController: restartedController,
      }),
    });
    await restartedStore.initialize();
    const restartedLease = await restartedController.acquireRuntimeRegistry();
    try {
      for (const pluginId of ['acme.restart.first', 'acme.restart.peer']) {
        await expect(restartedLease.registry.targetActionInvocations?.invoke({
          pluginId,
          localId: 'identity',
          input: {},
          surface: 'cli',
        })).resolves.toMatchObject({ status: 'executed' });
      }
    } finally {
      await restartedLease.release();
    }
    expect(await count(first.counterPath, 'activate')).toBe(2);
    expect(await count(peer.counterPath, 'activate')).toBe(2);

    await first.writeManifest('2.0.0');
    await expect(installFixtureCandidate(restartedStore, first.createInput('2.0.0')))
      .resolves.toMatchObject({ status: 'committed' });

    expect(await count(first.counterPath, 'activate')).toBe(3);
    expect(await count(first.counterPath, 'cleanup')).toBe(2);
    expect(await count(peer.counterPath, 'activate')).toBe(2);
    const activeLease = await restartedController.acquireRuntimeRegistry();
    try {
      await expect(activeLease.registry.targetActionInvocations?.invoke({
        pluginId: 'acme.restart.peer',
        localId: 'identity',
        input: {},
        surface: 'cli',
      })).resolves.toEqual({
        status: 'executed',
        value: { pluginId: 'acme.restart.peer' },
      });
      expect(await count(peer.counterPath, 'activate')).toBe(2);
      expect(await count(peer.counterPath, 'cleanup')).toBe(1);
    } finally {
      await activeLease.release();
      await restartedController.shutdown();
    }
    expect(await count(first.counterPath, 'activate')).toBe(3);
    expect(await count(first.counterPath, 'cleanup')).toBe(3);
    expect(await count(peer.counterPath, 'activate')).toBe(2);
    expect(await count(peer.counterPath, 'cleanup')).toBe(2);
  }, 90_000);

  it('retains a demand-activated peer as a current per-plugin component after cold restart', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-lazy-restart-isolation-'));
    const first = await createPluginFixture(happyHomeDir, 'acme.lazy-restart.first');
    const peer = await createPluginFixture(happyHomeDir, 'acme.lazy-restart.peer', 'demand');

    const firstController = createPluginReloadController({ happyHomeDir });
    const firstStore = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({
        happyHomeDir,
        reloadController: firstController,
      }),
    });
    await firstStore.initialize();
    await expect(installFixtureCandidate(firstStore, first.createInput('1.0.0')))
      .resolves.toMatchObject({ status: 'committed' });
    await expect(installFixtureCandidate(firstStore, peer.createInput('1.0.0')))
      .resolves.toMatchObject({ status: 'committed' });
    await firstController.shutdown();

    expect(await count(peer.counterPath, 'activate')).toBe(1);
    expect(await count(peer.counterPath, 'cleanup')).toBe(1);

    const restartedController = createPluginReloadController({ happyHomeDir });
    const restartedStore = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({
        happyHomeDir,
        reloadController: restartedController,
      }),
    });
    await restartedStore.initialize();
    const demandLease = await restartedController.acquireRuntimeRegistry();
    try {
      await expect(demandLease.registry.activateContributionsOnDemand([{
        pluginId: 'acme.lazy-restart.peer',
        family: 'actions',
        localId: 'identity',
      }])).resolves.toEqual([
        expect.objectContaining({ pluginId: 'acme.lazy-restart.peer' }),
      ]);
      await expect(demandLease.registry.targetActionInvocations?.invoke({
        pluginId: 'acme.lazy-restart.peer',
        localId: 'identity',
        input: {},
        surface: 'cli',
      })).resolves.toEqual({
        status: 'executed',
        value: { pluginId: 'acme.lazy-restart.peer' },
      });
    } finally {
      await demandLease.release();
    }
    expect(await count(peer.counterPath, 'activate')).toBe(2);
    expect(await count(peer.counterPath, 'cleanup')).toBe(1);

    await first.writeManifest('2.0.0');
    await expect(installFixtureCandidate(restartedStore, first.createInput('2.0.0')))
      .resolves.toMatchObject({ status: 'committed' });

    expect(await count(peer.counterPath, 'activate')).toBe(2);
    expect(await count(peer.counterPath, 'cleanup')).toBe(1);
    const activeLease = await restartedController.acquireRuntimeRegistry();
    try {
      await expect(activeLease.registry.targetActionInvocations?.invoke({
        pluginId: 'acme.lazy-restart.peer',
        localId: 'identity',
        input: {},
        surface: 'cli',
      })).resolves.toEqual({
        status: 'executed',
        value: { pluginId: 'acme.lazy-restart.peer' },
      });
      expect(await count(peer.counterPath, 'activate')).toBe(2);
      expect(await count(peer.counterPath, 'cleanup')).toBe(1);
    } finally {
      await activeLease.release();
      await restartedController.shutdown();
    }
    expect(await count(peer.counterPath, 'activate')).toBe(2);
    expect(await count(peer.counterPath, 'cleanup')).toBe(2);
  }, 90_000);
});
