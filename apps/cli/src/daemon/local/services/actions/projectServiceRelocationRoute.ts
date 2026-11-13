import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { DaemonLocalServiceLauncherStartRequestV1Schema, DaemonLocalServiceLauncherStartResponseV1Schema, LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { LocalServiceActionResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { ProjectWorkerStatusResultV1Schema } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { ProjectServicePlacementMutationResultV1Schema } from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import type { ProjectServiceRelocateInputV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import type { RuntimeActionExecuteArgs } from '@happier-dev/protocol/actions';

import type { StoredCredentials } from '@/persistence';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import type { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import type { WorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import {
    readWorkspaceSyncWorkerTargetSnapshot, readWorkspaceSyncWorkerRouteSnapshot,
    resolveWorkspaceSyncWorkerTarget,
} from '@/workspaces/sync/workspaceSyncPreparation';
import { createProjectServiceRelocation } from '@/workspaces/execution/projectServiceRelocation';
import { projectActionOperationFailure } from '@/daemon/actionOperations/actionOperationFailure';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { projectServiceMoveStatusInput, projectServiceMoveSnapshotInput, projectServiceMoveStopInput,
    projectServiceMoveInspectionInput, projectServiceMoveStartInput, projectServiceMoveChildRole } from './projectServiceMoveChildren';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';

type CanonicalChildAction = NonNullable<RuntimeActionExecuteArgs['executeCanonicalAction']>;

function refusal(reasonCode: string, error?: string) {
    return { status: 'refused' as const, reasonCode, ...(error ? { error } : {}) };
}

/** Production composition for the source-daemon relocation coordinator. */
export function createProjectServiceRelocationRoute(input: Readonly<{
    serverBaseUrl: string;
    credentials: StoredCredentials;
    projectManagedServices: Pick<ReturnType<typeof createManagedServicesOwner>, 'resolveProjectService'>
        & Partial<Pick<ReturnType<typeof createManagedServicesOwner>, 'restoreProjectServices'>>;
    resolveWorkspaceSyncHandoffAdapter(): WorkspaceSyncHandoffAdapter | null;
}>) {
    return async (
        request: ProjectServiceRelocateInputV1,
        context: RuntimeActionExecuteArgs['context'],
        executeCanonicalAction?: RuntimeActionExecuteArgs['executeCanonicalAction'],
        ingress?: RpcHandlerContext,
    ) => {
        const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
        if (context.externalActionExecutionAuthorization && (!requester || !await requester.isCurrent())) {
            return { ok: true as const, result: refusal('project_requester_authority_unavailable') };
        }
        const credentials = requester?.credentials ?? input.credentials;
        await input.projectManagedServices.restoreProjectServices?.();
        const execute: CanonicalChildAction | undefined = context.hostReviewedChild
            ? (action, childInput) => {
                const normalized = projectNativeJsonValueForTransport(getActionSpec(action).inputSchema.parse(childInput));
                return context.hostReviewedChild!.invoke({ action, role: projectServiceMoveChildRole(action, normalized), input: normalized });
            } : context.externalActionExecutionAuthorization ? undefined : executeCanonicalAction;
        const resolveDestination = async (signal?: AbortSignal) => {
            const targetMachineId = request.selectedTarget.machineId;
            try {
                const start = context.hostReviewedChild?.preparedChildren
                    ?.find(child => child.action === 'localServices.launcher.start');
                const selected = start ? DaemonLocalServiceLauncherStartRequestV1Schema.parse(start.input).workspace?.workspaceId : undefined;
                const snapshot: Awaited<ReturnType<typeof readWorkspaceSyncWorkerRouteSnapshot>> & Partial<
                    Pick<Awaited<ReturnType<typeof readWorkspaceSyncWorkerTargetSnapshot>>, 'relationshipStatuses'>
                > = await (selected ? readWorkspaceSyncWorkerRouteSnapshot : readWorkspaceSyncWorkerTargetSnapshot)({
                    serverId: request.workspace.serverId,
                    serverHttpBaseUrl: input.serverBaseUrl,
                    targetMachineId,
                    sourceWorkspaceRefId: request.workspace.refId,
                    credentials,
                    authorization: context.externalActionExecutionAuthorization,
                    ...(signal ? { signal } : {}),
                });
                const basis = resolveWorkspaceSyncWorkerTarget({
                    serverId: request.workspace.serverId,
                    sourceWorkspaceRefId: request.workspace.refId,
                    targetMachineId,
                    ...(selected ? { targetWorkspaceRefId: selected } : {}),
                    workspaceRefs: snapshot.workspaceRefs,
                    relationships: snapshot.relationships,
                    childMachines: snapshot.childMachines,
                    relationshipStatuses: snapshot.relationshipStatuses ?? [],
                });
                return basis.ok ? { status: 'resolved' as const, workspace: basis.target }
                    : refusal(basis.errorCode);
            } catch (error) {
                signal?.throwIfAborted();
                const failure = await projectActionOperationFailure(error, 'workspace_sync_source_unavailable');
                return refusal(failure.errorCode, failure.error);
            }
        };
        const coordinator = createProjectServiceRelocation({
            readService: async (_request, signal) => {
                // Re-read the exact native binding after placement persistence;
                // requester authority was admitted at the request boundary.
                const resolved = input.projectManagedServices.resolveProjectService(request.currentTarget);
                if (resolved.status !== 'found') {
                    if (resolved.status === 'mismatch') return refusal('service_inputs_changed');
                    if (!execute) return refusal('unknown_managed_service');
                    try {
                        // The Account ref supplies the exact root; the custodian's complete
                        // managed projection supplies native identity and admitted execution.
                        const target = request.currentTarget;
                        const refs = await readWorkspaceSyncWorkerRouteSnapshot({
                            serverId: request.workspace.serverId, serverHttpBaseUrl: input.serverBaseUrl,
                            sourceWorkspaceRefId: request.workspace.refId, targetMachineId: target.machineId,
                            credentials, authorization: context.externalActionExecutionAuthorization, ...(signal ? { signal } : {}),
                        });
                        const workspace = refs.workspaceRefs.find(ref => ref.serverId === request.workspace.serverId
                            && ref.machineId === target.machineId && ref.id === target.workspaceId);
                        if (!workspace) return refusal('service_inputs_changed');
                        const result = await execute('localServices.launcher.snapshot', projectServiceMoveSnapshotInput(request, workspace));
                        if (!result.ok) return refusal(result.errorCode ?? 'service_observation_unavailable');
                        const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(result.result);
                        if (snapshot.machineId !== target.machineId) return refusal('service_inputs_changed');
                        const observed = snapshot.targets.find(candidate => candidate.sourceClass?.kind === 'managed_service'
                            && candidate.sourceClass.managedServiceId === target.managedServiceId);
                        if (!observed) return refusal('unknown_managed_service');
                        const currentTarget = { kind: 'managed_service' as const, managedServiceId: target.managedServiceId,
                            machineId: observed.machineId, workspaceId: observed.workspaceId,
                            cwd: observed.cwd, declaration: observed.declaration };
                        if (!currentTarget.cwd || !currentTarget.declaration || !currentTarget.workspaceId
                            || observed.sessionId !== undefined
                            || createCanonicalJsonSigningInput(currentTarget) !== createCanonicalJsonSigningInput(target)) {
                            return refusal('service_inputs_changed');
                        }
                        if (!observed.execution) return refusal('service_execution_unavailable');
                        if (!observed.serviceState) return refusal('service_observation_unavailable');
                        return { status: 'resolved' as const, execution: observed.execution,
                            currentTarget: { ...currentTarget, cwd: currentTarget.cwd, declaration: currentTarget.declaration,
                                workspaceId: currentTarget.workspaceId },
                            workspace, instanceId: target.managedServiceId, snapshot: { state: observed.serviceState } };
                    } catch {
                        signal?.throwIfAborted();
                        return refusal('service_observation_unavailable');
                    }
                }
                const handle = resolved.handle;
                if (handle.kind !== 'workspace') return refusal('workspace_service_required');
                if (!handle.execution) return refusal('service_execution_unavailable');
                return {
                    status: 'resolved' as const,
                    execution: handle.execution,
                    currentTarget: {
                        ...request.currentTarget,
                        machineId: handle.workspace.machineId,
                        workspaceId: handle.workspace.id,
                        cwd: handle.cwd,
                        declaration: handle.declaration,
                    },
                    workspace: handle.workspace,
                    instanceId: handle.instanceId,
                    snapshot: handle.snapshot(),
                };
            },
            resolveDestination: async (_request, signal) => {
                const selected = await resolveDestination(signal);
                if (selected.status === 'refused') return selected;
                const destination = selected.workspace;
                // An unchanged placement has no destination launch to admit.
                if (destination.machineId === request.currentTarget.machineId
                    && destination.id === request.currentTarget.workspaceId) return selected;
                if (!execute) return refusal('project_worker_status_unavailable');
                const result = await execute('projects.worker.status', projectServiceMoveStatusInput(request, destination.machineId));
                signal?.throwIfAborted();
                if (!result.ok) return refusal(result.errorCode ?? 'project_worker_status_unavailable', result.error);
                const status = ProjectWorkerStatusResultV1Schema.safeParse(result.result);
                return status.success && status.data.eligible
                    && status.data.candidate.machineId === destination.machineId
                    ? selected
                    : refusal(status.success && !status.data.eligible
                        ? `project_worker_${status.data.explanation}` : 'project_worker_status_unavailable');
            },
            saveDesiredPlacement: async (placement, signal) => {
                if (!execute) return { status: 'unavailable' as const };
                const result = await execute('projects.service.placement.set', placement);
                signal?.throwIfAborted();
                if (!result.ok) return { status: 'unavailable' as const };
                const parsed = ProjectServicePlacementMutationResultV1Schema.safeParse(result.result);
                return parsed.success ? parsed.data : { status: 'unavailable' as const };
            },
            stopService: async (target, signal) => {
                const resolved = input.projectManagedServices.resolveProjectService(target);
                if (resolved.status === 'found') return await resolved.handle.stop(signal ? { signal } : undefined);
                if (resolved.status === 'mismatch' || !execute) return { status: 'termination_incomplete' as const };
                const stopInput = projectServiceMoveStopInput(request);
                const result = await execute('localServices.actions.stopManaged', stopInput);
                if (!result.ok) return { status: 'termination_incomplete' as const };
                const stopped = LocalServiceActionResultV1Schema.parse(result.result);
                if (stopped.requestId !== stopInput.requestId || stopped.action !== 'stop_managed') {
                    return { status: 'termination_incomplete' as const };
                }
                return { status: stopped.status === 'succeeded' ? 'stopped' as const
                    : stopped.reasonCode === 'service_control_unsupported' ? 'unsupported' as const : 'termination_incomplete' as const };
            },
            reviewDestinationSetup: async (_request, _destination, signal) => {
                if (!execute || !request.setupReview) return refusal('project_setup_review_unavailable');
                const prepared = context.hostReviewedChild?.preparedChildren
                    ?.find(child => child.action === 'projects.inspect' && child.role === 'service.inspect.setup');
                let inspectionInput: unknown = prepared?.input;
                if (!inspectionInput) {
                    const snapshot = await readWorkspaceSyncWorkerRouteSnapshot({ serverId: request.workspace.serverId,
                        serverHttpBaseUrl: input.serverBaseUrl, targetMachineId: request.selectedTarget.machineId,
                        sourceWorkspaceRefId: request.workspace.refId, credentials,
                        authorization: context.externalActionExecutionAuthorization, ...(signal ? { signal } : {}) });
                    const source = snapshot.workspaceRefs.find(ref => ref.serverId === request.workspace.serverId && ref.id === request.workspace.refId);
                    if (!source) return refusal('project_setup_review_unavailable');
                    inspectionInput = projectServiceMoveInspectionInput(source, true);
                }
                // Review the incoming SOURCE effect, not the stale destination manifest.
                // Setup's owner consumes this Move's admitted decision without executing it.
                const result = await execute('projects.inspect', inspectionInput);
                signal?.throwIfAborted();
                if (!result.ok) return refusal(result.errorCode ?? 'project_setup_review_unavailable');
                const inspected = ProjectDefinitionInspectOutputSchema.safeParse(result.result);
                if (!inspected.success || !inspected.data.setupReview) return refusal('project_setup_review_unavailable');
                if (inspected.data.definition.document?.status === 'invalid') return refusal('invalid_manifest');
                if (inspected.data.setupReview.reviewedEffectDigest !== request.setupReview.reviewedEffectDigest) return refusal('project_setup_effect_changed');
                const consent = inspected.data.setupConsent;
                return consent?.kind === 'admitted' ? { status: 'admitted' as const }
                    : refusal(consent?.code ?? 'project_setup_review_unavailable');
            },
            handoffPrepareBetween: async (preparation, signal) => {
                const adapter = input.resolveWorkspaceSyncHandoffAdapter();
                if (!adapter) return { ok: false as const, errorCode: 'workspace_sync_unavailable', completed: [] };
                return await adapter.prepareBetween(preparation, signal, {
                    ...ingress,
                    signal: signal ?? context.signal ?? new AbortController().signal,
                    callerAuthority: context.authority,
                    callerInputAuthorization: context.externalActionExecutionAuthorization,
                    originalActionEnvelope: context.originalActionEnvelope,
                });
            },
            startService: async (startRequest, destination, signal) => {
                if (!execute) return { status: 'failed' as const, reasonCode: 'launcher_start_unavailable' };
                const result = await execute('localServices.launcher.start', projectServiceMoveStartInput(startRequest, destination));
                signal?.throwIfAborted();
                if (!result.ok) {
                    // These acknowledgements refuse this Start before establishment.
                    // Already-claimed can describe an earlier admitted Start, so it
                    // cannot establish native absence and retains the unknown path.
                    const denied = result.errorCode === 'service_move_start_authority_unavailable'
                        || result.errorCode === 'service_move_not_starting'
                        || result.errorCode === 'project_service_runtime_unavailable';
                    return { status: denied ? 'denied' as const : 'failed' as const,
                        reasonCode: result.errorCode ?? 'launcher_start_failed' };
                }
                const parsed = DaemonLocalServiceLauncherStartResponseV1Schema.safeParse(result.result);
                return parsed.success ? {
                    status: parsed.data.status,
                    ...(parsed.data.reasonCode ? { reasonCode: parsed.data.reasonCode } : {}),
                    ...(parsed.data.currentTarget ? { currentTarget: parsed.data.currentTarget } : {}),
                } : { status: 'failed' as const, reasonCode: 'launcher_start_result_unavailable' };
            },
        });
        return await coordinator(request, {
            signal: context.signal,
            updateProgress: context.operationProgress?.update,
            publishOwnerUpdate: context.operationOwnerUpdate?.update,
        });
    };
}
