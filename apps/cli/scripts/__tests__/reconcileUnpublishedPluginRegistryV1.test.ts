import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const stagingDurabilityEvents = vi.hoisted(() => {
  type Event =
    | Readonly<{ kind: 'flushDirectory'; path: string }>
    | Readonly<{ kind: 'rename'; from: string; to: string }>;

  let capturing = false;
  const events: Event[] = [];
  return {
    startCapture(): void {
      events.length = 0;
      capturing = true;
    },
    stopCapture(): void {
      capturing = false;
    },
    recordDirectoryFlush(path: string): void {
      if (capturing) events.push({ kind: 'flushDirectory', path });
    },
    recordRename(from: string, to: string): void {
      if (capturing) events.push({ kind: 'rename', from, to });
    },
    snapshot(): readonly Event[] {
      return [...events];
    },
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      stagingDurabilityEvents.recordRename(String(args[0]), String(args[1]));
      return await actual.rename(...args);
    },
  };
});

vi.mock('../../src/plugins/store/registry/durability', async () => {
  const actual = await vi.importActual<typeof import('../../src/plugins/store/registry/durability')>(
    '../../src/plugins/store/registry/durability',
  );
  return {
    ...actual,
    flushDirectoryDurably: async (
      ...args: Parameters<typeof actual.flushDirectoryDurably>
    ) => {
      stagingDurabilityEvents.recordDirectoryFlush(args[0]);
      return await actual.flushDirectoryDurably(...args);
    },
  };
});

import { createDefaultPluginAccessScopeRegistry } from '../../src/plugins/store/install/accessScopeRegistry';
import { derivePluginInstallReviewPrincipalDigest } from '../../src/plugins/daemon/installReviewPrincipal';
import { resolvePluginStorePaths } from '../../src/plugins/store/paths';
import { readPluginRegistryCommitRecord } from '../../src/plugins/store/registry/commitRecord';
import { createPluginRegistryStateStore } from '../../src/plugins/store/registry/currentState';
import {
  readCurrentCommittedPluginGenerations,
  readInstallationStateRevision,
  readPreparedImmutablePluginGeneration,
} from '../../src/plugins/store/registry/generationStore';
import { reconcileUnpublishedPluginRegistryV1 } from '../../src/plugins/store/registry/unpublishedV1Reconciliation';

const PREDECESSOR_PROVENANCE = Object.freeze({
  repository: 'happier-dev/happier',
  producerCommit: '8173b221801c0f7ca747574559ba314303f8c211',
  producerCommittedAtMs: Date.parse('2026-08-05T09:43:24Z'),
  retainedObservedCreatedAtMs: 1_786_034_026_465,
  rejectedFutureCheckoutCommit: 'b059a7c2cbaac9fb413e217c4856be34953645ad',
  rejectedFutureCheckoutCommittedAtMs: Date.parse('2026-08-12T09:04:30Z'),
  commitRecordPath: 'apps/cli/src/plugins/store/registry/commitRecord.ts',
  generationStorePath: 'apps/cli/src/plugins/store/registry/generationStore.ts',
});

const PLUGIN_ID = 'acme.provenance-fixture';
const CURRENT_GENERATION_ID = 'generation-current-predecessor';
const ROLLBACK_GENERATION_ID = 'generation-rollback-predecessor';
const MANIFEST_RELATIVE_PATH = '.happier-plugin/plugin.json';

async function createRetainedStackCliHome(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const happyHomeDir = join(root, '.happier', 'stacks', 'sanitized-retained-stack', 'cli');
  await mkdir(happyHomeDir, { recursive: true });
  return happyHomeDir;
}

