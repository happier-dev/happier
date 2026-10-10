import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { SessionIdSchema, TurnIdSchema } from '../idsV1.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import {
  SessionInputAdmissionRejectionCodeV1Schema,
  SessionInputAdmissionResultV1Schema,
  SessionInputRequestEqualityEvidenceV1Schema,
} from './sessionInputAdmission.js';
import { SessionStoredMessageContentSchema } from './sessionStoredMessageContent.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

export const SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1 =
  'session-pending-admission-settlement-v1' as const;

const BoundedSettlementIdSchema = lazyZodSchema(() => z.string().trim().min(1).max(191));

export const SessionInputSettlementValidationV1Schema = lazyZodSchema(() => z.object({
  sourceSession: z.object({
    sourceSessionId: asProtocolZod(SessionIdSchema),
    sourceTurnId: TurnIdSchema,
    via: z.enum(['action', 'mcp']),
  }).strict().optional(),
  automation: z.object({
    automationId: BoundedSettlementIdSchema,
    runId: BoundedSettlementIdSchema,
  }).strict().optional(),
}).strict());
export type SessionInputSettlementValidationV1 = z.infer<
  typeof SessionInputSettlementValidationV1Schema
>;

export const SessionPendingAdmissionSettlementRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  sessionId: asProtocolZod(SessionIdSchema),
  localId: PendingLocalIdSchema,
  decision: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('admit'),
      finalContent: SessionStoredMessageContentSchema,
      /** Original request evidence from the exact target publisher, never from an Account request. */
      requestEqualityEvidenceV1: SessionInputRequestEqualityEvidenceV1Schema.optional(),
      validation: SessionInputSettlementValidationV1Schema.optional(),
    }).strict(),
    z.object({
      kind: z.literal('reject'),
      code: SessionInputAdmissionRejectionCodeV1Schema,
      validation: SessionInputSettlementValidationV1Schema.optional(),
    }).strict(),
  ]),
}).strict().superRefine((value, context) => {
  if (value.decision.kind !== 'admit' || value.decision.requestEqualityEvidenceV1 === undefined) return;
  if (value.decision.finalContent.t !== 'encrypted' || value.decision.requestEqualityEvidenceV1.kind !== 'e2eeTag') {
    context.addIssue({ code: 'custom', path: ['decision', 'requestEqualityEvidenceV1'], message: 'Publisher equality evidence requires encrypted target content and a host-derived E2EE tag' });
  }
}));
export type SessionPendingAdmissionSettlementRequestV1 = z.infer<
  typeof SessionPendingAdmissionSettlementRequestV1Schema
>;

export const SessionPendingAdmissionSettlementResponseV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  result: SessionInputAdmissionResultV1Schema,
}).strict());
export type SessionPendingAdmissionSettlementResponseV1 = z.infer<
  typeof SessionPendingAdmissionSettlementResponseV1Schema
>;
