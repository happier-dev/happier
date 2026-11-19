import type { WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type MachineFileSystemTarget = Readonly<{
    kind?: undefined;
    machineId: string;
    rootPath: string;
    agentRootPath?: string | null;
    serverId?: string | null;
}>;

export type WorkspaceFileSystemTarget = MachineFileSystemTarget | Readonly<{
    kind: 'managed';
    workspace: Extract<WorkspaceAddressV2, { kind: 'managed' }>;
}>;

export function workspaceFileSystemTargetFromScope(scope: WorkspaceScopeBase): WorkspaceFileSystemTarget {
    return scope.workspace ? { kind: 'managed', workspace: scope.workspace } : scope;
}

/** The controller carries a managed request. The address still names the guest filesystem. */
export function projectWorkspaceFileSystemRoute(target: WorkspaceFileSystemTarget): MachineFileSystemTarget {
    if (target.kind !== 'managed') return target;
    return { machineId: target.workspace.controller.machineId, rootPath: target.workspace.rootPath, serverId: target.workspace.serverId };
}
