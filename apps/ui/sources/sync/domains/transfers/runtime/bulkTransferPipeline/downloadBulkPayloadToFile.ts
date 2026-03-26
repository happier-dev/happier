import { type ChunkDownloadProgress, downloadInChunks } from './chunkTransferClient';
import { createTransferRecipientKeyPair } from './transferChunkEncryption';

type BulkTransferFailureResponse = Readonly<{
    success: false;
    error: string;
    errorCode?: string;
}>;

export type BulkTransferFileDestination = Readonly<{
    writeBytes: (bytes: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
    cleanup?: (() => Promise<void>) | null;
}>;

type BulkTransferDownloadInitSuccess = Readonly<{
    success: true;
    downloadId: string;
    chunkSizeBytes: number;
    sizeBytes: number;
    name: string;
}>;

type BulkTransferDownloadChunkSuccess = Readonly<{
    success: true;
    payloadBase64?: string;
    encryptedDataKeyEnvelopeBase64?: string;
    contentBase64?: string;
    isLast: boolean;
}>;

type BulkTransferDownloadChunkResponse = BulkTransferDownloadChunkSuccess | BulkTransferFailureResponse;
type BulkTransferDownloadInitResponse = BulkTransferDownloadInitSuccess | BulkTransferFailureResponse;

type BulkTransferDownloadFinalizeResponse = Readonly<{
    success: boolean;
    error?: string;
}>;

async function cleanupFailedDestination(destination: BulkTransferFileDestination): Promise<void> {
    if (destination.cleanup) {
        await destination.cleanup();
        return;
    }

    await destination.close();
}

export async function downloadBulkPayloadToFile(params: Readonly<{
    destination: BulkTransferFileDestination;
    init: (request: Readonly<{ recipientPublicKeyBase64: string }>) =>
        Promise<BulkTransferDownloadInitResponse>;
    readChunk: (request: Readonly<{ downloadId: string; index: number }>) =>
        Promise<BulkTransferDownloadChunkResponse>;
    finalize: (request: Readonly<{ downloadId: string }>) => Promise<BulkTransferDownloadFinalizeResponse>;
    abort?: ((request: Readonly<{ downloadId: string }>) => Promise<unknown>) | null;
    onProgress?: ((progress: ChunkDownloadProgress) => void) | null;
    signal?: AbortSignal | null;
}>): Promise<
    | Readonly<{ ok: true; name: string; sizeBytes: number }>
    | Readonly<{ ok: false; error: string }>
> {
    const recipientKeyPair = createTransferRecipientKeyPair();
    const init = await params.init({
        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
    });

    if (init.success !== true) {
        await cleanupFailedDestination(params.destination);
        return {
            ok: false,
            error: init.error,
        };
    }

    const download = await downloadInChunks<
        BulkTransferDownloadInitResponse,
        BulkTransferDownloadChunkResponse,
        BulkTransferDownloadFinalizeResponse
    >({
        init: async () => init,
        readChunk: async (request) => await params.readChunk(request),
        finalize: async (request) => await params.finalize(request),
        abort: params.abort ?? null,
        recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
        writeBytes: async (bytes) => await params.destination.writeBytes(bytes),
        onProgress: params.onProgress ?? null,
        signal: params.signal ?? null,
    });

    if (!download.ok) {
        await cleanupFailedDestination(params.destination);
        return download;
    }

    await params.destination.close();
    return {
        ok: true,
        name: init.name,
        sizeBytes: download.sizeBytes,
    };
}
