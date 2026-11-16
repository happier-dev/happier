import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createSessionFixture, createHydratedPlainMachineFixture } from '@/dev/testkit';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { publishMachineActivityForTest } from '@/dev/testkit/harness/machinePresence';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import { parseModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import { DaemonVoiceSpeechSynthesizeRequestSchema } from '@happier-dev/protocol/daemon/voiceSpeech';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

const speechBoundary = createVoiceSpeechOutputBoundary({ getAccount: () => account });
afterAll(() => speechBoundary.disposeAudioSession());
const { platform: platformOsMock, encodedAudio, machineRpc, expoSpeechSpeak, expoSpeechStop,
  nativeInitialize, nativeSynthesize, speechSynthesizeRpc, daemonStreamStartRpc } = speechBoundary;
let filesystem: ReturnType<typeof speechBoundary.reset>['filesystem'];

import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';
import { storage } from '@/sync/domains/state/storage';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
const initialSettings = storage.getState().settings;
const initialMachines = storage.getState().machines;
const initialMachineLists = storage.getState().machineListByServerId;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
const speechServerFeatures = FeaturesResponseSchema.parse({ features: {
  voice: { enabled: true }, execution: { runs: { enabled: true } },
  machines: { enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } } },
}, capabilities: { machines: { liveStream: { serverRouted: { disabledReason: null, caps: {
  maxBitrateBps: 64_000, maxFramesPerSecond: 50, maxFrameBytes: 16_000,
  maxDurationMs: 60_000, maxTotalBytes: 1_000_000, maxConcurrentStreamsPerAccount: 2,
  maxConcurrentStreamsPerSocket: 1, maxConcurrentStreamsPerMachine: 1,
} } } } } });

