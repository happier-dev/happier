import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const filesystemBoundary = vi.hoisted(() => ({
  realpathCallsByPath: new Map<string, number>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const path = String(args[0]);
      filesystemBoundary.realpathCallsByPath.set(
        path,
        (filesystemBoundary.realpathCallsByPath.get(path) ?? 0) + 1,
      );
      return await actual.realpath(...args);
    },
  };
});

import { createDaemonPluginChangeService } from './changeService';
import type {
  PluginChangeDecisionResult,
  PluginChangeRequest,
  PluginChangeRequestResult,
} from './changeContract';
import { createDaemonPathPluginChangePreparer } from './pathChangePreparer';
import { derivePluginInstallReviewPrincipal } from './installReviewPrincipal';
import {
  createPluginRegistryStateStore,
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
import {
  materializePluginDevelopmentCandidate,
  type RunManagedPluginPnpmBoundary,
} from './developmentCandidateMaterializer';
import {
  startPluginDevelopmentSourceObserver,
  type PluginDevelopmentSourceObservationDelivery,
} from '@/plugins/authoring/sourceObserver';
import { successfulManagedPluginPnpmBoundary as successfulManagedPnpmBoundary } from '@/plugins/testkit/managedPnpmBoundary';
import { requestUserPluginChange } from './changeClient';

const BUNDLED_PLUGIN_ROOT = resolve(import.meta.dirname, '../../../../../packages/plugins/codex');

const roots: string[] = [];

afterEach(async () => {
  filesystemBoundary.realpathCallsByPath.clear();
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
  await writeFile(join(root, '.happier-plugin', 'plugin.json'), JSON.stringify({
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
  }));
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
          distribution: generation.installation.source.distribution,
          trust: generation.installation.trust,
          isCurrent: current.isCurrent,
      },
    },
    cacheKey: generation.immutableGenerationId,
  });
  return (loaded as { sentinel?: string }).sentinel;
}

