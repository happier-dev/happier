import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { UsageTimingBoundsV1Schema } from '../../usage/usageTimingV1.js';

import { SessionIdSchema } from '../idsV1.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import {
  SessionInputAdmissionRejectionCodeV1Schema,
  SessionInputAdmissionResultV1Schema,
  SessionInputRequestEqualityEvidenceV1Schema,
  SessionInputSourceSessionV1Schema,
  SessionInputReturnedAnswerV1Schema,
} from './sessionInputAdmission.js';
import { SessionStoredMessageContentSchema } from './sessionStoredMessageContent.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";
import { SessionMessageReplyAdmissionV1Schema } from './sessionMessageReplyV1.js';

export const SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1 =
  'session-pending-admission-settlement-v1' as const;

const BoundedSettlementIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(191)));

export const SessionInputSettlementValidationV1Schema = lazyZodSchema(() => z.strictObject({
  sourceSession: z.optional(SessionInputSourceSessionV1Schema),
  returnedAnswer: z.optional(SessionInputReturnedAnswerV1Schema),
  autonomousCheckIn: z.optional(z.strictObject({
    afterTurns: z.nullable(z.number().check(z.int(), z.positive())),
  })),
  automation: z.optional(z.strictObject({
    automationId: BoundedSettlementIdSchema,
    runId: BoundedSettlementIdSchema,
  })),
  reply: z.optional(SessionMessageReplyAdmissionV1Schema),
}));
export type SessionInputSettlementValidationV1 = z.infer<
  typeof SessionInputSettlementValidationV1Schema
>;

export const SessionPendingAdmissionSettlementRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sessionId: asProtocolZod(SessionIdSchema),
  localId: PendingLocalIdSchema,
  decision: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('admit'),
      finalContent: SessionStoredMessageContentSchema,
      usageTimingV1: z.optional(z.nullable(UsageTimingBoundsV1Schema)),
      /** Original request evidence from the exact target publisher, never from an Account request. */
      requestEqualityEvidenceV1: z.optional(SessionInputRequestEqualityEvidenceV1Schema),
      validation: z.optional(SessionInputSettlementValidationV1Schema),
    }),
    z.strictObject({
      kind: z.literal('reject'),
      code: SessionInputAdmissionRejectionCodeV1Schema,
      validation: z.optional(SessionInputSettlementValidationV1Schema),
    }),
  ]),
}).check(z.superRefine((value, context) => {
  if (value.decision.kind !== 'admit' || value.decision.requestEqualityEvidenceV1 === undefined) return;
  if (value.decision.finalContent.t !== 'encrypted' || value.decision.requestEqualityEvidenceV1.kind !== 'e2eeTag') {
    context.addIssue({ code: 'custom', path: ['decision', 'requestEqualityEvidenceV1'], message: 'Publisher equality evidence requires encrypted target content and a host-derived E2EE tag' });
  }
})));
export type SessionPendingAdmissionSettlementRequestV1 = z.infer<
  typeof SessionPendingAdmissionSettlementRequestV1Schema
>;

export const SessionPendingAdmissionSettlementResponseV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  result: SessionInputAdmissionResultV1Schema,
}));
export type SessionPendingAdmissionSettlementResponseV1 = z.infer<
  typeof SessionPendingAdmissionSettlementResponseV1Schema
>;
