import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { encodeBase64 } from '@/encryption/base64';
import { digest } from '@/platform/digest';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import {
    callDaemonWorkspaceWriteFileRpc,
    downloadDaemonWorkspaceFileToBase64,
    uploadDaemonWorkspaceFileFromReader,
} from '@/sync/domains/transfers/runtime/transferRuntime';

import type { WorkspaceFileSystemTarget } from './directoryBrowsing';
import { runTransferFinalizeRecovery } from '@/components/transfers/recovery/runTransferFinalizeRecovery';
import { t } from '@/text';
import { isTransferFinalizeRecoveryFailure } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';
import type { WorkspaceFileUploadFinalizeResponse } from '@/sync/domains/transfers/runtime/transferRuntime/families/workspaceFileTransfers';

const WORKSPACE_FILE_INLINE_MAX_BYTES_ENV_KEY = 'EXPO_PUBLIC_HAPPIER_SESSION_FILE_INLINE_MAX_BYTES';
const DEFAULT_WORKSPACE_FILE_INLINE_MAX_BYTES = 256 * 1024;
// Inline base64 file read/write is intentionally small-only to avoid OOM and to keep the
// canonical transfer runtime (`transferRuntime/**` for large payloads).
const WORKSPACE_FILE_INLINE_HARD_MAX_BYTES = 10_000_000;
const WORKSPACE_READ_FILE_TOO_LARGE_ERROR = 'File exceeds the inline file read size limit';
export const WORKSPACE_WRITE_FILE_TOO_LARGE_ERROR = 'File exceeds the inline file write size limit';

function resolveWorkspaceFileInlineMaxBytes(): number {
    const raw = String(process.env[WORKSPACE_FILE_INLINE_MAX_BYTES_ENV_KEY] ?? '').trim();
    if (!raw) {
        return DEFAULT_WORKSPACE_FILE_INLINE_MAX_BYTES;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_WORKSPACE_FILE_INLINE_MAX_BYTES;
    }

    return Math.min(parsed, WORKSPACE_FILE_INLINE_HARD_MAX_BYTES);
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
}

export type WorkspaceReadFileResponse =
  | Readonly<{ success: true; content: string }>
  | Readonly<{ success: false; error: string }>;

export async function workspaceReadFile(
    target: WorkspaceFileSystemTarget,
    path: string,
    options?: Readonly<{ maxBytes?: number | null }>,
): Promise<WorkspaceReadFileResponse> {
    const inlineMaxBytes = resolveWorkspaceFileInlineMaxBytes();
    const requestedMaxBytes =
        typeof options?.maxBytes === 'number' && Number.isFinite(options.maxBytes)
            ? Math.max(0, Math.floor(options.maxBytes))
            : inlineMaxBytes;
    const download = await downloadDaemonWorkspaceFileToBase64({
        machineId: target.machineId,
        serverId: target.serverId,
        rootPath: target.rootPath,
        path,
        maxBytes: Math.min(requestedMaxBytes, inlineMaxBytes),
    });
    if (!download.ok) {
        return {
            success: false,
            error: download.error === WORKSPACE_READ_FILE_TOO_LARGE_ERROR
                ? WORKSPACE_READ_FILE_TOO_LARGE_ERROR
                : download.error,
        };
    }

    return {
        success: true,
        content: download.contentBase64,
    };
}

type WorkspaceWriteFileRequest = Readonly<{
  path: string;
  content: string;
  expectedHash?: string | null;
}>;

export type WorkspaceWriteFileResponse =
  | Readonly<{ success: true; hash: string }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

function normalizeWorkspaceWriteFileErrorCode(errorCode: string | undefined): string {
    const trimmed = typeof errorCode === 'string' ? errorCode.trim() : '';
    if (!trimmed) {
        return RPC_ERROR_CODES.METHOD_NOT_AVAILABLE;
    }
    return trimmed;
}

export async function workspaceWriteFile(
    target: WorkspaceFileSystemTarget,
    path: string,
    content: string,
    expectedHash?: string | null,
): Promise<WorkspaceWriteFileResponse> {
    const contentBytes = new TextEncoder().encode(content);
    const inlineMaxBytes = resolveWorkspaceFileInlineMaxBytes();
    const guardedWrite = typeof expectedHash === 'string' && expectedHash.trim().length > 0;

    if (guardedWrite && contentBytes.byteLength > inlineMaxBytes) {
        return {
            success: false,
            error: WORKSPACE_WRITE_FILE_TOO_LARGE_ERROR,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }

    if (contentBytes.byteLength <= inlineMaxBytes || guardedWrite) {
        const request: WorkspaceWriteFileRequest =
            expectedHash === undefined
                ? { path, content: encodeBase64(contentBytes, 'base64') }
                : { path, content: encodeBase64(contentBytes, 'base64'), expectedHash };

        const response = await callDaemonWorkspaceWriteFileRpc({
            machineId: target.machineId,
            serverId: target.serverId,
            rootPath: target.rootPath,
            request,
        });
        if (response.success !== true) {
            return {
                success: false,
                error: response.error,
                errorCode: normalizeWorkspaceWriteFileErrorCode(response.errorCode),
            };
        }
        return response;
    }

    try {
        const sha256 = bytesToHex(await digest('SHA-256', contentBytes));
        let upload = await uploadDaemonWorkspaceFileFromReader({
            machineId: target.machineId,
            serverId: target.serverId,
            rootPath: target.rootPath,
            fileReader: {
                sizeBytes: contentBytes.byteLength,
                readBytes: async (offset, length) => contentBytes.slice(offset, offset + length),
                close: async () => {},
            },
            request: {
                path,
                sizeBytes: contentBytes.byteLength,
                overwrite: expectedHash === undefined,
                sha256,
            },
        });

        if (isTransferFinalizeRecoveryFailure<WorkspaceFileUploadFinalizeResponse>(upload)) {
            const recoveryResult = await runTransferFinalizeRecovery({
                recovery: upload.recovery,
                title: t('transferRecovery.title'),
                message: t('transferRecovery.message'),
            });
            if (recoveryResult?.status === 'finalized') {
                upload = recoveryResult.response;
            } else {
                upload = {
                    success: false,
                    error: recoveryResult?.status === 'unavailable'
                        ? t('transferRecovery.unavailable')
                        : recoveryResult?.status === 'discarded'
                            ? t('transferRecovery.discarded')
                            : upload.error,
                };
            }
        }

        if (upload.success !== true) {
            return {
                success: false,
                error: upload.error,
                errorCode: normalizeWorkspaceWriteFileErrorCode(upload.errorCode),
            };
        }

        return {
            success: true,
            hash: upload.sha256,
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: normalizeWorkspaceWriteFileErrorCode(readRpcErrorCode(error)),
        };
    }
}
