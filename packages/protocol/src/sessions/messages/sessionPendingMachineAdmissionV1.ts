import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SessionIdSchema } from '../idsV1.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { PendingRequestedActionV1Schema } from '../pending/pendingRequestedActionV1.js';
import {
  SessionInputEnqueueResultV1Schema,
  SessionInputRequestEqualityEvidenceV1Schema,
  SESSION_FOLLOW_INPUT_ADMISSION_FIELDS_V1,
  SESSION_NEXT_TURN_NOTE_ADMISSION_FIELDS_V1,
} from './sessionInputAdmission.js';
import { SessionStoredMessageContentSchema } from './sessionStoredMessageContent.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionMachineRpcExecutionV1Schema, ExternalActionRequestEnvelopeSchema } from '../../actions/externalActionApi.js';
import { SessionMessageReplyAdmissionV1Schema } from './sessionMessageReplyV1.js';

export const SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 =
  'session-pending-enqueue-by-machine-v1' as const;

const SessionPendingTargetMachineIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));

export const SessionPendingEnqueueByMachineFieldsV1 = {
  v: z.literal(1),
  sessionId: asProtocolZod(SessionIdSchema),
  /** Live routing fact only. The server must not persist it in admission metadata. */
  targetMachineId: SessionPendingTargetMachineIdV1Schema,
  localId: PendingLocalIdSchema,
  content: SessionStoredMessageContentSchema,
  requestedAction: PendingRequestedActionV1Schema,
  requestEqualityEvidenceV1: z.optional(SessionInputRequestEqualityEvidenceV1Schema),
  reply: z.optional(SessionMessageReplyAdmissionV1Schema),
  ...SESSION_FOLLOW_INPUT_ADMISSION_FIELDS_V1,
  ...SESSION_NEXT_TURN_NOTE_ADMISSION_FIELDS_V1,
  /** Existing invocation authorization plus exact Machine-signed payload; never raw caller constraints. */
  externalAction: z.optional(z.lazy(() => ExternalActionMachineRpcExecutionV1Schema)),
};

/** Shared host-equality boundary for each closed Machine admission epoch. */
export function refineSessionPendingMachineEqualityEvidenceV1(
  value: { content: z.infer<typeof SessionStoredMessageContentSchema>; requestEqualityEvidenceV1?: z.infer<typeof SessionInputRequestEqualityEvidenceV1Schema> },
  context: z.core.$RefinementCtx,
): void {
  if (value.content.t === 'plain' && value.requestEqualityEvidenceV1 !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['requestEqualityEvidenceV1'],
      message: 'Plain machine admission equality is server-derived only at terminal settlement',
    });
  }
  if (
    value.content.t === 'encrypted'
    && value.requestEqualityEvidenceV1 !== undefined
    && value.requestEqualityEvidenceV1.kind !== 'e2eeTag'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['requestEqualityEvidenceV1'],
      message: 'Encrypted machine admission accepts only the host-derived E2EE equality tag',
    });
  }
}

export const SessionPendingEnqueueByMachineRequestV1Schema = lazyZodSchema(() => z.strictObject(SessionPendingEnqueueByMachineFieldsV1).check(z.superRefine(refineSessionPendingMachineEqualityEvidenceV1)));
export type SessionPendingEnqueueByMachineRequestV1 = z.infer<
  typeof SessionPendingEnqueueByMachineRequestV1Schema
>;

/** One requester-owned startup input under the signed, canonical template birth. */
export const SessionPendingTemplateOnboardingInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: SessionPendingEnqueueByMachineFieldsV1.v,
  sessionId: SessionPendingEnqueueByMachineFieldsV1.sessionId,
  targetMachineId: SessionPendingEnqueueByMachineFieldsV1.targetMachineId,
  localId: SessionPendingEnqueueByMachineFieldsV1.localId,
  content: SessionPendingEnqueueByMachineFieldsV1.content,
  requestedAction: SessionPendingEnqueueByMachineFieldsV1.requestedAction,
  requestEqualityEvidenceV1: SessionPendingEnqueueByMachineFieldsV1.requestEqualityEvidenceV1,
}).check(z.superRefine(refineSessionPendingMachineEqualityEvidenceV1)));
export type SessionPendingTemplateOnboardingInputV1 = z.infer<typeof SessionPendingTemplateOnboardingInputV1Schema>;

export const SessionPendingTemplateOnboardingRequestV1Schema = lazyZodSchema(() => z.strictObject({
  authorization: ExternalActionExecutionAuthorizationV1Schema,
  originalActionEnvelope: ExternalActionRequestEnvelopeSchema,
  request: SessionPendingTemplateOnboardingInputV1Schema,
}));

export const SessionPendingEnqueueByMachineResponseV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  result: SessionInputEnqueueResultV1Schema,
}));
export type SessionPendingEnqueueByMachineResponseV1 = z.infer<
  typeof SessionPendingEnqueueByMachineResponseV1Schema
>;