describe('createDaemonPathPluginChangePreparer', () => {
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
                ? candidate.pluginGenerations[pluginId]?.immutableGenerationId ?? null
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
    let interactionId = 0;
    const apply = async (request: PluginChangeRequest): Promise<void> => {
      const result = await service.requestPluginChange(request);
      if (result.kind === 'reviewRequired') {
        const decided = await service.decidePluginChange({
          pendingChangeId: result.pendingChangeId,
          decision: 'installAndTrust',
          actorEvidence: {
            kind: 'authenticatedLocalUser',
            interactionId: `cause-${interactionId += 1}`,
            occurredAtMs: interactionId,
          },
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
    await writeFile(join(pluginRoot, 'payload.txt'), 'development rebuild', 'utf8');
    await applyAndObserve('development rebuild', {
      kind: 'development',
      pluginId: 'acme.descriptor',
      sourceRootPath: pluginRoot,
    });
    const contributionRemovalManifest = JSON.parse(
      await readFile(manifestPath, 'utf8'),
    ) as Record<string, unknown>;
    contributionRemovalManifest.contributes = {};
    await writeFile(manifestPath, JSON.stringify(contributionRemovalManifest), 'utf8');
    await applyAndObserve('ordinary contribution removal', {
      kind: 'development',
      pluginId: 'acme.descriptor',
      sourceRootPath: pluginRoot,
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
        cause: 'development rebuild',
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

  it('fails closed and removes the owned candidate when pnpm emits a symlinked dependency', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-symlink-output-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-outside-'));
    roots.push(happyHomeDir, pluginRoot, outsideRoot);
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ dependencies: { escaped: '1.0.0' } }), 'utf8');
    await writeFile(join(pluginRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
    await writeFile(join(outsideRoot, 'index.js'), 'export default true;\n', 'utf8');
    let candidateRoot: string | undefined;

    await expect(materializePluginDevelopmentCandidate({
      happyHomeDir,
      sourceRootPath: pluginRoot,
    }, {
      runManagedPluginPnpm: async (input) => {
        candidateRoot = input.projectRoot;
        await mkdir(join(input.projectRoot, 'node_modules'), { recursive: true });
        await symlink(outsideRoot, join(input.projectRoot, 'node_modules', 'escaped'), 'dir');
        return { ok: true, result: { exitCode: 0, signal: null, stdout: '', stderr: '' } };
      },
    })).rejects.toThrow(/symbolic link/i);

    expect(candidateRoot).toBeDefined();
    await expect(lstat(candidateRoot!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not canonicalize every regular installed dependency file while verifying the contained tree', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-regular-files-'));
    roots.push(happyHomeDir, pluginRoot);
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ dependencies: { fixture: '1.0.0' } }), 'utf8');
    await writeFile(join(pluginRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');

    const dependencyFiles = [
      join('node_modules', 'fixture', 'index.js'),
      join('node_modules', 'fixture', 'nested', 'payload.js'),
      join('node_modules', 'fixture', 'nested', 'metadata.json'),
    ];
    filesystemBoundary.realpathCallsByPath.clear();

    const materialized = await materializePluginDevelopmentCandidate({
      happyHomeDir,
      sourceRootPath: pluginRoot,
    }, {
      runManagedPluginPnpm: async (input) => {
        await mkdir(join(input.projectRoot, 'node_modules', 'fixture', 'nested'), { recursive: true });
        await Promise.all(dependencyFiles.map(async (relativePath) => {
          await writeFile(join(input.projectRoot, relativePath), 'export {};\n', 'utf8');
        }));
        return { ok: true, result: { exitCode: 0, signal: null, stdout: '', stderr: '' } };
      },
    });

    expect(filesystemBoundary.realpathCallsByPath.get(join(materialized.rootPath, 'node_modules'))).toBe(1);
    for (const relativePath of dependencyFiles) {
      expect(filesystemBoundary.realpathCallsByPath.get(join(materialized.rootPath, relativePath)) ?? 0).toBe(0);
    }

    await materialized.cleanup();
  });

  it('removes pnpm executable links that are not part of the daemon runtime closure', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-bin-links-'));
    roots.push(happyHomeDir, pluginRoot);
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
      dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
    }), 'utf8');
    await writeFile(join(pluginRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');

    const materialized = await materializePluginDevelopmentCandidate({
      happyHomeDir,
      sourceRootPath: pluginRoot,
    }, {
      runManagedPluginPnpm: async (input) => {
        const sdkRoot = join(input.projectRoot, 'node_modules', '@happier-dev', 'plugin-sdk');
        await mkdir(join(sdkRoot, 'dist'), { recursive: true });
        await mkdir(join(input.projectRoot, 'node_modules', '.bin'), { recursive: true });
        await writeFile(join(sdkRoot, 'dist', 'bin.js'), 'export {};\n', 'utf8');
        await symlink(
          join('..', '@happier-dev', 'plugin-sdk', 'dist', 'bin.js'),
          join(input.projectRoot, 'node_modules', '.bin', 'happier-plugin-build-ui'),
          'file',
        );
        return { ok: true, result: { exitCode: 0, signal: null, stdout: '', stderr: '' } };
      },
    });

    await expect(lstat(join(materialized.rootPath, 'node_modules', '.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(
      join(materialized.rootPath, 'node_modules', '@happier-dev', 'plugin-sdk', 'dist', 'bin.js'),
      'utf8',
    )).resolves.toBe('export {};\n');
    await materialized.cleanup();
  });

  it('drops author-owned dist so the daemon-owned UI build is the only development artifact producer', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-ui-artifacts-'));
    roots.push(happyHomeDir, pluginRoot);
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'happier-plugin-ui-dev' }), 'utf8');
    await mkdir(join(pluginRoot, 'src'), { recursive: true });
    await writeFile(join(pluginRoot, 'src', 'index.ts'), 'export const activate = () => {};\n', 'utf8');
    await mkdir(join(pluginRoot, 'dist', 'happier-plugin-ui', 'react-native', 'main-native', 'web'), { recursive: true });
    await writeFile(join(pluginRoot, 'dist', 'index.js'), 'export const activate = () => {};\n', 'utf8');
    await writeFile(
      join(pluginRoot, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'),
      JSON.stringify({ version: 1, entries: [] }),
      'utf8',
    );
    await writeFile(
      join(pluginRoot, 'dist', 'happier-plugin-ui', 'react-native', 'main-native', 'web', 'entry.mjs.bundle'),
      'export function renderSurface() {}\n',
      'utf8',
    );

    const materialized = await materializePluginDevelopmentCandidate({
      happyHomeDir,
      sourceRootPath: pluginRoot,
    }, { runManagedPluginPnpm: successfulManagedPnpmBoundary });

    await expect(lstat(join(materialized.rootPath, 'dist', 'happier-plugin-ui')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(materialized.rootPath, 'dist', 'index.js'))).rejects.toMatchObject({ code: 'ENOENT' });
    await materialized.cleanup();
  });

  it('resolves a lockless development source before freezing an author-supplied lock', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-lock-policy-'));
    roots.push(happyHomeDir, pluginRoot);
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
      name: 'acme-lock-policy',
      version: '1.0.0',
      dependencies: { 'fixture-dependency': '1.0.0' },
    }), 'utf8');

    const installArguments: Array<readonly string[]> = [];
    const runManagedPluginPnpm = async (input: Readonly<{
      projectRoot: string;
      args: readonly string[];
    }>) => {
      installArguments.push(input.args);
      await mkdir(join(input.projectRoot, 'node_modules', 'fixture-dependency'), { recursive: true });
      await writeFile(
        join(input.projectRoot, 'node_modules', 'fixture-dependency', 'index.js'),
        'export const fixture = true;\n',
        'utf8',
      );
      return await successfulManagedPnpmBoundary();
    };

    const lockless = await materializePluginDevelopmentCandidate({
      happyHomeDir,
      sourceRootPath: pluginRoot,
    }, { runManagedPluginPnpm });
    await lockless.cleanup();

    await writeFile(join(pluginRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
    const locked = await materializePluginDevelopmentCandidate({
      happyHomeDir,
      sourceRootPath: pluginRoot,
    }, { runManagedPluginPnpm });
    await locked.cleanup();

    expect(installArguments).toEqual([
      [
        'install',
        '--ignore-scripts',
        '--config.node-linker=hoisted',
        '--package-import-method=copy',
      ],
      [
        'install',
        '--ignore-scripts',
        '--frozen-lockfile',
        '--config.node-linker=hoisted',
        '--package-import-method=copy',
      ],
    ]);
  });

  it('materializes a regular-file development dependency closure before immutable Jiti activation', async () => {
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
      'export const activatedValue: string = `${value}:${developmentValue}`;',
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
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        runManagedPluginPnpm,
      }),
      createPendingChangeId: () => 'pending-development-closure',
    });
    const begun = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: true,
    });
    if (begun.kind !== 'reviewRequired') throw new Error('Expected review');

    const result = await service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'test', occurredAtMs: 1 },
    });
    expect(result).toMatchObject({ kind: 'committed', pluginId: 'acme.dev-closure' });
    expect(materializedCandidateRoot).toBeDefined();
    await expect(lstat(materializedCandidateRoot!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runManagedPluginPnpm).toHaveBeenCalledWith({
      projectRoot: expect.any(String),
      args: [
        'install',
        '--ignore-scripts',
        '--frozen-lockfile',
        '--config.node-linker=hoisted',
        '--package-import-method=copy',
      ],
      sdkRegistryOrigin: null,
    });
    await rm(join(pluginRoot, 'node_modules'), { recursive: true, force: true });

    const current = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({ happyHomeDir }));
    const generation = current?.generations.get('acme.dev-closure');
    expect(generation).toBeDefined();
    const pendingDirectories = [generation!.rootPath];
    while (pendingDirectories.length > 0) {
      const directory = pendingDirectories.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = join(directory, entry.name);
        expect((await lstat(entryPath)).isSymbolicLink()).toBe(false);
        if (entry.isDirectory()) pendingDirectories.push(entryPath);
      }
    }
    await expect(readFile(join(generation!.rootPath, 'node_modules', 'development-only-dependency', 'index.js'), 'utf8'))
      .resolves.toContain('materialized-development-value');
    await expect(readFile(join(generation!.rootPath, '.npmrc'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(generation!.rootPath, 'pnpm-lock.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    if (!generation!.installation?.trust) throw new Error('Expected committed installation authorization');
    const loaded = await loadPluginModule({
      source: {
        kind: 'file_backed',
        entryPath: join(generation!.rootPath, 'dist', 'index.js'),
        devEntryPath: join(generation!.rootPath, 'src', 'index.ts'),
        useDevelopmentEntry: true,
        trustPolicy: 'prompt',
        committedAuthorization: {
          pluginId: generation!.pluginId,
          immutableGenerationId: generation!.immutableGenerationId,
          distribution: generation!.installation.source.distribution,
          trust: generation!.installation.trust,
          isCurrent: current!.isCurrent,
        },
      },
      cacheKey: generation!.immutableGenerationId,
    });
    expect((loaded as { activatedValue?: string }).activatedValue)
      .toBe('materialized-runtime-value:materialized-development-value');
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
    await writeFile(entryPath, "export const sentinel = 'before';\nexport function activate(): void {}\n", 'utf8');
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
    const prepare = createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: {
        prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
      },
      runManagedPluginPnpm,
    });
    const preservedReviewResults: Array<unknown> = [];
    const service = createDaemonPluginChangeService({
      prepare: async (request) => {
        const prepared = await prepare(request);
        if (request.kind === 'development' && request.changedPaths?.[0] === 'src/index.ts') {
          preservedReviewResults.push(prepared.review);
        }
        return prepared;
      },
      createPendingChangeId: () => 'pending-repeated-development',
    });
    const initial = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: true,
    });
    if (initial.kind !== 'reviewRequired') throw new Error('Expected initial review');
    await service.decidePluginChange({
      pendingChangeId: initial.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'initial', occurredAtMs: 1 },
    });
    runManagedPluginPnpm.mockClear();

    const appliedSentinels: string[] = [];
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
          appliedSentinels.push((await loadCurrentDevelopmentSentinel({
            happyHomeDir,
            pluginId: 'acme.repeated-development',
            developmentEntryRelativePath: 'src/index.ts',
          })) ?? 'missing');
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
          `export const sentinel = '${sentinel}';\nexport function activate(): void {}\n`,
          'utf8',
        );
        await vi.waitFor(() => {
          if (observerFailure) throw observerFailure;
          expect(appliedSentinels.at(-1)).toBe(sentinel);
        }, { timeout: 10_000, interval: 25 });
        expect(runManagedPluginPnpm).not.toHaveBeenCalled();
        const current = await readCurrentCommittedPluginGenerations(
          resolvePluginStorePaths({ happyHomeDir }),
        );
        const generation = current?.generations.get('acme.repeated-development');
        expect(generation).toBeDefined();
        await expect(readFile(
          join(generation!.rootPath, 'node_modules', 'fixture-dependency', 'index.js'),
          'utf8',
        )).resolves.toContain('installed-once');
        editToInvocationDurationsMs.push(performance.now() - startedAt);
      }
    } finally {
      observer.stop();
    }
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
      "export const sentinel = 'after-dependency-change';\nexport function activate(): void {}\n",
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

  it('conflicts a stale source-only candidate instead of dropping a same-plugin successor generation', async () => {
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
    const readCurrentGeneration = async () => {
      const current = await readCurrentCommittedPluginGenerations(
        resolvePluginStorePaths({ happyHomeDir }),
      );
      const generation = current?.generations.get(pluginId);
      if (!generation) throw new Error('Expected current development generation');
      return generation;
    };

    const initial = await service.requestPluginChange({
      kind: 'development',
      sourceRootPath: sourceRoot,
    });
    if (initial.kind !== 'sourceRootReviewRequired') {
      throw new Error(`Expected source-root review, received ${initial.kind}`);
    }
    const initialPackageReview = await service.decidePluginChange({
      pendingChangeId: initial.pendingChangeId,
      decision: 'trustSourceRoot',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'initial', occurredAtMs: 1 },
    });
    if (initialPackageReview.kind !== 'reviewRequired') {
      throw new Error(`Expected package review, received ${initialPackageReview.kind}`);
    }
    await expect(service.decidePluginChange({
      pendingChangeId: initialPackageReview.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'initial-package', occurredAtMs: 2 },
      optionalSelections: [],
    })).resolves.toMatchObject({ kind: 'committed', pluginId });
    const generationG = await readCurrentGeneration();

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
    const generationH = await readCurrentGeneration();
    expect(generationH.immutableGenerationId).not.toBe(generationG.immutableGenerationId);
    await expect(readFile(join(generationH.rootPath, 'src', 'a.ts'), 'utf8')).resolves.toContain("'g'");
    await expect(readFile(join(generationH.rootPath, 'src', 'b.ts'), 'utf8')).resolves.toContain("'b'");

    releaseFirstSourceOnlyBuild();
    await expect(staleA).resolves.toEqual({ kind: 'conflict', pluginId });
    const afterStaleConflict = await readCurrentGeneration();
    expect(afterStaleConflict.immutableGenerationId).toBe(generationH.immutableGenerationId);
    await expect(readFile(join(afterStaleConflict.rootPath, 'src', 'a.ts'), 'utf8')).resolves.toContain("'g'");
    await expect(readFile(join(afterStaleConflict.rootPath, 'src', 'b.ts'), 'utf8')).resolves.toContain("'b'");

    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId,
      sourceRootPath: sourceRoot,
      changedPaths: ['src/a.ts'],
    })).resolves.toMatchObject({ kind: 'committed', pluginId });
    const merged = await readCurrentGeneration();
    await expect(readFile(join(merged.rootPath, 'src', 'a.ts'), 'utf8')).resolves.toContain("'a'");
    await expect(readFile(join(merged.rootPath, 'src', 'b.ts'), 'utf8')).resolves.toContain("'b'");
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
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async (candidate) => ({
            abort: async () => undefined,
            adopt: async () => Object.freeze(Object.fromEntries(
              candidate.changedPluginIds.map((pluginId) => [
                pluginId,
                candidate.pluginGenerations[pluginId]?.immutableGenerationId ?? null,
              ]),
            )),
          }),
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
        if (result.kind === 'sourceRootReviewRequired') {
          result = await service.decidePluginChange({
            pendingChangeId: result.pendingChangeId,
            decision: 'trustSourceRoot',
            actorEvidence: {
              kind: 'authenticatedLocalUser',
              interactionId: 'one-file-source-root',
              occurredAtMs: 1,
            },
          });
        }
        if (result.kind === 'reviewRequired') {
          result = await service.decidePluginChange({
            pendingChangeId: result.pendingChangeId,
            decision: 'installAndTrust',
            actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'one-file', occurredAtMs: 1 },
          });
        }
        if (result.kind !== 'committed') throw new Error(`Unexpected one-file update: ${result.kind}`);
        appliedSentinels.push((await loadCurrentDevelopmentSentinel({
          happyHomeDir,
          pluginId: 'acme.one-file-live',
          developmentEntryRelativePath: 'plugin.ts',
        })) ?? 'missing');
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

    const current = await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    );
    const generation = current?.generations.get('acme.one-file-live');
    expect(generation).toBeDefined();
    await expect(readFile(join(generation!.rootPath, '.happier-plugin', 'plugin.json'), 'utf8'))
      .resolves.toContain('"development": "./plugin.ts"');
    await expect(readFile(join(generation!.rootPath, 'package.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    if (!generation?.installation?.trust) throw new Error('Expected one-file development authorization');
    const loaded = await loadPluginModule({
      source: {
        kind: 'file_backed',
        entryPath: join(generation.rootPath, 'plugin.ts'),
        devEntryPath: join(generation.rootPath, 'plugin.ts'),
        useDevelopmentEntry: true,
        trustPolicy: 'prompt',
        committedAuthorization: {
          pluginId: generation.pluginId,
          immutableGenerationId: generation.immutableGenerationId,
          distribution: generation.installation.source.distribution,
          trust: generation.installation.trust,
          isCurrent: current!.isCurrent,
        },
      },
      cacheKey: generation.immutableGenerationId,
    });
    expect((loaded as { sentinel?: string }).sentinel).toBe('edit-10');
  });

  it('requires separate source-root and package trust confirmations before activating a one-file development plugin', async () => {
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

    const preparedCandidates: PluginRegistryRuntimeCandidate[] = [];
    let pendingChangeSequence = 0;
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async (candidate) => {
            preparedCandidates.push(candidate);
            const preparedModules = Reflect.get(
              candidate,
              'preparedActivationGraphsByPluginId',
            ) as ReadonlyMap<string, Readonly<{ module: Readonly<Record<string, unknown>> }>> | undefined;
            const activate = preparedModules?.get('acme.one-file-trust')?.module.activate;
            if (typeof activate === 'function') activate();
            return {
              abort: async () => undefined,
              adopt: async () => Object.freeze(Object.fromEntries(
                candidate.changedPluginIds.map((pluginId) => [
                  pluginId,
                  candidate.pluginGenerations[pluginId]?.immutableGenerationId ?? null,
                ]),
              )),
            };
          },
        },
        runManagedPluginPnpm: vi.fn(successfulManagedPnpmBoundary),
      }),
      createPendingChangeId: () => `pending-one-file-source-trust-${pendingChangeSequence += 1}`,
    });

    const cancelled = await service.requestPluginChange({
      kind: 'installPath',
      locator: sourcePath,
      development: true,
    });
    if (cancelled.kind === 'failed') throw new Error(cancelled.message ?? cancelled.code);
    expect(cancelled).toMatchObject({
      kind: 'sourceRootReviewRequired',
      review: { source: { kind: 'path', locator: await realpath(sourcePath) } },
    });
    await expect(readFile(counterPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    if (cancelled.kind !== 'sourceRootReviewRequired') return;
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
    let interaction = 0;

    await expect(requestUserPluginChange({
      request: { kind: 'development', sourceRootPath: sourcePath },
      approval: 'prompt',
    }, {
      ensureDaemon: async () => undefined,
      confirm: confirmations,
      requestChange,
      decideChange,
      createInteractionId: () => `source-and-package-${interaction += 1}`,
      nowMs: () => interaction,
    })).resolves.toMatchObject({
      kind: 'committed',
      pluginId: 'acme.one-file-trust',
    });

    const initial = observedRequests[0];
    expect(initial).toMatchObject({ kind: 'sourceRootReviewRequired' });
    if (initial?.kind !== 'sourceRootReviewRequired') return;
    expect(observedDecisions[0]).toMatchObject({
      kind: 'reviewRequired',
      pendingChangeId: initial.pendingChangeId,
      review: { pluginId: 'acme.one-file-trust' },
    });
    expect(decideChange).toHaveBeenNthCalledWith(1, {
      pendingChangeId: initial.pendingChangeId,
      decision: 'trustSourceRoot',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'source-and-package-1',
        occurredAtMs: 1,
      },
    });
    expect(decideChange).toHaveBeenNthCalledWith(2, {
      pendingChangeId: initial.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'source-and-package-2',
        occurredAtMs: 2,
      },
      optionalSelections: [],
    });
    expect(confirmations.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('Trust this plugin development source root?'),
      expect.stringContaining('Install & Trust One file trust'),
    ]);
    await expect(createPluginRegistryStateStore({ happyHomeDir }).read()).resolves.toMatchObject({
      plugins: {
        'acme.one-file-trust': {
          install: { trust: { approvedAtMs: 2 } },
        },
      },
    });
    expect(await readFile(counterPath, 'utf8')).toBe('module\nactivate\n');
    expect(preparedCandidates).toHaveLength(1);
    const preparedModules = Reflect.get(
      preparedCandidates[0]!,
      'preparedActivationGraphsByPluginId',
    ) as ReadonlyMap<string, Readonly<{ module: Readonly<Record<string, unknown>> }>> | undefined;
    expect(preparedModules?.get('acme.one-file-trust')?.module.activate).toEqual(expect.any(Function));
  });

  it('persists package trust while optional access remains selection-only across edits', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-one-file-optional-home-'));
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-one-file-optional-source-'));
    roots.push(happyHomeDir, sourceRoot);
    const sourcePath = join(sourceRoot, 'plugin.ts');
    const writeSource = async (sentinel: string): Promise<void> => {
      await writeFile(sourcePath, [
        'export const manifest = {',
        "  schemaVersion: 2, id: 'acme.one-file-optional', version: '1.0.0',",
        "  displayName: 'One file optional', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        '  hostAccess: { required: [], optional: [{',
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
                candidate.pluginGenerations[pluginId]?.immutableGenerationId ?? null,
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
    if (requested.kind !== 'sourceRootReviewRequired') {
      throw new Error(`Expected source-root review, received ${requested.kind}`);
    }
    const approved = await service.decidePluginChange({
      pendingChangeId: requested.pendingChangeId,
      decision: 'trustSourceRoot',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'source-root-trust',
        occurredAtMs: 11,
      },
    });
    expect(approved).toMatchObject({
      kind: 'reviewRequired',
      review: {
        pluginId: 'acme.one-file-optional',
        optionalHostAccess: [expect.objectContaining({ id: 'project-sessions' })],
      },
    });
    if (approved.kind !== 'reviewRequired') return;
    await expect(service.decidePluginChange({
      pendingChangeId: approved.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'optional-selection',
        occurredAtMs: 22,
      },
      optionalSelections: [{ accessId: 'project-sessions', selected: true }],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.one-file-optional' });

    await expect(createPluginRegistryStateStore({ happyHomeDir }).read()).resolves.toMatchObject({
      plugins: {
        'acme.one-file-optional': {
          install: {
            trust: { approvedAtMs: 22 },
            optionalAccess: [{
              accessId: 'project-sessions',
              capability: 'sessions',
              selectedAtMs: 22,
            }],
          },
        },
      },
    });

    await writeSource('updated');
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.one-file-optional',
      sourceRootPath: sourcePath,
      changedPaths: ['plugin.ts'],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.one-file-optional' });
    await expect(createPluginRegistryStateStore({ happyHomeDir }).read()).resolves.toMatchObject({
      plugins: {
        'acme.one-file-optional': {
          install: {
            trust: { approvedAtMs: 22 },
            optionalAccess: [{ accessId: 'project-sessions', selectedAtMs: 22 }],
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
        prepare: async (candidate) => {
          const reference = candidate.pluginGenerations['acme.owned-graph'];
          if (!reference) throw new Error('Expected owned graph generation');
          const rootPath = join(
            resolvePluginStorePaths({ happyHomeDir }).generationsDir,
            reference.immutableGenerationId,
          );
          preparedRoots.push(rootPath);
          const graph = candidate.preparedActivationGraphsByPluginId?.get('acme.owned-graph');
          if (!graph) throw new Error('Expected prepared activation graph');
          const leaf = await loadVerifiedPluginModule({
            entryPath: join(rootPath, 'src', 'leaf.ts'),
            loadMode: 'source-ts',
            generationScope: graph.generationScope,
          });
          const activate = graph.module.activate;
          if (typeof activate !== 'function') throw new Error('Expected activation export');
          expect(activate()).toBe(leaf.marker);
          return {
            abort: async () => undefined,
            adopt: async () => undefined,
          };
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
    expect(unapproved.kind).toBe('sourceRootReviewRequired');
    await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    if (unapproved.kind !== 'sourceRootReviewRequired') return;
    const packageReview = await service.decidePluginChange({
      pendingChangeId: unapproved.pendingChangeId,
      decision: 'trustSourceRoot',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'root', occurredAtMs: 1 },
    });
    expect(packageReview).toMatchObject({
      kind: 'reviewRequired',
      review: { pluginId: 'acme.owned-graph' },
    });
    if (packageReview.kind !== 'reviewRequired') return;
    await expect(service.decidePluginChange({
      pendingChangeId: packageReview.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'package', occurredAtMs: 2 },
      optionalSelections: [],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.owned-graph' });
    expect(await readFile(logPath, 'utf8')).toBe('leaf\nmodule:initial\nactivate:initial\n');
    const committed = await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    );
    expect(await Promise.all(preparedRoots.map(async (path) => await realpath(path)))).toEqual([
      committed?.generations.get('acme.owned-graph')?.rootPath,
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
    const sourceEditGeneration = (await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    ))?.generations.get('acme.owned-graph');
    await expect(readFile(
      join(sourceEditGeneration!.rootPath, 'node_modules', 'fixture-dependency', 'index.js'),
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

    const generationsDir = resolvePluginStorePaths({ happyHomeDir }).generationsDir;
    const generationsBeforeConflict = (await readdir(generationsDir)).sort();
    await writeEntry('identity-conflict', 'acme.substituted-graph');
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.owned-graph',
      sourceRootPath: sourceRoot,
      changedPaths: ['src/index.ts'],
    })).resolves.toEqual({ kind: 'conflict', pluginId: 'acme.owned-graph' });
    expect((await readdir(generationsDir)).sort()).toEqual(generationsBeforeConflict);
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
    expect(sourceRootReview.kind).toBe('sourceRootReviewRequired');
    if (sourceRootReview.kind !== 'sourceRootReviewRequired') return;
    const initialPackageReview = await service.decidePluginChange({
      pendingChangeId: sourceRootReview.pendingChangeId,
      decision: 'trustSourceRoot',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'development-closure-root',
        occurredAtMs: 1,
      },
    });
    if (initialPackageReview.kind !== 'reviewRequired') {
      throw new Error(`Expected package review, received ${initialPackageReview.kind}`);
    }
    await expect(service.decidePluginChange({
      pendingChangeId: initialPackageReview.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'development-closure-package',
        occurredAtMs: 2,
      },
      optionalSelections: [],
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
    const sourceOnlyGeneration = (await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    ))?.generations.get('acme.development-closure');
    expect(sourceOnlyGeneration).toBeDefined();
    expect(uiBuildRoots).toHaveLength(2);
    expect(uiBuildRoots[1]).not.toBe(sourceRoot);
    await expect(readFile(
      join(sourceOnlyGeneration!.rootPath, 'dist', 'happier-plugin-ui', 'ui-byte.txt'),
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
    const dependencyChangedGeneration = (await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    ))?.generations.get('acme.development-closure');
    await expect(readFile(
      join(dependencyChangedGeneration!.rootPath, 'node_modules', 'fixture-added-dependency', 'index.js'),
      'utf8',
    )).resolves.toContain('fixture-added-dependency');

    const retainedGenerationId = dependencyChangedGeneration!.immutableGenerationId;
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
    expect((await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    ))?.generations.get('acme.development-closure')?.immutableGenerationId).toBe(retainedGenerationId);

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
    const rejoinedGeneration = (await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    ))?.generations.get('acme.development-closure');
    expect(rejoinedGeneration?.immutableGenerationId).not.toBe(retainedGenerationId);
    await expect(readFile(
      join(rejoinedGeneration!.rootPath, 'node_modules', 'fixture-retry-dependency', 'index.js'),
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
    expect(ordinaryGenerationSourceReview.kind).toBe('sourceRootReviewRequired');
    if (ordinaryGenerationSourceReview.kind !== 'sourceRootReviewRequired') return;
    await expect(service.decidePluginChange({
      pendingChangeId: ordinaryGenerationSourceReview.pendingChangeId,
      decision: 'trustSourceRoot',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'development-closure-reapprove-source',
        occurredAtMs: 2,
      },
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.development-closure' });
    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
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
      prepare: async (request) => {
        if (request.kind === 'development' && request.pluginId === 'acme.manual-delete') {
          manualChangedPaths.push(request.changedPaths);
        }
        return await prepare(request);
      },
      createPendingChangeId: () => 'pending-manual-delete',
    });

    const initial = await service.requestPluginChange({
      kind: 'development',
      sourceRootPath: sourceRoot,
    });
    if (initial.kind !== 'sourceRootReviewRequired') {
      throw new Error(`Expected source-root review, received ${initial.kind}`);
    }
    const initialPackageReview = await service.decidePluginChange({
      pendingChangeId: initial.pendingChangeId,
      decision: 'trustSourceRoot',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'manual-delete-root',
        occurredAtMs: 1,
      },
    });
    if (initialPackageReview.kind !== 'reviewRequired') {
      throw new Error(`Expected package review, received ${initialPackageReview.kind}`);
    }
    await expect(service.decidePluginChange({
      pendingChangeId: initialPackageReview.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'manual-delete-package',
        occurredAtMs: 2,
      },
      optionalSelections: [],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.manual-delete' });
    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
    const before = await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    );
    const beforeGeneration = before?.generations.get('acme.manual-delete');
    expect(beforeGeneration?.record.files.map((file) => file.relativePath)).toContain('src/obsolete.ts');
    await rm(deletedSourcePath);
    runManagedPluginPnpm.mockClear();
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.manual-delete',
      sourceRootPath: sourceRoot,
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.manual-delete' });

    expect(manualChangedPaths).toEqual([undefined]);
    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
    const after = await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    );
    const afterGeneration = after?.generations.get('acme.manual-delete');
    expect(afterGeneration?.record.files.map((file) => file.relativePath))
      .not.toContain('src/obsolete.ts');
    await expect(readFile(join(afterGeneration!.rootPath, 'src', 'obsolete.ts'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(
      join(afterGeneration!.rootPath, 'node_modules', 'fixture-dependency', 'index.js'),
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
    if (initial.kind !== 'sourceRootReviewRequired') {
      throw new Error(`Expected source-root review, received ${initial.kind}`);
    }
    const initialPackageReview = await service.decidePluginChange({
      pendingChangeId: initial.pendingChangeId,
      decision: 'trustSourceRoot',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'sensitive-inputs-root',
        occurredAtMs: 1,
      },
    });
    if (initialPackageReview.kind !== 'reviewRequired') {
      throw new Error(`Expected package review, received ${initialPackageReview.kind}`);
    }
    await expect(service.decidePluginChange({
      pendingChangeId: initialPackageReview.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'sensitive-inputs-package',
        occurredAtMs: 2,
      },
      optionalSelections: [],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.sensitive-inputs' });
    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
    const installedGeneration = (await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    ))?.generations.get('acme.sensitive-inputs');
    runManagedPluginPnpm.mockClear();
    await writeEntry('after-manual-reload');
    await expect(service.requestPluginChange({
      kind: 'development',
      pluginId: 'acme.sensitive-inputs',
      sourceRootPath: sourceRoot,
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.sensitive-inputs' });

    expect(runManagedPluginPnpm).toHaveBeenCalledTimes(1);
    const reloadedGeneration = (await readCurrentCommittedPluginGenerations(
      resolvePluginStorePaths({ happyHomeDir }),
    ))?.generations.get('acme.sensitive-inputs');
    expect(reloadedGeneration?.immutableGenerationId)
      .not.toBe(installedGeneration?.immutableGenerationId);
    await expect(readFile(join(reloadedGeneration!.rootPath, 'src', 'index.ts'), 'utf8'))
      .resolves.toContain("sentinel = 'after-manual-reload'");
    await expect(readFile(join(reloadedGeneration!.rootPath, '.npmrc'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
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
    expect(requested.kind).toBe('sourceRootReviewRequired');
    if (requested.kind !== 'sourceRootReviewRequired') return;
    await rm(locator);
    await symlink(secondRoot, locator, 'file');
    await expect(service.decidePluginChange({
      pendingChangeId: requested.pendingChangeId,
      decision: 'trustSourceRoot',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'substitution', occurredAtMs: 1 },
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
  it('prepares a local development source under its reserved id without granting bundled authority', async () => {
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

    const prepared = await prepare({
      kind: 'installPath',
      locator: BUNDLED_PLUGIN_ROOT,
      development: true,
    });

    expect(prepared).toMatchObject({ pluginId: bundledManifest.id });
    await prepared.cleanup();
  }, 180_000);

  // C1: an external plugin developed from a local working tree is the same
  // record shape as a bundled one — a path the operator authored on this
  // machine. Provenance, not authorship, decides the registry-lifecycle rules,
  // so the reserved namespace must not lock an external author out of the dev
  // loop that the discovery owner already admitted.
  it('prepares a development install of an external local path plugin under a reserved id', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-external-reserved-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({ pluginId: 'happier.agent.fake' });
    const prepare = createDaemonPathPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: {
        prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
      },
      runManagedPluginPnpm: successfulManagedPnpmBoundary,
      runPluginUiArtifactBuild: async (input) => ({ ok: true as const, projectRoot: input.projectRoot, built: false }),
    });

    const prepared = await prepare({
      kind: 'installPath',
      locator: pluginRoot,
      development: true,
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
    await mkdir(join(developmentOnlyRoot, 'src'), { recursive: true });
    await writeFile(join(developmentOnlyRoot, 'src', 'index.ts'), 'export function activate(): void {}\n', 'utf8');
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
        updatePolicy: 'manual',
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
    const adopt = vi.fn(async () => undefined);
    const prepareRuntime = vi.fn(async () => ({ abort: async () => undefined, adopt }));
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
      kind: 'reviewRequired',
      review: expect.objectContaining({ pluginId: 'acme.descriptor', executableRealms: [] }),
    }));
    if (begun.kind !== 'reviewRequired') throw new Error('Expected review');

    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'test', occurredAtMs: 1 },
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

  it('reports the generation committed by its own transaction when currentness advances before the response', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin();
    let preparePath!: ReturnType<typeof createDaemonPathPluginChangePreparer>;
    let runtimePreparationCount = 0;
    let firstGeneration: string | undefined;
    let laterGeneration: string | undefined;
    const runtimeLifecycle: PluginRegistryRuntimeLifecycle = {
      prepare: async (candidate) => {
        runtimePreparationCount += 1;
        const generation = candidate.pluginGenerations['acme.descriptor']?.immutableGenerationId;
        if (!generation) throw new Error('Expected descriptor generation');
        if (runtimePreparationCount === 1) firstGeneration = generation;
        else laterGeneration = generation;
        const isFirst = runtimePreparationCount === 1;
        return {
          abort: async () => undefined,
          adopt: async () => {
            if (!isFirst) return;
            await writeFile(join(pluginRoot, 'payload.txt'), 'later generation bytes');
            const laterPrepared = await preparePath({
              kind: 'installPath',
              locator: pluginRoot,
              development: true,
            });
            if ('kind' in laterPrepared) throw new Error('Unexpected source-root review for descriptor plugin');
            const laterResult = await laterPrepared.apply(undefined);
            expect(laterResult).toMatchObject({
              kind: 'committed',
              desiredGeneration: laterGeneration,
            });
          },
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
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'test', occurredAtMs: 1 },
    });

    expect(firstGeneration).toBeDefined();
    expect(laterGeneration).toBeDefined();
    expect(laterGeneration).not.toBe(firstGeneration);
    expect(result).toMatchObject({
      kind: 'committed',
      desiredGeneration: firstGeneration,
      appliedGeneration: firstGeneration,
    });
  });

  it('installs the daemon-owned non-development candidate reviewed before source bytes change', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin();
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
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'test', occurredAtMs: 1 },
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
      kind: 'reviewRequired',
      review: { optionalHostAccess: [{ id: 'project-sessions', capability: 'sessions' }] },
    });
    if (begun.kind !== 'reviewRequired') throw new Error('Expected review');

    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'test', occurredAtMs: 7 },
      optionalSelections: [{ accessId: 'project-sessions', selected: true }],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.descriptor' });
    await expect(createPluginRegistryStateStore({ happyHomeDir }).read()).resolves.toMatchObject({
      plugins: {
        'acme.descriptor': {
          install: {
            optionalAccess: [{
              accessId: 'project-sessions',
              capability: 'sessions',
              selectedAtMs: 7,
            }],
          },
        },
      },
    });
  });

  it('reuses source trust for later development replacements without another review', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin();
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
    const first = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: true,
    });
    if (first.kind !== 'reviewRequired') throw new Error('Expected initial review');
    await service.decidePluginChange({
      pendingChangeId: first.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'test', occurredAtMs: 1 },
    });
    await writeFile(join(pluginRoot, 'payload.txt'), 'development edit');

    await expect(service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: true,
    })).resolves.toEqual(expect.objectContaining({ kind: 'committed', pluginId: 'acme.descriptor' }));
  });

  it('requires a new decision when a trusted development replacement narrows ambient required access', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({
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
    const first = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: true,
    });
    if (first.kind !== 'reviewRequired') throw new Error('Expected initial review');
    await service.decidePluginChange({
      pendingChangeId: first.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'initial-path-trust', occurredAtMs: 1 },
    });

    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    const hostAccess = manifest.hostAccess as {
      required: Array<{
        scope: { targets: Array<{ kind: string; origin: string }> };
      }>;
      optional: unknown[];
    };
    hostAccess.required[0]!.scope.targets = [{
      kind: 'fixedOrigin',
      origin: 'https://api.example.test',
    }];
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    await expect(service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: true,
    })).resolves.toMatchObject({
      kind: 'reviewRequired',
      review: {
        pluginId: 'acme.descriptor',
        requiredHostAccess: [expect.objectContaining({
          id: 'api',
          capability: 'network',
          normalizedScope: {
            targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }],
          },
        })],
      },
    });
  });

  it('rejects a development source whose manifest identity changed after observation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin({ pluginId: 'acme.changed' });
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
    })).resolves.toEqual({
      kind: 'conflict',
      pluginId: 'acme.observed',
    });

    expect(runManagedPluginPnpm).not.toHaveBeenCalled();
    await expect(
      createPluginRegistryStateStore({ happyHomeDir }).read(),
    ).resolves.toMatchObject({ plugins: {} });
  });

  it('rejects a prepared replacement when the same plugin state changes before apply', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-home-'));
    roots.push(happyHomeDir);
    const pluginRoot = await createDescriptorPlugin();
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
    const first = await service.requestPluginChange({
      kind: 'installPath',
      locator: pluginRoot,
      development: true,
    });
    if (first.kind !== 'reviewRequired') throw new Error('Expected initial review');
    await service.decidePluginChange({
      pendingChangeId: first.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'test', occurredAtMs: 1 },
    });

    const prepared = await prepare({
      kind: 'installPath',
      locator: pluginRoot,
      development: true,
    });
    if ('kind' in prepared) throw new Error('Unexpected source-root review for descriptor plugin');
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

    await expect(prepared.apply(undefined)).resolves.toEqual({
      kind: 'conflict',
      pluginId: 'acme.descriptor',
    });
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
            ? candidate.pluginGenerations[pluginId]?.immutableGenerationId ?? null
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
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'test', occurredAtMs: 1 },
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
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'retry', occurredAtMs: 2 },
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
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'test', occurredAtMs: 1 },
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
      actorEvidence: {
        kind: 'authenticatedLocalUser' as const,
        interactionId: 'confirmed-delete',
        occurredAtMs: 1,
      },
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
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'confirmed-reserved-delete',
        occurredAtMs: 1,
      },
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
                  ? candidate.pluginGenerations[pluginId]?.immutableGenerationId ?? null
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
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'install', occurredAtMs: 1 },
    });
    const request = {
      kind: 'uninstallAndDeleteData' as const,
      pluginId: 'acme.descriptor',
      actorEvidence: {
        kind: 'authenticatedLocalUser' as const,
        interactionId: 'confirmed-delete',
        occurredAtMs: 2,
      },
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
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'test', occurredAtMs: 1 },
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
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'test', occurredAtMs: 1 },
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
                  ? candidate.pluginGenerations[pluginId]?.immutableGenerationId ?? null
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
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'test', occurredAtMs: 1 },
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
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'update', occurredAtMs: 2 },
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
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'reinstall', occurredAtMs: 3 },
    });

    expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins['acme.descriptor'])
      .toMatchObject({
        source: { trustPolicy: 'prompt' },
        install: { trust: { state: 'trusted' } },
        state: { enabled: true },
      });
  });
});
