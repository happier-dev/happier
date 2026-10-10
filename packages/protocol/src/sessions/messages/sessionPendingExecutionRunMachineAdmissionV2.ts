import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { ParticipantExecutionRunRecipientRoutingIdentityV1Schema } from '../../messages/structured/participantMessageV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema, SidechainIdSchema } from '../idsV1.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { PendingRequestedActionV1Schema } from '../pending/pendingRequestedActionV1.js';
import { PendingProviderActionSchema } from '../pending/pendingProviderAction.js';
import { AcceptedPendingSettlementResponseV1Schema } from '../pending/acceptedPendingSettlementV1.js';
import { SessionPendingEnqueueByMachineFieldsV1, refineSessionPendingMachineEqualityEvidenceV1 } from './sessionPendingMachineAdmissionV1.js';
import { SessionInputAdmissionResultV1Schema, SessionInputAdmissionReceiptV1Schema } from './sessionInputAdmission.js';
import { SessionMessageRoleSchema } from './sessionMessageRole.js';
import { PendingDeliveryBlockedReasonSchema } from './pendingDeliveryBlockedReason.js';
import { StrictSessionStoredMessageContentEnvelopeSchema } from './sessionStoredMessageContent.js';
import { SessionMessageAcceptedDeliveryContentV1Schema } from './sessionMessageDeliveryResolutionV1.js';

/** Account input has no authority to supply host-derived equality evidence. */
export const SessionExecutionRunPendingEnqueueRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  localId: PendingLocalIdSchema,
  targetMachineId: z.string().trim().min(1).max(256),
  content: StrictSessionStoredMessageContentEnvelopeSchema,
  messageRole: z.unknown().optional(),
  requestedAction: PendingRequestedActionV1Schema.optional(),
}).strict());
export type SessionExecutionRunPendingEnqueueRequestV1 = z.infer<typeof SessionExecutionRunPendingEnqueueRequestV1Schema>;

export const SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2 =
  'session-pending-execution-run-enqueue-by-machine-v2' as const;
export const SESSION_PENDING_EXECUTION_RUN_MATERIALIZE_NEXT_EVENT_V2 =
  'session-pending-execution-run-materialize-next-v2' as const;
export const SESSION_PENDING_EXECUTION_RUN_ACCEPTED_EVENT_V2 =
  'session-pending-execution-run-delivery-accepted-v2' as const;
export const SESSION_PENDING_EXECUTION_RUN_BLOCK_EVENT_V2 =
  'session-pending-execution-run-delivery-block-v2' as const;

export const SessionPendingExecutionRunEnqueueByMachineRequestV2Schema = lazyZodSchema(() => z.object({
  ...SessionPendingEnqueueByMachineFieldsV1,
  v: z.literal(2),
  recipient: ParticipantExecutionRunRecipientRoutingIdentityV1Schema,
  content: StrictSessionStoredMessageContentEnvelopeSchema,
}).strict().superRefine(refineSessionPendingMachineEqualityEvidenceV1));
export type SessionPendingExecutionRunEnqueueByMachineRequestV2 = z.infer<typeof SessionPendingExecutionRunEnqueueByMachineRequestV2Schema>;
export const SessionPendingExecutionRunEnqueueByMachineResponseV2Schema = lazyZodSchema(() => z.object({
  v: z.literal(2),
  result: SessionInputAdmissionResultV1Schema,
}).strict());
export type SessionPendingExecutionRunEnqueueByMachineResponseV2 = z.infer<typeof SessionPendingExecutionRunEnqueueByMachineResponseV2Schema>;

const executionRunTargetFields = {
  v: z.literal(2),
  sessionId: asProtocolZod(SessionIdSchema),
  recipient: ParticipantExecutionRunRecipientRoutingIdentityV1Schema,
  sidechainId: SidechainIdSchema,
};
export const SessionPendingExecutionRunMaterializeNextRequestV2Schema = lazyZodSchema(() => z.object({
  ...executionRunTargetFields,
  deliveryTiming: z.enum(['after_foreground_ready', 'after_runtime_idle']),
  foregroundState: z.enum(['ready', 'active_steerable', 'active_unsteerable']),
}).strict());
export type SessionPendingExecutionRunMaterializeNextRequestV2 = z.infer<typeof SessionPendingExecutionRunMaterializeNextRequestV2Schema>;

export const SessionPendingExecutionRunAcceptedRequestV2Schema = lazyZodSchema(() => z.object({
  ...executionRunTargetFields,
  localId: PendingLocalIdSchema,
  acceptedDelivery: SessionMessageAcceptedDeliveryContentV1Schema.optional(),
}).strict());
export type SessionPendingExecutionRunAcceptedRequestV2 = z.infer<typeof SessionPendingExecutionRunAcceptedRequestV2Schema>;

