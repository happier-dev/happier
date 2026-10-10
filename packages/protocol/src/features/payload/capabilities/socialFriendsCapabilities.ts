import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

export const SocialFriendsCapabilitiesSchema = lazyZodSchema(() => z.object({
  allowUsername: z.boolean(),
  requiredIdentityProviderId: z.string().nullable(),
}));

export type SocialFriendsCapabilities = z.infer<typeof SocialFriendsCapabilitiesSchema>;

export const DEFAULT_SOCIAL_FRIENDS_CAPABILITIES: SocialFriendsCapabilities = {
  allowUsername: false,
  requiredIdentityProviderId: null,
};
