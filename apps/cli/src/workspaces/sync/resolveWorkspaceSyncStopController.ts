import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveWorkspaceSyncExecutionMachineIdV1, resolveWorkspaceSyncReadControllerV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { isWorkspaceSyncRelationshipControlActionId, WORKSPACE_SYNC_RELATIONSHIP_CONTROL_ACTION_RPC_METHODS } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteFailure, ExternalActionTargetV1 } from '@happier-dev/protocol/actions';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { WorkspaceSyncRelationshipTerminateActionInputV1Schema, type WorkspaceSyncRelationshipTerminateActionInputV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readRequesterHomeWithinActionLifetime } from '@/daemon/sessionEncryption/requesterCurrentness';
import type { StoredCredentials } from '@/persistence';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';

type WorkspaceSyncStopPlacement = Readonly<{
  ok: true;
  input: WorkspaceSyncRelationshipTerminateActionInputV1;
  target: Extract<ExternalActionTargetV1, { kind: 'machine' }>;
}> | ActionExecuteFailure;

export function isWorkspaceSyncStopAction(actionId: string): boolean {
  return isWorkspaceSyncRelationshipControlActionId(actionId)
    && WORKSPACE_SYNC_RELATIONSHIP_CONTROL_ACTION_RPC_METHODS[actionId] === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE;
}

/** Rebind an original Stop to its controller before the requester records Ask. */
export async function prepareWorkspaceSyncStopPlacement(input: Readonly<{
  rawInput: unknown;
  credentials: StoredCredentials;
  serverId: string;
  serverHttpBaseUrl: string;
  machineId?: string;
  target?: ExternalActionTargetV1;
  signal?: AbortSignal;
  readWithinActionLifetime?: boolean;
}>): Promise<WorkspaceSyncStopPlacement | null> {
  const parsed = WorkspaceSyncRelationshipTerminateActionInputV1Schema.safeParse(input.rawInput);
  if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  const nominatedMachineId = parsed.data.controllerMachineId;
  try {
    const readController = () => resolveWorkspaceSyncStopController({
      credentials: input.credentials, serverId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl,
      relationshipId: parsed.data.relationshipId, nominatedMachineId, signal: input.signal,
    });
    const controllerMachineId = input.readWithinActionLifetime
      ? await readRequesterHomeWithinActionLifetime(readController, input.signal)
      : await readController();
    const rebound = controllerMachineId !== nominatedMachineId;
    const canAddressController = (id: string) => id === nominatedMachineId || id === controllerMachineId;
    // An explicit target binds every Stop. The local Machine hint only constrains rebinding.
    if ((input.target && (input.target.kind !== 'machine' || !canAddressController(input.target.machineId)))
      || (rebound && input.machineId && !canAddressController(input.machineId))) {
      return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    }
    if (!rebound) return null;
    return { ok: true, input: { ...parsed.data, controllerMachineId },
      target: { kind: 'machine', machineId: controllerMachineId } };
  } catch (error) {
    return { ok: false, ...normalizeActionExecutorThrownError(error, 'workspace_sync.stop.placement',
      input.signal?.aborted ? 'cancelled' : 'target_unavailable'), effectAttempted: false };
  }
}

/** An installed endpoint can initiate Stop. The admitted request runs on the link's controller. */
async function resolveWorkspaceSyncStopController(input: Readonly<{
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
  // Keep the addressed controller's idempotent handling when the relationship
  // is absent. The controller owns the live decision, including paused links.
  if (!relationship || relationship.controllerMachineId === input.nominatedMachineId) {
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
