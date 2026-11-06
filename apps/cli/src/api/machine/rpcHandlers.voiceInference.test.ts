import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ingestPluginManifestV2, ModelPackManifestSchema } from '@happier-dev/protocol';
import type {
  DaemonVoiceInferenceModelLicenseAcceptRequest,
} from '@happier-dev/protocol';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { createNodeModelPackInstallerHost } from '@/daemon/voiceInference/nodeModelPackInstallerHost';
import { createDaemonPublicVoiceModelPackRuntime } from '@/daemon/voiceInference/publicModelPacks/runtime';
import { installVoiceModelPackPluginArchiveFixture } from '@/daemon/voiceInference/publicModelPacks/pluginArchiveFixture';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { materializeZipformerVoiceModelPackPluginFixture, ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID, ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID } from '@/plugins/testkit/voiceModelPackPackage';

import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { resolveVoiceInferencePaths } from '@/daemon/voiceInference/voiceInferencePaths';
import { startVoiceInferenceWorker, type VoiceInferenceWorkerHandle } from '@/daemon/voiceInference/voiceInferenceWorker';
import type { VoiceInferenceRuntime } from '@/daemon/voiceInference/voiceInferenceRuntimeTypes';
import { registerMachineVoiceInferenceRpcHandlers } from './rpcHandlers.voiceInference';
import { createDiagnosticsControllerWithRemovalFailure } from '../../daemon/voiceDiagnostics/controller.testkit';

import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { RpcHandler as Handler } from '../rpc/types';

afterAll(async () => { await pluginReloadController.shutdown(); });

// Faults are injected only at Node's filesystem boundary; every unstubbed
// operation keeps the real filesystem and all Voice/RPC owners remain real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs/promises')>();
  return { ...native, stat: vi.fn(native.stat), open: vi.fn(native.open) };
});


function createRpcHandlerManager(): RpcHandlerManager {
  return new RpcHandlerManager({
    scopePrefix: 'voice-inference-test',
    encryptionKey: new Uint8Array(32),
    encryptionVariant: 'legacy',
    encryptionMode: 'plain',
    logger: () => {},
  });
}

function getHandler(manager: RpcHandlerManager, method: string): Handler | undefined {
  if (!manager.hasHandler(method)) return undefined;
  return async (params, context) => await manager.invokeLocal(method, params, {
    signal: context?.signal,
  });
}

async function createLicensedPublicPack() {
  const archiveSourceRoot = mkdtempSync(join(tmpdir(), 'voice-rpc-license-'));
  diagnosticTestDirs.push(archiveSourceRoot);
  const packageRoot = join(archiveSourceRoot, 'package');
  await materializeZipformerVoiceModelPackPluginFixture(packageRoot);
  const manifestPath = join(packageRoot, '.happier-plugin', 'plugin.json');
  const ingested = ingestPluginManifestV2(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (!ingested.ok) throw new Error('invalid canonical Voice pack fixture');
  const contribution = ingested.manifest.contributes?.voiceModelPacks?.[0];
  if (!contribution) throw new Error('canonical Voice fixture lacks its pack');
  const assets = new Map<string, Uint8Array>();
  const files = contribution.manifest.files.map((file) => {
    const bytes = Buffer.from(`fixture:${file.path}`);
    const url = `https://github.com/happier-dev/happier-assets/releases/download/test/${file.path.split('/').map(encodeURIComponent).join('/')}`;
    assets.set(url, bytes);
    return { ...file, url, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength };
  });
  const pluginManifest = {
    ...ingested.manifest,
    engines: { happier: '>=0.2.0' },
    contributes: { ...ingested.manifest.contributes, voiceModelPacks: [{
      ...contribution,
      manifest: {
        ...contribution.manifest,
        runtime: { ...contribution.manifest.runtime, platforms: ['linux', 'darwin', 'win32'], architectures: ['x64', 'arm64'] },
        license: { ...contribution.manifest.license, requiresAcceptance: true, text: 'Exact RPC fixture model license terms.' },
        files,
      },
    }] },
  };
  const validated = ingestPluginManifestV2(pluginManifest);
  if (!validated.ok) throw new Error('invalid platform-complete Voice pack fixture');
  writeFileSync(manifestPath, JSON.stringify(validated.manifest));
  await installVoiceModelPackPluginArchiveFixture({
    happyHomeDir: configuration.happyHomeDir, archiveSourceRoot, packageRoot,
    archiveFileName: 'zipformer-plugin.tgz', interactionId: 'voice-rpc-license-install',
  });
  const runtime = await createAdmittedPluginRuntimeFixture({
    happyHomeDir: configuration.happyHomeDir,
    controller: pluginReloadController,
    runtimeOptions: { pluginIds: [ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID] },
  });
  runtimes.push(runtime);
  const publicModelPacks = createDaemonPublicVoiceModelPackRuntime({
    accountId: 'voice-rpc-account', machineId: 'voice-rpc-machine',
    happyHomeDir: configuration.happyHomeDir, paths: resolveVoiceInferencePaths(),
    createInstallerHost: ({ packsRootDir, urlPolicy }) => createNodeModelPackInstallerHost({
      packsRootDir, urlPolicy, resolveAddresses: async () => ['93.184.216.34'],
      pinnedTransport: async ({ url }) => {
        const bytes = assets.get(url);
        if (!bytes) throw new Error('unknown fixture model URL');
        let delivered = false;
        return {
          status: 200, headers: { 'content-length': String(bytes.byteLength) }, contentLength: bytes.byteLength,
          read: async () => { if (delivered) return null; delivered = true; return bytes; },
          cancel: () => {},
        };
      },
    }),
  });
  return {
    publicModelPacks,
    qualifiedPackId: `${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID}/${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID}`,
  };
}

function createWavPayload(pcm: Buffer): Buffer {
  const wav = Buffer.alloc(44 + pcm.byteLength);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.byteLength, 40);
  pcm.copy(wav, 44);
  return wav;
}

