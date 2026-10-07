import { z } from 'zod';

import { VoiceLocalSttSchema } from '@/sync/domains/settings/voiceLocalSttSettings';
import { VoiceLocalTtsSchema } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { VoiceHandsFreeSchema } from '@/voice/adapters/local/settings';
import { MAX_VOICE_TIMER_DELAY_MS } from '@/voice/runtime/input/TurnEndpointDetector';

export const VoiceLocalDirectSchema = z.object({
  stt: VoiceLocalSttSchema.prefault({}),
  tts: VoiceLocalTtsSchema.prefault({}),
  networkTimeoutMs: z.number().int().positive().max(MAX_VOICE_TIMER_DELAY_MS).default(15000),
  handsFree: VoiceHandsFreeSchema.prefault({}),
});

export type VoiceLocalDirectSettings = z.infer<typeof VoiceLocalDirectSchema>;
