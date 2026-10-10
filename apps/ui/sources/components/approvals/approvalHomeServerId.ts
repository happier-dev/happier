import { resolveServerProfileForPortableIdentity } from '@/sync/domains/server/serverProfiles';

/**
 * The Home an approval belongs to, as this device addresses it.
 *
 * A request records the Home that asked twice: `serverId` is the asking device's own profile id for
 * it, and `serverIdentityId` is the Home's portable identity. Only the identity means the same thing
 * on every device, so it is resolved to this device's profile first; the recorded id is the fallback
 * for requests that carry no identity (or a Home this device does not know).
 */
export function resolveApprovalHomeServerId(
  origin: Readonly<Record<string, unknown>> | null | undefined,
): string {
  const identity =
    typeof origin?.serverIdentityId === 'string'
      ? origin.serverIdentityId.trim()
      : '';
  if (identity) {
    const resolution = resolveServerProfileForPortableIdentity(identity);
    if (resolution.kind === 'resolved') return resolution.profile.id;
  }
  return typeof origin?.serverId === 'string' ? origin.serverId.trim() : '';
}
