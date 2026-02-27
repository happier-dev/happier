import { z } from 'zod';

/**
 * Provider-agnostic structured payload for user messages that are routed to a specific participant
 * (agent-team teammate/broadcast, or a running execution run).
 *
 * Transport:
 * - Stored on the session transcript user message under `meta.happier`.
 * - The backend may use this meta to perform provider-specific routing (e.g. Claude Agent Teams).
 */

export const ParticipantRecipientV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('execution_run'),
    runId: z.string().min(1),
    label: z.string().min(1).max(200).optional(),
  }).passthrough(),
  z.object({
    kind: z.literal('agent_team_member'),
    teamId: z.string().min(1),
    memberId: z.string().min(1),
    memberLabel: z.string().min(1).max(200).optional(),
  }).passthrough(),
  z.object({
    kind: z.literal('agent_team_broadcast'),
    teamId: z.string().min(1),
  }).passthrough(),
]);
export type ParticipantRecipientV1 = z.infer<typeof ParticipantRecipientV1Schema>;

export const ParticipantMessageV1Schema = z.object({
  recipient: ParticipantRecipientV1Schema,
}).passthrough();
export type ParticipantMessageV1 = z.infer<typeof ParticipantMessageV1Schema>;

export function parseParticipantMessageV1(input: unknown): ParticipantMessageV1 | null {
  const parsed = ParticipantMessageV1Schema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

