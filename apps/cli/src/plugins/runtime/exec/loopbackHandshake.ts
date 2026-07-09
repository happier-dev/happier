import type { ExecLengthPrefixedByteOrderV1 } from '@happier-dev/plugin-sdk';

import {
    PluginExecClientError,
    createPluginExecClientAbortError,
} from './errors';

const LENGTH_PREFIX_BYTES = 4;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5_000;

type ByteReadableStream = NodeJS.ReadableStream & Readonly<{
    pause?: () => unknown;
    resume?: () => unknown;
}>;

type ReadHandshakeFrameParams = Readonly<{
    stdout: NodeJS.ReadableStream;
    byteOrder: ExecLengthPrefixedByteOrderV1;
    maxFrameBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    readStderrPreview?: () => string | undefined;
}>;

function createProtocolError(message: string, cause?: unknown, stderrPreview?: string): PluginExecClientError {
    return new PluginExecClientError('PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR', message, { cause, stderrPreview });
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

function readFrameLength(buffer: Buffer, byteOrder: ExecLengthPrefixedByteOrderV1): number {
    return byteOrder === 'little-endian'
        ? buffer.readUInt32LE(0)
        : buffer.readUInt32BE(0);
}

function writeFrameLength(buffer: Buffer, byteOrder: ExecLengthPrefixedByteOrderV1, length: number): void {
    if (byteOrder === 'little-endian') {
        buffer.writeUInt32LE(length, 0);
        return;
    }
    buffer.writeUInt32BE(length, 0);
}

export function encodeLoopbackHandshakeFrame(
    frame: Uint8Array | string,
    byteOrder: ExecLengthPrefixedByteOrderV1,
): Buffer {
    const payload = typeof frame === 'string' ? Buffer.from(frame, 'utf8') : Buffer.from(frame);
    const prefix = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES);
    writeFrameLength(prefix, byteOrder, payload.byteLength);
    return Buffer.concat([prefix, payload]);
}

export async function readLoopbackHandshakeFrame(params: ReadHandshakeFrameParams): Promise<Uint8Array> {
    const stdout = params.stdout as ByteReadableStream;
    const maxFrameBytes = params.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    const timeoutMs = params.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    const stderrPreview = () => {
        const preview = params.readStderrPreview?.();
        return preview && preview.length > 0 ? preview : undefined;
    };

    if (params.signal?.aborted) {
        throw createPluginExecClientAbortError();
    }

    return await new Promise<Uint8Array>((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        let settled = false;
        const timeout = setTimeout(() => {
            fail(new PluginExecClientError(
                'PLUGIN_EXEC_CLIENT_REQUEST_TIMEOUT',
                'Timed out waiting for loopback WebSocket handshake response',
                { stderrPreview: stderrPreview() },
            ));
        }, Math.max(0, timeoutMs));

        function cleanup(): void {
            clearTimeout(timeout);
            stdout.off('data', onData);
            stdout.off('end', onEnd);
            stdout.off('close', onEnd);
            stdout.off('error', onError);
            params.signal?.removeEventListener('abort', onAbort);
        }

        function succeed(frame: Uint8Array): void {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(frame);
        }

        function fail(error: Error): void {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        }

        function processBuffer(): void {
            if (buffer.byteLength < LENGTH_PREFIX_BYTES) {
                return;
            }
            const frameLength = readFrameLength(buffer, params.byteOrder);
            if (frameLength > maxFrameBytes) {
                fail(createProtocolError('Loopback WebSocket handshake response exceeded the configured size limit', undefined, stderrPreview()));
                return;
            }
            const totalLength = LENGTH_PREFIX_BYTES + frameLength;
            if (buffer.byteLength < totalLength) {
                return;
            }
            succeed(Uint8Array.from(buffer.subarray(LENGTH_PREFIX_BYTES, totalLength)));
        }

        function onData(chunk: unknown): void {
            if (settled) {
                return;
            }
            buffer = Buffer.concat([buffer, toBuffer(chunk)]);
            processBuffer();
        }

        function onEnd(): void {
            fail(createProtocolError('Loopback WebSocket handshake stdout ended before a complete response frame', undefined, stderrPreview()));
        }

        function onError(error: unknown): void {
            fail(createProtocolError('Loopback WebSocket handshake stdout failed', error, stderrPreview()));
        }

        function onAbort(): void {
            fail(createPluginExecClientAbortError());
        }

        stdout.on('data', onData);
        stdout.once('end', onEnd);
        stdout.once('close', onEnd);
        stdout.once('error', onError);
        params.signal?.addEventListener('abort', onAbort, { once: true });
        stdout.resume?.();
    });
}
