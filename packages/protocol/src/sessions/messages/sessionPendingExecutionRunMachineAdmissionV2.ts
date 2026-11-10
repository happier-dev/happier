import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { UsageTimingBoundsV1Schema } from '../../usage/usageTimingV1.js';

import { ParticipantExecutionRunRecipientRoutingIdentityV1Schema } from '../../messages/structured/participantMessageV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema, SidechainIdSchema } from '../idsV1.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { PendingRequestedActionV1Schema } from '../pending/pendingRequestedActionV1.js';
import { PendingProviderActionSchema } from '../pending/pendingProviderAction.js';
import { AcceptedPendingSettlementResponseV1Schema } from '../pending/acceptedPendingSettlementV1.js';
import { SessionPendingEnqueueByMachineFieldsV1, refineSessionPendingMachineEqualityEvidenceV1 } from './sessionPendingMachineAdmissionV1.js';
import { SessionInputEnqueueResultV1Schema, SessionInputAdmissionReceiptV1Schema } from './sessionInputAdmission.js';
import { SessionMessageRoleSchema } from './sessionMessageRole.js';
import { PendingDeliveryBlockedReasonSchema } from './pendingDeliveryBlockedReason.js';
import { StrictSessionStoredMessageContentEnvelopeSchema } from './sessionStoredMessageContent.js';
import { SessionMessageAcceptedDeliveryContentV1Schema, SessionMessageAcceptedTurnV1Schema } from './sessionMessageDeliveryResolutionV1.js';
import { SessionMessageReplyAdmissionV1Schema } from './sessionMessageReplyV1.js';

/** Account input has no authority to supply host-derived equality evidence. */
export const SessionExecutionRunPendingEnqueueRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  localId: PendingLocalIdSchema,
  targetMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  content: StrictSessionStoredMessageContentEnvelopeSchema,
  usageTimingV1: z.optional(z.nullable(UsageTimingBoundsV1Schema)),
  messageRole: z.optional(z.unknown()),
  requestedAction: z.optional(PendingRequestedActionV1Schema),
  reply: z.optional(SessionMessageReplyAdmissionV1Schema),
}));
export type SessionExecutionRunPendingEnqueueRequestV1 = z.infer<typeof SessionExecutionRunPendingEnqueueRequestV1Schema>;

export const SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2 =
  'session-pending-execution-run-enqueue-by-machine-v2' as const;
export const SESSION_PENDING_EXECUTION_RUN_MATERIALIZE_NEXT_EVENT_V2 =
  'session-pending-execution-run-materialize-next-v2' as const;
export const SESSION_PENDING_EXECUTION_RUN_ACCEPTED_EVENT_V2 =
  'session-pending-execution-run-delivery-accepted-v2' as const;
export const SESSION_PENDING_EXECUTION_RUN_BLOCK_EVENT_V2 =
  'session-pending-execution-run-delivery-block-v2' as const;

export const SessionPendingExecutionRunEnqueueByMachineRequestV2Schema = lazyZodSchema(() => z.strictObject({
  ...SessionPendingEnqueueByMachineFieldsV1,
  v: z.literal(2),
  recipient: ParticipantExecutionRunRecipientRoutingIdentityV1Schema,
  content: StrictSessionStoredMessageContentEnvelopeSchema,
}).check(z.superRefine(refineSessionPendingMachineEqualityEvidenceV1)));
export type SessionPendingExecutionRunEnqueueByMachineRequestV2 = z.infer<typeof SessionPendingExecutionRunEnqueueByMachineRequestV2Schema>;
export const SessionPendingExecutionRunEnqueueByMachineResponseV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2),
  result: SessionInputEnqueueResultV1Schema,
}));
export type SessionPendingExecutionRunEnqueueByMachineResponseV2 = z.infer<typeof SessionPendingExecutionRunEnqueueByMachineResponseV2Schema>;

const executionRunTargetFields = {
  v: z.literal(2),
  sessionId: asProtocolZod(SessionIdSchema),
  recipient: ParticipantExecutionRunRecipientRoutingIdentityV1Schema,
  sidechainId: SidechainIdSchema,
};
export const SessionPendingExecutionRunMaterializeNextRequestV2Schema = lazyZodSchema(() => z.strictObject({
  ...executionRunTargetFields,
  deliveryTiming: z.enum(['after_foreground_ready', 'after_runtime_idle']),
  foregroundState: z.enum(['ready', 'active_steerable', 'active_unsteerable']),
}));
export type SessionPendingExecutionRunMaterializeNextRequestV2 = z.infer<typeof SessionPendingExecutionRunMaterializeNextRequestV2Schema>;

export const SessionPendingExecutionRunAcceptedRequestV2Schema = lazyZodSchema(() => z.strictObject({
  ...executionRunTargetFields,
  localId: PendingLocalIdSchema,
  acceptedDelivery: z.optional(SessionMessageAcceptedDeliveryContentV1Schema),
  /** Added delivery component only; settlement merges with retained whole-message timing. */
  usageTimingV1: z.optional(z.nullable(UsageTimingBoundsV1Schema)),
  acceptedTurn: z.optional(SessionMessageAcceptedTurnV1Schema),
}));
export type SessionPendingExecutionRunAcceptedRequestV2 = z.infer<typeof SessionPendingExecutionRunAcceptedRequestV2Schema>;

