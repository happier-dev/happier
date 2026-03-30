import {
    createEncryptedTransferChunkEnvelope,
    decryptEncryptedTransferChunkEnvelope,
} from './transferChunkEncryption';
import { decodeBase64 } from '@/encryption/base64';

export type ChunkUploadProgress = Readonly<{
    uploadedBytes: number;
    totalBytes: number;
}>;

export async function uploadInChunks<
    TInit extends {
        success: boolean;
        uploadId?: string;
        chunkSizeBytes?: number;
        recipientPublicKeyBase64?: string;
        error?: string;
    },
    TChunk extends { success: boolean; error?: string },
    TFinalize extends { success: boolean; error?: string },
>(params: Readonly<{
    totalBytes: number;
    readBytes: (offset: number, length: number) => Promise<Uint8Array>;
    init: () => Promise<TInit>;
    sendChunk: (request: Readonly<{
        uploadId: string;
        index: number;
        payloadBase64: string;
        encryptedDataKeyEnvelopeBase64: string;
    }>) => Promise<TChunk>;
    finalize: (request: Readonly<{ uploadId: string }>) => Promise<TFinalize>;
    abort?: ((request: Readonly<{ uploadId: string }>) => Promise<unknown>) | null;
    onProgress?: ((progress: ChunkUploadProgress) => void) | null;
    signal?: AbortSignal | null;
}>): Promise<TFinalize | { success: false; error: string }> {
    let uploadId: string | null = null;

    try {
        const init = await params.init();
        if (!init || typeof init !== 'object' || init.success !== true) {
            const error = typeof (init as any)?.error === 'string' ? (init as any).error : 'Upload init failed';
            return { success: false, error };
        }

        const initUploadId = (init as any)?.uploadId;
        const chunkSizeBytes = (init as any)?.chunkSizeBytes;
        const recipientPublicKeyBase64 = (init as any)?.recipientPublicKeyBase64;
        if (typeof initUploadId !== 'string' || !initUploadId.trim()) {
            return { success: false, error: 'Upload init returned no uploadId' };
        }
        if (typeof chunkSizeBytes !== 'number' || !Number.isFinite(chunkSizeBytes) || chunkSizeBytes <= 0) {
            return { success: false, error: 'Upload init returned invalid chunkSizeBytes' };
        }
        if (typeof recipientPublicKeyBase64 !== 'string' || !recipientPublicKeyBase64.trim()) {
            return { success: false, error: 'Upload init returned no recipientPublicKeyBase64' };
        }

        uploadId = initUploadId;
        const emitProgress = (uploadedBytes: number) => {
            if (!params.onProgress) return;
            try {
                params.onProgress({ uploadedBytes, totalBytes: params.totalBytes });
            } catch {
                // ignore
            }
        };

        let index = 0;
        let uploadedBytes = 0;
        for (let offset = 0; offset < params.totalBytes; offset += chunkSizeBytes) {
            if (params.signal?.aborted) {
                return { success: false, error: 'Upload canceled' };
            }

            const length = Math.min(chunkSizeBytes, params.totalBytes - offset);
            const chunkBytes = await params.readBytes(offset, length);
            if (chunkBytes.byteLength !== length) {
                return { success: false, error: 'Failed to read upload chunk' };
            }
            let encryptedChunk: Awaited<ReturnType<typeof createEncryptedTransferChunkEnvelope>>;
            try {
                encryptedChunk = await createEncryptedTransferChunkEnvelope({
                    transferId: uploadId,
                    sequence: index,
                    payload: chunkBytes,
                    recipientPublicKeyBase64,
                });
            } catch {
                return { success: false, error: 'Upload chunk encryption failed' };
            }

            const chunk = await params.sendChunk({
                uploadId,
                index,
                payloadBase64: encryptedChunk.payloadBase64,
                encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
            });
            if (!chunk || typeof chunk !== 'object' || (chunk as any).success !== true) {
                const error = typeof (chunk as any)?.error === 'string' ? (chunk as any).error : 'Upload chunk failed';
                return { success: false, error };
            }

            uploadedBytes += chunkBytes.byteLength;
            emitProgress(uploadedBytes);
            index += 1;
        }

        const finalized = await params.finalize({ uploadId });
        if (!finalized || typeof finalized !== 'object' || (finalized as any).success !== true) {
            const error = typeof (finalized as any)?.error === 'string' ? (finalized as any).error : 'Upload finalize failed';
            return { success: false, error };
        }

        uploadId = null;
        return finalized;
    } finally {
        if (uploadId) {
            try {
                await params.abort?.({ uploadId });
            } catch {
                // Best-effort only.
            }
        }
    }
}

export type ChunkDownloadProgress = Readonly<{
    downloadedBytes: number;
    totalBytes: number;
}>;

