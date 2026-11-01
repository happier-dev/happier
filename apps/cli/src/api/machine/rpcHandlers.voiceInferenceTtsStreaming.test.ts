import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonVoiceInferenceTtsStreamNextResponseSchema, type DaemonVoiceInferenceTtsStreamEvent, ModelPackManifestSchema, VoiceSpeechDiagnosticsSettingsV1Schema } from '@happier-dev/protocol';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineVoiceInferenceTtsStreamingRpcHandlers } from './rpcHandlers.voiceInferenceTtsStreaming';
import { createDiagnosticsControllerWithRemovalFailure } from '../../daemon/voiceDiagnostics/controller.testkit';
import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { resolveVoiceInferencePaths } from '@/daemon/voiceInference/voiceInferencePaths';
import { startVoiceInferenceWorker, type VoiceInferenceWorkerHandle } from '@/daemon/voiceInference/voiceInferenceWorker';
import type { VoiceInferenceRuntime } from '@/daemon/voiceInference/voiceInferenceRuntimeTypes';
import { createVoiceDiagnosticsController } from '@/daemon/voiceDiagnostics/controller';

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

describe('registerMachineVoiceInferenceTtsStreamingRpcHandlers', () => {
  const tempDirs: string[] = [];
  const workers: VoiceInferenceWorkerHandle[] = [];
  const registrations: Array<ReturnType<typeof registerMachineVoiceInferenceTtsStreamingRpcHandlers>> = [];
  const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

  beforeEach(async () => {
    process.env.HAPPIER_HOME_DIR = await createTempDir();
    reloadConfiguration();
    const packDir = join(resolveVoiceInferencePaths().packsRootDir, packId);
    const bytes = Buffer.from('native-tts-model-fixture');
    await mkdir(packDir, { recursive: true });
    const manifest = ModelPackManifestSchema.parse({
      packId, kind: 'tts_sherpa', model: 'kokoro', version: '2026-02-15',
      files: [{
        path: 'model.onnx', url: 'https://example.test/model.onnx',
        sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength,
      }],
    });
    await writeFile(join(packDir, 'pack.json'), JSON.stringify(manifest));
    await writeFile(join(packDir, 'model.onnx'), bytes);
  });

  async function createWorker(synthesizeTts: VoiceInferenceRuntime['synthesizeTts']) {
    // Native speech is outside the host process's deterministic logic.
    const worker = await startVoiceInferenceWorker({
      runtimeLoader: async () => ({
        synthesizeTts,
        transcribeAudio: async () => { throw new Error('unused native recognition'); },
      }),
    });
    workers.push(worker);
    return worker;
  }

  async function createDiagnostics() {
    const diagnostics = createVoiceDiagnosticsController({ happyHomeDir: configuration.happyHomeDir });
    await diagnostics.configure(VoiceSpeechDiagnosticsSettingsV1Schema.parse({
      enabled: true, consentVersion: 1, captureTtsOutput: true,
    }));
    return diagnostics;
  }

  afterEach(async () => {
    await Promise.all(registrations.splice(0).map((registration) => registration.dispose()));
    await Promise.all(workers.splice(0).map((worker) => worker.stop()));
    vi.restoreAllMocks();
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    reloadConfiguration();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happier-tts-stream-handler-'));
    tempDirs.push(dir);
    return dir;
  }

  it('registers segmented TTS start/next/ack/cancel handlers and preserves per-segment synthesis', async () => {
    const root = await createTempDir();
    let segmentCounter = 0;
    const synthesizeTts: VoiceInferenceRuntime['synthesizeTts'] = async (input) => {
      const segmentIndex = segmentCounter++;
      return {
        bytes: Buffer.from(`audio-${segmentIndex}`),
        output: input.output,
        name: `segment-${segmentIndex}.wav`,
      };
    };
    const mgr = createRpcHandlerManager();
    const diagnostics = await createDiagnostics();
    const captureFile = vi.spyOn(diagnostics, 'captureFile');
    const registration = registerMachineVoiceInferenceTtsStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: await createWorker(synthesizeTts),
      streamRoot: root,
      voiceDiagnostics: diagnostics,
    });
    registrations.push(registration);

    const start = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_START);
    const next = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT);
    const ack = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_ACK);
    const cancel = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_CANCEL);
    expect(start).toBeTypeOf('function');
    expect(next).toBeTypeOf('function');
    expect(ack).toBeTypeOf('function');
    expect(cancel).toBeTypeOf('function');

    const started = await start?.({
      requestId: 'tts-handler-1',
      text: 'First sentence. Second sentence.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
      prefetchDepth: 1,
      diagnostics: { sessionId: 'session-1', captureAllowed: true, durationMs: null, authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637' },
    });
    expect(started).toMatchObject({ ok: true, segmentCount: 2 });

    const segment = await next?.({
      streamId: started.streamId,
      generation: started.generation,
    });
    expect(segment).toMatchObject({
      ok: true,
      event: {
        type: 'segment',
        segmentIndex: 0,
        audio: { contentBase64: Buffer.from('audio-0').toString('base64') },
      },
    });
    expect(captureFile).not.toHaveBeenCalled();
    await expect(ack?.({
      streamId: started.streamId,
      generation: started.generation,
      segmentId: segment.event.segmentId,
      segmentIndex: 0,
    })).resolves.toMatchObject({ ok: true, ackedSegmentIndex: 0 });

    await expect(registration.dispose()).resolves.toBeUndefined();
    await expect(cancel?.({
      streamId: started.streamId,
      generation: started.generation,
      reason: 'client_dispose',
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
  });

  it('stages segmented TTS diagnostics on disk instead of retaining the utterance in memory', async () => {
    const root = await createTempDir();
    const synthesizeTts: VoiceInferenceRuntime['synthesizeTts'] = async (input) => ({
      bytes: Buffer.from(`audio:${input.text}`),
      output: input.output,
      name: 'segment.wav',
    });
    const mgr = createRpcHandlerManager();
    const diagnostics = await createDiagnostics();
    const captureFile = vi.spyOn(diagnostics, 'captureFile');
    const registration = registerMachineVoiceInferenceTtsStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: await createWorker(synthesizeTts),
      streamRoot: root,
      voiceDiagnostics: diagnostics,
    });
    registrations.push(registration);
    const start = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_START)!;
    const next = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT)!;
    const ack = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_ACK)!;
    const cancel = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_CANCEL)!;
    const stagingRoot = join(root, 'diagnostics');

    const started = await start({
      requestId: 'tts-staged', text: 'First sentence. Second sentence. Third sentence.',
      packId, voiceId: null, speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' }, prefetchDepth: 1,
      diagnostics: { sessionId: 'session-1', captureAllowed: true, durationMs: null, authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637' },
    });

    const delivered: Array<Extract<DaemonVoiceInferenceTtsStreamEvent, { type: 'segment' }>> = [];
    for (let index = 0; index < 3; index += 1) {
      const response = DaemonVoiceInferenceTtsStreamNextResponseSchema.parse(
        await next({ streamId: started.streamId, generation: started.generation }),
      );
      if (!response.ok || response.event.type !== 'segment') throw new Error('expected synthesized segment');
      delivered.push(response.event);
    }
    expect(delivered.map((event) => event.type)).toEqual(['segment', 'segment', 'segment']);

    // Every delivered segment is already on disk before the utterance completes:
    // the handler must not be holding three audio Buffers.
    await vi.waitFor(async () => {
      expect(await readdir(join(stagingRoot, started.streamId))).toHaveLength(3);
    });
    expect(captureFile).not.toHaveBeenCalled();

    for (const event of delivered) {
      await ack({
        streamId: started.streamId,
        generation: started.generation,
        segmentId: event.segmentId,
        segmentIndex: event.segmentIndex,
      });
    }
    await vi.waitFor(() => expect(captureFile).toHaveBeenCalledTimes(3));
    expect(captureFile.mock.calls.every(([input]) => input.filePath.startsWith(join(stagingRoot, started.streamId)))).toBe(true);
    const capturedBytes = await Promise.all((await diagnostics.status()).artifacts.map(async (artifact) => {
      const stored = await diagnostics.resolveArtifactForExport(artifact.id);
      return await readFile(stored!.audioPath, 'utf8');
    }));
    expect(capturedBytes.sort()).toEqual([
      'audio:First sentence.', 'audio:Second sentence.', 'audio:Third sentence.',
    ]);
    // Staging is deleted once retention owns the bytes.
    await vi.waitFor(async () => {
      expect(await readdir(stagingRoot)).toEqual([]);
    });

    // A cancelled stream deletes its staging without capturing anything.
    captureFile.mockClear();
    const cancelled = await start({
      requestId: 'tts-staged-cancel', text: 'Alpha. Beta.', packId, voiceId: null, speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' }, prefetchDepth: 1,
      diagnostics: { sessionId: 'session-1', captureAllowed: true, durationMs: null, authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637' },
    });
    await next({ streamId: cancelled.streamId, generation: cancelled.generation });
    await vi.waitFor(async () => {
      expect(await readdir(join(stagingRoot, cancelled.streamId))).toHaveLength(1);
    });
    await cancel({ streamId: cancelled.streamId, generation: cancelled.generation, reason: 'client_abort' });
    await vi.waitFor(async () => {
      expect(await readdir(stagingRoot)).toEqual([]);
    });
    expect(captureFile).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it('discards staged diagnostics when the manager retires an abandoned stream', async () => {
    const root = await createTempDir();
    const synthesizeTts: VoiceInferenceRuntime['synthesizeTts'] = async (input) => ({
      bytes: Buffer.from(`audio:${input.text}`),
      output: input.output,
      name: 'segment.wav',
    });
    const mgr = createRpcHandlerManager();
    const diagnostics = await createDiagnostics();
    const captureFile = vi.spyOn(diagnostics, 'captureFile');
    const registration = registerMachineVoiceInferenceTtsStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: await createWorker(synthesizeTts),
      streamRoot: root,
      // Comfortably longer than staging one segment to disk, so the pre-check
      // below cannot race the deadline it is supposed to precede.
      ackTimeoutMs: 1_000,
      voiceDiagnostics: diagnostics,
    });
    registrations.push(registration);
    const start = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_START)!;
    const next = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT)!;
    const stagingRoot = join(root, 'diagnostics');

    const started = await start({
      requestId: 'tts-abandoned', text: 'Alpha. Beta.', packId, voiceId: null, speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' }, prefetchDepth: 1,
      diagnostics: { sessionId: 'session-1', captureAllowed: true, durationMs: null, authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637' },
    });
    await next({ streamId: started.streamId, generation: started.generation });
    await vi.waitFor(async () => {
      expect(await readdir(join(stagingRoot, started.streamId))).toHaveLength(1);
    }, { timeout: 900 });

    // The client never acks and never cancels. Whatever terminal path retires the
    // stream must also discard the private audio staged for it.
    await vi.waitFor(async () => {
      expect(await readdir(stagingRoot)).toEqual([]);
    }, { timeout: 8_000 });
    expect(captureFile).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it('keeps segmented TTS usable while surfacing and recovering diagnostics retention failure', async () => {
    const diagnosticsHome = await createTempDir();
    const { controller, recoverRemoval } = await createDiagnosticsControllerWithRemovalFailure({
      happyHomeDir: diagnosticsHome,
    });
    const streamRoot = await createTempDir();
    const synthesizeTts: VoiceInferenceRuntime['synthesizeTts'] = async (input) => ({
      bytes: Buffer.from(`audio:${input.text}`),
      output: input.output,
      name: 'segment.wav',
    });
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceTtsStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: await createWorker(synthesizeTts),
      streamRoot,
      voiceDiagnostics: controller,
    });
    registrations.push(registration);
    const start = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_START)!;
    const next = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT)!;
    const ack = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_ACK)!;

    const started = await start({
      requestId: 'tts-retention-failure', text: 'One sentence.', packId, voiceId: null, speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' }, prefetchDepth: 1,
      diagnostics: {
        sessionId: 'session-1', captureAllowed: true, durationMs: null,
        authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
      },
    });
    const segment = await next({ streamId: started.streamId, generation: started.generation });
    await expect(ack({
      streamId: started.streamId,
      generation: started.generation,
      segmentId: segment.event.segmentId,
      segmentIndex: segment.event.segmentIndex,
    })).resolves.toMatchObject({ ok: true, complete: true });

    await vi.waitFor(async () => {
      await expect(controller.status()).resolves.toMatchObject({
        health: {
          captureFailure: false,
          cleanup: { status: 'required', code: 'cleanup_failed', ownedEntryCount: 1 },
        },
      });
    });
    recoverRemoval();
    await controller.deleteAll();
    await expect(controller.status()).resolves.toMatchObject({
      health: { captureFailure: false, cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 } },
    });
    await registration.dispose();
  });
});