function createEncryptedUploadChunkRequest(input: Readonly<{
  uploadId: string;
  index: number;
  payload: Buffer;
  recipientPublicKeyBase64: string;
}>) {
  const encryptedChunk = createEncryptedTransferChunkEnvelope({
    transferId: input.uploadId,
    sequence: input.index,
    payload: input.payload,
    recipientPublicKeyBase64: input.recipientPublicKeyBase64,
  });

  return {
    uploadId: input.uploadId,
    index: input.index,
    payloadBase64: encryptedChunk.payloadBase64,
    encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
  };
}

const diagnosticTestDirs: string[] = [];

const workers: VoiceInferenceWorkerHandle[] = [];
const registrations: Array<ReturnType<typeof registerMachineVoiceInferenceRpcHandlers>> = [];
const runtimes: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>[] = [];
const ttsPackId = 'kokoro-82m-v1.0-onnx-q8-wasm';
const sttPackId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'voice-rpc-inference-home-'));
  diagnosticTestDirs.push(home);
  process.env.HAPPIER_HOME_DIR = home;
  reloadConfiguration();
  for (const [packId, kind, model] of [
    [ttsPackId, 'tts_sherpa', 'kokoro'], [sttPackId, 'stt_sherpa', 'zipformer'],
  ]) {
    const packDir = join(resolveVoiceInferencePaths().packsRootDir, packId);
    const bytes = Buffer.from('native-model-fixture');
    mkdirSync(packDir, { recursive: true });
    const manifest = ModelPackManifestSchema.parse({
      packId, kind, model, version: '2026-02-15',
      files: [{
        path: 'model.onnx', url: 'https://example.test/model.onnx',
        sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength,
      }],
    });
    writeFileSync(join(packDir, 'pack.json'), JSON.stringify(manifest));
    writeFileSync(join(packDir, 'model.onnx'), bytes);
  }
});

async function createWorker(runtime: Partial<VoiceInferenceRuntime> = {}, options: Pick<NonNullable<Parameters<typeof startVoiceInferenceWorker>[0]>, 'now' | 'publicModelPacks'> = {}) {
  const worker = await startVoiceInferenceWorker({
    ...options,
    runtimeLoader: async () => ({
      synthesizeTts: async () => { throw new Error('unused native synthesis'); },
      transcribeAudio: async () => { throw new Error('unused native recognition'); },
      ...runtime,
    }),
  });
  workers.push(worker);
  return worker;
}