const targetEchoFields = {
  v: z.literal(2),
  recipient: ParticipantExecutionRunRecipientRoutingIdentityV1Schema,
  sidechainId: SidechainIdSchema,
};
const pendingCounts = {
  pendingCount: z.number().check(z.int(), z.nonnegative()),
  pendingBlockedCount: z.number().check(z.int(), z.nonnegative()),
  pendingVersion: z.number().check(z.int(), z.nonnegative()),
};
const providerDeliveryState = z.strictObject({ mode: z.literal('provider'), unresolved: z.boolean() });
const materializedMessage = z.strictObject({
  id: z.nullable(z.string().check(z.minLength(1))),
  seq: z.nullable(z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER))),
  localId: PendingLocalIdSchema,
  messageRole: z.optional(SessionMessageRoleSchema),
  content: StrictSessionStoredMessageContentEnvelopeSchema,
  requestedAction: PendingRequestedActionV1Schema,
  providerAction: PendingProviderActionSchema,
  inputAdmissionReceipt: z.optional(z.nullable(SessionInputAdmissionReceiptV1Schema)),
  createdAt: z.number().check(z.int(), z.nonnegative()),
  updatedAt: z.number().check(z.int(), z.nonnegative()),
});

export const SessionPendingExecutionRunMaterializeNextResponseV2Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    ...targetEchoFields, ...pendingCounts,
    ok: z.literal(true), didMaterialize: z.literal(true), didWrite: z.boolean(),
    authorAccountId: z.nullable(z.string().check(z.minLength(1))),
    message: materializedMessage,
    deliveryState: providerDeliveryState,
  }),
  z.strictObject({
    ...targetEchoFields, ...pendingCounts,
    ok: z.literal(true), didMaterialize: z.literal(false),
    authorAccountId: z.nullable(z.string().check(z.minLength(1))),
    localId: z.optional(PendingLocalIdSchema),
    deferredReason: z.optional(z.enum(['waiting_for_foreground_turn', 'waiting_for_runtime_activity', 'runtime_activity_unknown', 'waiting_for_predecessor', 'steering_unavailable'])),
    deliveryState: providerDeliveryState,
  }),
  z.strictObject({
    v: z.literal(2), ok: z.literal(false),
    error: z.enum(['session-not-found', 'forbidden', 'invalid-params', 'transcript-conflict', 'internal', 'session_input_target_update_required']),
  }),
  z.strictObject({
    v: z.literal(2), ok: z.literal(false), error: z.literal('transaction-unavailable'),
    retryAfterMs: z.number().check(z.int(), z.nonnegative()),
  }),
]).check(z.superRefine((value, context) => {
  if (!value.ok || !value.didMaterialize) return;
  const receipt = value.message.inputAdmissionReceipt;
  if (receipt?.issuer === 'authenticatedAccount' && receipt.actorAccountId !== value.authorAccountId) {
    context.addIssue({ code: 'custom', path: ['authorAccountId'], message: 'Input author must agree with the authenticated admission receipt' });
  }
})));
export type SessionPendingExecutionRunMaterializeNextResponseV2 = z.infer<typeof SessionPendingExecutionRunMaterializeNextResponseV2Schema>;

/** Reuses the established settlement outcome without widening its V1 envelope. */
export const SessionPendingExecutionRunAcceptedResponseV2Schema = lazyZodSchema(() => z.strictObject({
  ...targetEchoFields,
  result: AcceptedPendingSettlementResponseV1Schema,
}));
export type SessionPendingExecutionRunAcceptedResponseV2 = z.infer<typeof SessionPendingExecutionRunAcceptedResponseV2Schema>;

/** The current publisher supplies registry evidence; the existing Pending lifecycle owns the transition. */
export const SessionPendingExecutionRunBlockRequestV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2),
  sessionId: asProtocolZod(SessionIdSchema),
  recipient: ParticipantExecutionRunRecipientRoutingIdentityV1Schema,
  localId: PendingLocalIdSchema,
  reason: PendingDeliveryBlockedReasonSchema,
}));
export type SessionPendingExecutionRunBlockRequestV2 = z.infer<typeof SessionPendingExecutionRunBlockRequestV2Schema>;
export const SessionPendingExecutionRunBlockResponseV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2),
  recipient: ParticipantExecutionRunRecipientRoutingIdentityV1Schema,
  localId: PendingLocalIdSchema,
  result: z.union([
    z.strictObject({ ok: z.literal(true), didUpdate: z.boolean(), ...pendingCounts }),
    z.strictObject({ ok: z.literal(false), error: z.enum(['session-not-found', 'forbidden', 'invalid-params', 'not-found', 'delivery-settlement-conflict', 'internal']) }),
  ]),
}));
export type SessionPendingExecutionRunBlockResponseV2 = z.infer<typeof SessionPendingExecutionRunBlockResponseV2Schema>;
