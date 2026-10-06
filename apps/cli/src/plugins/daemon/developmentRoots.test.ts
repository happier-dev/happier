import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectPath } from '@/projectPath';
import { BUNDLED_FIRST_PARTY_PLUGIN_METADATA } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createBundledActivationSourceResolver } from '@/plugins/runtime/bundledActivationSource';
import { collectActivationTargets } from '@/plugins/runtime/lifecycle/activation/targets';

import {
  createDaemonPluginDevelopmentRootsOwner,
  type DaemonPluginDevelopmentObservation,
} from './developmentRoots';
import { createDaemonPluginChangeService } from './changeService';
import { createDaemonPathPluginChangePreparer } from './pathChangePreparer';
import { startPluginDevelopmentSourceObserver } from '@/plugins/authoring/sourceObserver';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { handlePluginsCommand } from '@/cli/commands/plugins';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { bindProcessLogger, Logger } from '@/ui/logger';

const temporaryDirectories: string[] = [];
const packageRootObservation = {
  sourceKind: 'packageRoot',
  observedRelativePaths: [],
  declaredDependencies: {},
  observedDirectoryPaths: [],
} as const;

async function createDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

describe('daemon plugin development root ownership', () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }));
  });

  it('returns the typed preparation failure for an explicit standalone root and retains its recovery status', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-install-failure-home-');
    const sourceRoot = await createDirectory('happier-daemon-dev-install-failure-source-');
    const missingDependencyPath = join(sourceRoot, 'node_modules', 'missing-dependency');
    const logPath = join(happyHomeDir, 'preparation.log');
    const localLogger = new Logger({
      logFilePath: logPath,
      allowDangerousRemoteLogging: false,
      pruneCurrentProcessLogs: false,
    });
    const restoreLogger = bindProcessLogger(localLogger);
    await mkdir(join(sourceRoot, '.happier-plugin'));
    await writeFile(join(sourceRoot, 'package.json'), '{"name":"standalone-plugin","version":"1.0.0"}\n');
    await writeFile(join(sourceRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(
      createPluginManifestV2Fixture({ id: 'acme.install-failure', entrypoints: undefined }),
    ));
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: { prepare: async () => { throw new Error('Failed dependencies cannot reach runtime adoption'); } },
        // The managed tool boundary encounters a real missing local dependency.
        runManagedPluginPnpm: async () => {
          await lstat(missingDependencyPath);
          throw new Error('Missing dependency unexpectedly exists');
        },
      }),
    });
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: async ({ request }) => await service.requestPluginChange({
        ...request,
        sourceRootPath: request.projectRoot,
      }),
      // Watch delivery is the OS boundary; classification, initial observation,
      // preparation, service failure and status projection all remain real.
      startCollectionObserver: async () => ({ stop() {} }),
      startSourceObserver: async (projectRoot, onObservation) => await startPluginDevelopmentSourceObserver({
        projectRoot,
        onObservation,
        startWatchingDirectory: () => ({ ready: Promise.resolve(), stop() {} }),
      }),
    });
    try {
      await owner.initialize();
      await expect(owner.control({ kind: 'registerExplicit', rootPath: sourceRoot })).resolves.toMatchObject({
        kind: 'failed',
        code: 'plugin_dev_dependency_preparation_failed',
        message: expect.stringContaining('[REDACTED_PATH]'),
        status: { plugins: [expect.objectContaining({ sourceRootPath: sourceRoot, phase: 'unavailable' })] },
      });
      await expect(owner.readPersistedStateForTest()).resolves.toMatchObject({
        explicitRoots: [{ rootPath: sourceRoot }],
      });
      localLogger.flushSync();
      const log = await readFile(logPath, 'utf8');
      expect(log).toContain('[WARN]');
      expect(log).toContain('plugin_dev_dependency_preparation_failed');
      expect(log).toContain(missingDependencyPath);
      for (const args of [
        ['install', sourceRoot, '--dev', '--json'],
        ['dev', sourceRoot, '--json'],
      ]) {
        const output = captureStdoutJsonOutput();
        try {
          await handlePluginsCommand(args, {
            ensureDaemon: async () => undefined,
            controlPluginDevelopment: async (request) => await owner.control(request),
          });
          expect(output.json()).toMatchObject({
            ok: false,
            error: { code: 'plugin_dev_dependency_preparation_failed' },
          });
          expect(JSON.stringify(output.json())).not.toContain(missingDependencyPath);
          expect(process.exitCode).toBe(1);
        } finally {
          output.restore();
          process.exitCode = undefined;
        }
      }
    } finally {
      await owner.stop();
      await service.shutdown();
      restoreLogger();
    }
  });

  it('admits only the generated first-party source identity before daemon root initialization', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-first-party-source-home-');
    const repoRoot = await realpath(resolve(projectPath(), '..', '..'));
    const sourceRoot = join(repoRoot, 'packages', 'plugins', 'antigravity');
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(),
    });

    for (const metadata of BUNDLED_FIRST_PARTY_PLUGIN_METADATA) {
      const packageRoot = join(repoRoot, 'packages', 'plugins', metadata.pluginPackageId);
      expect(owner.resolveDevelopmentSourceAuthority({
        pluginId: metadata.pluginId,
        rootPath: packageRoot,
      }), metadata.pluginId).toMatchObject({
        kind: 'development',
        registeredRootId: packageRoot,
        canonicalRoot: packageRoot,
        observedRevision: 0,
      });
    }
    expect(owner.isDevelopmentSourceRegistered(sourceRoot)).toBe(true);
    expect(owner.resolveDevelopmentSourceAuthority({
      pluginId: 'happier.agent.codex',
      rootPath: sourceRoot,
    })).toBeNull();
    expect(owner.resolveDevelopmentSourceAuthority({
      pluginId: 'happier.agent.antigravity',
      rootPath: join(sourceRoot, 'src'),
    })).toBeNull();
    expect(owner.resolveDevelopmentSourceAuthority({
      pluginId: 'happier.agent.unknown',
      rootPath: resolve(projectPath(), '..', '..', 'packages', 'plugins', 'unknown'),
    })).toBeNull();
    await owner.stop();
  });

  it('binds first-party source custody through the bundled activation loader before startup', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-bundled-source-home-');
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(),
    });
    const resolveSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-antigravity'],
      resolveDevelopmentSourceAuthority: owner.resolveDevelopmentSourceAuthority,
    });

    const contributes = await resolveMergedContributionRegistry({ happyHomeDir });
    const antigravityTarget = collectActivationTargets(contributes)
      .find((target) => target.pluginId === 'happier.agent.antigravity');
    expect(antigravityTarget?.daemonEntryPath).toBe('@happier-dev/plugins-antigravity');
    expect(antigravityTarget && resolveSource(antigravityTarget)?.sourceAuthority).toMatchObject({
      kind: 'development',
      registeredRootId: await realpath(resolve(projectPath(), '..', '..', 'packages', 'plugins', 'antigravity')),
      observedRevision: 0,
    });
    await owner.stop();
  });

  it('derives and starts the home plugin root without persisting a trust grant', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-home-');
    const starts: string[] = [];
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(async () => ({ kind: 'committed', pluginId: 'acme.home' })),
      startCollectionObserver: async (rootPath) => {
        starts.push(rootPath);
        return { stop: vi.fn() };
      },
      startSourceObserver: vi.fn(),
    });

    await owner.initialize();

    expect(starts).toEqual([join(await realpath(happyHomeDir), 'plugins')]);
    expect(owner.readStatus().roots).toEqual([
      expect.objectContaining({ kind: 'home', trusted: true, persisted: false }),
    ]);
    await expect(owner.readPersistedStateForTest()).resolves.toEqual({
      version: 1,
      projects: {},
      explicitRoots: [],
    });
    await owner.stop();
  });

  it('discovers only the canonical four literal source extensions in a plugin collection', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-file-collection-home-');
    const pluginRoot = join(happyHomeDir, 'plugins');
    await mkdir(pluginRoot, { recursive: true });
    const supported = ['plugin.ts', 'plugin.mts', 'plugin.js', 'plugin.mjs'];
    const unsupported = ['plugin.tsx', 'plugin.cts', 'plugin.jsx', 'plugin.cjs'];
    await Promise.all([...supported, ...unsupported].map(async (name) => {
      await writeFile(join(pluginRoot, name), 'export function activate() {}\n', 'utf8');
    }));
    const sourceStarts: string[] = [];
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(),
      startCollectionObserver: async () => ({ stop: vi.fn() }),
      startSourceObserver: async (rootPath) => {
        sourceStarts.push(rootPath);
        return { stop: vi.fn(), failure: new Promise<Error>(() => undefined) };
      },
    });

    await owner.initialize();

    expect(sourceStarts.sort()).toEqual(supported.map((name) => join(pluginRoot, name)).sort());
    await owner.stop();
  });

  it('asks once for an existing workspace plugin root, activates only after acceptance, and remembers it', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-workspace-home-');
    const projectRoot = await createDirectory('happier-daemon-dev-project-');
    const pluginRoot = join(projectRoot, '.happier', 'plugins');
    const candidateRoot = join(pluginRoot, 'acme-workspace');
    await mkdir(join(candidateRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(candidateRoot, '.happier-plugin', 'plugin.json'), '{}', 'utf8');
    const starts: string[] = [];
    const sourceStarts: string[] = [];
    const submitObservation = vi.fn(async () => ({ kind: 'committed' as const, pluginId: 'acme.workspace' }));
    let deliver!: (observation: DaemonPluginDevelopmentObservation) => Promise<'adopted' | 'retained'>;
    const dependencies = {
      happyHomeDir,
      submitObservation,
      startCollectionObserver: async (rootPath: string) => {
        starts.push(rootPath);
        return { stop: vi.fn() };
      },
      startSourceObserver: async (
        rootPath: string,
        onObservation: (observation: DaemonPluginDevelopmentObservation) => Promise<'adopted' | 'retained'>,
      ) => {
        sourceStarts.push(rootPath);
        deliver = onObservation;
        return { stop: vi.fn(), failure: new Promise<Error>(() => undefined) };
      },
    };
    const first = createDaemonPluginDevelopmentRootsOwner(dependencies);
    await first.initialize();

    const pending = await first.control({ kind: 'registerWorkspace', projectRoot });
    expect(pending).toMatchObject({ kind: 'trustRequired' });
    expect(first.readPendingProjectTrusts()).toEqual([
      expect.objectContaining({ projectRoot, pluginRoot }),
    ]);
    expect(first.readPendingProjectTrusts()[0]?.pendingChangeId).toEqual(expect.any(String));
    expect(starts).toHaveLength(1);
    expect(sourceStarts).toEqual([]);

    await first.control({ kind: 'registerWorkspace', projectRoot, trust: 'deny' });
    expect(first.readPendingProjectTrusts()).toEqual([]);
    expect(sourceStarts).toEqual([]);

    await first.control({ kind: 'registerWorkspace', projectRoot });
    expect(first.readPendingProjectTrusts()).toHaveLength(1);
    await first.control({ kind: 'registerWorkspace', projectRoot, trust: 'accept' });
    expect(first.readPendingProjectTrusts()).toEqual([]);
    expect(starts).toContain(pluginRoot);
    expect(sourceStarts).toEqual([candidateRoot]);
    await expect(deliver({
      ok: true,
      ...packageRootObservation,
      sourceRootPath: candidateRoot,
      request: { kind: 'development', projectRoot: candidateRoot },
    })).resolves.toBe('adopted');
    expect(submitObservation).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ observedRevision: 1 }),
    }));
    await first.stop();

    starts.length = 0;
    const restarted = createDaemonPluginDevelopmentRootsOwner(dependencies);
    await restarted.initialize();
    await expect(restarted.control({ kind: 'registerWorkspace', projectRoot }))
      .resolves.toMatchObject({ kind: 'status' });
    expect(starts).toContain(pluginRoot);
    await restarted.stop();
  });

  it('does not prompt or start a watcher when a presented workspace has no plugin directory', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-absent-home-');
    const projectRoot = await createDirectory('happier-daemon-dev-absent-project-');
    const starts: string[] = [];
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(async () => ({ kind: 'committed', pluginId: 'unused' })),
      startCollectionObserver: async (rootPath) => {
        starts.push(rootPath);
        return { stop: vi.fn() };
      },
      startSourceObserver: vi.fn(),
    });

    await owner.initialize();
    await expect(owner.control({ kind: 'registerWorkspace', projectRoot }))
      .resolves.toMatchObject({ kind: 'status' });
    expect(starts).toEqual([join(await realpath(happyHomeDir), 'plugins')]);
    await expect(owner.readPersistedStateForTest()).resolves.toEqual({
      version: 1,
      projects: {},
      explicitRoots: [],
    });
    await owner.stop();
  });

  it('restores the SDK registry attached to an explicit root registration', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-registry-home-');
    const sourceRoot = await createDirectory('happier-daemon-dev-registry-source-');
    const starts: Array<Readonly<{ rootPath: string; sdkRegistryOrigin?: string }>> = [];
    const dependencies = {
      happyHomeDir,
      submitObservation: vi.fn(async () => ({ kind: 'committed' as const, pluginId: 'acme.registry' })),
      startCollectionObserver: async () => ({ stop: vi.fn() }),
      startSourceObserver: async (rootPath: string, _onObservation: unknown, sdkRegistryOrigin?: string) => {
        starts.push({ rootPath, ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}) });
        return { stop: vi.fn(), failure: new Promise<Error>(() => undefined) };
      },
    };
    const first = createDaemonPluginDevelopmentRootsOwner(dependencies);
    await first.initialize();
    await first.control({
      kind: 'registerExplicit',
      rootPath: sourceRoot,
      sdkRegistryOrigin: 'https://registry.example.test',
    });
    // The intrinsically trusted home collection is also always present; this
    // assertion is about preserving the explicit registration.
    await expect(first.control({
      kind: 'registerExplicit',
      rootPath: sourceRoot,
      sdkRegistryOrigin: 'https://other-registry.example.test',
    })).resolves.toMatchObject({
      kind: 'failed',
      status: { roots: expect.arrayContaining([
        expect.objectContaining({ kind: 'explicit', rootPath: sourceRoot }),
      ]) },
    });
    expect(starts).toEqual([{
      rootPath: await realpath(sourceRoot),
      sdkRegistryOrigin: 'https://registry.example.test',
    }]);
    await expect(first.readPersistedStateForTest()).resolves.toMatchObject({
      explicitRoots: [{
        rootPath: await realpath(sourceRoot),
        sdkRegistryOrigin: 'https://registry.example.test',
      }],
    });
    await first.stop();

    starts.length = 0;
    const restarted = createDaemonPluginDevelopmentRootsOwner(dependencies);
    await restarted.initialize();

    expect(starts).toEqual([{
      rootPath: await realpath(sourceRoot),
      sdkRegistryOrigin: 'https://registry.example.test',
    }]);
    await restarted.stop();
  });

  it('forgets an exact explicit root, retires its current occurrence, and does not restore it after restart', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-forget-home-');
    const sourceRoot = await createDirectory('happier-daemon-dev-forget-source-');
    const sourceStop = vi.fn();
    const adoptRemoval = vi.fn(async () => undefined);
    let deliver!: (observation: DaemonPluginDevelopmentObservation) => Promise<'adopted' | 'retained'>;
    const dependencies = {
      happyHomeDir,
      submitObservation: vi.fn(async () => ({
        kind: 'committed' as const,
        pluginId: 'acme.forget',
        occurrenceId: 'occurrence-1',
      })),
      prepareSourceRemoval: vi.fn(async () => ({ abort: vi.fn(async () => undefined), adopt: adoptRemoval })),
      startCollectionObserver: async () => ({ stop: vi.fn() }),
      startSourceObserver: async (
        _rootPath: string,
        onObservation: (observation: DaemonPluginDevelopmentObservation) => Promise<'adopted' | 'retained'>,
      ) => {
        deliver = onObservation;
        return { stop: sourceStop, failure: new Promise<Error>(() => undefined) };
      },
    };
    const first = createDaemonPluginDevelopmentRootsOwner(dependencies);
    await first.initialize();
    await first.control({ kind: 'registerExplicit', rootPath: sourceRoot });
    await deliver({
      ok: true,
      ...packageRootObservation,
      sourceRootPath: sourceRoot,
      request: { kind: 'development', projectRoot: sourceRoot },
    });

    await expect(first.control({ kind: 'unregisterExplicit', rootPath: sourceRoot }))
      .resolves.toMatchObject({ kind: 'status', status: { roots: expect.not.arrayContaining([
        expect.objectContaining({ kind: 'explicit', rootPath: await realpath(sourceRoot) }),
      ]) } });
    expect(dependencies.prepareSourceRemoval).toHaveBeenCalledWith({
      pluginId: 'acme.forget',
      registeredRootId: await realpath(sourceRoot),
    });
    expect(sourceStop).toHaveBeenCalledOnce();
    expect(adoptRemoval).toHaveBeenCalledOnce();
    await expect(first.readPersistedStateForTest()).resolves.toMatchObject({ explicitRoots: [] });
    await first.stop();

    dependencies.startSourceObserver = vi.fn(async () => ({
      stop: vi.fn(),
      failure: new Promise<Error>(() => undefined),
    }));
    const restarted = createDaemonPluginDevelopmentRootsOwner(dependencies);
    await restarted.initialize();
    expect(dependencies.startSourceObserver).not.toHaveBeenCalled();
    await restarted.stop();
  });

  it('forgets only explicit ownership while a workspace collection still owns the physical source', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-shared-home-');
    const projectRoot = await createDirectory('happier-daemon-dev-shared-project-');
    const sourceRoot = join(projectRoot, '.happier', 'plugins', 'acme-shared');
    await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(sourceRoot, '.happier-plugin', 'plugin.json'), '{}', 'utf8');
    const sourceStop = vi.fn();
    const prepareSourceRemoval = vi.fn();
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(async () => ({ kind: 'committed', pluginId: 'acme.shared' })),
      prepareSourceRemoval,
      startCollectionObserver: async () => ({ stop: vi.fn() }),
      startSourceObserver: async () => ({ stop: sourceStop, failure: new Promise<Error>(() => undefined) }),
    });
    await owner.initialize();
    await owner.control({ kind: 'registerWorkspace', projectRoot, trust: 'accept' });
    await owner.control({ kind: 'registerExplicit', rootPath: sourceRoot });

    await owner.control({ kind: 'unregisterExplicit', rootPath: sourceRoot });

    expect(prepareSourceRemoval).not.toHaveBeenCalled();
    expect(sourceStop).not.toHaveBeenCalled();
    expect(owner.readStatus().plugins).toEqual([
      expect.objectContaining({ sourceRootPath: await realpath(sourceRoot) }),
    ]);
    await owner.stop();
  });

  it('canonicalizes symlinks for exact unregister without matching a sibling path', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-exact-home-');
    const sourceRoot = await createDirectory('happier-daemon-dev-exact-source-');
    const siblingRoot = await createDirectory('happier-daemon-dev-exact-source-sibling-');
    const linkParent = await createDirectory('happier-daemon-dev-exact-links-');
    const sourceLink = join(linkParent, 'plugin-link');
    await symlink(sourceRoot, sourceLink, 'dir');
    const sourceStop = vi.fn();
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(async () => ({ kind: 'committed', pluginId: 'unused' })),
      startCollectionObserver: async () => ({ stop: vi.fn() }),
      startSourceObserver: async () => ({ stop: sourceStop, failure: new Promise<Error>(() => undefined) }),
    });
    await owner.initialize();
    await owner.control({ kind: 'registerExplicit', rootPath: sourceLink });

    await expect(owner.control({ kind: 'unregisterExplicit', rootPath: siblingRoot }))
      .resolves.toMatchObject({ kind: 'failed', code: 'plugin_development_root_not_registered' });
    expect(sourceStop).not.toHaveBeenCalled();

    await expect(owner.control({ kind: 'unregisterExplicit', rootPath: sourceLink }))
      .resolves.toMatchObject({ kind: 'status' });
    expect(sourceStop).toHaveBeenCalledOnce();
    await owner.stop();
  });

  it('permits a manifest id change only after unregister and re-admission', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-id-change-home-');
    const sourceRoot = await createDirectory('happier-daemon-dev-id-change-source-');
    const deliveries: Array<(
      observation: DaemonPluginDevelopmentObservation,
    ) => Promise<'adopted' | 'retained'>> = [];
    let pluginId = 'acme.before';
    const prepareSourceRemoval = vi.fn(async () => ({
      abort: vi.fn(async () => undefined),
      adopt: vi.fn(async () => undefined),
    }));
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(async () => ({ kind: 'committed', pluginId })),
      prepareSourceRemoval,
      startCollectionObserver: async () => ({ stop: vi.fn() }),
      startSourceObserver: async (_rootPath, onObservation) => {
        deliveries.push(onObservation);
        return { stop: vi.fn(), failure: new Promise<Error>(() => undefined) };
      },
    });
    const observation: DaemonPluginDevelopmentObservation = {
      ok: true,
      ...packageRootObservation,
      sourceRootPath: sourceRoot,
      request: { kind: 'development', projectRoot: sourceRoot },
    };
    await owner.initialize();
    await owner.control({ kind: 'registerExplicit', rootPath: sourceRoot });
    await deliveries[0]!(observation);
    await owner.control({ kind: 'unregisterExplicit', rootPath: sourceRoot });
    pluginId = 'acme.after';
    await owner.control({ kind: 'registerExplicit', rootPath: sourceRoot });
    await deliveries[1]!(observation);

    expect(prepareSourceRemoval).toHaveBeenCalledWith({
      pluginId: 'acme.before',
      registeredRootId: await realpath(sourceRoot),
    });
    expect(owner.readStatus().plugins).toEqual([
      expect.objectContaining({ pluginId: 'acme.after', phase: 'active' }),
    ]);
    await owner.stop();
  });

  it('retains the incumbent and rejects a manifest id change until unregister', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-id-bound-home-');
    const sourceRoot = await createDirectory('happier-daemon-dev-id-bound-source-');
    const deliveries: Array<(
      observation: DaemonPluginDevelopmentObservation,
    ) => Promise<'adopted' | 'retained'>> = [];
    const submitObservation = vi.fn(async (observation) => ({
      kind: 'committed' as const,
      pluginId: observation.request.pluginId,
      occurrenceId: observation.request.pluginId === 'acme.before' ? 'occurrence-a' : 'occurrence-b',
    }));
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation,
      startCollectionObserver: async () => ({ stop: vi.fn() }),
      startSourceObserver: async (_rootPath, onObservation) => {
        deliveries.push(onObservation);
        return { stop: vi.fn(), failure: new Promise<Error>(() => undefined) };
      },
    });
    await owner.initialize();
    await owner.control({ kind: 'registerExplicit', rootPath: sourceRoot });
    await expect(deliveries[0]!({
      ok: true,
      ...packageRootObservation,
      sourceRootPath: sourceRoot,
      request: { kind: 'development', pluginId: 'acme.before', projectRoot: sourceRoot },
    })).resolves.toBe('adopted');
    await owner.control({ kind: 'reload', rootPath: sourceRoot });

    await expect(deliveries[1]!({
      ok: true,
      ...packageRootObservation,
      sourceRootPath: sourceRoot,
      request: { kind: 'development', pluginId: 'acme.after', projectRoot: sourceRoot },
    })).resolves.toBe('retained');

    expect(submitObservation).toHaveBeenCalledTimes(1);
    expect(owner.readStatus().plugins).toEqual([
      expect.objectContaining({
        pluginId: 'acme.before',
        occurrenceId: 'occurrence-a',
        phase: 'retained_incumbent',
        diagnostic: expect.objectContaining({ code: 'plugin_development_plugin_id_changed' }),
      }),
    ]);
    expect(owner.isDevelopmentSourceRegistered(sourceRoot)).toBe(false);
    expect(owner.resolveDevelopmentSourceAuthority({ pluginId: 'acme.before', rootPath: sourceRoot }))
      .toBeNull();
    await owner.stop();
  });

  it('coalesces source observations and retains active status after a failed candidate', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-coalesce-home-');
    const sourceRoot = await createDirectory('happier-daemon-dev-source-');
    await writeFile(join(sourceRoot, 'plugin.ts'), 'export function activate() {}\n', 'utf8');
    let deliver!: (observation: DaemonPluginDevelopmentObservation) => Promise<'adopted' | 'retained'>;
    const submitObservation = vi.fn()
      .mockResolvedValueOnce({ kind: 'committed', pluginId: 'acme.one', occurrenceId: 'occurrence-1', uiArtifactDigest: 'digest-1' })
      .mockResolvedValueOnce({ kind: 'failed', pluginId: 'acme.one', code: 'build_failed' });
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation,
      startCollectionObserver: async () => ({ stop: vi.fn() }),
      startSourceObserver: async (_root, onObservation) => {
        deliver = onObservation;
        return { stop: vi.fn(), failure: new Promise<Error>(() => undefined) };
      },
    });
    await owner.initialize();
    await owner.control({ kind: 'registerExplicit', rootPath: sourceRoot });
    const observation: DaemonPluginDevelopmentObservation = {
      ok: true,
      ...packageRootObservation,
      sourceRootPath: sourceRoot,
      request: { kind: 'development', projectRoot: sourceRoot },
    };

    await expect(deliver(observation)).resolves.toBe('adopted');
    await expect(deliver(observation)).resolves.toBe('retained');

    expect(submitObservation.mock.calls.map(([submitted]) => submitted.request.observedRevision))
      .toEqual([1, 2]);

    expect(owner.readStatus().plugins).toEqual([
      expect.objectContaining({
        pluginId: 'acme.one',
        phase: 'retained_incumbent',
        occurrenceId: 'occurrence-1',
        uiArtifactDigest: 'digest-1',
        diagnostic: expect.objectContaining({ code: 'build_failed' }),
      }),
    ]);
    await owner.stop();
  });

  it('keeps a single file as registered custody identity while using its directory as the load root', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-file-identity-home-');
    const sourceRoot = await createDirectory('happier-daemon-dev-file-identity-source-');
    const sourcePath = join(sourceRoot, 'plugin.ts');
    await writeFile(sourcePath, 'export function activate() {}\n', 'utf8');
    let deliver!: (observation: DaemonPluginDevelopmentObservation) => Promise<'adopted' | 'retained'>;
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(async () => ({ kind: 'committed', pluginId: 'acme.file' })),
      startCollectionObserver: async () => ({ stop: vi.fn() }),
      startSourceObserver: async (_root, onObservation) => {
        deliver = onObservation;
        return { stop: vi.fn(), failure: new Promise<Error>(() => undefined) };
      },
    });
    await owner.initialize();
    await owner.control({ kind: 'registerExplicit', rootPath: sourcePath });
    await deliver({
      ok: true,
      ...packageRootObservation,
      sourceRootPath: sourceRoot,
      request: { kind: 'development', projectRoot: sourceRoot },
    });

    expect(owner.resolveDevelopmentSourceAuthority({ pluginId: 'acme.file', rootPath: sourcePath }))
      .toMatchObject({
        registeredRootId: sourcePath,
        canonicalRoot: sourceRoot,
        observedRevision: 1,
      });
    expect(owner.resolveDevelopmentSourceAuthority({ pluginId: 'acme.file', rootPath: sourceRoot }))
      .toBeNull();
    await owner.stop();
  });

  it('does not resolve one registered development source as authority for another plugin id', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-authority-id-home-');
    const sourceRoot = await createDirectory('happier-daemon-dev-authority-id-source-');
    let deliver!: (observation: DaemonPluginDevelopmentObservation) => Promise<'adopted' | 'retained'>;
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(async () => ({ kind: 'committed', pluginId: 'acme.authority' })),
      startCollectionObserver: async () => ({ stop: vi.fn() }),
      startSourceObserver: async (_root, onObservation) => {
        deliver = onObservation;
        return { stop: vi.fn(), failure: new Promise<Error>(() => undefined) };
      },
    });
    await owner.initialize();
    await owner.control({ kind: 'registerExplicit', rootPath: sourceRoot });
    await deliver({
      ok: true,
      ...packageRootObservation,
      sourceRootPath: sourceRoot,
      request: { kind: 'development', pluginId: 'acme.authority', projectRoot: sourceRoot },
    });

    expect(owner.resolveDevelopmentSourceAuthority({ pluginId: 'acme.other', rootPath: sourceRoot }))
      .toBeNull();
    expect(owner.resolveDevelopmentSourceAuthority({ pluginId: 'acme.authority', rootPath: sourceRoot }))
      .toMatchObject({ observedRevision: 1 });
    await owner.stop();
  });

  it('registers source authority before the observer submits its initial revision', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-initial-authority-home-');
    const sourceRoot = await createDirectory('happier-daemon-dev-initial-authority-source-');
    let owner!: ReturnType<typeof createDaemonPluginDevelopmentRootsOwner>;
    const submitObservation = vi.fn(async (observation) => {
      expect(observation.request.observedRevision).toBe(1);
      expect(owner.resolveDevelopmentSourceAuthority({
        pluginId: 'acme.initial',
        rootPath: sourceRoot,
      })).toMatchObject({
        registeredRootId: sourceRoot,
        observedRevision: 1,
      });
      expect(owner.isDevelopmentSourceRegistered(sourceRoot)).toBe(true);
      return { kind: 'committed' as const, pluginId: 'acme.initial' };
    });
    owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation,
      startCollectionObserver: async () => ({ stop: vi.fn() }),
      startSourceObserver: async (rootPath, onObservation) => {
        await onObservation({
          ok: true,
          ...packageRootObservation,
          sourceRootPath: rootPath,
          request: { kind: 'development', pluginId: 'acme.initial', projectRoot: rootPath },
        });
        return { stop: vi.fn(), failure: new Promise<Error>(() => undefined) };
      },
    });
    await owner.initialize();

    await expect(owner.control({ kind: 'registerExplicit', rootPath: sourceRoot }))
      .resolves.toMatchObject({ kind: 'status' });
    expect(submitObservation).toHaveBeenCalledOnce();
    await owner.stop();
  });

  it('retires only the missing development source and keeps its registered identity unavailable for recovery', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-missing-home-');
    const sourceA = await createDirectory('happier-daemon-dev-missing-a-');
    const sourceB = await createDirectory('happier-daemon-dev-missing-b-');
    const deliveries = new Map<string, (
      observation: DaemonPluginDevelopmentObservation,
    ) => Promise<'adopted' | 'retained'>>();
    const adoptedRemovals: string[] = [];
    let owner!: ReturnType<typeof createDaemonPluginDevelopmentRootsOwner>;
    owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(async (observation) => ({
        kind: 'committed',
        pluginId: observation.request.pluginId,
        occurrenceId: `occurrence-${observation.request.pluginId}`,
      })),
      prepareSourceRemoval: vi.fn(async ({ pluginId, registeredRootId }) => ({
        abort: vi.fn(async () => undefined),
        adopt: async () => {
          expect(owner.isDevelopmentSourceRegistered(registeredRootId)).toBe(false);
          adoptedRemovals.push(pluginId);
        },
      })),
      startCollectionObserver: async () => ({ stop: vi.fn() }),
      startSourceObserver: async (rootPath, onObservation) => {
        deliveries.set(rootPath, onObservation);
        return { stop: vi.fn(), failure: new Promise<Error>(() => undefined) };
      },
    });
    await owner.initialize();
    await owner.control({ kind: 'registerExplicit', rootPath: sourceA });
    await owner.control({ kind: 'registerExplicit', rootPath: sourceB });
    await deliveries.get(sourceA)!({
      ok: true,
      ...packageRootObservation,
      sourceRootPath: sourceA,
      request: { kind: 'development', pluginId: 'acme.a', projectRoot: sourceA },
    });
    await deliveries.get(sourceB)!({
      ok: true,
      ...packageRootObservation,
      sourceRootPath: sourceB,
      request: { kind: 'development', pluginId: 'acme.b', projectRoot: sourceB },
    });

    await expect(deliveries.get(sourceA)!({
      ok: false,
      diagnostics: [{
        code: 'plugin_dev_project_missing',
        message: 'Plugin project is unavailable',
      }],
    })).resolves.toBe('retained');

    expect(adoptedRemovals).toEqual(['acme.a']);
    expect(owner.readStatus().plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceRootPath: sourceA,
        pluginId: 'acme.a',
        phase: 'unavailable',
        diagnostic: expect.objectContaining({ code: 'plugin_dev_project_missing' }),
      }),
      expect.objectContaining({
        sourceRootPath: sourceB,
        pluginId: 'acme.b',
        phase: 'active',
        occurrenceId: 'occurrence-acme.b',
      }),
    ]));
    expect(owner.resolveDevelopmentSourceAuthority({ pluginId: 'acme.a', rootPath: sourceA }))
      .toBeNull();
    expect(owner.resolveDevelopmentSourceAuthority({ pluginId: 'acme.b', rootPath: sourceB }))
      .toMatchObject({ observedRevision: 1 });
    await owner.stop();
  });

  it('reloads only the requested source and stops every observer exactly once', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-stop-home-');
    const rootA = await createDirectory('happier-daemon-dev-a-');
    const rootB = await createDirectory('happier-daemon-dev-b-');
    const sourceStops = new Map<string, ReturnType<typeof vi.fn>>();
    const invalidations: string[] = [];
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(async () => ({ kind: 'committed', pluginId: 'unused' })),
      startCollectionObserver: async () => ({ stop: vi.fn() }),
      startSourceObserver: async (rootPath) => {
        const stop = vi.fn();
        sourceStops.set(rootPath, stop);
        return { stop, failure: new Promise<Error>(() => undefined) };
      },
      invalidateSource: async (rootPath) => { invalidations.push(rootPath); },
    });
    await owner.initialize();
    await owner.control({ kind: 'registerExplicit', rootPath: rootA });
    await owner.control({ kind: 'registerExplicit', rootPath: rootB });

    await owner.control({ kind: 'reload', rootPath: rootA });
    expect(invalidations).toEqual([await realpath(rootA)]);

    await owner.stop();
    expect([...sourceStops.values()].every((stop) => stop.mock.calls.length === 1)).toBe(true);
    await owner.stop();
    expect([...sourceStops.values()].every((stop) => stop.mock.calls.length === 1)).toBe(true);
  });

  it('does not let a superseded observed revision replace newer active status', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-stale-home-');
    const sourceRoot = await createDirectory('happier-daemon-dev-stale-source-');
    let deliver!: (observation: DaemonPluginDevelopmentObservation) => Promise<'adopted' | 'retained'>;
    let settleFirst!: (result: { kind: string; pluginId: string; code?: string }) => void;
    const first = new Promise<{ kind: string; pluginId: string; code?: string }>((resolve) => {
      settleFirst = resolve;
    });
    const submitObservation = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ kind: 'committed', pluginId: 'acme.stale' });
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation,
      startCollectionObserver: async () => ({ stop: vi.fn() }),
      startSourceObserver: async (_root, onObservation) => {
        deliver = onObservation;
        return { stop: vi.fn(), failure: new Promise<Error>(() => undefined) };
      },
    });
    await owner.initialize();
    await owner.control({ kind: 'registerExplicit', rootPath: sourceRoot });
    const observation: DaemonPluginDevelopmentObservation = {
      ok: true,
      ...packageRootObservation,
      sourceRootPath: sourceRoot,
      request: { kind: 'development', projectRoot: sourceRoot },
    };

    const stale = deliver(observation);
    await expect(deliver(observation)).resolves.toBe('adopted');
    settleFirst({ kind: 'failed', pluginId: 'acme.stale', code: 'stale_failure' });
    await expect(stale).resolves.toBe('retained');

    expect(owner.readStatus().plugins).toEqual([
      expect.objectContaining({ pluginId: 'acme.stale', phase: 'active' }),
    ]);
    await owner.stop();
  });

  it('rejects a workspace collection or child candidate that resolves outside the trusted project', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-boundary-home-');
    const projectRoot = await createDirectory('happier-daemon-dev-boundary-project-');
    const outsideCollection = await createDirectory('happier-daemon-dev-boundary-collection-');
    const outsidePlugin = await createDirectory('happier-daemon-dev-boundary-plugin-');
    await writeFile(join(outsidePlugin, 'package.json'), '{"name":"outside"}\n', 'utf8');
    await mkdir(join(projectRoot, '.happier'), { recursive: true });
    await symlink(outsideCollection, join(projectRoot, '.happier', 'plugins'), 'dir');
    const sourceStarts = vi.fn();
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(async () => ({ kind: 'committed', pluginId: 'unused' })),
      startCollectionObserver: async () => ({ stop: vi.fn() }),
      startSourceObserver: sourceStarts,
    });
    await owner.initialize();

    await expect(owner.control({ kind: 'registerWorkspace', projectRoot, trust: 'accept' }))
      .resolves.toMatchObject({ kind: 'failed', code: 'plugin_development_root_invalid' });
    expect(sourceStarts).not.toHaveBeenCalled();

    await rm(join(projectRoot, '.happier', 'plugins'));
    await mkdir(join(projectRoot, '.happier', 'plugins'), { recursive: true });
    await symlink(outsidePlugin, join(projectRoot, '.happier', 'plugins', 'outside'), 'dir');
    await owner.control({ kind: 'registerWorkspace', projectRoot, trust: 'accept' });
    expect(sourceStarts).not.toHaveBeenCalled();
    await owner.stop();
  });

  it('reconciles collection candidates by physical identity and stops a retargeted source once', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-retarget-home-');
    const collectionRoot = join(happyHomeDir, 'plugins');
    const targetContainer = join(collectionRoot, '.targets');
    const firstTarget = join(targetContainer, 'first-target');
    const secondTarget = join(targetContainer, 'second-target');
    const candidateLink = join(collectionRoot, 'candidate');
    await mkdir(firstTarget, { recursive: true });
    await mkdir(secondTarget, { recursive: true });
    await writeFile(join(firstTarget, 'package.json'), '{"name":"first"}\n', 'utf8');
    await writeFile(join(secondTarget, 'package.json'), '{"name":"second"}\n', 'utf8');
    await symlink(firstTarget, candidateLink, 'dir');
    let reconcile!: () => void;
    const sourceStops = new Map<string, ReturnType<typeof vi.fn>>();
    const deliveries = new Map<string, (
      observation: DaemonPluginDevelopmentObservation,
    ) => Promise<'adopted' | 'retained'>>();
    const adoptRemoval = vi.fn(async () => undefined);
    const prepareSourceRemoval = vi.fn(async () => ({
      abort: vi.fn(async () => undefined),
      adopt: adoptRemoval,
    }));
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(async (observation) => ({
        kind: 'committed',
        pluginId: observation.request.pluginId,
        occurrenceId: `occurrence-${observation.request.pluginId}`,
      })),
      prepareSourceRemoval,
      startCollectionObserver: async (_rootPath, onChange) => {
        reconcile = onChange;
        return { stop: vi.fn() };
      },
      startSourceObserver: async (rootPath, onObservation) => {
        const stop = vi.fn();
        sourceStops.set(rootPath, stop);
        deliveries.set(rootPath, onObservation);
        return { stop, failure: new Promise<Error>(() => undefined) };
      },
    });
    await owner.initialize();
    const firstPhysical = await realpath(firstTarget);
    const secondPhysical = await realpath(secondTarget);
    expect(sourceStops.has(firstPhysical)).toBe(true);
    await deliveries.get(firstPhysical)!({
      ok: true,
      ...packageRootObservation,
      sourceRootPath: firstPhysical,
      request: { kind: 'development', pluginId: 'acme.first', projectRoot: firstPhysical },
    });

    await rm(candidateLink);
    await symlink(secondTarget, candidateLink, 'dir');
    reconcile();
    await vi.waitFor(() => {
      expect(sourceStops.get(firstPhysical)).toHaveBeenCalledTimes(1);
      expect(sourceStops.has(secondPhysical)).toBe(true);
    });
    expect(prepareSourceRemoval).toHaveBeenCalledWith({
      pluginId: 'acme.first',
      registeredRootId: firstPhysical,
    });
    expect(adoptRemoval).toHaveBeenCalledOnce();
    expect(owner.readStatus().plugins.map((entry) => entry.sourceRootPath)).not.toContain(firstPhysical);
    expect(owner.readStatus().plugins.map((entry) => entry.sourceRootPath)).toContain(secondPhysical);

    await owner.stop();
    expect(sourceStops.get(firstPhysical)).toHaveBeenCalledTimes(1);
    expect(sourceStops.get(secondPhysical)).toHaveBeenCalledTimes(1);
  });

  it('does not offer a retargeted collection source when retiring the incumbent fails', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-retarget-fail-home-');
    const collectionRoot = join(happyHomeDir, 'plugins');
    const firstTarget = join(collectionRoot, '.targets', 'first-target');
    const secondTarget = join(collectionRoot, '.targets', 'second-target');
    const candidateLink = join(collectionRoot, 'candidate');
    await mkdir(firstTarget, { recursive: true });
    await mkdir(secondTarget, { recursive: true });
    await writeFile(join(firstTarget, 'package.json'), '{"name":"first"}\n', 'utf8');
    await writeFile(join(secondTarget, 'package.json'), '{"name":"second"}\n', 'utf8');
    await symlink(firstTarget, candidateLink, 'dir');
    let reconcile!: () => void;
    let deliver!: (observation: DaemonPluginDevelopmentObservation) => Promise<'adopted' | 'retained'>;
    const sourceStarts: string[] = [];
    const abortRemoval = vi.fn(async () => undefined);
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(async () => ({
        kind: 'committed' as const,
        pluginId: 'acme.first',
        occurrenceId: 'occurrence-first',
      })),
      prepareSourceRemoval: vi.fn(async () => ({
        abort: abortRemoval,
        adopt: async () => { throw new Error('retarget removal blocked'); },
      })),
      startCollectionObserver: async (_rootPath, onChange) => {
        reconcile = onChange;
        return { stop: vi.fn() };
      },
      startSourceObserver: async (rootPath, onObservation) => {
        sourceStarts.push(rootPath);
        deliver = onObservation;
        return { stop: vi.fn(), failure: new Promise<Error>(() => undefined) };
      },
    });
    await owner.initialize();
    const firstPhysical = await realpath(firstTarget);
    const secondPhysical = await realpath(secondTarget);
    await deliver({
      ok: true,
      ...packageRootObservation,
      sourceRootPath: firstPhysical,
      request: { kind: 'development', pluginId: 'acme.first', projectRoot: firstPhysical },
    });

    await rm(candidateLink);
    await symlink(secondTarget, candidateLink, 'dir');
    reconcile();
    await vi.waitFor(() => expect(abortRemoval).toHaveBeenCalledOnce());

    expect(sourceStarts).not.toContain(secondPhysical);
    expect(owner.readStatus().plugins).toEqual([
      expect.objectContaining({
        sourceRootPath: firstPhysical,
        pluginId: 'acme.first',
        phase: 'retained_incumbent',
        diagnostic: expect.objectContaining({ code: 'plugin_development_source_removal_failed' }),
      }),
    ]);
    await owner.stop();
  });

  it('retires a disappeared collection source through the prepared runtime removal transition', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-collection-remove-home-');
    const collectionRoot = join(happyHomeDir, 'plugins');
    const sourceRoot = join(collectionRoot, 'acme-remove');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), '{"name":"acme-remove"}\n', 'utf8');
    let reconcile!: () => void;
    let deliver!: (observation: DaemonPluginDevelopmentObservation) => Promise<'adopted' | 'retained'>;
    const sourceStop = vi.fn();
    const adoptRemoval = vi.fn(async () => undefined);
    const prepareSourceRemoval = vi.fn(async () => ({
      abort: vi.fn(async () => undefined),
      adopt: adoptRemoval,
    }));
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(async () => ({
        kind: 'committed' as const,
        pluginId: 'acme.remove',
        occurrenceId: 'occurrence-remove',
      })),
      prepareSourceRemoval,
      startCollectionObserver: async (_rootPath, onChange) => {
        reconcile = onChange;
        return { stop: vi.fn() };
      },
      startSourceObserver: async (_rootPath, onObservation) => {
        deliver = onObservation;
        return { stop: sourceStop, failure: new Promise<Error>(() => undefined) };
      },
    });
    await owner.initialize();
    const canonicalSourceRoot = await realpath(sourceRoot);
    await deliver({
      ok: true,
      ...packageRootObservation,
      sourceRootPath: sourceRoot,
      request: { kind: 'development', pluginId: 'acme.remove', projectRoot: sourceRoot },
    });

    await rm(sourceRoot, { recursive: true, force: true });
    reconcile();
    await vi.waitFor(() => expect(adoptRemoval).toHaveBeenCalledOnce());

    expect(prepareSourceRemoval).toHaveBeenCalledWith({
      pluginId: 'acme.remove',
      registeredRootId: canonicalSourceRoot,
    });
    expect(sourceStop).toHaveBeenCalledOnce();
    expect(owner.readStatus().plugins).toEqual([]);
    await owner.stop();
  });

  it('keeps a disappeared collection incumbent active when prepared removal fails', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-collection-remove-fail-home-');
    const sourceRoot = join(happyHomeDir, 'plugins', 'acme-retained');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), '{"name":"acme-retained"}\n', 'utf8');
    let reconcile!: () => void;
    let deliver!: (observation: DaemonPluginDevelopmentObservation) => Promise<'adopted' | 'retained'>;
    const sourceStop = vi.fn();
    const abortRemoval = vi.fn(async () => undefined);
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(async () => ({
        kind: 'committed' as const,
        pluginId: 'acme.retained',
        occurrenceId: 'occurrence-retained',
      })),
      prepareSourceRemoval: vi.fn(async () => ({
        abort: abortRemoval,
        adopt: async () => { throw new Error('removal blocked'); },
      })),
      startCollectionObserver: async (_rootPath, onChange) => {
        reconcile = onChange;
        return { stop: vi.fn() };
      },
      startSourceObserver: async (_rootPath, onObservation) => {
        deliver = onObservation;
        return { stop: sourceStop, failure: new Promise<Error>(() => undefined) };
      },
    });
    await owner.initialize();
    await deliver({
      ok: true,
      ...packageRootObservation,
      sourceRootPath: sourceRoot,
      request: { kind: 'development', pluginId: 'acme.retained', projectRoot: sourceRoot },
    });

    await rm(sourceRoot, { recursive: true, force: true });
    reconcile();
    await vi.waitFor(() => expect(abortRemoval).toHaveBeenCalledOnce());

    expect(sourceStop).not.toHaveBeenCalled();
    expect(owner.readStatus().plugins).toEqual([
      expect.objectContaining({
        pluginId: 'acme.retained',
        occurrenceId: 'occurrence-retained',
        phase: 'retained_incumbent',
        diagnostic: expect.objectContaining({ code: 'plugin_development_source_removal_failed' }),
      }),
    ]);
    await owner.stop();
    expect(sourceStop).toHaveBeenCalledOnce();
  });

  it('still retires an active collection incumbent when its source watcher fails before disappearance reconciliation', async () => {
    const happyHomeDir = await createDirectory('happier-daemon-dev-collection-watcher-fail-home-');
    const sourceRoot = join(happyHomeDir, 'plugins', 'acme-watcher-fail');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), '{"name":"acme-watcher-fail"}\n', 'utf8');
    let reconcile!: () => void;
    let deliver!: (observation: DaemonPluginDevelopmentObservation) => Promise<'adopted' | 'retained'>;
    let rejectWatcher!: (error: Error) => void;
    const sourceStop = vi.fn();
    const adoptRemoval = vi.fn(async () => undefined);
    const prepareSourceRemoval = vi.fn(async () => ({
      abort: vi.fn(async () => undefined),
      adopt: adoptRemoval,
    }));
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir,
      submitObservation: vi.fn(async () => ({
        kind: 'committed' as const,
        pluginId: 'acme.watcher-fail',
        occurrenceId: 'occurrence-watcher-fail',
      })),
      prepareSourceRemoval,
      startCollectionObserver: async (_rootPath, onChange) => {
        reconcile = onChange;
        return { stop: vi.fn() };
      },
      startSourceObserver: async (_rootPath, onObservation) => {
        deliver = onObservation;
        return {
          stop: sourceStop,
          failure: new Promise<Error>((_resolve, reject) => { rejectWatcher = reject; }),
        };
      },
    });
    await owner.initialize();
    await deliver({
      ok: true,
      ...packageRootObservation,
      sourceRootPath: sourceRoot,
      request: { kind: 'development', pluginId: 'acme.watcher-fail', projectRoot: sourceRoot },
    });

    rejectWatcher(new Error('watcher unavailable'));
    await vi.waitFor(() => expect(owner.readStatus().plugins).toEqual([
      expect.objectContaining({
        pluginId: 'acme.watcher-fail',
        phase: 'retained_incumbent',
        diagnostic: expect.objectContaining({ code: 'plugin_dev_watcher_unavailable' }),
      }),
    ]));
    await rm(sourceRoot, { recursive: true, force: true });
    reconcile();
    await vi.waitFor(() => expect(adoptRemoval).toHaveBeenCalledOnce());

    expect(prepareSourceRemoval).toHaveBeenCalledWith({
      pluginId: 'acme.watcher-fail',
      registeredRootId: sourceRoot,
    });
    expect(sourceStop).toHaveBeenCalledOnce();
    expect(owner.readStatus().plugins).toEqual([]);
    await owner.stop();
  });
});
