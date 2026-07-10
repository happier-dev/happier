import { z } from 'zod';

export const SharingPendingQueueV2CapabilitiesSchema = z.object({
  deliveryState: z.boolean().optional().default(false),
  deliveryBlockedReason: z.boolean().optional().default(false),
});

export type SharingPendingQueueV2Capabilities = z.infer<typeof SharingPendingQueueV2CapabilitiesSchema>;

export const DEFAULT_SHARING_PENDING_QUEUE_V2_CAPABILITIES: SharingPendingQueueV2Capabilities = Object.freeze({
  deliveryState: false,
  deliveryBlockedReason: false,
});

export const SharingCapabilitiesSchema = z.object({
  pendingQueueV2: SharingPendingQueueV2CapabilitiesSchema.optional().default(DEFAULT_SHARING_PENDING_QUEUE_V2_CAPABILITIES),
});

export type SharingCapabilities = z.infer<typeof SharingCapabilitiesSchema>;

export const DEFAULT_SHARING_CAPABILITIES: SharingCapabilities = Object.freeze({
  pendingQueueV2: DEFAULT_SHARING_PENDING_QUEUE_V2_CAPABILITIES,
});
