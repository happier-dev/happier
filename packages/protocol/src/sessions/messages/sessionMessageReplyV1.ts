import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionIdSchema, TurnIdSchema } from '../idsV1.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { SessionInputSourceSessionV1Schema, SessionInputHumanReplyOriginV1Schema, SessionInputWorkflowV2Schema } from './sessionInputAdmission.js';
import { WorkflowRunIdV1Schema, WorkflowInvocationRecordIdSchema } from '../../workflows/workflowIdsV1.js';
import { WorkflowDecimalV1Schema } from '../../workflows/workflowProgressV1.js';
import { CoordinationMessageRefV1Schema } from '../../discussions/references.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { sha256 } from '@noble/hashes/sha2';
import { encodeBase64 } from '../../crypto/base64.js';
import { ParticipantExecutionRunRecipientRoutingIdentityV1Schema } from '../../messages/structured/participantMessageV1.js';
import { SessionMessageRefV1Schema } from './sessionMessageRefV1.js';
import { ActionRequestAttributionV1Schema } from '../../actions/actionRequestAttributionV1.js';
import { DiscussionAddressingV1Schema, DiscussionAddressV1Schema } from '../../discussions/references.js';

export const SessionMessageReplyCapabilityV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), protocolVersions: z.tuple([z.literal(1)]),
}));
export type SessionMessageReplyCapabilityV1 = z.infer<typeof SessionMessageReplyCapabilityV1Schema>;

/** Explicit receivers publish an answer before fulfilling the named original input. */
export const SessionMessageExplicitReplyV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('answer'), message: z.string().check(z.refine(value => value.trim().length > 0)) }),
  z.strictObject({ kind: z.literal('pass') }),
]));
export type SessionMessageExplicitReplyV1 = z.infer<typeof SessionMessageExplicitReplyV1Schema>;

export const SessionMessageReplyTerminalOutcomeV1Schema = lazyZodSchema(() =>
  z.strictObject({ kind: z.enum(['pass', 'failed', 'cancelled', 'terminal_no_result', 'declined']) }));

const SessionMessageReplyResultV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema), messageId: z.string().check(z.minLength(1)),
}));

/** Authorized inline projection; text never enters original-input progress. */
export const SessionMessageReplyResolvedOutcomeV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('answer'), text: z.string(), messageRef: SessionMessageRefV1Schema }),
  z.strictObject({ kind: z.literal('answer'), publicationRef: CoordinationMessageRefV1Schema }),
  z.strictObject({ kind: z.literal('cancelled'), partialText: z.string(), messageRef: SessionMessageRefV1Schema }),
  SessionMessageReplyTerminalOutcomeV1Schema,
]));
export type SessionMessageReplyResolvedOutcomeV1 = z.infer<typeof SessionMessageReplyResolvedOutcomeV1Schema>;

/** Non-content projection of the protected original request, attested by a Machine. */
export const SessionMessageReplyAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  mode: z.enum(['wait', 'return']),
  sourceSession: z.optional(SessionInputSourceSessionV1Schema),
  humanOrigin: z.optional(SessionInputHumanReplyOriginV1Schema),
  /** The admitted question, participant and cutoff own this return destination. */
  discussion: z.optional(DiscussionAddressingV1Schema),
  /** Protected Workflow custody, never inferred from the reply's prose. */
  workflow: z.optional(SessionInputWorkflowV2Schema),
  actionRequestAttributionV1: z.optional(ActionRequestAttributionV1Schema),
}).check(z.refine(value => value.mode !== 'return' || value.sourceSession !== undefined || value.discussion !== undefined || value.humanOrigin !== undefined, 'Return requires an admitted destination'),
  z.refine(value => !value.humanOrigin || value.mode === 'return' && !value.sourceSession && !value.discussion, 'Human and agent reply destinations are distinct')));
export type SessionMessageReplyAdmissionV1 = z.infer<typeof SessionMessageReplyAdmissionV1Schema>;

