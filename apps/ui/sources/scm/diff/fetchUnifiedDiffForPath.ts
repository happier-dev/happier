import type { ScmDiffArea } from '@happier-dev/protocol';
import type { ScmLiveDiffFileRequest } from '@happier-dev/protocol/scm';

import { scmDiffCache } from '@/scm/diffCache/scmDiffCacheSingleton';
import type { ScmDiffCache } from '@/scm/diffCache/scmDiffCache';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { isBinaryContent, resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { buildAddedFileUnifiedDiff } from '@/scm/diff/fallbackUnifiedDiff';
import { looksLikeUnifiedDiff } from '@/scm/diff/looksLikeUnifiedDiff';
import { extractUnifiedDiffForSingleFile } from '@/scm/diff/extractUnifiedDiffForSingleFile';
import type { ScmDiffCacheKey } from '@/scm/diffCache/scmDiffCache';

export type UnifiedDiffInput = Readonly<{
    cacheKey?: ScmDiffCacheKey | null;
    loadDiff: () => Promise<{ success: boolean; diff?: string; error?: string }>;
    diffArea: ScmDiffArea;
    path: string;
    file: Pick<ScmFileStatus, 'status' | 'hasIncludedDelta' | 'isBinary' | 'oldPath'> | null;
    normalizeError: (input: unknown) => string;
    fallbackError: string;
    diffCache?: ScmDiffCache | null;
    forceRefresh?: boolean;
    readFileForFallback: () => Promise<string | null>;
}>;

export function buildFileDiffRequest(input: Pick<UnifiedDiffInput, 'path' | 'diffArea' | 'file'>): ScmLiveDiffFileRequest {
    return input.file?.oldPath
        ? { renamed: { path: input.path, previousPath: input.file.oldPath }, area: input.diffArea }
        : { path: input.path, area: input.diffArea };
}

export async function fetchUnifiedDiffForPath(input: UnifiedDiffInput): Promise<Readonly<{ success: true; diff: string; emptyFile?: true }> | Readonly<{ success: false; error: string }>> {
    const cache = input.diffCache === undefined ? scmDiffCache : input.diffCache;
    if (cache && input.cacheKey && input.forceRefresh) {
        cache.invalidatePaths({ sessionId: input.cacheKey.sessionId, paths: new Set([input.path]) });
    }
    const response = cache && input.cacheKey
        ? await cache.getOrLoad(input.cacheKey, () => loadDiff(input))
        : await loadDiff(input);
    if (!response.success) {
        const normalized = response.error.trim() ? input.normalizeError(response.error) : '';
        return { success: false, error: typeof normalized === 'string' && normalized.trim() ? normalized : input.fallbackError };
    }
    // A working-tree read cannot reconstruct the separately included content.
    if (response.diff || input.diffArea === 'included') return response;
    const file = input.file;
    const canReadAddedContent = file?.status === 'untracked'
        || (file?.status === 'added' && file.hasIncludedDelta === false);
    const viewer = resolveFileViewerKind({ path: input.path, isBinaryContent: file?.isBinary });
    if (!canReadAddedContent || (viewer.kind !== 'code' && viewer.kind !== 'markdown' && viewer.kind !== 'svg')) return response;
    // Fallback reads have caller-owned preview bounds. Never cache a bounded/unavailable
    // read as backend truth, or share it with a caller using a different read policy.
    const decoded = await input.readFileForFallback();
    // A new file with no bytes has no lines to show: say so, rather than a hunk header with no body.
    if (decoded === '') return { success: true, diff: '', emptyFile: true };
    return {
        success: true,
        diff: decoded !== null && !isBinaryContent(decoded)
            ? buildAddedFileUnifiedDiff({ filePath: input.path, newText: decoded })
            : '',
    };
}

async function loadDiff(input: UnifiedDiffInput): ReturnType<typeof fetchUnifiedDiffForPath> {
    const response = await input.loadDiff();
    if (!response.success) {
        return { success: false, error: typeof response.error === 'string' ? response.error : '' };
    }

    let resolvedDiff = response.diff ?? '';
    // Defensive: some SCM backends return a combined patch for multiple files even when a single file is requested.
    // Pierre (and other diff renderers) assume one file diff at a time.
    if (resolvedDiff.includes('diff --git ') && (resolvedDiff.match(/^diff --git /gm) ?? []).length > 1) {
        resolvedDiff = extractUnifiedDiffForSingleFile({ patch: resolvedDiff, path: input.path });
    }
    if (resolvedDiff && !looksLikeUnifiedDiff(resolvedDiff)) {
        // SCM backends sometimes return a non-unified placeholder for binary files.
        // Treat it as "no diff" so the UI renders a stable fallback state.
        resolvedDiff = '';
    }

    return { success: true, diff: resolvedDiff };
}
