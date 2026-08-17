import { z } from 'zod';

import { SessionIdSchema } from '../idsV1.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { PendingRequestedActionV1Schema } from '../pending/pendingRequestedActionV1.js';
import {
  SessionInputAdmissionResultV1Schema,
  SessionInputRequestEqualityEvidenceV1Schema,
} from './sessionInputAdmission.js';
import { SessionStoredMessageContentSchema } from './sessionStoredMessageContent.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

export const SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 =
  'session-pending-enqueue-by-machine-v1' as const;

const SessionPendingTargetMachineIdV1Schema = z.string().trim().min(1).max(256);

export const SessionPendingEnqueueByMachineRequestV1Schema = z.object({
  v: z.literal(1),
  sessionId: asProtocolZod(SessionIdSchema),
  /** Live routing fact only. The server must not persist it in admission metadata. */
  targetMachineId: SessionPendingTargetMachineIdV1Schema,
  localId: PendingLocalIdSchema,
  content: SessionStoredMessageContentSchema,
  requestedAction: PendingRequestedActionV1Schema,
  requestEqualityEvidenceV1: SessionInputRequestEqualityEvidenceV1Schema.optional(),
}).strict().superRefine((value, context) => {
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
});
export type SessionPendingEnqueueByMachineRequestV1 = z.infer<
  typeof SessionPendingEnqueueByMachineRequestV1Schema
>;

export const SessionPendingEnqueueByMachineResponseV1Schema = z.object({
  v: z.literal(1),
  result: SessionInputAdmissionResultV1Schema,
}).strict();
export type SessionPendingEnqueueByMachineResponseV1 = z.infer<
  typeof SessionPendingEnqueueByMachineResponseV1Schema
>;
