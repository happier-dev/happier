import { createHash, randomBytes } from 'node:crypto';
import { connect as connectSocket, type Socket } from 'node:net';

import type {
    ExecClientDiagnosticSanitizerV1,
    ExecLoopbackWebSocketConnectV1,
    ExecLoopbackWebSocketEndpointV1,
    ExecLoopbackWebSocketHeaderV1,
    ExecLoopbackWebSocketJsonClientSpecV1,
    ExecLoopbackWebSocketLimitsV1,
    ExecProcessHandleV1,
    ExecRunResultV1,
    LoopbackWebSocketJsonClientV1,
    LoopbackWebSocketJsonMessageListenerV1,
} from '@happier-dev/plugin-sdk';

import {
    PluginExecClientError,
    createPluginExecClientAbortError,
    sanitizeExecDiagnosticText,
} from './errors';
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
}>;

export type CreateLoopbackWebSocketJsonClientParams = Readonly<{
    endpoint: ExecLoopbackWebSocketEndpointV1;
    headers?: readonly ExecLoopbackWebSocketHeaderV1[];
    connect?: ExecLoopbackWebSocketConnectV1;
    limits?: ExecLoopbackWebSocketLimitsV1;
    signal?: AbortSignal;
    readDiagnosticPreview?: () => string | undefined;
}>;

type ValidatedEndpoint = Readonly<{
    host: string;
    port: number;
    path: string;
    headers: readonly ExecLoopbackWebSocketHeaderV1[];
    sensitiveValues: readonly string[];
}>;

type RawWebSocketConnection = Readonly<{
    socket: Socket;
    sendText(text: string): void;
    close(error?: Error): void;
    onMessage(listener: (text: string) => void): void;
    onClose(listener: (error?: Error) => void): void;
    bufferedBytes(): number;
}>;

