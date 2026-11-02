import type { ActiveProjectAccountRowsSnapshot } from './projectAccountRows';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';

/** A projection lifetime is local-profile scoped; workspace addresses are portable Home identities. */
export function readMachineProjectWorkspaceRefs(
  snapshot: Pick<ActiveProjectAccountRowsSnapshot, 'scopeKey' | 'workspaceRefs'> | null,
  target: Readonly<{ scopeKey: string; serverId: string; homeServerIdentityId: string | null; machineId: string }>,
): ActiveProjectAccountRowsSnapshot['workspaceRefs'] | null {
  if (snapshot?.scopeKey !== target.scopeKey) return null;
  return snapshot.workspaceRefs.filter(ref => ref.machineId === target.machineId
    && areServerProfileIdentifiersEquivalent(ref.serverId, target.serverId,
      id => id === target.serverId || id === target.homeServerIdentityId ? target.homeServerIdentityId : undefined));
}
