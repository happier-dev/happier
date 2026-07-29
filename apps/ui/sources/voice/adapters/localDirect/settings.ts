import { z } from 'zod';

import { VoiceLocalSttSchema } from '@/sync/domains/settings/voiceLocalSttSettings';
import { VoiceLocalTtsSchema } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { VoiceHandsFreeSchema } from '@/voice/adapters/local/settings';

export const VoiceLocalDirectSchema = z.object({
  stt: VoiceLocalSttSchema.prefault({}),
  tts: VoiceLocalTtsSchema.prefault({}),
  networkTimeoutMs: z.number().int().min(1000).max(60000).default(15000),
  handsFree: VoiceHandsFreeSchema.prefault({}),
});

export type VoiceLocalDirectSettings = z.infer<typeof VoiceLocalDirectSchema>;
