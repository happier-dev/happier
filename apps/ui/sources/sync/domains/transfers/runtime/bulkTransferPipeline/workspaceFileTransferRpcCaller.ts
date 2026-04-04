import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { assertRpcResponseWithSuccess } from '@/sync/runtime/assertRpcResponseWithSuccess';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';

import {
    abortDirectImportSession,
    finalizeDirectImportSession,
    prepareDirectImportSession,
    sendDirectImportChunk,
    type DirectTransferImportOpenRequest,
    type PreparedDirectImportSession,
} from './directTransferImportClient';
import { resolvePreferScopedForBulkMachineTransfer } from './resolvePreferScopedForBulkMachineTransfer';

type WorkspaceFileTransferRpcCallParams<TRequest> = Readonly<{
    request: TRequest;
    machineMethod: string;
    timeoutMs?: number | null;
}>;

export type WorkspaceFileTransferRpcCaller = Readonly<{
    call: <TResponse extends Readonly<{ success: boolean }>, TRequest>(
        params: WorkspaceFileTransferRpcCallParams<TRequest>,
    ) => Promise<TResponse>;
}>;

type DirectImportChunkRequest = Readonly<{
    uploadId: string;
    index: number;
    payloadBase64: string;
    encryptedDataKeyEnvelopeBase64: string;
}>;

type DirectImportFinalizeRequest = Readonly<{ uploadId: string }>;
type DirectImportFinalizeSuccess = Readonly<{
    success: true;
    path: string;
    sizeBytes: number;
    sha256: string;
}>;

type WorkspaceBulkUploadOpenRequest =
    | Readonly<{
        t: 'session_file_upload_v1';
        path: unknown;
        sizeBytes: unknown;
        overwrite: unknown;
        sha256?: unknown;
    }>
    | Readonly<{
        t: 'session_attachment_upload_v1';
        messageLocalId: unknown;
        fileName: unknown;
        sizeBytes: unknown;
        uploadLocation?: 'workspace' | 'os_temp';
        workspaceRootPath?: unknown;
        workspaceRelativeDir?: string;
        vcsIgnoreStrategy?: 'git_info_exclude' | 'gitignore' | 'none';
        vcsIgnoreWritesEnabled?: boolean;
    }>;

function isDirectImportChunkRequest(value: unknown): value is DirectImportChunkRequest {
    return Boolean(value)
        && typeof value === 'object'
        && typeof (value as DirectImportChunkRequest).uploadId === 'string'
        && typeof (value as DirectImportChunkRequest).index === 'number'
        && typeof (value as DirectImportChunkRequest).payloadBase64 === 'string'
        && typeof (value as DirectImportChunkRequest).encryptedDataKeyEnvelopeBase64 === 'string';
}

function isDirectImportFinalizeRequest(value: unknown): value is DirectImportFinalizeRequest {
    return Boolean(value)
        && typeof value === 'object'
        && typeof (value as DirectImportFinalizeRequest).uploadId === 'string';
}

function normalizeDirectImportFinalizeSuccess(value: unknown): DirectImportFinalizeSuccess | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (
        record.success === true
        && typeof record.path === 'string'
        && typeof record.sizeBytes === 'number'
        && typeof record.sha256 === 'string'
    ) {
        return {
            success: true,
            path: record.path,
            sizeBytes: record.sizeBytes,
            sha256: record.sha256,
        };
    }

    const finalized = record.finalized;
    if (
        record.success === true
        && finalized
        && typeof finalized === 'object'
        && typeof (finalized as Record<string, unknown>).path === 'string'
        && typeof (finalized as Record<string, unknown>).sizeBytes === 'number'
        && typeof record.sha256 === 'string'
    ) {
        return {
            success: true,
            path: (finalized as Record<string, unknown>).path as string,
            sizeBytes: (finalized as Record<string, unknown>).sizeBytes as number,
            sha256: record.sha256,
        };
    }

    return null;
}

function isWorkspaceBulkUploadOpenRequest(value: unknown): value is WorkspaceBulkUploadOpenRequest {
    return Boolean(value)
        && typeof value === 'object'
        && typeof (value as { t?: unknown }).t === 'string';
}

function toDirectImportOpenRequest(input: Readonly<{
    workingDirectory: string | null;
    request: unknown;
}>): DirectTransferImportOpenRequest | null {
    if (!input.workingDirectory || !isWorkspaceBulkUploadOpenRequest(input.request)) {
        return null;
    }
    return {
        workingDirectory: input.workingDirectory,
        ...input.request,
    };
}