const targetEchoFields = {
  v: z.literal(2),
  recipient: ParticipantExecutionRunRecipientRoutingIdentityV1Schema,
  sidechainId: SidechainIdSchema,
};
const pendingCounts = {
  pendingCount: z.number().int().nonnegative(),
  pendingBlockedCount: z.number().int().nonnegative(),
  pendingVersion: z.number().int().nonnegative(),
};
const providerDeliveryState = z.object({ mode: z.literal('provider'), unresolved: z.boolean() }).strict();
const materializedMessage = z.object({
  id: z.string().min(1).nullable(),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  localId: PendingLocalIdSchema,
  messageRole: SessionMessageRoleSchema.optional(),
  content: StrictSessionStoredMessageContentEnvelopeSchema,
  requestedAction: PendingRequestedActionV1Schema,
  providerAction: PendingProviderActionSchema,
  inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.nullable().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export const SessionPendingExecutionRunMaterializeNextResponseV2Schema = lazyZodSchema(() => z.union([
  z.object({
    ...targetEchoFields, ...pendingCounts,
    ok: z.literal(true), didMaterialize: z.literal(true), didWrite: z.boolean(),
    authorAccountId: z.string().min(1).nullable(),
    message: materializedMessage,
    deliveryState: providerDeliveryState,
  }).strict(),
  z.object({
    ...targetEchoFields, ...pendingCounts,
    ok: z.literal(true), didMaterialize: z.literal(false),
    authorAccountId: z.string().min(1).nullable(),
    localId: PendingLocalIdSchema.optional(),
    deferredReason: z.enum(['waiting_for_foreground_turn', 'waiting_for_runtime_activity', 'runtime_activity_unknown', 'waiting_for_predecessor', 'steering_unavailable']).optional(),
    deliveryState: providerDeliveryState,
  }).strict(),
  z.object({
    v: z.literal(2), ok: z.literal(false),
    error: z.enum(['session-not-found', 'forbidden', 'invalid-params', 'transcript-conflict', 'internal', 'session_input_target_update_required']),
  }).strict(),
  z.object({
    v: z.literal(2), ok: z.literal(false), error: z.literal('transaction-unavailable'),
    retryAfterMs: z.number().int().nonnegative(),
  }).strict(),
]).superRefine((value, context) => {
  if (!value.ok || !value.didMaterialize) return;
  const receipt = value.message.inputAdmissionReceipt;
  if (receipt?.issuer === 'authenticatedAccount' && receipt.actorAccountId !== value.authorAccountId) {
    context.addIssue({ code: 'custom', path: ['authorAccountId'], message: 'Input author must agree with the authenticated admission receipt' });
  }
}));
export type SessionPendingExecutionRunMaterializeNextResponseV2 = z.infer<typeof SessionPendingExecutionRunMaterializeNextResponseV2Schema>;

/** Reuses the established settlement outcome without widening its V1 envelope. */
export const SessionPendingExecutionRunAcceptedResponseV2Schema = lazyZodSchema(() => z.object({
  ...targetEchoFields,
  result: AcceptedPendingSettlementResponseV1Schema,
}).strict());
export type SessionPendingExecutionRunAcceptedResponseV2 = z.infer<typeof SessionPendingExecutionRunAcceptedResponseV2Schema>;

/** The current publisher supplies registry evidence; the existing Pending lifecycle owns the transition. */
export const SessionPendingExecutionRunBlockRequestV2Schema = lazyZodSchema(() => z.object({
  v: z.literal(2),
  sessionId: asProtocolZod(SessionIdSchema),
  recipient: ParticipantExecutionRunRecipientRoutingIdentityV1Schema,
  localId: PendingLocalIdSchema,
  reason: PendingDeliveryBlockedReasonSchema,
}).strict());
export type SessionPendingExecutionRunBlockRequestV2 = z.infer<typeof SessionPendingExecutionRunBlockRequestV2Schema>;
export const SessionPendingExecutionRunBlockResponseV2Schema = lazyZodSchema(() => z.object({
  v: z.literal(2),
  recipient: ParticipantExecutionRunRecipientRoutingIdentityV1Schema,
  localId: PendingLocalIdSchema,
  result: z.union([
    z.object({ ok: z.literal(true), didUpdate: z.boolean(), ...pendingCounts }).strict(),
    z.object({ ok: z.literal(false), error: z.enum(['session-not-found', 'forbidden', 'invalid-params', 'not-found', 'delivery-settlement-conflict', 'internal']) }).strict(),
  ]),
}).strict());
export type SessionPendingExecutionRunBlockResponseV2 = z.infer<typeof SessionPendingExecutionRunBlockResponseV2Schema>;
