import { z } from '../../zodRuntimePolicy.js';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { maxCodeUnits } from '../../strings/maxCodeUnits.js';
import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 as LIMITS } from '../../runtime/agentSessionLimitsV1.js';

/**
 * Sender of agent text delivered into an Agent's conversation by another agent: a teammate,
 * cross-session or subagent hand-back message. It rides committed agent `message` text as a
 * presentation-only sidecar (`{ type: 'message', message, peer }`); readers that ignore it show
 * the delivered text as ordinary agent prose. It never makes the text user input or the
 * Agent's own reply.
 */
export type TranscriptPeerSenderV1 = Readonly<{
  /** Display name of the sending agent when the Agent reports one. */
  name: string | null;
  /** A subagent's final report handed back to the Agent that delegated to it. */
  handback: boolean;
}>;

export const TranscriptPeerSenderV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.nullable(z.string().check(maxCodeUnits(LIMITS.descriptionMaxCodeUnits))),
  handback: z.boolean(),
}));

/** Tolerant reader for persisted sidecars: a malformed sender is ignored, never fatal to the message. */
export function readTranscriptPeerSenderV1(value: unknown): TranscriptPeerSenderV1 | null {
  const parsed = TranscriptPeerSenderV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
