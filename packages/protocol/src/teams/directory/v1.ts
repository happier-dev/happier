import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { TEAM_DIRECTORY_ACTION_IDS_V1, type TeamDirectoryActionIdV1 } from './actionIds.js';

import { TeamIdSchema, TeamMembershipIdSchema } from '../membership.js';
import { TeamGroupNameProjectionV1Schema } from '../groupLabel.js';

const DirectoryIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(256)));
const DirectoryLabelSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(256)));
const DirectoryTimestampSchema = lazyZodSchema(() => z.iso.datetime({ offset: true }));

export const TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_DEFAULT_V1 = 50;
export const TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_MAX_V1 = 100;

export const TeamDirectorySafeErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'directory_sync_unavailable',
  'directory_source_not_found',
  'directory_source_removed',
  'directory_source_identity_mismatch',
  'directory_source_permission_lost',
  'directory_cursor_expired',
  'directory_event_invalid',
  'directory_snapshot_incomplete',
  'directory_sync_rate_limited',
  'directory_group_mapping_invalid',
  'directory_group_already_bound',
  'directory_sync_needs_attention',
]));
export type TeamDirectorySafeErrorCodeV1 = z.infer<typeof TeamDirectorySafeErrorCodeV1Schema>;

export const TeamDirectoryErrorV1Schema = lazyZodSchema(() => z.strictObject({
  error: TeamDirectorySafeErrorCodeV1Schema,
}));
export type TeamDirectoryErrorV1 = z.infer<typeof TeamDirectoryErrorV1Schema>;

export const TeamDirectorySourceAllowedActionV1Schema = lazyZodSchema(() => z.enum([
  'teams.directory.sources.sync',
  'teams.directory.sources.pause',
  'teams.directory.sources.resume',
  'teams.directory.sources.remove',
]));
export type TeamDirectorySourceAllowedActionV1 = z.infer<typeof TeamDirectorySourceAllowedActionV1Schema>;

export const TeamDirectorySourceSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  id: DirectoryIdSchema,
  teamId: TeamIdSchema,
  kind: z.enum(['workos_directory', 'github_organization']),
  displayName: DirectoryLabelSchema,
  /** Exact current WorkOS connection used by the existing Admin Portal action. */
  workosAdminPortalConnectionId: z.optional(z.nullable(DirectoryIdSchema)),
  state: z.enum(['initializing', 'active', 'paused', 'needs_attention']),
  allowedActions: z.array(TeamDirectorySourceAllowedActionV1Schema),
  sync: z.strictObject({
    mode: z.enum(['events_and_full', 'full_only']),
    attempt: z.enum(['never', 'syncing', 'succeeded', 'failed', 'paused']),
    freshness: z.enum(['never_synced', 'fresh', 'stale', 'unknown']),
    lastAttemptAt: z.nullable(DirectoryTimestampSchema),
    lastSuccessAt: z.nullable(DirectoryTimestampSchema),
    lastFullReconcileAt: z.nullable(DirectoryTimestampSchema),
    nextScheduledAt: z.nullable(DirectoryTimestampSchema),
  }),
  error: z.nullable(z.strictObject({
    code: TeamDirectorySafeErrorCodeV1Schema,
    retryable: z.boolean(),
  })),
}));
export type TeamDirectorySourceSummaryV1 = z.infer<typeof TeamDirectorySourceSummaryV1Schema>;

export const TeamDirectorySourcePageV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(TeamDirectorySourceSummaryV1Schema),
  nextCursor: z.nullable(z.string()),
}));
export type TeamDirectorySourcePageV1 = z.infer<typeof TeamDirectorySourcePageV1Schema>;

export const TeamDirectorySourceSetupOptionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('workos_directory'),
    displayName: DirectoryLabelSchema,
    teamIdentityConnectionId: DirectoryIdSchema,
    workosDirectoryId: DirectoryIdSchema,
  }),
  z.strictObject({
    kind: z.literal('github_organization'),
    displayName: DirectoryLabelSchema,
    githubAppInstallationId: DirectoryIdSchema,
  }),
]));
export type TeamDirectorySourceSetupOptionV1 = z.infer<typeof TeamDirectorySourceSetupOptionV1Schema>;

export const TeamDirectorySourceSetupOptionsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  items: z.array(TeamDirectorySourceSetupOptionV1Schema).check(z.maxLength(TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_MAX_V1)),
  nextCursor: z.nullable(z.string()),
  complete: z.boolean(),
}));
export type TeamDirectorySourceSetupOptionsV1 = z.infer<typeof TeamDirectorySourceSetupOptionsV1Schema>;

