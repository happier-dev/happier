import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineFixture, createSessionFixture } from '@/dev/testkit';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { DaemonVoiceInferenceModelsStatusResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';
import type { BundledSpeechPreparation } from '@/voice/runtime/bundledSpeech/bundledSpeechRuntime';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import type { LocalVoiceTtsRequest } from './localVoiceTtsProviderControllers';

let account: Awaited<ReturnType<typeof serveAccountHomes>>;
let disconnect: (() => Promise<void>) | undefined;
const speechBoundary = createVoiceSpeechOutputBoundary({ getAccount: async () => {
  const home = account.homes.voice!;
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = await TokenStorage.getCredentialsForServerUrl(home.serverUrl);
  if (!credentials) throw new Error('TTS preference Account credentials unavailable');
  return { home, credentials };
} });
const { machineRpc, encodedAudio, daemonStreamStartRpc } = speechBoundary;
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { createDefaultLocalVoiceTtsProviderControllers } = await import('./localVoiceTtsProviderControllers');
const { createLocalVoiceTtsController } = await import('./localVoiceTtsController');
const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
const { previewLocalNeuralTts, localNeuralTtsPreviewController } = await import('@/voice/settings/panels/localTts/providers/localNeural/previewLocalNeuralTts');
const { voiceSettingsParse, readLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const initialSettings = storage.getState().settings;
const initialMachines = storage.getState().machines;
const initialMachineLists = storage.getState().machineListByServerId;
const initialSessions = storage.getState().sessions;
const statusReply = DaemonVoiceInferenceModelsStatusResponseSchema.parse({ ok: true, models: [{
  kind: 'tts_sherpa', packId: 'kokoro-82m-v1.0-onnx-q8-wasm', model: 'kokoro', version: '1',
  executionSupport: ['daemon'], runtimeFamily: 'sherpa_kokoro_offline', runtimeSupported: true,
  installState: 'installed', progress: null, lastError: null, updatedAtMs: 1,
  voices: [{ id: 'af_heart', title: 'Heart' }, { id: 'am_adam', title: 'Adam' }], defaultVoiceId: 'af_heart',
}] });
const serverFeatures = FeaturesResponseSchema.parse({ features: {
  voice: { enabled: true }, execution: { runs: { enabled: true } },
  machines: { enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } } },
}, capabilities: { machines: { liveStream: { serverRouted: { disabledReason: null, caps: {
  maxBitrateBps: 64_000, maxFramesPerSecond: 50, maxFrameBytes: 16_000,
  maxDurationMs: 60_000, maxTotalBytes: 1_000_000, maxConcurrentStreamsPerAccount: 2,
  maxConcurrentStreamsPerSocket: 1, maxConcurrentStreamsPerMachine: 1,
} } } } } });
let answerStatus: () => Promise<unknown>;
afterAll(() => speechBoundary.disposeAudioSession());

