import type { z } from 'zod';

import type { TeamIdentityActionIdV1 } from '../../teams/actionsV1.js';
import type { TeamDirectoryActionIdV1 } from '../../teams/directory/v1.js';
import type { TeamExternalGroupBindingActionIdV1 } from '../../teams/externalGroupBindings/v1.js';
import {
  TEAM_EXTERNAL_GROUP_BINDING_ACTION_INPUT_SCHEMAS_V1,
  TEAM_EXTERNAL_GROUP_BINDING_ACTION_METHODS_V1,
  TEAM_EXTERNAL_GROUP_BINDING_ACTION_OUTPUT_SCHEMAS_V1,
  TEAM_EXTERNAL_GROUP_BINDING_ACTION_PATHS_V1,
} from '../../teams/externalGroupBindings/v1.js';
import {
  TEAM_DIRECTORY_ACTION_PATHS_V1,
  TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1,
  TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1,
} from '../../teams/directory/v1.js';
import {
  TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1,
  TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1,
  TEAM_IDENTITY_ACTION_PATHS_V1,
} from './teamsIdentity.js';
import {
  TeamGroupCreateInputV1Schema,
  TeamGroupMemberAddInputV1Schema,
  TeamGroupMemberMutationResultV1Schema,
  TeamGroupMemberRemoveInputV1Schema,
  TeamGroupMembersListInputV1Schema,
  TeamGroupMembersPageV1Schema,
  TeamGroupRefInputV1Schema,
  TeamGroupUpdateInputV1Schema,
  TeamGroupV1Schema,
  TeamGroupsListInputV1Schema,
  TeamGroupsPageV1Schema,
  TeamMemberGroupsListInputV1Schema,
} from '../../teams/group.js';
import {
  TeamInvitationAcceptInputV1Schema,
  TeamInvitationAcceptApprovalPrepareInputV1Schema,
  TeamInvitationAcceptApprovalPrepareResultV1Schema,
  TeamInvitationAcceptResultV1Schema,
  TeamInvitationCreateInputV1Schema,
  TeamInvitationCreateResultV1Schema,
  TeamInvitationListInputV1Schema,
  TeamInvitationPreviewInputV1Schema,
  TeamInvitationPreviewResultV1Schema,
  TeamInvitationReissueInputV1Schema,
  TeamInvitationReissueResultV1Schema,
  TeamInvitationRevokeInputV1Schema,
  TeamInvitationRevokeResultV1Schema,
  TeamInvitationsPageV1Schema,
} from '../../teams/invitation.js';
import { TeamLogoSetInputV1Schema } from '../../teams/logo.js';
import {
  TeamMemberAddInputV1Schema,
  TeamMemberManagementSetInputV1Schema,
  TeamMemberRefInputV1Schema,
  TeamMemberRemoveResultV1Schema,
  TeamMemberRoleSetInputV1Schema,
  TeamMembersListInputV1Schema,
  TeamMembersPageV1Schema,
  TeamMembershipV1Schema,
} from '../../teams/membership.js';
import {
  TeamSummaryV1Schema,
  TeamsListInputV1Schema,
  TeamsPageV1Schema,
} from '../../teams/projections.js';
import {
  TeamCreateInputV1Schema,
  TeamPolicySetInputV1Schema,
  TeamRefInputV1Schema,
  TeamUpdateInputV1Schema,
} from '../../teams/team.js';
import {
  TEAM_CREDENTIAL_ACTION_IDS_V1,
  TEAM_CREDENTIAL_HOME_ACTION_IDS_V1,
  TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1,
  TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1,
  TEAM_CREDENTIAL_ACTION_PATHS_V1,
  type TeamCredentialActionIdV1,
} from '../../teams/credentials/actionsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import {
  homeDomainActionRow,
  homeDomainApprovalField as approvalField,
  type HomeDomainActionRow,
} from './homeDomainRow.js';
import { redactObservationInputPaths } from './observationRedaction.js';

const TEAM_ID_FIELD = approvalField('teamId', 'Team ID', { required: true });
const MEMBERSHIP_ID_FIELD = approvalField('membershipId', 'Membership ID', { required: true });
const GROUP_ID_FIELD = approvalField('groupId', 'Group ID', { required: true });
const ACCOUNT_ID_FIELD = approvalField('accountId', 'Account ID', { required: true });
const INVITATION_ID_FIELD = approvalField('invitationId', 'Invitation ID', { required: true });

function projectTeamInvitationCreateObservation(output: unknown): unknown {
  const parsed = TeamInvitationCreateResultV1Schema.safeParse(output);
  return parsed.success
    ? { ...parsed.data, joinUrl: null }
    : { redacted: true };
}

function projectTeamInvitationReissueObservation(output: unknown): unknown {
  const parsed = TeamInvitationReissueResultV1Schema.safeParse(output);
  return parsed.success
    ? { ...parsed.data, joinUrl: null }
    : { redacted: true };
}

function projectTeamCredentialExternalApiKeyCreateObservation(output: unknown): unknown {
  const parsed = TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1['teams.credentials.externalKeys.create'].safeParse(output);
  return parsed.success ? { key: parsed.data.key } : { redacted: true };
}

type TeamProvisioningActionRowInput = Readonly<{
  id: TeamIdentityActionIdV1 | TeamDirectoryActionIdV1;
  title: string;
  description: string;
  safety: 'safe' | 'danger';
  sideEffectClass: 'read' | 'write' | 'external' | 'danger';
  cliPath: readonly string[];
  presentUser?: boolean;
  agent?: boolean;
  sdkMethod?: string;
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  method?: 'GET' | 'POST' | 'DELETE';
  path: string;
  projectObservationInput?: PreNormalizedActionSpec['projectObservationInput'];
  projectObservationOutput?: PreNormalizedActionSpec['projectObservationOutput'];
  approvalResultCustody?: PreNormalizedActionSpec['approvalResultCustody'];
}>;

