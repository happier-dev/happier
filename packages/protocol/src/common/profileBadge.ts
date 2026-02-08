import { z } from 'zod';

export const ProfileBadgeSchema = z.object({
  id: z.string(),
  label: z.string(),
  url: z.string(),
}).strict();

export type ProfileBadge = z.infer<typeof ProfileBadgeSchema>;

