import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const SESSION_PENDING_QUEUE_DELIVERY_TIMINGS = ['after_foreground_ready', 'after_runtime_idle'] as const;
export const DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING = 'after_foreground_ready' as const;
export const SessionPendingQueueDeliveryTimingSchema = lazyZodSchema(() => z.catch(z
  .enum(SESSION_PENDING_QUEUE_DELIVERY_TIMINGS), DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING));
export type SessionPendingQueueDeliveryTiming = z.infer<typeof SessionPendingQueueDeliveryTimingSchema>;
