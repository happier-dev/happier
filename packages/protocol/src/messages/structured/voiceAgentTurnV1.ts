import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

/**
 * Structured meta payload for a persisted voice agent transcript turn.
 *
 * This is emitted under `meta.happier.kind='voice_agent_turn.v1'` by the daemon voice agent runtime.
 * The UI voice sidebar uses these entries to hydrate the local voice activity feed without needing
 * to render special transcript cards in the main session timeline.
 */
export const VoiceAgentTurnV1Schema = lazyZodSchema(() => z.looseObject({
  v: z.literal(1),
  epoch: z.number().check(z.int(), z.minimum(0)),
  role: z.enum(['user', 'assistant']),
  voiceAgentId: z.string().check(z.minLength(1)),
  runId: z.optional(z.string().check(z.minLength(1))),
  streamId: z.optional(z.string().check(z.minLength(1))),
  requestId: z.optional(z.string().check(z.minLength(1))),
  ts: z.number().check(z.int(), z.minimum(0)),
}));

export type VoiceAgentTurnV1 = z.infer<typeof VoiceAgentTurnV1Schema>;