function normalizeServerId(serverId?: string | null): string | undefined {
    return typeof serverId === 'string' ? serverId : undefined;
}

export function createWorkspaceFileTransferRpcCaller(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    transferSizeBytes?: number | null;
    workingDirectory?: string | null;
}>): WorkspaceFileTransferRpcCaller {
    const directImportSessions = new Map<string, PreparedDirectImportSession>();
    let preferScopedPromise: Promise<boolean> | null = null;

    const getPreferScoped = async (): Promise<boolean> => {
        preferScopedPromise ??= resolvePreferScopedForBulkMachineTransfer({
            machineId: params.machineId,
            serverId: params.serverId,
            timeoutMs: 500,
        });
        return await preferScopedPromise;
    };

    return {
        call: async <TResponse extends Readonly<{ success: boolean }>, TRequest>(
            callParams: WorkspaceFileTransferRpcCallParams<TRequest>,
        ): Promise<TResponse> => {
            try {
                if (callParams.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT) {
                    const directRequest = toDirectImportOpenRequest({
                        workingDirectory: typeof params.workingDirectory === 'string' ? params.workingDirectory : null,
                        request: callParams.request,
                    });
                    if (directRequest) {
                        const prepared = await prepareDirectImportSession({
                            machineId: params.machineId,
                            serverId: params.serverId,
                            request: directRequest,
                            preferScoped: await getPreferScoped(),
                        });
                        if (prepared.success === true) {
                            directImportSessions.set(prepared.session.uploadId, prepared.session);
                            return {
                                success: true,
                                uploadId: prepared.session.uploadId,
                                chunkSizeBytes: prepared.session.chunkSizeBytes,
                                recipientPublicKeyBase64: prepared.session.recipientPublicKeyBase64,
                                destDisplayPath: prepared.session.destDisplayPath,
                                expectedSizeBytes: prepared.session.expectedSizeBytes,
                                expiresAt: prepared.session.expiresAt,
                            } as unknown as TResponse;
                        }
                    }
                }

                if (callParams.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK && isDirectImportChunkRequest(callParams.request)) {
                    const directSession = directImportSessions.get(callParams.request.uploadId);
                    if (directSession) {
                        return await sendDirectImportChunk({
                            baseUrl: directSession.baseUrls[0] ?? '',
                            index: callParams.request.index,
                            payloadBase64: callParams.request.payloadBase64,
                            encryptedDataKeyEnvelopeBase64: callParams.request.encryptedDataKeyEnvelopeBase64,
                        }) as TResponse;
                    }
                }

                if (callParams.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE && isDirectImportFinalizeRequest(callParams.request)) {
                    const directSession = directImportSessions.get(callParams.request.uploadId);
                    if (directSession) {
                        const finalizeResponse = await finalizeDirectImportSession(directSession.baseUrls[0] ?? '');
                        const normalizedSuccess = normalizeDirectImportFinalizeSuccess(finalizeResponse);
                        if ((finalizeResponse as { keepSession?: boolean }).keepSession !== true) {
                            directImportSessions.delete(callParams.request.uploadId);
                        }
                        if (normalizedSuccess === null) {
                            return finalizeResponse as unknown as TResponse;
                        }
                        return normalizedSuccess as unknown as TResponse;
                    }
                }

                if (callParams.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_ABORT && isDirectImportFinalizeRequest(callParams.request)) {
                    const directSession = directImportSessions.get(callParams.request.uploadId);
                    if (directSession) {
                        directImportSessions.delete(callParams.request.uploadId);
                        try {
                            await abortDirectImportSession(directSession.baseUrls[0] ?? '');
                        } catch {
                            // Best-effort only.
                        }
                        return { success: true } as unknown as TResponse;
                    }
                }

                const response = await callGuardedMachineRpcWithPolicy<unknown, TRequest>({
                    machineId: params.machineId,
                    serverId: normalizeServerId(params.serverId),
                    timeoutMs: typeof callParams.timeoutMs === 'number' ? callParams.timeoutMs : undefined,
                    preferScoped: await getPreferScoped(),
                    method: callParams.machineMethod,
                    payload: callParams.request,
                });

                return assertRpcResponseWithSuccess<TResponse>(response);
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Workspace transfer RPC failed',
                    errorCode: readRpcErrorCode(error),
                } as unknown as TResponse;
            }
        },
    };
}
