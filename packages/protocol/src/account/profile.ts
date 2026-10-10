import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { ImageRefSchema } from '../common/imageRef.js';
import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceCloudVendorKeySchema,
  ConnectedServiceCredentialHealthV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
} from '../connect/connectedServiceSchemas.js';
import {
  QualifiedConnectedAccountGroupV4Schema,
  QualifiedConnectedAccountProfileV4Schema,
} from '../connect/qualifiedConnectedAccountProjectionsV4.js';
import { TeamIdSchema } from '../teams/membership.js';
import { TEAM_NAME_MAX_LENGTH_V1 } from '../teams/team.js';

const ConnectedServiceV2ProfileSchema = lazyZodSchema(() => z.object({
  profileId: z.string().min(1),
  status: z.enum(['connected', 'refreshing', 'needs_reauth', 'refresh_failed_retryable']),
  kind: z.enum(['oauth', 'token']).nullable().optional().default(null),
  providerEmail: z.string().nullable().optional().default(null),
  providerAccountId: z.string().nullable().optional().default(null),
  expiresAt: z.number().int().nonnegative().nullable().optional().default(null),
  lastUsedAt: z.number().int().nonnegative().nullable().optional().default(null),
  health: ConnectedServiceCredentialHealthV1Schema.nullable().optional().default(null),
}).strict());

const ConnectedServiceV2GroupSchema = lazyZodSchema(() => z.object({
  groupId: ConnectedServiceAuthGroupIdSchema,
  displayName: z.string().min(1).nullable().optional().default(null),
  activeProfileId: ConnectedServiceProfileIdSchema.nullable().optional().default(null),
  generation: z.number().int().nonnegative().optional().default(0),
  memberProfileIds: z.array(ConnectedServiceProfileIdSchema).default([]),
}).strict());

const ConnectedServiceV2ServiceSchema = lazyZodSchema(() => z.object({
  serviceId: ConnectedServiceIdSchema,
  profiles: z.array(ConnectedServiceV2ProfileSchema).default([]),
  groups: z.array(ConnectedServiceV2GroupSchema).default([]),
}).strict());

const ConnectedServiceCredentialRevisionProjectionV1Schema = lazyZodSchema(() => z.object({
  serviceId: ConnectedServiceIdSchema,
  profileId: ConnectedServiceProfileIdSchema,
  credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
}).strict());

export const LinkedProviderSchema = lazyZodSchema(() => z.object({
  id: z.string(),
  login: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  profileUrl: z.string().nullable(),
  showOnProfile: z.boolean(),
}).strict());

export type LinkedProvider = z.infer<typeof LinkedProviderSchema>;

const LinkedIdentityTeamPresentationV1Schema = lazyZodSchema(() => z.object({
  id: TeamIdSchema,
  name: z.string().trim().min(1).max(TEAM_NAME_MAX_LENGTH_V1),
}).strict());

export const LinkedIdentityManagementReasonV1Schema = lazyZodSchema(() => z.enum([
  'required_by_team',
  'last_login_method',
  'management_unavailable',
]));
export type LinkedIdentityManagementReasonV1 = z.infer<typeof LinkedIdentityManagementReasonV1Schema>;

export const LinkedIdentityManagementV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  providerId: z.string().trim().min(1).max(512),
  descriptor: z.object({
    displayName: z.string().trim().min(1).max(256).nullable(),
    iconHint: z.string().trim().min(1).max(256).nullable(),
    source: z.enum(['built_in', 'deployment', 'managed', 'unavailable']),
  }).strict(),
  managedBy: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('home') }).strict(),
    z.object({ kind: z.literal('team'), team: LinkedIdentityTeamPresentationV1Schema }).strict(),
  ]).nullable(),
  requiredByTeams: z.array(LinkedIdentityTeamPresentationV1Schema),
  canDisconnect: z.boolean(),
  disconnectReason: LinkedIdentityManagementReasonV1Schema.nullable(),
  canPublishProfile: z.boolean(),
  publishProfileReason: LinkedIdentityManagementReasonV1Schema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.canDisconnect !== (value.disconnectReason === null)) {
    context.addIssue({ code: 'custom', message: 'Disconnect permission and reason must agree' });
  }
  if (value.canPublishProfile !== (value.publishProfileReason === null)) {
    context.addIssue({ code: 'custom', message: 'Profile publication permission and reason must agree' });
  }
  if (value.descriptor.source !== 'managed' && value.managedBy !== null) {
    context.addIssue({ code: 'custom', message: 'Only managed providers can identify a management owner' });
  }
}));
export type LinkedIdentityManagementV1 = z.infer<typeof LinkedIdentityManagementV1Schema>;

export const AccountProfileSchema = lazyZodSchema(() => z.object({
  id: z.string(),
  timestamp: z.number().int().min(0).optional().default(0),
  firstName: z.string().nullable().optional().default(null),
  lastName: z.string().nullable().optional().default(null),
  username: z.string().nullable().optional().default(null),
  avatar: ImageRefSchema.nullable().optional().default(null),
  linkedProviders: z.array(LinkedProviderSchema).default([]),
  linkedIdentityManagementV1: z.array(LinkedIdentityManagementV1Schema).optional(),
  connectedServices: z.array(ConnectedServiceCloudVendorKeySchema).default([]),
  connectedServicesV2: z.array(ConnectedServiceV2ServiceSchema).default([]),
  connectedServiceCredentialRevisionsV1: z.array(ConnectedServiceCredentialRevisionProjectionV1Schema).default([]),
  connectedAccountsV4: z.array(QualifiedConnectedAccountProfileV4Schema).default([]),
  connectedAccountGroupsV4: z.array(QualifiedConnectedAccountGroupV4Schema).default([]),
}).passthrough());

export type AccountProfile = z.infer<typeof AccountProfileSchema>;

export const AccountProfileResponseSchema = AccountProfileSchema;
export type AccountProfileResponse = AccountProfile;
