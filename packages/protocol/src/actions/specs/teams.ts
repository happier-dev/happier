import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import type { z } from '../../zodRuntimePolicy.js';
import { PrivateLabelStoredV1Schema } from '../../crypto/privateLabelSchemaV1.js';

import { TEAM_IDENTITY_ACTION_IDS_V1, type TeamIdentityActionIdV1 } from '../../teams/identity/actionIds.js';
import { TEAM_DIRECTORY_ACTION_IDS_V1, type TeamDirectoryActionIdV1 } from '../../teams/directory/actionIds.js';
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
  TeamGroupCreateActionInputV1Schema, TeamGroupCreateInputV1Schema,
  TeamGroupMemberAddInputV1Schema,
  TeamGroupMemberMutationResultV1Schema,
  TeamGroupMemberRemoveInputV1Schema,
  TeamGroupMembersListInputV1Schema,
  TeamGroupMembersPageV1Schema,
  TeamGroupRefInputV1Schema,
  TeamGroupUpdateInputV1Schema,
  TeamGroupUpdateActionInputV1Schema,
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
  TEAM_POLICY_SET_ACTION_ID_V1,
  TEAM_SETUP_RUN_ACTION_ID_V1,
  TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1,
} from '../../teams/actionIdsV1.js';
import { TeamSetupBatchInputV1Schema, TeamSetupBatchResultV1Schema } from '../../teams/setupBatchV1.js';
import { resolvePluginLocalizedStringV2Text } from '../../plugins/contributions/publicTypes.js';
import { TeamSharedResourcesSummaryInputV1Schema, TeamSharedResourcesSummaryV1Schema } from '../../teams/teamShareableResourceKindV1.js';
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
  TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1, TEAM_CREDENTIAL_ACTION_WIRE_INPUT_SCHEMAS_V1,
  TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1,
  TEAM_CREDENTIAL_ACTION_PATHS_V1,
  TEAM_CREDENTIAL_ACTION_METHODS_V1,
  type TeamCredentialHomeActionIdV1,
} from '../../teams/credentials/actionsV1.js';
import {
  TEAM_CREDENTIAL_CREATE_ACTION_ID_V1,
  TEAM_CREDENTIAL_EXTERNAL_KEY_CREATE_ACTION_ID_V1,
  isTeamCredentialDeferredApprovalActionIdV1,
  isTeamCredentialDirectConfirmationActionIdV1,
  isTeamCredentialNativeDisclosureActionIdV1,
} from '../../teams/credentials/actionIdsV1.js';
import type { ActionInputFieldHint, PreNormalizedActionSpec } from '../actionSpecs.js';
import {
  homeAccountApprovalReferenceForField,
  homeDomainActionRow,
  homeDomainApprovalField as approvalField,
  type HomeDomainActionRow,
} from './homeDomainRow.js';
import { redactObservationInputPaths } from './observationRedaction.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { teamCredentialMutationRequiresUiConfirmation, teamCredentialNativeDisclosureApprovalSummary } from './teamCredentialApproval.js';
import { formatGovernanceApprovalSummary, type ApprovalPresentationContext } from './definition.js';
import { readDefaultsPlacementApprovalReference } from './governanceDefaultsApproval.js';
import { TeamMembershipHistoryInputV1Schema, TeamMembershipHistoryReadinessV1Schema,
  TeamMembershipHistoryPreparationResultV1Schema } from '../../teams/membershipHistoryPreparationV1.js';

const TEAM_MEMBER_ADD_TITLE = 'Add Team member';
const TEAM_ID_FIELD = approvalField('teamId', 'Team ID', { required: true });
const TEAM_POLICY_INPUT_HINTS = { fields: [
  TEAM_ID_FIELD,
  approvalField('sessionCreationPolicy', 'Session creation policy'),
  approvalField('reviewCreationPolicy', 'Review creation policy'),
  approvalField('externalSharingPolicy', 'External sharing policy'),
  approvalField('defaultSessionHistoryAccess', 'Default history access'),
  approvalField('admissionMode', 'Admission mode'),
  approvalField('authenticationPolicy.mode', 'Authentication policy'),
  approvalField('authenticationPolicy.accepted', 'Accepted sign-in methods', { widget: 'json' }),
  approvalField('managedDefaults', 'Team member defaults', { widget: 'json' }),
  approvalField('managedGroupDefaults', 'Group member defaults', { widget: 'json' }),
] };
const TEAM_ARCHIVE_INPUT_HINTS = {
  description: 'Waiting invitations are permanently revoked. Restoring the Team does not restore them.',
  fields: [TEAM_ID_FIELD],
};
const MEMBERSHIP_ID_FIELD = approvalField('membershipId', 'Membership ID', { required: true });
const GROUP_ID_FIELD = approvalField('groupId', 'Group ID', { required: true });
const TEAM_GROUP_CREATE_FIELDS = [
  TEAM_ID_FIELD,
  approvalField('name', 'Group name', { required: true }),
  approvalField('description', 'Description', { widget: 'textarea' }),
];
const ACCOUNT_ID_FIELD = approvalField('accountId', 'Account ID', { required: true });
const INVITATION_ID_FIELD = approvalField('invitationId', 'Invitation ID', { required: true });
// Input grammar may name the bearer, but never offer a value/default/example.
// Observation custody below still drops it before plugins or durable approval.
const INVITATION_TOKEN_FIELD = approvalField('token', 'Invitation token', { widget: 'secret' });

const invitationApprovalReference: NonNullable<PreNormalizedActionSpec['approvalPresentation']> = {
  summary: () => null,
  referenceForField: (path, value, input) => {
    const { teamId } = readRecord(input);
    if (path === 'invitationId' && typeof value === 'string' && typeof teamId === 'string') {
      return { kind: 'teamInvitation', id: value, teamId };
    }
  },
};

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
  approval: PreNormalizedActionSpec['approval'];
  approvalPolicy?: PreNormalizedActionSpec['approvalPolicy'];
  title: string;
  description: string;
  safety: 'safe' | 'danger';
  sideEffectClass: 'read' | 'write' | 'external' | 'danger';
  cliPath: readonly string[];
  presentUser?: boolean;
  agent?: boolean;
  mcp?: boolean;
  sdkMethod?: string;
  inputSchema: z.ZodMiniType;
  outputSchema: z.ZodMiniType;
  method?: 'GET' | 'POST' | 'DELETE';
  path: string;
  projectObservationInput?: PreNormalizedActionSpec['projectObservationInput'];
  projectObservationOutput?: PreNormalizedActionSpec['projectObservationOutput'];
  approvalResultCustody?: PreNormalizedActionSpec['approvalResultCustody'];
  approvalPresentation?: PreNormalizedActionSpec['approvalPresentation'];
}>;

const identityApprovalPresentation: NonNullable<PreNormalizedActionSpec['approvalPresentation']> = {
  referenceForField: (path, value, input) => {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const kind = path === 'connectionId' ? 'signInConnection'
      : path === 'providerInstanceId' ? 'signInProvider' : undefined;
    if (!kind) return undefined;
    const { teamId } = readRecord(input);
    return { kind, id: value, teamId: typeof teamId === 'string' ? teamId : null };
  },
  technicalInputPaths: ['workosConnectionId', 'externalReference.organizationId', 'externalReference.connectionId',
    'externalReference.installationId'],
};

const directoryApprovalPresentation: NonNullable<PreNormalizedActionSpec['approvalPresentation']> = {
  referenceForField: (path, value, input) => {
    const { teamId } = readRecord(input);
    if (typeof value !== 'string' || typeof teamId !== 'string') return undefined;
    if (path === 'sourceId') return { kind: 'teamDirectorySource', id: value, teamId };
    if (path === 'teamIdentityConnectionId') return { kind: 'signInConnection', id: value, teamId };
  },
  technicalInputPaths: ['cursor'],
};

type TeamProvisioningActionAuthority<
  TPresentUser extends boolean | undefined,
  TSideEffectClass extends TeamProvisioningActionRowInput['sideEffectClass'],
> = TPresentUser extends undefined
  ? TSideEffectClass extends 'read' ? 'account_automation' : 'present_user'
  : TPresentUser extends true ? 'present_user' : 'account_automation';

