import { resolveServerProfileForPortableIdentity } from '@/sync/domains/server/serverProfiles';

export type ApprovalReplayRoute = Readonly<{
  serverId: string;
  serverIdentityId: string;
  originServerId: string;
}>;

/** Resolve captured approval authority through this device's established Home binding. */
export function resolveApprovalReplayRoute(approval: Readonly<{
  v: number;
  executionOriginV1?: Readonly<{ serverId: string; serverIdentityId?: string }>;
}> | null): ApprovalReplayRoute | null {
  if (!approval?.executionOriginV1) return null;
  const originServerId = approval.executionOriginV1.serverId.trim();
  const serverIdentityId = approval.executionOriginV1.serverIdentityId?.trim() ?? '';
  if (!originServerId || !serverIdentityId) return null;
  const resolution = resolveServerProfileForPortableIdentity(serverIdentityId);
  if (resolution.kind !== 'resolved' || resolution.profile.serverIdentityId?.trim() !== serverIdentityId) return null;
  return { serverId: resolution.profile.id, serverIdentityId, originServerId };
}
