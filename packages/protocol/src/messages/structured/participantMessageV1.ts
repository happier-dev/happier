import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { ExecutionRunIdSchema } from '../../sessions/idsV1.js';

/**
 * Provider-agnostic structured payload for user messages that are routed to a specific participant
 * (agent-team teammate/broadcast, or a running execution run).
 *
 * Transport:
 * - Stored on the session transcript user message under `meta.happier`.
 * - The backend may use this meta to perform provider-specific routing (e.g. Claude Agent Teams).
 */

const executionRunRecipient = z.object({
    kind: z.literal('execution_run'),
    runId: z.string().min(1),
    label: z.string().min(1).max(200).optional(),
  });
const teamMemberRecipient = z.object({
    kind: z.literal('agent_team_member'),
    teamId: z.string().min(1),
    memberId: z.string().min(1),
    memberLabel: z.string().min(1).max(200).optional(),
  });
const teamBroadcastRecipient = z.object({
    kind: z.literal('agent_team_broadcast'),
    teamId: z.string().min(1),
  });

export const ParticipantRecipientV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  executionRunRecipient.passthrough(),
  teamMemberRecipient.passthrough(),
  teamBroadcastRecipient.passthrough(),
]));
export type ParticipantRecipientV1 = z.infer<typeof ParticipantRecipientV1Schema>;

export const ParticipantExecutionRunRecipientRoutingIdentityV1Schema = executionRunRecipient
  .omit({ label: true }).extend({ runId: ExecutionRunIdSchema }).strict();
export type ParticipantExecutionRunRecipientRoutingIdentityV1 = z.infer<
  typeof ParticipantExecutionRunRecipientRoutingIdentityV1Schema
>;
export const ParticipantRecipientRoutingIdentityV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ParticipantExecutionRunRecipientRoutingIdentityV1Schema,
  teamMemberRecipient.omit({ memberLabel: true }).extend({
    teamId: z.string().trim().min(1), memberId: z.string().trim().min(1),
  }).strict(),
  teamBroadcastRecipient.extend({ teamId: z.string().trim().min(1) }).strict(),
]));
export type ParticipantRecipientRoutingIdentityV1 = z.infer<typeof ParticipantRecipientRoutingIdentityV1Schema>;

const authoredRecipientSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  executionRunRecipient.strict(), teamMemberRecipient.strict(), teamBroadcastRecipient.strict(),
]));

/** Known display labels may be consumed at authoring, but never enter operational routing. */
export function normalizeParticipantRecipientRoutingIdentityV1(input: unknown): ParticipantRecipientRoutingIdentityV1 {
  const recipient = authoredRecipientSchema.parse(input);
  if (recipient.kind === 'execution_run') {
    return ParticipantRecipientRoutingIdentityV1Schema.parse({ kind: recipient.kind, runId: recipient.runId });
  }
  if (recipient.kind === 'agent_team_member') {
    return ParticipantRecipientRoutingIdentityV1Schema.parse({ kind: recipient.kind, teamId: recipient.teamId, memberId: recipient.memberId });
  }
  return ParticipantRecipientRoutingIdentityV1Schema.parse(recipient);
}

/** Projects participant metadata unless canonical Pending routing already owns a typed Run input. */
export function withParticipantRecipientV1(
  meta: Record<string, unknown>,
  input: ParticipantRecipientV1 | undefined,
): Record<string, unknown> {
  if (input === undefined) return meta;
  const recipient = normalizeParticipantRecipientRoutingIdentityV1(input);
  const content = meta.happier;
  // Attached Run routing lives in the canonical Pending target, independently
  // of the existing typed comment/media envelope. Their admission owners still
  // validate permissions, content and size; routing must not replace that input.
  if (recipient.kind === 'execution_run' && content !== null && typeof content === 'object'
    && 'kind' in content && (content.kind === 'review_comments.v1' || content.kind === 'attachments.v1')) {
    return meta;
  }
  if (meta.happier !== undefined) {
    const envelope = z.object({
      kind: z.literal('participant_message.v1'),
      payload: z.object({ recipient: authoredRecipientSchema }).strict(),
    }).strict().parse(meta.happier);
    const existing = normalizeParticipantRecipientRoutingIdentityV1(envelope.payload.recipient);
    if (JSON.stringify(existing) !== JSON.stringify(recipient)) {
      throw new Error('Session input recipient contradicts authored participant metadata');
    }
  }
  return { ...meta, happier: { kind: 'participant_message.v1', payload: { recipient } } };
}

/** Reads only closed operational metadata, independently of the historical display parser. */
export function readParticipantRecipientRoutingIdentityV1(meta: unknown): ParticipantRecipientRoutingIdentityV1 | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const parsed = z.object({
    kind: z.literal('participant_message.v1'),
    payload: z.object({ recipient: ParticipantRecipientRoutingIdentityV1Schema }).strict(),
  }).strict().safeParse((meta as Record<string, unknown>).happier);
  return parsed.success ? parsed.data.payload.recipient : null;
}

export const ParticipantMessageV1Schema = lazyZodSchema(() => z.object({
  recipient: ParticipantRecipientV1Schema,
}).passthrough());
export type ParticipantMessageV1 = z.infer<typeof ParticipantMessageV1Schema>;

export function parseParticipantMessageV1(input: unknown): ParticipantMessageV1 | null {
  const parsed = ParticipantMessageV1Schema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
