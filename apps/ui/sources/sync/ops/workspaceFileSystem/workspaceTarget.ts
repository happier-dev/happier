import type { WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type MachineFileSystemTarget = Readonly<{
    kind?: undefined;
    workspace?: never;
    machineId: string;
    rootPath: string;
    agentRootPath?: string | null;
    serverId?: string | null;
}>;

export type WorkspaceFileSystemTarget = MachineFileSystemTarget | Readonly<{
    kind: 'managed';
    workspace: Extract<WorkspaceAddressV2, { kind: 'managed' }>;
}>;

export function workspaceFileSystemTargetFromScope({ workspace, ...machine }: Omit<MachineFileSystemTarget, 'workspace'> & Pick<WorkspaceScopeBase, 'workspace'>): WorkspaceFileSystemTarget {
    return workspace ? { kind: 'managed', workspace } : machine;
}

/** The controller carries a managed request. The address still names the guest filesystem. */
export function projectWorkspaceFileSystemRoute(target: WorkspaceFileSystemTarget): MachineFileSystemTarget {
    if (target.kind !== 'managed') return target;
    return { machineId: target.workspace.controller.machineId, rootPath: target.workspace.rootPath, serverId: target.workspace.serverId };
}
