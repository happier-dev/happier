import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DaemonVoiceInferenceModelStatusSchema, getModelPackCatalogEntry, type ModelPackManifest } from '@happier-dev/protocol';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// Count real manifest reads, one per installed-plugin catalog projection.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createInferenceInstallBookkeeping } from '@/daemon/inference/inferenceInstallBookkeeping';
import { materializeZipformerVoiceModelPackPluginFixture } from '@/plugins/testkit/voiceModelPackPackage';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import type { PinnedHttpStreamTransport } from '@/network/pinnedHttp';
import { createNodeModelPackInstallerHost } from './nodeModelPackInstallerHost';
import {
  createDaemonPublicVoiceModelPackRuntime,
  resolveDefaultDaemonVoiceModelPackHostCapabilities,
} from './publicModelPacks/runtime';
import { installVoiceModelPackPluginArchiveFixture, VOICE_MODEL_PACK_TEST_RUNTIME_LIFECYCLE } from './publicModelPacks/pluginArchiveFixture';
import { hashVoiceModelPackManifest } from './voiceModelPackInstaller';
import * as lifecycleModule from './voiceInferenceWorker.lifecycle';
import { createNodeInstalledModelPackIntegrityHost } from './nodeModelPackIntegrityHost';
import { resolveVoiceInferencePaths } from './voiceInferencePaths';
import { startVoiceInferenceWorker } from './voiceInferenceWorker';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineVoiceInferenceRpcHandlers } from '@/api/machine/rpcHandlers.voiceInference';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

const ZIPFORMER_PACK_ID = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
const KOKORO_PACK_ID = 'kokoro-82m-v1.0-onnx-q8-wasm';

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createKokoroCatalogManifest(): ModelPackManifest {
  const catalogEntry = getModelPackCatalogEntry(KOKORO_PACK_ID);
  if (!catalogEntry || catalogEntry.runtimeFamily !== 'sherpa_kokoro_offline') {
    throw new Error('expected canonical Kokoro catalog entry');
  }
  const artifacts = [
    ...Object.values(catalogEntry.runtimeArtifacts),
    ...(catalogEntry.supportArtifacts ?? []),
  ];
  return {
    packId: KOKORO_PACK_ID,
    kind: 'tts_sherpa',
    model: 'kokoro',
    version: 'kokoro-int8-multi-lang-v1_1',
    files: artifacts.map((artifact, index) => ({
      path: artifact.path === 'espeak-ng-data'
        ? 'espeak-ng-data/voices/!v/Alex'
        : artifact.path,
      url: artifact.path === 'espeak-ng-data'
        ? 'https://github.com/happier-dev/happier-assets/releases/download/model-packs/kokoro-82m-v1.0-onnx-q8-wasm__espeak-ng-data__voices__.v__Alex'
        : `https://github.com/happier-dev/happier-assets/releases/download/model-packs/kokoro-82m-v1.0-onnx-q8-wasm__${artifact.path.replaceAll('/', '__')}`,
      sha256: String((index % 9) + 1).repeat(64),
      sizeBytes: index + 1,
    })),
  };
}

function createZipformerCatalogManifest(): Readonly<{
  manifest: ModelPackManifest;
  requiredRuntimePath: string;
}> {
  const catalogEntry = getModelPackCatalogEntry(ZIPFORMER_PACK_ID);
  if (!catalogEntry || catalogEntry.runtimeFamily !== 'sherpa_zipformer_streaming') {
    throw new Error('expected canonical Zipformer catalog entry');
  }
  const runtimePaths = Object.values(catalogEntry.runtimeArtifacts).map((artifact) => artifact.path);
  const paths = [
    ...runtimePaths,
    ...(catalogEntry.supportArtifacts ?? []).map((artifact) => artifact.path),
  ];

  return {
    manifest: {
      packId: catalogEntry.packId,
      kind: catalogEntry.kind,
      model: catalogEntry.model,
      version: 'catalog-fixture',
      files: paths.map((path, index) => ({
        path,
        url: `https://example.invalid/${path}`,
        sha256: String(index + 1).repeat(64),
        sizeBytes: 4,
      })),
    },
    requiredRuntimePath: runtimePaths[0],
  };
}

