import type { ScmDiffArea } from '@happier-dev/protocol';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { isBinaryContent, isKnownBinaryPath } from '@/scm/utils/filePresentation';
import { buildAddedFileUnifiedDiff, decodeUtf8Base64 } from '@/scm/diff/fallbackUnifiedDiff';
import { looksLikeUnifiedDiff } from '@/scm/diff/looksLikeUnifiedDiff';
import { extractUnifiedDiffForSingleFile } from '@/scm/diff/extractUnifiedDiffForSingleFile';
import { sessionReadFile, sessionScmDiffFile } from '@/sync/ops';

export async function fetchSessionUnifiedDiffForPath(input: Readonly<{
    sessionId: string;
    diffArea: ScmDiffArea;
    path: string;
    file: ScmFileStatus | null;
    normalizeError: (input: unknown) => string;
    fallbackError: string;
}>): Promise<Readonly<{ success: true; diff: string }> | Readonly<{ success: false; error: string }>> {
    const response = await sessionScmDiffFile(input.sessionId, { path: input.path, area: input.diffArea });
    if (!response.success) {
        const rawError = typeof response.error === 'string' ? response.error : '';
        const normalized = rawError.trim() ? input.normalizeError(rawError) : '';
        return {
            success: false,
            error: (typeof normalized === 'string' && normalized.trim()) ? normalized : input.fallbackError,
        };
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

    const file = input.file;
    const shouldTryNewFileFallback =
        !resolvedDiff
        && file
        && (file.status === 'untracked' || file.status === 'added')
        && !isKnownBinaryPath(input.path);

    if (shouldTryNewFileFallback) {
        const readRes = await sessionReadFile(input.sessionId, input.path);
        if (readRes?.success && typeof readRes.content === 'string') {
            const decoded = decodeUtf8Base64(readRes.content);
            if (!isBinaryContent(decoded)) {
                resolvedDiff = buildAddedFileUnifiedDiff({ filePath: input.path, newText: decoded });
            }
        }
    }

    return { success: true, diff: resolvedDiff };
}