function sha256(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function predecessorJsonDigest(value: unknown): `sha256:${string}` {
  return sha256(Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
}

function predecessorGenerationFingerprint(input: Readonly<{
  distribution: unknown;
  manifestDigest: string;
  packageDigest: string;
  updatePolicy: string;
}>): `sha256:${string}` {
  return sha256(Buffer.from(`happier.plugin-generation-fingerprint.v1\n${JSON.stringify({
    pluginId: PLUGIN_ID,
    distribution: input.distribution,
    updatePolicy: input.updatePolicy,
    normalizedManifestDigest: input.manifestDigest,
    packageDigest: input.packageDigest,
    runtimeDigest: input.packageDigest,
    installedUiArtifactDigest: input.packageDigest,
  })}`, 'utf8'));
}

type PredecessorGeneration = Readonly<{
  record: Record<string, unknown>;
  rootPath: string;
  files: readonly Readonly<{ relativePath: string; bytes: Buffer }>;
}>;

async function writePredecessorGeneration(input: Readonly<{
  generationsDir: string;
  immutableGenerationId: string;
  createdAtMs: number;
  manifestVersion: string;
  distribution: unknown;
  additionalFiles?: readonly Readonly<{ relativePath: string; bytes: Buffer }>;
}>): Promise<PredecessorGeneration> {
  const rootPath = join(input.generationsDir, input.immutableGenerationId);
  const files = [
    {
      relativePath: MANIFEST_RELATIVE_PATH,
      bytes: Buffer.from(JSON.stringify({
        schemaVersion: 2,
        id: PLUGIN_ID,
        version: input.manifestVersion,
      }), 'utf8'),
    },
    {
      relativePath: 'daemon.mjs',
      bytes: Buffer.from(`export const version = '${input.manifestVersion}';\n`, 'utf8'),
    },
    ...(input.additionalFiles ?? []),
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const inventory = files.map((file) => ({
    relativePath: file.relativePath,
    byteLength: file.bytes.byteLength,
    digest: sha256(file.bytes),
  }));
  const installedArtifactRecord = inventory.find((file) => file.relativePath === MANIFEST_RELATIVE_PATH)!;
  const packageDigest = predecessorJsonDigest(inventory);
  const fingerprint = predecessorGenerationFingerprint({
    distribution: input.distribution,
    manifestDigest: installedArtifactRecord.digest,
    packageDigest,
    updatePolicy: 'manual',
  });
  const record = {
    t: 'happier_plugin_generation_v1',
    schemaVersion: 1,
    pluginId: PLUGIN_ID,
    immutableGenerationId: input.immutableGenerationId,
    fingerprint,
    packageDigest,
    manifestDigest: installedArtifactRecord.digest,
    runtimeDigest: packageDigest,
    installedUiArtifactDigest: packageDigest,
    createdAtMs: input.createdAtMs,
    files: inventory,
    installedArtifactRecord: {
      relativePath: installedArtifactRecord.relativePath,
      digest: installedArtifactRecord.digest,
    },
  };
  for (const file of files) {
    const path = join(rootPath, ...file.relativePath.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes);
  }
  await writeFile(join(rootPath, 'plugin-generation.v1.json'), JSON.stringify(record, null, 2), 'utf8');
  return { record, rootPath, files };
}

async function writeFullPredecessorFixture(
  happyHomeDir: string,
  options: Readonly<{
    additionalGenerationFiles?: readonly Readonly<{ relativePath: string; bytes: Buffer }>;
    rollbackByteAvailability?: 'available' | 'missing' | 'corrupt' | 'evicted' | 'sourceIneligible';
  }> = {},
): Promise<Readonly<{
  paths: ReturnType<typeof resolvePluginStorePaths>;
  commit: Record<string, unknown>;
  state: Record<string, unknown>;
  currentGeneration: PredecessorGeneration;
  rollbackGeneration: PredecessorGeneration;
  selectedAccess: unknown;
}>> {
  const paths = resolvePluginStorePaths({ happyHomeDir });
  const distribution = { kind: 'localPath', canonicalPath: '/sanitized/acme-provenance-fixture' };
  const trust = {
    pluginId: PLUGIN_ID,
    distribution,
    state: 'trusted',
    approvedAtMs: 1_723_000_000_111,
  };
  const selectedAccess = createDefaultPluginAccessScopeRegistry().createSelection({
    pluginId: PLUGIN_ID,
    accessId: 'environment-selection',
    capability: 'environment',
    scope: { keys: ['ACME_TOKEN'] },
    selectedAtMs: 1_723_000_000_222,
  });
  const installReviewPrincipalPresentation = {
    v: 1 as const,
    packageIdentity: { pluginId: PLUGIN_ID, packageName: null },
    distributionIdentity: { kind: 'path' as const, development: true },
    publisherIdentity: { status: 'unavailable' as const },
    packageSignature: { status: 'unavailable' as const },
  };
  const installReviewPrincipalDigest = derivePluginInstallReviewPrincipalDigest(
    installReviewPrincipalPresentation,
  );
  const currentGeneration = await writePredecessorGeneration({
    generationsDir: paths.generationsDir,
    immutableGenerationId: CURRENT_GENERATION_ID,
    createdAtMs: 1_723_000_000_333,
    manifestVersion: '2.0.0',
    distribution,
    additionalFiles: options.additionalGenerationFiles,
  });
  const rollbackGeneration = await writePredecessorGeneration({
    generationsDir: paths.generationsDir,
    immutableGenerationId: ROLLBACK_GENERATION_ID,
    createdAtMs: 1_722_000_000_333,
    manifestVersion: '1.0.0',
    distribution,
    additionalFiles: options.additionalGenerationFiles,
  });
  const currentRecord = currentGeneration.record as {
    fingerprint: string;
    packageDigest: string;
    manifestDigest: string;
    installedArtifactRecord: Readonly<{ relativePath: string; digest: string }>;
  };
  const rollbackRecord = rollbackGeneration.record as {
    fingerprint: string;
    packageDigest: string;
    manifestDigest: string;
    installedArtifactRecord: Readonly<{ relativePath: string; digest: string }>;
  };
  const catalogRecord = (generation: PredecessorGeneration, version: string) => {
    const record = generation.record as {
      manifestDigest: string;
      installedArtifactRecord: Readonly<{ relativePath: string }>;
    };
    return {
      source: {
        kind: 'path',
        locator: distribution.canonicalPath,
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
        resolvedPath: generation.rootPath,
        manifestPath: join(generation.rootPath, ...record.installedArtifactRecord.relativePath.split('/')),
        resolvedDigest: record.manifestDigest,
        resolvedVersion: version,
      },
      compatibility: { status: 'compatible', checkedAtMs: 1_723_000_000_444, diagnostics: [] },
      install: {
        mode: 'managed_install',
        manifestVersion: version,
        manifestDigest: record.manifestDigest,
        installedPath: generation.rootPath,
        trust,
        updatePolicy: 'manual',
        optionalAccess: [selectedAccess],
      },
      state: { enabled: true, lastLoadedAtMs: 1_723_000_000_555 },
    };
  };
  const currentCatalog = catalogRecord(currentGeneration, '2.0.0');
  const rollbackCatalog = catalogRecord(rollbackGeneration, '1.0.0');
  const healthRecord = (generationId: string, fingerprint: string) => ({
    pluginId: PLUGIN_ID,
    immutableGenerationId: generationId,
    fingerprint,
    state: 'healthy',
    tryOnce: 'unavailable',
    eligibleFailures: [],
    consumedAttemptIds: [],
    observation: null,
  });
  const state = {
    t: 'happier_plugin_installations_v1',
    schemaVersion: 1,
    revisionId: 'state-provenance-predecessor',
    createdAtMs: PREDECESSOR_PROVENANCE.retainedObservedCreatedAtMs,
    plugins: {
      [PLUGIN_ID]: {
        enabled: true,
        trust,
        source: { distribution, admittedIntegrity: currentRecord.packageDigest },
        updatePolicy: 'manual',
        optionalAccess: [selectedAccess],
        installReviewPrincipalDigest,
        installReviewPrincipalPresentation,
      },
    },
    health: {
      [CURRENT_GENERATION_ID]: healthRecord(CURRENT_GENERATION_ID, currentRecord.fingerprint),
      [ROLLBACK_GENERATION_ID]: healthRecord(ROLLBACK_GENERATION_ID, rollbackRecord.fingerprint),
    },
    rollbackRetention: [{
      pluginId: PLUGIN_ID,
      immutableGenerationId: ROLLBACK_GENERATION_ID,
      healthGenerationId: ROLLBACK_GENERATION_ID,
      role: 'lastKnownGood',
      automaticRecoveryEligible: (options.rollbackByteAvailability ?? 'available') === 'available',
      retainedAtMs: 1_723_000_000_777,
      byteAvailability: options.rollbackByteAvailability ?? 'available',
      packageDigest: rollbackRecord.packageDigest,
      artifactDigest: rollbackRecord.installedArtifactRecord.digest,
      pluginVersion: '1.0.0',
      distribution,
      installReviewPrincipalDigest,
      installReviewPrincipalPresentation,
    }],
    healthTombstones: [{
      pluginId: PLUGIN_ID,
      immutableGenerationId: 'retired-sanitized-generation',
      state: 'quarantined',
      recordedAtMs: 1_721_000_000_888,
    }],
    hardRevocationRevisions: { [PLUGIN_ID]: 4 },
    runtimeCatalog: {
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: { [PLUGIN_ID]: currentCatalog },
    },
    retainedRuntimeCatalog: { [ROLLBACK_GENERATION_ID]: rollbackCatalog },
  };
  const statePath = join(paths.stateRevisionsDir, state.revisionId, 'plugin-installations.v1.json');
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  const commit = {
    t: 'happier_plugin_registry_commit_v1',
    schemaVersion: 1,
    revision: 7,
    transactionId: 'install-provenance-predecessor',
    baseRevision: 6,
    installationState: {
      revisionId: state.revisionId,
      digest: predecessorJsonDigest(state),
    },
    pluginGenerations: {
      [PLUGIN_ID]: {
        immutableGenerationId: CURRENT_GENERATION_ID,
        generationRecordDigest: predecessorJsonDigest(currentGeneration.record),
        installedArtifactRecord: currentRecord.installedArtifactRecord,
      },
    },
    createdAtMs: PREDECESSOR_PROVENANCE.retainedObservedCreatedAtMs,
    creator: { pid: 4321, instanceId: 'sanitized-daemon-instance' },
  };
  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(paths.registryCurrentFilePath, JSON.stringify(commit, null, 2), 'utf8');
  return { paths, commit, state, currentGeneration, rollbackGeneration, selectedAccess };
}

async function snapshotFiles(root: string): Promise<Readonly<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, relativePath);
      else snapshot[relativePath] = (await readFile(path)).toString('base64');
    }
  }
  await visit(root, '');
  return snapshot;
}

