import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const VendorPluginMentionV1Schema = lazyZodSchema(() => z.looseObject({
  backendId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  agentId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  vendorPluginRef: z.string().check(z.trim(), z.minLength(1)),
  label: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export type VendorPluginMentionV1 = z.infer<typeof VendorPluginMentionV1Schema>;
