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

export type WorkspaceFileDetailsFileContent = Readonly<{
    content: string;
    isBinary: boolean;
    binaryBase64?: string | null;
    binaryMime?: string | null;
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

export async function refreshWorkspaceFileDetails(input: Readonly<{
    scope: WorkspaceScopeBase;
    filePath: string;
    diffMode: FileDiffMode;
    fileEntryKind?: ScmEntryKind | null;
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

        const maxPreviewBytes = resolveMaxPreviewBytes();
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
            fileContent = { content: '', isBinary: true };
            return {
                status: 'ready',
                error: null,
                diffContent,
                fileContent,
                fileWriteSupported: true,
            };
        }

        const readResponse = await downloadDaemonWorkspaceFileToBase64({
            machineId: input.scope.machineId,
            serverId: input.scope.serverId,
            rootPath: input.scope.rootPath,
            path: input.filePath,
            maxBytes: maxPreviewBytes ?? 256 * 1024,
        });
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
