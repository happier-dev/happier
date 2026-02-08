import { z } from 'zod';

import { ImageRefSchema } from '../common/imageRef.js';

export const LinkedProviderSchema = z.object({
  id: z.string(),
  login: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  profileUrl: z.string().nullable(),
  showOnProfile: z.boolean(),
}).strict();

export type LinkedProvider = z.infer<typeof LinkedProviderSchema>;

export const AccountProfileSchema = z.object({
  id: z.string(),
  timestamp: z.number().int().min(0).optional().default(0),
  firstName: z.string().nullable().optional().default(null),
  lastName: z.string().nullable().optional().default(null),
  username: z.string().nullable().optional().default(null),
  avatar: ImageRefSchema.nullable().optional().default(null),
  linkedProviders: z.array(LinkedProviderSchema).default([]),
  connectedServices: z.array(z.string()).default([]),
}).passthrough();

export type AccountProfile = z.infer<typeof AccountProfileSchema>;

export const AccountProfileResponseSchema = AccountProfileSchema;
export type AccountProfileResponse = AccountProfile;
