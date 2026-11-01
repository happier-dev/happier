import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
  PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1,
  PEER_APPLICATION_ENCRYPTION_INSTALL_PROOF_V1,
  createPeerApplicationEncryptionAadV1,
  createPeerApplicationEncryptionNonceV1,
  createSpeechTranscriptionApplicationAuthorityDigestV1,
  decodeBase64,
  decodePeerApplicationEncryptedFrameV1,
  encodeBase64,
  encodePeerApplicationEncryptedFrameV1,
  sealEncryptedDataKeyEnvelopeV1,
  type DaemonVoiceInferenceSttStreamEvent,
  ModelPackManifestSchema,
  VoiceSpeechDiagnosticsSettingsV1Schema,
  DaemonVoiceInferenceSttStreamChunkResponseSchema,
  DaemonVoiceInferenceSttStreamFinishResponseSchema,
  DaemonVoiceInferenceSttStreamStartResponseSchema,
  DaemonVoiceInferenceSttStreamCancelResponseSchema,
} from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { bindProcessLogger, Logger, logger } from '@/ui/logger';
import { resolveVoiceInferencePaths } from '../voiceInferencePaths';
import { startVoiceInferenceWorker, type VoiceInferenceWorkerHandle } from '../voiceInferenceWorker';
import type { VoiceInferenceRuntime, VoiceInferenceRuntimeTranscribeInput, VoiceInferenceStreamingTranscriptionSession as RuntimeStreamSession } from '../voiceInferenceRuntimeTypes';

