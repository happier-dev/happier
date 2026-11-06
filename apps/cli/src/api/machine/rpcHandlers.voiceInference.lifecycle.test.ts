import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelPackManifestSchema } from '@happier-dev/protocol';
import { DaemonVoiceInferenceSttStreamStartRequestSchema, DaemonVoiceInferenceSttStreamStartResponseSchema, DaemonVoiceInferenceSttStreamCancelResponseSchema, DaemonVoiceInferenceSttStreamStatusResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { startVoiceInferenceWorker, type VoiceInferenceWorkerHandle } from '@/daemon/voiceInference/voiceInferenceWorker';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { resolveVoiceInferencePaths } from '@/daemon/voiceInference/voiceInferencePaths';
import type { VoiceInferenceRuntime } from '@/daemon/voiceInference/voiceInferenceRuntimeTypes';

import { registerMachineVoiceInferenceRpcHandlers } from './rpcHandlers.voiceInference';

import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { RpcHandler as Handler } from '../rpc/types';


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

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

const workers: VoiceInferenceWorkerHandle[] = [];
const registrations: Array<ReturnType<typeof registerMachineVoiceInferenceRpcHandlers>> = [];
const homes: string[] = [];
let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'voice-rpc-lifecycle-home-'));
  homes.push(home);
  process.env.HAPPIER_HOME_DIR = home;
  reloadConfiguration();
});

async function createWorker(bytes = Buffer.from('tts-audio'), streamingRuntime?: Pick<VoiceInferenceRuntime, 'createStreamingTranscriptionSession'>) {
  const packId = streamingRuntime ? 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17' : 'kokoro-82m-v1.0-onnx-q8-wasm';
  const packDir = join(resolveVoiceInferencePaths().packsRootDir, packId);
  mkdirSync(packDir, { recursive: true });
  const model = Buffer.from('native-model-fixture');
  const manifest = ModelPackManifestSchema.parse({
    packId, kind: streamingRuntime ? 'stt_sherpa' : 'tts_sherpa', model: streamingRuntime ? 'zipformer' : 'kokoro', version: '2026-02-15',
    files: [{
      path: 'model.onnx', url: 'https://example.test/model.onnx',
      sha256: createHash('sha256').update(model).digest('hex'), sizeBytes: model.byteLength,
    }],
  });
  writeFileSync(join(packDir, 'pack.json'), JSON.stringify(manifest));
  writeFileSync(join(packDir, 'model.onnx'), model);
  // Native model execution is the genuine external boundary. The worker owns
  // warmup, cancellation, output staging, and upload cleanup.
  const worker = await startVoiceInferenceWorker({
    runtimeLoader: async () => ({
      synthesizeTts: async ({ output }) => ({ bytes, output, name: 'tts.wav' }),
      transcribeAudio: async () => { throw new Error('unused native recognition'); },
      ...streamingRuntime,
    }),
  });
  workers.push(worker);
  return worker;
}

