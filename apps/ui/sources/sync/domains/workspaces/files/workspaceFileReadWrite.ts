import { WORKSPACE_WRITE_FILE_TOO_LARGE_ERROR, workspaceWriteFile as writeWorkspaceFile } from '@/sync/ops/workspaceFileSystem';

import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type WorkspaceWriteFileResponse =
    | Readonly<{ success: true; hash: string }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

export { WORKSPACE_WRITE_FILE_TOO_LARGE_ERROR };

export async function workspaceWriteFile(params: Readonly<{
    scope: WorkspaceScopeBase;
    path: string;
    content: string;
    expectedHash?: string | null;
}>): Promise<WorkspaceWriteFileResponse> {
    return await writeWorkspaceFile(
        {
            machineId: params.scope.machineId,
            rootPath: params.scope.rootPath,
            serverId: params.scope.serverId,
        },
        params.path,
        params.content,
        params.expectedHash,
    );
}
