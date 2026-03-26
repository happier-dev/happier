import { assertSafeWorkspaceReplicationPackId } from '../../../workspaces/replication/transport/workspaceReplicationPackId';

export function assertSafeHandoffWorkspaceReplicationPackId(packId: string): void {
  // Keep RPC handlers dependent on the adapter seam, not on replication transport internals directly.
  assertSafeWorkspaceReplicationPackId(packId);
}
