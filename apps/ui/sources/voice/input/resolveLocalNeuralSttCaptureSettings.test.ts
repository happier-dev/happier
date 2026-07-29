import { describe, expect, it } from 'vitest';

import { resolveLocalNeuralSttCaptureSettings } from './resolveLocalNeuralSttCaptureSettings';

describe('resolveLocalNeuralSttCaptureSettings', () => {
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
