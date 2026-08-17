import { describe, expect, it, vi } from 'vitest';
import type { VoiceProviderContribution } from '@happier-dev/protocol';

import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';

import { createBundledSpeechRuntime } from './bundledSpeechRuntime';

type SpeechDeclaration = Extract<VoiceProviderContribution, Readonly<{ kind: 'speech' }>>;

const CATALOG_STT_DECLARATION = Object.freeze({
  id: 'catalog-stt',
  title: 'Catalog speech-to-text',
  kind: 'speech',
  roles: ['dictation_stt'],
  platforms: ['web'],
  settings: {
    schemaVersion: 2,
    fields: [{
      id: 'catalogModel',
      title: 'Model',
      schema: { type: 'string', minLength: 1, maxLength: 256 },
      default: 'acme-default',
      presentation: { control: 'select' },
    }, {
      id: 'language',
      title: 'Language',
      schema: { type: 'string', maxLength: 64 },
      default: '',
      presentation: { control: 'text' },
    }],
  },
  catalogs: [{ kind: 'models', settingFieldId: 'catalogModel', allowCustom: true }],
} satisfies SpeechDeclaration);

const CATALOG_TTS_DECLARATION = Object.freeze({
  id: 'catalog-tts',
  title: 'Catalog text-to-speech',
  kind: 'speech',
  roles: ['conversation_tts'],
  platforms: ['web'],
  settings: {
    schemaVersion: 2,
    fields: [{
      id: 'catalogVoice',
      title: 'Voice',
      schema: { type: 'string', maxLength: 256 },
      default: '',
      presentation: { control: 'select' },
    }, {
      id: 'languageCode',
      title: 'Language',
      schema: { type: 'string', maxLength: 64 },
      default: '',
      presentation: { control: 'text' },
    }, {
      id: 'format',
      title: 'Audio format',
      schema: { type: 'string', enum: ['mp3', 'wav'] },
      default: 'mp3',
      presentation: {
        control: 'select',
        options: [{ value: 'mp3', title: 'MP3' }, { value: 'wav', title: 'WAV' }],
      },
    }, {
      id: 'speakingRate',
      title: 'Speaking rate',
      schema: { type: 'number', minimum: 0.25, maximum: 4 },
      default: 1,
      presentation: { control: 'number', step: 0.05 },
    }, {
      id: 'pitch',
      title: 'Pitch',
      schema: { type: 'number', minimum: -20, maximum: 20 },
      default: 0,
      presentation: { control: 'number', step: 0.5 },
    }],
    readiness: [{ kind: 'setting_nonempty', settingId: 'catalogVoice' }],
  },
  catalogs: [{ kind: 'voices', settingFieldId: 'catalogVoice', allowCustom: true }],
} satisfies SpeechDeclaration);

const CATALOG_STT_ID = 'happier.voice.acme/catalog-stt';
const CATALOG_TTS_ID = 'happier.voice.acme/catalog-tts';

function createFakeSpeechRegistry(
  declarations: readonly SpeechDeclaration[],
  enabledPluginIds: ReadonlySet<string> | null = null,
) {
  const pluginId = 'happier.voice.acme';
  const contributions = declarations.map((declaration) => Object.freeze({
    pluginId,
    providerId: `${pluginId}/${declaration.id}`,
    declaration,
  }));
  const presentations = declarations.map((declaration) => Object.freeze({
    providerId: `${pluginId}/${declaration.id}`,
    settingsSectionId: `voice.speech.${declaration.id}`,
    createSettingsSpec: () => null,
  }));
  return Object.freeze({
    registry: createVoiceProviderRegistry({
      bundledContributions: contributions,
      bundledPresentations: presentations,
      enabledPluginIds,
    }),
    providerId: (localId: string) => `${pluginId}/${localId}`,
    entries: contributions,
  });
}

