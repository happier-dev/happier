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

  it('parses legacy STT and TTS adapter settings through the canonical schemas', () => {
    expect(
      parseLocalVoiceSttSettings({
        useDeviceStt: true,
        baseUrl: ' http://legacy-stt.example/v1 ',
      }),
    ).toMatchObject({
      provider: 'device',
      openaiCompat: {
        baseUrl: 'http://legacy-stt.example/v1',
      },
    });

    expect(
      parseLocalVoiceTtsSettings({
        baseUrl: ' http://legacy-tts.example/v1 ',
        model: 'tts-1-hd',
        voice: 'alloy',
      }),
    ).toMatchObject({
      provider: 'openai_compat',
      openaiCompat: {
        baseUrl: 'http://legacy-tts.example/v1',
        model: 'tts-1-hd',
        voice: 'alloy',
      },
    });
  });

  it('migrates legacy Google speech fields into versioned provider envelopes without retaining vendor fields', () => {
    const stt = parseLocalVoiceSttSettings({
      provider: 'google_gemini',
      googleGemini: { model: 'gemini-test', language: 'fr' },
    });
    const tts = parseLocalVoiceTtsSettings({
      provider: 'google_cloud',
      googleCloud: { voiceName: 'fr-FR-Test-A', languageCode: 'fr-FR', format: 'wav' },
    });

    expect(stt).toMatchObject({
      provider: 'google_gemini',
      providers: {
        google_gemini: {
          schemaVersion: 1,
          config: { model: 'gemini-test', language: 'fr' },
        },
      },
    });
    expect(tts).toMatchObject({
      provider: 'google_cloud',
      providers: {
        google_cloud: {
          schemaVersion: 1,
          config: { voiceName: 'fr-FR-Test-A', languageCode: 'fr-FR', format: 'wav' },
        },
      },
    });
    expect(stt).not.toHaveProperty('googleGemini');
    expect(tts).not.toHaveProperty('googleCloud');
  });

  it('preserves unknown provider envelopes inertly across disable and reinstall parsing', () => {
    const stored = {
      provider: 'acme_speech',
      providers: {
        acme_speech: {
          schemaVersion: 7,
          config: { model: 'acme-v7', nested: { enabled: true } },
        },
      },
    };

    const whileDisabled = parseLocalVoiceSttSettings(stored);
    const afterReinstall = parseLocalVoiceSttSettings(JSON.parse(JSON.stringify(whileDisabled)));

    expect(whileDisabled.provider).toBe('acme_speech');
    expect(whileDisabled.providers.acme_speech).toEqual(stored.providers.acme_speech);
    expect(afterReinstall).toEqual(whileDisabled);
  });

  it('rejects provider records that exceed the host storage bounds', () => {
    const tooManyProviders = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [
      `provider_${index}`,
      { schemaVersion: 1, config: {} },
    ]));
    expect(() => parseLocalVoiceSttSettings({
      provider: 'openai_compat',
      providers: tooManyProviders,
    })).toThrow();

    expect(() => parseLocalVoiceTtsSettings({
      provider: 'openai_compat',
      providers: {
        acme_speech: { schemaVersion: 1, config: { payload: 'é'.repeat(140_000) } },
      },
    })).toThrow();
  });
});
