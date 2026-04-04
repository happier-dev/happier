import type { BulkTransferFailureResponse, BulkTransferFileReader } from './uploadBulkPayloadFromFile';
import { uploadInChunks } from './chunkTransferClient';
import {
    abortDirectImportSession,
    finalizeDirectImportSession,
    prepareDirectImportSession,
    sendDirectImportChunk,
    type DirectTransferImportFinalizeResponse,
    type DirectTransferImportOpenRequest,
} from './directTransferImportClient';

export type { DirectTransferImportOpenRequest } from './directTransferImportClient';

export async function uploadBulkPayloadFromFileViaDirectImport<TResponse>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    fileReader: BulkTransferFileReader;
    request: DirectTransferImportOpenRequest;
    parseFinalizeResponse?: ((response: Extract<DirectTransferImportFinalizeResponse, { success: true }>) => TResponse | null) | null;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<TResponse | BulkTransferFailureResponse> {
    const prepared = await prepareDirectImportSession({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        request: params.request,
    });
    if (prepared.success !== true) {
        if (prepared.error === 'Direct import endpoints unavailable') {
            return { success: false, error: 'Direct import upload unavailable' };
        }
        return prepared;
    }

    let lastFailure: BulkTransferFailureResponse | null = null;
    for (const baseUrl of prepared.session.baseUrls) {
        try {
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
                readBytes: async (offset, length) => await params.fileReader.readBytes(offset, length),
                init: async () => ({
                    success: true,
                    uploadId: prepared.session.uploadId,
                    chunkSizeBytes: prepared.session.chunkSizeBytes,
                    recipientPublicKeyBase64: prepared.session.recipientPublicKeyBase64,
                    expiresAt: prepared.session.expiresAt,
                }),
                sendChunk: async (request) =>
                    await sendDirectImportChunk({
                        baseUrl,
                        index: request.index,
                        payloadBase64: request.payloadBase64,
                        encryptedDataKeyEnvelopeBase64: request.encryptedDataKeyEnvelopeBase64,
                    }),
                finalize: async () => {
                    const finalizeResponse = await finalizeDirectImportSession(baseUrl);
                    if (finalizeResponse.success !== true) {
                        return {
                            success: false,
                            error: finalizeResponse.error ?? 'Direct import finalize failed',
                        } as BulkTransferFailureResponse;
                    }

                    const parsedResponse = params.parseFinalizeResponse?.(finalizeResponse) ?? {
                        success: true,
                        path: finalizeResponse.finalized.path,
                        sizeBytes: finalizeResponse.finalized.sizeBytes,
                        sha256: finalizeResponse.sha256,
                    } as TResponse;
                    if (parsedResponse === null) {
                        return {
                            success: false,
                            error: 'Direct import finalize returned an unsupported response',
                        } satisfies BulkTransferFailureResponse;
                    }

                    return {
                        success: true,
                        parsedResponse,
                    };
                },
                abort: async () => {
                    try {
                        await abortDirectImportSession(baseUrl);
                    } catch {
                        // Best-effort only.
                    }
                },
                onProgress: params.onProgress ?? null,
                signal: params.signal ?? null,
            });

            if (result.success === true) {
                return result.parsedResponse;
            }
            lastFailure = result;
        } catch (error) {
            lastFailure = {
                success: false,
                error: error instanceof Error ? error.message : 'Direct import upload unavailable',
            };
        }
    }

    return lastFailure ?? {
        success: false,
        error: 'Direct import upload unavailable',
    };
}
