import { z } from 'zod';

import { SecretStringSchema } from '../../encryption/secretSettings';

export const VoiceLocalTtsProviderSchema = z.enum(['device', 'openai_compat', 'google_cloud', 'local_neural']);
export type VoiceLocalTtsProvider = z.infer<typeof VoiceLocalTtsProviderSchema>;

const VoiceLocalTtsOpenAiCompatSchema = z
  .object({
    baseUrl: z.string().nullable().default(null),
    apiKey: SecretStringSchema.nullable().default(null),
    model: z.string().default('tts-1'),
    voice: z.string().default('alloy'),
    format: z.enum(['mp3', 'wav']).default('mp3'),
  })
  .default({});

const VoiceLocalTtsLocalNeuralSchema = z
  .object({
    model: z.enum(['kokoro']).default('kokoro'),
    // A stable cross-platform identifier; resolves to:
    // - native: a downloadable model pack manifest (Sherpa)
    // - web: a kokoro-js runtime config preset
    assetId: z.string().nullable().default('kokoro-82m-v1.0-onnx-q8-wasm'),
    voiceId: z.string().nullable().default(null),
    speed: z.number().min(0.5).max(2).nullable().default(null),
  })
  .default({});

const VoiceLocalTtsGoogleCloudSchema = z
  .object({
    apiKey: SecretStringSchema.nullable().default(null),
    androidCertSha1: z.string().nullable().default(null),
    voiceName: z.string().nullable().default(null),
    languageCode: z.string().nullable().default(null),
    format: z.enum(['mp3', 'wav']).default('mp3'),
    speakingRate: z.number().min(0.25).max(4).nullable().default(null),
    pitch: z.number().min(-20).max(20).nullable().default(null),
  })
  .default({});

const VoiceLocalTtsSchemaV2 = z.object({
  provider: VoiceLocalTtsProviderSchema.default('openai_compat'),
  openaiCompat: VoiceLocalTtsOpenAiCompatSchema,
  localNeural: VoiceLocalTtsLocalNeuralSchema,
  googleCloud: VoiceLocalTtsGoogleCloudSchema,
  autoSpeakReplies: z.boolean().default(true),
  bargeInEnabled: z.boolean().default(true),
});

type VoiceLocalTtsV2 = z.infer<typeof VoiceLocalTtsSchemaV2>;

function migrateLegacyLocalTts(input: Record<string, unknown>): VoiceLocalTtsV2 {
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl : input.baseUrl === null ? null : null;
  const apiKey = SecretStringSchema.nullable().safeParse(input.apiKey).success
    ? (SecretStringSchema.nullable().parse(input.apiKey) as any)
    : null;
  const model = typeof input.model === 'string' && input.model.trim() ? input.model : 'tts-1';
  const voice = typeof input.voice === 'string' && input.voice.trim() ? input.voice : 'alloy';
  const formatRaw = typeof input.format === 'string' ? input.format : 'mp3';
  const format = formatRaw === 'wav' ? 'wav' : 'mp3';
  const useDeviceTts = input.useDeviceTts === true;
  const autoSpeakReplies = input.autoSpeakReplies !== false;
  const bargeInEnabled = input.bargeInEnabled !== false;

  const provider: VoiceLocalTtsProvider =
    useDeviceTts ? 'device' : baseUrl && baseUrl.trim().length > 0 ? 'openai_compat' : 'openai_compat';

  return {
    provider,
    openaiCompat: {
      baseUrl: baseUrl && baseUrl.trim().length > 0 ? baseUrl.trim() : null,
      apiKey,
      model,
      voice,
      format,
    },
    localNeural: { model: 'kokoro', assetId: 'kokoro-82m-v1.0-onnx-q8-wasm', voiceId: null, speed: null },
    googleCloud: {
      apiKey: null,
      androidCertSha1: null,
      voiceName: null,
      languageCode: null,
      format: 'mp3',
      speakingRate: null,
      pitch: null,
    },
    autoSpeakReplies,
    bargeInEnabled,
  };
}

function migrateKokoroProviderToLocalNeural(input: Record<string, unknown>): VoiceLocalTtsV2 {
  const provider = input.provider === 'device' ? 'device' : 'local_neural';
  const kokoro = (input.kokoro && typeof input.kokoro === 'object' ? input.kokoro : null) as any;
  const assetId = typeof kokoro?.assetSetId === 'string' && kokoro.assetSetId.trim().length > 0 ? kokoro.assetSetId.trim() : null;
  const voiceId = typeof kokoro?.voiceId === 'string' && kokoro.voiceId.trim().length > 0 ? kokoro.voiceId.trim() : null;
  const speed = typeof kokoro?.speed === 'number' && Number.isFinite(kokoro.speed) ? kokoro.speed : null;

  const base = VoiceLocalTtsSchemaV2.parse({});
  return {
    ...base,
    provider: provider as any,
    localNeural: {
      model: 'kokoro',
      assetId,
      voiceId,
      speed,
    },
    autoSpeakReplies: input.autoSpeakReplies !== false,
    bargeInEnabled: input.bargeInEnabled !== false,
  };
}

export const VoiceLocalTtsSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;

  // If the new provider format is present, keep as-is.
  if ('provider' in obj || 'openaiCompat' in obj || 'localNeural' in obj) {
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

  // Legacy shape (flat openai-compat fields + `useDeviceTts` toggle).
  if ('baseUrl' in obj || 'useDeviceTts' in obj || 'format' in obj || 'voice' in obj || 'model' in obj) {
    return migrateLegacyLocalTts(obj);
  }

  // Legacy v2 shape: kokoro provider config.
  if ('kokoro' in obj || obj.provider === 'kokoro') {
    return migrateKokoroProviderToLocalNeural(obj);
  }

  return obj;
}, VoiceLocalTtsSchemaV2);

export type VoiceLocalTtsSettings = z.infer<typeof VoiceLocalTtsSchema>;