afterEach(async () => {
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fsPromises.stat).mockImplementation(native.stat).mockClear();
  vi.mocked(fsPromises.open).mockImplementation(native.open).mockClear();
  await Promise.all(registrations.splice(0).map((registration) => registration.dispose()));
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  envScope.restore();
  envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  reloadConfiguration();
  for (const dir of diagnosticTestDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('registerMachineVoiceInferenceRpcHandlers', () => {
  it('registers status, model management, and STT upload/transcribe handlers', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-voice-inference-rpc-'));
    const outputBytes = Buffer.from('tts-audio');
    const outputPath = join(workspace, 'tts.wav');
    writeFileSync(outputPath, outputBytes);

    const { publicModelPacks, qualifiedPackId } = await createLicensedPublicPack();
    let observedUploadedAudioText: string | null = null;
    const transcribeAudio = vi.fn(async (input: Parameters<VoiceInferenceRuntime['transcribeAudio']>[0]) => {
      observedUploadedAudioText = readFileSync(input.filePath).subarray(44, 49).toString('utf8');
      return { text: 'hello daemon stt', language: input.language };
    });
    const worker = await createWorker({
      synthesizeTts: async ({ output }) => ({ bytes: outputBytes, output, name: 'tts.wav' }),
      transcribeAudio
    }, { publicModelPacks, now: () => 1 });
    await worker.warmModelPack(ttsPackId);
    const models = await worker.listModels();
    expect(models.map((model) => model.packId)).toEqual([qualifiedPackId, ttsPackId, sttPackId]);
    expect(models).toMatchObject([
      { packId: qualifiedPackId, installState: 'not_installed', licenseReview: { accepted: false } },
      { packId: ttsPackId, installState: 'installed' },
      { packId: sttPackId, installState: 'installed' },
    ]);
    const installModel = vi.spyOn(worker, 'installModel');
    const acceptModelPackLicense = vi.spyOn(worker, 'acceptModelPackLicense');
    const removeModel = vi.spyOn(worker, 'removeModel');
    const cancelStt = vi.spyOn(worker, 'cancelStt');
    const uploadedWav = createWavPayload(Buffer.from('hello\0'));

    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));

    const status = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS);
    const modelsList = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST);
    const modelsStatus = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS);
    const modelsInstall = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL);
    const modelsLicenseAccept = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LICENSE_ACCEPT);
    const modelsRemove = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_REMOVE);
    const sttUploadInit = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
    const sttUploadChunk = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK);
    const sttUploadFinalize = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE);
    const sttTranscribe = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE);
    const sttCancel = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_CANCEL);
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamChunk = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK);
    const sttStreamFinish = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH);
    const sttStreamCancel = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CANCEL);
    const sttStreamStatus = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);

    expect(status).toBeDefined();
    expect(modelsList).toBeDefined();
    expect(modelsStatus).toBeDefined();
    expect(modelsInstall).toBeDefined();
    expect(modelsLicenseAccept).toBeDefined();
    expect(modelsRemove).toBeDefined();
    expect(sttUploadInit).toBeDefined();
    expect(sttUploadChunk).toBeDefined();
    expect(sttUploadFinalize).toBeDefined();
    expect(sttTranscribe).toBeDefined();
    expect(sttCancel).toBeDefined();
    expect(sttStreamStart).toBeDefined();
    expect(sttStreamChunk).toBeDefined();
    expect(sttStreamFinish).toBeDefined();
    expect(sttStreamCancel).toBeDefined();
    expect(sttStreamStatus).toBeDefined();

    await expect(status?.({})).resolves.toEqual(expect.objectContaining({
      ok: true,
      serviceState: 'ready',
      models,
    }));
    await expect(modelsList?.({})).resolves.toEqual({ ok: true, models });
    await expect(modelsStatus?.({ packIds: [ttsPackId] })).resolves.toEqual({ ok: true, models: [models[1]] });

    const review = models[0]!.licenseReview!;
    const licenseBinding = {
      qualifiedPackId,
      pluginId: review.pluginId,
      packId: review.packId,
      pluginVersion: review.pluginVersion,
      packVersion: review.packVersion,
      licenseId: review.licenseId,
      licenseSourceUrl: review.licenseSourceUrl,
      licenseTextDigest: review.licenseTextDigest,
      artifactBinding: review.artifactBinding,
    } satisfies DaemonVoiceInferenceModelLicenseAcceptRequest;
    await expect(modelsLicenseAccept?.(licenseBinding)).resolves.toMatchObject({
      ok: true, model: { packId: qualifiedPackId, installState: 'not_installed', licenseReview: { accepted: true } },
    });
    expect(acceptModelPackLicense).toHaveBeenCalledWith(licenseBinding);
    await expect(modelsLicenseAccept?.({
      ...licenseBinding, artifactBinding: { kind: 'sourceIntegrity', integrity: '' },
    })).resolves.toMatchObject({ ok: false });
    const installRequest = new AbortController();
    await expect(modelsInstall?.({ packId: qualifiedPackId }, { signal: installRequest.signal }))
      .resolves.toMatchObject({ ok: true, model: { packId: qualifiedPackId, installState: 'installed' } });
    expect(installModel).toHaveBeenCalledWith({ packId: qualifiedPackId, signal: installRequest.signal });

    const uploadInitResp = await sttUploadInit?.({
      requestId: 'stt-1',
      sizeBytes: uploadedWav.byteLength,
      inputMimeType: 'audio/wav',
    });
    expect(uploadInitResp).toEqual({
      success: true,
      uploadId: expect.any(String),
      chunkSizeBytes: expect.any(Number),
      recipientPublicKeyBase64: expect.any(String),
    });

    await expect(sttUploadChunk?.(
      createEncryptedUploadChunkRequest({
        uploadId: uploadInitResp.uploadId,
        index: 0,
        payload: uploadedWav,
        recipientPublicKeyBase64: uploadInitResp.recipientPublicKeyBase64,
      }),
    )).resolves.toEqual({ success: true });

    const uploadFinalizeResp = await sttUploadFinalize?.({ uploadId: uploadInitResp.uploadId });
    expect(uploadFinalizeResp).toEqual({
      success: true,
      uploadId: uploadInitResp.uploadId,
      path: expect.any(String),
      sizeBytes: uploadedWav.byteLength,
      sha256: expect.any(String),
    });
    // `path` is relative to the daemon's voice inference temp dir (not an absolute host path) to avoid leaking PII.
    expect(isAbsolute(uploadFinalizeResp.path)).toBe(false);
    expect(uploadFinalizeResp.path.includes('..')).toBe(false);

    await expect(sttTranscribe?.({
      requestId: 'stt-1',
      uploadId: uploadInitResp.uploadId,
      packId: sttPackId,
      language: 'en',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
    })).resolves.toEqual({
      ok: true,
      requestId: 'stt-1',
      text: 'hello daemon stt',
      language: 'en',
      modelPackId: sttPackId,
    });
    expect(transcribeAudio).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'stt-1',
      inputMimeType: 'audio/wav',
      language: 'en',
    }));

	    const transcribeCall = transcribeAudio.mock.calls[0]?.[0];
	    expect(typeof transcribeCall?.filePath).toBe('string');
	    const transcribeFilePath = String(transcribeCall?.filePath ?? '');
	    expect(observedUploadedAudioText).toBe('hello');

    const { resolveVoiceInferencePaths } = await import('@/daemon/voiceInference/voiceInferencePaths');
    const { tempDir } = resolveVoiceInferencePaths();
    const finalizedUploadFilePath = join(tempDir, uploadFinalizeResp.path);
    expect(transcribeFilePath).toBe(finalizedUploadFilePath);
	    const relToTemp = relative(tempDir, transcribeFilePath);
	    expect(relToTemp).not.toBe('');
	    expect(relToTemp.startsWith('..')).toBe(false);

	    // Privacy hardening: the daemon should not retain user audio uploads after transcription completes.
	    expect(existsSync(transcribeFilePath)).toBe(false);

    await expect(sttCancel?.({ requestId: 'stt-1' })).resolves.toEqual({ ok: true });
    expect(cancelStt).toHaveBeenCalledWith('stt-1');

    const streamStartResp = await sttStreamStart?.({
      requestId: 'stt-stream-1',
      packId: sttPackId,
      language: 'en',
      streamingMode: 'upload_bridge',
    });
    expect(streamStartResp).toEqual(expect.objectContaining({
      ok: true,
      requestId: 'stt-stream-1',
      streamId: expect.any(String),
      generation: 0,
      ackSeq: -1,
    }));
    await expect(sttStreamChunk?.({
      streamId: streamStartResp.streamId,
      generation: streamStartResp.generation,
      seq: 0,
      pcm16Base64: Buffer.from([0, 0, 1, 0]).toString('base64'),
    })).resolves.toEqual({
      ok: true,
      streamId: streamStartResp.streamId,
      generation: streamStartResp.generation,
      ackSeq: 0,
      events: [],
    });
    await expect(sttStreamStatus?.({
      streamId: streamStartResp.streamId,
      generation: streamStartResp.generation,
    })).resolves.toEqual({
      ok: true,
      streamId: streamStartResp.streamId,
      generation: streamStartResp.generation,
      ackSeq: 0,
      state: 'open',
    });
    await expect(sttStreamCancel?.({
      streamId: streamStartResp.streamId,
      generation: streamStartResp.generation,
    })).resolves.toEqual({
      ok: true,
      streamId: streamStartResp.streamId,
      generation: streamStartResp.generation,
    });
    expect(cancelStt).toHaveBeenCalledWith('stt-stream-1');
    await expect(modelsRemove?.({ packId: qualifiedPackId })).resolves.toEqual({ ok: true });
    expect(removeModel).toHaveBeenCalledWith(qualifiedPackId);
    await expect(worker.getModelsStatus([qualifiedPackId])).resolves.toMatchObject([{ installState: 'not_installed' }]);
  });

  it('rejects STT transcribe payloads with undeclared fields at the RPC boundary', async () => {
    const transcribeAudio = vi.fn(async () => ({
      requestId: 'stt-1',
      text: 'hello daemon stt',
      language: 'en',
      modelPackId: sttPackId,
    }));

    const worker = await createWorker({
      transcribeAudio });

    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));

    const sttUploadInit = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
    const sttUploadChunk = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK);
    const sttUploadFinalize = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE);
    const sttTranscribe = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE);

    const uploadInitResp = await sttUploadInit?.({
      requestId: 'stt-1',
      sizeBytes: 5,
      inputMimeType: 'audio/wav',
    });
    expect(uploadInitResp).toEqual({
      success: true,
      uploadId: expect.any(String),
      chunkSizeBytes: expect.any(Number),
      recipientPublicKeyBase64: expect.any(String),
    });

    await expect(sttUploadChunk?.(
      createEncryptedUploadChunkRequest({
        uploadId: uploadInitResp.uploadId,
        index: 0,
        payload: Buffer.from('hello'),
        recipientPublicKeyBase64: uploadInitResp.recipientPublicKeyBase64,
      }),
    )).resolves.toEqual({ success: true });

    await expect(sttUploadFinalize?.({ uploadId: uploadInitResp.uploadId })).resolves.toMatchObject({
      success: true,
      uploadId: uploadInitResp.uploadId,
      path: expect.any(String),
    });

    await expect(sttTranscribe?.({
      requestId: 'stt-1',
      uploadId: uploadInitResp.uploadId,
      packId: sttPackId,
      language: 'en',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
      // Undeclared field: should be rejected by strict protocol schema.
      inputMimeType: 'audio/wav',
    })).resolves.toMatchObject({
      ok: false,
    });
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('persists uploaded STT diagnostics only after transcription succeeds', async () => {
    const diagnosticsHome = mkdtempSync(join(tmpdir(), 'happier-voice-diagnostics-rpc-'));
    diagnosticTestDirs.push(diagnosticsHome);
    const { controller, recoverRemoval } = await createDiagnosticsControllerWithRemovalFailure({
      happyHomeDir: diagnosticsHome,
    });
    const captureFile = vi.spyOn(controller, 'captureFile');
    const transcribeAudio = vi.fn(async (input: Readonly<{ requestId: string; filePath: string }>) => {
      if (input.requestId === 'stt-failure') throw new Error('transcription_failed');
      return { requestId: input.requestId, text: 'ok', language: 'en', modelPackId: sttPackId };
    });
    const worker = await createWorker({
      transcribeAudio });
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
      voiceDiagnostics: controller,
    });
    registrations.push(registration);
    const init = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT)!;
    const chunk = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK)!;
    const finalize = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE)!;
    const transcribe = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE)!;

    const diagnosticAudio = createWavPayload(Buffer.from('data'));
    const upload = async (requestId: string) => {
      const started = await init({ requestId, sizeBytes: diagnosticAudio.byteLength, inputMimeType: 'audio/wav' });
      await chunk(createEncryptedUploadChunkRequest({
        uploadId: started.uploadId,
        index: 0,
        payload: diagnosticAudio,
        recipientPublicKeyBase64: started.recipientPublicKeyBase64,
      }));
      await finalize({ uploadId: started.uploadId });
      return started.uploadId as string;
    };

    const failedUploadId = await upload('stt-failure');
    await expect(transcribe({
      requestId: 'stt-failure', uploadId: failedUploadId, packId: sttPackId, language: 'en',
      normalization: { inputTransport: 'upload_transfer', strategy: 'daemon_decode', systemFfmpegAllowed: false },
      diagnostics: { sessionId: 'session-1', captureAllowed: true, durationMs: null, authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637' },
    })).resolves.toMatchObject({ ok: false });
    expect(captureFile).not.toHaveBeenCalled();

    const successfulUploadId = await upload('stt-success');
    await expect(transcribe({
      requestId: 'stt-success', uploadId: successfulUploadId, packId: sttPackId, language: 'en',
      normalization: { inputTransport: 'upload_transfer', strategy: 'daemon_decode', systemFfmpegAllowed: false },
      diagnostics: { sessionId: 'session-1', captureAllowed: true, durationMs: null, authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637' },
    })).resolves.toMatchObject({ ok: true, text: 'ok' });
    expect(captureFile).toHaveBeenCalledTimes(1);
    expect(transcribeAudio.mock.invocationCallOrder[1]).toBeLessThan(captureFile.mock.invocationCallOrder[0]!);
    await expect(controller.status()).resolves.toMatchObject({
        health: {
          captureFailure: false,
          cleanup: { status: 'required', code: 'cleanup_failed', ownedEntryCount: 1 },
        },
    });
    recoverRemoval();
    await controller.deleteAll();
    await expect(controller.status()).resolves.toMatchObject({
      health: { captureFailure: false, cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 } },
    });
    await registration.dispose();
  });

  it('deduplicates warm RPC pack ids and returns refreshed model status from the worker', async () => {
    const warmCalls: string[] = [];
    const warmSignals: AbortSignal[] = [];
    const worker = await createWorker({
      warmModel: async ({ packId, signal }) => {
        warmCalls.push(packId);
        warmSignals.push(signal!);
      }
    });
    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));

    const warm = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM);
    expect(warm).toBeDefined();

    const requestLifetime = new AbortController();
    await expect(warm?.({
      packIds: ['kokoro-82m-v1.0-onnx-q8-wasm', sttPackId, 'kokoro-82m-v1.0-onnx-q8-wasm'],
    }, { signal: requestLifetime.signal })).resolves.toMatchObject({
      ok: true,
      models: [
        { packId: ttsPackId, installState: 'installed', runtimeState: 'ready' },
        { packId: sttPackId, installState: 'installed', runtimeState: 'ready' },
      ],
    });
    expect(warmCalls).toEqual(['kokoro-82m-v1.0-onnx-q8-wasm', sttPackId]);
    expect(warmSignals).toHaveLength(2);
    expect(warmSignals.every((signal) => !signal.aborted)).toBe(true);
    requestLifetime.abort();
    expect(warmSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it('rejects STT upload init requests that exceed the configured max upload size', async () => {
    const previousMaxUploadBytes = process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES;
    process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES = '4';
    try {
      const worker = await createWorker();

      const mgr = createRpcHandlerManager();
      registrations.push(registerMachineVoiceInferenceRpcHandlers({
        rpcHandlerManager: mgr,
        voiceInferenceWorker: worker,
      }));

      const sttUploadInit = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
      await expect(sttUploadInit?.({
        requestId: 'stt-oversize',
        sizeBytes: 5,
        inputMimeType: 'audio/wav',
      })).resolves.toEqual({
        success: false,
        error: expect.stringContaining('size'),
        errorCode: expect.any(String),
      });
    } finally {
      if (previousMaxUploadBytes === undefined) {
        delete process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES;
      } else {
        process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES = previousMaxUploadBytes;
      }
    }
  });

  it('rejects STT upload init requests with unsupported input mime types', async () => {
    const worker = await createWorker({
      transcribeAudio: async () => ({
        requestId: 'unused',
        text: 'unused',
        language: null,
        modelPackId: null,
      }) });

    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));

    const sttUploadInit = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
    await expect(sttUploadInit?.({
      requestId: 'stt-unsupported-mime',
      sizeBytes: 1,
      inputMimeType: 'text/plain',
    })).resolves.toEqual({
      success: false,
      error: expect.any(String),
      errorCode: 'invalid_audio_input',
    });

    await expect(sttUploadInit?.({
      requestId: 'stt-octet-stream',
      sizeBytes: 1,
      inputMimeType: 'application/octet-stream',
    })).resolves.toEqual({
      success: false,
      error: expect.any(String),
      errorCode: 'invalid_audio_input',
    });
  });

  it('expires finalized STT uploads and deletes their temp files after the transfer TTL', async () => {
    vi.useFakeTimers();
    const mgr = createRpcHandlerManager();
    const worker = await createWorker({
      transcribeAudio: async () => ({
        requestId: 'unused',
        text: 'unused',
        language: null,
        modelPackId: null,
      }) });

    registrations.push(registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));

    const sttUploadInit = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
    const sttUploadChunk = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK);
    const sttUploadFinalize = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE);
    const sttTranscribe = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE);

    const uploadInitResp = await sttUploadInit?.({
      requestId: 'stt-expire',
      sizeBytes: 5,
      inputMimeType: 'audio/wav',
    });
    expect(uploadInitResp).toEqual({
      success: true,
      uploadId: expect.any(String),
      chunkSizeBytes: expect.any(Number),
      recipientPublicKeyBase64: expect.any(String),
    });

    await expect(sttUploadChunk?.(
      createEncryptedUploadChunkRequest({
        uploadId: uploadInitResp.uploadId,
        index: 0,
        payload: Buffer.from('hello'),
        recipientPublicKeyBase64: uploadInitResp.recipientPublicKeyBase64,
      }),
    )).resolves.toEqual({ success: true });

	    const uploadFinalizeResp = await sttUploadFinalize?.({ uploadId: uploadInitResp.uploadId });
	    expect(uploadFinalizeResp).toEqual({
	      success: true,
	      uploadId: uploadInitResp.uploadId,
	      path: expect.any(String),
	      sizeBytes: 5,
	      sha256: expect.any(String),
	    });
	    expect(isAbsolute(uploadFinalizeResp.path)).toBe(false);
	    expect(uploadFinalizeResp.path.includes('..')).toBe(false);
	    const { resolveVoiceInferencePaths } = await import('@/daemon/voiceInference/voiceInferencePaths');
	    const { tempDir } = resolveVoiceInferencePaths();
	    const finalizedUploadFilePath = join(tempDir, uploadFinalizeResp.path);
	    expect(readFileSync(finalizedUploadFilePath, 'utf8')).toBe('hello');

	    await vi.advanceTimersByTimeAsync(10 * 60_000);
	    await vi.runOnlyPendingTimersAsync();
	    await Promise.resolve();
	    // The expiry callback deletes asynchronously; give it a couple ticks to settle.
	    let exists = true;
	    for (let i = 0; i < 5; i += 1) {
	      try {
	        await access(finalizedUploadFilePath);
	        await vi.advanceTimersByTimeAsync(1);
	        await Promise.resolve();
	      } catch {
	        exists = false;
	        break;
	      }
	    }
	    expect(exists).toBe(false);

    await expect(sttTranscribe?.({
      requestId: 'stt-expire',
      uploadId: uploadInitResp.uploadId,
      packId: sttPackId,
      language: 'en',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_audio_input',
      error: expect.any(String),
    });

    vi.useRealTimers();
  });

  it('uses the finalized upload MIME type as the STT source of truth', async () => {
    const transcribeAudio = vi.fn(async (input: Readonly<{ requestId: string; inputMimeType: string; filePath: string }>) => ({
      text: `mime:${input.inputMimeType}`,
      language: 'en',
    }));

    const worker = await createWorker({
      transcribeAudio });

    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));

    const sttUploadInit = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
    const sttUploadChunk = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK);
    const sttUploadFinalize = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE);
    const sttTranscribe = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE);

    const uploadInitResp = await sttUploadInit?.({
      requestId: 'stt-source-of-truth',
      sizeBytes: 5,
      inputMimeType: 'audio/webm',
    });

    await expect(sttUploadChunk?.(
      createEncryptedUploadChunkRequest({
        uploadId: uploadInitResp.uploadId,
        index: 0,
        payload: Buffer.from('hello'),
        recipientPublicKeyBase64: uploadInitResp.recipientPublicKeyBase64,
      }),
    )).resolves.toEqual({ success: true });

    await expect(sttUploadFinalize?.({ uploadId: uploadInitResp.uploadId })).resolves.toEqual({
      success: true,
      uploadId: uploadInitResp.uploadId,
      path: expect.any(String),
      sizeBytes: 5,
      sha256: expect.any(String),
    });

	    await expect(sttTranscribe?.({
	      requestId: 'stt-source-of-truth',
	      uploadId: uploadInitResp.uploadId,
	      packId: sttPackId,
	      language: 'en',
	      normalization: {
	        inputTransport: 'upload_transfer',
	        strategy: 'daemon_decode',
	        systemFfmpegAllowed: false,
	      },
	    })).resolves.toEqual({
      ok: true,
      requestId: 'stt-source-of-truth',
      text: 'mime:audio/webm',
      language: 'en',
      modelPackId: sttPackId,
    });

    expect(transcribeAudio).toHaveBeenCalledWith(expect.objectContaining({
      inputMimeType: 'audio/webm',
    }));
  });

  it('cleans up finalized STT uploads after transcribe failures', async () => {
    const transcribeAudio = vi.fn(async () => {
      throw Object.assign(new Error('decode failed'), { code: 'unsupported_codec' });
    });

    const worker = await createWorker({
      transcribeAudio });

    const uploadedWav = createWavPayload(Buffer.from('hello\0'));
    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));

    const sttUploadInit = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
    const sttUploadChunk = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK);
    const sttUploadFinalize = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE);
    const sttTranscribe = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE);

    const uploadInitResp = await sttUploadInit?.({
      requestId: 'stt-failed-upload',
      sizeBytes: uploadedWav.byteLength,
      inputMimeType: 'audio/wav',
    });

    await expect(sttUploadChunk?.(
      createEncryptedUploadChunkRequest({
        uploadId: uploadInitResp.uploadId,
        index: 0,
        payload: uploadedWav,
        recipientPublicKeyBase64: uploadInitResp.recipientPublicKeyBase64,
      }),
    )).resolves.toEqual({ success: true });

    await expect(sttUploadFinalize?.({ uploadId: uploadInitResp.uploadId })).resolves.toEqual({
      success: true,
      uploadId: uploadInitResp.uploadId,
      path: expect.any(String),
      sizeBytes: uploadedWav.byteLength,
      sha256: expect.any(String),
    });

	    await expect(sttTranscribe?.({
	      requestId: 'stt-first-failure',
	      uploadId: uploadInitResp.uploadId,
	      packId: sttPackId,
	      language: 'en',
	      normalization: {
	        inputTransport: 'upload_transfer',
	        strategy: 'daemon_decode',
	        systemFfmpegAllowed: false,
	      },
	    })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_codec',
      error: expect.any(String),
    });

	    await expect(sttTranscribe?.({
	      requestId: 'stt-second-failure',
	      uploadId: uploadInitResp.uploadId,
	      packId: sttPackId,
	      language: 'en',
	      normalization: {
	        inputTransport: 'upload_transfer',
	        strategy: 'daemon_decode',
	        systemFfmpegAllowed: false,
	      },
	    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_audio_input',
      error: expect.any(String),
    });

    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: 'runtime_unavailable', error: 'voice_inference_runtime_unavailable' },
    { code: 'internal_error', error: 'voice_inference_internal_error' },
  ])('redacts internal daemon/runtime details from RPC error payloads ($code)', async ({ code, error }) => {
    const worker = await createWorker({ warmModel: async () => {
        throw Object.assign(new Error('voice_inference_daemon_decoder_spawn_failed:/Users/leeroy/private/input.m4a stderr=/tmp/runtime.log'), { code });
      } });

    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));

    const warm = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM);

    await expect(warm?.({ packIds: [ttsPackId] })).resolves.toEqual({
      ok: false,
      errorCode: code,
      error,
    });
  });


  it('fails closed when a worker returns an invalid model-status success payload', async () => {
    const worker = await createWorker();
    const nativeStat = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).stat;
    let corruptedTimestampObserved = false;
    // The real OS-stat adapter is the boundary; status projection remains real.
    vi.mocked(fsPromises.stat).mockImplementationOnce(async (path) => {
      corruptedTimestampObserved = true;
      return Object.assign(await nativeStat(path), { mtimeMs: Number.NaN });
    });

    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));

    const modelsStatus = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS);

    await expect(modelsStatus?.({ packIds: [ttsPackId] })).resolves.toEqual({
      ok: false,
      errorCode: 'internal_error',
      error: expect.any(String),
    });
    expect(corruptedTimestampObserved).toBe(true);
  });
});
