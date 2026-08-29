import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import {
  PluginInstallReviewPrincipalDigestSchema,
  PluginInstallReviewPrincipalPresentationV1Schema,
} from '@happier-dev/protocol';

const packagedRuntime = vi.hoisted(() => ({ root: '' }));

vi.mock('../../../configuration', () => ({ configuration: { happyHomeDir: join(tmpdir(), 'unused-registry-home') } }));
vi.mock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath', () => ({
  resolveCliRuntimeRootPath: () => packagedRuntime.root,
}));

import { resolvePluginStorePaths } from '../paths';
import {
  cleanupUnreferencedPluginGenerations,
  copyOwnedPluginGenerationFile,
  createImmutablePluginGenerationRecordFromSource,
  ImmutablePluginGenerationRecordSchema,
  persistInstallationStateRevision,
  persistValidatedAgentSessionRunnerFactories,
  prepareImmutablePluginGeneration,
  prepareOwnedImmutablePluginGeneration,
  prepareOwnedPluginDevelopmentGenerationFromEdit,
  readCurrentCommittedPluginGenerations,
  readPluginRegistryCommitInstallationAuthority,
  readCurrentPluginImmutableGenerationIntegrityCurrentness,
  readInstallationStateRevision,
  readPreparedImmutablePluginGeneration,
  readValidatedAgentSessionRunnerFactories,
  verifyPluginRegistryCommitGenerationReferences,
  PluginInstallationStateRevisionSchema,
  PluginRollbackRetentionRecordSchema,
  type PluginInstallationStateRevision,
} from './generationStore';
import type { PluginRegistryCommitRecord } from './commitRecord';
import { reconcilePluginGenerationCustodyRetirement } from './generationCustodyRetirement';
import { derivePluginInstallReviewPrincipalDigest } from '../../daemon/installReviewPrincipal';

function stateRevision(generationId = 'generation-a'): PluginInstallationStateRevision {
  return {
    t: 'happier_plugin_installations_v1', schemaVersion: 1, revisionId: 'state-1', createdAtMs: 1,
    plugins: {
      'acme.plugin': {
        enabled: true,
        trust: { pluginId: 'acme.plugin', distribution: { kind: 'localPath', canonicalPath: '/tmp/acme-plugin' }, state: 'trusted', approvedAtMs: 1 },
        source: {
          distribution: { kind: 'localPath', canonicalPath: '/tmp/acme-plugin' },
        },
        updatePolicy: 'manual',
        optionalAccess: [],
      },
    },
    rollbackRetention: [],
  };
}

it('requests copy-on-write cloning for immutable generation copies while preserving the platform fallback', async () => {
  const copyFile = vi.fn(async () => undefined);

  await copyOwnedPluginGenerationFile('/source/file', '/destination/file', copyFile);

  expect(copyFile).toHaveBeenCalledWith(
    '/source/file',
    '/destination/file',
    constants.COPYFILE_FICLONE,
  );
});

