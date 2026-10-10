import { resolveWorkspaceDisplayLabel } from '@/sync/domains/workspaces/workspaceLabel';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveWorkspacePathBasenameV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

export function resolveWorkspaceRefDisplayName(workspaceRef: WorkspaceRefV1): string {
    return resolveWorkspaceDisplayLabel({
        scope: {
            serverId: workspaceRef.serverId,
            machineId: workspaceRef.machineId,
            rootPath: workspaceRef.rootPath,
        },
        workspaceRef,
        fallbackPathLabel: resolveWorkspacePathBasenameV1(String(workspaceRef.rootPath ?? '').trim()) ?? workspaceRef.rootPath,
    });
}
