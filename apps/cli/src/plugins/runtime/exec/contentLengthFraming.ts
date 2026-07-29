const HEADER_TERMINATOR = Buffer.from('\r\n\r\n', 'ascii');
const MAX_HEADER_BYTES = 8 * 1024;

export function encodeContentLengthFrame(frame: Uint8Array): Buffer {
    return Buffer.concat([
        Buffer.from(`Content-Length: ${frame.byteLength}\r\n\r\n`, 'ascii'),
        Buffer.from(frame),
    ]);
}

export function attachContentLengthFrameReader(
    stream: NodeJS.ReadableStream,
    onFrame: (frame: Uint8Array) => void,
    options: Readonly<{
        maxFrameBytes: number;
        onError(error: Error): void;
        onTrailingPartialFrame(frame: Uint8Array): void;
    }>,
): () => void {
    let buffer = Buffer.alloc(0);
    let expectedPayloadBytes: number | null = null;
    let detached = false;

    const detach = (): void => {
        if (detached) return;
        detached = true;
        stream.removeListener('data', onData);
        stream.removeListener('end', onEnd);
        stream.removeListener('close', onEnd);
        stream.removeListener('error', onStreamError);
    };

    const fail = (message: string, cause?: unknown): void => {
        if (detached) return;
        detach();
        buffer = Buffer.alloc(0);
        try {
            options.onError(new Error(message, cause === undefined ? undefined : { cause }));
        } catch {
            // Reader failure reporting is isolated from the stream boundary.
        }
    };

    const readHeader = (): boolean => {
        const terminatorIndex = buffer.indexOf(HEADER_TERMINATOR);
        if (terminatorIndex < 0) {
            if (buffer.byteLength > MAX_HEADER_BYTES) fail('Content-length frame header exceeded its size limit');
            return false;
        }
        if (terminatorIndex > MAX_HEADER_BYTES) {
            fail('Content-length frame header exceeded its size limit');
            return false;
        }
        const lines = buffer.subarray(0, terminatorIndex).toString('ascii').split('\r\n');
        const lengths = lines
            .map((line) => /^content-length\s*:\s*([0-9]+)\s*$/iu.exec(line)?.[1])
            .filter((value): value is string => value !== undefined);
        if (lengths.length !== 1) {
            fail('Content-length frame requires exactly one Content-Length header');
            return false;
        }
        const length = Number(lengths[0]);
        if (!Number.isSafeInteger(length) || length < 0 || length > options.maxFrameBytes) {
            fail(`Content-length frame exceeded the configured size limit (${options.maxFrameBytes} bytes)`);
            return false;
        }
        expectedPayloadBytes = length;
        buffer = buffer.subarray(terminatorIndex + HEADER_TERMINATOR.byteLength);
        return true;
    };

    const processBuffer = (): void => {
        while (!detached) {
            if (expectedPayloadBytes === null && !readHeader()) return;
            if (expectedPayloadBytes === null || buffer.byteLength < expectedPayloadBytes) return;
            const frame = new Uint8Array(buffer.subarray(0, expectedPayloadBytes));
            buffer = buffer.subarray(expectedPayloadBytes);
            expectedPayloadBytes = null;
            try {
                onFrame(frame);
            } catch (error) {
                fail('Content-length frame callback failed', error);
            }
        }
    };

    function onData(chunk: unknown): void {
        if (detached) return;
        const bytes = Buffer.isBuffer(chunk)
            ? chunk
            : chunk instanceof Uint8Array
                ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                : Buffer.from(String(chunk));
        buffer = Buffer.concat([buffer, bytes]);
        processBuffer();
    }
    function onEnd(): void {
        if (detached) return;
        detach();
        if (buffer.byteLength > 0 || expectedPayloadBytes !== null) {
            options.onTrailingPartialFrame(new Uint8Array(buffer));
        }
    }
    function onStreamError(error: unknown): void {
        fail('Content-length frame stream failed', error);
    }

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('close', onEnd);
    stream.on('error', onStreamError);
    return detach;
}
