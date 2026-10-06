import { t } from '@/text';
import { config } from '@/config';
import { callDaemonWorkspaceStatFileRpc, downloadDaemonWorkspaceFileToBase64 } from '@/sync/domains/transfers/runtime/transferRuntime';
import { getImageMimeTypeFromPath, getVideoMimeTypeFromPath, isBinaryContent, isKnownBinaryPath } from '@/scm/utils/filePresentation';
import type { ScmDiffArea } from '@happier-dev/protocol';
import type { FileDiffMode } from '@/components/workspaces/files/file/FileActionToolbar';
import type { ScmEntryKind } from '@/sync/domains/state/storageTypes';
import { decodeUtf8Base64 } from '@/scm/diff/fallbackUnifiedDiff';
import { fetchWorkspaceUnifiedDiffForPath, invalidateWorkspaceUnifiedDiffPath } from '@/scm/diff/fetchWorkspaceUnifiedDiffForPath';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { digest } from '@/platform/digest';

export type WorkspaceFileDetailsFileContent = Readonly<{
    content: string;
    isBinary: boolean;
    contentHash?: string | null;
    binaryBase64?: string | null;
    binaryMime?: string | null;
    binarySizeBytes?: number | null;
    binaryPreviewRevision?: string | null;
}>;

export type WorkspaceFileDetailsRefreshResult = Readonly<{
    status: 'ready';
    error: string | null;
    diffContent: string | null;
    fileContent: WorkspaceFileDetailsFileContent | null;
    fileWriteSupported: boolean;
}>;

function toScmDiffArea(mode: FileDiffMode): ScmDiffArea {
    if (mode === 'included') return 'included';
    if (mode === 'pending') return 'pending';
    return 'both';
}

function resolveMaxPreviewBytes(): number | null {
    const maxPreviewBytesRaw = config.filesPreviewMaxBytes;
    if (typeof maxPreviewBytesRaw !== 'number' || !Number.isFinite(maxPreviewBytesRaw) || maxPreviewBytesRaw <= 0) {
        return null;
    }
    return Math.floor(maxPreviewBytesRaw);
}

function resolveOptionalMaxBytes(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return null;
    }
    return Math.floor(value);
}

function resolveFileReadTimeoutMs(): number {
    const configured = config.filesPreviewReadTimeoutMs;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
        return Math.floor(configured);
    }
    return 15_000;
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

async function withFileReadTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => T,
): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<T>((resolve) => {
        timeoutId = setTimeout(() => {
            timeoutId = null;
            resolve(onTimeout());
        }, timeoutMs);
    });

    try {
        return await Promise.race([
            promise.catch((error) => {
                throw error;
            }),
            timeoutPromise,
        ]);
    } finally {
        if (timeoutId != null) {
            clearTimeout(timeoutId);
        }
    }
}