const TeamDirectoryAccountBindingV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unbound') }),
  z.strictObject({
    state: z.literal('bound'),
    accountId: DirectoryIdSchema,
    teamMembershipId: z.nullable(TeamMembershipIdSchema),
  }),
]));

export const TeamDirectoryPersonV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  id: DirectoryIdSchema,
  sourceId: DirectoryIdSchema,
  externalUserId: DirectoryIdSchema,
  displayName: z.nullable(z.string().check(z.maxLength(512))),
  email: z.nullable(z.string().check(z.maxLength(512))),
  externalLogin: z.nullable(z.string().check(z.maxLength(512))),
  state: z.enum(['active', 'suspended', 'deleted']),
  accountBinding: TeamDirectoryAccountBindingV1Schema,
  sourceLabel: DirectoryLabelSchema,
}));
export type TeamDirectoryPersonV1 = z.infer<typeof TeamDirectoryPersonV1Schema>;

export const TeamDirectoryPeoplePageV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(TeamDirectoryPersonV1Schema),
  nextCursor: z.nullable(z.string()),
}));
export type TeamDirectoryPeoplePageV1 = z.infer<typeof TeamDirectoryPeoplePageV1Schema>;

const TeamDirectoryGroupMappingV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unbound') }),
  z.strictObject({
    state: z.literal('bound'),
    bindingId: DirectoryIdSchema,
    mode: z.enum(['directory_created', 'native_target']),
    teamGroupId: DirectoryIdSchema,
    /** Recipient-safe label; null explicitly means the target is outside this Team. */
    teamGroupName: z.nullable(TeamGroupNameProjectionV1Schema),
  }),
]));

export const TeamDirectoryGroupV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  id: DirectoryIdSchema,
  sourceId: DirectoryIdSchema,
  externalGroupId: DirectoryIdSchema,
  displayName: z.string().check(z.minLength(1), z.maxLength(512)),
  state: z.enum(['active', 'deleted']),
  memberCount: z.nullable(z.number().check(z.int(), z.minimum(0))),
  /** Distinct Accounts bound to people in the complete external Group roster. */
  boundAccountCount: z.nullable(z.number().check(z.int(), z.minimum(0))),
  /** People in the complete external Group roster without an Account binding. */
  unboundPeopleCount: z.nullable(z.number().check(z.int(), z.minimum(0))),
  mapping: TeamDirectoryGroupMappingV1Schema,
  lastCompleteObservationAt: z.nullable(DirectoryTimestampSchema),
  sourceLabel: DirectoryLabelSchema,
}));
export type TeamDirectoryGroupV1 = z.infer<typeof TeamDirectoryGroupV1Schema>;

export const TeamDirectoryGroupPageV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(TeamDirectoryGroupV1Schema),
  nextCursor: z.nullable(z.string()),
}));
export type TeamDirectoryGroupPageV1 = z.infer<typeof TeamDirectoryGroupPageV1Schema>;

export const TeamDirectorySourcesListInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  teamId: TeamIdSchema,
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_MAX_V1))),
  cursor: z.optional(z.nullable(z.string().check(z.minLength(1), z.maxLength(512)))),
}));
export type TeamDirectorySourcesListInputV1 = z.infer<typeof TeamDirectorySourcesListInputV1Schema>;

export const TeamDirectorySourceSetupListInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  teamId: TeamIdSchema,
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_MAX_V1))),
  cursor: z.optional(z.nullable(z.string().check(z.minLength(1), z.maxLength(512)))),
  query: z.optional(z.string().check(z.maxLength(256))),
}));
export type TeamDirectorySourceSetupListInputV1 = z.infer<typeof TeamDirectorySourceSetupListInputV1Schema>;

export const TeamDirectorySourceRefInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  teamId: TeamIdSchema,
  sourceId: DirectoryIdSchema,
}));
export type TeamDirectorySourceRefInputV1 = z.infer<typeof TeamDirectorySourceRefInputV1Schema>;

const TeamDirectoryPageInputFieldsV1 = {
  v: z.literal(1),
  teamId: TeamIdSchema,
  sourceId: DirectoryIdSchema,
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_MAX_V1))),
  cursor: z.optional(z.nullable(z.string().check(z.minLength(1), z.maxLength(512)))),
} as const;

export const TeamDirectoryPeopleListInputV1Schema = lazyZodSchema(() => z.strictObject(TeamDirectoryPageInputFieldsV1));
export type TeamDirectoryPeopleListInputV1 = z.infer<typeof TeamDirectoryPeopleListInputV1Schema>;

export const TeamDirectoryGroupsListInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...TeamDirectoryPageInputFieldsV1,
  query: z.optional(z.string().check(z.maxLength(256))),
}));
export type TeamDirectoryGroupsListInputV1 = z.infer<typeof TeamDirectoryGroupsListInputV1Schema>;

const TeamDirectorySourceCreateBaseV1 = {
  v: z.literal(1),
  teamId: TeamIdSchema,
  displayName: DirectoryLabelSchema,
} as const;

export const TeamDirectorySourceCreateInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    ...TeamDirectorySourceCreateBaseV1,
    kind: z.literal('workos_directory'),
    teamIdentityConnectionId: DirectoryIdSchema,
    workosDirectoryId: DirectoryIdSchema,
  }),
  z.strictObject({
    ...TeamDirectorySourceCreateBaseV1,
    kind: z.literal('github_organization'),
    githubAppInstallationId: DirectoryIdSchema,
  }),
]));
export type TeamDirectorySourceCreateInputV1 = z.infer<typeof TeamDirectorySourceCreateInputV1Schema>;

export const TeamDirectorySourceSyncResultV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  status: z.enum(['requested', 'coalesced']),
  source: TeamDirectorySourceSummaryV1Schema,
}));
export type TeamDirectorySourceSyncResultV1 = z.infer<typeof TeamDirectorySourceSyncResultV1Schema>;

export const TeamDirectorySourceRemovalImpactV1Schema = lazyZodSchema(() => z.strictObject({
  teamMembershipsRemoved: z.number().check(z.int(), z.minimum(0)),
  groupMembershipsRemoved: z.number().check(z.int(), z.minimum(0)),
  groupContributionsRemoved: z.number().check(z.int(), z.minimum(0)),
  directoryCreatedGroupsRetained: z.number().check(z.int(), z.minimum(0)),
  nativeMembershipsPreserved: z.number().check(z.int(), z.minimum(0)),
  nativeGroupContributionsPreserved: z.number().check(z.int(), z.minimum(0)),
}));
export type TeamDirectorySourceRemovalImpactV1 = z.infer<typeof TeamDirectorySourceRemovalImpactV1Schema>;

export const TeamDirectorySourceRemovalPreflightV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  status: z.literal('allowed'),
  sourceId: DirectoryIdSchema,
  sourceLabel: DirectoryLabelSchema,
  impact: TeamDirectorySourceRemovalImpactV1Schema,
}));
export type TeamDirectorySourceRemovalPreflightV1 = z.infer<typeof TeamDirectorySourceRemovalPreflightV1Schema>;

export const TeamDirectorySourceRemoveResultV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  status: z.enum(['removed', 'already_absent']),
  impact: TeamDirectorySourceRemovalImpactV1Schema,
}));
export type TeamDirectorySourceRemoveResultV1 = z.infer<typeof TeamDirectorySourceRemoveResultV1Schema>;

/** HTTP path/query/body codecs consumed by the REST adapter for these Actions. */
export const TeamDirectoryTeamParamsV1Schema = lazyZodSchema(() => z.strictObject({ teamId: TeamIdSchema }));
export const TeamDirectorySourceParamsV1Schema = lazyZodSchema(() => z.strictObject({
  teamId: TeamIdSchema,
  sourceId: DirectoryIdSchema,
}));
export const TeamDirectorySourceListQueryV1Schema = lazyZodSchema(() => z.strictObject({
  limit: z.optional(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_MAX_V1))),
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
}));
export const TeamDirectorySourceSetupListQueryV1Schema = lazyZodSchema(() => z.strictObject({
  limit: z.optional(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_MAX_V1))),
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
  query: z.optional(z.string().check(z.maxLength(256))),
}));
export const TeamDirectoryPeopleListQueryV1Schema = TeamDirectorySourceListQueryV1Schema;
export const TeamDirectoryGroupsListQueryV1Schema = lazyZodSchema(() => z.strictObject({
  limit: z.optional(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_MAX_V1))),
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
  query: z.optional(z.string().check(z.maxLength(256))),
}));
export const TeamDirectorySourceCreateBodyV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('workos_directory'),
    displayName: DirectoryLabelSchema,
    teamIdentityConnectionId: DirectoryIdSchema,
    workosDirectoryId: DirectoryIdSchema,
  }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('github_organization'),
    displayName: DirectoryLabelSchema,
    githubAppInstallationId: DirectoryIdSchema,
  }),
]));
export const TeamDirectoryLifecycleBodyV1Schema = lazyZodSchema(() => z.strictObject({ v: z.literal(1) }));