afterEach(async () => {
  await Promise.all(registrations.splice(0).map((registration) => registration.dispose()));
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  envScope.restore();
  envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  reloadConfiguration();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('registerMachineVoiceInferenceRpcHandlers transfer lifecycle', () => {
  it('cancels a pending JSON start and retires native preparation that completes after request abort', async () => {
    let finishPreparation!: () => void;
    const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
    let observePreparation!: () => void;
    const preparing = new Promise<void>(resolve => { observePreparation = resolve; });
    let nativeSignal: AbortSignal | null | undefined;
    const cancel = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const worker = await createWorker(undefined, {
      createStreamingTranscriptionSession: async input => {
        nativeSignal = input.signal;
        observePreparation();
        await preparation;
        return { appendPcm16: async () => ({ events: [] }),
          finish: async () => ({ text: '', language: 'en', events: [] }), cancel, close };
      },
    });
    const manager = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceRpcHandlers({ rpcHandlerManager: manager, voiceInferenceWorker: worker }));
    const abort = new AbortController();
    const request = DaemonVoiceInferenceSttStreamStartRequestSchema.parse({
      requestId: 'cancel-pending-json', packId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17', language: 'en', streamingMode: 'runtime',
    });
    const starting = manager.invokeLocal(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START, request, { signal: abort.signal });
    try {
      await preparing;
      abort.abort();
      expect(nativeSignal?.aborted).toBe(true);
    } finally {
      finishPreparation();
    }
    expect(DaemonVoiceInferenceSttStreamStartResponseSchema.parse(await starting)).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    const retryAbort = new AbortController();
    const retry = DaemonVoiceInferenceSttStreamStartResponseSchema.parse(await manager.invokeLocal(
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START, request, { signal: retryAbort.signal },
    ));
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error('Cancelled start retained request custody');
    retryAbort.abort();
    expect(DaemonVoiceInferenceSttStreamStatusResponseSchema.parse(await manager.invokeLocal(
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS, { streamId: retry.streamId, generation: retry.generation },
    ))).toMatchObject({ ok: true, state: 'open' });
    expect(DaemonVoiceInferenceSttStreamCancelResponseSchema.parse(await manager.invokeLocal(
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CANCEL, { streamId: retry.streamId, generation: retry.generation },
    ))).toMatchObject({ ok: true });
  });

  it('expires an abandoned STT upload without any later transfer traffic', async () => {
    vi.useFakeTimers();
    const worker = await createWorker();

    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    });
    registrations.push(registration);
    try {
      const sttUploadInit = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
      if (!sttUploadInit) {
        throw new Error('expected voice inference upload init handler');
      }
      const upload = await sttUploadInit({
        requestId: 'stt-abandoned',
        sizeBytes: 5,
        inputMimeType: 'audio/wav',
      });
      expect(upload).toMatchObject({ success: true, uploadId: expect.any(String) });
      const uploadStore = registration.voiceInferenceTransfers.uploadStore;
      const tempPath = uploadStore.getUploadSession(upload.uploadId)?.tempPath;
      expect(tempPath).toBeTypeOf('string');
      await expect(access(tempPath!)).resolves.toBeUndefined();

      // The client disappears right after init: no chunk, no finalize, no abort,
      // and no unrelated transfer traffic that could sweep on its behalf.
      await vi.advanceTimersByTimeAsync(configuration.filesTransferSessionTtlMs + 1_000);
      await uploadStore.settleClosures();

      expect(uploadStore.getUploadSession(upload.uploadId)).toBeNull();
      await expectPathMissing(tempPath!);
    } finally {
      await registration.dispose();
    }
  });

  it('disposes finalized STT uploads', async () => {
    vi.useFakeTimers();
    const workspace = mkdtempSync(join(tmpdir(), 'happier-voice-inference-lifecycle-'));
    const outputBytes = Buffer.from('tts-audio');

    try {
      const worker = await createWorker(outputBytes);

      const mgr = createRpcHandlerManager();
      const registration = registerMachineVoiceInferenceRpcHandlers({
        rpcHandlerManager: mgr,
        voiceInferenceWorker: worker,
      });
      registrations.push(registration);
      expect(registration).toBeTruthy();

      const sttUploadInit = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
      const sttUploadChunk = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK);
      const sttUploadFinalize = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE);
      const sttTranscribe = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE);
      const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
      const sttStreamStatus = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);
      if (!sttUploadInit || !sttUploadChunk || !sttUploadFinalize || !sttTranscribe || !sttStreamStart || !sttStreamStatus) {
        throw new Error('expected voice inference transfer handlers');
      }

      const stream = await sttStreamStart({
        requestId: 'stt-stream-lifecycle',
        packId: 'stt-pack-1',
        language: 'en',
        streamingMode: 'upload_bridge',
      });
      expect(stream).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0 });
      await expect(sttStreamStatus({
        streamId: stream.streamId,
        generation: stream.generation,
      })).resolves.toMatchObject({ ok: true, state: 'open' });

      const uploadPayload = Buffer.from('hello');
      const upload = await sttUploadInit({
        requestId: 'stt-lifecycle',
        sizeBytes: uploadPayload.length,
        inputMimeType: 'audio/wav',
      });
      expect(upload).toMatchObject({
        success: true,
        uploadId: expect.any(String),
        recipientPublicKeyBase64: expect.any(String),
      });
      await expect(sttUploadChunk(createEncryptedUploadChunkRequest({
        uploadId: upload.uploadId,
        index: 0,
        payload: uploadPayload,
        recipientPublicKeyBase64: upload.recipientPublicKeyBase64,
      }))).resolves.toEqual({ success: true });
      const finalized = await sttUploadFinalize({ uploadId: upload.uploadId });
      expect(finalized).toMatchObject({ success: true, path: expect.any(String) });
      const finalizedPath = join(resolveVoiceInferencePaths().tempDir, finalized.path);
      await expect(access(finalizedPath)).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);

      await registration.dispose();
      await registration.dispose();
      await worker.stop();

      expect(registration.voiceInferenceTransfers.uploadStore.getUploadSession(upload.uploadId)).toBeNull();
      await expectPathMissing(finalizedPath);
      expect(vi.getTimerCount()).toBe(0);
      await expect(sttTranscribe({
        requestId: 'stt-after-dispose',
        uploadId: upload.uploadId,
        packId: null,
        language: null,
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'invalid_audio_input',
      });
      await expect(sttUploadInit({
        requestId: 'stt-after-dispose',
        sizeBytes: 1,
        inputMimeType: 'audio/wav',
      })).rejects.toThrow('Transfer session store is disposed');
      await expect(sttStreamStatus({
        streamId: stream.streamId,
        generation: stream.generation,
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'stream_not_found',
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
