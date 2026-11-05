import { sessionScmDiffFile } from '@/sync/ops';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { fetchWorkspaceUnifiedDiffForPath, invalidateWorkspaceUnifiedDiffPath } from './fetchWorkspaceUnifiedDiffForPath';
import { buildFileDiffRequest, fetchUnifiedDiffForPath, type UnifiedDiffInput } from './fetchUnifiedDiffForPath';

type Input = Omit<UnifiedDiffInput, 'cacheKey' | 'loadDiff' | 'readFileForFallback'> & Readonly<{
    sessionId: string;
    snapshotSignature?: string | null;
    readFileForFallback?: () => Promise<string | null>;
}>;

export function fetchSessionUnifiedDiffForPath(input: Input): ReturnType<typeof fetchUnifiedDiffForPath> {
    const scope = resolveWorkspaceTargetForSession(input.sessionId);
    if (scope) return fetchWorkspaceUnifiedDiffForPath({ ...input, scope });
    // Session-only transport remains reachable without workspace metadata. It cannot
    // share workspace authority or perform the workspace-backed file fallback.
    return fetchUnifiedDiffForPath({
        ...input,
        loadDiff: () => sessionScmDiffFile(input.sessionId, buildFileDiffRequest(input)),
        readFileForFallback: input.readFileForFallback ?? (async () => null),
    });
}

export function invalidateSessionUnifiedDiffPath(input: Readonly<{ sessionId: string; path: string }>): void {
    const scope = resolveWorkspaceTargetForSession(input.sessionId);
    if (scope) invalidateWorkspaceUnifiedDiffPath({ scope, path: input.path });
}
