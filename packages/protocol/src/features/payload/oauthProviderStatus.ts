import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const OAuthProviderStatusSchema = lazyZodSchema(() => z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
}));

export type OAuthProviderStatus = z.infer<typeof OAuthProviderStatusSchema>;
