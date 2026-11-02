import type { ActionOperationSnapshotV1, LocalServiceLaunchTargetV1 } from '@happier-dev/protocol';
import { createProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';

import { isWorkspacePathWithin } from '../inventory/provenance';
import { formatLocalServiceLauncherTitle } from './suggestions';

/** Preparation belongs to the accepted Action; native custody takes over as soon as it exists. */
export function projectStartingServiceTargets(
    targets: readonly LocalServiceLaunchTargetV1[],
    operations: readonly ActionOperationSnapshotV1[],
    machineId: string,
    workspaceScopePaths: readonly string[] | undefined,
): readonly LocalServiceLaunchTargetV1[] {
    const byId = new Map(targets.map(target => [target.id, target]));
    for (const operation of operations) {
        const ref = operation.domainRef;
        if (operation.actionId !== 'localServices.launcher.start'
            || operation.state !== 'accepted' && operation.state !== 'running'
            || ref?.kind !== 'projectService' || ref.purpose !== 'start'
            || !ref.workspace || !ref.declaration || ref.workspace.machineId !== machineId
            || ref.declaration.workspaceRefId !== ref.workspace.workspaceId
            || workspaceScopePaths && !workspaceScopePaths.some(root => isWorkspacePathWithin(root, ref.workspace!.rootPath))) continue;
        const workspace = ref.workspace;
        const declaration = ref.declaration;
        const id = createProjectServiceDeclarationTargetIdV1({ serverId: workspace.serverId, machineId,
            id: workspace.workspaceId }, declaration.selection);
        const current = byId.get(id);
        // A healthy/running/unknown native occurrence already answers the live question,
        // even if transport settlement of the finite Start is still outstanding.
        if (current?.serviceState && current.serviceState !== 'failed' && current.serviceState !== 'stopped') continue;
        byId.set(id, {
            id, source: 'managed_service', machineId, workspaceId: workspace.workspaceId,
            workspace, declaration, cwd: workspace.rootPath,
            title: current?.title ?? formatLocalServiceLauncherTitle(declaration.selection.kind === 'manifest'
                ? declaration.selection.name : declaration.selection.source.target),
            subtitle: workspace.rootPath, confidence: 'high', state: 'starting', serviceState: 'starting', actions: [],
        });
    }
    return [...byId.values()];
}
