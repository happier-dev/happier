import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const VendorPluginMentionV1Schema = lazyZodSchema(() => z.object({
  backendId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  vendorPluginRef: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
}).passthrough());

export type VendorPluginMentionV1 = z.infer<typeof VendorPluginMentionV1Schema>;