describe('local model Session voice consumption', () => {
  beforeEach(async () => {
    speechBoundary.reset();
    answerStatus = async () => statusReply;
    const speechRpc = machineRpc.getMockImplementation();
    machineRpc.mockImplementation(async request => request.method === 'daemon.voiceInference.models.status'
      ? answerStatus() : speechRpc?.(request));
    // The Account has no persisted Sessions; preferences below are later local projections.
    const sessionHttp = createSessionMetadataHttpBoundary(() => ({}));
    account = await serveAccountHomes({ homes: [{ key: 'voice', serverUrl: 'https://tts-preference.test', accountId: 'tts-account' }],
      route: async request => {
        const sessionReply = sessionHttp.handle(request.url);
        if (sessionReply) return sessionReply;
        const machineReply = speechBoundary.answerMachineHttpRequest(request.url, 'tts-machine', 'tts-account', request);
        if (machineReply) return machineReply;
        if (request.path === '/v1/features') return Response.json(serverFeatures);
        if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        return undefined;
      } });
    disconnect = await account.restoreActiveConnection();
    await sync.resumeSync('manual');
    const machine = createMachineFixture({ id: 'tts-machine', activeAt: Date.now() });
    storage.setState({ machines: { ...initialMachines, [machine.id]: machine },
      machineListByServerId: { ...initialMachineLists, [account.homes.voice!.id]: [machine] } });
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ experiments: true, featureToggles: {
      voice: true, 'execution.runs': true, 'voice.agent': true, 'voice.daemonInference': true,
    }, voice: { ...storage.getState().settings.voice,
      executionMachine: { mode: 'fixed', machineId: machine.id, autoMachineId: null } } }, storage.getState().settings));
  });

  afterEach(async () => {
    localNeuralTtsPreviewController.stop();
    await disconnect?.();
    disconnect = undefined;
    await account?.dispose();
    speechBoundary.disposeNativeSdkBridge();
    voiceSessionBindingStore.getState().unbind('speech-carrier');
    storage.setState({ settings: initialSettings, machines: initialMachines, machineListByServerId: initialMachineLists, sessions: initialSessions });
    resetServerFeaturesClientForTests();
  });
  function beginSpeak(value: string, current: () => boolean = () => true, speed: number | null = 1.2) {
    const voice = voiceSettingsParse({ providerId: 'local_conversation' });
    const cfg = readLocalConversationVoiceSettings(voice);
    const applied = vi.fn();
    const speaking = vi.fn();
    const failed = vi.fn();
    const preparation: BundledSpeechPreparation = {
      targetSessionAddress: null, isCurrent: current, onVoiceApplied: applied,
      preference: { providerContributionId: 'happier.voice.builtin/local-neural', settingFieldPath: 'voiceId', value },
    };
    const request: LocalVoiceTtsRequest = {
      text: 'hello', settings: { voice }, networkTimeoutMs: 15000,
      tts: { ...cfg.tts, provider: 'local_neural', localNeural: { ...cfg.tts.localNeural,
        assetId: 'kokoro-82m-v1.0-onnx-q8-wasm', execution: 'daemon', voiceId: 'af_heart', speed } },
      registerPlaybackStopper: () => () => {}, onSpeaking: speaking, onTtsFailed: failed,
      preparation,
    };
    const pending = createDefaultLocalVoiceTtsProviderControllers().get('local_neural')!.speak(request);
    return { applied, failed, speaking, request, pending };
  }

  async function speak(value: string, current: () => boolean = () => true, speed: number | null = 1.2) {
    const result = beginSpeak(value, current, speed);
    await result.pending;
    return result;
  }

  it.each(['direct', 'bound', 'global', 'inherit', 'foreign_home'] as const)(
    'resolves %s Session selection through the real TTS entry point before its first synthesis', async mode => {
      const homeId = account.homes.voice!.id;
      const target = createSessionFixture({ id: 'speech-target', serverId: mode === 'foreign_home' ? 'other-home' : homeId, metadata: {
        path: '/speech-target', host: 'voice.test', work: { voicePreference: {
          providerContributionId: 'happier.voice.builtin/local-neural', settingFieldPath: 'voiceId', value: 'am_adam',
        } },
      } });
      const carrier = createSessionFixture({ id: 'speech-carrier', serverId: homeId, metadata: target.metadata });
      storage.setState({ sessions: { ...initialSessions, [target.id]: target, [carrier.id]: carrier } });
      if (mode === 'bound' || mode === 'global') voiceSessionBindingStore.getState().bind({
        adapterId: 'local_conversation', controlSessionId: carrier.id, conversationSessionId: carrier.id,
        conversationSessionAddress: { serverId: homeId, sessionId: carrier.id }, transcriptMode: 'synthetic',
        targetSessionAddress: mode === 'bound' ? { serverId: homeId, sessionId: target.id } : null, updatedAt: 1,
      });
      if (mode === 'inherit') storage.setState({ sessions: { ...storage.getState().sessions,
        [target.id]: createSessionFixture({ ...target, metadata: { path: '/speech-target', host: 'voice.test' } }),
      } });
      const cfg = readLocalConversationVoiceSettings(voiceSettingsParse({ providerId: 'local_conversation' }));
      const failed = vi.fn();
      await createLocalVoiceTtsController().speak({
        sessionId: mode === 'bound' || mode === 'global' ? carrier.id : target.id,
        text: 'first spoken reply', settings: storage.getState().settings,
        tts: { ...cfg.tts, provider: 'local_neural', localNeural: { ...cfg.tts.localNeural,
          assetId: 'kokoro-82m-v1.0-onnx-q8-wasm', execution: 'daemon', voiceId: 'af_heart', speed: 1.2 } },
        networkTimeoutMs: 15000, registerPlaybackStopper: () => () => {}, onSpeaking: () => {}, onTtsFailed: failed,
      });
      if (mode === 'foreign_home') {
        expect(failed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tts_failed', reason: 'session_metadata_unavailable' }));
        expect(daemonStreamStartRpc).not.toHaveBeenCalled();
        expect(encodedAudio.start).not.toHaveBeenCalled();
        return;
      }
      expect(failed).not.toHaveBeenCalled();
      expect(daemonStreamStartRpc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        voiceId: mode === 'direct' || mode === 'bound' ? 'am_adam' : 'af_heart', speed: 1.2,
      }));
      expect(encodedAudio.start).toHaveBeenCalledOnce();
    },
  );

  it('retires direct Session speech if its qualified metadata disappears during the catalog read', async () => {
    const target = createSessionFixture({ id: 'speech-target', serverId: account.homes.voice!.id, metadata: {
      path: '/speech-target', host: 'voice.test', work: { voicePreference: {
        providerContributionId: 'happier.voice.builtin/local-neural', settingFieldPath: 'voiceId', value: 'am_adam',
      } },
    } });
    storage.setState({ sessions: { ...initialSessions, [target.id]: target } });
    const catalog = createDeferred<unknown>();
    const readingCatalog = createDeferred<void>();
    answerStatus = () => { readingCatalog.resolve(); return catalog.promise; };
    const cfg = readLocalConversationVoiceSettings(voiceSettingsParse({ providerId: 'local_conversation' }));
    const failed = vi.fn();
    const pending = createLocalVoiceTtsController().speak({
      sessionId: target.id, text: 'retired reply', settings: storage.getState().settings,
      tts: { ...cfg.tts, provider: 'local_neural', localNeural: { ...cfg.tts.localNeural,
        assetId: 'kokoro-82m-v1.0-onnx-q8-wasm', execution: 'daemon', voiceId: 'af_heart' } },
      networkTimeoutMs: 15000, registerPlaybackStopper: () => () => {}, onSpeaking: () => {}, onTtsFailed: failed,
    });
    await readingCatalog.promise;
    expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.voiceInference.models.status' }));
    storage.setState({ sessions: initialSessions });
    catalog.resolve(statusReply);
    await pending;
    expect(daemonStreamStartRpc).not.toHaveBeenCalled();
    expect(encodedAudio.start).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it('uses the chosen installed voice without changing model/speed and publishes it only after audio starts', async () => {
    let startPhysicalAudio!: () => void;
    const playbackReady = createDeferred<void>();
    encodedAudio.start.mockImplementationOnce(async () => {
      startPhysicalAudio = () => { encodedAudio.emit('started'); encodedAudio.emit('finished'); };
      playbackReady.resolve();
    });
    const result = beginSpeak('am_adam');
    await playbackReady.promise;
    expect(startPhysicalAudio).toBeTypeOf('function');
    expect(result.applied).not.toHaveBeenCalled();
    expect(result.speaking).not.toHaveBeenCalled();
    expect(daemonStreamStartRpc).toHaveBeenCalledWith(expect.objectContaining({ voiceId: 'am_adam', speed: 1.2,
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm' }));
    startPhysicalAudio();
    await result.pending;
    expect(result.failed).not.toHaveBeenCalled();
    expect(result.applied).toHaveBeenCalledWith(expect.objectContaining({ value: 'am_adam', displayName: 'Adam' }));
    expect(result.speaking).toHaveBeenCalledOnce();
    expect(result.request.tts.localNeural.voiceId).toBe('af_heart');
  });

  it.each([
    { speed: null, expected: 1 },
    { speed: 1.2, expected: 1.2 },
    { speed: Number.NaN, expected: 1 },
    { speed: Number.POSITIVE_INFINITY, expected: 1 },
  ])('previews the same effective speed as runtime for $speed without rewriting stored options', async ({ speed, expected }) => {
    const { request, failed } = await speak('am_adam', () => true, speed);
    expect(failed).not.toHaveBeenCalled();
    expect(daemonStreamStartRpc).toHaveBeenLastCalledWith(expect.objectContaining({ speed: expected }));
    await previewLocalNeuralTts({ config: { ...request.tts.localNeural, voiceId: 'am_adam' },
      sample: 'preview', timeoutMs: request.networkTimeoutMs,
      registerPlaybackStopper: () => () => {} });
    expect(daemonStreamStartRpc).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'preview', speed: expected }));
    expect(request.tts.localNeural.speed).toBe(speed);
  });

  it('refuses a removed voice rather than playing the account default', async () => {
    const result = await speak('removed');
    expect(result.failed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tts_failed', reason: 'voice_missing' }));
    expect(daemonStreamStartRpc).not.toHaveBeenCalled();
    expect(encodedAudio.start).not.toHaveBeenCalled();
    expect(result.applied).not.toHaveBeenCalled();
  });

  it('does not synthesize or publish when the captured attempt is no longer current', async () => {
    const result = await speak('am_adam', () => false);
    expect(daemonStreamStartRpc).not.toHaveBeenCalled();
    expect(encodedAudio.start).not.toHaveBeenCalled();
    expect(result.applied).not.toHaveBeenCalled();
  });

  it('retires an awaited catalog result before synthesis when its attempt changes', async () => {
    let current = true;
    const catalog = createDeferred<unknown>();
    const readingCatalog = createDeferred<void>();
    answerStatus = () => { readingCatalog.resolve(); return catalog.promise; };
    const result = beginSpeak('am_adam', () => current);
    await readingCatalog.promise;
    expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.voiceInference.models.status' }));
    current = false;
    catalog.resolve(statusReply);
    await result.pending;
    expect(result.failed).not.toHaveBeenCalled();
    expect(daemonStreamStartRpc).not.toHaveBeenCalled();
    expect(encodedAudio.start).not.toHaveBeenCalled();
    expect(result.applied).not.toHaveBeenCalled();
  });

  it('previews a catalog-only local voice through the shared preview owner and real local speech path', async () => {
    const cfg = readLocalConversationVoiceSettings(voiceSettingsParse({ providerId: 'local_conversation' }));
    const attempt = localNeuralTtsPreviewController.begin('am_adam');
    try {
      await previewLocalNeuralTts({ config: { ...cfg.tts.localNeural, execution: 'daemon', voiceId: 'am_adam' },
        sample: 'preview', timeoutMs: cfg.networkTimeoutMs, ...attempt });
    } finally {
      attempt.finish();
    }
    expect(daemonStreamStartRpc).toHaveBeenCalledWith(expect.objectContaining({ voiceId: 'am_adam', text: 'preview' }));
    expect(encodedAudio.start).toHaveBeenCalledOnce();
    expect(localNeuralTtsPreviewController.read()).toBeNull();
  });

  it('stops a local preview while synthesis is pending without starting late audio', async () => {
    const cfg = readLocalConversationVoiceSettings(voiceSettingsParse({ providerId: 'local_conversation' }));
    let releaseSynthesis!: () => void;
    const synthesis = createDeferred<void>();
    const synthesizing = createDeferred<void>();
    daemonStreamStartRpc.mockImplementationOnce(() => { synthesizing.resolve(); return synthesis.promise; });
    releaseSynthesis = () => synthesis.resolve();
    const attempt = localNeuralTtsPreviewController.begin('am_adam');
    const pending = previewLocalNeuralTts({ config: { ...cfg.tts.localNeural, execution: 'daemon', voiceId: 'am_adam' },
      sample: 'preview', timeoutMs: cfg.networkTimeoutMs, ...attempt }).finally(attempt.finish);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await synthesizing.promise;
    expect(daemonStreamStartRpc).toHaveBeenCalled();
    expect(localNeuralTtsPreviewController.stop()).toBe(true);
    releaseSynthesis();
    await cancelled;
    expect(encodedAudio.start).not.toHaveBeenCalled();
    expect(localNeuralTtsPreviewController.read()).toBeNull();
  });
});
