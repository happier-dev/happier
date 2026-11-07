import { vi } from 'vitest';
import { installOptionalNativeModuleForTests } from '@/dev/expoModulesCoreStub';
import Module, { createRequire } from 'node:module';
import { installDisconnectedServerSocketBoundary } from './serverAccountConnectionHarness';
import { createPlainMachineRowFixture } from '../fixtures/machineFixtures';
import { MachineReadBatchRequestV1Schema, MachineReadBatchResponseV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import { createNativeVoicePcmCaptureHarness } from './nativeVoicePcmCapture';
import { getSharedVoiceAudioSessionCoordinator } from '@happier-dev/audio-stream-native';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { DaemonVoiceInferenceTtsStreamStartResponseSchema, DaemonVoiceInferenceTtsStreamNextResponseSchema,
  DaemonVoiceInferenceTtsStreamAckResponseSchema, DaemonVoiceInferenceTtsStreamCancelResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { DaemonVoiceSpeechSynthesizeRequestSchema, DaemonVoiceSpeechSynthesizeResponseSchema,
  DaemonVoiceSpeechDownloadChunkResponseSchema, type DaemonVoiceSpeechSynthesizeRequest } from '@happier-dev/protocol/daemon/voiceSpeech';
import type { VoiceProviderOperationErrorCode } from '@happier-dev/protocol/voice/providerOperations';
import type { SessionVoicePreferenceV1 } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import { createMemFs } from '@/voice/modelPacks/installerTestFs';
import type { SherpaNativeSynthesizeParams, SherpaNativeInitializeParams, SherpaNativeCancelInitializationParams,
  SherpaNativeCancelParams, SherpaNativeListVoicesParams, SherpaNativeVoice } from '@happier-dev/sherpa-native';
import { createVoiceEncodedAudioNativeBoundary } from './voiceEncodedAudioNativeBoundary';
import type { HappierAudioStreamNativeModule, VoiceFileRecordingStopResult } from '../../../../../../packages/audio-stream-native/src/HappierAudioStreamNative.types';
import type { SpeechOptions } from 'expo-speech';

type SpeechAccountTransport = Readonly<{ home: { id: string; serverUrl: string }; credentials: { token: string } }>;
let currentAccount: () => SpeechAccountTransport | Promise<SpeechAccountTransport>;
// Only native SDK/OS and authenticated network replies are substituted here.
// Account restoration, feature policy, clients, crypto, installer and playback stay real.
const platformOsMock = vi.hoisted(() => ({ value: 'ios' }));
const nativeEncodedAudio = createVoiceEncodedAudioNativeBoundary();
const encodedAudio = { ...nativeEncodedAudio, emit: (status: Parameters<typeof nativeEncodedAudio.emit>[0]['status'], playbackId?: string) => nativeEncodedAudio.emit({ status, playbackId }) };
const fileRecording = vi.hoisted(() => ({
  start: vi.fn<NonNullable<HappierAudioStreamNativeModule['startFileRecording']>>(async () => ({ recordingId: 'local-engine-recording' })),
  setMuted: vi.fn<NonNullable<HappierAudioStreamNativeModule['setFileRecordingMuted']>>(async () => {}),
  stop: vi.fn<(params: Readonly<{ recordingId: string }>) => Promise<unknown>>(async () => ({ uri: 'file:///recording.m4a' })),
}));
const fileRecordingListeners = new Set<(event: 'start' | 'stop') => void>();
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary((socket, serverUrl) => {
  vi.mocked(socket.connect).mockImplementation(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  // A pooled external Socket retains this network adapter through spy cleanup.
  socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload: unknown) => {
    if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
      throw new Error('Expected a framed daemon RPC');
    }
    const account = await currentAccount();
    const token = typeof socket.auth === 'object' && 'token' in socket.auth ? socket.auth.token : undefined;
    if (serverUrl !== account.home.serverUrl || token !== account.credentials.token) throw new Error('Expected admitted speech Account transport');
    const separator = payload.method.indexOf(':');
    return { ok: true, result: await machineRpc({ machineId: payload.method.slice(0, separator),
      serverId: account.home.id, method: payload.method.slice(separator + 1), payload: payload.params }) };
  });
});
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: {
      get OS() {
        return platformOsMock.value;
      },
    },
  });
});