describe('immutable plugin generation store', () => {
  it('rejects retired generation health state from the canonical schema', () => {
    const base = stateRevision('generation-current');
    const retiredState = {
      ...base,
      health: {
        'generation-current': {
          pluginId: 'acme.plugin',
          immutableGenerationId: 'generation-current',
          state: 'healthy',
        },
      },
      rollbackRetention: [{
        pluginId: 'acme.plugin',
        immutableGenerationId: 'generation-prior',
        healthGenerationId: 'generation-prior',
        role: 'lastKnownGood',
        automaticRecoveryEligible: true,
        retainedAtMs: 1,
        byteAvailability: 'available',
        pluginVersion: '1.0.0',
        distribution: { kind: 'localPath', canonicalPath: '/tmp/acme-plugin' },
      }, {
        pluginId: 'acme.plugin',
        immutableGenerationId: 'generation-quarantined',
        healthGenerationId: 'generation-quarantined',
        role: 'quarantined',
        automaticRecoveryEligible: false,
        retainedAtMs: 2,
        byteAvailability: 'available',
        pluginVersion: '0.9.0',
        distribution: { kind: 'localPath', canonicalPath: '/tmp/acme-plugin' },
      }],
      healthTombstones: [{
        pluginId: 'acme.plugin',
        immutableGenerationId: 'generation-revoked',
        state: 'integrityRevoked',
        recordedAtMs: 3,
      }, {
        pluginId: 'acme.plugin',
        immutableGenerationId: 'generation-quarantined',
        state: 'quarantined',
        recordedAtMs: 2,
      }],
    };

    expect(PluginInstallationStateRevisionSchema.safeParse(retiredState).success).toBe(false);
  });

  it('rejects obsolete persisted generation integrity revocations', () => {
    const legacyState = {
      ...stateRevision('generation-current'),
      integrityRevocations: [{
        pluginId: 'acme.plugin',
        immutableGenerationId: 'generation-current',
        state: 'integrityRevoked',
        recordedAtMs: 1,
      }],
    };

    expect(PluginInstallationStateRevisionSchema.safeParse(legacyState).success).toBe(false);
  });

  it('rejects an unreleased digest-bearing bootstrap instead of preserving a custom-hash reader', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-predecessor-bootstrap-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    await mkdir(paths.stateDir, { recursive: true });
    const predecessorBootstrap = {
      t: 'happier_plugin_registry_commit_v1' as const,
      schemaVersion: 1 as const,
      revision: 0,
      transactionId: 'predecessor-bootstrap',
      baseRevision: null,
      installationState: {
        revisionId: 'state-0',
        digest: `sha256:${'0'.repeat(64)}`,
      },
      pluginGenerations: {},
      createdAtMs: 1,
      creator: { pid: 1, instanceId: 'daemon-a' },
    };

    await writeFile(paths.registryCurrentFilePath, JSON.stringify(predecessorBootstrap), 'utf8');
    await expect(import('./commitRecord').then(({ readPluginRegistryCommitRecord }) => (
      readPluginRegistryCommitRecord(paths)
    ))).rejects.toThrow(/invalid plugin registry commit/i);
  });

  it('persists canonical archive SRI acquisition integrity and rejects malformed values', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-installation-source-integrity-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const admittedIntegrity = `sha256-${Buffer.alloc(32, 5).toString('base64')}`;
    const distribution = {
      kind: 'archive' as const,
      source: { kind: 'localFile' as const, canonicalPath: '/tmp/acme-plugin.tgz' },
      integrity: admittedIntegrity,
    };
    const state: PluginInstallationStateRevision = {
      ...stateRevision(),
      revisionId: 'state-acquisition-sri',
      plugins: {
        'acme.plugin': {
          ...stateRevision().plugins['acme.plugin']!,
          trust: {
            pluginId: 'acme.plugin',
            distribution,
            state: 'trusted',
            approvedAtMs: 1,
          },
          source: { distribution, admittedIntegrity },
        },
      },
    };

    const reference = await persistInstallationStateRevision({ paths, state });
    await expect(readInstallationStateRevision({ paths, reference })).resolves.toMatchObject({
      plugins: {
        'acme.plugin': {
          source: { admittedIntegrity },
        },
      },
    });

    const malformedState: PluginInstallationStateRevision = {
      ...state,
      revisionId: 'state-acquisition-sri-invalid',
      plugins: {
        'acme.plugin': {
          ...state.plugins['acme.plugin']!,
          source: {
            ...state.plugins['acme.plugin']!.source,
            admittedIntegrity: 'sha256-not-canonical-sri',
          },
        },
      },
    };
    await expect(persistInstallationStateRevision({ paths, state: malformedState }))
      .rejects.toThrow(/integrity/i);

    const localPathIntegrityState: PluginInstallationStateRevision = {
      ...stateRevision(),
      revisionId: 'state-local-path-acquisition-sri',
      plugins: {
        'acme.plugin': {
          ...stateRevision().plugins['acme.plugin']!,
          source: {
            distribution: { kind: 'localPath', canonicalPath: '/tmp/acme-plugin' },
            admittedIntegrity,
          },
        },
      },
    };
    await expect(persistInstallationStateRevision({ paths, state: localPathIntegrityState }))
      .rejects.toThrow(/local path.*integrity/i);
  });

  it('rejects mismatched principal presentation writes and rehydration while preserving digest-only records', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-principal-pair-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const presentation = PluginInstallReviewPrincipalPresentationV1Schema.parse({
      v: 1,
      packageIdentity: { pluginId: 'acme.plugin', packageName: '@acme/plugin' },
      distributionIdentity: { kind: 'archive' },
      publisherIdentity: { status: 'unavailable' },
      packageSignature: { status: 'unavailable' },
    });
    const mismatchedDigest = PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64));
    const mismatchedState: PluginInstallationStateRevision = {
      ...stateRevision(),
      plugins: {
        'acme.plugin': {
          ...stateRevision().plugins['acme.plugin']!,
          installReviewPrincipalDigest: mismatchedDigest,
          installReviewPrincipalPresentation: presentation,
        },
      },
    };

    await expect(persistInstallationStateRevision({ paths, state: mismatchedState }))
      .rejects.toThrow(/install-review principal.*digest|digest.*install-review principal/i);
    const rollbackRecord = {
      pluginId: 'acme.plugin',
      immutableGenerationId: 'generation-rollback',
      retainedAtMs: 1,
      byteAvailability: 'available',
      pluginVersion: '1.0.0',
      distribution: { kind: 'localPath', canonicalPath: '/tmp/acme-plugin' },
      installReviewPrincipalDigest: mismatchedDigest,
      installReviewPrincipalPresentation: presentation,
    } as const;
    expect(PluginRollbackRetentionRecordSchema.safeParse(rollbackRecord).success).toBe(false);
    expect(PluginRollbackRetentionRecordSchema.safeParse({
      ...rollbackRecord,
      installReviewPrincipalPresentation: undefined,
    }).success).toBe(true);

    await mkdir(join(paths.stateRevisionsDir, mismatchedState.revisionId), { recursive: true });
    const raw = JSON.stringify(mismatchedState);
    await writeFile(
      join(paths.stateRevisionsDir, mismatchedState.revisionId, 'plugin-installations.v1.json'),
      raw,
      'utf8',
    );
    await expect(readInstallationStateRevision({
      paths,
      reference: { revisionId: mismatchedState.revisionId },
    })).rejects.toThrow(/invalid installation state revision/i);

    const digestOnlyState: PluginInstallationStateRevision = {
      ...mismatchedState,
      revisionId: 'state-digest-only',
      plugins: {
        'acme.plugin': {
          ...mismatchedState.plugins['acme.plugin']!,
          installReviewPrincipalDigest: derivePluginInstallReviewPrincipalDigest(presentation),
          installReviewPrincipalPresentation: undefined,
        },
      },
    };
    await expect(persistInstallationStateRevision({ paths, state: digestOnlyState })).resolves.toBeDefined();
    const digestOnlyRead = await readInstallationStateRevision({
      paths,
      reference: await persistInstallationStateRevision({ paths, state: digestOnlyState }),
    });
    expect(digestOnlyRead.plugins['acme.plugin'])
      .not.toHaveProperty('installReviewPrincipalPresentation');
  });

  it('projects a host-generated canonical manifest into a one-file immutable generation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-one-file-home-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-one-file-source-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const manifestContents = '{"schemaVersion":2,"id":"acme.one-file"}\n';
    const initialSourceContents = "export const sentinel = 'one';\n";
    try {
      await writeFile(join(sourceRootPath, 'plugin.ts'), initialSourceContents, 'utf8');
      await writeFile(join(sourceRootPath, 'unrelated.txt'), 'must not be admitted', 'utf8');
      const record = await createImmutablePluginGenerationRecordFromSource({
        pluginId: 'acme.one-file',
        sourceRootPath,
        singleFileRelativePath: 'plugin.ts',
        manifestRelativePath: '.happier-plugin/plugin.json',
        generatedManifestContents: manifestContents,
        distribution: { kind: 'localPath', canonicalPath: join(sourceRootPath, 'plugin.ts') },
        updatePolicy: 'manual',
        createdAtMs: 1,
        immutableGenerationId: 'generation-one-file-a',
      });
      expect(record.files).toEqual([
        {
          relativePath: '.happier-plugin/plugin.json',
          byteLength: Buffer.byteLength(manifestContents),
        },
        {
          relativePath: 'plugin.ts',
          byteLength: Buffer.byteLength(initialSourceContents),
        },
      ]);
      const prepared = await prepareImmutablePluginGeneration({
        paths,
        sourceRootPath,
        record,
        generatedManifestContents: manifestContents,
      });
      await expect(readFile(join(prepared.rootPath, '.happier-plugin', 'plugin.json'), 'utf8'))
        .resolves.toBe(manifestContents);
      await expect(readFile(join(prepared.rootPath, 'unrelated.txt'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });

      const nextSourceContents = "export const sentinel = 'two';\n";
      await writeFile(join(sourceRootPath, 'plugin.ts'), nextSourceContents, 'utf8');
      const nextDraft = await prepareOwnedPluginDevelopmentGenerationFromEdit({
        paths,
        sourceRootPath,
        changedPaths: ['plugin.ts'],
        priorReference: prepared.reference,
        generatedManifestRelativePath: '.happier-plugin/plugin.json',
      });
      const next = await nextDraft.finalize({
        pluginId: 'acme.one-file',
        manifestRelativePath: '.happier-plugin/plugin.json',
        generatedManifestContents: manifestContents,
        distribution: { kind: 'localPath', canonicalPath: join(sourceRootPath, 'plugin.ts') },
        updatePolicy: 'manual',
        createdAtMs: 2,
      });
      await expect(readFile(join(next.rootPath, 'plugin.ts'), 'utf8')).resolves.toContain("'two'");
      await expect(readFile(join(next.rootPath, '.happier-plugin', 'plugin.json'), 'utf8'))
        .resolves.toBe(manifestContents);
      expect(next.record.files).toEqual([
        {
          relativePath: '.happier-plugin/plugin.json',
          byteLength: Buffer.byteLength(manifestContents),
        },
        {
          relativePath: 'plugin.ts',
          byteLength: Buffer.byteLength(nextSourceContents),
        },
      ]);
      expect(next.reference).toEqual({ immutableGenerationId: nextDraft.immutableGenerationId });
      await next.cleanup();
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('reads prepared generations structurally without rehashing materialized bytes', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-structural-read-home-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-structural-read-source-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    try {
      await mkdir(join(sourceRootPath, '.happier-plugin'), { recursive: true });
      await writeFile(join(sourceRootPath, '.happier-plugin', 'plugin.json'), '{}', 'utf8');
      await writeFile(join(sourceRootPath, 'entry.mjs'), 'export default 1;\n', 'utf8');
      const record = await createImmutablePluginGenerationRecordFromSource({
        pluginId: 'acme.structural-read',
        sourceRootPath,
        manifestRelativePath: '.happier-plugin/plugin.json',
        distribution: { kind: 'localPath', canonicalPath: sourceRootPath },
        updatePolicy: 'manual',
        createdAtMs: 1,
        immutableGenerationId: 'generation-structural-read',
      });
      const prepared = await prepareImmutablePluginGeneration({ paths, sourceRootPath, record });

      await writeFile(join(prepared.rootPath, 'entry.mjs'), 'export default 2;\n', 'utf8');
      await expect(readPreparedImmutablePluginGeneration({
        paths,
        immutableGenerationId: record.immutableGenerationId,
      })).resolves.toMatchObject({
        rootPath: prepared.rootPath,
        record: { immutableGenerationId: record.immutableGenerationId },
      });

      const manifestPath = join(prepared.rootPath, '.happier-plugin', 'plugin.json');
      await writeFile(manifestPath, '{}\n', 'utf8');
      await expect(readPreparedImmutablePluginGeneration({
        paths,
        immutableGenerationId: record.immutableGenerationId,
      })).rejects.toThrow(/manifest|byte length/i);

      await writeFile(manifestPath, '{}', 'utf8');
      await rm(manifestPath);
      await expect(readPreparedImmutablePluginGeneration({
        paths,
        immutableGenerationId: record.immutableGenerationId,
      })).rejects.toThrow(/manifest|required|regular|missing/i);

      await writeFile(manifestPath, '{}', 'utf8');
      await rm(manifestPath);
      await mkdir(manifestPath);
      await expect(readPreparedImmutablePluginGeneration({
        paths,
        immutableGenerationId: record.immutableGenerationId,
      })).rejects.toThrow(/manifest|required|regular|file/i);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('owns a staged immutable candidate until its exact root is adopted or cleaned', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-owned-candidate-home-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-owned-candidate-source-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    try {
      await mkdir(join(sourceRootPath, '.happier-plugin'), { recursive: true });
      await writeFile(join(sourceRootPath, '.happier-plugin', 'plugin.json'), '{}', 'utf8');
      await writeFile(join(sourceRootPath, 'entry.mjs'), 'export default 1;\n', 'utf8');

      const candidate = await prepareOwnedImmutablePluginGeneration({
        paths,
        pluginId: 'acme.owned-candidate',
        sourceRootPath,
        manifestRelativePath: '.happier-plugin/plugin.json',
        distribution: { kind: 'localPath', canonicalPath: sourceRootPath },
        updatePolicy: 'manual',
        createdAtMs: 1,
        immutableGenerationId: 'generation-owned-cleanup',
      });
      expect(candidate.reference).toEqual({ immutableGenerationId: 'generation-owned-cleanup' });
      const state = stateRevision('generation-current');
      const installationState = await persistInstallationStateRevision({ paths, state });
      await expect(cleanupUnreferencedPluginGenerations({
        paths,
        commit: {
          t: 'happier_plugin_registry_commit_v1',
          schemaVersion: 1,
          revision: 0,
          transactionId: 'owned-candidate-cleanup-race',
          baseRevision: null,
          installationState,
          pluginGenerations: {
            'acme.plugin': { immutableGenerationId: 'generation-current' },
          },
          createdAtMs: 1,
          creator: { pid: 1, instanceId: 'daemon-a' },
        },
        state,
      })).resolves.toMatchObject({ removed: [] });
      await expect(access(candidate.rootPath)).resolves.toBeUndefined();
      await expect(prepareOwnedImmutablePluginGeneration({
        paths,
        pluginId: 'acme.owned-candidate',
        sourceRootPath,
        manifestRelativePath: '.happier-plugin/plugin.json',
        distribution: { kind: 'localPath', canonicalPath: sourceRootPath },
        updatePolicy: 'manual',
        createdAtMs: 1,
        immutableGenerationId: 'generation-owned-cleanup',
      })).rejects.toThrow(/already exists/i);
      await expect(access(candidate.rootPath)).resolves.toBeUndefined();
      await writeFile(join(sourceRootPath, 'entry.mjs'), 'export default 2;\n', 'utf8');
      await expect(readFile(join(candidate.rootPath, 'entry.mjs'), 'utf8'))
        .resolves.toBe('export default 1;\n');
      await candidate.cleanup();
      await candidate.cleanup();
      await expect(access(candidate.rootPath)).rejects.toMatchObject({ code: 'ENOENT' });

      const adopted = await prepareOwnedImmutablePluginGeneration({
        paths,
        pluginId: 'acme.owned-candidate',
        sourceRootPath,
        manifestRelativePath: '.happier-plugin/plugin.json',
        distribution: { kind: 'localPath', canonicalPath: sourceRootPath },
        updatePolicy: 'manual',
        createdAtMs: 2,
        immutableGenerationId: 'generation-owned-adopted',
      });
      adopted.adopt();
      await adopted.cleanup();
      await expect(readPreparedImmutablePluginGeneration({
        paths,
        immutableGenerationId: adopted.reference.immutableGenerationId,
      })).resolves.toMatchObject({
        rootPath: adopted.rootPath,
        record: adopted.record,
        reference: adopted.reference,
      });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('does not share writable bytes between freshly materialized generations', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-fresh-write-isolation-home-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-fresh-write-isolation-source-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    try {
      await mkdir(join(sourceRootPath, '.happier-plugin'), { recursive: true });
      await writeFile(join(sourceRootPath, '.happier-plugin', 'plugin.json'), '{}', 'utf8');
      await writeFile(join(sourceRootPath, 'entry.mjs'), 'export default 1;\n', 'utf8');

      const generationG = await prepareImmutablePluginGeneration({
        paths,
        sourceRootPath,
        record: await createImmutablePluginGenerationRecordFromSource({
          pluginId: 'acme.write-isolation',
          sourceRootPath,
          manifestRelativePath: '.happier-plugin/plugin.json',
          distribution: { kind: 'localPath', canonicalPath: sourceRootPath },
          updatePolicy: 'manual',
          createdAtMs: 1,
          immutableGenerationId: 'generation-write-isolation-g',
        }),
      });
      const generationH = await prepareImmutablePluginGeneration({
        paths,
        sourceRootPath,
        record: await createImmutablePluginGenerationRecordFromSource({
          pluginId: 'acme.write-isolation',
          sourceRootPath,
          manifestRelativePath: '.happier-plugin/plugin.json',
          distribution: { kind: 'localPath', canonicalPath: sourceRootPath },
          updatePolicy: 'manual',
          createdAtMs: 2,
          immutableGenerationId: 'generation-write-isolation-h',
        }),
      });

      await writeFile(join(generationH.rootPath, 'entry.mjs'), 'export default 2;\n', 'utf8');

      await expect(readFile(join(generationG.rootPath, 'entry.mjs'), 'utf8'))
        .resolves.toBe('export default 1;\n');
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('derives and persists source provenance from the minting distribution', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-provenance-home-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-provenance-source-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    try {
      await mkdir(join(sourceRootPath, '.happier-plugin'), { recursive: true });
      await writeFile(join(sourceRootPath, '.happier-plugin', 'plugin.json'), '{}', 'utf8');
      const mint = async (
        distribution: Parameters<typeof createImmutablePluginGenerationRecordFromSource>[0]['distribution'],
        immutableGenerationId: string,
      ) => await createImmutablePluginGenerationRecordFromSource({
        pluginId: 'acme.provenance',
        sourceRootPath,
        manifestRelativePath: '.happier-plugin/plugin.json',
        distribution,
        updatePolicy: 'manual',
        createdAtMs: 1,
        immutableGenerationId,
      });

      const localPath = await mint(
        { kind: 'localPath', canonicalPath: sourceRootPath },
        'generation-provenance-local',
      );
      const npm = await mint(
        { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: '@acme/provenance' },
        'generation-provenance-npm',
      );
      const archive = await mint(
        {
          kind: 'archive',
          source: { kind: 'remoteUrl', canonicalUrl: 'https://example.test/acme-provenance.tgz' },
          integrity: `sha256-${Buffer.alloc(32, 7).toString('base64')}`,
        },
        'generation-provenance-archive',
      );

      expect([localPath.sourceProvenance, npm.sourceProvenance, archive.sourceProvenance])
        .toEqual(['localSource', 'registryCustodied', 'registryCustodied']);

      // The mint-time fact must survive the on-disk round trip: a runtime
      // reader holding only the persisted record is the consumer that could
      // not derive it before.
      await prepareImmutablePluginGeneration({ paths, sourceRootPath, record: localPath });
      await expect(readPreparedImmutablePluginGeneration({
        paths,
        immutableGenerationId: 'generation-provenance-local',
      })).resolves.toMatchObject({ record: { sourceProvenance: 'localSource' } });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('stores opaque generation identity and structural materialization facts without a digest graph', async () => {
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-opaque-record-source-'));
    try {
      await mkdir(join(sourceRootPath, '.happier-plugin'), { recursive: true });
      await writeFile(join(sourceRootPath, '.happier-plugin', 'plugin.json'), '{}', 'utf8');
      await writeFile(join(sourceRootPath, 'entry.mjs'), 'export default 1;\n', 'utf8');

      await expect(createImmutablePluginGenerationRecordFromSource({
        pluginId: 'acme.opaque-record',
        sourceRootPath,
        manifestRelativePath: '.happier-plugin/plugin.json',
        distribution: { kind: 'localPath', canonicalPath: sourceRootPath },
        updatePolicy: 'manual',
        createdAtMs: 1,
        immutableGenerationId: 'generation-opaque-record',
      })).resolves.toEqual({
        t: 'happier_plugin_generation_v1',
        schemaVersion: 1,
        pluginId: 'acme.opaque-record',
        immutableGenerationId: 'generation-opaque-record',
        createdAtMs: 1,
        manifestRelativePath: '.happier-plugin/plugin.json',
        sourceProvenance: 'localSource',
        files: [
          {
            relativePath: '.happier-plugin/plugin.json',
            byteLength: Buffer.byteLength('{}'),
          },
          {
            relativePath: 'entry.mjs',
            byteLength: Buffer.byteLength('export default 1;\n'),
          },
        ],
      });
    } finally {
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('copies only changed author bytes while keeping reused dependencies write-isolated', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-development-home-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-development-source-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    try {
      await mkdir(join(sourceRootPath, '.happier-plugin'), { recursive: true });
      await mkdir(join(sourceRootPath, 'src'), { recursive: true });
      await mkdir(join(sourceRootPath, 'node_modules', 'fixture-dependency'), { recursive: true });
      await writeFile(join(sourceRootPath, '.happier-plugin', 'plugin.json'), '{}', 'utf8');
      await writeFile(join(sourceRootPath, 'src', 'index.ts'), "export const sentinel = 'g';\n", 'utf8');
      await writeFile(
        join(sourceRootPath, 'node_modules', 'fixture-dependency', 'index.js'),
        "export const dependency = 'retained';\n",
        'utf8',
      );

      const priorRecord = await createImmutablePluginGenerationRecordFromSource({
        pluginId: 'acme.development-generation',
        sourceRootPath,
        manifestRelativePath: '.happier-plugin/plugin.json',
        distribution: { kind: 'localPath', canonicalPath: sourceRootPath },
        updatePolicy: 'manual',
        createdAtMs: 1,
        immutableGenerationId: 'generation-development-g',
      });
      const prior = await prepareImmutablePluginGeneration({
        paths,
        sourceRootPath,
        record: priorRecord,
      });

      // Development dependency preparation owns dependency changes. A source-only
      // edit must retain the already-admitted dependency closure even when it is
      // absent from the author root used for the fast edit.
      await rm(join(sourceRootPath, 'node_modules'), { recursive: true, force: true });
      const changedBytes = "export const sentinel = 'h';\n";
      await writeFile(join(sourceRootPath, 'src', 'index.ts'), changedBytes, 'utf8');

      const nextDraft = await prepareOwnedPluginDevelopmentGenerationFromEdit({
        paths,
        sourceRootPath,
        changedPaths: ['src\\index.ts'],
        priorReference: prior.reference,
        generatedManifestRelativePath: '.happier-plugin/plugin.json',
      });
      const next = await nextDraft.finalize({
        pluginId: 'acme.development-generation',
        manifestRelativePath: '.happier-plugin/plugin.json',
        generatedManifestContents: '{}',
        distribution: { kind: 'localPath', canonicalPath: sourceRootPath },
        updatePolicy: 'manual',
        createdAtMs: 2,
      });

      expect(next.reference).toEqual({ immutableGenerationId: nextDraft.immutableGenerationId });
      await expect(readFile(join(prior.rootPath, 'src', 'index.ts'), 'utf8'))
        .resolves.toContain("'g'");
      await expect(readFile(join(next.rootPath, 'src', 'index.ts'), 'utf8'))
        .resolves.toContain("'h'");
      await expect(readFile(
        join(next.rootPath, 'node_modules', 'fixture-dependency', 'index.js'),
        'utf8',
      )).resolves.toContain("'retained'");

      await writeFile(
        join(next.rootPath, 'node_modules', 'fixture-dependency', 'index.js'),
        "export const dependency = 'mutated!';\n",
        'utf8',
      );
      await expect(readFile(
        join(next.rootPath, 'node_modules', 'fixture-dependency', 'index.js'),
        'utf8',
      )).resolves.toContain("'mutated!'");
      await expect(readFile(
        join(prior.rootPath, 'node_modules', 'fixture-dependency', 'index.js'),
        'utf8',
      )).resolves.toContain("'retained'");

      await writeFile(join(sourceRootPath, 'src', 'index.ts'), "export const sentinel = 'later';\n", 'utf8');
      await expect(readFile(join(prior.rootPath, 'src', 'index.ts'), 'utf8'))
        .resolves.toContain("'g'");
      await expect(readFile(join(next.rootPath, 'src', 'index.ts'), 'utf8'))
        .resolves.toContain("'h'");
      await next.cleanup();
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('admits the conservative 16,384-file ceiling above the measured 6,356-file official SDK closure and rejects +1', () => {
    const createRecord = (fileCount: number) => {
      const files = Array.from({ length: fileCount }, (_, index) => {
        const relativePath = `files/${String(index).padStart(5, '0')}.js`;
        return { relativePath, byteLength: 0 };
      });
      return {
        t: 'happier_plugin_generation_v1' as const,
        schemaVersion: 1 as const,
        pluginId: 'acme.large-official-closure',
        immutableGenerationId: 'generation-large-official-closure',
        createdAtMs: 0,
        files,
        manifestRelativePath: files[0]!.relativePath,
        sourceProvenance: 'registryCustodied' as const,
      };
    };

    const exact = ImmutablePluginGenerationRecordSchema.safeParse(createRecord(16_384));
    expect(exact.success).toBe(true);
    expect(ImmutablePluginGenerationRecordSchema.safeParse(createRecord(16_385)).success).toBe(false);
  });

  it('orders mixed-case dependency paths by the generation schema canonical ordering', async () => {
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-canonical-order-'));
    try {
      await mkdir(join(sourceRootPath, '.happier-plugin'), { recursive: true });
      await writeFile(join(sourceRootPath, '.happier-plugin', 'plugin.json'), '{}', 'utf8');
      await writeFile(join(sourceRootPath, 'agentSettings.d.ts'), 'settings', 'utf8');
      await writeFile(join(sourceRootPath, 'agents.js.map'), 'agents', 'utf8');

      const record = await createImmutablePluginGenerationRecordFromSource({
        pluginId: 'acme.canonical-order',
        sourceRootPath,
        manifestRelativePath: '.happier-plugin/plugin.json',
        distribution: { kind: 'localPath', canonicalPath: sourceRootPath },
        updatePolicy: 'manual',
        createdAtMs: 1,
      });

      expect(record.files.map((file) => file.relativePath)).toEqual([
        '.happier-plugin/plugin.json',
        'agentSettings.d.ts',
        'agents.js.map',
      ]);
    } finally {
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('persists replacement-daemon runner factory structural facts outside immutable generation bytes', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-runner-factory-record-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-runner-factory-source-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    try {
      await mkdir(join(sourceRootPath, '.happier-plugin'), { recursive: true });
      await mkdir(join(sourceRootPath, 'agent', 'runtime'), { recursive: true });
      await writeFile(
        join(sourceRootPath, '.happier-plugin', 'plugin.json'),
        '{}',
        'utf8',
      );
      const factoryBytes =
        'export function createAgentRuntime() { return { sessions: { open() {} } }; }';
      await writeFile(
        join(sourceRootPath, 'agent', 'runtime', 'factory.mjs'),
        factoryBytes,
        'utf8',
      );
      const generated = await createImmutablePluginGenerationRecordFromSource({
        pluginId: 'acme.runner-factory',
        sourceRootPath,
        manifestRelativePath: '.happier-plugin/plugin.json',
        distribution: {
          kind: 'localPath',
          canonicalPath: sourceRootPath,
        },
        updatePolicy: 'manual',
        createdAtMs: 1,
      });
      const record = {
        ...generated,
        immutableGenerationId: 'generation-runner-factory',
      };
      const prepared = await prepareImmutablePluginGeneration({
        paths,
        sourceRootPath,
        record,
      });
      const before = (await readdir(prepared.rootPath)).sort();
      const persisted =
        await persistValidatedAgentSessionRunnerFactories({
          paths,
          record,
          manifestAuthority: 'external',
          factories: [{
            localAgentId: 'agent',
            locator: {
              module: './agent/runtime/factory',
              export: 'createAgentRuntime',
              runtimeApiVersion: 1,
            },
            normalizedModulePath: 'agent/runtime/factory.mjs',
            loadMode: 'immutable-js',
          }],
        });

      expect((await readdir(prepared.rootPath)).sort()).toEqual(before);
      expect(persisted).toEqual({
        t: 'happier_agent_session_runner_factories_v1',
        schemaVersion: 1,
        pluginId: 'acme.runner-factory',
        immutableGenerationId: 'generation-runner-factory',
        manifestAuthority: 'external',
        factories: [{
          localAgentId: 'agent',
          locator: {
            module: './agent/runtime/factory',
            export: 'createAgentRuntime',
            runtimeApiVersion: 1,
          },
          normalizedModulePath: 'agent/runtime/factory.mjs',
          loadMode: 'immutable-js',
        }],
      });
      expect(
        await readValidatedAgentSessionRunnerFactories({
          paths,
          record,
        }),
      ).toEqual(persisted);
      await expect(access(join(
        paths.stateDir,
        'validated-agent-session-runner-factories',
        'generation-runner-factory.v1.json',
      ))).resolves.toBeUndefined();
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('adopts bundled structural facts into immutable daemon custody without recurring source scans', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-'));
    const packageRoot = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-package-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const packageEntryPath = join(packageRoot, 'dist', 'index.js');
    const manifestPath = join(packageRoot, 'package.json');
    const record = {
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'happier.review.fixture',
      immutableGenerationId: 'bundled-generation-a',
      createdAtMs: 0,
      manifestRelativePath: 'package.json',
      files: [
        { relativePath: 'dist/index.js', byteLength: Buffer.byteLength('export default 1') },
        { relativePath: 'package.json', byteLength: 2 },
      ],
    };
    try {
      await mkdir(join(packageRoot, 'dist'), { recursive: true });
      await writeFile(packageEntryPath, 'export default 1', 'utf8');
      await writeFile(manifestPath, '{}', 'utf8');
      const options = {
        bundledArtifacts: [{
          packageName: '@happier-dev/plugins-review-fixture',
          packageEntryRelativePath: 'dist/index.js',
          record,
        }],
        resolveBundledPackageEntry: async () => packageEntryPath,
      };
      const current = await readCurrentCommittedPluginGenerations(paths, options);
      expect(current?.generations.get(record.pluginId)).toMatchObject({
        immutableGenerationId: record.immutableGenerationId,
        rootPath: join(paths.generationsDir, record.immutableGenerationId),
      });
      await expect(readFile(join(
        paths.generationsDir,
        record.immutableGenerationId,
        'dist/index.js',
      ), 'utf8')).resolves.toBe('export default 1');
      await expect(current?.isCurrent()).resolves.toBe(true);

      await writeFile(join(packageRoot, 'dist', 'unreviewed.mjs'), 'export default 2', 'utf8');
      await writeFile(packageEntryPath, 'export default 2', 'utf8');
      await expect(current?.isCurrent()).resolves.toBe(true);
      await expect(readFile(join(
        paths.generationsDir,
        record.immutableGenerationId,
        'dist/index.js',
      ), 'utf8')).resolves.toBe('export default 1');

      await rm(manifestPath);
      // Ordinary serving currentness is desired/applied identity, not a
      // recurring package-tree verifier. A fresh read reuses the exact private
      // custody rather than making the mutable package tree authoritative.
      await expect(current?.isCurrent()).resolves.toBe(true);
      const missingManifest = await readCurrentCommittedPluginGenerations(paths, options);
      expect(missingManifest?.generations.get(record.pluginId)?.rootPath)
        .toBe(join(paths.generationsDir, record.immutableGenerationId));
      expect([...missingManifest!.unavailableBundledPackageNames]).toEqual([]);

      await writeFile(manifestPath, '{}', 'utf8');
      await rm(packageEntryPath);
      const missingEntry = await readCurrentCommittedPluginGenerations(paths, options);
      expect(missingEntry?.generations.get(record.pluginId)?.rootPath)
        .toBe(join(paths.generationsDir, record.immutableGenerationId));
      expect([...missingEntry!.unavailableBundledPackageNames]).toEqual([]);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it('admits a bundled artifact from the runtime payload beside a self-contained daemon', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-runtime-root-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'happier-daemon-runtime-root-'));
    const packageRoot = join(
      runtimeRoot,
      'node_modules',
      '@happier-dev',
      'plugins-review-runtime-root-fixture',
    );
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const packageEntryPath = join(packageRoot, 'dist', 'index.js');
    const daemonEntryPath = join(packageRoot, '.happier-plugin', 'daemon.js');
    const daemonBytes = 'export const activate = () => undefined;';
    const packageMetadataBytes = JSON.stringify({
      name: '@happier-dev/plugins-review-runtime-root-fixture',
      type: 'module',
      // The immutable artifact identifies its physical entry itself. It must
      // not depend on the package root export being resolvable by the host.
      exports: { './daemon': './.happier-plugin/daemon.js' },
    });
    const record = {
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'happier.review.runtime-root-fixture',
      immutableGenerationId: 'bundled-generation-runtime-root',
      createdAtMs: 0,
      manifestRelativePath: 'package.json',
      files: [
        { relativePath: '.happier-plugin/daemon.js', byteLength: Buffer.byteLength(daemonBytes) },
        { relativePath: 'dist/index.js', byteLength: Buffer.byteLength('export default 1') },
        { relativePath: 'package.json', byteLength: Buffer.byteLength(packageMetadataBytes) },
      ],
    };
    try {
      packagedRuntime.root = runtimeRoot;
      await mkdir(join(packageRoot, 'dist'), { recursive: true });
      await mkdir(join(packageRoot, '.happier-plugin'), { recursive: true });
      await writeFile(packageEntryPath, 'export default 1', 'utf8');
      await writeFile(daemonEntryPath, daemonBytes, 'utf8');
      await writeFile(join(packageRoot, 'package.json'), packageMetadataBytes, 'utf8');

      const current = await readCurrentCommittedPluginGenerations(paths, {
        bundledArtifacts: [{
          packageName: '@happier-dev/plugins-review-runtime-root-fixture',
          packageEntryRelativePath: 'dist/index.js',
          daemonEntryRelativePath: '.happier-plugin/daemon.js',
          record,
        }],
      });

      expect(current?.generations.get(record.pluginId)).toMatchObject({
        immutableGenerationId: record.immutableGenerationId,
        rootPath: join(paths.generationsDir, record.immutableGenerationId),
      });
      await expect(readFile(join(
        paths.generationsDir,
        record.immutableGenerationId,
        '.happier-plugin',
        'daemon.js',
      ), 'utf8')).resolves.toBe(daemonBytes);
    } finally {
      packagedRuntime.root = '';
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('rejects a runtime payload package whose manifest name does not match its bundled artifact', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-runtime-name-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'happier-daemon-runtime-name-'));
    const packageName = '@happier-dev/plugins-review-runtime-name-fixture';
    const packageRoot = join(runtimeRoot, 'node_modules', ...packageName.split('/'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const packageEntryPath = join(packageRoot, 'dist', 'index.js');
    const record = {
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'happier.review.runtime-name-fixture',
      immutableGenerationId: 'bundled-generation-runtime-name',
      createdAtMs: 0,
      manifestRelativePath: 'package.json',
      files: [
        { relativePath: 'dist/index.js', byteLength: Buffer.byteLength('export default 1') },
        { relativePath: 'package.json', byteLength: 2 },
      ],
    };
    try {
      packagedRuntime.root = runtimeRoot;
      await mkdir(join(packageRoot, 'dist'), { recursive: true });
      await writeFile(packageEntryPath, 'export default 1', 'utf8');
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-review-runtime-name-impostor',
        type: 'module',
        exports: './dist/index.js',
      }), 'utf8');

      const current = await readCurrentCommittedPluginGenerations(paths, {
        bundledArtifacts: [{
          packageName,
          packageEntryRelativePath: 'dist/index.js',
          record,
        }],
      });

      expect(current?.generations.has(record.pluginId)).toBe(false);
      expect([...current!.unavailableBundledPackageNames]).toEqual([packageName]);
    } finally {
      packagedRuntime.root = '';
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('keeps an adopted bundled daemon entry in immutable daemon custody after the mutable package tree changes', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-daemon-'));
    const packageRoot = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-daemon-package-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const packageEntryPath = join(packageRoot, 'dist', 'index.js');
    const daemonEntryPath = join(packageRoot, '.happier-plugin', 'daemon.js');
    const daemonBytes = 'export const activate = () => undefined;';
    const record = {
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'happier.review.daemon-fixture',
      immutableGenerationId: 'bundled-generation-daemon',
      createdAtMs: 0,
      manifestRelativePath: 'package.json',
      files: [
        { relativePath: '.happier-plugin/daemon.js', byteLength: Buffer.byteLength(daemonBytes) },
        { relativePath: 'dist/index.js', byteLength: Buffer.byteLength('export default 1') },
        { relativePath: 'package.json', byteLength: 2 },
      ],
    };
    const artifact = {
      packageName: '@happier-dev/plugins-review-daemon-fixture',
      packageEntryRelativePath: 'dist/index.js',
      daemonEntryRelativePath: '.happier-plugin/daemon.js',
      record,
    };
    const options = {
      bundledArtifacts: [artifact],
      resolveBundledPackageEntry: async () => packageEntryPath,
    };
    try {
      await mkdir(join(packageRoot, 'dist'), { recursive: true });
      await mkdir(join(packageRoot, '.happier-plugin'), { recursive: true });
      await writeFile(packageEntryPath, 'export default 1', 'utf8');
      await writeFile(daemonEntryPath, daemonBytes, 'utf8');
      await writeFile(join(packageRoot, 'package.json'), '{}', 'utf8');

      const admitted = await readCurrentCommittedPluginGenerations(paths, options);
      expect(admitted?.generations.get(record.pluginId)).toMatchObject({
        immutableGenerationId: record.immutableGenerationId,
        rootPath: join(paths.generationsDir, record.immutableGenerationId),
      });
      await expect(readFile(join(
        paths.generationsDir,
        record.immutableGenerationId,
        '.happier-plugin',
        'daemon.js',
      ), 'utf8')).resolves.toBe(daemonBytes);

      await rm(daemonEntryPath);
      const missingDaemon = await readCurrentCommittedPluginGenerations(paths, options);
      expect(missingDaemon?.generations.get(record.pluginId)).toMatchObject({
        immutableGenerationId: record.immutableGenerationId,
        rootPath: join(paths.generationsDir, record.immutableGenerationId),
      });
      expect([...missingDaemon!.unavailableBundledPackageNames]).toEqual([]);
      await expect(readFile(join(
        paths.generationsDir,
        record.immutableGenerationId,
        '.happier-plugin',
        'daemon.js',
      ), 'utf8')).resolves.toBe(daemonBytes);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when a fresh home has not yet adopted the published bundled daemon entry', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-daemon-fresh-'));
    const packageRoot = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-daemon-fresh-package-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const packageEntryPath = join(packageRoot, 'dist', 'index.js');
    const daemonBytes = 'export const activate = () => undefined;';
    const record = {
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'happier.review.daemon-fixture',
      immutableGenerationId: 'bundled-generation-daemon',
      createdAtMs: 0,
      manifestRelativePath: 'package.json',
      files: [
        { relativePath: '.happier-plugin/daemon.js', byteLength: Buffer.byteLength(daemonBytes) },
        { relativePath: 'dist/index.js', byteLength: Buffer.byteLength('export default 1') },
        { relativePath: 'package.json', byteLength: 2 },
      ],
    };
    try {
      await mkdir(join(packageRoot, 'dist'), { recursive: true });
      await writeFile(packageEntryPath, 'export default 1', 'utf8');
      await writeFile(join(packageRoot, 'package.json'), '{}', 'utf8');

      const missingDaemon = await readCurrentCommittedPluginGenerations(paths, {
        bundledArtifacts: [{
          packageName: '@happier-dev/plugins-review-daemon-fixture',
          packageEntryRelativePath: 'dist/index.js',
          daemonEntryRelativePath: '.happier-plugin/daemon.js',
          record,
        }],
        resolveBundledPackageEntry: async () => packageEntryPath,
      });
      expect(missingDaemon?.generations.size).toBe(0);
      expect([...missingDaemon!.unavailableBundledPackageNames])
        .toEqual(['@happier-dev/plugins-review-daemon-fixture']);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it('isolates an unavailable bundled package without discarding an unrelated admitted generation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-isolation-'));
    const packageRoot = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-valid-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await writeFile(join(packageRoot, 'dist/index.js'), 'export default 1', 'utf8');
    await writeFile(join(packageRoot, 'package.json'), '{}', 'utf8');
    const createRecord = (pluginId: string, generationId: string) => ({
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId,
      immutableGenerationId: generationId,
      createdAtMs: 0,
      manifestRelativePath: 'package.json',
      files: [
        { relativePath: 'dist/index.js', byteLength: 16 },
        { relativePath: 'package.json', byteLength: 2 },
      ],
    });

    const current = await readCurrentCommittedPluginGenerations(paths, {
      bundledArtifacts: [
        {
          packageName: '@happier-dev/plugins-valid',
          packageEntryRelativePath: 'dist/index.js',
          record: createRecord('happier.valid', 'bundled-valid'),
        },
        {
          packageName: '@happier-dev/plugins-missing',
          packageEntryRelativePath: 'dist/index.js',
          record: createRecord('happier.missing', 'bundled-missing'),
        },
      ],
      resolveBundledPackageEntry: async (packageName) => packageName.endsWith('valid')
        ? join(packageRoot, 'dist/index.js')
        : join(packageRoot, 'missing/index.js'),
    });

    expect([...current!.generations.keys()]).toEqual(['happier.valid']);
    expect([...current!.unavailableBundledPackageNames]).toEqual(['@happier-dev/plugins-missing']);
    await expect(current!.isCurrent()).resolves.toBe(true);
  });

  it('keeps exact bundled currentness independent from an unrelated installed-plugin commit change and tamper', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-unrelated-'));
    const packageRoot = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-unrelated-package-'));
    const unrelatedSourceRoot = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-unrelated-installed-'));
    try {
      const paths = resolvePluginStorePaths({ happyHomeDir });
      const bundledBytes = 'export default "bundled"';
      await mkdir(join(packageRoot, 'dist'), { recursive: true });
      await writeFile(join(packageRoot, 'dist/index.js'), bundledBytes, 'utf8');
      await writeFile(join(packageRoot, 'package.json'), '{}', 'utf8');
      const bundledRecord = {
        t: 'happier_plugin_generation_v1' as const,
        schemaVersion: 1 as const,
        pluginId: 'happier.bundled.independent',
        immutableGenerationId: 'bundled-independent-a',
        createdAtMs: 0,
        manifestRelativePath: 'package.json',
        files: [
          { relativePath: 'dist/index.js', byteLength: Buffer.byteLength(bundledBytes) },
          { relativePath: 'package.json', byteLength: 2 },
        ],
      };

      const unrelatedBytes = 'export default "installed"';
      await writeFile(join(unrelatedSourceRoot, 'daemon.mjs'), unrelatedBytes, 'utf8');
      const unrelatedRecord = {
        sourceProvenance: 'registryCustodied' as const,
        t: 'happier_plugin_generation_v1' as const,
        schemaVersion: 1 as const,
        pluginId: 'acme.plugin',
        immutableGenerationId: 'generation-unrelated',
        createdAtMs: 1,
        manifestRelativePath: 'daemon.mjs',
        files: [{
          relativePath: 'daemon.mjs',
          byteLength: Buffer.byteLength(unrelatedBytes),
        }],
      };
      const unrelated = await prepareImmutablePluginGeneration({
        paths,
        sourceRootPath: unrelatedSourceRoot,
        record: unrelatedRecord,
      });
      const initialState = await persistInstallationStateRevision({
        paths,
        state: {
          ...stateRevision(unrelatedRecord.immutableGenerationId),
          revisionId: 'state-unrelated-a',
        },
      });
      const initialCommit: PluginRegistryCommitRecord = {
        t: 'happier_plugin_registry_commit_v1',
        schemaVersion: 1,
        revision: 0,
        transactionId: 'tx-unrelated-a',
        baseRevision: null,
        installationState: initialState,
        pluginGenerations: { 'acme.plugin': unrelated.reference },
        createdAtMs: 1,
        creator: { pid: 42, instanceId: 'daemon-a' },
      };
      await mkdir(paths.stateDir, { recursive: true });
      await writeFile(
        paths.registryCurrentFilePath,
        JSON.stringify(initialCommit),
        'utf8',
      );
      await writeFile(
        join(unrelated.rootPath, 'unreviewed-payload.mjs'),
        'tampered',
        'utf8',
      );

      const emptyState = await persistInstallationStateRevision({
        paths,
        state: {
          ...stateRevision(),
          revisionId: 'state-unrelated-b',
          plugins: {},
        },
      });
      const nextCommit: PluginRegistryCommitRecord = {
        ...initialCommit,
        revision: 1,
        transactionId: 'tx-unrelated-b',
        baseRevision: 0,
        installationState: emptyState,
        pluginGenerations: {},
        createdAtMs: 2,
      };
      let changed = false;
      await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
        paths,
        pluginId: bundledRecord.pluginId,
        immutableGenerationId: bundledRecord.immutableGenerationId,
        bundledArtifacts: [{
          packageName: '@happier-dev/plugins-bundled-independent',
          packageEntryRelativePath: 'dist/index.js',
          record: bundledRecord,
        }],
        resolveBundledPackageEntry: async () => {
          if (!changed) {
            changed = true;
            await writeFile(
              paths.registryCurrentFilePath,
              JSON.stringify(nextCommit),
              'utf8',
            );
          }
          return join(packageRoot, 'dist/index.js');
        },
      })).resolves.toBe(true);
      await expect(readPreparedImmutablePluginGeneration({
        paths,
        immutableGenerationId: bundledRecord.immutableGenerationId,
      })).resolves.toMatchObject({
        record: {
          pluginId: bundledRecord.pluginId,
          immutableGenerationId: bundledRecord.immutableGenerationId,
        },
      });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(packageRoot, { recursive: true, force: true });
      await rm(unrelatedSourceRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when a known bundled plugin id also has installed authority', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-installed-collision-'));
    const bundledPackageRoot = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-collision-package-'));
    const installedSourceRoot = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-collision-installed-'));
    try {
      const paths = resolvePluginStorePaths({ happyHomeDir });
      const pluginId = 'happier.bundled.collision';
      const bundledBytes = 'export default "bundled"';
      await mkdir(join(bundledPackageRoot, 'dist'), { recursive: true });
      await writeFile(join(bundledPackageRoot, 'dist/index.js'), bundledBytes, 'utf8');
      await writeFile(join(bundledPackageRoot, 'package.json'), '{}', 'utf8');
      const bundledRecord = {
        t: 'happier_plugin_generation_v1' as const,
        schemaVersion: 1 as const,
        pluginId,
        immutableGenerationId: 'bundled-collision-b',
        createdAtMs: 0,
        manifestRelativePath: 'package.json',
        files: [
          { relativePath: 'dist/index.js', byteLength: Buffer.byteLength(bundledBytes) },
          { relativePath: 'package.json', byteLength: 2 },
        ],
      };

      const installedBytes = 'export default "installed"';
      await writeFile(join(installedSourceRoot, 'daemon.mjs'), installedBytes, 'utf8');
      const installedRecord = {
        sourceProvenance: 'registryCustodied' as const,
        t: 'happier_plugin_generation_v1' as const,
        schemaVersion: 1 as const,
        pluginId,
        immutableGenerationId: 'installed-collision-i',
        createdAtMs: 1,
        manifestRelativePath: 'daemon.mjs',
        files: [{
          relativePath: 'daemon.mjs',
          byteLength: Buffer.byteLength(installedBytes),
        }],
      };
      const installed = await prepareImmutablePluginGeneration({
        paths,
        sourceRootPath: installedSourceRoot,
        record: installedRecord,
      });
      const baseState = stateRevision(installedRecord.immutableGenerationId);
      const installedPluginState = baseState.plugins['acme.plugin']!;
      const installationState = await persistInstallationStateRevision({
        paths,
        state: {
          ...baseState,
          revisionId: 'state-bundled-installed-collision',
          plugins: {
            [pluginId]: {
              ...installedPluginState,
              trust: {
                ...installedPluginState.trust!,
                pluginId,
              },
            },
          },
        },
      });
      const commit: PluginRegistryCommitRecord = {
        t: 'happier_plugin_registry_commit_v1',
        schemaVersion: 1,
        revision: 0,
        transactionId: 'tx-bundled-installed-collision',
        baseRevision: null,
        installationState,
        pluginGenerations: { [pluginId]: installed.reference },
        createdAtMs: 1,
        creator: { pid: 42, instanceId: 'daemon-a' },
      };
      await mkdir(paths.stateDir, { recursive: true });
      await writeFile(paths.registryCurrentFilePath, JSON.stringify(commit), 'utf8');
      const bundledArtifact = {
        packageName: '@happier-dev/plugins-bundled-collision',
        packageEntryRelativePath: 'dist/index.js',
        record: bundledRecord,
      };

      // A known bundle id with a different generation must not fall through to
      // the otherwise-valid installed generation for the same plugin.
      await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
        paths,
        pluginId,
        immutableGenerationId: installedRecord.immutableGenerationId,
        bundledArtifacts: [bundledArtifact],
        resolveBundledPackageEntry: async () => join(bundledPackageRoot, 'dist/index.js'),
      })).resolves.toBe(false);

      // The installation state alone is installed authority, even if a corrupt
      // or transitional commit omits the corresponding generation reference.
      await writeFile(paths.registryCurrentFilePath, JSON.stringify({
        ...commit,
        revision: 1,
        transactionId: 'tx-bundled-state-only-collision',
        baseRevision: 0,
        pluginGenerations: {},
      }), 'utf8');
      await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
        paths,
        pluginId,
        immutableGenerationId: bundledRecord.immutableGenerationId,
        bundledArtifacts: [bundledArtifact],
        resolveBundledPackageEntry: async () => join(bundledPackageRoot, 'dist/index.js'),
      })).resolves.toBe(false);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(bundledPackageRoot, { recursive: true, force: true });
      await rm(installedSourceRoot, { recursive: true, force: true });
    }
  });

  it('keeps a retained bundled Agent generation current through bundle replacement only with its durable factory admission fact', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-retained-'));
    const generationGRoot = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-retained-g-'));
    const generationHRoot = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-retained-h-'));
    try {
      const paths = resolvePluginStorePaths({ happyHomeDir });
      const pluginId = 'happier.bundled.retained-agent';
      const createBundle = async (
        rootPath: string,
        immutableGenerationId: string,
        runtimeBytes: string,
      ) => {
        await mkdir(join(rootPath, 'dist'), { recursive: true });
        await writeFile(join(rootPath, 'dist/index.js'), runtimeBytes, 'utf8');
        await writeFile(join(rootPath, 'package.json'), '{}', 'utf8');
        const record = {
          sourceProvenance: 'localSource' as const,
          t: 'happier_plugin_generation_v1' as const,
          schemaVersion: 1 as const,
          pluginId,
          immutableGenerationId,
          createdAtMs: 0,
          manifestRelativePath: 'package.json',
          files: [
            { relativePath: 'dist/index.js', byteLength: Buffer.byteLength(runtimeBytes) },
            { relativePath: 'package.json', byteLength: 2 },
          ],
        };
        return {
          record,
          artifact: {
            packageName: `@happier-dev/plugins-${immutableGenerationId}`,
            packageEntryRelativePath: 'dist/index.js',
            record,
          },
        };
      };
      const generationG = await createBundle(
        generationGRoot,
        'bundled-retained-g',
        'export default "generation-g"',
      );
      const generationH = await createBundle(
        generationHRoot,
        'bundled-retained-h',
        'export default "generation-h"',
      );
      const resolveBundledPackageEntry = async (packageName: string) =>
        packageName.endsWith('bundled-retained-g')
          ? join(generationGRoot, 'dist/index.js')
          : join(generationHRoot, 'dist/index.js');

      await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
        paths,
        pluginId,
        immutableGenerationId: generationG.record.immutableGenerationId,
        bundledArtifacts: [generationG.artifact],
        resolveBundledPackageEntry,
      })).resolves.toBe(true);
      await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
        paths,
        pluginId,
        immutableGenerationId: generationG.record.immutableGenerationId,
        bundledArtifacts: [generationG.artifact],
        resolveBundledPackageEntry,
        retainedManifestAuthority: 'external',
      })).resolves.toBe(false);
      await persistValidatedAgentSessionRunnerFactories({
        paths,
        record: generationG.record,
        manifestAuthority: 'bundled_first_party',
        factories: [{
          localAgentId: 'fixture',
          locator: {
            module: './dist/index.js',
            export: 'createFixtureAgentRuntime',
            runtimeApiVersion: 1,
          },
          normalizedModulePath: 'dist/index.js',
          loadMode: 'immutable-js',
        }],
      });

      await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
        paths,
        pluginId,
        immutableGenerationId: generationH.record.immutableGenerationId,
        bundledArtifacts: [generationH.artifact],
        resolveBundledPackageEntry,
      })).resolves.toBe(true);
      const [preparedGenerationG, preparedGenerationH] = await Promise.all([
        readPreparedImmutablePluginGeneration({
          paths,
          immutableGenerationId: generationG.record.immutableGenerationId,
        }),
        readPreparedImmutablePluginGeneration({
          paths,
          immutableGenerationId: generationH.record.immutableGenerationId,
        }),
      ]);
      expect(preparedGenerationG.rootPath).not.toBe(preparedGenerationH.rootPath);
      await expect(readFile(join(preparedGenerationG.rootPath, 'dist/index.js'), 'utf8'))
        .resolves.toBe('export default "generation-g"');
      await expect(readFile(join(preparedGenerationH.rootPath, 'dist/index.js'), 'utf8'))
        .resolves.toBe('export default "generation-h"');

      await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
        paths,
        pluginId,
        immutableGenerationId: generationG.record.immutableGenerationId,
        bundledArtifacts: [generationH.artifact],
        resolveBundledPackageEntry,
        requiredAgentSessionRunnerFactoryLocalAgentId: 'fixture',
      })).resolves.toBe(true);
      await expect(readFile(join(preparedGenerationG.rootPath, 'dist/index.js'), 'utf8'))
        .resolves.toBe('export default "generation-g"');
      // An authenticated host-declarative ACP binding is itself the retained
      // bundled source-class proof; it does not have a custom factory fact.
      await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
        paths,
        pluginId,
        immutableGenerationId: generationG.record.immutableGenerationId,
        bundledArtifacts: [generationH.artifact],
        resolveBundledPackageEntry,
        retainedManifestAuthority: 'bundled_first_party',
      })).resolves.toBe(true);
      await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
        paths,
        pluginId,
        immutableGenerationId: generationG.record.immutableGenerationId,
        bundledArtifacts: [],
        requiredAgentSessionRunnerFactoryLocalAgentId: 'fixture',
      })).resolves.toBe(true);
      await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
        paths,
        pluginId,
        immutableGenerationId: generationG.record.immutableGenerationId,
        bundledArtifacts: [generationH.artifact],
        resolveBundledPackageEntry,
        requiredAgentSessionRunnerFactoryLocalAgentId: 'another-agent',
      })).resolves.toBe(false);

      const neverAdmittedRecord = {
        ...generationG.record,
        immutableGenerationId: 'bundled-retained-never-admitted',
      };
      await prepareImmutablePluginGeneration({
        paths,
        sourceRootPath: generationGRoot,
        record: neverAdmittedRecord,
      });
      await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
        paths,
        pluginId,
        immutableGenerationId: neverAdmittedRecord.immutableGenerationId,
        bundledArtifacts: [generationH.artifact],
        resolveBundledPackageEntry,
        requiredAgentSessionRunnerFactoryLocalAgentId: 'fixture',
      })).resolves.toBe(false);

      const externalRecord = {
        ...generationG.record,
        immutableGenerationId: 'bundled-retained-external',
      };
      await prepareImmutablePluginGeneration({
        paths,
        sourceRootPath: generationGRoot,
        record: externalRecord,
      });
      await persistValidatedAgentSessionRunnerFactories({
        paths,
        record: externalRecord,
        manifestAuthority: 'external',
        factories: [{
          localAgentId: 'fixture',
          locator: {
            module: './dist/index.js',
            export: 'createFixtureAgentRuntime',
            runtimeApiVersion: 1,
          },
          normalizedModulePath: 'dist/index.js',
          loadMode: 'immutable-js',
        }],
      });
      await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
        paths,
        pluginId,
        immutableGenerationId: externalRecord.immutableGenerationId,
        bundledArtifacts: [generationH.artifact],
        resolveBundledPackageEntry,
        requiredAgentSessionRunnerFactoryLocalAgentId: 'fixture',
      })).resolves.toBe(false);
      await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
        paths,
        pluginId,
        immutableGenerationId: externalRecord.immutableGenerationId,
        bundledArtifacts: [generationH.artifact],
        resolveBundledPackageEntry,
        retainedManifestAuthority: 'external',
      })).resolves.toBe(false);

    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(generationGRoot, { recursive: true, force: true });
      await rm(generationHRoot, { recursive: true, force: true });
    }
  });

  it('uses an external retained Agent factory admission fact to select installed-generation currentness', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-external-retained-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-external-retained-source-'));
    try {
      const paths = resolvePluginStorePaths({ happyHomeDir });
      const pluginId = 'acme.external-retained-agent';
      const immutableGenerationId = 'external-retained-generation-g';
      const factoryBytes =
        'export function createAgentRuntime() { return { sessions: { open() {} } }; }';
      await mkdir(join(sourceRootPath, 'agent', 'runtime'), { recursive: true });
      await writeFile(
        join(sourceRootPath, 'agent', 'runtime', 'factory.mjs'),
        factoryBytes,
        'utf8',
      );
      await writeFile(join(sourceRootPath, 'package.json'), '{}', 'utf8');
      const record = {
        sourceProvenance: 'registryCustodied' as const,
        t: 'happier_plugin_generation_v1' as const,
        schemaVersion: 1 as const,
        pluginId,
        immutableGenerationId,
        createdAtMs: 1,
        manifestRelativePath: 'package.json',
        files: [
          {
            relativePath: 'agent/runtime/factory.mjs',
            byteLength: Buffer.byteLength(factoryBytes),
          },
          {
            relativePath: 'package.json',
            byteLength: 2,
          },
        ],
      };
      const prepared = await prepareImmutablePluginGeneration({
        paths,
        sourceRootPath,
        record,
      });
      await persistValidatedAgentSessionRunnerFactories({
        paths,
        record,
        manifestAuthority: 'external',
        factories: [{
          localAgentId: 'fixture',
          locator: {
            module: './agent/runtime/factory',
            export: 'createAgentRuntime',
            runtimeApiVersion: 1,
          },
          normalizedModulePath: 'agent/runtime/factory.mjs',
          loadMode: 'immutable-js',
        }],
      });
      const baseState = stateRevision(immutableGenerationId);
      const installationState = await persistInstallationStateRevision({
        paths,
        state: {
          ...baseState,
          revisionId: 'state-external-retained',
          plugins: {
            [pluginId]: {
              ...baseState.plugins['acme.plugin']!,
              trust: {
                ...baseState.plugins['acme.plugin']!.trust!,
                pluginId,
              },
            },
          },
        },
      });
      const commit: PluginRegistryCommitRecord = {
        t: 'happier_plugin_registry_commit_v1',
        schemaVersion: 1,
        revision: 1,
        transactionId: 'tx-external-retained',
        baseRevision: 0,
        installationState,
        pluginGenerations: { [pluginId]: prepared.reference },
        createdAtMs: 1,
        creator: { pid: 42, instanceId: 'daemon-a' },
      };
      await mkdir(paths.stateDir, { recursive: true });
      await writeFile(
        paths.registryCurrentFilePath,
        JSON.stringify(commit),
        'utf8',
      );

      await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
        paths,
        pluginId,
        immutableGenerationId,
        bundledArtifacts: [{
          packageName: '@happier-dev/plugins-external-retained-successor',
          packageEntryRelativePath: 'dist/index.js',
          record: {
            ...record,
            immutableGenerationId: 'bundled-successor-generation-h',
          },
        }],
        requiredAgentSessionRunnerFactoryLocalAgentId: 'fixture',
      })).resolves.toBe(true);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(sourceRootPath, { recursive: true, force: true });
    }
  });

  it('reads only exact immutable generation records named by one stable current commit', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-current-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-current-source-'));
    await writeFile(join(sourceRootPath, 'daemon.mjs'), 'export default 1', 'utf8');
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const record = {
      sourceProvenance: 'registryCustodied' as const,
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'acme.plugin',
      immutableGenerationId: 'generation-current',
      createdAtMs: 1,
      manifestRelativePath: 'daemon.mjs',
      files: [{ relativePath: 'daemon.mjs', byteLength: 16 }],
    };
    const prepared = await prepareImmutablePluginGeneration({ paths, sourceRootPath, record });
    const installationState = await persistInstallationStateRevision({
      paths,
      state: stateRevision('generation-current'),
    });
    const commit: PluginRegistryCommitRecord = {
      t: 'happier_plugin_registry_commit_v1', schemaVersion: 1, revision: 0,
      transactionId: 'tx-current', baseRevision: null,
      installationState,
      pluginGenerations: { 'acme.plugin': prepared.reference },
      createdAtMs: 1,
      creator: { pid: 42, instanceId: 'daemon-a' },
    };
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.registryCurrentFilePath, JSON.stringify(commit), 'utf8');

    const current = await readCurrentCommittedPluginGenerations(paths);
    expect(current).toMatchObject({
      commit: { revision: 0, transactionId: 'tx-current' },
      generations: new Map([['acme.plugin', {
        pluginId: 'acme.plugin', immutableGenerationId: 'generation-current',
        rootPath: await realpath(join(paths.generationsDir, 'generation-current')),
        installation: {
          trust: { pluginId: 'acme.plugin', state: 'trusted' },
          source: { distribution: { kind: 'localPath', canonicalPath: '/tmp/acme-plugin' } },
        },
      }]]),
    });
    await expect(current?.isCurrent()).resolves.toBe(true);

    const unreviewedPayloadPath = join(
      paths.generationsDir,
      'generation-current',
      'unreviewed-payload.mjs',
    );
    await writeFile(unreviewedPayloadPath, 'export default 2', 'utf8');
    await expect(current?.isCurrent()).resolves.toBe(true);
    await expect(readCurrentCommittedPluginGenerations(paths)).resolves.toMatchObject({
      generations: new Map([['acme.plugin', expect.anything()]]),
    });
    await expect(current?.isCurrent()).resolves.toBe(true);

    const staleTrustState = stateRevision('generation-current');
    staleTrustState.plugins['acme.plugin']!.enabled = false;
    const staleTrustInstallationState = await persistInstallationStateRevision({
      paths,
      state: {
        ...staleTrustState,
        revisionId: 'state-stale-durable-trust',
        runtimeCatalog: {
          t: 'happier_plugin_state_v1',
          schemaVersion: 1,
          plugins: {
            'acme.plugin': {
              source: {
                kind: 'path',
                locator: '/tmp/acme-plugin',
                trustPolicy: 'untrusted',
                installPolicy: 'link',
                resolvedPath: '/tmp/acme-plugin',
                manifestPath: '/tmp/acme-plugin/.happier-plugin/plugin.json',
              },
              compatibility: { status: 'compatible', diagnostics: [] },
              install: { mode: 'link', manifestVersion: '1.0.0', updatePolicy: 'manual' },
              state: { enabled: false },
            },
          },
        },
      },
    });
    await writeFile(
      paths.registryCurrentFilePath,
      JSON.stringify({ ...commit, installationState: staleTrustInstallationState }),
      'utf8',
    );
    const staleTrustCurrent = await readCurrentCommittedPluginGenerations(paths);
    expect(staleTrustCurrent?.generations.has('acme.plugin')).toBe(false);
    await writeFile(paths.registryCurrentFilePath, JSON.stringify(commit), 'utf8');

    const observedState = stateRevision('generation-current');
    const disabledState = await persistInstallationStateRevision({
      paths,
      state: {
        ...observedState,
        revisionId: 'state-disabled',
        createdAtMs: 3,
        plugins: {
          ...observedState.plugins,
          'acme.plugin': { ...observedState.plugins['acme.plugin']!, enabled: false },
        },
      },
    });
    await writeFile(paths.registryCurrentFilePath, JSON.stringify({
      ...commit,
      revision: 1,
      transactionId: 'tx-disabled',
      baseRevision: 0,
      installationState: disabledState,
      createdAtMs: 3,
    }), 'utf8');
    await expect(current?.isCurrent()).resolves.toBe(false);
    await writeFile(paths.registryCurrentFilePath, JSON.stringify(commit), 'utf8');

    await writeFile(
      join(paths.generationsDir, 'generation-current', 'plugin-generation.v1.json'),
      JSON.stringify({ ...record, pluginId: 'acme.other' }),
      'utf8',
    );
    await expect(readCurrentCommittedPluginGenerations(paths)).rejects.toThrow(/generation|digest|identity/i);
    const isolated = await readCurrentCommittedPluginGenerations(paths, {
      isolateInvalidInstalledGenerations: true,
    });
    expect(isolated?.generations.has('acme.plugin')).toBe(false);
    expect(isolated?.rejectedGenerations.get('acme.plugin')).toMatchObject({
      pluginId: 'acme.plugin',
      immutableGenerationId: 'generation-current',
    });
    expect(isolated?.rejectedGenerations.get('acme.plugin')?.message)
      .toMatch(/generation|digest|identity/i);

    await rm(join(paths.generationsDir, 'generation-current', 'plugin-generation.v1.json'));
    await expect(readCurrentCommittedPluginGenerations(paths)).rejects.toThrow();
  });

  it('rejects a cold-start installed generation whose root was replaced by a symbolic link', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-current-symlink-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-current-symlink-source-'));
    const relocatedParent = await mkdtemp(join(tmpdir(), 'happier-generation-current-symlink-relocated-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const runtimeBytes = 'export default 1';
    await writeFile(join(sourceRootPath, 'daemon.mjs'), runtimeBytes, 'utf8');
    const record = {
      sourceProvenance: 'registryCustodied' as const,
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'acme.plugin',
      immutableGenerationId: 'generation-current',
      createdAtMs: 1,
      files: [{
        relativePath: 'daemon.mjs',
        byteLength: Buffer.byteLength(runtimeBytes),
      }],
      manifestRelativePath: 'daemon.mjs',
    };
    const prepared = await prepareImmutablePluginGeneration({ paths, sourceRootPath, record });
    const installationState = await persistInstallationStateRevision({
      paths,
      state: stateRevision(record.immutableGenerationId),
    });
    const commit: PluginRegistryCommitRecord = {
      t: 'happier_plugin_registry_commit_v1',
      schemaVersion: 1,
      revision: 0,
      transactionId: 'tx-current-symlink',
      baseRevision: null,
      installationState,
      pluginGenerations: { 'acme.plugin': prepared.reference },
      createdAtMs: 1,
      creator: { pid: 42, instanceId: 'daemon-a' },
    };
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.registryCurrentFilePath, JSON.stringify(commit), 'utf8');
    const current = await readCurrentCommittedPluginGenerations(paths);
    expect(current?.generations.has('acme.plugin')).toBe(true);

    const relocatedRoot = join(relocatedParent, record.immutableGenerationId);
    await rename(prepared.rootPath, relocatedRoot);
    await symlink(relocatedRoot, prepared.rootPath, 'dir');

    // The already-admitted lease remains current by registry identity. A
    // fresh cold read below owns structural root validation and rejects the
    // replaced root.
    await expect(current?.isCurrent()).resolves.toBe(true);
    await expect(readCurrentCommittedPluginGenerations(paths)).rejects.toThrow(/symbolic link/i);
    const isolated = await readCurrentCommittedPluginGenerations(paths, {
      isolateInvalidInstalledGenerations: true,
    });
    expect(isolated?.generations.has('acme.plugin')).toBe(false);
    expect(isolated?.rejectedGenerations.get('acme.plugin')?.message).toMatch(/symbolic link/i);
  });

  it('validates staged structure and promotes one immutable generation without a current pointer', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-store-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-source-'));
    await mkdir(join(sourceRootPath, 'dist'), { recursive: true });
    await writeFile(join(sourceRootPath, 'dist', 'daemon.mjs'), 'export default 1', 'utf8');
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const flushedDirectories: string[] = [];

    const result = await prepareImmutablePluginGeneration({
      paths,
      sourceRootPath,
      flushDirectory: async (path) => { flushedDirectories.push(path); },
      record: { sourceProvenance: 'registryCustodied',
        t: 'happier_plugin_generation_v1', schemaVersion: 1, pluginId: 'acme.plugin', immutableGenerationId: 'generation-a', createdAtMs: 1,
        files: [{ relativePath: 'dist/daemon.mjs', byteLength: 16 }],
        manifestRelativePath: 'dist/daemon.mjs',
      },
    });

    expect(result.reference.immutableGenerationId).toBe('generation-a');
    expect(flushedDirectories.some((path) => path.endsWith(join('dist')))).toBe(true);
    expect(flushedDirectories).toContain(paths.generationsDir);
    await expect(access(join(paths.generationsDir, 'generation-a', 'dist', 'daemon.mjs'))).resolves.toBeUndefined();
    await expect(access(join(paths.generationsDir, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('flushes both a new state-revision directory and its immutable-root parent', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-state-durability-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const flushedDirectories: string[] = [];

    await persistInstallationStateRevision({
      paths,
      state: stateRevision(),
      flushDirectory: async (path) => { flushedDirectories.push(path); },
    });

    expect(flushedDirectories).toEqual([
      join(paths.stateRevisionsDir, 'state-1'),
      paths.stateRevisionsDir,
    ]);
  });

  it('rejects a commit whose current generation map contains a plugin absent from installation state', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-owner-map-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-owner-map-source-'));
    await writeFile(join(sourceRootPath, 'daemon.mjs'), 'export default 1', 'utf8');
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const record = {
      sourceProvenance: 'registryCustodied' as const,
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'acme.plugin',
      immutableGenerationId: 'generation-current',
      createdAtMs: 1,
      files: [{ relativePath: 'daemon.mjs', byteLength: 16 }],
      manifestRelativePath: 'daemon.mjs',
    };
    const prepared = await prepareImmutablePluginGeneration({ paths, sourceRootPath, record });
    const state = { ...stateRevision('generation-current'), plugins: {} };
    const installationState = await persistInstallationStateRevision({ paths, state });
    const candidate: PluginRegistryCommitRecord = {
      t: 'happier_plugin_registry_commit_v1',
      schemaVersion: 1,
      revision: 1,
      transactionId: 'orphan-current-generation',
      baseRevision: 0,
      installationState,
      pluginGenerations: { 'acme.plugin': prepared.reference },
      createdAtMs: 2,
      creator: { pid: 42, instanceId: 'daemon-a' },
    };

    await expect(verifyPluginRegistryCommitGenerationReferences(paths, candidate))
      .rejects.toThrow(/generation map|installation/i);
  });

  it('rejects commit publication when available rollback bytes exist only in the retirement namespace', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-retained-publication-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const retainedGenerationId = 'generation-retained';
    const retiringRoot = join(paths.generationsDir, `.retiring-${retainedGenerationId}`);
    const retainedBytes = 'retained';
    const retainedRecord = {
      sourceProvenance: 'registryCustodied' as const,
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'acme.plugin',
      immutableGenerationId: retainedGenerationId,
      createdAtMs: 1,
      files: [{ relativePath: 'daemon.mjs', byteLength: Buffer.byteLength(retainedBytes) }],
      manifestRelativePath: 'daemon.mjs',
    };
    await mkdir(retiringRoot, { recursive: true });
    await writeFile(join(retiringRoot, 'daemon.mjs'), retainedBytes, 'utf8');
    await writeFile(join(retiringRoot, 'plugin-generation.v1.json'), JSON.stringify(retainedRecord), 'utf8');
    const base = stateRevision('generation-current');
    const state: PluginInstallationStateRevision = {
      ...base,
      rollbackRetention: [{
        pluginId: 'acme.plugin',
        immutableGenerationId: retainedGenerationId,
        retainedAtMs: 1,
        byteAvailability: 'available',
        pluginVersion: '1.0.0',
        distribution: { kind: 'localPath', canonicalPath: '/tmp/acme-plugin' },
      }],
    };
    const installationState = await persistInstallationStateRevision({ paths, state });
    const candidate: PluginRegistryCommitRecord = {
      t: 'happier_plugin_registry_commit_v1',
      schemaVersion: 1,
      revision: 1,
      transactionId: 'retained-publication',
      baseRevision: 0,
      installationState,
      pluginGenerations: {},
      createdAtMs: 2,
      creator: { pid: 42, instanceId: 'daemon-a' },
    };

    await expect(verifyPluginRegistryCommitGenerationReferences(paths, candidate))
      .rejects.toThrow(/rollback|retention|generation/i);
  });

  it('rejects commit publication when the same immutable generation is already staged for retirement', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-retiring-current-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-retiring-current-source-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const bytes = 'export default 1';
    await writeFile(join(sourceRootPath, 'daemon.mjs'), bytes, 'utf8');
    const prepared = await prepareImmutablePluginGeneration({
      paths,
      sourceRootPath,
      record: { sourceProvenance: 'registryCustodied',
        t: 'happier_plugin_generation_v1',
        schemaVersion: 1,
        pluginId: 'acme.plugin',
        immutableGenerationId: 'generation-current',
        createdAtMs: 1,
        files: [{ relativePath: 'daemon.mjs', byteLength: Buffer.byteLength(bytes) }],
        manifestRelativePath: 'daemon.mjs',
      },
    });
    await mkdir(join(paths.generationsDir, '.retiring-generation-current'));
    const state = stateRevision('generation-current');
    const installationState = await persistInstallationStateRevision({ paths, state });
    const candidate: PluginRegistryCommitRecord = {
      t: 'happier_plugin_registry_commit_v1',
      schemaVersion: 1,
      revision: 1,
      transactionId: 'retiring-current',
      baseRevision: 0,
      installationState,
      pluginGenerations: { 'acme.plugin': prepared.reference },
      createdAtMs: 2,
      creator: { pid: 42, instanceId: 'daemon-a' },
    };

    await expect(verifyPluginRegistryCommitGenerationReferences(paths, candidate))
      .rejects.toThrow(/retir/i);
    await expect(verifyPluginRegistryCommitGenerationReferences(paths, candidate, {
      allowInvalidUnchangedReferencesFrom: candidate,
    })).rejects.toThrow(/retir/i);

    await rm(join(paths.generationsDir, '.retiring-generation-current'), { recursive: true });
    const currentAndRetainedState: PluginInstallationStateRevision = {
      ...state,
      revisionId: 'state-current-and-retained',
      rollbackRetention: [{
        pluginId: 'acme.plugin',
        immutableGenerationId: 'generation-current',
        retainedAtMs: 1,
        byteAvailability: 'available',
        pluginVersion: '1.0.0',
        distribution: { kind: 'localPath', canonicalPath: '/tmp/acme-plugin' },
      }],
    };
    const currentAndRetainedReference = await persistInstallationStateRevision({ paths, state: currentAndRetainedState });
    await expect(verifyPluginRegistryCommitGenerationReferences(paths, {
      ...candidate,
      installationState: currentAndRetainedReference,
    })).rejects.toThrow(/current.*rollback|rollback.*current/i);
  });

  it('reads an installation state revision by its opaque identity without rehashing bytes', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-installation-state-reference-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const state = stateRevision();
    const statePath = join(paths.stateRevisionsDir, state.revisionId, 'plugin-installations.v1.json');
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 4), 'utf8');

    await expect(readInstallationStateRevision({
      paths,
      reference: { revisionId: state.revisionId },
    })).resolves.toEqual(state);
  });

  it('rejects corrupt staged structure and immutable state-revision substitution', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-corrupt-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-corrupt-source-'));
    await writeFile(join(sourceRootPath, 'daemon.mjs'), 'tampered', 'utf8');
    const paths = resolvePluginStorePaths({ happyHomeDir });
    await expect(prepareImmutablePluginGeneration({
      paths, sourceRootPath,
      record: { sourceProvenance: 'registryCustodied',
        t: 'happier_plugin_generation_v1', schemaVersion: 1, pluginId: 'acme.plugin', immutableGenerationId: 'generation-a', createdAtMs: 1,
        files: [{ relativePath: 'daemon.mjs', byteLength: 7 }],
        manifestRelativePath: 'daemon.mjs',
      },
    })).rejects.toThrow(/byte length/i);

    const persisted = await persistInstallationStateRevision({ paths, state: stateRevision() });
    expect(persisted).toEqual({ revisionId: 'state-1' });
    await expect(readInstallationStateRevision({ paths, reference: persisted })).resolves.toEqual(stateRevision());
    await expect(persistInstallationStateRevision({ paths, state: { ...stateRevision(), createdAtMs: 2 } })).rejects.toThrow(/immutable/i);
  });

  it('rejects an existing generation root that escapes through a symbolic link', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-symlink-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-symlink-source-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'happier-generation-symlink-outside-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const bytes = 'export default 1';
    const record = {
      sourceProvenance: 'registryCustodied' as const,
      t: 'happier_plugin_generation_v1' as const, schemaVersion: 1 as const, pluginId: 'acme.plugin', immutableGenerationId: 'generation-a', createdAtMs: 1,
      files: [{ relativePath: 'daemon.mjs', byteLength: Buffer.byteLength(bytes) }],
      manifestRelativePath: 'daemon.mjs',
    };
    await mkdir(paths.generationsDir, { recursive: true });
    await writeFile(join(outsideRoot, 'daemon.mjs'), bytes, 'utf8');
    await writeFile(join(outsideRoot, 'plugin-generation.v1.json'), JSON.stringify(record), 'utf8');
    await symlink(outsideRoot, join(paths.generationsDir, record.immutableGenerationId), 'dir');

    await expect(prepareImmutablePluginGeneration({ paths, sourceRootPath, record }))
      .rejects.toThrow(/symbolic link/i);
  });

  it('rejects an existing generation whose nested directory escapes through a symbolic link', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-nested-symlink-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-nested-symlink-source-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'happier-generation-nested-symlink-outside-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const bytes = 'export default 1';
    const record = {
      sourceProvenance: 'registryCustodied' as const,
      t: 'happier_plugin_generation_v1' as const, schemaVersion: 1 as const, pluginId: 'acme.plugin', immutableGenerationId: 'generation-a', createdAtMs: 1,
      files: [{ relativePath: 'dist/daemon.mjs', byteLength: Buffer.byteLength(bytes) }],
      manifestRelativePath: 'dist/daemon.mjs',
    };
    const generationRoot = join(paths.generationsDir, record.immutableGenerationId);
    await mkdir(generationRoot, { recursive: true });
    await writeFile(join(outsideRoot, 'daemon.mjs'), bytes, 'utf8');
    await writeFile(join(generationRoot, 'plugin-generation.v1.json'), JSON.stringify(record), 'utf8');
    await symlink(outsideRoot, join(generationRoot, 'dist'), 'dir');

    await expect(prepareImmutablePluginGeneration({ paths, sourceRootPath, record }))
      .rejects.toThrow(/symbolic link/i);
  });

  it('never removes current or retained bytes while cleaning unreferenced generations', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-cleanup-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    for (const generation of [
      'generation-current',
      'generation-lkg',
      'generation-runner',
      'generation-orphan',
    ]) {
      await mkdir(join(paths.generationsDir, generation), { recursive: true });
      await writeFile(join(paths.generationsDir, generation, 'marker'), generation, 'utf8');
    }
    const orphanBytes = 'generation-orphan';
    await writeFile(join(
      paths.generationsDir,
      'generation-orphan',
      'plugin-generation.v1.json',
    ), JSON.stringify({
      sourceProvenance: 'registryCustodied',
      t: 'happier_plugin_generation_v1',
      schemaVersion: 1,
      pluginId: 'acme.plugin',
      immutableGenerationId: 'generation-orphan',
      createdAtMs: 1,
      files: [{
        relativePath: 'marker',
        byteLength: Buffer.byteLength(orphanBytes),
      }],
      manifestRelativePath: 'marker',
    }), 'utf8');
    const state = {
      ...stateRevision('generation-current'),
      rollbackRetention: [{
        pluginId: 'acme.plugin', immutableGenerationId: 'generation-lkg', retainedAtMs: 1, byteAvailability: 'available' as const,
        pluginVersion: '1.0.0',
        distribution: { kind: 'localPath' as const, canonicalPath: '/tmp/acme-plugin' },
      }],
    };
    const stateReference = await persistInstallationStateRevision({ paths, state });
    const commit: PluginRegistryCommitRecord = {
      t: 'happier_plugin_registry_commit_v1', schemaVersion: 1, revision: 0, transactionId: 'cleanup', baseRevision: null,
      installationState: stateReference,
      pluginGenerations: { 'acme.plugin': { immutableGenerationId: 'generation-current' } },
      createdAtMs: 1, creator: { pid: 1, instanceId: 'daemon-a' },
    };

    const result = await cleanupUnreferencedPluginGenerations({
      paths,
      commit,
      state,
      runnerRetainedGenerationIds: new Set(['generation-runner']),
    });

    expect(result).toMatchObject({
      referenced: ['generation-current'],
      retained: ['generation-lkg', 'generation-runner'],
      removed: ['generation-orphan'],
    });
    await expect(access(join(paths.generationsDir, 'generation-current', 'marker'))).resolves.toBeUndefined();
    await expect(access(join(paths.generationsDir, 'generation-lkg', 'marker'))).resolves.toBeUndefined();
    await expect(access(join(paths.generationsDir, 'generation-runner', 'marker'))).resolves.toBeUndefined();
    await expect(access(join(paths.generationsDir, 'generation-orphan'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(
      paths.generationsDir,
      '.retired-generation-orphan.v1.json',
    ))).resolves.toBeUndefined();
  });

  it('removes an unreferenced development draft interrupted after its generation record became durable', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-draft-crash-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-draft-crash-source-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const generationId = 'generation-interrupted-draft';
    const sourceBytes = 'export function activate() {}\n';
    await writeFile(join(sourceRootPath, 'plugin.js'), sourceBytes, 'utf8');
    const record = await createImmutablePluginGenerationRecordFromSource({
      pluginId: 'acme.plugin',
      sourceRootPath,
      manifestRelativePath: 'plugin.js',
      distribution: { kind: 'localPath', canonicalPath: sourceRootPath },
      updatePolicy: 'manual',
      createdAtMs: 1,
      immutableGenerationId: generationId,
    });
    const generationRoot = join(paths.generationsDir, generationId);
    await mkdir(generationRoot, { recursive: true });
    await writeFile(join(generationRoot, 'plugin.js'), sourceBytes, 'utf8');
    await writeFile(join(generationRoot, 'plugin-generation.v1.json'), JSON.stringify(record), 'utf8');
    await writeFile(join(generationRoot, '.owned-development-draft.v1.json'), JSON.stringify({
      t: 'happier_owned_plugin_development_draft_v1',
      schemaVersion: 1,
      immutableGenerationId: generationId,
    }), 'utf8');
    const state = stateRevision('generation-current');
    const stateReference = await persistInstallationStateRevision({ paths, state });
    const commit: PluginRegistryCommitRecord = {
      t: 'happier_plugin_registry_commit_v1',
      schemaVersion: 1,
      revision: 0,
      transactionId: 'cleanup-interrupted-draft',
      baseRevision: null,
      installationState: stateReference,
      pluginGenerations: {
        'acme.plugin': { immutableGenerationId: 'generation-current' },
      },
      createdAtMs: 1,
      creator: { pid: 1, instanceId: 'daemon-a' },
    };

    await expect(cleanupUnreferencedPluginGenerations({
      paths,
      commit,
      state,
      runnerRetainedGenerationIds: new Set(),
    })).resolves.toMatchObject({
      removed: [generationId],
      failures: [],
    });
    await expect(access(generationRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps unauthenticated retirement pending and completes it idempotently across failure and restart', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-custody-retirement-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const orphanId = 'generation-obsolete';
    const orphanRoot = join(paths.generationsDir, orphanId);
    const orphanRecord = {
      sourceProvenance: 'registryCustodied' as const,
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'acme.plugin',
      immutableGenerationId: orphanId,
      createdAtMs: 1,
      files: [{ relativePath: 'marker', byteLength: 8 }],
      manifestRelativePath: 'marker',
    };
    await mkdir(orphanRoot, { recursive: true });
    await writeFile(join(orphanRoot, 'marker'), 'obsolete', 'utf8');
    await writeFile(join(orphanRoot, 'plugin-generation.v1.json'), JSON.stringify(orphanRecord), 'utf8');
    const state = stateRevision('generation-current');
    const stateReference = await persistInstallationStateRevision({ paths, state });
    const commit: PluginRegistryCommitRecord = {
      t: 'happier_plugin_registry_commit_v1', schemaVersion: 1, revision: 0, transactionId: 'cleanup-retirement', baseRevision: null,
      installationState: stateReference,
      pluginGenerations: { 'acme.plugin': { immutableGenerationId: 'generation-current' } },
      createdAtMs: 1, creator: { pid: 1, instanceId: 'daemon-a' },
    };
    const retireGeneration = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce(undefined);
    const flushDirectory = vi.fn(async () => undefined);
    const commitFenceEntered = vi.fn();
    const unauthenticated = await reconcilePluginGenerationCustodyRetirement({
      paths,
      commit,
      isCommitCurrent: async () => true,
      withCommitFence: async <T>(operation: () => Promise<T>) => {
        commitFenceEntered();
        return await operation();
      },
      readCredentials: async () => null,
      flushDirectory,
      retireGeneration,
    });

    expect(unauthenticated).toEqual({ status: 'authentication-unavailable' });
    expect(retireGeneration).not.toHaveBeenCalled();
    await expect(access(orphanRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(paths.generationsDir, `.retiring-${orphanId}`, 'marker'))).resolves.toBeUndefined();

    const reconcileAfterRestart = () => reconcilePluginGenerationCustodyRetirement({
      paths,
      commit,
      isCommitCurrent: async () => true,
      withCommitFence: async <T>(operation: () => Promise<T>) => {
        commitFenceEntered();
        return await operation();
      },
      readCredentials: async () => ({
        token: 'account-token',
        encryption: null,
      }),
      flushDirectory,
      retireGeneration,
    });

    const first = await reconcileAfterRestart();
    expect(first).toMatchObject({ status: 'reconciled', removed: [], failures: [{ generationId: orphanId, message: 'response lost' }] });
    expect(flushDirectory).toHaveBeenCalledWith(paths.generationsDir);
    expect(flushDirectory.mock.invocationCallOrder[0]).toBeLessThan(retireGeneration.mock.invocationCallOrder[0]!);
    await expect(access(orphanRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(paths.generationsDir, `.retiring-${orphanId}`, 'marker'))).resolves.toBeUndefined();
    await expect(access(join(paths.generationsDir, `.retired-${orphanId}.v1.json`)))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const second = await reconcileAfterRestart();
    expect(second).toMatchObject({ status: 'reconciled', removed: [orphanId], failures: [] });
    expect(retireGeneration).toHaveBeenNthCalledWith(1, { token: 'account-token', pluginId: 'acme.plugin', immutableGenerationId: orphanId });
    expect(retireGeneration).toHaveBeenNthCalledWith(2, { token: 'account-token', pluginId: 'acme.plugin', immutableGenerationId: orphanId });
    expect(commitFenceEntered).toHaveBeenCalledTimes(3);
    await expect(access(orphanRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(paths.generationsDir, `.retiring-${orphanId}`))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(paths.generationsDir, `.retired-${orphanId}.v1.json`)))
      .resolves.toBeUndefined();

    // Simulate a replacement daemon observing an exact old root reintroduced
    // after completed retirement. Current installed authority alone must not
    // allow that identity to become current again.
    await mkdir(orphanRoot, { recursive: true });
    await writeFile(join(orphanRoot, 'marker'), 'obsolete', 'utf8');
    await writeFile(join(orphanRoot, 'plugin-generation.v1.json'), JSON.stringify(orphanRecord), 'utf8');
    await mkdir(paths.stateDir, { recursive: true });
    const reintroducedCurrentCommit: PluginRegistryCommitRecord = {
      ...commit,
      revision: 1,
      transactionId: 'cleanup-retirement-reintroduced-current',
      baseRevision: 0,
      pluginGenerations: {
        'acme.plugin': { immutableGenerationId: orphanId },
      },
    };
    await writeFile(
      paths.registryCurrentFilePath,
      JSON.stringify(reintroducedCurrentCommit),
      'utf8',
    );
    await expect(readCurrentPluginImmutableGenerationIntegrityCurrentness({
      paths,
      pluginId: orphanRecord.pluginId,
      immutableGenerationId: orphanId,
    })).resolves.toBe(false);
    const reintroduced = await reconcileAfterRestart();
    expect(reintroduced).toMatchObject({
      status: 'reconciled',
      removed: [orphanId],
      failures: [],
    });
    expect(retireGeneration).toHaveBeenCalledTimes(2);
    await expect(access(orphanRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(paths.generationsDir, `.retired-${orphanId}.v1.json`)))
      .resolves.toBeUndefined();

    const reinstallSourceRoot = await mkdtemp(join(tmpdir(), 'happier-generation-retired-reinstall-'));
    await writeFile(join(reinstallSourceRoot, 'marker'), 'obsolete', 'utf8');
    await expect(prepareImmutablePluginGeneration({
      paths,
      sourceRootPath: reinstallSourceRoot,
      record: orphanRecord,
    })).rejects.toThrow(/retir/i);
    await expect(prepareImmutablePluginGeneration({
      paths,
      sourceRootPath: reinstallSourceRoot,
      record: { ...orphanRecord, immutableGenerationId: 'generation-reinstalled' },
    })).resolves.toMatchObject({
      reference: { immutableGenerationId: 'generation-reinstalled' },
    });
  });

  it('fails closed when a completed-retirement marker belongs to another plugin', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-retirement-marker-mismatch-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const immutableGenerationId = 'generation-marker-plugin-mismatch';
    const generationRoot = join(paths.generationsDir, immutableGenerationId);
    const record = {
      sourceProvenance: 'registryCustodied' as const,
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'acme.plugin',
      immutableGenerationId,
      createdAtMs: 1,
      files: [{ relativePath: 'marker', byteLength: 8 }],
      manifestRelativePath: 'marker',
    };
    await mkdir(generationRoot, { recursive: true });
    await writeFile(join(generationRoot, 'marker'), 'obsolete', 'utf8');
    await writeFile(
      join(generationRoot, 'plugin-generation.v1.json'),
      JSON.stringify(record),
      'utf8',
    );
    await persistValidatedAgentSessionRunnerFactories({
      paths,
      record,
      manifestAuthority: 'external',
      factories: [],
    });
    const markerPath = join(
      paths.generationsDir,
      `.retired-${immutableGenerationId}.v1.json`,
    );
    const factoryPath = join(
      paths.stateDir,
      'validated-agent-session-runner-factories',
      `${immutableGenerationId}.v1.json`,
    );
    await writeFile(markerPath, JSON.stringify({
      t: 'happier_retired_plugin_generation_v1',
      schemaVersion: 1,
      pluginId: 'other.plugin',
      immutableGenerationId,
    }), 'utf8');
    const state = stateRevision('generation-current');
    const installationState = await persistInstallationStateRevision({ paths, state });
    const commit: PluginRegistryCommitRecord = {
      t: 'happier_plugin_registry_commit_v1',
      schemaVersion: 1,
      revision: 0,
      transactionId: 'marker-plugin-mismatch',
      baseRevision: null,
      installationState,
      pluginGenerations: { 'acme.plugin': { immutableGenerationId: 'generation-current' } },
      createdAtMs: 1,
      creator: { pid: 1, instanceId: 'daemon-a' },
    };
    const retireGeneration = vi.fn();

    await expect(cleanupUnreferencedPluginGenerations({
      paths,
      commit,
      state,
      runnerRetainedGenerationIds: new Set(),
      retireGeneration,
    })).resolves.toMatchObject({
      removed: [],
      failures: [{
        generationId: immutableGenerationId,
        message: expect.stringMatching(/marker.*identity|identity.*marker/i),
      }],
    });
    expect(retireGeneration).not.toHaveBeenCalled();
    await expect(access(generationRoot)).resolves.toBeUndefined();
    await expect(access(factoryPath)).resolves.toBeUndefined();
    await expect(access(markerPath)).resolves.toBeUndefined();
  });

  it('rejects retirement when the exact durable commit changed and preserves the candidate bytes', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-custody-stale-commit-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const orphanId = 'generation-obsolete';
    const orphanRoot = join(paths.generationsDir, orphanId);
    const orphanBytes = 'obsolete';
    const orphanRecord = {
      sourceProvenance: 'registryCustodied' as const,
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'acme.plugin',
      immutableGenerationId: orphanId,
      createdAtMs: 1,
      files: [{ relativePath: 'marker', byteLength: Buffer.byteLength(orphanBytes) }],
      manifestRelativePath: 'marker',
    };
    await mkdir(orphanRoot, { recursive: true });
    await writeFile(join(orphanRoot, 'marker'), orphanBytes, 'utf8');
    await writeFile(join(orphanRoot, 'plugin-generation.v1.json'), JSON.stringify(orphanRecord), 'utf8');
    const stateReference = await persistInstallationStateRevision({ paths, state: stateRevision('generation-current') });
    const staleCommit: PluginRegistryCommitRecord = {
      t: 'happier_plugin_registry_commit_v1', schemaVersion: 1, revision: 0, transactionId: 'cleanup-stale', baseRevision: null,
      installationState: stateReference,
      pluginGenerations: { 'acme.plugin': { immutableGenerationId: 'generation-current' } },
      createdAtMs: 1, creator: { pid: 1, instanceId: 'daemon-a' },
    };
    const currentCommit: PluginRegistryCommitRecord = {
      ...staleCommit,
      revision: 1,
      transactionId: 'newer-health-only-commit',
      baseRevision: 0,
      createdAtMs: 2,
    };
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.registryCurrentFilePath, JSON.stringify(currentCommit), 'utf8');
    const readCredentials = vi.fn(async () => ({
      token: 'account-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
    }));
    const retireGeneration = vi.fn(async () => undefined);

    const result = await reconcilePluginGenerationCustodyRetirement({
      paths,
      commit: staleCommit,
      readCredentials,
      retireGeneration,
    });

    expect(result).toMatchObject({
      status: 'reconciled',
      removed: [],
      failures: [{ generationId: orphanId, message: expect.stringMatching(/commit changed/iu) }],
    });
    expect(readCredentials).not.toHaveBeenCalled();
    expect(retireGeneration).not.toHaveBeenCalled();
    await expect(readFile(join(orphanRoot, 'marker'), 'utf8')).resolves.toBe(orphanBytes);
    await expect(readFile(paths.registryCurrentFilePath, 'utf8')).resolves.toBe(JSON.stringify(currentCommit));
  });

  it('fails cleanup closed on a partial current record before deleting any generation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-cleanup-partial-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    await mkdir(join(paths.generationsDir, 'generation-live'), { recursive: true });
    await writeFile(join(paths.generationsDir, 'generation-live', 'marker'), 'live', 'utf8');

    await expect(cleanupUnreferencedPluginGenerations({
      paths,
      commit: { pluginGenerations: {} } as unknown as PluginRegistryCommitRecord,
      state: stateRevision(),
    })).rejects.toThrow();
    await expect(access(join(paths.generationsDir, 'generation-live', 'marker'))).resolves.toBeUndefined();
  });

  it('fails cleanup closed when the supplied state is not the exact revision referenced by current', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-cleanup-state-mismatch-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    await mkdir(join(paths.generationsDir, 'generation-live'), { recursive: true });
    await writeFile(join(paths.generationsDir, 'generation-live', 'marker'), 'live', 'utf8');
    const authoritativeState = {
      ...stateRevision('generation-current'),
      rollbackRetention: [{
        pluginId: 'acme.plugin', immutableGenerationId: 'generation-live', retainedAtMs: 1,
        byteAvailability: 'available' as const,
        pluginVersion: '1.0.0', distribution: { kind: 'localPath' as const, canonicalPath: '/tmp/acme-plugin' },
      }],
    };
    const authoritativeReference = await persistInstallationStateRevision({ paths, state: authoritativeState });
    const commit: PluginRegistryCommitRecord = {
      t: 'happier_plugin_registry_commit_v1', schemaVersion: 1, revision: 0, transactionId: 'cleanup', baseRevision: null,
      installationState: authoritativeReference,
      pluginGenerations: { 'acme.plugin': { immutableGenerationId: 'generation-current' } },
      createdAtMs: 1, creator: { pid: 1, instanceId: 'daemon-a' },
    };
    const unrelatedState = { ...stateRevision('generation-current'), revisionId: 'state-unrelated' };

    await expect(cleanupUnreferencedPluginGenerations({ paths, commit, state: unrelatedState }))
      .rejects.toThrow(/installation state revision/i);
    await expect(access(join(paths.generationsDir, 'generation-live', 'marker'))).resolves.toBeUndefined();
  });

  it('rejects unbounded duplicate rollback retention roles for one plugin', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-retention-bounds-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const base = stateRevision('generation-current');
    const retainedGenerationIds = ['generation-lkg-a', 'generation-lkg-b'];
    const state: PluginInstallationStateRevision = {
      ...base,
      rollbackRetention: retainedGenerationIds.map((immutableGenerationId) => ({
        pluginId: 'acme.plugin', immutableGenerationId, retainedAtMs: 1,
        byteAvailability: 'available' as const, pluginVersion: '1.0.0',
        distribution: { kind: 'localPath' as const, canonicalPath: '/tmp/acme-plugin' },
      })),
    };

    await expect(persistInstallationStateRevision({ paths, state })).rejects.toThrow(/bounded rollback retention/i);
  });

});