describe('bundledSpeechRuntime', () => {
  it('projects enabled bundled speech engines and removes them fail-closed when their package is disabled', () => {
    const declarations = [CATALOG_STT_DECLARATION, CATALOG_TTS_DECLARATION];
    const enabled = createBundledSpeechRuntime({
      registry: createFakeSpeechRegistry(declarations).registry,
      client: {} as never,
    });
    const disabled = createBundledSpeechRuntime({
      registry: createFakeSpeechRegistry(declarations, new Set()).registry,
      client: {} as never,
    });

    expect(enabled.sttProviderIds()).toContain(CATALOG_STT_ID);
    expect(enabled.ttsProviderIds()).toContain(CATALOG_TTS_ID);
    expect(disabled.sttProviderIds()).not.toContain(CATALOG_STT_ID);
    expect(disabled.ttsProviderIds()).not.toContain(CATALOG_TTS_ID);
  });

  it('transcribes through the package-owned descriptor without a provider branch in the host', async () => {
    const transcribe = vi.fn(async () => ' hello from package ');
    const runtime = createBundledSpeechRuntime({
      registry: createFakeSpeechRegistry([CATALOG_STT_DECLARATION]).registry,
      client: { transcribe } as never,
      platformOs: 'ios',
    });

    await expect(runtime.transcribeRecordedAudio(CATALOG_STT_ID, {
      uri: 'file:///recording.wav',
      providerConfig: { catalogModel: 'gemini-test', language: 'fr' },
      fallbackLanguage: 'en',
    })).resolves.toBe('hello from package');
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ providerId: CATALOG_STT_ID }),
      model: 'gemini-test',
      language: 'fr',
      mimeType: 'audio/wav',
      source: { kind: 'native', uri: 'file:///recording.wav' },
    }));
  });

  it('fails closed before STT dispatch when the canonical root settings envelope is missing', async () => {
    const transcribe = vi.fn(async () => 'must not run');
    const runtime = createBundledSpeechRuntime({
      registry: createFakeSpeechRegistry([CATALOG_STT_DECLARATION]).registry,
      client: { transcribe } as never,
      platformOs: 'ios',
    });

    await expect(runtime.transcribeRecordedAudio(CATALOG_STT_ID, {
      uri: 'file:///recording.wav',
      providerConfig: null,
      fallbackLanguage: 'en',
    })).rejects.toMatchObject({ code: 'provider_settings_invalid' });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('synthesizes and plays through host substrate while package config validation fails closed', async () => {
    const synthesize = vi.fn(async () => ({ bytes: new Uint8Array([1, 2]), mimeType: 'audio/wav' as const }));
    const onPlaybackStarted = vi.fn();
    let notifyPlaybackStarted!: () => void;
    const play = vi.fn(async (params: unknown) => {
      const callback = (params as Readonly<{ onPlaybackStarted?: () => void }>).onPlaybackStarted;
      if (!callback) throw new Error('Expected playback-start callback');
      notifyPlaybackStarted = callback;
    });
    const runtime = createBundledSpeechRuntime({
      registry: createFakeSpeechRegistry([CATALOG_TTS_DECLARATION]).registry,
      client: { synthesize } as never,
      play,
    });

    await runtime.speak(CATALOG_TTS_ID, {
      text: 'hello',
      providerConfig: {
        catalogVoice: 'en-US-Test-A',
        languageCode: '',
        format: 'wav',
        speakingRate: 1,
        pitch: 0,
      },
      registerPlaybackStopper: () => () => {},
      onPlaybackStarted,
    });
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ providerId: CATALOG_TTS_ID }),
      model: null,
      voiceName: 'en-US-Test-A',
      format: 'wav',
    }));
    expect(play).toHaveBeenCalledTimes(1);
    expect(onPlaybackStarted).not.toHaveBeenCalled();
    notifyPlaybackStarted();
    expect(onPlaybackStarted).toHaveBeenCalledTimes(1);

    await expect(runtime.speak(CATALOG_TTS_ID, {
      text: 'bad',
      providerConfig: { speakingRate: 99 },
      registerPlaybackStopper: () => () => {},
    })).rejects.toMatchObject({ code: 'provider_settings_invalid' });
  });

  it('cancels in-flight bundled synthesis before playback and suppresses a late result', async () => {
    let resolveSynthesis!: (result: Readonly<{ bytes: Uint8Array; mimeType: 'audio/wav' }>) => void;
    const synthesis = new Promise<Readonly<{ bytes: Uint8Array; mimeType: 'audio/wav' }>>((resolve) => {
      resolveSynthesis = resolve;
    });
    let synthesisSignal: AbortSignal | null | undefined;
    const synthesize = vi.fn(async (params: Readonly<{ signal?: AbortSignal | null }>) => {
      synthesisSignal = params.signal;
      return await synthesis;
    });
    const play = vi.fn(async () => undefined);
    const cancellation: { current: (() => void) | null } = { current: null };
    const registerPlaybackStopper = vi.fn((stopper: () => void) => {
      cancellation.current = stopper;
      return () => {
        if (cancellation.current === stopper) cancellation.current = null;
      };
    });
    const runtime = createBundledSpeechRuntime({
      registry: createFakeSpeechRegistry([CATALOG_TTS_DECLARATION]).registry,
      client: { synthesize } as never,
      play,
    });

    const speaking = runtime.speak(CATALOG_TTS_ID, {
      text: 'cancel me',
      providerConfig: {
        catalogVoice: 'en-US-Test-A',
        languageCode: '',
        format: 'wav',
        speakingRate: 1,
        pitch: 0,
      },
      registerPlaybackStopper,
    });
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(1));

    try {
      expect(registerPlaybackStopper).toHaveBeenCalledTimes(1);
      const cancel = cancellation.current;
      if (!cancel) throw new Error('Expected an active synthesis stopper');
      cancel();
      expect(synthesisSignal?.aborted).toBe(true);
    } finally {
      resolveSynthesis({ bytes: new Uint8Array([1, 2]), mimeType: 'audio/wav' });
    }

    await expect(speaking).resolves.toBeUndefined();
    expect(play).not.toHaveBeenCalled();
  });

  it('does not report speaking when bundled synthesis fails before playback', async () => {
    const synthesize = vi.fn(async () => {
      throw new Error('bundled_synthesis_failed');
    });
    const play = vi.fn(async () => undefined);
    const onPlaybackStarted = vi.fn();
    const runtime = createBundledSpeechRuntime({
      registry: createFakeSpeechRegistry([CATALOG_TTS_DECLARATION]).registry,
      client: { synthesize } as never,
      play,
    });

    await expect(runtime.speak(CATALOG_TTS_ID, {
      text: 'hello',
      providerConfig: {
        catalogVoice: 'en-US-Test-A',
        languageCode: '',
        format: 'wav',
        speakingRate: 1,
        pitch: 0,
      },
      registerPlaybackStopper: () => () => {},
      onPlaybackStarted,
    })).rejects.toThrow('bundled_synthesis_failed');

    expect(play).not.toHaveBeenCalled();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
  });

  it('executes a second bundled speech package from the injected registry without a host-global descriptor edit', async () => {
    const transcribe = vi.fn(async () => 'acme result');
    const fake = createFakeSpeechRegistry([CATALOG_STT_DECLARATION]);
    const runtime = createBundledSpeechRuntime({
      registry: fake.registry,
      client: { transcribe } as never,
      platformOs: 'ios',
    });

    await expect(runtime.transcribeRecordedAudio(CATALOG_STT_ID, {
      uri: 'file:///recording.wav',
      providerConfig: { catalogModel: 'acme-v2', language: '' },
      fallbackLanguage: 'de',
    })).resolves.toBe('acme result');
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ providerId: CATALOG_STT_ID }),
      model: 'acme-v2',
      language: 'de',
    }));
  });

  it('uses a declared text model when a speech-to-text contribution has no model catalog', async () => {
    const transcribe = vi.fn(async () => 'openai-compatible result');
    const fake = createFakeSpeechRegistry([{
      id: 'text-stt',
      title: 'Text-configured speech-to-text',
      kind: 'speech',
      roles: ['dictation_stt'],
      platforms: ['web'],
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'model',
          title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 256 },
          default: 'whisper-1',
          presentation: { control: 'text' },
        }],
      },
    }]);
    const runtime = createBundledSpeechRuntime({
      registry: fake.registry,
      client: { transcribe } as never,
      platformOs: 'ios',
    });

    await expect(runtime.transcribeRecordedAudio(fake.providerId('text-stt'), {
      uri: 'file:///recording.wav',
      providerConfig: { model: 'whisper-custom' },
      fallbackLanguage: 'en',
    })).resolves.toBe('openai-compatible result');
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      model: 'whisper-custom',
    }));
  });

  it('uses declared text voice and model settings when a text-to-speech contribution has no catalogs', async () => {
    const synthesize = vi.fn(async () => ({ bytes: new Uint8Array([1]), mimeType: 'audio/mpeg' as const }));
    const fake = createFakeSpeechRegistry([{
      id: 'text-tts',
      title: 'Text-configured text-to-speech',
      kind: 'speech',
      roles: ['conversation_tts'],
      platforms: ['web'],
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'model',
          title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 256 },
          default: 'tts-1',
          presentation: { control: 'text' },
        }, {
          id: 'voiceName',
          title: 'Voice',
          schema: { type: 'string', minLength: 1, maxLength: 256 },
          default: 'alloy',
          presentation: { control: 'text' },
        }],
      },
    }]);
    const runtime = createBundledSpeechRuntime({
      registry: fake.registry,
      client: { synthesize } as never,
      play: vi.fn(async () => undefined),
    });

    await runtime.speak(fake.providerId('text-tts'), {
      text: 'hello',
      providerConfig: { model: 'tts-custom', voiceName: 'verse' },
      registerPlaybackStopper: () => () => {},
    });
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      model: 'tts-custom',
      voiceName: 'verse',
    }));
  });
});
