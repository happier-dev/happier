import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { SessionPendingExecutionRunMaterializeNextRequestV2Schema } from '../messages/sessionPendingExecutionRunMachineAdmissionV2.js';

export const PENDING_INPUT_READY_EVENT_V1 = 'pending-input-ready';

export const PendingInputReadyV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    id: z.number().check(z.int(), z.minimum(1)),
    pendingVersion: z.number().check(z.int(), z.minimum(0)),
    foregroundState: SessionPendingExecutionRunMaterializeNextRequestV2Schema.shape.foregroundState,
    deliveryTiming: SessionPendingExecutionRunMaterializeNextRequestV2Schema.shape.deliveryTiming,
    expectedRuntimeActivityRevision: z.optional(z.number().check(z.int(), z.minimum(0))),
}));

export type PendingInputReadyV1 = z.infer<typeof PendingInputReadyV1Schema>;

// The materialized result is decoded by the same parser as pending-materialize-next.
export const PendingRunnerClaimV1Schema = lazyZodSchema(() => z.strictObject({
    id: PendingInputReadyV1Schema.shape.id,
    result: z.union([z.literal('queue-only'), z.record(z.string(), z.unknown())]),
}));

export type PendingRunnerClaimV1 = z.infer<typeof PendingRunnerClaimV1Schema>;
