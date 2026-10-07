import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionTransferRoutingV1Schema, type SessionTransferRoutingV1 } from '@happier-dev/protocol/socketRpc';
import { SessionAttachmentHandleV1Schema, type SessionAttachmentHandleV1 } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';
import type { SessionAttachmentUploadInitRequestV1 } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentUploadInitRequestV1';
import type { SessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import { SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR } from '@/sync/runtime/sessionMachineRpcErrorCodes';

import { uploadBulkPayloadFromFile } from '../plumbing/uploadBulkPayloadFromFile';
import { downloadBulkPayloadViaMachineRpcToDestination } from '../carriers/downloadBulkPayloadViaMachineRpcToDestination';
import {
    createTransferFinalizeRecovery,
    isTransferFinalizeRecoveryFailure,
    retainTransferFinalizeRecovery,
    settleTransferFinalizeRecovery,
    type TransferFinalizeRecoveryFailure,
} from '../plumbing/directTransferFinalizeRecovery';
import { TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE } from '../plumbing/directTransferImportClient';

export type SessionAttachmentTransferContext = Readonly<{
    kind: 'sessionBound';
    sessionId: string;
    call: <T>(method: string, request: unknown, signal?: AbortSignal | null) => Promise<T>;
}>;

/** The Protocol schema owns the method/direction relation; transport adds no parallel map. */
export function createSessionAttachmentTransferRouting(sessionId: string, method: string): SessionTransferRoutingV1 {
    const upload = SessionTransferRoutingV1Schema.safeParse({ sessionId, method, t: 'session_attachment_upload_v1' });
    return upload.success ? upload.data : SessionTransferRoutingV1Schema.parse({ sessionId, method, t: 'session_attachment_download_v1' });
}

type SessionRpcFailure = Readonly<{ success: false; error: string; errorCode?: string }>;
type TransferFailureResponse = Readonly<{ success: false; error: string; errorCode?: string }>;
export type TransferFileReader = Readonly<{
    sizeBytes: number;
    readBytes: (offset: number, length: number) => Promise<Uint8Array>;
    close: () => Promise<void>;
}>;

export type SessionAttachmentsUploadInitRequest = Readonly<
    Omit<SessionAttachmentUploadInitRequestV1, 't' | 'sessionId'>
    & Required<Pick<SessionAttachmentUploadInitRequestV1,
        'uploadLocation' | 'workspaceRelativeDir' | 'vcsIgnoreStrategy' | 'vcsIgnoreWritesEnabled'>>
    & {
    messageLocalId: string;
    fileName: string;
    sizeBytes: number;
    workspaceRootPath?: string;
}>;

export type SessionAttachmentsUploadFinalizeResponse =
    | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string; attachmentHandle?: SessionAttachmentHandleV1 }>
    | SessionRpcFailure;

type SessionAttachmentUploadTarget =
    | Readonly<{ session: SessionMachineTargetIdentity | string }>
    | Readonly<{ sessionId: string }>;

function readSessionAttachmentUploadTarget(
    target: SessionAttachmentUploadTarget,
): SessionMachineTargetIdentity | string {
    return 'session' in target ? target.session : target.sessionId;
}

