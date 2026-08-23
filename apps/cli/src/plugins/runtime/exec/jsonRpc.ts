import type {
    ExecClientHandlersV1,
    ExecClientHooksV1,
    ExecProcessHandleV1,
    JsonRpcMessageHookDecisionV1,
    JsonRpcClientV1,
    JsonRpcNotificationHandlerV1,
    JsonRpcRequestHandlerV1,
    JsonRpcRequestOptionsV1,
} from './privateContract';
import { createJsonlRequestCorrelator } from '@/plugins/runtime/jsonlRequestCorrelator';

import { attachJsonlLineReader } from '@/agent/runtime/jsonl/attachJsonlLineReader';

import {
    PluginExecClientError,
    createPluginExecClientAbortError,
    createPluginExecClientProtocolError,
    sanitizeExecDiagnosticText,
} from './errors';
import { createPluginProtocolCallbackQueue } from './callbackQueue';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';
import { attachContentLengthFrameReader, encodeContentLengthFrame } from './contentLengthFraming';

type JsonRpcObject = Record<string, unknown>;
type JsonRpcApplicationError = Error & Readonly<{
    code?: number | string;
    data?: unknown;
    method?: string;
}>;
const MAX_JSON_RPC_ERROR_MESSAGE_BYTES = 500;
const MAX_PENDING_JSON_RPC_REQUESTS = 256;
const MAX_IN_FLIGHT_JSON_RPC_REQUEST_HANDLERS = 256;
const MAX_IN_FLIGHT_JSON_RPC_WRITES = 256;

export type CreateJsonRpcProcessClientParams = Readonly<{
    process: ExecProcessHandleV1;
    stdout: NodeJS.ReadableStream;
    write: (input: string | Uint8Array) => Promise<void>;
    framing?: 'jsonLines' | 'contentLength';
    encoding?: BufferEncoding;
    maxFrameBytes?: number;
    requestTimeoutMs?: number;
    handlers?: ExecClientHandlersV1['jsonRpc'];
    hooks?: ExecClientHooksV1['jsonRpc'];
    readStderrPreview?: () => string;
    onFailure?: (error: Error) => void;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>;

export type JsonRpcProcessClient = Readonly<{
    client: JsonRpcClientV1;
    subscribeNotification(listener: (message: Readonly<{ method: string; params?: unknown }>) => void | Promise<void>): () => void;
    dispose(error?: Error): void;
    settleExit(error: Error): void;
}>;

function isObject(value: unknown): value is JsonRpcObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readId(value: unknown): string | number | null {
    return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function createFrameSizeError(maxFrameBytes: number, stderrPreview?: string): PluginExecClientError {
    return createPluginExecClientProtocolError(
        `JSON-RPC frame exceeded the configured size limit (${maxFrameBytes} bytes)`,
        undefined,
        stderrPreview,
    );
}

function readTopLevelJsonRpcResponseIdFromLineStartSample(sample: string): string | number | null {
    let objectDepth = 0;
    let arrayDepth = 0;
    let responseId: string | number | null = null;
    let hasResponsePayload = false;
    let hasMethod = false;
    const readStringEnd = (start: number): number => {
        let escaped = false;
        for (let index = start + 1; index < sample.length; index += 1) {
            const char = sample[index];
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                return index;
            }
        }
        return -1;
    };
    for (let index = 0; index < sample.length; index += 1) {
        const char = sample[index];
        if (char === '"') {
            const end = readStringEnd(index);
            if (end < 0) break;
            if (objectDepth === 1 && arrayDepth === 0) {
                let cursor = end + 1;
                while (/\s/.test(sample[cursor] ?? '')) cursor += 1;
                if (sample[cursor] === ':') {
                    let key: unknown;
                    try { key = JSON.parse(sample.slice(index, end + 1)); } catch { return null; }
                    if (key === 'method') {
                        hasMethod = true;
                    } else if (key === 'result' || key === 'error') {
                        hasResponsePayload = true;
                    } else if (key === 'id') {
                        cursor += 1;
                        while (/\s/.test(sample[cursor] ?? '')) cursor += 1;
                        if (sample[cursor] === '"') {
                            const valueEnd = readStringEnd(cursor);
                            if (valueEnd < 0) return null;
                            try {
                                const value: unknown = JSON.parse(sample.slice(cursor, valueEnd + 1));
                                responseId = typeof value === 'string' ? value : null;
                            } catch {
                                return null;
                            }
                        } else {
                            const numberMatch = /^-?\d+/.exec(sample.slice(cursor));
                            if (!numberMatch) return null;
                            const value = Number(numberMatch[0]);
                            responseId = Number.isSafeInteger(value) ? value : null;
                        }
                    }
                }
            }
            index = end;
        } else if (char === '{') objectDepth += 1;
        else if (char === '}') objectDepth -= 1;
        else if (char === '[') arrayDepth += 1;
        else if (char === ']') arrayDepth -= 1;
    }
    return hasResponsePayload && !hasMethod ? responseId : null;
}

function readJsonRpcErrorCode(value: unknown): number | string | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    return undefined;
}

