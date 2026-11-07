import { t } from '@/text';
import { config } from '@/config';
import { sessionReadFile, sessionStatFile } from '@/sync/ops';
import { resolveSessionPathState } from '@/hooks/session/files/sessionPathState';
import { getImageMimeTypeFromPath, getVideoMimeTypeFromPath, isBinaryContent, isKnownBinaryPath } from '@/scm/utils/filePresentation';
import type { ScmDiffArea } from '@happier-dev/protocol';
import type { FileDiffMode } from '@/components/sessions/files/file/FileActionToolbar';
import type { ScmEntryKind } from '@/sync/domains/state/storageTypes';
import { decodeUtf8Base64 } from '@/scm/diff/fallbackUnifiedDiff';
import { fetchSessionUnifiedDiffForPath, invalidateSessionUnifiedDiffPath } from '@/scm/diff/fetchSessionUnifiedDiffForPath';
import { digest } from '@/platform/digest';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';

export type SessionFileDetailsFileContent = Readonly<{
    content: string;
    isBinary: boolean;
    contentHash?: string | null;
    binaryBase64?: string | null;
    binaryMime?: string | null;
    binarySizeBytes?: number | null;
    binaryPreviewRevision?: string | null;
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

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
}

async function computeTextContentHash(content: string): Promise<string | null> {
    try {
        const bytes = new TextEncoder().encode(content);
        return bytesToHex(await digest('SHA-256', bytes));
    } catch {
        return null;
    }
}

