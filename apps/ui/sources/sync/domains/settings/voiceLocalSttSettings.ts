import { z } from 'zod';
import { LocalNeuralExecutionSchema } from '@happier-dev/protocol';

import {
  migrateLegacyGoogleSttSettings,
  normalizeLegacySpeechProviderSelection,
} from './migrations/speechProviders';
import { VoiceLocalSpeechProviderIdSchema } from './voiceLocalSpeechProviderSettings';

export const VoiceLocalSttProviderSchema = VoiceLocalSpeechProviderIdSchema;
export type VoiceLocalSttProvider = z.infer<typeof VoiceLocalSttProviderSchema>;

const VoiceLocalSttLocalNeuralSchema = z
  .object({
    assetId: z.string().nullable().default('sherpa-onnx-streaming-zipformer-en-20M-2023-02-17'),
    language: z.string().nullable().default(null),
    execution: LocalNeuralExecutionSchema.default('auto'),
  })
  .prefault({});

const VoiceLocalSttSchemaV3 = z.object({
  provider: VoiceLocalSttProviderSchema.default('happier.voice.openai-compat/stt'),
  localNeural: VoiceLocalSttLocalNeuralSchema,
});

type VoiceLocalSttV3 = z.infer<typeof VoiceLocalSttSchemaV3>;

function migrateLegacyLocalStt(input: Record<string, unknown>): VoiceLocalSttV3 {
  const useDeviceStt = input.useDeviceStt === true;

  return {
    provider: useDeviceStt ? 'device' : 'happier.voice.openai-compat/stt',
    localNeural: { assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17', language: null, execution: 'auto' },
  };
}

export const VoiceLocalSttSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = migrateLegacyGoogleSttSettings(raw as Record<string, unknown>);

  // Released predecessor rows may still carry inline provider configuration.
  // Current role settings retain only selection and local-neural/device fields;
  // the root Voice settings ingress migrates provider configuration separately.
  if ('provider' in obj || 'localNeural' in obj) {
    return {
      ...obj,
      ...(typeof obj.provider === 'string'
        ? { provider: normalizeLegacySpeechProviderSelection('stt', obj.provider) }
        : {}),
    };
  }

  // Legacy shape (flat openai-compat fields + `useDeviceStt` toggle).
  if ('baseUrl' in obj || 'useDeviceStt' in obj || 'model' in obj || 'apiKey' in obj) {
    return migrateLegacyLocalStt(obj);
  }

  return obj;
}, VoiceLocalSttSchemaV3);

export type VoiceLocalSttSettings = z.infer<typeof VoiceLocalSttSchema>;
