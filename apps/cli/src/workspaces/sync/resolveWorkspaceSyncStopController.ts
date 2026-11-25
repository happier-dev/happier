import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveWorkspaceSyncExecutionMachineIdV1, resolveWorkspaceSyncReadControllerV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';

/** An installed endpoint can initiate Stop. The admitted request runs on the link's controller. */
export async function resolveWorkspaceSyncStopController(input: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  serverHttpBaseUrl: string;
  relationshipId: string;
  nominatedMachineId: string;
  signal?: AbortSignal;
}>): Promise<string> {
  const { workspaceRefs, relationships } = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () =>
    readProjectAccountRows({
      credentials: input.credentials,
      serverId: input.serverId,
      selection: { kinds: ['workspace-ref', 'relationship-graph'] },
      ...(input.signal ? { signal: input.signal } : {}),
    }));
  const relationship = relationships.find(row => row.relationshipId === input.relationshipId);
  // Retain the addressed controller's existing idempotent handling when this
  // observation does not have a committed route.
  if (relationship?.committedAtMs == null || relationship.controllerMachineId === input.nominatedMachineId) {
    return input.nominatedMachineId;
  }
  const isEndpoint = [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId].some(id => {
    const endpoint = resolveWorkspaceRefV1(workspaceRefs, { id, serverId: input.serverId });
    return endpoint.kind === 'resolved'
      && resolveWorkspaceSyncExecutionMachineIdV1(endpoint.ref) === input.nominatedMachineId;
  });
  if (!isEndpoint) throw Object.assign(new Error('The nominated Machine does not host this Sync link'), { code: 'target_unavailable' });
  return resolveWorkspaceSyncReadControllerV1({
    serverId: input.serverId, workspaceRefs, relationships, relationshipId: input.relationshipId,
  });
}
