import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDaemonPluginChangeService as createBaseDaemonPluginChangeService } from './changeService';
import type {
  PluginChangeDecisionResult,
  PluginChangeRequest,
  PluginChangeRequestResult,
} from './changeContract';
import { createDaemonPathPluginChangePreparer as createBaseDaemonPathPluginChangePreparer } from './pathChangePreparer';
import { derivePluginInstallReviewPrincipal } from './installReviewPrincipal';
import {
  createPluginRegistryStateStore,
  type PluginDevelopmentRuntimeCandidate,
  type PluginRegistryRuntimeCandidate,
  type PluginRegistryRuntimeLifecycle,
} from '@/plugins/store/registry/currentState';
import { readPluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import {
  readCurrentCommittedPluginGenerations,
  readInstallationStateRevision,
} from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { loadPluginModule, loadVerifiedPluginModule } from '@/plugins/runtime/loadPluginModule';
import type { RunManagedPluginPnpmBoundary } from './developmentCandidateMaterializer';
import {
  startPluginDevelopmentSourceObserver,
  type PluginDevelopmentSourceObservationDelivery,
} from '@/plugins/authoring/sourceObserver';
import { successfulManagedPluginPnpmBoundary as successfulManagedPnpmBoundary } from '@/plugins/testkit/managedPnpmBoundary';
import { requestUserPluginChange } from './changeClient';
import { updateSelectedPluginOptionalAccess } from './optionalAccessSelections';
import { preserveValidPluginOptionalSelections } from './updateReviewPolicy';
import { bindProcessLogger, Logger } from '@/ui/logger';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { runPluginUiArtifactBuild } from '@/plugins/authoring/toolchain';
import { readInstalledPluginCatalog } from '@/plugins/projection/catalog/installed';
import { loadInstalledPlugins, loadPluginsFromState } from '@/plugins/discovery/load/installed';
import { projectPluginCatalogEntrySnapshot } from '@/plugins/projection/introspection/catalogSnapshot';

const BUNDLED_PLUGIN_ROOT = resolve(import.meta.dirname, '../../../../../packages/plugins/codex');

const roots: string[] = [];

// Replace only managed command selection and the OS subprocess boundary;
// retain the toolchain, SDK CLI, discovery and artifact publisher beneath it.
async function buildUiWithManagedProcessBoundary(
  input: Parameters<typeof runPluginUiArtifactBuild>[0],
  missingInputPath?: string,
) {
  return await runPluginUiArtifactBuild(input, {
    ensureManagedPnpmCommand: async () => null,
    managedPnpmBinPath: () => '/managed/pnpm',
    buildManagedPnpmEnvironment: (env) => env ?? {},
    ensureManagedJavaScriptRuntimeCommand: async () => '/managed/runtime',
    managedJavaScriptRuntimeBinPath: () => '/managed/runtime',
    resolveNativeTypeScriptBin: () => '/managed/compiler',
    resolvePluginUiBuildBin: () => '/managed/build-ui',
    processEnv: {},
    spawn: async (spawnInput) => {
      if (missingInputPath) {
        try { await readFile(missingInputPath); } catch (error) {
          return { exitCode: 1, signal: null, stdout: '', stderr: (error as Error).message };
        }
        throw new Error('Expected the missing process input to fail');
      }
      const { runPluginBuildUiCli } = await import('../../../../../packages/plugin-sdk/src/ui/build/bin');
      const errors: string[] = [];
      const exitCode = await runPluginBuildUiCli({ argv: spawnInput.args.slice(1), cwd: spawnInput.cwd, onError: (message) => errors.push(message) });
      return { exitCode, signal: null, stdout: '', stderr: errors.join('\n') };
    },
  });
}

type PathPreparerParams = Parameters<typeof createBaseDaemonPathPluginChangePreparer>[0];
const pathPreparerOwners = new WeakMap<
  ReturnType<typeof createBaseDaemonPathPluginChangePreparer>,
  Readonly<{ happyHomeDir: string; runtimeLifecycle: PluginRegistryRuntimeLifecycle }>
>();

/**
 * The path-preparer suite owns candidate preparation, while the daemon runtime
 * owner owns source-in-place adoption. Keep that genuine boundary in the
 * harness, but commit through the real registry authority owner so development
 * reviews exercise the same catalog/baseline state as production.
 */
function createDaemonPathPluginChangePreparer(params: PathPreparerParams) {
  const prepare = createBaseDaemonPathPluginChangePreparer({
    ...params,
    runPluginUiArtifactBuild: params.runPluginUiArtifactBuild
      ?? (async (input) => ({ ok: true as const, projectRoot: input.projectRoot, built: false })),
  });
  pathPreparerOwners.set(prepare, {
    happyHomeDir: params.happyHomeDir,
    runtimeLifecycle: params.runtimeLifecycle,
  });
  return prepare;
}

function preservePathPreparerOwner(
  source: ReturnType<typeof createBaseDaemonPathPluginChangePreparer>,
  wrapped: ReturnType<typeof createBaseDaemonPathPluginChangePreparer>,
) {
  const owner = pathPreparerOwners.get(source);
  if (owner) pathPreparerOwners.set(wrapped, owner);
  return wrapped;
}

function createDaemonPluginChangeService(
  params: Parameters<typeof createBaseDaemonPluginChangeService>[0],
) {
  const owner = pathPreparerOwners.get(params.prepare);
  return createBaseDaemonPluginChangeService({
    ...params,
    ...(owner
      ? {
          applyDevelopment: async (candidate, decision) => {
            const optionalAccess = decision
              ? updateSelectedPluginOptionalAccess({
                  pluginId: candidate.pluginId,
                  manifest: candidate.manifest,
                  existing: candidate.priorOptionalAccess ?? [],
                  decisions: decision.optionalSelections,
                  selectedAtMs: Date.now(),
                })
              : preserveValidPluginOptionalSelections(
                  candidate.pluginId,
                  candidate.manifest,
                  candidate.priorOptionalAccess ?? [],
                );
            if (!optionalAccess || candidate.registryRevision === undefined) {
              return { kind: 'failed' as const, code: 'plugin_install_trust_required' };
            }
            const principal = decision
              ? candidate.installReviewPrincipal
              : candidate.priorInstallReviewPrincipal;
            const preparedRuntime = owner.runtimeLifecycle.prepareDevelopment
              ? await owner.runtimeLifecycle.prepareDevelopment(candidate)
              : null;
            try {
              const committed = await createPluginRegistryStateStore({
                happyHomeDir: owner.happyHomeDir,
                runtimeLifecycle: owner.runtimeLifecycle,
              }).approveDevelopmentAuthorityWithResult({
                pluginId: candidate.pluginId,
                expectedRevision: candidate.registryRevision,
                approvedAuthorityManifest: candidate.manifest,
                catalogRecord: candidate.catalogRecord,
                trust: candidate.trust,
                updatePolicy: candidate.updatePolicy,
                optionalAccess,
                ...(principal
                  ? {
                      installReviewPrincipalDigest: principal.digest,
                      installReviewPrincipalPresentation: principal.presentation,
                    }
                  : {}),
              });
              if (!committed) {
                await preparedRuntime?.abort();
                return { kind: 'conflict' as const, pluginId: candidate.pluginId };
              }
              await preparedRuntime?.adopt();
              return {
                kind: 'committed' as const,
                pluginId: candidate.pluginId,
                desiredGeneration: null,
                appliedGeneration: null,
                pendingSurfaces: Object.freeze([]),
              };
            } catch (error) {
              await preparedRuntime?.abort();
              throw error;
            }
          },
        }
      : {}),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function createDescriptorPlugin(params?: Readonly<{
  pluginId?: string;
  optionalSessions?: boolean;
  daemon?: boolean;
  development?: boolean;
  reactNative?: boolean;
  requiredNetworkOrigins?: readonly string[];
}>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-plugin-change-'));
  roots.push(root);
  await mkdir(join(root, '.happier-plugin'), { recursive: true });
  const manifest = {
    schemaVersion: 2,
    id: params?.pluginId ?? 'acme.descriptor',
    version: '1.0.0',
    displayName: 'Descriptor',
    engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
    hostAccess: {
      required: params?.requiredNetworkOrigins ? [{
        id: 'api',
        capability: 'network',
        reason: 'Call the plugin API',
        scope: {
          targets: params.requiredNetworkOrigins.map((origin) => ({
            kind: 'fixedOrigin',
            origin,
          })),
        },
      }] : [],
      optional: params?.optionalSessions ? [{
        id: 'project-sessions',
        capability: 'sessions',
        reason: 'Read selected project sessions',
        scope: { access: ['read'], projectIds: ['project-a'] },
      }] : [],
    },
    ...((params?.daemon || params?.development) ? {
      entrypoints: {
        ...(params.daemon ? { daemon: './dist/index.js' } : {}),
        ...(params.development ? { development: './src/index.ts' } : {}),
      },
    } : {}),
    contributes: params?.reactNative ? {
      ui: {
        views: [],
        renderers: [{
          id: 'main-native',
          kind: 'reactNative',
          artifact: 'main-native',
          requiredHostMethods: ['context'],
        }],
        translations: [],
      },
    } : {},
  };
  await writeFile(join(root, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest));
  if (params?.development) {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'index.ts'), [
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function activate(): void {}',
      '',
    ].join('\n'), 'utf8');
  }
  await writeFile(join(root, 'payload.txt'), 'reviewed bytes');
  return root;
}

async function loadCurrentDevelopmentSentinel(input: Readonly<{
  happyHomeDir: string;
  pluginId: string;
  developmentEntryRelativePath: string;
}>): Promise<string | undefined> {
  const current = await readCurrentCommittedPluginGenerations(
    resolvePluginStorePaths({ happyHomeDir: input.happyHomeDir }),
  );
  if (!current) {
    throw new Error(`Expected current development state for ${input.pluginId}`);
  }
  const generation = current.generations.get(input.pluginId);
  if (!generation?.installation?.trust) {
    throw new Error(`Expected current trusted development generation for ${input.pluginId}`);
  }
  const developmentEntryPath = join(
    generation.rootPath,
    ...input.developmentEntryRelativePath.split('/'),
  );
  const loaded = await loadPluginModule({
    source: {
      kind: 'file_backed',
      entryPath: developmentEntryPath,
      devEntryPath: developmentEntryPath,
      useDevelopmentEntry: true,
      trustPolicy: 'prompt',
      committedAuthorization: {
        pluginId: generation.pluginId,
          immutableGenerationId: generation.immutableGenerationId,
      },
    },
    cacheKey: generation.immutableGenerationId,
  });
  return (loaded as { sentinel?: string }).sentinel;
}

describe('createDaemonPathPluginChangePreparer', () => {
  it.each(['dependencies', 'ui', 'compile', 'admission', 'runtime', 'runtimeUnavailable'] as const)('logs the original local %s failure before publishing a redacted diagnostic', async (phase) => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-development-log-'));
    const pluginRoot = await createDescriptorPlugin({ development: true });
    roots.push(happyHomeDir);
    await writeFile(join(pluginRoot, 'package.json'), '{"name":"development-diagnostic-fixture","type":"module"}', 'utf8');
    const missingPath = join(pluginRoot, 'missing-input.ts');
    if (phase === 'compile') {
      await writeFile(join(pluginRoot, 'src/index.ts'), 'import "../missing-input.ts";\n', 'utf8');
    }
    const logPath = join(happyHomeDir, 'development.log');
    const localLogger = new Logger({ logFilePath: logPath, allowDangerousRemoteLogging: false, pruneCurrentProcessLogs: false });
    const restoreLogger = bindProcessLogger(localLogger);
    const createService = phase === 'runtimeUnavailable' ? createBaseDaemonPluginChangeService : createDaemonPluginChangeService;
    const service = createService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        isRegisteredDevelopmentRoot: () => true,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
          prepareDevelopment: async () => {
            await readFile(missingPath);
            throw new Error('Expected the missing runtime input to fail');
          },
        },
        runManagedPluginPnpm: async (input) => {
          if (phase === 'dependencies') await readFile(missingPath);
          return await successfulManagedPnpmBoundary(input);
        },
        runPluginUiArtifactBuild: async (input) => await buildUiWithManagedProcessBoundary(input, phase === 'ui' ? missingPath : undefined),
      }),
    });
    try {
      let result: PluginChangeRequestResult | PluginChangeDecisionResult = await service.requestPluginChange({
        kind: 'development', sourceRootPath: pluginRoot,
        ...(phase === 'admission' ? { pluginId: 'acme.different-identity' } : {}),
      });
      if (result.kind === 'reviewRequired' && result.reviewKind === 'installation') {
        result = await service.decidePluginChange({ pendingChangeId: result.pendingChangeId, decision: 'installAndTrust' });
      }
      expect(result).toMatchObject({ kind: 'failed' });
      expect(JSON.stringify(result)).not.toContain(pluginRoot);
      localLogger.flushSync();
      const log = await readFile(logPath, 'utf8');
      expect(log).toContain('[WARN]');
      const expectedCode = phase === 'dependencies' ? 'plugin_dev_dependency_preparation_failed'
        : phase === 'ui' ? 'plugin_dev_ui_build_failed'
        : phase === 'runtime' ? 'plugin_change_failed'
        : phase === 'runtimeUnavailable' ? 'plugin_development_runtime_unavailable'
        : 'plugin_change_preparation_failed';
      expect(log).toContain(expectedCode);
      expect(log.match(/\[WARN\]/g)).toHaveLength(1);
      expect(log).toContain(JSON.stringify(pluginRoot).slice(1, -1));
      if (phase === 'dependencies' || phase === 'ui' || phase === 'runtime') expect(log).toContain(JSON.stringify(missingPath).slice(1, -1));
      if (phase === 'compile') {
        expect(log).toContain(JSON.stringify(join(pluginRoot, 'src/index.ts')).slice(1, -1));
        expect(log).toContain('../missing-input.ts');
      }
    } finally {
      await service.shutdown();
      restoreLogger();
    }
  });

  it.each([false, true])('builds code-defined development UI from the evaluated manifest (hosted UI: %s)', async (hostedUi) => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-code-ui-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-code-ui-root-'));
    roots.push(happyHomeDir, pluginRoot);
    await mkdir(join(pluginRoot, 'src'));
    await writeFile(join(pluginRoot, 'package.json'), '{"name":"code-defined-plugin","type":"module"}', 'utf8');
    const manifest = createPluginManifestV2Fixture({
      id: 'acme.code-ui',
      entrypoints: { development: './src/index.ts' },
      ...(hostedUi ? { contributes: { ui: { views: [], translations: [], renderers: [{
        id: 'panel', kind: 'hostedWeb', source: { kind: 'artifact', artifact: 'panel' }, requiredHostMethods: ['context'],
      }] } } } : {}),
    });
    await writeFile(join(pluginRoot, 'src/index.ts'), `export const manifest = ${JSON.stringify(manifest)};\nexport function activate() {}\n`, 'utf8');
    if (hostedUi) {
      await mkdir(join(pluginRoot, '.happier-plugin/ui/hosted-web/panel'), { recursive: true });
      await writeFile(join(pluginRoot, '.happier-plugin/ui/hosted-web/panel/index.html'), '<p>Current code-defined panel</p>', 'utf8');
    }
    const prepare = createBaseDaemonPathPluginChangePreparer({
      happyHomeDir,
      isRegisteredDevelopmentRoot: () => true,
      runtimeLifecycle: { prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }) },
      runManagedPluginPnpm: successfulManagedPnpmBoundary,
      runPluginUiArtifactBuild: buildUiWithManagedProcessBoundary,
    });
    const candidate = await prepare({ kind: 'development', sourceRootPath: pluginRoot, observedRevision: 1 });
    expect(candidate).toMatchObject({ kind: 'preparedDevelopmentCandidate', pluginId: 'acme.code-ui' });
    const inventory = JSON.parse(await readFile(join(pluginRoot, 'dist/happier-plugin-ui/ui-artifacts.json'), 'utf8')) as { entries: { artifactId: string }[] };
    expect(inventory.entries.map((entry) => entry.artifactId)).toEqual(hostedUi ? ['panel'] : []);
    await expect(readFile(join(pluginRoot, '.happier-plugin/plugin.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await candidate.cleanup();
    if (hostedUi) {
      const nextManifest = { ...manifest, contributes: {} };
      await writeFile(join(pluginRoot, 'src/index.ts'), `export const manifest = ${JSON.stringify(nextManifest)};\nexport function activate() {}\n`, 'utf8');
      const next = await prepare({ kind: 'development', sourceRootPath: pluginRoot, pluginId: 'acme.code-ui', observedRevision: 2, changedPaths: ['src/index.ts'] });
      const nextInventory = JSON.parse(await readFile(join(pluginRoot, 'dist/happier-plugin-ui/ui-artifacts.json'), 'utf8')) as { entries: unknown[] };
      expect(nextInventory.entries).toEqual([]);
      await expect(readFile(join(pluginRoot, 'dist/happier-plugin-ui/hosted-web/panel/index.html'))).rejects.toMatchObject({ code: 'ENOENT' });
      await next.cleanup();
    }
  });

  it.each(['packageRoot', 'singleFile'] as const)('discovers the accepted code-defined development workflow without evaluating source again (%s)', async (sourceKind) => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-workflow-discovery-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-workflow-discovery-root-'));
    roots.push(happyHomeDir, pluginRoot);
    await mkdir(join(pluginRoot, 'src'));
    await writeFile(join(pluginRoot, 'package.json'), '{"name":"workflow-discovery-plugin","type":"module"}', 'utf8');
    const sourcePath = join(pluginRoot, 'src/index.ts');
    const locator = sourceKind === 'packageRoot' ? pluginRoot : sourcePath;
    const pluginId = 'acme.workflow-discovery';
    const manifest = createPluginManifestV2Fixture({
      id: pluginId,
      contributes: { workflows: [{
        id: 'checkpoint', title: 'Checkpoint',
        definition: { version: 1, blocks: [{ kind: 'wait', id: 'review',
          document: { text: 'Review the result.', references: [], attachments: [] }, result: { kind: 'text' },
        }] },
      }] },
    });
    await writeFile(sourcePath, `export const manifest = ${JSON.stringify(manifest)};\nexport function activate() {}\n`, 'utf8');
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        isRegisteredDevelopmentRoot: () => true,
        runtimeLifecycle: { prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }) },
        runManagedPluginPnpm: successfulManagedPnpmBoundary,
      }),
    });
    try {
      const result = await service.requestPluginChange({ kind: 'development', sourceRootPath: locator, observedRevision: 1 });
      expect(result).toMatchObject({ kind: 'committed', pluginId });
      const approved = (await createPluginRegistryStateStore({ happyHomeDir }).readSnapshot()).approvedAuthorityManifestsByPluginId[pluginId]!;
      expect(approved.entrypoints?.development).toBe(sourceKind === 'packageRoot' ? './src/index.ts' : './index.ts');

      // Discovery must read the admitted projection, not run or JSON-parse
      // current author bytes before the development lifecycle accepts them.
      await writeFile(sourcePath, 'throw new Error("unaccepted source must not run during discovery");\n', 'utf8');
      const [catalogEntry] = await readInstalledPluginCatalog({ happyHomeDir });
      expect(catalogEntry?.diagnostics).toEqual([]);
      expect(catalogEntry?.manifest).toEqual(approved);
      const snapshot = projectPluginCatalogEntrySnapshot(catalogEntry!);
      expect(snapshot.diagnostics).toEqual([]);
      expect(snapshot.contributions.contributions).toContainEqual(expect.objectContaining({
        contribution: expect.objectContaining({ family: 'workflows', localId: 'checkpoint' }),
      }));
      const loaded = await loadInstalledPlugins({ happyHomeDir });
      expect(loaded.diagnosticsByPluginId[pluginId]).toEqual([]);
      expect(loaded.loadedPlugins).toHaveLength(1);
      expect(loaded.loadedPlugins[0]?.manifest).toEqual(approved);
      expect(loaded.loadedPlugins[0]?.devDaemonEntryPath).toBe(await realpath(sourcePath));
      await expect(readFile(join(pluginRoot, '.happier-plugin/plugin.json'))).rejects.toMatchObject({ code: 'ENOENT' });

      const state = await createPluginRegistryStateStore({ happyHomeDir }).read();
      const unprojected = await loadPluginsFromState(state);
      expect(unprojected.loadedPlugins).toEqual([]);
      expect(unprojected.diagnosticsByPluginId[pluginId]).toContainEqual(expect.objectContaining({ code: 'plugin_manifest_missing' }));

      const revisedManifest = { ...manifest, version: '1.0.1', contributes: {} };
      await writeFile(sourcePath, `export const manifest = ${JSON.stringify(revisedManifest)};\nexport function activate() {}\n`, 'utf8');
      const revised = await service.requestPluginChange({ kind: 'development', sourceRootPath: locator, observedRevision: 2 });
      expect(revised).toMatchObject({ kind: 'committed', pluginId });
      const [revisedCatalogEntry] = await readInstalledPluginCatalog({ happyHomeDir });
      expect(revisedCatalogEntry?.version).toBe('1.0.1');
      expect(revisedCatalogEntry?.diagnostics).toEqual([]);
      expect(revisedCatalogEntry?.contributionIntrospection.contributions).toEqual([]);
      expect((await loadInstalledPlugins({ happyHomeDir })).loadedPlugins[0]?.manifest).toEqual(revisedCatalogEntry?.manifest);
    } finally {
      await service.shutdown();
    }
  });

  it('returns an ephemeral source-in-place candidate without writing a development generation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-source-in-place-home-'));
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-in-place-root-'));
    roots.push(happyHomeDir, sourceRoot);
    const sourcePath = join(sourceRoot, 'plugin.ts');
    await writeFile(sourcePath, [
      "export const manifest = { schemaVersion: 2, id: 'acme.source-in-place', version: '1.0.0',",
      "displayName: 'Source in place', engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },",
      'hostAccess: { required: [], optional: [] }, contributes: {} };',
      'export function activate() {}',
    ].join('\n'), 'utf8');
    const runManagedPluginPnpm = vi.fn(successfulManagedPnpmBoundary);
    const prepare = createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: {
        prepare: async () => {
          throw new Error('source-in-place preparation must not enter the managed registry lifecycle');
        },
      },
      runManagedPluginPnpm,
    });

    const approval = await prepare({
      kind: 'development',
      sourceRootPath: sourcePath,
      observedRevision: 7,
      changedPaths: ['plugin.ts'],
    });
    expect(approval).toMatchObject({ kind: 'projectTrustApprovalRequired' });
    if (!('kind' in approval) || approval.kind !== 'projectTrustApprovalRequired') return;
    const candidate = await approval.continueAfterProjectTrustApproval();

    expect(candidate).toMatchObject({
      kind: 'preparedDevelopmentCandidate',
      pluginId: 'acme.source-in-place',
      sourceAuthority: {
        kind: 'development',
        observedRevision: 7,
        canonicalRoot: sourceRoot,
      },
      preparedActivationGraph: {
        rootPath: sourceRoot,
        entryPath: sourcePath,
      },
    });
    expect(runManagedPluginPnpm).not.toHaveBeenCalled();
    const generationEntries = await readdir(resolvePluginStorePaths({ happyHomeDir }).generationsDir)
      .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    expect(generationEntries).toEqual([]);
    await candidate.cleanup();
    await expect(readFile(sourcePath, 'utf8')).resolves.toContain('acme.source-in-place');
  });

  it('delegates already-registered development-root trust to the daemon root owner', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-registered-root-home-'));
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-registered-root-source-'));
    roots.push(happyHomeDir, sourceRoot);
    const sourcePath = join(sourceRoot, 'plugin.ts');
    await writeFile(sourcePath, [
      "export const manifest = { schemaVersion: 2, id: 'acme.registered-root', version: '1.0.0',",
      "displayName: 'Registered root', engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },",
      'hostAccess: { required: [], optional: [] }, contributes: {} };',
      'export function activate() {}',
    ].join('\n'), 'utf8');
    const isRegisteredDevelopmentRoot = vi.fn((path: string) => path === sourcePath);
    const prepare = createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: {
        prepare: async () => {
          throw new Error('development preparation must not enter the managed lifecycle');
        },
      },
      isRegisteredDevelopmentRoot,
      runManagedPluginPnpm: successfulManagedPnpmBoundary,
    });

    const candidate = await prepare({
      kind: 'development',
      sourceRootPath: sourcePath,
      observedRevision: 1,
    });

    expect(isRegisteredDevelopmentRoot).toHaveBeenCalledWith(sourcePath);
    expect(candidate).toMatchObject({
      kind: 'preparedDevelopmentCandidate',
      pluginId: 'acme.registered-root',
      sourceAuthority: { observedRevision: 1 },
    });
    expect(candidate).not.toHaveProperty('kind', 'projectTrustApprovalRequired');
    await candidate.cleanup();
  });

  it('never reopens review for a development change after restart, even when it widens required access', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-development-authority-restart-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({ development: true });
    await mkdir(join(pluginRoot, 'src'), { recursive: true });
    await writeFile(join(pluginRoot, 'src', 'index.ts'), 'export function activate() {}\n', 'utf8');
    const runtimeLifecycle: PluginRegistryRuntimeLifecycle = {
      prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
    };
    const createPrepare = () => createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle,
      runManagedPluginPnpm: successfulManagedPnpmBoundary,
      runPluginUiArtifactBuild: async (input) => ({
        ok: true as const,
        projectRoot: input.projectRoot,
        built: false,
      }),
    });

    const first = await createPrepare()({
      kind: 'development',
      sourceRootPath: pluginRoot,
    });
    if (!('kind' in first) || first.kind !== 'preparedDevelopmentCandidate') {
      throw new Error('Expected first development candidate');
    }
    expect(first).toMatchObject({ requiresReview: true, reviewReason: 'firstInstall' });
    await expect(createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle })
      .approveDevelopmentAuthorityWithResult({
        pluginId: first.pluginId,
        expectedRevision: first.registryRevision!,
        approvedAuthorityManifest: first.manifest,
        catalogRecord: first.catalogRecord,
        trust: first.trust,
        updatePolicy: first.updatePolicy,
        optionalAccess: [],
        installReviewPrincipalDigest: first.installReviewPrincipal!.digest,
        installReviewPrincipalPresentation: first.installReviewPrincipal!.presentation,
      })).resolves.toMatchObject({ transaction: { status: 'committed' } });
    await first.cleanup();

    const neutralAfterRestart = await createPrepare()({
      kind: 'development',
      pluginId: first.pluginId,
      sourceRootPath: pluginRoot,
      observedRevision: 2,
      changedPaths: ['src/index.ts'],
    });
    expect(neutralAfterRestart).toMatchObject({
      kind: 'preparedDevelopmentCandidate',
      requiresReview: false,
      authorityExpansion: [],
    });
    await neutralAfterRestart.cleanup();

    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    const widenedManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    widenedManifest.hostAccess = {
      required: [{
        id: 'api',
        capability: 'network',
        reason: 'Call the plugin API',
        scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }] },
      }],
      optional: [],
    };
    await writeFile(manifestPath, JSON.stringify(widenedManifest), 'utf8');

    const widenedAfterRestart = await createPrepare()({
      kind: 'development',
      pluginId: first.pluginId,
      sourceRootPath: pluginRoot,
      observedRevision: 3,
      changedPaths: ['.happier-plugin/plugin.json'],
    });
    // Development plugins never prompt on change (PPS §9 ruling (a), refined).
    expect(widenedAfterRestart).toMatchObject({
      kind: 'preparedDevelopmentCandidate',
      requiresReview: false,
      authorityExpansion: [],
    });
    await widenedAfterRestart.cleanup();
  });

  it('sets update policy through the existing transaction path without review or executable reactivation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-policy-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin();
    const preparedCandidates: PluginRegistryRuntimeCandidate[] = [];
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async (candidate) => {
            preparedCandidates.push(candidate);
            return {
              abort: async () => undefined,
              adopt: async () => Object.freeze(Object.fromEntries(
                candidate.changedPluginIds.map((pluginId) => [
                  pluginId,
                  candidate.pluginOccurrenceIds[pluginId]?.immutableGenerationId ?? null,
                ]),
              )),
            };
          },
        },
      }),
      createPendingChangeId: () => 'pending-policy-install',
    });
    const install = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    if (install.kind !== 'reviewRequired') throw new Error('Expected installation review');
    await service.decidePluginChange({
      pendingChangeId: install.pendingChangeId,
      decision: 'installAndTrust',
    });

    await expect(service.requestPluginChange({
      kind: 'setUpdatePolicy',
      pluginId: 'acme.descriptor',
      policy: 'pinned',
    })).resolves.toMatchObject({
      kind: 'committed',
      pluginId: 'acme.descriptor',
      desiredGeneration: expect.any(String),
      // Nothing was reactivated, so the runtime reports no applied generation
      // for this plugin: the served code is exactly the one already running.
      appliedGeneration: null,
    });
    expect(preparedCandidates.at(-1)).toMatchObject({
      mutationKind: 'state',
      changedPluginIds: [],
    });
    await expect(createPluginRegistryStateStore({ happyHomeDir }).read()).resolves.toMatchObject({
      plugins: { 'acme.descriptor': { install: { updatePolicy: 'pinned' } } },
    });

    await expect(service.requestPluginChange({
      kind: 'setUpdatePolicy',
      pluginId: 'acme.descriptor',
      policy: 'allowed',
    })).resolves.toMatchObject({
      kind: 'committed',
      pluginId: 'acme.descriptor',
      appliedGeneration: null,
    });
    await expect(createPluginRegistryStateStore({ happyHomeDir }).read()).resolves.toMatchObject({
      plugins: { 'acme.descriptor': { install: { updatePolicy: 'allowed' } } },
    });
    await service.shutdown();
  });

  it('threads the authenticated ordinary-versus-hard cause without inferring from mutation kind or contribution shape', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-cause-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({ daemon: true });
    await mkdir(join(pluginRoot, 'dist'), { recursive: true });
    await writeFile(join(pluginRoot, 'dist', 'index.js'), 'export function activate() {}\n', 'utf8');
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.contributes = {
      agents: [{
        id: 'assistant',
        title: 'Assistant',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: {
          sessions: {
            open: ['create'],
            delivery: ['newTurn'],
            cancel: true,
          },
        },
      }],
    };
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    const preparedCandidates: PluginRegistryRuntimeCandidate[] = [];
    const runtimeLifecycle: PluginRegistryRuntimeLifecycle = {
      prepare: async (candidate) => {
        preparedCandidates.push(candidate);
        return {
          abort: async () => undefined,
          adopt: async () => Object.freeze(Object.fromEntries(
            candidate.changedPluginIds.map((pluginId) => [
              pluginId,
              candidate.installationState.plugins[pluginId]?.enabled === true
                ? candidate.pluginOccurrenceIds[pluginId]?.immutableGenerationId ?? null
                : null,
            ]),
          )),
        };
      },
    };
    let pendingId = 0;
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle,
        runManagedPluginPnpm: successfulManagedPnpmBoundary,
      }),
      createPendingChangeId: () => `pending-cause-${pendingId += 1}`,
    });
    const apply = async (request: PluginChangeRequest): Promise<void> => {
      const result = await service.requestPluginChange(request);
      if (result.kind === 'reviewRequired') {
        const decided = await service.decidePluginChange({
          pendingChangeId: result.pendingChangeId,
          decision: 'installAndTrust',
        });
        expect(decided).toMatchObject({ kind: 'committed', pluginId: 'acme.descriptor' });
        return;
      }
      expect(result).toMatchObject({ kind: 'committed', pluginId: 'acme.descriptor' });
    };
    const observed: Array<Readonly<{
      cause: string;
      mutationKind: PluginRegistryRuntimeCandidate['mutationKind'];
      runningSessionDisposition: unknown;
      hardRevocationRevision: unknown;
    }>> = [];
    const applyAndObserve = async (
      cause: string,
      request: PluginChangeRequest,
    ): Promise<void> => {
      const before = preparedCandidates.length;
      await apply(request);
      const candidates = preparedCandidates.slice(before);
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0]!;
      observed.push({
        cause,
        mutationKind: candidate.mutationKind,
        runningSessionDisposition: Reflect.get(candidate, 'runningSessionDisposition'),
        hardRevocationRevision: Reflect.get(
          Reflect.get(candidate.installationState, 'hardRevocationRevisions') ?? {},
          'acme.descriptor',
        ) ?? 0,
      });
    };

    await apply({ kind: 'installPath', locator: pluginRoot, development: false });
    await writeFile(join(pluginRoot, 'payload.txt'), 'ordinary reviewed update', 'utf8');
    await applyAndObserve('ordinary update', {
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    await writeFile(join(pluginRoot, 'payload.txt'), 'managed rebuild', 'utf8');
    await applyAndObserve('managed rebuild', {
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    const contributionRemovalManifest = JSON.parse(
      await readFile(manifestPath, 'utf8'),
    ) as Record<string, unknown>;
    contributionRemovalManifest.contributes = {};
    await writeFile(manifestPath, JSON.stringify(contributionRemovalManifest), 'utf8');
    await applyAndObserve('ordinary contribution removal', {
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    await applyAndObserve('manual rollback', {
      kind: 'rollback',
      pluginId: 'acme.descriptor',
    });
    await applyAndObserve('disable', {
      kind: 'disable',
      pluginId: 'acme.descriptor',
    });
    await applyAndObserve('re-enable', {
      kind: 'enable',
      pluginId: 'acme.descriptor',
    });
    await applyAndObserve('forget trust', {
      kind: 'forgetTrust',
      pluginId: 'acme.descriptor',
    });
    await applyAndObserve('uninstall authority', {
      kind: 'uninstall',
      pluginId: 'acme.descriptor',
    });
    await applyAndObserve('reinstall after revocation', {
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });

    expect(observed.map(({ hardRevocationRevision: _, ...entry }) => entry)).toEqual([
      {
        cause: 'ordinary update',
        mutationKind: 'install',
        runningSessionDisposition: 'retainRunningSessions',
      },
      {
        cause: 'managed rebuild',
        mutationKind: 'install',
        runningSessionDisposition: 'retainRunningSessions',
      },
      {
        cause: 'ordinary contribution removal',
        mutationKind: 'install',
        runningSessionDisposition: 'retainRunningSessions',
      },
      {
        cause: 'manual rollback',
        mutationKind: 'rollback',
        runningSessionDisposition: 'retainRunningSessions',
      },
      {
        cause: 'disable',
        mutationKind: 'state',
        runningSessionDisposition: 'revokeRunningSessions',
      },
      {
        cause: 're-enable',
        mutationKind: 'state',
        runningSessionDisposition: 'retainRunningSessions',
      },
      {
        cause: 'forget trust',
        mutationKind: 'state',
        runningSessionDisposition: 'revokeRunningSessions',
      },
      {
        cause: 'uninstall authority',
        mutationKind: 'uninstall',
        runningSessionDisposition: 'revokeRunningSessions',
      },
      {
        cause: 'reinstall after revocation',
        mutationKind: 'install',
        runningSessionDisposition: 'retainRunningSessions',
      },
    ]);
    const hardRevocationRevisions = observed.map(
      (entry) => entry.hardRevocationRevision,
    );
    expect(hardRevocationRevisions.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(hardRevocationRevisions[4]).toEqual(expect.any(Number));
    expect(hardRevocationRevisions[4]).toBeGreaterThan(0);
    expect(hardRevocationRevisions[5]).toBe(hardRevocationRevisions[4]);
    expect(hardRevocationRevisions[6]).toEqual(expect.any(Number));
    expect(hardRevocationRevisions[6]).toBeGreaterThan(
      hardRevocationRevisions[5] as number,
    );
    expect(hardRevocationRevisions[7]).toEqual(expect.any(Number));
    expect(hardRevocationRevisions[7]).toBeGreaterThan(
      hardRevocationRevisions[6] as number,
    );
    expect(hardRevocationRevisions[8]).toBe(hardRevocationRevisions[7]);
  });

  it('prepares a regular-file development dependency closure in place before runtime adoption', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-closure-'));
    roots.push(pluginRoot);
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(pluginRoot, 'src'), { recursive: true });
    await mkdir(join(pluginRoot, 'node_modules', '.pnpm', 'runtime-dependency@1.0.0', 'node_modules', 'runtime-dependency'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'acme.dev-closure',
      version: '1.0.0',
      displayName: 'Development closure',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },
      hostAccess: { required: [], optional: [] },
      contributes: {},
    }), 'utf8');
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
      name: 'acme-dev-closure',
      version: '1.0.0',
      dependencies: { 'runtime-dependency': '1.0.0' },
      devDependencies: { 'development-only-dependency': '1.0.0' },
    }), 'utf8');
    await writeFile(join(pluginRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
    await writeFile(join(pluginRoot, '.npmrc'), '//registry.example.test/:_authToken=must-not-persist\n', 'utf8');
    await writeFile(join(pluginRoot, 'src', 'index.ts'), [
      "import { value } from 'runtime-dependency';",
      "import { value as developmentValue } from 'development-only-dependency';",
      "export const manifest = { schemaVersion: 2, id: 'acme.dev-closure', version: '1.0.0', displayName: 'Development closure', engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './dist/index.js', development: './src/index.ts' }, hostAccess: { required: [], optional: [] }, contributes: {} };",
      'export const activatedValue: string = `${value}:${developmentValue}`;',
      'export function activate(): void {}',
      '',
    ].join('\n'), 'utf8');
    const authorRuntimePackageRoot = join(
      pluginRoot,
      'node_modules',
      '.pnpm',
      'runtime-dependency@1.0.0',
      'node_modules',
      'runtime-dependency',
    );
    await writeFile(join(authorRuntimePackageRoot, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }), 'utf8');
    await writeFile(join(authorRuntimePackageRoot, 'index.js'), "export const value = 'mutable-author-value';\n", 'utf8');
    await symlink(
      join('.pnpm', 'runtime-dependency@1.0.0', 'node_modules', 'runtime-dependency'),
      join(pluginRoot, 'node_modules', 'runtime-dependency'),
      'dir',
    );

    let materializedCandidateRoot: string | undefined;
    const runManagedPluginPnpm = vi.fn(async (input: Readonly<{
      projectRoot: string;
      args: readonly string[];
      sdkRegistryOrigin?: string | null;
    }>) => {
      materializedCandidateRoot = input.projectRoot;
      const installedPackageRoot = join(input.projectRoot, 'node_modules', 'runtime-dependency');
      const installedDevelopmentPackageRoot = join(
        input.projectRoot,
        'node_modules',
        'development-only-dependency',
      );
      await mkdir(installedPackageRoot, { recursive: true });
      await mkdir(installedDevelopmentPackageRoot, { recursive: true });
      await writeFile(join(installedPackageRoot, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }), 'utf8');
      await writeFile(join(installedPackageRoot, 'index.js'), "export const value = 'materialized-runtime-value';\n", 'utf8');
      await writeFile(
        join(installedDevelopmentPackageRoot, 'package.json'),
        JSON.stringify({ type: 'module', exports: './index.js' }),
        'utf8',
      );
      await writeFile(
        join(installedDevelopmentPackageRoot, 'index.js'),
        "export const value = 'materialized-development-value';\n",
        'utf8',
      );
      return {
        ok: true as const,
        result: { exitCode: 0, signal: null, stdout: '', stderr: '' },
      };
    });
    let preparedDevelopmentEntryPath: string | undefined;
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
          prepareDevelopment: async (candidate) => {
            preparedDevelopmentEntryPath = candidate.preparedActivationGraph.entryPath;
            return { abort: async () => undefined, adopt: async () => undefined };
          },
        },
        runManagedPluginPnpm,
      }),
      createPendingChangeId: () => 'pending-development-closure',
    });
    const begun = await service.requestPluginChange({
      kind: 'development',
      sourceRootPath: pluginRoot,
    });
    if (begun.kind !== 'reviewRequired') throw new Error(`Expected review, received ${begun.kind}${begun.kind === 'failed' ? ` (${begun.code}: ${begun.message ?? ''})` : ''}`);

    const result = await service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
    });
    expect(result).toMatchObject({ kind: 'committed', pluginId: 'acme.dev-closure' });
    expect(materializedCandidateRoot).toBeDefined();
    expect(await realpath(materializedCandidateRoot!)).toBe(await realpath(pluginRoot));
    await expect(lstat(materializedCandidateRoot!)).resolves.toBeDefined();
    expect(runManagedPluginPnpm).toHaveBeenCalledWith({
      projectRoot: await realpath(pluginRoot),
      args: [
        'install',
        '--ignore-scripts',
        '--frozen-lockfile',
      ],
      sdkRegistryOrigin: null,
    });
    await expect(readFile(join(pluginRoot, 'node_modules', 'development-only-dependency', 'index.js'), 'utf8'))
      .resolves.toContain('materialized-development-value');
    await expect(readFile(join(pluginRoot, '.npmrc'), 'utf8')).resolves.toContain('must-not-persist');
    await expect(readFile(join(pluginRoot, 'pnpm-lock.yaml'), 'utf8')).resolves.toContain('lockfileVersion');
    expect(preparedDevelopmentEntryPath).toBe(await realpath(join(pluginRoot, 'src', 'index.ts')));
    await expect(createPluginRegistryStateStore({ happyHomeDir }).read()).resolves.toMatchObject({
      plugins: {
        'acme.dev-closure': {
          source: { kind: 'path', devWatch: true },
        },
      },
    });
    await expect(createPluginRegistryStateStore({ happyHomeDir }).readSnapshot()).resolves.toMatchObject({
      approvedAuthorityManifestsByPluginId: {
        'acme.dev-closure': { id: 'acme.dev-closure', version: '1.0.0' },
      },
    });
  });

  it('rebuilds repeated development candidates while preserving their reviewed source snapshots', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({
      pluginId: 'acme.repeated-development',
      development: true,
    });
    await mkdir(join(pluginRoot, 'src'), { recursive: true });
    const entryPath = join(pluginRoot, 'src', 'index.ts');
    const sourceForSentinel = (sentinel: string) => [
      "export const manifest = { schemaVersion: 2, id: 'acme.repeated-development', version: '1.0.0', displayName: 'Descriptor', engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { development: './src/index.ts' }, hostAccess: { required: [], optional: [] }, contributes: {} };",
      `export const sentinel = '${sentinel}';`,
      'export function activate(): void {}',
      '',
    ].join('\n');
    await writeFile(entryPath, sourceForSentinel('before'), 'utf8');
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
      name: 'happier-plugin-acme-repeated-development',
      version: '0.1.0',
      dependencies: { 'fixture-dependency': '1.0.0' },
    }), 'utf8');

    const runManagedPluginPnpm = vi.fn(async (input: Readonly<{
      projectRoot: string;
    }>) => {
      await mkdir(join(input.projectRoot, 'node_modules', 'fixture-dependency'), { recursive: true });
      await writeFile(
        join(input.projectRoot, 'node_modules', 'fixture-dependency', 'index.js'),
        "export const dependency = 'installed-once';\n",
        'utf8',
      );
      return await successfulManagedPnpmBoundary();
    });
    const appliedSentinels: string[] = [];
    const prepare = createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: {
        prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        prepareDevelopment: async (candidate) => {
          const preparedSource = await readFile(candidate.preparedActivationGraph.entryPath, 'utf8');
          appliedSentinels.push(/export const sentinel = '([^']+)'/.exec(preparedSource)?.[1] ?? 'missing');
          return { abort: async () => undefined, adopt: async () => undefined };
        },
      },
      runManagedPluginPnpm,
    });
    const preservedReviewResults: Array<unknown> = [];
    const service = createDaemonPluginChangeService({
      prepare: preservePathPreparerOwner(prepare, async (request) => {
        const prepared = await prepare(request);
        if (request.kind === 'development' && request.changedPaths?.[0] === 'src/index.ts') {
          preservedReviewResults.push(prepared.review);
        }
        return prepared;
      }),
      createPendingChangeId: () => 'pending-repeated-development',
    });
    const initial = await service.requestPluginChange({
      kind: 'development',
      sourceRootPath: pluginRoot,
    });
    if (initial.kind !== 'reviewRequired') throw new Error(`Expected initial review, received ${initial.kind}${initial.kind === 'failed' ? ` (${initial.code}: ${initial.message ?? ''})` : ''}`);
    await service.decidePluginChange({
      pendingChangeId: initial.pendingChangeId,
      decision: 'installAndTrust',
    });
    expect(appliedSentinels).toEqual(['before']);
    appliedSentinels.length = 0;
    runManagedPluginPnpm.mockClear();

    let observerFailure: unknown;
    const observer = await startPluginDevelopmentSourceObserver({
      projectRoot: pluginRoot,
      debounceMs: 25,
      async onObservation(observation) {
        if (!observation.ok) {
          observerFailure = new Error(observation.diagnostics.map((entry) => entry.message).join('\n'));
          return 'retained';
        }
        if (observation.request.changedPaths === undefined) return 'adopted';
        try {
          const result = await service.requestPluginChange({
            kind: 'development',
            pluginId: observation.request.pluginId,
            sourceRootPath: observation.request.projectRoot,
            changedPaths: observation.request.changedPaths,
          });
          if (result.kind !== 'committed') {
            throw new Error(`Unexpected package-root development update: ${result.kind}`);
          }
          return 'adopted';
        } catch (error) {
          observerFailure = error;
          return 'retained';
        }
      },
    });
    const editToInvocationDurationsMs: number[] = [];
    try {
      for (let edit = 1; edit <= 10; edit += 1) {
        const sentinel = `edit-${edit}`;
        const startedAt = performance.now();
        await writeFile(
          entryPath,
          sourceForSentinel(sentinel),
          'utf8',
        );
        await vi.waitFor(() => {
          if (observerFailure) throw observerFailure;
          expect(appliedSentinels.at(-1)).toBe(sentinel);
        }, { timeout: 10_000, interval: 25 });
        expect(runManagedPluginPnpm).not.toHaveBeenCalled();
        await expect(readFile(
          join(pluginRoot, 'node_modules', 'fixture-dependency', 'index.js'),
          'utf8',
        )).resolves.toContain('installed-once');
        editToInvocationDurationsMs.push(performance.now() - startedAt);
      }
    } finally {
      observer.stop();
    }
    await new Promise<void>((resolveStopped) => setTimeout(resolveStopped, 100));
    expect(preservedReviewResults).toEqual(Array.from({ length: 10 }, () => undefined));
    if (process.env.HAPPIER_REPORT_PLUGIN_DEV_TIMING === '1') {
      const sorted = [...editToInvocationDurationsMs].sort((left, right) => left - right);
      const median = (sorted[4]! + sorted[5]!) / 2;
      const p95 = sorted[9]!;
      console.info(JSON.stringify({
        fixture: 'dependency-bearing-package-root',
        samples: sorted.length,
        medianMs: Math.round(median * 100) / 100,
        p95Ms: Math.round(p95 * 100) / 100,
      }));
    }

    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
      name: 'happier-plugin-acme-repeated-development',
      version: '0.1.0',
      dependencies: { 'fixture-dependency': '1.0.0' },
    }), 'utf8');
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.repeated-development',
      sourceRootPath: pluginRoot,
      changedPaths: ['.\\package.json'],
    })).resolves.toMatchObject({
      kind: 'committed',
      pluginId: 'acme.repeated-development',
    });
    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
    expect(runManagedPluginPnpm).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining(['install']),
    }));

    await writeFile(
      entryPath,
      sourceForSentinel('after-dependency-change'),
      'utf8',
    );
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.repeated-development',
      sourceRootPath: pluginRoot,
      changedPaths: ['src/index.ts'],
    })).resolves.toMatchObject({
      kind: 'committed',
      pluginId: 'acme.repeated-development',
    });
    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
  });

  it('serializes overlapping neutral source-only adoptions through the current authority state', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-development-currentness-home-'));
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-development-currentness-source-'));
    roots.push(happyHomeDir, sourceRoot);
    const pluginId = 'acme.development-currentness';
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({
      name: 'acme-development-currentness',
      version: '1.0.0',
    }), 'utf8');
    await writeFile(join(sourceRoot, 'src', 'index.ts'), [
      'export const manifest = {',
      `  schemaVersion: 2, id: '${pluginId}', version: '1.0.0',`,
      "  displayName: 'Development currentness', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
      '  hostAccess: { required: [], optional: [] }, contributes: {},',
      '};',
      'export function activate(): void {}',
      '',
    ].join('\n'), 'utf8');
    await writeFile(join(sourceRoot, 'src', 'a.ts'), "export const value = 'g';\n", 'utf8');
    await writeFile(join(sourceRoot, 'src', 'b.ts'), "export const value = 'g';\n", 'utf8');

    let releaseFirstSourceOnlyBuild!: () => void;
    const firstSourceOnlyBuildBlocked = new Promise<void>((resolve) => {
      releaseFirstSourceOnlyBuild = resolve;
    });
    let signalFirstSourceOnlyBuild!: () => void;
    const firstSourceOnlyBuildStarted = new Promise<void>((resolve) => {
      signalFirstSourceOnlyBuild = resolve;
    });
    let pauseNextDevelopmentBuild = false;
    const runPluginUiArtifactBuild = vi.fn(async (input: Readonly<{ projectRoot: string }>) => {
      if (pauseNextDevelopmentBuild) {
        pauseNextDevelopmentBuild = false;
        signalFirstSourceOnlyBuild();
        await firstSourceOnlyBuildBlocked;
      }
      return { ok: true as const, projectRoot: input.projectRoot, built: true };
    });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        runManagedPluginPnpm: vi.fn(successfulManagedPnpmBoundary),
        runPluginUiArtifactBuild,
      }),
      createPendingChangeId: () => 'pending-development-currentness',
    });
    const readCurrentRevision = async () => (
      (await readPluginRegistryCommitRecord(resolvePluginStorePaths({ happyHomeDir })))
        ?.installationState.revisionId ?? null
    );

    const initial = await service.requestPluginChange({
      kind: 'development',
      sourceRootPath: sourceRoot,
    });
    if (initial.kind !== 'reviewRequired' || initial.reviewKind !== 'projectTrust') {
      throw new Error(`Expected source-root review, received ${initial.kind}`);
    }
    await expect(service.decidePluginChange({
      pendingChangeId: initial.pendingChangeId,
      decision: 'installAndTrust', optionalSelections: [],
    })).resolves.toMatchObject({ kind: 'committed', pluginId });
    const revisionG = await readCurrentRevision();

    pauseNextDevelopmentBuild = true;
    await writeFile(join(sourceRoot, 'src', 'a.ts'), "export const value = 'a';\n", 'utf8');
    const staleA = service.requestPluginChange({
      kind: 'development',
      pluginId,
      sourceRootPath: sourceRoot,
      changedPaths: ['src/a.ts'],
    });
    await firstSourceOnlyBuildStarted;

    await writeFile(join(sourceRoot, 'src', 'b.ts'), "export const value = 'b';\n", 'utf8');
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId,
      sourceRootPath: sourceRoot,
      changedPaths: ['src/b.ts'],
    })).resolves.toMatchObject({ kind: 'committed', pluginId });
    const revisionH = await readCurrentRevision();
    expect(revisionH).not.toBe(revisionG);

    releaseFirstSourceOnlyBuild();
    await expect(staleA).resolves.toMatchObject({ kind: 'committed', pluginId });
    expect(await readCurrentRevision()).not.toBe(revisionH);

    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId,
      sourceRootPath: sourceRoot,
      changedPaths: ['src/a.ts'],
    })).resolves.toMatchObject({ kind: 'committed', pluginId });
    expect(await readCurrentRevision()).not.toBe(revisionH);
    await expect(readFile(join(sourceRoot, 'src', 'a.ts'), 'utf8')).resolves.toContain("'a'");
    await expect(readFile(join(sourceRoot, 'src', 'b.ts'), 'utf8')).resolves.toContain("'b'");
  });

  it('evaluates and adopts a literal one-file development source without author JSON or package installation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-one-file-home-'));
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-one-file-source-'));
    roots.push(happyHomeDir, sourceRoot);
    const sourcePath = join(sourceRoot, 'plugin.ts');
    const writeSource = async (sentinel: string): Promise<void> => {
      await writeFile(sourcePath, [
        'export const manifest = {',
        "  schemaVersion: 2, id: 'acme.one-file-live', version: '1.0.0',",
        "  displayName: 'One file live', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        '  hostAccess: { required: [], optional: [] }, contributes: {},',
        '};',
        `export const sentinel = '${sentinel}';`,
        'export function activate(): void {}',
        '',
      ].join('\n'), 'utf8');
    };
    await writeSource('before');
    const runManagedPluginPnpm = vi.fn(successfulManagedPnpmBoundary);
    const preparedSentinels: string[] = [];
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async (candidate) => ({
            abort: async () => undefined,
            adopt: async () => Object.freeze(Object.fromEntries(
              candidate.changedPluginIds.map((pluginId) => [
                pluginId,
                candidate.pluginOccurrenceIds[pluginId]?.immutableGenerationId ?? null,
              ]),
            )),
          }),
          prepareDevelopment: async (candidate) => {
            const preparedSource = await readFile(candidate.preparedActivationGraph.entryPath, 'utf8');
            preparedSentinels.push(/export const sentinel = '([^']+)'/.exec(preparedSource)?.[1] ?? 'missing');
            return { abort: async () => undefined, adopt: async () => undefined };
          },
        },
        runManagedPluginPnpm,
      }),
      createPendingChangeId: () => 'pending-one-file-live',
    });

    const appliedSentinels: string[] = [];
    const observer = await startPluginDevelopmentSourceObserver({
      projectRoot: sourcePath,
      debounceMs: 25,
      async onObservation(observation): Promise<PluginDevelopmentSourceObservationDelivery> {
        if (!observation.ok) {
          throw new Error(observation.diagnostics.map((entry) => entry.message).join('\n'));
        }
        let result: PluginChangeRequestResult | PluginChangeDecisionResult = await service.requestPluginChange({
          kind: 'development',
          sourceRootPath: observation.request.projectRoot,
          ...(observation.request.changedPaths
            ? { changedPaths: observation.request.changedPaths }
            : {}),
        });
        if (result.kind === 'reviewRequired' && result.reviewKind === 'projectTrust') {
          result = await service.decidePluginChange({
            pendingChangeId: result.pendingChangeId,
            decision: 'installAndTrust', optionalSelections: [],
          });
        }
        if (result.kind === 'reviewRequired') {
          result = await service.decidePluginChange({
            pendingChangeId: result.pendingChangeId,
            decision: 'installAndTrust',
          });
        }
        if (result.kind !== 'committed') throw new Error(`Unexpected one-file update: ${result.kind}`);
        appliedSentinels.push(preparedSentinels.at(-1) ?? 'missing');
        return 'adopted';
      },
    });
    const editToInvocationDurationsMs: number[] = [];
    try {
      expect(appliedSentinels).toEqual(['before']);
      expect(runManagedPluginPnpm).not.toHaveBeenCalled();
      await new Promise<void>((resolveReady) => setTimeout(resolveReady, 100));
      for (let edit = 1; edit <= 10; edit += 1) {
        const sentinel = `edit-${edit}`;
        const startedAt = performance.now();
        await writeSource(sentinel);
        await vi.waitFor(
          () => expect(appliedSentinels.at(-1)).toBe(sentinel),
          { timeout: 10_000, interval: 25 },
        );
        expect(runManagedPluginPnpm).not.toHaveBeenCalled();
        editToInvocationDurationsMs.push(performance.now() - startedAt);
      }
    } finally {
      observer.stop();
    }

    if (process.env.HAPPIER_REPORT_PLUGIN_DEV_TIMING === '1') {
      const sorted = [...editToInvocationDurationsMs].sort((left, right) => left - right);
      const median = (sorted[4]! + sorted[5]!) / 2;
      const p95 = sorted[9]!;
      console.info(JSON.stringify({
        fixture: 'one-file-typescript',
        samples: sorted.length,
        medianMs: Math.round(median * 100) / 100,
        p95Ms: Math.round(p95 * 100) / 100,
      }));
    }

    await expect(createPluginRegistryStateStore({ happyHomeDir }).read()).resolves.toMatchObject({
      plugins: {
        'acme.one-file-live': {
          source: { kind: 'path', devWatch: true, resolvedPath: await realpath(sourceRoot) },
        },
      },
    });
    await expect(createPluginRegistryStateStore({ happyHomeDir }).readSnapshot()).resolves.toMatchObject({
      approvedAuthorityManifestsByPluginId: {
        'acme.one-file-live': { id: 'acme.one-file-live' },
      },
    });
    await expect(readFile(sourcePath, 'utf8')).resolves.toContain("sentinel = 'edit-10'");
  });

  it('requires one remembered project trust confirmation before activating a one-file development plugin', async () => {
    const approvalWindowStartMs = Date.now();
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-one-file-trust-home-'));
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-one-file-trust-source-'));
    roots.push(happyHomeDir, sourceRoot);
    const counterPath = join(sourceRoot, 'evaluations.log');
    const sourcePath = join(sourceRoot, 'plugin.ts');
    await writeFile(sourcePath, [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(counterPath)}, 'module\\n');`,
      'export const manifest = {',
      "  schemaVersion: 2, id: 'acme.one-file-trust', version: '1.0.0',",
      "  displayName: 'One file trust', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
      '  hostAccess: { required: [], optional: [] }, contributes: {},',
      '};',
      `export function activate(): void { appendFileSync(${JSON.stringify(counterPath)}, 'activate\\n'); }`,
      '',
    ].join('\n'), 'utf8');

    const preparedDevelopmentCandidates: PluginDevelopmentRuntimeCandidate[] = [];
    let pendingChangeSequence = 0;
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
          prepareDevelopment: async (candidate) => {
            preparedDevelopmentCandidates.push(candidate);
            return { abort: async () => undefined, adopt: async () => undefined };
          },
        },
        runManagedPluginPnpm: vi.fn(successfulManagedPnpmBoundary),
      }),
      createPendingChangeId: () => `pending-one-file-source-trust-${pendingChangeSequence += 1}`,
    });

    const cancelled = await service.requestPluginChange({
      kind: 'development',
      sourceRootPath: sourcePath,
    });
    if (cancelled.kind === 'failed') throw new Error(cancelled.message ?? cancelled.code);
    expect(cancelled).toMatchObject({
      kind: 'reviewRequired', reviewKind: 'projectTrust',
      review: { source: { kind: 'path', locator: await realpath(sourcePath) } },
    });
    await expect(readFile(counterPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    if (cancelled.kind !== 'reviewRequired' || cancelled.reviewKind !== 'projectTrust') return;
    await expect(service.decidePluginChange({
      pendingChangeId: cancelled.pendingChangeId,
      decision: 'cancel',
    })).resolves.toEqual({ kind: 'cancelled' });
    await expect(readFile(counterPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const confirmations = vi.fn(async (_message: string) => true);
    const observedRequests: PluginChangeRequestResult[] = [];
    const observedDecisions: PluginChangeDecisionResult[] = [];
    const requestChange = vi.fn(async (request: PluginChangeRequest) => {
      const result = await service.requestPluginChange(request);
      observedRequests.push(result);
      return result;
    });
    const decideChange = vi.fn(async (decision) => {
      const result = await service.decidePluginChange(decision);
      observedDecisions.push(result);
      return result;
    });

    await expect(requestUserPluginChange({
      request: { kind: 'development', sourceRootPath: sourcePath },
      approval: 'prompt',
    }, {
      ensureDaemon: async () => undefined,
      confirm: confirmations,
      requestChange,
      decideChange,
    })).resolves.toMatchObject({
      kind: 'committed',
      pluginId: 'acme.one-file-trust',
    });

    const initial = observedRequests[0];
    expect(initial).toMatchObject({ kind: 'reviewRequired', reviewKind: 'projectTrust' });
    if (initial?.kind !== 'reviewRequired' || initial.reviewKind !== 'projectTrust') return;
    expect(observedDecisions[0]).toMatchObject({
      kind: 'committed',
      pluginId: 'acme.one-file-trust',
    });
    expect(decideChange).toHaveBeenNthCalledWith(1, {
      pendingChangeId: initial.pendingChangeId,
      decision: 'installAndTrust', optionalSelections: [],
    });
    expect(confirmations.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('Trust this plugin project source?'),
    ]);
    // The decision carried no timestamp of its own, so the persisted approval
    // time can only have come from the daemon clock at apply time.
    const trustedState = await createPluginRegistryStateStore({ happyHomeDir }).read();
    expect(trustedState.plugins['acme.one-file-trust']?.install.trust?.approvedAtMs)
      .toBeGreaterThanOrEqual(approvalWindowStartMs);
    expect(await readFile(counterPath, 'utf8')).toBe('module\n');
    expect(preparedDevelopmentCandidates).toHaveLength(1);
    expect(preparedDevelopmentCandidates[0]?.preparedActivationGraph.module.activate)
      .toEqual(expect.any(Function));
  });

  it('separates initial project code trust from required authority and undisclosed optional access', async () => {
    const approvalWindowStartMs = Date.now();
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-one-file-optional-home-'));
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-one-file-optional-source-'));
    roots.push(happyHomeDir, sourceRoot);
    const sourcePath = join(sourceRoot, 'plugin.ts');
    const writeSource = async (sentinel: string): Promise<void> => {
      await writeFile(sourcePath, [
        'export const manifest = {',
        "  schemaVersion: 2, id: 'acme.one-file-optional', version: '1.0.0',",
        "  displayName: 'One file optional', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        '  hostAccess: { required: [{',
        "    id: 'api', capability: 'network', reason: 'Call the plugin API',",
        "    scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }] },",
        '  }], optional: [{',
        "    id: 'project-sessions', capability: 'sessions', reason: 'Read selected project sessions',",
        "    scope: { access: ['read'], projectIds: ['project-a'] },",
        '  }] }, contributes: {},',
        '};',
        `export const sentinel = '${sentinel}';`,
        'export function activate(): void {}',
        '',
      ].join('\n'), 'utf8');
    };
    await writeSource('initial');
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async (candidate) => ({
            abort: async () => undefined,
            adopt: async () => Object.freeze(Object.fromEntries(
              candidate.changedPluginIds.map((pluginId) => [
                pluginId,
                candidate.pluginOccurrenceIds[pluginId]?.immutableGenerationId ?? null,
              ]),
            )),
          }),
        },
      }),
      createPendingChangeId: () => 'pending-one-file-optional',
    });

    const requested = await service.requestPluginChange({
      kind: 'development',
      sourceRootPath: sourcePath,
    });
    if (requested.kind !== 'reviewRequired' || requested.reviewKind !== 'projectTrust') {
      throw new Error(`Expected source-root review, received ${requested.kind}`);
    }
    const authorityReview = await service.decidePluginChange({
      pendingChangeId: requested.pendingChangeId,
      decision: 'installAndTrust', optionalSelections: [],
    });
    expect(authorityReview).toMatchObject({
      kind: 'reviewRequired',
      reviewKind: 'installation',
      reason: 'authorityExpansion',
      authorityExpansion: expect.arrayContaining(['requiredHostAccess']),
      review: { pluginId: 'acme.one-file-optional' },
    });
    if (authorityReview.kind !== 'reviewRequired' || authorityReview.reviewKind !== 'installation') return;
    await expect(service.decidePluginChange({
      pendingChangeId: authorityReview.pendingChangeId,
      decision: 'installAndTrust', optionalSelections: [],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.one-file-optional' });

    // Project trust admits the code but does not silently select an optional
    // host resource that was not part of the project-trust disclosure.
    const approvedState = await createPluginRegistryStateStore({ happyHomeDir }).read();
    const approvedInstall = approvedState.plugins['acme.one-file-optional']?.install;
    expect(approvedInstall?.trust?.approvedAtMs).toBeGreaterThanOrEqual(approvalWindowStartMs);
    expect(approvedInstall?.optionalAccess).toEqual([]);

    await writeSource('updated');
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.one-file-optional',
      sourceRootPath: sourcePath,
      changedPaths: ['plugin.ts'],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.one-file-optional' });
    // A source-only edit reuses the reviewed approval rather than restamping it.
    await expect(createPluginRegistryStateStore({ happyHomeDir }).read()).resolves.toMatchObject({
      plugins: {
        'acme.one-file-optional': {
          install: {
            trust: { approvedAtMs: approvedInstall?.trust?.approvedAtMs },
            optionalAccess: [],
          },
        },
      },
    });
  });

  it('evaluates dependency-bearing code roots once from the exact adopted generation graph', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-owned-graph-home-'));
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-owned-graph-source-'));
    roots.push(happyHomeDir, sourceRoot);
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({
      name: 'acme-owned-graph',
      version: '1.0.0',
      dependencies: { 'fixture-dependency': '1.0.0' },
    }), 'utf8');
    const logPath = join(sourceRoot, 'evaluations.log');
    await writeFile(join(sourceRoot, 'src', 'leaf.ts'), [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(logPath)}, 'leaf\\n');`,
      'export const marker = Object.freeze({ value: 1 });',
      '',
    ].join('\n'), 'utf8');
    const writeEntry = async (
      version: string,
      pluginId = 'acme.owned-graph',
    ): Promise<void> => {
      await writeFile(join(sourceRoot, 'src', 'index.ts'), [
        "import { appendFileSync } from 'node:fs';",
        "import { marker } from './leaf';",
        `appendFileSync(${JSON.stringify(logPath)}, 'module:${version}\\n');`,
        'export const manifest = {',
        `  schemaVersion: 2, id: '${pluginId}', version: '1.0.0',`,
        "  displayName: 'Owned graph', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        '  hostAccess: { required: [], optional: [] }, contributes: {},',
        '};',
        `export function activate(): object { appendFileSync(${JSON.stringify(logPath)}, 'activate:${version}\\n'); return marker; }`,
        '',
      ].join('\n'), 'utf8');
    };
    await writeEntry('initial');

    const preparedRoots: string[] = [];
    const runManagedPluginPnpm = vi.fn(async (input: Readonly<{ projectRoot: string }>) => {
      const dependencyRoot = join(input.projectRoot, 'node_modules', 'fixture-dependency');
      await mkdir(dependencyRoot, { recursive: true });
      await writeFile(join(dependencyRoot, 'index.js'), "export const retained = 'dependency';\n", 'utf8');
      return await successfulManagedPnpmBoundary();
    });
    const prepare = createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runManagedPluginPnpm,
      runtimeLifecycle: {
        prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        prepareDevelopment: async (candidate) => {
          const graph = candidate.preparedActivationGraph;
          const rootPath = graph.rootPath;
          preparedRoots.push(rootPath);
          const leaf = await loadVerifiedPluginModule({
            entryPath: join(rootPath, 'src', 'leaf.ts'),
            loadMode: 'source-ts',
            generationScope: graph.candidateScope,
          });
          const activate = graph.module.activate;
          if (typeof activate !== 'function') throw new Error('Expected activation export');
          expect(activate()).toBe(leaf.marker);
          return { abort: async () => undefined, adopt: async () => undefined };
        },
      },
    });
    const service = createDaemonPluginChangeService({
      prepare,
      createPendingChangeId: () => 'pending-owned-graph',
    });

    const unapproved = await service.requestPluginChange({
      kind: 'development',
      sourceRootPath: sourceRoot,
    });
    if (unapproved.kind === 'failed') throw new Error(unapproved.message ?? unapproved.code);
    expect(unapproved.kind).toBe('reviewRequired');
    await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    if (unapproved.kind !== 'reviewRequired' || unapproved.reviewKind !== 'projectTrust') return;
    await expect(service.decidePluginChange({
      pendingChangeId: unapproved.pendingChangeId,
      decision: 'installAndTrust', optionalSelections: [],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.owned-graph' });
    expect(await readFile(logPath, 'utf8')).toBe('leaf\nmodule:initial\nactivate:initial\n');
    expect(await Promise.all(preparedRoots.map(async (path) => await realpath(path)))).toEqual([
      await realpath(sourceRoot),
    ]);

    runManagedPluginPnpm.mockClear();
    await writeEntry('manual-source-edit');
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.owned-graph',
      sourceRootPath: sourceRoot,
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.owned-graph' });
    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
    expect(await readFile(logPath, 'utf8')).toBe([
      'leaf', 'module:initial', 'activate:initial',
      'leaf', 'module:manual-source-edit', 'activate:manual-source-edit', '',
    ].join('\n'));

    await writeEntry('source-edit');
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.owned-graph',
      sourceRootPath: sourceRoot,
      changedPaths: ['src/index.ts'],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.owned-graph' });
    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
    await expect(readFile(
      join(sourceRoot, 'node_modules', 'fixture-dependency', 'index.js'),
      'utf8',
    )).resolves.toContain("retained = 'dependency'");
    expect(await readFile(logPath, 'utf8')).toBe([
      'leaf', 'module:initial', 'activate:initial',
      'leaf', 'module:manual-source-edit', 'activate:manual-source-edit',
      'leaf', 'module:source-edit', 'activate:source-edit', '',
    ].join('\n'));

    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({
      name: 'acme-owned-graph',
      version: '1.0.0',
      dependencies: { 'fixture-dependency': '1.0.0' },
    }), 'utf8');
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.owned-graph',
      sourceRootPath: sourceRoot,
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.owned-graph' });
    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(2);

    const revisionBeforeConflict = (await readPluginRegistryCommitRecord(
      resolvePluginStorePaths({ happyHomeDir }),
    ))?.installationState.revisionId;
    await writeEntry('identity-conflict', 'acme.substituted-graph');
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.owned-graph',
      sourceRootPath: sourceRoot,
      changedPaths: ['src/index.ts'],
    })).resolves.toMatchObject({
      kind: 'failed',
      code: 'plugin_change_preparation_failed',
      message: expect.stringContaining("identity changed from 'acme.owned-graph' to 'acme.substituted-graph'"),
    });
    expect((await readPluginRegistryCommitRecord(
      resolvePluginStorePaths({ happyHomeDir }),
    ))?.installationState.revisionId).toBe(revisionBeforeConflict);
    expect(await readFile(logPath, 'utf8')).toContain('module:identity-conflict\n');
    expect(await readFile(logPath, 'utf8')).not.toContain('activate:identity-conflict\n');
  });

  it('builds the full daemon-owned development closure, including dev imports and fresh UI bytes, before adoption', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-development-closure-home-'));
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-development-closure-source-'));
    roots.push(happyHomeDir, sourceRoot);
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    const writePackage = async (additionalDependencies: readonly string[]): Promise<void> => {
      await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({
        name: 'acme-development-closure',
        version: '1.0.0',
        devDependencies: {
          'fixture-dev-dependency': '1.0.0',
          ...Object.fromEntries(additionalDependencies.map((name) => [name, '1.0.0'])),
        },
      }), 'utf8');
    };
    const writeEntry = async (additionalDependencies: readonly string[]): Promise<void> => {
      await writeFile(join(sourceRoot, 'src', 'index.ts'), [
        "import { value as devValue } from 'fixture-dev-dependency';",
        ...additionalDependencies.map((name, index) => (
          `import { value as addedValue${index} } from '${name}';`
        )),
        'export const manifest = {',
        "  schemaVersion: 2, id: 'acme.development-closure', version: '1.0.0',",
        "  displayName: 'Development closure', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        '  hostAccess: { required: [], optional: [] }, contributes: {},',
        '};',
        `export const importedDependency = [devValue${additionalDependencies.map((_, index) => `, addedValue${index}`).join('')}].join(':');`,
        'export function activate(): void {}',
        '',
      ].join('\n'), 'utf8');
    };
    await writePackage([]);
    await writeEntry([]);
    await writeFile(join(sourceRoot, 'src', 'ui-byte.txt'), 'first-ui-byte\n', 'utf8');

    const runManagedPluginPnpm = vi.fn<RunManagedPluginPnpmBoundary>(async (input) => {
      const packageJson = JSON.parse(await readFile(join(input.projectRoot, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const dependencies = {
        ...(packageJson.dependencies ?? {}),
        ...(!input.args.includes('--prod') ? packageJson.devDependencies ?? {} : {}),
      };
      for (const packageName of Object.keys(dependencies)) {
        const packageRoot = join(input.projectRoot, 'node_modules', packageName);
        await mkdir(packageRoot, { recursive: true });
        await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
          name: packageName,
          type: 'module',
          exports: './index.js',
        }), 'utf8');
        await writeFile(join(packageRoot, 'index.js'), `export const value = ${JSON.stringify(packageName)};\n`, 'utf8');
      }
      return await successfulManagedPnpmBoundary();
    });
    const uiBuildRoots: string[] = [];
    const runPluginUiArtifactBuild = vi.fn(async (input: Readonly<{ projectRoot: string }>) => {
      uiBuildRoots.push(input.projectRoot);
      const uiByte = await readFile(join(input.projectRoot, 'src', 'ui-byte.txt'), 'utf8');
      const artifactRoot = join(input.projectRoot, 'dist', 'happier-plugin-ui');
      await mkdir(artifactRoot, { recursive: true });
      await writeFile(join(artifactRoot, 'ui-byte.txt'), uiByte, 'utf8');
      return { ok: true as const, projectRoot: input.projectRoot, built: true };
    });
    const runtimeLifecycle = {
      prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
    };
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle,
        runManagedPluginPnpm,
        runPluginUiArtifactBuild,
      }),
      createPendingChangeId: () => 'pending-development-closure',
    });

    const sourceRootReview = await service.requestPluginChange({
      kind: 'development',
      sourceRootPath: sourceRoot,
    });
    expect(sourceRootReview.kind).toBe('reviewRequired');
    if (sourceRootReview.kind !== 'reviewRequired' || sourceRootReview.reviewKind !== 'projectTrust') return;
    await expect(service.decidePluginChange({
      pendingChangeId: sourceRootReview.pendingChangeId,
      decision: 'installAndTrust', optionalSelections: [],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.development-closure' });
    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
    expect(runManagedPluginPnpm.mock.calls[0]?.[0]?.args).not.toContain('--prod');
    expect(uiBuildRoots).toHaveLength(1);

    runManagedPluginPnpm.mockClear();
    await writeFile(join(sourceRoot, 'src', 'ui-byte.txt'), 'second-ui-byte\n', 'utf8');
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.development-closure',
      sourceRootPath: sourceRoot,
      changedPaths: ['src/ui-byte.txt'],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.development-closure' });
    expect(runManagedPluginPnpm).not.toHaveBeenCalled();
    expect(uiBuildRoots).toHaveLength(2);
    expect(await realpath(uiBuildRoots[1]!)).toBe(await realpath(sourceRoot));
    await expect(readFile(
      join(sourceRoot, 'dist', 'happier-plugin-ui', 'ui-byte.txt'),
      'utf8',
    )).resolves.toBe('second-ui-byte\n');

    runManagedPluginPnpm.mockClear();
    await writePackage(['fixture-added-dependency']);
    await writeEntry(['fixture-added-dependency']);
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.development-closure',
      sourceRootPath: sourceRoot,
      changedPaths: ['package.json', 'src/index.ts'],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.development-closure' });
    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
    expect(runManagedPluginPnpm.mock.calls[0]?.[0]?.args).not.toContain('--prod');
    await expect(readFile(
      join(sourceRoot, 'node_modules', 'fixture-added-dependency', 'index.js'),
      'utf8',
    )).resolves.toContain('fixture-added-dependency');

    const retainedRevisionId = (await readPluginRegistryCommitRecord(
      resolvePluginStorePaths({ happyHomeDir }),
    ))?.installationState.revisionId;
    const completedUiBuilds = uiBuildRoots.length;
    await writePackage(['fixture-added-dependency', 'fixture-retry-dependency']);
    await writeEntry(['fixture-added-dependency', 'fixture-retry-dependency']);
    runManagedPluginPnpm.mockImplementationOnce(async () => ({
      ok: false as const,
      message: 'managed dependency materializer unavailable',
    }));
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.development-closure',
      sourceRootPath: sourceRoot,
      changedPaths: ['package.json', 'src/index.ts'],
    })).resolves.toMatchObject({
      kind: 'failed',
      code: 'plugin_dev_dependency_preparation_failed',
      message: expect.stringContaining('managed dependency materializer unavailable'),
    });
    expect(uiBuildRoots).toHaveLength(completedUiBuilds);
    expect((await readPluginRegistryCommitRecord(
      resolvePluginStorePaths({ happyHomeDir }),
    ))?.installationState.revisionId).toBe(retainedRevisionId);

    // The source observer retains the failed dependency batch. Its next real
    // edit therefore rejoins the package update instead of incorrectly
    // treating this as a source-only clone of the stale dependency closure.
    runManagedPluginPnpm.mockClear();
    await writeFile(join(sourceRoot, 'src', 'ui-byte.txt'), 'retry-ui-byte\n', 'utf8');
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.development-closure',
      sourceRootPath: sourceRoot,
      changedPaths: ['package.json', 'src/index.ts', 'src/ui-byte.txt'],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.development-closure' });
    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
    expect((await readPluginRegistryCommitRecord(
      resolvePluginStorePaths({ happyHomeDir }),
    ))?.installationState.revisionId).not.toBe(retainedRevisionId);
    await expect(readFile(
      join(sourceRoot, 'node_modules', 'fixture-retry-dependency', 'index.js'),
      'utf8',
    )).resolves.toContain('fixture-retry-dependency');

    // A current ordinary generation is not a known complete development
    // closure. After source-root approval, even a source-only batch must make
    // one fresh daemon dependency preparation instead of cloning that owner.
    await createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle }).update(async (state) => ({
      ...state,
      plugins: {
        ...state.plugins,
        'acme.development-closure': {
          ...state.plugins['acme.development-closure']!,
          source: {
            ...state.plugins['acme.development-closure']!.source,
            devWatch: false,
          },
        },
      },
    }));
    runManagedPluginPnpm.mockClear();
    const ordinaryGenerationSourceReview = await service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.development-closure',
      sourceRootPath: sourceRoot,
      changedPaths: ['src/ui-byte.txt'],
    });
    expect(ordinaryGenerationSourceReview.kind).toBe('reviewRequired');
    if (ordinaryGenerationSourceReview.kind !== 'reviewRequired' || ordinaryGenerationSourceReview.reviewKind !== 'projectTrust') return;
    await expect(service.decidePluginChange({
      pendingChangeId: ordinaryGenerationSourceReview.pendingChangeId,
      decision: 'installAndTrust', optionalSelections: [],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.development-closure' });
    expect(runManagedPluginPnpm).not.toHaveBeenCalled();
    await expect(service.requestPluginChange({
      kind: 'uninstall',
      pluginId: 'acme.development-closure',
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.development-closure' });
    expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins)
      .not.toHaveProperty('acme.development-closure');
  });

  it('removes deleted author files on a watcher-free development reload after rebuilding dependencies', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-manual-delete-home-'));
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-manual-delete-source-'));
    roots.push(happyHomeDir, sourceRoot);
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    const deletedSourcePath = join(sourceRoot, 'src', 'obsolete.ts');
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({
      name: 'acme-manual-delete',
      version: '1.0.0',
      dependencies: { 'fixture-dependency': '1.0.0' },
    }), 'utf8');
    await writeFile(join(sourceRoot, 'src', 'index.ts'), [
      'export const manifest = {',
      "  schemaVersion: 2, id: 'acme.manual-delete', version: '1.0.0',",
      "  displayName: 'Manual delete', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
      '  hostAccess: { required: [], optional: [] }, contributes: {},',
      '};',
      'export function activate(): void {}',
      '',
    ].join('\n'), 'utf8');
    await writeFile(deletedSourcePath, "export const obsolete = 'initial';\n", 'utf8');

    const runManagedPluginPnpm = vi.fn(async (input: Readonly<{ projectRoot: string }>) => {
      const dependencyRoot = join(input.projectRoot, 'node_modules', 'fixture-dependency');
      await mkdir(dependencyRoot, { recursive: true });
      await writeFile(join(dependencyRoot, 'index.js'), "export const dependency = 'retained';\n", 'utf8');
      return await successfulManagedPnpmBoundary();
    });
    const prepare = createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: {
        prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
      },
      runManagedPluginPnpm,
    });
    const manualChangedPaths: Array<readonly string[] | undefined> = [];
    const service = createDaemonPluginChangeService({
      prepare: preservePathPreparerOwner(prepare, async (request) => {
        if (request.kind === 'development' && request.pluginId === 'acme.manual-delete') {
          manualChangedPaths.push(request.changedPaths);
        }
        return await prepare(request);
      }),
      createPendingChangeId: () => 'pending-manual-delete',
    });

    const initial = await service.requestPluginChange({
      kind: 'development',
      sourceRootPath: sourceRoot,
    });
    if (initial.kind !== 'reviewRequired' || initial.reviewKind !== 'projectTrust') {
      throw new Error(`Expected source-root review, received ${initial.kind}`);
    }
    await expect(service.decidePluginChange({
      pendingChangeId: initial.pendingChangeId,
      decision: 'installAndTrust', optionalSelections: [],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.manual-delete' });
    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
    await expect(readFile(deletedSourcePath, 'utf8')).resolves.toContain('initial');
    await rm(deletedSourcePath);
    runManagedPluginPnpm.mockClear();
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.manual-delete',
      sourceRootPath: sourceRoot,
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.manual-delete' });

    expect(manualChangedPaths).toEqual([undefined]);
    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
    await expect(readFile(deletedSourcePath, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(
      join(sourceRoot, 'node_modules', 'fixture-dependency', 'index.js'),
      'utf8',
    )).resolves.toContain("dependency = 'retained'");
  });

  it('keeps manual reloads cold while a credential-bearing dependency input is present', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-sensitive-home-'));
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-sensitive-source-'));
    roots.push(happyHomeDir, sourceRoot);
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({
      name: 'acme-sensitive-inputs',
      version: '1.0.0',
      dependencies: { 'fixture-dependency': '1.0.0' },
    }), 'utf8');
    await writeFile(
      join(sourceRoot, '.npmrc'),
      '//registry.example.test/:_authToken=must-not-be-digested\n',
      'utf8',
    );
    const writeEntry = async (sentinel: string): Promise<void> => {
      await writeFile(join(sourceRoot, 'src', 'index.ts'), [
        'export const manifest = {',
        "  schemaVersion: 2, id: 'acme.sensitive-inputs', version: '1.0.0',",
        "  displayName: 'Sensitive inputs', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        '  hostAccess: { required: [], optional: [] }, contributes: {},',
        '};',
        `export const sentinel = '${sentinel}';`,
        'export function activate(): void {}',
        '',
      ].join('\n'), 'utf8');
    };
    await writeEntry('initial');

    const runManagedPluginPnpm = vi.fn(async (input: Readonly<{ projectRoot: string }>) => {
      const dependencyRoot = join(input.projectRoot, 'node_modules', 'fixture-dependency');
      await mkdir(dependencyRoot, { recursive: true });
      await writeFile(join(dependencyRoot, 'index.js'), "export const dependency = 'installed';\n", 'utf8');
      return await successfulManagedPnpmBoundary();
    });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        runManagedPluginPnpm,
      }),
      createPendingChangeId: () => 'pending-sensitive-inputs',
    });

    const initial = await service.requestPluginChange({
      kind: 'development',
      sourceRootPath: sourceRoot,
    });
    if (initial.kind !== 'reviewRequired' || initial.reviewKind !== 'projectTrust') {
      throw new Error(`Expected source-root review, received ${initial.kind}`);
    }
    await expect(service.decidePluginChange({
      pendingChangeId: initial.pendingChangeId,
      decision: 'installAndTrust', optionalSelections: [],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.sensitive-inputs' });
    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
    const installedRevision = (await readPluginRegistryCommitRecord(
      resolvePluginStorePaths({ happyHomeDir }),
    ))?.installationState.revisionId;
    runManagedPluginPnpm.mockClear();
    await writeEntry('after-manual-reload');
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.sensitive-inputs',
      sourceRootPath: sourceRoot,
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.sensitive-inputs' });

    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
    expect((await readPluginRegistryCommitRecord(
      resolvePluginStorePaths({ happyHomeDir }),
    ))?.installationState.revisionId).not.toBe(installedRevision);
    await expect(readFile(join(sourceRoot, 'src', 'index.ts'), 'utf8'))
      .resolves.toContain("sentinel = 'after-manual-reload'");
    await expect(readFile(join(sourceRoot, '.npmrc'), 'utf8'))
      .resolves.toContain('must-not-be-digested');
  });

  it('rejects source-root substitution after approval and before evaluation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-root-substitution-home-'));
    const container = await mkdtemp(join(tmpdir(), 'happier-plugin-root-substitution-source-'));
    roots.push(happyHomeDir, container);
    const firstRoot = join(container, 'current.ts');
    const secondRoot = join(container, 'second.ts');
    const locator = firstRoot;
    const counterPath = join(container, 'evaluation.log');
    for (const [root, pluginId] of [[firstRoot, 'acme.first'], [secondRoot, 'acme.second']] as const) {
      await writeFile(root, [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(counterPath)}, 'evaluated\\n');`,
        `export const manifest = { schemaVersion: 2, id: '${pluginId}', version: '1.0.0', displayName: '${pluginId}', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 }, hostAccess: { required: [], optional: [] }, contributes: {} };`,
        'export function activate(): void {}',
        '',
      ].join('\n'), 'utf8');
    }
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        runManagedPluginPnpm: vi.fn(successfulManagedPnpmBoundary),
      }),
      createPendingChangeId: () => 'pending-root-substitution',
    });
    const requested = await service.requestPluginChange({
      kind: 'development',
      sourceRootPath: locator,
    });
    expect(requested.kind).toBe('reviewRequired');
    if (requested.kind !== 'reviewRequired' || requested.reviewKind !== 'projectTrust') return;
    await rm(locator);
    await symlink(secondRoot, locator, 'file');
    await expect(service.decidePluginChange({
      pendingChangeId: requested.pendingChangeId,
      decision: 'installAndTrust', optionalSelections: [],
    })).resolves.toMatchObject({
      kind: 'failed',
      code: 'plugin_change_preparation_failed',
      message: expect.stringMatching(/identity changed|substituted/u),
    });
    await expect(readFile(counterPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Local development remains externally admitted even when its source is also
  // used to generate a bundled artifact. Exact generated artifact custody is a
  // separate fact owned by the generated-artifact resolver.
  it('requires an explicit development entrypoint for a bundled source working tree', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-bundled-dev-'));
    roots.push(happyHomeDir);
    const bundledManifest = JSON.parse(
      await readFile(join(BUNDLED_PLUGIN_ROOT, '.happier-plugin', 'plugin.json'), 'utf8'),
    ) as Readonly<{ id: string }>;
    expect(bundledManifest.id.startsWith('happier.')).toBe(true);
    const prepare = createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: {
        prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
      },
      runManagedPluginPnpm: successfulManagedPnpmBoundary,
      runPluginUiArtifactBuild: async (input) => ({ ok: true as const, projectRoot: input.projectRoot, built: false }),
    });

    await expect(prepare({
      kind: 'development',
      sourceRootPath: BUNDLED_PLUGIN_ROOT,
    })).rejects.toThrow('has no development entrypoint');
  }, 180_000);

  // C1: an external plugin developed from a local working tree is the same
  // record shape as a bundled one — a path the operator authored on this
  // machine. Provenance, not authorship, decides the registry-lifecycle rules,
  // so the reserved namespace must not lock an external author out of the dev
  // loop that the discovery owner already admitted.
  it('prepares a development install of an external local path plugin under a reserved id', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-external-reserved-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({ pluginId: 'happier.agent.fake', development: true });
    const prepare = createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: {
        prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
      },
      runManagedPluginPnpm: successfulManagedPnpmBoundary,
      runPluginUiArtifactBuild: async (input) => ({ ok: true as const, projectRoot: input.projectRoot, built: false }),
    });

    const prepared = await prepare({
      kind: 'development',
      sourceRootPath: pluginRoot,
    });

    expect(prepared).toMatchObject({ pluginId: 'happier.agent.fake' });
    await prepared.cleanup();
  });

  it('discloses each executable realm declared by a local path plugin', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const reactNativeOnlyRoot = await createDescriptorPlugin({
      pluginId: 'acme.react-native-only',
      reactNative: true,
    });
    const daemonAndReactNativeRoot = await createDescriptorPlugin({
      pluginId: 'acme.daemon-and-react-native',
      daemon: true,
      reactNative: true,
    });
    const developmentOnlyRoot = await createDescriptorPlugin({
      pluginId: 'acme.development-only',
      development: true,
    });
    const prepare = createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: {
        prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
      },
    });

    const reactNativeOnly = await prepare({
      kind: 'installPath',
      locator: reactNativeOnlyRoot,
      development: false,
    });
    expect(reactNativeOnly).toMatchObject({
      review: {
        packageIdentity: { name: null, version: '1.0.0' },
        publisherIdentity: { status: 'unavailable' },
        updateChannel: { kind: 'path', development: false },
        signature: { status: 'notProvided' },
        provenance: { status: 'notProvided' },
        curation: { status: 'notApplicable' },
        executableRealms: ['reactNative'],
        contributions: [{ family: 'ui.renderers', count: 1 }],
        uiArtifacts: { status: 'unavailable', contributionIds: ['main-native'] },
        compatibility: { happier: '^0.2.0', runtimeApiVersion: 1 },
        updatePolicy: 'allowed',
      },
    });
    expect(reactNativeOnly).not.toHaveProperty('review.integrity');
    await expect(prepare({
      kind: 'installPath',
      locator: daemonAndReactNativeRoot,
      development: false,
    })).resolves.toMatchObject({
      review: { executableRealms: ['daemon', 'reactNative'] },
    });
    await expect(prepare({
      kind: 'installPath',
      locator: developmentOnlyRoot,
      development: false,
    })).resolves.toMatchObject({
      review: { executableRealms: ['daemon'] },
    });
  });

  it('reviews statically, then commits through the supplied daemon runtime lifecycle', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin();
    let preparedCandidate: PluginRegistryRuntimeCandidate | undefined;
    const adopt = vi.fn(async () => Object.freeze(Object.fromEntries(
      (preparedCandidate?.changedPluginIds ?? []).map((pluginId) => [
        pluginId,
        preparedCandidate?.pluginOccurrenceIds[pluginId]?.immutableGenerationId ?? null,
      ]),
    )));
    const prepareRuntime = vi.fn(async (candidate: PluginRegistryRuntimeCandidate) => {
      preparedCandidate = candidate;
      return { abort: async () => undefined, adopt };
    });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: { prepare: prepareRuntime },
      }),
      createPendingChangeId: () => 'pending-descriptor',
    });

    const begun = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    expect(begun).toEqual(expect.objectContaining({
      kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
      review: expect.objectContaining({ pluginId: 'acme.descriptor', executableRealms: [] }),
    }));
    if (begun.kind !== 'reviewRequired' || begun.reviewKind !== 'installation') throw new Error('Expected review');

    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
    })).resolves.toEqual(expect.objectContaining({
      kind: 'committed',
      pluginId: 'acme.descriptor',
      desiredGeneration: expect.any(String),
      appliedGeneration: expect.any(String),
    }));
    expect(prepareRuntime).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenCalledTimes(1);
    await expect(createPluginRegistryStateStore({ happyHomeDir }).readSnapshot())
      .resolves.toMatchObject({
        installReviewPrincipalDigestsByPluginId: {
          'acme.descriptor': derivePluginInstallReviewPrincipal(begun.review).digest,
        },
      });
  });

  it('reports the managed generation committed by its own transaction', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({ development: true });
    let preparePath!: ReturnType<typeof createDaemonPathPluginChangePreparer>;
    let firstGeneration: string | undefined;
    const runtimeLifecycle: PluginRegistryRuntimeLifecycle = {
      prepare: async (candidate) => {
        const generation = candidate.pluginOccurrenceIds['acme.descriptor']?.immutableGenerationId;
        if (!generation) throw new Error('Expected descriptor generation');
        firstGeneration = generation;
        const appliedGenerationsByPluginId = Object.freeze(Object.fromEntries(
          candidate.changedPluginIds.map((pluginId) => [
            pluginId,
            candidate.pluginOccurrenceIds[pluginId]?.immutableGenerationId ?? null,
          ]),
        ));
        return {
          abort: async () => undefined,
          adopt: async () => appliedGenerationsByPluginId,
        };
      },
    };
    preparePath = createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle,
      runManagedPluginPnpm: successfulManagedPnpmBoundary,
    });
    const service = createDaemonPluginChangeService({
      prepare: preparePath,
      createPendingChangeId: () => 'pending-result-identity',
    });

    const begun = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    if (begun.kind !== 'reviewRequired') throw new Error('Expected review');

    const result = await service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
    });

    expect(firstGeneration).toBeDefined();
    expect(result).toMatchObject({
      kind: 'committed',
      desiredGeneration: firstGeneration,
      appliedGeneration: firstGeneration,
    });
  });

  it('installs the daemon-owned non-development candidate reviewed before source bytes change', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({ development: true });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        runManagedPluginPnpm: successfulManagedPnpmBoundary,
      }),
      createPendingChangeId: () => 'pending-descriptor',
    });
    const begun = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    if (begun.kind !== 'reviewRequired') throw new Error('Expected review');
    await writeFile(join(pluginRoot, 'payload.txt'), 'substituted bytes');

    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.descriptor' });

    const current = await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    );
    const generation = current?.generations.get('acme.descriptor');
    if (!generation) throw new Error('Expected the reviewed descriptor generation');
    await expect(readFile(join(generation.rootPath, 'payload.txt'), 'utf8'))
      .resolves.toBe('reviewed bytes');
  });

  it('persists only the optional host resources selected in the human decision', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({ optionalSessions: true });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        runManagedPluginPnpm: successfulManagedPnpmBoundary,
      }),
      createPendingChangeId: () => 'pending-optional-selection',
    });

    const begun = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    expect(begun).toMatchObject({
      kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
      review: { optionalHostAccess: [{ id: 'project-sessions', capability: 'sessions' }] },
    });
    if (begun.kind !== 'reviewRequired') throw new Error('Expected review');

    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      optionalSelections: [{ accessId: 'project-sessions', selected: true }],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.descriptor' });
    const descriptorInstall = (await createPluginRegistryStateStore({ happyHomeDir }).read())
      .plugins['acme.descriptor']?.install;
    expect(descriptorInstall?.optionalAccess).toMatchObject([{
      accessId: 'project-sessions',
      capability: 'sessions',
      // Stamped by the daemon at apply time, matching the approval it belongs to.
      selectedAtMs: descriptorInstall?.trust?.approvedAtMs,
    }]);
  });

  it('reopens a managed-path update when its persisted optional selection is stale', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-stale-optional-path-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({ optionalSessions: true });
    const runtimeLifecycle: PluginRegistryRuntimeLifecycle = {
      prepare: async (candidate) => ({
        abort: async () => undefined,
        adopt: async () => Object.freeze(Object.fromEntries(
          candidate.changedPluginIds.map((pluginId) => [
            pluginId,
            candidate.pluginOccurrenceIds[pluginId]?.immutableGenerationId ?? null,
          ]),
        )),
      }),
    };
    const preparePath = createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle,
      runManagedPluginPnpm: successfulManagedPnpmBoundary,
    });
    let installed = false;
    const service = createDaemonPluginChangeService({
      prepare: async (request) => await preparePath(
        request,
        installed ? { installedUpdate: { pluginId: 'acme.descriptor' } } : undefined,
      ),
    });
    const first = await service.requestPluginChange({ kind: 'installPath', locator: pluginRoot, development: false });
    if (first.kind !== 'reviewRequired' || first.reviewKind !== 'installation') throw new Error('Expected initial review');
    await service.decidePluginChange({
      pendingChangeId: first.pendingChangeId,
      decision: 'installAndTrust',
      optionalSelections: [{ accessId: 'project-sessions', selected: true }],
    });
    installed = true;
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    const widened = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      hostAccess: { optional: Array<{ scope: { access: string[] } }> };
    };
    widened.hostAccess.optional[0]!.scope.access.push('write');
    await writeFile(manifestPath, JSON.stringify(widened), 'utf8');

    await expect(service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    })).resolves.toMatchObject({
      kind: 'reviewRequired',
      reason: 'authorityExpansion',
      authorityExpansion: expect.arrayContaining(['selectedOptionalHostAccess']),
    });
  });

  it('reuses source trust for later development replacements without another review', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({ development: true });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        runManagedPluginPnpm: successfulManagedPnpmBoundary,
      }),
      createPendingChangeId: () => 'pending-development',
    });
    let first: PluginChangeRequestResult | PluginChangeDecisionResult = await service.requestPluginChange({
      kind: 'development',
      sourceRootPath: pluginRoot,
    });
    if (first.kind === 'reviewRequired' && first.reviewKind === 'projectTrust') {
      first = await service.decidePluginChange({
        pendingChangeId: first.pendingChangeId,
        decision: 'installAndTrust', optionalSelections: [],
      });
    }
    if (first.kind === 'reviewRequired') {
      first = await service.decidePluginChange({
        pendingChangeId: first.pendingChangeId,
        decision: 'installAndTrust',
      });
    }
    expect(first).toMatchObject({ kind: 'committed', pluginId: 'acme.descriptor' });
    await writeFile(join(pluginRoot, 'payload.txt'), 'development edit');

    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.descriptor',
      sourceRootPath: pluginRoot,
    })).resolves.toEqual(expect.objectContaining({ kind: 'committed', pluginId: 'acme.descriptor' }));
  });

  it.each(['manifest', 'code'] as const)('rejects saved-disabled development sources before evaluating their code (%s)', async (sourceKind) => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-disabled-development-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({ development: true });
    const sourceRootPath = sourceKind === 'code' ? join(pluginRoot, 'src', 'index.ts') : pluginRoot;
    const runtimeLifecycle: PluginRegistryRuntimeLifecycle = {
      prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
    };
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle,
        isRegisteredDevelopmentRoot: () => true,
        runManagedPluginPnpm: successfulManagedPnpmBoundary,
      }),
    });
    let initial: PluginChangeRequestResult | PluginChangeDecisionResult = await service.requestPluginChange({
      kind: 'development', sourceRootPath,
    });
    if (initial.kind === 'reviewRequired') {
      initial = await service.decidePluginChange({ pendingChangeId: initial.pendingChangeId, decision: 'installAndTrust' });
    }
    expect(initial).toMatchObject({ kind: 'committed', pluginId: 'acme.descriptor' });
    await createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle })
      .setEnabled('acme.descriptor', false);
    await writeFile(join(pluginRoot, 'src', 'index.ts'), "throw new Error('disabled source was evaluated');", 'utf8');

    for (const pluginId of [undefined, 'acme.descriptor']) {
      await expect(service.requestPluginChange({
        kind: 'development', sourceRootPath, ...(pluginId ? { pluginId } : {}),
      })).resolves.toMatchObject({ kind: 'failed', code: 'plugin_disabled' });
    }
    expect((await createPluginRegistryStateStore({ happyHomeDir }).read())
      .plugins['acme.descriptor']?.state.enabled).toBe(false);
  });

  it('reuses source trust for trusted development replacements that narrow or widen required access', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({
      development: true,
      requiredNetworkOrigins: ['https://api.example.test', 'https://secondary.example.test'],
    });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        runManagedPluginPnpm: successfulManagedPnpmBoundary,
      }),
    });
    let first: PluginChangeRequestResult | PluginChangeDecisionResult = await service.requestPluginChange({
      kind: 'development',
      sourceRootPath: pluginRoot,
    });
    if (first.kind === 'reviewRequired' && first.reviewKind === 'projectTrust') {
      first = await service.decidePluginChange({
        pendingChangeId: first.pendingChangeId,
        decision: 'installAndTrust', optionalSelections: [],
      });
    }
    if (first.kind !== 'reviewRequired') throw new Error('Expected initial review');
    await service.decidePluginChange({
      pendingChangeId: first.pendingChangeId,
      decision: 'installAndTrust',
    });

    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    const hostAccess = manifest.hostAccess as {
      required: Array<{
        scope: { targets: Array<{ kind: string; origin: string }> };
      }>;
      optional: unknown[];
    };
    // Dropping an origin reaches nowhere the approved grant could not, so the
    // reviewed source trust carries the replacement without a new decision.
    hostAccess.required[0]!.scope.targets = [{
      kind: 'fixedOrigin',
      origin: 'https://api.example.test',
    }];
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    await writeFile(join(pluginRoot, 'src', 'index.ts'), [
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function activate(): void {}',
      '',
    ].join('\n'), 'utf8');

    await expect(service.requestPluginChange({
      kind: 'development',
      sourceRootPath: pluginRoot,
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.descriptor' });

    // Re-adding the dropped origin widens reach, but a development change never
    // prompts (PPS §9 ruling (a), refined).
    hostAccess.required[0]!.scope.targets = [
      { kind: 'fixedOrigin', origin: 'https://api.example.test' },
      { kind: 'fixedOrigin', origin: 'https://secondary.example.test' },
    ];
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    await writeFile(join(pluginRoot, 'src', 'index.ts'), [
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function activate(): void {}',
      '',
    ].join('\n'), 'utf8');

    await expect(service.requestPluginChange({
      kind: 'development',
      sourceRootPath: pluginRoot,
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.descriptor' });
  });

  it('rejects a development source whose manifest identity changed after observation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({ pluginId: 'acme.changed', development: true });
    const runManagedPluginPnpm = vi.fn(successfulManagedPnpmBoundary);
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        runManagedPluginPnpm,
      }),
    });

    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.observed',
      sourceRootPath: pluginRoot,
    })).resolves.toMatchObject({
      kind: 'failed',
      code: 'plugin_change_preparation_failed',
      message: expect.stringContaining("identity changed from 'acme.observed' to 'acme.changed'"),
    });

    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
    await expect(
      createPluginRegistryStateStore({ happyHomeDir }).read(),
    ).resolves.toMatchObject({ plugins: {} });
  });

  it('rejects a prepared replacement when the same plugin state changes before apply', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({ development: true });
    const runtimeLifecycle = {
      prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
    };
    const prepare = createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle,
      runManagedPluginPnpm: successfulManagedPnpmBoundary,
    });
    const service = createDaemonPluginChangeService({
      prepare,
      createPendingChangeId: () => 'pending-development-conflict',
    });
    let first: PluginChangeRequestResult | PluginChangeDecisionResult = await service.requestPluginChange({
      kind: 'development',
      sourceRootPath: pluginRoot,
    });
    if (first.kind === 'reviewRequired' && first.reviewKind === 'projectTrust') {
      first = await service.decidePluginChange({
        pendingChangeId: first.pendingChangeId,
        decision: 'installAndTrust', optionalSelections: [],
      });
    }
    if (first.kind !== 'reviewRequired') throw new Error('Expected initial review');
    await service.decidePluginChange({
      pendingChangeId: first.pendingChangeId,
      decision: 'installAndTrust',
    });

    const preparedOrSourceApproval = await prepare({
      kind: 'development',
      pluginId: 'acme.descriptor',
      sourceRootPath: pluginRoot,
    });
    const prepared = 'kind' in preparedOrSourceApproval
      && preparedOrSourceApproval.kind === 'projectTrustApprovalRequired'
      ? await preparedOrSourceApproval.continueAfterProjectTrustApproval()
      : preparedOrSourceApproval;
    if ('kind' in prepared && prepared.kind === 'preparedDevelopmentCandidate') {
      // Expected current source-in-place candidate.
    } else if ('kind' in prepared) {
      throw new Error(`Unexpected prepared change kind: ${prepared.kind}`);
    }
    expect(prepared.requiresReview).toBe(false);

    const takeoverStore = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    await takeoverStore.update((state) => {
      const record = state.plugins['acme.descriptor']!;
      const { trust: _trust, ...install } = record.install;
      return {
        ...state,
        plugins: {
          ...state.plugins,
          'acme.descriptor': {
            ...record,
            source: { ...record.source, trustPolicy: 'untrusted' as const },
            install,
            state: { ...record.state, enabled: false },
          },
        },
      };
    });

    if (!('kind' in prepared) || prepared.kind !== 'preparedDevelopmentCandidate') {
      throw new Error('Expected prepared development candidate');
    }
    const optionalAccess = preserveValidPluginOptionalSelections(
      prepared.pluginId,
      prepared.manifest,
      prepared.priorOptionalAccess ?? [],
    );
    if (!optionalAccess || prepared.registryRevision === undefined) {
      throw new Error('Expected a complete prepared development authority candidate');
    }
    await expect(createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle })
      .approveDevelopmentAuthorityWithResult({
        pluginId: prepared.pluginId,
        expectedRevision: prepared.registryRevision,
        approvedAuthorityManifest: prepared.manifest,
        catalogRecord: prepared.catalogRecord,
        trust: prepared.trust,
        updatePolicy: prepared.updatePolicy,
        optionalAccess,
        ...(prepared.priorInstallReviewPrincipal
          ? {
              installReviewPrincipalDigest: prepared.priorInstallReviewPrincipal.digest,
              installReviewPrincipalPresentation: prepared.priorInstallReviewPrincipal.presentation,
            }
          : {}),
      })).resolves.toBeNull();
    await prepared.cleanup();
  });

  it('routes enablement and uninstall through the same daemon lifecycle and reports pending custody cleanup', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin();
    const prepareRuntime = vi.fn(async (candidate: PluginRegistryRuntimeCandidate) => ({
      abort: async () => undefined,
      adopt: async () => Object.freeze(Object.fromEntries(
        candidate.changedPluginIds.map((pluginId) => [
          pluginId,
          candidate.installationState.plugins[pluginId]?.enabled === true
            ? candidate.pluginOccurrenceIds[pluginId]?.immutableGenerationId ?? null
            : null,
        ]),
      )),
    }));
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: { prepare: prepareRuntime },
      }),
      createPendingChangeId: () => 'pending-state-change',
    });
    const install = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    if (install.kind !== 'reviewRequired') throw new Error('Expected review');
    await service.decidePluginChange({
      pendingChangeId: install.pendingChangeId,
      decision: 'installAndTrust',
    });

    await expect(service.requestPluginChange({
      kind: 'disable',
      pluginId: 'acme.descriptor',
    })).resolves.toEqual(expect.objectContaining({
      kind: 'committed',
      pluginId: 'acme.descriptor',
      desiredGeneration: expect.any(String),
      appliedGeneration: null,
    }));

    await expect(service.requestPluginChange({
      kind: 'uninstall',
      pluginId: 'acme.descriptor',
    })).resolves.toEqual({
      kind: 'committed',
      pluginId: 'acme.descriptor',
      desiredGeneration: null,
      appliedGeneration: null,
      pendingSurfaces: ['reconciliation'],
    });
    expect(prepareRuntime).toHaveBeenCalledTimes(3);

    await expect(service.requestPluginChange({
      kind: 'uninstallAndDeleteData',
      pluginId: 'acme.descriptor',
    })).resolves.toEqual({
      kind: 'committed',
      pluginId: 'acme.descriptor',
      desiredGeneration: null,
      appliedGeneration: null,
      pendingSurfaces: [],
      dataRemoval: {
        alreadyUninstalled: true,
        removedData: { daemonStorage: false, secrets: false },
      },
    });
    expect(prepareRuntime).toHaveBeenCalledTimes(3);
  });

  it('re-applies enablement from current state when another change commits after preparation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin();
    const preparePath = createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: {
        prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
      },
    });
    let pausePreparedEnable = false;
    let markEnablePrepared!: () => void;
    const enablePrepared = new Promise<void>((resolve) => {
      markEnablePrepared = resolve;
    });
    let releaseEnableApply!: () => void;
    const enableMayApply = new Promise<void>((resolve) => {
      releaseEnableApply = resolve;
    });
    const service = createDaemonPluginChangeService({
      prepare: async (request) => {
        const prepared = await preparePath(request);
        if (pausePreparedEnable && request.kind === 'enable') {
          markEnablePrepared();
          await enableMayApply;
        }
        return prepared;
      },
      createPendingChangeId: () => 'pending-current-state',
    });
    const install = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    if (install.kind !== 'reviewRequired') throw new Error('Expected review');
    await service.decidePluginChange({
      pendingChangeId: install.pendingChangeId,
      decision: 'installAndTrust',
    });

    pausePreparedEnable = true;
    const enableResult = service.requestPluginChange({
      kind: 'enable',
      pluginId: 'acme.descriptor',
    });
    await enablePrepared;

    await expect(service.requestPluginChange({
      kind: 'disable',
      pluginId: 'acme.descriptor',
    })).resolves.toMatchObject({
      kind: 'committed',
      pluginId: 'acme.descriptor',
    });
    releaseEnableApply();

    await expect(enableResult).resolves.toMatchObject({
      kind: 'committed',
      pluginId: 'acme.descriptor',
    });
    await expect(createPluginRegistryStateStore({ happyHomeDir }).read()).resolves.toMatchObject({
      plugins: {
        'acme.descriptor': {
          state: { enabled: true },
        },
      },
    });
  });

  it('owns destructive uninstall cleanup and returns an idempotent typed partial outcome', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-destructive-uninstall-'));
    roots.push(happyHomeDir);
    const pluginId = 'acme.removed';
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const daemonStoragePath = join(paths.storageDir, pluginId);
    const secretsPath = join(paths.secretsDir, pluginId);
    await mkdir(daemonStoragePath, { recursive: true });
    await mkdir(secretsPath, { recursive: true });
    await writeFile(join(daemonStoragePath, 'daemon.v1.json'), '{}', 'utf8');
    await writeFile(join(secretsPath, 'secrets.v1.json'), '{}', 'utf8');

    let failSecrets = true;
    const removeDirectory = vi.fn(async (directoryPath: string) => {
      if (failSecrets && directoryPath === secretsPath) {
        const error = new Error('injected secrets removal failure') as Error & { code: string };
        error.code = 'EIO';
        throw error;
      }
      await rm(directoryPath, { recursive: true, force: true });
    });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        removePluginDataDirectory: removeDirectory,
      }),
    });
    const request = {
      kind: 'uninstallAndDeleteData' as const,
      pluginId,
    };

    await expect(service.requestPluginChange(request)).resolves.toEqual({
      kind: 'dataRemovalPartial',
      pluginId,
      completed: ['uninstall', 'daemonStorage'],
      pending: ['secrets'],
      causeCode: 'EIO',
    });
    await expect(lstat(daemonStoragePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(secretsPath)).resolves.toBeDefined();

    failSecrets = false;
    await expect(service.requestPluginChange(request)).resolves.toEqual({
      kind: 'committed',
      pluginId,
      desiredGeneration: null,
      appliedGeneration: null,
      pendingSurfaces: [],
      dataRemoval: {
        alreadyUninstalled: true,
        removedData: { daemonStorage: false, secrets: true },
      },
    });
    await expect(lstat(secretsPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await service.shutdown();
  });

  it('refuses an absent reserved destructive namespace before preparing any deletion', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-destructive-reserved-'));
    roots.push(happyHomeDir);
    const removePluginDataDirectory = vi.fn(async () => undefined);
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        removePluginDataDirectory,
      }),
    });

    await expect(service.requestPluginChange({
      kind: 'uninstallAndDeleteData',
      pluginId: 'happier.unowned',
    })).resolves.toMatchObject({
      kind: 'failed',
      code: 'plugin_data_removal_ownership_unsupported',
    });
    expect(removePluginDataDirectory).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it('keeps same-plugin mutation exclusion until destructive namespace deletion settles', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-destructive-exclusion-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin();
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const daemonStoragePath = join(paths.storageDir, 'acme.descriptor');
    await mkdir(daemonStoragePath, { recursive: true });
    let releaseRemoval!: () => void;
    const removalMaySettle = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    let markRemovalStarted!: () => void;
    const removalStarted = new Promise<void>((resolve) => { markRemovalStarted = resolve; });
    let markSecondRemovalStarted!: () => void;
    const secondRemovalStarted = new Promise<void>((resolve) => { markSecondRemovalStarted = resolve; });
    const removePluginDataDirectory = vi.fn(async (directoryPath: string) => {
      if (removePluginDataDirectory.mock.calls.length === 2) markSecondRemovalStarted();
      markRemovalStarted();
      await removalMaySettle;
      await rm(directoryPath, { recursive: true, force: true });
    });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async (candidate) => ({
            abort: async () => undefined,
            adopt: async () => Object.freeze(Object.fromEntries(
              candidate.changedPluginIds.map((pluginId) => [
                pluginId,
                candidate.installationState.plugins[pluginId]?.enabled === true
                  ? candidate.pluginOccurrenceIds[pluginId]?.immutableGenerationId ?? null
                  : null,
              ]),
            )),
          }),
        },
        removePluginDataDirectory,
      }),
      createPendingChangeId: () => 'pending-destructive-exclusion',
    });
    const install = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    if (install.kind !== 'reviewRequired') throw new Error('Expected review');
    await service.decidePluginChange({
      pendingChangeId: install.pendingChangeId,
      decision: 'installAndTrust',
    });
    const request = {
      kind: 'uninstallAndDeleteData' as const,
      pluginId: 'acme.descriptor',
    };

    const first = service.requestPluginChange(request);
    await removalStarted;
    const second = service.requestPluginChange(request);
    const secondBeforeRelease = await Promise.race([
      second.then((result) => ({ kind: 'settled' as const, result })),
      secondRemovalStarted.then(() => ({ kind: 'secondRemovalStarted' as const })),
    ]);
    const removalCallsBeforeRelease = removePluginDataDirectory.mock.calls.length;
    releaseRemoval();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(removalCallsBeforeRelease).toBe(1);
    expect(secondBeforeRelease).toEqual({
      kind: 'settled',
      result: { kind: 'busy', pluginId: 'acme.descriptor' },
    });
    expect(firstResult).toMatchObject({ kind: 'committed', pluginId: 'acme.descriptor' });
    expect(secondResult).toEqual({ kind: 'busy', pluginId: 'acme.descriptor' });
    await service.shutdown();
  });

  it('reports outcomeUnknown when desired state may be durable but adoption cannot be confirmed', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin();
    let preparation = 0;
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => {
            preparation += 1;
            return {
              abort: async () => undefined,
              adopt: async () => {
                if (preparation === 2) throw new Error('serving swap failed');
              },
            };
          },
        },
      }),
      createPendingChangeId: () => 'pending-adoption',
    });
    const install = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    if (install.kind !== 'reviewRequired') throw new Error('Expected review');
    await service.decidePluginChange({
      pendingChangeId: install.pendingChangeId,
      decision: 'installAndTrust',
    });

    await expect(service.requestPluginChange({
      kind: 'disable',
      pluginId: 'acme.descriptor',
    })).resolves.toEqual({
      kind: 'outcomeUnknown',
      pluginId: 'acme.descriptor',
      expectedCandidate: expect.any(String),
    });
  });

  it('preserves the registry cleanup diagnostic when an install fails after storage-pressure recovery', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin();
    const message = [
      'BEGIN_FAILURE Storage-pressure quarantine eviction cleanup remains pending:',
      'client_secret=path-preparer-secret',
      '🙂'.repeat(1_200),
      'END_STACK',
    ].join(' ');
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => {
            throw new Error(message);
          },
        },
      }),
      createPendingChangeId: () => 'pending-cleanup-diagnostic',
    });
    const install = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    if (install.kind !== 'reviewRequired') throw new Error('Expected review');

    const result = await service.decidePluginChange({
      pendingChangeId: install.pendingChangeId,
      decision: 'installAndTrust',
    });
    expect(result).toMatchObject({
      kind: 'failed',
      code: 'plugin_install_failed',
      message: expect.stringMatching(/^BEGIN_FAILURE/u),
    });
    if (result.kind !== 'failed') throw new Error('Expected failed plugin installation');
    expect(result.message).not.toContain('path-preparer-secret');
    expect(result.message).not.toContain('END_STACK');
    expect(Buffer.byteLength(result.message ?? '', 'utf8')).toBeLessThanOrEqual(2_048);
  });

  it('forgets package trust by disabling the plugin through the same daemon mutation owner', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({ daemon: true });
    await mkdir(join(pluginRoot, 'dist'), { recursive: true });
    await writeFile(join(pluginRoot, 'dist', 'index.js'), 'export function activate() {}\n', 'utf8');
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async (candidate) => ({
            abort: async () => undefined,
            adopt: async () => Object.freeze(Object.fromEntries(
              candidate.changedPluginIds.map((pluginId) => [
                pluginId,
                candidate.installationState.plugins[pluginId]?.enabled === true
                  ? candidate.pluginOccurrenceIds[pluginId]?.immutableGenerationId ?? null
                  : null,
              ]),
            )),
          }),
        },
      }),
      createPendingChangeId: () => 'pending-forget-trust',
    });
    const install = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    if (install.kind !== 'reviewRequired') throw new Error('Expected review');
    await service.decidePluginChange({
      pendingChangeId: install.pendingChangeId,
      decision: 'installAndTrust',
    });
    await writeFile(join(pluginRoot, 'payload.txt'), 'updated reviewed bytes');
    const update = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    if (update.kind !== 'reviewRequired') throw new Error('Expected update review');
    await service.decidePluginChange({
      pendingChangeId: update.pendingChangeId,
      decision: 'installAndTrust',
    });

    const paths = resolvePluginStorePaths({ happyHomeDir });
    const commitBeforeForget = await readPluginRegistryCommitRecord(paths);
    if (!commitBeforeForget) throw new Error('Expected committed registry state before forgetting trust');
    const installationStateBeforeForget = await readInstallationStateRevision({
      paths,
      reference: commitBeforeForget.installationState,
    });
    expect(installationStateBeforeForget.rollbackRetention).toEqual([
      expect.objectContaining({ pluginId: 'acme.descriptor' }),
    ]);

    await expect(service.requestPluginChange({
      kind: 'forgetTrust',
      pluginId: 'acme.descriptor',
    })).resolves.toEqual(expect.objectContaining({
      kind: 'committed',
      pluginId: 'acme.descriptor',
      desiredGeneration: expect.any(String),
      appliedGeneration: null,
    }));
    const record = (await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins['acme.descriptor'];
    expect(record).toMatchObject({
      source: { trustPolicy: 'untrusted' },
      state: { enabled: false },
    });
    expect(record?.install).not.toHaveProperty('trust');

    const commitAfterForget = await readPluginRegistryCommitRecord(paths);
    if (!commitAfterForget) throw new Error('Expected committed registry state after forgetting trust');
    const installationStateAfterForget = await readInstallationStateRevision({
      paths,
      reference: commitAfterForget.installationState,
    });
    expect(installationStateAfterForget.plugins['acme.descriptor']).not.toHaveProperty('trust');
    expect(installationStateAfterForget.rollbackRetention).toEqual([]);
    expect(installationStateAfterForget.retainedRuntimeCatalog).toEqual({});
    const executionAuthorityAfterForget = await readCurrentCommittedPluginGenerations(paths);
    expect(executionAuthorityAfterForget?.generations.has('acme.descriptor')).toBe(false);

    await expect(service.requestPluginChange({
      kind: 'enable',
      pluginId: 'acme.descriptor',
    })).resolves.toMatchObject({
      kind: 'failed',
      code: 'plugin_change_failed',
      message: expect.stringMatching(/review|trust/i),
    });
    await expect(createPluginRegistryStateStore({ happyHomeDir }).read()).resolves.toMatchObject({
      plugins: {
        'acme.descriptor': {
          source: { trustPolicy: 'untrusted' },
          state: { enabled: false },
        },
      },
    });

    const reinstall = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: false,
    });
    if (reinstall.kind !== 'reviewRequired') throw new Error('Expected fresh review after forgotten trust');
    await service.decidePluginChange({
      pendingChangeId: reinstall.pendingChangeId,
      decision: 'installAndTrust',
    });

    expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins['acme.descriptor'])
      .toMatchObject({
        source: { trustPolicy: 'prompt' },
        install: { trust: { state: 'trusted' } },
        state: { enabled: true },
      });
  });
});