type TeamProvisioningActionAuthority<
  TPresentUser extends boolean | undefined,
  TSideEffectClass extends TeamProvisioningActionRowInput['sideEffectClass'],
> = TPresentUser extends undefined
  ? TSideEffectClass extends 'read' ? 'account_automation' : 'present_user'
  : TPresentUser extends true ? 'present_user' : 'account_automation';

// Preserve each row's declared authority in the schema projection, including
// explicit automation mutations whose Agent surface is independently disabled.
function teamProvisioningActionRow<const TInput extends TeamProvisioningActionRowInput>(
  input: TInput,
): HomeDomainActionRow<
  TInput['id'],
  TInput['inputSchema'],
  TInput['outputSchema'],
  TeamProvisioningActionAuthority<
    'presentUser' extends keyof TInput ? TInput['presentUser'] : undefined,
    TInput['sideEffectClass']
  >
>;
function teamProvisioningActionRow<const TInput extends TeamProvisioningActionRowInput>(
  input: TInput,
): HomeDomainActionRow<TInput['id'], TInput['inputSchema'], TInput['outputSchema'], 'account_automation' | 'present_user'> {
  const row = homeDomainActionRow(input);
  const presentUser = input.presentUser ?? input.sideEffectClass !== 'read';
  if (!presentUser) return row;
  return {
    ...row,
    requiredAuthority: 'present_user' as const,
    surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: true, rpc: false } as const,
  };
}

function teamExternalGroupBindingActionRow<
  const TActionId extends TeamExternalGroupBindingActionIdV1,
  const TInputSchema extends z.ZodTypeAny,
  const TOutputSchema extends z.ZodTypeAny,
>(input: Readonly<{
  id: TActionId;
  title: string;
  description: string;
  safety: 'safe' | 'danger';
  sideEffectClass: 'read' | 'danger';
  cliPath: readonly string[];
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  method: 'GET' | 'PUT' | 'DELETE';
  path: string;
}>): HomeDomainActionRow<TActionId, TInputSchema, TOutputSchema> {
  return homeDomainActionRow(input);
}

function teamCredentialActionRow<TActionId extends TeamCredentialActionIdV1>(input: Readonly<{
  id: TActionId;
  title: string;
  description: string;
  safety: 'safe' | 'danger';
  sideEffectClass: 'read' | 'write' | 'external' | 'danger';
  cliPath: readonly string[];
  path: string;
}>) {
  const row = homeDomainActionRow({
    ...input,
    inputSchema: TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1[input.id],
    outputSchema: TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1[input.id],
  });
  if (input.id === 'teams.credentials.externalKeys.create') {
    return {
      ...row,
      projectObservationOutput: projectTeamCredentialExternalApiKeyCreateObservation,
      approvalResultCustody: 'live_only' as const,
    };
  }
  return input.id === 'teams.credentials.test'
    ? { ...row, surfaces: { ...row.surfaces, agent: false, mcp: false } as const }
    : row;
}

/**
 * Team rows. Every one of them is served behind the single `teams` feature gate
 * at its Home route; the row itself declares intent, transport and codecs and
 * makes no availability decision of its own.
 *
 * Membership, Group and admission changes are `danger`: each one changes who can
 * reach Team work. Metadata and logo edits are ordinary writes. Mutations answer
 * with the row the viewer now sees, except removals, whose results must keep an
 * idempotent `unchanged` — and a surviving directory contribution — visible.
 *
 * Invitation preview and accept live under the public `/v1/team-invitations`
 * prefix because preview is the pre-authentication transport of the same owner.
 */
