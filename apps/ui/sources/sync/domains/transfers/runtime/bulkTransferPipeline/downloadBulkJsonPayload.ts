import { downloadBulkPayloadToFile } from './downloadBulkPayloadToFile';
import { resolveBulkTransferJsonMaxBytes } from './resolveBulkTransferJsonMaxBytes';

export async function downloadBulkJsonPayload<TPayload>(params: Readonly<{
    init: (request: Readonly<{ recipientPublicKeyBase64: string }>) =>
        Promise<
            | Readonly<{ success: true; downloadId: string; chunkSizeBytes: number; sizeBytes: number; name: string }>
            | Readonly<{ success: false; error: string; errorCode?: string }>
        >;
    readChunk: (request: Readonly<{ downloadId: string; index: number }>) =>
        Promise<
            | Readonly<{
                success: true;
                payloadBase64?: string;
                encryptedDataKeyEnvelopeBase64?: string;
                contentBase64?: string;
                isLast: boolean;
            }>
            | Readonly<{ success: false; error: string; errorCode?: string }>
        >;
    finalize: (request: Readonly<{ downloadId: string }>) =>
        Promise<Readonly<{ success: boolean; error?: string }>>;
    parsePayload: (value: unknown) => TPayload | null;
    abort?: ((request: Readonly<{ downloadId: string }>) => Promise<unknown>) | null;
    onProgress?: ((progress: Readonly<{ downloadedBytes: number; totalBytes: number }>) => void) | null;
    signal?: AbortSignal | null;
}>): Promise<
    | Readonly<{ ok: true; payload: TPayload }>
    | Readonly<{ ok: false; error: string }>
> {
    const jsonMaxBytes = resolveBulkTransferJsonMaxBytes(null);
    let receivedBytes = 0;
    let buffer: Uint8Array | null = null;
    let bufferOffset = 0;

    function ensureCapacity(requiredBytes: number): void {
        if (!buffer) {
            buffer = new Uint8Array(Math.min(jsonMaxBytes, Math.max(1, requiredBytes)));
            bufferOffset = 0;
            return;
        }

        if (requiredBytes <= buffer.byteLength) {
            return;
        }

        const nextCapacity = Math.min(
            jsonMaxBytes,
            Math.max(requiredBytes, Math.max(1, buffer.byteLength) * 2),
        );
        if (nextCapacity < requiredBytes) {
            throw new Error(`Downloaded JSON payload exceeds max allowed bytes (${jsonMaxBytes})`);
        }
        const next = new Uint8Array(nextCapacity);
        next.set(buffer.subarray(0, bufferOffset), 0);
        buffer = next;
    }

    let download: Awaited<ReturnType<typeof downloadBulkPayloadToFile>>;
    try {
        download = await downloadBulkPayloadToFile({
            destination: {
                writeBytes: async (bytes) => {
                    const nextTotal = receivedBytes + bytes.byteLength;
                    if (nextTotal > jsonMaxBytes) {
                        // Throw so the chunk reader aborts the transfer in its finally block.
                        throw new Error(`Downloaded JSON payload exceeds max allowed bytes (${jsonMaxBytes})`);
                    }
                    receivedBytes = nextTotal;
                    ensureCapacity(bufferOffset + bytes.byteLength);
                    if (!buffer) throw new Error('Downloaded transfer payload returned an unsupported response');
                    buffer.set(bytes, bufferOffset);
                    bufferOffset += bytes.byteLength;
                },
                close: async () => {},
                cleanup: async () => {
                    receivedBytes = 0;
                    buffer = null;
                    bufferOffset = 0;
                },
            },
            init: async (request) => {
                const init = await params.init(request);
                if (init.success === true && init.sizeBytes > jsonMaxBytes) {
                    return {
                        success: false as const,
                        error: `Downloaded JSON payload exceeds max allowed bytes (${jsonMaxBytes})`,
                    };
                }
                if (init.success === true) {
                    ensureCapacity(init.sizeBytes);
                }
                return init;
            },
            readChunk: async (request) => await params.readChunk(request),
            finalize: async (request) => await params.finalize(request),
            abort: params.abort ?? null,
            onProgress: params.onProgress ?? null,
            signal: params.signal ?? null,
        });
    } catch (error) {
        const message =
            error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0
                ? error.message
                : 'Downloaded transfer payload returned an unsupported response';
        receivedBytes = 0;
        buffer = null;
        bufferOffset = 0;
        return {
            ok: false,
            error: message,
        };
    }

    if (!download.ok) {
        return download;
    }

    let parsedJson: unknown;
    try {
        // Use a local const to ensure TypeScript narrows correctly even though `buffer` is
        // mutated by callbacks in the download pipeline.
        const decodeBuffer = buffer as Uint8Array | null;
        if (!decodeBuffer) {
            return {
                ok: false,
                error: 'Downloaded transfer payload returned an unsupported response',
            };
        }
        parsedJson = JSON.parse(
            new TextDecoder('utf-8', { fatal: false }).decode(decodeBuffer.subarray(0, receivedBytes)),
        );
    } catch {
        return {
            ok: false,
            error: 'Downloaded transfer payload is not valid JSON',
        };
    }

    const parsedPayload = params.parsePayload(parsedJson);
    if (parsedPayload === null) {
        return {
            ok: false,
            error: 'Downloaded transfer payload returned an unsupported response',
        };
    }

    return {
        ok: true,
        payload: parsedPayload,
    };
}
