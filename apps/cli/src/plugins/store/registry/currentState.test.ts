import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { resolvePredecessorPluginStorePaths } from '../state.testkit';
import { PluginStateFileV1Schema } from '../state';
import {
  createArchivePluginDistributionIdentity,
  createLocalPathPluginDistributionIdentity,
  createPluginTrustRecord,
} from '../install/trustIdentity';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { readPluginRegistryCommitRecord } from './commitRecord';
import {
  createPluginRegistryStateStore,
  type PluginRegistryRuntimeLifecycle,
} from './currentState';
import { readInstallationStateRevision } from './generationStore';

const TEST_RUNTIME_LIFECYCLE: PluginRegistryRuntimeLifecycle = Object.freeze({
  prepare: async () => Object.freeze({
    abort: async () => undefined,
    adopt: async () => undefined,
  }),
});

function createRevisionTaggedRuntimeRegistry(
  generationId: string,
): ResolvedExecutablePluginRuntimeRegistry {
  return {
    contributes: {
      agents: Object.freeze([]),
            actions: Object.freeze([]),
      resources: Object.freeze([]),
      uiViewsV2: Object.freeze([]),
      uiRenderersV2: Object.freeze([]),
      uiTranslationsV2: Object.freeze([]),
      activationTargets: Object.freeze([]),
            catalogEntriesById: Object.freeze({}),
      agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
      generationId,
    },
    hookHandlersByHookId: new Map(),
    agentRuntimesByAgentId: new Map(),
    daemonAuthBridgesByServiceId: new Map(),
    scmHostingProvidersById: new Map(),
    networkAllowedUrlOriginsByPluginId: new Map(),
    processSpawnAllowedPathsByPluginId: new Map(),
    pluginDiagnosticsByPluginId: Object.freeze({}),
    activatedPluginIds: new Set(),
    activateContributionsOnDemand: async () => [],
    resolvePromptAssetBlocks: async () => [],
    addRuntimeDisposable: (_pluginId, disposable) => disposable,
    createAgentInvocationServices: () => createUnavailablePluginServices(),
    readHookEventEnvelopeV1,
    retireConsumers: () => undefined,
    dispose: async () => undefined,
  };
}