function stagingDirectoryAncestors(
  stagingRoot: string,
  relativePaths: readonly string[],
): readonly string[] {
  const directories = new Set<string>([stagingRoot]);
  for (const relativePath of relativePaths) {
    let directory = dirname(join(stagingRoot, ...relativePath.split('/')));
    while (true) {
      directories.add(directory);
      if (directory === stagingRoot) break;
      const parent = dirname(directory);
      if (parent === directory) throw new Error('Test fixture escaped its staging root');
      directory = parent;
    }
  }
  return [...directories];
}

describe('unpublished plugin registry v1 persistence reconciliation', () => {
  it('flushes every recursively-created staging ancestor before publishing replacement generations', async () => {
    const happyHomeDir = await createRetainedStackCliHome('happier-unpublished-registry-reconcile-durability-');
    const fixture = await writeFullPredecessorFixture(happyHomeDir, {
      additionalGenerationFiles: [{
        relativePath: 'plugins/runtime/deep/worker.mjs',
        bytes: Buffer.from('export const nested = true;\n', 'utf8'),
      }],
    });
    stagingDurabilityEvents.startCapture();
    try {
      await expect(reconcileUnpublishedPluginRegistryV1({
        happyHomeDir,
        expectedProducerCommit: PREDECESSOR_PROVENANCE.producerCommit,
        ownerStopped: true,
        owner: {
          pid: process.pid,
          instanceId: 'unpublished-reconciliation-durability-test',
        },
      })).resolves.toMatchObject({ status: 'reconciled' });
    } finally {
      stagingDurabilityEvents.stopCapture();
    }

    const events = stagingDurabilityEvents.snapshot();
    const publications = events
      .map((event, index) => ({ event, index }))
      .filter(
        (entry): entry is Readonly<{
          event: Readonly<{ kind: 'rename'; from: string; to: string }>;
          index: number;
        }> => (
          entry.event.kind === 'rename'
          && entry.event.from.startsWith(
            join(fixture.paths.generationsDir, '.reconciling-'),
          )
          && entry.event.to.startsWith(
            join(fixture.paths.generationsDir, 'reconciled-'),
          )
        ),
      );
    expect(publications).toHaveLength(2);

    const expectedRelativePaths = fixture.currentGeneration.files.map((file) => file.relativePath);
    for (const publication of publications) {
      const flushedBeforePublication = new Set(events
        .slice(0, publication.index)
        .filter(
          (event): event is Readonly<{ kind: 'flushDirectory'; path: string }> => (
            event.kind === 'flushDirectory'
          ),
        )
        .map((event) => event.path));
      for (const directory of stagingDirectoryAncestors(
        publication.event.from,
        expectedRelativePaths,
      )) {
        expect(flushedBeforePublication).toContain(directory);
      }
    }
  });

  it('reconciles the exact digest-bearing predecessor graph, retires only provably superseded roots, and is idempotent', async () => {
    expect(PREDECESSOR_PROVENANCE.producerCommit).toBe('8173b221801c0f7ca747574559ba314303f8c211');
    expect(PREDECESSOR_PROVENANCE.producerCommittedAtMs)
      .toBeLessThan(PREDECESSOR_PROVENANCE.retainedObservedCreatedAtMs);
    expect(PREDECESSOR_PROVENANCE.retainedObservedCreatedAtMs)
      .toBeLessThan(PREDECESSOR_PROVENANCE.rejectedFutureCheckoutCommittedAtMs);
    const happyHomeDir = await createRetainedStackCliHome('happier-unpublished-registry-reconcile-');
    const fixture = await writeFullPredecessorFixture(happyHomeDir);

    await expect(readCurrentCommittedPluginGenerations(fixture.paths)).rejects.toThrow(/invalid plugin registry commit/i);
    await expect(createPluginRegistryStateStore({ happyHomeDir }).read())
      .rejects.toThrow(/invalid plugin registry commit/i);

    const first = await reconcileUnpublishedPluginRegistryV1({
      happyHomeDir,
      expectedProducerCommit: PREDECESSOR_PROVENANCE.producerCommit,
      ownerStopped: true,
      owner: { pid: process.pid, instanceId: 'unpublished-reconciliation-test' },
    });
    expect(first.status).toBe('reconciled');
    expect(first.replacedGenerationIds).toEqual({
      [CURRENT_GENERATION_ID]: expect.stringMatching(/^reconciled-[a-f0-9]{64}$/),
      [ROLLBACK_GENERATION_ID]: expect.stringMatching(/^reconciled-[a-f0-9]{64}$/),
    });

    const commit = await readPluginRegistryCommitRecord(fixture.paths);
    expect(commit).toMatchObject({
      revision: 7,
      transactionId: 'install-provenance-predecessor',
      baseRevision: 6,
      createdAtMs: PREDECESSOR_PROVENANCE.retainedObservedCreatedAtMs,
      creator: { pid: 4321, instanceId: 'sanitized-daemon-instance' },
    });
    expect(commit?.installationState).toEqual({ revisionId: first.installationRevisionId });
    const state = await readInstallationStateRevision({
      paths: fixture.paths,
      reference: commit!.installationState,
      commit: commit!,
    });
    const currentId = commit!.pluginGenerations[PLUGIN_ID]!.immutableGenerationId;
    const rollbackId = state.rollbackRetention[0]!.immutableGenerationId;
    expect(currentId).toBe(first.replacedGenerationIds[CURRENT_GENERATION_ID]);
    expect(rollbackId).toBe(first.replacedGenerationIds[ROLLBACK_GENERATION_ID]);
    expect(state).toMatchObject({
      createdAtMs: PREDECESSOR_PROVENANCE.retainedObservedCreatedAtMs,
      plugins: {
        [PLUGIN_ID]: {
          enabled: true,
          trust: ((fixture.state.plugins as Record<string, {
            trust: unknown;
          }>)[PLUGIN_ID]!).trust,
          updatePolicy: 'manual',
          optionalAccess: [fixture.selectedAccess],
          installReviewPrincipalDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      rollbackRetention: [{
        pluginId: PLUGIN_ID,
        retainedAtMs: 1_723_000_000_777,
        byteAvailability: 'available',
        pluginVersion: '1.0.0',
        installReviewPrincipalDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }],
      hardRevocationRevisions: { [PLUGIN_ID]: 4 },
    });
    expect(state).not.toHaveProperty('health');
    expect(state).not.toHaveProperty('healthTombstones');
    expect(state.plugins[PLUGIN_ID]?.source).not.toHaveProperty('admittedIntegrity');
    expect(Object.keys(state.runtimeCatalog?.plugins ?? {})).toEqual([PLUGIN_ID]);
    expect(Object.keys(state.retainedRuntimeCatalog ?? {})).toEqual([rollbackId]);
    expect(state.runtimeCatalog?.plugins[PLUGIN_ID]?.install.optionalAccess).toEqual([fixture.selectedAccess]);
    expect(state.runtimeCatalog?.plugins[PLUGIN_ID]?.compatibility.checkedAtMs).toBe(1_723_000_000_444);
    expect(state.runtimeCatalog?.plugins[PLUGIN_ID]?.state.lastLoadedAtMs).toBe(1_723_000_000_555);

    const currentGeneration = await readPreparedImmutablePluginGeneration({
      paths: fixture.paths,
      immutableGenerationId: currentId,
    });
    const rollbackGeneration = await readPreparedImmutablePluginGeneration({
      paths: fixture.paths,
      immutableGenerationId: rollbackId,
    });
    expect(currentGeneration.record).toMatchObject({
      pluginId: PLUGIN_ID,
      createdAtMs: 1_723_000_000_333,
      manifestRelativePath: MANIFEST_RELATIVE_PATH,
    });
    expect(currentGeneration.record.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: MANIFEST_RELATIVE_PATH }),
    ]));
    expect(rollbackGeneration.record).toMatchObject({
      pluginId: PLUGIN_ID,
      createdAtMs: 1_722_000_000_333,
      manifestRelativePath: MANIFEST_RELATIVE_PATH,
    });
    await expect(stat(join(fixture.paths.generationsDir, CURRENT_GENERATION_ID)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(fixture.paths.generationsDir, ROLLBACK_GENERATION_ID)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readCurrentCommittedPluginGenerations(fixture.paths)).resolves.toMatchObject({
      generations: new Map([[PLUGIN_ID, expect.objectContaining({ immutableGenerationId: currentId })]]),
    });
    await expect(createPluginRegistryStateStore({ happyHomeDir }).read()).resolves.toMatchObject({
      plugins: { [PLUGIN_ID]: { install: { manifestVersion: '2.0.0' } } },
    });

    const distribution = (
      fixture.state.plugins as Record<string, { source: { distribution: unknown } }>
    )[PLUGIN_ID]!.source.distribution;
    // A prior operator can have completed the durable commit before its
    // post-commit root cleanup. Recreate those exact predecessor roots to
    // prove that the current-record retry cleans them without accepting
    // arbitrary predecessor-shaped directories.
    await writePredecessorGeneration({
      generationsDir: fixture.paths.generationsDir,
      immutableGenerationId: CURRENT_GENERATION_ID,
      createdAtMs: 1_723_000_000_333,
      manifestVersion: '2.0.0',
      distribution,
    });
    await writePredecessorGeneration({
      generationsDir: fixture.paths.generationsDir,
      immutableGenerationId: ROLLBACK_GENERATION_ID,
      createdAtMs: 1_722_000_000_333,
      manifestVersion: '1.0.0',
      distribution,
    });
    const unrelatedGeneration = await writePredecessorGeneration({
      generationsDir: fixture.paths.generationsDir,
      immutableGenerationId: 'generation-unrelated-predecessor',
      createdAtMs: 1_721_000_000_333,
      manifestVersion: '0.1.0',
      distribution,
    });

    await expect(reconcileUnpublishedPluginRegistryV1({
      happyHomeDir,
      expectedProducerCommit: PREDECESSOR_PROVENANCE.producerCommit,
      ownerStopped: true,
      owner: { pid: process.pid, instanceId: 'unpublished-reconciliation-test' },
    })).resolves.toMatchObject({ status: 'no_op', installationRevisionId: first.installationRevisionId });
    await expect(stat(join(fixture.paths.generationsDir, CURRENT_GENERATION_ID)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(fixture.paths.generationsDir, ROLLBACK_GENERATION_ID)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(unrelatedGeneration.rootPath)).resolves.toBeDefined();

    const afterSecond = await snapshotFiles(fixture.paths.rootDir);
    await expect(reconcileUnpublishedPluginRegistryV1({
      happyHomeDir,
      expectedProducerCommit: PREDECESSOR_PROVENANCE.producerCommit,
      ownerStopped: true,
      owner: { pid: process.pid, instanceId: 'unpublished-reconciliation-test' },
    })).resolves.toMatchObject({ status: 'no_op', installationRevisionId: first.installationRevisionId });
    expect(await snapshotFiles(fixture.paths.rootDir)).toEqual(afterSecond);
  });

  it('fails closed before any write when a predecessor digest is corrupt', async () => {
    const happyHomeDir = await createRetainedStackCliHome('happier-unpublished-registry-corrupt-');
    const fixture = await writeFullPredecessorFixture(happyHomeDir);
    const currentDaemonPath = join(
      fixture.paths.generationsDir,
      CURRENT_GENERATION_ID,
      'daemon.mjs',
    );
    await writeFile(currentDaemonPath, "export const version = '9.9.9';\n", 'utf8');
    const before = await snapshotFiles(fixture.paths.rootDir);

    await expect(reconcileUnpublishedPluginRegistryV1({
      happyHomeDir,
      expectedProducerCommit: PREDECESSOR_PROVENANCE.producerCommit,
      ownerStopped: true,
      owner: { pid: process.pid, instanceId: 'unpublished-reconciliation-corrupt-test' },
    })).rejects.toThrow(/digest|manifest/i);
    expect(await snapshotFiles(fixture.paths.rootDir)).toEqual(before);
  });

  it('retires a verified predecessor rollback root even when its replacement retention is byte-unavailable', async () => {
    const happyHomeDir = await createRetainedStackCliHome('happier-unpublished-registry-unavailable-retention-');
    const fixture = await writeFullPredecessorFixture(happyHomeDir, {
      rollbackByteAvailability: 'evicted',
    });

    await expect(reconcileUnpublishedPluginRegistryV1({
      happyHomeDir,
      expectedProducerCommit: PREDECESSOR_PROVENANCE.producerCommit,
      ownerStopped: true,
      owner: { pid: process.pid, instanceId: 'unpublished-reconciliation-unavailable-retention-test' },
    })).resolves.toMatchObject({ status: 'reconciled' });

    const commit = await readPluginRegistryCommitRecord(fixture.paths);
    if (!commit) throw new Error('Expected a reconciled current commit');
    const state = await readInstallationStateRevision({
      paths: fixture.paths,
      reference: commit.installationState,
      commit,
    });
    expect(state.rollbackRetention).toMatchObject([{ byteAvailability: 'evicted' }]);
    await expect(stat(join(fixture.paths.generationsDir, ROLLBACK_GENERATION_ID)))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const replacementId = state.rollbackRetention[0]!.immutableGenerationId;
    await rm(join(fixture.paths.generationsDir, replacementId), { recursive: true, force: false });
    const distribution = (
      fixture.state.plugins as Record<string, { source: { distribution: unknown } }>
    )[PLUGIN_ID]!.source.distribution;
    await writePredecessorGeneration({
      generationsDir: fixture.paths.generationsDir,
      immutableGenerationId: ROLLBACK_GENERATION_ID,
      createdAtMs: 1_722_000_000_333,
      manifestVersion: '1.0.0',
      distribution,
    });
    await expect(reconcileUnpublishedPluginRegistryV1({
      happyHomeDir,
      expectedProducerCommit: PREDECESSOR_PROVENANCE.producerCommit,
      ownerStopped: true,
      owner: { pid: process.pid, instanceId: 'unpublished-reconciliation-unavailable-retention-retry-test' },
    })).resolves.toMatchObject({ status: 'no_op' });
    await expect(stat(join(fixture.paths.generationsDir, ROLLBACK_GENERATION_ID)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects the later b059 checkout basis because it postdates the retained writes', async () => {
    const happyHomeDir = await createRetainedStackCliHome('happier-unpublished-registry-wrong-producer-');
    const fixture = await writeFullPredecessorFixture(happyHomeDir);
    const before = await snapshotFiles(fixture.paths.rootDir);

    await expect(reconcileUnpublishedPluginRegistryV1({
      happyHomeDir,
      expectedProducerCommit: PREDECESSOR_PROVENANCE.rejectedFutureCheckoutCommit,
      ownerStopped: true,
      owner: { pid: process.pid, instanceId: 'unpublished-reconciliation-wrong-producer-test' },
    })).rejects.toThrow(/unsupported.*producer/i);
    expect(await snapshotFiles(fixture.paths.rootDir)).toEqual(before);
  });
});
