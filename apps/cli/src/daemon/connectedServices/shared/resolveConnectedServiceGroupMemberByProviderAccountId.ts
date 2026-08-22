type ConnectedServiceGroupMemberIdentityCandidate = Readonly<{ profileId: string }>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function resolveConnectedServiceGroupMemberByProviderAccountId(input: Readonly<{
  providerAccountId: string;
  members: readonly ConnectedServiceGroupMemberIdentityCandidate[];
  resolveProviderAccountId: (profileId: string) => Promise<string | null>;
}>): Promise<string | null> {
  const providerAccountId = readNonEmptyString(input.providerAccountId);
  if (!providerAccountId) return null;
  const matches: string[] = [];
  for (const member of input.members) {
    const profileId = readNonEmptyString(member.profileId);
    if (!profileId) continue;
    try {
      if (readNonEmptyString(await input.resolveProviderAccountId(profileId)) === providerAccountId) {
        matches.push(profileId);
      }
    } catch {
      // An unreadable member is not a match; uniqueness still has to be proven.
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
