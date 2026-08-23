import { isPluginError } from '@happier-dev/plugin-sdk';
import type {
    PluginWebSocketClose,
    PluginWebSocketConnection,
} from '@happier-dev/plugin-sdk/http';

import type {
    ExecClientDiagnosticSanitizerV1,
    ExecLoopbackWebSocketConnectV1,
    ExecLoopbackWebSocketEndpointCodecV1,
    ExecLoopbackWebSocketEndpointV1,
    ExecLoopbackWebSocketHandshakeV1,
    ExecLoopbackWebSocketHeaderV1,
    ExecLoopbackWebSocketJsonClientSpecV1,
    ExecLoopbackWebSocketLimitsV1,
    ExecProcessHandleV1,
    ExecRunResultV1,
    LoopbackWebSocketJsonClientV1,
    LoopbackWebSocketJsonMessageListenerV1,
} from './privateContract';

import {
    PluginExecClientError,
    createPluginExecClientAbortError,
    createPluginExecClientProtocolError,
    sanitizeExecDiagnosticText,
} from './errors';
import { createPluginProtocolCallbackQueue } from './callbackQueue';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';
import { createPluginWebSocketConnection } from '../fetch/webSocket';
import {
    encodeLoopbackHandshakeFrame,
    readLoopbackHandshakeFrame,
} from './loopbackHandshake';

type SpawnedLoopbackProcess = Readonly<{
    child: Readonly<{
        stdin: NodeJS.WritableStream;
        stdout: NodeJS.ReadableStream;
    }>;
    handle: ExecProcessHandleV1;
    readStderrPreview: () => string;
}>;

export type LoopbackWebSocketProcessClient = Readonly<{
    client: LoopbackWebSocketJsonClientV1;
    dispose(error?: Error): void;
    settleExit(error: Error): void;
}>;

