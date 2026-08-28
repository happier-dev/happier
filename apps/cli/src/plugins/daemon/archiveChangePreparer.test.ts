import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestNpmTarball } from '@/plugins/distribution/testkit/npmTarball';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { readPluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { resolveDefaultScmBackendRegistry } from '@/scm/scmBackendCatalog';
import { createHostScmHostingProviderRuntimeServices } from '@/scm/hostingProviders/runtimeServices';

import { createDaemonArchivePluginChangePreparer } from './archiveChangePreparer';
import { createDaemonPluginChangeService } from './changeService';

const roots: string[] = [];
const archiveServers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(archiveServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function createArchiveFixture(params?: Readonly<{
  packageName?: string;
  packageVersion?: string;
  manifestVersion?: string;
  optionalSessions?: boolean;
  action?: boolean;
  speech?: boolean;
  scm?: boolean;
}>): Promise<Readonly<{
  archivePath: string;
  integrity: string;
  root: string;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'happier-archive-change-source-'));
  roots.push(root);
  const packageName = params?.packageName ?? '@acme/archive-candidate';
  const packageVersion = params?.packageVersion ?? '1.2.3';
  const archivePath = join(root, 'candidate.tgz');
  const bytes = await createTestNpmTarball([
    {
      name: 'package/package.json',
      body: JSON.stringify({
        name: packageName,
        version: packageVersion,
        keywords: ['happier-plugin'],
        happier: { manifest: '.happier-plugin/plugin.json' },
        files: ['.happier-plugin', 'dist', 'payload.txt'],
        scripts: { preinstall: `touch ${join(root, 'lifecycle-script-ran')}` },
      }),
    },
    {
      name: 'package/.happier-plugin/plugin.json',
      body: JSON.stringify({
        schemaVersion: 2,
        id: 'acme.archive-candidate',
        version: params?.manifestVersion ?? packageVersion,
        displayName: 'Acme archive candidate',
        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
        entrypoints: { daemon: './dist/daemon.mjs' },
        hostAccess: {
          required: [],
          optional: params?.optionalSessions ? [{
            id: 'project-sessions',
            capability: 'sessions',
            reason: 'Read project sessions',
            scope: { access: ['read'], projectIds: ['project-a'] },
          }] : [],
        },
        contributes: params?.action ? {
          actions: [{
            id: 'roundtrip',
            title: 'Roundtrip',
            scopes: ['global'],
            surfaces: ['cli'],
            execution: { target: 'daemon' },
            placementBindings: ['commandPalette'],
            dangerLevel: 'safe',
          }],
        } : params?.speech ? {
          voiceProviders: [{
            id: 'speech',
            title: 'Speech',
            kind: 'speech',
            roles: ['dictation_stt', 'conversation_stt', 'conversation_tts'],
            platforms: ['web', 'ios', 'android'],
            settings: {
              schemaVersion: 2,
              fields: [
                {
                  id: 'model',
                  title: 'Model',
                  schema: { type: 'string', minLength: 1, maxLength: 512 },
                  default: 'packed-stt-model',
                  presentation: { control: 'text' },
                },
                {
                  id: 'voice',
                  title: 'Voice',
                  schema: { type: 'string', minLength: 1, maxLength: 512 },
                  default: 'voice',
                  presentation: { control: 'select' },
                },
              ],
            },
            catalogs: [{ kind: 'voices', settingFieldId: 'voice', allowCustom: false }],
          }],
        } : params?.scm ? {
          scmBackends: [{
            id: 'stacked',
            title: 'Packed Stacked SCM',
            description: 'Packed external stacked-change backend',
            kind: 'packed-stacked',
            capabilities: ['detect', 'status'],
          }],
          scmHostingProviders: [{
            id: 'forge',
            title: 'Packed Forge',
            description: 'Packed external forge provider',
            kind: 'packed-forge',
            capabilities: ['detect'],
          }],
        } : {},
      }),
    },
    {
      name: 'package/dist/daemon.mjs',
      body: params?.action
        ? [
            'export function activate(api) {',
            "  api.actions.register('roundtrip', async (_input, context) => {",
            "    await context.services.storage.daemon.set('value', 'archive-adopted');",
            "    return { value: await context.services.storage.daemon.get('value') };",
            '  });',
            '}',
            '',
          ].join('\n')
        : params?.speech
          ? [
              'const runtime = Object.freeze({',
              '  kind: "speech",',
              '  catalog: { async list(_request, { signal }) {',
              '    if (signal.aborted) throw new Error("aborted");',
              '    return [{ id: "voice", name: "Packed Voice", metadata: {} }];',
              '  } },',
              '  async transcribe(request, { signal }) { if (signal.aborted) throw new Error("aborted"); return { requestId: request.requestId, text: `bytes:${request.bytes.byteLength}` }; },',
              '  async synthesize(request, { signal }) { if (signal.aborted) throw new Error("aborted"); return { requestId: request.requestId, bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/wav" }; },',
              '});',
              'export function activate(api) { api.voiceProviders.register("speech", runtime); }',
              '',
            ].join('\n')
          : params?.scm
            ? [
                'const unsupported = { support: "unsupported", reason: "not_implemented" };',
                'const supported = { support: "supported" };',
                'export function activate(api) {',
                '  api.scm.registerHostingProvider("forge", { adapter: { routing: {',
                '    detectRemote() { return { id: "forge", kind: "packed-forge", displayName: "Packed Forge", baseUrl: "https://forge.example", repositoryWebUrl: "https://forge.example/acme/repo" }; },',
                '    buildCompareUrl() { return null; },',
                '  } } });',
                '  api.scm.registerBackend("stacked", {',
                '    runtime: { repoModes: [".git"], capabilities: {',
                '      detection: { repository: supported, repoIdentity: unsupported },',
                '      read: { status: supported, diffFile: unsupported, diffCommit: unsupported, log: unsupported },',
                '      changeSet: { model: "working-copy", diffAreas: ["pending"] },',
                '      commit: {}, remote: {}, branch: {}, worktree: {}, lifecycle: {}, hosting: {}, checkpoints: {}, workspaceIntegration: {}, tooling: {}, freshness: {},',
                '    }, commands: [] },',
                '    handlers: { detection: { detectRepo({ cwd }) { return { isRepo: true, rootPath: cwd, mode: ".git" }; } }, read: { statusSnapshot() { return { success: true, branch: "packed/main", entries: [] }; } } },',
                '  });',
                '}',
                '',
              ].join('\n')
            : 'export async function activate() {}\n',
    },
    { name: 'package/payload.txt', body: 'reviewed archive bytes' },
  ]);
  await writeFile(archivePath, bytes);
  return {
    archivePath,
    integrity: `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
    root,
  };
}

async function candidateRoots(happyHomeDir: string): Promise<readonly string[]> {
  const cacheDir = resolvePluginStorePaths({ happyHomeDir }).cacheDir;
  try {
    return (await readdir(cacheDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('plugin-archive-candidate-'))
      .map((entry) => join(cacheDir, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return [];
    throw error;
  }
}

async function preparedGenerationRoots(happyHomeDir: string): Promise<readonly string[]> {
  const generationsDir = resolvePluginStorePaths({ happyHomeDir }).generationsDir;
  try {
    return (await readdir(generationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(generationsDir, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return [];
    throw error;
  }
}

async function findFile(rootPath: string, fileName: string): Promise<string> {
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === fileName) return path;
    }
  }
  throw new Error(`Could not find ${fileName} below archive candidate root`);
}

/**
 * Remote archive acquisition owns a destination-assessed, DNS-pinned connection
 * of its own, so the substitutable boundary is a real HTTP origin. Loopback is
 * the caller's own network intent, the one destination the policy admits as
 * private.
 */
async function startArchiveServer(bytes: Buffer): Promise<Readonly<{
  port: number;
  observedUrls: readonly string[];
}>> {
  const observedUrls: string[] = [];
  const server = createServer((request, response) => {
    observedUrls.push(request.url ?? '');
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
    });
    response.end(bytes);
  });
  archiveServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, observedUrls };
}

describe('createDaemonArchivePluginChangePreparer', () => {
  it('adopts packed SCM backend and hosting runtimes through canonical owners and removes them when disabled', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-archive-scm-runtime-home-'));
    roots.push(happyHomeDir);
    const fixture = await createArchiveFixture({ scm: true });
    const reloadController = createPluginReloadController({ happyHomeDir });
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController });
    const store = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    await store.initialize();
    const initialLease = await reloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir,
        generation: reloadController.getState().generation + 1,
      }),
    });
    await initialLease.release();
    const prepare = createDaemonArchivePluginChangePreparer({ happyHomeDir, runtimeLifecycle });
    const service = createDaemonPluginChangeService({
      prepare,
      createPendingChangeId: () => 'pending-archive-scm',
    });
    const begun = await service.requestPluginChange({ kind: 'installArchive', locator: fixture.archivePath });
    expect(begun).toMatchObject({
      kind: 'reviewRequired',
      review: {
        packageIdentity: { name: '@acme/archive-candidate', version: '1.2.3' },
        publisherIdentity: { status: 'unavailable' },
        updateChannel: { kind: 'archive' },
        signature: { status: 'notProvided' },
        provenance: { status: 'notProvided' },
        curation: { status: 'notApplicable' },
        contributions: [
          { family: 'scmHostingProviders', count: 1 },
          { family: 'scmBackends', count: 1 },
        ],
        uiArtifacts: { status: 'none', contributionIds: [] },
        compatibility: { happier: '^0.2.0', runtimeApiVersion: 1 },
        updatePolicy: 'manual',
      },
    });
    if (begun.kind !== 'reviewRequired') {
      throw new Error(`Expected archive installation review, received ${JSON.stringify(begun)}`);
    }
    expect(begun.review).not.toHaveProperty('integrity');
    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'archive-scm', occurredAtMs: 10 },
    })).resolves.toMatchObject({ kind: 'committed', pendingSurfaces: [] });

    const activeLease = await reloadController.acquireRuntimeRegistry();
    const activeGeneration = activeLease.registry.generation;
    if (activeGeneration === undefined) throw new Error('Expected active plugin runtime generation');
    const scmRegistry = await resolveDefaultScmBackendRegistry({ pluginRuntimeRegistry: activeLease.registry });
    expect(
      [...(activeLease.registry.scmBackendsById?.keys() ?? [])],
      JSON.stringify(activeLease.registry.pluginDiagnosticsByPluginId['acme.archive-candidate'] ?? []),
    ).toContain('acme.archive-candidate/stacked');
    const selected = await scmRegistry.selectBackend({
      cwd: '/workspace',
      workingDirectory: '/workspace',
      backendPreference: { kind: 'prefer', backendId: 'acme.archive-candidate/stacked' },
    });
    expect(selected?.backend.id).toBe('acme.archive-candidate/stacked');
    if (!selected?.backend.statusSnapshot) throw new Error('Expected packed SCM status operation');
    const invokeStatus = async () => await selected.backend.statusSnapshot!({
      context: {
        cwd: '/workspace',
        projectKey: 'packed:/workspace',
        detection: { isRepo: true, rootPath: '/workspace', mode: '.git' },
      },
      request: { cwd: '/workspace' },
    });
    await expect(invokeStatus()).resolves.toMatchObject({ success: true, branch: 'packed/main' });

    const hostingServices = createHostScmHostingProviderRuntimeServices({
      contributes: activeLease.registry.contributes,
      scmHostingProvidersById: activeLease.registry.scmHostingProvidersById,
      envAllowedNamesByPluginId: activeLease.registry.envAllowedNamesByPluginId,
      managedDependencies: activeLease.registry.managedDependencies,
    });
    const hostingRegistry = await hostingServices.resolveScmHostingProviderRegistry?.();
    expect(hostingRegistry?.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://forge.example/acme/repo',
    })).toMatchObject({ kind: 'resolved', providerId: 'acme.archive-candidate/forge' });

    const projection = buildPluginProjectionV2({
      registry: activeLease.registry.contributes,
      generation: activeGeneration,
      scmRuntimeAvailability: {
        backendIds: new Set(activeLease.registry.scmBackendsById?.keys() ?? []),
        hostingProviderIds: new Set(activeLease.registry.scmHostingProvidersById.keys()),
      },
    });
    expect(projection.familiesById.scmBackends?.entriesById['acme.archive-candidate/stacked'])
      .toMatchObject({ displayName: 'Packed Stacked SCM', operations: ['detect', 'status'] });
    expect(projection.familiesById.scmHostingProviders?.entriesById['acme.archive-candidate/forge'])
      .toMatchObject({ displayName: 'Packed Forge', operations: ['detect'] });
    await activeLease.release();

    await store.setEnabled('acme.archive-candidate', false);
    const disabledLease = await reloadController.acquireRuntimeRegistry();
    const disabledGeneration = disabledLease.registry.generation;
    if (disabledGeneration === undefined) throw new Error('Expected disabled plugin runtime generation');
    const disabledProjection = buildPluginProjectionV2({
      registry: disabledLease.registry.contributes,
      generation: disabledGeneration,
      scmRuntimeAvailability: {
        backendIds: new Set(disabledLease.registry.scmBackendsById?.keys() ?? []),
        hostingProviderIds: new Set(disabledLease.registry.scmHostingProvidersById.keys()),
      },
    });
    expect(disabledProjection.familiesById.scmBackends?.entriesById['acme.archive-candidate/stacked'])
      .toBeUndefined();
    expect(disabledProjection.familiesById.scmHostingProviders?.entriesById['acme.archive-candidate/forge'])
      .toBeUndefined();
    await expect(invokeStatus()).rejects.toThrow(/no longer active/);
    await disabledLease.release();
    await service.shutdown();
    await reloadController.shutdown();
  });

  it('adopts a packed public speech registration and removes it when the plugin is disabled', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-archive-speech-runtime-home-'));
    roots.push(happyHomeDir);
    const fixture = await createArchiveFixture({ speech: true });
    const reloadController = createPluginReloadController({ happyHomeDir });
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController });
    const store = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    await store.initialize();
    const initialLease = await reloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir,
        generation: reloadController.getState().generation + 1,
      }),
    });
    await initialLease.release();
    const prepare = createDaemonArchivePluginChangePreparer({ happyHomeDir, runtimeLifecycle });
    const service = createDaemonPluginChangeService({
      prepare,
      createPendingChangeId: () => 'pending-archive-speech',
    });
    const begun = await service.requestPluginChange({ kind: 'installArchive', locator: fixture.archivePath });
    if (begun.kind !== 'reviewRequired') {
      throw new Error(`Expected archive installation review, received ${JSON.stringify(begun)}`);
    }
    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'archive-speech', occurredAtMs: 9 },
    })).resolves.toMatchObject({ kind: 'committed', pendingSurfaces: [] });

    const activeLease = await reloadController.acquireRuntimeRegistry();
    const speech = activeLease.registry.voiceSpeechProviders?.read({
      pluginId: 'acme.archive-candidate',
      localId: 'speech',
    });
    expect(speech?.isCurrent()).toBe(true);
    if (!speech) throw new Error('Expected installed speech runtime');
    const signal = new AbortController().signal;
    await expect(speech.runtime.catalog?.list(
      { catalog: 'voices' },
      {
        credentials: { phase: 'speech', mediated: null, raw: null },
        settings: Object.freeze({ model: 'packed-stt-model', voice: 'voice' }),
        http: speech.createHttp(signal),
        signal,
      },
    )).resolves.toEqual([{ id: 'voice', name: 'Packed Voice', metadata: {} }]);
    await activeLease.release();

    await store.setEnabled('acme.archive-candidate', false);
    const disabledLease = await reloadController.acquireRuntimeRegistry();
    expect(disabledLease.registry.voiceSpeechProviders?.read({
      pluginId: 'acme.archive-candidate',
      localId: 'speech',
    })).toBeNull();
    await disabledLease.release();
    await service.shutdown();
    await reloadController.shutdown();
  });

  it('keeps the adopted archive runtime current after temporary candidate cleanup', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-archive-change-runtime-home-'));
    roots.push(happyHomeDir);
    const fixture = await createArchiveFixture({ action: true });
    const reloadController = createPluginReloadController({ happyHomeDir });
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
    });
    const stateStore = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle,
    });
    await stateStore.initialize();
    const initialLease = await reloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir,
        generation: reloadController.getState().generation + 1,
      }),
    });
    await initialLease.release();
    const service = createDaemonPluginChangeService({
      prepare: createDaemonArchivePluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle,
      }),
      createPendingChangeId: () => 'pending-archive-runtime',
    });

    const begun = await service.requestPluginChange({ kind: 'installArchive', locator: fixture.archivePath });
    if (begun.kind !== 'reviewRequired') throw new Error('Expected archive installation review');
    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'archive-runtime', occurredAtMs: 9 },
    })).resolves.toMatchObject({ kind: 'committed', pendingSurfaces: [] });
    expect(await candidateRoots(happyHomeDir)).toEqual([]);
    await vi.waitFor(async () => {
      expect((await readPluginRegistryCommitRecord(resolvePluginStorePaths({ happyHomeDir })))?.revision).toBeGreaterThan(1);
    });

    const lease = await reloadController.acquireRuntimeRegistry();
    try {
      await expect(lease.registry.targetActionInvocations?.invoke({
        pluginId: 'acme.archive-candidate',
        localId: 'roundtrip',
        input: {},
        surface: 'cli',
      })).resolves.toEqual({ status: 'executed', value: { value: 'archive-adopted' } });
    } finally {
      await lease.release();
      await reloadController.shutdown();
    }
  });

  it('reviews exact local archive bytes before committing through the supplied daemon runtime lifecycle', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-archive-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createArchiveFixture();
    const canonicalArchivePath = await realpath(fixture.archivePath);
    const adopt = vi.fn(async () => undefined);
    const prepareRuntime = vi.fn(async () => ({ abort: async () => undefined, adopt }));
    const service = createDaemonPluginChangeService({
      prepare: createDaemonArchivePluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: { prepare: prepareRuntime },
      }),
      createPendingChangeId: () => 'pending-archive-candidate',
    });

    const begun = await service.requestPluginChange({ kind: 'installArchive', locator: fixture.archivePath });

    expect(begun).toEqual(expect.objectContaining({
      kind: 'reviewRequired',
      review: expect.objectContaining({
        pluginId: 'acme.archive-candidate',
        version: '1.2.3',
        source: {
          kind: 'archive',
          locator: canonicalArchivePath,
          integrity: fixture.integrity,
        },
        executableRealms: ['daemon'],
      }),
    }));
    expect(prepareRuntime).not.toHaveBeenCalled();
    await expect(readFile(join(fixture.root, 'lifecycle-script-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (begun.kind !== 'reviewRequired') throw new Error('Expected archive installation review');

    const committed = await service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'archive-review', occurredAtMs: 10 },
    });

    expect(committed).toEqual(expect.objectContaining({
      kind: 'committed',
      pluginId: 'acme.archive-candidate',
      desiredGeneration: expect.any(String),
      appliedGeneration: expect.any(String),
      pendingSurfaces: [],
    }));
    if (committed.kind !== 'committed') throw new Error('Expected archive candidate commit');
    expect(committed.appliedGeneration).toBe(committed.desiredGeneration);
    expect(prepareRuntime).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(await candidateRoots(happyHomeDir)).toEqual([]);

    const installed = (await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins['acme.archive-candidate'];
    expect(installed).toMatchObject({
      source: {
        kind: 'archive',
        locator: canonicalArchivePath,
        resolvedVersion: '1.2.3',
      },
      install: {
        mode: 'managed_install',
        trust: {
          distribution: {
            kind: 'archive',
            source: { kind: 'localFile', canonicalPath: canonicalArchivePath },
            integrity: fixture.integrity,
          },
        },
      },
    });
  });

  it('rejects a caller-pinned archive digest mismatch before review or runtime preparation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-archive-pin-home-'));
    roots.push(happyHomeDir);
    const fixture = await createArchiveFixture();
    const prepareRuntime = vi.fn(async () => ({ abort: async () => undefined, adopt: async () => undefined }));
    const prepare = createDaemonArchivePluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: { prepare: prepareRuntime },
    });

    await expect(prepare({
      kind: 'installArchive',
      locator: fixture.archivePath,
      expectedIntegrity: `sha256-${Buffer.alloc(32, 9).toString('base64')}`,
    })).rejects.toThrow(/integrity/i);
    expect(prepareRuntime).not.toHaveBeenCalled();
    expect(await candidateRoots(happyHomeDir)).toEqual([]);
  });

  it('accepts a matching caller-pinned archive digest and retains the normal Install and trust review', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-archive-pin-home-'));
    roots.push(happyHomeDir);
    const fixture = await createArchiveFixture();
    const service = createDaemonPluginChangeService({
      prepare: createDaemonArchivePluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
      }),
    });

    const begun = await service.requestPluginChange({
      kind: 'installArchive',
      locator: fixture.archivePath,
      expectedIntegrity: fixture.integrity,
    });

    expect(begun).toMatchObject({
      kind: 'reviewRequired',
      review: {
        pluginId: 'acme.archive-candidate',
        source: { integrity: fixture.integrity },
      },
    });
    await service.shutdown();
    expect(await candidateRoots(happyHomeDir)).toEqual([]);
    expect(await preparedGenerationRoots(happyHomeDir)).toEqual([]);
  });

  it('installs the daemon-custodied reviewed archive candidate when staging bytes change after review', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-archive-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createArchiveFixture();
    const prepareRuntime = vi.fn(async () => ({ abort: async () => undefined, adopt: async () => undefined }));
    const service = createDaemonPluginChangeService({
      prepare: createDaemonArchivePluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: { prepare: prepareRuntime },
      }),
      createPendingChangeId: () => 'pending-archive-tamper',
    });
    const begun = await service.requestPluginChange({ kind: 'installArchive', locator: fixture.archivePath });
    if (begun.kind !== 'reviewRequired') throw new Error('Expected archive installation review');
    const rootsBeforeDecision = await candidateRoots(happyHomeDir);
    expect(rootsBeforeDecision).toHaveLength(1);
    await writeFile(await findFile(rootsBeforeDecision[0]!, 'payload.txt'), 'substituted bytes');

    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'archive-tamper', occurredAtMs: 11 },
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.archive-candidate' });

    expect(prepareRuntime).toHaveBeenCalledOnce();
    const installed = (await createPluginRegistryStateStore({ happyHomeDir }).read())
      .plugins['acme.archive-candidate'];
    expect(installed).toBeDefined();
    await expect(readFile(join(installed!.source.resolvedPath, 'payload.txt'), 'utf8'))
      .resolves.toBe('reviewed archive bytes');
    expect(await candidateRoots(happyHomeDir)).toEqual([]);
    expect(await preparedGenerationRoots(happyHomeDir)).toHaveLength(1);
  });

  it('rejects when the same installed plugin changes after archive review', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-archive-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createArchiveFixture();
    const runtimeLifecycle = {
      prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
    };
    const prepare = createDaemonArchivePluginChangePreparer({ happyHomeDir, runtimeLifecycle });
    const service = createDaemonPluginChangeService({ prepare });
    const initial = await service.requestPluginChange({ kind: 'installArchive', locator: fixture.archivePath });
    if (initial.kind !== 'reviewRequired') throw new Error('Expected initial archive review');
    await service.decidePluginChange({
      pendingChangeId: initial.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'initial', occurredAtMs: 1 },
    });

    const prepared = await prepare({ kind: 'installArchive', locator: fixture.archivePath });
    const takeoverStore = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    await takeoverStore.update((state) => ({
      ...state,
      plugins: {
        ...state.plugins,
        'acme.archive-candidate': {
          ...state.plugins['acme.archive-candidate']!,
          state: { ...state.plugins['acme.archive-candidate']!.state, enabled: false },
        },
      },
    }));

    await expect(prepared.apply({
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'replacement', occurredAtMs: 2 },
      optionalSelections: [],
    })).resolves.toEqual({ kind: 'conflict', pluginId: 'acme.archive-candidate' });
    await prepared.cleanup();
  });

  it('computes remote archive integrity, omits unrecognized query credentials, and persists only benign selectors', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-archive-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createArchiveFixture();
    const bytes = await readFile(fixture.archivePath);
    const origin = await startArchiveServer(bytes);
    const archivePathAndQuery = [
      '/plugins/archive-candidate.tgz?download=1',
      'download=selector-private-secret',
      'opaqueGrant=opaque-private-secret',
      'token=private-archive-secret',
    ].join('&');
    const archiveUrl = `http://127.0.0.1:${origin.port}${archivePathAndQuery}`;
    const reviewArchiveUrl = `http://127.0.0.1:${origin.port}/plugins/archive-candidate.tgz?download=1`;
    const service = createDaemonPluginChangeService({
      prepare: createDaemonArchivePluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: { prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }) },
      }),
      createPendingChangeId: () => 'pending-remote-archive',
    });

    const begun = await service.requestPluginChange({ kind: 'installArchive', locator: archiveUrl });
    expect(begun).toMatchObject({
      kind: 'reviewRequired',
      review: {
        source: { kind: 'archive', locator: reviewArchiveUrl, integrity: fixture.integrity },
        updateChannel: { kind: 'archive', locator: reviewArchiveUrl },
      },
    });
    expect(JSON.stringify(begun)).not.toContain('private-archive-secret');
    expect(JSON.stringify(begun)).not.toContain('selector-private-secret');
    expect(JSON.stringify(begun)).not.toContain('opaque-private-secret');
    if (begun.kind !== 'reviewRequired') throw new Error('Expected remote archive installation review');
    const committed = await service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'remote-archive', occurredAtMs: 12 },
    });
    expect(committed).toMatchObject({ kind: 'committed', appliedGeneration: expect.any(String), pendingSurfaces: [] });
    expect(origin.observedUrls).toEqual([archivePathAndQuery]);
    expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins['acme.archive-candidate'])
      .toMatchObject({
        source: { kind: 'archive', locator: reviewArchiveUrl },
        install: { trust: { distribution: {
          kind: 'archive',
          source: { kind: 'remoteUrl', canonicalUrl: reviewArchiveUrl },
          integrity: fixture.integrity,
        } } },
      });
    await expect(createPluginRegistryStateStore({ happyHomeDir }).readSnapshot()).resolves.toMatchObject({
      admittedIntegrityByPluginId: {
        'acme.archive-candidate': fixture.integrity,
      },
    });
    expect(JSON.stringify(await createPluginRegistryStateStore({ happyHomeDir }).read()))
      .not.toContain('private-archive-secret');
    expect(JSON.stringify(await createPluginRegistryStateStore({ happyHomeDir }).read()))
      .not.toContain('selector-private-secret');
    expect(JSON.stringify(await createPluginRegistryStateStore({ happyHomeDir }).read()))
      .not.toContain('opaque-private-secret');
  });

  it('persists selected host resources and reports transaction adoption ambiguity as outcomeUnknown', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-archive-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createArchiveFixture({ optionalSessions: true });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonArchivePluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({
            abort: async () => undefined,
            adopt: async () => { throw new Error('adoption failed'); },
          }),
        },
      }),
      createPendingChangeId: () => 'pending-archive-adoption',
    });
    const begun = await service.requestPluginChange({ kind: 'installArchive', locator: fixture.archivePath });
    expect(begun).toMatchObject({
      kind: 'reviewRequired',
      review: { optionalHostAccess: [{ id: 'project-sessions', capability: 'sessions' }] },
    });
    if (begun.kind !== 'reviewRequired') throw new Error('Expected archive installation review');

    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'archive-adoption', occurredAtMs: 13 },
      optionalSelections: [{ accessId: 'project-sessions', selected: true }],
    })).resolves.toMatchObject({
      kind: 'outcomeUnknown',
      pluginId: 'acme.archive-candidate',
      expectedCandidate: expect.any(String),
    });
    expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins['acme.archive-candidate'])
      .toMatchObject({
        install: {
          optionalAccess: [{
            accessId: 'project-sessions',
            capability: 'sessions',
            selectedAtMs: 13,
          }],
        },
      });
  });

  it('rejects a package/manifest version mismatch through the canonical archive validator and cleans temporary bytes', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-archive-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createArchiveFixture({ manifestVersion: '9.9.9' });
    const prepareRuntime = vi.fn(async () => ({ abort: async () => undefined, adopt: async () => undefined }));
    const prepare = createDaemonArchivePluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: { prepare: prepareRuntime },
    });

    await expect(prepare({ kind: 'installArchive', locator: fixture.archivePath }))
      .rejects.toThrow(/manifest_identity_mismatch/);
    expect(prepareRuntime).not.toHaveBeenCalled();
    expect(await candidateRoots(happyHomeDir)).toEqual([]);
  });
});
