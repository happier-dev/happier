import { connectedServiceUsageRequiresOrganizationId, ConnectedServiceIdSchema } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';
import type { ConnectedServiceRuntimeFailureClassification } from './types';
import { resolveConnectedServiceGroupMemberByProviderAccountId, type ConnectedServiceGroupMemberProviderAccountIdentity } from '../shared/resolveConnectedServiceGroupMemberByProviderAccountId';

type RuntimeAuthFailureGroupMember = Readonly<{
  profileId: string;
  enabled: boolean;
}>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Reconcile immutable launch metadata with provider-qualified account evidence.
 *
 * Shared provider auth surfaces can advance while a long-lived runner keeps its original
 * selection environment. The provider account context observed from the live auth surface
 * identifies the failed member only when it uniquely matches current credentials. Unknown or
 * ambiguous context cannot authorize the launch tuple. Group generation and credential revision
 * are removed when the matching member differs; exact-runtime providers can then re-establish
 * their stronger tuple through their existing live-source resolver.
 */
export async function resolveRuntimeAuthFailureSourceProfile(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  getGroupMembers: () => Promise<readonly RuntimeAuthFailureGroupMember[] | null>;
  resolveProviderAccountIdentity: (profileId: string) => Promise<ConnectedServiceGroupMemberProviderAccountIdentity | null>;
}>): Promise<ConnectedServiceRuntimeFailureClassification> {
  const groupId = readNonEmptyString(input.classification.groupId);
  const sourceProviderAccountId = readNonEmptyString(input.classification.sourceProviderAccountId);
  const hasProviderEvidence = input.classification.providerReportedOrganizationId !== undefined;
  if (!groupId || (!sourceProviderAccountId && !hasProviderEvidence)) return input.classification;

  const unattributed = {
    ...input.classification,
    profileId: null,
    groupGeneration: null,
    credentialRevision: null,
  };
  const providerReportedOrganizationId = readNonEmptyString(input.classification.providerReportedOrganizationId);
  const capturedOrganizationId = readNonEmptyString(input.classification.sourceProviderOrganizationId);
  const unproven = (reason: string) => {
    logger.warnFile('[CONNECTED SERVICE] Runtime failure account attribution unproven; quota probe required', {
      serviceId: input.classification.serviceId, groupId,
      reportedProfileId: input.classification.profileId,
      sourceProviderOrganizationId: capturedOrganizationId,
      providerReportedOrganizationId, reason,
    });
    return unattributed;
  };
  if (hasProviderEvidence && !providerReportedOrganizationId) return unproven('provider_organization_unknown');
  if (providerReportedOrganizationId && capturedOrganizationId && providerReportedOrganizationId !== capturedOrganizationId) {
    return unproven('provider_organization_mismatch');
  }
  const serviceId = ConnectedServiceIdSchema.safeParse(input.classification.serviceId);
  if (
    input.classification.kind === 'usage_limit'
    && !capturedOrganizationId && !providerReportedOrganizationId
    && serviceId.success
    && connectedServiceUsageRequiresOrganizationId(serviceId.data)
  ) return unproven('source_organization_unknown');
  let members: readonly RuntimeAuthFailureGroupMember[] | null;
  try {
    members = await input.getGroupMembers();
  } catch {
    return unproven('group_read_failed');
  }
  if (!members || members.length === 0) return unproven('group_members_unavailable');

  const sourceProfileId = await resolveConnectedServiceGroupMemberByProviderAccountId({
    providerAccountId: hasProviderEvidence ? null : sourceProviderAccountId,
    providerOrganizationId: providerReportedOrganizationId ?? capturedOrganizationId,
    members,
    resolveProviderAccountIdentity: input.resolveProviderAccountIdentity,
  });
  if (!sourceProfileId) return unproven('member_identity_ambiguous_or_unknown');
  if (sourceProfileId === readNonEmptyString(input.classification.profileId)) {
    return input.classification;
  }
  return {
    ...input.classification,
    profileId: sourceProfileId,
    groupGeneration: null,
    credentialRevision: null,
  };
}
