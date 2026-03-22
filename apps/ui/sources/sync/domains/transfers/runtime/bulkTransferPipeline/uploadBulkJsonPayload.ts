import { type ChunkUploadProgress } from '@/sync/domains/files/transfers/chunkTransferClient';

import { type BulkTransferFailureResponse, uploadBulkPayloadFromFile } from './uploadBulkPayloadFromFile';

type BulkTransferUploadInitSuccess = Readonly<{
    success: true;
    uploadId: string;
    chunkSizeBytes: number;
    recipientPublicKeyBase64: string;
}>;

export async function uploadBulkJsonPayload<TFinalize extends { success: boolean; error?: string }, TResponse>(params: Readonly<{
    payload: unknown;
    init: (request: Readonly<{ sizeBytes: number }>) =>
        Promise<BulkTransferUploadInitSuccess | BulkTransferFailureResponse>;
    sendChunk: (request: Readonly<{
        uploadId: string;
        index: number;
        payloadBase64: string;
        encryptedDataKeyEnvelopeBase64: string;
    }>) => Promise<{ success: boolean; error?: string }>;
    finalize: (request: Readonly<{ uploadId: string }>) => Promise<TFinalize>;
    parseResponse: (value: TFinalize) => TResponse | null;
    abort?: ((request: Readonly<{ uploadId: string }>) => Promise<unknown>) | null;
    onProgress?: ((progress: ChunkUploadProgress) => void) | null;
    signal?: AbortSignal | null;
}>): Promise<
    | Readonly<{ ok: true; response: TResponse }>
    | Readonly<{ ok: false; error: string }>
> {
    const encodedPayload = new TextEncoder().encode(JSON.stringify(params.payload));
    const upload = await uploadBulkPayloadFromFile<TFinalize>({
        fileReader: {
            sizeBytes: encodedPayload.byteLength,
            readBytes: async (offset, length) => encodedPayload.subarray(offset, offset + length),
            close: async () => {},
        },
        init: async () => await params.init({ sizeBytes: encodedPayload.byteLength }),
        sendChunk: async (request) => await params.sendChunk(request),
        finalize: async (request) => await params.finalize(request),
        abort: params.abort ?? null,
        onProgress: params.onProgress ?? null,
        signal: params.signal ?? null,
    });

    if (upload.success !== true) {
        return {
            ok: false,
            error: upload.error ?? 'Upload failed',
        };
    }

    const parsedResponse = params.parseResponse(upload);
    if (parsedResponse === null) {
        return {
            ok: false,
            error: 'Uploaded transfer payload returned an unsupported response',
        };
    }

    return {
        ok: true,
        response: parsedResponse,
    };
}
