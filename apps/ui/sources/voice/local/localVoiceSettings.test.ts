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
          adapters: {
            local_direct: { sentinel: 'direct' },
            local_conversation: { sentinel: 'conversation' },
          },
        },
      }),
    ).toEqual({
      adapterId: 'local_direct',
      config: { sentinel: 'direct' },
    });
  });

  it('trims the STT provider before resolving the local STT provider', () => {
    expect(
      resolveLocalSttProvider({
        voice: {
          providerId: 'local_conversation',
          adapters: {
            local_conversation: {
              stt: { provider: ' device ' },
              handsFree: { enabled: true },
            },
          },
        },
      }),
    ).toBe('device');

    expect(
      isHandsFreeDeviceSttEnabled({
        voice: {
          providerId: 'local_conversation',
          adapters: {
            local_conversation: {
              stt: { provider: ' device ' },
              handsFree: { enabled: true },
            },
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
});
