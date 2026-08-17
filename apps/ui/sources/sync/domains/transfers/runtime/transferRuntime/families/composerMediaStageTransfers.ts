import {
    COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
    ComposerContentHandleV1Schema,
    ComposerContentInspectRequestV1Schema,
    ComposerContentInspectWireResultV1Schema,
    type ComposerContentHandleV1,
    type ComposerContentInspectRequestV1,
    type ComposerContentInspectWireResultV1,
    type ComposerContentMediaKindV1,
    type ComposerContentMimeTypeV1,
    type PluginContributionIdentityV1,
    type SessionExecutionTargetV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { TransferFileReader } from './sessionAttachmentTransfers';
import { createWorkspaceFileTransferRpcCaller } from './workspaceFileTransferRpcCaller';
import {
    type ComposerMediaStageUploadRequest,
    type DirectTransferImportFinalizeResponse,
} from '../plumbing/directTransferImportClient';
import type { TransferFinalizeRecoveryFailure } from '../plumbing/directTransferFinalizeRecovery';
import { uploadBulkPayloadFromFileWithCarrierFallbacks } from '../plumbing/uploadBulkPayloadFromFileWithCarrierFallbacks';
import { createBufferedTransferDestination } from '../carriers/createBufferedTransferDestination';
import { downloadBulkPayloadViaMachineRpcToDestination } from '../carriers/downloadBulkPayloadViaMachineRpcToDestination';

type TransferFailureResponse = Readonly<{ success: false; error: string; errorCode?: string }>;
type ComposerMediaStageUploadInitResponse =
    | Readonly<{
        success: true;
        uploadId: string;
        chunkSizeBytes: number;
        recipientPublicKeyBase64: string;
    }>
    | TransferFailureResponse;
type ComposerMediaStageUploadChunkResponse = Readonly<{ success: true }> | TransferFailureResponse;
type ComposerMediaStageUploadAbortResponse = Readonly<{ success: true }> | TransferFailureResponse;
type ComposerMediaStageUploadFinalizeResponse =
    | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string; result?: unknown }>
    | TransferFailureResponse;

export type ComposerMediaStageUploadResult = Readonly<{
    success: true;
    handle: ComposerContentHandleV1;
}>;

type ComposerMediaStageDownloadInitRequest = Readonly<{
    t: 'composer_media_stage_inspect_v1';
    handle: ComposerContentHandleV1;
    offset: number;
    maxBytes: number;
    recipientPublicKeyBase64: string;
}>;
type ComposerMediaStageDownloadInitResponse =
    | Readonly<{
        success: true;
        downloadId: string;
        chunkSizeBytes: number;
        sizeBytes: number;
        name: string;
    }>
    | TransferFailureResponse;
type ComposerMediaStageDownloadChunkResponse =
    | Readonly<{
        success: true;
        payloadBase64?: string;
        encryptedDataKeyEnvelopeBase64?: string;
        contentBase64?: string;
        isLast: boolean;
    }>
    | TransferFailureResponse;
type ComposerMediaStageDownloadFinalizeResponse = Readonly<{ success: true }> | TransferFailureResponse;
type ComposerMediaStageReleaseResponse = Readonly<{ success: true }> | TransferFailureResponse;
type ComposerMediaStageCapabilityResponse =
    | Readonly<{
        success: true;
        available: true;
        capability: typeof COMPOSER_MEDIA_CONTENT_CAPABILITY_V1;
    }>
    | TransferFailureResponse;

export type ComposerMediaContentAvailability =
    | Readonly<{
        available: true;
        capability: typeof COMPOSER_MEDIA_CONTENT_CAPABILITY_V1;
    }>
    | Readonly<{ available: false }>;

export type ComposerContentTransferResult<T> =
    | Readonly<{ success: true; result: T }>
    | TransferFailureResponse;

function transferFailure(error: string, errorCode?: string): TransferFailureResponse {
    return {
        success: false,
        error,
        ...(typeof errorCode === 'string' ? { errorCode } : {}),
    };
}

/**
 * Negotiates the exact current-daemon media operation before a picker opens.
 * Missing or malformed older-daemon responses fail closed without creating a
 * UI capability cache or a second transfer authority.
 */
