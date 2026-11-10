import { z } from '../../zodRuntimePolicy.js';

import { VoiceLocalSttSchema } from './localStt.js';
import { VoiceLocalTtsSchema } from './localTts.js';
import { VoiceHandsFreeSchema } from './handsFree.js';
import { MAX_VOICE_TIMER_DELAY_MS } from './timing.js';

export const VoiceLocalDirectSchema = z.object({
  stt: z.prefault(VoiceLocalSttSchema, {}),
  tts: z.prefault(VoiceLocalTtsSchema, {}),
  networkTimeoutMs: z._default(z.number().check(z.int(), z.positive(), z.maximum(MAX_VOICE_TIMER_DELAY_MS)), 15000),
  handsFree: z.prefault(VoiceHandsFreeSchema, {}),
});

export type VoiceLocalDirectSettings = z.infer<typeof VoiceLocalDirectSchema>;
