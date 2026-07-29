import type { BulkTransferFailureResponse, BulkTransferFileReader } from './uploadBulkPayloadFromFile';
import { uploadInChunks } from './chunkTransferClient';
import {
    createDirectTransferFinalizeRecovery,
    type TransferFinalizeRecoveryFailure,
} from './directTransferFinalizeRecovery';
import {
    abortOwnedDirectImportSession,
    DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE_ERROR_CODE,
    DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE,
    finalizeDirectImportSession,
    prepareDirectImportSession,
    sendDirectImportChunk,
    TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE,
    type DirectTransferImportFinalizeResponse,
    type DirectTransferImportOpenRequest,
} from './directTransferImportClient';

export type { DirectTransferImportOpenRequest } from './directTransferImportClient';
export type {
    TransferFinalizeRecoveryAction,
    TransferFinalizeRecoveryActionResult,
    TransferFinalizeRecoveryContinuation,
    TransferFinalizeRecoveryFailure,
} from './directTransferFinalizeRecovery';

export async function uploadBulkPayloadFromFileViaDirectImport<TResponse>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    fileReader: BulkTransferFileReader;
    request: DirectTransferImportOpenRequest;
    parseFinalizeResponse?: ((response: Extract<DirectTransferImportFinalizeResponse, { success: true }>) => TResponse | null) | null;
    timeoutMs?: number | null;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<TResponse | BulkTransferFailureResponse | TransferFinalizeRecoveryFailure<TResponse>> {
    const prepared = await prepareDirectImportSession({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        request: params.request,
        timeoutMs: params.timeoutMs ?? null,
        signal: params.signal ?? null,
    });
    if (prepared.success !== true) {
        if (prepared.error === 'Direct import endpoints unavailable') {
            return { success: false, error: 'Direct import upload unavailable' };
        }
        return prepared;
    }

    let lastFailure: BulkTransferFailureResponse | null = null;
    let didFinalizeSession = false;
    let nextChunkIndex = 0;
    try {
        for (const baseUrl of prepared.session.baseUrls) {
            try {
                let finalizeRecoveryFailure: TransferFinalizeRecoveryFailure<TResponse> | null = null;
                const result = await uploadInChunks<
                    Readonly<{
                        success: true;
                        uploadId: string;
                        chunkSizeBytes: number;
                        recipientPublicKeyBase64: string;
                        expiresAt: number;
                    }>,
                    Readonly<{ success: boolean; error?: string }>,
                    Readonly<{ success: true; parsedResponse: TResponse }> | BulkTransferFailureResponse
                >({
                    totalBytes: params.fileReader.sizeBytes,
                    initialChunkIndex: nextChunkIndex,
                    readBytes: async (offset, length) => await params.fileReader.readBytes(offset, length),
                    init: async () => ({
                        success: true,
                        uploadId: prepared.session.uploadId,
                        chunkSizeBytes: prepared.session.chunkSizeBytes,
                        recipientPublicKeyBase64: prepared.session.recipientPublicKeyBase64,
                        expiresAt: prepared.session.expiresAt,
                    }),
                    sendChunk: async (request) => {
                        const response = await sendDirectImportChunk({
                            baseUrl,
                            index: request.index,
                            payloadBase64: request.payloadBase64,
                            encryptedDataKeyEnvelopeBase64: request.encryptedDataKeyEnvelopeBase64,
                            timeoutMs: params.timeoutMs ?? null,
                            signal: params.signal ?? null,
                        });
                        if (response.success === true) {
                            nextChunkIndex = request.index + 1;
                        }
                        return response;
                    },
                    finalize: async () => {
                        const finalizeResponse = await finalizeDirectImportSession({
                            baseUrl,
                            timeoutMs: params.timeoutMs ?? null,
                            signal: params.signal ?? null,
                        });
                        if (finalizeResponse.success !== true) {
                            if (
                                finalizeResponse.errorCode
                                === DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE
                            ) {
                                didFinalizeSession = true;
                            }
                            if (
                                finalizeResponse.errorCode
                                === TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE
                                && finalizeResponse.keepSession === true
                            ) {
                                const parseFinalizeResponse = (
                                    response: Extract<DirectTransferImportFinalizeResponse, { success: true }>,
                                ): TResponse | null => {
                                    if (params.parseFinalizeResponse) {
                                        return params.parseFinalizeResponse(response);
                                    }
                                    return {
                                        success: true,
                                        path: response.finalized.path,
                                        sizeBytes: response.finalized.sizeBytes,
                                        sha256: response.sha256,
                                    } as TResponse;
                                };
                                finalizeRecoveryFailure = {
                                    success: false,
                                    error: finalizeResponse.error,
                                    errorCode: TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE,
                                    recovery: createDirectTransferFinalizeRecovery({
                                        machineId: params.machineId,
                                        ...(typeof params.serverId === 'string'
                                            ? { serverId: params.serverId }
                                            : {}),
                                        uploadId: prepared.session.uploadId,
                                        baseUrl,
                                        expiresAt: finalizeResponse.expiresAt
                                            ?? prepared.session.expiresAt,
                                        timeoutMs: params.timeoutMs ?? null,
                                        parseFinalizeResponse,
                                    }),
                                } satisfies TransferFinalizeRecoveryFailure<TResponse>;
                                return finalizeRecoveryFailure;
                            }
                            return {
                                success: false,
                                error: finalizeResponse.error ?? 'Direct import finalize failed',
                                ...(typeof finalizeResponse.errorCode === 'string'
                                    ? { errorCode: finalizeResponse.errorCode }
                                    : {}),
                            } as BulkTransferFailureResponse;
                        }
                        didFinalizeSession = true;

                        let parsedResponse: TResponse | null;
                        try {
                            parsedResponse = params.parseFinalizeResponse
                                ? params.parseFinalizeResponse(finalizeResponse)
                                : {
                                    success: true,
                                    path: finalizeResponse.finalized.path,
                                    sizeBytes: finalizeResponse.finalized.sizeBytes,
                                    sha256: finalizeResponse.sha256,
                                } as TResponse;
                        } catch {
                            parsedResponse = null;
                        }
                        if (parsedResponse === null) {
                            return {
                                success: false,
                                error: 'Direct import finalize committed but returned an unusable result',
                                errorCode: DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE,
                            } satisfies BulkTransferFailureResponse;
                        }

                        return {
                            success: true,
                            parsedResponse,
                        };
                    },
                    onProgress: params.onProgress ?? null,
                    signal: params.signal ?? null,
                });

                if (result.success === true) {
                    return result.parsedResponse;
                }
                if (
                    result.errorCode === TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE
                    && finalizeRecoveryFailure
                ) {
                    return finalizeRecoveryFailure;
                }
                lastFailure = result;
                if (
                    result.errorCode
                    === DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE
                    || result.errorCode
                    === TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE
                ) {
                    return result;
                }
                if (
                    result.errorCode
                    === DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE_ERROR_CODE
                ) {
                    break;
                }
                if (params.signal?.aborted) {
                    break;
                }
            } catch (error) {
                lastFailure = {
                    success: false,
                    error: error instanceof Error ? error.message : 'Direct import upload unavailable',
                };
                if (params.signal?.aborted) {
                    break;
                }
            }
        }

        lastFailure ??= {
            success: false,
            error: 'Direct import upload unavailable',
        };
    } catch (error) {
        lastFailure = {
            success: false,
            error: error instanceof Error ? error.message : 'Direct import upload unavailable',
        };
    }

    if (!didFinalizeSession) {
        const cleanupFailure = await abortOwnedDirectImportSession({
            machineId: params.machineId,
            ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
            uploadId: prepared.session.uploadId,
            timeoutMs: params.timeoutMs ?? null,
        });
        if (cleanupFailure) {
            return cleanupFailure;
        }
    }

    return lastFailure ?? {
        success: false,
        error: 'Direct import upload unavailable',
    };
}
