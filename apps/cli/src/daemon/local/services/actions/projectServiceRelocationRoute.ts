import { createHash } from 'node:crypto';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { DaemonLocalServiceLauncherStartResponseV1Schema, LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createProjectServiceDeclarationTargetIdV1, LocalServiceActionResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
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
    readWorkspaceSyncWorkerTargetSnapshot,
    resolveWorkspaceSyncWorkerTarget,
} from '@/workspaces/sync/workspaceSyncPreparation';
import { createProjectServiceRelocation } from '@/workspaces/execution/projectServiceRelocation';
import { projectActionOperationFailure } from '@/daemon/actionOperations/actionOperationFailure';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

type CanonicalChildAction = NonNullable<RuntimeActionExecuteArgs['executeCanonicalAction']>;

function refusal(reasonCode: string, error?: string) {
    return { status: 'refused' as const, reasonCode, ...(error ? { error } : {}) };
}

/** Production composition for the source-daemon relocation coordinator. */
export function createProjectServiceRelocationRoute(input: Readonly<{
    serverBaseUrl: string;
    credentials: StoredCredentials;
    projectManagedServices: Pick<ReturnType<typeof createManagedServicesOwner>, 'resolveProjectService'>;
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
        const execute = executeCanonicalAction as CanonicalChildAction | undefined;
        const resolveDestination = async (signal?: AbortSignal) => {
            const targetMachineId = request.selectedTarget.machineId;
            try {
                const snapshot = await readWorkspaceSyncWorkerTargetSnapshot({
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
                    workspaceRefs: snapshot.workspaceRefs,
                    relationships: snapshot.relationships,
                    childMachines: snapshot.childMachines,
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
                // The coordinator re-reads after placement persistence. Local
                // native custody must not outlive the original requester's root.
                if (requester && !await requester.isCurrent()) return refusal('project_requester_authority_unavailable');
                const resolved = input.projectManagedServices.resolveProjectService(request.currentTarget);
                if (resolved.status !== 'found') {
                    if (resolved.status === 'mismatch') return refusal('service_inputs_changed');
                    if (!execute) return refusal('unknown_managed_service');
                    try {
                        // The Account ref supplies the exact root; the custodian's complete
                        // managed projection supplies native identity and admitted execution.
                        const target = request.currentTarget;
                        const refs = await readWorkspaceSyncWorkerTargetSnapshot({
                            serverId: request.workspace.serverId, serverHttpBaseUrl: input.serverBaseUrl,
                            sourceWorkspaceRefId: request.workspace.refId, targetMachineId: target.machineId,
                            credentials, authorization: context.externalActionExecutionAuthorization, ...(signal ? { signal } : {}),
                        });
                        const workspace = refs.workspaceRefs.find(ref => ref.serverId === request.workspace.serverId
                            && ref.machineId === target.machineId && ref.id === target.workspaceId);
                        if (!workspace) return refusal('service_inputs_changed');
                        const result = await execute('localServices.launcher.snapshot', { machineId: target.machineId,
                            projection: 'managed_bindings', scope: 'workspace', workspaceRoot: workspace.rootPath });
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
            resolveDestination: async (_request, signal) => await resolveDestination(signal),
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
                // Move's existing request id allows 2,000 characters; the control
                // contract allows 256. Preserve all valid parent ids without truncation.
                const stopRequestId = createHash('sha256').update(request.requestId).digest('hex');
                const result = await execute('localServices.actions.stopManaged', { requestId: stopRequestId,
                    action: 'stop_managed', force: false, target });
                if (!result.ok) return { status: 'termination_incomplete' as const };
                const stopped = LocalServiceActionResultV1Schema.parse(result.result);
                if (stopped.requestId !== stopRequestId || stopped.action !== 'stop_managed') {
                    return { status: 'termination_incomplete' as const };
                }
                return { status: stopped.status === 'succeeded' ? 'stopped' as const
                    : stopped.reasonCode === 'service_control_unsupported' ? 'unsupported' as const : 'termination_incomplete' as const };
            },
            revalidateDestination: async (_request, destination, signal) => {
                const current = await resolveDestination(signal);
                if (current.status === 'refused') return current;
                if (createCanonicalJsonSigningInput(current.workspace) !== createCanonicalJsonSigningInput(destination)) {
                    return refusal('selected_target_changed');
                }
                if (!execute) return refusal('project_worker_status_unavailable');
                const result = await execute('projects.worker.status', {
                    workspace: request.workspace,
                    destination: { kind: 'machine', machineId: destination.machineId },
                    purpose: 'service-start',
                });
                signal?.throwIfAborted();
                if (!result.ok) return refusal(result.errorCode ?? 'project_worker_status_unavailable', result.error);
                const status = ProjectWorkerStatusResultV1Schema.safeParse(result.result);
                return status.success && status.data.eligible
                    && status.data.candidate.machineId === destination.machineId
                    ? { status: 'admitted' as const }
                    : refusal(status.success && !status.data.eligible
                        ? `project_worker_${status.data.explanation}` : 'project_worker_status_unavailable');
            },
            reviewDestinationSetup: async (_request, destination, signal) => {
                if (!execute) return refusal('project_setup_review_unavailable');
                const snapshot = await readWorkspaceSyncWorkerTargetSnapshot({ serverId: request.workspace.serverId,
                    serverHttpBaseUrl: input.serverBaseUrl, targetMachineId: destination.machineId,
                    sourceWorkspaceRefId: request.workspace.refId, credentials,
                    authorization: context.externalActionExecutionAuthorization, ...(signal ? { signal } : {}) });
                const source = snapshot.workspaceRefs.find(ref => ref.serverId === request.workspace.serverId && ref.id === request.workspace.refId);
                if (!source) return refusal('project_setup_review_unavailable');
                const inspect = async (workspace: typeof source, reviewSetupConsent?: true) => {
                    const result = await execute('projects.inspect', { workspace: workspaceAddressFromRefV1(workspace),
                        ...(reviewSetupConsent ? { reviewSetupConsent } : {}) });
                    signal?.throwIfAborted();
                    if (!result.ok) return { status: 'refused' as const, reasonCode: result.errorCode ?? 'project_setup_review_unavailable' };
                    const parsed = ProjectDefinitionInspectOutputSchema.safeParse(result.result);
                    return parsed.success ? { status: 'inspected' as const, value: parsed.data } : refusal('project_setup_review_unavailable');
                };
                const original = await inspect(source);
                if (original.status === 'refused') return original;
                const target = await inspect(destination, true);
                if (target.status === 'refused') return target;
                const sourceManifest = original.value.definition.document?.status === 'valid' ? original.value.definition.document.manifest : null;
                const targetManifest = target.value.definition.document?.status === 'valid' ? target.value.definition.document.manifest : null;
                if (original.value.definition.document?.status === 'invalid' || target.value.definition.document?.status === 'invalid') return refusal('invalid_manifest');
                // An empty/stale destination cannot prove consent for setup about to
                // arrive from SOURCE. Review the current target through projects.prepare
                // after its normal Sync copy, then request a fresh Move.
                const setupDeclaration = (manifest: typeof sourceManifest) => ({ setup: manifest?.workspace?.setup ?? [],
                    setupInputs: manifest?.workspace?.setupInputs ?? [], environment: manifest?.environment ?? { kind: 'host' },
                    environmentVariables: manifest?.environmentVariables ?? [], devcontainer: manifest?.devcontainer ?? null });
                if (createCanonicalJsonSigningInput(setupDeclaration(sourceManifest)) !== createCanonicalJsonSigningInput(setupDeclaration(targetManifest))) {
                    return refusal('project_setup_review_unavailable', 'Review and prepare the current destination checkout with projects.prepare before moving the service.');
                }
                const copiedFileFacts = (effect: typeof original.value.setupReview) => {
                    const reviewed = effect?.reviewedEffect;
                    return reviewed && typeof reviewed === 'object' && !Array.isArray(reviewed) && 'files' in reviewed ? reviewed.files : undefined;
                };
                const sourceFiles = copiedFileFacts(original.value.setupReview);
                const targetFiles = copiedFileFacts(target.value.setupReview);
                if (!Array.isArray(sourceFiles) || !Array.isArray(targetFiles)) return refusal('project_setup_review_unavailable');
                // Consent for retained target bytes cannot authorize different
                // setup inputs/native definitions arriving in the upcoming copy.
                if (createCanonicalJsonSigningInput(sourceFiles) !== createCanonicalJsonSigningInput(targetFiles)) {
                    return refusal('project_setup_effect_changed', 'Sync and review destination setup with projects.prepare, then request a fresh Move. The current service is still running.');
                }
                const consent = target.value.setupConsent;
                if (consent?.kind === 'admitted') return { status: 'admitted' as const };
                const readiness = target.value.setupReadiness;
                return refusal(consent?.kind === 'required' ? consent.code : consent?.code
                    ?? (readiness?.kind === 'needsReview' || readiness?.kind === 'unknown' ? readiness.code : 'project_setup_review_unavailable'),
                    'Review destination setup with projects.prepare, then request a fresh Move. The current service is still running.');
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
                const declaration = {
                    workspaceRefId: destination.id,
                    selection: startRequest.currentTarget.declaration.selection,
                };
                const result = await execute('localServices.launcher.start', {
                    machineId: destination.machineId,
                    targetId: createProjectServiceDeclarationTargetIdV1(destination, declaration.selection),
                    workspaceId: destination.id,
                    workspace: {
                        serverId: destination.serverId,
                        machineId: destination.machineId,
                        workspaceId: destination.id,
                        rootPath: destination.rootPath,
                    },
                    declaration,
                    // The pool has already settled to this reviewed exact Machine.
                    choice: request.destination.kind === 'primary'
                        ? { kind: 'primary' }
                        : { kind: 'workers', destination: { kind: 'machine', machineId: destination.machineId } },
                });
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