// Preserve each row's declared authority in the schema projection, including
// explicit automation mutations. Agent/MCP requests retain that same authority.
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
  const approvalPresentation = input.approvalPresentation ?? (
    TEAM_IDENTITY_ACTION_IDS_V1.some(id => id === input.id) ? identityApprovalPresentation
      : TEAM_DIRECTORY_ACTION_IDS_V1.some(id => id === input.id) ? directoryApprovalPresentation : undefined
  );
  const row = homeDomainActionRow({ ...input, agent: true, mcp: true, approvalPresentation });
  const presentUser = input.presentUser ?? input.sideEffectClass !== 'read';
  if (!presentUser) return row;
  return {
    ...row,
    requiredAuthority: 'present_user' as const,
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false } as const,
  };
}

function teamExternalGroupBindingActionRow<
  const TActionId extends TeamExternalGroupBindingActionIdV1,
  const TInputSchema extends z.ZodMiniType,
  const TOutputSchema extends z.ZodMiniType,
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
  approval: PreNormalizedActionSpec['approval'];
  path: string;
  approvalPolicy?: PreNormalizedActionSpec['approvalPolicy'];
  approvalPresentation?: PreNormalizedActionSpec['approvalPresentation'];
}>): HomeDomainActionRow<TActionId, TInputSchema, TOutputSchema> {
  return homeDomainActionRow(input);
}

const membershipHistoryApprovalPresentation: NonNullable<PreNormalizedActionSpec['approvalPresentation']> = {
  referenceForField: (path, value, input) => {
    const teamId = readRecord(input).teamId;
    if (typeof value !== 'string' || typeof teamId !== 'string') return;
    if (path === 'target.teamMembershipId') return { kind: 'teamMembership', id: value, teamId };
    if (path === 'target.teamGroupId') return { kind: 'group', id: value, teamId };
  },
  technicalInputPaths: ['clientId'],
};

function teamCredentialApprovalReferences(actionId: TeamCredentialHomeActionIdV1 | 'teams.credentials.usage.export'):
  NonNullable<PreNormalizedActionSpec['approvalPresentation']> {
  const createsResource = actionId === TEAM_CREDENTIAL_CREATE_ACTION_ID_V1;
  return {
    referenceForField: (path, value, input, parent) => {
      if (typeof value !== 'string' || !value.trim()) return;
      if ((path === 'resourceId' && !createsResource) || path === 'query.resourceId') {
        return { kind: 'teamCredentialResource', id: value, unavailableWithoutName: true };
      }
      if (path === 'keyId' && actionId !== TEAM_CREDENTIAL_EXTERNAL_KEY_CREATE_ACTION_ID_V1) {
        const { resourceId } = readRecord(input);
        if (typeof resourceId === 'string') return { kind: 'teamCredentialExternalKey', id: value, resourceId };
      }
      if (path === 'limitId') {
        const { resourceId, expectedRevision } = readRecord(input);
        if (typeof resourceId === 'string' && typeof expectedRevision === 'number') {
          return { kind: 'teamCredentialLimit', id: value, resourceId, resourceRevision: expectedRevision };
        }
      }
      if (path === 'source.connectionId' || path === 'replacement.custodian.source.connectionId') {
        return { kind: 'providerConnection', id: value };
      }
      if (path === 'executionMachineId' || path === 'brokerPlacement.machineId' || path === 'replacement.custodian.brokerPlacement.machineId') {
        return { kind: 'machine', id: value, unavailableWithoutName: true };
      }
      if (path === 'brokerPlacement.poolId' || path === 'replacement.custodian.brokerPlacement.poolId') return { kind: 'machinePool', id: value };
      if (path === 'limit.subjectId' || path === 'replacement.usageLimitDelta.upserts.[].subjectId') {
        const { limit, resourceId } = readRecord(input);
        const { subjectKind } = readRecord(path === 'limit.subjectId' ? limit : parent);
        if (subjectKind === 'team_member') return { kind: 'account', id: value };
        if (subjectKind === 'team_group' && typeof resourceId === 'string') {
          return { kind: 'teamCredentialAudience', id: value, resourceId, audience: 'group' };
        }
      }
      const operand = path.split('.').at(-1);
      const audience = operand === 'teamGroupId' ? 'group' : operand === 'teamMembershipId' ? 'teamMembership' : null;
      if (!audience) return;
      const { teamId, resourceId } = readRecord(input);
      if (createsResource && typeof teamId === 'string') {
        return audience === 'group' ? { kind: 'group', id: value, teamId } : { kind: 'teamMembership', id: value, teamId };
      }
      if (typeof resourceId === 'string') return { kind: 'teamCredentialAudience', id: value, resourceId, audience };
    },
    clearInputPaths: createsResource ? [] : [
      'allMembersAllowedRoutes', 'requestPolicy', 'brokerPlacement',
      'requestPolicy.allowedProtocolKinds', 'requestPolicy.allowedModelIds', 'requestPolicy.reasoningEffort',
      'replacement.allMembersAllowedRoutes', 'replacement.requestPolicy', 'replacement.custodian.brokerPlacement',
      'replacement.requestPolicy.allowedProtocolKinds', 'replacement.requestPolicy.allowedModelIds', 'replacement.requestPolicy.reasoningEffort',
    ],
    technicalInputPaths: ['cursor', 'query.cursor', 'limit.id', 'replacement.usageLimitDelta.upserts.[].id',
      ...(createsResource ? ['resourceId'] : []),
      ...(actionId === TEAM_CREDENTIAL_EXTERNAL_KEY_CREATE_ACTION_ID_V1 ? ['keyId'] : [])],
  };
}

function approvalChoiceField(
  path: string, title: string, options: NonNullable<ActionInputFieldHint['options']>,
): ActionInputFieldHint {
  return { path, title, widget: 'select', options };
}

