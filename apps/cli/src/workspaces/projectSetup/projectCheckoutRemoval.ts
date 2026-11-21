import type { BackendRuntimeContext } from '@happier-dev/plugin-sdk/scm/backend';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { createRpcCallError, RpcError } from '@happier-dev/protocol/rpcErrors';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, type WorktreeRemovedEventV1 } from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { publishDaemonHostEvent } from '@/daemon/events/publishDaemonHostEvent';
import { logger } from '@/ui/logger';
import { projectRuntimeAccountRowsInput } from '@/workspaces/projectAccountRows';
import { createProjectFiniteAction, type ProjectFiniteActionRuntime } from './projectFiniteAction';
import { resolveProjectSetupAcceptedWorkspace, type ProjectSetupAcceptedWorkspace } from './projectSetupAcceptedWorkspace';
import type { ProjectSetupOperationContext } from './projectSetupExecution';
import { createProjectSetupTrustClient, resolveProjectTeardownConsent } from './projectSetupTrust';
import type { RetainedCheckoutTeardownDataV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { canonicalWorktreeRootIdentity, getHostWorktreePortsOwner, resolvePhysicalWorktreeRootIdentity } from '@/workspaces/execution/worktreePorts';
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
    association: ProjectSetupAcceptedWorkspace | null;
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
    association?: ProjectSetupAcceptedWorkspace | null;
    /** Already opened and matched to this retained root by its target owner. */
    admittedTeardown?: RetainedCheckoutTeardownDataV1;
    skipCleanup?: boolean;
    unattended?: boolean;
}>): Promise<ProjectCheckoutRemoval> {
    const { runtime, ingress, operation } = input;
    const operationId = operation.operationAcceptance?.operationId;
    if (!operationId) throw Object.assign(new Error('project_setup_operation_unavailable'), { code: 'project_setup_operation_unavailable' });
    // Capture a live root before deletion, or consume the selected backend's
    // retained registration when the files were already removed externally.
    let physicalRoot: string;
    try {
        physicalRoot = input.missingWorktree
            ? canonicalWorktreeRootIdentity(input.missingWorktree.physicalRootPath)
            : await resolvePhysicalWorktreeRootIdentity(input.worktreePath);
    } catch {
        const code = operation.signal.aborted ? 'cancelled' : 'project_worktree_root_unavailable';
        throw Object.assign(new Error(code), { code });
    }
    const association = input.association !== undefined ? input.association : await resolveProjectSetupAcceptedWorkspace({
        ...projectRuntimeAccountRowsInput(runtime), serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl,
        address: { serverId: runtime.serverId, machineId: runtime.machineId, rootPath: input.worktreePath },
        physicalRootPath: physicalRoot,
        allowUnassociated: true, allowProjectless: true, signal: operation.signal,
    });
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
        const services = lease.registry.projectManagedServices;
        if (!services) throw Object.assign(new Error('plugin_managed_service_unavailable'), { code: 'plugin_managed_service_unavailable' });
        if (!await services.isWorkspaceStopped(physicalRoot)) {
            throw new RpcError('workspace_root_in_use', 'workspace_root_in_use');
        }
    } finally { await lease.release(); }
    let cleanup: ProjectCheckoutRemoval['cleanup'] = association?.project ? 'completed' : 'unassociated';
    if (association?.project && !input.skipCleanup && !input.missingWorktree) {
        const admittedTeardown = input.admittedTeardown;
        const checkoutTeardownConsent = admittedTeardown ? async (digest: string) => resolveProjectTeardownConsent(admittedTeardown.trust, digest)
            : createProjectSetupTrustClient({
            ...projectRuntimeAccountRowsInput(runtime), serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal: operation.signal,
        }).captureCheckoutTeardownConsent(association.project);
        const result = await createProjectFiniteAction(runtime, ingress, { operation,
            association: { workspace: association.workspace, project: association.project },
            checkoutTeardownConsent,
            ...(admittedTeardown ? { admittedTeardown } : {}),
            ...(input.unattended ? { requireRememberedConsent: true } : {}) })({
            actionId: 'projects.prepare', input: { workspace: workspaceAddressFromRefV1(association.workspace), phase: 'teardown' },
            context: input.context,
        });
        const failure = ActionExecuteFailureSchema.safeParse(result);
        if (failure.success) {
            if (input.unattended && (failure.data.errorCode === 'project_setup_consent_required'
                || failure.data.errorCode === 'project_setup_effect_changed')) cleanup = 'skipped';
            else throw createRpcCallError(failure.data);
        }
    } else if (association?.project) cleanup = 'skipped';
    return { association, cleanup,
        settle(removalKind) {
            if (cleanup === 'skipped') operation.operationProgress.update({ phase: 'teardown.skipped',
                label: 'Worktree removed; project teardown skipped' });
            // Port custody is local to the removed root. Account Event
            // delivery has its own audience and is independent of release.
            void getHostWorktreePortsOwner().release({ rootPath: physicalRoot }).then(released => {
                if (released.kind === 'unavailable') logger.warn('[WorktreePorts] Assignment release unavailable', {
                    code: released.code, reason: released.reason,
                });
            }).catch(error => {
                const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
                logger.warn('[WorktreePorts] Assignment release unavailable', {
                    code: typeof code === 'string' ? code : 'project_worktree_ports_unavailable',
                });
            });
            const observation = {
                kind: 'worktreeRemoved', serverId: runtime.serverId, occurredAt: Date.now(), removal: {
                    workspace: association ? workspaceAddressFromRefV1(association.workspace) : null,
                    project: association?.project ?? null, machineId: runtime.machineId, operationId,
                    ...(operation.operationAcceptance?.originRunId ? { originRunId: operation.operationAcceptance.originRunId } : {}),
                    worktreePath: physicalRoot, outcome: 'removed', removalKind,
                },
            } as const;
            try {
                if (runtime.publishMachineServiceObservation) runtime.publishMachineServiceObservation(observation);
                else if (!input.ingress.retainedCheckoutTeardown) publishDaemonHostEvent({ eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1,
                    scope: { kind: 'account' }, payload: observation }, () => false);
            } catch (error) {
                const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
                logger.warn('[DAEMON RUN] Host Event projection failed (ignored)', {
                    code: typeof code === 'string' ? code : 'automation_event_host_evidence_unavailable',
                });
            }
        },
    };
}
