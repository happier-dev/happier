export type ConnectedServiceGroupMemberProviderAccountIdentity = Readonly<{
  providerAccountId: string | null;
  providerOrganizationId?: string | null;
}>;

type ConnectedServiceGroupMemberIdentityCandidate = Readonly<{ profileId: string }>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function resolveConnectedServiceGroupMemberByProviderAccountId(input: Readonly<{
  providerAccountId?: string | null;
  providerOrganizationId?: string | null;
  members: readonly ConnectedServiceGroupMemberIdentityCandidate[];
  resolveProviderAccountIdentity: (profileId: string) => Promise<ConnectedServiceGroupMemberProviderAccountIdentity | null>;
}>): Promise<string | null> {
  const providerAccountId = readNonEmptyString(input.providerAccountId);
  const providerOrganizationId = readNonEmptyString(input.providerOrganizationId);
  if (!providerAccountId && !providerOrganizationId) return null;
  const matches: string[] = [];
  for (const member of input.members) {
    const profileId = readNonEmptyString(member.profileId);
    if (!profileId) continue;
    try {
      const identity = await input.resolveProviderAccountIdentity(profileId);
      if (!identity && !providerAccountId) return null;
      if (identity && (!providerAccountId || readNonEmptyString(identity.providerAccountId) === providerAccountId)
        && (providerOrganizationId === null || readNonEmptyString(identity?.providerOrganizationId) === providerOrganizationId)) {
        matches.push(profileId);
      }
    } catch {
      if (!providerAccountId) return null;
      // An unreadable member is not a match; uniqueness still has to be proven.
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
