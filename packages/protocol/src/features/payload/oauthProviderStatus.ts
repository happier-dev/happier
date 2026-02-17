import { z } from 'zod';

export const OAuthProviderStatusSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
});

export type OAuthProviderStatus = z.infer<typeof OAuthProviderStatusSchema>;