export async function downloadInChunks<
    TInit extends { success: boolean; downloadId?: string; chunkSizeBytes?: number; sizeBytes?: number; error?: string },
    TChunk extends {
        success: boolean;
        contentBase64?: string;
        payloadBase64?: string;
        encryptedDataKeyEnvelopeBase64?: string;
        isLast?: boolean;
        error?: string;
    },
    TFinalize extends { success: boolean; error?: string },
>(params: Readonly<{
    init: () => Promise<TInit>;
    readChunk: (request: Readonly<{ downloadId: string; index: number }>) => Promise<TChunk>;
    finalize: (request: Readonly<{ downloadId: string }>) => Promise<TFinalize>;
    abort?: ((request: Readonly<{ downloadId: string }>) => Promise<unknown>) | null;
    recipientSecretKeySeed?: Uint8Array | null;
    writeBytes: (bytes: Uint8Array) => Promise<void>;
    onProgress?: ((progress: ChunkDownloadProgress) => void) | null;
    signal?: AbortSignal | null;
}>): Promise<{ ok: true; sizeBytes: number } | { ok: false; error: string }> {
    let downloadId: string | null = null;

    try {
        const init = await params.init();
        if (!init || typeof init !== 'object' || (init as any).success !== true) {
            const error = typeof (init as any)?.error === 'string' ? (init as any).error : 'Download init failed';
            return { ok: false, error };
        }

        const initDownloadId = (init as any)?.downloadId;
        const totalBytes = (init as any)?.sizeBytes;
        if (typeof initDownloadId !== 'string' || !initDownloadId.trim()) {
            return { ok: false, error: 'Download init returned no downloadId' };
        }
        if (typeof totalBytes !== 'number' || !Number.isFinite(totalBytes) || totalBytes < 0) {
            return { ok: false, error: 'Download init returned invalid sizeBytes' };
        }

        downloadId = initDownloadId;
        const emitProgress = (downloadedBytes: number) => {
            if (!params.onProgress) return;
            try {
                params.onProgress({ downloadedBytes, totalBytes });
            } catch {
                // ignore
            }
        };

        let index = 0;
        let downloadedBytes = 0;
        while (true) {
            if (params.signal?.aborted) {
                return { ok: false, error: 'Download canceled' };
            }

            const chunk = await params.readChunk({ downloadId, index });
            if (!chunk || typeof chunk !== 'object' || (chunk as any).success !== true) {
                const error = typeof (chunk as any)?.error === 'string' ? (chunk as any).error : 'Download chunk failed';
                return { ok: false, error };
            }

            const payloadBase64 = typeof (chunk as any).payloadBase64 === 'string' ? (chunk as any).payloadBase64 : '';
            const encryptedDataKeyEnvelopeBase64 = typeof (chunk as any).encryptedDataKeyEnvelopeBase64 === 'string'
                ? (chunk as any).encryptedDataKeyEnvelopeBase64
                : '';
            const contentBase64 = typeof (chunk as any).contentBase64 === 'string' ? (chunk as any).contentBase64 : '';
            if (payloadBase64) {
                if (!params.recipientSecretKeySeed) {
                    return { ok: false, error: 'Download chunk decryption key is unavailable' };
                }
                let bytes: Uint8Array;
                try {
                    bytes = await decryptEncryptedTransferChunkEnvelope({
                        transferId: downloadId,
                        sequence: index,
                        payloadBase64,
                        encryptedDataKeyEnvelopeBase64,
                        recipientSecretKeySeed: params.recipientSecretKeySeed,
                    });
                } catch {
                    return { ok: false, error: 'Download chunk decryption failed' };
                }
                await params.writeBytes(bytes);
                downloadedBytes += bytes.byteLength;
                emitProgress(downloadedBytes);
            } else if (contentBase64) {
                let bytes: Uint8Array;
                try {
                    bytes = decodeBase64(contentBase64, 'base64');
                } catch {
                    return { ok: false, error: 'Download chunk decode failed' };
                }
                await params.writeBytes(bytes);
                downloadedBytes += bytes.byteLength;
                emitProgress(downloadedBytes);
            }

            const isLast = Boolean((chunk as any).isLast);
            if (!payloadBase64 && !contentBase64 && !isLast) {
                return { ok: false, error: 'Download chunk returned no content' };
            }
            if (isLast) {
                break;
            }
            index += 1;
        }

        if (downloadedBytes !== totalBytes) {
            return { ok: false, error: 'Downloaded size did not match expected size' };
        }

        const finalized = await params.finalize({ downloadId });
        if (!finalized || typeof finalized !== 'object' || (finalized as any).success !== true) {
            const error = typeof (finalized as any)?.error === 'string' ? (finalized as any).error : 'Download finalize failed';
            return { ok: false, error };
        }

        downloadId = null;
        return { ok: true, sizeBytes: totalBytes };
    } finally {
        if (downloadId) {
            try {
                await params.abort?.({ downloadId });
            } catch {
                // Best-effort only.
            }
        }
    }
}
