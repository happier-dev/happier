import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

import { SessionIdSchema, SessionIndexedIdentifierMaxLengthV1, TurnIdSchema } from '../idsV1.js';
import { SessionRuntimeIssueV1Schema } from '../control/runtimeIssueV1.js';
import { normalizeLegacySessionTurnAgentIdentity } from './compat/agentIdentity.js';
import {
  AgentSessionProviderCheckpointMaxJsonBytesV1,
  AgentSessionProviderCheckpointV1Schema,
} from '../../runtime/agentSessionV1.js';
import { AgentIdV1Schema } from '../../agents/agentIdV1.js';
import { ExecutionRunIdSchema } from '../idsV1.js';
import { SessionWorkDepthV1Schema } from '../creation/sessionCreateOriginV1.js';
import { SessionTurnLifecycleStatusV1Schema } from './sessionTurnLifecycleStatusV1.js';
export { SessionTurnLifecycleStatusV1Schema } from './sessionTurnLifecycleStatusV1.js';
export type { SessionTurnLifecycleStatusV1 } from './sessionTurnLifecycleStatusV1.js';

export const SessionTurnInitiatorV1Schema = lazyZodSchema(() => z.enum(['user', 'agent_session', 'host', 'workflow']));
export const SessionTurnWorkflowInvocationV1Schema = lazyZodSchema(() => z.strictObject({
  runId: ExecutionRunIdSchema,
  invocationRecordId: z.string().check(z.minLength(1), z.maxLength(SessionIndexedIdentifierMaxLengthV1)),
}));
export const SessionTurnFactsV1Schema = lazyZodSchema(() => z.strictObject({
  initiator: SessionTurnInitiatorV1Schema,
  workDepth: SessionWorkDepthV1Schema,
  workflowInvocation: z.optional(SessionTurnWorkflowInvocationV1Schema),
}));
export type SessionTurnFactsV1 = z.infer<typeof SessionTurnFactsV1Schema>;

const SessionTurnMutationIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SessionIndexedIdentifierMaxLengthV1)));
const SessionTurnAgentIdV1Schema = AgentIdV1Schema;
const SessionTurnAgentTurnIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SessionIndexedIdentifierMaxLengthV1)));
const SessionTurnObservedAtV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const SessionTurnReasonV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
export const SessionTurnProviderCheckpointMaxJsonBytesV1 =
  AgentSessionProviderCheckpointMaxJsonBytesV1;
export const SessionTurnProviderCheckpointV1Schema =
  AgentSessionProviderCheckpointV1Schema;
export type SessionTurnProviderCheckpointV1 = z.infer<
  typeof SessionTurnProviderCheckpointV1Schema
>;

export const SessionTurnRollbackStateV1Schema = lazyZodSchema(() => z.enum([
  'not_eligible',
  'eligible',
  'rolled_back',
]));
export type SessionTurnRollbackStateV1 = z.infer<typeof SessionTurnRollbackStateV1Schema>;

export const SessionTurnTranscriptAnchorsV1Schema = lazyZodSchema(() => z.readonly(z.looseObject({
    startUserMessageSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
    userMessageSeqs: z.optional(z.readonly(z.array(z.number().check(z.int(), z.nonnegative())))),
    startSeqInclusive: z.optional(z.number().check(z.int(), z.nonnegative())),
    endSeqInclusive: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    finalAssistantMessageSeq: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    providerCheckpoint: z.optional(SessionTurnProviderCheckpointV1Schema),
  })));
export type SessionTurnTranscriptAnchorsV1 = z.infer<typeof SessionTurnTranscriptAnchorsV1Schema>;

export const SessionTurnMutationActionV1Schema = lazyZodSchema(() => z.enum([
  'begin',
  'touch_active',
  'attach_agent_turn_id',
  'append_transcript_anchors',
  'complete',
  'wait',
  'fail',
  'cancel',
  'end_session',
  'session_opened',
  'mark_rollback_eligible',
  'mark_rolled_back',
]));
export type SessionTurnMutationActionV1 = z.infer<typeof SessionTurnMutationActionV1Schema>;

const SessionTurnMutationBaseV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    sessionId: asProtocolZod(SessionIdSchema),
    mutationId: SessionTurnMutationIdV1Schema,
    observedAt: SessionTurnObservedAtV1Schema,
    agentId: z.optional(SessionTurnAgentIdV1Schema),
  }));

const ExactSessionTurnMutationBaseV1Schema = lazyZodSchema(() => z.omit(SessionTurnMutationBaseV1Schema, { agentId: true }));

export const ExactSessionTurnEndMutationV1Schema = lazyZodSchema(() => z.readonly((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExactSessionTurnMutationBaseV1Schema, {
  action: z.literal('end_session'),
  turnId: TurnIdSchema,
}))));
export type ExactSessionTurnEndMutationV1 = z.infer<typeof ExactSessionTurnEndMutationV1Schema>;

export function isExactSessionTurnEndMutationV1(
  value: unknown,
): value is ExactSessionTurnEndMutationV1 {
  return ExactSessionTurnEndMutationV1Schema.safeParse(value).success;
}