export async function getComposerMediaContentAvailability(params: Readonly<{
    executionTarget: SessionExecutionTargetV1;
    signal?: AbortSignal | null;
}>): Promise<ComposerMediaContentAvailability> {
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.executionTarget.machineId,
        serverId: params.executionTarget.serverId,
    });
    const response = await transferClient.call<ComposerMediaStageCapabilityResponse, Readonly<Record<string, never>>>({
        machineMethod: RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CAPABILITY_GET_V1,
        request: {},
        signal: params.signal ?? null,
    });
    return response.success === true
        && response.available === true
        && response.capability === COMPOSER_MEDIA_CONTENT_CAPABILITY_V1
        ? { available: true, capability: COMPOSER_MEDIA_CONTENT_CAPABILITY_V1 }
        : { available: false };
}

function resolveInspectionRange(handle: ComposerContentHandleV1, request: ComposerContentInspectRequestV1): number {
    return Math.min(request.maxBytes, Math.max(0, handle.sizeBytes - request.offset));
}

function parseComposerMediaStageHandle(input: Readonly<{
    value: unknown;
    request: ComposerMediaStageUploadRequest;
}>): ComposerContentHandleV1 | null {
    const parsed = ComposerContentHandleV1Schema.safeParse(input.value);
    if (!parsed.success) return null;
    const handle = parsed.data;
    if (
        handle.executionTarget.serverId !== input.request.executionTarget.serverId
        || handle.executionTarget.machineId !== input.request.executionTarget.machineId
        || handle.owner.pluginId !== input.request.owner.pluginId
        || handle.owner.localId !== input.request.owner.localId
        || handle.mediaKind !== input.request.mediaKind
        || handle.mimeType !== input.request.mimeType
        || handle.sizeBytes !== input.request.sizeBytes
        || handle.sha256.toLowerCase() !== input.request.sha256.toLowerCase()
    ) {
        return null;
    }
    return handle;
}

function parseComposerMediaStageFinalizeResponse(input: Readonly<{
    response: Pick<Extract<DirectTransferImportFinalizeResponse, { success: true }>, 'finalized'>;
    request: ComposerMediaStageUploadRequest;
}>): ComposerMediaStageUploadResult | null {
    const handle = parseComposerMediaStageHandle({
        value: input.response.finalized.result,
        request: input.request,
    });
    return handle ? { success: true, handle } : null;
}

export async function uploadComposerMediaStageFromReader(params: Readonly<{
    fileReader: TransferFileReader;
    executionTarget: SessionExecutionTargetV1;
    owner: PluginContributionIdentityV1;
    mediaKind: ComposerContentMediaKindV1;
    mimeType: ComposerContentMimeTypeV1;
    name: string;
    sha256: string;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<
    | ComposerMediaStageUploadResult
    | TransferFailureResponse
    | TransferFinalizeRecoveryFailure<ComposerMediaStageUploadResult>
> {
    const request: ComposerMediaStageUploadRequest = {
        t: 'composer_media_stage_upload_v1',
        executionTarget: params.executionTarget,
        owner: params.owner,
        mediaKind: params.mediaKind,
        mimeType: params.mimeType,
        name: params.name,
        sizeBytes: params.fileReader.sizeBytes,
        sha256: params.sha256.trim().toLowerCase(),
    };
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: request.executionTarget.machineId,
        serverId: request.executionTarget.serverId,
    });

    return await uploadBulkPayloadFromFileWithCarrierFallbacks<ComposerMediaStageUploadResult>({
        machineId: request.executionTarget.machineId,
        serverId: request.executionTarget.serverId,
        fileReader: params.fileReader,
        directImportRequest: {
            ...request,
            workingDirectory: '/',
        },
        parseDirectFinalizeResponse: (response) => parseComposerMediaStageFinalizeResponse({
            response,
            request,
        }),
        relay: {
            init: async () => await transferClient.call<ComposerMediaStageUploadInitResponse, ComposerMediaStageUploadRequest>({
                machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
                request,
            }),
            sendChunk: async (chunk) => await transferClient.call<ComposerMediaStageUploadChunkResponse, typeof chunk>({
                machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
                request: chunk,
            }),
            finalize: async (finalize) => {
                const response = await transferClient.call<ComposerMediaStageUploadFinalizeResponse, typeof finalize>({
                    machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
                    request: finalize,
                });
                if (!response.success) return response;
                const handle = parseComposerMediaStageHandle({ value: response.result, request });
                return handle
                    ? { success: true, handle }
                    : { success: false, error: 'Composer media stage finalized with an invalid handle' };
            },
            abort: async (abort) => await transferClient.call<ComposerMediaStageUploadAbortResponse, typeof abort>({
                machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
                request: abort,
            }),
        },
        signal: params.signal ?? null,
        onProgress: params.onProgress ?? null,
    });
}