// The app registry resolves one SDK module per JS lifetime. Keep that module
// stable across behaviors; reset only its OS observations, not internal owners.
const audioSession = createNativeVoicePcmCaptureHarness();
const nativeAudioModule = encodedAudio.nativeModule({ ...audioSession.nativeModule,
  startFileRecording: (...args) => {
    const starting = fileRecording.start(...args);
    for (const listener of fileRecordingListeners) listener('start');
    return starting;
  },
  setFileRecordingMuted: fileRecording.setMuted,
  stopFileRecording: async params => {
    // The untyped OS bridge also supplies malformed replies in failure tests;
    // preserve them for the actual file-recorder's validation, not this fixture.
    const stopping = fileRecording.stop(params);
    for (const listener of fileRecordingListeners) listener('stop');
    return await stopping as VoiceFileRecordingStopResult;
  },
});
const restoreNativeAudioModule = installOptionalNativeModuleForTests('HappierAudioStreamNative', nativeAudioModule);
const expoSpeechSpeak = vi.fn<(text: string, options: SpeechOptions) => void>();
const expoSpeechStop = vi.fn();
const speechListeners = new Set<(event: 'speak' | 'stop') => void>();
vi.mock('expo-speech', () => ({
  speak: (text: string, options: SpeechOptions) => {
    const result = expoSpeechSpeak(text, options);
    for (const listener of [...speechListeners]) listener('speak');
    return result;
  },
  stop: () => {
    const result = expoSpeechStop();
    for (const listener of [...speechListeners]) listener('stop');
    return result;
  },
}));

let filesystem: ReturnType<typeof createMemFs>;
vi.mock('expo-file-system', () => ({
  Paths: { document: 'file:///docs', cache: 'file:///cache' },
  Directory: class {
    constructor(...args: unknown[]) { return new filesystem.fs.Directory(...args); }
  },
  File: class {
    constructor(...args: unknown[]) { return new filesystem.fs.File(...args); }
  },
}));
const nativeInitialize = vi.hoisted(() => vi.fn<(params: SherpaNativeInitializeParams) => Promise<void>>(async () => {}));
const nativeCancelInitialization = vi.hoisted(() => vi.fn<(params: SherpaNativeCancelInitializationParams) => Promise<void>>(async () => {}));
const nativeCancel = vi.hoisted(() => vi.fn<(params: SherpaNativeCancelParams) => Promise<void>>(async () => {}));
const nativeListVoices = vi.hoisted(() => vi.fn<(params: SherpaNativeListVoicesParams) => Promise<SherpaNativeVoice[]>>(async () => [{ id: 'af_heart', title: 'Heart', sid: 0 }]));
const nativeSynthesize = vi.fn<(params: SherpaNativeSynthesizeParams) => Promise<{ wavPath: string; sampleRate: number }>>();
let nativeAvailable = true;
const sherpaNative = { initialize: nativeInitialize, cancelInitialization: nativeCancelInitialization,
  listVoices: nativeListVoices, synthesizeToWavFile: nativeSynthesize, cancel: nativeCancel };
const getOptionalHappierSherpaNativeModule = () => nativeAvailable ? sherpaNative : null;
vi.mock('@happier-dev/sherpa-native', () => ({ getOptionalHappierSherpaNativeModule }));
// Node selects portable sentinels; bind complete real native exports, not policy.
vi.mock('@/voice/settings/voiceDeviceModelPackOperation', () => import('@/voice/settings/voiceDeviceModelPackOperation.native'));
vi.mock('@/voice/kokoro/runtime/synthesizeKokoroWav', () => import('@/voice/kokoro/runtime/synthesizeKokoroWav.native'));
vi.mock('@/voice/kokoro/assets/readInstalledKokoroVoices', () => import('@/voice/kokoro/assets/readInstalledKokoroVoices.native'));
const nativeRequire = createRequire(import.meta.url);
const nativeModuleId = nativeRequire.resolve('@happier-dev/sherpa-native');
let priorNativeModule: NodeJS.Module | undefined;
let nativeSdkBridgeInstalled = false;

type SpeechReply = { bytes: Uint8Array; mimeType: string; appliedVoice?: SessionVoicePreferenceV1 | null }
  | { errorCode: VoiceProviderOperationErrorCode };
const speechSynthesizeRpc = vi.fn<(input: DaemonVoiceSpeechSynthesizeRequest) => Promise<SpeechReply>>();

const daemonStreamStartRpc = vi.fn().mockResolvedValue(undefined);