function teamCredentialActionRow<TActionId extends TeamCredentialHomeActionIdV1>(input: Readonly<{
  id: TActionId;
  approval: PreNormalizedActionSpec['approval'];
  mcp?: boolean;
  title: string;
  description: string;
  safety: 'safe' | 'danger';
  sideEffectClass: 'read' | 'write' | 'external' | 'danger';
  cliPath: readonly string[];
  path: string;
  approvalFields?: readonly ActionInputFieldHint[];
}>) {
  const { approvalFields, ...action } = input;
  const row = homeDomainActionRow({
    ...action,
    ...(input.id === 'teams.credentials.externalKeys.revoke' || input.id === 'teams.credentials.externalKeys.revokeAll'
      ? { confirmVerb: { key: 'files.reviewComments.durable.directWriteGrant.revoke', fallback: 'Revoke' }, irreversible: true as const }
      : input.id === 'teams.credentials.delete' ? { confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true as const } : {}),
    ...(isTeamCredentialDirectConfirmationActionIdV1(input.id)
      ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
    approvalPresentation: {
      ...teamCredentialApprovalReferences(input.id),
      ...(approvalFields ? { inputHints: { fields: approvalFields } } : {}),
      ...(isTeamCredentialNativeDisclosureActionIdV1(input.id) ? {
        summary: (value: unknown, context?: ApprovalPresentationContext) =>
          teamCredentialNativeDisclosureApprovalSummary(input.id, value, context),
      } : {}),
    },
    ...(isTeamCredentialNativeDisclosureActionIdV1(input.id) ? {
      approvalPolicy: {
      uiConfirmation: 'direct' as const,
      uiConfirmationForInput: (value: unknown) => teamCredentialMutationRequiresUiConfirmation(input.id, value),
    } } : {}),
    inputSchema: TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1[input.id],
    wireInputSchema: TEAM_CREDENTIAL_ACTION_WIRE_INPUT_SCHEMAS_V1[input.id],
    outputSchema: TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1[input.id],
    method: TEAM_CREDENTIAL_ACTION_METHODS_V1[input.id],
  });
  if (input.id === 'teams.credentials.externalKeys.create') {
    return {
      ...row,
      projectObservationOutput: projectTeamCredentialExternalApiKeyCreateObservation,
      approvalResultCustody: 'live_only' as const,
    };
  }
  if (input.id === 'teams.credentials.test') return { ...row, requiredAuthority: 'present_user' as const };
  return row;
}

type ActionSpec<
  Id extends PreNormalizedActionSpec['id'],
  Input extends z.ZodMiniType,
  Output extends z.ZodMiniType,
  Placement extends NonNullable<PreNormalizedActionSpec['executionPlacement']> = 'account',
  RequiredAuthority extends NonNullable<PreNormalizedActionSpec['requiredAuthority']> = 'account_automation',
> = Omit<PreNormalizedActionSpec, 'id' | 'inputSchema' | 'outputSchema' | 'surfaceBindings' | 'requiredAuthority'> & Readonly<{
  id: Id;
  inputSchema: Input;
  outputSchema: Output;
  requiredAuthority: RequiredAuthority;
  executionPlacement: Placement;
}>;

// Keep per-id schema correlations without serializing every schema's implementation
// into the inferred factory declaration, matching the Execution Run spec boundary.
export type TeamActionSpecs = readonly [
  ActionSpec<typeof TEAM_SETUP_RUN_ACTION_ID_V1, typeof TeamSetupBatchInputV1Schema, typeof TeamSetupBatchResultV1Schema, 'client'>,
  ActionSpec<'teams.credentials.usage.export', typeof TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1['teams.credentials.usage.export'], typeof TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1['teams.credentials.usage.export'], 'client'>,
  ActionSpec<'teams.members.history.preparation.get', typeof TeamMembershipHistoryInputV1Schema, typeof TeamMembershipHistoryReadinessV1Schema, 'client'>,
  ActionSpec<'teams.members.history.prepare', typeof TeamMembershipHistoryInputV1Schema, typeof TeamMembershipHistoryPreparationResultV1Schema, 'client', 'present_user'>,
  ...ReturnType<typeof teamCredentialActionRow>[],
  ActionSpec<'teams.list', typeof TeamsListInputV1Schema, typeof TeamsPageV1Schema>,
  ActionSpec<'teams.get', typeof TeamRefInputV1Schema, typeof TeamSummaryV1Schema>,
  ActionSpec<typeof TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, typeof TeamSharedResourcesSummaryInputV1Schema, typeof TeamSharedResourcesSummaryV1Schema>,
  ActionSpec<'teams.create', typeof TeamCreateInputV1Schema, typeof TeamSummaryV1Schema>,
  ActionSpec<'teams.update', typeof TeamUpdateInputV1Schema, typeof TeamSummaryV1Schema>,
  ActionSpec<'teams.logo.set', typeof TeamLogoSetInputV1Schema, typeof TeamSummaryV1Schema>,
  ActionSpec<'teams.logo.remove', typeof TeamRefInputV1Schema, typeof TeamSummaryV1Schema>,
  ActionSpec<typeof TEAM_POLICY_SET_ACTION_ID_V1, typeof TeamPolicySetInputV1Schema, typeof TeamSummaryV1Schema>,
  ActionSpec<'teams.archive', typeof TeamRefInputV1Schema, typeof TeamSummaryV1Schema>,
  ActionSpec<'teams.restore', typeof TeamRefInputV1Schema, typeof TeamSummaryV1Schema>,
  ActionSpec<'teams.members.list', typeof TeamMembersListInputV1Schema, typeof TeamMembersPageV1Schema>,
  ActionSpec<'teams.members.get', typeof TeamMemberRefInputV1Schema, typeof TeamMembershipV1Schema>,
  ActionSpec<'teams.members.add', typeof TeamMemberAddInputV1Schema, typeof TeamMembershipV1Schema>,
  ActionSpec<'teams.members.role.set', typeof TeamMemberRoleSetInputV1Schema, typeof TeamMembershipV1Schema>,
  ActionSpec<'teams.members.suspend', typeof TeamMemberRefInputV1Schema, typeof TeamMembershipV1Schema>,
  ActionSpec<'teams.members.reactivate', typeof TeamMemberRefInputV1Schema, typeof TeamMembershipV1Schema>,
  ActionSpec<'teams.members.remove', typeof TeamMemberRefInputV1Schema, typeof TeamMemberRemoveResultV1Schema>,
  ActionSpec<'teams.members.leave', typeof TeamRefInputV1Schema, typeof TeamMemberRemoveResultV1Schema>,
  ActionSpec<'teams.members.management.set', typeof TeamMemberManagementSetInputV1Schema, typeof TeamMembershipV1Schema>,
  ActionSpec<'teams.members.groups.list', typeof TeamMemberGroupsListInputV1Schema, typeof TeamGroupsPageV1Schema>,
  ActionSpec<'teams.groups.list', typeof TeamGroupsListInputV1Schema, typeof TeamGroupsPageV1Schema>,
  ActionSpec<'teams.groups.get', typeof TeamGroupRefInputV1Schema, typeof TeamGroupV1Schema>,
  ActionSpec<'teams.groups.create', typeof TeamGroupCreateActionInputV1Schema, typeof TeamGroupV1Schema>,
  ActionSpec<'teams.groups.update', typeof TeamGroupUpdateActionInputV1Schema, typeof TeamGroupV1Schema>,
  ActionSpec<'teams.groups.archive', typeof TeamGroupRefInputV1Schema, typeof TeamGroupV1Schema>,
  ActionSpec<'teams.groups.restore', typeof TeamGroupRefInputV1Schema, typeof TeamGroupV1Schema>,
  ActionSpec<'teams.groups.members.list', typeof TeamGroupMembersListInputV1Schema, typeof TeamGroupMembersPageV1Schema>,
  ActionSpec<'teams.groups.members.add', typeof TeamGroupMemberAddInputV1Schema, typeof TeamGroupMemberMutationResultV1Schema>,
  ActionSpec<'teams.groups.members.remove', typeof TeamGroupMemberRemoveInputV1Schema, typeof TeamGroupMemberMutationResultV1Schema>,
  ActionSpec<'teams.invitations.list', typeof TeamInvitationListInputV1Schema, typeof TeamInvitationsPageV1Schema>,
  ActionSpec<'teams.invitations.create', typeof TeamInvitationCreateInputV1Schema, typeof TeamInvitationCreateResultV1Schema, 'account', 'present_user'>,
  ActionSpec<'teams.invitations.revoke', typeof TeamInvitationRevokeInputV1Schema, typeof TeamInvitationRevokeResultV1Schema>,
  ActionSpec<'teams.invitations.reissue', typeof TeamInvitationReissueInputV1Schema, typeof TeamInvitationReissueResultV1Schema, 'account', 'present_user'>,
  ActionSpec<'teams.invitations.preview', typeof TeamInvitationPreviewInputV1Schema, typeof TeamInvitationPreviewResultV1Schema>,
  ActionSpec<'teams.invitations.accept.prepareApproval', typeof TeamInvitationAcceptApprovalPrepareInputV1Schema, typeof TeamInvitationAcceptApprovalPrepareResultV1Schema>,
  ActionSpec<'teams.invitations.accept', typeof TeamInvitationAcceptInputV1Schema, typeof TeamInvitationAcceptResultV1Schema>,
  ActionSpec<'teams.identity.connections.list', typeof TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.list'], typeof TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.list']>,
  ActionSpec<'teams.identity.connections.create', typeof TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.create'], typeof TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.create'], 'account', 'present_user'>,
  ActionSpec<'teams.identity.connections.settings.update', typeof TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.settings.update'], typeof TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.settings.update'], 'account', 'present_user'>,
  ActionSpec<'teams.identity.connections.enable', typeof TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.enable'], typeof TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.enable'], 'account', 'present_user'>,
  ActionSpec<'teams.identity.connections.disable', typeof TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.disable'], typeof TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.disable'], 'account', 'present_user'>,
  ActionSpec<'teams.identity.connections.remove.preview', typeof TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.remove.preview'], typeof TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.remove.preview']>,
  ActionSpec<'teams.identity.connections.remove', typeof TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.remove'], typeof TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.remove'], 'account', 'present_user'>,
  ActionSpec<'teams.identity.connections.test.start', typeof TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.test.start'], typeof TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.test.start']>,
  ActionSpec<'teams.identity.connections.test.consume', typeof TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.connections.test.consume'], typeof TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.connections.test.consume']>,
  ActionSpec<'teams.identity.workos.connection.create', typeof TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.workos.connection.create'], typeof TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.workos.connection.create'], 'account', 'present_user'>,
  ActionSpec<'teams.identity.workos.adminPortalLink.create', typeof TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.workos.adminPortalLink.create'], typeof TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.workos.adminPortalLink.create']>,
  ActionSpec<'teams.identity.workos.reconcile', typeof TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.workos.reconcile'], typeof TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.workos.reconcile'], 'account', 'present_user'>,
  ActionSpec<'teams.identity.workos.connection.set', typeof TEAM_IDENTITY_ACTION_INPUT_SCHEMAS_V1['teams.identity.workos.connection.set'], typeof TEAM_IDENTITY_ACTION_OUTPUT_SCHEMAS_V1['teams.identity.workos.connection.set'], 'account', 'present_user'>,
  ActionSpec<'teams.externalGroupBindings.list', typeof TEAM_EXTERNAL_GROUP_BINDING_ACTION_INPUT_SCHEMAS_V1['teams.externalGroupBindings.list'], typeof TEAM_EXTERNAL_GROUP_BINDING_ACTION_OUTPUT_SCHEMAS_V1['teams.externalGroupBindings.list']>,
  ActionSpec<'teams.externalGroupBindings.set', typeof TEAM_EXTERNAL_GROUP_BINDING_ACTION_INPUT_SCHEMAS_V1['teams.externalGroupBindings.set'], typeof TEAM_EXTERNAL_GROUP_BINDING_ACTION_OUTPUT_SCHEMAS_V1['teams.externalGroupBindings.set']>,
  ActionSpec<'teams.externalGroupBindings.remove', typeof TEAM_EXTERNAL_GROUP_BINDING_ACTION_INPUT_SCHEMAS_V1['teams.externalGroupBindings.remove'], typeof TEAM_EXTERNAL_GROUP_BINDING_ACTION_OUTPUT_SCHEMAS_V1['teams.externalGroupBindings.remove']>,
  ActionSpec<'teams.directory.sourceSetup.list', typeof TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sourceSetup.list'], typeof TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sourceSetup.list']>,
  ActionSpec<'teams.directory.sources.list', typeof TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.list'], typeof TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.list']>,
  ActionSpec<'teams.directory.sources.get', typeof TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.get'], typeof TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.get']>,
  ActionSpec<'teams.directory.people.list', typeof TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.people.list'], typeof TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.people.list']>,
  ActionSpec<'teams.directory.groups.list', typeof TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.groups.list'], typeof TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.groups.list']>,
  ActionSpec<'teams.directory.sources.create', typeof TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.create'], typeof TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.create'], 'account', 'present_user'>,
  ActionSpec<'teams.directory.sources.sync', typeof TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.sync'], typeof TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.sync'], 'account', 'present_user'>,
  ActionSpec<'teams.directory.sources.pause', typeof TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.pause'], typeof TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.pause'], 'account', 'present_user'>,
  ActionSpec<'teams.directory.sources.resume', typeof TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.resume'], typeof TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.resume'], 'account', 'present_user'>,
  ActionSpec<'teams.directory.sources.remove.preview', typeof TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.remove.preview'], typeof TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.remove.preview']>,
  ActionSpec<'teams.directory.sources.remove', typeof TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.remove'], typeof TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.remove']>,
];

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
function createTeamActionSpecs(): TeamActionSpecs {
  const credentialSessionUseOptions = [
    { value: 'personal_allowed', label: 'Personal sessions allowed', labelKey: 'teams.credentials.usePolicy.personalAllowed' },
    { value: 'team_context_required', label: 'Team context required', labelKey: 'teams.credentials.usePolicy.teamContextRequired' },
    { value: 'team_visibility_required', label: 'Team visibility required', labelKey: 'teams.credentials.usePolicy.teamVisibilityRequired' },
  ];
  const credentialProtocolOptions = [
    { value: 'openai_responses', label: 'OpenAI Responses', labelKey: 'teams.credentials.requestPolicy.protocol.openaiResponses' },
    { value: 'openai_chat_completions', label: 'OpenAI Chat Completions', labelKey: 'teams.credentials.requestPolicy.protocol.openaiChatCompletions' },
    { value: 'anthropic_messages', label: 'Anthropic Messages', labelKey: 'teams.credentials.requestPolicy.protocol.anthropicMessages' },
  ];
  const credentialLimitAudienceOptions = [
    { value: 'resource', label: 'Resource', labelKey: 'teams.credentials.limits.subject.resource' },
    { value: 'each_member', label: 'Each member', labelKey: 'teams.credentials.limits.subject.eachMember' },
    { value: 'team_group', label: 'Group', labelKey: 'teams.credentials.limits.subject.group' },
    { value: 'team_member', label: 'Member', labelKey: 'teams.credentials.limits.subject.member' },
  ];
  const credentialLimitPeriodOptions = [
    { value: 'day', label: 'Day', labelKey: 'teams.credentials.limits.period.day' },
    { value: 'week', label: 'Week', labelKey: 'teams.credentials.limits.period.week' },
    { value: 'month', label: 'Month', labelKey: 'teams.credentials.limits.period.month' },
  ];
  const credentialLimitMetricOptions = [
    { value: 'inference_requests', label: 'Requests', labelKey: 'teams.credentials.limits.metric.requests' },
    { value: 'total_tokens', label: 'Tokens', labelKey: 'teams.credentials.limits.metric.tokens' },
    { value: 'cost_usd', label: 'Cost', labelKey: 'teams.credentials.limits.metric.cost' },
  ];
  const credentialApprovalFields: Partial<Record<TeamCredentialHomeActionIdV1, readonly ActionInputFieldHint[]>> = {
    'teams.credentials.create': [
      TEAM_ID_FIELD,
      approvalField('resourceId', 'Resource ID', { required: true }),
      approvalField('displayName', 'Name', { widget: 'json', required: true }),
      approvalField('source', 'Credential source', { widget: 'json', required: true }),
      approvalField('deliveryPolicy', 'Delivery policy', { widget: 'json' }),
      approvalChoiceField('sessionUsePolicy', 'Session use policy', credentialSessionUseOptions),
      approvalField('brokerPlacement', 'Broker placement', { widget: 'json' }),
      approvalField('requestPolicy', 'Request policy', { widget: 'json' }),
      approvalField('allMembersAllowedRoutes', 'Routes for all members', { widget: 'json' }),
      approvalField('groupGrants', 'Group grants', { widget: 'json' }),
      approvalField('memberGrants', 'Member grants', { widget: 'json' }),
      approvalField('usageLimits', 'Usage limits', { widget: 'json' }),
    ],
    'teams.credentials.update': [
      approvalField('resourceId', 'Resource', { required: true }),
      approvalField('expectedRevision', 'Expected revision', { required: true }),
      approvalField('enabled', 'Enabled'),
      approvalField('displayName', 'Name', { widget: 'json' }),
      approvalField('deliveryPolicy', 'Delivery policy', { widget: 'json' }),
      approvalChoiceField('sessionUsePolicy', 'Session use policy', credentialSessionUseOptions),
      approvalField('brokerPlacement', 'Broker placement', { widget: 'json' }),
      approvalField('requestPolicy', 'Request policy', { widget: 'json' }),
      { path: 'requestPolicy.allowedProtocolKinds', title: 'Allowed protocols', widget: 'multiselect', options: credentialProtocolOptions },
      approvalField('replacement', 'Changes', { widget: 'json' }),
      approvalChoiceField('replacement.sessionUsePolicy', 'Session use policy', credentialSessionUseOptions),
      { path: 'replacement.requestPolicy.allowedProtocolKinds', title: 'Allowed protocols', widget: 'multiselect', options: credentialProtocolOptions },
      approvalChoiceField('replacement.usageLimitDelta.upserts.[].subjectKind', 'Audience', credentialLimitAudienceOptions),
      approvalChoiceField('replacement.usageLimitDelta.upserts.[].period', 'Period', credentialLimitPeriodOptions),
      approvalChoiceField('replacement.usageLimitDelta.upserts.[].metric', 'Usage measure', credentialLimitMetricOptions),
    ],
    'teams.credentials.list': [
      TEAM_ID_FIELD,
      approvalField('scope', 'Scope'),
      approvalChoiceField('filter', 'Filter', [
        { value: 'all', label: 'All', labelKey: 'common.all' },
        { value: 'needs_attention', label: 'Needs attention', labelKey: 'teams.credentials.state.needsAttention' },
        { value: 'brokered', label: 'Brokered', labelKey: 'teams.credentials.delivery.brokered' },
        { value: 'direct', label: 'Direct', labelKey: 'teams.credentials.delivery.direct' },
        { value: 'external_api', label: 'External API', labelKey: 'teams.credentials.externalApi.title' },
      ]),
      approvalField('limit', 'Limit'),
      approvalField('cursor', 'Cursor'),
    ],
    'teams.credentials.limits.upsert': [
      approvalField('resourceId', 'Resource', { required: true }),
      approvalField('expectedRevision', 'Expected revision', { required: true }),
      approvalField('limit.id', 'Limit ID'),
      approvalChoiceField('limit.subjectKind', 'Audience', credentialLimitAudienceOptions),
      approvalField('limit.subjectId', 'Audience target'),
      approvalChoiceField('limit.period', 'Period', credentialLimitPeriodOptions),
      approvalChoiceField('limit.metric', 'Usage measure', credentialLimitMetricOptions),
      approvalField('limit.maximum', 'Maximum', { required: true }),
      approvalField('limit.enabled', 'Enabled', { required: true }),
    ],
  };
  return Object.freeze<TeamActionSpecs>([
  {
    id: TEAM_SETUP_RUN_ACTION_ID_V1, title: 'Set up Team projects',
    description: 'Ask the requester to review the selected Machine setup and checkouts on their App, then run them in order.',
    executionPlacement: 'client', requiredAuthority: 'account_automation', safety: 'danger', sideEffectClass: 'write',
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false }, placements: [],
    cli: { commands: [], acceptsServerId: true, requiresServerId: true },
    inputSchema: TeamSetupBatchInputV1Schema, outputSchema: TeamSetupBatchResultV1Schema,
    approval: { flow: 'blocking', result: 'required' }, approvalPolicy: { uiConfirmation: 'policy', requesterAppReview: true },
    approvalPresentation: { summary: (value, context) => {
      const setup = TeamSetupBatchInputV1Schema.parse(value);
      const { machineId, homeId, machine, repositories } = setup;
      return formatGovernanceApprovalSummary(context, { kind: 'teamSetup', setup }, () => [
        `Machine ${machineId} on Home ${homeId}`,
        ...(machine ? machine.targets.flatMap(target => [
          `Apply ${target.preset?.id ?? 'Machine setup'} (revision ${target.preset?.revision ?? target.desiredRevision})`,
          ...target.recipePlans.flatMap(({ plan }) => plan.steps.map(step =>
            `${step.kind}: ${step.review ? resolvePluginLocalizedStringV2Text(step.review.title) : step.id}`)),
          ...(target.removeItemKeys ?? []).map(id => `Remove ${id}`),
          ...(target.appChildren ?? []).map(child => child.actionId),
        ]) : []),
        ...repositories.map(({ input }) => {
          const checkoutPath = input.source.kind === 'source' ? input.source.checkoutPath ?? input.source.checkout?.rootPath : undefined;
          const source = input.source.kind === 'folder' ? input.source.path
            : input.source.kind === 'workspace' ? input.source.checkout?.rootPath ?? `Workspace ${input.source.workspaceId}`
            : `${input.source.selector.repository.nameWithOwner} on ${input.source.selector.provider.baseUrl}`
              + (checkoutPath ? ` at ${checkoutPath}` : '');
          const checkout = input.materialization;
          const destination = checkout.kind === 'clone'
            ? ` → ${checkout.destinationParentPath}/${checkout.destinationDirectoryName}`
            : checkout.kind === 'sync' ? ` → ${checkout.targetPath}`
              : checkout.kind === 'worktree' ? ` → ${checkout.targetPath ?? checkout.checkout.displayName}` : '';
          const authentication = checkout.kind === 'clone'
            ? ` using ${checkout.gitAccount ? `Connected Account ${checkout.gitAccount.accountId}` : checkout.authentication}` : '';
          const ref = input.ref ?? (input.source.kind === 'source' ? input.source.defaultRef : undefined);
          return `${checkout.kind} ${source}${ref ? ` @ ${ref}` : ''}${authentication}${destination}`;
        }),
      ].join('\n'));
    } },
    bindings: { mcpToolName: 'teams_setup_run' },
  } as const satisfies PreNormalizedActionSpec,
  {
    id: 'teams.credentials.usage.export', approval: {result: 'required'}, title: 'Export Team credential usage',
    description: 'Build CSV file bytes on the keyholding client from the authorized Team credential usage projection, preserving the selected ranked-row scope and measurement coverage. Saving and sharing remain explicit client operations.',
    safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { commands: [{ path: ['teams', 'credentials', 'usage', 'export'], visibility: 'canonical' }], acceptsServerId: true, requiresServerId: true },
    bindings: { mcpToolName: 'teams_credentials_usage_export' },
    inputSchema: TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1['teams.credentials.usage.export'],
    outputSchema: TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1['teams.credentials.usage.export'],
    approvalPresentation: teamCredentialApprovalReferences('teams.credentials.usage.export'),
    inputHints: { fields: [approvalField('query', 'Usage query', { widget: 'json', required: true }),
      approvalField('breakdownRowCount', 'Selected ranked rows', { widget: 'number' })] },
  } as const satisfies PreNormalizedActionSpec,
  {
    id: 'teams.members.history.preparation.get', title: 'Check member history encryption',
    description: 'Read readiness and counts through an answering app without exposing Session envelopes.',
    executionPlacement: 'client', requiredAuthority: 'account_automation', safety: 'safe', sideEffectClass: 'read',
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false }, placements: [],
    inputSchema: TeamMembershipHistoryInputV1Schema, outputSchema: TeamMembershipHistoryReadinessV1Schema,
    approvalPresentation: membershipHistoryApprovalPresentation,
    approval: { flow: 'blocking', result: 'required' },
    inputHints: { fields: [TEAM_ID_FIELD, approvalField('target', 'Membership', { widget: 'json', required: true }),
      approvalField('recipientAccountId', 'Recipient Account', { required: true })] },
    bindings: { mcpToolName: 'teams_members_history_preparation_get' },
  },
  {
    id: 'teams.members.history.prepare', title: 'Prepare member history encryption',
    irreversible: true,
    description: 'Ask a person to prepare existing encrypted history through the answering app’s captured encryption owner.',
    executionPlacement: 'client', requiredAuthority: 'present_user', safety: 'danger', sideEffectClass: 'write',
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false }, placements: [],
    inputSchema: TeamMembershipHistoryInputV1Schema, outputSchema: TeamMembershipHistoryPreparationResultV1Schema,
    approvalPresentation: membershipHistoryApprovalPresentation,
    approval: { flow: 'blocking', result: 'required' },
    inputHints: { fields: [TEAM_ID_FIELD, approvalField('target', 'Membership', { widget: 'json', required: true }),
      approvalField('recipientAccountId', 'Recipient Account', { required: true })] },
    bindings: { mcpToolName: 'teams_members_history_prepare' },
  },
  ...TEAM_CREDENTIAL_HOME_ACTION_IDS_V1.map((id) => teamCredentialActionRow({
    mcp: true,
    id, approval: isTeamCredentialDeferredApprovalActionIdV1(id) ? { result: 'required', flow: 'deferred' } : { result: 'required' },
    approvalFields: credentialApprovalFields[id],
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
      'teams.credentials.preparation.get': 'Check Team credential preparation',
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
      'teams.credentials.preparation.get': 'Read aggregate direct-access readiness without credential material or recipient encryption bindings.',
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
      || id === 'teams.credentials.preparation.get'
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
      || id === 'teams.credentials.preparation.get'
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
    id: 'teams.list', approval: {result: 'required'},
    mcp: true,
    title: 'List Teams',
    description: 'List visible Team names and IDs in this Home for the authenticated Account; resolve a Team by name before listing or changing its Groups.',
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
    id: 'teams.get', approval: {result: 'required'},
    mcp: true,
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
    id: TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, approval: { result: 'required' },
    mcp: true,
    title: 'Summarize Team shared resources',
    description: 'Read per-kind counts of resources shared with this Team and admitted for the authenticated Account.',
    safety: 'safe', sideEffectClass: 'read',
    cliPath: ['teams', 'shared-resources', 'summary'], path: '/v1/teams/shared-resources/summary',
    inputSchema: TeamSharedResourcesSummaryInputV1Schema, outputSchema: TeamSharedResourcesSummaryV1Schema,
    inputHints: { fields: [TEAM_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'teams.create', approval: {result: 'required'},
    approvalPresentation: { referenceForField: homeAccountApprovalReferenceForField('initialOwnerAccountId') },
    mcp: true,
    title: 'Create Team',
    description: 'Create a Team in this Home. initialOwnerAccountId is required when Team creation is managed-only. A repeated request key returns the same Team rather than a second one.',
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
    id: 'teams.update', approval: {result: 'required',flow: 'deferred'},
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
    id: 'teams.logo.set', approval: {result: 'required'},
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
    id: 'teams.logo.remove', approval: {result: 'required'},
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
    id: TEAM_POLICY_SET_ACTION_ID_V1, approval: {result: 'required',flow: 'deferred'},
    mcp: true,
    voiceClientToolName: 'teams_policy_set',
    approvalPolicy: { uiConfirmation: 'direct' },
    approvalPresentation: {
      inputHints: TEAM_POLICY_INPUT_HINTS,
      referenceForField: (path, value, input, parent) => {
        if (path === 'managedDefaults.team.approvalProfileId' || path === 'managedGroupDefaults.defaults.approvalProfileId'
          || path === 'managedDefaults.groups.[].defaults.approvalProfileId') {
          if (value === null || (typeof value === 'string' && value.trim())) return { kind: 'approvalProfile', id: value };
          return undefined;
        }
        if (typeof value !== 'string' || !value.trim()) return undefined;
        if (path === 'managedGroupDefaults.teamGroupId' || path === 'managedDefaults.groups.[].teamGroupId') {
          const teamId = readRecord(input).teamId;
          if (typeof teamId === 'string' && teamId.trim()) return { kind: 'group', id: value, teamId };
        }
        return readDefaultsPlacementApprovalReference(path, value, parent);
      },
      summary: (input, context) => {
        const change = readRecord(input);
        const groupChange = readRecord(change?.managedGroupDefaults);
        const signIn = change.authenticationPolicy === null
          ? change.previousAuthenticationPolicy === null ? 'inherit' : 'inheritMayExpand' : null;
        const clearTeamDefaults = change.managedDefaults === null;
        const clearGroupDefaults = groupChange.defaults === null;
        if (!signIn && !clearTeamDefaults && !clearGroupDefaults) return null;
        return formatGovernanceApprovalSummary(context, { kind: 'teamPolicy', signIn, clearTeamDefaults, clearGroupDefaults }, () => [
          signIn === 'inherit' ? 'Use the Home’s sign-in policy'
            : signIn === 'inheritMayExpand' ? 'Use the Home’s sign-in policy (may allow more sign-in methods)' : null,
          clearTeamDefaults ? 'Clear Team member defaults and all Group overrides' : null,
          clearGroupDefaults ? 'Clear Group member defaults' : null,
        ].filter(Boolean).join('. '));
      },
    },
    title: 'Set Team policy',
    description: 'Change a Team\'s Session, sharing, history and admission policy. These decide who may reach Team work.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'policy', 'set'],
    path: '/v1/teams/policy/set',
    inputSchema: TeamPolicySetInputV1Schema,
    outputSchema: TeamSummaryV1Schema,
    inputHints: TEAM_POLICY_INPUT_HINTS,
  }),
  homeDomainActionRow({
    id: 'teams.archive', approval: {result: 'required',flow: 'deferred'},
    // A manager restores an archived Team, so it confirms by default without "This can't be undone."
    approvalPolicy: { uiConfirmation: 'policy' },
    mcp: true,
    title: 'Archive Team',
    description: 'Archive a Team, ending ordinary member access until it is restored. Waiting invitations are permanently revoked.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'archive'],
    path: '/v1/teams/archive',
    inputSchema: TeamRefInputV1Schema,
    outputSchema: TeamSummaryV1Schema,
    approvalPresentation: { summary: (_value, context) =>
      formatGovernanceApprovalSummary(context, { kind: 'teamArchive' }, () => TEAM_ARCHIVE_INPUT_HINTS.description), inputHints: TEAM_ARCHIVE_INPUT_HINTS },
    inputHints: TEAM_ARCHIVE_INPUT_HINTS,
  }),
  homeDomainActionRow({
    id: 'teams.restore', approval: {result: 'required',flow: 'deferred'},
    mcp: true,
    approvalPolicy: { uiConfirmation: 'direct' },
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
    id: 'teams.members.list', approval: {result: 'required'},
    title: 'List Team members',
    description: 'Page through a Team roster with the viewer\'s per-member capabilities.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'members', 'list'],
    path: '/v1/teams/members/list',
    inputSchema: TeamMembersListInputV1Schema,
    outputSchema: TeamMembersPageV1Schema,
    approvalPresentation: {
      technicalInputPaths: ['cursor'],
      inputHints: { fields: [
        TEAM_ID_FIELD,
        approvalChoiceField('filter', 'Member filter', [
          { value: 'all', label: 'All members', labelKey: 'teams.members.filterAll' },
          { value: 'owners_admins', label: 'Owners and admins', labelKey: 'teams.members.filterOwnersAndAdmins' },
          { value: 'members', label: 'Members', labelKey: 'teams.members.filterMembers' },
          { value: 'guests', label: 'Guests', labelKey: 'teams.members.filterGuests' },
          { value: 'suspended', label: 'Suspended', labelKey: 'teams.members.filterSuspended' },
        ]),
        approvalField('query', 'Search'), approvalField('limit', 'Limit'), approvalField('cursor', 'Cursor'),
      ] },
    },
    inputHints: { fields: [
      TEAM_ID_FIELD,
      approvalField('filter', 'Member filter', { required: true }),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.members.get', approval: {result: 'required'},
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
    id: 'teams.members.add', approval: {result: 'required',flow: 'deferred'},
    mcp: true,
    approvalPolicy: { uiConfirmation: 'direct' },
    title: TEAM_MEMBER_ADD_TITLE,
    approvalPresentation: {
      summary: (_input, context) => context?.teamMemberPresentation
        ? `${TEAM_MEMBER_ADD_TITLE} · ${context.teamMemberPresentation.accountName} · ${context.teamMemberPresentation.teamName}` : null,
      referenceForField: homeAccountApprovalReferenceForField(ACCOUNT_ID_FIELD.path),
    },
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
    id: 'teams.members.role.set', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
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
    id: 'teams.members.suspend', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
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
    id: 'teams.members.reactivate', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
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
    id: 'teams.members.remove', approval: {result: 'required',flow: 'deferred'},
    irreversible: true,
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
    id: 'teams.members.leave', approval: {result: 'required',flow: 'deferred'},
    irreversible: true,
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
    id: 'teams.members.management.set', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Set Team member management',
    description: 'Convert who owns one membership\'s lifecycle while preserving its lifetime, role, status and horizon.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'members', 'management', 'set'],
    path: '/v1/teams/members/management/set',
    inputSchema: TeamMemberManagementSetInputV1Schema,
    outputSchema: TeamMembershipV1Schema,
    approvalPresentation: {
      referenceForField: (path, value, input) => {
        const { teamId } = readRecord(input);
        if (path === 'management.directorySourceId' && typeof teamId === 'string' && typeof value === 'string') {
          return { kind: 'teamDirectorySource', id: value, teamId };
        }
      },
      inputHints: { fields: [
        TEAM_ID_FIELD, MEMBERSHIP_ID_FIELD,
        approvalChoiceField('management.kind', 'Management owner', [
          { value: 'native', label: 'Manually managed', labelKey: 'teams.members.managementNative' },
          { value: 'directory_source', label: 'Directory sync', labelKey: 'teams.authentication.directory.title' },
        ]),
        approvalField('management.directorySourceId', 'Directory source'),
      ] },
    },
    inputHints: { description: 'Choose whether a Team member is managed by hand or by your directory. Their role and access stay the same.', fields: [
      TEAM_ID_FIELD,
      MEMBERSHIP_ID_FIELD,
      approvalField('management.kind', 'Management owner', { required: true }),
      approvalField('management.directorySourceId', 'Directory source ID'),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.members.groups.list', approval: {result: 'required'},
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
    id: 'teams.groups.list', approval: {result: 'required'},
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
    id: 'teams.groups.get', approval: {result: 'required'},
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
    id: 'teams.groups.create', approval: {result: 'required'},
    title: 'Create Team Group',
    description: 'Create a Group in a Team. The Account client seals authored labels before the Home mutation.',
    safety: 'safe',
    sideEffectClass: 'write',
    cliPath: ['teams', 'groups', 'create'],
    path: '/v1/teams/groups/create',
    inputSchema: TeamGroupCreateActionInputV1Schema,
    wireInputSchema: TeamGroupCreateInputV1Schema,
    outputSchema: TeamGroupV1Schema,
    approvalPresentation: {
      inputHints: { fields: [...TEAM_GROUP_CREATE_FIELDS, approvalField('groupId', 'Group ID')] },
      technicalInputPaths: ['groupId'],
      referenceForField: (field, value, input) => {
        const { groupId } = readRecord(input);
        if ((field !== 'name' && field !== 'description') || typeof groupId !== 'string') return undefined;
        const stored = PrivateLabelStoredV1Schema.safeParse(value);
        return stored.success ? { kind: 'privateLabel', id: groupId, field, stored: stored.data, owner: 'teamGroup' } : undefined;
      },
    },
    inputHints: { fields: TEAM_GROUP_CREATE_FIELDS },
  }),
  homeDomainActionRow({
    id: 'teams.groups.update', approval: {result: 'required'},
    title: 'Update Team Group',
    description: 'Change a Group\'s name or description using authored text. The captured Account client seals labels before the Home mutation.',
    safety: 'safe',
    sideEffectClass: 'write',
    cliPath: ['teams', 'groups', 'update'],
    path: '/v1/teams/groups/update',
    inputSchema: TeamGroupUpdateActionInputV1Schema,
    wireInputSchema: TeamGroupUpdateInputV1Schema,
    outputSchema: TeamGroupV1Schema,
    inputHints: { fields: [
      TEAM_ID_FIELD,
      GROUP_ID_FIELD,
      approvalField('name', 'Group name'),
      approvalField('description', 'Description', { widget: 'textarea' }),
    ] },
  }),
  homeDomainActionRow({
    id: 'teams.groups.archive', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
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
    id: 'teams.groups.restore', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
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
    id: 'teams.groups.members.list', approval: {result: 'required'},
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
    id: 'teams.groups.members.add', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
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
    id: 'teams.groups.members.remove', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'policy' },
    confirmVerb: { key: 'common.remove', fallback: 'Remove' },
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
    id: 'teams.invitations.list', approval: {result: 'required'},
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
  { ...homeDomainActionRow({
    id: 'teams.invitations.create', approval: {result: 'required'},
    approvalPolicy: { uiConfirmation: 'direct' },
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
    // Requesters receive safe observations. Only the approving user's live
    // invocation receives the bearer; the shared approval owner enforces custody.
    projectObservationOutput: projectTeamInvitationCreateObservation,
    approvalResultCustody: 'live_only',
  }), requiredAuthority: 'present_user' as const },
  homeDomainActionRow({
    id: 'teams.invitations.revoke', approval: {result: 'required',flow: 'deferred'},
    confirmVerb: { key: 'files.reviewComments.durable.directWriteGrant.revoke', fallback: 'Revoke' }, irreversible: true,
    title: 'Revoke Team invitation',
    description: 'Stop an outstanding invitation from admitting anyone. A repeated revocation reports the current row.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'invitations', 'revoke'],
    path: '/v1/teams/invitations/revoke',
    inputSchema: TeamInvitationRevokeInputV1Schema,
    outputSchema: TeamInvitationRevokeResultV1Schema,
    approvalPresentation: invitationApprovalReference,
    inputHints: { fields: [TEAM_ID_FIELD, INVITATION_ID_FIELD] },
  }),
  { ...homeDomainActionRow({
    id: 'teams.invitations.reissue', approval: {result: 'required'},
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Reissue Team invitation',
    description: 'Retire the current bearer and issue a fresh invitation carrying the same role and history intent.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'invitations', 'reissue'],
    path: '/v1/teams/invitations/reissue',
    inputSchema: TeamInvitationReissueInputV1Schema,
    outputSchema: TeamInvitationReissueResultV1Schema,
    approvalPresentation: invitationApprovalReference,
    inputHints: { fields: [
      TEAM_ID_FIELD,
      INVITATION_ID_FIELD,
      approvalField('recipientEmail', 'Recipient email'),
    ] },
    projectObservationOutput: projectTeamInvitationReissueObservation,
    approvalResultCustody: 'live_only',
  }), requiredAuthority: 'present_user' as const },
  homeDomainActionRow({
    id: 'teams.invitations.preview', approval: {result: 'required'},
    mcp: true,
    title: 'Preview Team invitation',
    description: 'Read the bounded public preview for an invitation bearer.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'invitations', 'preview'],
    path: '/v1/team-invitations/preview',
    inputSchema: TeamInvitationPreviewInputV1Schema,
    outputSchema: TeamInvitationPreviewResultV1Schema,
    inputHints: { fields: [{ ...INVITATION_TOKEN_FIELD, required: true }] },
    projectObservationInput: redactObservationInputPaths('token'),
  }),
  {
    id: 'teams.invitations.accept.prepareApproval', approval: {result: 'required'},
    title: 'Prepare Team invitation approval',
    description: 'Exchange an invitation bearer for Account-bound deferred-approval custody.',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    placements: [],
    surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: false, rpc: false },
    sideEffectClass: 'write',
    inputHints: { fields: [{ ...INVITATION_TOKEN_FIELD, required: true }] },
    inputSchema: TeamInvitationAcceptApprovalPrepareInputV1Schema,
    outputSchema: TeamInvitationAcceptApprovalPrepareResultV1Schema,
    projectObservationInput: redactObservationInputPaths('token'),
    serverTransport: { method: 'POST', path: '/v1/team-invitations/accept/prepare-approval' },
  },
  homeDomainActionRow({
    id: 'teams.invitations.accept', approval: {result: 'required',flow: 'deferred'},
    mcp: true,
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Accept Team invitation',
    description: 'Redeem an invitation bearer and join the Team as the authenticated Account.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'invitations', 'accept'],
    path: '/v1/team-invitations/accept',
    inputSchema: TeamInvitationAcceptInputV1Schema,
    outputSchema: TeamInvitationAcceptResultV1Schema,
    inputHints: { fields: [
      INVITATION_TOKEN_FIELD,
      approvalField('continuation.reference', 'Invitation continuation', { widget: 'secret' }),
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
    id: 'teams.identity.connections.list', approval: {result: 'required'},
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
    id: 'teams.identity.connections.create', approval: {result: 'required'},
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
    id: 'teams.identity.connections.settings.update', approval: {result: 'required'},
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
    id: 'teams.identity.connections.enable', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
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
    id: 'teams.identity.connections.disable', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
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
    id: 'teams.identity.connections.remove.preview', approval: {result: 'required'},
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
    id: 'teams.identity.connections.remove', approval: {result: 'required',flow: 'deferred'},
    irreversible: true,
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
    id: 'teams.identity.connections.test.start', approval: {result: 'required'},
    approvalPolicy: { uiConfirmation: 'direct' },
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
    id: 'teams.identity.connections.test.consume', approval: {result: 'required'},
    approvalPolicy: { uiConfirmation: 'direct' },
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
    id: 'teams.identity.workos.connection.create', approval: {result: 'required'},
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
    id: 'teams.identity.workos.adminPortalLink.create', approval: {result: 'required'},
    approvalPolicy: {
      uiConfirmation: 'direct',
      // Connection detail and existing-source directory setup review the portal.
      // First-time directory setup has no such review and keeps shared consent.
      uiConfirmationForInput: (input) => {
        const value = readRecord(input);
        return value.intent !== 'sso'
          && !(value.intent === 'dsync' && typeof value.directorySourceId === 'string' && value.directorySourceId.length > 0);
      },
    },
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
    id: 'teams.identity.workos.reconcile', approval: {result: 'required'},
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
    id: 'teams.identity.workos.connection.set', approval: {result: 'required'},
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
    id: 'teams.externalGroupBindings.list', approval: {result: 'required'},
    method: TEAM_EXTERNAL_GROUP_BINDING_ACTION_METHODS_V1['teams.externalGroupBindings.list'],
    path: TEAM_EXTERNAL_GROUP_BINDING_ACTION_PATHS_V1['teams.externalGroupBindings.list'],
    inputSchema: TEAM_EXTERNAL_GROUP_BINDING_ACTION_INPUT_SCHEMAS_V1['teams.externalGroupBindings.list'],
    outputSchema: TEAM_EXTERNAL_GROUP_BINDING_ACTION_OUTPUT_SCHEMAS_V1['teams.externalGroupBindings.list'],
    title: 'List external Group mappings',
    description: 'Page through the external Group mappings for one exact Team source.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['teams', 'external-group-bindings', 'list'],
    approvalPresentation: {
      inputHints: { fields: [
        TEAM_ID_FIELD,
        approvalChoiceField('ownerKind', 'Source', [
          { value: 'directory_source', label: 'Directory', labelKey: 'teams.authentication.directory.section' },
          { value: 'identity_connection', label: 'Sign-in connections', labelKey: 'teams.authentication.connectionsSection' },
        ]),
        approvalField('directorySourceId', 'Directory'),
        approvalField('teamIdentityConnectionId', 'Sign-in connection'),
        approvalField('limit', 'Limit', { widget: 'integer' }),
        approvalField('cursor', 'Cursor'),
      ] },
      technicalInputPaths: ['cursor'],
      referenceForField: (path, value, args) => {
        const { teamId } = readRecord(args);
        if (typeof value !== 'string' || typeof teamId !== 'string') return undefined;
        if (path === 'directorySourceId') return { kind: 'teamDirectorySource', id: value, teamId };
        if (path === 'teamIdentityConnectionId') return { kind: 'signInConnection', id: value, teamId };
        return undefined;
      },
    },
  }),
  teamExternalGroupBindingActionRow({
    id: 'teams.externalGroupBindings.set', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
    method: TEAM_EXTERNAL_GROUP_BINDING_ACTION_METHODS_V1['teams.externalGroupBindings.set'],
    path: TEAM_EXTERNAL_GROUP_BINDING_ACTION_PATHS_V1['teams.externalGroupBindings.set'],
    inputSchema: TEAM_EXTERNAL_GROUP_BINDING_ACTION_INPUT_SCHEMAS_V1['teams.externalGroupBindings.set'],
    outputSchema: TEAM_EXTERNAL_GROUP_BINDING_ACTION_OUTPUT_SCHEMAS_V1['teams.externalGroupBindings.set'],
    title: 'Set external Group mapping',
    description: 'Map one exact external Group into a directory-created or selected native Team Group.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'external-group-bindings', 'set'],
    approvalPresentation: {
      inputHints: { fields: [
        TEAM_ID_FIELD,
        approvalChoiceField('owner.kind', 'Source', [
          { value: 'directory_source', label: 'Directory', labelKey: 'teams.authentication.directory.section' },
          { value: 'identity_connection', label: 'Sign-in connections', labelKey: 'teams.authentication.connectionsSection' },
        ]),
        approvalField('owner.directorySourceId', 'Directory'),
        approvalField('owner.teamIdentityConnectionId', 'Sign-in connection'),
        approvalField('externalGroupId', 'External Group'),
        approvalChoiceField('target.kind', 'Mapping', [
          { value: 'directory_created', label: 'Create and manage a Team Group', labelKey: 'identityAdministration.mapCreate' },
          { value: 'native_target', label: 'Map to an existing Team Group', labelKey: 'identityAdministration.mapExisting' },
        ]),
        approvalField('target.teamGroupId', 'Team Group'),
      ] },
      referenceForField: (path, value, input) => {
        const { teamId, owner } = readRecord(input);
        if (typeof value !== 'string' || typeof teamId !== 'string') return;
        if (path === 'owner.directorySourceId') return { kind: 'teamDirectorySource', id: value, teamId };
        if (path === 'owner.teamIdentityConnectionId') return { kind: 'signInConnection', id: value, teamId };
        if (path === 'target.teamGroupId') return { kind: 'group', id: value, teamId };
        if (path === 'externalGroupId') {
          const { kind, directorySourceId } = readRecord(owner);
          return { kind: 'teamDirectoryGroup', id: value, teamId,
            ...(kind === 'directory_source' && typeof directorySourceId === 'string' ? { sourceId: directorySourceId } : {}) };
        }
      },
    },
  }),
  teamExternalGroupBindingActionRow({
    id: 'teams.externalGroupBindings.remove', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
    method: TEAM_EXTERNAL_GROUP_BINDING_ACTION_METHODS_V1['teams.externalGroupBindings.remove'],
    path: TEAM_EXTERNAL_GROUP_BINDING_ACTION_PATHS_V1['teams.externalGroupBindings.remove'],
    inputSchema: TEAM_EXTERNAL_GROUP_BINDING_ACTION_INPUT_SCHEMAS_V1['teams.externalGroupBindings.remove'],
    outputSchema: TEAM_EXTERNAL_GROUP_BINDING_ACTION_OUTPUT_SCHEMAS_V1['teams.externalGroupBindings.remove'],
    title: 'Remove external Group mapping',
    description: 'Remove one exact external Group contribution while preserving native and other-source facts.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'external-group-bindings', 'remove'],
    approvalPresentation: {
      inputHints: { fields: [TEAM_ID_FIELD, approvalField('bindingId', 'Group mapping')] },
      referenceForField: (path, value, input) => {
        const { teamId } = readRecord(input);
        if (path === 'bindingId' && typeof value === 'string' && typeof teamId === 'string') {
          return { kind: 'teamExternalGroupBinding', id: value, teamId };
        }
      },
    },
  }),
  teamProvisioningActionRow({
    id: 'teams.directory.sourceSetup.list', approval: {result: 'required'},
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
    id: 'teams.directory.sources.list', approval: {result: 'required'},
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
    id: 'teams.directory.sources.get', approval: {result: 'required'},
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
    id: 'teams.directory.people.list', approval: {result: 'required'},
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
    id: 'teams.directory.groups.list', approval: {result: 'required'},
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
    id: 'teams.directory.sources.create', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
    method: 'POST',
    path: TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.sources.create'],
    inputSchema: TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.create'],
    outputSchema: TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.create'],
    title: 'Create Team directory source',
    description: 'Configure one exact verified WorkOS directory or GitHub organization source.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'directory', 'sources', 'create'],
    approvalPresentation: {
      ...directoryApprovalPresentation,
      inputHints: { fields: [
        TEAM_ID_FIELD,
        approvalChoiceField('kind', 'Source', [
          { value: 'workos_directory', label: 'WorkOS', labelKey: 'teams.authentication.directory.kind.workos' },
          { value: 'github_organization', label: 'GitHub', labelKey: 'teams.authentication.directory.kind.github' },
        ]),
        approvalField('displayName', 'Name'),
        approvalField('teamIdentityConnectionId', 'Sign-in connection'),
        approvalField('githubAppInstallationId', 'GitHub installation ID'),
        approvalField('workosDirectoryId', 'WorkOS directory ID'),
      ] },
      technicalInputPaths: ['githubAppInstallationId', 'workosDirectoryId'],
    },
  }),
  teamProvisioningActionRow({
    id: 'teams.directory.sources.sync', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
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
    id: 'teams.directory.sources.pause', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
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
    id: 'teams.directory.sources.resume', approval: {result: 'required',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
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
    id: 'teams.directory.sources.remove.preview', approval: {result: 'required'},
    approvalPolicy: { requiredSurfaces: ['agent', 'mcp', 'plugin'] },
    mcp: true,
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
    id: 'teams.directory.sources.remove', approval: {result: 'required',flow: 'deferred'},
    irreversible: true,
    method: 'DELETE',
    path: TEAM_DIRECTORY_ACTION_PATHS_V1['teams.directory.sources.remove'],
    inputSchema: TEAM_DIRECTORY_ACTION_INPUT_SCHEMAS_V1['teams.directory.sources.remove'],
    outputSchema: TEAM_DIRECTORY_ACTION_OUTPUT_SCHEMAS_V1['teams.directory.sources.remove'],
    title: 'Remove Team directory source',
    description: 'Atomically revoke this source\'s native facts and remove its stored projection.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['teams', 'directory', 'sources', 'remove'],
    // Exact API automation exception; the shared danger/approval policy and
    // current Team-domain authorization still govern the effect.
    presentUser: false,
    mcp: true,
    // `remove.preview` occupies the `remove` SDK namespace, so the mutation takes the
    // sibling `remove.execute` path exactly like the identity-connection removal above.
    sdkMethod: 'teams.directory.sources.remove.execute',
  }),
]) satisfies readonly PreNormalizedActionSpec[];
}

export const TEAM_ACTION_SPECS: TeamActionSpecs = lazyActionSpecArray(createTeamActionSpecs);