export const SessionMessageReplyOutcomeV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('answer'), result: SessionMessageReplyResultV1Schema }),
  z.strictObject({ kind: z.literal('answer'), publicationRef: CoordinationMessageRefV1Schema }),
  // Partial content stays with its exact committed transcript row, including in E2EE Accounts.
  z.strictObject({ kind: z.literal('cancelled'), result: SessionMessageReplyResultV1Schema }),
  SessionMessageReplyTerminalOutcomeV1Schema,
]));
export type SessionMessageReplyOutcomeV1 = z.infer<typeof SessionMessageReplyOutcomeV1Schema>;

/** Original-input custody; publication and person review settle a captured native answer. */
export const SessionMessageReplyProgressV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  mode: z.enum(['wait', 'return']),
  sourceSession: z.optional(SessionInputSourceSessionV1Schema),
  humanOrigin: z.optional(SessionInputHumanReplyOriginV1Schema),
  discussion: z.optional(DiscussionAddressingV1Schema),
  workflow: z.optional(SessionInputWorkflowV2Schema),
  actionRequestAttributionV1: z.optional(ActionRequestAttributionV1Schema),
  acceptedTurnId: z.optional(TurnIdSchema),
  outcome: z.optional(SessionMessageReplyOutcomeV1Schema),
  disposition: z.enum(['observing', 'inline', 'return_pending', 'returned', 'released']),
  returnedInputLocalId: z.optional(PendingLocalIdSchema),
}).check(z.refine(value => value.mode !== 'return' || value.sourceSession !== undefined || value.discussion !== undefined || value.humanOrigin !== undefined, 'Return requires an admitted destination'),
  z.refine(value => !value.humanOrigin || value.mode === 'return' && !value.sourceSession && !value.discussion, 'Human and agent reply destinations are distinct')));

/** Host-only original obligation proof. The authenticated publisher supplies its Session identity. */
export const SessionMessageDiscussionReplyReturnV1Schema = lazyZodSchema(() => z.strictObject({
  /** Captured client Home address for the output reference only; never publication authority. */
  serverId: DiscussionAddressV1Schema.shape.serverId,
  requestLocalId: PendingLocalIdSchema,
  acceptedTurnId: z.optional(TurnIdSchema),
  /** The durable invocation index is checked before this original can publish. */
  workflow: z.optional(z.strictObject({
    runId: WorkflowRunIdV1Schema,
    invocationRecordId: WorkflowInvocationRecordIdSchema,
    invocationAttempt: WorkflowDecimalV1Schema,
  })),
}));
export type SessionMessageDiscussionReplyReturnV1 = z.infer<typeof SessionMessageDiscussionReplyReturnV1Schema>;
export type SessionMessageReplyProgressV1 = z.infer<typeof SessionMessageReplyProgressV1Schema>;

/** Source-Session observation only; fulfillment remains with the actual receiver. */
export const SessionMessageReplyObservationRequestV1Schema = lazyZodSchema(() => z.strictObject({
  requestSessionId: asProtocolZod(SessionIdSchema),
  requestLocalId: PendingLocalIdSchema,
  operation: z.enum(['inline', 'release']),
}));
export type SessionMessageReplyObservationRequestV1 = z.infer<typeof SessionMessageReplyObservationRequestV1Schema>;

/** Account observations and non-publishing private review use the same original-input mutation. */
export const SessionMessageReplyAccountMutationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['inline', 'release']) }),
  z.strictObject({
    kind: z.literal('discussion_review'),
    discussionId: DiscussionAddressingV1Schema.shape.discussionId,
    messageId: DiscussionAddressingV1Schema.shape.messageId,
    acceptedTurnId: z.optional(TurnIdSchema),
    decision: z.enum(['reject', 'cancel']),
  }),
]));
export type SessionMessageReplyAccountMutationV1 = z.infer<typeof SessionMessageReplyAccountMutationV1Schema>;

