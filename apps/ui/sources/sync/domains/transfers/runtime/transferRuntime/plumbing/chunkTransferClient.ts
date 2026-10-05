import { uploadInChunks as uploadFiniteChunks } from "@happier-dev/transfers";
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
        errorCode?: string;
    },
    TChunk extends { success: boolean; error?: string; errorCode?: string },
    TFinalize extends { success: boolean; error?: string; errorCode?: string },
>(params: Readonly<{
    totalBytes: number;
    initialChunkIndex?: number;
    readBytes: (offset: number, length: number) => Promise<Uint8Array>;
    init: () => Promise<TInit>;
    sendChunk: (request: Readonly<{
        uploadId: string;
        index: number;
        payloadBase64: string;
        encryptedDataKeyEnvelopeBase64: string;
    }>, signal?: AbortSignal | null) => Promise<TChunk>;
    finalize: (request: Readonly<{ uploadId: string }>, signal?: AbortSignal | null) => Promise<TFinalize>;
    abort?: ((request: Readonly<{ uploadId: string }>) => Promise<unknown>) | null;
    retainUploadAfterFinalize?: (response: TFinalize) => boolean;
    onProgress?: ((progress: ChunkUploadProgress) => void) | null;
    signal?: AbortSignal | null;
}>): Promise<TFinalize | { success: false; error: string; errorCode?: string }> {
    return await uploadFiniteChunks({
        ...params,
        init: async () => {
            const init = await params.init();
            if (init.success === true && (!init.recipientPublicKeyBase64 || !init.recipientPublicKeyBase64.trim())) {
                return { ...init, success: false, error: "Upload init returned no recipientPublicKeyBase64" };
            }
            return init;
        },
        prepareChunk: async ({ uploadId, index, bytes, init }) => {
            const encrypted = await createEncryptedTransferChunkEnvelope({
                transferId: uploadId, sequence: index, payload: bytes,
                recipientPublicKeyBase64: init.recipientPublicKeyBase64!,
            });
            return { uploadId, index, ...encrypted };
        },
    });
}

export type ChunkDownloadProgress = Readonly<{
    downloadedBytes: number;
    totalBytes: number;
}>;

export async function downloadInChunks<
    TInit extends { success: boolean; downloadId?: string; chunkSizeBytes?: number; sizeBytes?: number; error?: string; errorCode?: string },
    TChunk extends {
        success: boolean;
        contentBase64?: string;
        payloadBase64?: string;
        encryptedDataKeyEnvelopeBase64?: string;
        isLast?: boolean;
        error?: string;
        errorCode?: string;
    },
    TFinalize extends { success: boolean; error?: string; errorCode?: string },
>(params: Readonly<{
    init: () => Promise<TInit>;
    readChunk: (request: Readonly<{ downloadId: string; index: number }>, signal?: AbortSignal | null) => Promise<TChunk>;
    finalize: (request: Readonly<{ downloadId: string }>, signal?: AbortSignal | null) => Promise<TFinalize>;
    abort?: ((request: Readonly<{ downloadId: string }>) => Promise<unknown>) | null;
    recipientSecretKeySeed?: Uint8Array | null;
    writeBytes: (bytes: Uint8Array) => Promise<void>;
    onProgress?: ((progress: ChunkDownloadProgress) => void) | null;
    signal?: AbortSignal | null;
}>): Promise<{ ok: true; sizeBytes: number } | { ok: false; error: string; errorCode?: string }> {
    let downloadId: string | null = null;

    try {
        const init = await params.init();
        if (!init || typeof init !== 'object' || (init as any).success !== true) {
            const error = typeof (init as any)?.error === 'string' ? (init as any).error : 'Download init failed';
            const errorCode = typeof (init as any)?.errorCode === 'string' ? (init as any).errorCode : undefined;
            return { ok: false, error, ...(errorCode ? { errorCode } : {}) };
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

            const chunk = params.signal
                ? await params.readChunk({ downloadId, index }, params.signal)
                : await params.readChunk({ downloadId, index });
            if (!chunk || typeof chunk !== 'object' || (chunk as any).success !== true) {
                const error = typeof (chunk as any)?.error === 'string' ? (chunk as any).error : 'Download chunk failed';
                const errorCode = typeof (chunk as any)?.errorCode === 'string' ? (chunk as any).errorCode : undefined;
                return { ok: false, error, ...(errorCode ? { errorCode } : {}) };
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

        if (params.signal?.aborted) {
            return { ok: false, error: 'Download canceled' };
        }

        const finalized = params.signal
            ? await params.finalize({ downloadId }, params.signal)
            : await params.finalize({ downloadId });
        if (!finalized || typeof finalized !== 'object' || (finalized as any).success !== true) {
            const error = typeof (finalized as any)?.error === 'string' ? (finalized as any).error : 'Download finalize failed';
            const errorCode = typeof (finalized as any)?.errorCode === 'string' ? (finalized as any).errorCode : undefined;
            return { ok: false, error, ...(errorCode ? { errorCode } : {}) };
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