describe('PluginRegistryStateStore', () => {
  it('does not let a delayed older commit replace the runtime registry adopted for a newer desired revision', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-adoption-order-'));
    const reloadController = createPluginReloadController();
    let releaseOlderAdoption!: () => void;
    const olderAdoptionBlocked = new Promise<void>((resolve) => {
      releaseOlderAdoption = resolve;
    });
    let signalOlderCommit!: () => void;
    const olderCommitReachedAdoption = new Promise<void>((resolve) => {
      signalOlderCommit = resolve;
    });
    const registriesByRevision = new Map<number, ResolvedExecutablePluginRuntimeRegistry>();
    const runtimeLifecycle: PluginRegistryRuntimeLifecycle = {
      async prepare(candidate) {
        const registry = createRevisionTaggedRuntimeRegistry(
          `registry:${Object.keys(candidate.runtimeCatalog.plugins).sort().join('+')}`,
        );
        return {
          abort: async () => undefined,
          async adopt(record) {
            registriesByRevision.set(record.revision, registry);
            if (record.revision === 1) {
              signalOlderCommit();
              await olderAdoptionBlocked;
            }
            await reloadController.adoptPreparedRuntimeRegistry({
              registry,
              changedPluginIds: candidate.changedPluginIds,
              durableRevision: record.revision,
            });
          },
        };
      },
    };
    const firstStore = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    const secondStore = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    await firstStore.initialize();
    const createInstallInput = async (pluginId: string) => {
      const pluginRoot = join(happyHomeDir, pluginId);
      await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
      await writeFile(
        join(pluginRoot, '.happier-plugin', 'plugin.json'),
        JSON.stringify({ id: pluginId, version: '1.0.0' }),
        'utf8',
      );
      const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
      const trust = createPluginTrustRecord({ pluginId, distribution, approvedAtMs: 1 });
      const catalogRecord = PluginStateFileV1Schema.parse({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          [pluginId]: {
            source: {
              kind: 'path',
              locator: pluginRoot,
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedPath: pluginRoot,
              manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
            },
            compatibility: { status: 'compatible', diagnostics: [] },
            install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'manual' },
            state: { enabled: true },
          },
        },
      }).plugins[pluginId]!;
      return {
        pluginId,
        sourceRootPath: pluginRoot,
        manifestRelativePath: '.happier-plugin/plugin.json',
        catalogRecord,
        trust,
        updatePolicy: 'manual' as const,
        optionalAccess: Object.freeze([]),
      };
    };
    const [firstInstall, secondInstall] = await Promise.all([
      createInstallInput('acme.first'),
      createInstallInput('acme.second'),
    ]);

    const olderChange = firstStore.install(firstInstall);
    await olderCommitReachedAdoption;

    const newerChange = await secondStore.install(secondInstall);
    expect(newerChange).toMatchObject({ status: 'committed', record: { revision: 2 } });
    expect(reloadController.getState().activeRegistry).toBe(registriesByRevision.get(2));

    releaseOlderAdoption();
    await expect(olderChange).resolves.toMatchObject({
      status: 'outcomeUnknown',
      record: { revision: 1 },
      phase: 'adoption',
    });

    await expect(readPluginRegistryCommitRecord(firstStore.paths)).resolves.toMatchObject({
      revision: 2,
    });
    expect(reloadController.getState().activeRegistry).toBe(registriesByRevision.get(2));
  });

  it('allows pure reads but rejects explicit mutations without a runtime lifecycle', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-runtime-required-'));
    const store = createPluginRegistryStateStore({ happyHomeDir });

    const current = await store.read();
    expect(current.plugins).toEqual({});
    await expect(store.update(() => current)).rejects.toThrow(/runtime lifecycle/i);
    await expect(store.write(current)).rejects.toThrow(/runtime lifecycle/i);
    await expect(store.rollback('acme.missing')).rejects.toThrow(/runtime lifecycle/i);
    await expect(store.uninstall('acme.missing')).rejects.toThrow(/runtime lifecycle/i);
    await expect(store.readSnapshot()).resolves.toMatchObject({ revision: -1, state: current });
    await expect(readPluginRegistryCommitRecord(store.paths)).resolves.toBeNull();
  });

  it('does not publish an install when daemon runtime preparation rejects the candidate', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-runtime-prepare-reject-'));
    const pluginRoot = join(happyHomeDir, 'rejected-plugin');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export const activate = () => undefined;\n', 'utf8');
    await writeFile(
      join(pluginRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify({ id: 'acme.rejected.plugin', version: '1.0.0' }),
      'utf8',
    );

    const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
    const trust = createPluginTrustRecord({
      pluginId: 'acme.rejected.plugin',
      distribution,
      approvedAtMs: 1,
    });
    const record = PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.rejected.plugin': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'manual' },
          state: { enabled: true },
        },
      },
    }).plugins['acme.rejected.plugin']!;
    let preparedCandidates = 0;
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: {
        prepare: async (candidate) => {
          preparedCandidates += 1;
          expect(candidate.changedPluginIds).toEqual(['acme.rejected.plugin']);
          throw new Error('registration graph rejected');
        },
      },
    });

    await expect(store.install({
      pluginId: 'acme.rejected.plugin',
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord: record,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
    })).rejects.toThrow('registration graph rejected');

    expect(preparedCandidates).toBe(1);
    await expect(readPluginRegistryCommitRecord(store.paths)).resolves.toMatchObject({
      revision: 0,
      pluginGenerations: {},
    });
  });

  it('aborts a retained activation once when a different-plugin conflict cannot rebase', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-rebase-reject-'));
    const createInstallInput = async (pluginId: string) => {
      const pluginRoot = join(happyHomeDir, pluginId);
      await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
      await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
      await writeFile(
        join(pluginRoot, '.happier-plugin', 'plugin.json'),
        JSON.stringify(createPluginManifestV2Fixture({
          schemaVersion: 2,
          id: pluginId,
          version: '1.0.0',
          displayName: pluginId,
          description: 'Rebase rejection fixture',
          engines: { happier: '^0.2.0' },
          runtime: { apiVersion: 1 },
          entrypoints: { daemon: './daemon.mjs' },
          hostAccess: { required: [], optional: [] },
          contributes: {},
        })),
        'utf8',
      );
      const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
      const trust = createPluginTrustRecord({ pluginId, distribution, approvedAtMs: 1 });
      const catalogRecord = PluginStateFileV1Schema.parse({
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
            install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'manual' },
            state: { enabled: true },
          },
        },
      }).plugins[pluginId]!;
      return {
        pluginId,
        sourceRootPath: pluginRoot,
        manifestRelativePath: '.happier-plugin/plugin.json',
        catalogRecord,
        trust,
        updatePolicy: 'manual' as const,
        optionalAccess: Object.freeze([]),
      };
    };
    const [first, second] = await Promise.all([
      createInstallInput('acme.rebase.first'),
      createInstallInput('acme.rebase.second'),
    ]);
    let preparationCount = 0;
    let releaseInitialPreparations!: () => void;
    const initialPreparationsReady = new Promise<void>((resolve) => {
      releaseInitialPreparations = resolve;
    });
    const abortsByPluginId = new Map<string, number>();
    const runtimeLifecycle: PluginRegistryRuntimeLifecycle = {
      async prepare(candidate) {
        preparationCount += 1;
        if (preparationCount <= 2) {
          if (preparationCount === 2) releaseInitialPreparations();
          await initialPreparationsReady;
        }
        const pluginId = candidate.changedPluginIds[0]!;
        return {
          async abort() {
            abortsByPluginId.set(pluginId, (abortsByPluginId.get(pluginId) ?? 0) + 1);
          },
          async adopt() {},
          async rebase() {
            throw new Error(`rebase rejected for ${pluginId}`);
          },
        };
      },
    };
    const firstStore = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    const secondStore = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    await firstStore.initialize();

    const results = await Promise.allSettled([
      firstStore.install(first),
      secondStore.install(second),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toEqual(expect.objectContaining({
      message: expect.stringMatching(/rebase rejected/i),
    }));
    expect([...abortsByPluginId.values()]).toEqual([1]);
    await expect(readPluginRegistryCommitRecord(firstStore.paths)).resolves.toMatchObject({
      revision: 1,
    });
  });

  it('initializes an empty canonical registry without importing the unpublished predecessor file', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-state-cutover-'));
    const paths = resolvePredecessorPluginStorePaths({ happyHomeDir });
    const pluginRoot = join(happyHomeDir, 'verified-predecessor-plugin');
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export const imported = true;\n', 'utf8');
    await writeFile(manifestPath, JSON.stringify(createPluginManifestV2Fixture({
      schemaVersion: 2,
      id: 'acme.imported.plugin',
      version: '1.0.0',
      displayName: 'Imported plugin',
      description: 'Verified predecessor import fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './daemon.mjs' },
      hostAccess: { required: [], optional: [] },
      contributes: {},
    })), 'utf8');
    const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
    const trust = createPluginTrustRecord({ pluginId: 'acme.imported.plugin', distribution, approvedAtMs: 1 });
    const verifiedRecord = PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.imported.plugin': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath,
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'manual' },
          state: { enabled: true },
        },
      },
    }).plugins['acme.imported.plugin']!;
    const predecessor = {
      t: 'happier_plugin_state_v1' as const,
      schemaVersion: 1 as const,
      plugins: {
        'acme.imported.plugin': verifiedRecord,
        'acme.malformed.plugin': { state: { enabled: true } },
      },
    };
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.stateFilePath, JSON.stringify(predecessor), { encoding: 'utf8', flag: 'wx' });

    const store = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: TEST_RUNTIME_LIFECYCLE,
    });
    const imported = await store.initialize();
    expect(imported.plugins).toEqual({});
    const importCommit = await readPluginRegistryCommitRecord(paths);
    expect(importCommit).toMatchObject({
      revision: 0,
      pluginGenerations: {},
    });

    await expect(readFile(paths.stateFilePath, 'utf8')).resolves.toBe(JSON.stringify(predecessor));
    await expect(store.read()).resolves.toEqual(imported);
  });

  it('publishes install, update, rollback, and uninstall through one committed generation map while preserving plugin data', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-install-lifecycle-'));
    const pluginRoot = join(happyHomeDir, 'author-plugin');
    const manifestDir = join(pluginRoot, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export const version = 1;\n', 'utf8');
    await writeFile(join(manifestDir, 'plugin.json'), JSON.stringify({ id: 'acme.registry.plugin', version: '1.0.0' }), 'utf8');

    const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
    const trust = createPluginTrustRecord({ pluginId: 'acme.registry.plugin', distribution, approvedAtMs: 1 });
    const readCredentials = vi.fn(async () => ({
      token: 'account-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
    }));
    const retireGeneration = vi.fn(async (_retirement: Readonly<{
      token: string;
      pluginId: string;
      immutableGenerationId: string;
    }>) => undefined);
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      nowMs: () => 10,
      runtimeLifecycle: TEST_RUNTIME_LIFECYCLE,
      generationCustodyRetirement: { readCredentials, retireGeneration },
    });
    const record = PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.registry.plugin': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(manifestDir, 'plugin.json'),
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'manual' },
          state: { enabled: true },
        },
      },
    }).plugins['acme.registry.plugin']!;

    await store.install({
      pluginId: 'acme.registry.plugin',
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord: record,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
    });
    const firstCommit = (await readPluginRegistryCommitRecord(store.paths))!;
    const firstGenerationId = firstCommit.pluginGenerations['acme.registry.plugin']!.immutableGenerationId;
    expect(firstCommit.revision).toBe(1);
    expect(firstCommit.pluginGenerations['acme.registry.plugin']).toBeDefined();
    expect((await store.read()).plugins['acme.registry.plugin']?.install.installedPath).toContain('/generations/');

    await store.update((current) => ({
      ...current,
      plugins: {
        ...current.plugins,
        'acme.registry.plugin': {
          ...current.plugins['acme.registry.plugin']!,
          state: { ...current.plugins['acme.registry.plugin']!.state, enabled: false },
        },
      },
    }));

    const storagePath = join(store.paths.storageDir, 'acme.registry.plugin', 'local.v1.json');
    await mkdir(join(store.paths.storageDir, 'acme.registry.plugin'), { recursive: true });
    await writeFile(storagePath, '{"preserved":true}', 'utf8');
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export const version = 2;\n', 'utf8');
    const secondRecord = {
      ...record,
      install: { ...record.install, manifestVersion: '2.0.0' },
    };
    await store.install({
      pluginId: 'acme.registry.plugin',
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord: secondRecord,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
    });
    const secondCommit = (await readPluginRegistryCommitRecord(store.paths))!;
    const secondGenerationId = secondCommit.pluginGenerations['acme.registry.plugin']!.immutableGenerationId;
    const secondState = await readInstallationStateRevision({ paths: store.paths, reference: secondCommit.installationState });
    expect(secondCommit.revision).toBe(3);
    expect(secondState.rollbackRetention).toHaveLength(1);
    expect((await store.read()).plugins['acme.registry.plugin']?.state.enabled).toBe(false);

    await store.rollback('acme.registry.plugin');
    expect((await store.read()).plugins['acme.registry.plugin']?.install.manifestVersion).toBe('1.0.0');

    const unrelatedGenerationStatePath = join(store.paths.generationsDir, '.unrelated-state', 'keep.txt');
    await mkdir(join(store.paths.generationsDir, '.unrelated-state'), { recursive: true });
    await writeFile(unrelatedGenerationStatePath, 'preserve exactly', 'utf8');
    await store.uninstall('acme.registry.plugin');
    expect((await store.read()).plugins).toEqual({});
    expect(readCredentials).toHaveBeenCalled();
    expect(retireGeneration.mock.calls.map(([retirement]) => retirement)
      .sort((left, right) => left.immutableGenerationId.localeCompare(right.immutableGenerationId))).toEqual(
      [firstGenerationId, secondGenerationId]
        .sort()
        .map((immutableGenerationId) => ({
          token: 'account-token',
          pluginId: 'acme.registry.plugin',
          immutableGenerationId,
        })),
    );
    await expect(readFile(storagePath, 'utf8')).resolves.toBe('{"preserved":true}');
    await expect(readFile(unrelatedGenerationStatePath, 'utf8')).resolves.toBe('preserve exactly');
  });

  it('does not retain or roll back bytes from a superseded distribution identity', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-source-substitution-'));
    const firstRoot = join(happyHomeDir, 'first-source');
    const secondRoot = join(happyHomeDir, 'second-source');
    for (const [root, version] of [[firstRoot, '1.0.0'], [secondRoot, '2.0.0']] as const) {
      await mkdir(join(root, '.happier-plugin'), { recursive: true });
      await writeFile(join(root, 'daemon.mjs'), `export const version = ${JSON.stringify(version)};\n`, 'utf8');
      await writeFile(
        join(root, '.happier-plugin', 'plugin.json'),
        JSON.stringify({ id: 'acme.source-substitution', version }),
        'utf8',
      );
    }

    const store = createPluginRegistryStateStore({
      happyHomeDir,
      nowMs: () => 10,
      runtimeLifecycle: TEST_RUNTIME_LIFECYCLE,
    });
    const installFrom = async (root: string, version: string) => {
      const distribution = await createLocalPathPluginDistributionIdentity(root);
      const trust = createPluginTrustRecord({
        pluginId: 'acme.source-substitution',
        distribution,
        approvedAtMs: 1,
      });
      const record = PluginStateFileV1Schema.parse({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          'acme.source-substitution': {
            source: {
              kind: 'path',
              locator: root,
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedPath: root,
              manifestPath: join(root, '.happier-plugin', 'plugin.json'),
            },
            compatibility: { status: 'compatible', diagnostics: [] },
            install: { mode: 'link', manifestVersion: version, trust, updatePolicy: 'manual' },
            state: { enabled: true },
          },
        },
      }).plugins['acme.source-substitution']!;
      await store.install({
        pluginId: 'acme.source-substitution',
        sourceRootPath: root,
        manifestRelativePath: '.happier-plugin/plugin.json',
        catalogRecord: record,
        trust,
        updatePolicy: 'manual',
        optionalAccess: [],
      });
    };

    await installFrom(firstRoot, '1.0.0');
    await installFrom(secondRoot, '2.0.0');

    const commit = (await readPluginRegistryCommitRecord(store.paths))!;
    const revision = await readInstallationStateRevision({ paths: store.paths, reference: commit.installationState });
    expect(revision.rollbackRetention).toEqual([]);
    await expect(store.rollback('acme.source-substitution')).rejects.toThrow(/no available rollback generation/i);
  });

  it('retains a newly reviewed archive replacement from the same source for explicit rollback only', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-archive-rollback-'));
    const pluginRoot = join(happyHomeDir, 'archive-plugin');
    const archivePath = join(happyHomeDir, 'acme-archive-plugin.tgz');
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(archivePath, 'reviewed archive source', 'utf8');

    const store = createPluginRegistryStateStore({
      happyHomeDir,
      nowMs: () => 10,
      runtimeLifecycle: TEST_RUNTIME_LIFECYCLE,
    });
    const install = async (version: string, integrityByte: number) => {
      await writeFile(join(pluginRoot, 'daemon.mjs'), `export const version = ${JSON.stringify(version)};\n`, 'utf8');
      await writeFile(manifestPath, JSON.stringify({ id: 'acme.archive.rollback', version }), 'utf8');
      const distribution = await createArchivePluginDistributionIdentity({
        source: { kind: 'localFile', path: archivePath },
        integrity: `sha256-${Buffer.alloc(32, integrityByte).toString('base64')}`,
      });
      const trust = createPluginTrustRecord({
        pluginId: 'acme.archive.rollback',
        distribution,
        approvedAtMs: integrityByte,
      });
      const record = PluginStateFileV1Schema.parse({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          'acme.archive.rollback': {
            source: {
              kind: 'archive',
              locator: archivePath,
              trustPolicy: 'prompt',
              installPolicy: 'managed_install',
              resolvedPath: pluginRoot,
              manifestPath,
            },
            compatibility: { status: 'compatible', diagnostics: [] },
            install: { mode: 'managed_install', manifestVersion: version, trust, updatePolicy: 'manual' },
            state: { enabled: true },
          },
        },
      }).plugins['acme.archive.rollback']!;
      await store.install({
        pluginId: 'acme.archive.rollback',
        sourceRootPath: pluginRoot,
        manifestRelativePath: '.happier-plugin/plugin.json',
        catalogRecord: record,
        trust,
        updatePolicy: 'manual',
        optionalAccess: [],
      });
      return distribution;
    };

    const firstDistribution = await install('1.0.0', 1);
    const firstGenerationId = (await readPluginRegistryCommitRecord(store.paths))!
      .pluginGenerations['acme.archive.rollback']!.immutableGenerationId;
    const secondDistribution = await install('2.0.0', 2);
    const afterUpdateCommit = (await readPluginRegistryCommitRecord(store.paths))!;
    const afterUpdateState = await readInstallationStateRevision({
      paths: store.paths,
      reference: afterUpdateCommit.installationState,
    });

    expect(firstDistribution).not.toEqual(secondDistribution);
    expect(afterUpdateState.rollbackRetention).toEqual([
      expect.objectContaining({
        pluginId: 'acme.archive.rollback',
        immutableGenerationId: firstGenerationId,
        role: 'userRollback',
        automaticRecoveryEligible: false,
        distribution: firstDistribution,
      }),
    ]);

    await store.rollback('acme.archive.rollback');
    const rolledBackCommit = (await readPluginRegistryCommitRecord(store.paths))!;
    const rolledBackState = await readInstallationStateRevision({
      paths: store.paths,
      reference: rolledBackCommit.installationState,
    });
    expect(rolledBackCommit.pluginGenerations['acme.archive.rollback']?.immutableGenerationId).toBe(firstGenerationId);
    expect(rolledBackState.plugins['acme.archive.rollback']).toMatchObject({
      trust: { distribution: firstDistribution },
      source: { distribution: firstDistribution },
    });
  });

  it('keeps a committed install authoritative when a derived surface is pending and retries reconciliation on startup', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-post-commit-reconcile-'));
    const pluginRoot = join(happyHomeDir, 'reviewed-plugin');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export const version = 1;\n', 'utf8');
    await writeFile(
      join(pluginRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify({ id: 'acme.reconcile-pending', version: '1.0.0' }),
      'utf8',
    );

    const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
    const trust = createPluginTrustRecord({
      pluginId: 'acme.reconcile-pending',
      distribution,
      approvedAtMs: 1,
    });
    const record = PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.reconcile-pending': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'manual' },
          state: { enabled: true },
        },
      },
    }).plugins['acme.reconcile-pending']!;
    let runtimeUnavailable = true;
    const appliedRevisions: number[] = [];
    const onReconciliationPending = vi.fn();
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: TEST_RUNTIME_LIFECYCLE,
      onReconciliationPending,
      reconciliationSurfaces: [{
        name: 'runtime',
        apply: async ({ commit }) => {
          if (runtimeUnavailable) throw new Error('runtime reload unavailable');
          appliedRevisions.push(commit.revision);
        },
      }],
    });

    const result = await store.install({
      pluginId: 'acme.reconcile-pending',
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord: record,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
    });

    expect(result).toMatchObject({
      status: 'committed',
      pendingSurfaces: ['reconciliation'],
      record: { revision: 1 },
      message: expect.stringContaining('runtime reload unavailable'),
    });
    await expect(readPluginRegistryCommitRecord(store.paths)).resolves.toMatchObject({
      revision: 1,
      pluginGenerations: { 'acme.reconcile-pending': expect.any(Object) },
    });

    onReconciliationPending.mockClear();
    await expect(store.initialize()).resolves.toMatchObject({
      plugins: { 'acme.reconcile-pending': expect.any(Object) },
    });
    expect(onReconciliationPending).toHaveBeenLastCalledWith({
      operation: 'startup',
      pendingSurfaces: ['reconciliation'],
      message: expect.stringContaining('runtime: runtime reload unavailable'),
    });

    runtimeUnavailable = false;
    await expect(store.initialize()).resolves.toMatchObject({
      plugins: { 'acme.reconcile-pending': expect.any(Object) },
    });
    expect(appliedRevisions).toEqual([1]);

    await mkdir(join(store.paths.generationsDir, 'generation-invalid-obsolete'));
    const cleanupPending = await store.setEnabledWithResult('acme.reconcile-pending', false);
    expect(cleanupPending?.transaction).toMatchObject({
      status: 'committed',
      pendingSurfaces: ['reconciliation'],
      message: expect.stringContaining('generationCleanup'),
    });
  });
});
