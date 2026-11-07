import { HARD_OPENABLE_CONTENT_MAX_BYTES_V1 } from '@happier-dev/protocol/plugins/openableContent';
import { readCanonicalPaddedBase64DecodedLength } from '@happier-dev/protocol/crypto/base64';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';

import { encodeBase64 } from '@/encryption/base64';
import { digest } from '@/platform/digest';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import {
    callDaemonWorkspaceStatFileRpc,
    downloadDaemonWorkspaceFileToBase64,
    uploadDaemonWorkspaceFileFromReader,
    observeTransferOperation,
    callAdmittedFilesystemTransferActionRpc,
} from '@/sync/domains/transfers/runtime/transferRuntime';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';

import type { WorkspaceFileSystemTarget } from './directoryBrowsing';
import { runTransferFinalizeRecovery } from '@/components/transfers/recovery/runTransferFinalizeRecovery';
import { t } from '@/text';
import { isTransferFinalizeRecoveryFailure } from '@/sync/domains/transfers/runtime/transferRuntime';
import type { WorkspaceFileUploadFinalizeResponse } from '@/sync/domains/transfers/runtime/transferRuntime/families/workspaceFileTransfers';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
    FilesystemReadFileOutputSchema,
    FilesystemWriteFileOutputSchema,
    isFilesystemWriteGuardErrorCode,
} from '@happier-dev/protocol/actions/filesystemActionFamily';
import { MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE, MACHINE_CARRIER_UNAVAILABLE_ERROR_CODE } from '@/sync/domains/transfers/runtime/transferRuntime';
import { invokeWorkspaceFileSystemAction, projectWorkspaceFileSystemActionFailure, type WorkspaceFileSystemFailure } from './actionInvocation';
import { callAdmittedFilesystemActionRpc } from '@/sync/ops/actions/filesystemActionDeps';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { captureLazyActionAccountContext, withActionAccountRequestSignal } from '@/sync/ops/actions/actionAccountContext';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resumeActionExecutionResult, type ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';

const WORKSPACE_FILE_INLINE_MAX_BYTES_ENV_KEY = 'EXPO_PUBLIC_HAPPIER_SESSION_FILE_INLINE_MAX_BYTES';
const DEFAULT_WORKSPACE_FILE_INLINE_MAX_BYTES = 256 * 1024;
// Unqualified inline reads keep a small default; callers with an explicit bounded
// ceiling retain it up to the canonical public hard limit.

function resolveWorkspaceFileInlineMaxBytes(): number {
    const raw = String(process.env[WORKSPACE_FILE_INLINE_MAX_BYTES_ENV_KEY] ?? '').trim();
    if (!raw) {
        return DEFAULT_WORKSPACE_FILE_INLINE_MAX_BYTES;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_WORKSPACE_FILE_INLINE_MAX_BYTES;
    }

    return Math.min(parsed, HARD_OPENABLE_CONTENT_MAX_BYTES_V1);
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
}

export type WorkspaceReadFileResponse =
  | Readonly<{ success: true; content: string; sizeBytes?: number; eof?: boolean }>
  | WorkspaceFileSystemFailure;

/**
 * The workspace file-details owner exposes this narrow stat alongside its
 * bounded read. Callers retain the private workspace target and path; public
 * plugin surfaces receive only owner-derived metadata through their opaque
 * openable-content binding.
 */
export type WorkspaceStatFileResponse =
  | Readonly<{
      success: true;
      exists: boolean;
      kind?: 'file' | 'directory' | 'other';
      sizeBytes?: number;
      modifiedMs?: number;
      /**
       * Status-change time, when the daemon reports it. Size and modification
       * time alone cannot distinguish an equal-size edit that preserved mtime;
       * exact revision consumers request `contentHash` below.
       */
      changedMs?: number;
      /** SHA-256 of the file bytes when the daemon can provide an exact revision. */
      contentHash?: string;
    }>
  | WorkspaceFileSystemFailure;

