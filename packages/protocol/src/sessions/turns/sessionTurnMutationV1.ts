import { z } from 'zod';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

import { SessionIdSchema, SessionIndexedIdentifierMaxLengthV1, TurnIdSchema } from '../idsV1.js';
import { SessionRuntimeIssueV1Schema } from '../control/runtimeIssueV1.js';
import { normalizeLegacySessionTurnAgentIdentity } from './compat/agentIdentity.js';
import {
  AgentSessionProviderCheckpointMaxJsonBytesV1,
  AgentSessionProviderCheckpointV1Schema,
} from '../../runtime/agentSessionV1.js';
import { AgentIdV1Schema } from '../../agents/agentIdV1.js';

const SessionTurnMutationIdV1Schema = z.string().trim().min(1).max(SessionIndexedIdentifierMaxLengthV1);
const SessionTurnAgentIdV1Schema = AgentIdV1Schema;
const SessionTurnAgentTurnIdV1Schema = z.string().trim().min(1).max(SessionIndexedIdentifierMaxLengthV1);
const SessionTurnObservedAtV1Schema = z.number().int().nonnegative();
const SessionTurnReasonV1Schema = z.string().trim().min(1).max(256);
export const SessionTurnProviderCheckpointMaxJsonBytesV1 =
  AgentSessionProviderCheckpointMaxJsonBytesV1;
export const SessionTurnProviderCheckpointV1Schema =
  AgentSessionProviderCheckpointV1Schema;
export type SessionTurnProviderCheckpointV1 = z.infer<
  typeof SessionTurnProviderCheckpointV1Schema
>;

export const SessionTurnLifecycleStatusV1Schema = z.enum([
  'in_progress',
  'completed',
  'cancelled',
  'failed',
]);
export type SessionTurnLifecycleStatusV1 = z.infer<typeof SessionTurnLifecycleStatusV1Schema>;

export const SessionTurnRollbackStateV1Schema = z.enum([
  'not_eligible',
  'eligible',
  'rolled_back',
]);
export type SessionTurnRollbackStateV1 = z.infer<typeof SessionTurnRollbackStateV1Schema>;

export const SessionTurnTranscriptAnchorsV1Schema = z
  .object({
    startUserMessageSeq: z.number().int().nonnegative().optional(),
    userMessageSeqs: z.array(z.number().int().nonnegative()).readonly().optional(),
    startSeqInclusive: z.number().int().nonnegative().optional(),
    endSeqInclusive: z.number().int().nonnegative().nullable().optional(),
    finalAssistantMessageSeq: z.number().int().nonnegative().nullable().optional(),
    providerCheckpoint: SessionTurnProviderCheckpointV1Schema.optional(),
  })
  .passthrough()
  .readonly();
export type SessionTurnTranscriptAnchorsV1 = z.infer<typeof SessionTurnTranscriptAnchorsV1Schema>;

export const SessionTurnMutationActionV1Schema = z.enum([
  'begin',
  'touch_active',
  'attach_agent_turn_id',
  'append_transcript_anchors',
  'complete',
  'fail',
  'cancel',
  'end_session',
  'mark_rollback_eligible',
  'mark_rolled_back',
]);
export type SessionTurnMutationActionV1 = z.infer<typeof SessionTurnMutationActionV1Schema>;

const SessionTurnMutationBaseV1Schema = z
  .object({
    v: z.literal(1),
    sessionId: asProtocolZod(SessionIdSchema),
    mutationId: SessionTurnMutationIdV1Schema,
    observedAt: SessionTurnObservedAtV1Schema,
    agentId: SessionTurnAgentIdV1Schema.optional(),
  })
  .strict();

const ExactSessionTurnMutationBaseV1Schema = SessionTurnMutationBaseV1Schema.omit({ agentId: true });

export const ExactSessionTurnEndMutationV1Schema = ExactSessionTurnMutationBaseV1Schema.extend({
  action: z.literal('end_session'),
  turnId: TurnIdSchema,
}).strict().readonly();
export type ExactSessionTurnEndMutationV1 = z.infer<typeof ExactSessionTurnEndMutationV1Schema>;

export function isExactSessionTurnEndMutationV1(
  value: unknown,
): value is ExactSessionTurnEndMutationV1 {
  return ExactSessionTurnEndMutationV1Schema.safeParse(value).success;
}

const TurnScopedMutationBaseV1Schema = SessionTurnMutationBaseV1Schema.extend({
  turnId: TurnIdSchema,
  agentTurnId: SessionTurnAgentTurnIdV1Schema.optional(),
});

