import type { ScmDiffArea } from '@happier-dev/protocol';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { isBinaryContent, isKnownBinaryPath } from '@/scm/utils/filePresentation';
import { buildAddedFileUnifiedDiff, decodeUtf8Base64 } from '@/scm/diff/fallbackUnifiedDiff';
import { looksLikeUnifiedDiff } from '@/scm/diff/looksLikeUnifiedDiff';
import { extractUnifiedDiffForSingleFile } from '@/scm/diff/extractUnifiedDiffForSingleFile';
import { machineScmDiffFile } from '@/sync/ops/scm/machineScm';
import { workspaceReadFile } from '@/sync/ops/workspaceFileSystem';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export async function fetchWorkspaceUnifiedDiffForPath(input: Readonly<{
    scope: WorkspaceScopeBase;
    diffArea: ScmDiffArea;
    path: string;
    file: ScmFileStatus | null;
    normalizeError: (input: unknown) => string;
    fallbackError: string;
}>): Promise<Readonly<{ success: true; diff: string }> | Readonly<{ success: false; error: string }>> {
    const response = await machineScmDiffFile(input.scope.machineId, {
        cwd: input.scope.rootPath,
        path: input.path,
        area: input.diffArea,
    }, { serverId: input.scope.serverId });
    if (!response.success) {
        const rawError = typeof response.error === 'string' ? response.error : '';
        const normalized = rawError.trim() ? input.normalizeError(rawError) : '';
        return {
            success: false,
            error: (typeof normalized === 'string' && normalized.trim()) ? normalized : input.fallbackError,
        };
    }

    let resolvedDiff = response.diff ?? '';
    if (resolvedDiff.includes('diff --git ') && (resolvedDiff.match(/^diff --git /gm) ?? []).length > 1) {
        resolvedDiff = extractUnifiedDiffForSingleFile({ patch: resolvedDiff, path: input.path });
    }
    if (resolvedDiff && !looksLikeUnifiedDiff(resolvedDiff)) {
        resolvedDiff = '';
    }

    const file = input.file;
    const shouldTryNewFileFallback =
        !resolvedDiff
        && file
        && (file.status === 'untracked' || file.status === 'added')
        && !isKnownBinaryPath(input.path);

    if (shouldTryNewFileFallback) {
        const readRes = await workspaceReadFile(input.scope, input.path);
        if (readRes?.success && typeof readRes.content === 'string') {
            const decoded = decodeUtf8Base64(readRes.content);
            if (!isBinaryContent(decoded)) {
                resolvedDiff = buildAddedFileUnifiedDiff({ filePath: input.path, newText: decoded });
            }
        }
    }

    return { success: true, diff: resolvedDiff };
}