describe('speakAssistantText', () => {
  beforeEach(async () => {
    filesystem = speechBoundary.reset().filesystem;
    account = await restoreServerAccountForTest({ serverUrl: 'https://speech-output.example.test',
      accountId: 'speech-account', credentialScope: 'restored-home', request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/health') return Response.json({ status: 'ok' });
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        const machineResponse = speechBoundary.answerMachineHttpRequest(url, 'speech-machine', 'speech-account', init);
        if (machineResponse) return machineResponse;
        if (path === '/v1/features') return Response.json(speechServerFeatures);
        return null;
      } });
    const manifest = parseModelPackManifest({ packId: 'kokoro-output-contract', kind: 'tts_sherpa', model: 'kokoro', version: '1',
      frontend: { lang: 'en' }, voices: [{ id: 'af_heart', title: 'Heart', sid: 0 }], defaultVoiceId: 'af_heart',
      files: [{ path: 'model.onnx', url: 'https://example.test/model.onnx', sha256: 'a'.repeat(64), sizeBytes: 1 }] });
    filesystem.files.set(`${filesystem.root}/kokoro-output-contract/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: {
      voice: true, 'execution.runs': true, 'voice.agent': true, 'voice.daemonInference': true,
    } });
    primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: {
      status: 'ready', features: speechServerFeatures,
    } });
    const machine = createHydratedPlainMachineFixture({ id: 'speech-machine', accountId: 'speech-account', machine: { activeAt: Date.now() } });
    publishMachineActivityForTest([machine]);
    storage.setState({ machines: { ...initialMachines, [machine.id]: machine },
      machineListByServerId: { ...initialMachineLists, [account.home.id]: [machine] } });
    storage.getState().applySettingsLocal({ voice: { ...storage.getState().settings.voice,
      executionMachine: { ...storage.getState().settings.voice.executionMachine, mode: 'fixed', machineId: machine.id } } });
  });

  afterEach(async () => {
    speechBoundary.disposeNativeSdkBridge();
    await account?.dispose();
    storage.setState({ settings: initialSettings, machines: initialMachines, machineListByServerId: initialMachineLists });
    resetServerFeaturesClientForTests();
    platformOsMock.value = 'ios';
  });

  it.each([
    ['**Done.** See [the PR](https://example.test/pull/1).\n```ts\nconst a = 1;\n```', 'Done. See the PR.'],
    ['```sh\nls -la\n```', ''],
    ['Call `f(*args, **kwargs)`.', 'Call f(*args, **kwargs).'],
    ['See [`parser`](https://example.test/docs) and literal `[x](url)`.', 'See parser and literal [x](url).'],
  ])('normalizes complete assistant speech before provider dispatch: %s', async (text, spoken) => {
    await speakAssistantText({ text, settings: { voice: { providerId: 'local_direct', providers: {
      local_direct: { schemaVersion: 1, config: { tts: { provider: 'device' } } },
    } } }, networkTimeoutMs: 15_000, registerPlaybackStopper: () => () => {}, onSpeaking: () => {} });

    if (spoken) expect(expoSpeechSpeak).toHaveBeenCalledWith(spoken, expect.anything());
    else expect(expoSpeechSpeak).not.toHaveBeenCalled();
  });

  it('trims the voice provider id before selecting the TTS adapter', async () => {
    expoSpeechSpeak.mockClear();

    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      text: 'hello',
      settings: {
        voice: {
          providerId: ' local_direct ',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'device',
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
            local_conversation: { schemaVersion: 1, config: {
              tts: {
                provider: 'happier.voice.openai-compat/tts',
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(expoSpeechSpeak).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ onStart: expect.any(Function), onDone: expect.any(Function) }),
    );
    expect(onSpeaking).toHaveBeenCalledOnce();
  });

  it('routes device TTS provider to expo speech', async () => {
    const onSpeaking = vi.fn();
    let stopper: (() => void) | null = null;
    const registerPlaybackStopper = (s: () => void) => {
      stopper = s;
      return () => {};
    };

    await speakAssistantText({
      text: 'hello',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'device',
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(expoSpeechSpeak).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ onStart: expect.any(Function), onDone: expect.any(Function) }),
    );
    expect(onSpeaking).toHaveBeenCalledOnce();
    expect(typeof stopper).toBe('function');
  });

  it('routes local_neural (Kokoro model) provider to speakKokoroText', async () => {
    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      text: 'hello',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'local_neural',
                localNeural: { model: 'kokoro', assetId: 'kokoro-output-contract', voiceId: 'af_heart', speed: 1, execution: 'device' },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(nativeSynthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'hello',
        voiceId: 'af_heart',
      }),
    );
  });

  it('rejects delayed local-neural playback from a stopped attempt without poisoning restarted playback', async () => {
    const execution = createDeferred<void>();
    const initializing = createDeferred<void>();
    nativeInitialize.mockImplementationOnce(() => { initializing.resolve(); return execution.promise; });
    const controller = createVoicePlaybackController();
    const staleOnSpeaking = vi.fn();
    const restartedOnSpeaking = vi.fn();
    expoSpeechSpeak.mockImplementationOnce((_text, options) => {
      options.onStart?.(); options.onDone?.();
    });

    const staleAttempt = speakAssistantText({
      text: 'stale local neural reply',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'local_neural',
                localNeural: { model: 'kokoro', assetId: 'kokoro-output-contract', voiceId: 'af_heart', speed: 1, execution: 'device' },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15_000,
      registerPlaybackStopper: controller.registerStopper,
      onSpeaking: staleOnSpeaking,
    });
    await initializing.promise;
    expect(nativeInitialize).toHaveBeenCalledTimes(1);

    controller.interrupt();
    await speakAssistantText({
      text: 'fresh device reply',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'device',
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15_000,
      registerPlaybackStopper: controller.registerStopper,
      onSpeaking: restartedOnSpeaking,
    });
    execution.resolve();
    await staleAttempt;

    expect(restartedOnSpeaking).toHaveBeenCalledTimes(1);
    expect(staleOnSpeaking).not.toHaveBeenCalled();
  });

  it('routes local_neural daemon execution to the daemon TTS controller', async () => {
    daemonStreamStartRpc.mockClear();
    nativeSynthesize.mockClear();

    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      sessionId: 'session-1',
      text: 'hello from daemon',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'local_neural',
                localNeural: {
                  model: 'kokoro',
                  assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                  voiceId: 'af_heart',
                  speed: 1,
                  execution: 'daemon',
                },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });

    expect(daemonStreamStartRpc).toHaveBeenCalledWith(expect.objectContaining({
      text: 'hello from daemon',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
    }));
    expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'speech-machine',
      method: 'daemon.voiceInference.tts.stream.start' }));
    expect(nativeSynthesize).not.toHaveBeenCalled();
  });

  it('reports selected daemon local_neural synthesis failure without changing execution or provider', async () => {
    daemonStreamStartRpc.mockRejectedValueOnce(new Error('daemon unavailable'));
    expoSpeechSpeak.mockClear();
    nativeSynthesize.mockClear();

    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await expect(speakAssistantText({
      sessionId: 'session-1',
      text: 'hello from daemon fallback',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'local_neural',
                localNeural: {
                  model: 'kokoro',
                  assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                  voiceId: 'af_heart',
                  speed: 1,
                  execution: 'daemon',
                },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    })).rejects.toMatchObject({
      kind: 'tts_failed',
      reason: 'daemon unavailable',
    });

    expect(nativeSynthesize).not.toHaveBeenCalled();
    expect(expoSpeechSpeak).not.toHaveBeenCalled();
  });

  it('keeps explicit web local_neural device execution instead of changing it to daemon', async () => {
    platformOsMock.value = 'web';
    expoSpeechSpeak.mockClear();
    nativeSynthesize.mockClear();
    daemonStreamStartRpc.mockClear();

    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await expect(speakAssistantText({
      text: 'hello from web clamp',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'local_neural',
                localNeural: {
                  model: 'kokoro',
                  assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                  voiceId: 'af_heart',
                  speed: 1,
                  execution: 'device',
                },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    })).rejects.toMatchObject({ kind: 'tts_failed', reason: 'kokoro_runtime_unsupported' });

    expect(nativeSynthesize).not.toHaveBeenCalled();
    expect(expoSpeechSpeak).not.toHaveBeenCalled();
    expect(daemonStreamStartRpc).not.toHaveBeenCalled();
  });

  it('reports explicit web local_neural device failure without daemon or OS speech substitution', async () => {
    platformOsMock.value = 'web';
    expoSpeechSpeak.mockClear();
    nativeSynthesize.mockClear();

    const onSpeaking = vi.fn();
    const onTtsFailed = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      sessionId: 'session-1',
      text: 'hello from web fallback',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'local_neural',
                localNeural: {
                  model: 'kokoro',
                  assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                  voiceId: 'af_heart',
                  speed: 1,
                  execution: 'device',
                },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
      onTtsFailed,
    });

    expect(daemonStreamStartRpc).not.toHaveBeenCalled();
    expect(nativeSynthesize).not.toHaveBeenCalled();
    expect(expoSpeechSpeak).not.toHaveBeenCalled();
    expect(onTtsFailed).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tts_failed',
      reason: 'kokoro_runtime_unsupported',
    }));
  });

  it('routes a bundled speech provider with the exact bound Session preference through the selected-daemon client', async () => {
    const originalSessions = storage.getState().sessions;
    const serverId = getActiveServerSnapshot().serverId;
    const preference = { providerContributionId: 'happier.voice.google/google-cloud-tts', settingFieldPath: 'voiceName', value: 'bound-custom-voice' };
    storage.setState({ sessions: { ...originalSessions,
      'target-a': createSessionFixture({ id: 'target-a', serverId, metadata: {
        path: '/target-a', host: 'host', work: { voicePreference: preference },
      } }),
      'history-b': createSessionFixture({ id: 'history-b', serverId, metadata: {
        path: '/history-b', host: 'host', work: { voicePreference: { ...preference, value: 'wrong-history-voice' } },
      } }),
    } });
    voiceSessionBindingStore.getState().bind({ adapterId: 'local_direct', controlSessionId: 'control-c',
      conversationSessionId: 'history-b', conversationSessionAddress: { serverId, sessionId: 'history-b' },
      lifetime: 'runtime_attempt', targetSessionAddress: { serverId, sessionId: 'target-a' },
      transcriptMode: 'native_session', updatedAt: 1 });
    const onSpeaking = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};
    let notifyPlaybackStarted!: () => void;
    const playbackReady = createDeferred<void>();
    encodedAudio.start.mockImplementationOnce(async () => {
      notifyPlaybackStarted = () => { encodedAudio.emit('started'); encodedAudio.emit('finished'); };
      playbackReady.resolve();
    });

    try {
    const playback = speakAssistantText({
      sessionId: 'control-c',
      text: 'hello',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'happier.voice.google/google-cloud-tts',
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
            'happier.voice.google/google-cloud-tts': {
              schemaVersion: 2,
              config: {
                voiceName: 'en-US-Wavenet-D',
                languageCode: 'en-US',
                format: 'mp3',
                speakingRate: 1,
                pitch: 0,
              },
            },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
    });
    await playbackReady.promise;
    expect(notifyPlaybackStarted).toBeTypeOf('function');

    expect(speechSynthesizeRpc).toHaveBeenCalledTimes(1);
    const synthesizeInput = DaemonVoiceSpeechSynthesizeRequestSchema.parse(speechSynthesizeRpc.mock.calls[0]?.[0]);
    expect(synthesizeInput.target).toEqual({ pluginId: 'happier.voice.google', localId: 'google-cloud-tts' });
    expect(synthesizeInput.input).toBe('hello');
    expect(synthesizeInput.voicePreference).toEqual(preference);
    expect(speechSynthesizeRpc).not.toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: expect.anything(), androidCertSha1: expect.anything() }),
    );
    expect(onSpeaking).not.toHaveBeenCalled();
    notifyPlaybackStarted();
    await playback;
    expect(onSpeaking).toHaveBeenCalledTimes(1);
    } finally {
      storage.setState({ sessions: originalSessions });
      voiceSessionBindingStore.getState().unbind('history-b');
    }
  });

  it.each([
    { provider: 'device', metadataAvailable: true, reason: 'voice_preference_unavailable' },
    // Neural speech declares voice selection; the bound Google voice belongs to another provider.
    { provider: 'local_neural', metadataAvailable: true, reason: 'provider_mismatch' },
    { provider: 'device', metadataAvailable: false, reason: 'session_metadata_unavailable' },
  ])('refuses unsupported bound speech on $provider instead of playing an inherited default', async (selection) => {
    const originalSessions = storage.getState().sessions;
    const serverId = getActiveServerSnapshot().serverId;
    const preference = { providerContributionId: 'happier.voice.google/google-cloud-tts', settingFieldPath: 'voiceName', value: 'bound-custom-voice' };
    const targetId = 'native-target';
    const controlId = 'native-control';
    storage.setState({ sessions: { ...originalSessions,
      ...(selection.metadataAvailable ? { [targetId]: createSessionFixture({ id: targetId, serverId,
        metadata: { path: '/target', host: 'host', work: { voicePreference: preference } } }) } : {}),
    } });
    voiceSessionBindingStore.getState().bind({ adapterId: 'local_direct', controlSessionId: controlId,
      conversationSessionId: 'native-history', conversationSessionAddress: { serverId, sessionId: 'native-history' },
      lifetime: 'runtime_attempt', targetSessionAddress: { serverId, sessionId: targetId },
      transcriptMode: 'native_session', updatedAt: 1 });
    const onTtsFailed = vi.fn();
    const onSpeaking = vi.fn();
    try {
      await speakAssistantText({ sessionId: controlId, text: 'hello',
        settings: { voice: { providerId: 'local_direct', providers: { local_direct: { schemaVersion: 1,
          config: { tts: { provider: selection.provider, localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: 1 },
            autoSpeakReplies: true, bargeInEnabled: true } } } } } },
        networkTimeoutMs: 15000, registerPlaybackStopper: () => () => {}, onSpeaking, onTtsFailed });
      expect(onTtsFailed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tts_failed', reason: selection.reason }));
      expect(onSpeaking).not.toHaveBeenCalled();
      expect(expoSpeechSpeak).not.toHaveBeenCalled();
      expect(nativeSynthesize).not.toHaveBeenCalled();
      expect(daemonStreamStartRpc).not.toHaveBeenCalled();
      expect(speechSynthesizeRpc).not.toHaveBeenCalled();
    } finally {
      storage.setState({ sessions: originalSessions });
      voiceSessionBindingStore.getState().unbind('native-history');
    }
  });

  it('retires a prior applied voice only after inherited native playback actually starts', async () => {
    const originalSessions = storage.getState().sessions;
    const serverId = getActiveServerSnapshot().serverId;
    const controlId = 'native-inherited-control';
    const previousVoice = { providerContributionId: 'happier.voice.google/google-cloud-tts',
      settingFieldPath: 'voiceName', value: 'previous-voice', displayName: 'Previous voice' };
    storage.setState({ sessions: { ...originalSessions,
      'native-inherited-target': createSessionFixture({ id: 'native-inherited-target', serverId,
        metadata: { path: '/target', host: 'host', work: {} } }),
    } });
    voiceSessionBindingStore.getState().bind({ adapterId: 'local_direct', controlSessionId: controlId,
      conversationSessionId: 'native-inherited-history', conversationSessionAddress: { serverId, sessionId: 'native-inherited-history' },
      lifetime: 'runtime_attempt', targetSessionAddress: { serverId, sessionId: 'native-inherited-target' },
      transcriptMode: 'native_session', updatedAt: 1 });
    voiceConversationRuntimeMachine.reset();
    voiceConversationRuntimeMachine.transitionToConnecting({ controlSessionId: controlId });
    voiceConversationRuntimeMachine.transitionToSpeaking({ controlSessionId: controlId });
    voiceConversationRuntimeMachine.setInUseVoice({ controlSessionId: controlId, inUseVoice: previousVoice });
    let started!: () => void;
    const playbackReady = createDeferred<void>();
    expoSpeechSpeak.mockImplementationOnce((_text, options) => {
      started = () => { options.onStart?.(); options.onDone?.(); };
      playbackReady.resolve();
    });
    const onSpeaking = vi.fn();
    try {
      const playback = speakAssistantText({ sessionId: controlId, text: 'hello',
        settings: { voice: { providerId: 'local_direct', providers: { local_direct: { schemaVersion: 1,
          config: { tts: { provider: 'device' } } } } } },
        networkTimeoutMs: 15000, registerPlaybackStopper: () => () => {}, onSpeaking });
      await playbackReady.promise;
      expect(started).toBeTypeOf('function');
      expect(voiceConversationRuntimeMachine.getSnapshot().inUseVoice).toEqual(previousVoice);
      expect(onSpeaking).not.toHaveBeenCalled();
      started();
      await playback;
      expect(voiceConversationRuntimeMachine.getSnapshot().inUseVoice).toBeUndefined();
      expect(onSpeaking).toHaveBeenCalledOnce();
    } finally {
      storage.setState({ sessions: originalSessions });
      voiceSessionBindingStore.getState().unbind('native-inherited-history');
      voiceConversationRuntimeMachine.reset();
    }
  });

  it('rejects delayed bundled playback from a stopped attempt without poisoning restarted playback', async () => {
    const synthesis = createDeferred<{ bytes: Uint8Array; mimeType: string }>();
    const synthesizing = createDeferred<void>();
    speechSynthesizeRpc.mockImplementationOnce(() => { synthesizing.resolve(); return synthesis.promise; });
    const controller = createVoicePlaybackController();
    const staleOnSpeaking = vi.fn();
    const restartedOnSpeaking = vi.fn();
    expoSpeechSpeak.mockImplementationOnce((_text, options) => {
      options.onStart?.(); options.onDone?.();
    });

    const staleAttempt = speakAssistantText({
      text: 'stale bundled reply',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'happier.voice.google/google-cloud-tts',
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
            'happier.voice.google/google-cloud-tts': {
              schemaVersion: 2,
              config: {
                voiceName: 'en-US-Wavenet-D',
                languageCode: 'en-US',
                format: 'mp3',
                speakingRate: 1,
                pitch: 0,
              },
            },
          },
        },
      },
      networkTimeoutMs: 15_000,
      registerPlaybackStopper: controller.registerStopper,
      onSpeaking: staleOnSpeaking,
    });
    await synthesizing.promise;
    expect(speechSynthesizeRpc).toHaveBeenCalledTimes(1);

    controller.interrupt();
    await speakAssistantText({
      text: 'fresh device reply',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'device',
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15_000,
      registerPlaybackStopper: controller.registerStopper,
      onSpeaking: restartedOnSpeaking,
    });
    synthesis.resolve({ bytes: new Uint8Array([1]), mimeType: 'audio/mpeg' });
    await staleAttempt;

    expect(restartedOnSpeaking).toHaveBeenCalledTimes(1);
    expect(staleOnSpeaking).not.toHaveBeenCalled();
  });

  it('reports selected local_neural device failure without substituting device TTS', async () => {
    nativeSynthesize.mockRejectedValueOnce(new Error('kokoro_runtime_unavailable'));
    expoSpeechSpeak.mockClear();

    const onSpeaking = vi.fn();
    const onTtsFailed = vi.fn();
    const registerPlaybackStopper = (_s: () => void) => () => {};

    await speakAssistantText({
      text: 'hello',
      settings: {
        voice: {
          providerId: 'local_direct',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              tts: {
                provider: 'local_neural',
                localNeural: { model: 'kokoro', assetId: 'kokoro-output-contract', voiceId: 'af_heart', speed: 1 },
                autoSpeakReplies: true,
                bargeInEnabled: true,
              },
            } },
          },
        },
      },
      networkTimeoutMs: 15000,
      registerPlaybackStopper,
      onSpeaking,
      onTtsFailed,
    });

    expect(expoSpeechSpeak).not.toHaveBeenCalled();
    expect(nativeSynthesize).toHaveBeenCalledTimes(1);
    expect(onTtsFailed).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tts_failed',
      reason: 'kokoro_runtime_unavailable',
    }));
  });
});