const CanonicalSessionTurnMutationV1Schema = z.discriminatedUnion('action', [
  TurnScopedMutationBaseV1Schema.extend({
    action: z.literal('begin'),
    transcriptAnchors: SessionTurnTranscriptAnchorsV1Schema.optional(),
  }).strict(),
  TurnScopedMutationBaseV1Schema.extend({
    action: z.literal('touch_active'),
  }).strict(),
  TurnScopedMutationBaseV1Schema.extend({
    action: z.literal('attach_agent_turn_id'),
    agentTurnId: SessionTurnAgentTurnIdV1Schema,
  }).strict(),
  TurnScopedMutationBaseV1Schema.extend({
    action: z.literal('append_transcript_anchors'),
    transcriptAnchors: SessionTurnTranscriptAnchorsV1Schema,
  }).strict(),
  TurnScopedMutationBaseV1Schema.extend({
    action: z.literal('complete'),
    transcriptAnchors: SessionTurnTranscriptAnchorsV1Schema.optional(),
  }).strict(),
  TurnScopedMutationBaseV1Schema.extend({
    action: z.literal('fail'),
    issue: SessionRuntimeIssueV1Schema,
  }).strict(),
  TurnScopedMutationBaseV1Schema.extend({
    action: z.literal('cancel'),
    reason: SessionTurnReasonV1Schema.optional(),
  }).strict(),
  SessionTurnMutationBaseV1Schema.extend({
    action: z.literal('end_session'),
    turnId: TurnIdSchema.optional(),
    agentTurnId: SessionTurnAgentTurnIdV1Schema.optional(),
  }).strict(),
  TurnScopedMutationBaseV1Schema.extend({
    action: z.literal('mark_rollback_eligible'),
    transcriptAnchors: SessionTurnTranscriptAnchorsV1Schema.optional(),
    agentRollbackOrdinal: z.number().int().nonnegative().optional(),
    reason: SessionTurnReasonV1Schema.optional(),
  }).strict(),
  TurnScopedMutationBaseV1Schema.extend({
    action: z.literal('mark_rolled_back'),
    restoredToTurnId: TurnIdSchema.optional(),
    agentRollbackOrdinal: z.number().int().nonnegative().optional(),
    reason: SessionTurnReasonV1Schema.optional(),
  }).strict(),
]).superRefine((mutation, context) => {
  if (mutation.action !== 'end_session' || mutation.turnId === undefined) return;
  if (!ExactSessionTurnEndMutationV1Schema.safeParse(mutation).success) {
    context.addIssue({
      code: 'custom',
      message: 'Exact session end cannot author agent metadata',
    });
  }
});

export const SessionTurnMutationV1Schema = z.preprocess(
  normalizeLegacySessionTurnAgentIdentity,
  CanonicalSessionTurnMutationV1Schema,
);
export type SessionTurnMutationV1 = z.infer<typeof SessionTurnMutationV1Schema>;

export const SessionTurnMutationDecisionV1Schema = z.enum([
  'applied',
  'duplicate-mutation',
  'duplicate-terminal',
  'missing-turn',
  'stale-in-progress',
  'stale-terminal',
]);
export type SessionTurnMutationDecisionV1 = z.infer<typeof SessionTurnMutationDecisionV1Schema>;

export const SessionTurnMutationReceiptV1Schema = z
  .object({
    v: z.literal(1),
    sessionId: asProtocolZod(SessionIdSchema),
    mutationId: SessionTurnMutationIdV1Schema,
    turnId: TurnIdSchema.optional(),
    action: SessionTurnMutationActionV1Schema,
    decision: SessionTurnMutationDecisionV1Schema,
    observedAt: SessionTurnObservedAtV1Schema,
    appliedAt: SessionTurnObservedAtV1Schema,
  })
  .passthrough()
  .readonly();
export type SessionTurnMutationReceiptV1 = z.infer<typeof SessionTurnMutationReceiptV1Schema>;

export const ExactSessionTurnMutationPositiveReceiptV1Schema = z
  .object({
    v: z.literal(1),
    sessionId: asProtocolZod(SessionIdSchema),
    mutationId: SessionTurnMutationIdV1Schema,
    turnId: TurnIdSchema,
    action: z.literal('end_session'),
    decision: z.enum(['applied', 'duplicate-terminal']),
    observedAt: SessionTurnObservedAtV1Schema,
    appliedAt: SessionTurnObservedAtV1Schema,
  })
  .passthrough()
  .readonly();
export type ExactSessionTurnMutationPositiveReceiptV1 = z.infer<
  typeof ExactSessionTurnMutationPositiveReceiptV1Schema
>;

export function isExactSessionTurnMutationPositiveReceiptV1(
  mutationValue: unknown,
  receiptValue: unknown,
): receiptValue is ExactSessionTurnMutationPositiveReceiptV1 {
  const mutation = ExactSessionTurnEndMutationV1Schema.safeParse(mutationValue);
  const receipt = ExactSessionTurnMutationPositiveReceiptV1Schema.safeParse(receiptValue);
  if (!mutation.success || !receipt.success) return false;
  return receipt.data.v === mutation.data.v
    && receipt.data.sessionId === mutation.data.sessionId
    && receipt.data.mutationId === mutation.data.mutationId
    && receipt.data.action === mutation.data.action
    && receipt.data.turnId === mutation.data.turnId
    && receipt.data.observedAt === mutation.data.observedAt;
}