export function createVoiceSpeechOutputBoundary(input: Readonly<{ getAccount: () => SpeechAccountTransport | Promise<SpeechAccountTransport> }>) {
  currentAccount = input.getAccount;
  return {
    platform: platformOsMock, encodedAudio, fileRecording, machineRpc, expoSpeechSpeak, expoSpeechStop,
    subscribeSpeech(listener: (event: 'speak' | 'stop') => void) {
      speechListeners.add(listener);
      return () => { speechListeners.delete(listener); };
    },
    subscribeFileRecording(listener: (event: 'start' | 'stop') => void) {
      fileRecordingListeners.add(listener);
      return () => { fileRecordingListeners.delete(listener); };
    },
    nativeInitialize, nativeSynthesize, nativeCancelInitialization, nativeCancel, nativeListVoices,
    native: sherpaNative,
    getAudioSessionCoordinator() {
      const coordinator = getSharedVoiceAudioSessionCoordinator();
      if (!coordinator) throw new Error('Native SDK audio coordinator unavailable');
      return coordinator;
    },
    async disposeAudioSession() {
      await getSharedVoiceAudioSessionCoordinator()?.dispose();
      await audioSession.coordinator.dispose();
      restoreNativeAudioModule();
    },
    speechSynthesizeRpc, daemonStreamStartRpc,
    setNativeAvailable(available: boolean) { nativeAvailable = available; },
    setRecorderUri(uri: string | null) { fileRecording.stop.mockResolvedValue({ uri }); },
    disposeNativeSdkBridge() {
      if (!nativeSdkBridgeInstalled) return;
      if (priorNativeModule) nativeRequire.cache[nativeModuleId] = priorNativeModule;
      else delete nativeRequire.cache[nativeModuleId];
      nativeSdkBridgeInstalled = false;
    },
    reset() {
      nativeAvailable = true;
      if (!nativeSdkBridgeInstalled) priorNativeModule = nativeRequire.cache[nativeModuleId];
      // Vitest's ESM mocks do not replace CJS SDK discovery. Substitute only
      // this external package cache entry, leaving actual native support real.
      const sdk = new Module(nativeModuleId);
      sdk.exports = { getOptionalHappierSherpaNativeModule };
      nativeRequire.cache[nativeModuleId] = sdk;
      nativeSdkBridgeInstalled = true;
      filesystem = createMemFs();
      vi.mocked(audioSession.nativeModule.configureAudioSession).mockClear();
      vi.mocked(audioSession.nativeModule.restoreAudioSession).mockClear();
      encodedAudio.start.mockReset();
      encodedAudio.stop.mockClear();
      encodedAudio.start.mockImplementation(async () => { encodedAudio.emit('started'); encodedAudio.emit('finished'); });
      fileRecording.start.mockReset();
      fileRecording.start.mockResolvedValue({ recordingId: 'local-engine-recording' });
      fileRecording.setMuted.mockReset();
      fileRecording.setMuted.mockResolvedValue(undefined);
      fileRecording.stop.mockReset();
      fileRecording.stop.mockResolvedValue({ uri: 'file:///recording.m4a' });
      expoSpeechStop.mockReset();
      expoSpeechStop.mockResolvedValue(undefined);
      nativeInitialize.mockReset();
      nativeInitialize.mockResolvedValue(undefined);
      nativeCancelInitialization.mockReset();
      nativeCancelInitialization.mockResolvedValue(undefined);
      nativeCancel.mockReset();
      nativeCancel.mockResolvedValue(undefined);
      nativeListVoices.mockReset();
      nativeListVoices.mockResolvedValue([{ id: 'af_heart', title: 'Heart', sid: 0 }]);
      let segmentProduced = false;
      let daemonText = '';
      let encryptedSpeech: Awaited<ReturnType<typeof import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption')['createEncryptedTransferChunkEnvelope']>> | undefined;
      machineRpc.mockReset();
      machineRpc.mockImplementation(async (request: { method: string; payload: { requestId?: string; text?: string; segmentIndex?: number } }) => {
        const output = { codec: 'wav', mimeType: 'audio/wav' };
        if (request.method === 'daemon.voiceInference.tts.stream.start') {
          await daemonStreamStartRpc(request.payload);
          daemonText = request.payload.text ?? '';
          segmentProduced = false;
          return DaemonVoiceInferenceTtsStreamStartResponseSchema.parse({ ok: true, requestId: request.payload.requestId,
            streamId: 'speech-stream', generation: 0, segmentCount: 1, output });
        }
        if (request.method === 'daemon.voiceInference.tts.stream.next') {
          const event = segmentProduced ? { type: 'done', streamId: 'speech-stream', generation: 0 } : {
            type: 'segment', streamId: 'speech-stream', generation: 0, segmentId: 'speech-segment',
            segmentIndex: 0, segmentCount: 1, text: daemonText, textRange: { start: 0, end: daemonText.length },
            textHash: 'speech-hash', output, audio: { contentBase64: 'AQ==', sizeBytes: 1 }, isLastSegment: true,
          };
          segmentProduced = true;
          return DaemonVoiceInferenceTtsStreamNextResponseSchema.parse({ ok: true, streamId: 'speech-stream', generation: 0, event });
        }
        if (request.method === 'daemon.voiceInference.tts.stream.ack') return DaemonVoiceInferenceTtsStreamAckResponseSchema.parse({
          ok: true, streamId: 'speech-stream', generation: 0, ackedSegmentIndex: request.payload.segmentIndex, complete: true });
        if (request.method === 'daemon.voiceInference.tts.stream.cancel') return DaemonVoiceInferenceTtsStreamCancelResponseSchema.parse({
          ok: true, streamId: 'speech-stream', generation: 0, cancelled: true });
        if (request.method === 'daemon.voice.speech.synthesize') {
          const input = DaemonVoiceSpeechSynthesizeRequestSchema.parse(request.payload);
          const result = await speechSynthesizeRpc(input);
          if ('errorCode' in result) return DaemonVoiceSpeechSynthesizeResponseSchema.parse({ ok: false, errorCode: result.errorCode });
          const { createEncryptedTransferChunkEnvelope } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption');
          encryptedSpeech = await createEncryptedTransferChunkEnvelope({ transferId: 'speech-download', sequence: 0,
            payload: result.bytes, recipientPublicKeyBase64: input.recipientPublicKeyBase64 });
          return DaemonVoiceSpeechSynthesizeResponseSchema.parse({ ok: true, requestId: input.requestId,
            downloadId: 'speech-download', sizeBytes: result.bytes.byteLength, chunkSizeBytes: result.bytes.byteLength,
            mimeType: result.mimeType, ...('appliedVoice' in result ? { appliedVoice: result.appliedVoice }
              : input.voicePreference ? { appliedVoice: input.voicePreference } : {}) });
        }
        if (request.method === 'daemon.voice.speech.download.chunk') {
          if (!encryptedSpeech) throw new Error('Speech download was not initialized');
          return DaemonVoiceSpeechDownloadChunkResponseSchema.parse({ success: true, ...encryptedSpeech, isLast: true });
        }
        if (request.method === 'daemon.voice.speech.download.finalize' || request.method === 'daemon.voice.speech.download.abort') return { success: true };
        throw new Error(`Unexpected speech RPC: ${request.method}`);
      });
      expoSpeechSpeak.mockReset();
      expoSpeechSpeak.mockImplementation((_text, options) => { options.onStart?.(); options.onDone?.(); });
      nativeSynthesize.mockReset();
      nativeSynthesize.mockImplementation(async params => {
        if (!params.outWavPath) throw new Error('Expected native output path');
        filesystem.files.set(`file://${params.outWavPath}`, new Uint8Array([1]));
        return { wavPath: params.outWavPath, sampleRate: 24_000 };
      });
      daemonStreamStartRpc.mockReset();
      daemonStreamStartRpc.mockResolvedValue(undefined);
      speechSynthesizeRpc.mockReset();
      speechSynthesizeRpc.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: 'audio/mpeg' });
      return { filesystem, audioSession };
    },
    holdNextPlayback(kind: 'device' | 'encoded') {
      let release = () => {};
      let started!: () => void;
      const startObserved = new Promise<void>(resolve => { started = resolve; });
      if (kind === 'device') expoSpeechSpeak.mockImplementationOnce((_text, options) => {
        options.onStart?.(); started(); release = () => options.onDone?.();
      });
      else encodedAudio.start.mockImplementationOnce(async () => {
        encodedAudio.emit('started'); started(); release = () => encodedAudio.emit('finished');
      });
      return Object.assign(() => release(), { started: startObserved });
    },
    failNextSynthesis(errorCode: VoiceProviderOperationErrorCode = 'provider_response_invalid') {
      speechSynthesizeRpc.mockResolvedValueOnce({ errorCode });
    },
    answerMachineHttpRequest(input: URL | RequestInfo, machineId: string, accountId: string,
      init?: Readonly<{ method?: string; body?: unknown }>) {
      const path = new URL(String(input)).pathname;
      const row = createPlainMachineRowFixture({ id: machineId, accountId });
      if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
        const request = MachineReadBatchRequestV1Schema.parse(typeof init.body === 'string' ? JSON.parse(init.body) : init.body);
        return Response.json(MachineReadBatchResponseV1Schema.parse({ results: request.machineIds.map(id => id === machineId
          ? { machineId: id, status: 'found', machine: row }
          : { machineId: id, status: 'not_found' }) }));
      }
      if (path === '/v1/machines') return Response.json([row]);
      if (path === '/v1/machines/' + machineId) return Response.json({ machine: row });
      if (path === '/v1/machines/' + machineId + '/access') return Response.json({ machineId,
        custodian: row.access!.custodian, access: row.access, canManage: true,
        grants: [], ownDirectGrant: false, ownAccessSources: [] });
      return null;
    },
  };
}

