import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const PendingQueueWakeUnavailableV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  error: z.literal('pending_materialization_wake_unavailable'),
  errorCode: z.literal('runtime_upgrade_required'),
}));

export const SessionPendingQueueLegacyMaterializeDeferredResponseV0Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  didMaterialize: z.literal(false),
  result: z.strictObject({ type: z.literal('deferred'), reason: z.literal('runtime_upgrade_required') }),
}));
export const SessionPendingQueueWakeCapabilityRequestV1Schema = lazyZodSchema(() => z.strictObject({}));
export const SessionPendingQueueWakeCapabilityResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true), capability: z.literal('pending_queue_wake_v1'), protocolVersion: z.literal(1),
    method: z.literal('session.pendingQueue.wake.v1'),
  }),
  PendingQueueWakeUnavailableV1Schema,
]));
export const SessionPendingQueueWakeRequestV1Schema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(1),
}));
export const SessionPendingQueueWakeResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), result: z.literal('wake_published') }),
  PendingQueueWakeUnavailableV1Schema,
]));