export async function uploadDaemonSessionAttachmentFromReader(params: SessionAttachmentUploadTarget & Readonly<{
    fileReader: TransferFileReader;
    transferContext?: SessionAttachmentTransferContext | null;
    request: SessionAttachmentsUploadInitRequest;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<
    SessionAttachmentsUploadFinalizeResponse
    | TransferFailureResponse
    | TransferFinalizeRecoveryFailure<SessionAttachmentsUploadFinalizeResponse>
> {
    const session = readSessionAttachmentUploadTarget(params);
    const sessionId = typeof session === 'string' ? session : session.sessionId;
    const context = params.transferContext;
    if (context) {
        if (context.sessionId !== sessionId) {
            await params.fileReader.close();
            return { success: false, error: 'Session attachment scope is unavailable', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
        }
        let expiresAt: number | undefined;
        const readFinalizeResponse = async (request: Readonly<{ uploadId: string }>, signal?: AbortSignal | null): Promise<SessionAttachmentsUploadFinalizeResponse & { expiresAt?: number }> => {
            const response = await context.call<SessionAttachmentsUploadFinalizeResponse & { expiresAt?: number }>(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, request, signal);
            if (response.success) {
                const parsed = SessionAttachmentHandleV1Schema.safeParse(response.attachmentHandle);
                if (!parsed.success || parsed.data.sessionId !== context.sessionId) {
                    return { success: false, error: 'Upload finalized without a valid Session attachment handle' };
                }
                return { ...response, attachmentHandle: parsed.data };
            }
            return response;
        };
        const finalize = async (request: Readonly<{ uploadId: string }>, signal?: AbortSignal | null): Promise<SessionAttachmentsUploadFinalizeResponse | TransferFinalizeRecoveryFailure<SessionAttachmentsUploadFinalizeResponse>> => {
            const response = await readFinalizeResponse(request, signal);
            if (response.success) return response;
            const recoveryExpiry = response.expiresAt ?? expiresAt;
            if (response.errorCode !== TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE || typeof recoveryExpiry !== 'number') return response;
            return {
                success: false,
                error: response.error,
                errorCode: TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE,
                recovery: createTransferFinalizeRecovery<SessionAttachmentsUploadFinalizeResponse>({
                    expiresAt: recoveryExpiry,
                    retryFinalize: async () => {
                        try {
                            const retried = await readFinalizeResponse(request);
                            if (retried.success) return settleTransferFinalizeRecovery({ status: 'finalized', response: retried });
                            if (retried.errorCode === TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE) return retainTransferFinalizeRecovery({ status: 'recovery_required', error: retried.error });
                            return settleTransferFinalizeRecovery({ status: 'unavailable', reason: 'session_unavailable', error: retried.error });
                        } catch (error) {
                            return retainTransferFinalizeRecovery({ status: 'unavailable', reason: 'session_unavailable', error: error instanceof Error ? error.message : 'Session attachment scope is unavailable' });
                        }
                    },
                    discard: async () => {
                        try {
                            const discarded = await context.call<SessionRpcFailure | { success: true }>(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT, request);
                            return discarded.success
                                ? settleTransferFinalizeRecovery({ status: 'discarded' })
                                : settleTransferFinalizeRecovery({ status: 'unavailable', reason: 'session_unavailable', error: discarded.error });
                        } catch (error) {
                            return retainTransferFinalizeRecovery({ status: 'unavailable', reason: 'session_unavailable', error: error instanceof Error ? error.message : 'Session attachment scope is unavailable' });
                        }
                    },
                }),
            };
        };
        return await uploadBulkPayloadFromFile({
            fileReader: params.fileReader,
            init: async (signal) => {
                const { workspaceRootPath: _root, ...request } = params.request;
                const response = await context.call<
                    | SessionRpcFailure
                    | { success: true; uploadId: string; chunkSizeBytes: number; recipientPublicKeyBase64: string; expiresAt?: number }
                >(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, { ...request, t: 'session_attachment_upload_v1', sessionId }, signal);
                if (response.success) expiresAt = response.expiresAt;
                return response;
            },
            sendChunk: (request, signal) => context.call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, request, signal),
            finalize,
            abort: (request) => context.call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT, request),
            retainUploadAfterFinalize: isTransferFinalizeRecoveryFailure,
            signal: params.signal,
            onProgress: params.onProgress,
        });
    }
    const [{ readMachineControlTargetForSession }, { resolveSessionListPreferredServerIdFromState }, { getActiveServerSnapshot }, { storage }, { uploadSessionAttachmentFromReaderViaMachineCarrier }] = await Promise.all([
        import('@/sync/ops/sessionMachineTarget'),
        import('@/sync/domains/session/listing/sessionListLookupState'),
        import('@/sync/domains/server/serverRuntime'),
        import('@/sync/domains/state/storage'),
        import('./uploadSessionAttachmentFromReaderViaMachineCarrier'),
    ]);
    const machineTarget = readMachineControlTargetForSession(session);
    const preferredServerId = typeof session === 'object'
        ? session.serverId
        : resolveSessionListPreferredServerIdFromState(
            storage.getState(),
            sessionId,
            getActiveServerSnapshot().serverId,
        );
    const serverId = preferredServerId ?? undefined;
    if (!machineTarget || !serverId) {
        return {
            success: false,
            error: SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }

    return await uploadSessionAttachmentFromReaderViaMachineCarrier({
        machineId: machineTarget.machineId,
        serverId,
        fileReader: params.fileReader,
        request: {
            ...params.request,
            t: 'session_attachment_upload_v1',
            sessionId,
            workingDirectory: machineTarget.basePath,
            workspaceRootPath: params.request.uploadLocation === 'workspace'
                ? machineTarget.basePath
                : params.request.workspaceRootPath,
        },
        onProgress: params.onProgress ?? null,
        signal: params.signal ?? null,
    });
}

/** Handle-only preview; there is deliberately no filesystem path request in this carrier. */
export async function downloadDaemonSessionAttachmentToDestination(params: Readonly<{
    transferContext: SessionAttachmentTransferContext;
    attachmentHandle: SessionAttachmentHandleV1;
    destination: Parameters<typeof downloadBulkPayloadViaMachineRpcToDestination>[0]['destination'];
    onInit?: Parameters<typeof downloadBulkPayloadViaMachineRpcToDestination>[0]['onInit'];
    signal?: AbortSignal | null;
}>): ReturnType<typeof downloadBulkPayloadViaMachineRpcToDestination> {
    const context = params.transferContext;
    return await downloadBulkPayloadViaMachineRpcToDestination({
        destination: params.destination,
        init: (recipient, signal) => params.attachmentHandle.sessionId !== context.sessionId
            ? Promise.resolve({ success: false, error: 'Session attachment scope is unavailable' })
            : context.call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, {
            t: 'session_attachment_download_v1', attachmentHandle: params.attachmentHandle, ...recipient,
        }, signal),
        readChunk: (request, signal) => context.call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, request, signal),
        finalize: (request, signal) => context.call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, request, signal),
        abort: (request) => context.call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT, request),
        onInit: params.onInit,
        signal: params.signal,
    });
}
