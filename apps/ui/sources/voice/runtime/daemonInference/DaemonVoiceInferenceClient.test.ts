import { MachineLiveStreamRelayCapsV1Schema } from '@happier-dev/protocol';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';

const network = await installSessionOpsNetworkBoundary();
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { createMachineFixture, createSessionFixture, createDeferred } = await import("@/dev/testkit");
const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
const { storage } = await import("@/sync/domains/state/storage");
const { getActiveServerSnapshot } = await import("@/sync/domains/server/serverRuntime");
const { resetVoiceDiagnosticsSessionPolicyForTests } = await import("@/voice/diagnostics/capturePolicy");
import { VoiceSpeechDiagnosticsSettingsV1Schema } from '@happier-dev/protocol/voice/diagnostics';
import {
  DaemonVoiceInferenceSttStreamChunkRequestSchema,
  DaemonVoiceInferenceSttStreamFinishRequestSchema,
  DaemonVoiceInferenceSttStreamStartRequestSchema,
} from '@happier-dev/protocol/daemon/voiceInference';
const { createTransferRecipientKeyPair } = await import("@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption");

const machineRpcWithServerScopeMock = vi.fn();


vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));

// Physical file handle only; the native/web upload readers and encrypted transfer remain real.
vi.mock('expo-file-system', () => ({ File: class {
  open() {
    return { size: 5, offset: 0, readBytes: () => new Uint8Array(Buffer.from('hello')), close() {} };
  }
} }));
const initialSettings = storage.getState().settings;
const initialMachines = storage.getState().machines;
const initialMachineLists = storage.getState().machineListByServerId;
const initialSessions = storage.getState().sessions;
let account: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
function selectMachine(machineId: string | null) {
  const machine = machineId ? createMachineFixture({ id: machineId, activeAt: Date.now() }) : null;
  storage.setState({ machines: machine ? { ...initialMachines, [machine.id]: machine } : {},
    machineListByServerId: { ...initialMachineLists, [account.home.id]: machine ? [machine] : [] } });
  storage.getState().applySettingsLocal({ voice: { ...storage.getState().settings.voice, executionMachine: {
    ...storage.getState().settings.voice.executionMachine, mode: 'fixed', machineId: machineId ?? 'missing-machine',
  } } });
}
function bindUnrelatedSession(sessionId: string, machineId: string) {
  const session = createSessionFixture({ id: sessionId, metadata: { path: '/unrelated', host: 'other', machineId } });
  storage.setState({ sessions: { ...storage.getState().sessions, [session.id]: session } });
}

const DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS = 30_000;

// Load the shared real owner graph during collection. Each test creates its
// own client and resets its boundary functions; rebuilding Sync per case is
// neither required isolation nor part of the inference contract.
await import('./DaemonVoiceInferenceClient');

