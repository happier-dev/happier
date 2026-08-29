import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
  type DaemonVoiceInferenceNormalizationDecision,
  type DaemonVoiceInferenceSttStreamEvent,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVoiceInferenceSpeechStreamManager } from './voiceInferenceSpeechStreamManager';
import type { VoiceInferenceWorkerStreamingTranscriptionSession } from '../voiceInferenceWorker.execution';
import type { VoiceDiagnosticsController } from '../../voiceDiagnostics/controller';
import { createDiagnosticsControllerWithRemovalFailure } from '../../voiceDiagnostics/controller.testkit';
import { openAes256GcmBytes, sealAes256GcmBytes } from '@/utils/crypto/aes256GcmBytes';

type RuntimeStreamSession = VoiceInferenceWorkerStreamingTranscriptionSession;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('createVoiceInferenceSpeechStreamManager', () => {
  it('rejects Agent realtime and wrong-attempt carrier authority before creating an STT session', async () => {
    const createStreamingTranscriptionSession = vi.fn();
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => { throw new Error('unused'); }),
        cancelStt: vi.fn(async () => {}),
        createStreamingTranscriptionSession,
      },
    });
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
      packId: 'stt-pack-1',
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
      packId: 'stt-pack-1',
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
      modelPackId: 'stt-pack-1',
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const pendingRuntimeStart = deferred<RuntimeStreamSession>();
    const createStreamingTranscriptionSession = vi.fn(() => pendingRuntimeStart.promise);
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => { throw new Error('unused'); }),
        cancelStt: vi.fn(async () => {}),
        createStreamingTranscriptionSession,
      },
    });
    const request = {
      requestId: 'attempt-with-duplicate-start',
      packId: 'stt-pack-1',
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
    await expect(firstStart).resolves.toMatchObject({ ok: true });
    await expect(manager.start(request)).resolves.toMatchObject({
      ok: false,
      errorCode: 'invalid_stream_state',
    });
    await expect(manager.start({
      ...request,
      requestId: 'distinct-concurrent-attempt',
    })).resolves.toMatchObject({ ok: true });
    expect(createStreamingTranscriptionSession).toHaveBeenCalledTimes(2);

    await manager.dispose();
  });

  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }));
  });

  async function createTempStreamRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happier-stt-stream-manager-'));
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
        { type: 'final', seq: input.finalSeq, text: 'hello world', language: 'en', modelPackId: 'stt-pack-1' },
      ];
      return {
        text: 'hello world',
        language: 'en',
        events,
      };
    });
    const runtimeSession: RuntimeStreamSession = {
      modelPackId: 'stt-pack-1',
      appendPcm16,
      finish,
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const transcribeAudio = vi.fn(async () => {
      throw new Error('runtime_stream_must_not_batch_transcribe');
    });
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceInferenceWorker: {
        transcribeAudio,
        cancelStt: vi.fn(async () => {}),
        createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
      },
    });

    const started = await manager.start({
      requestId: 'runtime-request-1',
      packId: 'stt-pack-1',
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
      modelPackId: 'stt-pack-1',
      events: [{ type: 'final', seq: 0, text: 'hello world', language: 'en', modelPackId: 'stt-pack-1' }],
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
      modelPackId: 'stt-pack-1',
      appendPcm16,
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => { throw new Error('unused'); }),
        cancelStt: vi.fn(async () => {}),
        createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
      },
    });
    const started = await manager.start({
      requestId: 'runtime-pipeline',
      packId: 'stt-pack-1',
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

  it('installs a START-bound relay key and authenticates encrypted PCM before backend invocation', async () => {
    const appendPcm16 = vi.fn<RuntimeStreamSession['appendPcm16']>(async () => ({ events: [] }));
    const runtimeSession: RuntimeStreamSession = {
      modelPackId: 'stt-pack-1',
      appendPcm16,
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => { throw new Error('unused'); }),
        cancelStt: vi.fn(async () => {}),
        createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
      },
    });
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
      packId: 'stt-pack-1',
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
    expect(JSON.parse(new TextDecoder().decode(openResponse('data', 1, dataResponse)))).toMatchObject({ ok: true, ackSeq: 0 });
    expect(appendPcm16).toHaveBeenCalledOnce();

    const finishResponse = await manager.appendPeerApplicationFrame({
      binding,
      streamId: started.streamId,
      generation: started.generation,
      substreamId,
      carrierSequence: 2,
      payloadBytes: sealFrame('finish', 2, new TextEncoder().encode(JSON.stringify({ finalSeq: 0 }))),
    });
    expect(JSON.parse(new TextDecoder().decode(openResponse('finish', 2, finishResponse)))).toMatchObject({
      ok: true,
      ackSeq: 0,
      finalText: '',
    });
    expect(runtimeSession.finish).toHaveBeenCalledOnce();
  });

  it('captures a completed runtime PCM stream only when request-scoped diagnostics consent is present', async () => {
    const runtimeSession: RuntimeStreamSession = {
      modelPackId: 'stt-pack-1',
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: 'captured', language: 'en', events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const capture = vi.fn<VoiceDiagnosticsController['capture']>(async () => null);
    const capturedWav = (() => {
      let resolve: (bytes: Buffer) => void = () => {};
      const promise = new Promise<Buffer>((nextResolve) => {
        resolve = nextResolve;
      });
      return { promise, resolve };
    })();
    const captureFile = vi.fn<VoiceDiagnosticsController['captureFile']>(async (input) => {
      capturedWav.resolve(await readFile(input.filePath));
      return null;
    });
    const voiceDiagnostics = { capture, captureFile };
    const streamRoot = await createTempStreamRoot();
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot,
      voiceDiagnostics,
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => { throw new Error('unused'); }),
        cancelStt: vi.fn(async () => {}),
        createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
      },
    });

    const started = await manager.start({
      requestId: 'runtime-diagnostic-request',
      packId: 'stt-pack-1',
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
    const capturedWavBytes = await capturedWav.promise;
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
      modelPackId: 'stt-pack-1',
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: 'still usable', language: 'en', events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceDiagnostics: controller,
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => { throw new Error('unused'); }),
        cancelStt: vi.fn(async () => {}),
        createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
      },
    });

    const started = await manager.start({
      requestId: 'runtime-diagnostic-retention-failure',
      packId: 'stt-pack-1',
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
      modelPackId: 'stt-pack-1',
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const capture = vi.fn<VoiceDiagnosticsController['capture']>(async () => null);
    const captureFile = vi.fn<VoiceDiagnosticsController['captureFile']>(async () => null);
    const voiceDiagnostics = { capture, captureFile };
    const streamRoot = await createTempStreamRoot();
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot,
      voiceDiagnostics,
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => { throw new Error('unused'); }),
        cancelStt: vi.fn(async () => {}),
        createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
      },
    });
    const started = await manager.start({
      requestId: 'runtime-diagnostic-cancel',
      packId: 'stt-pack-1',
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
    expect(await readdir(streamRoot)).toEqual([]);
  });

  it('preserves the upload bridge compatibility path for non-runtime streaming starts', async () => {
    let observedInput: null | Readonly<{
      filePath: string;
      requestId: string;
      uploadId: string;
      inputMimeType: string;
      packId: string | null;
      language: string | null;
      normalization: DaemonVoiceInferenceNormalizationDecision;
    }> = null;
    const transcribeAudio = vi.fn(async (input: NonNullable<typeof observedInput>) => {
      observedInput = input;
      const wav = await readFile(input.filePath);
      expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
      expect([...wav.subarray(44)]).toEqual([0, 0, 1, 0]);
      return {
        requestId: input.requestId,
        text: 'compatibility transcript',
        language: input.language,
        modelPackId: input.packId,
      };
    });
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceInferenceWorker: {
        transcribeAudio,
        cancelStt: vi.fn(async () => {}),
      },
    });

    const started = await manager.start({
      requestId: 'compat-request-1',
      packId: 'stt-pack-1',
      language: 'en',
      streamingMode: 'upload_bridge',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0 });
    if (!started.ok) throw new Error('expected stream start to succeed');
    await expect(manager.appendPcm16Bytes({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0, 1, 0]),
    })).resolves.toMatchObject({ ok: true, ackSeq: 0, events: [] });

    await expect(manager.finish({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    })).resolves.toMatchObject({
      ok: true,
      ackSeq: 0,
      finalText: 'compatibility transcript',
      language: 'en',
      modelPackId: 'stt-pack-1',
    });
    expect(observedInput).toMatchObject({
      requestId: 'compat-request-1',
      uploadId: started.streamId,
      inputMimeType: 'audio/wav',
      packId: 'stt-pack-1',
      language: 'en',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'ui_pretranscoded_pcm16_fallback',
        systemFfmpegAllowed: false,
      },
    });
  });

  it('does not select the upload bridge when streaming mode is omitted', async () => {
    const transcribeAudio = vi.fn(async () => {
      throw new Error('upload_bridge_requires_explicit_start');
    });
    const createStreamingTranscriptionSession = vi.fn(async () => {
      throw new Error('runtime_requires_explicit_start');
    });
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceInferenceWorker: {
        transcribeAudio,
        cancelStt: vi.fn(async () => {}),
        createStreamingTranscriptionSession,
      },
    });

    await expect(manager.start({
      requestId: 'missing-mode-request-1',
      packId: 'stt-pack-1',
      language: 'en',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'invalid_stream_state',
    });
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(createStreamingTranscriptionSession).not.toHaveBeenCalled();
  });

  it('returns a typed error and closes the stream when the runtime append fails', async () => {
    const runtimeSession: RuntimeStreamSession = {
      modelPackId: 'stt-pack-1',
      appendPcm16: vi.fn(async () => {
        throw Object.assign(new Error('runtime append timed out'), { code: 'runtime_timeout' });
      }),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const cancelStt = vi.fn(async () => {});
    const manager = createVoiceInferenceSpeechStreamManager({
      streamRoot: await createTempStreamRoot(),
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => {
          throw new Error('unused');
        }),
        cancelStt,
        createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
      },
    });

    const started = await manager.start({
      requestId: 'runtime-request-crash',
      packId: 'stt-pack-1',
      language: 'en',
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0 });
    if (!started.ok) throw new Error('expected stream start to succeed');

    await expect(manager.appendPcm16Bytes({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'request_timeout',
    });
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
  });
});
