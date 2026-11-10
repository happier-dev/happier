import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const ProfileBadgeSchema = lazyZodSchema(() => z.strictObject({
  id: z.string(),
  label: z.string(),
  url: z.string(),
}));

export type ProfileBadge = z.infer<typeof ProfileBadgeSchema>;
