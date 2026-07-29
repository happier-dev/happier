import { describe, expect, it } from 'vitest';

import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

import { resolveVoiceDictationReadiness } from './voiceDictationReadiness';

describe('resolveVoiceDictationReadiness', () => {
  const registry = createDefaultVoiceProviderRegistry();

  it('projects device Dictation as ready without opening a microphone or provider session', () => {
    expect(resolveVoiceDictationReadiness({
      registry,
      platform: 'ios',
      executionMachineId: null,
      daemon: null,
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

  it('fails an explicit OpenAI-compatible selection closed when its machine is missing', () => {
    expect(resolveVoiceDictationReadiness({
      registry,
      platform: 'web',
      executionMachineId: null,
      daemon: null,
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
