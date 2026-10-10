import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { TEAM_DIRECTORY_ACTION_IDS_V1, type TeamDirectoryActionIdV1 } from './actionIds.js';

import { TeamIdSchema, TeamMembershipIdSchema } from '../membership.js';

const DirectoryIdSchema = lazyZodSchema(() => z.string().min(1).max(256));
const DirectoryLabelSchema = lazyZodSchema(() => z.string().min(1).max(256));
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

export const TeamDirectoryErrorV1Schema = lazyZodSchema(() => z.object({
  error: TeamDirectorySafeErrorCodeV1Schema,
}).strict());
export type TeamDirectoryErrorV1 = z.infer<typeof TeamDirectoryErrorV1Schema>;

export const TeamDirectorySourceAllowedActionV1Schema = lazyZodSchema(() => z.enum([
  'teams.directory.sources.sync',
  'teams.directory.sources.pause',
  'teams.directory.sources.resume',
  'teams.directory.sources.remove',
]));
export type TeamDirectorySourceAllowedActionV1 = z.infer<typeof TeamDirectorySourceAllowedActionV1Schema>;

export const TeamDirectorySourceSummaryV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  id: DirectoryIdSchema,
  teamId: TeamIdSchema,
  kind: z.enum(['workos_directory', 'github_organization']),
  displayName: DirectoryLabelSchema,
  /** Exact current WorkOS connection used by the existing Admin Portal action. */
  workosAdminPortalConnectionId: DirectoryIdSchema.nullable().optional(),
  state: z.enum(['initializing', 'active', 'paused', 'needs_attention']),
  allowedActions: z.array(TeamDirectorySourceAllowedActionV1Schema),
  sync: z.object({
    mode: z.enum(['events_and_full', 'full_only']),
    attempt: z.enum(['never', 'syncing', 'succeeded', 'failed', 'paused']),
    freshness: z.enum(['never_synced', 'fresh', 'stale', 'unknown']),
    lastAttemptAt: DirectoryTimestampSchema.nullable(),
    lastSuccessAt: DirectoryTimestampSchema.nullable(),
    lastFullReconcileAt: DirectoryTimestampSchema.nullable(),
    nextScheduledAt: DirectoryTimestampSchema.nullable(),
  }).strict(),
  error: z.object({
    code: TeamDirectorySafeErrorCodeV1Schema,
    retryable: z.boolean(),
  }).strict().nullable(),
}).strict());
export type TeamDirectorySourceSummaryV1 = z.infer<typeof TeamDirectorySourceSummaryV1Schema>;

export const TeamDirectorySourcePageV1Schema = lazyZodSchema(() => z.object({
  items: z.array(TeamDirectorySourceSummaryV1Schema),
  nextCursor: z.string().nullable(),
}).strict());
export type TeamDirectorySourcePageV1 = z.infer<typeof TeamDirectorySourcePageV1Schema>;

export const TeamDirectorySourceSetupOptionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('workos_directory'),
    displayName: DirectoryLabelSchema,
    teamIdentityConnectionId: DirectoryIdSchema,
    workosDirectoryId: DirectoryIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('github_organization'),
    displayName: DirectoryLabelSchema,
    githubAppInstallationId: DirectoryIdSchema,
  }).strict(),
]));
export type TeamDirectorySourceSetupOptionV1 = z.infer<typeof TeamDirectorySourceSetupOptionV1Schema>;

export const TeamDirectorySourceSetupOptionsV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  items: z.array(TeamDirectorySourceSetupOptionV1Schema).max(TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_MAX_V1),
  nextCursor: z.string().nullable(),
  complete: z.boolean(),
}).strict());
export type TeamDirectorySourceSetupOptionsV1 = z.infer<typeof TeamDirectorySourceSetupOptionsV1Schema>;

const TeamDirectoryAccountBindingV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  z.object({ state: z.literal('unbound') }).strict(),
  z.object({
    state: z.literal('bound'),
    accountId: DirectoryIdSchema,
    teamMembershipId: TeamMembershipIdSchema.nullable(),
  }).strict(),
]));

export const TeamDirectoryPersonV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  id: DirectoryIdSchema,
  sourceId: DirectoryIdSchema,
  externalUserId: DirectoryIdSchema,
  displayName: z.string().max(512).nullable(),
  email: z.string().max(512).nullable(),
  externalLogin: z.string().max(512).nullable(),
  state: z.enum(['active', 'suspended', 'deleted']),
  accountBinding: TeamDirectoryAccountBindingV1Schema,
  sourceLabel: DirectoryLabelSchema,
}).strict());
export type TeamDirectoryPersonV1 = z.infer<typeof TeamDirectoryPersonV1Schema>;

