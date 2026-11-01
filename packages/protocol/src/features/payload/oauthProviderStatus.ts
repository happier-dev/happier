import { z } from 'zod';
import { lazySchema } from '../../lazySchema.js';

export const OAuthProviderStatusSchema = lazySchema(() => z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
}));

export type OAuthProviderStatus = z.infer<typeof OAuthProviderStatusSchema>;

