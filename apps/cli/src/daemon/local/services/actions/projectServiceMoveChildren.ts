import { createHash } from 'node:crypto';
import { createProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';
import type { ProjectServiceRelocateInputV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecutorContext, HostReviewedChildrenPlanV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { StoredCredentials } from '@/persistence';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { readWorkspaceSyncWorkerTargetSnapshot, resolveWorkspaceSyncWorkerTarget } from '@/workspaces/sync/workspaceSyncPreparation';

/** One producer for the operands reviewed at SOURCE and later executed by Move. */
export function projectServiceMoveStatusInput(request: ProjectServiceRelocateInputV1, machineId: string) {
    return { workspace: request.workspace, destination: { kind: 'machine' as const, machineId }, purpose: 'service-start' as const };
}

export function projectServiceMoveSnapshotInput(request: ProjectServiceRelocateInputV1, workspace: WorkspaceRefV1) {
    return { machineId: request.currentTarget.machineId, projection: 'managed_bindings' as const,
        scope: 'workspace' as const, workspaceRoot: workspace.rootPath };
}

export function projectServiceMoveStopInput(request: ProjectServiceRelocateInputV1) {
    // Parent ids permit 2,000 characters; native control ids permit 256.
    return { requestId: createHash('sha256').update(request.requestId).digest('hex'),
        action: 'stop_managed' as const, force: false, target: request.currentTarget };
}

export function projectServiceMoveInspectionInput(workspace: WorkspaceRefV1, reviewSetupConsent?: true) {
    return { workspace: workspaceAddressFromRefV1(workspace), read: { kind: 'setup' as const },
        ...(reviewSetupConsent ? { reviewSetupConsent } : {}) };
}

export function projectServiceMoveStartInput(request: ProjectServiceRelocateInputV1, destination: WorkspaceRefV1) {
    const selection = request.currentTarget.declaration!.selection;
    return { machineId: destination.machineId,
        targetId: createProjectServiceDeclarationTargetIdV1(destination, selection), workspaceId: destination.id,
        workspace: { serverId: destination.serverId, machineId: destination.machineId,
            workspaceId: destination.id, rootPath: destination.rootPath },
        declaration: { workspaceRefId: destination.id, selection },
        choice: request.destination.kind === 'primary' ? { kind: 'primary' as const }
            : { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: destination.machineId } } };
}

export function projectServiceMoveChildRole(actionId: string, input: unknown): string {
    return actionId === 'projects.inspect'
        ? input && typeof input === 'object' && 'reviewSetupConsent' in input && input.reviewSetupConsent === true
            ? 'service.inspect.destination' : 'service.inspect.source'
        : `service.${actionId}`;
}

/** Prepare the exact demanded operands once, before the parent policy review. */
export async function prepareProjectServiceMoveChildren(input: Readonly<{
    request: ProjectServiceRelocateInputV1;
    context: ActionExecutorContext;
    credentials?: StoredCredentials;
    serverBaseUrl: string;
}>) {
    const fail = (code: string) => ({ ok: false as const, errorCode: code, error: code });
    const { request, context } = input;
    const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
    if (context.externalActionExecutionAuthorization && !requester) return fail('project_requester_authority_unavailable');
    const credentials = requester?.credentials ?? input.credentials;
    if (!credentials || requester && !await requester.isCurrent()) return fail('project_requester_authority_unavailable');
    if (!request.currentTarget.declaration) return fail('service_inputs_changed');
    const snapshot = await readWorkspaceSyncWorkerTargetSnapshot({ serverId: request.workspace.serverId,
        serverHttpBaseUrl: input.serverBaseUrl, sourceWorkspaceRefId: request.workspace.refId,
        targetMachineId: request.selectedTarget.machineId, credentials,
        ...(context.externalActionExecutionAuthorization ? { authorization: context.externalActionExecutionAuthorization } : {}),
        ...(context.signal ? { signal: context.signal } : {}) });
    const basis = resolveWorkspaceSyncWorkerTarget({ serverId: request.workspace.serverId,
        sourceWorkspaceRefId: request.workspace.refId, targetMachineId: request.selectedTarget.machineId,
        workspaceRefs: snapshot.workspaceRefs, relationships: snapshot.relationships, childMachines: snapshot.childMachines });
    if (!basis.ok) return fail(basis.errorCode);
    const incumbent = snapshot.workspaceRefs.find(workspace => workspace.serverId === request.workspace.serverId
        && workspace.machineId === request.currentTarget.machineId && workspace.id === request.currentTarget.workspaceId);
    if (!incumbent) return fail('service_inputs_changed');
    const children: HostReviewedChildrenPlanV1['children'][number][] = [];
    const add = (action: ActionId, value: unknown) => {
        const normalized = projectNativeJsonValueForTransport(getActionSpec(action).inputSchema.parse(value));
        children.push({ action, role: projectServiceMoveChildRole(action, normalized), input: normalized });
    };
    add('localServices.launcher.snapshot', projectServiceMoveSnapshotInput(request, incumbent));
    add('projects.service.placement.set', request.desiredPlacement);
    if (basis.target.machineId !== incumbent.machineId || basis.target.id !== incumbent.id) {
        add('projects.worker.status', projectServiceMoveStatusInput(request, basis.target.machineId));
        add('projects.inspect', projectServiceMoveInspectionInput(basis.source));
        add('projects.inspect', projectServiceMoveInspectionInput(basis.target, true));
        add('localServices.actions.stopManaged', projectServiceMoveStopInput(request));
        add('localServices.launcher.start', projectServiceMoveStartInput(request, basis.target));
    }
    return { children } satisfies HostReviewedChildrenPlanV1;
}
