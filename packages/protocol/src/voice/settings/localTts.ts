import { z } from '../../zodRuntimePolicy.js';
import { KOKORO_DEFAULT_TTS_PACK_ID } from '../modelPacks/catalog.js';
import { LocalNeuralExecutionSchema } from '../../daemon/voiceInference.js';

import {
  migrateLegacyGoogleTtsSettings,
  normalizeLegacySpeechProviderSelection,
} from './migrations/speechProviders.js';
import { VoiceLocalSpeechProviderIdSchema } from './speechProvider.js';

export const VoiceLocalTtsProviderSchema = VoiceLocalSpeechProviderIdSchema;
export type VoiceLocalTtsProvider = z.infer<typeof VoiceLocalTtsProviderSchema>;

const VoiceLocalTtsLocalNeuralSchema = z.prefault(z
  .object({
    model: z._default(z.enum(['kokoro']), 'kokoro'),
    // A stable cross-platform identifier for Kokoro model packs across native and daemon-backed surfaces.
    assetId: z._default(z.nullable(z.string()), KOKORO_DEFAULT_TTS_PACK_ID),
    voiceId: z._default(z.nullable(z.string()), null),
    speed: z._default(z.nullable(z.number().check(z.minimum(0.5), z.maximum(2))), null),
    execution: z._default(LocalNeuralExecutionSchema, 'auto'),
  }), {});

const VoiceLocalTtsSchemaV3 = z.object({
  provider: z._default(VoiceLocalTtsProviderSchema, 'device'),
  localNeural: VoiceLocalTtsLocalNeuralSchema,
  autoSpeakReplies: z._default(z.boolean(), true),
  bargeInEnabled: z._default(z.boolean(), true),
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
  const kokoro = input.kokoro && typeof input.kokoro === 'object' && !Array.isArray(input.kokoro) ? input.kokoro as Record<string, unknown> : null;
  const assetId = typeof kokoro?.assetSetId === 'string' && kokoro.assetSetId.trim().length > 0 ? kokoro.assetSetId.trim() : null;
  const voiceId = typeof kokoro?.voiceId === 'string' && kokoro.voiceId.trim().length > 0 ? kokoro.voiceId.trim() : null;
  const speed = typeof kokoro?.speed === 'number' && Number.isFinite(kokoro.speed) ? kokoro.speed : null;

  const base = VoiceLocalTtsSchemaV3.parse({});
  return {
    ...base,
    provider,
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

export const VoiceLocalTtsSchema = (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => {
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
}), VoiceLocalTtsSchemaV3);

export type VoiceLocalTtsSettings = z.infer<typeof VoiceLocalTtsSchema>;