// The ids are declared in the dependency-free id module; re-exported here so
// this module's existing public surface is unchanged.
export { TEAM_DIRECTORY_ACTION_IDS_V1, type TeamDirectoryActionIdV1 } from './actionIds.js';
export const TeamDirectoryActionIdV1Schema = lazyZodSchema(() => z.enum(TEAM_DIRECTORY_ACTION_IDS_V1));

export const TEAM_DIRECTORY_ACTION_PATHS_V1: Readonly<Record<TeamDirectoryActionIdV1, string>> = Object.freeze({
  'teams.directory.sourceSetup.list': '/v1/teams/:teamId/directory-source-setup-options',
  'teams.directory.sources.list': '/v1/teams/:teamId/directory-sources',
  'teams.directory.sources.get': '/v1/teams/:teamId/directory-sources/:sourceId',
  'teams.directory.people.list': '/v1/teams/:teamId/directory-sources/:sourceId/people',
  'teams.directory.groups.list': '/v1/teams/:teamId/directory-sources/:sourceId/groups',
  'teams.directory.sources.create': '/v1/teams/:teamId/directory-sources',
  'teams.directory.sources.sync': '/v1/teams/:teamId/directory-sources/:sourceId/sync',
  'teams.directory.sources.pause': '/v1/teams/:teamId/directory-sources/:sourceId/pause',
  'teams.directory.sources.resume': '/v1/teams/:teamId/directory-sources/:sourceId/resume',
  'teams.directory.sources.remove.preview': '/v1/teams/:teamId/directory-sources/:sourceId/removal-impact',
  'teams.directory.sources.remove': '/v1/teams/:teamId/directory-sources/:sourceId',
});

export const TEAM_DIRECTORY_ACTION_METHODS_V1: Readonly<Record<TeamDirectoryActionIdV1, 'GET' | 'POST' | 'DELETE'>> = Object.freeze({
  'teams.directory.sourceSetup.list': 'GET',
  'teams.directory.sources.list': 'GET',
  'teams.directory.sources.get': 'GET',
  'teams.directory.people.list': 'GET',
  'teams.directory.groups.list': 'GET',
  'teams.directory.sources.create': 'POST',
  'teams.directory.sources.sync': 'POST',
  'teams.directory.sources.pause': 'POST',
  'teams.directory.sources.resume': 'POST',
  'teams.directory.sources.remove.preview': 'GET',
  'teams.directory.sources.remove': 'DELETE',
});

export const TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1 = Object.freeze({
  'teams.directory.sourceSetup.list': TeamDirectorySourceSetupListInputV1Schema,
  'teams.directory.sources.list': TeamDirectorySourcesListInputV1Schema,
  'teams.directory.sources.get': TeamDirectorySourceRefInputV1Schema,
  'teams.directory.people.list': TeamDirectoryPeopleListInputV1Schema,
  'teams.directory.groups.list': TeamDirectoryGroupsListInputV1Schema,
  'teams.directory.sources.create': TeamDirectorySourceCreateInputV1Schema,
  'teams.directory.sources.sync': TeamDirectorySourceRefInputV1Schema,
  'teams.directory.sources.pause': TeamDirectorySourceRefInputV1Schema,
  'teams.directory.sources.resume': TeamDirectorySourceRefInputV1Schema,
  'teams.directory.sources.remove.preview': TeamDirectorySourceRefInputV1Schema,
  'teams.directory.sources.remove': TeamDirectorySourceRefInputV1Schema,
} satisfies Record<TeamDirectoryActionIdV1, z.ZodMiniType>);

export const TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1 = Object.freeze({
  'teams.directory.sourceSetup.list': TeamDirectorySourceSetupOptionsV1Schema,
  'teams.directory.sources.list': TeamDirectorySourcePageV1Schema,
  'teams.directory.sources.get': TeamDirectorySourceSummaryV1Schema,
  'teams.directory.people.list': TeamDirectoryPeoplePageV1Schema,
  'teams.directory.groups.list': TeamDirectoryGroupPageV1Schema,
  'teams.directory.sources.create': TeamDirectorySourceSummaryV1Schema,
  'teams.directory.sources.sync': TeamDirectorySourceSyncResultV1Schema,
  'teams.directory.sources.pause': TeamDirectorySourceSummaryV1Schema,
  'teams.directory.sources.resume': TeamDirectorySourceSummaryV1Schema,
  'teams.directory.sources.remove.preview': TeamDirectorySourceRemovalPreflightV1Schema,
  'teams.directory.sources.remove': TeamDirectorySourceRemoveResultV1Schema,
} satisfies Record<TeamDirectoryActionIdV1, z.ZodMiniType>);