export const SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1 = 'session-message-reply-mutate-v1' as const;
export const SessionMessageReplyOperationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fulfill'), turnId: TurnIdSchema,
    /** Current host native-turn witness; the Home rechecks the original Run and committed row. */
    nativeResult: z.optional(z.strictObject({ runId: ParticipantExecutionRunRecipientRoutingIdentityV1Schema.shape.runId,
      sidechainId: z.string().check(z.minLength(1)), localId: PendingLocalIdSchema })),
    outcome: SessionMessageReplyOutcomeV1Schema.check(z.refine(outcome => outcome.kind !== 'declined',
      'Declining a private draft requires the present-person review operation')) }).check(
        z.refine(value => !value.nativeResult || 'result' in value.outcome, 'Native result binding requires a committed result')),
  z.strictObject({ kind: z.literal('inline') }),
  z.strictObject({ kind: z.literal('release') }),
  z.strictObject({ kind: z.literal('returned'), returnedInputLocalId: PendingLocalIdSchema }),
]));
export type SessionMessageReplyOperationV1 = z.infer<typeof SessionMessageReplyOperationV1Schema>;
export const SessionMessageReplyMutationV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  /** Authenticated publisher, either original receiver or original source. */
  sessionId: asProtocolZod(SessionIdSchema),
  requestSessionId: asProtocolZod(SessionIdSchema),
  requestLocalId: PendingLocalIdSchema,
  operation: SessionMessageReplyOperationV1Schema,
}));
export type SessionMessageReplyMutationV1 = z.infer<typeof SessionMessageReplyMutationV1Schema>;
/** Owning Machine recovery may acknowledge delivery, never author or consume an outcome. */
export const SessionMessageReplyMachineMutationV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), machineId: z.string().check(z.minLength(1)),
  requestSessionId: asProtocolZod(SessionIdSchema), requestLocalId: PendingLocalIdSchema,
  operation: z.strictObject({ kind: z.literal('returned'), returnedInputLocalId: PendingLocalIdSchema }),
}));
export type SessionMessageReplyMachineMutationV1 = z.infer<typeof SessionMessageReplyMachineMutationV1Schema>;
export const SESSION_MESSAGE_REPLY_RELEASE_SOURCE_TURN_EVENT_V1 = 'session-message-reply-release-source-turn-v1' as const;
export const SessionMessageReplySourceTurnReleaseV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), sessionId: asProtocolZod(SessionIdSchema), sourceTurnId: TurnIdSchema, sourceInputId: PendingLocalIdSchema,
}));
export type SessionMessageReplySourceTurnReleaseV1 = z.infer<typeof SessionMessageReplySourceTurnReleaseV1Schema>;
export const SessionMessageReplySourceTurnReleaseResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ v: z.literal(1), ok: z.literal(true) }),
  z.strictObject({ v: z.literal(1), ok: z.literal(false), error: z.enum(['unavailable', 'forbidden', 'invalid_request']) }),
]));
export type SessionMessageReplySourceTurnReleaseResultV1 = z.infer<typeof SessionMessageReplySourceTurnReleaseResultV1Schema>;
export const SessionMessageReplyReadResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ v: z.literal(1), status: z.literal('none') }),
  z.strictObject({ v: z.literal(1), status: z.literal('unavailable') }),
  z.strictObject({ v: z.literal(1), status: z.literal('available'), progress: SessionMessageReplyProgressV1Schema,
    recipient: z.optional(ParticipantExecutionRunRecipientRoutingIdentityV1Schema),
    returnRecipient: z.optional(ParticipantExecutionRunRecipientRoutingIdentityV1Schema), sidechainId: z.optional(z.string().check(z.minLength(1))) }),
]));
export type SessionMessageReplyReadResultV1 = z.infer<typeof SessionMessageReplyReadResultV1Schema>;
/** Exact demand, never a receiver inventory. HTTP body limits own request size. */
export const SessionMessageReplyReadBatchRequestV1Schema = lazyZodSchema(() => z.strictObject({
  requests: z.array(z.strictObject({ sessionId: asProtocolZod(SessionIdSchema), localId: PendingLocalIdSchema })),
}));
export const SessionMessageReplyReadBatchResponseV1Schema = lazyZodSchema(() => z.strictObject({
  results: z.array(z.strictObject({ sessionId: asProtocolZod(SessionIdSchema), localId: PendingLocalIdSchema,
    reply: SessionMessageReplyReadResultV1Schema })),
}));
export type SessionMessageReplyReadBatchResponseV1 = z.infer<typeof SessionMessageReplyReadBatchResponseV1Schema>;
export const SessionMessageReplyPendingPageV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  entries: z.array(z.strictObject({ requestLocalId: PendingLocalIdSchema, progress: SessionMessageReplyProgressV1Schema,
    returnRecipient: z.optional(ParticipantExecutionRunRecipientRoutingIdentityV1Schema) })),
  nextAfterLocalId: z.nullable(PendingLocalIdSchema),
}));
export type SessionMessageReplyPendingPageV1 = z.infer<typeof SessionMessageReplyPendingPageV1Schema>;
export const SessionMessageReplyMachinePendingCursorV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema), localId: PendingLocalIdSchema,
}));
export const SessionMessageReplyMachinePendingPageV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), entries: z.array(z.strictObject({ requestSessionId: asProtocolZod(SessionIdSchema),
    requestLocalId: PendingLocalIdSchema, progress: SessionMessageReplyProgressV1Schema,
    returnRecipient: z.optional(ParticipantExecutionRunRecipientRoutingIdentityV1Schema) })),
  nextAfter: z.nullable(SessionMessageReplyMachinePendingCursorV1Schema),
}));
export type SessionMessageReplyMachinePendingPageV1 = z.infer<typeof SessionMessageReplyMachinePendingPageV1Schema>;
/** Lossy content-free invalidation. Current original custody is always reread before an effect. */
export const SessionMessageReplyPendingHintV1Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal('session-message-reply-pending-v1'), v: z.literal(1),
  sessionId: asProtocolZod(SessionIdSchema), requestLocalId: PendingLocalIdSchema,
}));
export type SessionMessageReplyPendingHintV1 = z.infer<typeof SessionMessageReplyPendingHintV1Schema>;
export const SessionMessageReplyMutationResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ v: z.literal(1), ok: z.literal(true), progress: SessionMessageReplyProgressV1Schema }),
  z.strictObject({ v: z.literal(1), ok: z.literal(false), error: z.enum(['unavailable', 'forbidden', 'conflict', 'invalid_request']) }),
]));
export type SessionMessageReplyMutationResultV1 = z.infer<typeof SessionMessageReplyMutationResultV1Schema>;