/**
 * Reads a bounded opaque stage range through the incumbent encrypted download
 * carrier. The UI retains no stage path, bytes cache, or transfer identity.
 */
export async function inspectComposerContent(
    rawHandle: ComposerContentHandleV1,
    rawRequest: ComposerContentInspectRequestV1,
    options?: Readonly<{ signal?: AbortSignal | null }>,
): Promise<ComposerContentTransferResult<ComposerContentInspectWireResultV1>> {
    const handle = ComposerContentHandleV1Schema.safeParse(rawHandle);
    const request = ComposerContentInspectRequestV1Schema.safeParse(rawRequest);
    if (!handle.success || !request.success) return transferFailure('Invalid Composer media inspection request');

    const expectedSizeBytes = resolveInspectionRange(handle.data, request.data);
    const buffered = createBufferedTransferDestination(request.data.maxBytes);
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: handle.data.executionTarget.machineId,
        serverId: handle.data.executionTarget.serverId,
    });
    const transfer = await downloadBulkPayloadViaMachineRpcToDestination({
        destination: buffered.destination,
        init: async ({ recipientPublicKeyBase64 }) => await transferClient.call<
            ComposerMediaStageDownloadInitResponse,
            ComposerMediaStageDownloadInitRequest
        >({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
            request: {
                t: 'composer_media_stage_inspect_v1',
                handle: handle.data,
                offset: request.data.offset,
                maxBytes: request.data.maxBytes,
                recipientPublicKeyBase64,
            },
            signal: options?.signal ?? null,
        }),
        readChunk: async (chunk) => await transferClient.call<
            ComposerMediaStageDownloadChunkResponse,
            typeof chunk
        >({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
            request: chunk,
            signal: options?.signal ?? null,
        }),
        finalize: async (finalize) => await transferClient.call<
            ComposerMediaStageDownloadFinalizeResponse,
            typeof finalize
        >({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE,
            request: finalize,
            signal: options?.signal ?? null,
        }),
        abort: async (abort) => await transferClient.call<ComposerMediaStageDownloadFinalizeResponse, typeof abort>({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
            request: abort,
            signal: options?.signal ?? null,
        }),
        onInit: async (init) => (
            init.name === handle.data.name && init.sizeBytes === expectedSizeBytes
                ? undefined
                : transferFailure('Composer media inspection returned an invalid range')
        ),
        signal: options?.signal ?? null,
    });
    if (!transfer.ok) return transferFailure(transfer.error, transfer.errorCode);
    if (options?.signal?.aborted) {
        buffered.reset();
        return transferFailure('Composer media inspection canceled');
    }

    const result = ComposerContentInspectWireResultV1Schema.safeParse({
        offset: request.data.offset,
        bytesBase64: buffered.toBase64(),
        eof: request.data.offset + transfer.sizeBytes >= handle.data.sizeBytes,
    });
    if (!result.success) {
        buffered.reset();
        return transferFailure('Composer media inspection returned an invalid range');
    }
    return { success: true, result: result.data };
}

/** Idempotent completed-stage release for post-transaction draft cleanup. */
export async function releaseComposerContent(
    rawHandle: ComposerContentHandleV1,
    options?: Readonly<{ signal?: AbortSignal | null }>,
): Promise<Readonly<{ success: true }> | TransferFailureResponse> {
    const handle = ComposerContentHandleV1Schema.safeParse(rawHandle);
    if (!handle.success) return transferFailure('Invalid Composer media release request');
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: handle.data.executionTarget.machineId,
        serverId: handle.data.executionTarget.serverId,
    });
    return await transferClient.call<ComposerMediaStageReleaseResponse, Readonly<{ handle: ComposerContentHandleV1 }>>({
        machineMethod: RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE,
        request: { handle: handle.data },
        signal: options?.signal ?? null,
    });
}