function createJsonRpcApplicationError(params: Readonly<{
    method?: string;
    error: unknown;
}>): JsonRpcApplicationError {
    const errorRecord = isObject(params.error) ? params.error : {};
    const rawMessage = typeof errorRecord.message === 'string' && errorRecord.message.trim().length > 0
        ? errorRecord.message
        : 'JSON-RPC request failed';
    const failure = new Error(
        sanitizeExecDiagnosticText(rawMessage, MAX_JSON_RPC_ERROR_MESSAGE_BYTES),
        { cause: params.error },
    ) as JsonRpcApplicationError;
    failure.name = 'JsonRpcApplicationError';

    const code = readJsonRpcErrorCode(errorRecord.code);
    if (code !== undefined) {
        Object.defineProperty(failure, 'code', { value: code, enumerable: true });
    }
    if (params.method) {
        Object.defineProperty(failure, 'method', { value: params.method, enumerable: true });
    }
    if (Object.prototype.hasOwnProperty.call(errorRecord, 'data')) {
        Object.defineProperty(failure, 'data', { value: errorRecord.data, enumerable: true });
    }
    return failure;
}

function toErrorObject(error: unknown): Readonly<{ code: number; message: string }> {
    if (error instanceof PluginExecClientError && error.code === 'PLUGIN_EXEC_CLIENT_METHOD_NOT_FOUND') {
        return {
            code: -32601,
            message: sanitizeExecDiagnosticText(error.message, MAX_JSON_RPC_ERROR_MESSAGE_BYTES),
        };
    }
    return {
        code: -32000,
        message: error instanceof Error
            ? sanitizeExecDiagnosticText(error.message, MAX_JSON_RPC_ERROR_MESSAGE_BYTES)
            : 'JSON-RPC handler failed',
    };
}

