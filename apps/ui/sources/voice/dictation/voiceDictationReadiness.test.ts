import { describe, expect, it } from 'vitest';

import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { resolveVoiceProviderLocalAvailability } from '@/voice/settings/voiceProviderLocalAvailability';

import { resolveVoiceDictationReadiness } from './voiceDictationReadiness';

describe('resolveVoiceDictationReadiness', () => {
  const registry = createDefaultVoiceProviderRegistry();

  it('projects device Dictation as ready only when native speech recognition is known available', () => {
    expect(resolveVoiceDictationReadiness({
      registry,
      platform: 'ios',
      executionMachineId: null,
      daemon: null,
      localAvailability: resolveVoiceProviderLocalAvailability({
        platformOs: 'ios',
        daemonFeatureEnabled: false,
        serverFeatures: null,
        nativeDeviceSpeechRecognition: 'available',
      }),
      settings: {
        voice: {
          dictation: {
            sttBinding: 'explicit',
            language: null,
            stt: { provider: 'device' },
          },
        },
      },
    })).toMatchObject({
      providerId: 'device',
      status: 'ready',
      code: 'ready',
    });
  });

  it.each([
    ['unavailable', 'device_stt_unavailable'],
    ['unknown', 'device_stt_availability_unknown'],
  ] as const)(
    'fails native device Dictation closed when speech recognition is %s',
    (nativeDeviceSpeechRecognition, code) => {
      expect(resolveVoiceDictationReadiness({
        registry,
        platform: 'ios',
        executionMachineId: null,
        daemon: null,
        localAvailability: resolveVoiceProviderLocalAvailability({
          platformOs: 'ios',
          daemonFeatureEnabled: false,
          serverFeatures: null,
          nativeDeviceSpeechRecognition,
        }),
        settings: {
          voice: {
            dictation: {
              sttBinding: 'explicit',
              language: null,
              stt: { provider: 'device' },
            },
          },
        },
      })).toMatchObject({
        providerId: 'device',
        status: 'unavailable',
        code,
      });
    },
  );

  it('fails web device Dictation closed when passive browser speech support is unknown', () => {
    expect(resolveVoiceDictationReadiness({
      registry,
      platform: 'web',
      executionMachineId: null,
      daemon: null,
      localAvailability: resolveVoiceProviderLocalAvailability({
        platformOs: 'web',
        daemonFeatureEnabled: false,
        serverFeatures: null,
        browserSpeechCapability: { support: 'unknown', onDevice: 'unknown' },
      }),
      settings: {
        voice: {
          dictation: {
            sttBinding: 'explicit',
            language: null,
            stt: { provider: 'device' },
          },
        },
      },
    })).toMatchObject({
      providerId: 'device',
      status: 'unavailable',
      code: 'device_stt_availability_unknown',
    });
  });

  it('fails an explicit OpenAI-compatible selection closed when its machine is missing', () => {
    expect(resolveVoiceDictationReadiness({
      registry,
      platform: 'web',
      executionMachineId: null,
      daemon: null,
      localAvailability: resolveVoiceProviderLocalAvailability({
        platformOs: 'web',
        daemonFeatureEnabled: false,
        serverFeatures: null,
      }),
      settings: {
        voice: {
          dictation: {
            sttBinding: 'explicit',
            language: 'en-US',
            stt: {
              provider: 'openai_compat',
              openaiCompat: {
                baseUrl: 'https://speech.example.test/v1',
                model: 'whisper-1',
              },
            },
          },
        },
      },
    })).toMatchObject({
      providerId: 'openai_compat',
      status: 'needs_setup',
      code: 'execution_machine_missing',
    });
  });
});
