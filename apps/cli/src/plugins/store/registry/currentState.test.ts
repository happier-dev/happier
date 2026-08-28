import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PluginInstallReviewPrincipalDigestSchema,
  PluginInstallReviewPrincipalPresentationV1Schema,
  normalizePluginReleaseFactsV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { resolvePredecessorPluginStorePaths } from '../state.testkit';
import { PluginStateFileV1Schema } from '../state';
import {
  createArchivePluginDistributionIdentity,
  createLocalPathPluginDistributionIdentity,
  createNpmPluginDistributionIdentity,
  createPluginTrustRecord,
} from '../install/trustIdentity';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { readInstalledPluginCatalog } from '@/plugins/projection/catalog/installed';
import { readPluginRegistryCommitRecord } from './commitRecord';
import { PREDECESSOR_PLUGIN_REGISTRY_COMMIT_RECORD_BYTES } from './currentState.testkit';
import {
  createPluginRegistryStateStore,
  type CommitPluginRegistryInstallationInput,
  type PreparedPluginRegistryRuntime,
  type PluginRegistryRuntimeLifecycle,
} from './currentState';
import {
  prepareOwnedImmutablePluginGeneration,
  readInstallationStateRevision,
  type BundledImmutablePluginArtifact,
} from './generationStore';
import { derivePluginInstallReviewPrincipalDigest } from '../../daemon/installReviewPrincipal';

const TEST_RUNTIME_LIFECYCLE: PluginRegistryRuntimeLifecycle = Object.freeze({
  prepare: async () => Object.freeze({
    abort: async () => undefined,
    adopt: async () => undefined,
  }),
});

