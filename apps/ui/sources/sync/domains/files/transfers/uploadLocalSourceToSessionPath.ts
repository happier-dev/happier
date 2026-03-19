import {
    createSessionFilesUploadTransferClient,
    type FilesUploadFinalizeResponse,
} from './sessionPathTransferRpc';

import { type ChunkUploadProgress, uploadInChunks } from './chunkTransferClient';
import { openLocalUploadSourceReader, type LocalUploadSource } from './localUploadSourceReader';

export async function uploadLocalSourceToSessionPath(params: Readonly<{
    sessionId: string;
    source: LocalUploadSource;
    targetPath: string;
    sizeBytes: number;
    overwrite: boolean;
    signal?: AbortSignal | null;
    onProgress?: ((progress: ChunkUploadProgress) => void) | null;
}>): Promise<FilesUploadFinalizeResponse> {
    const reader = await openLocalUploadSourceReader(params.source);

    try {
        const transferClient = createSessionFilesUploadTransferClient({
            sessionId: params.sessionId,
            sizeBytes: params.sizeBytes,
        });

        const init = await transferClient.init({
            path: params.targetPath,
            sizeBytes: params.sizeBytes,
            overwrite: params.overwrite,
        });
        if (!init.success) {
            return init;
        }

        return await uploadInChunks({
            totalBytes: params.sizeBytes,
            readBytes: async (offset, length) => await reader.readBytes(offset, length),
            init: async () => init,
            sendChunk: async ({ uploadId, index, payloadBase64, encryptedDataKeyEnvelopeBase64 }) =>
                await transferClient.chunk({
                    uploadId,
                    index,
                    payloadBase64,
                    encryptedDataKeyEnvelopeBase64,
                }),
            finalize: async ({ uploadId }) => await transferClient.finalize({ uploadId }),
            abort: async ({ uploadId }) => await transferClient.abort({ uploadId }),
            signal: params.signal ?? null,
            onProgress: params.onProgress ?? null,
        });
    } finally {
        await reader.close();
    }
}
