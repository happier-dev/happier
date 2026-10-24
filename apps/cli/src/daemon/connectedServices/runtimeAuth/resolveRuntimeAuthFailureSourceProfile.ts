import { connectedServiceUsageRequiresOrganizationId, ConnectedServiceIdSchema } from '@happier-dev/protocol';
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
  if (!groupId || !sourceProviderAccountId) return input.classification;

  const unattributed = {
    ...input.classification,
    profileId: null,
    groupGeneration: null,
    credentialRevision: null,
  };
  const serviceId = ConnectedServiceIdSchema.safeParse(input.classification.serviceId);
  if (
    input.classification.kind === 'usage_limit'
    && !readNonEmptyString(input.classification.sourceProviderOrganizationId)
    && serviceId.success
    && connectedServiceUsageRequiresOrganizationId(serviceId.data)
  ) return unattributed;
  let members: readonly RuntimeAuthFailureGroupMember[] | null;
  try {
    members = await input.getGroupMembers();
  } catch {
    return unattributed;
  }
  if (!members || members.length === 0) return unattributed;

  const sourceProfileId = await resolveConnectedServiceGroupMemberByProviderAccountId({
    providerAccountId: sourceProviderAccountId,
    providerOrganizationId: input.classification.sourceProviderOrganizationId,
    members,
    resolveProviderAccountIdentity: input.resolveProviderAccountIdentity,
  });
  if (!sourceProfileId) return unattributed;
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
