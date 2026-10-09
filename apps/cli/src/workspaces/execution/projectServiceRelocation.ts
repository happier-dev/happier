import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { LocalServiceManagedServiceActionTargetV1Schema, type LocalServiceActionTargetV1 } from '@happier-dev/protocol/local/services/actions/v1';
import type { WorkspaceSyncPrepareBetweenRequestV1, WorkspaceSyncPrepareBetweenResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { ProjectServiceRelocateInputV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ManagedServiceSnapshot } from '@happier-dev/plugin-sdk/managed-services';

import type { ManagedServiceProcessStopResult } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import type { ActionOperationProgressUpdate, ActionOperationOwnerUpdate } from '@/daemon/actionOperations/actionOperationTypes';
import type { LocalServiceLauncherStartExecutionOutcome } from '@/daemon/local/services/launch/start';
import type { ProjectManagedServiceWitness } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { isWorkspacePathWithin } from '@/daemon/local/services/inventory/provenance';

type ManagedTarget = Extract<LocalServiceActionTargetV1, { kind: 'managed_service' }>;
type Refusal = Readonly<{ status: 'refused'; reasonCode: string }>;

/** Admitted native/Machine IO ports; no service custody or operation store lives here. */
export interface ProjectServiceRelocationPorts {
  readService(input: ProjectServiceRelocateInputV1, signal?: AbortSignal): Promise<Refusal | Readonly<{
    status: 'resolved'; execution: 'primary' | 'portable';
    currentTarget: ManagedTarget & Pick<ProjectManagedServiceWitness, 'declaration' | 'cwd'> & Readonly<{ workspaceId: string }>;
    workspace: ProjectManagedServiceWitness['workspace'];
    instanceId: string; snapshot: Pick<ManagedServiceSnapshot, 'state'>;
  }>>;
  resolveDestination(input: ProjectServiceRelocateInputV1, signal?: AbortSignal): Promise<Refusal | Readonly<{
    status: 'resolved'; workspace: WorkspaceRefV1;
  }>>;
  stopService(target: ManagedTarget, signal?: AbortSignal): Promise<ManagedServiceProcessStopResult>;
  revalidateDestination(input: ProjectServiceRelocateInputV1, destination: WorkspaceRefV1, signal?: AbortSignal): Promise<Refusal | Readonly<{ status: 'admitted' }>>;
  /** Must be production handoffPrepareBetween: it routes to the real Sync controller. */
  handoffPrepareBetween(request: WorkspaceSyncPrepareBetweenRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncPrepareBetweenResultV1>;
  startService(input: ProjectServiceRelocateInputV1, destination: WorkspaceRefV1, signal?: AbortSignal): Promise<LocalServiceLauncherStartExecutionOutcome>;
}

function failure(errorCode: string): ActionExecuteResult {
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
    if (signal?.aborted) return failure('cancelled');
    const current = await ports.readService(input, signal);
    if (current.status === 'refused') return failure(current.reasonCode);
    if (current.execution === 'primary' && input.destination.kind === 'workers') return failure('primary_only');
    if (createCanonicalJsonSigningInput(current.currentTarget) !== createCanonicalJsonSigningInput(input.currentTarget)
      || current.instanceId !== input.currentTarget.managedServiceId
      || !isObservedWorkspaceTarget(current.currentTarget, current.workspace, input.workspace.serverId)) {
      return failure('service_inputs_changed');
    }
    if (current.snapshot.state === 'stopped') return failure('service_already_stopped');
    const destination = await ports.resolveDestination(input, signal);
    if (destination.status === 'refused') return failure(destination.reasonCode);
    const selected = destination.workspace;
    if (selected.serverId !== input.workspace.serverId) return failure('wrong_home');
    if (selected.machineId === current.currentTarget.machineId && selected.id === current.currentTarget.workspaceId) {
      return { ok: true, result: { status: 'unchanged', currentTarget: current.currentTarget } };
    }
    if (signal?.aborted) return failure('cancelled');
    // Re-read after destination admission: an await cannot lend stale stop authority.
    const beforeStop = await ports.readService(input, signal);
    if (beforeStop.status === 'refused') return failure(beforeStop.reasonCode);
    if (createCanonicalJsonSigningInput(beforeStop.currentTarget) !== createCanonicalJsonSigningInput(input.currentTarget)
      || beforeStop.instanceId !== current.instanceId
      || !isObservedWorkspaceTarget(beforeStop.currentTarget, beforeStop.workspace, input.workspace.serverId)
      || !isWorkspacePathWithin(current.workspace.rootPath, beforeStop.workspace.rootPath)
      || !isWorkspacePathWithin(beforeStop.workspace.rootPath, current.workspace.rootPath)) {
      return failure('service_inputs_changed');
    }
    if (beforeStop.snapshot.state === 'stopped') return failure('service_already_stopped');
    if (beforeStop.execution === 'primary' && input.destination.kind === 'workers') return failure('primary_only');
    if (signal?.aborted) return failure('cancelled');
    // This is an observed resource identity, not a claim that Stop has settled.
    context.publishOwnerUpdate?.({ domainRef: { kind: 'projectService', purpose: 'relocation',
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
    if (signal?.aborted) return failure('cancelled');
    const currentDestination = await ports.revalidateDestination(input, selected, signal);
    if (currentDestination.status === 'refused') return failure(currentDestination.reasonCode);
    if (signal?.aborted) return failure('cancelled');
    progress('copying', 'Copying current files');
    try {
      const prepared = await ports.handoffPrepareBetween({ sourceWorkspaceRefId: input.workspace.refId,
        targetWorkspaceRefId: selected.id }, signal);
      if (!prepared.ok) return failure(prepared.errorCode);
    } catch {
      return failure(signal?.aborted ? 'cancelled' : 'service_preparation_failed');
    }
    if (signal?.aborted) return failure('cancelled');
    // Never re-rank Auto after the approved exact destination has been selected.
    const admitted = await ports.revalidateDestination(input, selected, signal);
    if (admitted.status === 'refused') return failure(admitted.reasonCode);
    if (signal?.aborted) return failure('cancelled');
    const selectedDeclaration = { workspaceRefId: selected.id, selection: current.currentTarget.declaration.selection };
    // Retain actual dispatch routing, not an invented native instance or running fact.
    context.publishOwnerUpdate?.({ domainRef: { kind: 'projectService', purpose: 'relocation',
      workspace: { serverId: selected.serverId, machineId: selected.machineId,
        workspaceId: selected.id, rootPath: selected.rootPath }, declaration: selectedDeclaration } });
    progress('starting', 'Starting service');
    try {
      const started = await ports.startService(input, selected, signal);
      // The actual starter may deny after acquiring native cleanup custody. Its
      // status alone is not proof of no launch; only a fresh binding proves success.
      if (started.status !== 'succeeded' || !started.currentTarget) return failure('outcome_uncertain');
      const binding = LocalServiceManagedServiceActionTargetV1Schema.safeParse(started.currentTarget);
      if (!binding.success) return failure('outcome_uncertain');
      const target = binding.data;
      if (target.machineId !== selected.machineId || target.workspaceId !== selected.id
        || target.sessionId !== undefined || !target.cwd || !isWorkspacePathWithin(selected.rootPath, target.cwd)
        || !target.declaration || createCanonicalJsonSigningInput(target.declaration) !== createCanonicalJsonSigningInput(selectedDeclaration)
        || target.managedServiceId === current.currentTarget.managedServiceId) return failure('outcome_uncertain');
      return { ok: true, result: { status: 'moved', currentTarget: target } };
    } catch {
      // Establishment may have taken effect, including cancellation after dispatch.
      return failure('outcome_uncertain');
    }
  };
}
