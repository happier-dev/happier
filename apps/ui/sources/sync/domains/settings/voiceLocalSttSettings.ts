import { z } from 'zod';

import { SecretStringSchema } from '../../encryption/secretSettings';

export const VoiceLocalSttProviderSchema = z.enum(['device', 'openai_compat', 'google_gemini', 'local_neural']);
export type VoiceLocalSttProvider = z.infer<typeof VoiceLocalSttProviderSchema>;

const VoiceLocalSttOpenAiCompatSchema = z
  .object({
    baseUrl: z.string().nullable().default(null),
    apiKey: SecretStringSchema.nullable().default(null),
    model: z.string().default('whisper-1'),
  })
  .default({});

const VoiceLocalSttGoogleGeminiSchema = z
  .object({
    apiKey: SecretStringSchema.nullable().default(null),
    model: z.string().default('gemini-2.5-flash'),
    language: z.string().nullable().default(null),
  })
  .default({});

const VoiceLocalSttLocalNeuralSchema = z
  .object({
    assetId: z.string().nullable().default('sherpa-onnx-streaming-zipformer-en-20M-2023-02-17'),
    language: z.string().nullable().default(null),
  })
  .default({});

const VoiceLocalSttSchemaV2 = z.object({
  provider: VoiceLocalSttProviderSchema.default('openai_compat'),
  openaiCompat: VoiceLocalSttOpenAiCompatSchema,
  googleGemini: VoiceLocalSttGoogleGeminiSchema,
  localNeural: VoiceLocalSttLocalNeuralSchema,
});

type VoiceLocalSttV2 = z.infer<typeof VoiceLocalSttSchemaV2>;

function migrateLegacyLocalStt(input: Record<string, unknown>): VoiceLocalSttV2 {
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl : input.baseUrl === null ? null : null;
  const apiKey = SecretStringSchema.nullable().safeParse(input.apiKey).success
    ? (SecretStringSchema.nullable().parse(input.apiKey) as any)
    : null;
  const model = typeof input.model === 'string' && input.model.trim() ? input.model : 'whisper-1';
  const useDeviceStt = input.useDeviceStt === true;

  const provider: VoiceLocalSttProvider = useDeviceStt ? 'device' : 'openai_compat';

  return {
    provider,
    openaiCompat: {
      baseUrl: baseUrl && baseUrl.trim().length > 0 ? baseUrl.trim() : null,
      apiKey,
      model,
    },
    googleGemini: {
      apiKey: null,
      model: 'gemini-2.5-flash',
      language: null,
    },
    localNeural: { assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17', language: null },
  };
}

export const VoiceLocalSttSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;

  // If the new provider format is present, keep as-is.
  if ('provider' in obj || 'openaiCompat' in obj || 'googleGemini' in obj || 'localNeural' in obj) {
    // Normalize legacy flat `baseUrl` into `openaiCompat.baseUrl` when present.
    if (obj.provider === 'openai_compat' && obj.openaiCompat && typeof obj.openaiCompat === 'object') {
      const legacyBaseUrl = typeof obj.baseUrl === 'string' ? obj.baseUrl.trim() : '';
      const openaiCompat = obj.openaiCompat as Record<string, unknown>;
      const hasOpenaiBaseUrl = typeof openaiCompat.baseUrl === 'string' && String(openaiCompat.baseUrl).trim().length > 0;
      if (!hasOpenaiBaseUrl && legacyBaseUrl) {
        return {
          ...obj,
          openaiCompat: {
            ...openaiCompat,
            baseUrl: legacyBaseUrl,
          },
        };
      }
    }
    return obj;
  }

  // Legacy shape (flat openai-compat fields + `useDeviceStt` toggle).
  if ('baseUrl' in obj || 'useDeviceStt' in obj || 'model' in obj || 'apiKey' in obj) {
    return migrateLegacyLocalStt(obj);
  }

  return obj;
}, VoiceLocalSttSchemaV2);

export type VoiceLocalSttSettings = z.infer<typeof VoiceLocalSttSchema>;
