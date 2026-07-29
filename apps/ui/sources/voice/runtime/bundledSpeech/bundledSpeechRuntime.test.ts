import { describe, expect, it, vi } from 'vitest';

import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

import { createBundledSpeechRuntime } from './bundledSpeechRuntime';

function createFakeSttRegistry() {
  const descriptor = Object.freeze({
    kind: 'voice.internal.speech-settings.v1',
    providerId: 'acme_stt',
    role: 'stt',
    schemaVersion: 1,
    titleKey: 'fixture.title',
    subtitleKey: 'fixture.subtitle',
    detailKey: 'fixture.detail',
    iconName: 'sparkles',
    credential: Object.freeze({
      kind: 'api_key',
      titleKey: 'fixture.credential',
      promptTitleKey: 'fixture.prompt',
      promptBodyKey: 'fixture.body',
      androidRestricted: false,
      androidRestrictedBodyKey: null,
    }),
    fields: Object.freeze([]),
    runtime: Object.freeze({ modelKey: 'model', languageKey: 'language', defaultModel: 'acme-default' }),
    defaultConfig: Object.freeze({ model: 'acme-default', language: null }),
    parseConfig(value: unknown) {
      return value && typeof value === 'object' ? value as Readonly<Record<string, unknown>> : null;
    },
    parseLegacyConfig: () => null,
    readLegacySecret: () => null,
    migrateLegacy: () => null,
    classifyLegacyCredential: () => 'importable' as const,
    test: null,
  });
  const internal = Object.freeze({
    createSettingsSpec: () => descriptor,
    speechTarget: Object.freeze({ localId: 'speech' }),
    schemas: Object.freeze({
      transcribeResponse: Object.freeze({ safeParse: () => ({ success: false as const }) }),
      synthesizeResponse: Object.freeze({ safeParse: () => ({ success: false as const }) }),
    }),
  });
  const entry = Object.freeze({
    kind: 'voice.speech-engine.v1',
    pluginId: 'happier.voice.acme',
    providerId: 'acme_stt',
    role: 'stt',
    roles: Object.freeze(['dictation_stt']),
    requirements: Object.freeze([]),
    supportedPlatforms: Object.freeze(['web']),
    settingsSectionId: 'voice.stt.acme',
    internal,
  });
  const contribution = Object.freeze({
    ...entry,
    source: Object.freeze({ kind: 'bundled', pluginId: 'happier.voice.acme' }),
  });
  return Object.freeze({
    registry: Object.freeze({
      list: () => Object.freeze([contribution]),
      get: (providerId: string) => providerId === 'acme_stt' ? contribution : null,
    }),
    entry,
  });
}

describe('bundledSpeechRuntime', () => {
  it('projects enabled bundled speech engines and removes them fail-closed when their package is disabled', () => {
    const enabled = createBundledSpeechRuntime({
      registry: createDefaultVoiceProviderRegistry(),
      client: {} as never,
    });
    const disabled = createBundledSpeechRuntime({
      registry: createDefaultVoiceProviderRegistry({ enabledPluginIds: new Set() }),
      client: {} as never,
    });

    expect(enabled.sttProviderIds()).toContain('google_gemini');
    expect(enabled.ttsProviderIds()).toContain('google_cloud');
    expect(disabled.sttProviderIds()).not.toContain('google_gemini');
    expect(disabled.ttsProviderIds()).not.toContain('google_cloud');
  });

  it('transcribes through the package-owned descriptor without a provider branch in the host', async () => {
    const transcribe = vi.fn(async () => ' hello from package ');
    const runtime = createBundledSpeechRuntime({
      registry: createDefaultVoiceProviderRegistry(),
      client: { transcribe } as never,
      platformOs: 'ios',
    });

    await expect(runtime.transcribeRecordedAudio('google_gemini', {
      uri: 'file:///recording.wav',
      providerConfig: { model: 'gemini-test', language: 'fr' },
      fallbackLanguage: 'en',
    })).resolves.toBe('hello from package');
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ providerId: 'google_gemini' }),
      model: 'gemini-test',
      language: 'fr',
      mimeType: 'audio/wav',
      source: { kind: 'native', uri: 'file:///recording.wav' },
    }));
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
      registry: createDefaultVoiceProviderRegistry(),
      client: { synthesize } as never,
      play,
    });

    await runtime.speak('google_cloud', {
      text: 'hello',
      providerConfig: { voiceName: 'en-US-Test-A', format: 'wav' },
      registerPlaybackStopper: () => () => {},
      onPlaybackStarted,
    });
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ providerId: 'google_cloud' }),
      voiceName: 'en-US-Test-A',
      format: 'wav',
    }));
    expect(play).toHaveBeenCalledTimes(1);
    expect(onPlaybackStarted).not.toHaveBeenCalled();
    notifyPlaybackStarted();
    expect(onPlaybackStarted).toHaveBeenCalledTimes(1);

    await expect(runtime.speak('google_cloud', {
      text: 'bad',
      providerConfig: { speakingRate: 99 },
      registerPlaybackStopper: () => () => {},
    })).rejects.toMatchObject({ code: 'provider_settings_invalid' });
  });

  it('does not report speaking when bundled synthesis fails before playback', async () => {
    const synthesize = vi.fn(async () => {
      throw new Error('bundled_synthesis_failed');
    });
    const play = vi.fn(async () => undefined);
    const onPlaybackStarted = vi.fn();
    const runtime = createBundledSpeechRuntime({
      registry: createDefaultVoiceProviderRegistry(),
      client: { synthesize } as never,
      play,
    });

    await expect(runtime.speak('google_cloud', {
      text: 'hello',
      providerConfig: { voiceName: 'en-US-Test-A', format: 'wav' },
      registerPlaybackStopper: () => () => {},
      onPlaybackStarted,
    })).rejects.toThrow('bundled_synthesis_failed');

    expect(play).not.toHaveBeenCalled();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
  });

  it('executes a second bundled speech package from the injected registry without a host-global descriptor edit', async () => {
    const transcribe = vi.fn(async () => 'acme result');
    const fake = createFakeSttRegistry();
    const runtime = createBundledSpeechRuntime({
      registry: fake.registry as never,
      client: { transcribe } as never,
      platformOs: 'ios',
    });

    await expect(runtime.transcribeRecordedAudio('acme_stt', {
      uri: 'file:///recording.wav',
      providerConfig: { model: 'acme-v2', language: 'de' },
      fallbackLanguage: null,
    })).resolves.toBe('acme result');
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ providerId: 'acme_stt' }),
      model: 'acme-v2',
      language: 'de',
    }));
  });
});