export const TeamDirectoryPeoplePageV1Schema = lazyZodSchema(() => z.object({
  items: z.array(TeamDirectoryPersonV1Schema),
  nextCursor: z.string().nullable(),
}).strict());
export type TeamDirectoryPeoplePageV1 = z.infer<typeof TeamDirectoryPeoplePageV1Schema>;

const TeamDirectoryGroupMappingV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  z.object({ state: z.literal('unbound') }).strict(),
  z.object({
    state: z.literal('bound'),
    bindingId: DirectoryIdSchema,
    mode: z.enum(['directory_created', 'native_target']),
    teamGroupId: DirectoryIdSchema,
  }).strict(),
]));

export const TeamDirectoryGroupV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  id: DirectoryIdSchema,
  sourceId: DirectoryIdSchema,
  externalGroupId: DirectoryIdSchema,
  displayName: z.string().min(1).max(512),
  state: z.enum(['active', 'deleted']),
  memberCount: z.number().int().min(0).nullable(),
  /** Distinct Accounts bound to people in the complete external Group roster. */
  boundAccountCount: z.number().int().min(0).nullable(),
  /** People in the complete external Group roster without an Account binding. */
  unboundPeopleCount: z.number().int().min(0).nullable(),
  mapping: TeamDirectoryGroupMappingV1Schema,
  lastCompleteObservationAt: DirectoryTimestampSchema.nullable(),
  sourceLabel: DirectoryLabelSchema,
}).strict());
export type TeamDirectoryGroupV1 = z.infer<typeof TeamDirectoryGroupV1Schema>;

export const TeamDirectoryGroupPageV1Schema = lazyZodSchema(() => z.object({
  items: z.array(TeamDirectoryGroupV1Schema),
  nextCursor: z.string().nullable(),
}).strict());
export type TeamDirectoryGroupPageV1 = z.infer<typeof TeamDirectoryGroupPageV1Schema>;

export const TeamDirectorySourcesListInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  limit: z.number().int().min(1).max(TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_MAX_V1).optional(),
  cursor: z.string().min(1).max(512).nullable().optional(),
}).strict());
export type TeamDirectorySourcesListInputV1 = z.infer<typeof TeamDirectorySourcesListInputV1Schema>;

export const TeamDirectorySourceSetupListInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  limit: z.number().int().min(1).max(TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_MAX_V1).optional(),
  cursor: z.string().min(1).max(512).nullable().optional(),
  query: z.string().max(256).optional(),
}).strict());
export type TeamDirectorySourceSetupListInputV1 = z.infer<typeof TeamDirectorySourceSetupListInputV1Schema>;

export const TeamDirectorySourceRefInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  sourceId: DirectoryIdSchema,
}).strict());
export type TeamDirectorySourceRefInputV1 = z.infer<typeof TeamDirectorySourceRefInputV1Schema>;

const TeamDirectoryPageInputFieldsV1 = {
  v: z.literal(1),
  teamId: TeamIdSchema,
  sourceId: DirectoryIdSchema,
  limit: z.number().int().min(1).max(TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_MAX_V1).optional(),
  cursor: z.string().min(1).max(512).nullable().optional(),
} as const;

export const TeamDirectoryPeopleListInputV1Schema = lazyZodSchema(() => z.object(TeamDirectoryPageInputFieldsV1).strict());
export type TeamDirectoryPeopleListInputV1 = z.infer<typeof TeamDirectoryPeopleListInputV1Schema>;

export const TeamDirectoryGroupsListInputV1Schema = lazyZodSchema(() => z.object({
  ...TeamDirectoryPageInputFieldsV1,
  query: z.string().max(256).optional(),
}).strict());
export type TeamDirectoryGroupsListInputV1 = z.infer<typeof TeamDirectoryGroupsListInputV1Schema>;

const TeamDirectorySourceCreateBaseV1 = {
  v: z.literal(1),
  teamId: TeamIdSchema,
  displayName: DirectoryLabelSchema,
} as const;

export const TeamDirectorySourceCreateInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    ...TeamDirectorySourceCreateBaseV1,
    kind: z.literal('workos_directory'),
    teamIdentityConnectionId: DirectoryIdSchema,
    workosDirectoryId: DirectoryIdSchema,
  }).strict(),
  z.object({
    ...TeamDirectorySourceCreateBaseV1,
    kind: z.literal('github_organization'),
    githubAppInstallationId: DirectoryIdSchema,
  }).strict(),
]));
export type TeamDirectorySourceCreateInputV1 = z.infer<typeof TeamDirectorySourceCreateInputV1Schema>;

export const TeamDirectorySourceSyncResultV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  status: z.enum(['requested', 'coalesced']),
  source: TeamDirectorySourceSummaryV1Schema,
}).strict());
export type TeamDirectorySourceSyncResultV1 = z.infer<typeof TeamDirectorySourceSyncResultV1Schema>;

export const TeamDirectorySourceRemovalImpactV1Schema = lazyZodSchema(() => z.object({
  teamMembershipsRemoved: z.number().int().min(0),
  groupMembershipsRemoved: z.number().int().min(0),
  groupContributionsRemoved: z.number().int().min(0),
  directoryCreatedGroupsRetained: z.number().int().min(0),
  nativeMembershipsPreserved: z.number().int().min(0),
  nativeGroupContributionsPreserved: z.number().int().min(0),
}).strict());
export type TeamDirectorySourceRemovalImpactV1 = z.infer<typeof TeamDirectorySourceRemovalImpactV1Schema>;

export const TeamDirectorySourceRemovalPreflightV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  status: z.literal('allowed'),
  sourceId: DirectoryIdSchema,
  sourceLabel: DirectoryLabelSchema,
  impact: TeamDirectorySourceRemovalImpactV1Schema,
}).strict());
export type TeamDirectorySourceRemovalPreflightV1 = z.infer<typeof TeamDirectorySourceRemovalPreflightV1Schema>;

export const TeamDirectorySourceRemoveResultV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  status: z.enum(['removed', 'already_absent']),
  impact: TeamDirectorySourceRemovalImpactV1Schema,
}).strict());
export type TeamDirectorySourceRemoveResultV1 = z.infer<typeof TeamDirectorySourceRemoveResultV1Schema>;

/** HTTP path/query/body codecs consumed by the REST adapter for these Actions. */
export const TeamDirectoryTeamParamsV1Schema = lazyZodSchema(() => z.object({ teamId: TeamIdSchema }).strict());
export const TeamDirectorySourceParamsV1Schema = lazyZodSchema(() => z.object({
  teamId: TeamIdSchema,
  sourceId: DirectoryIdSchema,
}).strict());
export const TeamDirectorySourceListQueryV1Schema = lazyZodSchema(() => z.object({
  limit: z.coerce.number().int().min(1).max(TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_MAX_V1).optional(),
  cursor: z.string().min(1).max(512).optional(),
}).strict());
export const TeamDirectorySourceSetupListQueryV1Schema = lazyZodSchema(() => z.object({
  limit: z.coerce.number().int().min(1).max(TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_MAX_V1).optional(),
  cursor: z.string().min(1).max(512).optional(),
  query: z.string().max(256).optional(),
}).strict());
export const TeamDirectoryPeopleListQueryV1Schema = TeamDirectorySourceListQueryV1Schema;
export const TeamDirectoryGroupsListQueryV1Schema = lazyZodSchema(() => z.object({
  limit: z.coerce.number().int().min(1).max(TEAM_DIRECTORY_SOURCE_PAGE_LIMIT_MAX_V1).optional(),
  cursor: z.string().min(1).max(512).optional(),
  query: z.string().max(256).optional(),
}).strict());
export const TeamDirectorySourceCreateBodyV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    kind: z.literal('workos_directory'),
    displayName: DirectoryLabelSchema,
    teamIdentityConnectionId: DirectoryIdSchema,
    workosDirectoryId: DirectoryIdSchema,
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('github_organization'),
    displayName: DirectoryLabelSchema,
    githubAppInstallationId: DirectoryIdSchema,
  }).strict(),
]));
export const TeamDirectoryLifecycleBodyV1Schema = lazyZodSchema(() => z.object({ v: z.literal(1) }).strict());

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
} satisfies Record<TeamDirectoryActionIdV1, z.ZodTypeAny>);

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
} satisfies Record<TeamDirectoryActionIdV1, z.ZodTypeAny>);
