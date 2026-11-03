import type { CliActionDepsParams } from './types';
import type { CliMachineActionCall } from './machineTransport';
import type { CliProjectAdmission } from './projectAdmission';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { WorkspaceSyncRelationshipsListRpcResultV1Schema, WorkspaceSyncConflictPageV1Schema, WorkspaceSyncConflictInspectRpcResultV1Schema, WorkspaceSyncConflictResolutionResultV1Schema, WorkspaceSyncRelationshipIdV1Schema, WorkspaceSyncStatusV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { resolveWorkspaceSyncReadControllerV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';
import type { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
export function createCliWorkspaceSyncActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'serverIdentityId'>,
  { actionHomeId, callMachineAction, normalizeStringValue, notSupported, projectHomeAdmission, projectHomeId, readProjectRows, readRecord, resolveProjectHomeIdentity }: Readonly<{
    actionHomeId: string;
    callMachineAction: CliMachineActionCall;
    normalizeStringValue: (value: unknown) => string | null;
    notSupported: () => never;
    projectHomeAdmission: CliProjectAdmission['projectHomeAdmission'];
    projectHomeId: string;
    readProjectRows: CliProjectAdmission['readProjectRows'];
    readRecord: (value: unknown) => Record<string, unknown>;
    resolveProjectHomeIdentity: CliProjectAdmission['resolveProjectHomeIdentity'];
  }>,
): Pick<ActionExecutorDeps, 'workspaceSyncRelationshipObserveCreation' | 'workspaceSyncRelationshipCreate' | 'workspaceSyncRelationshipTerminate' | 'workspaceSyncRelationshipDisable' | 'workspaceSyncRelationshipEnable' | 'workspaceSyncRelationshipFlush' | 'workspaceSyncConflictResolve' | 'workspaceSyncRelationshipsList' | 'workspaceSyncConflictsList' | 'workspaceSyncConflictInspect'> {

  const resolveWorkspaceSyncReadController = async (input: Readonly<{
    controllerMachineId?: string;
    workspaceRefId?: string;
    relationshipId?: string;
  }>, signal?: AbortSignal): Promise<string> => {
    if (!params.credentials) {
      throw Object.assign(new Error('Workspace sync read requires an authenticated Account'), { code: 'not_authenticated' });
    }
    const current = await readProjectRows({ kinds: ['workspace-ref', 'relationship-graph'] }, signal);
    const workspaceRefs = current.workspaceRefs;
    const relationships = current.relationships;
    const relationship = input.relationshipId ? relationships.find(entry => entry.relationshipId === input.relationshipId) : undefined;
    const selectedRefId = input.workspaceRefId ?? relationship?.alphaWorkspaceRefId;
    const { resolveWorkspaceRefById } = await import("@/workspaces/workspaceRefsV1");
    const selectedRef = selectedRefId ? resolveWorkspaceRefById(workspaceRefs, selectedRefId, params.serverIdentityId ?? projectHomeId)
      ?? resolveWorkspaceRefById(workspaceRefs, selectedRefId) : null;
    const currentServerId = selectedRef?.serverId ?? params.serverIdentityId ?? projectHomeId;
    const denied = await projectHomeAdmission(currentServerId);
    if (denied) throw Object.assign(new Error(denied.errorCode), { code: denied.errorCode });
    return resolveWorkspaceSyncReadControllerV1({ ...input, workspaceRefs, relationships, serverId: currentServerId });
  };
  return {
    workspaceSyncRelationshipObserveCreation: async ({ input, operationId, serverId, signal }) => {
      const denied = await projectHomeAdmission(serverId);
      if (denied) throw Object.assign(new Error(denied.errorCode), { code: denied.errorCode });
      const homeIdentityId = await resolveProjectHomeIdentity();
      const rows = await readProjectRows({ kinds: ['workspace-ref'], serverId: homeIdentityId }, signal);
      const { resolveWorkspaceRefById } = await import('@/workspaces/workspaceRefsV1');
      const source = resolveWorkspaceRefById(rows.workspaceRefs, input.sourceWorkspaceRefId, homeIdentityId);
      if (!source) throw Object.assign(new Error('workspace_ref_not_ready'), { code: 'workspace_ref_not_ready' });
      const { WorkspaceSyncRelationshipCreationObservationV1Schema } = await import('@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas');
      return WorkspaceSyncRelationshipCreationObservationV1Schema.parse(await callMachineAction({ machineId: source.machineId,
        serverId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATION_OBSERVE,
        request: { v: 1, operationId, actionInput: input }, exactMachine: true, ...(signal ? { signal } : {}) }));
    },
    workspaceSyncRelationshipCreate: async ({
      input,
      operationId,
      serverIdentityId,
      serverId,
      targetReplacementApproval,
      targetReplacementApprovalReceiptId,
      context,
      signal,
    }) => {
      if (!params.credentials) return notSupported();
      // Linking runs on the machine that hosts the selected source Workspace.
      // Its address comes from current Account rows, never from the caller.
      const requestedServerId = normalizeStringValue(serverId);
      const denied = await projectHomeAdmission(requestedServerId ?? actionHomeId);
      if (denied) return denied;
      // Action contexts carry a device-local profile in `serverId`, while
      // WorkspaceRefs are keyed by the stable Home identity when available.
      // Admission accepts either identifier; domain lookup must use the Home.
      const currentServerId = normalizeStringValue(serverIdentityId) ?? await resolveProjectHomeIdentity();
      const rows = await readProjectRows({ kinds: ['workspace-ref'], serverId: currentServerId }, signal);
      const { resolveWorkspaceRefById } = await import('@/workspaces/workspaceRefsV1');
      const source = resolveWorkspaceRefById(rows.workspaceRefs, input.sourceWorkspaceRefId, currentServerId)
        ?? (serverId === undefined && params.serverIdentityId === undefined
          ? resolveWorkspaceRefById(rows.workspaceRefs, input.sourceWorkspaceRefId) : null);
      if (!source) {
        return { ok: false, errorCode: 'workspace_ref_not_ready', error: 'workspace_ref_not_ready' };
      }
      const sourceDenied = await projectHomeAdmission(source.serverId);
      if (sourceDenied) return sourceDenied;
      return await callMachineAction({
        machineId: source.machineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE,
        request: {
          v: 1,
          operationId,
          actionInput: input,
          ...(targetReplacementApproval && targetReplacementApprovalReceiptId
            ? { targetReplacementApproval, targetReplacementApprovalReceiptId }
            : {}),
        },
        context,
        effectActionId: 'workspace.sync.relationship.create',
        exactMachine: true,
        ...(signal ? { signal } : {}),
      });
    },
    workspaceSyncRelationshipTerminate: async ({ input, serverId, signal }) => {
      if (!params.credentials) return notSupported();
      const denied = await projectHomeAdmission(serverId ?? actionHomeId);
      if (denied) return denied;
      const response = await callMachineAction({
        machineId: input.controllerMachineId,
        serverId: actionHomeId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE,
        request: WorkspaceSyncRelationshipIdV1Schema.parse({ relationshipId: input.relationshipId }),
        exactMachine: true,
        ...(signal ? { signal } : {}),
      });
      if (readRecord(response).ok !== true) throw Object.assign(new Error('Invalid Workspace Sync terminate response'), { code: 'action_failed' });
      return { v: 1 as const, relationshipId: input.relationshipId, terminated: true as const };
    },
    workspaceSyncRelationshipDisable: async ({ input, serverId, signal }) => {
      if (!params.credentials) return notSupported();
      const denied = await projectHomeAdmission(serverId ?? actionHomeId);
      if (denied) return denied;
      const response = await callMachineAction({
        machineId: input.controllerMachineId,
        serverId: actionHomeId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_PAUSE,
        request: WorkspaceSyncRelationshipIdV1Schema.parse({ relationshipId: input.relationshipId }),
        exactMachine: true,
        ...(signal ? { signal } : {}),
      });
      if (readRecord(response).ok !== true) throw Object.assign(new Error('Invalid Workspace Sync pause response'), { code: 'action_failed' });
      return { v: 1 as const, relationshipId: input.relationshipId, enabled: false as const };
    },
    workspaceSyncRelationshipEnable: async ({ input, serverId, signal }) => {
      if (!params.credentials) return notSupported();
      const denied = await projectHomeAdmission(serverId ?? actionHomeId);
      if (denied) return denied;
      const response = await callMachineAction({
        machineId: input.controllerMachineId,
        serverId: actionHomeId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_RESUME,
        request: WorkspaceSyncRelationshipIdV1Schema.parse({ relationshipId: input.relationshipId }),
        exactMachine: true,
        ...(signal ? { signal } : {}),
      });
      if (readRecord(response).ok !== true) throw Object.assign(new Error('Invalid Workspace Sync resume response'), { code: 'action_failed' });
      return { v: 1 as const, relationshipId: input.relationshipId, enabled: true as const };
    },
    workspaceSyncRelationshipFlush: async ({ input, serverId, signal }) => {
      if (!params.credentials) return notSupported();
      const denied = await projectHomeAdmission(serverId ?? actionHomeId);
      if (denied) return denied;
      const response = await callMachineAction({
        machineId: input.controllerMachineId,
        serverId: actionHomeId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH,
        request: WorkspaceSyncRelationshipIdV1Schema.parse({ relationshipId: input.relationshipId }),
        exactMachine: true,
        ...(signal ? { signal } : {}),
      });
      return { v: 1 as const, relationshipId: input.relationshipId,
        status: WorkspaceSyncStatusV1Schema.parse(readRecord(response).status) };
    },
    workspaceSyncConflictResolve: async ({ actionReceiptId, input, signal }) => {
      if (!params.credentials) {
        throw Object.assign(new Error('Workspace sync resolution requires an authenticated Account'), { code: 'not_authenticated' });
      }
      try {
        return WorkspaceSyncConflictResolutionResultV1Schema.parse(await callMachineAction({
          machineId: input.controllerMachineId,
          method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE,
          request: { actionReceiptId, actionInput: input },
          ...(signal ? { signal } : {}),
        }));
      } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
          throw Object.assign(new Error('Controller must be updated for workspace conflict resolution'), {
            code: 'workspace_sync_update_required',
          });
        }
        throw error;
      }
    },
    workspaceSyncRelationshipsList: async ({ input, signal }) => {
      const machineId = await resolveWorkspaceSyncReadController(input, signal);
      return WorkspaceSyncRelationshipsListRpcResultV1Schema.parse(await callMachineAction({
        machineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST,
        request: input.workspaceRefId ? { workspaceRefId: input.workspaceRefId } : {},
        ...(signal ? { signal } : {}),
      }));
    },
    workspaceSyncConflictsList: async ({ input, signal }) => {
      const machineId = await resolveWorkspaceSyncReadController(input, signal);
      return WorkspaceSyncConflictPageV1Schema.parse(await callMachineAction({
        machineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST,
        request: { relationshipId: input.relationshipId, limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) },
        ...(signal ? { signal } : {}),
      }));
    },
    workspaceSyncConflictInspect: async ({ input, signal }) => {
      const machineId = await resolveWorkspaceSyncReadController(input, signal);
      return WorkspaceSyncConflictInspectRpcResultV1Schema.parse(await callMachineAction({
        machineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT,
        request: {
          workspaceRefId: input.workspaceRefId,
          path: input.path,
          ...(input.preview ? { preview: input.preview } : {}),
        },
        ...(signal ? { signal } : {}),
      }));
    },
  };
}
