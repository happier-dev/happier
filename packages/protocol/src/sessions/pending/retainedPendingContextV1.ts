import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';
import { SessionPendingExecutionRunMaterializeNextRequestV2Schema } from '../messages/sessionPendingExecutionRunMachineAdmissionV2.js';
import { SessionRuntimeActivityProjectionSchema } from '../runtime/activity/sessionRuntimeActivity.js';
import { PendingLocalIdSchema } from './pendingLocalId.js';

/** Exact, still-uncollected context in the current publisher's local input queue. */
export const RetainedPendingContextV1Schema = lazyZodSchema(() => z.strictObject({
  localIds: z.array(PendingLocalIdSchema).check(z.minLength(1), z.refine(ids => new Set(ids).size === ids.length)),
}));
export type RetainedPendingContextV1 = z.infer<typeof RetainedPendingContextV1Schema>;

/** The authority-bearing V5 materialization request is closed at every object boundary. */
export const RetainedContextPendingMaterializeRequestV5Schema = lazyZodSchema(() => z.strictObject({
  sid: asProtocolZod(SessionIdSchema),
  pendingVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
  deliveryState: z.literal('provider'),
  deliveryTiming: SessionPendingExecutionRunMaterializeNextRequestV2Schema.shape.deliveryTiming,
  foregroundState: SessionPendingExecutionRunMaterializeNextRequestV2Schema.shape.foregroundState,
  expectedRuntimeActivityRevision: z.optional(SessionRuntimeActivityProjectionSchema.shape.revision),
  retainedContext: RetainedPendingContextV1Schema,
}));
