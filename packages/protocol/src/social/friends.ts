import { z } from 'zod';
import { ImageRefSchema } from '../common/imageRef.js';
import { ProfileBadgeSchema } from '../common/profileBadge.js';

export const RelationshipStatusSchema = z.enum(['none', 'requested', 'pending', 'friend', 'rejected']);
export type RelationshipStatus = z.infer<typeof RelationshipStatusSchema>;

export const UserProfileSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  avatar: ImageRefSchema.nullable(),
  username: z.string(),
  bio: z.string().nullable(),
  badges: z.array(ProfileBadgeSchema).optional().default([]),
  status: RelationshipStatusSchema,
  // Keyless accounts (enterprise/plaintext mode) may not have an E2EE signing public key.
  publicKey: z.string().nullable(),
  // Optional for backward compatibility with older servers.
  contentPublicKey: z.string().nullable().optional(),
  contentPublicKeySig: z.string().nullable().optional(),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

export const UserResponseSchema = z.object({ user: UserProfileSchema });
export type UserResponse = z.infer<typeof UserResponseSchema>;

export const FriendsResponseSchema = z.object({ friends: z.array(UserProfileSchema) });
export type FriendsResponse = z.infer<typeof FriendsResponseSchema>;

export const UsersSearchResponseSchema = z.object({ users: z.array(UserProfileSchema) });
export type UsersSearchResponse = z.infer<typeof UsersSearchResponseSchema>;

export const RelationshipUpdatedEventSchema = z.object({
  fromUserId: z.string(),
  toUserId: z.string(),
  status: RelationshipStatusSchema,
  action: z.enum(['created', 'updated', 'deleted']),
  fromUser: UserProfileSchema.optional(),
  toUser: UserProfileSchema.optional(),
  timestamp: z.number(),
});

export type RelationshipUpdatedEvent = z.infer<typeof RelationshipUpdatedEventSchema>;
