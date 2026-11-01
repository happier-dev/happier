import { z } from 'zod';

import {
  SessionTurnIdentifierV1Schema,
  SessionTurnProviderV1Schema,
  SessionTurnTimestampV1Schema,
  SessionTurnTranscriptAnchorsV1Schema,
} from './sessionTurnV1.js';
import { SessionRuntimeIssueV1Schema } from '../control/runtimeIssueV1.js';
import { lazySchema } from '../../lazySchema.js';

export const SessionTurnMutationActionV1Schema = lazySchema(() => z.enum([
  'begin',
  'touch_active',
  'attach_provider_turn_id',
  'append_transcript_anchors',
  'complete',
  'fail',
  'cancel',
  'end_session',
  'mark_rollback_eligible',
  'mark_rolled_back',
]));
export type SessionTurnMutationActionV1 = z.infer<typeof SessionTurnMutationActionV1Schema>;

const SessionTurnMutationBaseV1Schema = lazySchema(() => z
  .object({
    v: z.literal(1),
    sessionId: SessionTurnIdentifierV1Schema,
    mutationId: SessionTurnIdentifierV1Schema,
    observedAt: SessionTurnTimestampV1Schema,
    provider: SessionTurnProviderV1Schema.optional(),
  })
  .strict());

const ExactSessionTurnMutationBaseV1Schema = lazySchema(() => SessionTurnMutationBaseV1Schema.omit({ provider: true }));

export const ExactSessionTurnEndMutationV1Schema = lazySchema(() => ExactSessionTurnMutationBaseV1Schema.extend({
  action: z.literal('end_session'),
  turnId: SessionTurnIdentifierV1Schema,
}).strict().readonly());
export type ExactSessionTurnEndMutationV1 = z.infer<typeof ExactSessionTurnEndMutationV1Schema>;

export function isExactSessionTurnEndMutationV1(
  value: unknown,
): value is ExactSessionTurnEndMutationV1 {
  return ExactSessionTurnEndMutationV1Schema.safeParse(value).success;
}

const TurnScopedMutationBaseV1Schema = lazySchema(() => SessionTurnMutationBaseV1Schema.extend({
    turnId: SessionTurnIdentifierV1Schema.optional(),
    providerTurnId: SessionTurnIdentifierV1Schema.optional(),
  }));

const TurnRequiredMutationBaseV1Schema = lazySchema(() => SessionTurnMutationBaseV1Schema.extend({
    turnId: SessionTurnIdentifierV1Schema,
    providerTurnId: SessionTurnIdentifierV1Schema.optional(),
  }));

const CanonicalSessionTurnMutationV1Schema = lazySchema(() => z.discriminatedUnion('action', [
  TurnRequiredMutationBaseV1Schema.extend({
    action: z.literal('begin'),
    transcriptAnchors: SessionTurnTranscriptAnchorsV1Schema.optional(),
  }).strict(),
  TurnRequiredMutationBaseV1Schema.extend({
    action: z.literal('touch_active'),
  }).strict(),
  TurnRequiredMutationBaseV1Schema.extend({
    action: z.literal('attach_provider_turn_id'),
    providerTurnId: SessionTurnIdentifierV1Schema,
  }).strict(),
  TurnRequiredMutationBaseV1Schema.extend({
    action: z.literal('append_transcript_anchors'),
    transcriptAnchors: SessionTurnTranscriptAnchorsV1Schema,
  }).strict(),
  TurnRequiredMutationBaseV1Schema.extend({
    action: z.literal('complete'),
  }).strict(),
  TurnRequiredMutationBaseV1Schema.extend({
    action: z.literal('fail'),
    issue: SessionRuntimeIssueV1Schema,
  }).strict(),
  TurnRequiredMutationBaseV1Schema.extend({
    action: z.literal('cancel'),
    reason: z.string().trim().min(1).max(256).optional(),
  }).strict(),
  TurnScopedMutationBaseV1Schema.extend({
    action: z.literal('end_session'),
  }).strict(),
  TurnRequiredMutationBaseV1Schema.extend({
    action: z.literal('mark_rollback_eligible'),
    transcriptAnchors: SessionTurnTranscriptAnchorsV1Schema.optional(),
    providerRollbackOrdinal: z.number().finite().int().nonnegative().optional(),
    reason: z.string().trim().min(1).max(256).optional(),
  }).strict(),
  TurnRequiredMutationBaseV1Schema.extend({
    action: z.literal('mark_rolled_back'),
    restoredToTurnId: SessionTurnIdentifierV1Schema.optional(),
    providerRollbackOrdinal: z.number().finite().int().nonnegative().optional(),
    reason: z.string().trim().min(1).max(256).optional(),
  }).strict(),
]).superRefine((mutation, context) => {
  if (mutation.action !== 'end_session' || mutation.turnId === undefined) return;
  const exact = ExactSessionTurnEndMutationV1Schema.safeParse(mutation);
  if (!exact.success) {
    context.addIssue({ code: 'custom', message: 'Exact session end cannot author provider metadata' });
  }
}));

export const SessionTurnMutationV1Schema = lazySchema(() => CanonicalSessionTurnMutationV1Schema.readonly());
export type SessionTurnMutationV1 = z.infer<typeof SessionTurnMutationV1Schema>;

export const SessionTurnMutationDecisionV1Schema = lazySchema(() => z.enum([
  'applied',
  'duplicate-mutation',
  'duplicate-terminal',
  'missing-turn',
  'stale-in-progress',
  'stale-terminal',
]));
export type SessionTurnMutationDecisionV1 = z.infer<typeof SessionTurnMutationDecisionV1Schema>;

export const SessionTurnMutationReceiptV1Schema = lazySchema(() => z
  .object({
    v: z.literal(1),
    sessionId: SessionTurnIdentifierV1Schema,
    mutationId: SessionTurnIdentifierV1Schema,
    turnId: SessionTurnIdentifierV1Schema.optional(),
    action: SessionTurnMutationActionV1Schema,
    decision: SessionTurnMutationDecisionV1Schema,
    observedAt: SessionTurnTimestampV1Schema,
    appliedAt: SessionTurnTimestampV1Schema,
  })
  .passthrough()
  .readonly());
export type SessionTurnMutationReceiptV1 = z.infer<typeof SessionTurnMutationReceiptV1Schema>;

export const ExactSessionTurnMutationPositiveReceiptV1Schema = lazySchema(() => z
  .object({
    v: z.literal(1),
    sessionId: SessionTurnIdentifierV1Schema,
    mutationId: SessionTurnIdentifierV1Schema,
    turnId: SessionTurnIdentifierV1Schema,
    action: z.literal('end_session'),
    decision: z.enum(['applied', 'duplicate-terminal']),
    observedAt: SessionTurnTimestampV1Schema,
    appliedAt: SessionTurnTimestampV1Schema,
  })
  .passthrough()
  .readonly());
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