export async function refreshWorkspaceFileDetails(input: Readonly<{
    scope: WorkspaceScopeBase;
    filePath: string;
    diffMode: FileDiffMode;
    fileEntryKind?: ScmEntryKind | null;
    fileHasIncludedDelta?: boolean;
    maxImagePreviewBytes?: number | null;
    includeDiff?: boolean;
    includeFile?: boolean;
    reuseFile?: Readonly<{ fileContent: WorkspaceFileDetailsFileContent; fileWriteSupported: boolean }>;
    snapshotSignature?: string | null;
    forceRefresh?: boolean;
    onDiffContent?: (diff: string | null) => void;
    signal?: AbortSignal;
}>): Promise<WorkspaceFileDetailsRefreshResult> {
    const includeDiff = input.includeDiff !== false && !isKnownBinaryPath(input.filePath) && !getImageMimeTypeFromPath(input.filePath);
    // A saved file can be refreshed before the next SCM snapshot advances.
    if (input.forceRefresh && !includeDiff) {
        invalidateWorkspaceUnifiedDiffPath({ scope: input.scope, path: input.filePath });
    }

    let failedReadError: string | null = null;
    let diffContent: string | null = null;
    let fileContent: WorkspaceFileDetailsFileContent | null = null;
    let error: string | null = null;

    let fileTask: Promise<WorkspaceFileDetailsRefreshResult> | null = null;
    const loadFile = (): Promise<WorkspaceFileDetailsRefreshResult> => {
        if (fileTask) return fileTask;
        if (input.reuseFile) {
            fileTask = Promise.resolve({ status: 'ready', error: null, diffContent: null, ...input.reuseFile });
            return fileTask;
        }
        fileTask = (async (): Promise<WorkspaceFileDetailsRefreshResult> => {
            try {
                if (input.signal?.aborted) throw new Error(t('files.fileReadFailed'));
                const imageMime = getImageMimeTypeFromPath(input.filePath);
                const videoMime = getVideoMimeTypeFromPath(input.filePath);
                const previewMime = imageMime ?? videoMime;
                const wantsBinaryPreview = previewMime !== null;
                // Opaque binary classification performs no inline read and consumes no text budget.
                if (isKnownBinaryPath(input.filePath) && !wantsBinaryPreview) {
                    return {
                        status: 'ready', error: null, diffContent,
                        fileContent: { content: '', isBinary: true, contentHash: null },
                        fileWriteSupported: true,
                    };
                }
                // Video admission belongs to the ordinary workspace transfer, independently of inline preview limits.
                const maxPreviewBytes = videoMime ? null : imageMime
                    ? resolveOptionalMaxBytes(input.maxImagePreviewBytes)
                    : resolveMaxPreviewBytes();
                let statSizeBytes: number | null = null;
                let binaryPreviewRevision: string | null = null;

                if (maxPreviewBytes != null || videoMime) {
                    const stat = await callDaemonWorkspaceStatFileRpc({
                        machineId: input.scope.machineId,
                        serverId: input.scope.serverId,
                        rootPath: input.scope.rootPath,
                        request: { path: input.filePath },
                    });
                    if (input.signal?.aborted) throw new Error(t('files.fileReadFailed'));
                    if (
                        stat.success
                        && stat.exists === true
                        && typeof stat.sizeBytes === 'number'
                        && Number.isFinite(stat.sizeBytes)
                        && stat.sizeBytes >= 0
                    ) {
                        statSizeBytes = Math.floor(stat.sizeBytes);
                        binaryPreviewRevision = JSON.stringify([statSizeBytes, stat.modifiedMs ?? null]);
                    }
                    if (
                        stat.success
                        && stat.exists === true
                        && typeof stat.sizeBytes === 'number'
                        && maxPreviewBytes != null
                        && stat.sizeBytes > maxPreviewBytes
                    ) {
                        return {
                            status: 'ready',
                            error: t('files.fileTooLargeToPreview'),
                            diffContent,
                            fileContent: null,
                            fileWriteSupported: false,
                        };
                    }
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

                const readResponse = await withFileReadTimeout(
                    downloadDaemonWorkspaceFileToBase64({
                        machineId: input.scope.machineId,
                        serverId: input.scope.serverId,
                        rootPath: input.scope.rootPath,
                        path: input.filePath,
                        maxBytes: maxPreviewBytes ?? 256 * 1024,
                        signal: input.signal,
                    }),
                    resolveFileReadTimeoutMs(),
                    () => ({
                        ok: false as const,
                        error: t('files.fileReadFailed'),
                    }),
                );
                if (!readResponse.ok) {
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

                const encodedContent = readResponse.contentBase64 || '';

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
            const response = await fetchWorkspaceUnifiedDiffForPath({
                scope: input.scope,
                path: input.filePath,
                diffArea: toScmDiffArea(input.diffMode),
                file: input.fileEntryKind ? { status: input.fileEntryKind, hasIncludedDelta: input.fileHasIncludedDelta } : null,
                snapshotSignature: input.snapshotSignature,
                forceRefresh: input.forceRefresh,
                normalizeError: (value) => value instanceof Error ? value.message : String(value),
                fallbackError: t('files.fileReadFailed'),
                readFileForFallback: async () => {
                    const result = await loadFile();
                    return result.fileContent && !result.fileContent.isBinary ? result.fileContent.content : null;
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
    const result = await (fileTask ?? (diffContent ? Promise.resolve<WorkspaceFileDetailsRefreshResult>({
        status: 'ready', error: null, diffContent, fileContent: null, fileWriteSupported: true,
    }) : loadFile()));
    return { ...result, diffContent, error: result.error ?? diffError };
}
