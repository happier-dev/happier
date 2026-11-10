import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

export const SharingPendingQueueV2CapabilitiesSchema = lazyZodSchema(() => z.object({
  deliveryState: z._default(z.optional(z.boolean()), false),
  deliveryBlockedReason: z._default(z.optional(z.boolean()), false),
}));

export type SharingPendingQueueV2Capabilities = z.infer<typeof SharingPendingQueueV2CapabilitiesSchema>;

export const DEFAULT_SHARING_PENDING_QUEUE_V2_CAPABILITIES: SharingPendingQueueV2Capabilities = Object.freeze({
  deliveryState: false,
  deliveryBlockedReason: false,
});

export const SharingCapabilitiesSchema = lazyZodSchema(() => z.object({
  pendingQueueV2: z._default(z.optional(SharingPendingQueueV2CapabilitiesSchema), DEFAULT_SHARING_PENDING_QUEUE_V2_CAPABILITIES),
}));

export type SharingCapabilities = z.infer<typeof SharingCapabilitiesSchema>;

export const DEFAULT_SHARING_CAPABILITIES: SharingCapabilities = Object.freeze({
  pendingQueueV2: DEFAULT_SHARING_PENDING_QUEUE_V2_CAPABILITIES,
});