export type CreateLoopbackWebSocketProcessClientParams = Readonly<{
    spec: ExecLoopbackWebSocketJsonClientSpecV1;
    process: SpawnedLoopbackProcess;
    optionsSignal?: AbortSignal;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>;

export type CreateLoopbackWebSocketHandshakeClientParams<
    TEndpoint extends ExecLoopbackWebSocketEndpointV1 = ExecLoopbackWebSocketEndpointV1,
> = Readonly<{
    handshake: ExecLoopbackWebSocketHandshakeV1;
    endpoint: ExecLoopbackWebSocketEndpointCodecV1<TEndpoint>;
    connect?: ExecLoopbackWebSocketConnectV1;
    limits?: ExecLoopbackWebSocketLimitsV1;
    sanitizer?: ExecClientDiagnosticSanitizerV1;
    process: SpawnedLoopbackProcess;
    optionsSignal?: AbortSignal;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>;

export type CreateLoopbackWebSocketJsonClientParams = Readonly<{
    endpoint: ExecLoopbackWebSocketEndpointV1;
    headers?: readonly ExecLoopbackWebSocketHeaderV1[];
    connect?: ExecLoopbackWebSocketConnectV1;
    limits?: ExecLoopbackWebSocketLimitsV1;
    signal?: AbortSignal;
    readDiagnosticPreview?: () => string | undefined;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>;

type ValidatedEndpoint = Readonly<{
    host: string;
    port: number;
    path: string;
    headers: readonly ExecLoopbackWebSocketHeaderV1[];
    sensitiveValues: readonly string[];
}>;

type NormalizedLoopbackLimits = Readonly<{
    maxMessageBytes: number;
    maxPendingMessages: number;
    maxBufferedBytes: number;
}>;

const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 10;
const DEFAULT_RETRY_MAX_DELAY_MS = 50;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_MESSAGES = 64;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 250;
const SAFE_ORIGIN_FORM_PATH_PATTERN = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*(?:\?[A-Za-z0-9\-._~!$&'()*+,;=:@/%?]*)?$/;

function createBackpressureError(stderrPreview?: string): PluginExecClientError {
    return new PluginExecClientError(
        'PLUGIN_EXEC_CLIENT_BACKPRESSURE_EXCEEDED',
        'Loopback WebSocket client exceeded configured backpressure limits',
        { stderrPreview },
    );
}

function createConnectionTimeoutError(cause?: unknown, stderrPreview?: string): PluginExecClientError {
    return new PluginExecClientError(
        'PLUGIN_EXEC_CLIENT_REQUEST_TIMEOUT',
        'Timed out connecting to loopback WebSocket endpoint',
        { cause, stderrPreview },
    );
}

function readNodeErrorCode(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
}

function readErrorCause(error: unknown): unknown {
    if (!error || typeof error !== 'object') return null;
    return (error as { cause?: unknown }).cause;
}

function isAbortError(error: unknown): boolean {
    return !!error
        && typeof error === 'object'
        && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * A loopback server that has not finished binding refuses the connection. Every
 * error reaching this point is a canonical PluginError - `PluginExecClientError`
 * included - so one predicate decides readiness for all of them.
 */
function isRetryableReadinessError(error: unknown): boolean {
    return isPluginError(error)
        && error.code === 'plugin_websocket_connect_failed'
        && readNodeErrorCode(readErrorCause(error)) === 'ECONNREFUSED';
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : fallback;
}

function normalizeLimits(limits: ExecLoopbackWebSocketLimitsV1 | undefined): NormalizedLoopbackLimits {
    return Object.freeze({
        maxMessageBytes: normalizePositiveInteger(limits?.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES),
        maxPendingMessages: normalizePositiveInteger(limits?.maxPendingMessages, DEFAULT_MAX_PENDING_MESSAGES),
        maxBufferedBytes: normalizePositiveInteger(limits?.maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES),
    });
}

function isLoopbackHost(host: string): boolean {
    const normalized = host.toLowerCase();
    return normalized === '127.0.0.1'
        || normalized === 'localhost'
        || normalized === '::1'
        || normalized === '[::1]';
}

function readPath(parsed: URL): string {
    return (parsed.pathname || '/') + parsed.search;
}

function isSafeAbsolutePath(path: string): boolean {
    return SAFE_ORIGIN_FORM_PATH_PATTERN.test(path);
}

function validateHeader(header: ExecLoopbackWebSocketHeaderV1): void {
    if (!/^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/.test(header.name)) {
        throw createPluginExecClientProtocolError('Loopback WebSocket header name is invalid');
    }
    if (/[\r\n]/.test(header.value)) {
        throw createPluginExecClientProtocolError('Loopback WebSocket header value is invalid');
    }
}

function validateEndpoint(
    endpoint: ExecLoopbackWebSocketEndpointV1,
    headers: readonly ExecLoopbackWebSocketHeaderV1[],
): ValidatedEndpoint {
    let protocol = typeof endpoint.protocol === 'string' ? endpoint.protocol : 'ws';
    let host = typeof endpoint.host === 'string' && endpoint.host.trim().length > 0
        ? endpoint.host.trim()
        : '127.0.0.1';
    let port = endpoint.port;
    let path = typeof endpoint.path === 'string' && endpoint.path.length > 0 ? endpoint.path : '/';

    if (typeof endpoint.url === 'string' && endpoint.url.trim().length > 0) {
        const parsed = new URL(endpoint.url);
        if (parsed.username || parsed.password) {
            throw createPluginExecClientProtocolError('Loopback WebSocket endpoint URL must not include credentials');
        }
        protocol = parsed.protocol.replace(/:$/, '');
        host = parsed.hostname;
        port = parsed.port.length > 0 ? Number(parsed.port) : undefined;
        path = readPath(parsed);
    }

    if (protocol !== 'ws') {
        throw createPluginExecClientProtocolError('Loopback WebSocket endpoint must use ws protocol');
    }
    if (!isLoopbackHost(host)) {
        throw createPluginExecClientProtocolError('Loopback WebSocket endpoint host must be loopback-only');
    }
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
        throw createPluginExecClientProtocolError('Loopback WebSocket endpoint port must be an integer user-space port');
    }
    if (!isSafeAbsolutePath(path)) {
        throw createPluginExecClientProtocolError('Loopback WebSocket endpoint path must be a safe absolute path/query form');
    }
    for (const header of headers) {
        validateHeader(header);
    }
    return Object.freeze({
        host,
        port,
        path,
        headers: Object.freeze([...headers]),
        sensitiveValues: Object.freeze(headers.filter((header) => header.sensitive === true).map((header) => header.value)),
    });
}

function loopbackUrl(endpoint: ValidatedEndpoint): string {
    const host = endpoint.host.replace(/^\[|\]$/g, '');
    const authority = host.includes(':') ? '[' + host + ']' : host;
    return 'ws://' + authority + ':' + String(endpoint.port) + endpoint.path;
}

function mergeSanitizer(
    sanitizer: ExecClientDiagnosticSanitizerV1 | undefined,
    sensitiveValues: readonly string[],
): ExecClientDiagnosticSanitizerV1 | undefined {
    if (sensitiveValues.length === 0) return sanitizer;
    return Object.freeze({
        ...(sanitizer ?? {}),
        redactedValues: Object.freeze([
            ...(sanitizer?.redactedValues ?? []),
            ...sensitiveValues,
        ]),
    });
}

function createSanitizedPreviewReader(
    process: SpawnedLoopbackProcess,
    sanitizer: ExecClientDiagnosticSanitizerV1 | undefined,
): () => string | undefined {
    return () => {
        const preview = sanitizeExecDiagnosticText(process.readStderrPreview(), 4096, sanitizer);
        return preview.length > 0 ? preview : undefined;
    };
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw createPluginExecClientAbortError();
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
        };
        const settle = (callback: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };
        const timeout = setTimeout(() => settle(resolve), Math.max(0, ms));
        const onAbort = () => settle(() => reject(createPluginExecClientAbortError()));
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function waitForExitError(
    process: SpawnedLoopbackProcess,
    readStderrPreview: () => string | undefined,
): Promise<never> {
    return process.handle.exit.then((result) => {
        throw new PluginExecClientError(
            'PLUGIN_EXEC_CLIENT_EXITED',
            'Loopback WebSocket child exited before the client was ready (exitCode='
                + String(result.exitCode ?? 'null') + ', signal=' + String(result.signal ?? 'null') + ')',
            { stderrPreview: readStderrPreview() },
        );
    }, (error) => {
        throw new PluginExecClientError(
            'PLUGIN_EXEC_CLIENT_EXITED',
            'Loopback WebSocket child failed before the client was ready',
            { cause: error, stderrPreview: readStderrPreview() },
        );
    });
}

async function raceWithExit<T>(
    promise: Promise<T>,
    process: SpawnedLoopbackProcess,
    readStderrPreview: () => string | undefined,
): Promise<T> {
    return await Promise.race([
        promise,
        waitForExitError(process, readStderrPreview),
    ]);
}

async function rethrowProcessExitIfReady(
    error: unknown,
    process: SpawnedLoopbackProcess,
    readStderrPreview: () => string | undefined,
): Promise<never> {
    const exitError = await Promise.race<PluginExecClientError | null>([
        waitForExitError(process, readStderrPreview).catch((exitFailure: unknown) => (
            exitFailure instanceof PluginExecClientError
                ? exitFailure
                : new PluginExecClientError(
                    'PLUGIN_EXEC_CLIENT_EXITED',
                    'Loopback WebSocket child failed before the client was ready',
                    { cause: exitFailure, stderrPreview: readStderrPreview() },
                )
        )),
        delay(25).then(() => null),
    ]);
    if (exitError) throw exitError;
    throw error;
}

async function writeHandshakeFrames(
    handshake: ExecLoopbackWebSocketHandshakeV1,
    process: SpawnedLoopbackProcess,
): Promise<void> {
    const maxFrameBytes = handshake.response?.maxFrameBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    for (const frame of handshake.requestFrames) {
        const payloadLength = typeof frame === 'string' ? Buffer.byteLength(frame) : frame.byteLength;
        if (payloadLength > maxFrameBytes) {
            throw createPluginExecClientProtocolError('Loopback WebSocket handshake request exceeded the configured size limit');
        }
        await process.handle.writeStdin(encodeLoopbackHandshakeFrame(frame, handshake.byteOrder));
    }
}

async function readHandshakeResponse(
    handshake: ExecLoopbackWebSocketHandshakeV1,
    process: SpawnedLoopbackProcess,
    signal: AbortSignal | undefined,
    readStderrPreview: () => string | undefined,
): Promise<Uint8Array> {
    const response = handshake.response;
    return await readLoopbackHandshakeFrame({
        stdout: process.child.stdout,
        byteOrder: response?.byteOrder ?? handshake.byteOrder,
        maxFrameBytes: response?.maxFrameBytes,
        timeoutMs: response?.timeoutMs,
        signal,
        readStderrPreview,
    });
}

function toExecClientError(
    error: unknown,
    readStderrPreview: () => string | undefined,
): PluginExecClientError {
    if (error instanceof PluginExecClientError) return error;
    if (isAbortError(error)) return createPluginExecClientAbortError();
    if (isPluginError(error) && error.code === 'plugin_websocket_backpressure_exceeded') {
        return createBackpressureError(readStderrPreview());
    }
    return createPluginExecClientProtocolError('Loopback WebSocket transport failed', error, readStderrPreview());
}

function closeError(
    close: PluginWebSocketClose,
    readStderrPreview: () => string | undefined,
): Error | undefined {
    if (close.kind === 'remote' || close.kind === 'local') return undefined;
    if (close.kind === 'aborted') return createPluginExecClientAbortError();
    if (close.diagnostic?.code === 'plugin_websocket_backpressure_exceeded') {
        return createBackpressureError(readStderrPreview());
    }
    return createPluginExecClientProtocolError('Loopback WebSocket transport closed unexpectedly', close, readStderrPreview());
}

async function openSharedLoopbackWebSocket(
    endpoint: ValidatedEndpoint,
    limits: NormalizedLoopbackLimits,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    readStderrPreview: () => string | undefined,
): Promise<PluginWebSocketConnection> {
    if (signal?.aborted) throw createPluginExecClientAbortError();
    const deadline = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        deadline.abort(Object.freeze({ kind: 'loopbackConnectTimeout' }));
    }, timeoutMs);
    try {
        return await createPluginWebSocketConnection({
            url: loopbackUrl(endpoint),
            headers: endpoint.headers.map((header) => Object.freeze({
                name: header.name,
                value: header.value,
                ...(header.sensitive === true ? { sensitive: true } : {}),
            })),
            connectTimeoutMs: Math.min(60_000, Math.max(100, timeoutMs)),
            maxMessageBytes: limits.maxMessageBytes,
            maxPendingMessages: limits.maxPendingMessages,
            maxPendingBytes: limits.maxBufferedBytes,
            maxBufferedSendBytes: limits.maxBufferedBytes,
        }, {
            // The adapter's public signal only governs opening. The spawned
            // client signal remains authoritative after a successful upgrade;
            // use the private lifecycle slot for that longer-lived ownership.
            signal: deadline.signal,
            ...(signal ? { lifecycleSignal: signal } : {}),
        });
    } catch (error) {
        if (signal?.aborted) throw createPluginExecClientAbortError();
        if (timedOut) throw createConnectionTimeoutError(error, readStderrPreview());
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function connectWithRetry(
    endpoint: ValidatedEndpoint,
    connect: ExecLoopbackWebSocketConnectV1 | undefined,
    limits: NormalizedLoopbackLimits,
    signal: AbortSignal | undefined,
    readStderrPreview: () => string | undefined,
): Promise<PluginWebSocketConnection> {
    const timeoutMs = normalizePositiveInteger(connect?.timeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    const retryInitialDelayMs = normalizePositiveInteger(connect?.retryInitialDelayMs, DEFAULT_RETRY_INITIAL_DELAY_MS);
    const retryMaxDelayMs = normalizePositiveInteger(connect?.retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS);
    const deadline = Date.now() + timeoutMs;
    let nextDelay = retryInitialDelayMs;
    let lastError: unknown;

    for (;;) {
        try {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) throw createConnectionTimeoutError(lastError, readStderrPreview());
            return await openSharedLoopbackWebSocket(endpoint, limits, remainingMs, signal, readStderrPreview);
        } catch (error) {
            if (signal?.aborted) throw createPluginExecClientAbortError();
            if (!isRetryableReadinessError(error)) {
                throw toExecClientError(error, readStderrPreview);
            }
            lastError = error;
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) throw createConnectionTimeoutError(lastError, readStderrPreview());
            await delay(Math.min(nextDelay, remainingMs), signal);
            nextDelay = Math.min(nextDelay * 2, retryMaxDelayMs);
        }
    }
}

function createJsonClient(params: Readonly<{
    connection: PluginWebSocketConnection;
    maxMessageBytes: number;
    maxPendingMessages: number;
    maxBufferedBytes: number;
    readStderrPreview: () => string | undefined;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>): LoopbackWebSocketProcessClient {
    const subscribers = new Set<LoopbackWebSocketJsonMessageListenerV1>();
    let disposedError: Error | null = null;
    let closedSettled = false;
    let resolveClosed: () => void = () => undefined;
    let rejectClosed: (error: Error) => void = () => undefined;
    const closed = new Promise<void>((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
    });
    closed.catch(() => undefined);

    function settleClosed(error?: Error): void {
        if (closedSettled) return;
        closedSettled = true;
        if (error) {
            disposedError = error;
            rejectClosed(error);
            return;
        }
        disposedError = new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'Loopback WebSocket client is closed');
        resolveClosed();
    }

    function failClient(error: Error): void {
        if (closedSettled) return;
        settleClosed(error);
        params.connection.dispose();
    }

    async function deliverMessage(text: string): Promise<void> {
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch (error) {
            throw createPluginExecClientProtocolError('Loopback WebSocket message was not valid JSON', error, params.readStderrPreview());
        }
        let firstFailure: unknown;
        for (const listener of [...subscribers]) {
            try {
                await listener(value);
            } catch (error) {
                firstFailure ??= error;
            }
        }
        if (firstFailure !== undefined) throw firstFailure;
    }

    const deliveryQueue = createPluginProtocolCallbackQueue({
        maxPendingCallbacks: params.maxPendingMessages,
        maxPendingBytes: params.maxBufferedBytes,
        ...(params.recordRuntimeLimitMeasurement
            ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
            : {}),
        onFailure(failure) {
            if (failure.code === 'PLUGIN_EXEC_CLIENT_BACKPRESSURE_EXCEEDED') {
                failClient(createBackpressureError(params.readStderrPreview()));
                return;
            }
            if (
                failure.cause instanceof PluginExecClientError
                && failure.cause.code === 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR'
            ) {
                failClient(failure.cause);
                return;
            }
            failClient(createPluginExecClientProtocolError(
                'Loopback WebSocket subscriber failed',
                failure.cause,
                params.readStderrPreview(),
            ));
        },
    });

    async function receiveMessages(): Promise<void> {
        while (!closedSettled) {
            try {
                const result = await params.connection.receive();
                if (closedSettled) return;
                if (result.kind === 'closed') {
                    settleClosed(closeError(result.close, params.readStderrPreview));
                    return;
                }
                if (result.kind !== 'text') {
                    failClient(createPluginExecClientProtocolError('Loopback WebSocket received an unsupported message type', undefined, params.readStderrPreview()));
                    return;
                }
                const bytes = Buffer.byteLength(result.text, 'utf8');
                if (bytes > params.maxMessageBytes) {
                    failClient(createPluginExecClientProtocolError('Loopback WebSocket message exceeded the configured size limit', undefined, params.readStderrPreview()));
                    return;
                }
                deliveryQueue.enqueue(bytes, () => deliverMessage(result.text));
            } catch (error) {
                failClient(toExecClientError(error, params.readStderrPreview));
                return;
            }
        }
    }
    void receiveMessages();

    const client: LoopbackWebSocketJsonClientV1 = Object.freeze({
        closed,
        subscribe(listener) {
            subscribers.add(listener);
            return () => {
                subscribers.delete(listener);
            };
        },
        async sendJson(message, options) {
            if (disposedError) throw disposedError;
            if (options?.signal?.aborted) throw createPluginExecClientAbortError();
            const text = JSON.stringify(message);
            if (Buffer.byteLength(text, 'utf8') > params.maxMessageBytes) {
                throw createPluginExecClientProtocolError('Loopback WebSocket message exceeded the configured size limit', undefined, params.readStderrPreview());
            }
            try {
                await params.connection.send({ kind: 'text', text }, options);
            } catch (error) {
                const mapped = toExecClientError(error, params.readStderrPreview);
                if (mapped.code === 'PLUGIN_EXEC_CLIENT_BACKPRESSURE_EXCEEDED') {
                    failClient(mapped);
                }
                throw mapped;
            }
        },
    });

    return Object.freeze({
        client,
        dispose(error = new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'Loopback WebSocket client was disposed')) {
            failClient(error);
        },
        settleExit(error) {
            failClient(error);
        },
    });
}

export async function createLoopbackWebSocketJsonClient(
    params: CreateLoopbackWebSocketJsonClientParams,
): Promise<LoopbackWebSocketProcessClient> {
    const validatedEndpoint = validateEndpoint(params.endpoint, params.headers ?? []);
    const readStderrPreview = params.readDiagnosticPreview ?? (() => undefined);
    const limits = normalizeLimits(params.limits);
    const connection = await connectWithRetry(
        validatedEndpoint,
        params.connect,
        limits,
        params.signal,
        readStderrPreview,
    );
    return createJsonClient({
        connection,
        ...limits,
        readStderrPreview,
        ...(params.recordRuntimeLimitMeasurement
            ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
            : {}),
    });
}

export async function createLoopbackWebSocketProcessClient(
    params: CreateLoopbackWebSocketProcessClientParams,
): Promise<LoopbackWebSocketProcessClient> {
    return await createLoopbackWebSocketHandshakeClient({
        handshake: params.spec.transport.handshake,
        endpoint: params.spec.protocol.endpoint,
        ...(params.spec.transport.connect ? { connect: params.spec.transport.connect } : {}),
        ...(params.spec.transport.limits ? { limits: params.spec.transport.limits } : {}),
        ...(params.spec.lifecycle?.diagnostics?.sanitizer
            ? { sanitizer: params.spec.lifecycle.diagnostics.sanitizer }
            : {}),
        process: params.process,
        ...(params.optionsSignal ? { optionsSignal: params.optionsSignal } : {}),
        ...(params.recordRuntimeLimitMeasurement
            ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
            : {}),
    });
}

export async function createLoopbackWebSocketHandshakeClient<
    TEndpoint extends ExecLoopbackWebSocketEndpointV1,
>(
    params: CreateLoopbackWebSocketHandshakeClientParams<TEndpoint>,
): Promise<LoopbackWebSocketProcessClient> {
    const initialPreview = createSanitizedPreviewReader(params.process, params.sanitizer);
    const responsePromise = raceWithExit(
        readHandshakeResponse(params.handshake, params.process, params.optionsSignal, initialPreview),
        params.process,
        initialPreview,
    ).catch((error: unknown) => rethrowProcessExitIfReady(error, params.process, initialPreview));
    try {
        await raceWithExit(writeHandshakeFrames(params.handshake, params.process), params.process, initialPreview);
    } catch (error) {
        void responsePromise.catch(() => undefined);
        throw error;
    }
    const response = await responsePromise;
    const endpoint = await params.endpoint.decodeHandshakeResponse(response);
    const headers = params.endpoint.buildHeaders?.(endpoint) ?? [];
    const validatedEndpoint = validateEndpoint(endpoint, headers);
    const sanitizer = mergeSanitizer(params.sanitizer, validatedEndpoint.sensitiveValues);
    const readStderrPreview = createSanitizedPreviewReader(params.process, sanitizer);
    const limits = normalizeLimits(params.limits);
    const connection = await raceWithExit(
        connectWithRetry(
            validatedEndpoint,
            params.connect,
            limits,
            params.optionsSignal,
            readStderrPreview,
        ),
        params.process,
        readStderrPreview,
    );
    return createJsonClient({
        connection,
        ...limits,
        readStderrPreview,
        ...(params.recordRuntimeLimitMeasurement
            ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
            : {}),
    });
}

export async function disposeLoopbackWebSocketProcess(params: Readonly<{
    process: SpawnedLoopbackProcess;
    spec: ExecLoopbackWebSocketJsonClientSpecV1;
}>): Promise<void> {
    if (params.spec.transport.shutdown?.kind !== 'close-stdin') {
        await params.process.handle.dispose();
        return;
    }
    const graceMs = normalizePositiveInteger(params.spec.transport.shutdown.graceMs, DEFAULT_SHUTDOWN_GRACE_MS);
    params.process.child.stdin.end();
    await Promise.race([
        params.process.handle.exit.catch(() => undefined),
        delay(graceMs).catch(() => undefined),
    ]);
    await params.process.handle.dispose();
}
