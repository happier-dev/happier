import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { createLocalPathPluginDistributionIdentity, createPluginTrustRecord } from './install/trustIdentity';
import { withPluginStoreLock } from './lock';
import { ensurePluginStoreDirectories, resolvePluginStorePaths, type PluginStorePaths } from './paths';
import { readPluginRegistryCommitRecord, replacePluginRegistryCommitRecord } from './registry/commitRecord';
import { createPluginRegistryStateStore } from './registry/currentState';
import {
  createImmutablePluginGenerationRecordFromSource,
  persistInstallationStateRevision,
  prepareImmutablePluginGeneration,
  readInstallationStateRevision,
  type PluginInstallationStateRevision,
} from './registry/generationStore';
import { PluginStateFileV1Schema, type PluginStateFileV1 } from './state';

export * from './state';

const PLUGIN_STATE_LOCK_NAME = 'plugin-state.v1.lock';

type PredecessorPluginStorePaths = PluginStorePaths & Readonly<{
  stateFilePath: string;
}>;

export function resolvePredecessorPluginStorePaths(
  params?: Readonly<{ happyHomeDir?: string }>,
): PredecessorPluginStorePaths {
  const paths = resolvePluginStorePaths(params);
  return Object.freeze({
    ...paths,
    stateFilePath: join(paths.stateDir, 'plugin-state.v1.json'),
  });
}

function createEmptyPluginStateFile(): PluginStateFileV1 {
  return PluginStateFileV1Schema.parse({
    t: 'happier_plugin_state_v1',
    schemaVersion: 1,
    plugins: {},
  });
}

/** Predecessor-file fixture owner. Production code must use registry/currentState. */
export function createPluginStateStore(params?: Readonly<{
  happyHomeDir?: string;
  retainedCurrentHostGenerationIds?: readonly string[];
}>): Readonly<{
  paths: PluginStorePaths;
  read: () => Promise<PluginStateFileV1>;
  write: (next: PluginStateFileV1) => Promise<void>;
  update: (transform: (current: PluginStateFileV1) => Promise<PluginStateFileV1> | PluginStateFileV1) => Promise<PluginStateFileV1>;
}> {
  const paths = resolvePredecessorPluginStorePaths(params);

  async function readUnlocked(): Promise<PluginStateFileV1> {
    try {
      const parsed = PluginStateFileV1Schema.safeParse(JSON.parse(await readFile(paths.stateFilePath, 'utf8')) as unknown);
      if (!parsed.success) throw new Error('Invalid plugin state file');
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return createEmptyPluginStateFile();
      if (error instanceof SyntaxError) throw new Error('Invalid plugin state file');
      throw error;
    }
  }

  async function writeUnlocked(next: PluginStateFileV1): Promise<void> {
    const parsed = PluginStateFileV1Schema.parse(next);
    await ensurePluginStoreDirectories({ happyHomeDir: paths.happyHomeDir });
    await writeJsonAtomic(paths.stateFilePath, parsed);
  }

  async function seedCanonicalFixture(next: PluginStateFileV1): Promise<void> {
    const registryStore = createPluginRegistryStateStore({
      happyHomeDir: paths.happyHomeDir,
      ...(params?.retainedCurrentHostGenerationIds
        ? {
            retainedCurrentHostGenerationIds:
              params.retainedCurrentHostGenerationIds,
          }
        : {}),
    });
    await registryStore.initialize();
    const currentCommit = await readPluginRegistryCommitRecord(paths);
    if (!currentCommit) throw new Error('Canonical plugin registry fixture bootstrap did not publish current state');
    const currentRevision = await readInstallationStateRevision({
      paths,
      reference: currentCommit.installationState,
    });
    const fallbackDistribution = await createLocalPathPluginDistributionIdentity(paths.happyHomeDir);
    const plugins: PluginInstallationStateRevision['plugins'] = {};
    for (const [pluginId, record] of Object.entries(next.plugins)) {
      const trust = record.install.trust ?? createPluginTrustRecord({
        pluginId,
        distribution: fallbackDistribution,
        approvedAtMs: 0,
      });
      plugins[pluginId] = {
        enabled: record.state.enabled,
        trust,
        source: {
          distribution: trust.distribution,
        },
        updatePolicy: record.install.updatePolicy ?? 'allowed',
        optionalAccess: record.install.optionalAccess ?? [],
      };
    }
    const pluginOccurrenceIds = Object.fromEntries(Object.entries(currentCommit.pluginOccurrenceIds)
      .filter(([pluginId]) => next.plugins[pluginId] !== undefined));
    const createdAtMs = Date.now();
    const revision: PluginInstallationStateRevision = {
      t: 'happier_plugin_installations_v1',
      schemaVersion: 1,
      revisionId: `state-${randomUUID()}`,
      createdAtMs,
      plugins,
      rollbackRetention: [],
      runtimeCatalog: next,
      retainedRuntimeCatalog: {},
    };
    const installationState = await persistInstallationStateRevision({ paths, state: revision });
    const transactionId = `fixture-${randomUUID()}`;
    await replacePluginRegistryCommitRecord({
      paths,
      expectedCurrent: currentCommit,
      next: {
        ...currentCommit,
        revision: currentCommit.revision + 1,
        transactionId,
        baseRevision: currentCommit.revision,
        installationState,
        pluginOccurrenceIds,
        createdAtMs,
      },
    });
  }

  async function readVisible(): Promise<PluginStateFileV1> {
    if (await readPluginRegistryCommitRecord(paths)) {
      return await createPluginRegistryStateStore({ happyHomeDir: paths.happyHomeDir }).read();
    }
    return await readUnlocked();
  }

  return {
    paths,
    read: readVisible,
    write: async (next) => {
      const parsed = PluginStateFileV1Schema.parse(next);
      await createPluginRegistryStateStore({
        happyHomeDir: paths.happyHomeDir,
        ...(params?.retainedCurrentHostGenerationIds
          ? {
              retainedCurrentHostGenerationIds:
                params.retainedCurrentHostGenerationIds,
            }
          : {}),
      }).initialize();
      await withPluginStoreLock({
        paths,
        lockName: PLUGIN_STATE_LOCK_NAME,
        fn: async () => {
          await writeUnlocked(parsed);
          await seedCanonicalFixture(parsed);
        },
      });
    },
    update: async (transform) => {
      await createPluginRegistryStateStore({
        happyHomeDir: paths.happyHomeDir,
        ...(params?.retainedCurrentHostGenerationIds
          ? {
              retainedCurrentHostGenerationIds:
                params.retainedCurrentHostGenerationIds,
            }
          : {}),
      }).initialize();
      return await withPluginStoreLock({
        paths,
        lockName: PLUGIN_STATE_LOCK_NAME,
        fn: async () => {
          const next = PluginStateFileV1Schema.parse(await transform(await readUnlocked()));
          await writeUnlocked(next);
          await seedCanonicalFixture(next);
          return next;
        },
      });
    },
  };
}