export function createJsonRpcProcessClient(params: CreateJsonRpcProcessClientParams): JsonRpcProcessClient {
    const correlator = createJsonlRequestCorrelator<string, unknown>();
    const pendingRequestMethods = new Map<string, string>();
    const requestHandlers = new Map<string, JsonRpcRequestHandlerV1>();
    const notificationHandlers = new Map<string, JsonRpcNotificationHandlerV1>();
    const notificationSubscribers = new Set<(message: Readonly<{ method: string; params?: unknown }>) => void | Promise<void>>();
    const maxFrameBytes = params.maxFrameBytes ?? 1024 * 1024;
    let nextId = 1;
    let inFlightRequestHandlers = 0;
    let inFlightWrites = 0;
    let disposedError: Error | null = null;
    let detachLineReader: () => void = () => undefined;

    for (const [method, handler] of Object.entries(params.handlers?.requests ?? {})) {
        requestHandlers.set(method, handler);
    }
    for (const [method, handler] of Object.entries(params.handlers?.notifications ?? {})) {
        notificationHandlers.set(method, handler);
    }

    function readStderrPreview(): string | undefined {
        const preview = params.readStderrPreview?.();
        return preview && preview.length > 0 ? preview : undefined;
    }

    async function writeJson(message: JsonRpcObject): Promise<boolean> {
        if (disposedError) {
            throw disposedError;
        }
        if (inFlightWrites >= MAX_IN_FLIGHT_JSON_RPC_WRITES) {
            throw new PluginExecClientError(
                'PLUGIN_EXEC_CLIENT_BACKPRESSURE_EXCEEDED',
                'JSON-RPC writes exceeded their bounded concurrency',
                { stderrPreview: readStderrPreview() },
            );
        }
        inFlightWrites += 1;
        try {
            const nextMessage = await applyJsonRpcMessageHook(message, 'outgoing');
            if (!nextMessage) {
                return false;
            }
            const encoded = JSON.stringify(nextMessage);
            if (Buffer.byteLength(encoded, 'utf8') > maxFrameBytes) {
                throw createFrameSizeError(maxFrameBytes, readStderrPreview());
            }
            await params.write(params.framing === 'contentLength'
                ? encodeContentLengthFrame(new Uint8Array(Buffer.from(encoded, 'utf8')))
                : `${encoded}\n`);
            return true;
        } finally {
            inFlightWrites -= 1;
        }
    }

    function failClient(error: Error): void {
        if (disposedError) {
            return;
        }
        disposedError = error;
        detachLineReader();
        correlator.close(error);
        pendingRequestMethods.clear();
        if (
            !(error instanceof PluginExecClientError)
            || (error.code !== 'PLUGIN_EXEC_CLIENT_DISPOSED' && error.code !== 'PLUGIN_EXEC_CLIENT_EXITED')
        ) {
            try {
                params.onFailure?.(error);
            } catch {
                // Process termination remains owned by the caller boundary.
            }
        }
    }

    const notificationDispatchQueue = createPluginProtocolCallbackQueue({
        ...(params.recordRuntimeLimitMeasurement
            ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
            : {}),
        onFailure(failure) {
            failClient(new PluginExecClientError(
                failure.code,
                failure.code === 'PLUGIN_EXEC_CLIENT_BACKPRESSURE_EXCEEDED'
                    ? 'JSON-RPC notification callback queue exceeded its bounded capacity'
                    : 'JSON-RPC notification callback failed',
                { cause: failure.cause, stderrPreview: readStderrPreview() },
            ));
        },
    });

    async function handleRequest(message: JsonRpcObject, id: string | number, method: string): Promise<void> {
        const handler = requestHandlers.get(method);
        if (!handler) {
            await writeJson({
                jsonrpc: '2.0',
                id,
                error: { code: -32601, message: `No JSON-RPC handler registered for '${method}'` },
            });
            return;
        }
        try {
            const result = await handler(message.params, { method, requestId: String(id) });
            if (result === undefined) {
                throw new PluginExecClientError(
                    'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
                    `JSON-RPC request handler for ${method} returned undefined`,
                );
            }
            await writeJson({ jsonrpc: '2.0', id, result });
        } catch (error) {
            await writeJson({ jsonrpc: '2.0', id, error: toErrorObject(error) });
        }
    }

    async function handleNotification(message: JsonRpcObject, method: string): Promise<void> {
        let firstFailure: unknown;
        for (const listener of [...notificationSubscribers]) {
            try {
                await listener({
                    method,
                    ...(Object.prototype.hasOwnProperty.call(message, 'params') ? { params: message.params } : {}),
                });
            } catch (error) {
                firstFailure ??= error;
            }
        }
        const handler = notificationHandlers.get(method);
        if (handler) {
            try {
                await handler(message.params, { method });
            } catch (error) {
                firstFailure ??= error;
            }
        }
        if (firstFailure !== undefined) throw firstFailure;
    }

    function normalizeHookDecision(
        decision: JsonRpcMessageHookDecisionV1 | undefined,
        originalMessage: JsonRpcObject,
    ): unknown {
        if (decision === undefined || decision === 'pass') {
            return originalMessage;
        }
        if (decision === 'suppress') {
            return null;
        }
        return decision.message;
    }

    async function applyJsonRpcMessageHook(
        message: JsonRpcObject,
        phase: 'incoming' | 'outgoing',
    ): Promise<JsonRpcObject | null> {
        const hook = params.hooks?.onMessage;
        if (!hook) {
            return message;
        }
        const nextMessage = normalizeHookDecision(await hook(message, { phase }), message);
        if (nextMessage === null) {
            return null;
        }
        if (!isObject(nextMessage)) {
            throw createPluginExecClientProtocolError('JSON-RPC message hook must pass, suppress, or replace with an object frame', undefined, readStderrPreview());
        }
        return nextMessage;
    }

    async function handleMessage(message: unknown): Promise<void> {
        if (!isObject(message)) {
            failClient(createPluginExecClientProtocolError('JSON-RPC frame must be an object', undefined, readStderrPreview()));
            return;
        }
        const hookedMessage = await applyJsonRpcMessageHook(message, 'incoming');
        if (!hookedMessage) {
            return;
        }
        const jsonMessage = hookedMessage;
        const id = readId(jsonMessage.id);
        if (id !== null && ('result' in jsonMessage || 'error' in jsonMessage)) {
            const requestId = String(id);
            const method = pendingRequestMethods.get(requestId);
            pendingRequestMethods.delete(requestId);
            if ('error' in jsonMessage) {
                correlator.reject(requestId, createJsonRpcApplicationError({
                    method,
                    error: jsonMessage.error,
                }));
            } else {
                correlator.resolve(requestId, jsonMessage.result);
            }
            return;
        }
        const method = typeof jsonMessage.method === 'string' ? jsonMessage.method : null;
        if (!method) {
            failClient(createPluginExecClientProtocolError('JSON-RPC frame must include a method or response id', undefined, readStderrPreview()));
            return;
        }
        if (id !== null) {
            if (inFlightRequestHandlers >= MAX_IN_FLIGHT_JSON_RPC_REQUEST_HANDLERS) {
                failClient(new PluginExecClientError(
                    'PLUGIN_EXEC_CLIENT_BACKPRESSURE_EXCEEDED',
                    'JSON-RPC child request handlers exceeded their bounded concurrency',
                    { stderrPreview: readStderrPreview() },
                ));
                return;
            }
            inFlightRequestHandlers += 1;
            void handleRequest(jsonMessage, id, method)
                .catch((error) => {
                    failClient(createPluginExecClientProtocolError('JSON-RPC request handler dispatch failed', error, readStderrPreview()));
                })
                .finally(() => {
                    inFlightRequestHandlers -= 1;
                });
            return;
        }
        await handleNotification(jsonMessage, method);
    }

    function rejectCorrelatedFrame(sample: string, error: Error): boolean {
        const id = readTopLevelJsonRpcResponseIdFromLineStartSample(sample);
        if (id !== null) {
            const requestId = String(id);
            if (pendingRequestMethods.has(requestId)) {
                pendingRequestMethods.delete(requestId);
                correlator.reject(requestId, error);
                return true;
            }
        }
        return false;
    }

    function rejectOversizedFrame(sample: string, maxBytes: number): void {
        const error = createFrameSizeError(maxBytes, readStderrPreview());
        if (rejectCorrelatedFrame(sample, error)) return;
        failClient(error);
    }

    function handleLine(line: string): void {
        if (line.trim().length === 0) {
            return;
        }
        if (Buffer.byteLength(line) > maxFrameBytes) {
            rejectOversizedFrame(line, maxFrameBytes);
            return;
        }
        try {
            const message: unknown = JSON.parse(line);
            const isNotification = isObject(message)
                && readId(message.id) === null
                && typeof message.method === 'string';
            if (isNotification) {
                notificationDispatchQueue.enqueue(Buffer.byteLength(line), () => handleMessage(message));
                return;
            }
            void handleMessage(message).catch((error) => {
                failClient(createPluginExecClientProtocolError('JSON-RPC message hook failed', error, readStderrPreview()));
            });
        } catch (error) {
            const failure = createPluginExecClientProtocolError('Invalid JSON-RPC frame', error, readStderrPreview());
            if (rejectCorrelatedFrame(line, failure)) return;
            failClient(failure);
        }
    }

    detachLineReader = params.framing === 'contentLength'
        ? attachContentLengthFrameReader(params.stdout, (frame) => {
            handleLine(Buffer.from(frame).toString(params.encoding ?? 'utf8'));
        }, {
            maxFrameBytes,
            onError: (error) => {
                failClient(createPluginExecClientProtocolError('JSON-RPC content-length reader failed', error, readStderrPreview()));
            },
            onTrailingPartialFrame: () => {
                failClient(createPluginExecClientProtocolError('JSON-RPC stream ended with a trailing partial frame', undefined, readStderrPreview()));
            },
        })
        : attachJsonlLineReader(params.stdout, handleLine, {
            encoding: params.encoding,
            maxLineBytes: maxFrameBytes,
            onOversizedLine: rejectOversizedFrame,
            onError: (error) => {
                failClient(createPluginExecClientProtocolError('JSON-RPC LF reader failed', error, readStderrPreview()));
            },
            onTrailingPartialLine: (partialLine) => {
                if (partialLine.length > 0) {
                    failClient(createPluginExecClientProtocolError('JSON-RPC stream ended with a trailing partial frame', undefined, readStderrPreview()));
                }
            },
        });

    const client: JsonRpcClientV1 = Object.freeze({
        async request<TParams = unknown, TResult = unknown>(
            method: string,
            requestParams?: TParams,
            options?: JsonRpcRequestOptionsV1,
        ): Promise<TResult> {
            if (disposedError) {
                throw disposedError;
            }
            if (options?.signal?.aborted) {
                throw createPluginExecClientAbortError();
            }
            if (pendingRequestMethods.size >= MAX_PENDING_JSON_RPC_REQUESTS) {
                throw new PluginExecClientError(
                    'PLUGIN_EXEC_CLIENT_BACKPRESSURE_EXCEEDED',
                    'JSON-RPC pending request correlation exceeded its bounded capacity',
                    { stderrPreview: readStderrPreview() },
                );
            }
            const id = nextId++;
            const requestTimeoutMs = options?.timeoutMs === null
                ? undefined
                : options?.timeoutMs ?? params.requestTimeoutMs;
            const abortSignal = options?.signal;
            const requestId = String(id);
            let timeout: NodeJS.Timeout | null = null;
            let onAbort: (() => void) | null = null;
            const cleanup = () => {
                pendingRequestMethods.delete(requestId);
                if (timeout) {
                    clearTimeout(timeout);
                }
                if (abortSignal && onAbort) {
                    abortSignal.removeEventListener('abort', onAbort);
                }
            };
            const promise = new Promise<TResult>((resolve, reject) => {
                pendingRequestMethods.set(requestId, method);
                correlator.add(requestId, {
                    resolve: (value) => {
                        cleanup();
                        resolve(value as TResult);
                    },
                    reject: (error) => {
                        cleanup();
                        reject(error);
                    },
                });
                if (requestTimeoutMs !== undefined) {
                    timeout = setTimeout(() => {
                        correlator.reject(requestId, new PluginExecClientError(
                            'PLUGIN_EXEC_CLIENT_REQUEST_TIMEOUT',
                            `JSON-RPC request '${method}' timed out`,
                            { stderrPreview: readStderrPreview() },
                        ));
                    }, Math.max(0, requestTimeoutMs));
                }
                if (abortSignal) {
                    onAbort = () => {
                        correlator.reject(requestId, createPluginExecClientAbortError());
                    };
                    if (abortSignal.aborted) {
                        onAbort();
                    } else {
                        abortSignal.addEventListener('abort', onAbort, { once: true });
                    }
                }
            });
            const writeOutcome = writeJson({ jsonrpc: '2.0', id, method, params: requestParams }).then(
                (wrote) => ({ kind: 'write' as const, wrote }),
                (error: unknown) => ({ kind: 'writeError' as const, error }),
            );
            const requestOutcome = promise.then(
                (value) => ({ kind: 'request' as const, value }),
                (error: unknown) => ({ kind: 'requestError' as const, error }),
            );
            const firstOutcome = await Promise.race([writeOutcome, requestOutcome]);
            if (firstOutcome.kind === 'request') return firstOutcome.value;
            if (firstOutcome.kind === 'requestError') throw firstOutcome.error;
            try {
                if (firstOutcome.kind === 'writeError') throw firstOutcome.error;
                const wrote = firstOutcome.wrote;
                if (!wrote) {
                    correlator.reject(
                        requestId,
                        createPluginExecClientProtocolError('JSON-RPC request write was suppressed by a message hook', undefined, readStderrPreview()),
                    );
                }
            } catch (error) {
                correlator.reject(
                    requestId,
                    error instanceof Error ? error : createPluginExecClientProtocolError('JSON-RPC write failed', error),
                );
            }
            return await promise;
        },
        async notify<TParams = unknown>(method: string, notificationParams?: TParams): Promise<void> {
            await writeJson({ jsonrpc: '2.0', method, params: notificationParams });
        },
        registerRequestHandler<TParams = unknown, TResult = unknown>(
            method: string,
            handler: JsonRpcRequestHandlerV1<TParams, TResult>,
        ): () => void {
            if (requestHandlers.has(method)) {
                throw new PluginExecClientError(
                    'PLUGIN_EXEC_CLIENT_DUPLICATE_HANDLER',
                    `A JSON-RPC responder is already registered for '${method}'`,
                );
            }
            requestHandlers.set(method, handler as JsonRpcRequestHandlerV1);
            return () => {
                if (requestHandlers.get(method) === handler) {
                    requestHandlers.delete(method);
                }
            };
        },
        registerNotificationHandler<TParams = unknown>(
            method: string,
            handler: JsonRpcNotificationHandlerV1<TParams>,
        ): () => void {
            notificationHandlers.set(method, handler as JsonRpcNotificationHandlerV1);
            return () => {
                if (notificationHandlers.get(method) === handler) {
                    notificationHandlers.delete(method);
                }
            };
        },
    });

    return Object.freeze({
        client,
        subscribeNotification(listener) {
            notificationSubscribers.add(listener);
            return () => {
                notificationSubscribers.delete(listener);
            };
        },
        dispose(error = new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'Plugin exec client was disposed')) {
            failClient(error);
        },
        settleExit(error: Error) {
            failClient(error);
        },
    });
}