describe('createVoiceInferenceWorkerLifecycle', () => {
  const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_MODEL_PACK_MANIFESTS'] as const;
  let envScope = createEnvKeyScope(envKeys);
  const tempDirs: string[] = [];
  const disposeRuntimes: Array<() => Promise<void>> = [];
  const closeAssetServers: Array<() => Promise<void>> = [];
  const retainedRuntimeHomes = new Set<string>();

  async function createHomeDir(): Promise<string> {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-voice-inference-lifecycle-'));
    tempDirs.push(homeDir);
    return homeDir;
  }

  async function importLifecycleModuleForHome(homeDir: string) {
    process.env.HAPPIER_HOME_DIR = homeDir;
    reloadConfiguration();
    return lifecycleModule;
  }

  async function serveModelPackManifest(
    manifest: ModelPackManifest,
    onAssetRequest?: (request: IncomingMessage, response: ServerResponse) => void,
  ) {
    const assets = new Map<string, Uint8Array>();
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/manifest.json') {
        response.end(JSON.stringify(manifest));
      } else if (onAssetRequest) {
        onAssetRequest(request, response);
      } else {
        const bytes = assets.get(request.url ?? '');
        response.writeHead(bytes ? 200 : 404);
        response.end(bytes);
      }
    });
    closeAssetServers.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture_server_failed_to_bind');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const file of manifest.files) {
      const bytes = new TextEncoder().encode(`fixture:${file.path}`);
      file.sha256 = createHash('sha256').update(bytes).digest('hex');
      file.sizeBytes = bytes.byteLength;
      const path = `/${file.path.split('/').map(encodeURIComponent).join('/')}`;
      file.url = `${origin}${path}`;
      assets.set(path, bytes);
    }
    process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({ [manifest.packId]: `${origin}/manifest.json` });
    return { assets, requests };
  }

  function createAssetTransport(assets: ReadonlyMap<string, Uint8Array>): PinnedHttpStreamTransport {
    // Download transport and DNS are system boundaries; verification, promotion and disk are real.
    const pinnedTransport: PinnedHttpStreamTransport = async ({ url }) => {
      const bytes = assets.get(url);
      if (!bytes) throw new Error(`fixture_asset_missing:${url}`);
      let delivered = false;
      return {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
        contentLength: bytes.byteLength,
        read: async () => {
          if (delivered) return null;
          delivered = true;
          return bytes;
        },
        cancel: () => undefined,
      };
    };
    return pinnedTransport;
  }

  function createAssetInstallerHost(
    input: Parameters<typeof createNodeModelPackInstallerHost>[0],
    assets: ReadonlyMap<string, Uint8Array>,
  ) {
    return createNodeModelPackInstallerHost({
      ...input,
      resolveAddresses: async () => ['93.184.216.34'],
      pinnedTransport: createAssetTransport(assets),
    });
  }

  async function createInstalledPublicPack(
    homeDir: string,
    localId: string,
    fingerprintInstalledPack?: Parameters<typeof createDaemonPublicVoiceModelPackRuntime>[0]['fingerprintInstalledPack'],
    pluginId = 'acme.voice',
  ) {
    // The real controller owns one file-lifetime publication; keep its source roots until shutdown.
    retainedRuntimeHomes.add(homeDir);
    const packageRoot = join(homeDir, 'archive-source', 'package');
    await materializeZipformerVoiceModelPackPluginFixture(packageRoot);
    const pluginJsonPath = join(packageRoot, '.happier-plugin', 'plugin.json');
    const plugin = PluginManifestV2Schema.parse(JSON.parse(await readFile(pluginJsonPath, 'utf8')));
    const contribution = plugin.contributes?.voiceModelPacks?.[0];
    if (!contribution) throw new Error('expected model-pack fixture contribution');
    const catalogEntry = getModelPackCatalogEntry(KOKORO_PACK_ID);
    if (!catalogEntry || catalogEntry.runtimeFamily !== 'sherpa_kokoro_offline') {
      throw new Error('expected canonical Kokoro catalog entry');
    }
    const host = resolveDefaultDaemonVoiceModelPackHostCapabilities(process.platform, process.arch);
    if (!host) throw new Error('model-pack fixture requires a supported daemon host');
    plugin.id = pluginId;
    contribution.id = localId;
    const manifest = createKokoroCatalogManifest();
    const assets = new Map<string, Uint8Array>();
    for (const file of manifest.files) {
      const bytes = new TextEncoder().encode(`fixture:${file.path}`);
      file.sha256 = createHash('sha256').update(bytes).digest('hex');
      file.sizeBytes = bytes.byteLength;
      assets.set(file.url, bytes);
    }
    contribution.manifest = {
      ...contribution.manifest,
      kind: manifest.kind,
      model: manifest.model,
      files: manifest.files,
      supportArtifacts: [...(catalogEntry.supportArtifacts ?? [])],
      runtime: {
        ...contribution.manifest.runtime,
        family: catalogEntry.runtimeFamily,
        artifacts: catalogEntry.runtimeArtifacts,
        abiVersion: 1,
        platforms: [host.platform],
        architectures: [host.architecture],
      },
      voices: [
        { id: 'calm', title: 'Calm', sid: 4 },
        { id: 'bright', title: 'Bright', subtitle: 'English', sid: 7 },
      ],
      defaultVoiceId: 'bright',
    };
    await writeFile(pluginJsonPath, JSON.stringify(PluginManifestV2Schema.parse(plugin)), 'utf8');
    await installVoiceModelPackPluginArchiveFixture({
      happyHomeDir: homeDir,
      archiveSourceRoot: join(homeDir, 'archive-source'),
      packageRoot,
      archiveFileName: 'voice-model-pack.tgz',
      interactionId: 'lifecycle-model-pack-install',
    });
    const reload = async () => {
      const contributes = createResolvedContributionRegistry(await resolvePluginContributes({ happyHomeDir: homeDir }));
      const admitted = await createAdmittedPluginRuntimeFixture({
        happyHomeDir: homeDir,
        controller: pluginReloadController,
        runtimeOptions: { pluginIds: [plugin.id], contributes },
      });
      await admitted.lease.release();
      disposeRuntimes.push(admitted.dispose);
    };
    await reload();
    const publicModelPacks = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-lifecycle',
      machineId: 'machine-lifecycle',
      happyHomeDir: homeDir,
      paths: resolveVoiceInferencePaths(),
      host,
      createInstallerHost: (input) => createAssetInstallerHost(input, assets),
      fingerprintInstalledPack,
    });
    const key = `${plugin.id}/${localId}`;
    await publicModelPacks.install({ key, signal: new AbortController().signal });
    return { publicModelPacks, key, reload };
  }

  afterEach(async () => {
    try {
      await Promise.all(closeAssetServers.splice(0).map((close) => close()));
    } finally {
      envScope.restore();
      envScope = createEnvKeyScope(envKeys);
      await Promise.all(tempDirs.splice(0).filter((dir) => !retainedRuntimeHomes.has(dir))
        .map(async (dir) => await rm(dir, { recursive: true, force: true }).catch(() => undefined)));
    }
  });

  afterAll(async () => {
    try {
      for (const dispose of disposeRuntimes.splice(0).reverse()) await dispose();
    } finally {
      try {
        await pluginReloadController.shutdown();
      } finally {
        await Promise.all([...retainedRuntimeHomes].map((dir) => rm(dir, { recursive: true, force: true })));
        retainedRuntimeHomes.clear();
      }
    }
  });

  it('reports model use from overlapping leases and clears it after success or failure', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const lifecycle = createVoiceInferenceWorkerLifecycle();
    const first = deferred<void>();
    const second = deferred<void>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const read = async () => DaemonVoiceInferenceModelStatusSchema.parse(
      (await lifecycle.getModelsStatus([ZIPFORMER_PACK_ID]))[0],
    );
    const firstUse = lifecycle.runWithModelLease(ZIPFORMER_PACK_ID, async () => {
      firstStarted.resolve();
      await first.promise;
    });
    const secondUse = lifecycle.runWithModelLease(ZIPFORMER_PACK_ID, async () => {
      secondStarted.resolve();
      await second.promise;
      throw new Error('native_operation_failed');
    }).catch((error: unknown) => error);
    try {
      await Promise.all([firstStarted.promise, secondStarted.promise]);
      expect(await read()).toMatchObject({ inUse: true });
      first.resolve();
      await firstUse;
      expect(await read()).toMatchObject({ inUse: true });
      second.resolve();
      expect(await secondUse).toBeInstanceOf(Error);
      expect(await read()).toMatchObject({ inUse: false });
    } finally {
      first.resolve();
      second.resolve();
      await Promise.all([firstUse, secondUse]);
      await lifecycle.stop();
    }
  });

  it('rejects unsupported runtime families before manifest download or install mutation', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { requests } = await serveModelPackManifest(createZipformerCatalogManifest().manifest);
    const lifecycle = createVoiceInferenceWorkerLifecycle();

    await expect(lifecycle.installModel({
      packId: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    })).rejects.toMatchObject({ code: 'unsupported_runtime_family' });
    expect(requests).toEqual([]);
    await expect(lifecycle.listModels()).resolves.toEqual([]);
    await lifecycle.stop();
  });

  it('admits the exact published Kokoro catalog pack through the normal manifest installer', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const manifest = createKokoroCatalogManifest();
    const { assets, requests } = await serveModelPackManifest(manifest);
    const lifecycle = createVoiceInferenceWorkerLifecycle();
    try {
      await expect(lifecycle.getModelsStatus([
        'kokoro-82m-v1.0-onnx-q8-wasm',
      ])).resolves.toEqual([
        expect.objectContaining({
          runtimeFamily: 'sherpa_kokoro_offline',
          runtimeSupported: true,
          installState: 'not_installed',
        }),
      ]);
      await expect(lifecycle.installModel({
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      })).resolves.toMatchObject({
        packId: KOKORO_PACK_ID,
        runtimeFamily: 'sherpa_kokoro_offline',
        runtimeSupported: true,
        installState: 'installed',
      });
      const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
      const packDir = join(resolveVoiceInferencePaths().packsRootDir, manifest.packId);
      const installedManifest: unknown = JSON.parse(await readFile(join(packDir, 'pack.json'), 'utf8'));
      expect(installedManifest).toEqual(manifest);
      expect(requests.filter((path) => path === '/manifest.json')).toHaveLength(1);
      for (const file of manifest.files) {
        const path = new URL(file.url).pathname;
        expect(requests.filter((requestedPath) => requestedPath === path)).toHaveLength(1);
        await expect(readFile(join(packDir, file.path))).resolves.toEqual(Buffer.from(assets.get(path)!));
      }
    } finally {
      await lifecycle.stop();
    }
  });

  it('cancels an in-flight model install when the caller aborts and never reports it installed', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const manifest = createKokoroCatalogManifest();
    const caller = new AbortController();
    const cancelledDownload = deferred<void>();
    await serveModelPackManifest(manifest, (_request, response) => {
      response.once('close', () => cancelledDownload.resolve());
      // Hold the real HTTP download open while its requesting caller gives up.
      caller.abort(new Error('caller_cancelled'));
    });
    const lifecycle = createVoiceInferenceWorkerLifecycle();

    await expect(lifecycle.installModel({
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      signal: caller.signal,
    })).rejects.toBeDefined();

    await cancelledDownload.promise;
    expect(caller.signal.aborted).toBe(true);
    await expect(lifecycle.getModelsStatus(['kokoro-82m-v1.0-onnx-q8-wasm'])).resolves.toEqual([
      expect.objectContaining({ installState: expect.not.stringMatching(/^installed$/) }),
    ]);
    await lifecycle.stop();
  });

  it('refreshes retained Kokoro voice metadata through model install and publishes it after restart', async () => {
    const homeDir = await createHomeDir();
    await importLifecycleModuleForHome(homeDir);
    const manifest = createKokoroCatalogManifest();
    const { requests } = await serveModelPackManifest(manifest);
    let worker = await startVoiceInferenceWorker();
    const manager = new RpcHandlerManager({
      scopePrefix: 'kokoro-catalog-metadata-test',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      encryptionMode: 'plain',
      logger: () => {},
    });
    let registration = registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: manager,
      voiceInferenceWorker: worker,
    });
    const list = () => manager.invokeLocal(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST, {});
    try {
      await manager.invokeLocal(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL, { packId: KOKORO_PACK_ID });
      await expect(list()).resolves.toMatchObject({ ok: true, models: [{ voices: [], defaultVoiceId: null }] });

      manifest.voices = [
        { id: 'calm', title: 'Calm', subtitle: 'English', sid: 0 },
        { id: 'bright', title: 'Bright', subtitle: 'English', sid: 1 },
      ];
      manifest.defaultVoiceId = 'bright';
      const expected = {
        packId: KOKORO_PACK_ID,
        installState: 'installed',
        voices: manifest.voices,
        defaultVoiceId: 'bright',
      };
      const requestsBeforeRefresh = requests.length;
      await expect(manager.invokeLocal(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL, {
        packId: KOKORO_PACK_ID,
      })).resolves.toMatchObject({ ok: true, model: expected });
      expect(requests.slice(requestsBeforeRefresh)).toEqual(['/manifest.json']);
      await expect(list()).resolves.toMatchObject({ ok: true, models: [expected] });

      await registration.dispose();
      await worker.stop();
      worker = await startVoiceInferenceWorker();
      registration = registerMachineVoiceInferenceRpcHandlers({ rpcHandlerManager: manager, voiceInferenceWorker: worker });
      const requestsBeforeReads = requests.length;
      await expect(list()).resolves.toMatchObject({ ok: true, models: [expected] });
      await expect(manager.invokeLocal(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS, {
        packIds: [KOKORO_PACK_ID],
      })).resolves.toMatchObject({ ok: true, models: [expected] });
      expect(requests).toHaveLength(requestsBeforeReads);
    } finally {
      await registration.dispose();
      await worker.stop();
    }
  });

  it('admits a supported catalog family for an explicit injected runtime fixture', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
    const manifest: ModelPackManifest = {
      packId: KOKORO_PACK_ID,
      kind: 'tts_sherpa',
      model: 'kokoro-82m-v1.0',
      version: 'injected-runtime-fixture',
      files: [{
        path: 'model.onnx',
        url: 'https://example.invalid/model.onnx',
        sha256: '1'.repeat(64),
        sizeBytes: 4,
      }],
    };
    const { requests } = await serveModelPackManifest(manifest);
    const warmModel = vi.fn(async () => undefined);
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      enforceCatalogRuntimeManifest: false,
      runtimeLoader: async () => ({
        warmModel,
        synthesizeTts: async () => {
          throw new Error('not exercised');
        },
        transcribeAudio: async () => {
          throw new Error('not exercised');
        },
      }),
    });

    await expect(lifecycle.getModelsStatus([KOKORO_PACK_ID])).resolves.toEqual([
      expect.objectContaining({
        packId: KOKORO_PACK_ID,
        runtimeFamily: 'sherpa_kokoro_offline',
        runtimeSupported: true,
        installState: 'not_installed',
      }),
    ]);
    await expect(lifecycle.installModel({
      packId: KOKORO_PACK_ID,
    })).resolves.toMatchObject({
      packId: KOKORO_PACK_ID,
      runtimeSupported: true,
      installState: 'installed',
    });
    await lifecycle.warmModelPack(KOKORO_PACK_ID);

    expect(requests).toEqual(['/manifest.json', '/model.onnx']);
    expect(warmModel).toHaveBeenCalledWith(expect.objectContaining({
      packId: KOKORO_PACK_ID,
      packDir: join(resolveVoiceInferencePaths().packsRootDir, KOKORO_PACK_ID),
      manifest,
    }));
    await lifecycle.stop();
  });

  it('keeps previously-installed unpublished catalog bytes inert for status and runtime warmup', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
    const unavailablePackId = 'kokoro-en-v0_19';
    const catalogEntry = getModelPackCatalogEntry(unavailablePackId);
    if (!catalogEntry || catalogEntry.runtimeFamily !== 'sherpa_kokoro_offline') {
      throw new Error('expected unavailable neighboring Kokoro catalog entry');
    }
    const packDir = join(resolveVoiceInferencePaths().packsRootDir, unavailablePackId);
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'pack.json'), JSON.stringify({
      packId: catalogEntry.packId,
      kind: catalogEntry.kind,
      model: catalogEntry.model,
      version: 'installed-before-publication-was-disabled',
      files: [
        ...Object.values(catalogEntry.runtimeArtifacts),
        ...(catalogEntry.supportArtifacts ?? []),
      ].map((artifact, index) => ({
        path: artifact.path,
        url: `https://example.invalid/${artifact.path}`,
        sha256: String((index % 9) + 1).repeat(64),
        sizeBytes: 4,
      })),
    }), 'utf8');
    const runtimeLoader = vi.fn(async () => ({
      warmModel: vi.fn(async () => undefined),
      primeModel: vi.fn(async () => undefined),
      releaseModel: vi.fn(async () => undefined),
      synthesizeTts: vi.fn(async () => {
        throw new Error('unavailable_pack_reached_synthesis');
      }),
      transcribeAudio: vi.fn(async () => {
        throw new Error('unavailable_pack_reached_transcription');
      }),
    }));
    const lifecycle = createVoiceInferenceWorkerLifecycle({ runtimeLoader });

    const status = (await lifecycle.getModelsStatus([unavailablePackId]))[0];
    const listedStatuses = await lifecycle.listModels();
    const warmResult = await lifecycle.warmModelPack(unavailablePackId)
      .then(() => 'warmed' as const)
      .catch((error: unknown) => error);
    await lifecycle.removeModel(unavailablePackId);
    const removedStatus = (await lifecycle.getModelsStatus([unavailablePackId]))[0];
    const listedAfterRemoval = await lifecycle.listModels();
    await lifecycle.stop();

    expect(status).toMatchObject({
      packId: unavailablePackId,
      installState: 'installed',
      runtimeSupported: false,
    });
    expect(listedStatuses).toContainEqual(expect.objectContaining({
      packId: unavailablePackId,
      installState: 'installed',
      runtimeSupported: false,
    }));
    expect(warmResult).toMatchObject({ code: 'unsupported_runtime_family' });
    expect(runtimeLoader).not.toHaveBeenCalled();
    expect(removedStatus).toMatchObject({
      packId: unavailablePackId,
      installState: 'not_installed',
      runtimeSupported: false,
    });
    expect(listedAfterRemoval).not.toContainEqual(expect.objectContaining({
      packId: unavailablePackId,
    }));
  });

  it('projects runtime-family support for every requested catalog pack without downloading manifests', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { requests } = await serveModelPackManifest(createZipformerCatalogManifest().manifest);
    const lifecycle = createVoiceInferenceWorkerLifecycle();

    await expect(lifecycle.getModelsStatus([
      'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
      'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    ])).resolves.toEqual([
      expect.objectContaining({
        runtimeFamily: 'sherpa_zipformer_streaming',
        runtimeSupported: true,
        installState: 'not_installed',
      }),
      expect.objectContaining({
        runtimeFamily: 'sherpa_parakeet_offline',
        runtimeSupported: false,
        installState: 'not_installed',
      }),
    ]);
    expect(requests).toEqual([]);
    await lifecycle.stop();
  });

  it.each([
    {
      label: 'omits a required runtime file',
      defect: 'missing_runtime_file' as const,
    },
    {
      label: 'declares a different model kind',
      defect: 'different_kind' as const,
    },
  ])('rejects a supported-family manifest that $label before install mutation', async ({ defect }) => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const baseline = createZipformerCatalogManifest();
    const manifest: ModelPackManifest = defect === 'missing_runtime_file'
      ? {
          ...baseline.manifest,
          files: baseline.manifest.files.filter((file) => file.path !== baseline.requiredRuntimePath),
        }
      : {
          ...baseline.manifest,
          kind: 'tts_sherpa',
        };
    const { requests } = await serveModelPackManifest(manifest);
    const lifecycle = createVoiceInferenceWorkerLifecycle();

    await expect(lifecycle.installModel({ packId: ZIPFORMER_PACK_ID })).rejects.toMatchObject({
      code: 'internal_error',
      message: 'voice_inference_model_pack_manifest_incompatible',
    });
    expect(requests).toEqual(['/manifest.json']);
    await expect(lifecycle.listModels()).resolves.toEqual([]);
    await lifecycle.stop();
  });

  it('admits the canonical Zipformer manifest baseline before install mutation', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { manifest } = createZipformerCatalogManifest();
    const { requests } = await serveModelPackManifest(manifest);
    const lifecycle = createVoiceInferenceWorkerLifecycle();

    await expect(lifecycle.installModel({ packId: ZIPFORMER_PACK_ID })).resolves.toMatchObject({
      packId: ZIPFORMER_PACK_ID,
      kind: manifest.kind,
      runtimeFamily: 'sherpa_zipformer_streaming',
      runtimeSupported: true,
    });
    expect(requests.filter((path) => path !== '/manifest.json')).toHaveLength(manifest.files.length);
    const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
    const installed: unknown = JSON.parse(await readFile(join(resolveVoiceInferencePaths().packsRootDir, manifest.packId, 'pack.json'), 'utf8'));
    expect(installed).toEqual(manifest);
    await lifecycle.stop();
  });

  it('projects a legacy installed manifest that cannot satisfy its runtime adapter as unsupported for recovery', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
    const packId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
    const packDir = join(resolveVoiceInferencePaths().packsRootDir, packId);
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'pack.json'), JSON.stringify({
      packId,
      kind: 'stt_sherpa',
      model: 'zipformer_transducer',
      version: 'legacy-incomplete',
      files: [{
        path: 'encoder.onnx',
        url: 'https://example.invalid/encoder.onnx',
        sha256: 'a'.repeat(64),
        sizeBytes: 4,
      }],
    }), 'utf8');
    const lifecycle = createVoiceInferenceWorkerLifecycle();

    await expect(lifecycle.getModelsStatus([packId])).resolves.toEqual([
      expect.objectContaining({
        packId,
        installState: 'installed',
        runtimeFamily: 'sherpa_zipformer_streaming',
        runtimeSupported: false,
      }),
    ]);
    await lifecycle.stop();
  });

  it('does not let a retained pack manifest overrule interrupted-install integrity reconciliation', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
    const { manifest } = createZipformerCatalogManifest();
    const paths = resolveVoiceInferencePaths();
    const packDir = join(paths.packsRootDir, manifest.packId);
    await mkdir(packDir, { recursive: true });
    // Preserve the canonical manifest but omit every declared model byte. The
    // startup verifier must reject this predecessor-owned partial install.
    await writeFile(join(packDir, 'pack.json'), JSON.stringify(manifest), 'utf8');
    const predecessor = createInferenceInstallBookkeeping({ stateFilePath: paths.installsStateFilePath, now: () => 1 });
    let interruptedCheckpoint = '';
    await predecessor.install({
      modelId: manifest.packId,
      version: manifest.version,
      manifestHash: hashVoiceModelPackManifest(manifest),
      kind: manifest.kind,
      model: manifest.model,
      performInstall: async (reportProgress) => {
        await reportProgress({ phase: 'installing', progress: 0.9 });
        interruptedCheckpoint = await readFile(paths.installsStateFilePath, 'utf8');
      },
    });
    // Restore the actual writer's interrupted checkpoint, as a stopped predecessor would leave it.
    await writeFile(paths.installsStateFilePath, interruptedCheckpoint, 'utf8');

    const lifecycle = createVoiceInferenceWorkerLifecycle();
    await expect(lifecycle.getModelsStatus([manifest.packId])).resolves.toEqual([
      expect.objectContaining({
        packId: manifest.packId,
        installState: 'error',
        runtimeSupported: false,
        lastError: 'inference_install_interrupted',
      }),
    ]);
    await lifecycle.stop();
  });

  it('clears failed warm readiness and exposes degraded service diagnostics before a retry', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
    const { manifest } = createZipformerCatalogManifest();
    const packDir = join(resolveVoiceInferencePaths().packsRootDir, manifest.packId);
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'pack.json'), JSON.stringify(manifest), 'utf8');

    let warmAttempts = 0;
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      runtimeLoader: async () => ({
        warmModel: async () => {
          warmAttempts += 1;
          if (warmAttempts === 1) {
            throw new Error('warm-model-failed');
          }
        },
        synthesizeTts: async () => {
          throw new Error('not exercised');
        },
        transcribeAudio: async () => {
          throw new Error('not exercised');
        },
      }),
    });

    const firstWarmFailure = await lifecycle.warmModelPack(manifest.packId)
      .then(() => null)
      .catch((error: unknown) => error);
    const failedStatus = await lifecycle.getStatus();
    await lifecycle.warmModelPack(manifest.packId);
    const recoveredStatus = await lifecycle.getStatus();
    await lifecycle.stop();

    expect(firstWarmFailure).toMatchObject({ message: 'warm-model-failed' });
    expect(failedStatus).toMatchObject({
      serviceState: 'degraded',
      models: [
        expect.objectContaining({
          packId: manifest.packId,
          runtimeState: 'cold',
        }),
      ],
    });
    expect(warmAttempts).toBe(2);
    expect(recoveredStatus).toMatchObject({
      serviceState: 'ready',
      models: [
        expect.objectContaining({
          packId: manifest.packId,
          runtimeState: 'ready',
        }),
      ],
    });
  });

  it('keeps a runtime-unavailable warm failure unavailable instead of reporting the loaded service ready', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
    const { manifest } = createZipformerCatalogManifest();
    const packDir = join(resolveVoiceInferencePaths().packsRootDir, manifest.packId);
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'pack.json'), JSON.stringify(manifest), 'utf8');

    const lifecycle = createVoiceInferenceWorkerLifecycle({
      runtimeLoader: async () => ({
        warmModel: async () => {
          throw Object.assign(new Error('runtime-warm-unavailable'), { code: 'runtime_unavailable' });
        },
        synthesizeTts: async () => {
          throw new Error('not exercised');
        },
        transcribeAudio: async () => {
          throw new Error('not exercised');
        },
      }),
    });

    await expect(lifecycle.warmModelPack(manifest.packId)).rejects.toMatchObject({
      code: 'runtime_unavailable',
    });
    await expect(lifecycle.getStatus()).resolves.toMatchObject({
      serviceState: 'unavailable',
      models: [
        expect.objectContaining({
          packId: manifest.packId,
          runtimeState: 'cold',
        }),
      ],
    });
    await lifecycle.stop();
  });

  it.each([
    { kind: 'timeout', code: 'runtime_timeout', message: 'voice_inference_worker_request_timeout' },
    { kind: 'termination', code: 'runtime_unavailable', message: 'voice_inference_worker_terminated' },
  ])('does not publish a ready runtime after priming reports a fork-invalidating $kind', async ({ code, message }) => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
    const { manifest } = createZipformerCatalogManifest();
    const packDir = join(resolveVoiceInferencePaths().packsRootDir, manifest.packId);
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'pack.json'), JSON.stringify(manifest), 'utf8');

    const releasedPackIds: string[] = [];
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      runtimeLoader: async () => ({
        warmModel: async () => {},
        primeModel: async () => {
          throw Object.assign(new Error(message), { code });
        },
        releaseModel: async ({ packId }) => {
          releasedPackIds.push(packId);
        },
        synthesizeTts: async () => {
          throw new Error('not exercised');
        },
        transcribeAudio: async () => {
          throw new Error('not exercised');
        },
      }),
    });

    await expect(lifecycle.warmRuntimeForPack(manifest.packId)).rejects.toMatchObject({
      code,
    });
    expect(releasedPackIds).toEqual([manifest.packId]);
    const status = await lifecycle.getStatus();
    expect(status.serviceState).not.toBe('ready');
    expect(status).toMatchObject({
      models: [
        expect.objectContaining({
          packId: manifest.packId,
          runtimeState: 'cold',
        }),
      ],
    });

    await lifecycle.stop();
  });

  it('publishes a ready runtime when a non-invalidating prime failure is best-effort', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
    const { manifest } = createZipformerCatalogManifest();
    const packDir = join(resolveVoiceInferencePaths().packsRootDir, manifest.packId);
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'pack.json'), JSON.stringify(manifest), 'utf8');

    const releasedPackIds: string[] = [];
    const runtime = {
      warmModel: async () => {},
      primeModel: async () => {
        throw new Error('best_effort_prime_failed');
      },
      releaseModel: async ({ packId }: Readonly<{ packId: string }>) => {
        releasedPackIds.push(packId);
      },
      synthesizeTts: async () => {
        throw new Error('not exercised');
      },
      transcribeAudio: async () => {
        throw new Error('not exercised');
      },
    };
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      runtimeLoader: async () => runtime,
    });

    await expect(lifecycle.warmRuntimeForPack(manifest.packId)).resolves.toMatchObject({
      runtime,
    });
    expect(releasedPackIds).toEqual([]);
    await expect(lifecycle.getStatus()).resolves.toMatchObject({
      serviceState: 'ready',
      models: [
        expect.objectContaining({
          packId: manifest.packId,
          runtimeState: 'ready',
        }),
      ],
    });

    await lifecycle.stop();
    expect(releasedPackIds).toEqual([manifest.packId]);
  });

  it('releases a warmed runtime when priming is cancelled before publication', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
    const { manifest } = createZipformerCatalogManifest();
    const packDir = join(resolveVoiceInferencePaths().packsRootDir, manifest.packId);
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'pack.json'), JSON.stringify(manifest), 'utf8');

    const cancellation = new AbortController();
    let warmAttempts = 0;
    let primeAttempts = 0;
    const releasedPackIds: string[] = [];
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      runtimeLoader: async () => ({
        warmModel: async () => {
          warmAttempts += 1;
        },
        primeModel: async () => {
          primeAttempts += 1;
          if (primeAttempts === 1) {
            cancellation.abort();
            throw Object.assign(new Error('prime-aborted'), { code: 'cancelled' });
          }
        },
        releaseModel: async ({ packId }) => {
          releasedPackIds.push(packId);
          if (releasedPackIds.length === 1) {
            throw new Error('release-after-prime-failed');
          }
        },
        synthesizeTts: async () => {
          throw new Error('not exercised');
        },
        transcribeAudio: async () => {
          throw new Error('not exercised');
        },
      }),
    });

    const warmFailure = await lifecycle.warmRuntimeForPack(manifest.packId, cancellation.signal)
      .then(() => null)
      .catch((error: unknown) => error);
    const failedStatus = await lifecycle.getStatus();

    expect(warmFailure).toMatchObject({ message: 'prime-aborted', code: 'cancelled' });
    expect(warmAttempts).toBe(1);
    expect(primeAttempts).toBe(1);
    expect(releasedPackIds).toEqual([manifest.packId]);
    expect(failedStatus).toMatchObject({
      serviceState: 'ready',
      models: [
        expect.objectContaining({
          packId: manifest.packId,
          runtimeState: 'cold',
        }),
      ],
    });
    expect(failedStatus.models[0]).not.toHaveProperty('loadedArtifactBytes');

    await lifecycle.warmRuntimeForPack(manifest.packId);
    expect(warmAttempts).toBe(2);
    expect(primeAttempts).toBe(2);
    expect(releasedPackIds).toEqual([manifest.packId]);
    await expect(lifecycle.getStatus()).resolves.toMatchObject({
      serviceState: 'ready',
      models: [
        expect.objectContaining({
          packId: manifest.packId,
          runtimeState: 'ready',
        }),
      ],
    });

    await lifecycle.stop();
  });

  it('releases the exact evicted runtime while retaining a replacement that serves the next inference', async () => {
    vi.useFakeTimers();
    const oldReleaseGate = deferred<void>();
    let stopLifecycle: (() => Promise<void>) | null = null;

    try {
      const homeDir = await createHomeDir();
      const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
      const { createVoiceInferenceWorkerExecution } = await import('./voiceInferenceWorker.execution');
      const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
      const manifest: ModelPackManifest = {
        packId: KOKORO_PACK_ID,
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: 'replacement-race-fixture',
        files: [{
          path: 'model.onnx',
          url: 'https://example.invalid/model.onnx',
          sha256: 'a'.repeat(64),
          sizeBytes: 4,
        }],
      };
      const packDir = join(resolveVoiceInferencePaths().packsRootDir, manifest.packId);
      await mkdir(packDir, { recursive: true });
      await writeFile(join(packDir, 'pack.json'), JSON.stringify(manifest), 'utf8');

      const oldReleaseStarted = deferred<void>();
      const replacementReleaseStarted = deferred<void>();
      const releasedRuntimeIds: string[] = [];
      const warmedRuntimeIds: string[] = [];
      const createRuntime = (runtimeId: 'old' | 'replacement') => ({
        warmModel: async () => {
          warmedRuntimeIds.push(runtimeId);
        },
        releaseModel: async () => {
          releasedRuntimeIds.push(runtimeId);
          if (runtimeId === 'old') {
            oldReleaseStarted.resolve();
            await oldReleaseGate.promise;
            return;
          }
          replacementReleaseStarted.resolve();
        },
        synthesizeTts: async () => ({
          bytes: Buffer.from(runtimeId, 'utf8'),
          output: { codec: 'wav' as const, mimeType: 'audio/wav' as const },
          name: `${runtimeId}.wav`,
        }),
        transcribeAudio: async () => ({ text: 'unused', language: null }),
      });
      const oldRuntime = createRuntime('old');
      const replacementRuntime = createRuntime('replacement');
      const runtimeLoader = vi.fn(async () => {
        const nextRuntime = [oldRuntime, replacementRuntime][warmedRuntimeIds.length];
        if (!nextRuntime) {
          throw new Error('unexpected_runtime_load');
        }
        return nextRuntime;
      });

      const lifecycle = createVoiceInferenceWorkerLifecycle({
        enforceCatalogRuntimeManifest: false,
        residencyMs: 1_000,
        runtimeLoader,
      });
      stopLifecycle = lifecycle.stop;
      const firstWarm = await lifecycle.warmRuntimeForPack(manifest.packId);
      expect(firstWarm.runtime).toBe(oldRuntime);

      const lifecycleLockEntered = deferred<void>();
      const releaseLifecycleLock = deferred<void>();
      const heldLifecycleLock = lifecycle.runLifecycleExclusive(manifest.packId, async () => {
        lifecycleLockEntered.resolve();
        await releaseLifecycleLock.promise;
      });
      await lifecycleLockEntered.promise;

      // The residency timer removes the old coordinator entry, but its asynchronous release
      // callback is deliberately queued behind this lock. A subsequent warm must therefore
      // publish a new runtime before the old callback reaches the lifecycle map.
      await vi.advanceTimersByTimeAsync(1_000);
      const replacementWarm = await lifecycle.warmRuntimeForPack(manifest.packId);
      expect(replacementWarm.runtime).toBe(replacementRuntime);
      expect(warmedRuntimeIds).toEqual(['old', 'replacement']);

      releaseLifecycleLock.resolve();
      await heldLifecycleLock;

      const releasedByEviction = await Promise.race([
        oldReleaseStarted.promise.then(() => 'old' as const),
        replacementReleaseStarted.promise.then(() => 'replacement' as const),
      ]);
      expect(releasedByEviction).toBe('old');
      await expect(lifecycle.getModelsStatus([manifest.packId])).resolves.toEqual([
        expect.objectContaining({
          packId: manifest.packId,
          runtimeState: 'ready',
          loadedArtifactBytes: 4,
        }),
      ]);

      oldReleaseGate.resolve();
      const execution = createVoiceInferenceWorkerExecution({ lifecycle });
      const synthesized = await execution.synthesizeTts({
        requestId: 'replacement-runtime-inference',
        text: 'hello',
        packId: manifest.packId,
        voiceId: null,
        speed: null,
        output: { codec: 'wav', mimeType: 'audio/wav' },
      });
      await expect(readFile(synthesized.filePath, 'utf8')).resolves.toBe('replacement');
      expect(releasedRuntimeIds).toEqual(['old']);

      await lifecycle.stop();
      stopLifecycle = null;
      expect(releasedRuntimeIds).toEqual(['old', 'replacement']);
    } finally {
      oldReleaseGate.resolve();
      await stopLifecycle?.();
      vi.useRealTimers();
    }
  });

  it.each([1, 4])('projects only the selected plugin at speech admission with %i installed plugins', async (pluginCount) => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    for (let index = 1; index < pluginCount; index += 1) {
      await createInstalledPublicPack(homeDir, 'unrelated', undefined, `acme.unrelated-${index}`);
    }
    const { publicModelPacks, key } = await createInstalledPublicPack(homeDir, 'selected');
    const { manifest } = createZipformerCatalogManifest();
    await serveModelPackManifest(manifest);
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      publicModelPacks,
      runtimeLoader: async () => ({
        warmModel: async () => undefined,
        synthesizeTts: async () => { throw new Error('not exercised'); },
        transcribeAudio: async () => { throw new Error('not exercised'); },
      }),
    });
    const reads = vi.mocked(readFile);
    const pluginProjections = () => reads.mock.calls.filter(([path]) => (
      String(path).endsWith(join('.happier-plugin', 'plugin.json'))
    )).length;
    try {
      await lifecycle.installModel({ packId: ZIPFORMER_PACK_ID });
      for (let admission = 0; admission < 2; admission += 1) {
        reads.mockClear();
        await lifecycle.warmModelPack(ZIPFORMER_PACK_ID);
        expect.soft(pluginProjections(), 'built-in admission').toBe(0);
        reads.mockClear();
        await lifecycle.warmModelPack(key);
        expect.soft(pluginProjections(), 'plugin-pack admission').toBe(1);
      }
      // A real enablement change still reaches the next exact read.
      const { createPluginRegistryStateStore } = await import('@/plugins/store/registry/currentState');
      await createPluginRegistryStateStore({ happyHomeDir: homeDir, runtimeLifecycle: VOICE_MODEL_PACK_TEST_RUNTIME_LIFECYCLE })
        .setEnabled('acme.voice', false);
      await expect(publicModelPacks.resolve(key)).resolves.toMatchObject({ descriptor: { loadable: false } });
    } finally {
      await lifecycle.stop();
      reads.mockClear();
    }
  });

  it('verifies a public pack once per warm request without rereading its admitted manifest', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const host = createNodeInstalledModelPackIntegrityHost(resolveVoiceInferencePaths().packsRootDir);
    const fingerprinted: string[] = [];
    const { publicModelPacks, key } = await createInstalledPublicPack(homeDir, 'warm-read', async (packId, filePaths) => {
      fingerprinted.push(packId);
      return await host.fingerprint(packId, filePaths);
    });
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      publicModelPacks,
      runtimeLoader: async () => ({
        warmModel: async () => {},
        synthesizeTts: async () => { throw new Error('not exercised'); },
        transcribeAudio: async () => { throw new Error('not exercised'); },
      }),
    });
    try {
      for (let request = 0; request < 2; request += 1) {
        fingerprinted.length = 0;
        await lifecycle.warmModelPack(key);
        expect(fingerprinted).toHaveLength(1);
      }
      fingerprinted.length = 0;
      await lifecycle.stop();
      expect(fingerprinted).toHaveLength(0);
    } finally {
      await lifecycle.stop();
    }
  });

  it('retires a warmed public runtime when its owning plugin generation reloads', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { publicModelPacks, key, reload } = await createInstalledPublicPack(homeDir, 'english-small');
    let invalidate: ((changedPluginIds: readonly string[]) => void) | null = null;
    const releaseModel = vi.fn(async () => {});
    const listPublicEntries = vi.fn(() => publicModelPacks.list());
    const resolvePublicEntry = vi.fn((candidate: string) => publicModelPacks.resolve(candidate));
    const subscribeInvalidations = publicModelPacks.subscribeInvalidations!;
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      publicModelPacks: {
        ...publicModelPacks,
        list: listPublicEntries,
        resolve: resolvePublicEntry,
        // Observe the real subscription while retaining explicit control over reload timing.
        subscribeInvalidations: (listener) => {
          invalidate = listener;
          const unsubscribe = subscribeInvalidations(listener);
          return () => { invalidate = null; unsubscribe(); };
        },
      },
      runtimeLoader: async () => ({
        warmModel: async () => {},
        releaseModel,
        synthesizeTts: async () => { throw new Error('not exercised'); },
        transcribeAudio: async () => { throw new Error('not exercised'); },
      }),
    });

    await lifecycle.warmModelPack(key);
    listPublicEntries.mockClear();
    resolvePublicEntry.mockClear();
    await expect(lifecycle.getModelsStatus([key])).resolves.toEqual([
      expect.objectContaining({
        runtimeState: 'ready',
        voices: [
          { id: 'calm', title: 'Calm', sid: 4 },
          { id: 'bright', title: 'Bright', subtitle: 'English', sid: 7 },
        ],
        defaultVoiceId: 'bright',
      }),
    ]);
    expect(listPublicEntries).toHaveBeenCalledTimes(1);
    expect(resolvePublicEntry).not.toHaveBeenCalled();

    expect(invalidate).not.toBeNull();
    await reload();
    await vi.waitFor(() => expect(releaseModel).toHaveBeenCalledTimes(1));
    await expect(lifecycle.getModelsStatus([key])).resolves.toEqual([
      expect.objectContaining({ runtimeState: 'cold' }),
    ]);

    await lifecycle.warmModelPack(key);
    expect(releaseModel).toHaveBeenCalledTimes(1);
    await lifecycle.stop();
    expect(releaseModel).toHaveBeenCalledTimes(2);
  });

  it('rejects a public descriptor that resolves after its plugin was invalidated', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { publicModelPacks, key, reload } = await createInstalledPublicPack(homeDir, 'deferred');
    const deferredResolve = deferred<void>();
    const resolutionEntered = deferred<void>();
    const originalResolve = publicModelPacks.resolve;
    const resolve = vi.fn(async (candidate: string) => {
      const entry = await originalResolve(candidate);
      resolutionEntered.resolve();
      await deferredResolve.promise;
      return entry;
    });
    let invalidate: ((changedPluginIds: readonly string[]) => void) | null = null;
    const subscribeInvalidations = publicModelPacks.subscribeInvalidations!;
    const warmModel = vi.fn(async () => {});
    const runtimeLoader = vi.fn(async () => ({
      warmModel,
      releaseModel: vi.fn(async () => {}),
      synthesizeTts: async () => { throw new Error('not exercised'); },
      transcribeAudio: async () => { throw new Error('not exercised'); },
    }));
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      publicModelPacks: {
        ...publicModelPacks,
        resolve,
        subscribeInvalidations: (listener) => {
          invalidate = listener;
          const unsubscribe = subscribeInvalidations(listener);
          return () => { invalidate = null; unsubscribe(); };
        },
      },
      runtimeLoader,
    });

    const warming = lifecycle.warmModelPack(key);
    await resolutionEntered.promise;
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith(key));
    expect(invalidate).not.toBeNull();
    await reload();
    deferredResolve.resolve();

    await expect(warming).rejects.toMatchObject({
      code: 'runtime_unavailable',
      message: 'voice_inference_public_pack_generation_stale',
    });
    expect(runtimeLoader).not.toHaveBeenCalled();
    expect(warmModel).not.toHaveBeenCalled();
    await expect(lifecycle.getModelsStatus([key])).resolves.toEqual([
      expect.objectContaining({ packId: key, runtimeState: 'cold' }),
    ]);
    await lifecycle.stop();
  });

  it('aborts a public warm during daemon stop and rejects a late native success before readiness publication', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
    const { manifest } = createZipformerCatalogManifest();
    const packDir = join(resolveVoiceInferencePaths().packsRootDir, manifest.packId);
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'pack.json'), JSON.stringify(manifest), 'utf8');

    const warmStarted = deferred<void>();
    const allowIgnoredNativeWarmToReturn = deferred<void>();
    let observedWarmSignal: AbortSignal | null = null;
    let releaseCalls = 0;
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      runtimeLoader: async () => ({
        warmModel: async ({ signal }) => {
          observedWarmSignal = signal ?? null;
          warmStarted.resolve();
          await Promise.race([
            allowIgnoredNativeWarmToReturn.promise,
            new Promise<void>((resolve) => {
              if (signal?.aborted) {
                resolve();
                return;
              }
              signal?.addEventListener('abort', () => resolve(), { once: true });
            }),
          ]);
          // This deliberately reports normal completion after cancellation, like a synchronous
          // native call that only observes its signal after returning to JavaScript.
        },
        releaseModel: async () => {
          releaseCalls += 1;
        },
        synthesizeTts: async () => {
          throw new Error('not exercised');
        },
        transcribeAudio: async () => {
          throw new Error('not exercised');
        },
      }),
    });

    const warming = lifecycle.warmModelPack(manifest.packId);
    // Stop intentionally races the caller's await below. Attach a handler now so the expected
    // cancellation cannot be reported as unhandled between the stop and that assertion.
    void warming.catch(() => undefined);
    let stopPromise: Promise<void> | null = null;
    try {
      await warmStarted.promise;
      stopPromise = lifecycle.stop();

      await expect(Promise.race([
        stopPromise.then(() => 'stopped' as const),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
      ])).resolves.toBe('stopped');
      expect(observedWarmSignal).not.toBeNull();
      expect(observedWarmSignal!.aborted).toBe(true);
      await expect(warming).rejects.toMatchObject({ code: 'cancelled' });
      expect(releaseCalls).toBe(1);
      await expect(lifecycle.getStatus()).resolves.toMatchObject({
        models: [expect.objectContaining({ packId: manifest.packId, runtimeState: 'cold' })],
      });
    } finally {
      // Keep the valid RED cleanup bounded: before the stop signal reaches public warm, this
      // models the native call eventually returning so the test leaves no lifecycle lock behind.
      allowIgnoredNativeWarmToReturn.resolve();
      await warming.catch(() => undefined);
      await stopPromise?.catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  });

  it('aborts an in-flight model-pack install so stop does not wait behind the lifecycle lock', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { manifest } = createZipformerCatalogManifest();
    const installStarted = deferred<void>();
    const downloadClosed = deferred<void>();
    await serveModelPackManifest(manifest, (_request, response) => {
      response.once('close', () => downloadClosed.resolve());
      installStarted.resolve();
    });
    const lifecycle = createVoiceInferenceWorkerLifecycle();

    const installPromise = lifecycle.installModel({ packId: manifest.packId });
    // Attach rejection observation before Stop aborts the actual HTTP download.
    const rejectedInstall = expect(installPromise).rejects.toMatchObject({ name: 'ModelPackInstallError', message: 'aborted' });
    await installStarted.promise;

    const stopPromise = lifecycle.stop();
    await expect(Promise.race([
      stopPromise.then(() => 'stopped' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
    ])).resolves.toBe('stopped');

    await downloadClosed.promise;
    await rejectedInstall;
    const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
    await expect(readFile(join(resolveVoiceInferencePaths().packsRootDir, manifest.packId, 'pack.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await stopPromise;
  });
});
