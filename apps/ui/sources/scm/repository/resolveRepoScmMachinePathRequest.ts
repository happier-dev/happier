import { storage } from '@/sync/domains/state/storage';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export function resolveRepoScmMachinePathRequest(input: Readonly<{
    serverId?: string | null;
    machineId: string;
    path: string;
    homeDir?: string | null;
    workspace?: WorkspaceScopeBase['workspace'];
}>): Readonly<{
    machineId: string;
    resolvedPath: string;
    repoIdentityPrefix: string;
    repoIdentityKey: string;
}> | null {
    if (input.workspace) {
        const workspace = input.workspace;
        const machineId = workspace.controller.machineId;
        const repoIdentityPrefix = tryBuildWorkspaceCacheKey({ serverId: workspace.serverId, machineId, rootPath: workspace.rootPath, workspace });
        return repoIdentityPrefix ? { machineId, resolvedPath: workspace.rootPath, repoIdentityPrefix,
            repoIdentityKey: `${repoIdentityPrefix}:${workspace.rootPath}` } : null;
    }
    const hasSelectedServer = Object.prototype.hasOwnProperty.call(input, 'serverId')
        && input.serverId !== undefined;
    const serverId = typeof input.serverId === 'string' ? input.serverId.trim() : '';
    const machineId = input.machineId.trim();
    const rawPath = input.path.trim();
    if (!machineId || !rawPath || (hasSelectedServer && !serverId)) {
        return null;
    }

    const homeDir = Object.prototype.hasOwnProperty.call(input, 'homeDir')
        ? input.homeDir ?? undefined
        : storage.getState().machines?.[machineId]?.metadata?.homeDir;
    const resolvedPath = resolveAbsolutePath(rawPath, homeDir);
    const repoIdentityPrefix = serverId
        ? `server:${JSON.stringify(serverId)}:machine:${JSON.stringify(machineId)}`
        : machineId;
    return {
        machineId,
        resolvedPath,
        repoIdentityPrefix,
        repoIdentityKey: `${repoIdentityPrefix}:${resolvedPath}`,
    };
}
