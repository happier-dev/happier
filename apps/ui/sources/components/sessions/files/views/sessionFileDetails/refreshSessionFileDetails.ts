import { t } from '@/text';
import { config } from '@/config';
import { sessionScmDiffFile, sessionReadFile, sessionStatFile } from '@/sync/ops';
import { resolveSessionPathState } from '@/hooks/session/files/sessionPathState';
import { getImageMimeTypeFromPath, isBinaryContent, isKnownBinaryPath } from '@/scm/utils/filePresentation';
import type { ScmDiffArea } from '@happier-dev/protocol';
import type { FileDiffMode } from '@/components/sessions/files/file/FileActionToolbar';
import type { ScmEntryKind } from '@/sync/domains/state/storageTypes';
import { buildAddedFileUnifiedDiff, decodeUtf8Base64 } from '@/scm/diff/fallbackUnifiedDiff';
import { looksLikeUnifiedDiff } from '@/scm/diff/looksLikeUnifiedDiff';
import { extractUnifiedDiffForSingleFile } from '@/scm/diff/extractUnifiedDiffForSingleFile';

export type SessionFileDetailsFileContent = Readonly<{
    content: string;
    isBinary: boolean;
    binaryBase64?: string | null;
    binaryMime?: string | null;
}>;

export type SessionFileDetailsRefreshResult =
    | Readonly<{ status: 'waiting' }>
    | Readonly<{
        status: 'ready';
        error: string | null;
        diffContent: string | null;
        fileContent: SessionFileDetailsFileContent | null;
        fileWriteSupported: boolean;
    }>;

function toScmDiffArea(mode: FileDiffMode): ScmDiffArea {
    if (mode === 'included') return 'included';
    if (mode === 'pending') return 'pending';
    return 'both';
}

export async function refreshSessionFileDetails(input: Readonly<{
    sessionId: string;
    filePath: string;
    diffMode: FileDiffMode;
    sessionPath: string | null;
    sessionsReady: boolean;
    fileEntryKind?: ScmEntryKind | null;
}>): Promise<SessionFileDetailsRefreshResult> {
    const sessionState = resolveSessionPathState({
        sessionId: input.sessionId,
        sessionPath: input.sessionPath,
        sessionsReady: input.sessionsReady,
    });
    if (sessionState.status === 'waiting') return { status: 'waiting' };
    if (sessionState.status === 'error') {
        return {
            status: 'ready',
            error: sessionState.error,
            diffContent: null,
            fileContent: null,
            fileWriteSupported: false,
        };
    }

    let failedReadError: string | null = null;
    let diffContent: string | null = null;
    let fileContent: SessionFileDetailsFileContent | null = null;
    let error: string | null = null;

    try {
        const diffResponse = await sessionScmDiffFile(input.sessionId, {
            path: input.filePath,
            area: toScmDiffArea(input.diffMode),
        });
        diffContent = diffResponse.success ? (diffResponse.diff ?? '') : null;
        if (typeof diffContent === 'string' && diffContent.includes('diff --git ') && (diffContent.match(/^diff --git /gm) ?? []).length > 1) {
            diffContent = extractUnifiedDiffForSingleFile({ patch: diffContent, path: input.filePath });
        }
        if (typeof diffContent === 'string' && !looksLikeUnifiedDiff(diffContent)) {
            diffContent = null;
        }

        const imageMime = getImageMimeTypeFromPath(input.filePath);
        const wantsBinaryPreview = typeof imageMime === 'string' && imageMime.trim().length > 0;

        const maxPreviewBytesRaw = config.filesPreviewMaxBytes;
        const maxPreviewBytes =
            typeof maxPreviewBytesRaw === 'number' && Number.isFinite(maxPreviewBytesRaw) && maxPreviewBytesRaw > 0
                ? Math.floor(maxPreviewBytesRaw)
                : null;
        if (maxPreviewBytes != null) {
            const stat = await sessionStatFile(input.sessionId, input.filePath);
            if (stat.success && stat.exists === true && typeof stat.sizeBytes === 'number' && stat.sizeBytes > maxPreviewBytes) {
                return {
                    status: 'ready',
                    error: t('files.fileTooLargeToPreview'),
                    diffContent,
                    fileContent: null,
                    fileWriteSupported: false,
                };
            }
        }

        if (isKnownBinaryPath(input.filePath) && !wantsBinaryPreview) {
            fileContent = { content: '', isBinary: true };
            return {
                status: 'ready',
                error: null,
                diffContent,
                fileContent,
                fileWriteSupported: true,
            };
        }

        const readResponse = await sessionReadFile(input.sessionId, input.filePath);
        if (!readResponse.success) {
            failedReadError = readResponse.error || t('files.fileReadFailed');
            error = failedReadError;
            fileContent = null;
            return {
                status: 'ready',
                error,
                diffContent,
                fileContent,
                fileWriteSupported: false,
            };
        }

        const encodedContent = readResponse.content || '';

        if (wantsBinaryPreview) {
            fileContent = { content: '', isBinary: true, binaryBase64: encodedContent, binaryMime: imageMime };
            return {
                status: 'ready',
                error: null,
                diffContent,
                fileContent,
                fileWriteSupported: true,
            };
        }

        const decodedContent = decodeUtf8Base64(encodedContent);
        if (isBinaryContent(decodedContent)) {
            fileContent = { content: '', isBinary: true };
            return {
                status: 'ready',
                error: null,
                diffContent,
                fileContent,
                fileWriteSupported: true,
            };
        }

        fileContent = { content: decodedContent, isBinary: false };

        const entryKind = input.fileEntryKind ?? null;
        if (diffContent == null && (entryKind === 'untracked' || entryKind === 'added')) {
            diffContent = buildAddedFileUnifiedDiff({ filePath: input.filePath, newText: decodedContent });
        }
        return {
            status: 'ready',
            error: null,
            diffContent,
            fileContent,
            fileWriteSupported: true,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : t('files.fileReadFailed');
        error = message;
        return {
            status: 'ready',
            error,
            diffContent,
            fileContent,
            fileWriteSupported: failedReadError == null,
        };
    }
}
