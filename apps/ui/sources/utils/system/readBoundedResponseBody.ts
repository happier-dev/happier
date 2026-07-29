export type BoundedResponseBodyErrorCode =
    | 'aborted'
    | 'body_missing'
    | 'body_too_large'
    | 'read_failed';

export class BoundedResponseBodyError extends Error {
    readonly code: BoundedResponseBodyErrorCode;

    constructor(code: BoundedResponseBodyErrorCode) {
        super(code);
        this.name = 'BoundedResponseBodyError';
        this.code = code;
    }
}

function readDeclaredContentLength(response: Response): number | null {
    const raw = response.headers.get('content-length');
    if (raw === null || raw.trim() === '') {
        return null;
    }
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function readBoundedResponseBody(params: Readonly<{
    response: Response;
    maxBytes: number;
    signal?: AbortSignal | null;
}>): Promise<Uint8Array> {
    const maxBytes = Number.isSafeInteger(params.maxBytes) && params.maxBytes >= 0
        ? params.maxBytes
        : 0;
    const declaredContentLength = readDeclaredContentLength(params.response);
    if (declaredContentLength !== null && declaredContentLength > maxBytes) {
        await params.response.body?.cancel().catch(() => undefined);
        throw new BoundedResponseBodyError('body_too_large');
    }

    const reader = params.response.body?.getReader();
    if (!reader) {
        throw new BoundedResponseBodyError('body_missing');
    }

    let buffer = new Uint8Array(Math.min(declaredContentLength ?? 16 * 1024, maxBytes));
    let byteLength = 0;
    let completed = false;
    let aborted = params.signal?.aborted === true;
    const abortRead = () => {
        aborted = true;
        void reader.cancel(params.signal?.reason).catch(() => undefined);
    };
    params.signal?.addEventListener('abort', abortRead, { once: true });

    try {
        while (true) {
            if (aborted) {
                throw new BoundedResponseBodyError('aborted');
            }

            let next: ReadableStreamReadResult<Uint8Array>;
            try {
                next = await reader.read();
            } catch (error) {
                if (aborted) {
                    throw new BoundedResponseBodyError('aborted');
                }
                throw error;
            }
            if (aborted) {
                throw new BoundedResponseBodyError('aborted');
            }
            if (next.done) {
                completed = true;
                break;
            }
            if (next.value.byteLength === 0) {
                continue;
            }

            const nextByteLength = byteLength + next.value.byteLength;
            if (nextByteLength > maxBytes) {
                throw new BoundedResponseBodyError('body_too_large');
            }
            if (nextByteLength > buffer.byteLength) {
                let nextCapacity = Math.max(1, buffer.byteLength);
                while (nextCapacity < nextByteLength) {
                    nextCapacity = Math.min(maxBytes, nextCapacity * 2);
                    if (nextCapacity < nextByteLength && nextCapacity === maxBytes) {
                        nextCapacity = nextByteLength;
                    }
                }
                const grown = new Uint8Array(nextCapacity);
                grown.set(buffer.subarray(0, byteLength));
                buffer = grown;
            }
            buffer.set(next.value, byteLength);
            byteLength = nextByteLength;
        }
    } catch (error) {
        if (error instanceof BoundedResponseBodyError) {
            throw error;
        }
        throw new BoundedResponseBodyError(aborted ? 'aborted' : 'read_failed');
    } finally {
        params.signal?.removeEventListener('abort', abortRead);
        if (!completed) {
            await reader.cancel().catch(() => undefined);
        }
        reader.releaseLock();
    }

    return buffer.slice(0, byteLength);
}
