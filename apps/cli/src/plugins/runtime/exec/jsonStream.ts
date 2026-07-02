import type {
    ExecProcessHandleV1,
    JsonStreamClientV1,
    JsonStreamRecordListenerV1,
} from '@happier-dev/plugin-sdk';

import { attachJsonlLineReader } from '@/agent/runtime/jsonl/attachJsonlLineReader';

import {
    PluginExecClientError,
    createPluginExecClientAbortError,
} from './errors';

type ReadableStreamControls = NodeJS.ReadableStream & Readonly<{
    pause?: () => unknown;
    resume?: () => unknown;
}>;

export type CreateJsonStreamProcessClientParams = Readonly<{
    process: ExecProcessHandleV1;
    stdout: NodeJS.ReadableStream;
    write: (input: string) => Promise<void>;
    encoding?: BufferEncoding;
    maxFrameBytes?: number;
    readStderrPreview?: () => string;
}>;

export type JsonStreamProcessClient = Readonly<{
    client: JsonStreamClientV1;
    dispose(error?: Error): void;
    settleExit(error: Error): void;
}>;

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

function createProtocolError(message: string, cause?: unknown, stderrPreview?: string): PluginExecClientError {
    return new PluginExecClientError('PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR', message, { cause, stderrPreview });
}

function createClosedError(): PluginExecClientError {
    return new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'Plugin exec client stream is closed');
}

export function createJsonStreamProcessClient(params: CreateJsonStreamProcessClientParams): JsonStreamProcessClient {
    const stdout = params.stdout as ReadableStreamControls;
    const subscribers = new Set<JsonStreamRecordListenerV1>();
    const maxFrameBytes = params.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    let disposedError: Error | null = null;
    let closedSettled = false;
    let deliveryQueue = Promise.resolve();
    let resolveClosed: () => void = () => undefined;
    let rejectClosed: (error: Error) => void = () => undefined;
    let detachLineReader: () => void = () => undefined;

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
        detachLineReader();
        stdout.off('end', onStreamEnd);
        stdout.off('close', onStreamEnd);
        stdout.off('error', onStreamError);
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

    async function deliverRecord(record: unknown): Promise<void> {
        if (subscribers.size === 0) {
            return;
        }
        stdout.pause?.();
        try {
            for (const listener of [...subscribers]) {
                await listener(record);
            }
        } finally {
            stdout.resume?.();
        }
    }

    function enqueueRecord(record: unknown): void {
        deliveryQueue = deliveryQueue
            .then(() => deliverRecord(record))
            .catch((error) => {
                failClient(createProtocolError('JSON stream subscriber failed', error, readStderrPreview()));
            });
    }

    function handleLine(line: string): void {
        if (line.trim().length === 0) {
            return;
        }
        if (Buffer.byteLength(line) > maxFrameBytes) {
            failClient(createProtocolError('JSON stream record exceeded the configured size limit', undefined, readStderrPreview()));
            return;
        }
        try {
            enqueueRecord(JSON.parse(line));
        } catch (error) {
            failClient(createProtocolError('Invalid JSON stream record', error, readStderrPreview()));
        }
    }

    function onStreamEnd(): void {
        if (!closedSettled) {
            settleClosed();
        }
    }

    function onStreamError(error: unknown): void {
        failClient(createProtocolError('JSON stream failed', error, readStderrPreview()));
    }

    detachLineReader = attachJsonlLineReader(params.stdout, handleLine, {
        encoding: params.encoding,
        maxLineBytes: maxFrameBytes,
        onOversizedLine: () => {
            failClient(createProtocolError('JSON stream record exceeded the configured size limit', undefined, readStderrPreview()));
        },
        onError: (error) => {
            failClient(createProtocolError('JSON stream LF reader failed', error, readStderrPreview()));
        },
        onTrailingPartialLine: (partialLine) => {
            if (partialLine.length > 0) {
                failClient(createProtocolError('JSON stream ended with a trailing partial record', undefined, readStderrPreview()));
            }
        },
    });

    stdout.on('end', onStreamEnd);
    stdout.on('close', onStreamEnd);
    stdout.on('error', onStreamError);

    const client: JsonStreamClientV1 = Object.freeze({
        closed,
        subscribe(listener) {
            subscribers.add(listener);
            return () => {
                subscribers.delete(listener);
            };
        },
        async writeRecord(record, options) {
            if (disposedError) {
                throw disposedError;
            }
            if (options?.signal?.aborted) {
                throw createPluginExecClientAbortError();
            }
            let encodedRecord: string | undefined;
            try {
                encodedRecord = JSON.stringify(record);
            } catch (error) {
                throw createProtocolError('JSON stream record is not JSON-serializable', error, readStderrPreview());
            }
            if (typeof encodedRecord !== 'string') {
                throw createProtocolError('JSON stream record is not JSON-serializable', undefined, readStderrPreview());
            }
            if (Buffer.byteLength(encodedRecord) > maxFrameBytes) {
                throw createProtocolError('JSON stream record exceeded the configured size limit', undefined, readStderrPreview());
            }
            await params.write(`${encodedRecord}\n`);
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
