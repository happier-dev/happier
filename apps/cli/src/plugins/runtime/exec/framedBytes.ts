import type {
    ExecProcessHandleV1,
    FramedBytesClientV1,
    FramedBytesListenerV1,
} from '@happier-dev/plugin-sdk';

import {
    PluginExecClientError,
    createPluginExecClientAbortError,
} from './errors';

type ByteReadableStream = NodeJS.ReadableStream & Readonly<{
    pause?: () => unknown;
    resume?: () => unknown;
}>;

export type CreateFramedBytesProcessClientParams = Readonly<{
    process: ExecProcessHandleV1;
    stdout: NodeJS.ReadableStream;
    write: (input: Uint8Array) => Promise<void>;
    maxFrameBytes?: number;
    readStderrPreview?: () => string;
}>;

export type FramedBytesProcessClient = Readonly<{
    client: FramedBytesClientV1;
    dispose(error?: Error): void;
    settleExit(error: Error): void;
}>;

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const LENGTH_PREFIX_BYTES = 4;

function createProtocolError(message: string, cause?: unknown, stderrPreview?: string): PluginExecClientError {
    return new PluginExecClientError('PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR', message, { cause, stderrPreview });
}

function createClosedError(): PluginExecClientError {
    return new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'Plugin exec client stream is closed');
}

function toBuffer(chunk: unknown): Buffer {
    if (Buffer.isBuffer(chunk)) {
        return chunk;
    }
    if (chunk instanceof Uint8Array) {
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    return Buffer.from(String(chunk));
}

function encodeFrame(frame: Uint8Array): Buffer {
    const payload = Buffer.from(frame);
    const prefix = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES);
    prefix.writeUInt32BE(payload.byteLength, 0);
    return Buffer.concat([prefix, payload]);
}

export function createFramedBytesProcessClient(params: CreateFramedBytesProcessClientParams): FramedBytesProcessClient {
    const stdout = params.stdout as ByteReadableStream;
    const subscribers = new Set<FramedBytesListenerV1>();
    const maxFrameBytes = params.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    let disposedError: Error | null = null;
    let closedSettled = false;
    let buffer = Buffer.alloc(0);
    let deliveryQueue = Promise.resolve();
    let resolveClosed: () => void = () => undefined;
    let rejectClosed: (error: Error) => void = () => undefined;

    const closed = new Promise<void>((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
    });
    closed.catch(() => undefined);

    function readStderrPreview(): string | undefined {
        const preview = params.readStderrPreview?.();
        return preview && preview.length > 0 ? preview : undefined;
    }

    function settleClosed(error?: Error): void {
        if (closedSettled) {
            return;
        }
        closedSettled = true;
        stdout.off('data', onData);
        stdout.off('end', onEnd);
        stdout.off('close', onEnd);
        stdout.off('error', onError);
        buffer = Buffer.alloc(0);
        if (error) {
            disposedError = error;
            rejectClosed(error);
            return;
        }
        disposedError = createClosedError();
        resolveClosed();
    }

    function failClient(error: Error): void {
        if (closedSettled) {
            return;
        }
        settleClosed(error);
    }

    async function deliverFrame(frame: Uint8Array): Promise<void> {
        if (subscribers.size === 0) {
            return;
        }
        stdout.pause?.();
        try {
            for (const listener of [...subscribers]) {
                await listener(Uint8Array.from(frame));
            }
        } finally {
            stdout.resume?.();
        }
    }

    function enqueueFrame(frame: Uint8Array): void {
        deliveryQueue = deliveryQueue
            .then(() => deliverFrame(frame))
            .catch((error) => {
                failClient(createProtocolError('Framed-bytes subscriber failed', error, readStderrPreview()));
            });
    }

    function processBuffer(): void {
        for (;;) {
            if (buffer.byteLength < LENGTH_PREFIX_BYTES) {
                return;
            }
            const frameLength = buffer.readUInt32BE(0);
            if (frameLength > maxFrameBytes) {
                failClient(createProtocolError('Framed-bytes frame exceeded the configured size limit', undefined, readStderrPreview()));
                return;
            }
            const totalLength = LENGTH_PREFIX_BYTES + frameLength;
            if (buffer.byteLength < totalLength) {
                return;
            }
            const frame = Uint8Array.from(buffer.subarray(LENGTH_PREFIX_BYTES, totalLength));
            buffer = buffer.subarray(totalLength);
            enqueueFrame(frame);
        }
    }

    function onData(chunk: unknown): void {
        if (closedSettled) {
            return;
        }
        buffer = Buffer.concat([buffer, toBuffer(chunk)]);
        processBuffer();
    }

    function onEnd(): void {
        if (closedSettled) {
            return;
        }
        if (buffer.byteLength > 0) {
            failClient(createProtocolError('Framed-bytes stream ended with a trailing partial frame', undefined, readStderrPreview()));
            return;
        }
        settleClosed();
    }

    function onError(error: unknown): void {
        failClient(createProtocolError('Framed-bytes stream failed', error, readStderrPreview()));
    }

    stdout.on('data', onData);
    stdout.on('end', onEnd);
    stdout.on('close', onEnd);
    stdout.on('error', onError);

    const client: FramedBytesClientV1 = Object.freeze({
        closed,
        subscribe(listener) {
            subscribers.add(listener);
            return () => {
                subscribers.delete(listener);
            };
        },
        async writeFrame(frame, options) {
            if (disposedError) {
                throw disposedError;
            }
            if (options?.signal?.aborted) {
                throw createPluginExecClientAbortError();
            }
            if (frame.byteLength > maxFrameBytes) {
                throw createProtocolError('Framed-bytes frame exceeded the configured size limit', undefined, readStderrPreview());
            }
            await params.write(encodeFrame(frame));
        },
    });

    return Object.freeze({
        client,
        dispose(error = new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'Plugin exec client was disposed')) {
            failClient(error);
        },
        settleExit(error: Error) {
            if (!closedSettled) {
                failClient(error);
            }
        },
    });
}
