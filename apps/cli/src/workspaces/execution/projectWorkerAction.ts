import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ProjectWorkerActionInputSchemasV1, type ProjectWorkerStatusResultV1 } from '@happier-dev/protocol';
import { ProjectWorkerDependencyV1Schema } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { MachineWorkspaceSyncRpcService } from '@/api/machine/rpcHandlers.workspaceSync';
import type { StoredCredentials } from '@/persistence';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
import { readWorkspaceSyncRootObjectIdentity } from '@/workspaces/sync/workspaceSyncRootIdentity';
import { resolveWorkspaceSyncWorkerTarget } from '@/workspaces/sync/workspaceSyncPreparation';
import type { createProjectWorkerAdmission } from './projectWorkerAdmission';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { WorkspaceSyncStatusV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

/** Exact-target host adapter. Pool selection and current access authority remain with their callers. */
export function createProjectWorkerAction(options: Readonly<{
  machineId: string;
  serverId: string;
  serverHttpBaseUrl: string;
  credentials: StoredCredentials;
  accountId?: string;
  admission: ReturnType<typeof createProjectWorkerAdmission>;
  /** Actual callback installation lifetime; not a user policy or availability cache. */
  isFiniteExecutionLive(): boolean;
  /** Mounted declaration starter and its current host execution ports. */
  isServiceExecutionLive?: () => boolean;
  workspaceSync?: Readonly<{ relationshipOwner: Pick<MachineWorkspaceSyncRpcService['relationshipOwner'], 'stop'> }>;
}>): NonNullable<ActionExecutorDeps['projectWorkerAction']> {
  return async ({ actionId, input, context, signal }) => {
    if (actionId !== 'projects.worker.status' && actionId !== 'projects.worker.copy.retire') {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    }
    const requester = context.externalActionCredential?.accountId ?? context.runtimeAccountId;
    if ((requester && requester !== options.accountId) || (context.serverId && context.serverId !== options.serverId)) {
      return { ok: false, errorCode: 'project_worker_access_denied', error: 'project_worker_access_denied' };
    }
    if (actionId === 'projects.worker.status') {
      const request = ProjectWorkerActionInputSchemasV1[actionId].parse(input);
      let lastCleanSyncAtMs: ProjectWorkerStatusResultV1['lastCleanSyncAtMs'];
      const refused = (explanation: Extract<ProjectWorkerStatusResultV1, { eligible: false }>['explanation'],
        load: ProjectWorkerStatusResultV1['load'] = { kind: 'unknown' },
        observedMemory?: ProjectWorkerStatusResultV1['observedMemory']): ProjectWorkerStatusResultV1 => ({
        eligible: false, candidate: null, explanation, load,
        ...(observedMemory ? { observedMemory } : {}),
        ...(lastCleanSyncAtMs !== undefined ? { lastCleanSyncAtMs } : {}),
      });
      if (request.workspace.serverId !== options.serverId) return refused('forbidden');
      if (request.destination.kind !== 'machine' || request.destination.machineId !== options.machineId) {
        return refused('forbidden');
      }
      const service = request.purpose === 'service-start';
      if (!(service ? options.isServiceExecutionLive?.() : options.isFiniteExecutionLive())) return refused('unsupported');
      try {
        signal?.throwIfAborted();
        const snapshot = await runWithServerHttpBaseUrl(options.serverHttpBaseUrl,
          () => readProjectAccountRows({ credentials: options.credentials, serverId: options.serverId, signal })).catch(() => null);
        // A missing Home observation is unknown, not proof that this copy is absent.
        if (!snapshot) return refused('unavailable');
        const basis = resolveWorkspaceSyncWorkerTarget({ serverId: options.serverId,
          sourceWorkspaceRefId: request.workspace.refId, targetMachineId: options.machineId,
          workspaceRefs: snapshot.workspaceRefs, relationships: snapshot.relationships });
        if (!basis.ok) {
          if (basis.errorCode === 'worker_copy_missing') {
            const source = resolveWorkspaceRefById(snapshot.workspaceRefs, request.workspace.refId, options.serverId);
            if (source) return { ...refused('worker_copy_missing'), workerCopy: {
              serverId: source.serverId, sourceWorkspaceRefId: source.id,
              sourceMachineId: source.machineId, targetMachineId: options.machineId,
            } };
          }
          return refused('workspace_unavailable');
        }
        try { await readWorkspaceSyncRootObjectIdentity(basis.target.rootPath); }
        catch { return refused('workspace_unavailable'); }
        const targetEdge = basis.relationships.at(-1);
        if (targetEdge) {
          try {
            const response = await callMachineRpc({ credentials: options.credentials,
              machineId: targetEdge.controllerMachineId, serverUrl: options.serverHttpBaseUrl,
              method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_GET,
              request: { relationshipId: targetEdge.relationshipId }, ...(signal ? { signal } : {}) });
            const status = WorkspaceSyncStatusV1Schema.safeParse(
              typeof response === 'object' && response !== null && 'status' in response ? response.status : undefined);
            if (status.success && status.data.relationshipId === targetEdge.relationshipId
              && status.data.controllerMachineId === targetEdge.controllerMachineId) {
              lastCleanSyncAtMs = status.data.lastCleanSyncAtMs;
            }
          } catch {
            // An unavailable controller observation does not alter current
            // worker eligibility or turn this read into a Sync barrier.
            signal?.throwIfAborted();
          }
        }
        const observation = service ? await options.admission.observeServiceEligibility(request.memoryDemand)
          : await options.admission.observeFiniteEligibility(request.memoryDemand);
        if (!observation.eligible) return refused(observation.reason ?? 'unavailable', observation.load, observation.observedMemory);
        return { eligible: true, candidate: { serverId: options.serverId, machineId: options.machineId },
          load: observation.load, explanation: observation.load.kind === 'unknown' ? 'load_unknown' : 'eligible',
          ...(lastCleanSyncAtMs !== undefined ? { lastCleanSyncAtMs } : {}) };
      } catch {
        return refused('unavailable');
      }
    }
    const request = ProjectWorkerActionInputSchemasV1[actionId].parse(input);
    const failure = (errorCode: string, details?: unknown) => ({ ok: false as const, errorCode, error: errorCode,
      ...(details === undefined ? {} : { details }) });
    if (request.workspace.serverId !== options.serverId || request.machineId !== options.machineId
      || request.expectedRelationship.controllerMachineId !== options.machineId) {
      return failure('worker_destination_mismatch');
    }
    if (!options.workspaceSync) return failure('workspace_sync_unavailable');
    if (request.removeTargetCopy && !context.actionRequestId) return failure('approval_required');
    try {
      if (request.workspace.refId !== request.expectedRelationship.alphaWorkspaceRefId
        && request.workspace.refId !== request.expectedRelationship.betaWorkspaceRefId) {
        return failure('workspace_unavailable');
      }
      const snapshot = await runWithServerHttpBaseUrl(options.serverHttpBaseUrl,
        () => readProjectAccountRows({ credentials: options.credentials, serverId: options.serverId, signal }));
      if (!resolveWorkspaceRefById(snapshot.workspaceRefs, request.workspace.refId, options.serverId)) {
        return failure('workspace_unavailable');
      }
      await options.workspaceSync.relationshipOwner.stop(request.expectedRelationship.relationshipId, signal, {
        expectedRelationship: request.expectedRelationship,
        ...(request.removeTargetCopy ? { removeTargetCopy: request.removeTargetCopy,
          approval: { actionReceiptId: context.actionRequestId!, actionInput: request } } : {}),
      });
      return { status: 'retired' };
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code : 'workspace_sync_unavailable';
      const definitionRetired = typeof error === 'object' && error !== null
        && 'definitionRetired' in error && error.definitionRetired === true;
      const dependencies = error instanceof Error && 'dependencies' in error
        ? ProjectWorkerDependencyV1Schema.array().safeParse(error.dependencies) : null;
      if (definitionRetired || code === 'indeterminate' || code === 'workspace_copy_removal_unknown' || code === 'project_account_row_outcome_unknown') {
        return failure(code, { kind: 'outcomeUnknown', ...(dependencies?.success ? { dependencies: dependencies.data } : {}) });
      }
      return failure(code, dependencies?.success ? { dependencies: dependencies.data } : undefined);
    }
  };
}
