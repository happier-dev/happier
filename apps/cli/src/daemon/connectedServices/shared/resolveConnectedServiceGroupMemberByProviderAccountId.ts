export type ConnectedServiceGroupMemberProviderAccountIdentity = Readonly<{
  providerAccountId: string | null;
  providerOrganizationId?: string | null;
}>;

type ConnectedServiceGroupMemberIdentityCandidate = Readonly<{ profileId: string }>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function resolveConnectedServiceGroupMemberByProviderAccountId(input: Readonly<{
  providerAccountId: string;
  providerOrganizationId?: string | null;
  members: readonly ConnectedServiceGroupMemberIdentityCandidate[];
  resolveProviderAccountIdentity: (profileId: string) => Promise<ConnectedServiceGroupMemberProviderAccountIdentity | null>;
}>): Promise<string | null> {
  const providerAccountId = readNonEmptyString(input.providerAccountId);
  if (!providerAccountId) return null;
  const providerOrganizationId = readNonEmptyString(input.providerOrganizationId);
  const matches: string[] = [];
  for (const member of input.members) {
    const profileId = readNonEmptyString(member.profileId);
    if (!profileId) continue;
    try {
      const identity = await input.resolveProviderAccountIdentity(profileId);
      if (readNonEmptyString(identity?.providerAccountId) === providerAccountId) {
        // An account-only observation cannot attest an organization-bearing quota context.
        if (readNonEmptyString(identity?.providerOrganizationId) !== providerOrganizationId) continue;
        matches.push(profileId);
      }
    } catch {
      // An unreadable member contributes no positive match. Readable duplicate identities still
      // remain ambiguous, without making an unrelated credential outage veto the live identity.
    }
  }
  return matches.length === 1 ? matches[0] ?? null : null;
}
