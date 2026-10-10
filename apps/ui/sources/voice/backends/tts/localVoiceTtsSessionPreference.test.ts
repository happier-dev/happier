import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import type { BundledSpeechPreparation } from '@/voice/runtime/bundledSpeech/bundledSpeechRuntime';
import type { DaemonVoiceInferenceModelStatus } from '@happier-dev/protocol/daemon/voiceInference';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import { playRealtimeCatalogPreview, readRealtimeCatalogPreview, stopRealtimeCatalogPreview } from '@/voice/settings/panels/realtime/catalogPreview';
import { previewLocalNeuralTts } from '@/voice/settings/panels/localTts/providers/localNeural/previewLocalNeuralTts';
import { voiceSettingsParse, readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { storage } from '@/sync/domains/state/storage';
import { createDefaultLocalVoiceTtsProviderControllers, type LocalVoiceTtsRequest } from './localVoiceTtsProviderControllers';

const boundary = vi.hoisted(() => ({ synthesize: vi.fn(), status: vi.fn(), playback: vi.fn() }));
// Daemon RPC and audio playback are genuine network/OS boundaries. The selection,
// execution policy, model catalog projection and playback controller remain real.
vi.mock('@/voice/runtime/daemonInference/DaemonVoiceInferenceClient', () => ({
  DaemonVoiceInferenceClient: class {
    getModelsStatus = boundary.status;
    synthesizeText = boundary.synthesize;
  },
}));
vi.mock('@/voice/output/playAudioBytesWithStopper', () => ({ playAudioBytesWithStopper: boundary.playback }));
vi.mock('@/sync/api/capabilities/serverFeaturesClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/sync/api/capabilities/serverFeaturesClient')>(),
  getServerFeaturesSnapshot: async () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
    voice: { enabled: true }, execution: { runs: { enabled: true } },
  } }) }),
}));

