import { PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1 } from "@happier-dev/protocol";

export class WebhookRawBodyReadError extends Error {
    constructor(readonly code: "tooLarge" | "lengthMismatch" | "streamFailed" | "aborted") {
        super("Webhook request body stream failed");
        this.name = "WebhookRawBodyReadError";
    }
}

export function readWebhookDeclaredContentLengthV1(value: unknown):
    | Readonly<{ ok: true; bytes: number }>
    | Readonly<{ ok: false; code: "missing" | "invalid" | "tooLarge" }> {
    if (value === undefined) return { ok: false, code: "missing" };
    if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) return { ok: false, code: "invalid" };

    let parsed: bigint;
    try {
        parsed = BigInt(value);
    } catch {
        return { ok: false, code: "invalid" };
    }
    if (parsed > BigInt(PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1)) return { ok: false, code: "tooLarge" };
    return { ok: true, bytes: Number(parsed) };
}

async function readNextWebhookRawBodyChunkV1(
    iterator: AsyncIterator<Uint8Array>,
    signal: AbortSignal | undefined,
): Promise<IteratorResult<Uint8Array>> {
    if (!signal) return await iterator.next();
    if (signal.aborted) throw new WebhookRawBodyReadError("aborted");

    const next = iterator.next();
    return await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
        const onAbort = () => reject(new WebhookRawBodyReadError("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        void next.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

export async function readWebhookRawBodyV1(params: {
    body: AsyncIterable<Uint8Array>;
    declaredBytes: number;
    signal?: AbortSignal;
    onChunk?: (chunk: Uint8Array) => void;
}): Promise<Uint8Array> {
    if (!Number.isSafeInteger(params.declaredBytes) || params.declaredBytes < 0) {
        throw new WebhookRawBodyReadError("lengthMismatch");
    }
    if (params.declaredBytes > PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1) {
        throw new WebhookRawBodyReadError("tooLarge");
    }
    if (params.signal?.aborted) throw new WebhookRawBodyReadError("aborted");

    const iterator = params.body[Symbol.asyncIterator]();
    let body: Uint8Array | null = new Uint8Array(params.declaredBytes);
    let offset = 0;
    let streamCompleted = false;
    try {
        while (true) {
            if (params.signal?.aborted) throw new WebhookRawBodyReadError("aborted");
            const next = await readNextWebhookRawBodyChunkV1(iterator, params.signal);
            if (next.done) {
                streamCompleted = true;
                break;
            }
            const chunk = next.value;
            if (!(chunk instanceof Uint8Array)) throw new WebhookRawBodyReadError("streamFailed");
            if (offset + chunk.byteLength > params.declaredBytes) {
                throw new WebhookRawBodyReadError("lengthMismatch");
            }
            params.onChunk?.(chunk);
            body.set(chunk, offset);
            offset += chunk.byteLength;
        }
        if (offset !== params.declaredBytes) throw new WebhookRawBodyReadError("lengthMismatch");
        const completed = body;
        body = null;
        return completed;
    } catch (error) {
        body = null;
        if (error instanceof WebhookRawBodyReadError) throw error;
        throw new WebhookRawBodyReadError("streamFailed");
    } finally {
        if (!streamCompleted) {
            try {
                const closing = iterator.return?.();
                void closing?.catch(() => undefined);
            } catch {
                // The bounded public error above remains authoritative; body/transport details are secret-free.
            }
        }
    }
}
