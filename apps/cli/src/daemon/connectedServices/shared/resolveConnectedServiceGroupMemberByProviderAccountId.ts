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
  // Native transcript evidence may attest only an organization. It identifies a member only
  // when that organization is unique across the pool (including disabled members).
  if (!providerAccountId && !providerOrganizationId) return null;
  const matches: string[] = [];
  for (const member of input.members) {
    const profileId = readNonEmptyString(member.profileId);
    if (!profileId) continue;
    try {
      const identity = await input.resolveProviderAccountIdentity(profileId);
      if (!identity && !providerAccountId) return null;
      if (identity && (!providerAccountId || readNonEmptyString(identity.providerAccountId) === providerAccountId)) {
        // An account-only observation cannot attest an organization-bearing quota context.
        if (readNonEmptyString(identity?.providerOrganizationId) !== providerOrganizationId) continue;
        matches.push(profileId);
      }
    } catch {
      if (!providerAccountId) return null;
      // An unreadable member contributes no positive match. Readable duplicate identities still
      // remain ambiguous for account-qualified evidence. Organization-only evidence cannot
      // establish uniqueness while another member's identity is unknown.
    }
  }
  return matches.length === 1 ? matches[0] ?? null : null;
}
