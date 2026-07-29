import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  createLocalPathPluginDistributionIdentity,
  createPluginTrustRecord,
} from '../install/trustIdentity';
import { ensurePluginStoreDirectories, PLUGIN_MANIFEST_RELATIVE_PATH } from '../paths';
import { PluginStateFileV1Schema, PluginStateRecordSchema } from '../state';
import {
  readPluginRegistryCommitRecord,
  replacePluginRegistryCommitRecord,
} from './commitRecord';
import { createPluginRegistryStateStore } from './currentState';
import {
  createImmutablePluginGenerationRecordFromSource,
  persistInstallationStateRevision,
  prepareImmutablePluginGeneration,
  readInstallationStateRevision,
  verifyPluginRegistryCommitGenerationReferences,
  type PluginInstallationStateRevision,
} from './generationStore';
import { createPendingGenerationHealthRecord } from './healthPolicy';

/**
 * Seeds the current durable registry for process-boundary tests that start the
 * daemon only after the fixture exists. This intentionally does not author the
 * retired plugin-state.v1.json projection.
 */
export async function seedCurrentLocalPathPluginFixture(input: Readonly<{
  happyHomeDir: string;
  pluginRoot: string;
  pluginId: string;
  manifestVersion: string;
  devWatch?: boolean;
}>): Promise<void> {
  const paths = await ensurePluginStoreDirectories({ happyHomeDir: input.happyHomeDir });
  const store = createPluginRegistryStateStore({ happyHomeDir: input.happyHomeDir });
  await store.initialize();

  const currentCommit = await readPluginRegistryCommitRecord(paths);
  if (!currentCommit) throw new Error('Current plugin registry fixture bootstrap did not publish a commit');
  const currentRevision = await readInstallationStateRevision({
    paths,
    reference: currentCommit.installationState,
  });
  if (currentRevision.plugins[input.pluginId] || currentCommit.pluginGenerations[input.pluginId]) {
    throw new Error(`Current plugin registry fixture '${input.pluginId}' is already installed`);
  }

  const createdAtMs = Date.now();
  const distribution = await createLocalPathPluginDistributionIdentity(input.pluginRoot);
  const trust = createPluginTrustRecord({
    pluginId: input.pluginId,
    distribution,
    approvedAtMs: createdAtMs,
  });
  const generationRecord = await createImmutablePluginGenerationRecordFromSource({
    pluginId: input.pluginId,
    sourceRootPath: input.pluginRoot,
    manifestRelativePath: PLUGIN_MANIFEST_RELATIVE_PATH.split('\\').join('/'),
    distribution,
    updatePolicy: 'manual',
    createdAtMs,
  });
  const prepared = await prepareImmutablePluginGeneration({
    paths,
    sourceRootPath: input.pluginRoot,
    record: generationRecord,
  });
  const catalogRecord = PluginStateRecordSchema.parse({
    source: {
      kind: 'path',
      locator: input.pluginRoot,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedPath: prepared.rootPath,
      manifestPath: join(prepared.rootPath, PLUGIN_MANIFEST_RELATIVE_PATH),
      resolvedVersion: input.manifestVersion,
      resolvedDigest: generationRecord.manifestDigest,
      ...(input.devWatch === undefined ? {} : { devWatch: input.devWatch }),
    },
    compatibility: {
      status: 'compatible',
      diagnostics: [],
    },
    install: {
      mode: 'managed_install',
      manifestVersion: input.manifestVersion,
      manifestDigest: generationRecord.manifestDigest,
      installedPath: prepared.rootPath,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
    },
    state: {
      enabled: true,
    },
  });
  const runtimeCatalog = PluginStateFileV1Schema.parse({
    ...(currentRevision.runtimeCatalog ?? {
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {},
    }),
    plugins: {
      ...(currentRevision.runtimeCatalog?.plugins ?? {}),
      [input.pluginId]: catalogRecord,
    },
  });
  const revision: PluginInstallationStateRevision = {
    ...currentRevision,
    revisionId: `state-${randomUUID()}`,
    createdAtMs,
    plugins: {
      ...currentRevision.plugins,
      [input.pluginId]: {
        enabled: true,
        trust,
        source: {
          distribution,
          admittedIntegrity: generationRecord.packageDigest,
        },
        updatePolicy: 'manual',
        optionalAccess: [],
      },
    },
    health: {
      ...currentRevision.health,
      [generationRecord.immutableGenerationId]: createPendingGenerationHealthRecord({
        pluginId: input.pluginId,
        immutableGenerationId: generationRecord.immutableGenerationId,
        fingerprint: generationRecord.fingerprint,
      }),
    },
    runtimeCatalog,
  };
  const installationState = await persistInstallationStateRevision({ paths, state: revision });
  const transactionId = `fixture-${randomUUID()}`;
  const nextCommit = {
    ...currentCommit,
    revision: currentCommit.revision + 1,
    transactionId,
    baseRevision: currentCommit.revision,
    installationState,
    pluginGenerations: {
      ...currentCommit.pluginGenerations,
      [input.pluginId]: prepared.reference,
    },
    createdAtMs,
  };
  await replacePluginRegistryCommitRecord({
    paths,
    expectedRevision: currentCommit.revision,
    next: nextCommit,
  });
  await verifyPluginRegistryCommitGenerationReferences(paths, nextCommit);
}
