import type {
    ProjectLaunchPlacementProjectV1,
    ProjectLaunchPlacementSnapshotV1,
    WorkspaceRefV1,
} from '@happier-dev/protocol';

import { normalizeWorkspaceScopeBase, type WorkspaceScopeBase } from './workspaceScope';

/**
 * Assembles the projects a launch placement join reads, from the registry this
 * client already holds.
 *
 * The registry is Account Settings `workspaceRefsV1` and the snapshot is the
 * one already keyed by the same workspace scope, so this is a read of existing
 * state — not an index, a probe, or a fan-out. A ref whose scope does not
 * normalize is dropped rather than queried under a guessed key.
 *
 * Reachability and snapshot access are injected because this module owns
 * neither: `isMachineOnline` and the workspace SCM snapshot store remain their
 * own canonical owners.
 */
export function collectProjectLaunchPlacementProjects(input: Readonly<{
    workspaceRefs: readonly WorkspaceRefV1[];
    readSnapshot: (scope: WorkspaceScopeBase) => ProjectLaunchPlacementSnapshotV1 | null;
    isMachineReachable: (machineId: string) => boolean;
}>): readonly ProjectLaunchPlacementProjectV1[] {
    const projects: ProjectLaunchPlacementProjectV1[] = [];
    for (const workspaceRef of input.workspaceRefs) {
        const scope = normalizeWorkspaceScopeBase({
            serverId: workspaceRef.serverId,
            machineId: workspaceRef.machineId,
            rootPath: workspaceRef.rootPath,
        });
        if (!scope) continue;
        projects.push({
            workspaceRef,
            snapshot: input.readSnapshot(scope),
            reachable: input.isMachineReachable(scope.machineId),
        });
    }
    return projects;
}
