import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export type JsonlLineReaderErrorHandler = (error: unknown) => void;

export type AttachJsonlLineReaderOptions = Readonly<{
    encoding?: BufferEncoding;
    maxLineBytes?: number;
    onOversizedLine?: (sample: string, maxLineBytes: number) => void;
    onError?: JsonlLineReaderErrorHandler;
    onTrailingPartialLine?: (partialLine: string) => void;
}>;

export type DetachJsonlLineReader = () => void;

type JsonlReadableEventStream = Readonly<{
    on: (eventName: 'data', listener: (chunk: unknown) => void) => unknown;
    off: (eventName: 'data', listener: (chunk: unknown) => void) => unknown;
}> & Readonly<{
    on: (eventName: 'end' | 'close' | 'error', listener: (arg?: unknown) => void) => unknown;
    off: (eventName: 'end' | 'close' | 'error', listener: (arg?: unknown) => void) => unknown;
}>;

export function attachJsonlLineReader(
    stream: Readable | NodeJS.ReadableStream,
    onLine: (line: string) => void,
    options?: AttachJsonlLineReaderOptions,
): DetachJsonlLineReader {
    const eventStream = stream as JsonlReadableEventStream;
    const encoding = options?.encoding ?? 'utf8';
    const decoder = new StringDecoder(encoding);
    const maxLineBytes = typeof options?.maxLineBytes === 'number'
        && Number.isFinite(options.maxLineBytes)
        && options.maxLineBytes > 0
        ? Math.trunc(options.maxLineBytes)
        : null;
    const maxLineStartSampleChars = 4096;
    let buffer = '';
    let bufferBytes = 0;
    let lineStartSample = '';
    let discardingOversizedLine = false;
    let detached = false;

    const clearBuffer = (): void => {
        buffer = '';
        bufferBytes = 0;
        lineStartSample = '';
    };

    const detachInternal = (params?: Readonly<{ emitTrailingPartialLine?: boolean }>): void => {
        if (detached) return;
        detached = true;
        if (params?.emitTrailingPartialLine === true && buffer.length > 0 && !discardingOversizedLine) {
            buffer += decoder.end();
            options?.onTrailingPartialLine?.(buffer);
        } else if (params?.emitTrailingPartialLine === true) {
            const trailingDecodedText = decoder.end();
            if (trailingDecodedText.length > 0 && !discardingOversizedLine) {
                options?.onTrailingPartialLine?.(trailingDecodedText);
            }
        }
        clearBuffer();
        discardingOversizedLine = false;
        eventStream.off('data', onData);
        eventStream.off('end', onEnd);
        eventStream.off('close', onEnd);
        eventStream.off('error', onStreamError);
    };

    const detach = (): void => {
        detachInternal({ emitTrailingPartialLine: true });
    };

    const reportError = (error: unknown): void => {
        detachInternal();
        if (options?.onError) {
            options.onError(error);
            return;
        }
        queueMicrotask(() => {
            throw error;
        });
    };

    const emitLine = (): boolean => {
        const rawLine = buffer;
        clearBuffer();
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        try {
            onLine(line);
            return true;
        } catch (error) {
            reportError(error);
            return false;
        }
    };

    const appendSegment = (segment: string): boolean => {
        if (segment.length === 0 || discardingOversizedLine) return true;
        if (lineStartSample.length < maxLineStartSampleChars) {
            lineStartSample += segment.slice(0, maxLineStartSampleChars - lineStartSample.length);
        }
        const segmentBytes = Buffer.byteLength(segment, encoding);
        if (maxLineBytes !== null && bufferBytes + segmentBytes > maxLineBytes) {
            const sample = lineStartSample;
            clearBuffer();
            discardingOversizedLine = true;
            try {
                options?.onOversizedLine?.(sample, maxLineBytes);
                return true;
            } catch (error) {
                reportError(error);
                return false;
            }
        }
        buffer += segment;
        bufferBytes += segmentBytes;
        return true;
    };

    const processText = (text: string): boolean => {
        let startIndex = 0;
        for (;;) {
            const newlineIndex = text.indexOf('\n', startIndex);
            if (newlineIndex < 0) {
                return appendSegment(text.slice(startIndex));
            }

            if (!appendSegment(text.slice(startIndex, newlineIndex))) return false;
            if (discardingOversizedLine) {
                discardingOversizedLine = false;
                clearBuffer();
            } else if (!emitLine()) {
                return false;
            }
            startIndex = newlineIndex + 1;
            if (startIndex >= text.length) {
                return true;
            }
        }
    };

    function decodeChunk(chunk: unknown): string {
        if (typeof chunk === 'string') return chunk;
        if (Buffer.isBuffer(chunk)) return decoder.write(chunk);
        if (chunk instanceof Uint8Array) {
            return decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        }
        return decoder.write(Buffer.from(String(chunk)));
    }

    function onData(chunk: unknown): void {
        if (detached) return;
        processText(decodeChunk(chunk));
    }

    function onEnd(): void {
        if (detached) return;
        const trailingDecodedText = decoder.end();
        if (trailingDecodedText && !processText(trailingDecodedText)) return;
        if (buffer.length > 0 && !discardingOversizedLine) {
            const partialLine = buffer;
            clearBuffer();
            options?.onTrailingPartialLine?.(partialLine);
        }
        detachInternal();
    }

    function onStreamError(error: unknown): void {
        reportError(error);
    }

    eventStream.on('data', onData);
    eventStream.on('end', onEnd);
    eventStream.on('close', onEnd);
    eventStream.on('error', onStreamError);

    return detach;
}
