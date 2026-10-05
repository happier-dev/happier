import { describe, expect, it } from 'vitest';

import { resolveLocalNeuralSttCaptureSettings } from './resolveLocalNeuralSttCaptureSettings';

describe('resolveLocalNeuralSttCaptureSettings', () => {
  it('keeps conversation recognition separate from reply and the per-purpose Dictation override', () => {
    const settings = { voice: {
      providerId: 'local_direct', assistantLanguage: 'es', dictation: { language: ' de ' },
      providers: { local_direct: { schemaVersion: 1, config: {
        stt: { provider: 'local_neural', localNeural: { assetId: 'selected-pack', language: 'fr' } },
      } } },
    } };
    expect(resolveLocalNeuralSttCaptureSettings(settings, 'conversation')).toEqual({ packId: 'selected-pack', language: 'fr' });
    expect(resolveLocalNeuralSttCaptureSettings(settings, 'dictation')).toEqual({ packId: 'selected-pack', language: 'de' });
    expect(resolveLocalNeuralSttCaptureSettings({ voice: { ...settings.voice, dictation: { language: null } } }, 'dictation'))
      .toEqual({ packId: 'selected-pack', language: null });
    expect(resolveLocalNeuralSttCaptureSettings({ voice: { ...settings.voice, providers: {
      local_direct: { schemaVersion: 1, config: { stt: { provider: 'local_neural', localNeural: { assetId: 'selected-pack', language: null } } } },
    } } }, 'conversation')).toEqual({ packId: 'selected-pack', language: null });
  });
  it('resolves the active adapter local-neural pack and language with schema defaults', () => {
    expect(resolveLocalNeuralSttCaptureSettings({
      voice: {
        providerId: 'local_conversation',
        providers: {
          local_conversation: { schemaVersion: 1, config: {
            stt: {
              provider: 'local_neural',
              localNeural: {
                assetId: 'custom-stt-pack',
                language: ' en ',
                execution: 'daemon',
              },
            },
          } },
        },
      },
    })).toEqual({
      packId: 'custom-stt-pack',
      language: 'en',
    });
  });

  it('falls back to the schema default pack and null language for malformed settings', () => {
    expect(resolveLocalNeuralSttCaptureSettings({
      voice: {
        providerId: 'local_direct',
        providers: {
          local_direct: { schemaVersion: 1, config: {
            stt: {
              localNeural: {
                assetId: '',
                language: '   ',
              },
            },
          } },
        },
      },
    })).toEqual({
      packId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
      language: null,
    });
  });
});
