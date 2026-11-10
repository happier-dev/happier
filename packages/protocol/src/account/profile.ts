import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { readAccountNameFromLegacyProfileV1 } from './accountDisplayProfileV1.js';

export const AccountNameUpdateRequestV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.nullable(z.pipe(z.string().check(z.trim()), z.transform(name => name || null))),
}));
export type AccountNameUpdateRequestV1 = z.infer<typeof AccountNameUpdateRequestV1Schema>;

export const AccountNameUpdateResponseV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.nullable(z.string()),
  firstName: z.nullable(z.string()),
  lastName: z.nullable(z.string()),
  timestamp: z.number().check(z.int(), z.nonnegative()),
}));
export type AccountNameUpdateResponseV1 = z.infer<typeof AccountNameUpdateResponseV1Schema>;

export const AccountUsernameUpdateRequestV1Schema = lazyZodSchema(() => z.strictObject({ username: z.string() }));
export const AccountUsernameUpdateResponseV1Schema = lazyZodSchema(() => z.strictObject({ username: z.string() }));
export const AccountUsernameUpdateErrorV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.enum(['invalid-username', 'username-disabled', 'friends-disabled', 'username-taken', 'username-changed']),
}));

export const AccountUsernameCheckRequestV1Schema = lazyZodSchema(() => z.strictObject({ username: z.string() }));
export type AccountUsernameCheckRequestV1 = z.infer<typeof AccountUsernameCheckRequestV1Schema>;
export const AccountUsernameCheckResponseV1Schema = lazyZodSchema(() => z.strictObject({
  username: z.string(),
  availability: z.enum(['available', 'unavailable', 'invalid', 'reserved']),
  suggestions: z.array(z.string()),
}));
export type AccountUsernameCheckResponseV1 = z.infer<typeof AccountUsernameCheckResponseV1Schema>;

export const AccountUsernameReleaseRequestV1Schema = lazyZodSchema(() => z.strictObject({}));
export type AccountUsernameReleaseRequestV1 = z.infer<typeof AccountUsernameReleaseRequestV1Schema>;
export const AccountUsernameReleaseResponseV1Schema = lazyZodSchema(() => z.strictObject({
  username: z.null(),
  released: z.boolean(),
  reservedUntilMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
}));
export type AccountUsernameReleaseResponseV1 = z.infer<typeof AccountUsernameReleaseResponseV1Schema>;

import { ImageRefSchema } from '../common/imageRef.js';

/** Self-profile read projection. Drop unrelated and future GET-profile fields before disclosure. */
export const AccountSelfProfileV1Schema = lazyZodSchema(() => z.pipe(z.object({
  id: z.string(),
  timestamp: z._default(z.optional(z.number().check(z.int(), z.nonnegative())), 0),
  name: z.optional(z.nullable(z.string())),
  firstName: z._default(z.optional(z.nullable(z.string())), null),
  lastName: z._default(z.optional(z.nullable(z.string())), null),
  username: z._default(z.optional(z.nullable(z.string())), null),
  avatar: z._default(z.optional(z.nullable(ImageRefSchema)), null),
}), z.transform(profile => ({ ...profile, name: readAccountNameFromLegacyProfileV1(profile) }))));
export type AccountSelfProfileV1 = z.infer<typeof AccountSelfProfileV1Schema>;

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

const ConnectedServiceV2ProfileSchema = lazyZodSchema(() => z.strictObject({
  profileId: z.string().check(z.minLength(1)),
  status: z.enum(['connected', 'refreshing', 'needs_reauth', 'refresh_failed_retryable']),
  kind: z._default(z.optional(z.nullable(z.enum(['oauth', 'token']))), null),
  providerEmail: z._default(z.optional(z.nullable(z.string())), null),
  providerAccountId: z._default(z.optional(z.nullable(z.string())), null),
  expiresAt: z._default(z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))), null),
  lastUsedAt: z._default(z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))), null),
  health: z._default(z.optional(z.nullable(ConnectedServiceCredentialHealthV1Schema)), null),
}));

const ConnectedServiceV2GroupSchema = lazyZodSchema(() => z.strictObject({
  groupId: ConnectedServiceAuthGroupIdSchema,
  displayName: z._default(z.optional(z.nullable(z.string().check(z.minLength(1)))), null),
  activeProfileId: z._default(z.optional(z.nullable(ConnectedServiceProfileIdSchema)), null),
  generation: z._default(z.optional(z.number().check(z.int(), z.nonnegative())), 0),
  memberProfileIds: z._default(z.array(ConnectedServiceProfileIdSchema), []),
}));

