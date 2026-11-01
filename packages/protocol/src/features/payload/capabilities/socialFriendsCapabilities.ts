import { z } from 'zod';
import { lazySchema } from '../../../lazySchema.js';

export const SocialFriendsCapabilitiesSchema = lazySchema(() => z.object({
  allowUsername: z.boolean(),
  requiredIdentityProviderId: z.string().nullable(),
}));

export type SocialFriendsCapabilities = z.infer<typeof SocialFriendsCapabilitiesSchema>;

export const DEFAULT_SOCIAL_FRIENDS_CAPABILITIES: SocialFriendsCapabilities = {
  allowUsername: false,
  requiredIdentityProviderId: null,
};

