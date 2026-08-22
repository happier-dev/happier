import type { ConnectedServiceRuntimeFailureClassification } from './types';
import { resolveConnectedServiceGroupMemberByProviderAccountId } from '../shared/resolveConnectedServiceGroupMemberByProviderAccountId';

type RuntimeAuthFailureGroupMember = Readonly<{ profileId: string }>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

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
  if (!members?.length) return input.classification;

  const sourceProfileId = await resolveConnectedServiceGroupMemberByProviderAccountId({
    providerAccountId: sourceProviderAccountId,
    members,
    resolveProviderAccountId: input.resolveProviderAccountId,
  });
  if (!sourceProfileId) return input.classification;
  if (sourceProfileId === readNonEmptyString(input.classification.profileId)) return input.classification;
  return {
    ...input.classification,
    profileId: sourceProfileId,
    groupGeneration: null,
    expectedCredentialRevision: null,
  };
}
