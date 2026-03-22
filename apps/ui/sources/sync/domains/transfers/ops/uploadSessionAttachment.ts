import { apiSocket } from '@/sync/api/session/apiSocket';
import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { openLocalUploadSourceReader, resolveLocalUploadSourceSizeBytes } from '@/sync/domains/files/transfers/localUploadSourceReader';
import { resolveBulkTransferPolicyAndRoute, uploadBulkPayloadFromFile } from '@/sync/domains/transfers/runtime/bulkTransferPipeline';
import { canUseSessionRpc, readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';

const SESSION_ATTACHMENTS_UPLOAD_INIT = 'daemon.sessionAttachments.upload.init';
const SESSION_ATTACHMENTS_UPLOAD_CHUNK = 'daemon.sessionAttachments.upload.chunk';
const SESSION_ATTACHMENTS_UPLOAD_FINALIZE = 'daemon.sessionAttachments.upload.finalize';
const SESSION_ATTACHMENTS_UPLOAD_ABORT = 'daemon.sessionAttachments.upload.abort';

export type AttachmentsUploadLocation = 'workspace' | 'os_temp';
export type VcsIgnoreStrategy = 'git_info_exclude' | 'gitignore' | 'none';

export type AttachmentsUploadConfig = Readonly<{
    uploadLocation: AttachmentsUploadLocation;
    workspaceRelativeDir: string;
    vcsIgnoreStrategy: VcsIgnoreStrategy;
    vcsIgnoreWritesEnabled: boolean;
    maxFileBytes: number;
}>;

export type AttachmentsUploadProgress = Readonly<{
    uploadedBytes: number;
    totalBytes: number;
}>;

export type SessionAttachmentsUploadFileResult =
    | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

function describeUploadSource(source: AttachmentsUploadFileSource): Readonly<{
    name: string;
    sizeBytes: number;
    mimeType?: string;
}> {
    if (source.kind === 'web') {
        return {
            name: source.file.name,
            sizeBytes: source.file.size,
            mimeType: source.file.type || undefined,
        };
    }

    return {
        name: source.name,
        sizeBytes: typeof source.sizeBytes === 'number' && Number.isFinite(source.sizeBytes) ? source.sizeBytes : -1,
        mimeType: source.mimeType ? String(source.mimeType) : undefined,
    };
}

async function resolveAttachmentUploadRoute(args: Readonly<{
    sessionId: string;
    transferSizeBytes: number;
}>): Promise<
    | Readonly<{
        kind: 'selected';
        route: Readonly<{
            kind: 'machine_rpc_direct' | 'server_routed_stream';
            serverId: string | undefined;
        }>;
    }>
    | Readonly<{
        kind: 'unavailable';
        error: string;
    }>
> {
    const serverId = resolvePreferredServerIdForSessionId(args.sessionId);
    const serverFeatures = await getReadyServerFeatures({
        timeoutMs: 500,
        serverId,
    });
    const machineTarget = readMachineTargetForSession(args.sessionId);
    const sessionRpcAvailable = canUseSessionRpc(args.sessionId);

    const resolved = resolveBulkTransferPolicyAndRoute({
        serverId,
        machineTargetAvailable: machineTarget !== null,
        sessionRpcAvailable,
        transferSizeBytes: args.transferSizeBytes,
        serverFeatures,
    });

    if (resolved.kind === 'unavailable') {
        return {
            kind: 'unavailable',
            error: resolved.response.error,
        };
    }

    return resolved;
}

async function callAttachmentTransferRpc<TResponse, TRequest>(args: Readonly<{
    sessionId: string;
    route: Readonly<{
        kind: 'machine_rpc_direct' | 'server_routed_stream';
        serverId: string | undefined;
    }>;
    machineMethod: string;
    sessionMethod: string;
    payload: TRequest;
}>): Promise<TResponse> {
    if (args.route.kind === 'machine_rpc_direct') {
        const machineTarget = readMachineTargetForSession(args.sessionId);
        if (!machineTarget) {
            throw new Error('No machine target available for attachment upload');
        }
        return await apiSocket.machineRPC<TResponse, TRequest>(
            machineTarget.machineId,
            args.machineMethod,
            args.payload,
        );
    }

    return await apiSocket.sessionRPC<TResponse, TRequest>(
        args.sessionId,
        args.sessionMethod,
        args.payload,
    );
}

export async function sessionAttachmentsUploadFile(args: Readonly<{
    sessionId: string;
    file: AttachmentsUploadFileSource;
    messageLocalId: string;
    config: AttachmentsUploadConfig;
    onProgress?: (progress: AttachmentsUploadProgress) => void;
}>): Promise<SessionAttachmentsUploadFileResult> {
    try {
        let described = describeUploadSource(args.file);
        const resolvedSizeBytes = await resolveLocalUploadSourceSizeBytes(args.file);
        if (resolvedSizeBytes != null) {
            described = { ...described, sizeBytes: resolvedSizeBytes };
        }

        if (described.sizeBytes < 0) {
            return { success: false, error: 'Unknown attachment size' };
        }
        if (described.sizeBytes > args.config.maxFileBytes) {
            return { success: false, error: 'File exceeds maximum allowed size' };
        }

        const resolvedRoute = await resolveAttachmentUploadRoute({
            sessionId: args.sessionId,
            transferSizeBytes: described.sizeBytes,
        });
        if (resolvedRoute.kind === 'unavailable') {
            return { success: false, error: resolvedRoute.error };
        }

        const reader = await openLocalUploadSourceReader(args.file);
        const bulkUpload = await uploadBulkPayloadFromFile({
            fileReader: {
                sizeBytes: described.sizeBytes,
                readBytes: async (offset, length) => await reader.readBytes(offset, length),
                close: async () => await reader.close(),
            },
            init: async () => {
                return await callAttachmentTransferRpc<{
                    success: true;
                    uploadId: string;
                    chunkSizeBytes: number;
                    recipientPublicKeyBase64: string;
                } | { success: false; error: string }, unknown>({
                    sessionId: args.sessionId,
                    route: resolvedRoute.route,
                    machineMethod: SESSION_ATTACHMENTS_UPLOAD_INIT,
                    sessionMethod: SESSION_ATTACHMENTS_UPLOAD_INIT,
                    payload: {
                        messageLocalId: args.messageLocalId,
                        fileName: described.name,
                        sizeBytes: described.sizeBytes,
                        uploadLocation: args.config.uploadLocation,
                        workspaceRelativeDir: args.config.workspaceRelativeDir,
                        vcsIgnoreStrategy: args.config.vcsIgnoreStrategy,
                        vcsIgnoreWritesEnabled: args.config.vcsIgnoreWritesEnabled,
                    },
                });
            },
            sendChunk: async ({ uploadId, index, payloadBase64, encryptedDataKeyEnvelopeBase64 }) => {
                const payload = {
                    uploadId,
                    index,
                    payloadBase64,
                    encryptedDataKeyEnvelopeBase64,
                };
                return await callAttachmentTransferRpc<{ success: boolean; error?: string }, typeof payload>({
                    sessionId: args.sessionId,
                    route: resolvedRoute.route,
                    machineMethod: SESSION_ATTACHMENTS_UPLOAD_CHUNK,
                    sessionMethod: SESSION_ATTACHMENTS_UPLOAD_CHUNK,
                    payload,
                });
            },
            finalize: async ({ uploadId }) => {
                return await callAttachmentTransferRpc<SessionAttachmentsUploadFileResult, { uploadId: string }>({
                    sessionId: args.sessionId,
                    route: resolvedRoute.route,
                    machineMethod: SESSION_ATTACHMENTS_UPLOAD_FINALIZE,
                    sessionMethod: SESSION_ATTACHMENTS_UPLOAD_FINALIZE,
                    payload: { uploadId },
                });
            },
            abort: async ({ uploadId }) => {
                return await callAttachmentTransferRpc({
                    sessionId: args.sessionId,
                    route: resolvedRoute.route,
                    machineMethod: SESSION_ATTACHMENTS_UPLOAD_ABORT,
                    sessionMethod: SESSION_ATTACHMENTS_UPLOAD_ABORT,
                    payload: { uploadId },
                });
            },
            onProgress: args.onProgress
                ? (progress) => {
                    try {
                        args.onProgress?.(progress);
                    } catch {
                        // ignore
                    }
                }
                : null,
        });

        if (bulkUpload.success !== true) {
            return { success: false, error: bulkUpload.error ?? 'Upload failed' };
        }

        return { success: true, path: bulkUpload.path, sizeBytes: bulkUpload.sizeBytes, sha256: bulkUpload.sha256 };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}
