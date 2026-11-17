import * as z from 'zod/mini';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { readHostAdmittedReviewedChildV1, readHostReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { sameStrictJsonValue, projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { isProjectServiceMoveChildInputV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { ProjectWorkerActionInputSchemasV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';
import type { ProjectWorkerStatusResultV1 } from '@happier-dev/protocol';
import { ProjectWorkerDependencyV1Schema } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';
import type { MachineWorkspaceSyncRpcService } from '@/api/machine/rpcHandlers.workspaceSync';
import type { StoredCredentials } from '@/persistence';
import { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
import { readWorkspaceSyncRootObjectIdentity } from '@/workspaces/sync/workspaceSyncRootIdentity';
import { readWorkspaceSyncWorkerTargetSnapshot, resolveWorkspaceSyncWorkerTarget } from '@/workspaces/sync/workspaceSyncPreparation';
import type { createProjectWorkerAdmission } from './projectWorkerAdmission';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { refuseExternalActionPhase, runTracedExternalActionStage } from '@/daemon/externalActions/externalActionPhase';
import { rethrowRequesterHomeReadFailure } from "@/daemon/sessionEncryption/requesterCurrentness";
import { readWorkspaceSyncCopyRetirementReceiptV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncCommittedCopyV1';

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
  workspaceSync?: Readonly<{ relationshipOwner: Pick<MachineWorkspaceSyncRpcService['relationshipOwner'], 'stop'>;
    forRequester?: MachineWorkspaceSyncRpcService['forRequester'] }>;
}>): NonNullable<ActionExecutorDeps['projectWorkerAction']> {
  return async ({ actionId, input, context, signal }) => {
    if (actionId !== 'projects.worker.status' && actionId !== 'projects.worker.copy.retire') {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    }
    const requester = context.externalActionExecutionAuthorization?.binding.accountId
      ?? context.externalActionCredential?.accountId ?? context.runtimeAccountId;
    if ((requester && requester !== options.accountId && context.machineAdmission?.actorAccountId !== requester)
      || context.serverId && !await isServerProfileHomeIdentity(options.serverId, context.serverId)) {
      return { ok: false, errorCode: 'project_worker_access_denied', error: 'project_worker_access_denied' };
    }
    if (actionId === 'projects.worker.status') {
      const request = ProjectWorkerActionInputSchemasV1[actionId].parse(input);
      const trace = <T>(stage: string, operation: () => T | Promise<T>) => runTracedExternalActionStage(actionId,
        context.externalActionExecutionAuthorization?.binding.requestId ?? context.actionRequestId, `worker_status.${stage}`, operation);
      let lastCleanSyncAtMs: ProjectWorkerStatusResultV1['lastCleanSyncAtMs'];
      const refused = (explanation: Extract<ProjectWorkerStatusResultV1, { eligible: false }>['explanation'],
        load: ProjectWorkerStatusResultV1['load'] = { kind: 'unknown' },
        observedMemory?: ProjectWorkerStatusResultV1['observedMemory']): ProjectWorkerStatusResultV1 => ({
        eligible: false, candidate: null, explanation, load,
        ...(observedMemory ? { observedMemory } : {}),
        ...(lastCleanSyncAtMs !== undefined ? { lastCleanSyncAtMs } : {}),
      });
      if (!await isServerProfileHomeIdentity(options.serverId, request.workspace.serverId)) return refused('forbidden');
      if (request.destination.kind !== 'machine' || request.destination.machineId !== options.machineId) {
        return refused('forbidden');
      }
      const service = request.purpose === 'service-start';
      if (!(service ? options.isServiceExecutionLive?.() : options.isFiniteExecutionLive())) return refused('unsupported');
      try {
        signal?.throwIfAborted();
        const requesterContext = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
        if (context.externalActionExecutionAuthorization && (!requesterContext
          || !await trace('requester_currentness', () => (requesterContext.isCustodyCurrent ?? requesterContext.isCurrent)()))) return refused('unavailable');
        const child = readHostAdmittedReviewedChildV1(context);
        const parent = readHostReviewedParentV1(context);
        const admittedMoveStatus = child?.actionId === actionId && parent?.actionId === 'projects.service.relocate'
          && sameStrictJsonValue(child.input, projectNativeJsonValueForTransport(request))
          && isProjectServiceMoveChildInputV1(parent.input, actionId, options.machineId, request);
        // SOURCE already selected the exact copy before review. This admitted
        // child observes host capacity; the exact Start child owns its effect.
        if (!admittedMoveStatus) {
          // Retain private custody so requester rows cannot replace the daemon's
          // Account projection; native observations still use requester material.
          const credentials = requesterContext?.credentials ?? options.credentials;
          const snapshot = await trace('snapshot', () => readWorkspaceSyncWorkerTargetSnapshot({ ...options, credentials, serverId: request.workspace.serverId, signal,
            authorization: context.externalActionExecutionAuthorization,
            sourceWorkspaceRefId: request.workspace.refId, targetMachineId: options.machineId })).catch(error => {
              if (process.env.HAPPIER_WEB_LATENCY_TRACE === '1') refuseExternalActionPhase('worker_status_snapshot', options.machineId, error);
              return null;
            });
          // A missing Home observation is unknown, not proof that this copy is absent.
          if (!snapshot) return refused('unavailable');
          const basis = await trace('topology', () => resolveWorkspaceSyncWorkerTarget({ serverId: request.workspace.serverId,
            sourceWorkspaceRefId: request.workspace.refId, targetMachineId: options.machineId,
            workspaceRefs: snapshot.workspaceRefs, relationships: snapshot.relationships, childMachines: snapshot.childMachines,
            relationshipStatuses: snapshot.relationshipStatuses }));
          if (!basis.ok) {
            if (basis.errorCode === 'worker_copy_missing') {
              const source = resolveWorkspaceRefById(snapshot.workspaceRefs, request.workspace.refId, request.workspace.serverId);
              if (source) return { ...refused('worker_copy_missing'), workerCopy: {
                serverId: source.serverId, sourceWorkspaceRefId: source.id,
                sourceMachineId: source.machineId, targetMachineId: options.machineId,
              } };
            }
            return refused('workspace_unavailable');
          }
          try { await trace('root_identity', () => readWorkspaceSyncRootObjectIdentity(basis.target.rootPath)); }
          catch { return refused('workspace_unavailable'); }
          const targetEdge = basis.relationships.at(-1);
          if (targetEdge) {
            lastCleanSyncAtMs = snapshot.relationshipStatuses.find(status => status.relationshipId === targetEdge.relationshipId
              && status.controllerMachineId === targetEdge.controllerMachineId)?.lastCleanSyncAtMs;
          }
        }
        const observation = service
          ? await trace('eligibility', () => options.admission.observeServiceEligibility(request.memoryDemand))
          : await trace('eligibility', () => options.admission.observeFiniteEligibility(request.memoryDemand));
        if (requesterContext && !await trace('final_currentness', () => requesterContext.isCurrent())) return refused('unavailable');
        if (!observation.eligible) return refused(observation.reason ?? 'unavailable', observation.load, observation.observedMemory);
        return { eligible: true, candidate: { serverId: request.workspace.serverId, machineId: options.machineId },
          load: observation.load, explanation: observation.load.kind === 'unknown' ? 'load_unknown' : 'eligible',
          ...(lastCleanSyncAtMs !== undefined ? { lastCleanSyncAtMs } : {}) };
      } catch (error) {
        rethrowRequesterHomeReadFailure(error);
        return refused('unavailable');
      }
    }
    const request = ProjectWorkerActionInputSchemasV1[actionId].parse(input);
    const failure = (errorCode: string, details?: unknown) => ({ ok: false as const, errorCode, error: errorCode,
      ...(details === undefined ? {} : { details }) });
    if (!await isServerProfileHomeIdentity(options.serverId, request.workspace.serverId) || request.machineId !== options.machineId
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
      // The relationship owner validates both refs in its Account graph before
      // the retirement CAS; the adapter does not acquire a second row authority.
      const workspaceSync = options.workspaceSync.forRequester ? await options.workspaceSync.forRequester({
        signal: signal ?? new AbortController().signal, machineAdmission: context.machineAdmission,
        callerAuthority: context.authority, localActionContext: { ...context },
        verifyMachineAdmissionCurrent: context.verifyMachineAdmissionCurrent,
        callerInputAuthorization: context.externalActionExecutionAuthorization,
        ...(context.originalActionEnvelope ? { originalActionEnvelope: context.originalActionEnvelope } : {}),
      }) : options.workspaceSync;
      await workspaceSync.relationshipOwner.stop(request.expectedRelationship.relationshipId, signal, {
        expectedRelationship: request.expectedRelationship,
        ...(request.removeTargetCopy ? { removeTargetCopy: request.removeTargetCopy,
          approval: { actionReceiptId: context.externalActionExecutionAuthorization
            ? readWorkspaceSyncCopyRetirementReceiptV1(context.externalActionExecutionAuthorization.binding) ?? context.actionRequestId!
            : context.actionRequestId!, actionInput: request } } : {}),
      });
      return { status: 'retired' };
    } catch (error) {
      const projected = normalizeActionExecutorThrownError(error);
      const code = readActionErrorCodeV1(error) ?? projected.errorCode;
      const definitionRetired = typeof error === 'object' && error !== null
        && 'definitionRetired' in error && error.definitionRetired === true;
      const dependencies = error instanceof Error && 'dependencies' in error
        ? z.array(ProjectWorkerDependencyV1Schema).safeParse(error.dependencies) : null;
      if (definitionRetired || code === 'indeterminate' || code === 'workspace_copy_removal_unknown' || code === 'project_account_row_outcome_unknown') {
        return { ok: false, ...projected, errorCode: code,
          details: { kind: 'outcomeUnknown', ...(dependencies?.success ? { dependencies: dependencies.data } : {}) } };
      }
      return { ok: false, ...projected, errorCode: code,
        ...(dependencies?.success ? { details: { dependencies: dependencies.data } } : {}) };
    }
  };
}
