import type {
    ExecProcessHandleV1,
    FramedBytesClientV1,
    FramedBytesListenerV1,
} from './privateContract';

import {
    PluginExecClientError,
    createPluginExecClientAbortError,
    createPluginExecClientProtocolError,
} from './errors';
import { createPluginProtocolCallbackQueue } from './callbackQueue';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';
import { attachContentLengthFrameReader, encodeContentLengthFrame } from './contentLengthFraming';

type ByteReadableStream = NodeJS.ReadableStream & Readonly<{
    pause?: () => unknown;
    resume?: () => unknown;
}>;

export type CreateFramedBytesProcessClientParams = Readonly<{
    process: ExecProcessHandleV1;
    stdout: NodeJS.ReadableStream;
    write: (input: Uint8Array) => Promise<void>;
    framing?: 'lengthPrefix' | 'contentLength';
    maxFrameBytes?: number;
    readStderrPreview?: () => string;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>;

export type FramedBytesProcessClient = Readonly<{
    client: FramedBytesClientV1;
    dispose(error?: Error): void;
    settleExit(error: Error): void;
}>;

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const LENGTH_PREFIX_BYTES = 4;

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
    let resolveClosed: () => void = () => undefined;
    let rejectClosed: (error: Error) => void = () => undefined;
    let detachContentLengthReader: () => void = () => undefined;

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
        detachContentLengthReader();
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

    const deliveryQueue = createPluginProtocolCallbackQueue({
        ...(params.recordRuntimeLimitMeasurement
            ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
            : {}),
        onFailure(failure) {
            failClient(new PluginExecClientError(
                failure.code,
                failure.code === 'PLUGIN_EXEC_CLIENT_BACKPRESSURE_EXCEEDED'
                    ? 'Framed-bytes callback queue exceeded its bounded capacity'
                    : 'Framed-bytes subscriber failed',
                { cause: failure.cause, stderrPreview: readStderrPreview() },
            ));
        },
    });

    async function deliverFrame(frame: Uint8Array): Promise<void> {
        if (subscribers.size === 0) {
            return;
        }
        stdout.pause?.();
        try {
            let firstFailure: unknown;
            for (const listener of [...subscribers]) {
                try {
                    await listener(Uint8Array.from(frame));
                } catch (error) {
                    firstFailure ??= error;
                }
            }
            if (firstFailure !== undefined) throw firstFailure;
        } finally {
            stdout.resume?.();
        }
    }

    function enqueueFrame(frame: Uint8Array): void {
        deliveryQueue.enqueue(frame.byteLength, () => deliverFrame(frame));
    }

    function processBuffer(): void {
        for (;;) {
            if (buffer.byteLength < LENGTH_PREFIX_BYTES) {
                return;
            }
            const frameLength = buffer.readUInt32BE(0);
            if (frameLength > maxFrameBytes) {
                failClient(createPluginExecClientProtocolError('Framed-bytes frame exceeded the configured size limit', undefined, readStderrPreview()));
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
            failClient(createPluginExecClientProtocolError('Framed-bytes stream ended with a trailing partial frame', undefined, readStderrPreview()));
            return;
        }
        settleClosed();
    }

    function onError(error: unknown): void {
        failClient(createPluginExecClientProtocolError('Framed-bytes stream failed', error, readStderrPreview()));
    }

    if (params.framing === 'contentLength') {
        detachContentLengthReader = attachContentLengthFrameReader(params.stdout, (frame) => {
            enqueueFrame(frame);
        }, {
            maxFrameBytes,
            onError: (error) => failClient(createPluginExecClientProtocolError('Framed-bytes content-length reader failed', error, readStderrPreview())),
            onTrailingPartialFrame: () => failClient(createPluginExecClientProtocolError('Framed-bytes stream ended with a trailing partial frame', undefined, readStderrPreview())),
        });
    } else {
        stdout.on('data', onData);
        stdout.on('end', onEnd);
        stdout.on('close', onEnd);
        stdout.on('error', onError);
    }

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
                throw createPluginExecClientProtocolError('Framed-bytes frame exceeded the configured size limit', undefined, readStderrPreview());
            }
            await params.write(params.framing === 'contentLength'
                ? encodeContentLengthFrame(frame)
                : encodeFrame(frame));
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