/**
 * Test-only owner for a path fixture that must be executable through the same
 * immutable-generation/current-commit boundary as a daemon-applied plugin.
 */
export async function writeCommittedLocalPathPluginFixture(params: Readonly<{
  happyHomeDir: string;
  pluginId: string;
  sourceRootPath: string;
  plugin: PluginStateFileV1['plugins'][string];
  manifestRelativePath?: string;
  createdAtMs?: number;
  retainedCurrentHostGenerationIds?: readonly string[];
  /** Multi-plugin publication fixtures keep unrelated committed installations. */
  preserveExistingPlugins?: true;
}>): Promise<Readonly<{ immutableGenerationId: string; rootPath: string }>> {
  const manifestRelativePath = params.manifestRelativePath ?? '.happier-plugin/plugin.json';
  const store = createPluginStateStore({
    happyHomeDir: params.happyHomeDir,
    ...(params.retainedCurrentHostGenerationIds
      ? {
          retainedCurrentHostGenerationIds:
            params.retainedCurrentHostGenerationIds,
        }
      : {}),
  });
  const existingPlugins = params.preserveExistingPlugins ? (await store.read()).plugins : {};
  await store.write({
    t: 'happier_plugin_state_v1',
    schemaVersion: 1,
    plugins: {
      ...existingPlugins,
      [params.pluginId]: params.plugin,
    },
  });

  const paths = resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir });
  const distribution = params.plugin.install.trust?.distribution
    ?? await createLocalPathPluginDistributionIdentity(params.sourceRootPath);
  const generation = await createImmutablePluginGenerationRecordFromSource({
    pluginId: params.pluginId,
    sourceRootPath: params.sourceRootPath,
    manifestRelativePath,
    distribution,
    updatePolicy: params.plugin.install.updatePolicy ?? 'allowed',
    createdAtMs: params.createdAtMs ?? Date.now(),
  });
  const prepared = await prepareImmutablePluginGeneration({
    paths,
    sourceRootPath: params.sourceRootPath,
    record: generation,
  });
  const currentCommit = await readPluginRegistryCommitRecord(paths);
  if (!currentCommit) throw new Error('Committed local-path fixture bootstrap did not publish current state');
  const currentInstallationState = await readInstallationStateRevision({
    paths,
    reference: currentCommit.installationState,
  });
  const currentPlugin = currentInstallationState.plugins[params.pluginId];
  if (!currentPlugin) throw new Error('Committed local-path fixture is absent from installation state');
  const runtimeCatalog = PluginStateFileV1Schema.parse({
    t: 'happier_plugin_state_v1',
    schemaVersion: 1,
    plugins: {
      ...(params.preserveExistingPlugins ? currentInstallationState.runtimeCatalog.plugins : {}),
      [params.pluginId]: {
        ...params.plugin,
        source: {
          ...params.plugin.source,
          resolvedPath: prepared.rootPath,
          manifestPath: join(prepared.rootPath, ...manifestRelativePath.split('/')),
        },
        install: {
          ...params.plugin.install,
          ...(params.plugin.source.trustPolicy === 'local_trusted' && currentPlugin.trust
            ? { trust: currentPlugin.trust }
            : {}),
        },
      },
    },
  });
  const installationState = await persistInstallationStateRevision({
    paths,
    state: {
      ...currentInstallationState,
      revisionId: `state-${randomUUID()}`,
      createdAtMs: generation.createdAtMs,
      plugins: {
        ...currentInstallationState.plugins,
        [params.pluginId]: {
          ...currentPlugin,
        },
      },
      runtimeCatalog,
    },
  });
  await replacePluginRegistryCommitRecord({
    paths,
    expectedCurrent: currentCommit,
    next: {
      ...currentCommit,
      revision: currentCommit.revision + 1,
      transactionId: `fixture-generation-${randomUUID()}`,
      baseRevision: currentCommit.revision,
      pluginOccurrenceIds: {
        ...currentCommit.pluginOccurrenceIds,
        [params.pluginId]: prepared.reference,
      },
      installationState,
      createdAtMs: generation.createdAtMs,
    },
  });
  return Object.freeze({
    immutableGenerationId: generation.immutableGenerationId,
    rootPath: prepared.rootPath,
  });
}