describe('local model Session voice consumption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.setState(state => ({ settings: { ...state.settings, experiments: true,
      featureToggles: { ...state.settings.featureToggles, voice: true, 'voice.agent': true,
        'execution.runs': true, 'voice.daemonInference': true } } }));
    const status = { kind: 'tts_sherpa', packId: 'kokoro-82m-v1.0-onnx-q8-wasm', model: 'kokoro', version: '1',
      executionSupport: ['daemon'], runtimeFamily: 'sherpa_kokoro_offline', runtimeSupported: true,
      installState: 'installed', progress: null, lastError: null, updatedAtMs: 1,
      voices: [{ id: 'af_heart', title: 'Heart' }, { id: 'am_adam', title: 'Adam' }], defaultVoiceId: 'af_heart',
    } satisfies DaemonVoiceInferenceModelStatus;
    boundary.status.mockResolvedValue([status]);
    boundary.synthesize.mockResolvedValue({ bytes: new Uint8Array([1]), output: { codec: 'wav', mimeType: 'audio/wav' } });
  });

  async function speak(value: string, current: () => boolean = () => true) {
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
        assetId: 'kokoro-82m-v1.0-onnx-q8-wasm', execution: 'daemon', voiceId: 'af_heart', speed: 1.2 } },
      registerPlaybackStopper: () => () => {}, onSpeaking: speaking, onTtsFailed: failed,
      preparation,
    };
    boundary.playback.mockImplementation(async (options: { onPlaybackStarted?: () => void }) => {
      expect(applied).not.toHaveBeenCalled();
      options.onPlaybackStarted?.();
    });
    await createDefaultLocalVoiceTtsProviderControllers().get('local_neural')!.speak(request);
    return { applied, failed, speaking, request };
  }

  it('uses the chosen installed voice without changing model/speed and publishes it only after audio starts', async () => {
    const result = await speak('am_adam');
    expect(result.failed).not.toHaveBeenCalled();
    expect(boundary.synthesize).toHaveBeenCalledWith(expect.objectContaining({ voiceId: 'am_adam', speed: 1.2,
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm' }));
    expect(result.applied).toHaveBeenCalledWith(expect.objectContaining({ value: 'am_adam', displayName: 'Adam' }));
    expect(result.request.tts.localNeural.voiceId).toBe('af_heart');
  });

  it('refuses a removed voice rather than playing the account default', async () => {
    const result = await speak('removed');
    expect(result.failed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tts_failed', reason: 'voice_missing' }));
    expect(boundary.synthesize).not.toHaveBeenCalled();
    expect(result.applied).not.toHaveBeenCalled();
  });

  it('does not synthesize or publish when the captured attempt is no longer current', async () => {
    const result = await speak('am_adam', () => false);
    expect(boundary.synthesize).not.toHaveBeenCalled();
    expect(result.applied).not.toHaveBeenCalled();
  });

  it('retires an awaited catalog result before synthesis when its attempt changes', async () => {
    let current = true;
    boundary.status.mockImplementationOnce(async () => { current = false; return []; });
    const result = await speak('am_adam', () => current);
    expect(result.failed).not.toHaveBeenCalled();
    expect(boundary.synthesize).not.toHaveBeenCalled();
    expect(result.applied).not.toHaveBeenCalled();
  });

  it('previews a catalog-only local voice through the shared preview owner and real local speech path', async () => {
    const cfg = readLocalConversationVoiceSettings(voiceSettingsParse({ providerId: 'local_conversation' }));
    boundary.playback.mockImplementation(async () => {});
    const synthesize = async (input: { registerPlaybackStopper: VoicePlaybackStopperRegistrar; signal: AbortSignal; isCurrent: () => boolean }) => {
      await previewLocalNeuralTts({ config: { ...cfg.tts.localNeural, execution: 'daemon', voiceId: 'am_adam' },
        sample: 'preview', timeoutMs: cfg.networkTimeoutMs, ...input });
    };
    const result = await playRealtimeCatalogPreview({ providerId: 'happier.voice.builtin/local-neural',
      row: { id: 'am_adam', name: 'Adam' }, isCurrent: () => true, synthesize });
    expect(result).toMatchObject({ status: 'completed' });
    expect(boundary.synthesize).toHaveBeenCalledWith(expect.objectContaining({ voiceId: 'am_adam', text: 'preview' }));
    expect(readRealtimeCatalogPreview()).toBeNull();
  });

  it('stops a local preview while synthesis is pending without starting late audio', async () => {
    const cfg = readLocalConversationVoiceSettings(voiceSettingsParse({ providerId: 'local_conversation' }));
    let releaseSynthesis!: () => void;
    boundary.synthesize.mockImplementationOnce(() => new Promise(resolve => {
      releaseSynthesis = () => resolve({ bytes: new Uint8Array([1]), output: { codec: 'wav', mimeType: 'audio/wav' } });
    }));
    const synthesize = async (input: { registerPlaybackStopper: VoicePlaybackStopperRegistrar; signal: AbortSignal; isCurrent: () => boolean }) => {
      await previewLocalNeuralTts({ config: { ...cfg.tts.localNeural, execution: 'daemon', voiceId: 'am_adam' },
        sample: 'preview', timeoutMs: cfg.networkTimeoutMs, ...input });
    };
    const providerId = 'happier.voice.builtin/local-neural';
    const pending = playRealtimeCatalogPreview({ providerId, row: { id: 'am_adam', name: 'Adam' },
      isCurrent: () => true, synthesize });
    await vi.waitFor(() => expect(boundary.synthesize).toHaveBeenCalled());
    expect(stopRealtimeCatalogPreview(providerId)).toBe(true);
    releaseSynthesis();
    expect(await pending).toMatchObject({ status: 'cancelled' });
    expect(boundary.playback).not.toHaveBeenCalled();
    expect(readRealtimeCatalogPreview()).toBeNull();
  });
});
