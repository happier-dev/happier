import type { ConnectedServiceRuntimeFailureClassification } from './types';
import { resolveConnectedServiceGroupMemberByProviderAccountId } from '../shared/resolveConnectedServiceGroupMemberByProviderAccountId';

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
 * selection environment. The provider account id observed from the live auth surface identifies
 * the failed member; group generation and credential revision do not, so they are removed when
 * the provider-qualified member differs from the launch tuple. Exact-runtime providers can then
 * re-establish their stronger tuple through their existing live-source resolver.
 */
export async function resolveRuntimeAuthFailureSourceProfile(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  getGroupMembers: () => Promise<readonly RuntimeAuthFailureGroupMember[] | null>;
  resolveProviderAccountId: (profileId: string) => Promise<string | null>;
}>): Promise<ConnectedServiceRuntimeFailureClassification> {
  const groupId = readNonEmptyString(input.classification.groupId);
  const sourceProviderAccountId = readNonEmptyString(input.classification.sourceProviderAccountId);
  if (!groupId || !sourceProviderAccountId) return input.classification;

  let members: readonly RuntimeAuthFailureGroupMember[] | null;
  try {
    members = await input.getGroupMembers();
  } catch {
    return input.classification;
  }
  if (!members || members.length === 0) return input.classification;

  const sourceProfileId = await resolveConnectedServiceGroupMemberByProviderAccountId({
    providerAccountId: sourceProviderAccountId,
    members,
    resolveProviderAccountId: input.resolveProviderAccountId,
  });
  if (!sourceProfileId) return input.classification;
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
