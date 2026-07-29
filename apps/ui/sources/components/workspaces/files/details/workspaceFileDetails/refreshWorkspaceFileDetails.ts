import { t } from '@/text';
import { config } from '@/config';
import { callDaemonWorkspaceStatFileRpc, downloadDaemonWorkspaceFileToBase64 } from '@/sync/domains/transfers/runtime/transferRuntime';
import { getImageMimeTypeFromPath, isBinaryContent, isKnownBinaryPath } from '@/scm/utils/filePresentation';
import type { ScmDiffArea } from '@happier-dev/protocol';
import type { FileDiffMode } from '@/components/workspaces/files/file/FileActionToolbar';
import type { ScmEntryKind } from '@/sync/domains/state/storageTypes';
import { buildAddedFileUnifiedDiff, decodeUtf8Base64 } from '@/scm/diff/fallbackUnifiedDiff';
import { looksLikeUnifiedDiff } from '@/scm/diff/looksLikeUnifiedDiff';
import { extractUnifiedDiffForSingleFile } from '@/scm/diff/extractUnifiedDiffForSingleFile';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { machineScmDiffFile } from '@/sync/ops/scm/machineScm';
import { digest } from '@/platform/digest';

export type WorkspaceFileDetailsFileContent = Readonly<{
    content: string;
    isBinary: boolean;
    contentHash?: string | null;
    binaryBase64?: string | null;
    binaryMime?: string | null;
    binarySizeBytes?: number | null;
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
    maxImagePreviewBytes?: number | null;
}>): Promise<WorkspaceFileDetailsRefreshResult> {
    let failedReadError: string | null = null;
    let diffContent: string | null = null;
    let fileContent: WorkspaceFileDetailsFileContent | null = null;
    let error: string | null = null;

    try {
        const diffResponse = await machineScmDiffFile(input.scope.machineId, {
            cwd: input.scope.rootPath,
            path: input.filePath,
            area: toScmDiffArea(input.diffMode),
        }, { serverId: input.scope.serverId });
        diffContent = diffResponse.success ? (diffResponse.diff ?? '') : null;
        if (typeof diffContent === 'string' && diffContent.includes('diff --git ') && (diffContent.match(/^diff --git /gm) ?? []).length > 1) {
            diffContent = extractUnifiedDiffForSingleFile({ patch: diffContent, path: input.filePath });
        }
        if (typeof diffContent === 'string' && !looksLikeUnifiedDiff(diffContent)) {
            diffContent = null;
        }

        const imageMime = getImageMimeTypeFromPath(input.filePath);
        const wantsBinaryPreview = typeof imageMime === 'string' && imageMime.trim().length > 0;
        const maxPreviewBytes = wantsBinaryPreview
            ? resolveOptionalMaxBytes(input.maxImagePreviewBytes)
            : resolveMaxPreviewBytes();
        let statSizeBytes: number | null = null;

        if (maxPreviewBytes != null) {
            const stat = await callDaemonWorkspaceStatFileRpc({
                machineId: input.scope.machineId,
                serverId: input.scope.serverId,
                rootPath: input.scope.rootPath,
                request: { path: input.filePath },
            });
            if (
                stat.success
                && stat.exists === true
                && typeof stat.sizeBytes === 'number'
                && Number.isFinite(stat.sizeBytes)
                && stat.sizeBytes >= 0
            ) {
                statSizeBytes = Math.floor(stat.sizeBytes);
            }
            if (
                stat.success
                && stat.exists === true
                && typeof stat.sizeBytes === 'number'
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

        if (isKnownBinaryPath(input.filePath) && !wantsBinaryPreview) {
            fileContent = { content: '', isBinary: true, contentHash: null };
            return {
                status: 'ready',
                error: null,
                diffContent,
                fileContent,
                fileWriteSupported: true,
            };
        }

        if (wantsBinaryPreview) {
            fileContent = { content: '', isBinary: true, contentHash: null, binaryMime: imageMime, binarySizeBytes: statSizeBytes };
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
            }),
            resolveFileReadTimeoutMs(),
            () => ({
                ok: false as const,
                error: t('files.fileReadFailed'),
            }),
        );
        if (!readResponse.ok) {
            failedReadError = readResponse.error || t('files.fileReadFailed');
            if (diffContent != null) {
                return {
                    status: 'ready',
                    error: null,
                    diffContent,
                    fileContent: null,
                    fileWriteSupported: false,
                };
            }
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
