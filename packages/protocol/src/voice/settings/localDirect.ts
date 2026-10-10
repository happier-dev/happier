import { z } from 'zod';

import { VoiceLocalSttSchema } from './localStt.js';
import { VoiceLocalTtsSchema } from './localTts.js';
import { VoiceHandsFreeSchema } from './handsFree.js';
import { MAX_VOICE_TIMER_DELAY_MS } from './timing.js';

export const VoiceLocalDirectSchema = z.object({
  stt: VoiceLocalSttSchema.prefault({}),
  tts: VoiceLocalTtsSchema.prefault({}),
  networkTimeoutMs: z.number().int().positive().max(MAX_VOICE_TIMER_DELAY_MS).default(15000),
  handsFree: VoiceHandsFreeSchema.prefault({}),
});

export type VoiceLocalDirectSettings = z.infer<typeof VoiceLocalDirectSchema>;
