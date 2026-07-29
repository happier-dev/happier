import { z } from 'zod';

const LEGACY_HANDS_FREE_ENDPOINTING_DEFAULTS = {
  silenceMs: 450,
  minSpeechMs: 120,
} as const;

export const VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS = {
  silenceMs: 5000,
  minSpeechMs: 1000,
} as const;

function migrateLegacyHandsFreeDefaults(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  const endpointing = value.endpointing;
  if (!endpointing || typeof endpointing !== 'object' || Array.isArray(endpointing)) return raw;

  const endpointingRecord = endpointing as Record<string, unknown>;
  const silenceMs = endpointingRecord.silenceMs;
  const minSpeechMs = endpointingRecord.minSpeechMs;
  const nextSilenceMs = silenceMs === LEGACY_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs
    ? VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs
    : silenceMs;
  const nextMinSpeechMs = minSpeechMs === LEGACY_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs
    ? VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs
    : minSpeechMs;

  if (nextSilenceMs === silenceMs && nextMinSpeechMs === minSpeechMs) return raw;
  return {
    ...value,
    endpointing: {
      ...endpointingRecord,
      silenceMs: nextSilenceMs,
      minSpeechMs: nextMinSpeechMs,
    },
  };
}

export const VoiceHandsFreeSchema = z.preprocess(
  migrateLegacyHandsFreeDefaults,
  z
    .object({
      enabled: z.boolean().default(false),
      endpointing: z
        .object({
          silenceMs: z.number().int().min(0).max(5000).default(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs),
          minSpeechMs: z.number().int().min(0).max(5000).default(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs),
        })
        .prefault({}),
    })
    .default({
      enabled: false,
      endpointing: {
        silenceMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
        minSpeechMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
      },
    }),
);