const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 10;
const DEFAULT_RETRY_MAX_DELAY_MS = 50;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_MESSAGES = 64;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 250;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SAFE_ORIGIN_FORM_PATH_PATTERN = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*(?:\?[A-Za-z0-9\-._~!$&'()*+,;=:@/%?]*)?$/;

function createProtocolError(message: string, cause?: unknown, stderrPreview?: string): PluginExecClientError {
    return new PluginExecClientError('PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR', message, { cause, stderrPreview });
}

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
    if (!error || typeof error !== 'object') {
        return null;
    }
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
}

function readErrorCause(error: unknown): unknown {
    if (!error || typeof error !== 'object') {
        return null;
    }
    return (error as { cause?: unknown }).cause;
}

function isRetryableReadinessError(error: unknown): boolean {
    if (!(error instanceof PluginExecClientError)) {
        return false;
    }
    if (error.code !== 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR') {
        return false;
    }
    return readNodeErrorCode(readErrorCause(error)) === 'ECONNREFUSED';
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : fallback;
}

function isLoopbackHost(host: string): boolean {
    const normalized = host.toLowerCase();
    return normalized === '127.0.0.1'
        || normalized === 'localhost'
        || normalized === '::1'
        || normalized === '[::1]';
}

function readPath(parsed: URL): string {
    return `${parsed.pathname || '/'}${parsed.search}`;
}

function isSafeAbsolutePath(path: string): boolean {
    return SAFE_ORIGIN_FORM_PATH_PATTERN.test(path);
}

function validateHeader(header: ExecLoopbackWebSocketHeaderV1): void {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header.name)) {
        throw createProtocolError('Loopback WebSocket header name is invalid');
    }
    if (/[\r\n]/.test(header.value)) {
        throw createProtocolError('Loopback WebSocket header value is invalid');
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
            throw createProtocolError('Loopback WebSocket endpoint URL must not include credentials');
        }
        protocol = parsed.protocol.replace(/:$/, '');
        host = parsed.hostname;
        port = parsed.port.length > 0 ? Number(parsed.port) : undefined;
        path = readPath(parsed);
    }

    if (protocol !== 'ws') {
        throw createProtocolError('Loopback WebSocket endpoint must use ws protocol');
    }
    if (!isLoopbackHost(host)) {
        throw createProtocolError('Loopback WebSocket endpoint host must be loopback-only');
    }
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
        throw createProtocolError('Loopback WebSocket endpoint port must be an integer user-space port');
    }
    if (!isSafeAbsolutePath(path)) {
        throw createProtocolError('Loopback WebSocket endpoint path must be a safe absolute path/query form');
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

function mergeSanitizer(
    sanitizer: ExecClientDiagnosticSanitizerV1 | undefined,
    sensitiveValues: readonly string[],
): ExecClientDiagnosticSanitizerV1 | undefined {
    if (sensitiveValues.length === 0) {
        return sanitizer;
    }
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
    if (signal?.aborted) {
        throw createPluginExecClientAbortError();
    }
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
        };
        const settle = (callback: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            callback();
        };
        const timeout = setTimeout(() => {
            settle(resolve);
        }, Math.max(0, ms));
        const onAbort = () => {
            settle(() => {
                reject(createPluginExecClientAbortError());
            });
        };
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
            `Loopback WebSocket child exited before the client was ready (exitCode=${result.exitCode ?? 'null'}, signal=${result.signal ?? 'null'})`,
            { stderrPreview: readStderrPreview() },
        );
    }, (error) => {
        throw new PluginExecClientError(
            'PLUGIN_EXEC_CLIENT_EXITED',
            'Loopback WebSocket child failed before the client was ready',
            {
                cause: error,
                stderrPreview: readStderrPreview(),
            },
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
        waitForExitError(process, readStderrPreview).catch((exitFailure: unknown) => {
            if (exitFailure instanceof PluginExecClientError) {
                return exitFailure;
            }
            return new PluginExecClientError(
                'PLUGIN_EXEC_CLIENT_EXITED',
                'Loopback WebSocket child failed before the client was ready',
                {
                    cause: exitFailure,
                    stderrPreview: readStderrPreview(),
                },
            );
        }),
        delay(25).then(() => null),
    ]);
    if (exitError) {
        throw exitError;
    }
    throw error;
}

async function writeHandshakeFrames(
    spec: ExecLoopbackWebSocketJsonClientSpecV1,
    process: SpawnedLoopbackProcess,
): Promise<void> {
    const maxFrameBytes = spec.transport.handshake.response?.maxFrameBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    for (const frame of spec.transport.handshake.requestFrames) {
        const payloadLength = typeof frame === 'string'
            ? Buffer.byteLength(frame)
            : frame.byteLength;
        if (payloadLength > maxFrameBytes) {
            throw createProtocolError('Loopback WebSocket handshake request exceeded the configured size limit');
        }
        await process.handle.writeStdin(encodeLoopbackHandshakeFrame(frame, spec.transport.handshake.byteOrder));
    }
}

async function readHandshakeResponse(
    spec: ExecLoopbackWebSocketJsonClientSpecV1,
    process: SpawnedLoopbackProcess,
    signal: AbortSignal | undefined,
    readStderrPreview: () => string | undefined,
): Promise<Uint8Array> {
    const response = spec.transport.handshake.response;
    return await readLoopbackHandshakeFrame({
        stdout: process.child.stdout,
        byteOrder: response?.byteOrder ?? spec.transport.handshake.byteOrder,
        maxFrameBytes: response?.maxFrameBytes,
        timeoutMs: response?.timeoutMs,
        signal,
        readStderrPreview,
    });
}

