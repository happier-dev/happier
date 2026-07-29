import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDaemonPluginChangeService } from './changeService';
import { createDaemonPathPluginChangePreparer } from './pathChangePreparer';
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
import { loadPluginModule } from '@/plugins/runtime/loadPluginModule';
import { materializePluginDevelopmentCandidate } from './developmentCandidateMaterializer';

const roots: string[] = [];
const successfulManagedPnpmBoundary = async () => ({
  ok: true as const,
  result: { exitCode: 0, signal: null, stdout: '', stderr: '' },
});

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

describe('createDaemonPathPluginChangePreparer', () => {
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

  it('materializes a regular-file production dependency closure before immutable Jiti activation', async () => {
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
      'export const activatedValue: string = value;',
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
      await mkdir(installedPackageRoot, { recursive: true });
      await writeFile(join(installedPackageRoot, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }), 'utf8');
      await writeFile(join(installedPackageRoot, 'index.js'), "export const value = 'materialized-runtime-value';\n", 'utf8');
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
      projectRoot: expect.stringContaining(join('development-candidates', 'candidate-')),
      args: [
        'install',
        '--prod',
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
      .rejects.toMatchObject({ code: 'ENOENT' });
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
          admittedIntegrity: generation!.installation.source.admittedIntegrity,
          packageDigest: generation!.record.packageDigest,
          isCurrent: current!.isCurrent,
        },
      },
      cacheKey: generation!.immutableGenerationId,
    });
    expect((loaded as { activatedValue?: string }).activatedValue).toBe('materialized-runtime-value');
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

    await expect(prepare({
      kind: 'installPath',
      locator: reactNativeOnlyRoot,
      development: false,
    })).resolves.toMatchObject({
      review: {
        packageIdentity: { name: null, version: '1.0.0' },
        publisherIdentity: { status: 'unavailable' },
        updateChannel: { kind: 'path', development: false },
        integrity: {
          packageDigest: expect.stringMatching(/^sha256:/),
          manifestDigest: expect.stringMatching(/^sha256:/),
          uiArtifactDigest: expect.stringMatching(/^sha256:/),
        },
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

  it('does not install changed non-development bytes after the review', async () => {
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
    })).resolves.toEqual({ kind: 'conflict', pluginId: 'acme.descriptor' });
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
      kind: 'uninstall',
      pluginId: 'acme.descriptor',
      clearHealthHistory: true,
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'retry', occurredAtMs: 2 },
    })).resolves.toEqual({
      kind: 'committed',
      pluginId: 'acme.descriptor',
      desiredGeneration: null,
      appliedGeneration: null,
      pendingSurfaces: [],
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
    const message =
      'Storage-pressure quarantine eviction cleanup remains pending: reconciliation: generationCleanup unavailable';
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

    await expect(service.decidePluginChange({
      pendingChangeId: install.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'test', occurredAtMs: 1 },
    })).resolves.toEqual({
      kind: 'failed',
      code: 'plugin_install_failed',
      message,
    });
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
