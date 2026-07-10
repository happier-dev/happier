import { z } from 'zod';

import { SessionIdSchema, SessionIndexedIdentifierMaxLengthV1, TurnIdSchema } from '../idsV1.js';
import { SessionRuntimeIssueV1Schema } from '../control/runtimeIssueV1.js';
import { normalizeLegacySessionTurnAgentIdentity } from './compat/agentIdentity.js';

const SessionTurnMutationIdV1Schema = z.string().trim().min(1).max(SessionIndexedIdentifierMaxLengthV1);
const SessionTurnAgentIdV1Schema = z.string().trim().min(1).max(128);
const SessionTurnAgentTurnIdV1Schema = z.string().trim().min(1).max(SessionIndexedIdentifierMaxLengthV1);
const SessionTurnObservedAtV1Schema = z.number().int().nonnegative();
const SessionTurnReasonV1Schema = z.string().trim().min(1).max(256);

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
    sessionId: SessionIdSchema,
    mutationId: SessionTurnMutationIdV1Schema,
    observedAt: SessionTurnObservedAtV1Schema,
    agentId: SessionTurnAgentIdV1Schema.optional(),
  })
  .strict();

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
]);

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
    sessionId: SessionIdSchema,
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
