import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const ProfileBadgeSchema = lazyZodSchema(() => z.object({
  id: z.string(),
  label: z.string(),
  url: z.string(),
}).strict());

export type ProfileBadge = z.infer<typeof ProfileBadgeSchema>;
