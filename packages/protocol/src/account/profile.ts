import { z } from 'zod';

import { ImageRefSchema } from '../common/imageRef.js';
import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceCredentialHealthV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
} from '../connect/connectedServiceSchemas.js';
import { lazySchema } from '../lazySchema.js';

const ConnectedServiceV2ProfileSchema = lazySchema(() => z.object({
  profileId: z.string().min(1),
  status: z.enum(['connected', 'refreshing', 'needs_reauth', 'refresh_failed_retryable']),
  kind: z.enum(['oauth', 'token']).nullable().optional().default(null),
  providerEmail: z.string().nullable().optional().default(null),
  providerAccountId: z.string().nullable().optional().default(null),
  expiresAt: z.number().int().nonnegative().nullable().optional().default(null),
  lastUsedAt: z.number().int().nonnegative().nullable().optional().default(null),
  health: ConnectedServiceCredentialHealthV1Schema.nullable().optional().default(null),
}).strict());

const ConnectedServiceV2GroupSchema = lazySchema(() => z.object({
  groupId: ConnectedServiceAuthGroupIdSchema,
  displayName: z.string().min(1).nullable().optional().default(null),
  activeProfileId: ConnectedServiceProfileIdSchema.nullable().optional().default(null),
  generation: z.number().int().nonnegative().optional().default(0),
  memberProfileIds: z.array(ConnectedServiceProfileIdSchema).default([]),
}).strict());

const ConnectedServiceV2ServiceSchema = lazySchema(() => z.object({
  serviceId: ConnectedServiceIdSchema,
  profiles: z.array(ConnectedServiceV2ProfileSchema).default([]),
  groups: z.array(ConnectedServiceV2GroupSchema).default([]),
}).strict());

const ConnectedServiceCredentialRevisionProjectionV1Schema = lazySchema(() => z.object({
  serviceId: ConnectedServiceIdSchema,
  profileId: ConnectedServiceProfileIdSchema,
  credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
}).strict());

export const LinkedProviderSchema = lazySchema(() => z.object({
  id: z.string(),
  login: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  profileUrl: z.string().nullable(),
  showOnProfile: z.boolean(),
}).strict());

export type LinkedProvider = z.infer<typeof LinkedProviderSchema>;

export const AccountProfileSchema = lazySchema(() => z.object({
  id: z.string(),
  timestamp: z.number().int().min(0).optional().default(0),
  firstName: z.string().nullable().optional().default(null),
  lastName: z.string().nullable().optional().default(null),
  username: z.string().nullable().optional().default(null),
  avatar: ImageRefSchema.nullable().optional().default(null),
  linkedProviders: z.array(LinkedProviderSchema).default([]),
  connectedServices: z.array(z.string()).default([]),
  connectedServicesV2: z.array(ConnectedServiceV2ServiceSchema).default([]),
  // Kept top-level for mixed-version rollout: released profile entries are strict,
  // while the released outer account profile explicitly passes through additions.
  connectedServiceCredentialRevisionsV1: z.array(ConnectedServiceCredentialRevisionProjectionV1Schema).default([]),
}).passthrough());

export type AccountProfile = z.infer<typeof AccountProfileSchema>;

export const AccountProfileResponseSchema = AccountProfileSchema;
export type AccountProfileResponse = AccountProfile;