export async function refreshSessionFileDetails(input: Readonly<{
    sessionId: string;
    filePath: string;
    diffMode: FileDiffMode;
    sessionPath: string | null;
    sessionsReady: boolean;
    fileEntryKind?: ScmEntryKind | null;
    fileHasIncludedDelta?: boolean;
    imagePreviewMaxBytes?: number | null;
    includeDiff?: boolean;
    includeFile?: boolean;
    reuseFile?: Readonly<{ fileContent: SessionFileDetailsFileContent; fileWriteSupported: boolean }>;
    snapshotSignature?: string | null;
    forceRefresh?: boolean;
    onDiffContent?: (diff: string | null) => void;
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

    const workspaceRelativePath = isSafeWorkspaceRelativePath(input.filePath);
    const includeDiff = workspaceRelativePath && input.includeDiff !== false && !isKnownBinaryPath(input.filePath) && !getImageMimeTypeFromPath(input.filePath);
    // A saved file can be refreshed before the next SCM snapshot advances.
    if (workspaceRelativePath && input.forceRefresh && !includeDiff) {
        invalidateSessionUnifiedDiffPath({ sessionId: input.sessionId, path: input.filePath });
    }

    let failedReadError: string | null = null;
    let diffContent: string | null = null;
    let fileContent: SessionFileDetailsFileContent | null = null;
    let error: string | null = null;

    let fileTask: Promise<SessionFileDetailsRefreshResult> | null = null;
    const loadFile = (): Promise<SessionFileDetailsRefreshResult> => {
        if (fileTask) return fileTask;
        if (input.reuseFile) {
            fileTask = Promise.resolve({ status: 'ready', error: null, diffContent: null, ...input.reuseFile });
            return fileTask;
        }
        fileTask = (async (): Promise<SessionFileDetailsRefreshResult> => {
            try {
                const imageMime = getImageMimeTypeFromPath(input.filePath);
                const videoMime = getVideoMimeTypeFromPath(input.filePath);
                const previewMime = imageMime ?? videoMime;
                const wantsBinaryPreview = previewMime != null;
                const opaqueBinary = isKnownBinaryPath(input.filePath) && !wantsBinaryPreview;

                const genericMaxPreviewBytesRaw = config.filesPreviewMaxBytes;
                const genericMaxPreviewBytes =
                    typeof genericMaxPreviewBytesRaw === 'number' && Number.isFinite(genericMaxPreviewBytesRaw) && genericMaxPreviewBytesRaw > 0
                        ? Math.floor(genericMaxPreviewBytesRaw)
                        : null;
                const imageMaxPreviewBytesRaw = input.imagePreviewMaxBytes;
                const imageMaxPreviewBytes =
                    typeof imageMaxPreviewBytesRaw === 'number' && Number.isFinite(imageMaxPreviewBytesRaw) && imageMaxPreviewBytesRaw > 0
                        ? Math.floor(imageMaxPreviewBytesRaw)
                        : null;
                // Video bytes use encrypted chunk downloads; opaque binaries need only metadata.
                // Neither uses the inline text and image preview limits.
                const maxPreviewBytes = videoMime || opaqueBinary ? null : imageMime && imageMaxPreviewBytes != null
                    ? imageMaxPreviewBytes
                    : genericMaxPreviewBytes;

                const readOptions = maxPreviewBytes != null ? { maxBytes: maxPreviewBytes } : undefined;
                const statLimitBytes =
                    typeof maxPreviewBytes === 'number' && Number.isFinite(maxPreviewBytes) && maxPreviewBytes > 0
                        ? maxPreviewBytes
                        : null;
                let statSizeBytes: number | null = null;
                let binaryPreviewRevision: string | null = null;
                if (statLimitBytes != null || wantsBinaryPreview || opaqueBinary) {
                    const stat = await sessionStatFile(input.sessionId, input.filePath);
                    // Binary classification must not conceal missing files or access failures.
                    // Videos also require a reusable revision from valid size and modification metadata.
                    if ((wantsBinaryPreview || opaqueBinary) && (!stat.success || !stat.exists || (videoMime && (
                        typeof stat.sizeBytes !== 'number' || !Number.isFinite(stat.sizeBytes) || stat.sizeBytes < 0
                        || typeof stat.modifiedMs !== 'number' || !Number.isFinite(stat.modifiedMs))))) {
                        return {
                            status: 'ready',
                            error: !stat.success ? stat.error : t('files.fileReadFailed'),
                            diffContent,
                            fileContent: null,
                            fileWriteSupported: false,
                        };
                    }
                    if (stat.success && stat.exists === true && typeof stat.sizeBytes === 'number') {
                        statSizeBytes = Math.max(0, Math.floor(stat.sizeBytes));
                        binaryPreviewRevision = JSON.stringify([statSizeBytes, stat.modifiedMs ?? null]);
                        if (statLimitBytes != null && stat.sizeBytes > statLimitBytes) {
                            return {
                                status: 'ready',
                                error: t('files.fileTooLargeToPreview'),
                                diffContent,
                                fileContent: null,
                                fileWriteSupported: false,
                            };
                        }
                    }
                }

                if (opaqueBinary) {
                    return {
                        status: 'ready', error: null, diffContent,
                        fileContent: { content: '', isBinary: true, contentHash: null },
                        fileWriteSupported: true,
                    };
                }

                if (wantsBinaryPreview) {
                    fileContent = { content: '', isBinary: true, contentHash: null, binaryMime: previewMime, binarySizeBytes: statSizeBytes, binaryPreviewRevision };
                    return {
                        status: 'ready',
                        error: null,
                        diffContent,
                        fileContent,
                        fileWriteSupported: true,
                    };
                }

                const readResponse = await sessionReadFile(input.sessionId, input.filePath, readOptions);
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

                const decodedContent = decodeUtf8Base64(encodedContent);
                if (isBinaryContent(decodedContent)) {
                    fileContent = { content: '', isBinary: true, contentHash: null };
                    return {
                        status: 'ready',
                        error: null,
                        diffContent,
                        fileContent,
                        fileWriteSupported: true,
                    };
                }

                fileContent = { content: decodedContent, isBinary: false, contentHash: await computeTextContentHash(decodedContent) };

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
        })();
        return fileTask;
    };
    if (input.includeFile !== false || isKnownBinaryPath(input.filePath) || getImageMimeTypeFromPath(input.filePath)) {
        void loadFile();
    }
    let diffError: string | null = null;
    const diffTask = (async () => {
        if (!includeDiff) return;
        try {
            const response = await fetchSessionUnifiedDiffForPath({
                sessionId: input.sessionId,
                path: input.filePath,
                diffArea: toScmDiffArea(input.diffMode),
                file: input.fileEntryKind ? { status: input.fileEntryKind, hasIncludedDelta: input.fileHasIncludedDelta } : null,
                snapshotSignature: input.snapshotSignature,
                forceRefresh: input.forceRefresh,
                normalizeError: (value) => value instanceof Error ? value.message : String(value),
                fallbackError: t('files.fileReadFailed'),
                readFileForFallback: async () => {
                    const result = await loadFile();
                    return result.status === 'ready' && result.fileContent && !result.fileContent.isBinary
                        ? result.fileContent.content : null;
                },
            });
            if (!response.success) {
                diffError = response.error;
                return;
            }
            diffContent = response.diff || null;
            if (diffContent) input.onDiffContent?.(diffContent);
        } catch (err) {
            diffError = err instanceof Error ? err.message : t('files.fileReadFailed');
        }
    })();
    await diffTask;
    const result = await (fileTask ?? (diffContent ? Promise.resolve<SessionFileDetailsRefreshResult>({
        status: 'ready', error: null, diffContent, fileContent: null, fileWriteSupported: true,
    }) : loadFile()));
    if (result.status !== 'ready') return result;
    return { ...result, diffContent, error: result.error ?? diffError };
}
