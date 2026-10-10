import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { ImageRefSchema } from '../common/imageRef.js';
import { ProfileBadgeSchema } from '../common/profileBadge.js';
import { AccountRecipientEnvelopeReadinessSchema } from '../account/encryptionMode.js';
import { KEYSET_CURSOR_MAX_LENGTH_V1 } from '../pagination/keysetCursorV1.js';

export const RelationshipStatusSchema = lazyZodSchema(() => z.enum(['none', 'requested', 'pending', 'friend', 'rejected']));
export type RelationshipStatus = z.infer<typeof RelationshipStatusSchema>;

export const UserProfileSchema = lazyZodSchema(() => z.object({
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
}));

export type UserProfile = z.infer<typeof UserProfileSchema>;

export const UserResponseSchema = lazyZodSchema(() => z.object({ user: UserProfileSchema }));
export type UserResponse = z.infer<typeof UserResponseSchema>;

/** Authenticated exact-user projection consumed by trusted direct-grant hosts. */
export const UserRecipientEnvelopeResponseSchema = lazyZodSchema(() => z.object({
  user: UserProfileSchema.extend({
    recipientEnvelopeReadiness: AccountRecipientEnvelopeReadinessSchema,
  }),
}));
export type UserRecipientEnvelopeResponse = z.infer<typeof UserRecipientEnvelopeResponseSchema>;

export const FriendsResponseSchema = lazyZodSchema(() => z.object({ friends: z.array(UserProfileSchema) }));
export type FriendsResponse = z.infer<typeof FriendsResponseSchema>;

/**
 * Username discovery is a keyset-paged directory. The continuation is opaque
 * and query-bound by the server; clients only carry it back unchanged.
 */
export const UsersSearchQueryV1Schema = lazyZodSchema(() => z.object({
  query: z.string(),
  cursor: z.string().min(1).max(KEYSET_CURSOR_MAX_LENGTH_V1).optional(),
  /** Narrow the directory to Accounts the caller may name in a collaboration grant. */
  purpose: z.literal('collaboration').optional(),
}).strict());
export type UsersSearchQueryV1 = z.infer<typeof UsersSearchQueryV1Schema>;

export const UsersSearchResponseSchema = lazyZodSchema(() => z.object({
  users: z.array(UserProfileSchema),
  // Optional while current clients can still meet a released Home. Absence is
  // the released bounded result and therefore has no continuation.
  nextCursor: z.string().min(1).max(KEYSET_CURSOR_MAX_LENGTH_V1).nullable().optional(),
}));
export type UsersSearchResponse = z.infer<typeof UsersSearchResponseSchema>;

export const RelationshipUpdatedEventSchema = lazyZodSchema(() => z.object({
  fromUserId: z.string(),
  toUserId: z.string(),
  status: RelationshipStatusSchema,
  action: z.enum(['created', 'updated', 'deleted']),
  fromUser: UserProfileSchema.optional(),
  toUser: UserProfileSchema.optional(),
  timestamp: z.number(),
}));

export type RelationshipUpdatedEvent = z.infer<typeof RelationshipUpdatedEventSchema>;
