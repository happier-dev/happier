import type { ConnectedServiceRuntimeFailureClassification } from './types';
import { logger } from '@/ui/logger';
import { resolveConnectedServiceGroupMemberByProviderAccountId, type ConnectedServiceGroupMemberProviderAccountIdentity } from '../shared/resolveConnectedServiceGroupMemberByProviderAccountId';

type RuntimeAuthFailureGroupMember = Readonly<{ profileId: string }>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function resolveRuntimeAuthFailureSourceProfile(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  requiresProviderOrganizationId?: boolean;
  getGroupMembers: () => Promise<readonly RuntimeAuthFailureGroupMember[] | null>;
  resolveProviderAccountIdentity: (profileId: string) => Promise<ConnectedServiceGroupMemberProviderAccountIdentity | null>;
}>): Promise<ConnectedServiceRuntimeFailureClassification> {
  const groupId = readNonEmptyString(input.classification.groupId);
  const sourceProviderAccountId = readNonEmptyString(input.classification.sourceProviderAccountId);
  const hasProviderEvidence = input.classification.providerReportedOrganizationId !== undefined;
  if (!groupId || (!sourceProviderAccountId && !hasProviderEvidence)) return input.classification;
  const unattributed = { ...input.classification, profileId: null, groupGeneration: null, expectedCredentialRevision: null };
  const providerReportedOrganizationId = readNonEmptyString(input.classification.providerReportedOrganizationId);
  const capturedOrganizationId = readNonEmptyString(input.classification.sourceProviderOrganizationId);
  const unproven = (reason: string) => {
    logger.warnLocalFile('[CONNECTED SERVICE] Runtime failure account attribution unproven; quota probe required', {
      serviceId: input.classification.serviceId, groupId, reportedProfileId: input.classification.profileId,
      sourceProviderOrganizationId: capturedOrganizationId, providerReportedOrganizationId, reason,
    });
    return unattributed;
  };
  if (hasProviderEvidence && !providerReportedOrganizationId) return unproven('provider_organization_unknown');
  if (providerReportedOrganizationId && capturedOrganizationId && providerReportedOrganizationId !== capturedOrganizationId) {
    return unproven('provider_organization_mismatch');
  }
  if (input.classification.kind === 'usage_limit' && input.requiresProviderOrganizationId
    && !capturedOrganizationId && !providerReportedOrganizationId) return unproven('source_organization_unknown');
  let members: readonly RuntimeAuthFailureGroupMember[] | null;
  try {
    members = await input.getGroupMembers();
  } catch {
    return unproven('group_read_failed');
  }
  if (!members?.length) return unproven('group_members_unavailable');

  const sourceProfileId = await resolveConnectedServiceGroupMemberByProviderAccountId({
    providerAccountId: hasProviderEvidence ? null : sourceProviderAccountId,
    providerOrganizationId: providerReportedOrganizationId ?? capturedOrganizationId,
    members,
    resolveProviderAccountIdentity: input.resolveProviderAccountIdentity,
  });
  if (!sourceProfileId) return unproven('member_identity_ambiguous_or_unknown');
  if (sourceProfileId === readNonEmptyString(input.classification.profileId)) return input.classification;
  return {
    ...input.classification,
    profileId: sourceProfileId,
    groupGeneration: null,
    expectedCredentialRevision: null,
  };
}