it('projects an admitted bundled generation through the canonical machine Availability inventory', async () => {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-bundled-availability-home-'));
  const packageRoot = await mkdtemp(join(tmpdir(), 'happier-bundled-availability-package-'));
  await mkdir(join(packageRoot, '.happier-plugin'), { recursive: true });
  await mkdir(join(packageRoot, 'dist', 'happier-plugin-ui'), { recursive: true });
  const manifestBytes = '{}';
  const entryBytes = 'export {};';
  const packageMetadataBytes = JSON.stringify({
    name: '@happier-dev/plugins-availability-fixture',
    version: '0.0.0',
  });
  await writeFile(join(packageRoot, '.happier-plugin', 'plugin.json'), manifestBytes);
  await writeFile(join(packageRoot, 'dist', 'index.js'), entryBytes);
  await writeFile(join(packageRoot, 'package.json'), packageMetadataBytes);
  const artifactDigest = `sha256:${'a'.repeat(64)}`;
  const uiManifestBytes = JSON.stringify({
    version: 1,
    entries: [{
      contributionId: 'fixture-native',
      tier: 'reactNative',
      platform: 'web',
      entry: 'entry.mjs.bundle',
      files: [{
        relativePath: 'entry.mjs.bundle',
        digest: `sha256:${'b'.repeat(64)}`,
        byteSize: 1,
      }],
      digest: artifactDigest,
      builtWith: { bundler: 'vite', version: '1.0.0' },
      hostUiApiVersion: '1.0.0',
      compat: { react: '19.2.0', reactNative: '0.83.5' },
    }],
  });
  await writeFile(join(packageRoot, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'), uiManifestBytes);
  const bundledArtifact: BundledImmutablePluginArtifact = Object.freeze({
    packageName: '@happier-dev/plugins-availability-fixture',
    packageEntryRelativePath: 'dist/index.js',
    record: Object.freeze({
      t: 'happier_plugin_generation_v1',
      schemaVersion: 1,
      pluginId: 'happier.fixture.availability',
      immutableGenerationId: 'bundled-generation-fixture',
      createdAtMs: 0,
      manifestRelativePath: '.happier-plugin/plugin.json',
      files: Object.freeze([
        { relativePath: '.happier-plugin/plugin.json', byteLength: Buffer.byteLength(manifestBytes) },
        { relativePath: 'dist/happier-plugin-ui/ui-artifacts.json', byteLength: Buffer.byteLength(uiManifestBytes) },
        { relativePath: 'dist/index.js', byteLength: Buffer.byteLength(entryBytes) },
        { relativePath: 'package.json', byteLength: Buffer.byteLength(packageMetadataBytes) },
      ]),
    }),
  });
  const store = createPluginRegistryStateStore({
    happyHomeDir,
    bundledArtifacts: [bundledArtifact],
    resolveBundledPackageEntry: async () => join(packageRoot, 'dist', 'index.js'),
    nowMs: () => 123,
  });

  await expect(store.readAvailabilityInventory()).resolves.toEqual({
    revision: 0,
    releasePublications: [],
    materializations: [{
      materializationId: 'bundled-first-party:bundled-generation-fixture',
      pluginId: 'happier.fixture.availability',
      version: '0.0.0',
      sourceClass: 'bundledFirstParty',
      portableRelease: false,
      uiArtifacts: [{
        contributionId: 'fixture-native',
        tier: 'reactNative',
        platform: 'web',
        artifactDigest,
      }],
      enabled: true,
      trustState: 'trusted',
      observedAt: 123,
    }],
  });
  await Promise.all([
    rm(happyHomeDir, { recursive: true, force: true }),
    rm(packageRoot, { recursive: true, force: true }),
  ]);
});

const INSTALL_REVIEW_PRESENTATION_A = PluginInstallReviewPrincipalPresentationV1Schema.parse({
  v: 1,
  packageIdentity: { pluginId: 'acme.registry.plugin', packageName: null },
  distributionIdentity: { kind: 'path', development: false },
  publisherIdentity: { status: 'unavailable' },
  packageSignature: { status: 'unavailable' },
});
const INSTALL_REVIEW_PRESENTATION_B = PluginInstallReviewPrincipalPresentationV1Schema.parse({
  ...INSTALL_REVIEW_PRESENTATION_A,
  distributionIdentity: { kind: 'path', development: true },
});
const INSTALL_REVIEW_PRINCIPAL_A = derivePluginInstallReviewPrincipalDigest(
  INSTALL_REVIEW_PRESENTATION_A,
);
const INSTALL_REVIEW_PRINCIPAL_B = derivePluginInstallReviewPrincipalDigest(
  INSTALL_REVIEW_PRESENTATION_B,
);

type TestPluginRegistryInstallationInput = Omit<
  CommitPluginRegistryInstallationInput,
  'preparedGeneration'
> & Readonly<{
  sourceRootPath: string;
  manifestRelativePath: string;
  createdAtMs?: number;
}>;

async function installPreparedCandidate(
  store: ReturnType<typeof createPluginRegistryStateStore>,
  input: TestPluginRegistryInstallationInput,
) {
  const { sourceRootPath, manifestRelativePath, createdAtMs, ...installation } = input;
  const preparedGeneration = await prepareOwnedImmutablePluginGeneration({
    paths: store.paths,
    pluginId: input.pluginId,
    sourceRootPath,
    manifestRelativePath,
    distribution: input.trust.distribution,
    updatePolicy: input.updatePolicy,
    createdAtMs: createdAtMs ?? Date.now(),
  });
  try {
    return await store.install({ ...installation, preparedGeneration });
  } finally {
    await preparedGeneration.cleanup();
  }
}

function createRevisionTaggedRuntimeRegistry(): ResolvedExecutablePluginRuntimeRegistry {
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
    },
    hookHandlersByHookId: new Map(),
    agentRuntimesByAgentId: new Map(),
    scmHostingProvidersById: new Map(),
    pluginDiagnosticsByPluginId: Object.freeze({}),
    activatedPluginIds: new Set(),
    activateContributionsOnDemand: async () => [],
    resolvePromptAssetBlocks: async () => [],
    addRuntimeDisposable: (_pluginId, disposable) => disposable,
    createAgentInvocationServices: async () => createUnavailablePluginServices(),
    retireConsumers: () => undefined,
    dispose: async () => undefined,
  };
}

