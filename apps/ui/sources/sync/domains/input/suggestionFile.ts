/**
 * The composer's file-suggestion entry point.
 *
 * **Addressed by machine + folder, never by session.** A session is not the scoping unit for
 * reading a workspace's files — the machine and the folder are. A session merely *has* a
 * machine and a folder, so addressing the search by session id names the wrong identity, and
 * it is why the search could not be offered at all before a session existed: the new-session
 * composer had to invent a `'__new_session__'` session to call this, which resolved to no
 * workspace and returned nothing.
 *
 * Resolving a *session* to one of these scopes stays at
 * `@/sync/domains/session/resolveWorkspaceTargetForSession`, and the index itself stays at
 * `@/sync/domains/workspaces/files/workspaceFileSearch` — this module only carries the
 * composer's addressing and the cache-invalidation bridge.
 */
import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';
import { searchWorkspaceFiles, workspaceFileSearchCache } from '@/sync/domains/workspaces/files/workspaceFileSearch';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { registerSuggestionFileSearchCacheClearer } from '@/sync/domains/input/suggestionFileCacheInvalidation';
import {
    normalizeWorkspaceScopeBase,
    type WorkspaceScopeBase,
} from '@/sync/domains/workspaces/workspaceScope';

export type FileItem = FileSearchItem;

/**
 * What a composer's file search is addressed to: the machine, the folder on it, and the
 * server that machine is reached through. `WorkspaceScopeBase` is the repository's existing
 * name for exactly that tuple, and its `tryBuildWorkspaceCacheKey` is the one owner of the
 * index identity — so two composers on one folder share an index and two on different
 * folders cannot collide, whichever host resolved the scope.
 */
export type FileSuggestionScope = WorkspaceScopeBase;

export type SearchOptions = Readonly<{
    limit?: number;
    threshold?: number;
    signal?: AbortSignal;
}>;

export const fileSearchCache = {
    /**
     * Invalidation is still asked in SESSION terms by its only caller (SCM status sync knows
     * which sessions a changed project covers), and answered in workspace terms here: the
     * index a session addresses is the one for its machine + folder, so sessions sharing that
     * folder share one index and are all refreshed by a single clear. A session whose
     * workspace cannot be resolved addresses no index and must clear nothing — never fall
     * through to wiping every workspace's cache.
     */
    clearCache(sessionId?: string) {
        if (typeof sessionId === 'string' && sessionId.trim()) {
            const target = resolveWorkspaceTargetForSession(sessionId);
            if (!target) return;
            workspaceFileSearchCache.clearCache({
                serverId: target.serverId,
                machineId: target.machineId,
                rootPath: target.rootPath,
            });
            return;
        }
        workspaceFileSearchCache.clearAll();
    },
};
registerSuggestionFileSearchCacheClearer((sessionId) => fileSearchCache.clearCache(sessionId));

export async function searchFiles(
    scope: FileSuggestionScope | null,
    query: string,
    options: SearchOptions = {},
): Promise<FileItem[]> {
    if (!scope) return [];
    // Normalize before keying AND before searching, so a trailing separator or a repeated
    // slash is spelling rather than a second index rooted at the same folder.
    const normalized = normalizeWorkspaceScopeBase(scope);
    if (!normalized) return [];

    return await searchWorkspaceFiles({
        scope: normalized,
        query,
        limit: options.limit,
        threshold: options.threshold,
        ...(options.signal ? { signal: options.signal } : {}),
    });
}
