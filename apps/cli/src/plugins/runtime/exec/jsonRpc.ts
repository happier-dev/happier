import type {
    ExecClientHandlersV1,
    ExecClientHooksV1,
    ExecProcessHandleV1,
    JsonRpcMessageHookDecisionV1,
    JsonRpcClientV1,
    JsonRpcNotificationHandlerV1,
    JsonRpcRequestHandlerV1,
    JsonRpcRequestOptionsV1,
} from '@happier-dev/plugin-sdk';
import { createJsonlRequestCorrelator } from '@happier-dev/plugin-sdk';

import { attachJsonlLineReader } from '@/agent/runtime/jsonl/attachJsonlLineReader';

import {
    PluginExecClientError,
    createPluginExecClientAbortError,
    sanitizeExecDiagnosticText,
} from './errors';

type JsonRpcObject = Record<string, unknown>;
type JsonRpcApplicationError = Error & Readonly<{
    code?: number | string;
    data?: unknown;
    method?: string;
}>;
const MAX_JSON_RPC_ERROR_MESSAGE_BYTES = 500;

export type CreateJsonRpcProcessClientParams = Readonly<{
    process: ExecProcessHandleV1;
    stdout: NodeJS.ReadableStream;
    write: (input: string) => Promise<void>;
    encoding?: BufferEncoding;
    maxFrameBytes?: number;
    requestTimeoutMs?: number;
    handlers?: ExecClientHandlersV1['jsonRpc'];
    hooks?: ExecClientHooksV1['jsonRpc'];
    readStderrPreview?: () => string;
}>;

export type JsonRpcProcessClient = Readonly<{
    client: JsonRpcClientV1;
    dispose(error?: Error): void;
    settleExit(error: Error): void;
}>;

function isObject(value: unknown): value is JsonRpcObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readId(value: unknown): string | number | null {
    return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function createProtocolError(message: string, cause?: unknown, stderrPreview?: string): PluginExecClientError {
    return new PluginExecClientError('PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR', message, { cause, stderrPreview });
}

function createFrameSizeError(maxFrameBytes: number, stderrPreview?: string): PluginExecClientError {
    return createProtocolError(
        `JSON-RPC frame exceeded the configured size limit (${maxFrameBytes} bytes)`,
        undefined,
        stderrPreview,
    );
}

function readJsonRpcIdFromLineStartSample(sample: string): string | number | null {
    const match = /"id"\s*:\s*(-?\d+|"((?:\\.|[^"\\])*)")/.exec(sample);
    if (!match) return null;
    const raw = match[1];
    if (!raw) return null;
    if (raw.startsWith('"')) {
        try {
            const parsed = JSON.parse(raw) as unknown;
            return typeof parsed === 'string' ? parsed : null;
        } catch {
            return null;
        }
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
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
    const maxFrameBytes = params.maxFrameBytes ?? 1024 * 1024;
    let nextId = 1;
    let disposedError: Error | null = null;

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
        const nextMessage = await applyJsonRpcMessageHook(message, 'outgoing');
        if (!nextMessage) {
            return false;
        }
        await params.write(`${JSON.stringify(nextMessage)}\n`);
        return true;
    }

    function failClient(error: Error): void {
        if (disposedError) {
            return;
        }
        disposedError = error;
        detachLineReader();
        correlator.close(error);
        pendingRequestMethods.clear();
    }

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
        const handler = notificationHandlers.get(method);
        if (!handler) {
            return;
        }
        await handler(message.params, { method });
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
            throw createProtocolError('JSON-RPC message hook must pass, suppress, or replace with an object frame', undefined, readStderrPreview());
        }
        return nextMessage;
    }

    async function handleMessage(message: unknown): Promise<void> {
        if (!isObject(message)) {
            failClient(createProtocolError('JSON-RPC frame must be an object', undefined, readStderrPreview()));
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
            failClient(createProtocolError('JSON-RPC frame must include a method or response id', undefined, readStderrPreview()));
            return;
        }
        if (id !== null) {
            void handleRequest(jsonMessage, id, method).catch((error) => {
                failClient(createProtocolError('JSON-RPC request handler dispatch failed', error, readStderrPreview()));
            });
            return;
        }
        void handleNotification(jsonMessage, method).catch((error) => {
            failClient(createProtocolError('JSON-RPC notification handler dispatch failed', error, readStderrPreview()));
        });
    }

    function rejectOversizedFrame(sample: string, maxBytes: number): void {
        const error = createFrameSizeError(maxBytes, readStderrPreview());
        const id = readJsonRpcIdFromLineStartSample(sample);
        if (id !== null) {
            const requestId = String(id);
            if (pendingRequestMethods.has(requestId)) {
                pendingRequestMethods.delete(requestId);
                correlator.reject(requestId, error);
                return;
            }
        }
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
            void handleMessage(JSON.parse(line)).catch((error) => {
                failClient(createProtocolError('JSON-RPC message hook failed', error, readStderrPreview()));
            });
        } catch (error) {
            failClient(createProtocolError('Invalid JSON-RPC frame', error, readStderrPreview()));
        }
    }

    const detachLineReader = attachJsonlLineReader(params.stdout, handleLine, {
        encoding: params.encoding,
        maxLineBytes: maxFrameBytes,
        onOversizedLine: rejectOversizedFrame,
        onError: (error) => {
            failClient(createProtocolError('JSON-RPC LF reader failed', error, readStderrPreview()));
        },
        onTrailingPartialLine: (partialLine) => {
            if (partialLine.length > 0) {
                failClient(createProtocolError('JSON-RPC stream ended with a trailing partial frame', undefined, readStderrPreview()));
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
            const id = nextId++;
            const requestTimeoutMs = options?.timeoutMs ?? params.requestTimeoutMs;
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
            try {
                const wrote = await writeJson({ jsonrpc: '2.0', id, method, params: requestParams });
                if (!wrote) {
                    correlator.reject(
                        requestId,
                        createProtocolError('JSON-RPC request write was suppressed by a message hook', undefined, readStderrPreview()),
                    );
                }
            } catch (error) {
                correlator.reject(
                    requestId,
                    error instanceof Error ? error : createProtocolError('JSON-RPC write failed', error),
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
        dispose(error = new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'Plugin exec client was disposed')) {
            failClient(error);
        },
        settleExit(error: Error) {
            failClient(error);
        },
    });
}
