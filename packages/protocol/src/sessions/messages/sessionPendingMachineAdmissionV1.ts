import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { UsageTimingBoundsV1Schema } from '../../usage/usageTimingV1.js';

import { SessionIdSchema } from '../idsV1.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { PendingRequestedActionV1Schema } from '../pending/pendingRequestedActionV1.js';
import { SessionRequesterInstallationSealedBootstrapV1Schema } from '../creation/sessionRequesterBootstrapSchemasV1.js';
import {
  SessionInputEnqueueResultV1Schema,
  SessionInputRequestEqualityEvidenceV1Schema,
  SESSION_FOLLOW_INPUT_ADMISSION_FIELDS_V1,
  SESSION_NEXT_TURN_NOTE_ADMISSION_FIELDS_V1,
  SessionInputMachineTargetV1Schema,
} from './sessionInputAdmission.js';
import { SessionStoredMessageContentSchema } from './sessionStoredMessageContent.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";
import { ExternalActionMachineRpcExecutionV1Schema } from '../../actions/externalActionApi.js';
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
  usageTimingV1: z.optional(z.nullable(UsageTimingBoundsV1Schema)),
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

/** One owner-authored startup input admitted by the Session Pending owner. */
export const SessionPendingTemplateOnboardingInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: SessionPendingEnqueueByMachineFieldsV1.v,
  sessionId: SessionPendingEnqueueByMachineFieldsV1.sessionId,
  targetMachineId: SessionPendingEnqueueByMachineFieldsV1.targetMachineId,
  localId: SessionPendingEnqueueByMachineFieldsV1.localId,
  content: SessionPendingEnqueueByMachineFieldsV1.content,
  usageTimingV1: SessionPendingEnqueueByMachineFieldsV1.usageTimingV1,
  requestedAction: SessionPendingEnqueueByMachineFieldsV1.requestedAction,
  requestEqualityEvidenceV1: SessionPendingEnqueueByMachineFieldsV1.requestEqualityEvidenceV1,
  /** Private birth custody; excluded from ordinary Pending and Session projections. */
  requesterBootstrap: z.optional(SessionRequesterInstallationSealedBootstrapV1Schema),
}).check(z.superRefine(refineSessionPendingMachineEqualityEvidenceV1)));
export type SessionPendingTemplateOnboardingInputV1 = z.infer<typeof SessionPendingTemplateOnboardingInputV1Schema>;

export const SESSION_PENDING_REQUESTER_BOOTSTRAP_EVENT_V1 = 'session-pending-requester-bootstrap-v1' as const;
/** The receipt owns placement; the opaque box opens only at that installation. */
export const SessionPendingRequesterBootstrapV1Schema = lazyZodSchema(() => z.strictObject({
  target: SessionInputMachineTargetV1Schema,
  requestId: PendingLocalIdSchema,
  requesterBootstrap: SessionRequesterInstallationSealedBootstrapV1Schema,
}));
export type SessionPendingRequesterBootstrapV1 = z.infer<typeof SessionPendingRequesterBootstrapV1Schema>;
export const SessionPendingRequesterBootstrapRequestV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ v: z.literal(1), operation: z.literal('list'), sessionId: z.optional(asProtocolZod(SessionIdSchema)) }),
  z.strictObject({ v: z.literal(1), operation: z.literal('consume'), sessionId: asProtocolZod(SessionIdSchema), requestId: PendingLocalIdSchema }),
]));
export type SessionPendingRequesterBootstrapRequestV1 = z.infer<typeof SessionPendingRequesterBootstrapRequestV1Schema>;
export const SessionPendingRequesterBootstrapResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ v: z.literal(1), ok: z.literal(true), bootstraps: z.array(SessionPendingRequesterBootstrapV1Schema) }),
  z.strictObject({ v: z.literal(1), ok: z.literal(true) }),
  z.strictObject({ v: z.literal(1), ok: z.literal(false) }),
]));
export type SessionPendingRequesterBootstrapResponseV1 = z.infer<typeof SessionPendingRequesterBootstrapResponseV1Schema>;

export const SessionPendingTemplateOnboardingRequestV1Schema = lazyZodSchema(() => z.strictObject({
  request: SessionPendingTemplateOnboardingInputV1Schema,
}));

export const SessionPendingEnqueueByMachineResponseV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  result: SessionInputEnqueueResultV1Schema,
}));
export type SessionPendingEnqueueByMachineResponseV1 = z.infer<
  typeof SessionPendingEnqueueByMachineResponseV1Schema
>;
