import { z } from 'zod';
import { LocalNeuralExecutionSchema } from '@happier-dev/protocol';

import { SecretStringSchema } from '../../encryption/secretSettings';
import { migrateLegacyGoogleSttSettings } from './migrations/legacyGoogleSpeechSettingsMigration';
import {
  VoiceLocalSpeechProviderIdSchema,
  VoiceLocalSpeechProviderSettingsRecordSchema,
} from './voiceLocalSpeechProviderSettings';

export const VoiceLocalSttProviderSchema = VoiceLocalSpeechProviderIdSchema;
export type VoiceLocalSttProvider = z.infer<typeof VoiceLocalSttProviderSchema>;

const VoiceLocalSttOpenAiCompatSchema = z
  .object({
    baseUrl: z.string().nullable().default(null),
    insecureLocalOriginConsent: z.string().url().nullable().default(null),
    insecureLocalConsentMachineId: z.string().min(1).max(256).nullable().default(null),
    apiKey: SecretStringSchema.nullable().default(null),
    model: z.string().default('whisper-1'),
  })
  .prefault({});

const VoiceLocalSttLocalNeuralSchema = z
  .object({
    assetId: z.string().nullable().default('sherpa-onnx-streaming-zipformer-en-20M-2023-02-17'),
    language: z.string().nullable().default(null),
    execution: LocalNeuralExecutionSchema.default('auto'),
  })
  .prefault({});

const VoiceLocalSttSchemaV3 = z.object({
  provider: VoiceLocalSttProviderSchema.default('openai_compat'),
  openaiCompat: VoiceLocalSttOpenAiCompatSchema,
  localNeural: VoiceLocalSttLocalNeuralSchema,
  providers: VoiceLocalSpeechProviderSettingsRecordSchema.default({}),
});

type VoiceLocalSttV3 = z.infer<typeof VoiceLocalSttSchemaV3>;

function migrateLegacyLocalStt(input: Record<string, unknown>): VoiceLocalSttV3 {
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
      insecureLocalOriginConsent: null,
      insecureLocalConsentMachineId: null,
      apiKey,
      model,
    },
    localNeural: { assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17', language: null, execution: 'auto' },
    providers: {},
  };
}

export const VoiceLocalSttSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = migrateLegacyGoogleSttSettings(raw as Record<string, unknown>);

  // If the new provider format is present, keep as-is.
  if ('provider' in obj || 'openaiCompat' in obj || 'localNeural' in obj || 'providers' in obj) {
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
}, VoiceLocalSttSchemaV3);

export type VoiceLocalSttSettings = z.infer<typeof VoiceLocalSttSchema>;