describe('PluginRegistryStateStore', () => {
  it('rejects an unreleased health bootstrap instead of retaining a dynamic migration reader', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-empty-bootstrap-migration-'));
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      owner: { pid: 42, instanceId: 'daemon-migration' },
      nowMs: () => 10,
      runtimeLifecycle: TEST_RUNTIME_LIFECYCLE,
    });
    const predecessorRevisionId = 'state-predecessor-empty';
    const predecessorRevisionPath = join(
      store.paths.stateRevisionsDir,
      predecessorRevisionId,
      'plugin-installations.v1.json',
    );
    const predecessorRevision = {
      t: 'happier_plugin_installations_v1',
      schemaVersion: 1,
      revisionId: predecessorRevisionId,
      createdAtMs: 1,
      plugins: {},
      health: {},
      rollbackRetention: [],
      healthTombstones: [],
      runtimeCatalog: {
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {},
      },
      retainedRuntimeCatalog: {},
    };
    await mkdir(join(store.paths.stateRevisionsDir, predecessorRevisionId), { recursive: true });
    await mkdir(store.paths.stateDir, { recursive: true });
    await writeFile(predecessorRevisionPath, JSON.stringify(predecessorRevision), 'utf8');
    await writeFile(store.paths.registryCurrentFilePath, JSON.stringify({
      t: 'happier_plugin_registry_commit_v1',
      schemaVersion: 1,
      revision: 0,
      transactionId: 'predecessor-bootstrap',
      baseRevision: null,
      installationState: { revisionId: predecessorRevisionId },
      pluginGenerations: {},
      createdAtMs: 1,
      creator: { pid: 7, instanceId: 'daemon-predecessor' },
    }), 'utf8');

    await expect(store.initialize()).rejects.toThrow(/invalid installation state revision/i);

    const current = await readPluginRegistryCommitRecord(store.paths);
    expect(current).toMatchObject({
      revision: 0,
      baseRevision: null,
      pluginGenerations: {},
    });
    expect(current?.installationState.revisionId).toBe(predecessorRevisionId);
    await expect(readFile(predecessorRevisionPath, 'utf8')).resolves.toBe(
      JSON.stringify(predecessorRevision),
    );
  });

  it('adopts the supplied immutable candidate and never re-materializes the reviewed source', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-owned-candidate-'));
    const pluginId = 'acme.owned-candidate';
    const pluginRoot = join(happyHomeDir, 'author-plugin');
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export const candidate = "reviewed";\n', 'utf8');
    await writeFile(manifestPath, JSON.stringify({ id: pluginId, version: '1.0.0' }), 'utf8');
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
            manifestPath,
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'manual' },
          state: { enabled: true },
        },
      },
    }).plugins[pluginId]!;
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: TEST_RUNTIME_LIFECYCLE,
    });
    const preparedGeneration = await prepareOwnedImmutablePluginGeneration({
      paths: store.paths,
      pluginId,
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      distribution,
      updatePolicy: 'manual',
      createdAtMs: 1,
    });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export const candidate = "later";\n', 'utf8');

    await expect(store.install({
      pluginId,
      catalogRecord,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
      admittedIntegrity: `sha256-${Buffer.alloc(32, 1).toString('base64')}`,
      preparedGeneration,
    })).rejects.toThrow(/local path.*acquisition integrity/i);

    await expect(store.install({
      pluginId,
      catalogRecord,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
      preparedGeneration,
    })).resolves.toMatchObject({
      status: 'committed',
      record: {
        pluginGenerations: {
          [pluginId]: preparedGeneration.reference,
        },
      },
    });
    await preparedGeneration.cleanup();

    await expect(readFile(join(preparedGeneration.rootPath, 'daemon.mjs'), 'utf8'))
      .resolves.toContain('"reviewed"');
    await expect(store.read()).resolves.toMatchObject({
      plugins: {
        [pluginId]: {
          source: { resolvedPath: preparedGeneration.rootPath },
        },
      },
    });
    await expect(store.readSnapshot()).resolves.toMatchObject({
      admittedIntegrityByPluginId: {},
    });
  });

  it('persists verified npm acquisition integrity in the same committed snapshot as its generation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-admitted-integrity-'));
    const pluginId = 'acme.npm-integrity';
    const pluginRoot = join(happyHomeDir, 'npm-plugin');
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    const admittedIntegrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
    const normalizedManifest = createPluginManifestV2Fixture({ id: pluginId, version: '1.0.0' });
    await writeFile(manifestPath, JSON.stringify(normalizedManifest), 'utf8');

    const distribution = createNpmPluginDistributionIdentity({
      registryOrigin: 'https://registry.npmjs.org',
      packageName: '@acme/npm-integrity',
    });
    const trust = createPluginTrustRecord({ pluginId, distribution, approvedAtMs: 1 });
    const catalogRecord = PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        [pluginId]: {
          source: {
            kind: 'package',
            locator: '@acme/npm-integrity',
            trustPolicy: 'prompt',
            installPolicy: 'managed_install',
            resolvedVersion: '1.0.0',
            resolvedPath: pluginRoot,
            manifestPath,
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'managed_install', manifestVersion: '1.0.0', trust, updatePolicy: 'manual' },
          state: { enabled: true },
        },
      },
    }).plugins[pluginId]!;
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: TEST_RUNTIME_LIFECYCLE,
    });
    const archiveDigestSha256 = `sha256:${'a'.repeat(64)}` as const;
    const availability = {
      sourceClass: 'registryPackage' as const,
      portableRelease: true,
      release: normalizePluginReleaseFactsV1({
        ref: { pluginId, version: '1.0.0' },
        archiveDigestSha256,
        normalizedManifest,
        collectionContracts: [],
        uiSlots: [],
        packageAssetArchive: {
          archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
          resources: [],
        },
      }),
    };

    await expect(installPreparedCandidate(store, {
      pluginId,
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
      admittedIntegrity,
      availability,
    })).resolves.toMatchObject({ status: 'committed' });

    await expect(store.readSnapshot()).resolves.toMatchObject({
      revision: 1,
      state: { plugins: { [pluginId]: expect.anything() } },
      pluginGenerations: {
        [pluginId]: { immutableGenerationId: expect.any(String) },
      },
      admittedIntegrityByPluginId: {
        [pluginId]: admittedIntegrity,
      },
    });
    await expect(readInstalledPluginCatalog({ happyHomeDir })).resolves.toEqual([
      expect.objectContaining({
        pluginId,
        admittedIntegrity,
      }),
    ]);
    const availabilityInventory = await store.readAvailabilityInventory();
    expect(availabilityInventory.materializations[0]).not.toHaveProperty('releaseFacts');
    expect(availabilityInventory).toMatchObject({
      revision: 1,
      releasePublications: [{
        sourceClass: 'registryPackage',
        facts: {
          ref: { pluginId, version: '1.0.0' },
          archiveDigestSha256,
        },
      }],
      materializations: [{
        materializationId: expect.stringMatching(/^materialization-/u),
        pluginId,
        version: '1.0.0',
        sourceClass: 'registryPackage',
        portableRelease: true,
        archiveDigestSha256,
        uiArtifacts: [],
        enabled: true,
        trustState: 'trusted',
        observedAt: expect.any(Number),
      }],
    });
    const publishedRelease = availabilityInventory.releasePublications[0]?.facts;
    if (!publishedRelease) throw new Error('Expected a portable release publication.');
    const publishedEngines = publishedRelease.normalizedManifest.engines;
    if (!publishedEngines) throw new Error('Expected a normalized manifest engines declaration.');
    expect(Object.isFrozen(publishedRelease)).toBe(true);
    expect(Object.isFrozen(publishedRelease.normalizedManifest)).toBe(true);
    expect(Object.isFrozen(publishedEngines)).toBe(true);
    expect(Object.isFrozen(publishedRelease.packageAssetArchive)).toBe(true);
    expect(() => Object.assign(publishedEngines, {
      happier: '^99.0.0',
    })).toThrow(TypeError);
    const firstCommit = await readPluginRegistryCommitRecord(store.paths);
    if (!firstCommit) throw new Error('Expected the first committed availability revision');
    await store.setEnabled(pluginId, false);
    await expect(store.readAvailabilityInventoryForCommit(firstCommit)).resolves.toMatchObject({
      revision: 1,
      materializations: [{ enabled: true }],
    });
    await expect(store.readAvailabilityInventory()).resolves.toMatchObject({
      revision: 2,
      materializations: [{ enabled: false }],
    });
  });

  it('requires a curated source binding for automatic npm installation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-curated-auto-'));
    const pluginId = 'acme.curated-auto';
    const pluginRoot = join(happyHomeDir, 'npm-plugin');
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
    await writeFile(
      manifestPath,
      JSON.stringify(createPluginManifestV2Fixture({ id: pluginId, version: '1.0.0' })),
      'utf8',
    );

    const distribution = createNpmPluginDistributionIdentity({
      registryOrigin: 'https://registry.npmjs.org',
      packageName: '@acme/curated-auto',
    });
    const trust = createPluginTrustRecord({ pluginId, distribution, approvedAtMs: 1 });
    const catalogRecord = PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        [pluginId]: {
          source: {
            kind: 'package',
            locator: '@acme/curated-auto',
            trustPolicy: 'prompt',
            installPolicy: 'managed_install',
            resolvedVersion: '1.0.0',
            resolvedPath: pluginRoot,
            manifestPath,
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'managed_install', manifestVersion: '1.0.0', trust, updatePolicy: 'automatic' },
          state: { enabled: true },
        },
      },
    }).plugins[pluginId]!;
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: TEST_RUNTIME_LIFECYCLE,
    });
    const input = {
      pluginId,
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord,
      trust,
      updatePolicy: 'automatic' as const,
      optionalAccess: [],
    };

    await expect(installPreparedCandidate(store, input))
      .rejects.toThrow(/reviewed curated npm source binding/i);

    const curatedUpdateSource = {
      id: 'marketplace:curated',
      sourceUrl: 'https://marketplace.example.test/catalog.json',
      registryProfileId: 'registry_private',
    };
    await expect(installPreparedCandidate(store, {
      ...input,
      catalogRecord: {
        ...catalogRecord,
        install: { ...catalogRecord.install, curatedUpdateSource },
      },
    })).resolves.toMatchObject({ status: 'committed' });
    await expect(store.read()).resolves.toMatchObject({
      plugins: {
        [pluginId]: { install: { curatedUpdateSource } },
      },
    });
  });

  it('publishes a hard running-Session disposition after durable commit even when runtime adoption fails', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-hard-adoption-failure-'));
    const pluginId = 'acme.hard-adoption-failure';
    const pluginRoot = join(happyHomeDir, pluginId);
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
    await writeFile(manifestPath, JSON.stringify(createPluginManifestV2Fixture({
      id: pluginId,
      entrypoints: { daemon: './daemon.mjs' },
    })), 'utf8');
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
            manifestPath,
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'manual' },
          state: { enabled: true },
        },
      },
    }).plugins[pluginId]!;
    const events: string[] = [];
    const runtimeLifecycle: PluginRegistryRuntimeLifecycle = {
      async prepare(candidate): Promise<PreparedPluginRegistryRuntime> {
        const prepared: PreparedPluginRegistryRuntime & Readonly<{
          notifyDurableRunningSessionDisposition(record: Readonly<{ revision: number }>): void;
        }> = Object.freeze({
          abort: async () => undefined,
          notifyDurableRunningSessionDisposition(record) {
            events.push(`notify:${record.revision}:${candidate.runningSessionDisposition}`);
          },
          async adopt(record) {
            events.push(`adopt:${record.revision}:${candidate.runningSessionDisposition}`);
            if (candidate.runningSessionDisposition === 'revokeRunningSessions') {
              throw new Error('fixture adoption unavailable');
            }
          },
        });
        return prepared;
      },
    };
    const onApplied = vi.fn();
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle,
      onApplied,
    });
    await installPreparedCandidate(store, {
      pluginId,
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
    });
    events.length = 0;
    onApplied.mockClear();

    await expect(store.setEnabledWithResult(pluginId, false)).resolves.toMatchObject({
      transaction: {
        status: 'outcomeUnknown',
        phase: 'adoption',
      },
    });
    expect(events).toEqual([
      'notify:2:revokeRunningSessions',
      'adopt:2:revokeRunningSessions',
    ]);
    expect(onApplied).not.toHaveBeenCalled();
    await expect(readPluginRegistryCommitRecord(store.paths)).resolves.toMatchObject({ revision: 2 });
  });

  it('advances the hard-revocation fence across repeated integrity failures without resetting it on replacement', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-hard-revocation-fence-'));
    const pluginId = 'acme.hard-revocation-fence';
    const pluginRoot = join(happyHomeDir, pluginId);
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
    await writeFile(manifestPath, JSON.stringify(createPluginManifestV2Fixture({
      id: pluginId,
      entrypoints: { daemon: './daemon.mjs' },
    })), 'utf8');
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
            manifestPath,
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'manual' },
          state: { enabled: true },
        },
      },
    }).plugins[pluginId]!;
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: TEST_RUNTIME_LIFECYCLE,
      runHardRevocationCurrentnessChange: async (_pluginId, change) => {
        await change({ onApplied: () => undefined });
      },
    });

    await installPreparedCandidate(store, {
      pluginId,
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
    });
    const firstInstallCommit = await readPluginRegistryCommitRecord(store.paths);
    if (!firstInstallCommit) throw new Error('Expected first plugin installation commit');
    const generationG = firstInstallCommit.pluginGenerations[pluginId]?.immutableGenerationId;
    if (!generationG) throw new Error('Expected first immutable generation');

    await store.hardRevokeRunningSessionsForGenerationIntegrityFailure({
      pluginId,
      immutableGenerationId: generationG,
    });
    const firstHardRevocationCommit = await readPluginRegistryCommitRecord(store.paths);
    if (!firstHardRevocationCommit) throw new Error('Expected first hard-revocation commit');
    const firstHardRevocationState = await readInstallationStateRevision({
      paths: store.paths,
      reference: firstHardRevocationCommit.installationState,
      commit: firstHardRevocationCommit,
    });
    expect(firstHardRevocationState.hardRevocationRevisions?.[pluginId])
      .toBe(firstHardRevocationCommit.revision);

    await store.hardRevokeRunningSessionsForGenerationIntegrityFailure({
      pluginId,
      immutableGenerationId: generationG,
    });
    const repeatedHardRevocationCommit = await readPluginRegistryCommitRecord(store.paths);
    if (!repeatedHardRevocationCommit) throw new Error('Expected repeated hard-revocation commit');
    const repeatedHardRevocationState = await readInstallationStateRevision({
      paths: store.paths,
      reference: repeatedHardRevocationCommit.installationState,
      commit: repeatedHardRevocationCommit,
    });
    expect(repeatedHardRevocationCommit.revision)
      .toBeGreaterThan(firstHardRevocationCommit.revision);
    expect(repeatedHardRevocationState.hardRevocationRevisions?.[pluginId])
      .toBe(repeatedHardRevocationCommit.revision);

    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() { return "replacement"; }\n', 'utf8');
    await installPreparedCandidate(store, {
      pluginId,
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
    });
    const replacementCommit = await readPluginRegistryCommitRecord(store.paths);
    if (!replacementCommit) throw new Error('Expected replacement plugin installation commit');
    const replacementState = await readInstallationStateRevision({
      paths: store.paths,
      reference: replacementCommit.installationState,
      commit: replacementCommit,
    });
    expect(replacementState.hardRevocationRevisions?.[pluginId])
      .toBe(repeatedHardRevocationCommit.revision);
    const generationH = replacementCommit.pluginGenerations[pluginId]?.immutableGenerationId;
    if (!generationH) throw new Error('Expected replacement immutable generation');
    expect(generationH).not.toBe(generationG);

    await store.hardRevokeRunningSessionsForGenerationIntegrityFailure({
      pluginId,
      immutableGenerationId: generationH,
    });
    const secondHardRevocationCommit = await readPluginRegistryCommitRecord(store.paths);
    if (!secondHardRevocationCommit) throw new Error('Expected second hard-revocation commit');
    const secondHardRevocationState = await readInstallationStateRevision({
      paths: store.paths,
      reference: secondHardRevocationCommit.installationState,
      commit: secondHardRevocationCommit,
    });
    expect(secondHardRevocationState.hardRevocationRevisions?.[pluginId])
      .toBe(secondHardRevocationCommit.revision);
  });

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
        const registry = createRevisionTaggedRuntimeRegistry();
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
              runningSessionDisposition: candidate.runningSessionDisposition,
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

    const olderChange = installPreparedCandidate(firstStore, firstInstall);
    await olderCommitReachedAdoption;

    const newerChange = await installPreparedCandidate(secondStore, secondInstall);
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

    await expect(installPreparedCandidate(store, {
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
      installPreparedCandidate(firstStore, first),
      installPreparedCandidate(secondStore, second),
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

    await expect(installPreparedCandidate(store, {
      pluginId: 'acme.registry.plugin',
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord: record,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
      installReviewPrincipalDigest: PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64)),
      installReviewPrincipalPresentation: INSTALL_REVIEW_PRESENTATION_A,
    })).rejects.toThrow(/install-review principal.*digest|digest.*install-review principal/i);

    await installPreparedCandidate(store, {
      pluginId: 'acme.registry.plugin',
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord: record,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
      installReviewPrincipalDigest: INSTALL_REVIEW_PRINCIPAL_A,
      installReviewPrincipalPresentation: INSTALL_REVIEW_PRESENTATION_A,
    });
    const firstCommit = (await readPluginRegistryCommitRecord(store.paths))!;
    const firstGenerationId = firstCommit.pluginGenerations['acme.registry.plugin']!.immutableGenerationId;
    const firstState = await readInstallationStateRevision({
      paths: store.paths,
      reference: firstCommit.installationState,
    });
    const firstMaterializationId = firstState.plugins['acme.registry.plugin']?.materializationId;
    expect(firstCommit.revision).toBe(1);
    expect(firstCommit.pluginGenerations['acme.registry.plugin']).toBeDefined();
    expect(firstMaterializationId).toEqual(expect.stringMatching(/^materialization-/u));
    expect(firstState.plugins['acme.registry.plugin']).toMatchObject({
      availability: { sourceClass: 'localPath', portableRelease: false },
    });
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
    await installPreparedCandidate(store, {
      pluginId: 'acme.registry.plugin',
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord: secondRecord,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
      installReviewPrincipalDigest: INSTALL_REVIEW_PRINCIPAL_B,
      installReviewPrincipalPresentation: INSTALL_REVIEW_PRESENTATION_B,
    });
    const secondCommit = (await readPluginRegistryCommitRecord(store.paths))!;
    const secondGenerationId = secondCommit.pluginGenerations['acme.registry.plugin']!.immutableGenerationId;
    const secondState = await readInstallationStateRevision({ paths: store.paths, reference: secondCommit.installationState });
    expect(secondCommit.revision).toBe(3);
    expect(secondState.rollbackRetention).toHaveLength(1);
    expect(secondState.rollbackRetention[0]?.installReviewPrincipalDigest)
      .toBe(INSTALL_REVIEW_PRINCIPAL_A);
    expect(secondState.rollbackRetention[0]?.installReviewPrincipalPresentation)
      .toEqual(INSTALL_REVIEW_PRESENTATION_A);
    expect(secondState.plugins['acme.registry.plugin']?.materializationId)
      .toBe(firstMaterializationId);
    expect((await store.read()).plugins['acme.registry.plugin']?.state.enabled).toBe(false);

    await store.rollback('acme.registry.plugin');
    expect((await store.read()).plugins['acme.registry.plugin']?.install.manifestVersion).toBe('1.0.0');
    await expect(store.readSnapshot()).resolves.toMatchObject({
      admittedIntegrityByPluginId: {},
      installReviewPrincipalDigestsByPluginId: {
        'acme.registry.plugin': INSTALL_REVIEW_PRINCIPAL_A,
      },
      installReviewPrincipalPresentationsByPluginId: {
        'acme.registry.plugin': INSTALL_REVIEW_PRESENTATION_A,
      },
    });

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

    await installPreparedCandidate(store, {
      pluginId: 'acme.registry.plugin',
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord: secondRecord,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
      installReviewPrincipalDigest: INSTALL_REVIEW_PRINCIPAL_B,
      installReviewPrincipalPresentation: INSTALL_REVIEW_PRESENTATION_B,
    });
    const reinstalledCommit = (await readPluginRegistryCommitRecord(store.paths))!;
    const reinstalledState = await readInstallationStateRevision({
      paths: store.paths,
      reference: reinstalledCommit.installationState,
    });
    expect(reinstalledState.plugins['acme.registry.plugin']?.materializationId)
      .toEqual(expect.stringMatching(/^materialization-/u));
    expect(reinstalledState.plugins['acme.registry.plugin']?.materializationId)
      .not.toBe(firstMaterializationId);
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
      await installPreparedCandidate(store, {
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
      const admittedIntegrity = `sha256-${Buffer.alloc(32, integrityByte).toString('base64')}`;
      const distribution = await createArchivePluginDistributionIdentity({
        source: { kind: 'localFile', path: archivePath },
        integrity: admittedIntegrity,
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
      await installPreparedCandidate(store, {
        pluginId: 'acme.archive.rollback',
        sourceRootPath: pluginRoot,
        manifestRelativePath: '.happier-plugin/plugin.json',
        catalogRecord: record,
        trust,
        updatePolicy: 'manual',
        optionalAccess: [],
        admittedIntegrity,
      });
      return { distribution, admittedIntegrity };
    };

    const first = await install('1.0.0', 1);
    const firstGenerationId = (await readPluginRegistryCommitRecord(store.paths))!
      .pluginGenerations['acme.archive.rollback']!.immutableGenerationId;
    const second = await install('2.0.0', 2);
    const afterUpdateCommit = (await readPluginRegistryCommitRecord(store.paths))!;
    const afterUpdateState = await readInstallationStateRevision({
      paths: store.paths,
      reference: afterUpdateCommit.installationState,
    });

    expect(first.distribution).not.toEqual(second.distribution);
    expect(afterUpdateState.rollbackRetention).toEqual([
      expect.objectContaining({
        pluginId: 'acme.archive.rollback',
        immutableGenerationId: firstGenerationId,
        distribution: first.distribution,
        admittedIntegrity: first.admittedIntegrity,
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
      trust: { distribution: first.distribution },
      source: {
        distribution: first.distribution,
        admittedIntegrity: first.admittedIntegrity,
      },
    });
    expect(rolledBackState.rollbackRetention).toContainEqual(expect.objectContaining({
      distribution: second.distribution,
      admittedIntegrity: second.admittedIntegrity,
    }));
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
          if (runtimeUnavailable) {
            throw new Error(
              'runtime reload unavailable with client_secret=reconciliation-secret '
              + 'at /Users/alice/private/plugin-runtime.json',
            );
          }
          appliedRevisions.push(commit.revision);
        },
      }],
    });

    const result = await installPreparedCandidate(store, {
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
    if (result.status !== 'committed') throw new Error('Expected committed registry transaction');
    expect(result.message).not.toContain('reconciliation-secret');
    expect(result.message).not.toContain('/Users/alice/private/plugin-runtime.json');
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

  it('fails a normal start closed but recovers a plugin-recovery start from an unreadable current record', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-unreadable-'));
    const paths = resolvePredecessorPluginStorePaths({ happyHomeDir });
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(
      paths.registryCurrentFilePath,
      PREDECESSOR_PLUGIN_REGISTRY_COMMIT_RECORD_BYTES,
      'utf8',
    );

    // A normal start must still refuse to discard durable plugin state, but its
    // refusal has to name the file and the exact rejected field.
    const normalStart = await createPluginRegistryStateStore({ happyHomeDir })
      .initialize()
      .then(() => null, (reason: unknown) => reason);
    expect((normalStart as Error).message).toContain(paths.registryCurrentFilePath);
    expect((normalStart as Error).message).toContain('installationState');
    expect((normalStart as Error).message).toContain('digest');
    await expect(readFile(paths.registryCurrentFilePath, 'utf8'))
      .resolves.toBe(PREDECESSOR_PLUGIN_REGISTRY_COMMIT_RECORD_BYTES);

    const quarantined: string[] = [];
    const recovered = await createPluginRegistryStateStore({
      happyHomeDir,
      pluginRecovery: true,
      onCommitRecordQuarantined: (info) => {
        quarantined.push(info.quarantinePath);
      },
    }).initialize();

    expect(recovered.plugins).toEqual({});
    expect(quarantined).toHaveLength(1);
    // The unreadable record is preserved, never deleted.
    await expect(readFile(quarantined[0]!, 'utf8'))
      .resolves.toBe(PREDECESSOR_PLUGIN_REGISTRY_COMMIT_RECORD_BYTES);
    await expect(readPluginRegistryCommitRecord(paths)).resolves.toMatchObject({
      revision: 0,
      pluginGenerations: {},
    });
  });
});
