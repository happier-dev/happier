import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ImageRefSchema } from '../common/imageRef.js';
import { ProfileBadgeSchema } from '../common/profileBadge.js';
import { AccountRecipientEnvelopeReadinessSchema } from '../account/encryptionMode.js';
import { KEYSET_CURSOR_MAX_LENGTH_V1 } from '../pagination/keysetCursorV1.js';
import { readAccountNameFromLegacyProfileV1 } from '../account/accountDisplayProfileV1.js';

export const RelationshipStatusSchema = lazyZodSchema(() => z.enum(['none', 'requested', 'pending', 'friend', 'rejected']));
export type RelationshipStatus = z.infer<typeof RelationshipStatusSchema>;

const UserProfileFieldsSchema = lazyZodSchema(() => z.object({
  id: z.string(),
  name: z.optional(z.nullable(z.string())),
  firstName: z.string(),
  lastName: z.nullable(z.string()),
  avatar: z.nullable(ImageRefSchema),
  username: z.string(),
  bio: z.nullable(z.string()),
  badges: z._default(z.optional(z.array(ProfileBadgeSchema)), []),
  status: RelationshipStatusSchema,
  // Keyless accounts (enterprise/plaintext mode) may not have an E2EE signing public key.
  publicKey: z.nullable(z.string()),
  // Optional for backward compatibility with older servers.
  contentPublicKey: z.optional(z.nullable(z.string())),
  contentPublicKeySig: z.optional(z.nullable(z.string())),
}));

export const UserProfileSchema = lazyZodSchema(() => z.pipe(UserProfileFieldsSchema, z.transform(profile => ({
  ...profile,
  name: readAccountNameFromLegacyProfileV1(profile),
}))));

export type UserProfile = z.infer<typeof UserProfileSchema>;

export const UserResponseSchema = lazyZodSchema(() => z.object({ user: UserProfileSchema }));
export type UserResponse = z.infer<typeof UserResponseSchema>;

/** The incumbent Friends writers take one Account id and may find no profile. */
export const FriendsMutationInputSchema = lazyZodSchema(() => z.strictObject({ uid: z.string() }));
export const FriendsMutationResponseSchema = lazyZodSchema(() => z.strictObject({ user: z.nullable(UserProfileSchema) }));
export const FriendsMutationErrorSchema = lazyZodSchema(() => z.union([
  z.strictObject({ error: z.literal('provider-required'), provider: z.string() }),
  z.strictObject({ error: z.literal('username-required') }),
  z.strictObject({ error: z.enum(['not_found', 'User not found']) }),
]));

/** Authenticated exact-user projection consumed by trusted direct-grant hosts. */
export const UserRecipientEnvelopeResponseSchema = lazyZodSchema(() => z.object({
  user: z.pipe(z.extend(UserProfileFieldsSchema, {
    recipientEnvelopeReadiness: AccountRecipientEnvelopeReadinessSchema,
  }), z.transform(profile => ({ ...profile, name: readAccountNameFromLegacyProfileV1(profile) }))),
}));
export type UserRecipientEnvelopeResponse = z.infer<typeof UserRecipientEnvelopeResponseSchema>;

export const FriendsResponseSchema = lazyZodSchema(() => z.object({ friends: z.array(UserProfileSchema) }));
export type FriendsResponse = z.infer<typeof FriendsResponseSchema>;

/**
 * Username discovery is a keyset-paged directory. The continuation is opaque
 * and query-bound by the server; clients only carry it back unchanged.
 */
export const UsersSearchQueryV1Schema = lazyZodSchema(() => z.strictObject({
  query: z.string(),
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(KEYSET_CURSOR_MAX_LENGTH_V1))),
  /** Narrow the directory to Accounts the caller may name in a collaboration grant. */
  purpose: z.optional(z.literal('collaboration')),
}));
export type UsersSearchQueryV1 = z.infer<typeof UsersSearchQueryV1Schema>;

export const UsersSearchResponseSchema = lazyZodSchema(() => z.object({
  users: z.array(UserProfileSchema),
  // Optional while current clients can still meet a released Home. Absence is
  // the released bounded result and therefore has no continuation.
  nextCursor: z.optional(z.nullable(z.string().check(z.minLength(1), z.maxLength(KEYSET_CURSOR_MAX_LENGTH_V1)))),
}));
export type UsersSearchResponse = z.infer<typeof UsersSearchResponseSchema>;

export const RelationshipUpdatedEventSchema = lazyZodSchema(() => z.object({
  fromUserId: z.string(),
  toUserId: z.string(),
  status: RelationshipStatusSchema,
  action: z.enum(['created', 'updated', 'deleted']),
  fromUser: z.optional(UserProfileSchema),
  toUser: z.optional(UserProfileSchema),
  timestamp: z.number(),
}));

export type RelationshipUpdatedEvent = z.infer<typeof RelationshipUpdatedEventSchema>;
