import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const ProfileBadgeSchema = lazySchema(() => z.object({
  id: z.string(),
  label: z.string(),
  url: z.string(),
}).strict());

export type ProfileBadge = z.infer<typeof ProfileBadgeSchema>;

