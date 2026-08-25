import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getModelPackCatalogEntry, type ModelPackManifest } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

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
  const envKeys = ['HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  const tempDirs: string[] = [];

  async function createHomeDir(): Promise<string> {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-voice-inference-lifecycle-'));
    tempDirs.push(homeDir);
    return homeDir;
  }

  async function importLifecycleModuleForHome(homeDir: string) {
    process.env.HAPPIER_HOME_DIR = homeDir;
    const configurationModule = await import('@/configuration');
    configurationModule.reloadConfiguration();
    return await import('./voiceInferenceWorker.lifecycle');
  }

  afterEach(async () => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true }).catch(() => undefined)));
  });

  it('rejects unsupported runtime families before manifest download or install mutation', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const fetchManifest = vi.fn();
    const installModelPack = vi.fn();
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      installerOps: { fetchManifest, installModelPack },
    });

    await expect(lifecycle.installModel({
      packId: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    })).rejects.toMatchObject({ code: 'unsupported_runtime_family' });
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(installModelPack).not.toHaveBeenCalled();
    await expect(lifecycle.listModels()).resolves.toEqual([]);
    await lifecycle.stop();
  });

  it('admits the exact published Kokoro catalog pack through the normal manifest installer', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const manifest = createKokoroCatalogManifest();
    const fetchManifest = vi.fn(async () => manifest);
    const installModelPack = vi.fn(async (input: Readonly<{
      packsRootDir: string;
      manifest: ModelPackManifest;
    }>) => {
      const packDir = join(input.packsRootDir, input.manifest.packId);
      await mkdir(packDir, { recursive: true });
      await writeFile(join(packDir, 'pack.json'), JSON.stringify(input.manifest), 'utf8');
      return input.manifest;
    });
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      installerOps: { fetchManifest, installModelPack },
    });

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
    expect(fetchManifest).toHaveBeenCalledOnce();
    expect(installModelPack).toHaveBeenCalledOnce();
    expect(installModelPack).toHaveBeenCalledWith(expect.objectContaining({
      manifest,
    }));
    await lifecycle.stop();
  });

  it('cancels an in-flight model install when the caller aborts and never reports it installed', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const manifest = createKokoroCatalogManifest();
    const fetchManifest = vi.fn(async () => manifest);
    const caller = new AbortController();
    let observedSignal: AbortSignal | null = null;
    const installModelPack = vi.fn(async (input: Readonly<{
      packsRootDir: string;
      manifest: ModelPackManifest;
      signal?: AbortSignal | null;
    }>) => {
      observedSignal = input.signal ?? null;
      // A real install is a long download; the caller gives up midway.
      caller.abort(new Error('caller_cancelled'));
      await new Promise<void>((resolve, reject) => {
        if (input.signal?.aborted) {
          reject(input.signal.reason);
          return;
        }
        input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true });
        setTimeout(resolve, 5_000);
      });
      // Only reached if cancellation never arrived: this is the late publish.
      const packDir = join(input.packsRootDir, input.manifest.packId);
      await mkdir(packDir, { recursive: true });
      await writeFile(join(packDir, 'pack.json'), JSON.stringify(input.manifest), 'utf8');
      return input.manifest;
    });
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      installerOps: { fetchManifest, installModelPack },
    });

    await expect(lifecycle.installModel({
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      signal: caller.signal,
    })).rejects.toBeDefined();

    expect(observedSignal).not.toBeNull();
    expect((observedSignal as unknown as AbortSignal).aborted).toBe(true);
    await expect(lifecycle.getModelsStatus(['kokoro-82m-v1.0-onnx-q8-wasm'])).resolves.toEqual([
      expect.objectContaining({ installState: expect.not.stringMatching(/^installed$/) }),
    ]);
    await lifecycle.stop();
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
    const fetchManifest = vi.fn(async () => manifest);
    const installModelPack = vi.fn(async (input: Readonly<{
      packsRootDir: string;
      manifest: ModelPackManifest;
    }>) => {
      const packDir = join(input.packsRootDir, input.manifest.packId);
      await mkdir(packDir, { recursive: true });
      await writeFile(join(packDir, 'pack.json'), JSON.stringify(input.manifest), 'utf8');
      return input.manifest;
    });
    const warmModel = vi.fn(async () => undefined);
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      enforceCatalogRuntimeManifest: false,
      installerOps: { fetchManifest, installModelPack },
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

    await expect(lifecycle.installModel({
      packId: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    })).rejects.toMatchObject({ code: 'unsupported_runtime_family' });
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

    expect(fetchManifest).toHaveBeenCalledOnce();
    expect(installModelPack).toHaveBeenCalledOnce();
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
    const fetchManifest = vi.fn();
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      installerOps: { fetchManifest },
    });

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
    expect(fetchManifest).not.toHaveBeenCalled();
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
    const installModelPack = vi.fn();
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      installerOps: {
        fetchManifest: vi.fn(async () => manifest),
        installModelPack,
      },
    });

    await expect(lifecycle.installModel({ packId: ZIPFORMER_PACK_ID })).rejects.toMatchObject({
      code: 'internal_error',
      message: 'voice_inference_model_pack_manifest_incompatible',
    });
    expect(installModelPack).not.toHaveBeenCalled();
    await expect(lifecycle.listModels()).resolves.toEqual([]);
    await lifecycle.stop();
  });

  it('admits the canonical Zipformer manifest baseline before install mutation', async () => {
    const homeDir = await createHomeDir();
    const { createVoiceInferenceWorkerLifecycle } = await importLifecycleModuleForHome(homeDir);
    const { manifest } = createZipformerCatalogManifest();
    const installModelPack = vi.fn();
    const lifecycle = createVoiceInferenceWorkerLifecycle({
      installerOps: {
        fetchManifest: vi.fn(async () => manifest),
        installModelPack,
      },
    });

    await expect(lifecycle.installModel({ packId: ZIPFORMER_PACK_ID })).resolves.toMatchObject({
      packId: ZIPFORMER_PACK_ID,
      kind: manifest.kind,
      runtimeFamily: 'sherpa_zipformer_streaming',
      runtimeSupported: true,
    });
    expect(installModelPack).toHaveBeenCalledOnce();
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
    let installSignal: AbortSignal | null = null;
    let releaseInstallStart!: () => void;
    const installStarted = new Promise<void>((resolve) => {
      releaseInstallStart = resolve;
    });

    const lifecycle = createVoiceInferenceWorkerLifecycle({
      installerOps: {
        fetchManifest: async ({ signal }) => {
          expect(signal?.aborted).toBe(false);
          return manifest;
        },
        installModelPack: async ({ signal }) => {
          installSignal = signal ?? null;
          releaseInstallStart();
          return await new Promise<never>((_, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('install-aborted')), { once: true });
          });
        },
      },
    });

    const installPromise = lifecycle.installModel({ packId: manifest.packId });
    await installStarted;

    const stopPromise = lifecycle.stop();
    await expect(Promise.race([
      stopPromise.then(() => 'stopped' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
    ])).resolves.toBe('stopped');

    expect(installSignal).not.toBeNull();
    expect(installSignal!.aborted).toBe(true);
    await expect(installPromise).rejects.toThrow('install-aborted');
    await stopPromise;
  });
});
