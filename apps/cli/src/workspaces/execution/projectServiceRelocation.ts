import type { WorkspaceProjectManagedServiceWitness } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { LocalServiceManagedServiceActionTargetV1Schema, type LocalServiceActionTargetV1 } from '@happier-dev/protocol/local/services/actions/v1';
import type { WorkspaceSyncPrepareBetweenRequestV1, WorkspaceSyncPrepareBetweenResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { ProjectServiceRelocateInputV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import type { ProjectServicePlacementMutationResultV1 } from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ManagedServiceSnapshot } from '@happier-dev/plugin-sdk/managed-services';
import { isLocalServiceStateRunningV1, type DaemonLocalServiceLauncherStartResponseV1 } from '@happier-dev/protocol/local/services/launcher/v1';

import type { ManagedServiceProcessStopResult } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import type { ActionOperationProgressUpdate, ActionOperationOwnerUpdate } from '@/daemon/actionOperations/actionOperationTypes';

import { isWorkspacePathWithin } from '@/daemon/local/services/inventory/provenance';
import { projectActionOperationFailure } from '@/daemon/actionOperations/actionOperationFailure';

type ManagedTarget = Extract<LocalServiceActionTargetV1, { kind: 'managed_service' }>;
type Refusal = Readonly<{ status: 'refused'; reasonCode: string; error?: string }>;

/** Admitted native/Machine IO ports; no service custody or operation store lives here. */
export interface ProjectServiceRelocationPorts {
  readService(input: ProjectServiceRelocateInputV1, signal?: AbortSignal): Promise<Refusal | Readonly<{
    status: 'resolved'; execution: 'primary' | 'portable';
    currentTarget: ManagedTarget & Pick<WorkspaceProjectManagedServiceWitness, 'declaration' | 'cwd'> & Readonly<{ workspaceId: string }>;
    workspace: WorkspaceProjectManagedServiceWitness['workspace'];
    instanceId: string; snapshot: Pick<ManagedServiceSnapshot, 'state'>;
  }>>;
  resolveDestination(input: ProjectServiceRelocateInputV1, signal?: AbortSignal): Promise<Refusal | Readonly<{
    status: 'resolved'; workspace: WorkspaceRefV1;
  }>>;
  saveDesiredPlacement(input: ProjectServiceRelocateInputV1['desiredPlacement'], signal?: AbortSignal): Promise<ProjectServicePlacementMutationResultV1>;
  stopService(target: ManagedTarget, signal?: AbortSignal): Promise<ManagedServiceProcessStopResult>;
  revalidateDestination(input: ProjectServiceRelocateInputV1, destination: WorkspaceRefV1, signal?: AbortSignal): Promise<Refusal | Readonly<{ status: 'admitted' }>>;
  reviewDestinationSetup(input: ProjectServiceRelocateInputV1, destination: WorkspaceRefV1, signal?: AbortSignal): Promise<Refusal | Readonly<{ status: 'admitted' }>>;
  /** Must be production handoffPrepareBetween: it routes to the real Sync controller. */
  handoffPrepareBetween(request: WorkspaceSyncPrepareBetweenRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncPrepareBetweenResultV1>;
  startService(input: ProjectServiceRelocateInputV1 & Readonly<{
    currentTarget: ManagedTarget & Pick<WorkspaceProjectManagedServiceWitness, 'declaration'>;
  }>, destination: WorkspaceRefV1, signal?: AbortSignal): Promise<Readonly<
    Pick<DaemonLocalServiceLauncherStartResponseV1, 'status' | 'currentTarget' | 'reasonCode'>
  >>;
}

async function failure(errorCode: string, error?: string): Promise<ActionExecuteResult> {
  if (error) return projectActionOperationFailure(Object.assign(new Error(error), { code: errorCode }), errorCode);
  return { ok: false, errorCode, error: errorCode };
}

function isObservedWorkspaceTarget(target: ManagedTarget, workspace: WorkspaceRefV1, serverId: string): boolean {
  return workspace.serverId === serverId && workspace.machineId === target.machineId
    && workspace.id === target.workspaceId && target.sessionId === undefined
    && target.declaration?.workspaceRefId === workspace.id && typeof target.cwd === 'string' && target.cwd.length > 0
    && isWorkspacePathWithin(workspace.rootPath, target.cwd);
}

/** A single observed stop → clean preparation → exact native start, hosted by the source daemon. */
export function createProjectServiceRelocation(ports: ProjectServiceRelocationPorts) {
  return async (input: ProjectServiceRelocateInputV1, context: Readonly<{
    signal?: AbortSignal;
    updateProgress?: (update: ActionOperationProgressUpdate) => void;
    publishOwnerUpdate?: (update: ActionOperationOwnerUpdate) => void;
  }> = {}): Promise<ActionExecuteResult> => {
    const { signal } = context;
    const progress = (phase: string, label: string) => context.updateProgress?.({ phase, label });
    try {
      if (signal?.aborted) return failure('cancelled');
      const current = await ports.readService(input, signal);
      if (current.status === 'refused') return failure(current.reasonCode, current.error);
      if (current.execution === 'primary' && input.destination.kind === 'workers') return failure('primary_only');
      if (createCanonicalJsonSigningInput(current.currentTarget) !== createCanonicalJsonSigningInput(input.currentTarget)
        || current.instanceId !== input.currentTarget.managedServiceId
        || !isObservedWorkspaceTarget(current.currentTarget, current.workspace, input.workspace.serverId)) {
        return failure('service_inputs_changed');
      }
      if (current.snapshot.state === 'stopped') return failure('service_already_stopped');
      if (!isLocalServiceStateRunningV1(current.snapshot.state)) return failure('service_not_running');
      const destination = await ports.resolveDestination(input, signal);
      if (destination.status === 'refused') return failure(destination.reasonCode, destination.error);
      const selected = destination.workspace;
      if (selected.machineId !== input.selectedTarget.machineId) {
        return failure('selected_target_changed');
      }
      if (selected.serverId !== input.workspace.serverId) return failure('wrong_home');
      const sameTarget = selected.machineId === current.currentTarget.machineId && selected.id === current.currentTarget.workspaceId;
      const sourceWorkspace = input.workspace;
      const destinationWorkspace = { serverId: selected.serverId, machineId: selected.machineId, workspaceId: selected.id, rootPath: selected.rootPath };
      context.publishOwnerUpdate?.({ domainRef: { kind: 'projectService', purpose: 'relocation', sourceWorkspace, destinationWorkspace,
        workspace: { serverId: current.workspace.serverId, machineId: current.workspace.machineId,
          workspaceId: current.workspace.id, rootPath: current.workspace.rootPath },
        declaration: current.currentTarget.declaration, currentTarget: current.currentTarget } });
      if (!sameTarget) {
        // Destination selection admitted the target once. Keep the exact
        // domain operands current before the irreversible old Stop.
        const admitted = await ports.revalidateDestination(input, selected, signal);
        if (admitted.status === 'refused') return failure(admitted.reasonCode, admitted.error);
        if (signal?.aborted) return failure('cancelled');
        const setup = await ports.reviewDestinationSetup(input, selected, signal);
        if (setup.status === 'refused') return failure(setup.reasonCode, setup.error);
        if (signal?.aborted) return failure('cancelled');
      }
      // This compound producer owns set+Move. The desired placement must settle before
      // any native Stop, and an unknown/conflicting write cannot lend effect authority.
      const placement = await ports.saveDesiredPlacement(input.desiredPlacement, signal);
      if (placement.status === 'conflict') return failure('placement_conflict');
      if (placement.status === 'outcomeUnknown') return failure('placement_outcome_unknown');
      if (placement.status === 'cancelled') return failure('cancelled');
      if (placement.status === 'locked' || placement.status === 'invalid' || placement.status === 'unavailable') {
        return failure(`placement_${placement.status}`);
      }
      if (sameTarget) {
        return { ok: true, result: { status: 'unchanged', currentTarget: current.currentTarget } };
      }
      if (signal?.aborted) return failure('cancelled');
      // Re-read after destination admission: an await cannot lend stale stop authority.
      const beforeStop = await ports.readService(input, signal);
      if (beforeStop.status === 'refused') return failure(beforeStop.reasonCode, beforeStop.error);
      if (createCanonicalJsonSigningInput(beforeStop.currentTarget) !== createCanonicalJsonSigningInput(input.currentTarget)
        || beforeStop.instanceId !== current.instanceId
        || !isObservedWorkspaceTarget(beforeStop.currentTarget, beforeStop.workspace, input.workspace.serverId)
        || !isWorkspacePathWithin(current.workspace.rootPath, beforeStop.workspace.rootPath)
        || !isWorkspacePathWithin(beforeStop.workspace.rootPath, current.workspace.rootPath)) {
        return failure('service_inputs_changed');
      }
      if (beforeStop.snapshot.state === 'stopped') return failure('service_already_stopped');
      if (!isLocalServiceStateRunningV1(beforeStop.snapshot.state)) return failure('service_not_running');
      if (beforeStop.execution === 'primary' && input.destination.kind === 'workers') return failure('primary_only');
      if (signal?.aborted) return failure('cancelled');
      // This is an observed resource identity, not a claim that Stop has settled.
      context.publishOwnerUpdate?.({ domainRef: { kind: 'projectService', purpose: 'relocation', sourceWorkspace, destinationWorkspace,
        workspace: { serverId: beforeStop.workspace.serverId, machineId: beforeStop.workspace.machineId,
          workspaceId: beforeStop.workspace.id, rootPath: beforeStop.workspace.rootPath },
        declaration: beforeStop.currentTarget.declaration, currentTarget: beforeStop.currentTarget } });
      progress('stopping', 'Stopping service');
      let stopped: ManagedServiceProcessStopResult;
      try {
        stopped = await ports.stopService(input.currentTarget, signal);
      } catch {
        return failure('stop_unconfirmed');
      }
      if (stopped.status !== 'stopped') {
        return failure(stopped.status === 'unsupported' ? 'service_control_unsupported' : 'stop_unconfirmed');
      }
      // Retain the native Stop fact even if cancellation or changed operands prevent copy.
      progress('stopped', 'Service stopped');
      if (signal?.aborted) return failure('cancelled');
      const currentDestination = await ports.revalidateDestination(input, selected, signal);
      if (currentDestination.status === 'refused') return failure(currentDestination.reasonCode, currentDestination.error);
      if (signal?.aborted) return failure('cancelled');
      progress('copying', 'Copying current files');
      try {
        const prepared = await ports.handoffPrepareBetween({ sourceWorkspaceRefId: input.workspace.refId,
          targetWorkspaceRefId: selected.id }, signal);
        if (!prepared.ok) return failure(prepared.errorCode);
      } catch (error) {
        return signal?.aborted ? failure('cancelled') : await projectActionOperationFailure(error, 'service_preparation_failed');
      }
      if (signal?.aborted) return failure('cancelled');
      // Never re-rank Auto after the approved exact destination has been selected.
      const admitted = await ports.revalidateDestination(input, selected, signal);
      if (admitted.status === 'refused') return failure(admitted.reasonCode, admitted.error);
      if (signal?.aborted) return failure('cancelled');
      const selectedDeclaration = { workspaceRefId: selected.id, selection: current.currentTarget.declaration.selection };
      // Retain actual dispatch routing, not an invented native instance or running fact.
      context.publishOwnerUpdate?.({ domainRef: { kind: 'projectService', purpose: 'relocation', sourceWorkspace, destinationWorkspace,
        workspace: { serverId: selected.serverId, machineId: selected.machineId,
          workspaceId: selected.id, rootPath: selected.rootPath }, declaration: selectedDeclaration } });
      progress('starting', 'Starting service');
      try {
        const started = await ports.startService({ ...input, currentTarget: current.currentTarget }, selected, signal);
        // Launcher denial is a completed pre-establishment refusal. Failed or
        // lost establishment may retain native custody and must remain unknown.
        if (started.status === 'denied') {
          progress('stopped', 'Service stopped');
          return failure(started.reasonCode ?? 'launcher_start_denied');
        }
        if (started.status !== 'succeeded' || !started.currentTarget) return failure('outcome_uncertain');
        const binding = LocalServiceManagedServiceActionTargetV1Schema.safeParse(started.currentTarget);
        if (!binding.success) return failure('outcome_uncertain');
        const target = binding.data;
        if (target.machineId !== selected.machineId || target.workspaceId !== selected.id
          || target.sessionId !== undefined || !target.cwd || !isWorkspacePathWithin(selected.rootPath, target.cwd)
          || !target.declaration || createCanonicalJsonSigningInput(target.declaration) !== createCanonicalJsonSigningInput(selectedDeclaration)
          || target.managedServiceId === current.currentTarget.managedServiceId) return failure('outcome_uncertain');
        context.publishOwnerUpdate?.({ domainRef: { kind: 'projectService', purpose: 'relocation', sourceWorkspace, destinationWorkspace,
          workspace: { serverId: selected.serverId, machineId: selected.machineId, workspaceId: selected.id, rootPath: selected.rootPath },
          declaration: selectedDeclaration, currentTarget: target } });
        return { ok: true, result: { status: 'moved', currentTarget: target } };
      } catch {
        // Establishment may have taken effect, including cancellation after dispatch.
        return failure('outcome_uncertain');
      }
    } catch (error) {
      return signal?.aborted ? failure('cancelled') : await projectActionOperationFailure(error, 'service_relocation_failed');
    }
  };
}
