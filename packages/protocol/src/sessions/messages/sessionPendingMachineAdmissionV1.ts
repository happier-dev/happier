import { lazyZodSchema } from '../../lazyZodSchema.js';
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
import { ExternalActionMachineRpcExecutionV1Schema } from '../../actions/externalActionApi.js';

export const SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 =
  'session-pending-enqueue-by-machine-v1' as const;

const SessionPendingTargetMachineIdV1Schema = lazyZodSchema(() => z.string().trim().min(1).max(256));

export const SessionPendingEnqueueByMachineFieldsV1 = {
  v: z.literal(1),
  sessionId: asProtocolZod(SessionIdSchema),
  /** Live routing fact only. The server must not persist it in admission metadata. */
  targetMachineId: SessionPendingTargetMachineIdV1Schema,
  localId: PendingLocalIdSchema,
  content: SessionStoredMessageContentSchema,
  requestedAction: PendingRequestedActionV1Schema,
  requestEqualityEvidenceV1: SessionInputRequestEqualityEvidenceV1Schema.optional(),
  /** Existing invocation authorization plus exact Machine-signed payload; never raw caller constraints. */
  externalAction: z.lazy(() => ExternalActionMachineRpcExecutionV1Schema).optional(),
};

/** Shared host-equality boundary for each closed Machine admission epoch. */
export function refineSessionPendingMachineEqualityEvidenceV1(
  value: { content: z.infer<typeof SessionStoredMessageContentSchema>; requestEqualityEvidenceV1?: z.infer<typeof SessionInputRequestEqualityEvidenceV1Schema> },
  context: z.RefinementCtx,
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

export const SessionPendingEnqueueByMachineRequestV1Schema = lazyZodSchema(() => z.object(SessionPendingEnqueueByMachineFieldsV1)
  .strict().superRefine(refineSessionPendingMachineEqualityEvidenceV1));
export type SessionPendingEnqueueByMachineRequestV1 = z.infer<
  typeof SessionPendingEnqueueByMachineRequestV1Schema
>;

export const SessionPendingEnqueueByMachineResponseV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  result: SessionInputAdmissionResultV1Schema,
}).strict());
export type SessionPendingEnqueueByMachineResponseV1 = z.infer<
  typeof SessionPendingEnqueueByMachineResponseV1Schema
>;