describe('DaemonVoiceInferenceClient', () => {
  beforeEach(async () => {
    network.resetRequests();
    await network.addHome('https://daemon-inference.example.test', 'artifact-account');
    account = await createPlainArtifactHomeFixture('https://daemon-inference.example.test', {
      serverFeatures: FeaturesResponseSchema.parse({ ...{ features: { voice: { enabled: true }, execution: { runs: { enabled: true } } } }, features: { ...{ voice: { enabled: true }, execution: { runs: { enabled: true } } }, machines: {
      enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } },
    } }, capabilities: { machines: { liveStream: { serverRouted: {
      caps: MachineLiveStreamRelayCapsV1Schema.parse({}), disabledReason: null,
    } } } } }),
      handleRequest: async (path, init) => createPlainMachineReadHttpResponseFixture(path, init),
    });
    network.setRpcResponder(async request => await machineRpcWithServerScopeMock(request));
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: {
      voice: true, 'execution.runs': true, 'voice.agent': true, 'voice.daemonInference': true,
    } });
    primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: {
      status: 'ready', features: FeaturesResponseSchema.parse({ ...{ features: {
        voice: { enabled: true }, execution: { runs: { enabled: true } },
      } }, features: { ...{
        voice: { enabled: true }, execution: { runs: { enabled: true } },
      }, machines: {
      enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } },
    } }, capabilities: { machines: { liveStream: { serverRouted: {
      caps: MachineLiveStreamRelayCapsV1Schema.parse({}), disabledReason: null,
    } } } } }),
    } });
    selectMachine('machine-1');
    storage.getState().applySettingsLocal({ voiceDiagnosticsV1: VoiceSpeechDiagnosticsSettingsV1Schema.parse({
      enabled: true, consentVersion: 1, captureSttInput: true, captureTtsOutput: true,
    }) });
    expect(storage.getState().settings.voice.diagnostics.enabled).toBe(true);
    machineRpcWithServerScopeMock.mockReset();
  });
  afterEach(async () => {
    await account?.dispose();
    storage.setState({ settings: initialSettings, machines: initialMachines,
      machineListByServerId: initialMachineLists, sessions: initialSessions });
    resetServerFeaturesClientForTests();
    resetVoiceDiagnosticsSessionPolicyForTests();
  });

  it('fails closed with feature_disabled before resolving machine scope when daemon inference is not enabled', async () => {
    storage.getState().applySettingsLocal({ featureToggles: { 'voice.daemonInference': false } });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.getStatus()).rejects.toMatchObject({
      code: 'feature_disabled',
      message: 'daemon_voice_inference_feature_disabled',
    });
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  it('runs machine-only model status without creating a voice-home session or requiring a directory', async () => {
    machineRpcWithServerScopeMock.mockResolvedValue({ ok: true, models: [] });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.getModelsStatus()).resolves.toEqual([]);
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'machine-1',
      method: 'daemon.voiceInference.models.status',
    }));
  });

  it('fails closed before a model mutation when its captured execution-machine scope is no longer current', async () => {
    selectMachine('machine-b');

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.installModel(
      { packId: 'kokoro-82m-v1.0-onnx-q8-wasm' },
      { machineId: 'machine-a' },
    )).rejects.toMatchObject({ code: 'machine_unreachable' });
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  it('gives a model install its own deadline and forwards the caller lifetime to the daemon', async () => {
    machineRpcWithServerScopeMock.mockResolvedValue({ ok: true, model: {
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm', kind: 'tts_sherpa', model: 'kokoro', version: '1',
      executionSupport: ['daemon'], installState: 'installed', progress: null, lastError: null, updatedAtMs: 1,
    } });
    const clientModule = await import('./DaemonVoiceInferenceClient');
    const client = new clientModule.DaemonVoiceInferenceClient();
    const caller = new AbortController();

    await expect(client.installModel({
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      signal: caller.signal,
    })).resolves.toMatchObject({ packId: 'kokoro-82m-v1.0-onnx-q8-wasm', installState: 'installed' });

    const call = machineRpcWithServerScopeMock.mock.calls
      .map(([input]: any[]) => input)
      .find((input: any) => input.method === 'daemon.voiceInference.models.install');
    expect(call).toBeDefined();
    // The daemon aborts the install at the deadline the caller declares, so the
    // ordinary short RPC default would cancel a legitimate multi-minute download.
    expect(call.timeoutMs).toBeLessThanOrEqual(clientModule.VOICE_MODEL_INSTALL_RPC_TIMEOUT_MS);
    expect(call.timeoutMs).toBeGreaterThan(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS);
    const alreadyRetired = new AbortController();
    alreadyRetired.abort();
    machineRpcWithServerScopeMock.mockClear();
    await expect(client.installModel({ packId: 'kokoro-82m-v1.0-onnx-q8-wasm', signal: alreadyRetired.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  it('awaits Account-owned stt upload cleanup after capture cancellation', async () => {
    const chunkEntered = createDeferred<void>();
    const cleanupEntered = createDeferred<void>();
    const cleanupReply = createDeferred<void>();
    const caller = new AbortController();
    const recipient = createTransferRecipientKeyPair();
    machineRpcWithServerScopeMock.mockImplementation(async (input: { method: string; payload: { requestId?: string } }) => {
      if (input.method === 'daemon.voiceInference.stt.upload.init') return {
        success: true, uploadId: 'cleanup-upload', chunkSizeBytes: 1024,
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      };
      if (input.method === 'daemon.voiceInference.stt.upload.chunk') {
        chunkEntered.resolve();
        return await new Promise(() => {});
      }
      if (input.method === 'daemon.voiceInference.stt.upload.abort') {
        cleanupEntered.resolve();
        await cleanupReply.promise;
        return { success: true };
      }
      if (input.method === 'daemon.voiceInference.stt.cancel') {
        return { ok: true };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });
    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();
    let settled = false;
    const pending = client.transcribeRecordedAudio({ source: { kind: 'native', uri: 'file:///recording.wav', sizeBytes: 5 },
      inputMimeType: 'audio/wav', packId: null, language: null, signal: caller.signal }).then(
      () => { settled = true; return 'returned_audio' as const; },
      () => { settled = true; return 'cancelled' as const; },
    );
    try {
      await chunkEntered.promise;
      caller.abort();
      await cleanupEntered.promise;
      // Drain the RPC/transfer continuation: capture abort must not detach cleanup.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      cleanupReply.resolve();
      await expect(pending).resolves.toBe('cancelled');
    } finally {
      cleanupReply.resolve();
      caller.abort();
      await pending;
    }
  });

  it('awaits Account-owned segmented TTS cleanup after capture cancellation', async () => {
    const cleanupEntered = createDeferred<void>();
    const cleanupReply = createDeferred<void>();
    const caller = new AbortController();
    machineRpcWithServerScopeMock.mockImplementation(async (input: { method: string; payload: { requestId?: string } }) => {
      if (input.method === 'daemon.voiceInference.tts.stream.start') return {
        ok: true, requestId: input.payload.requestId, streamId: 'cleanup-stream', generation: 1, segmentCount: 1,
        output: { codec: 'wav', mimeType: 'audio/wav' },
      };
      if (input.method === 'daemon.voiceInference.tts.stream.cancel') {
        cleanupEntered.resolve();
        await cleanupReply.promise;
        return { ok: true, streamId: 'cleanup-stream', generation: 1 };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });
    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const stream = await new DaemonVoiceInferenceClient().startSegmentedTts({ text: 'hello',
      packId: null, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' }, signal: caller.signal });
    let settled = false;
    const pending = stream.cancel().then(() => { settled = true; });
    try {
      await cleanupEntered.promise;
      caller.abort();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      cleanupReply.resolve();
      await pending;
    } finally {
      cleanupReply.resolve();
      await pending;
    }
  });

  it('starts segmented daemon TTS, receives ready segments, and sends playback acknowledgements', async () => {
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.tts.stream.start') {
        return {
          ok: true,
          requestId: input.payload.requestId,
          streamId: 'tts-stream-1',
          generation: 0,
          segmentCount: 2,
          output: { codec: 'wav', mimeType: 'audio/wav' },
        };
      }
      if (input.method === 'daemon.voiceInference.tts.stream.next') {
        return {
          ok: true,
          streamId: 'tts-stream-1',
          generation: 0,
          event: {
            type: 'segment',
            streamId: 'tts-stream-1',
            generation: 0,
            segmentId: 'tts-stream-1:0',
            segmentIndex: 0,
            segmentCount: 2,
            text: 'Hello.',
            textRange: { start: 0, end: 6 },
            textHash: 'hash0',
            output: { codec: 'wav', mimeType: 'audio/wav' },
            audio: {
              contentBase64: Buffer.from('audio-0').toString('base64'),
              sizeBytes: 7,
            },
            isLastSegment: false,
          },
        };
      }
      if (input.method === 'daemon.voiceInference.tts.stream.ack') {
        return {
          ok: true,
          streamId: input.payload.streamId,
          generation: input.payload.generation,
          ackedSegmentIndex: input.payload.segmentIndex,
          complete: false,
        };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient({
      createRequestId: () => 'tts-request-1',
    });
    const stream = await client.startSegmentedTts({
      sessionId: 'voice-session-1',
      text: 'Hello. There.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });

    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'daemon.voiceInference.tts.stream.start',
      payload: expect.objectContaining({
        diagnostics: {
          sessionId: 'voice-session-1',
          captureAllowed: true,
          durationMs: null,
          authorizationId: expect.any(String),
        },
      }),
    }));

    const event = await stream.next();
    expect(event).toMatchObject({
      type: 'segment',
      streamId: 'tts-stream-1',
      segmentIndex: 0,
      bytes: new Uint8Array(Buffer.from('audio-0')),
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    if (event.type !== 'segment') throw new Error('expected segment');
    await stream.ackSegment(event);

    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'machine-1',
      method: 'daemon.voiceInference.tts.stream.start',
      payload: expect.objectContaining({
        requestId: 'tts-request-1',
        text: 'Hello. There.',
      }),
    }));
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'daemon.voiceInference.tts.stream.ack',
      payload: {
        streamId: 'tts-stream-1',
        generation: 0,
        segmentId: 'tts-stream-1:0',
        segmentIndex: 0,
      },
    }));
  });

  it('does not send segmented daemon TTS cancel after the final segment ack completes the stream', async () => {
    const abortController = new AbortController();
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.tts.stream.start') {
        return {
          ok: true,
          requestId: input.payload.requestId,
          streamId: 'tts-stream-complete',
          generation: 0,
          segmentCount: 1,
          output: { codec: 'wav', mimeType: 'audio/wav' },
        };
      }
      if (input.method === 'daemon.voiceInference.tts.stream.next') {
        return {
          ok: true,
          streamId: 'tts-stream-complete',
          generation: 0,
          event: {
            type: 'segment',
            streamId: 'tts-stream-complete',
            generation: 0,
            segmentId: 'tts-stream-complete:0',
            segmentIndex: 0,
            segmentCount: 1,
            text: 'Done.',
            textRange: { start: 0, end: 5 },
            textHash: 'hash0',
            output: { codec: 'wav', mimeType: 'audio/wav' },
            audio: {
              contentBase64: Buffer.from('audio-0').toString('base64'),
              sizeBytes: 7,
            },
            isLastSegment: true,
          },
        };
      }
      if (input.method === 'daemon.voiceInference.tts.stream.ack') {
        return {
          ok: true,
          streamId: input.payload.streamId,
          generation: input.payload.generation,
          ackedSegmentIndex: input.payload.segmentIndex,
          complete: true,
        };
      }
      if (input.method === 'daemon.voiceInference.tts.stream.cancel') {
        return {
          ok: true,
          streamId: input.payload.streamId,
          generation: input.payload.generation,
        };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient({ createRequestId: () => 'tts-request-complete' });
    const stream = await client.startSegmentedTts({
      text: 'Done.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
      signal: abortController.signal,
    });

    const event = await stream.next();
    if (event.type !== 'segment') throw new Error('expected segment');
    await stream.ackSegment(event);
    abortController.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalledWith(expect.objectContaining({
      method: 'daemon.voiceInference.tts.stream.cancel',
    }));
  });

  it('returns daemon status snapshots with progress and degraded service state intact', async () => {
    machineRpcWithServerScopeMock.mockResolvedValue({
      ok: true,
      serviceState: 'degraded',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
      models: [{
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: '2026-04-17',
        executionSupport: ['daemon'],
        installState: 'installing',
        progress: {
          phase: 'downloading',
          progress: 0.5,
          bytesDownloaded: 512,
          totalBytes: 1024,
          message: 'warming',
        },
        lastError: 'runtime_warmup_slow',
        updatedAtMs: 99,
      }],
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.getStatus()).resolves.toEqual({
      ok: true,
      serviceState: 'degraded',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
      models: [{
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: '2026-04-17',
        executionSupport: ['daemon'],
        installState: 'installing',
        progress: {
          phase: 'downloading',
          progress: 0.5,
          bytesDownloaded: 512,
          totalBytes: 1024,
          message: 'warming',
        },
        lastError: 'runtime_warmup_slow',
        pluginIdentity: null,
        updatedAtMs: 99,
      }],
    });
  });

  it('uploads recorded audio and returns daemon STT transcription', async () => {
    const recipientKeyPair = createTransferRecipientKeyPair();
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.stt.upload.init') {
        return {
          success: true,
          uploadId: 'upload-1',
          chunkSizeBytes: 1024,
          recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
        };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.chunk') {
        return { success: true };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.finalize') {
        return {
          success: true,
          uploadId: 'upload-1',
          path: '/tmp/upload-1.wav',
          sizeBytes: 5,
          sha256: 'abc',
        };
      }
      if (input.method === 'daemon.voiceInference.stt.transcribe') {
        return {
          ok: true,
          requestId: 'stt-1',
          text: 'hello daemon',
          language: 'en',
          modelPackId: 'stt-pack-1',
        };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const controller = new AbortController();
    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();
    const result = await client.transcribeRecordedAudio({
      sessionId: 'voice-session-1',
      durationMs: 1_250,
      source: { kind: 'native', uri: 'file:///recording.wav', sizeBytes: 5 },
      inputMimeType: 'audio/wav',
      packId: 'stt-pack-1',
      language: 'en',
      signal: controller.signal,
    });

    expect(result).toEqual({
      text: 'hello daemon',
      language: 'en',
      modelPackId: 'stt-pack-1',
    });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'machine-1',
      method: 'daemon.voiceInference.stt.transcribe',
      payload: expect.objectContaining({
        packId: 'stt-pack-1',
        language: 'en',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
        diagnostics: {
          sessionId: 'voice-session-1',
          captureAllowed: true,
          durationMs: 1_250,
          authorizationId: expect.any(String),
        },
      }),
    }));
  });

  it('cannot force diagnostics on when the canonical capture policy denies it', async () => {
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.tts.stream.start') {
        return {
          ok: true,
          requestId: input.payload.requestId,
          streamId: 'tts-stream-denied',
          generation: 0,
          segmentCount: 1,
          output: { codec: 'wav', mimeType: 'audio/wav' },
        };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });
    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    storage.getState().applySettingsLocal({ voiceDiagnosticsV1: VoiceSpeechDiagnosticsSettingsV1Schema.parse({ enabled: false }) });
    const client = new DaemonVoiceInferenceClient();
    const legacyShapedInput: Parameters<typeof client.startSegmentedTts>[0] & { captureDiagnostics: true } = {
      sessionId: 'voice-session-1',
      captureDiagnostics: true,
      text: 'must stay private',
      packId: null,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    };

    await client.startSegmentedTts(legacyShapedInput);

    const startCall = machineRpcWithServerScopeMock.mock.calls
      .map(([input]) => input)
      .find((input) => input.method === 'daemon.voiceInference.tts.stream.start');
    expect(startCall.payload).not.toHaveProperty('diagnostics');
  });

  it('creates a streaming STT sender for the selected daemon without spawning an unrelated voice-home agent session', async () => {
    bindUnrelatedSession('active-control-session', 'synthetic-session-machine');
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.stt.stream.start') {
        return {
          ok: true,
          requestId: input.payload.requestId,
          streamId: 'stream-1',
          generation: 3,
          ackSeq: -1,
          format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' },
        };
      }
      if (input.method === 'daemon.voiceInference.stt.stream.chunk') {
        return {
          ok: true,
          streamId: 'stream-1',
          generation: 3,
          ackSeq: input.payload.seq,
          events: [{ type: 'partial', seq: input.payload.seq, text: 'hel', isEndpoint: false, confidence: null }],
        };
      }
      if (input.method === 'daemon.voiceInference.stt.stream.finish') {
        return {
          ok: true,
          streamId: 'stream-1',
          generation: 3,
          ackSeq: input.payload.finalSeq,
          finalText: 'hello daemon',
          language: 'en',
          modelPackId: 'stt-pack-1',
          events: [{ type: 'final', seq: input.payload.finalSeq, text: 'hello daemon', language: 'en', modelPackId: 'stt-pack-1' }],
        };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const controller = new AbortController();
    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient({
      createRequestId: () => 'stream-request-1',
    });
    const sender = await client.createStreamingSttSender({
      sessionId: 'active-control-session',
      packId: 'stt-pack-1',
      language: 'en',
      signal: controller.signal,
    });
    expect(sender.transportKind).toBe('json_rpc_compat');

    await sender.start();
    await expect(sender.pushChunk(new Uint8Array([112, 99, 109]))).resolves.toEqual([
      { type: 'partial', seq: 0, text: 'hel', isEndpoint: false, confidence: null },
    ]);
    await expect(sender.finish()).resolves.toMatchObject({
      ok: true,
      finalText: 'hello daemon',
      language: 'en',
      modelPackId: 'stt-pack-1',
    });

    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'machine-1',
      method: 'daemon.voiceInference.stt.stream.start',
      payload: expect.objectContaining({
        requestId: 'stream-request-1',
        packId: 'stt-pack-1',
        language: 'en',
        streamingMode: 'runtime',
        diagnostics: {
          sessionId: 'active-control-session',
          captureAllowed: true,
          durationMs: null,
          authorizationId: expect.any(String),
        },
      }),
    }));
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'machine-1',
      method: 'daemon.voiceInference.stt.stream.chunk',
      payload: expect.objectContaining({
        streamId: 'stream-1',
        generation: 3,
        seq: 0,
        pcm16Base64: Buffer.from('pcm').toString('base64'),
      }),
    }));
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'machine-1',
      method: 'daemon.voiceInference.stt.stream.finish',
      payload: expect.objectContaining({
        streamId: 'stream-1',
        generation: 3,
        finalSeq: 0,
      }),
    }));
  });

  it('preserves queued capture PCM through JSON compatibility while RPC acknowledgements are held', async () => {
    const acknowledgement = createDeferred<void>();
    const receivedPcm: Uint8Array[] = [];
    machineRpcWithServerScopeMock.mockImplementation(async (input: Readonly<{ method: string; payload: unknown }>) => {
      if (input.method === 'daemon.voiceInference.stt.stream.start') {
        const request = DaemonVoiceInferenceSttStreamStartRequestSchema.parse(input.payload);
        return { ok: true, requestId: request.requestId, streamId: 'compat-stream', generation: 0, ackSeq: -1,
          format: request.format };
      }
      if (input.method === 'daemon.voiceInference.stt.stream.chunk') {
        const request = DaemonVoiceInferenceSttStreamChunkRequestSchema.parse(input.payload);
        receivedPcm.push(new Uint8Array(Buffer.from(request.pcm16Base64, 'base64')));
        await acknowledgement.promise;
        return { ok: true, streamId: request.streamId, generation: request.generation, ackSeq: request.seq, events: [] };
      }
      if (input.method === 'daemon.voiceInference.stt.stream.finish') {
        const request = DaemonVoiceInferenceSttStreamFinishRequestSchema.parse(input.payload);
        return { ok: true, streamId: request.streamId, generation: request.generation, ackSeq: request.finalSeq,
          finalText: 'complete capture', language: 'en', modelPackId: 'stt-pack-1', events: [] };
      }
      if (input.method === 'daemon.voiceInference.stt.stream.cancel') {
        return { ok: true, streamId: 'compat-stream', generation: 0 };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });
    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const sender = await new DaemonVoiceInferenceClient({ createRequestId: () => 'compat-held-ack' })
      .createStreamingSttSender({ packId: 'stt-pack-1', language: 'en' });
    expect(sender.transportKind).toBe('json_rpc_compat');
    try {
      await sender.start();
      const capture = Array.from({ length: 120 }, (_, frame) => new Uint8Array(640).fill(frame));
      const outcomes = Promise.allSettled(capture.map(pcm => sender.pushChunk(pcm)));
      acknowledgement.resolve();
      expect((await outcomes).filter(outcome => outcome.status === 'rejected')).toEqual([]);
      await expect(sender.finish()).resolves.toMatchObject({ ok: true, finalText: 'complete capture' });
      expect(Buffer.concat(receivedPcm)).toEqual(Buffer.concat(capture));
      expect(receivedPcm.some(pcm => pcm.byteLength > 640)).toBe(true);
    } finally {
      acknowledgement.resolve();
      await sender.cancel();
    }
  });

  it('reports JSON compatibility selection and can forbid it without sending stream RPCs', async () => {
    const recordStreamingSttTransportSelection = vi.fn();
    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const allowedClient = new DaemonVoiceInferenceClient({
      createRequestId: () => 'compat-request',
      recordStreamingSttTransportSelection,
    });
    const sender = await allowedClient.createStreamingSttSender({ packId: 'stt-pack-1', language: 'en' });
    expect(sender.transportKind).toBe('json_rpc_compat');
    expect(recordStreamingSttTransportSelection).toHaveBeenCalledWith(expect.objectContaining({
      transport: 'json_rpc_compat',
      sessionId: 'machine-1',
      machineId: 'machine-1',
    }));

    recordStreamingSttTransportSelection.mockClear();
    const forbiddenClient = new DaemonVoiceInferenceClient({
      createRequestId: () => 'forbidden-request',
      allowStreamingSttJsonRpcCompatibility: () => false,
      recordStreamingSttTransportSelection,
    });
    await expect(forbiddenClient.createStreamingSttSender({ packId: 'stt-pack-1', language: 'en' }))
      .rejects.toMatchObject({ code: 'stream_transport_unavailable' });
    expect(recordStreamingSttTransportSelection).toHaveBeenCalledWith(expect.objectContaining({
      transport: 'json_rpc_compat_forbidden',
    }));
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  it('keeps recorded-audio STT pinned to the selected daemon even when a session id targets another machine', async () => {
    bindUnrelatedSession('qa-session-target', 'machine-qa');
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.stt.upload.init') {
        const recipientKeyPair = createTransferRecipientKeyPair();
        return {
          success: true,
          uploadId: 'upload-qa',
          chunkSizeBytes: 1024,
          recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
        };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.chunk') {
        return { success: true };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.finalize') {
        return {
          success: true,
          uploadId: 'upload-qa',
          path: '/tmp/upload-qa.wav',
          sizeBytes: 5,
          sha256: 'abc',
        };
      }
      if (input.method === 'daemon.voiceInference.stt.transcribe') {
        return {
          ok: true,
          requestId: 'stt-qa',
          text: 'hello voice-home daemon',
          language: 'en',
          modelPackId: 'stt-pack-qa',
        };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.transcribeRecordedAudio({
      sessionId: 'qa-session-target',
      source: { kind: 'native', uri: 'file:///recording.wav', sizeBytes: 5 },
      inputMimeType: 'audio/wav',
      packId: 'stt-pack-qa',
      language: 'en',
    })).resolves.toEqual({
      text: 'hello voice-home daemon',
      language: 'en',
      modelPackId: 'stt-pack-qa',
    });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'machine-1',
      method: 'daemon.voiceInference.stt.transcribe',
    }));
  });

  it('uploads the admitted Chrome WebM file through the real web source reader', async () => {
    const source = {
      kind: 'web' as const,
      file: new File(
        [new Uint8Array(1_080)],
        'recording.webm',
        { type: 'audio/webm;codecs=opus' },
      ),
    };
    const recipientKeyPair = createTransferRecipientKeyPair();
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.stt.upload.init') {
        return {
          success: true,
          uploadId: 'upload-chrome-webm',
          chunkSizeBytes: 64 * 1024,
          recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
        };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.chunk') {
        return { success: true };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.finalize') {
        return {
          success: true,
          uploadId: 'upload-chrome-webm',
          path: '/tmp/upload-chrome-webm.webm',
          sizeBytes: 1_080,
          sha256: 'abc',
        };
      }
      if (input.method === 'daemon.voiceInference.stt.transcribe') {
        return {
          ok: true,
          requestId: 'stt-chrome-webm',
          text: 'open the project settings',
          language: 'en',
          modelPackId: 'stt-pack-qa',
        };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient({
      createRequestId: () => 'stt-chrome-webm',
    });
    selectMachine(null);

    await expect(client.transcribeRecordedAudio({
      sessionId: 'qa-session-target',
      machineTarget: { machineId: 'machine-ready-at-start' },
      source,
      inputMimeType: 'audio/webm;codecs=opus',
      packId: 'stt-pack-qa',
      language: 'en',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
    })).resolves.toEqual({
      text: 'open the project settings',
      language: 'en',
      modelPackId: 'stt-pack-qa',
    });

    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'machine-ready-at-start',
      method: 'daemon.voiceInference.stt.upload.init',
      payload: expect.objectContaining({
        sizeBytes: 1_080,
        inputMimeType: 'audio/webm;codecs=opus',
      }),
    }));
  });

  it('throws a machine-unreachable style error when the voice-home machine target cannot be resolved', async () => {
    selectMachine(null);

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.getStatus()).rejects.toMatchObject({
      message: 'daemon_voice_inference_machine_unreachable',
      code: 'machine_unreachable',
    });
  });

  it('lists, installs, removes, and refreshes daemon model status through the machine-scoped RPC namespace', async () => {
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.models.list') {
        return {
          ok: true,
          models: [
            {
              packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
              kind: 'tts_sherpa',
              model: 'kokoro',
              version: '2026-04-17',
              executionSupport: ['daemon'],
              installState: 'not_installed',
              progress: null,
              lastError: null,
              updatedAtMs: 1,
            },
          ],
        };
      }
      if (input.method === 'daemon.voiceInference.models.status') {
        return {
          ok: true,
          models: [
            {
              packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
              kind: 'tts_sherpa',
              model: 'kokoro',
              version: '2026-04-17',
              executionSupport: ['daemon'],
              installState: 'installing',
              progress: { phase: 'downloading', progress: 0.5, bytesDownloaded: 5, totalBytes: 10, message: null },
              lastError: null,
              updatedAtMs: 2,
            },
          ],
        };
      }
      if (input.method === 'daemon.voiceInference.models.install') {
        return {
          ok: true,
          model: {
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: '2026-04-17',
            executionSupport: ['daemon'],
            installState: 'installed',
            progress: null,
            lastError: null,
            updatedAtMs: 3,
          },
        };
      }
      if (input.method === 'daemon.voiceInference.models.remove') {
        return { ok: true };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.listModels()).resolves.toEqual([
      expect.objectContaining({
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        installState: 'not_installed',
      }),
    ]);
    await expect(client.getModelsStatus(['kokoro-82m-v1.0-onnx-q8-wasm'])).resolves.toEqual([
      expect.objectContaining({
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        installState: 'installing',
      }),
    ]);
    await expect(client.installModel({ packId: 'kokoro-82m-v1.0-onnx-q8-wasm' })).resolves.toMatchObject({
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      installState: 'installed',
    });
    await expect(client.removeModel('kokoro-82m-v1.0-onnx-q8-wasm')).resolves.toBeUndefined();
  });
});

afterAll(() => network.dispose());