const ConnectedServiceV2ServiceSchema = lazyZodSchema(() => z.strictObject({
  serviceId: ConnectedServiceIdSchema,
  profiles: z._default(z.array(ConnectedServiceV2ProfileSchema), []),
  groups: z._default(z.array(ConnectedServiceV2GroupSchema), []),
}));

const ConnectedServiceCredentialRevisionProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  serviceId: ConnectedServiceIdSchema,
  profileId: ConnectedServiceProfileIdSchema,
  credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
}));

export const LinkedProviderSchema = lazyZodSchema(() => z.strictObject({
  id: z.string(),
  login: z.nullable(z.string()),
  displayName: z.nullable(z.string()),
  avatarUrl: z.nullable(z.string()),
  profileUrl: z.nullable(z.string()),
  showOnProfile: z.boolean(),
}));

export type LinkedProvider = z.infer<typeof LinkedProviderSchema>;

const LinkedIdentityTeamPresentationV1Schema = lazyZodSchema(() => z.strictObject({
  id: TeamIdSchema,
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(TEAM_NAME_MAX_LENGTH_V1)),
}));

export const LinkedIdentityManagementReasonV1Schema = lazyZodSchema(() => z.enum([
  'required_by_team',
  'last_login_method',
  'management_unavailable',
]));
export type LinkedIdentityManagementReasonV1 = z.infer<typeof LinkedIdentityManagementReasonV1Schema>;

export const LinkedIdentityManagementV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  providerId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  descriptor: z.strictObject({
    displayName: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    iconHint: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    source: z.enum(['built_in', 'deployment', 'managed', 'unavailable']),
  }),
  managedBy: z.nullable(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('home') }),
    z.strictObject({ kind: z.literal('team'), team: LinkedIdentityTeamPresentationV1Schema }),
  ])),
  requiredByTeams: z.array(LinkedIdentityTeamPresentationV1Schema),
  canDisconnect: z.boolean(),
  disconnectReason: z.nullable(LinkedIdentityManagementReasonV1Schema),
  canPublishProfile: z.boolean(),
  publishProfileReason: z.nullable(LinkedIdentityManagementReasonV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.canDisconnect !== (value.disconnectReason === null)) {
    context.addIssue({ code: 'custom', message: 'Disconnect permission and reason must agree' });
  }
  if (value.canPublishProfile !== (value.publishProfileReason === null)) {
    context.addIssue({ code: 'custom', message: 'Profile publication permission and reason must agree' });
  }
  if (value.descriptor.source !== 'managed' && value.managedBy !== null) {
    context.addIssue({ code: 'custom', message: 'Only managed providers can identify a management owner' });
  }
})));
export type LinkedIdentityManagementV1 = z.infer<typeof LinkedIdentityManagementV1Schema>;

export const AccountProfileSchema = lazyZodSchema(() => z.pipe(z.looseObject({
  id: z.string(),
  timestamp: z._default(z.optional(z.number().check(z.int(), z.minimum(0))), 0),
  name: z.optional(z.nullable(z.string())),
  firstName: z._default(z.optional(z.nullable(z.string())), null),
  lastName: z._default(z.optional(z.nullable(z.string())), null),
  username: z._default(z.optional(z.nullable(z.string())), null),
  avatar: z._default(z.optional(z.nullable(ImageRefSchema)), null),
  linkedProviders: z._default(z.array(LinkedProviderSchema), []),
  linkedIdentityManagementV1: z.optional(z.array(LinkedIdentityManagementV1Schema)),
  connectedServices: z._default(z.array(ConnectedServiceCloudVendorKeySchema), []),
  connectedServicesV2: z._default(z.array(ConnectedServiceV2ServiceSchema), []),
  connectedServiceCredentialRevisionsV1: z._default(z.array(ConnectedServiceCredentialRevisionProjectionV1Schema), []),
  connectedAccountsV4: z._default(z.array(QualifiedConnectedAccountProfileV4Schema), []),
  connectedAccountGroupsV4: z._default(z.array(QualifiedConnectedAccountGroupV4Schema), []),
}), z.transform(profile => ({ ...profile, name: readAccountNameFromLegacyProfileV1(profile) }))));

export type AccountProfile = z.infer<typeof AccountProfileSchema>;

export const AccountProfileResponseSchema = AccountProfileSchema;
export type AccountProfileResponse = AccountProfile;