/** Lost delivery acknowledgements rejoin this same original input, without another receipt. */
export function deriveSessionMessageReplyReturnLocalIdV1(params: Readonly<{
  sessionId: string; localId: string; acceptedTurnId?: string;
}>): string {
  const identity = JSON.stringify(['happier.session-input-reply.v1', SessionIdSchema.parse(params.sessionId),
    PendingLocalIdSchema.parse(params.localId), params.acceptedTurnId === undefined ? null : TurnIdSchema.parse(params.acceptedTurnId)]);
  return PendingLocalIdSchema.parse(`reply-v1:${encodeBase64(sha256(new TextEncoder().encode(identity)), 'base64url')}`);
}

/** Explicit publication retries retain their own committed row in the original receiver. */
export function deriveSessionMessageReplyAnswerLocalIdV1(params: Readonly<{
  sessionId: string; localId: string; acceptedTurnId: string;
}>): string {
  const identity = JSON.stringify(['happier.session-input-explicit-answer.v1', SessionIdSchema.parse(params.sessionId),
    PendingLocalIdSchema.parse(params.localId), TurnIdSchema.parse(params.acceptedTurnId)]);
  return PendingLocalIdSchema.parse(`answer-v1:${encodeBase64(sha256(new TextEncoder().encode(identity)), 'base64url')}`);
}

export { classifySessionMessageReplyPublicationFailureV1 } from './sessionMessageReplyPublicationV1.js';
