import { scmDiffCache } from '@/scm/diffCache/scmDiffCacheSingleton';
import { machineScmDiffFile } from '@/sync/ops/scm/machineScm';
import { buildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { decodeUtf8Base64 } from './fallbackUnifiedDiff';
import { buildFileDiffRequest, fetchUnifiedDiffForPath, type UnifiedDiffInput } from './fetchUnifiedDiffForPath';

type Input = Omit<UnifiedDiffInput, 'cacheKey' | 'loadDiff' | 'readFileForFallback'> & Readonly<{
    scope: WorkspaceScopeBase;
    snapshotSignature?: string | null;
    readFileForFallback?: () => Promise<string | null>;
}>;

export function fetchWorkspaceUnifiedDiffForPath(input: Input): ReturnType<typeof fetchUnifiedDiffForPath> {
    return fetchUnifiedDiffForPath({
        ...input,
        cacheKey: input.snapshotSignature ? { sessionId: buildWorkspaceCacheKey(input.scope), snapshotSignature: input.snapshotSignature, diffArea: input.diffArea, path: input.path } : null,
        loadDiff: () => machineScmDiffFile(input.scope.machineId, { cwd: input.scope.rootPath, ...buildFileDiffRequest(input) }, { serverId: input.scope.serverId }),
        readFileForFallback: input.readFileForFallback ?? (async () => {
            const { workspaceReadFile } = await import('@/sync/ops/workspaceFileSystem/fileReadWrite');
            const response = await workspaceReadFile(input.scope, input.path);
            return response.success && typeof response.content === 'string' ? decodeUtf8Base64(response.content) : null;
        }),
    });
}

export function invalidateWorkspaceUnifiedDiffPath(input: Readonly<{ scope: WorkspaceScopeBase; path: string }>): void {
    scmDiffCache.invalidatePaths({ sessionId: buildWorkspaceCacheKey(input.scope), paths: new Set([input.path]) });
}
