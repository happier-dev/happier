import type { BackendRuntimeContext } from '@happier-dev/plugin-sdk/scm/backend';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, type WorktreeRemovedEventV1 } from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { publishDaemonHostEvent } from '@/daemon/events/publishDaemonHostEvent';
import { projectRuntimeAccountRowsInput } from '@/workspaces/projectAccountRows';
import { createProjectFiniteAction, type ProjectFiniteActionRuntime } from './projectFiniteAction';
import { resolveProjectSetupAcceptedWorkspace, type ProjectSetupAcceptedAssociation } from './projectSetupAcceptedWorkspace';
import type { ProjectSetupOperationContext } from './projectSetupExecution';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';

/** Only the containing operation supplies review, cancellation and settlement. */
export function requireProjectCheckoutRemovalOperation(context: ActionExecutorContext & Partial<ProjectSetupOperationContext>): ProjectSetupOperationContext {
    if (!context.signal || !context.operationOwnerUpdate || !context.operationAcceptance || !context.operationProgress) {
        throw Object.assign(new Error('project_setup_operation_unavailable'), { code: 'project_setup_operation_unavailable' });
    }
    return { ...context, signal: context.signal, operationOwnerUpdate: context.operationOwnerUpdate,
        operationAcceptance: context.operationAcceptance, operationProgress: context.operationProgress };
}

export type ProjectCheckoutRemoval = Readonly<{
    association: ProjectSetupAcceptedAssociation | null;
    cleanup: 'completed' | 'skipped' | 'unassociated';
    settle(removalKind: WorktreeRemovedEventV1['removalKind']): void;
}>;

/** The destructive lifecycle captures accepted identity before any bytes or rows move.
 * Call once at the native owner's before-effect boundary, then settle only after
 * its filesystem and Account-row effects succeed. Collection never calls this. */
export async function prepareProjectCheckoutRemoval(input: Readonly<{
    runtime: ProjectFiniteActionRuntime;
    ingress: RpcHandlerContext;
    context: ActionExecutorContext;
    operation: ProjectSetupOperationContext;
    worktreePath: string;
    /** Supplied only by the selected backend from its retained physical registration. */
    missingWorktree?: Parameters<NonNullable<BackendRuntimeContext['beforeFilesystemMutation']>>[0];
    /** Already accepted by the containing owner before its Account rows retire. */
    association?: ProjectSetupAcceptedAssociation | null;
    skipCleanup?: boolean;
    unattended?: boolean;
}>): Promise<ProjectCheckoutRemoval> {
    const { runtime, ingress, operation } = input;
    const operationId = operation.operationAcceptance?.operationId;
    if (!operationId) throw Object.assign(new Error('project_setup_operation_unavailable'), { code: 'project_setup_operation_unavailable' });
    // Capture a live root before deletion, or consume the selected backend's
    // retained registration when the files were already removed externally.
    const physicalRoot = input.missingWorktree?.physicalRootPath ?? await currentWorkspaceSource().realpath(input.worktreePath).catch(() => {
        const code = operation.signal.aborted ? 'cancelled' : 'project_worktree_root_unavailable';
        throw Object.assign(new Error(code), { code });
    });
    const association = input.association !== undefined ? input.association : await resolveProjectSetupAcceptedWorkspace({
        ...projectRuntimeAccountRowsInput(runtime), serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl,
        address: { serverId: runtime.serverId, machineId: runtime.machineId, rootPath: input.worktreePath },
        allowUnassociated: true, signal: operation.signal,
    });
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
        const services = lease.registry.projectManagedServices;
        if (!services) throw Object.assign(new Error('plugin_managed_service_unavailable'), { code: 'plugin_managed_service_unavailable' });
        if (!await services.isWorkspaceStopped(physicalRoot)) {
            throw Object.assign(new Error('workspace_root_in_use'), { code: 'workspace_root_in_use' });
        }
    } finally { await lease.release(); }
    let cleanup: ProjectCheckoutRemoval['cleanup'] = association ? 'completed' : 'unassociated';
    if (association && !input.skipCleanup && !input.missingWorktree) {
        const result = await createProjectFiniteAction(runtime, ingress, { operation, association,
            ...(input.unattended ? { requireRememberedConsent: true } : {}) })({
            actionId: 'projects.prepare', input: { workspace: workspaceAddressFromRefV1(association.workspace), phase: 'teardown' },
            context: input.context,
        });
        const failure = ActionExecuteFailureSchema.safeParse(result);
        if (failure.success) {
            if (input.unattended && (failure.data.errorCode === 'project_setup_consent_required'
                || failure.data.errorCode === 'project_setup_effect_changed')) cleanup = 'skipped';
            else throw Object.assign(new Error(failure.data.error), { code: failure.data.errorCode, details: failure.data.details });
        }
    } else if (association) cleanup = 'skipped';
    return { association, cleanup,
        settle(removalKind) {
            publishDaemonHostEvent({ eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' }, payload: {
                kind: 'worktreeRemoved', serverId: runtime.serverId, occurredAt: Date.now(), removal: {
                    workspace: association ? workspaceAddressFromRefV1(association.workspace) : null,
                    project: association?.project ?? null, machineId: runtime.machineId, operationId,
                    worktreePath: physicalRoot, outcome: 'removed', removalKind,
                },
            } }, () => false);
        },
    };
}
