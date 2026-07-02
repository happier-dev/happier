import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';
import { searchWorkspaceFiles, workspaceFileSearchCache } from '@/sync/domains/workspaces/files/workspaceFileSearch';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { registerSuggestionFileSearchCacheClearer } from '@/sync/domains/input/suggestionFileCacheInvalidation';

export type FileItem = FileSearchItem;

export type SearchOptions = Readonly<{
    limit?: number;
    threshold?: number;
}>;

export const fileSearchCache = {
    clearCache(sessionId?: string) {
        if (typeof sessionId === 'string' && sessionId.trim()) {
            const target = resolveWorkspaceTargetForSession(sessionId);
            if (!target) return;
            workspaceFileSearchCache.clearCache(target.workspaceCacheKey);
            return;
        }
        workspaceFileSearchCache.clearCache();
    },
};
registerSuggestionFileSearchCacheClearer((sessionId) => fileSearchCache.clearCache(sessionId));

export async function searchFiles(
    sessionId: string,
    query: string,
    options: SearchOptions = {},
): Promise<FileItem[]> {
    const target = resolveWorkspaceTargetForSession(sessionId);
    if (!target) return [];

    return await searchWorkspaceFiles({
        workspaceCacheKey: target.workspaceCacheKey,
        machineId: target.machineId,
        rootPath: target.rootPath,
        serverId: target.serverId,
        query,
        limit: options.limit,
        threshold: options.threshold,
    });
}