import { createVoiceInferenceSpeechStreamManager } from './voiceInferenceSpeechStreamManager';
import { createVoiceDiagnosticsController } from '../../voiceDiagnostics/controller';
import { createDiagnosticsControllerWithRemovalFailure } from '../../voiceDiagnostics/controller.testkit';
import { openAes256GcmBytes, sealAes256GcmBytes } from '@happier-dev/transfers/node';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('createVoiceInferenceSpeechStreamManager', () => {
  const packId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
  const tempDirs: string[] = [];
  const managers: ReturnType<typeof createVoiceInferenceSpeechStreamManager>[] = [];
  let worker: VoiceInferenceWorkerHandle;
  let nativeRuntime: VoiceInferenceRuntime;
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_WEB_LATENCY_TRACE']);

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-stt-stream-home-'));
    tempDirs.push(home);
    process.env.HAPPIER_HOME_DIR = home;
    reloadConfiguration();
    const packDir = join(resolveVoiceInferencePaths().packsRootDir, packId);
    const bytes = Buffer.from('native recognition model boundary fixture');
    await mkdir(packDir, { recursive: true });
    const manifest = ModelPackManifestSchema.parse({
      packId, kind: 'stt_sherpa', model: 'zipformer', version: 'fixture-v1',
      files: [{ path: 'model.onnx', url: 'https://example.test/model.onnx',
        sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength }],
    });
    await writeFile(join(packDir, 'pack.json'), JSON.stringify(manifest));
    await writeFile(join(packDir, 'model.onnx'), bytes);
    nativeRuntime = {
      synthesizeTts: async () => { throw new Error('unused native synthesis'); },
      transcribeAudio: async () => { throw new Error('unused native recognition'); },
    };
    worker = await startVoiceInferenceWorker({ runtimeLoader: async () => nativeRuntime });
  });

  it('rejects Agent realtime and wrong-attempt carrier authority before creating an STT session', async () => {
    const createStreamingTranscriptionSession = vi.fn();
    nativeRuntime = { ...nativeRuntime, createStreamingTranscriptionSession };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceInferenceWorker: worker,
    });
    managers.push(manager);
    const baseBinding = {
      v: 1 as const,
      suite: 'aes-256-gcm' as const,
      flowKind: 'voice_media' as const,
      routeKind: 'server_relay' as const,
      authorityDigest: `sha256:${'ab'.repeat(32)}`,
      accountId: 'account-1',
      machineId: 'machine-1',
      tunnelId: 'tunnel-1',
      applicationAttemptId: 'attempt-1',
      applicationAuthorityDigest:
        createSpeechTranscriptionApplicationAuthorityDigestV1('attempt-1'),
    };
    await expect(manager.start({
      requestId: 'attempt-1',
      packId: packId,
      language: 'en',
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
      peerApplicationEncryption: {
        ...baseBinding,
        applicationKind: 'agent_realtime' as never,
      },
    })).resolves.toMatchObject({ ok: false, error: 'voice_inference_invalid_stream_state' });
    await expect(manager.start({
      requestId: 'attempt-2',
      packId: packId,
      language: 'en',
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
      peerApplicationEncryption: {
        ...baseBinding,
        applicationKind: 'speech_transcription',
      },
    })).resolves.toMatchObject({ ok: false, error: 'voice_inference_invalid_stream_state' });
    expect(createStreamingTranscriptionSession).not.toHaveBeenCalled();
  });

  it('admits only one live STT stream for a signed application attempt', async () => {
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const pendingRuntimeStart = deferred<RuntimeStreamSession>();
    const createStreamingTranscriptionSession = vi.fn(() => pendingRuntimeStart.promise);
    nativeRuntime = { ...nativeRuntime, createStreamingTranscriptionSession };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceInferenceWorker: worker,
    });
    managers.push(manager);
    const request = {
      requestId: 'attempt-with-duplicate-start',
      packId: packId,
      language: 'en',
      streamingMode: 'runtime' as const,
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    };

    const firstStart = manager.start(request);
    await vi.waitFor(() => expect(createStreamingTranscriptionSession).toHaveBeenCalledOnce());
    await expect(manager.start(request)).resolves.toMatchObject({
      ok: false,
      errorCode: 'invalid_stream_state',
    });
    pendingRuntimeStart.resolve(runtimeSession);
    expect(DaemonVoiceInferenceSttStreamStartResponseSchema.parse(await firstStart)).toMatchObject({ ok: true });
    await expect(manager.start(request)).resolves.toMatchObject({
      ok: false,
      errorCode: 'invalid_stream_state',
    });
    expect(DaemonVoiceInferenceSttStreamStartResponseSchema.parse(await manager.start({
      ...request,
      requestId: 'distinct-concurrent-attempt',
    }))).toMatchObject({ ok: true });
    expect(createStreamingTranscriptionSession).toHaveBeenCalledTimes(2);

    await manager.dispose();
  });

  it('retires a native start lost with its transport before publishing a late stream', async () => {
    const gate = deferred<RuntimeStreamSession>();
    const cancel = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    let startSignal: AbortSignal | null | undefined;
    const create = vi.fn(async (input: Parameters<NonNullable<VoiceInferenceRuntime['createStreamingTranscriptionSession']>>[0]) => {
      startSignal = input.signal;
      return await gate.promise;
    });
    nativeRuntime = { ...nativeRuntime, createStreamingTranscriptionSession: create };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(), voiceInferenceWorker: worker,
    });
    managers.push(manager);
    const requestId = 'lost-start';
    const starting = manager.start({
      requestId, packId, language: 'en', streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    try {
      expect(DaemonVoiceInferenceSttStreamCancelResponseSchema.parse(await manager.cancelForTransportLoss({
        voiceMediaApplicationAuthority: {
          v: 1, applicationKind: 'speech_transcription', applicationAttemptId: requestId,
          applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1('other-attempt'),
        },
      }))).toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
      expect(startSignal?.aborted).toBe(false);
      const result = DaemonVoiceInferenceSttStreamCancelResponseSchema.parse(await manager.cancelForTransportLoss({
        voiceMediaApplicationAuthority: {
          v: 1, applicationKind: 'speech_transcription', applicationAttemptId: requestId,
          applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1(requestId),
        },
      }));
      expect(result).toMatchObject({ ok: true });
      expect(startSignal?.aborted).toBe(true);
    } finally {
      gate.resolve({
        appendPcm16: async () => ({ events: [] }),
        finish: async () => ({ text: '', language: null, events: [] }), cancel, close,
      });
    }
    expect(DaemonVoiceInferenceSttStreamStartResponseSchema.parse(await starting)).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(DaemonVoiceInferenceSttStreamStartResponseSchema.parse(await manager.start({
      requestId: 'fresh-start', packId, language: 'en', streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    }))).toMatchObject({ ok: true });
  });

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
    await worker.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_WEB_LATENCY_TRACE']);
    reloadConfiguration();
    await Promise.all(tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }));
  });

  async function createTempStreamRoot(): Promise<string> {
    // The upload bridge's real worker accepts only its canonical private temp tree.
    const dir = await mkdtemp(join(resolveVoiceInferencePaths().tempDir, 'happier-stt-stream-manager-'));
    tempDirs.push(dir);
    return dir;
  }

  it('emits runtime partial and endpoint events before finish and final events on finish', async () => {
    const appendPcm16 = vi.fn<RuntimeStreamSession['appendPcm16']>(async (input) => {
      const events: DaemonVoiceInferenceSttStreamEvent[] = [
        { type: 'partial', seq: input.seq, text: 'hel', isEndpoint: false, confidence: null },
        { type: 'endpoint', seq: input.seq, transcript: 'hello', reason: 'vad' },
      ];
      return { events };
    });
    const finish = vi.fn<RuntimeStreamSession['finish']>(async (input) => {
      const events: DaemonVoiceInferenceSttStreamEvent[] = [
        { type: 'final', seq: input.finalSeq, text: 'hello world', language: 'en', modelPackId: packId },
      ];
      return {
        text: 'hello world',
        language: 'en',
        events,
      };
    });
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16,
      finish,
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const transcribeAudio = vi.fn(async () => {
      throw new Error('runtime_stream_must_not_batch_transcribe');
    });
    nativeRuntime = { ...nativeRuntime, transcribeAudio, createStreamingTranscriptionSession: vi.fn(async () => runtimeSession) };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceInferenceWorker: worker,
    });
    managers.push(manager);

    const started = await manager.start({
      requestId: 'runtime-request-1',
      packId: packId,
      language: 'en',
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0, ackSeq: -1 });
    if (!started.ok) throw new Error('expected stream start to succeed');

    await expect(manager.appendPcm16Bytes({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0, 1, 0]),
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      events: [
        { type: 'partial', seq: 0, text: 'hel', isEndpoint: false, confidence: null },
        { type: 'endpoint', seq: 0, transcript: 'hello', reason: 'vad' },
      ],
    });

    await expect(manager.finish({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      finalText: 'hello world',
      language: 'en',
      modelPackId: packId,
      events: [{ type: 'final', seq: 0, text: 'hello world', language: 'en', modelPackId: packId }],
    });

    expect(runtimeSession.appendPcm16).toHaveBeenCalledOnce();
    expect(runtimeSession.finish).toHaveBeenCalledOnce();
    expect(runtimeSession.close).toHaveBeenCalledOnce();
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('admits contiguous pipelined chunks while keeping backend consumption ordered', async () => {
    const appends = [deferred<Readonly<{ events: readonly DaemonVoiceInferenceSttStreamEvent[] }>>(), deferred<Readonly<{ events: readonly DaemonVoiceInferenceSttStreamEvent[] }>>()];
    const appendPcm16 = vi.fn<RuntimeStreamSession['appendPcm16']>(({ seq }) => appends[seq]!.promise);
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16,
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    nativeRuntime = { ...nativeRuntime, createStreamingTranscriptionSession: vi.fn(async () => runtimeSession) };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceInferenceWorker: worker,
    });
    managers.push(manager);
    const started = await manager.start({
      requestId: 'runtime-pipeline',
      packId: packId,
      language: 'en',
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    });
    if (!started.ok) throw new Error('expected stream start to succeed');

    const first = manager.appendPcm16Bytes({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    });
    const second = manager.appendPcm16Bytes({
      streamId: started.streamId,
      generation: started.generation,
      seq: 1,
      pcm16Bytes: new Uint8Array([1, 0]),
    });
    await vi.waitFor(() => expect(appendPcm16).toHaveBeenCalledTimes(1));
    appends[0]!.resolve({ events: [] });
    await vi.waitFor(() => expect(appendPcm16).toHaveBeenCalledTimes(2));
    appends[1]!.resolve({ events: [] });

    await expect(first).resolves.toMatchObject({ ok: true, ackSeq: 0 });
    await expect(second).resolves.toMatchObject({ ok: true, ackSeq: 1 });
  });

  it('keeps reordered compatibility chunks within stream credit and settles them on cancellation', async () => {
    const received: number[] = [];
    nativeRuntime = { ...nativeRuntime, createStreamingTranscriptionSession: async () => ({
      appendPcm16: async ({ seq }) => { received.push(seq); return { events: [] }; },
      finish: async () => ({ text: '', language: null, events: [] }),
      cancel: async () => {}, close: async () => {},
    }) };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(), voiceInferenceWorker: worker,
      maxAdmittedFrames: 2, maxAdmittedBytes: 4,
    });
    managers.push(manager);
    const started = await manager.start({ requestId: 'compatibility-credit', packId, language: 'en',
      streamingMode: 'runtime', format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT });
    if (!started.ok) throw new Error('Stream did not start');
    const append = (seq: number, pcm16Base64 = 'AAA=') => manager.appendCompatibilityChunk({
      streamId: started.streamId, generation: started.generation, seq, pcm16Base64,
    });
    const waiting = append(1);
    const duplicate = append(1);
    await expect(append(1, 'AQA=')).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    const head = append(0);
    await expect(Promise.all([head, waiting, duplicate])).resolves.toMatchObject([
      { ok: true }, { ok: true }, { ok: true },
    ]);
    expect(received).toEqual([0, 1]);
    const gap = append(3);
    const tail = append(4);
    await expect(append(5)).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    await manager.cancel({ streamId: started.streamId, generation: started.generation });
    await expect(Promise.all([gap, tail])).resolves.toMatchObject([
      { ok: false, error: 'daemon_voice_inference_stream_not_open' },
      { ok: false, error: 'daemon_voice_inference_stream_not_open' },
    ]);

    const fresh = await manager.start({ requestId: 'compatibility-cancel', packId, language: 'en',
      streamingMode: 'runtime', format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT });
    if (!fresh.ok) throw new Error('Stream did not start');
    const stranded = manager.appendCompatibilityChunk({ streamId: fresh.streamId, generation: fresh.generation,
      seq: 1, pcm16Base64: 'AAA=' });
    await manager.cancel({ streamId: fresh.streamId, generation: fresh.generation });
    await expect(stranded).resolves.toMatchObject({ ok: false, error: 'daemon_voice_inference_stream_not_open' });
    expect(received).toEqual([0, 1]);
  });

  it.each(['pcm', 'compatibility'] as const)('keeps native %s recognition live beyond the file-upload byte limit', async (ingress) => {
    const received: number[][] = [];
    nativeRuntime = { ...nativeRuntime, createStreamingTranscriptionSession: async () => ({
      appendPcm16: async ({ seq, pcm16Bytes }) => {
        received.push([...pcm16Bytes]);
        return { events: seq === 3
          ? [{ type: 'endpoint', seq, transcript: 'speech after silence', reason: 'vad' }]
          : [] };
      },
      finish: async () => ({ text: 'speech after silence', language: 'en', events: [] }),
      cancel: async () => {}, close: async () => {},
    }) };
    const streamRoot = await createTempStreamRoot();
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot, voiceInferenceWorker: worker,
    });
    managers.push(manager);
    const started = await manager.start({ requestId: `long-${ingress}`, packId, language: 'en',
      streamingMode: 'runtime', format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT });
    if (!started.ok) throw new Error('Stream did not start');
    const frames = [Buffer.from([0, 0]), Buffer.from([0, 0]), Buffer.from([0, 0]), Buffer.from([1, 0])];
    for (const [seq, pcm] of frames.entries()) {
      const address = { streamId: started.streamId, generation: started.generation, seq };
      const response = await (ingress === 'pcm'
        ? manager.appendPcm16Bytes({ ...address, pcm16Bytes: pcm })
        : manager.appendCompatibilityChunk({ ...address, pcm16Base64: pcm.toString('base64') }));
      expect(DaemonVoiceInferenceSttStreamChunkResponseSchema.parse(response)).toMatchObject({
        ok: true, ackSeq: seq,
        events: seq === 3 ? [{ type: 'endpoint', transcript: 'speech after silence' }] : [],
      });
    }
    expect(received).toEqual(frames.map(pcm => [...pcm]));
    await expect(manager.status(started)).resolves.toMatchObject({ ok: true, state: 'open', ackSeq: 3 });
    expect(await readdir(streamRoot)).toEqual([]);
    expect(DaemonVoiceInferenceSttStreamFinishResponseSchema.parse(await manager.finish({
      streamId: started.streamId, generation: started.generation, finalSeq: 3,
    }))).toMatchObject({ ok: true, ackSeq: 3, finalText: 'speech after silence' });
  });

  it.each([false, true])('authenticates START-bound PCM and its terminal native failure=%s response', async nativeFailure => {
    process.env.HAPPIER_WEB_LATENCY_TRACE = '1';
    const trace = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const appendPcm16 = vi.fn<RuntimeStreamSession['appendPcm16']>(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      if (nativeFailure) throw Object.assign(new Error('native append cancelled'), { code: 'cancelled' });
      return { events: [] };
    });
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16,
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    nativeRuntime = { ...nativeRuntime, createStreamingTranscriptionSession: vi.fn(async () => runtimeSession) };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceInferenceWorker: worker,
    });
    managers.push(manager);
    const binding = {
      v: 1 as const,
      suite: 'aes-256-gcm' as const,
      flowKind: 'voice_media' as const,
      routeKind: 'server_relay' as const,
      authorityDigest: 'sha256:acdb52b3d7de70428b1c54fbb340ab675b98d6900d2b86ababad20baa7aed6ca',
      accountId: 'account-1',
      machineId: 'machine-1',
      tunnelId: 'tunnel-1',
      applicationKind: 'speech_transcription' as const,
      applicationAttemptId: 'runtime-encrypted-relay',
      applicationAuthorityDigest:
        createSpeechTranscriptionApplicationAuthorityDigestV1('runtime-encrypted-relay'),
    };
    const started = await manager.start({
      requestId: 'runtime-encrypted-relay',
      packId: packId,
      language: 'en',
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
      peerApplicationEncryption: binding,
    });
    if (!started.ok || !started.peerApplicationEncryption) throw new Error('expected encrypted stream start');
    const substreamId = `daemon.voiceInference.stt.${started.streamId}.${started.generation}`;
    const contentKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: contentKey,
      recipientPublicKey: decodeBase64(started.peerApplicationEncryption.recipientPublicKeyBase64Url, 'base64url'),
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    const sealFrame = (phase: 'install' | 'data' | 'finish', sequence: number, plaintext: Uint8Array, envelopeBytes?: Uint8Array) => {
      const nonce = createPeerApplicationEncryptionNonceV1({ direction: 'client_to_daemon', phase, sequence });
      const ciphertext = sealAes256GcmBytes({
        key: contentKey,
        nonce,
        aad: createPeerApplicationEncryptionAadV1({
          authorityDigest: binding.authorityDigest,
          accountId: binding.accountId,
          machineId: binding.machineId,
          tunnelId: binding.tunnelId,
          applicationKind: binding.applicationKind,
          applicationAttemptId: binding.applicationAttemptId,
          applicationAuthorityDigest: binding.applicationAuthorityDigest,
          direction: 'client_to_daemon',
          streamId: started.streamId,
          generation: started.generation,
          substreamId,
          sequence,
          phase,
        }),
        plaintext,
      });
      return encodePeerApplicationEncryptedFrameV1({
        v: 1,
        kind: phase,
        nonceBase64Url: encodeBase64(nonce, 'base64url'),
        ciphertextBase64Url: encodeBase64(ciphertext, 'base64url'),
        ...(envelopeBytes ? { encryptedDataKeyEnvelopeBase64Url: encodeBase64(envelopeBytes, 'base64url') } : {}),
      });
    };
    const openResponse = (phase: 'install' | 'data' | 'finish', sequence: number, payload: Uint8Array) => {
      const frame = decodePeerApplicationEncryptedFrameV1(payload);
      if (!frame) throw new Error('expected encrypted response');
      const nonce = createPeerApplicationEncryptionNonceV1({ direction: 'daemon_to_client', phase, sequence });
      return openAes256GcmBytes({
        key: contentKey,
        nonce,
        aad: createPeerApplicationEncryptionAadV1({
          authorityDigest: binding.authorityDigest,
          accountId: binding.accountId,
          machineId: binding.machineId,
          tunnelId: binding.tunnelId,
          applicationKind: binding.applicationKind,
          applicationAttemptId: binding.applicationAttemptId,
          applicationAuthorityDigest: binding.applicationAuthorityDigest,
          direction: 'daemon_to_client',
          streamId: started.streamId,
          generation: started.generation,
          substreamId,
          sequence,
          phase,
        }),
        ciphertext: decodeBase64(frame.ciphertextBase64Url, 'base64url'),
      });
    };

    const installResponse = await manager.appendPeerApplicationFrame({
      binding,
      streamId: started.streamId,
      generation: started.generation,
      substreamId,
      carrierSequence: 0,
      payloadBytes: sealFrame('install', 0, new TextEncoder().encode(PEER_APPLICATION_ENCRYPTION_INSTALL_PROOF_V1), envelope),
    });
    expect(new TextDecoder().decode(openResponse('install', 0, installResponse))).toBe(PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1);

    await expect(manager.appendPeerApplicationFrame({
      binding: { ...binding, tunnelId: 'wrong-tunnel' },
      streamId: started.streamId,
      generation: started.generation,
      substreamId,
      carrierSequence: 1,
      payloadBytes: sealFrame('data', 1, new Uint8Array([0, 0, 1, 0])),
    })).rejects.toThrow('daemon_voice_inference_encryption_authority_mismatch');
    expect(appendPcm16).not.toHaveBeenCalled();

    const dataResponse = await manager.appendPeerApplicationFrame({
      binding,
      streamId: started.streamId,
      generation: started.generation,
      substreamId,
      carrierSequence: 1,
      payloadBytes: sealFrame('data', 1, new Uint8Array([0, 0, 1, 0])),
    });
    const parsedResponse = DaemonVoiceInferenceSttStreamChunkResponseSchema.parse(JSON.parse(new TextDecoder().decode(openResponse('data', 1, dataResponse))));
    expect(appendPcm16).toHaveBeenCalledOnce();
    expect(trace.mock.calls).toContainEqual([
      '[VoiceInference] Relay application frame settled',
      expect.objectContaining({ tunnelId: binding.tunnelId, substreamId, sequence: 1,
        phase: 'data', ok: !nativeFailure, elapsedMs: expect.any(Number) }),
    ]);
    const dataTrace = trace.mock.calls.find(([message, fields]) => message === '[VoiceInference] Relay application frame settled'
      && fields && typeof fields === 'object' && 'sequence' in fields && fields.sequence === 1)?.[1];
    expect(dataTrace && typeof dataTrace === 'object' && 'elapsedMs' in dataTrace ? dataTrace.elapsedMs : undefined)
      .toBeGreaterThanOrEqual(20);
    if (nativeFailure) {
      expect(parsedResponse).toMatchObject({ ok: false, errorCode: 'cancelled', diagnostic: { operation: 'appendPcm16', code: 'cancelled' } });
      expect(runtimeSession.close).toHaveBeenCalledOnce();
      return;
    }
    expect(parsedResponse).toMatchObject({ ok: true, ackSeq: 0 });

    const finishResponse = await manager.appendPeerApplicationFrame({
      binding,
      streamId: started.streamId,
      generation: started.generation,
      substreamId,
      carrierSequence: 2,
      payloadBytes: sealFrame('finish', 2, new TextEncoder().encode(JSON.stringify({ finalSeq: 0 }))),
    });
    expect(DaemonVoiceInferenceSttStreamFinishResponseSchema.parse(JSON.parse(new TextDecoder().decode(openResponse('finish', 2, finishResponse))))).toMatchObject({
      ok: true,
      ackSeq: 0,
      finalText: '',
    });
    expect(runtimeSession.finish).toHaveBeenCalledOnce();
  });

  it('captures a completed runtime PCM stream only when request-scoped diagnostics consent is present', async () => {
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: 'captured', language: 'en', events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const voiceDiagnostics = createVoiceDiagnosticsController({ happyHomeDir: configuration.happyHomeDir });
    await voiceDiagnostics.configure(VoiceSpeechDiagnosticsSettingsV1Schema.parse({
      enabled: true, consentVersion: 1, captureSttInput: true,
    }));
    const capture = vi.spyOn(voiceDiagnostics, 'capture');
    const captureFile = vi.spyOn(voiceDiagnostics, 'captureFile');
    const streamRoot = await createTempStreamRoot();
    nativeRuntime = { ...nativeRuntime, createStreamingTranscriptionSession: vi.fn(async () => runtimeSession) };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot,
      voiceDiagnostics,
      voiceInferenceWorker: worker,
    });
    managers.push(manager);

    const started = await manager.start({
      requestId: 'runtime-diagnostic-request',
      packId: packId,
      language: 'en',
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
      diagnostics: { sessionId: 'private-session', captureAllowed: true, durationMs: null, authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637' },
    });
    if (!started.ok) throw new Error('expected stream start to succeed');
    await manager.appendPcm16Bytes({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0, 1, 0]),
    });
    await manager.finish({ streamId: started.streamId, generation: started.generation, finalSeq: 0 });

    await vi.waitFor(() => expect(captureFile).toHaveBeenCalledOnce());
    expect(capture).not.toHaveBeenCalled();
    const status = await voiceDiagnostics.status();
    expect(status).toMatchObject({ artifacts: [expect.objectContaining({ direction: 'stt_input' })], health: { captureFailure: false } });
    const artifact = await voiceDiagnostics.resolveArtifactForExport(status.artifacts[0]!.id);
    expect(artifact).not.toBeNull();
    const capturedWavBytes = await readFile(artifact!.audioPath);
    const captured = captureFile.mock.calls[0]?.[0];
    expect(captured).toMatchObject({
      direction: 'stt_input',
      format: 'wav',
      durationMs: null,
      sessionId: 'private-session',
      providerId: 'local_neural',
      attemptId: 'runtime-diagnostic-request',
    });
    expect(capturedWavBytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect([...capturedWavBytes.subarray(44)]).toEqual([0, 0, 1, 0]);
    await vi.waitFor(async () => expect(await readdir(streamRoot)).toEqual([]));
  });

  it('keeps completed streaming STT usable while surfacing and recovering diagnostics retention failure', async () => {
    const diagnosticsHome = await createTempStreamRoot();
    const { controller, recoverRemoval } = await createDiagnosticsControllerWithRemovalFailure({
      happyHomeDir: diagnosticsHome,
    });
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: 'still usable', language: 'en', events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    nativeRuntime = { ...nativeRuntime, createStreamingTranscriptionSession: vi.fn(async () => runtimeSession) };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceDiagnostics: controller,
      voiceInferenceWorker: worker,
    });
    managers.push(manager);

    const started = await manager.start({
      requestId: 'runtime-diagnostic-retention-failure',
      packId: packId,
      language: 'en',
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
      diagnostics: {
        sessionId: 'private-session',
        captureAllowed: true,
        durationMs: null,
        authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
      },
    });
    if (!started.ok) throw new Error('expected stream start to succeed');
    await manager.appendPcm16Bytes({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    });
    await expect(manager.finish({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    })).resolves.toMatchObject({ ok: true, finalText: 'still usable' });

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
  });

  it('does not retain streaming STT audio after cancellation', async () => {
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const voiceDiagnostics = createVoiceDiagnosticsController({ happyHomeDir: configuration.happyHomeDir });
    await voiceDiagnostics.configure(VoiceSpeechDiagnosticsSettingsV1Schema.parse({
      enabled: true, consentVersion: 1, captureSttInput: true,
    }));
    const capture = vi.spyOn(voiceDiagnostics, 'capture');
    const captureFile = vi.spyOn(voiceDiagnostics, 'captureFile');
    const streamRoot = await createTempStreamRoot();
    nativeRuntime = { ...nativeRuntime, createStreamingTranscriptionSession: vi.fn(async () => runtimeSession) };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot,
      voiceDiagnostics,
      voiceInferenceWorker: worker,
    });
    managers.push(manager);
    const started = await manager.start({
      requestId: 'runtime-diagnostic-cancel',
      packId: packId,
      language: 'en',
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
      diagnostics: { sessionId: 'private-session', captureAllowed: true, durationMs: null, authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637' },
    });
    if (!started.ok) throw new Error('expected stream start to succeed');
    await manager.appendPcm16Bytes({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    });
    await manager.cancel({ streamId: started.streamId, generation: started.generation });

    expect(capture).not.toHaveBeenCalled();
    expect(captureFile).not.toHaveBeenCalled();
    expect((await voiceDiagnostics.status()).artifacts).toEqual([]);
    expect(await readdir(streamRoot)).toEqual([]);
  });

  it.each(['pcm', 'compatibility'] as const)('finishes %s upload bridge streams beyond the file-upload limit', async (ingress) => {
    vi.stubEnv('HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES', '48');
    let observedInput: VoiceInferenceRuntimeTranscribeInput | null = null;
    const workerTranscribe = vi.spyOn(worker, 'transcribeAudio');
    const transcribeAudio = vi.fn<VoiceInferenceRuntime['transcribeAudio']>(async (input) => {
      observedInput = input;
      const wav = await readFile(input.filePath);
      expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
      expect([...wav.subarray(44)]).toEqual([0, 0, 1, 0, 2, 0]);
      return {
        text: 'compatibility transcript',
        language: input.language,
      };
    });
    nativeRuntime = { ...nativeRuntime, transcribeAudio };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceInferenceWorker: worker,
    });
    managers.push(manager);

    const started = await manager.start({
      requestId: 'compat-request-1',
      packId: packId,
      language: 'en',
      streamingMode: 'upload_bridge',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0 });
    if (!started.ok) throw new Error('expected stream start to succeed');
    const append = (seq: number, pcm: Buffer) => {
      const address = { streamId: started.streamId, generation: started.generation, seq };
      return ingress === 'pcm'
        ? manager.appendPcm16Bytes({ ...address, pcm16Bytes: pcm })
        : manager.appendCompatibilityChunk({ ...address, pcm16Base64: pcm.toString('base64') });
    };
    await expect(append(0, Buffer.from([0, 0]))).resolves.toMatchObject({ ok: true, ackSeq: 0 });
    await expect(append(1, Buffer.from([1, 0]))).resolves.toMatchObject({ ok: true, ackSeq: 1 });
    await expect(append(2, Buffer.from([2, 0]))).resolves.toMatchObject({
      ok: true, ackSeq: 2,
    });

    await expect(manager.finish({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 2,
    })).resolves.toMatchObject({
      ok: true,
      ackSeq: 2,
      finalText: 'compatibility transcript',
      language: 'en',
      modelPackId: packId,
    });
    expect(observedInput).toMatchObject({
      requestId: 'compat-request-1',
      inputMimeType: 'audio/wav',
      packId: packId,
      language: 'en',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'ui_pretranscoded_pcm16_fallback',
        systemFfmpegAllowed: false,
      },
    });
    expect(workerTranscribe).toHaveBeenCalledWith(expect.objectContaining({ uploadId: started.streamId }));
    vi.unstubAllEnvs();
  });

  it('does not select the upload bridge when streaming mode is omitted', async () => {
    const transcribeAudio = vi.fn(async () => {
      throw new Error('upload_bridge_requires_explicit_start');
    });
    const createStreamingTranscriptionSession = vi.fn(async () => {
      throw new Error('runtime_requires_explicit_start');
    });
    nativeRuntime = { ...nativeRuntime, transcribeAudio, createStreamingTranscriptionSession };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceInferenceWorker: worker,
    });
    managers.push(manager);

    await expect(manager.start({
      requestId: 'missing-mode-request-1',
      packId: packId,
      language: 'en',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'invalid_stream_state',
    });
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(createStreamingTranscriptionSession).not.toHaveBeenCalled();
  });

  it.each([
    { cause: Object.assign(new Error('private audio /secret/model.wav token=secret'), { code: 'runtime_timeout' }),
      errorCode: 'request_timeout', exceptionClass: 'Error', code: 'runtime_timeout' },
    { cause: Object.assign(new TypeError('private audio /secret/model.wav token=secret'), { code: 'ERR_NATIVE_FAILURE' }),
      errorCode: 'internal_error', exceptionClass: 'TypeError', code: 'ERR_NATIVE_FAILURE' },
    { cause: Object.assign(new Error('private audio /secret/model.wav token=secret'), { name: 'private audio', code: 'token=secret /secret/model.wav' }),
      errorCode: 'internal_error', exceptionClass: 'Error', code: null },
    { cause: 'private audio /secret/model.wav token=secret',
      errorCode: 'internal_error', exceptionClass: 'Unknown', code: null },
  ])('preserves sanitized native append diagnostics and closes the stream ($exceptionClass/$code)', async ({ cause, errorCode, exceptionClass, code }) => {
    const logPath = join(await createTempStreamRoot(), 'append-failure.log');
    const fileLogger = new Logger({ logFilePath: logPath, pruneCurrentProcessLogs: false, allowDangerousRemoteLogging: false });
    const restoreLogger = bindProcessLogger(fileLogger);
    try {
      const runtimeSession: RuntimeStreamSession = {
        appendPcm16: vi.fn(async () => {
          throw cause;
        }),
        finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      };
      const cancelStt = vi.spyOn(worker, 'cancelStt');
      nativeRuntime = { ...nativeRuntime, createStreamingTranscriptionSession: vi.fn(async () => runtimeSession) };
      const manager = createVoiceInferenceSpeechStreamManager({
        streamRoot: await createTempStreamRoot(),
        voiceInferenceWorker: worker,
      });
      managers.push(manager);

      const started = await manager.start({
        requestId: 'runtime-request-crash',
        packId: packId,
        language: 'en',
        streamingMode: 'runtime',
        format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
      });
      expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0 });
      if (!started.ok) throw new Error('expected stream start to succeed');

      const response = await manager.appendPcm16Bytes({
        streamId: started.streamId,
        generation: started.generation,
        seq: 0,
        pcm16Bytes: new Uint8Array([0, 0]),
      });
      const diagnostic = { operation: 'appendPcm16', streamId: started.streamId, exceptionClass, code };
      expect(response).toEqual({
        ok: false,
        errorCode,
        error: `voice_inference_${errorCode}`,
        diagnostic,
      });
      expect(DaemonVoiceInferenceSttStreamChunkResponseSchema.parse(response)).toEqual(response);
      fileLogger.flushSync();
      const log = await readFile(logPath, 'utf8');
      expect(log).toContain(JSON.stringify(diagnostic));
      expect(log).not.toMatch(/private audio|secret|model\.wav|pcm16Bytes/);
      await expect(manager.status({
        streamId: started.streamId,
        generation: started.generation,
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'stream_not_found',
      });
      expect(runtimeSession.cancel).toHaveBeenCalledOnce();
      expect(runtimeSession.close).toHaveBeenCalledOnce();
      expect(cancelStt).toHaveBeenCalledWith('runtime-request-crash');
    } finally {
      restoreLogger();
    }
  });

  it('restores PCM and per-frame events after asynchronous compatibility admission reorders frames', async () => {
    const received: Array<{ seq: number; pcm: number[] }> = [];
    nativeRuntime = { ...nativeRuntime, createStreamingTranscriptionSession: async () => ({
      appendPcm16: async ({ seq, pcm16Bytes }) => {
        received.push({ seq, pcm: [...pcm16Bytes] });
        return { events: [{ type: 'partial', seq, text: `frame ${seq}`, isEndpoint: false, confidence: null }] };
      },
      finish: async () => ({ text: 'heard in order', language: 'en', events: [] }),
      cancel: async () => {}, close: async () => {},
    }) };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(), voiceInferenceWorker: worker,
    });
    managers.push(manager);
    const started = await manager.start({ requestId: 'async-admission-order', packId, language: 'en',
      streamingMode: 'runtime', format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT });
    if (!started.ok) throw new Error('Stream did not start');
    const firstAdmission = deferred<void>();
    const admitted: number[] = [];
    // The composed RPC suite covers real authorization. Here the resulting
    // asynchronous arrival order reaches the real manager and worker unchanged.
    const append = async (seq: number) => {
      if (seq === 0) await firstAdmission.promise;
      admitted.push(seq);
      return await manager.appendCompatibilityChunk({
        streamId: started.streamId, generation: started.generation, seq,
        pcm16Base64: Buffer.from([seq, 0]).toString('base64'),
      });
    };
    const first = append(0);
    const third = append(2);
    const second = append(1);
    try {
      expect(admitted).toEqual([2, 1]);
      expect(received).toEqual([]);
    } finally {
      firstAdmission.resolve();
    }
    const replies = await Promise.all([first, second, third]);
    expect(replies.map(reply => DaemonVoiceInferenceSttStreamChunkResponseSchema.parse(reply)))
      .toMatchObject([0, 1, 2].map(seq => ({
        ok: true, events: [{ type: 'partial', seq, text: `frame ${seq}` }],
      })));
    expect(admitted).toEqual([2, 1, 0]);
    expect(received).toEqual([0, 1, 2].map(seq => ({ seq, pcm: [seq, 0] })));
    expect(DaemonVoiceInferenceSttStreamFinishResponseSchema.parse(await manager.finish({
      streamId: started.streamId, generation: started.generation, finalSeq: 2,
    }))).toMatchObject({ ok: true, finalText: 'heard in order' });
  });
});
