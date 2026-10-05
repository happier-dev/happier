export type ChunkUploadProgress = Readonly<{ uploadedBytes: number; totalBytes: number }>;
type TransferResult = Readonly<{ success: boolean; error?: string; errorCode?: string }>;
type UploadInit = TransferResult & Readonly<{ uploadId?: string; chunkSizeBytes?: number }>;

/** One finite-upload sender; transport and encryption adapters only encode each chunk. */
export async function uploadInChunks<TInit extends UploadInit, TChunk extends TransferResult,
    TFinalize extends TransferResult, TRequest>(params: Readonly<{
    totalBytes: number;
    initialChunkIndex?: number;
    readBytes(offset: number, length: number): Promise<Uint8Array>;
    init(): Promise<TInit>;
    prepareChunk(input: Readonly<{ uploadId: string; index: number; bytes: Uint8Array; init: TInit }>): Promise<TRequest>;
    sendChunk(request: TRequest, signal?: AbortSignal | null): Promise<TChunk>;
    finalize(request: Readonly<{ uploadId: string }>, signal?: AbortSignal | null): Promise<TFinalize>;
    abort?: ((request: Readonly<{ uploadId: string }>) => Promise<unknown>) | null;
    retainUploadAfterFinalize?: (response: TFinalize) => boolean;
    onProgress?: ((progress: ChunkUploadProgress) => void) | null;
    signal?: AbortSignal | null;
}>): Promise<TFinalize | Readonly<{ success: false; error: string; errorCode?: string }>> {
    let uploadId: string | null = null;
    try {
        const init = await params.init();
        if (!init || init.success !== true) return { success: false, error: init?.error ?? 'Upload init failed',
            ...(init?.errorCode ? { errorCode: init.errorCode } : {}) };
        if (typeof init.uploadId !== 'string' || !init.uploadId.trim()) return { success: false, error: 'Upload init returned no uploadId' };
        const chunkSizeBytes = init.chunkSizeBytes;
        if (typeof chunkSizeBytes !== 'number' || !Number.isFinite(chunkSizeBytes) || chunkSizeBytes <= 0) {
            return { success: false, error: 'Upload init returned invalid chunkSizeBytes' };
        }
        const initialChunkIndex = params.initialChunkIndex ?? 0;
        if (!Number.isSafeInteger(initialChunkIndex) || initialChunkIndex < 0 || initialChunkIndex > Math.ceil(params.totalBytes / chunkSizeBytes)) {
            return { success: false, error: 'Upload resume state is invalid' };
        }
        uploadId = init.uploadId;
        let index = initialChunkIndex;
        let uploadedBytes = Math.min(params.totalBytes, initialChunkIndex * chunkSizeBytes);
        for (let offset = uploadedBytes; offset < params.totalBytes; offset += chunkSizeBytes) {
            if (params.signal?.aborted) return { success: false, error: 'Upload canceled' };
            const length = Math.min(chunkSizeBytes, params.totalBytes - offset);
            const bytes = await params.readBytes(offset, length);
            if (bytes.byteLength !== length) return { success: false, error: 'Failed to read upload chunk' };
            let request: TRequest;
            try { request = await params.prepareChunk({ uploadId, index, bytes, init }); }
            catch { return { success: false, error: 'Upload chunk encryption failed' }; }
            const chunk = params.signal ? await params.sendChunk(request, params.signal) : await params.sendChunk(request);
            if (!chunk || chunk.success !== true) return { success: false, error: chunk?.error ?? 'Upload chunk failed',
                ...(chunk?.errorCode ? { errorCode: chunk.errorCode } : {}) };
            uploadedBytes += bytes.byteLength;
            try { params.onProgress?.({ uploadedBytes, totalBytes: params.totalBytes }); } catch { /* Progress observers do not own the transfer. */ }
            index += 1;
        }
        if (params.signal?.aborted) return { success: false, error: 'Upload canceled' };
        const finalized = params.signal ? await params.finalize({ uploadId }, params.signal) : await params.finalize({ uploadId });
        if (params.retainUploadAfterFinalize?.(finalized)) { uploadId = null; return finalized; }
        if (!finalized || finalized.success !== true) return { success: false, error: finalized?.error ?? 'Upload finalize failed',
            ...(finalized?.errorCode ? { errorCode: finalized.errorCode } : {}) };
        uploadId = null;
        return finalized;
    } finally {
        if (uploadId) {
            try { await params.abort?.({ uploadId }); } catch { /* Receiver lifecycle retains abandoned temporary-file cleanup custody. */ }
        }
    }
}