const TurnScopedMutationBaseV1Schema = lazyZodSchema(() => z.extend(SessionTurnMutationBaseV1Schema, {
  turnId: TurnIdSchema,
  agentTurnId: z.optional(SessionTurnAgentTurnIdV1Schema),
}));

const CanonicalSessionTurnMutationV1Schema = lazyZodSchema(() => z.discriminatedUnion('action', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionTurnMutationBaseV1Schema, {
    action: z.literal('session_opened'),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TurnScopedMutationBaseV1Schema, {
    action: z.literal('begin'),
    /** Host-correlated input that caused this exact native turn start. */
    startingInputId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(SessionIndexedIdentifierMaxLengthV1))),
    initiator: z.optional(SessionTurnInitiatorV1Schema),
    workDepth: z.optional(SessionWorkDepthV1Schema),
    workflowInvocation: z.optional(SessionTurnWorkflowInvocationV1Schema),
    transcriptAnchors: z.optional(SessionTurnTranscriptAnchorsV1Schema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TurnScopedMutationBaseV1Schema, {
    action: z.literal('touch_active'),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TurnScopedMutationBaseV1Schema, {
    action: z.literal('attach_agent_turn_id'),
    agentTurnId: SessionTurnAgentTurnIdV1Schema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TurnScopedMutationBaseV1Schema, {
    action: z.literal('append_transcript_anchors'),
    transcriptAnchors: SessionTurnTranscriptAnchorsV1Schema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TurnScopedMutationBaseV1Schema, {
    action: z.literal('complete'),
    transcriptAnchors: z.optional(SessionTurnTranscriptAnchorsV1Schema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TurnScopedMutationBaseV1Schema, {
    action: z.literal('wait'),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TurnScopedMutationBaseV1Schema, {
    action: z.literal('fail'),
    issue: SessionRuntimeIssueV1Schema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TurnScopedMutationBaseV1Schema, {
    action: z.literal('cancel'),
    reason: z.optional(SessionTurnReasonV1Schema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionTurnMutationBaseV1Schema, {
    action: z.literal('end_session'),
    turnId: z.optional(TurnIdSchema),
    agentTurnId: z.optional(SessionTurnAgentTurnIdV1Schema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TurnScopedMutationBaseV1Schema, {
    action: z.literal('mark_rollback_eligible'),
    transcriptAnchors: z.optional(SessionTurnTranscriptAnchorsV1Schema),
    agentRollbackOrdinal: z.optional(z.number().check(z.int(), z.nonnegative())),
    reason: z.optional(SessionTurnReasonV1Schema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TurnScopedMutationBaseV1Schema, {
    action: z.literal('mark_rolled_back'),
    restoredToTurnId: z.optional(TurnIdSchema),
    agentRollbackOrdinal: z.optional(z.number().check(z.int(), z.nonnegative())),
    reason: z.optional(SessionTurnReasonV1Schema),
  })),
]).check(z.superRefine((mutation, context) => {
  if (mutation.action !== 'end_session' || mutation.turnId === undefined) return;
  if (!ExactSessionTurnEndMutationV1Schema.safeParse(mutation).success) {
    context.addIssue({
      code: 'custom',
      message: 'Exact session end cannot author agent metadata',
    });
  }
})));

export const SessionTurnMutationV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeLegacySessionTurnAgentIdentity), CanonicalSessionTurnMutationV1Schema));
export type SessionTurnMutationV1 = z.infer<typeof SessionTurnMutationV1Schema>;

export const SessionTurnMutationDecisionV1Schema = lazyZodSchema(() => z.enum([
  'applied',
  'duplicate-mutation',
  'duplicate-terminal',
  'missing-turn',
  'stale-in-progress',
  'stale-terminal',
]));
export type SessionTurnMutationDecisionV1 = z.infer<typeof SessionTurnMutationDecisionV1Schema>;

export const SessionTurnMutationReceiptV1Schema = lazyZodSchema(() => z.readonly(z.looseObject({
    v: z.literal(1),
    sessionId: asProtocolZod(SessionIdSchema),
    mutationId: SessionTurnMutationIdV1Schema,
    turnId: z.optional(TurnIdSchema),
    action: SessionTurnMutationActionV1Schema,
    decision: SessionTurnMutationDecisionV1Schema,
    observedAt: SessionTurnObservedAtV1Schema,
    appliedAt: SessionTurnObservedAtV1Schema,
  })));
export type SessionTurnMutationReceiptV1 = z.infer<typeof SessionTurnMutationReceiptV1Schema>;

export const ExactSessionTurnMutationPositiveReceiptV1Schema = lazyZodSchema(() => z.readonly(z.looseObject({
    v: z.literal(1),
    sessionId: asProtocolZod(SessionIdSchema),
    mutationId: SessionTurnMutationIdV1Schema,
    turnId: TurnIdSchema,
    action: z.literal('end_session'),
    decision: z.enum(['applied', 'duplicate-terminal']),
    observedAt: SessionTurnObservedAtV1Schema,
    appliedAt: SessionTurnObservedAtV1Schema,
  })));
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
