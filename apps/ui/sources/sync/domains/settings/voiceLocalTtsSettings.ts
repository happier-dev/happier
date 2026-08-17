import { z } from 'zod';
import { KOKORO_DEFAULT_TTS_PACK_ID, LocalNeuralExecutionSchema } from '@happier-dev/protocol';

import {
  migrateLegacyGoogleTtsSettings,
  normalizeLegacySpeechProviderSelection,
} from './migrations/speechProviders';
import { VoiceLocalSpeechProviderIdSchema } from './voiceLocalSpeechProviderSettings';

export const VoiceLocalTtsProviderSchema = VoiceLocalSpeechProviderIdSchema;
export type VoiceLocalTtsProvider = z.infer<typeof VoiceLocalTtsProviderSchema>;

const VoiceLocalTtsLocalNeuralSchema = z
  .object({
    model: z.enum(['kokoro']).default('kokoro'),
    // A stable cross-platform identifier for Kokoro model packs across native and daemon-backed surfaces.
    assetId: z.string().nullable().default(KOKORO_DEFAULT_TTS_PACK_ID),
    voiceId: z.string().nullable().default(null),
    speed: z.number().min(0.5).max(2).nullable().default(null),
    execution: LocalNeuralExecutionSchema.default('auto'),
  })
  .prefault({});

const VoiceLocalTtsSchemaV3 = z.object({
  provider: VoiceLocalTtsProviderSchema.default('happier.voice.openai-compat/tts'),
  localNeural: VoiceLocalTtsLocalNeuralSchema,
  autoSpeakReplies: z.boolean().default(true),
  bargeInEnabled: z.boolean().default(true),
});

type VoiceLocalTtsV3 = z.infer<typeof VoiceLocalTtsSchemaV3>;

function migrateLegacyLocalTts(input: Record<string, unknown>): VoiceLocalTtsV3 {
  const useDeviceTts = input.useDeviceTts === true;
  const autoSpeakReplies = input.autoSpeakReplies !== false;
  const bargeInEnabled = input.bargeInEnabled !== false;

  return {
    provider: useDeviceTts ? 'device' : 'happier.voice.openai-compat/tts',
    localNeural: { model: 'kokoro', assetId: KOKORO_DEFAULT_TTS_PACK_ID, voiceId: null, speed: null, execution: 'auto' },
    autoSpeakReplies,
    bargeInEnabled,
  };
}

function migrateKokoroProviderToLocalNeural(input: Record<string, unknown>): VoiceLocalTtsV3 {
  const provider = input.provider === 'device' ? 'device' : 'local_neural';
  const kokoro = (input.kokoro && typeof input.kokoro === 'object' ? input.kokoro : null) as any;
  const assetId = typeof kokoro?.assetSetId === 'string' && kokoro.assetSetId.trim().length > 0 ? kokoro.assetSetId.trim() : null;
  const voiceId = typeof kokoro?.voiceId === 'string' && kokoro.voiceId.trim().length > 0 ? kokoro.voiceId.trim() : null;
  const speed = typeof kokoro?.speed === 'number' && Number.isFinite(kokoro.speed) ? kokoro.speed : null;

  const base = VoiceLocalTtsSchemaV3.parse({});
  return {
    ...base,
    provider: provider as any,
    localNeural: {
      model: 'kokoro',
      assetId,
      voiceId,
      speed,
      execution: 'auto',
    },
    autoSpeakReplies: input.autoSpeakReplies !== false,
    bargeInEnabled: input.bargeInEnabled !== false,
  };
}

export const VoiceLocalTtsSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = migrateLegacyGoogleTtsSettings(raw as Record<string, unknown>);

  // If the new provider format is present, keep as-is.
  if (obj.provider === 'kokoro' || 'kokoro' in obj) {
    return migrateKokoroProviderToLocalNeural(obj);
  }

  if ('provider' in obj || 'localNeural' in obj) {
    return {
      ...obj,
      ...(typeof obj.provider === 'string'
        ? { provider: normalizeLegacySpeechProviderSelection('tts', obj.provider) }
        : {}),
    };
  }

  // Legacy shape (flat openai-compat fields + `useDeviceTts` toggle).
  if ('baseUrl' in obj || 'useDeviceTts' in obj || 'format' in obj || 'voice' in obj || 'model' in obj) {
    return migrateLegacyLocalTts(obj);
  }

  return obj;
}, VoiceLocalTtsSchemaV3);

export type VoiceLocalTtsSettings = z.infer<typeof VoiceLocalTtsSchema>;
