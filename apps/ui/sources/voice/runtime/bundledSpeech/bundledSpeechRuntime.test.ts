import { describe, expect, it, vi } from 'vitest';
import type { VoiceProviderContribution } from '@happier-dev/protocol';

import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import type { BundledSpeechDaemonClient } from '@/voice/credentials/bundledSpeechClient';

import { createBundledSpeechRuntime } from './bundledSpeechRuntime';

// The default RPC client is a network boundary. Tests inject its transport and
// keep the real registry/settings/speech orchestration beneath that boundary.
vi.mock('@/voice/credentials/bundledSpeechClient', () => ({ bundledSpeechDaemonClient: {} }));

type SpeechDeclaration = Extract<VoiceProviderContribution, Readonly<{ kind: 'speech' }>>;
type BundledSpeechClient = NonNullable<Parameters<typeof createBundledSpeechRuntime>[0]['client']>;

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
  it('batches multibyte replies by the declared UTF-8 cap through the real settings owner', async () => {
    const declaration = { ...CATALOG_TTS_DECLARATION, limits: { synthesize: { maxInputUtf8Bytes: 9 } } };
    const received: string[] = [];
    const text = '😀界你好。 继续。';
    const runtime = createBundledSpeechRuntime({
      registry: createFakeSpeechRegistry([declaration]).registry,
      client: { transcribe: async () => '', synthesize: async ({ input }) => {
        received.push(input); return { bytes: new Uint8Array([1]), mimeType: 'audio/wav' as const };
      } },
      play: async () => {},
    });
    await runtime.speak(CATALOG_TTS_ID, {
      text, providerConfig: { catalogVoice: 'voice', format: 'wav', languageCode: '', speakingRate: 1, pitch: 0 },
      registerPlaybackStopper: () => () => {},
    });
    expect(received.length).toBeGreaterThan(1);
    expect(received.every((batch) => new TextEncoder().encode(batch).byteLength <= 9)).toBe(true);
    expect(received.join('')).toBe(text.replace(/\s/gu, ''));
  });
  it('batches whole replies by the selected character limit and cancels remaining batches during playback', async () => {
    const declaration = { ...CATALOG_TTS_DECLARATION, limits: { synthesize: { maxInputCharacters: 20 } } };
    const received: string[] = [];
    let stop: (() => void) | undefined;
    const runtime = createBundledSpeechRuntime({
      registry: createFakeSpeechRegistry([declaration]).registry,
      client: { transcribe: async () => '', synthesize: async ({ input }) => {
        received.push(input);
        return { bytes: new Uint8Array([1]), mimeType: 'audio/wav' as const };
      } },
      play: async () => { if (received.length === 2) stop?.(); },
    });
    await runtime.speak(CATALOG_TTS_ID, {
      text: 'First short reply. Second short reply. Third short reply.',
      providerConfig: { catalogVoice: 'voice', format: 'wav', languageCode: '', speakingRate: 1, pitch: 0 },
      registerPlaybackStopper: (stopper) => { stop = stopper; return () => {}; },
    });
    expect(received).toEqual(['First short reply.', 'Second short reply.']);
  });
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
    const transcribe = vi.fn<BundledSpeechDaemonClient['transcribe']>(async () => ' hello from package ');
    const runtime = createBundledSpeechRuntime({
      registry: createFakeSpeechRegistry([CATALOG_STT_DECLARATION]).registry,
      client: { transcribe } as never,
      platformOs: 'ios',
    });

    await expect(runtime.transcribeRecordedAudio(CATALOG_STT_ID, {
      uri: 'file:///recording.wav',
      providerConfig: { catalogModel: 'gemini-test', language: 'fr' },
      capturePurpose: 'dictation',
    })).resolves.toBe('hello from package');
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ providerId: CATALOG_STT_ID }),
      mimeType: 'audio/wav',
      capturePurpose: 'dictation',
      source: { kind: 'native', uri: 'file:///recording.wav' },
    }));
    expect(transcribe.mock.calls[0]?.[0]).not.toHaveProperty('model');
    expect(transcribe.mock.calls[0]?.[0]).not.toHaveProperty('language');
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
    })).rejects.toMatchObject({ code: 'provider_settings_invalid' });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('synthesizes and plays through host substrate while package config validation fails closed', async () => {
    const synthesize = vi.fn<BundledSpeechDaemonClient['synthesize']>(async () => ({ bytes: new Uint8Array([1, 2]), mimeType: 'audio/wav' as const }));
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
      input: 'hello',
    }));
    expect(synthesize.mock.calls[0]?.[0]).not.toHaveProperty('model');
    expect(synthesize.mock.calls[0]?.[0]).not.toHaveProperty('voiceName');
    expect(synthesize.mock.calls[0]?.[0]).not.toHaveProperty('format');
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
    const transcribe = vi.fn<BundledSpeechDaemonClient['transcribe']>(async () => 'acme result');
    const fake = createFakeSpeechRegistry([CATALOG_STT_DECLARATION]);
    const runtime = createBundledSpeechRuntime({
      registry: fake.registry,
      client: { transcribe } as never,
      platformOs: 'ios',
    });

    await expect(runtime.transcribeRecordedAudio(CATALOG_STT_ID, {
      uri: 'file:///recording.wav',
      providerConfig: { catalogModel: 'acme-v2', language: '' },
    })).resolves.toBe('acme result');
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ providerId: CATALOG_STT_ID }),
    }));
    expect(transcribe.mock.calls[0]?.[0]).not.toHaveProperty('model');
    expect(transcribe.mock.calls[0]?.[0]).not.toHaveProperty('language');
  });

  it('validates a declared text model without carrying it over the daemon RPC', async () => {
    const transcribe = vi.fn<BundledSpeechDaemonClient['transcribe']>(async () => 'openai-compatible result');
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
    })).resolves.toBe('openai-compatible result');
    expect(transcribe).toHaveBeenCalledOnce();
    expect(transcribe.mock.calls[0]?.[0]).not.toHaveProperty('model');
  });

  it('validates declared text voice and model settings without carrying them over the daemon RPC', async () => {
    const synthesize = vi.fn<BundledSpeechDaemonClient['synthesize']>(async () => ({ bytes: new Uint8Array([1]), mimeType: 'audio/mpeg' as const }));
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
        }, {
          id: 'format',
          title: 'Format',
          schema: { type: 'string', enum: ['mp3', 'wav'] },
          default: 'mp3',
          presentation: {
            control: 'select',
            options: [{ value: 'mp3', title: 'MP3' }, { value: 'wav', title: 'WAV' }],
          },
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
      providerConfig: { model: 'tts-custom', voiceName: 'verse', format: 'mp3' },
      registerPlaybackStopper: () => () => {},
    });
    expect(synthesize).toHaveBeenCalledOnce();
    expect(synthesize.mock.calls[0]?.[0]).not.toHaveProperty('model');
    expect(synthesize.mock.calls[0]?.[0]).not.toHaveProperty('voiceName');
  });
});
