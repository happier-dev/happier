import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { encodeBase64 } from '@/encryption/base64';
import { digest } from '@/platform/digest';
import { canUseSessionRpc, readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import {
    callDaemonSessionWriteFileRpc,
    downloadDaemonSessionFileToBase64,
    uploadDaemonSessionFileFromReader,
} from '@/sync/domains/transfers/runtime/bulkTransferPipeline/daemonSessionFiles';

import { readRpcErrorCode } from '../../runtime/rpcErrors';

const INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR = 'Session RPC unavailable for inactive session';

const SESSION_FILE_INLINE_MAX_BYTES_ENV_KEY = 'EXPO_PUBLIC_HAPPIER_SESSION_FILE_INLINE_MAX_BYTES';
const DEFAULT_SESSION_FILE_INLINE_MAX_BYTES = 256 * 1024;
// Inline base64 file read/write is intentionally small-only to avoid OOM and to keep the
// bulk-byte substrate canonical (`bulkTransferPipeline/**` for large payloads).
const SESSION_FILE_INLINE_HARD_MAX_BYTES = 10_000_000;
const SESSION_READ_FILE_TOO_LARGE_ERROR = 'File exceeds the inline file read size limit';
const SESSION_WRITE_FILE_TOO_LARGE_ERROR = 'File exceeds the inline file write size limit';

function resolveSessionFileInlineMaxBytes(): number {
    const raw = String(process.env[SESSION_FILE_INLINE_MAX_BYTES_ENV_KEY] ?? '').trim();
    if (!raw) {
        return DEFAULT_SESSION_FILE_INLINE_MAX_BYTES;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_SESSION_FILE_INLINE_MAX_BYTES;
    }

    return Math.min(parsed, SESSION_FILE_INLINE_HARD_MAX_BYTES);
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
}

export type SessionReadFileResponse =
  | Readonly<{ success: true; content: string }>
  | Readonly<{ success: false; error: string }>;

export async function sessionReadFile(sessionId: string, path: string): Promise<SessionReadFileResponse> {
    if (!readMachineTargetForSession(sessionId) && !canUseSessionRpc(sessionId)) {
        return {
            success: false,
            error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
        };
    }

    const inlineMaxBytes = resolveSessionFileInlineMaxBytes();
    const download = await downloadDaemonSessionFileToBase64({
        sessionId,
        path,
        maxBytes: inlineMaxBytes,
    });
    if (!download.ok) {
        return {
            success: false,
            error: download.error === SESSION_READ_FILE_TOO_LARGE_ERROR
                ? SESSION_READ_FILE_TOO_LARGE_ERROR
                : download.error,
        };
    }

    return {
        success: true,
        content: download.contentBase64,
    };
}

type SessionWriteFileRequest = Readonly<{
  path: string;
  content: string;
  expectedHash?: string | null;
}>;

export type SessionWriteFileResponse =
  | Readonly<{ success: true; hash: string }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionWriteFile(
  sessionId: string,
  path: string,
  content: string,
  expectedHash?: string | null,
): Promise<SessionWriteFileResponse> {
    const contentBytes = new TextEncoder().encode(content);
    const inlineMaxBytes = resolveSessionFileInlineMaxBytes();
    const guardedWrite = typeof expectedHash === 'string' && expectedHash.trim().length > 0;

    if (guardedWrite && contentBytes.byteLength > inlineMaxBytes) {
        return {
            success: false,
            error: SESSION_WRITE_FILE_TOO_LARGE_ERROR,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }

    if (contentBytes.byteLength <= inlineMaxBytes || guardedWrite) {
        const request: SessionWriteFileRequest =
            expectedHash === undefined
                ? { path, content: encodeBase64(contentBytes, 'base64') }
                : { path, content: encodeBase64(contentBytes, 'base64'), expectedHash };

        return await callDaemonSessionWriteFileRpc({
            sessionId,
            request,
            contentSizeBytes: contentBytes.byteLength,
        });
    }

    try {
        const sha256 = bytesToHex(await digest('SHA-256', contentBytes));
        const upload = await uploadDaemonSessionFileFromReader({
            sessionId,
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

        if (upload.success !== true) {
            return {
                success: false,
                error: upload.error,
                errorCode: upload.errorCode,
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
            errorCode: readRpcErrorCode(error),
        };
    }
}
