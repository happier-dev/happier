import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../configuration', () => ({ configuration: { happyHomeDir: join(tmpdir(), 'unused-registry-home') } }));

import { resolvePluginStorePaths } from '../paths';
import { createPendingGenerationHealthRecord } from './healthPolicy';
import {
  cleanupUnreferencedPluginGenerations,
  computePluginGenerationFingerprint,
  createImmutablePluginGenerationRecordFromSource,
  ImmutablePluginGenerationRecordSchema,
  persistInstallationStateRevision,
  prepareImmutablePluginGeneration,
  readCurrentCommittedPluginGenerations,
  readInstallationStateRevision,
  verifyPluginRegistryCommitGenerationReferences,
  type PluginInstallationStateRevision,
} from './generationStore';
import type { PluginRegistryCommitRecord } from './commitRecord';
import { reconcilePluginGenerationCustodyRetirement } from './generationCustodyRetirement';

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}` as const;

function stateRevision(
  generationId = 'generation-a',
  admittedIntegrity: `sha256:${string}` = digest('source'),
): PluginInstallationStateRevision {
  return {
    t: 'happier_plugin_installations_v1', schemaVersion: 1, revisionId: 'state-1', createdAtMs: 1,
    plugins: {
      'acme.plugin': {
        enabled: true,
        trust: { pluginId: 'acme.plugin', distribution: { kind: 'localPath', canonicalPath: '/tmp/acme-plugin' }, state: 'trusted', approvedAtMs: 1 },
        source: { distribution: { kind: 'localPath', canonicalPath: '/tmp/acme-plugin' }, admittedIntegrity },
        updatePolicy: 'manual',
        optionalAccess: [],
      },
    },
    health: {
      [generationId]: createPendingGenerationHealthRecord({ pluginId: 'acme.plugin', immutableGenerationId: generationId, fingerprint: digest(generationId) }),
    },
    rollbackRetention: [],
    healthTombstones: [],
  };
}

describe('immutable plugin generation store', () => {
  it('admits the conservative 16,384-file ceiling above the measured 6,356-file official SDK closure and rejects +1', () => {
    const createRecord = (fileCount: number) => {
      const files = Array.from({ length: fileCount }, (_, index) => {
        const relativePath = `files/${String(index).padStart(5, '0')}.js`;
        return { relativePath, byteLength: 0, digest: digest(relativePath) };
      });
      return {
        t: 'happier_plugin_generation_v1' as const,
        schemaVersion: 1 as const,
        pluginId: 'acme.large-official-closure',
        immutableGenerationId: 'generation-large-official-closure',
        fingerprint: digest('fingerprint'),
        packageDigest: digest('package'),
        manifestDigest: files[0]!.digest,
        runtimeDigest: digest('runtime'),
        installedUiArtifactDigest: digest('ui'),
        createdAtMs: 0,
        files,
        installedArtifactRecord: { relativePath: files[0]!.relativePath, digest: files[0]!.digest },
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

  it('admits generated bundled inventories through the same generation reader and stales on byte replacement', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-'));
    const packageRoot = await mkdtemp(join(tmpdir(), 'happier-generation-bundled-package-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await mkdir(join(packageRoot, 'resources'), { recursive: true });
    const runtimeBytes = 'export default 1';
    const promptBytes = 'immutable prompt';
    await writeFile(join(packageRoot, 'dist/index.js'), runtimeBytes, 'utf8');
    await writeFile(join(packageRoot, 'resources/prompt.md'), promptBytes, 'utf8');
    await writeFile(join(packageRoot, 'package.json'), '{}', 'utf8');
    const record = {
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'happier.review.fixture',
      immutableGenerationId: 'bundled-generation-a',
      fingerprint: digest('fingerprint'),
      packageDigest: digest('package'),
      manifestDigest: digest('manifest'),
      runtimeDigest: digest(runtimeBytes),
      installedUiArtifactDigest: digest(''),
      createdAtMs: 0,
      files: [
        { relativePath: 'dist/index.js', byteLength: Buffer.byteLength(runtimeBytes), digest: digest(runtimeBytes) },
        { relativePath: 'package.json', byteLength: 2, digest: digest('{}') },
        { relativePath: 'resources/prompt.md', byteLength: Buffer.byteLength(promptBytes), digest: digest(promptBytes) },
      ],
      installedArtifactRecord: { relativePath: 'package.json', digest: digest('{}') },
    };
    const current = await readCurrentCommittedPluginGenerations(paths, {
      bundledArtifacts: [{ packageName: '@happier-dev/plugins-review-fixture', packageEntryRelativePath: 'dist/index.js', record }],
      resolveBundledPackageEntry: async () => join(packageRoot, 'dist/index.js'),
    });
    expect(current?.generations.get('happier.review.fixture')).toMatchObject({
      immutableGenerationId: 'bundled-generation-a',
      rootPath: await realpath(packageRoot),
      record: { manifestDigest: digest('manifest') },
    });
    await expect(current?.isCurrent()).resolves.toBe(true);

    await writeFile(join(packageRoot, 'dist/unreviewed.mjs'), 'export default 2', 'utf8');
    await expect(current?.isCurrent()).resolves.toBe(false);
    const unexpected = await readCurrentCommittedPluginGenerations(paths, {
      bundledArtifacts: [{ packageName: '@happier-dev/plugins-review-fixture', packageEntryRelativePath: 'dist/index.js', record }],
      resolveBundledPackageEntry: async () => join(packageRoot, 'dist/index.js'),
    });
    expect(unexpected?.generations.size).toBe(0);
    expect([...unexpected!.unavailableBundledPackageNames]).toEqual(['@happier-dev/plugins-review-fixture']);
    await rm(join(packageRoot, 'dist/unreviewed.mjs'));
    await expect(current?.isCurrent()).resolves.toBe(true);

    await writeFile(join(packageRoot, 'resources/prompt.md'), 'replacement bytes', 'utf8');
    await expect(current?.isCurrent()).resolves.toBe(false);

    await rm(join(packageRoot, 'resources/prompt.md'));
    const missing = await readCurrentCommittedPluginGenerations(paths, {
      bundledArtifacts: [{ packageName: '@happier-dev/plugins-review-fixture', packageEntryRelativePath: 'dist/index.js', record }],
      resolveBundledPackageEntry: async () => join(packageRoot, 'dist/index.js'),
    });
    expect(missing?.generations.size).toBe(0);
    expect([...missing!.unavailableBundledPackageNames]).toEqual(['@happier-dev/plugins-review-fixture']);

    const outsidePrompt = join(await mkdtemp(join(tmpdir(), 'happier-generation-bundled-outside-')), 'prompt.md');
    await writeFile(outsidePrompt, promptBytes, 'utf8');
    await symlink(outsidePrompt, join(packageRoot, 'resources/prompt.md'));
    const symbolic = await readCurrentCommittedPluginGenerations(paths, {
      bundledArtifacts: [{ packageName: '@happier-dev/plugins-review-fixture', packageEntryRelativePath: 'dist/index.js', record }],
      resolveBundledPackageEntry: async () => join(packageRoot, 'dist/index.js'),
    });
    expect(symbolic?.generations.size).toBe(0);
    expect([...symbolic!.unavailableBundledPackageNames]).toEqual(['@happier-dev/plugins-review-fixture']);

    await rm(join(packageRoot, 'resources/prompt.md'));
    await writeFile(join(packageRoot, 'resources/prompt.md'), promptBytes, 'utf8');
    const relocatedPackageRoot = `${packageRoot}-relocated`;
    await rename(packageRoot, relocatedPackageRoot);
    await symlink(relocatedPackageRoot, packageRoot, 'dir');
    const symbolicRoot = await readCurrentCommittedPluginGenerations(paths, {
      bundledArtifacts: [{ packageName: '@happier-dev/plugins-review-fixture', packageEntryRelativePath: 'dist/index.js', record }],
      resolveBundledPackageEntry: async () => join(packageRoot, 'dist/index.js'),
    });
    expect(symbolicRoot?.generations.size).toBe(0);
    expect([...symbolicRoot!.unavailableBundledPackageNames]).toEqual(['@happier-dev/plugins-review-fixture']);
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
      fingerprint: digest(`${generationId}:fingerprint`),
      packageDigest: digest(`${generationId}:package`),
      manifestDigest: digest(`${generationId}:manifest`),
      runtimeDigest: digest('export default 1'),
      installedUiArtifactDigest: digest(''),
      createdAtMs: 0,
      files: [
        { relativePath: 'dist/index.js', byteLength: 16, digest: digest('export default 1') },
        { relativePath: 'package.json', byteLength: 2, digest: digest('{}') },
      ],
      installedArtifactRecord: { relativePath: 'package.json', digest: digest('{}') },
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

  it('reads only exact immutable generation records named by one stable current commit', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-current-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-current-source-'));
    await writeFile(join(sourceRootPath, 'daemon.mjs'), 'export default 1', 'utf8');
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const record = {
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'acme.plugin',
      immutableGenerationId: 'generation-current',
      fingerprint: digest('fingerprint'),
      packageDigest: digest('package'),
      manifestDigest: digest('manifest'),
      runtimeDigest: digest('runtime'),
      installedUiArtifactDigest: digest('ui'),
      createdAtMs: 1,
      files: [{ relativePath: 'daemon.mjs', byteLength: 16, digest: digest('export default 1') }],
      installedArtifactRecord: { relativePath: 'daemon.mjs', digest: digest('export default 1') },
    };
    const prepared = await prepareImmutablePluginGeneration({ paths, sourceRootPath, record });
    const installationState = await persistInstallationStateRevision({
      paths,
      state: stateRevision('generation-current', record.packageDigest),
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
          source: { admittedIntegrity: record.packageDigest },
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
    await expect(current?.isCurrent()).resolves.toBe(false);
    await expect(readCurrentCommittedPluginGenerations(paths)).rejects.toThrow(/inventory|unexpected/i);
    const isolatedUnexpectedPayload = await readCurrentCommittedPluginGenerations(paths, {
      isolateInvalidInstalledGenerations: true,
    });
    expect(isolatedUnexpectedPayload?.generations.has('acme.plugin')).toBe(false);
    expect(isolatedUnexpectedPayload?.rejectedGenerations.get('acme.plugin')?.message)
      .toMatch(/inventory|unexpected/i);
    await rm(unreviewedPayloadPath);
    await expect(current?.isCurrent()).resolves.toBe(true);

    const staleTrustState = stateRevision('generation-current', record.packageDigest);
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

    const mismatchedInstallationState = await persistInstallationStateRevision({
      paths,
      state: { ...stateRevision('generation-current'), revisionId: 'state-mismatched' },
    });
    await writeFile(paths.registryCurrentFilePath, JSON.stringify({ ...commit, installationState: mismatchedInstallationState }), 'utf8');
    await expect(readCurrentCommittedPluginGenerations(paths)).rejects.toThrow(/integrity/i);
    const isolatedMismatchedAuthority = await readCurrentCommittedPluginGenerations(paths, {
      isolateInvalidInstalledGenerations: true,
    });
    expect(isolatedMismatchedAuthority?.rejectedGenerations.get('acme.plugin')?.message)
      .toMatch(/integrity/i);
    await writeFile(paths.registryCurrentFilePath, JSON.stringify({
      ...commit,
      installationState: {
        ...mismatchedInstallationState,
        digest: `sha256:${'0'.repeat(64)}`,
      },
    }), 'utf8');
    await expect(readCurrentCommittedPluginGenerations(paths, {
      isolateInvalidInstalledGenerations: true,
    })).rejects.toThrow(/digest/i);
    await writeFile(paths.registryCurrentFilePath, JSON.stringify(commit), 'utf8');

    const observedState = stateRevision('generation-current', record.packageDigest);
    const observedInstallationState = await persistInstallationStateRevision({
      paths,
      state: {
        ...observedState,
        revisionId: 'state-health-observed',
        createdAtMs: 2,
        health: {
          ...observedState.health,
          'generation-current': {
            ...observedState.health['generation-current']!,
            observation: { daemonInstanceId: 'daemon-a', startedAtUptimeMs: 1 },
          },
        },
      },
    });
    const healthOnlyCommit: PluginRegistryCommitRecord = {
      ...commit,
      revision: 1,
      transactionId: 'tx-health-observed',
      baseRevision: 0,
      installationState: observedInstallationState,
      createdAtMs: 2,
    };
    await writeFile(paths.registryCurrentFilePath, JSON.stringify(healthOnlyCommit), 'utf8');
    await expect(current?.isCurrent()).resolves.toBe(true);

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
      ...healthOnlyCommit,
      revision: 2,
      transactionId: 'tx-disabled',
      baseRevision: 1,
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
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'acme.plugin',
      immutableGenerationId: 'generation-current',
      fingerprint: digest('fingerprint'),
      packageDigest: digest('package'),
      manifestDigest: digest('manifest'),
      runtimeDigest: digest('runtime'),
      installedUiArtifactDigest: digest('ui'),
      createdAtMs: 1,
      files: [{
        relativePath: 'daemon.mjs',
        byteLength: Buffer.byteLength(runtimeBytes),
        digest: digest(runtimeBytes),
      }],
      installedArtifactRecord: { relativePath: 'daemon.mjs', digest: digest(runtimeBytes) },
    };
    const prepared = await prepareImmutablePluginGeneration({ paths, sourceRootPath, record });
    const installationState = await persistInstallationStateRevision({
      paths,
      state: stateRevision(record.immutableGenerationId, record.packageDigest),
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

    await expect(current?.isCurrent()).resolves.toBe(false);
    await expect(readCurrentCommittedPluginGenerations(paths)).rejects.toThrow(/symbolic link/i);
    const isolated = await readCurrentCommittedPluginGenerations(paths, {
      isolateInvalidInstalledGenerations: true,
    });
    expect(isolated?.generations.has('acme.plugin')).toBe(false);
    expect(isolated?.rejectedGenerations.get('acme.plugin')?.message).toMatch(/symbolic link/i);
  });

  it('verifies staged bytes and promotes one immutable generation without a current pointer', async () => {
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
      record: {
        t: 'happier_plugin_generation_v1', schemaVersion: 1, pluginId: 'acme.plugin', immutableGenerationId: 'generation-a',
        fingerprint: digest('fingerprint'), packageDigest: digest('package'), manifestDigest: digest('manifest'),
        runtimeDigest: digest('runtime'), installedUiArtifactDigest: digest('ui'), createdAtMs: 1,
        files: [{ relativePath: 'dist/daemon.mjs', byteLength: 16, digest: digest('export default 1') }],
        installedArtifactRecord: { relativePath: 'dist/daemon.mjs', digest: digest('export default 1') },
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
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'acme.plugin',
      immutableGenerationId: 'generation-current',
      fingerprint: digest('fingerprint'),
      packageDigest: digest('package'),
      manifestDigest: digest('manifest'),
      runtimeDigest: digest('runtime'),
      installedUiArtifactDigest: digest('ui'),
      createdAtMs: 1,
      files: [{ relativePath: 'daemon.mjs', byteLength: 16, digest: digest('export default 1') }],
      installedArtifactRecord: { relativePath: 'daemon.mjs', digest: digest('export default 1') },
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
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'acme.plugin',
      immutableGenerationId: retainedGenerationId,
      fingerprint: digest('retained-fingerprint'),
      packageDigest: digest('retained-package'),
      manifestDigest: digest('retained-manifest'),
      runtimeDigest: digest('retained-runtime'),
      installedUiArtifactDigest: digest('retained-ui'),
      createdAtMs: 1,
      files: [{ relativePath: 'daemon.mjs', byteLength: Buffer.byteLength(retainedBytes), digest: digest(retainedBytes) }],
      installedArtifactRecord: { relativePath: 'daemon.mjs', digest: digest(retainedBytes) },
    };
    await mkdir(retiringRoot, { recursive: true });
    await writeFile(join(retiringRoot, 'daemon.mjs'), retainedBytes, 'utf8');
    await writeFile(join(retiringRoot, 'plugin-generation.v1.json'), JSON.stringify(retainedRecord), 'utf8');
    const base = stateRevision('generation-current');
    const state: PluginInstallationStateRevision = {
      ...base,
      health: {
        ...base.health,
        [retainedGenerationId]: createPendingGenerationHealthRecord({
          pluginId: 'acme.plugin',
          immutableGenerationId: retainedGenerationId,
          fingerprint: digest(retainedGenerationId),
        }),
      },
      rollbackRetention: [{
        pluginId: 'acme.plugin',
        immutableGenerationId: retainedGenerationId,
        healthGenerationId: retainedGenerationId,
        role: 'lastKnownGood',
        automaticRecoveryEligible: true,
        retainedAtMs: 1,
        byteAvailability: 'available',
        packageDigest: retainedRecord.packageDigest,
        artifactDigest: retainedRecord.installedArtifactRecord.digest,
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
      record: {
        t: 'happier_plugin_generation_v1',
        schemaVersion: 1,
        pluginId: 'acme.plugin',
        immutableGenerationId: 'generation-current',
        fingerprint: digest('fingerprint'),
        packageDigest: digest('package'),
        manifestDigest: digest('manifest'),
        runtimeDigest: digest('runtime'),
        installedUiArtifactDigest: digest('ui'),
        createdAtMs: 1,
        files: [{ relativePath: 'daemon.mjs', byteLength: Buffer.byteLength(bytes), digest: digest(bytes) }],
        installedArtifactRecord: { relativePath: 'daemon.mjs', digest: digest(bytes) },
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

    await rm(join(paths.generationsDir, '.retiring-generation-current'), { recursive: true });
    const currentAndRetainedState: PluginInstallationStateRevision = {
      ...state,
      revisionId: 'state-current-and-retained',
      rollbackRetention: [{
        pluginId: 'acme.plugin',
        immutableGenerationId: 'generation-current',
        healthGenerationId: 'generation-current',
        role: 'lastKnownGood',
        automaticRecoveryEligible: true,
        retainedAtMs: 1,
        byteAvailability: 'available',
        packageDigest: digest('package'),
        artifactDigest: digest(bytes),
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

  it('rejects corrupt staged bytes and immutable state-revision substitution', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-corrupt-'));
    const sourceRootPath = await mkdtemp(join(tmpdir(), 'happier-generation-corrupt-source-'));
    await writeFile(join(sourceRootPath, 'daemon.mjs'), 'tampered', 'utf8');
    const paths = resolvePluginStorePaths({ happyHomeDir });
    await expect(prepareImmutablePluginGeneration({
      paths, sourceRootPath,
      record: {
        t: 'happier_plugin_generation_v1', schemaVersion: 1, pluginId: 'acme.plugin', immutableGenerationId: 'generation-a',
        fingerprint: digest('fingerprint'), packageDigest: digest('package'), manifestDigest: digest('manifest'),
        runtimeDigest: digest('runtime'), installedUiArtifactDigest: digest('ui'), createdAtMs: 1,
        files: [{ relativePath: 'daemon.mjs', byteLength: 8, digest: digest('expected') }],
        installedArtifactRecord: { relativePath: 'daemon.mjs', digest: digest('expected') },
      },
    })).rejects.toThrow(/digest/i);

    const persisted = await persistInstallationStateRevision({ paths, state: stateRevision() });
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
      t: 'happier_plugin_generation_v1' as const, schemaVersion: 1 as const, pluginId: 'acme.plugin', immutableGenerationId: 'generation-a',
      fingerprint: digest('fingerprint'), packageDigest: digest('package'), manifestDigest: digest('manifest'),
      runtimeDigest: digest('runtime'), installedUiArtifactDigest: digest('ui'), createdAtMs: 1,
      files: [{ relativePath: 'daemon.mjs', byteLength: Buffer.byteLength(bytes), digest: digest(bytes) }],
      installedArtifactRecord: { relativePath: 'daemon.mjs', digest: digest(bytes) },
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
      t: 'happier_plugin_generation_v1' as const, schemaVersion: 1 as const, pluginId: 'acme.plugin', immutableGenerationId: 'generation-a',
      fingerprint: digest('fingerprint'), packageDigest: digest('package'), manifestDigest: digest('manifest'),
      runtimeDigest: digest('runtime'), installedUiArtifactDigest: digest('ui'), createdAtMs: 1,
      files: [{ relativePath: 'dist/daemon.mjs', byteLength: Buffer.byteLength(bytes), digest: digest(bytes) }],
      installedArtifactRecord: { relativePath: 'dist/daemon.mjs', digest: digest(bytes) },
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
    for (const generation of ['generation-current', 'generation-lkg', 'generation-orphan']) {
      await mkdir(join(paths.generationsDir, generation), { recursive: true });
      await writeFile(join(paths.generationsDir, generation, 'marker'), generation, 'utf8');
    }
    const orphanBytes = 'generation-orphan';
    await writeFile(join(
      paths.generationsDir,
      'generation-orphan',
      'plugin-generation.v1.json',
    ), JSON.stringify({
      t: 'happier_plugin_generation_v1',
      schemaVersion: 1,
      pluginId: 'acme.plugin',
      immutableGenerationId: 'generation-orphan',
      fingerprint: digest('orphan-fingerprint'),
      packageDigest: digest('orphan-package'),
      manifestDigest: digest('orphan-manifest'),
      runtimeDigest: digest('orphan-runtime'),
      installedUiArtifactDigest: digest('orphan-ui'),
      createdAtMs: 1,
      files: [{
        relativePath: 'marker',
        byteLength: Buffer.byteLength(orphanBytes),
        digest: digest(orphanBytes),
      }],
      installedArtifactRecord: { relativePath: 'marker', digest: digest(orphanBytes) },
    }), 'utf8');
    const state = {
      ...stateRevision('generation-current'),
      health: {
        'generation-current': createPendingGenerationHealthRecord({ pluginId: 'acme.plugin', immutableGenerationId: 'generation-current', fingerprint: digest('generation-current') }),
        'generation-lkg': createPendingGenerationHealthRecord({ pluginId: 'acme.plugin', immutableGenerationId: 'generation-lkg', fingerprint: digest('generation-lkg') }),
      },
      rollbackRetention: [{
        pluginId: 'acme.plugin', immutableGenerationId: 'generation-lkg', healthGenerationId: 'generation-lkg',
        role: 'lastKnownGood' as const, automaticRecoveryEligible: true, retainedAtMs: 1, byteAvailability: 'available' as const,
        packageDigest: digest('package'), artifactDigest: digest('artifact'), pluginVersion: '1.0.0',
        distribution: { kind: 'localPath' as const, canonicalPath: '/tmp/acme-plugin' },
      }],
    };
    const stateReference = await persistInstallationStateRevision({ paths, state });
    const commit: PluginRegistryCommitRecord = {
      t: 'happier_plugin_registry_commit_v1', schemaVersion: 1, revision: 0, transactionId: 'cleanup', baseRevision: null,
      installationState: stateReference,
      pluginGenerations: { 'acme.plugin': {
        immutableGenerationId: 'generation-current', generationRecordDigest: digest('generation'),
        installedArtifactRecord: { relativePath: 'installed-artifacts.v1.json', digest: digest('artifact') },
      } },
      createdAtMs: 1, creator: { pid: 1, instanceId: 'daemon-a' },
    };

    const result = await cleanupUnreferencedPluginGenerations({ paths, commit, state });

    expect(result).toMatchObject({ referenced: ['generation-current'], retained: ['generation-lkg'], removed: ['generation-orphan'] });
    await expect(access(join(paths.generationsDir, 'generation-current', 'marker'))).resolves.toBeUndefined();
    await expect(access(join(paths.generationsDir, 'generation-lkg', 'marker'))).resolves.toBeUndefined();
    await expect(access(join(paths.generationsDir, 'generation-orphan'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(
      paths.generationsDir,
      '.retired-generation-orphan.v1.json',
    ))).resolves.toBeUndefined();
  });

  it('keeps unauthenticated retirement pending and completes it idempotently across failure and restart', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-custody-retirement-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const orphanId = 'generation-obsolete';
    const orphanRoot = join(paths.generationsDir, orphanId);
    const orphanRecord = {
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'acme.plugin',
      immutableGenerationId: orphanId,
      fingerprint: digest('obsolete-fingerprint'),
      packageDigest: digest('obsolete-package'),
      manifestDigest: digest('obsolete-manifest'),
      runtimeDigest: digest('obsolete-runtime'),
      installedUiArtifactDigest: digest('obsolete-ui'),
      createdAtMs: 1,
      files: [{ relativePath: 'marker', byteLength: 8, digest: digest('obsolete') }],
      installedArtifactRecord: { relativePath: 'marker', digest: digest('obsolete') },
    };
    await mkdir(orphanRoot, { recursive: true });
    await writeFile(join(orphanRoot, 'marker'), 'obsolete', 'utf8');
    await writeFile(join(orphanRoot, 'plugin-generation.v1.json'), JSON.stringify(orphanRecord), 'utf8');
    const state = stateRevision('generation-current');
    const stateReference = await persistInstallationStateRevision({ paths, state });
    const commit: PluginRegistryCommitRecord = {
      t: 'happier_plugin_registry_commit_v1', schemaVersion: 1, revision: 0, transactionId: 'cleanup-retirement', baseRevision: null,
      installationState: stateReference,
      pluginGenerations: { 'acme.plugin': {
        immutableGenerationId: 'generation-current', generationRecordDigest: digest('generation'),
        installedArtifactRecord: { relativePath: 'installed-artifacts.v1.json', digest: digest('artifact') },
      } },
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
        encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
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

    const second = await reconcileAfterRestart();
    expect(second).toMatchObject({ status: 'reconciled', removed: [orphanId], failures: [] });
    expect(retireGeneration).toHaveBeenNthCalledWith(1, { token: 'account-token', pluginId: 'acme.plugin', immutableGenerationId: orphanId });
    expect(retireGeneration).toHaveBeenNthCalledWith(2, { token: 'account-token', pluginId: 'acme.plugin', immutableGenerationId: orphanId });
    expect(commitFenceEntered).toHaveBeenCalledTimes(3);
    await expect(access(orphanRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(paths.generationsDir, `.retiring-${orphanId}`))).rejects.toMatchObject({ code: 'ENOENT' });

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

  it('rejects retirement when the exact durable commit changed and preserves the candidate bytes', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-generation-custody-stale-commit-'));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const orphanId = 'generation-obsolete';
    const orphanRoot = join(paths.generationsDir, orphanId);
    const orphanBytes = 'obsolete';
    const orphanRecord = {
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'acme.plugin',
      immutableGenerationId: orphanId,
      fingerprint: digest('obsolete-fingerprint'),
      packageDigest: digest('obsolete-package'),
      manifestDigest: digest('obsolete-manifest'),
      runtimeDigest: digest('obsolete-runtime'),
      installedUiArtifactDigest: digest('obsolete-ui'),
      createdAtMs: 1,
      files: [{ relativePath: 'marker', byteLength: Buffer.byteLength(orphanBytes), digest: digest(orphanBytes) }],
      installedArtifactRecord: { relativePath: 'marker', digest: digest(orphanBytes) },
    };
    await mkdir(orphanRoot, { recursive: true });
    await writeFile(join(orphanRoot, 'marker'), orphanBytes, 'utf8');
    await writeFile(join(orphanRoot, 'plugin-generation.v1.json'), JSON.stringify(orphanRecord), 'utf8');
    const stateReference = await persistInstallationStateRevision({ paths, state: stateRevision('generation-current') });
    const staleCommit: PluginRegistryCommitRecord = {
      t: 'happier_plugin_registry_commit_v1', schemaVersion: 1, revision: 0, transactionId: 'cleanup-stale', baseRevision: null,
      installationState: stateReference,
      pluginGenerations: { 'acme.plugin': {
        immutableGenerationId: 'generation-current', generationRecordDigest: digest('generation'),
        installedArtifactRecord: { relativePath: 'installed-artifacts.v1.json', digest: digest('artifact') },
      } },
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
        pluginId: 'acme.plugin', immutableGenerationId: 'generation-live', healthGenerationId: 'generation-live',
        role: 'lastKnownGood' as const, automaticRecoveryEligible: true, retainedAtMs: 1,
        byteAvailability: 'available' as const, packageDigest: digest('package'), artifactDigest: digest('artifact'),
        pluginVersion: '1.0.0', distribution: { kind: 'localPath' as const, canonicalPath: '/tmp/acme-plugin' },
      }],
      health: {
        ...stateRevision('generation-current').health,
        'generation-live': createPendingGenerationHealthRecord({
          pluginId: 'acme.plugin', immutableGenerationId: 'generation-live', fingerprint: digest('generation-live'),
        }),
      },
    };
    const authoritativeReference = await persistInstallationStateRevision({ paths, state: authoritativeState });
    const commit: PluginRegistryCommitRecord = {
      t: 'happier_plugin_registry_commit_v1', schemaVersion: 1, revision: 0, transactionId: 'cleanup', baseRevision: null,
      installationState: authoritativeReference,
      pluginGenerations: { 'acme.plugin': {
        immutableGenerationId: 'generation-current', generationRecordDigest: digest('generation'),
        installedArtifactRecord: { relativePath: 'installed-artifacts.v1.json', digest: digest('artifact') },
      } },
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
      health: Object.fromEntries([
        ...Object.entries(base.health),
        ...retainedGenerationIds.map((generationId) => [generationId, createPendingGenerationHealthRecord({
          pluginId: 'acme.plugin', immutableGenerationId: generationId, fingerprint: digest(generationId),
        })]),
      ]),
      rollbackRetention: retainedGenerationIds.map((immutableGenerationId) => ({
        pluginId: 'acme.plugin', immutableGenerationId, healthGenerationId: immutableGenerationId,
        role: 'lastKnownGood' as const, automaticRecoveryEligible: true, retainedAtMs: 1,
        byteAvailability: 'available' as const, packageDigest: digest(`package-${immutableGenerationId}`),
        artifactDigest: digest(`artifact-${immutableGenerationId}`), pluginVersion: '1.0.0',
        distribution: { kind: 'localPath' as const, canonicalPath: '/tmp/acme-plugin' },
      })),
    };

    await expect(persistInstallationStateRevision({ paths, state })).rejects.toThrow(/bounded rollback retention/i);
  });

  it('binds fingerprints to integrity facts', () => {
    const facts = {
      pluginId: 'acme.plugin',
      distribution: { kind: 'localPath' as const, canonicalPath: '/tmp/acme-plugin' },
      updatePolicy: 'manual' as const,
      normalizedManifestDigest: digest('manifest'), packageDigest: digest('package'), runtimeDigest: digest('runtime'),
      installedUiArtifactDigest: digest('ui'),
    };
    expect(computePluginGenerationFingerprint(facts)).not.toBe(computePluginGenerationFingerprint({ ...facts, runtimeDigest: digest('runtime-2') }));
  });
});
