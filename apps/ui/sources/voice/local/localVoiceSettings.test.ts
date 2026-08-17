import { describe, expect, it } from 'vitest';

import {
  isHandsFreeDeviceSttEnabled,
  parseLocalVoiceSttSettings,
  parseLocalVoiceTtsSettings,
  resolveLocalSttProvider,
  resolveLocalVoiceAdapterSettings,
} from './localVoiceSettings';

describe('localVoiceSettings', () => {
  it('trims the provider id before selecting the local voice adapter', () => {
    expect(
      resolveLocalVoiceAdapterSettings({
        voice: {
          providerId: ' local_direct ',
          providers: {
            local_direct: {
              schemaVersion: 1,
              config: { networkTimeoutMs: 12_345 },
            },
          },
        },
      }),
    ).toMatchObject({
      adapterId: 'local_direct',
      config: { networkTimeoutMs: 12_345 },
    });
  });

  it('trims the STT provider before resolving the local STT provider', () => {
    expect(
      resolveLocalSttProvider({
        voice: {
          providerId: 'local_conversation',
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              stt: { provider: ' device ' },
              handsFree: { enabled: true },
            } },
          },
        },
      }),
    ).toBe('device');

    expect(
      isHandsFreeDeviceSttEnabled({
        voice: {
          providerId: 'local_conversation',
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              stt: { provider: ' device ' },
              handsFree: { enabled: true },
            } },
          },
        },
      }),
    ).toBe(true);
  });

  it('normalizes legacy speech selections without retaining inline provider configuration', () => {
    const stt = parseLocalVoiceSttSettings({
        useDeviceStt: true,
        baseUrl: ' http://legacy-stt.example/v1 ',
    });
    const tts = parseLocalVoiceTtsSettings({
        baseUrl: ' http://legacy-tts.example/v1 ',
        model: 'tts-1-hd',
        voice: 'alloy',
    });

    expect(stt.provider).toBe('device');
    expect(tts.provider).toBe('happier.voice.openai-compat/tts');
    expect(stt).not.toHaveProperty('openaiCompat');
    expect(tts).not.toHaveProperty('openaiCompat');
  });

  it('normalizes legacy Google selections without retaining nested provider settings', () => {
    const stt = parseLocalVoiceSttSettings({
      provider: 'google_gemini',
      googleGemini: { model: 'gemini-test', language: 'fr' },
    });
    const tts = parseLocalVoiceTtsSettings({
      provider: 'google_cloud',
      googleCloud: { voiceName: 'fr-FR-Test-A', languageCode: 'fr-FR', format: 'wav' },
    });

    expect(stt.provider).toBe('happier.voice.google/gemini-stt');
    expect(tts.provider).toBe('happier.voice.google/google-cloud-tts');
    expect(stt).not.toHaveProperty('googleGemini');
    expect(tts).not.toHaveProperty('googleCloud');
    expect(stt).not.toHaveProperty('providers');
    expect(tts).not.toHaveProperty('providers');
  });

  it('preserves an unknown provider selection but contracts its nested settings intermediary', () => {
    const stored = {
      provider: 'acme.voice/speech',
      providers: {
        acme_speech: {
          schemaVersion: 7,
          config: { model: 'acme-v7', nested: { enabled: true } },
        },
      },
    };

    const whileDisabled = parseLocalVoiceSttSettings(stored);
    const afterReinstall = parseLocalVoiceSttSettings(JSON.parse(JSON.stringify(whileDisabled)));

    expect(whileDisabled.provider).toBe('acme.voice/speech');
    expect(whileDisabled).not.toHaveProperty('providers');
    expect(afterReinstall).toEqual(whileDisabled);
  });

  it('ignores nested provider records regardless of their retired intermediary payload', () => {
    const tooManyProviders = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [
      `provider_${index}`,
      { schemaVersion: 1, config: {} },
    ]));
    expect(parseLocalVoiceSttSettings({
      provider: 'happier.voice.openai-compat/stt',
      providers: tooManyProviders,
    })).toMatchObject({ provider: 'happier.voice.openai-compat/stt' });

    expect(parseLocalVoiceTtsSettings({
      provider: 'happier.voice.openai-compat/tts',
      providers: {
        acme_speech: { schemaVersion: 1, config: { payload: 'é'.repeat(140_000) } },
      },
    })).toMatchObject({ provider: 'happier.voice.openai-compat/tts' });
  });
});
