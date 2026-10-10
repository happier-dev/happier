import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/** Omitted Home belongs to the admitted Account; an explicit foreign Home never does. */
export function isPromptLibraryReferenceInHome(
  reference: Readonly<{ artifactId: string; serverId?: string }>,
  artifactId: string,
  serverId?: string,
): boolean {
  return reference.artifactId === artifactId.trim()
    && (!reference.serverId || Boolean(serverId && areServerProfileIdentifiersEquivalent(reference.serverId, serverId)));
}
