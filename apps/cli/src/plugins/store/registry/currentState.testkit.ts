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

/**
 * Verbatim bytes of a real predecessor-shaped current record recovered from a
 * retained stack home (sha256
 * 8d3e165bd931b9d717ef6557ffa912e97f752d6bbb112a13fdb268a807986999).
 * A predecessor build writes `installationState.digest`; the current strict
 * reader declares no such key, so these are the exact bytes that a mixed-build
 * stack home leaves behind and that the current reader must reject with an
 * actionable, recoverable outcome rather than an unhandled startup fatal.
 */
export const PREDECESSOR_PLUGIN_REGISTRY_COMMIT_RECORD_BYTES = `{
  "t": "happier_plugin_registry_commit_v1",
  "schemaVersion": 1,
  "revision": 0,
  "transactionId": "cutover-44d214da-3370-4153-8a62-432136578925",
  "baseRevision": null,
  "installationState": {
    "revisionId": "state-a0c537ed-8285-4531-b28f-514350d3f256",
    "digest": "sha256:60b3b4cec4e73f7e579037e3c459ac4b2e161bd7312d699752ea531be627c973"
  },
  "pluginGenerations": {},
  "createdAtMs": 1787564705855,
  "creator": {
    "pid": 5151,
    "instanceId": "plugin-registry-5151-0f34860e-cc17-4912-b415-e4d3abbfae88"
  }
}`;

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
      ...(input.devWatch === undefined ? {} : { devWatch: input.devWatch }),
    },
    compatibility: {
      status: 'compatible',
      diagnostics: [],
    },
    install: {
      mode: 'managed_install',
      manifestVersion: input.manifestVersion,
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
        materializationId: `materialization-${randomUUID()}`,
        trust,
        source: {
          distribution,
        },
        updatePolicy: 'manual',
        optionalAccess: [],
      },
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
    expectedCurrent: currentCommit,
    next: nextCommit,
  });
  await verifyPluginRegistryCommitGenerationReferences(paths, nextCommit);
}