export async function workspaceStatFile(
    target: WorkspaceFileSystemTarget,
    path: string,
    options?: Readonly<{ signal?: AbortSignal | null; includeContentHash?: boolean }>,
): Promise<WorkspaceStatFileResponse> {
    return await callDaemonWorkspaceStatFileRpc({
        machineId: target.machineId,
        serverId: target.serverId,
        rootPath: target.rootPath,
        agentRootPath: target.agentRootPath,
        request: { path },
        ...(options?.includeContentHash ? { includeContentHash: true } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
    });
}

export async function workspaceReadFile(
    target: WorkspaceFileSystemTarget,
    path: string,
    options?: Readonly<{
        maxBytes?: number | null;
        signal?: AbortSignal | null;
        range?: Readonly<{ offset: number; length: number }>;
        /** Size from the caller's preceding stat; delivery hint only, never a byte-bound authority. */
        knownSizeBytes?: number | null;
    }>,
): Promise<WorkspaceReadFileResponse> {
    const inlineMaxBytes = resolveWorkspaceFileInlineMaxBytes();
    const maxBytes =
        typeof options?.maxBytes === 'number' && Number.isFinite(options.maxBytes)
            ? Math.min(Math.max(0, Math.floor(options.maxBytes)), HARD_OPENABLE_CONTENT_MAX_BYTES_V1)
            : options?.range?.length ?? inlineMaxBytes;
    const result = await invokeWorkspaceFileSystemAction(target, 'daemon.filesystem.readFile', {
        rootPath: target.rootPath,
        path: resolveMachineAbsolutePath({
            rootPath: target.rootPath,
            agentRootPath: target.agentRootPath,
            requestPath: path,
            pathKind: 'workspace_entry',
        }),
        ...(options?.range ? { offset: options.range.offset, length: options.range.length } : {}),
    }, { signal: options?.signal,
        ...(!options?.range && maxBytes > inlineMaxBytes ? { delivery: async ({ actionId, input, context }) => {
            // A preview ceiling is an admission bound, not the file's size.
            // Keep small files on the ordinary reader even when the viewer
            // permits larger previews. Reuse its admitted RPC and Account custody.
            let sizeBytes = options?.knownSizeBytes;
            if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
                const stat = await workspaceStatFile({ ...target, serverId: context.serverId }, path, { signal: context.signal });
                sizeBytes = stat.success && stat.exists && (!stat.kind || stat.kind === 'file') ? stat.sizeBytes : null;
            }
            context.signal?.throwIfAborted();
            if (typeof sizeBytes === 'number' && Number.isFinite(sizeBytes)
                && sizeBytes >= 0 && sizeBytes <= inlineMaxBytes) {
                return await callAdmittedFilesystemActionRpc({ actionId, input, context, machineId: target.machineId,
                    serverId: context.serverId, accountId: context.runtimeAccountId, requestId: context.actionRequestId ?? undefined });
            }
            const read = await downloadDaemonWorkspaceFileToBase64({ machineId: target.machineId,
                serverId: context.serverId, rootPath: target.rootPath, agentRootPath: target.agentRootPath,
                path, maxBytes, signal: context.signal,
                callAdmittedAction: params => callAdmittedFilesystemTransferActionRpc({ ...params, context, requestId: context.actionRequestId ?? undefined }),
            });
            return read.ok ? { success: true, content: read.contentBase64 }
                : { success: false, error: read.error };
        } } : {}),
    });
    if (!result.ok) return projectWorkspaceFileSystemActionFailure(result);

    const response = FilesystemReadFileOutputSchema.safeParse(result.result);
    if (!response.success) {
        return { success: false, error: 'The filesystem Action response could not be validated.' };
    }
    if (!response.data.success) return response.data;

    const decodedLength = readCanonicalPaddedBase64DecodedLength(response.data.content);
    if (decodedLength === null) {
        return { success: false, error: 'The filesystem Action returned invalid file content.' };
    }
    if (decodedLength > maxBytes) {
        return { success: false, error: 'File exceeds the inline file read size limit' };
    }
    if (options?.range) {
        const { offset, length } = options.range;
        const { sizeBytes, eof } = response.data;
        if (sizeBytes === undefined || eof === undefined
            || decodedLength !== Math.min(length, Math.max(0, sizeBytes - offset))
            || eof !== (offset + decodedLength >= sizeBytes)) {
            return { success: false, error: 'The filesystem Action returned an incomplete byte range.' };
        }
    }

    return response.data;
}

export type WorkspaceWriteFileResponse =
  | Readonly<{ success: true; hash: string }>
  | Readonly<WorkspaceFileSystemFailure & { approvalArtifactId?: string; kind: WorkspaceWriteFileFailureKind }>;

export type WorkspaceWriteFileFailureKind = 'conflict' | 'approval_required' | 'unreachable' | 'unsupported' | 'failed';

