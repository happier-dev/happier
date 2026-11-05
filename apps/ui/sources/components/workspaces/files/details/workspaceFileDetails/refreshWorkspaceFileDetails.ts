import { t } from '@/text';
import { config } from '@/config';
import { callDaemonWorkspaceStatFileRpc } from '@/sync/domains/transfers/runtime/transferRuntime';
import { workspaceReadFile } from '@/sync/ops/workspaceFileSystem/fileReadWrite';
import { isBinaryContent, resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { decodeBase64 } from '@/encryption/base64';
import type { ScmDiffArea } from '@happier-dev/protocol';
import type { FileDiffMode } from '@/components/workspaces/files/file/filePageModel';
import type { ScmEntryKind } from '@/sync/domains/state/storageTypes';
import { decodeWorkspaceFileText } from '@/sync/ops/workspaceFileSystem/workspaceFileTextDecoding';
import { decodeUtf8Base64 } from '@/scm/diff/fallbackUnifiedDiff';
import { fetchWorkspaceUnifiedDiffForPath, invalidateWorkspaceUnifiedDiffPath } from '@/scm/diff/fetchWorkspaceUnifiedDiffForPath';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { decodeFilePreviewSlice, resolveFilePreviewRead } from './decodeFilePreviewSlice';

export type WorkspaceFileDetailsFileContent = Readonly<{
    content: string;
    isBinary: boolean;
    contentHash?: string | null;
    encoding?: Readonly<{ hasBom: boolean; editable: boolean; reason?: 'notUtf8'; eol: 'lf' | 'crlf'; mixedEol: boolean }>;
    binaryBase64?: string | null;
    binaryMime?: string | null;
    binarySizeBytes?: number | null;
    binaryPreviewRevision?: string | null;
    /** A preview range is never an editable buffer or a comparison source. */
    partial?: Readonly<{ slice: 'head' | 'tail'; offset: number; length: number; totalBytes: number }>;
}>;

export type WorkspaceFileDetailsRefreshResult = Readonly<{
    status: 'ready';
    error: string | null;
    diffContent: string | null;
    fileContent: WorkspaceFileDetailsFileContent | null;
    fileWriteSupported: boolean;
    tooLarge?: Readonly<{ sizeBytes: number; maxPreviewBytes: number }>;
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

export async function refreshWorkspaceFileDetails(input: Readonly<{
    scope: WorkspaceScopeBase;
    filePath: string;
    diffMode: FileDiffMode;
    fileEntryKind?: ScmEntryKind | null;
    filePreviousPath?: string | null;
    isBinaryContent?: boolean;
    /** Explicit built-in alternative; display bytes without making them an editable buffer. */
    readAsText?: boolean;
    fileHasIncludedDelta?: boolean;
    maxImagePreviewBytes?: number | null;
    previewSlice?: 'head' | 'tail';
    includeDiff?: boolean;
    includeFile?: boolean;
    reuseFile?: Readonly<{ fileContent: WorkspaceFileDetailsFileContent; fileWriteSupported: boolean }>;
    snapshotSignature?: string | null;
    forceRefresh?: boolean;
    onDiffContent?: (diff: string | null) => void;
    signal?: AbortSignal;
}>): Promise<WorkspaceFileDetailsRefreshResult> {
    const viewer = resolveFileViewerKind({ path: input.filePath, isBinaryContent: input.isBinaryContent });
    const textReadable = input.readAsText === true || viewer.kind === 'code' || viewer.kind === 'markdown' || viewer.kind === 'svg';
    const includeDiff = input.readAsText !== true && input.includeDiff !== false && textReadable && !input.previewSlice && !input.reuseFile?.fileContent.partial;
    // A saved file can be refreshed before the next SCM snapshot advances.
    if (input.forceRefresh && !includeDiff) {
        invalidateWorkspaceUnifiedDiffPath({ scope: input.scope, path: input.filePath });
    }

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
                const videoPreview = input.readAsText !== true && viewer.kind === 'video';
                const wantsBinaryPreview = input.readAsText !== true && viewer.previewable && viewer.kind !== 'svg';
                // Opaque binary classification performs no inline read and consumes no text budget; one stat names its
                // size on the identity card (lab FV2b), and a stat that cannot answer only leaves the size out.
                if (viewer.kind === 'binary' && !input.readAsText) {
                    const stat = await callDaemonWorkspaceStatFileRpc({
                        machineId: input.scope.machineId,
                        serverId: input.scope.serverId,
                        rootPath: input.scope.rootPath,
                        request: { path: input.filePath },
                        signal: input.signal,
                    }).catch(() => null);
                    if (input.signal?.aborted) throw new Error(t('files.fileReadFailed'));
                    const binarySizeBytes = stat?.success && stat.exists === true && typeof stat.sizeBytes === 'number'
                        && Number.isFinite(stat.sizeBytes) && stat.sizeBytes >= 0 ? Math.floor(stat.sizeBytes) : null;
                    return {
                        status: 'ready', error: null, diffContent,
                        fileContent: { content: '', isBinary: true, contentHash: null, binaryMime: viewer.mimeType, binarySizeBytes },
                        fileWriteSupported: true,
                    };
                }
                // Video admission belongs to the ordinary workspace transfer, independently of inline preview limits.
                const maxPreviewBytes = videoPreview ? null : wantsBinaryPreview
                    ? resolveOptionalMaxBytes(input.maxImagePreviewBytes)
                    : resolveMaxPreviewBytes();
                let statSizeBytes: number | null = null;
                let binaryPreviewRevision: string | null = null;

                if (maxPreviewBytes != null || viewer.previewable) {
                    const stat = await callDaemonWorkspaceStatFileRpc({
                        machineId: input.scope.machineId,
                        serverId: input.scope.serverId,
                        rootPath: input.scope.rootPath,
                        request: { path: input.filePath },
                        signal: input.signal,
                    });
                    if (input.signal?.aborted) throw new Error(t('files.fileReadFailed'));
                    // Retain the last good player and expose the ordinary retry error when its revision cannot be refreshed.
                    if (videoPreview && (!stat.success || !stat.exists
                        || typeof stat.sizeBytes !== 'number' || !Number.isFinite(stat.sizeBytes) || stat.sizeBytes < 0
                        || typeof stat.modifiedMs !== 'number' || !Number.isFinite(stat.modifiedMs))) {
                        throw new Error(!stat.success ? stat.error : t('files.fileReadFailed'));
                    }
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
                }

                const previewRead = resolveFilePreviewRead({ sizeBytes: statSizeBytes, maxPreviewBytes,
                    previewSlice: textReadable ? input.previewSlice : undefined });
                if (previewRead.kind === 'tooLarge') return {
                    status: 'ready', error: textReadable ? null : t('files.fileTooLargeToPreview'),
                    diffContent, fileContent: null, fileWriteSupported: false,
                    ...(textReadable ? { tooLarge: { sizeBytes: previewRead.sizeBytes, maxPreviewBytes: previewRead.maxPreviewBytes } } : {}),
                };

                if (wantsBinaryPreview) {
                    fileContent = { content: '', isBinary: true, contentHash: null, binaryMime: viewer.mimeType, binarySizeBytes: statSizeBytes, binaryPreviewRevision };
                    return {
                        status: 'ready',
                        error: null,
                        diffContent,
                        fileContent,
                        fileWriteSupported: true,
                    };
                }

                const readResponse = await workspaceReadFile(input.scope, input.filePath, {
                    maxBytes: maxPreviewBytes ?? 256 * 1024,
                    knownSizeBytes: statSizeBytes,
                    signal: input.signal,
                    ...(previewRead.kind === 'partial' ? { range: previewRead.range } : {}),
                });
                if (!readResponse.success) {
                    error = readResponse.error || t('files.fileReadFailed');
                    fileContent = null;
                    return {
                        status: 'ready',
                        error,
                        diffContent,
                        fileContent,
                        fileWriteSupported: previewRead.kind !== 'partial',
                    };
                }

                const encodedContent = readResponse.content || '';

                if (previewRead.kind === 'partial') {
                    const bytes = decodeBase64(encodedContent);
                    const totalBytes = readResponse.sizeBytes ?? previewRead.totalBytes;
                    const content = decodeFilePreviewSlice(bytes, { offset: previewRead.range.offset, totalBytes });
                    const binary = !input.readAsText && isBinaryContent(content);
                    return {
                        status: 'ready', error: null, diffContent, fileWriteSupported: false,
                        fileContent: { content: binary ? '' : content, isBinary: binary, contentHash: null,
                            binaryMime: binary ? resolveFileViewerKind({ path: input.filePath, isBinaryContent: true }).mimeType : viewer.mimeType,
                            partial: { slice: previewRead.slice, offset: previewRead.range.offset, length: bytes.length, totalBytes } },
                    };
                }

                const decodedContent = await decodeWorkspaceFileText(encodedContent);
                if (decodedContent.kind === 'binary' && !input.readAsText) {
                    fileContent = { content: '', isBinary: true, contentHash: null, binaryMime: resolveFileViewerKind({ path: input.filePath, isBinaryContent: true }).mimeType, binarySizeBytes: statSizeBytes };
                    return {
                        status: 'ready',
                        error: null,
                        diffContent,
                        fileContent,
                        fileWriteSupported: true,
                    };
                }

                const content = decodedContent.kind === 'text' ? decodedContent.text : decodeUtf8Base64(encodedContent);
                let lf = 0;
                let crlf = 0;
                for (const ending of content.matchAll(/\r\n|\n/g)) {
                    if (ending[0] === '\r\n') crlf += 1;
                    else lf += 1;
                }
                fileContent = {
                    content, isBinary: false, contentHash: input.readAsText ? null : decodedContent.kind === 'binary' ? null : decodedContent.hash,
                    encoding: { hasBom: decodedContent.kind === 'text' && decodedContent.hasBom,
                        editable: !input.readAsText && decodedContent.kind === 'text',
                        ...(decodedContent.kind === 'notUtf8' ? { reason: 'notUtf8' as const } : {}),
                        eol: crlf > lf ? 'crlf' : 'lf', mixedEol: crlf > 0 && lf > 0 },
                    binaryMime: viewer.mimeType, binarySizeBytes: statSizeBytes, binaryPreviewRevision,
                };

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
                    fileWriteSupported: true,
                };
            }
        })();
        return fileTask;
    };
    // Changes has the same current-document holder as View/Edit. A patch is
    // display data, never the full after-text used by language queries or Ask.
    const needsCurrentText = includeDiff && input.fileEntryKind !== 'deleted';
    if (input.includeFile !== false || needsCurrentText || viewer.previewable || viewer.kind === 'binary') {
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
                file: input.fileEntryKind ? { status: input.fileEntryKind, oldPath: input.filePreviousPath ?? undefined, hasIncludedDelta: input.fileHasIncludedDelta, isBinary: input.isBinaryContent } : null,
                snapshotSignature: input.snapshotSignature,
                forceRefresh: input.forceRefresh,
                normalizeError: (value) => value instanceof Error ? value.message : String(value),
                fallbackError: t('files.fileReadFailed'),
                readFileForFallback: async () => {
                    const result = await loadFile();
                    return result.fileContent && !result.fileContent.isBinary && !result.fileContent.partial ? result.fileContent.content : null;
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
