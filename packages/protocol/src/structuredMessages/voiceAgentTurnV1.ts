import { z } from 'zod';

/**
 * Structured meta payload for a persisted voice agent transcript turn.
 *
 * This is emitted under `meta.happier.kind='voice_agent_turn.v1'` by the daemon voice agent runtime.
 * The UI voice sidebar uses these entries to hydrate the local voice activity feed without needing
 * to render special transcript cards in the main session timeline.
 */
export const VoiceAgentTurnV1Schema = z.object({
  v: z.literal(1),
  epoch: z.number().int().min(0),
  role: z.enum(['user', 'assistant']),
  voiceAgentId: z.string().min(1),
  ts: z.number().int().min(0),
}).passthrough();

export type VoiceAgentTurnV1 = z.infer<typeof VoiceAgentTurnV1Schema>;