export function classifyWorkspaceWriteFileFailure(
    failure: Readonly<WorkspaceFileSystemFailure & { approvalArtifactId?: string }>,
): Extract<WorkspaceWriteFileResponse, { success: false }> {
    const code = failure.errorCode;
    const kind: WorkspaceWriteFileFailureKind = isFilesystemWriteGuardErrorCode(code) ? 'conflict'
        : code === 'approval_required' ? 'approval_required'
        : code === RPC_ERROR_CODES.METHOD_NOT_FOUND ? 'unsupported'
        : code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE || code === RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE
            || code === MACHINE_RPC_TIMEOUT_ERROR_CODE || code === MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE
            || code === MACHINE_CARRIER_UNAVAILABLE_ERROR_CODE ? 'unreachable' : 'failed';
    return { ...failure, kind };
}

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
    content: string | Uint8Array,
    expectedHash?: string | null,
    options?: Readonly<{ signal?: AbortSignal | null; accountId?: string | null;
        onApprovalPending?: (registration: ActionApprovalContinuation) => void }>,
): Promise<WorkspaceWriteFileResponse> {
    options?.signal?.throwIfAborted();
    const contentBytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const inlineMaxBytes = resolveWorkspaceFileInlineMaxBytes();
    const serverId = target.serverId ?? captureActiveServerAccountScopeLifetime()?.scope.serverId;
    const account = options?.onApprovalPending && serverId ? await captureLazyActionAccountContext(serverId) : null;
    try {

    // View cancellation ends observation; an admitted write keeps the Action's
    // Account lifetime and must not be reported as definitely unwritten.
    const input = {
        rootPath: target.rootPath,
        path: resolveMachineAbsolutePath({ rootPath: target.rootPath, agentRootPath: target.agentRootPath,
            requestPath: path, pathKind: 'workspace_entry' }),
        content: encodeBase64(contentBytes, 'base64'),
        ...(expectedHash === undefined ? {} : { expectedHash }),
    };
    const accountId = options?.accountId ?? account?.accountId;
    const operation = invokeWorkspaceFileSystemAction(account ? { ...target, serverId: account.serverId } : target,
        'daemon.filesystem.writeFile', input, { ...(accountId ? { accountId } : {}),
        ...(contentBytes.byteLength > inlineMaxBytes ? { delivery: async ({ context }) => {
        const recoveryObservation = mergeAbortSignals([options?.signal ?? undefined, context.signal]);
        try {
            const sha256 = bytesToHex(await digest('SHA-256', contentBytes));
            let upload = await uploadDaemonWorkspaceFileFromReader({
                machineId: target.machineId,
                serverId: target.serverId,
                rootPath: target.rootPath,
                agentRootPath: target.agentRootPath,
                fileReader: {
                    sizeBytes: contentBytes.byteLength,
                    readBytes: async (offset, length) => contentBytes.slice(offset, offset + length),
                    close: async () => {},
                },
                callAdmittedAction: params => callAdmittedFilesystemTransferActionRpc({ ...params, context, requestId: context.actionRequestId ?? undefined }),
                request: {
                    path,
                    sizeBytes: contentBytes.byteLength,
                    overwrite: expectedHash !== null,
                    ...(expectedHash === undefined ? {} : { expectedHash }),
                    sha256,
                },
                signal: context.signal,
            });

            if (isTransferFinalizeRecoveryFailure<WorkspaceFileUploadFinalizeResponse>(upload)) {
                const recoveryResult = await runTransferFinalizeRecovery({
                    recovery: upload.recovery,
                    signal: recoveryObservation.signal,
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
        } finally { recoveryObservation.dispose(); }
    } } : {}) });
    let result = await observeTransferOperation(operation, options?.signal);
    if (account && options?.onApprovalPending && result.ok && ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) {
        result = await withActionAccountRequestSignal({ accountLifetime: account.accountOnlyLifetime }, options.signal ?? undefined,
            signal => resumeActionExecutionResult({ result, actionId: 'daemon.filesystem.writeFile', actionInput: input,
                scope: { serverId: account.serverId, accountId: account.accountId }, signal,
                onApprovalPending: options.onApprovalPending! }));
    }
    if (!result.ok) return classifyWorkspaceWriteFileFailure({ ...projectWorkspaceFileSystemActionFailure(result),
        errorCode: normalizeWorkspaceWriteFileErrorCode(result.errorCode) });
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) return classifyWorkspaceWriteFileFailure({ success: false, error: 'The Action awaits approval.', errorCode: 'approval_required', approvalArtifactId: approval.data.artifactId });
    const response = FilesystemWriteFileOutputSchema.safeParse(result.result);
    if (!response.success) return classifyWorkspaceWriteFileFailure({ success: false, error: 'The filesystem Action response could not be validated.', errorCode: 'invalid_action_output' });
    return response.data.success ? response.data : classifyWorkspaceWriteFileFailure(response.data);
    } finally { account?.dispose(); }
}