export const TEAM_ACTION_SPECS = Object.freeze([
  ...TEAM_CREDENTIAL_HOME_ACTION_IDS_V1.map((id) => teamCredentialActionRow({
    id,
    title: {
      'teams.credentials.list': 'List Team credentials',
      'teams.credentials.sources.list': 'List offerable credential sources',
      'teams.credentials.requestPolicySupport.get': 'Get Team credential request-policy support',
      'teams.credentials.sourceResources.list': 'List resources for one owned credential source',
      'teams.credentials.get': 'Get Team credential',
      'teams.credentials.entitled.list': 'List entitled Team credentials',
      'teams.credentials.create': 'Create Team credential',
      'teams.credentials.update': 'Update Team credential',
      'teams.credentials.audience.set': 'Update Team credential audience',
      'teams.credentials.delete': 'Delete Team credential',
      'teams.credentials.test': 'Test Team credential',
      'teams.credentials.activity.list': 'List Team credential activity',
      'teams.credentials.limits.list': 'List Team credential limits',
      'teams.credentials.limits.upsert': 'Set Team credential limit',
      'teams.credentials.limits.delete': 'Delete Team credential limit',
      'teams.credentials.usage.query': 'Query Team credential usage',
      'teams.credentials.externalKeys.create': 'Create external API key',
      'teams.credentials.externalKeys.authorize': 'Authorize external API key',
      'teams.credentials.externalKeys.list': 'List external API keys',
      'teams.credentials.externalKeys.revoke': 'Revoke external API key',
      'teams.credentials.externalKeys.revokeAll': 'Revoke all external API keys',
    }[id],
    description: {
      'teams.credentials.list': 'List credential resources visible to the authenticated Team member.',
      'teams.credentials.sources.list': 'List the sources the authenticated Account may offer to a Team, with their pinned lifetimes.',
      'teams.credentials.requestPolicySupport.get': 'Read value-free request-policy support for one owned source or managed resource.',
      'teams.credentials.sourceResources.list': 'List safe administration rows backed by one exact source owned by the authenticated Account.',
      'teams.credentials.get': 'Read one Team credential resource visible to a qualified Team credential manager.',
      'teams.credentials.entitled.list': 'List recipient-safe Team credential resources available to the authenticated Team member.',
      'teams.credentials.create': 'Offer an owned credential source to a Team.',
      'teams.credentials.update': 'Update a Team credential resource policy.',
      'teams.credentials.audience.set': 'Set the Team credential audience and delivery modes.',
      'teams.credentials.delete': 'Remove a Team credential resource.',
      'teams.credentials.test': 'Test a saved Team credential through its production broker and Provider path.',
      'teams.credentials.activity.list': 'Read administrative activity for a visible Team credential resource.',
      'teams.credentials.limits.list': 'List usage limits for a visible Team credential resource.',
      'teams.credentials.limits.upsert': 'Set a usage limit for a Team credential resource.',
      'teams.credentials.limits.delete': 'Delete a usage limit for a Team credential resource.',
      'teams.credentials.usage.query': 'Query usage for a visible Team credential resource.',
      'teams.credentials.externalKeys.create': 'Create a one-time-reveal external API key for a Team credential resource.',
      'teams.credentials.externalKeys.authorize': 'Authorize your assigned external API key using your current Team authentication.',
      'teams.credentials.externalKeys.list': 'List safe external API key metadata for a Team credential resource.',
      'teams.credentials.externalKeys.revoke': 'Revoke one external API key for a Team credential resource.',
      'teams.credentials.externalKeys.revokeAll': 'Revoke every external API key for a Team credential resource.',
    }[id],
    safety: id === 'teams.credentials.list'
      || id === 'teams.credentials.sources.list'
      || id === 'teams.credentials.requestPolicySupport.get'
      || id === 'teams.credentials.sourceResources.list'
      || id === 'teams.credentials.get'
      || id === 'teams.credentials.entitled.list'
      || id === 'teams.credentials.activity.list'
      || id === 'teams.credentials.limits.list'
      || id === 'teams.credentials.usage.query'
      || id === 'teams.credentials.externalKeys.list' ? 'safe' : 'danger',
    sideEffectClass: id === 'teams.credentials.test' ? 'external' : id === 'teams.credentials.list'
      || id === 'teams.credentials.sources.list'
      || id === 'teams.credentials.requestPolicySupport.get'
      || id === 'teams.credentials.sourceResources.list'
      || id === 'teams.credentials.get'
      || id === 'teams.credentials.entitled.list'
      || id === 'teams.credentials.activity.list'
      || id === 'teams.credentials.limits.list'
      || id === 'teams.credentials.usage.query'
      || id === 'teams.credentials.externalKeys.list' ? 'read' : 'danger',
    cliPath: id.split('.').slice(1).map((segment) =>
      segment.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    ),
    path: TEAM_CREDENTIAL_ACTION_PATHS_V1[id],
  })),
  homeDomainActionRow({
    id: 'teams.list',
    title: 'List Teams',
    description: 'Page through the Teams visible in this Home for the authenticated Account.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'list'],
    path: '/v1/teams/list',
    inputSchema: TeamsListInputV1Schema,
    outputSchema: TeamsPageV1Schema,
    inputHints: { fields: [
      approvalField('scope', 'Scope', { required: true }),
      approvalField('archived', 'Team state', { required: true }),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.get',
    title: 'Get Team',
    description: 'Read one Team as the authenticated Account sees it.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'get'],
    path: '/v1/teams/get',
    inputSchema: TeamRefInputV1Schema,
    outputSchema: TeamSummaryV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.create',
    title: 'Create Team',
    description: 'Create a Team in this Home. A repeated request key returns the same Team rather than a second one.',
    safety: 'safe',
    sideEffectClass: 'write',
    cliPath: ['teams', 'create'],
    path: '/v1/teams/create',
    inputSchema: TeamCreateInputV1Schema,
    outputSchema: TeamSummaryV1Schema,
    inputHints: { fields: [
      approvalField('name', 'Team name', { required: true }),
      approvalField('description', 'Description', { widget: 'textarea' }),
      approvalField('initialOwnerAccountId', 'Initial owner Account ID'),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.update',
    title: 'Update Team',
    description: 'Change a Team\'s name or description.',
    safety: 'safe',
    sideEffectClass: 'write',
    cliPath: ['teams', 'update'],
    path: '/v1/teams/update',
    inputSchema: TeamUpdateInputV1Schema,
    outputSchema: TeamSummaryV1Schema,
    inputHints: { fields: [
      TEAM_ID_FIELD,
      approvalField('name', 'Team name'),
      approvalField('description', 'Description', { widget: 'textarea' }),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.logo.set',
    title: 'Set Team logo',
    description: 'Replace a Team\'s logo through the shared managed-image owner.',
    safety: 'safe',
    sideEffectClass: 'write',
    cliPath: ['teams', 'logo', 'set'],
    path: '/v1/teams/logo/set',
    inputSchema: TeamLogoSetInputV1Schema,
    outputSchema: TeamSummaryV1Schema,
    inputHints: { fields: [
      TEAM_ID_FIELD,
      approvalField('image.mimeType', 'Image type', { required: true }),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.logo.remove',
    title: 'Remove Team logo',
    description: 'Drop a Team\'s logo and fall back to its monogram.',
    safety: 'safe',
    sideEffectClass: 'write',
    cliPath: ['teams', 'logo', 'remove'],
    path: '/v1/teams/logo/remove',
    inputSchema: TeamRefInputV1Schema,
    outputSchema: TeamSummaryV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.policy.set',
    title: 'Set Team policy',
    description: 'Change a Team\'s Session, sharing, history and admission policy. These decide who may reach Team work.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'policy', 'set'],
    path: '/v1/teams/policy/set',
    inputSchema: TeamPolicySetInputV1Schema,
    outputSchema: TeamSummaryV1Schema,
    inputHints: { fields: [
      TEAM_ID_FIELD,
      approvalField('sessionCreationPolicy', 'Session creation policy'),
      approvalField('externalSharingPolicy', 'External sharing policy'),
      approvalField('defaultSessionHistoryAccess', 'Default history access'),
      approvalField('admissionMode', 'Admission mode'),
      approvalField('authenticationPolicy.mode', 'Authentication policy'),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.archive',
    title: 'Archive Team',
    description: 'Archive a Team, ending ordinary member access to its work until it is restored.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'archive'],
    path: '/v1/teams/archive',
    inputSchema: TeamRefInputV1Schema,
    outputSchema: TeamSummaryV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.restore',
    title: 'Restore Team',
    description: 'Restore an archived Team and its members\' access.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'restore'],
    path: '/v1/teams/restore',
    inputSchema: TeamRefInputV1Schema,
    outputSchema: TeamSummaryV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.members.list',
    title: 'List Team members',
    description: 'Page through a Team roster with the viewer\'s per-member capabilities.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'members', 'list'],
    path: '/v1/teams/members/list',
    inputSchema: TeamMembersListInputV1Schema,
    outputSchema: TeamMembersPageV1Schema,
    inputHints: { fields: [
      TEAM_ID_FIELD,
      approvalField('filter', 'Member filter', { required: true }),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.members.get',
    title: 'Get Team member',
    description: 'Read one membership lifetime and what the viewer may do to it.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'members', 'get'],
    path: '/v1/teams/members/get',
    inputSchema: TeamMemberRefInputV1Schema,
    outputSchema: TeamMembershipV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD, MEMBERSHIP_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.members.add',
    title: 'Add Team member',
    description: 'Admit an existing Home Account to a Team with an explicit role and history horizon.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'members', 'add'],
    path: '/v1/teams/members/add',
    inputSchema: TeamMemberAddInputV1Schema,
    outputSchema: TeamMembershipV1Schema,
    inputHints: { fields: [
      TEAM_ID_FIELD,
      ACCOUNT_ID_FIELD,
      approvalField('role', 'Team role', { required: true }),
      approvalField('historyAccess', 'History access', { required: true }),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.members.role.set',
    title: 'Set Team member role',
    description: 'Change one member\'s Team role. The Team refuses to strand its final active owner.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'members', 'role', 'set'],
    path: '/v1/teams/members/role/set',
    inputSchema: TeamMemberRoleSetInputV1Schema,
    outputSchema: TeamMembershipV1Schema,
    inputHints: { fields: [
      TEAM_ID_FIELD,
      MEMBERSHIP_ID_FIELD,
      approvalField('role', 'Team role', { required: true }),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.members.suspend',
    title: 'Suspend Team member',
    description: 'Suspend one membership, ending its access while preserving the lifetime.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'members', 'suspend'],
    path: '/v1/teams/members/suspend',
    inputSchema: TeamMemberRefInputV1Schema,
    outputSchema: TeamMembershipV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD, MEMBERSHIP_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.members.reactivate',
    title: 'Reactivate Team member',
    description: 'Lift a suspension and restore that membership\'s access.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'members', 'reactivate'],
    path: '/v1/teams/members/reactivate',
    inputSchema: TeamMemberRefInputV1Schema,
    outputSchema: TeamMembershipV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD, MEMBERSHIP_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.members.remove',
    title: 'Remove Team member',
    description: 'End one membership lifetime. Repeating the request answers unchanged rather than failing.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'members', 'remove'],
    path: '/v1/teams/members/remove',
    inputSchema: TeamMemberRefInputV1Schema,
    outputSchema: TeamMemberRemoveResultV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD, MEMBERSHIP_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.members.leave',
    title: 'Leave Team',
    description: 'End your own membership lifetime. Directory-managed members and the final active owner of a live Team cannot leave.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'members', 'leave'],
    path: '/v1/teams/members/leave',
    inputSchema: TeamRefInputV1Schema,
    outputSchema: TeamMemberRemoveResultV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.members.management.set',
    title: 'Set Team member management',
    description: 'Convert who owns one membership\'s lifecycle while preserving its lifetime, role, status and horizon.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'members', 'management', 'set'],
    path: '/v1/teams/members/management/set',
    inputSchema: TeamMemberManagementSetInputV1Schema,
    outputSchema: TeamMembershipV1Schema,
    inputHints: { description: 'Choose whether a Team member is managed by hand or by your directory. Their role and access stay the same.', fields: [
      TEAM_ID_FIELD,
      MEMBERSHIP_ID_FIELD,
      approvalField('management.kind', 'Management owner', { required: true }),
      approvalField('management.directorySourceId', 'Directory source ID'),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.members.groups.list',
    title: 'List a Team member\'s Groups',
    description: 'Page through the Groups one membership lifetime is effectively in.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'members', 'groups', 'list'],
    path: '/v1/teams/members/groups/list',
    inputSchema: TeamMemberGroupsListInputV1Schema,
    outputSchema: TeamGroupsPageV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD, MEMBERSHIP_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.groups.list',
    title: 'List Team Groups',
    description: 'Page through a Team\'s Groups.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'groups', 'list'],
    path: '/v1/teams/groups/list',
    inputSchema: TeamGroupsListInputV1Schema,
    outputSchema: TeamGroupsPageV1Schema,
    inputHints: { fields: [
      TEAM_ID_FIELD,
      approvalField('archived', 'Group state', { required: true }),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.groups.get',
    title: 'Get Team Group',
    description: 'Read one Group on direct reload or deep link.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'groups', 'get'],
    path: '/v1/teams/groups/get',
    inputSchema: TeamGroupRefInputV1Schema,
    outputSchema: TeamGroupV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD, GROUP_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.groups.create',
    title: 'Create Team Group',
    description: 'Create a Group in a Team. A repeated request key returns the same Group.',
    safety: 'safe',
    sideEffectClass: 'write',
    cliPath: ['teams', 'groups', 'create'],
    path: '/v1/teams/groups/create',
    inputSchema: TeamGroupCreateInputV1Schema,
    outputSchema: TeamGroupV1Schema,
    inputHints: { fields: [
      TEAM_ID_FIELD,
      approvalField('name', 'Group name', { required: true }),
      approvalField('description', 'Description', { widget: 'textarea' }),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.groups.update',
    title: 'Update Team Group',
    description: 'Change a Group\'s name or description.',
    safety: 'safe',
    sideEffectClass: 'write',
    cliPath: ['teams', 'groups', 'update'],
    path: '/v1/teams/groups/update',
    inputSchema: TeamGroupUpdateInputV1Schema,
    outputSchema: TeamGroupV1Schema,
    inputHints: { fields: [
      TEAM_ID_FIELD,
      GROUP_ID_FIELD,
      approvalField('name', 'Group name'),
      approvalField('description', 'Description', { widget: 'textarea' }),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.groups.archive',
    title: 'Archive Team Group',
    description: 'Archive a Group, ending the access its membership conferred.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'groups', 'archive'],
    path: '/v1/teams/groups/archive',
    inputSchema: TeamGroupRefInputV1Schema,
    outputSchema: TeamGroupV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD, GROUP_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.groups.restore',
    title: 'Restore Team Group',
    description: 'Restore an archived Group and the access its membership confers.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'groups', 'restore'],
    path: '/v1/teams/groups/restore',
    inputSchema: TeamGroupRefInputV1Schema,
    outputSchema: TeamGroupV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD, GROUP_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.groups.members.list',
    title: 'List Team Group members',
    description: 'Page through a Group\'s members and where each contribution comes from.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'groups', 'members', 'list'],
    path: '/v1/teams/groups/members/list',
    inputSchema: TeamGroupMembersListInputV1Schema,
    outputSchema: TeamGroupMembersPageV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD, GROUP_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.groups.members.add',
    title: 'Add Team Group member',
    description: 'Add a native Group contribution for one Team member.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'groups', 'members', 'add'],
    path: '/v1/teams/groups/members/add',
    inputSchema: TeamGroupMemberAddInputV1Schema,
    outputSchema: TeamGroupMemberMutationResultV1Schema,
    inputHints: { fields: [
      TEAM_ID_FIELD,
      GROUP_ID_FIELD,
      ACCOUNT_ID_FIELD,
      approvalField('historyAccess', 'History access', { required: true }),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.groups.members.remove',
    title: 'Remove Team Group member',
    description: 'Clear the native Group contribution. A surviving directory contribution is reported truthfully.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'groups', 'members', 'remove'],
    path: '/v1/teams/groups/members/remove',
    inputSchema: TeamGroupMemberRemoveInputV1Schema,
    outputSchema: TeamGroupMemberMutationResultV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD, GROUP_ID_FIELD, ACCOUNT_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.invitations.list',
    title: 'List Team invitations',
    description: 'Page through a Team\'s invitations. The bearer is never republished here.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'invitations', 'list'],
    path: '/v1/teams/invitations/list',
    inputSchema: TeamInvitationListInputV1Schema,
    outputSchema: TeamInvitationsPageV1Schema,
    inputHints: { fields: [
      TEAM_ID_FIELD,
      approvalField('state', 'Invitation state'),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.invitations.create',
    title: 'Invite to Team',
    description: 'Create a Team invitation. Accepting it admits a person to Team work.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'invitations', 'create'],
    path: '/v1/teams/invitations/create',
    inputSchema: TeamInvitationCreateInputV1Schema,
    outputSchema: TeamInvitationCreateResultV1Schema,
    inputHints: { fields: [
      TEAM_ID_FIELD,
      approvalField('recipientEmail', 'Recipient email'),
      approvalField('role', 'Team role', { required: true }),
      approvalField('historyAccess', 'History access', { required: true }),
    ] },
    // The direct human/API/plugin caller receives the one-time bearer. Shared
    // execution observers retain useful metadata but never receive it, and an
    // autonomous Agent cannot invoke this result-bearing Action directly.
    agent: false,
    projectObservationOutput: projectTeamInvitationCreateObservation,
    approvalResultCustody: 'live_only',
  }),
  homeDomainActionRow({
    id: 'teams.invitations.revoke',
    title: 'Revoke Team invitation',
    description: 'Stop an outstanding invitation from admitting anyone. A repeated revocation reports the current row.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'invitations', 'revoke'],
    path: '/v1/teams/invitations/revoke',
    inputSchema: TeamInvitationRevokeInputV1Schema,
    outputSchema: TeamInvitationRevokeResultV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD, INVITATION_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.invitations.reissue',
    title: 'Reissue Team invitation',
    description: 'Retire the current bearer and issue a fresh invitation carrying the same role and history intent.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'invitations', 'reissue'],
    path: '/v1/teams/invitations/reissue',
    inputSchema: TeamInvitationReissueInputV1Schema,
    outputSchema: TeamInvitationReissueResultV1Schema,
    inputHints: { fields: [
      TEAM_ID_FIELD,
      INVITATION_ID_FIELD,
      approvalField('recipientEmail', 'Recipient email'),
    ] },
    agent: false,
    projectObservationOutput: projectTeamInvitationReissueObservation,
    approvalResultCustody: 'live_only',
  }),
  homeDomainActionRow({
    id: 'teams.invitations.preview',
    title: 'Preview Team invitation',
    description: 'Read the bounded public preview for an invitation bearer.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'invitations', 'preview'],
    path: '/v1/team-invitations/preview',
    inputSchema: TeamInvitationPreviewInputV1Schema,
    outputSchema: TeamInvitationPreviewResultV1Schema,
    projectObservationInput: redactObservationInputPaths('token'),
  }),
  {
    id: 'teams.invitations.accept.prepareApproval',
    title: 'Prepare Team invitation approval',
    description: 'Exchange an invitation bearer for Account-bound deferred-approval custody.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    placements: [],
    surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: false, rpc: false },
    sideEffectClass: 'write',
    inputHints: { fields: [] },
    inputSchema: TeamInvitationAcceptApprovalPrepareInputV1Schema,
    outputSchema: TeamInvitationAcceptApprovalPrepareResultV1Schema,
    projectObservationInput: redactObservationInputPaths('token'),
    serverTransport: { method: 'POST', path: '/v1/team-invitations/accept/prepare-approval' },
  },
  homeDomainActionRow({
    id: 'teams.invitations.accept',
    title: 'Accept Team invitation',
    description: 'Redeem an invitation bearer and join the Team as the authenticated Account.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'invitations', 'accept'],
    path: '/v1/team-invitations/accept',
    inputSchema: TeamInvitationAcceptInputV1Schema,
    outputSchema: TeamInvitationAcceptResultV1Schema,
    inputHints: { fields: [
      approvalField('homeServerId', 'Home ID'),
      approvalField('continuation.teamId', 'Team ID', { required: true }),
      approvalField('teamName', 'Team name'),
      approvalField('role', 'Team role'),
      approvalField('historyAccess', 'History access'),
      approvalField('state', 'Invitation state'),
      approvalField('expiresAt', 'Expires at'),
      approvalField('recipientEmailMask', 'Recipient'),
    ] },
    projectObservationInput: redactObservationInputPaths('token', 'continuation.reference'),
  }),
  teamProvisioningActionRow({
    id: 'teams.identity.connections.list',
    path: TEAM_IDENTITY_ACTION_PATHS_V1['teams.identity.connections.list'],
    inputSchema: TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.list'],
    outputSchema: TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.list'],
    title: 'List Team identity connections',
    description: 'List the identity connections configured for one Team.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'identity', 'connections', 'list'],
  }),
  teamProvisioningActionRow({
    id: 'teams.identity.connections.create',
    path: TEAM_IDENTITY_ACTION_PATHS_V1['teams.identity.connections.create'],
    inputSchema: TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.create'],
    outputSchema: TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.create'],
    title: 'Create Team identity connection',
    description: 'Bind one managed identity provider instance to a Team.',
    safety: 'safe',
    sideEffectClass: 'write',
    cliPath: ['teams', 'identity', 'connections', 'create'],
  }),
  teamProvisioningActionRow({
    id: 'teams.identity.connections.settings.update',
    path: TEAM_IDENTITY_ACTION_PATHS_V1['teams.identity.connections.settings.update'],
    inputSchema: TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.settings.update'],
    outputSchema: TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.settings.update'],
    title: 'Update Team identity connection settings',
    description: 'Update sign-in restrictions and Group mapping settings for one Team identity connection.',
    safety: 'safe',
    sideEffectClass: 'write',
    cliPath: ['teams', 'identity', 'connections', 'settings', 'update'],
  }),
  teamProvisioningActionRow({
    id: 'teams.identity.connections.enable',
    path: TEAM_IDENTITY_ACTION_PATHS_V1['teams.identity.connections.enable'],
    inputSchema: TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.enable'],
    outputSchema: TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.enable'],
    title: 'Enable Team identity connection',
    description: 'Enable a configured Team identity connection for current policy decisions.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'identity', 'connections', 'enable'],
  }),
  teamProvisioningActionRow({
    id: 'teams.identity.connections.disable',
    path: TEAM_IDENTITY_ACTION_PATHS_V1['teams.identity.connections.disable'],
    inputSchema: TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.disable'],
    outputSchema: TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.disable'],
    title: 'Disable Team identity connection',
    description: 'Stop a Team identity connection from admitting new sign-ins.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'identity', 'connections', 'disable'],
  }),
  teamProvisioningActionRow({
    id: 'teams.identity.connections.remove.preview',
    path: TEAM_IDENTITY_ACTION_PATHS_V1['teams.identity.connections.remove.preview'],
    inputSchema: TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.remove.preview'],
    outputSchema: TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.remove.preview'],
    title: 'Preview Team identity connection removal',
    description: 'Read current bounded blockers and impact before removing a Team identity connection.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'identity', 'connections', 'remove', 'preview'],
  }),
  teamProvisioningActionRow({
    id: 'teams.identity.connections.remove',
    path: TEAM_IDENTITY_ACTION_PATHS_V1['teams.identity.connections.remove'],
    inputSchema: TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.remove'],
    outputSchema: TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.remove'],
    title: 'Remove Team identity connection',
    description: 'Remove a Team identity binding after its current impact is accepted.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'identity', 'connections', 'remove'],
    sdkMethod: 'teams.identity.connections.remove.execute',
  }),
  teamProvisioningActionRow({
    id: 'teams.identity.connections.test.start',
    path: TEAM_IDENTITY_ACTION_PATHS_V1['teams.identity.connections.test.start'],
    presentUser: false,
    inputSchema: TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.test.start'],
    outputSchema: TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.test.start'],
    title: 'Test Team identity connection',
    description: 'Start a non-mutating browser sign-in test for an exact Team identity connection.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'identity', 'connections', 'test', 'start'],
    projectObservationOutput: () => ({ redacted: true }),
  }),
  teamProvisioningActionRow({
    id: 'teams.identity.connections.test.consume',
    path: TEAM_IDENTITY_ACTION_PATHS_V1['teams.identity.connections.test.consume'],
    presentUser: false,
    inputSchema: TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.test.consume'],
    outputSchema: TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.test.consume'],
    title: 'Finish Team identity connection test',
    description: 'Consume the initiating user\'s one-time test result and record the successful observation.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'identity', 'connections', 'test', 'consume'],
    projectObservationInput: redactObservationInputPaths('resultHandle'),
  }),
  teamProvisioningActionRow({
    id: 'teams.identity.workos.connection.create',
    path: TEAM_IDENTITY_ACTION_PATHS_V1['teams.identity.workos.connection.create'],
    inputSchema: TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.workos.connection.create'],
    outputSchema: TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.workos.connection.create'],
    title: 'Create WorkOS connection',
    description: 'Create or reuse one Team-owned WorkOS provider and its draft identity connection.',
    safety: 'safe',
    sideEffectClass: 'write',
    cliPath: ['teams', 'identity', 'workos', 'connection', 'create'],
  }),
  teamProvisioningActionRow({
    id: 'teams.identity.workos.adminPortalLink.create',
    path: TEAM_IDENTITY_ACTION_PATHS_V1['teams.identity.workos.adminPortalLink.create'],
    presentUser: false,
    inputSchema: TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.workos.adminPortalLink.create'],
    outputSchema: TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.workos.adminPortalLink.create'],
    title: 'Open WorkOS Admin Portal',
    description: 'Create a short-lived WorkOS Admin Portal link for one Team connection.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'identity', 'workos', 'admin-portal-link', 'create'],
    projectObservationOutput: () => ({ redacted: true }),
    // The Portal URL is a short-lived bearer for full external SSO/Directory
    // administration of the organization. It stays on the invocation that
    // asked for it and never becomes durable Artifact result state.
    approvalResultCustody: 'live_only',
  }),
  teamProvisioningActionRow({
    id: 'teams.identity.workos.reconcile',
    path: TEAM_IDENTITY_ACTION_PATHS_V1['teams.identity.workos.reconcile'],
    inputSchema: TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.workos.reconcile'],
    outputSchema: TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.workos.reconcile'],
    title: 'Reconcile WorkOS connection',
    description: 'Refresh the exact Team connection from its WorkOS organization.',
    safety: 'safe',
    sideEffectClass: 'write',
    cliPath: ['teams', 'identity', 'workos', 'reconcile'],
  }),
  teamProvisioningActionRow({
    id: 'teams.identity.workos.connection.set',
    path: TEAM_IDENTITY_ACTION_PATHS_V1['teams.identity.workos.connection.set'],
    inputSchema: TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.workos.connection.set'],
    outputSchema: TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.workos.connection.set'],
    title: 'Select WorkOS connection',
    description: 'Select one verified WorkOS SSO connection for a Team binding.',
    safety: 'safe',
    sideEffectClass: 'write',
    cliPath: ['teams', 'identity', 'workos', 'connection', 'set'],
  }),
  teamExternalGroupBindingActionRow({
    id: 'teams.externalGroupBindings.list',
    method: TEAM_EXTERNAL_GROUP_BINDING_ACTION_METHODS_V1['teams.externalGroupBindings.list'],
    path: TEAM_EXTERNAL_GROUP_BINDING_ACTION_PATHS_V1['teams.externalGroupBindings.list'],
    inputSchema: TEAM_EXTERNAL_GROUP_BINDING_ACTION_INPUT_SCHEMAS_V1['teams.externalGroupBindings.list'],
    outputSchema: TEAM_EXTERNAL_GROUP_BINDING_ACTION_OUTPUT_SCHEMAS_V1['teams.externalGroupBindings.list'],
    title: 'List external Group mappings',
    description: 'Page through the external Group mappings for one exact Team source.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'external-group-bindings', 'list'],
  }),
  teamExternalGroupBindingActionRow({
    id: 'teams.externalGroupBindings.set',
    method: TEAM_EXTERNAL_GROUP_BINDING_ACTION_METHODS_V1['teams.externalGroupBindings.set'],
    path: TEAM_EXTERNAL_GROUP_BINDING_ACTION_PATHS_V1['teams.externalGroupBindings.set'],
    inputSchema: TEAM_EXTERNAL_GROUP_BINDING_ACTION_INPUT_SCHEMAS_V1['teams.externalGroupBindings.set'],
    outputSchema: TEAM_EXTERNAL_GROUP_BINDING_ACTION_OUTPUT_SCHEMAS_V1['teams.externalGroupBindings.set'],
    title: 'Set external Group mapping',
    description: 'Map one exact external Group into a directory-created or selected native Team Group.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'external-group-bindings', 'set'],
  }),
  teamExternalGroupBindingActionRow({
    id: 'teams.externalGroupBindings.remove',
    method: TEAM_EXTERNAL_GROUP_BINDING_ACTION_METHODS_V1['teams.externalGroupBindings.remove'],
    path: TEAM_EXTERNAL_GROUP_BINDING_ACTION_PATHS_V1['teams.externalGroupBindings.remove'],
    inputSchema: TEAM_EXTERNAL_GROUP_BINDING_ACTION_INPUT_SCHEMAS_V1['teams.externalGroupBindings.remove'],
    outputSchema: TEAM_EXTERNAL_GROUP_BINDING_ACTION_OUTPUT_SCHEMAS_V1['teams.externalGroupBindings.remove'],
    title: 'Remove external Group mapping',
    description: 'Remove one exact external Group contribution while preserving native and other-source facts.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'external-group-bindings', 'remove'],
  }),
  teamProvisioningActionRow({
    id: 'teams.directory.sourceSetup.list',
    method: 'GET',
    path: TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.sourceSetup.list'],
    inputSchema: TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sourceSetup.list'],
    outputSchema: TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sourceSetup.list'],
    title: 'List Team directory source setup options',
    description: 'List exact verified WorkOS directories and GitHub organization installations eligible for one Team.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'directory', 'source-setup', 'list'],
  }),
  teamProvisioningActionRow({
    id: 'teams.directory.sources.list',
    method: 'GET',
    path: TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.sources.list'],
    inputSchema: TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.list'],
    outputSchema: TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.list'],
    title: 'List Team directory sources',
    description: 'Page through directory sources configured for one Team.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'directory', 'sources', 'list'],
  }),
  teamProvisioningActionRow({
    id: 'teams.directory.sources.get',
    method: 'GET',
    path: TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.sources.get'],
    inputSchema: TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.get'],
    outputSchema: TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.get'],
    title: 'Get Team directory source',
    description: 'Read one directory source and its server-derived sync state.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'directory', 'sources', 'get'],
  }),
  teamProvisioningActionRow({
    id: 'teams.directory.people.list',
    method: 'GET',
    path: TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.people.list'],
    inputSchema: TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.people.list'],
    outputSchema: TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.people.list'],
    title: 'List Team directory people',
    description: 'Page through the safe people projection for one directory source.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'directory', 'people', 'list'],
  }),
  teamProvisioningActionRow({
    id: 'teams.directory.groups.list',
    method: 'GET',
    path: TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.groups.list'],
    inputSchema: TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.groups.list'],
    outputSchema: TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.groups.list'],
    title: 'List Team directory Groups',
    description: 'Search and page through external Groups for one directory source.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'directory', 'groups', 'list'],
  }),
  teamProvisioningActionRow({
    id: 'teams.directory.sources.create',
    method: 'POST',
    path: TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.sources.create'],
    inputSchema: TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.create'],
    outputSchema: TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.create'],
    title: 'Create Team directory source',
    description: 'Configure one exact verified WorkOS directory or GitHub organization source.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'directory', 'sources', 'create'],
  }),
  teamProvisioningActionRow({
    id: 'teams.directory.sources.sync',
    method: 'POST',
    path: TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.sources.sync'],
    inputSchema: TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.sync'],
    outputSchema: TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.sync'],
    title: 'Sync Team directory source',
    description: 'Request or coalesce reconciliation that may change source-owned Team access.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'directory', 'sources', 'sync'],
  }),
  teamProvisioningActionRow({
    id: 'teams.directory.sources.pause',
    method: 'POST',
    path: TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.sources.pause'],
    inputSchema: TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.pause'],
    outputSchema: TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.pause'],
    title: 'Pause Team directory source',
    description: 'Pause observation while preserving the source\'s committed Team access.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'directory', 'sources', 'pause'],
  }),
  teamProvisioningActionRow({
    id: 'teams.directory.sources.resume',
    method: 'POST',
    path: TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.sources.resume'],
    inputSchema: TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.resume'],
    outputSchema: TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.resume'],
    title: 'Resume Team directory source',
    description: 'Resume a directory source through a complete repair reconciliation.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'directory', 'sources', 'resume'],
  }),
  teamProvisioningActionRow({
    id: 'teams.directory.sources.remove.preview',
    method: 'GET',
    path: TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.sources.remove.preview'],
    inputSchema: TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.remove.preview'],
    outputSchema: TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.remove.preview'],
    title: 'Preview Team directory source removal',
    description: 'Read current bounded impact before removing a Team directory source.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'directory', 'sources', 'remove', 'preview'],
  }),
  teamProvisioningActionRow({
    id: 'teams.directory.sources.remove',
    method: 'DELETE',
    path: TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.sources.remove'],
    inputSchema: TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.remove'],
    outputSchema: TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.remove'],
    title: 'Remove Team directory source',
    description: 'Atomically revoke this source\'s native facts and remove its stored projection.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'directory', 'sources', 'remove'],
    // This exact mutation is an approved public SDK operation. The Team route
    // remains the authorization/currentness owner and the shared dangerous
    // Action policy still routes API/plugin calls through configurable approval.
    // Keep autonomous Agent/MCP discovery closed; this does not widen the rest
    // of the directory mutation family.
    presentUser: false,
    agent: false,
    // `remove.preview` occupies the `remove` SDK namespace, so the mutation takes the
    // sibling `remove.execute` path exactly like the identity-connection removal above.
    sdkMethod: 'teams.directory.sources.remove.execute',
  }),
]) satisfies readonly PreNormalizedActionSpec[];
