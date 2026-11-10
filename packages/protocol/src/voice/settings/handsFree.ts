import { z } from '../../zodRuntimePolicy.js';
import { MAX_VOICE_TIMER_DELAY_MS } from './timing.js';

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

export const VoiceHandsFreeSchema = (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(migrateLegacyHandsFreeDefaults), z._default(z
    .object({
      enabled: z._default(z.boolean(), false),
      endpointing: z.prefault(z
        .object({
          silenceMs: z._default(z.number().check(z.int(), z.minimum(0), z.maximum(MAX_VOICE_TIMER_DELAY_MS)), VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs),
          minSpeechMs: z._default(z.number().check(z.int(), z.minimum(0), z.maximum(MAX_VOICE_TIMER_DELAY_MS)), VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs),
        }), {}),
    }), {
      enabled: false,
      endpointing: {
        silenceMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
        minSpeechMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
      },
    }));