function buildUpgradeRequest(endpoint: ValidatedEndpoint, key: string): Buffer {
    const hostHeader = endpoint.host.includes(':')
        ? `[${endpoint.host.replace(/^\[|\]$/g, '')}]:${endpoint.port}`
        : `${endpoint.host}:${endpoint.port}`;
    const lines = [
        `GET ${endpoint.path} HTTP/1.1`,
        `Host: ${hostHeader}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        ...endpoint.headers.map((header) => `${header.name}: ${header.value}`),
        '',
        '',
    ];
    return Buffer.from(lines.join('\r\n'), 'utf8');
}

function expectedAcceptKey(key: string): string {
    return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

function encodeClientTextFrame(text: string): Buffer {
    const payload = Buffer.from(text, 'utf8');
    const length = payload.byteLength;
    const mask = randomBytes(4);
    let header: Buffer;
    if (length < 126) {
        header = Buffer.from([0x81, 0x80 | length]);
    } else if (length <= 0xffff) {
        header = Buffer.allocUnsafe(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.allocUnsafe(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }
    const masked = Buffer.from(payload);
    for (let index = 0; index < masked.length; index += 1) {
        masked[index] = masked[index] ^ mask[index % 4];
    }
    return Buffer.concat([header, mask, masked]);
}

function encodeControlFrame(opcode: number, payload: Buffer<ArrayBufferLike> = Buffer.alloc(0)): Buffer {
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.byteLength]), payload]);
}

function tryDecodeServerFrame(buffer: Buffer<ArrayBufferLike>, maxMessageBytes: number): null | Readonly<{
    opcode: number;
    payload: Buffer<ArrayBufferLike>;
    rest: Buffer<ArrayBufferLike>;
}> {
    if (buffer.byteLength < 2) {
        return null;
    }
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
        if (buffer.byteLength < offset + 2) {
            return null;
        }
        length = buffer.readUInt16BE(offset);
        offset += 2;
    } else if (length === 127) {
        if (buffer.byteLength < offset + 8) {
            return null;
        }
        const wideLength = buffer.readBigUInt64BE(offset);
        if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw createProtocolError('Loopback WebSocket message exceeded the configured size limit');
        }
        length = Number(wideLength);
        offset += 8;
    }
    if (length > maxMessageBytes) {
        throw createProtocolError('Loopback WebSocket message exceeded the configured size limit');
    }
    const maskOffset = offset;
    offset += masked ? 4 : 0;
    if (buffer.byteLength < offset + length) {
        return null;
    }
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        for (let index = 0; index < payload.length; index += 1) {
            payload[index] = payload[index] ^ mask[index % 4];
        }
    }
    return Object.freeze({
        opcode,
        payload,
        rest: buffer.subarray(offset + length),
    });
}

async function openRawWebSocket(
    endpoint: ValidatedEndpoint,
    maxMessageBytes: number,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    readStderrPreview: () => string | undefined,
): Promise<RawWebSocketConnection> {
    if (signal?.aborted) {
        throw createPluginExecClientAbortError();
    }
    const key = randomBytes(16).toString('base64');
    const socket = connectSocket({
        host: endpoint.host.replace(/^\[|\]$/g, ''),
        port: endpoint.port,
    });

    return await new Promise<RawWebSocketConnection>((resolve, reject) => {
        let settled = false;
        let upgradeBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let frameBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let closedError: Error | undefined;
        const messageListeners = new Set<(text: string) => void>();
        const closeListeners = new Set<(error?: Error) => void>();
        const timeout = setTimeout(() => {
            fail(createConnectionTimeoutError(undefined, readStderrPreview()));
        }, timeoutMs);
        timeout.unref?.();

        function cleanupConnectListeners(): void {
            clearTimeout(timeout);
            socket.off('connect', onConnect);
            socket.off('data', onUpgradeData);
            socket.off('error', onConnectError);
            socket.off('close', onConnectClose);
            signal?.removeEventListener('abort', onAbort);
        }

        function fail(error: Error): void {
            if (settled) {
                return;
            }
            settled = true;
            cleanupConnectListeners();
            socket.destroy();
            reject(error);
        }

        function onAbort(): void {
            fail(createPluginExecClientAbortError());
        }

        function onConnect(): void {
            socket.write(buildUpgradeRequest(endpoint, key));
        }

        function onConnectError(error: unknown): void {
            fail(createProtocolError('Loopback WebSocket connection failed', error, readStderrPreview()));
        }

        function onConnectClose(): void {
            fail(createProtocolError('Loopback WebSocket closed before upgrade completed', undefined, readStderrPreview()));
        }

        function notifyClose(error?: Error): void {
            if (closedError) {
                return;
            }
            closedError = error ?? new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'Loopback WebSocket closed');
            for (const listener of [...closeListeners]) {
                listener(error);
            }
        }

        function handleFrameData(chunk: Buffer): void {
            if (closedError) {
                return;
            }
            frameBuffer = Buffer.concat([frameBuffer, chunk]);
            if (frameBuffer.byteLength > maxMessageBytes * 2) {
                notifyClose(createProtocolError('Loopback WebSocket buffered data exceeded the configured size limit', undefined, readStderrPreview()));
                socket.destroy();
                return;
            }
            try {
                for (;;) {
                    const decoded = tryDecodeServerFrame(frameBuffer, maxMessageBytes);
                    if (!decoded) {
                        return;
                    }
                    frameBuffer = decoded.rest;
                    if (decoded.opcode === 0x8) {
                        socket.end(encodeControlFrame(0x8));
                        notifyClose();
                        return;
                    }
                    if (decoded.opcode === 0x9) {
                        socket.write(encodeControlFrame(0xA, decoded.payload));
                        continue;
                    }
                    if (decoded.opcode !== 0x1) {
                        notifyClose(createProtocolError('Loopback WebSocket received an unsupported frame type', undefined, readStderrPreview()));
                        socket.destroy();
                        return;
                    }
                    const text = decoded.payload.toString('utf8');
                    for (const listener of [...messageListeners]) {
                        listener(text);
                    }
                }
            } catch (error) {
                notifyClose(error instanceof Error ? error : createProtocolError(String(error), undefined, readStderrPreview()));
                socket.destroy();
            }
        }

        function resolveConnection(rest: Buffer): void {
            if (settled) {
                return;
            }
            settled = true;
            cleanupConnectListeners();
            socket.on('data', handleFrameData);
            socket.on('error', (error) => {
                notifyClose(createProtocolError('Loopback WebSocket socket failed', error, readStderrPreview()));
            });
            socket.on('close', () => {
                notifyClose();
            });
            const connection: RawWebSocketConnection = Object.freeze({
                socket,
                sendText(text) {
                    if (closedError) {
                        throw closedError;
                    }
                    socket.write(encodeClientTextFrame(text));
                },
                close(error?: Error) {
                    if (!socket.destroyed) {
                        socket.end(encodeControlFrame(0x8));
                        setTimeout(() => {
                            if (!socket.destroyed) {
                                socket.destroy();
                            }
                        }, 50).unref?.();
                    }
                    notifyClose(error);
                },
                onMessage(listener) {
                    messageListeners.add(listener);
                },
                onClose(listener) {
                    closeListeners.add(listener);
                },
                bufferedBytes() {
                    return socket.writableLength;
                },
            });
            resolve(connection);
            if (rest.byteLength > 0) {
                handleFrameData(rest);
            }
        }

        function onUpgradeData(chunk: Buffer): void {
            upgradeBuffer = Buffer.concat([upgradeBuffer, chunk]);
            const headerEnd = upgradeBuffer.indexOf('\r\n\r\n');
            if (headerEnd < 0) {
                if (upgradeBuffer.byteLength > 8192) {
                    fail(createProtocolError('Loopback WebSocket upgrade response exceeded the configured size limit', undefined, readStderrPreview()));
                }
                return;
            }
            const headerText = upgradeBuffer.subarray(0, headerEnd).toString('latin1');
            const [statusLine, ...headerLines] = headerText.split('\r\n');
            if (!/^HTTP\/1\.[01] 101(?:\s|$)/.test(statusLine ?? '')) {
                fail(createProtocolError('Loopback WebSocket upgrade was rejected', undefined, readStderrPreview()));
                return;
            }
            const headers = new Map<string, string>();
            for (const line of headerLines) {
                const separator = line.indexOf(':');
                if (separator > 0) {
                    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
                }
            }
            if (headers.get('sec-websocket-accept') !== expectedAcceptKey(key)) {
                fail(createProtocolError('Loopback WebSocket upgrade accept key was invalid', undefined, readStderrPreview()));
                return;
            }
            resolveConnection(upgradeBuffer.subarray(headerEnd + 4));
        }

        socket.on('connect', onConnect);
        socket.on('data', onUpgradeData);
        socket.once('error', onConnectError);
        socket.once('close', onConnectClose);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

async function connectWithRetry(
    endpoint: ValidatedEndpoint,
    connect: ExecLoopbackWebSocketConnectV1 | undefined,
    maxMessageBytes: number,
    signal: AbortSignal | undefined,
    readStderrPreview: () => string | undefined,
): Promise<RawWebSocketConnection> {
    const timeoutMs = normalizePositiveInteger(connect?.timeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    const retryInitialDelayMs = normalizePositiveInteger(connect?.retryInitialDelayMs, DEFAULT_RETRY_INITIAL_DELAY_MS);
    const retryMaxDelayMs = normalizePositiveInteger(connect?.retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS);
    const deadline = Date.now() + timeoutMs;
    let nextDelay = retryInitialDelayMs;
    let lastError: unknown;

    for (;;) {
        try {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                throw createConnectionTimeoutError(lastError, readStderrPreview());
            }
            return await openRawWebSocket(endpoint, maxMessageBytes, remainingMs, signal, readStderrPreview);
        } catch (error) {
            if (signal?.aborted) {
                throw createPluginExecClientAbortError();
            }
            if (!isRetryableReadinessError(error)) {
                throw error;
            }
            lastError = error;
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                throw createConnectionTimeoutError(lastError, readStderrPreview());
            }
            await delay(Math.min(nextDelay, remainingMs), signal);
            nextDelay = Math.min(nextDelay * 2, retryMaxDelayMs);
        }
    }
}

function createJsonClient(params: Readonly<{
    connection: RawWebSocketConnection;
    maxMessageBytes: number;
    maxPendingMessages: number;
    maxBufferedBytes: number;
    readStderrPreview: () => string | undefined;
}>): LoopbackWebSocketProcessClient {
    const subscribers = new Set<LoopbackWebSocketJsonMessageListenerV1>();
    let disposedError: Error | null = null;
    let closedSettled = false;
    let pendingMessages = 0;
    let deliveryQueue = Promise.resolve();
    let resolveClosed: () => void = () => undefined;
    let rejectClosed: (error: Error) => void = () => undefined;
    const closed = new Promise<void>((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
    });
    closed.catch(() => undefined);

    function settleClosed(error?: Error): void {
        if (closedSettled) {
            return;
        }
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
        if (closedSettled) {
            return;
        }
        params.connection.close(error);
        settleClosed(error);
    }

    async function deliverMessage(text: string): Promise<void> {
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch (error) {
            throw createProtocolError('Loopback WebSocket message was not valid JSON', error, params.readStderrPreview());
        }
        try {
            for (const listener of [...subscribers]) {
                await listener(value);
            }
        } finally {
            pendingMessages -= 1;
        }
    }

    params.connection.onMessage((text) => {
        if (closedSettled) {
            return;
        }
        if (Buffer.byteLength(text, 'utf8') > params.maxMessageBytes) {
            failClient(createProtocolError('Loopback WebSocket message exceeded the configured size limit', undefined, params.readStderrPreview()));
            return;
        }
        pendingMessages += 1;
        if (pendingMessages > params.maxPendingMessages) {
            failClient(createBackpressureError(params.readStderrPreview()));
            return;
        }
        deliveryQueue = deliveryQueue
            .then(() => deliverMessage(text))
            .catch((error) => {
                failClient(error instanceof Error ? error : createProtocolError(String(error), undefined, params.readStderrPreview()));
            });
    });

    params.connection.onClose((error) => {
        settleClosed(error);
    });

    const client: LoopbackWebSocketJsonClientV1 = Object.freeze({
        closed,
        subscribe(listener) {
            subscribers.add(listener);
            return () => {
                subscribers.delete(listener);
            };
        },
        async sendJson(message, options) {
            if (disposedError) {
                throw disposedError;
            }
            if (options?.signal?.aborted) {
                throw createPluginExecClientAbortError();
            }
            const text = JSON.stringify(message);
            if (Buffer.byteLength(text, 'utf8') > params.maxMessageBytes) {
                throw createProtocolError('Loopback WebSocket message exceeded the configured size limit', undefined, params.readStderrPreview());
            }
            if (params.connection.bufferedBytes() + Buffer.byteLength(text, 'utf8') > params.maxBufferedBytes) {
                const error = createBackpressureError(params.readStderrPreview());
                failClient(error);
                throw error;
            }
            params.connection.sendText(text);
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
    const maxMessageBytes = normalizePositiveInteger(params.limits?.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES);
    const connection = await connectWithRetry(
        validatedEndpoint,
        params.connect,
        maxMessageBytes,
        params.signal,
        readStderrPreview,
    );
    return createJsonClient({
        connection,
        maxMessageBytes,
        maxPendingMessages: normalizePositiveInteger(params.limits?.maxPendingMessages, DEFAULT_MAX_PENDING_MESSAGES),
        maxBufferedBytes: normalizePositiveInteger(params.limits?.maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES),
        readStderrPreview,
    });
}

export async function createLoopbackWebSocketProcessClient(
    params: CreateLoopbackWebSocketProcessClientParams,
): Promise<LoopbackWebSocketProcessClient> {
    const initialPreview = createSanitizedPreviewReader(params.process, params.spec.lifecycle?.diagnostics?.sanitizer);
    const responsePromise = raceWithExit(
        readHandshakeResponse(params.spec, params.process, params.optionsSignal, initialPreview),
        params.process,
        initialPreview,
    ).catch((error: unknown) => rethrowProcessExitIfReady(error, params.process, initialPreview));
    try {
        await raceWithExit(writeHandshakeFrames(params.spec, params.process), params.process, initialPreview);
    } catch (error) {
        void responsePromise.catch(() => undefined);
        throw error;
    }
    const response = await responsePromise;
    const endpoint = await params.spec.protocol.endpoint.decodeHandshakeResponse(response);
    const headers = params.spec.protocol.endpoint.buildHeaders?.(endpoint) ?? [];
    const validatedEndpoint = validateEndpoint(endpoint, headers);
    const sanitizer = mergeSanitizer(params.spec.lifecycle?.diagnostics?.sanitizer, validatedEndpoint.sensitiveValues);
    const readStderrPreview = createSanitizedPreviewReader(params.process, sanitizer);
    const maxMessageBytes = normalizePositiveInteger(params.spec.transport.limits?.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES);
    const connection = await raceWithExit(
        connectWithRetry(
            validatedEndpoint,
            params.spec.transport.connect,
            maxMessageBytes,
            params.optionsSignal,
            readStderrPreview,
        ),
        params.process,
        readStderrPreview,
    );
    return createJsonClient({
        connection,
        maxMessageBytes,
        maxPendingMessages: normalizePositiveInteger(params.spec.transport.limits?.maxPendingMessages, DEFAULT_MAX_PENDING_MESSAGES),
        maxBufferedBytes: normalizePositiveInteger(params.spec.transport.limits?.maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES),
        readStderrPreview,
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
