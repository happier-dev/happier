import { downloadBulkPayloadViaMachineRpcToDestination } from './downloadBulkPayloadViaMachineRpcToDestination';

function parseOptionalPositiveInt(value: unknown): number | undefined {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return undefined;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return undefined;
    }

    const normalized = Math.floor(parsed);
    return normalized > 0 ? normalized : undefined;
}

// Keep parity with the existing UI-side file preview ceiling until the app-level
// config promotes a dedicated bulk JSON budget.
const DEFAULT_BULK_TRANSFER_JSON_MAX_BYTES = 2_500_000;
const BULK_TRANSFER_JSON_HARD_MAX_BYTES = 10_000_000;

function resolveBulkTransferJsonMaxBytes(maxBytes?: number | null): number {
    const resolved = (
        parseOptionalPositiveInt(maxBytes)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPY_BULK_TRANSFER_JSON_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_BULK_TRANSFER_JSON_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPIER_FILES_PREVIEW_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPY_FILES_PREVIEW_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_FILES_PREVIEW_MAX_BYTES)
        ?? DEFAULT_BULK_TRANSFER_JSON_MAX_BYTES
    );
    return Math.min(resolved, BULK_TRANSFER_JSON_HARD_MAX_BYTES);
}

export async function downloadBulkJsonPayloadViaMachineRpc<TPayload>(params: Readonly<{
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
    | Readonly<{ ok: false; error: string; errorCode?: string }>
> {
    const jsonMaxBytes = resolveBulkTransferJsonMaxBytes(null);
    let receivedBytes = 0;
    let buffer: Uint8Array | null = null;
    let bufferOffset = 0;

    function ensureCapacity(requiredBytes: number): void {
        if (buffer === null) {
            buffer = new Uint8Array(Math.min(jsonMaxBytes, Math.max(1, requiredBytes)));
            bufferOffset = 0;
            return;
        }

        const currentBuffer = buffer;
        if (requiredBytes <= currentBuffer.byteLength) {
            return;
        }

        const nextCapacity = Math.min(
            jsonMaxBytes,
            Math.max(requiredBytes, Math.max(1, currentBuffer.byteLength) * 2),
        );
        if (nextCapacity < requiredBytes) {
            throw new Error(`Downloaded JSON payload exceeds max allowed bytes (${jsonMaxBytes})`);
        }
        const next = new Uint8Array(nextCapacity);
        next.set(currentBuffer.subarray(0, bufferOffset), 0);
        buffer = next;
    }

    function readBufferedPayloadBytes(): Uint8Array | null {
        if (buffer === null) {
            return null;
        }

        return buffer.subarray(0, receivedBytes);
    }

    const download = await downloadBulkPayloadViaMachineRpcToDestination({
        destination: {
            writeBytes: async (bytes) => {
                const nextTotal = receivedBytes + bytes.byteLength;
                if (nextTotal > jsonMaxBytes) {
                    throw new Error(`Downloaded JSON payload exceeds max allowed bytes (${jsonMaxBytes})`);
                }
                receivedBytes = nextTotal;
                ensureCapacity(bufferOffset + bytes.byteLength);
                if (buffer === null) {
                    throw new Error('Downloaded transfer payload returned an unsupported response');
                }
                const writeBuffer = buffer;
                writeBuffer.set(bytes, bufferOffset);
                bufferOffset += bytes.byteLength;
            },
            close: async () => {},
            cleanup: async () => {
                receivedBytes = 0;
                buffer = null;
                bufferOffset = 0;
            },
        },
        init: async (request) => await params.init(request),
        readChunk: async (request) => await params.readChunk(request),
        finalize: async (request) => await params.finalize(request),
        abort: params.abort ?? null,
        onInit: async (init) => {
            if (init.sizeBytes > jsonMaxBytes) {
                return {
                    success: false as const,
                    error: `Downloaded JSON payload exceeds max allowed bytes (${jsonMaxBytes})`,
                };
            }
            ensureCapacity(init.sizeBytes);
        },
        onProgress: params.onProgress ?? null,
        signal: params.signal ?? null,
    });

    if (!download.ok) {
        return download;
    }

    let parsedJson: unknown;
    try {
        const decodeBuffer = readBufferedPayloadBytes();
        if (!decodeBuffer) {
            return {
                ok: false,
                error: 'Downloaded transfer payload returned an unsupported response',
            };
        }
        parsedJson = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(decodeBuffer));
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
