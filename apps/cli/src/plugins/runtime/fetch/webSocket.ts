import { isIP, type LookupFunction } from 'node:net';

import { PluginError } from '@happier-dev/plugin-sdk';
import type {
    PluginDiagnosticData,
    PluginCancellationOptions,
} from '@happier-dev/plugin-sdk';
import type {
    PluginWebSocketClose,
    PluginWebSocketConnection,
    PluginWebSocketMessage,
    PluginWebSocketOpenInput,
} from '@happier-dev/plugin-sdk/http';
import WebSocket from 'ws';

export type PluginWebSocketRuntimeOptions = PluginCancellationOptions & Readonly<{
    /** Host-owned lifecycle signal; never exposed through the public SDK. */
    lifecycleSignal?: AbortSignal;
    /** Exact address set admitted for this socket open; never exposed through the public SDK. */
    validatedAddresses?: readonly string[];
}>;

export type NormalizedPluginWebSocketOpenInput = Readonly<{
    url: URL;
    targetOrigin: string;
    protocols: readonly string[];
    headers: Readonly<Record<string, string>>;
    connectTimeoutMs: number;
    maxMessageBytes: number;
    maxPendingMessages: number;
    maxPendingBytes: number;
    maxBufferedSendBytes: number;
}>;

const MAX_URL_BYTES = 8 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const MIN_CONNECT_TIMEOUT_MS = 100;
const MAX_CONNECT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PENDING_MESSAGES = 64;
const MAX_MAX_PENDING_MESSAGES = 1024;
const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_MAX_PENDING_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_SEND_BYTES = 1024 * 1024;
const MAX_MAX_BUFFERED_SEND_BYTES = 16 * 1024 * 1024;
const MAX_WEBSOCKET_PROTOCOLS = 16;
const MAX_FRAGMENTS = 1024;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const WEBSOCKET_PROTOCOL_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RESERVED_HANDSHAKE_HEADERS = new Set([
    'connection',
    'host',
    'sec-websocket-extensions',
    'sec-websocket-key',
    'sec-websocket-protocol',
    'sec-websocket-version',
    'upgrade',
]);
const TLS_DRIVER_ERROR_CODES = new Set([
    'CERT_CHAIN_TOO_LONG',
    'CERT_HAS_EXPIRED',
    'CERT_REJECTED',
    'CERT_REVOKED',
    'CERT_SIGNATURE_FAILURE',
    'CERT_UNTRUSTED',
    'CERT_NOT_YET_VALID',
    'CRL_HAS_EXPIRED',
    'CRL_NOT_YET_VALID',
    'CRL_SIGNATURE_FAILURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERROR_IN_CERT_NOT_AFTER_FIELD',
    'ERROR_IN_CERT_NOT_BEFORE_FIELD',
    'ERROR_IN_CRL_LAST_UPDATE_FIELD',
    'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'HOSTNAME_MISMATCH',
    'INVALID_CA',
    'INVALID_PURPOSE',
    'PATH_LENGTH_EXCEEDED',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
    'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
    'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
    'UNABLE_TO_GET_CRL',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

type CloseIntent = Readonly<{
    kind: PluginWebSocketClose['kind'];
    code?: number;
    reason?: string;
    wasClean: boolean;
    diagnostic?: PluginDiagnosticData;
}>;

function pluginWebSocketError(code: string, message: string, cause?: unknown): PluginError {
    return new PluginError({ code, message }, cause === undefined ? undefined : { cause });
}

function createAbortError(): Error {
    const error = new Error('Plugin WebSocket operation was aborted');
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) throw createAbortError();
}

function byteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

function readBoundedPositiveInteger(
    value: number | undefined,
    fallback: number,
    min: number,
    max: number,
    name: string,
): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw pluginWebSocketError(
            'plugin_websocket_invalid_limit',
            `Plugin WebSocket ${name} must be an integer between ${min} and ${max}`,
        );
    }
    return value;
}

function isLoopbackHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') return true;
    if (isIP(normalized) !== 4) return false;
    return Number(normalized.split('.')[0]) === 127;
}

function normalizeProtocols(protocols: readonly string[] | undefined): readonly string[] {
    const values = protocols ?? Object.freeze([]);
    if (values.length > MAX_WEBSOCKET_PROTOCOLS) {
        throw pluginWebSocketError(
            'plugin_websocket_invalid_protocol',
            `Plugin WebSocket accepts at most ${MAX_WEBSOCKET_PROTOCOLS} subprotocols`,
        );
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const protocol of values) {
        if (typeof protocol !== 'string' || protocol.length === 0 || !WEBSOCKET_PROTOCOL_PATTERN.test(protocol)) {
            throw pluginWebSocketError(
                'plugin_websocket_invalid_protocol',
                'Plugin WebSocket subprotocols must be RFC token values',
            );
        }
        if (seen.has(protocol)) {
            throw pluginWebSocketError(
                'plugin_websocket_invalid_protocol',
                'Plugin WebSocket subprotocols must be unique',
            );
        }
        seen.add(protocol);
        normalized.push(protocol);
    }
    return Object.freeze(normalized);
}

function headerLineByteLength(name: string, value: string): number {
    return byteLength(`${name}: ${value}\r\n`);
}

type NormalizedPluginWebSocketHeaders = Readonly<{
    headers: Readonly<Record<string, string>>;
    byteLength: number;
}>;

function normalizeHeaders(headers: PluginWebSocketOpenInput['headers']): NormalizedPluginWebSocketHeaders {
    const seen = new Set<string>();
    const output: Record<string, string> = {};
    let totalBytes = 0;
    for (const header of headers ?? Object.freeze([])) {
        if (
            !header
            || typeof header.name !== 'string'
            || typeof header.value !== 'string'
            || !HEADER_NAME_PATTERN.test(header.name)
            || /[\r\n]/.test(header.name)
            || /[\r\n]/.test(header.value)
        ) {
            throw pluginWebSocketError(
                'plugin_websocket_invalid_header',
                'Plugin WebSocket headers must use valid names and CRLF-free values',
            );
        }
        const normalizedName = header.name.toLowerCase();
        if (RESERVED_HANDSHAKE_HEADERS.has(normalizedName) || normalizedName.startsWith('sec-websocket-')) {
            throw pluginWebSocketError(
                'plugin_websocket_invalid_header',
                'Plugin WebSocket cannot override host-owned handshake headers',
            );
        }
        if (seen.has(normalizedName)) {
            throw pluginWebSocketError(
                'plugin_websocket_invalid_header',
                'Plugin WebSocket headers must be unique by name',
            );
        }
        seen.add(normalizedName);
        totalBytes += headerLineByteLength(header.name, header.value);
        if (totalBytes > MAX_HEADER_BYTES) {
            throw pluginWebSocketError(
                'plugin_websocket_invalid_header',
                'Plugin WebSocket headers exceed the 64 KiB handshake limit',
            );
        }
        output[header.name] = header.value;
    }
    return Object.freeze({
        headers: Object.freeze(output),
        byteLength: totalBytes,
    });
}

function assertHandshakeHeaderLimit(protocols: readonly string[], customHeaderBytes: number): void {
    const protocolHeaderBytes = protocols.length === 0
        ? 0
        : headerLineByteLength('Sec-WebSocket-Protocol', protocols.join(','));
    if (customHeaderBytes + protocolHeaderBytes > MAX_HEADER_BYTES) {
        throw pluginWebSocketError(
            'plugin_websocket_invalid_header',
            'Plugin WebSocket headers exceed the 64 KiB handshake limit',
        );
    }
}

/** Maps ws/wss endpoints to the canonical declared HTTP(S) target origin. */
export function webSocketTargetOrigin(url: URL): string {
    const protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    return `${protocol}//${url.host}`;
}

export function normalizePluginWebSocketOpenInput(
    input: PluginWebSocketOpenInput,
): NormalizedPluginWebSocketOpenInput {
    if (!input || typeof input.url !== 'string' || byteLength(input.url) > MAX_URL_BYTES) {
        throw pluginWebSocketError(
            'plugin_websocket_invalid_url',
            'Plugin WebSocket URL must be an absolute ws(s) URL no longer than 8 KiB',
        );
    }
    let url: URL;
    try {
        url = new URL(input.url);
    } catch {
        throw pluginWebSocketError('plugin_websocket_invalid_url', 'Plugin WebSocket URL is invalid');
    }
    if (
        (url.protocol !== 'ws:' && url.protocol !== 'wss:')
        || url.username !== ''
        || url.password !== ''
        || url.hash !== ''
    ) {
        throw pluginWebSocketError(
            'plugin_websocket_invalid_url',
            'Plugin WebSocket requires a credential-free ws(s) URL without a fragment',
        );
    }
    if (
        url.protocol === 'ws:'
        && input.allowInsecureWs !== true
        && !isLoopbackHostname(url.hostname)
    ) {
        throw pluginWebSocketError(
            'plugin_websocket_insecure_url_denied',
            'Insecure WebSocket URLs are limited to loopback unless explicitly allowed',
        );
    }
    if (input.allowInsecureWs !== undefined && typeof input.allowInsecureWs !== 'boolean') {
        throw pluginWebSocketError('plugin_websocket_invalid_url', 'allowInsecureWs must be a boolean');
    }
    const protocols = normalizeProtocols(input.protocols);
    const headers = normalizeHeaders(input.headers);
    assertHandshakeHeaderLimit(protocols, headers.byteLength);
    return Object.freeze({
        url,
        targetOrigin: webSocketTargetOrigin(url),
        protocols,
        headers: headers.headers,
        connectTimeoutMs: readBoundedPositiveInteger(
            input.connectTimeoutMs,
            DEFAULT_CONNECT_TIMEOUT_MS,
            MIN_CONNECT_TIMEOUT_MS,
            MAX_CONNECT_TIMEOUT_MS,
            'connectTimeoutMs',
        ),
        maxMessageBytes: readBoundedPositiveInteger(
            input.maxMessageBytes,
            DEFAULT_MAX_MESSAGE_BYTES,
            1,
            MAX_MAX_MESSAGE_BYTES,
            'maxMessageBytes',
        ),
        maxPendingMessages: readBoundedPositiveInteger(
            input.maxPendingMessages,
            DEFAULT_MAX_PENDING_MESSAGES,
            1,
            MAX_MAX_PENDING_MESSAGES,
            'maxPendingMessages',
        ),
        maxPendingBytes: readBoundedPositiveInteger(
            input.maxPendingBytes,
            DEFAULT_MAX_PENDING_BYTES,
            1,
            MAX_MAX_PENDING_BYTES,
            'maxPendingBytes',
        ),
        maxBufferedSendBytes: readBoundedPositiveInteger(
            input.maxBufferedSendBytes,
            DEFAULT_MAX_BUFFERED_SEND_BYTES,
            1,
            MAX_MAX_BUFFERED_SEND_BYTES,
            'maxBufferedSendBytes',
        ),
    });
}

function closeDiagnostic(code: string): PluginDiagnosticData {
    return Object.freeze({ code, severity: 'error' as const });
}

function readLifecycleCloseKind(signal: AbortSignal): PluginWebSocketClose['kind'] {
    const reason = signal.reason;
    if (
        reason
        && typeof reason === 'object'
        && 'kind' in reason
        && (reason.kind === 'generationRetired' || reason.kind === 'hostShutdown')
    ) return reason.kind;
    return 'aborted';
}

function validateCloseRequest(request: Readonly<{ code?: number; reason?: string }> | undefined): void {
    if (request?.code !== undefined) {
        const code = request.code;
        if (!Number.isSafeInteger(code) || (code !== 1000 && (code < 3000 || code > 4999))) {
            throw pluginWebSocketError(
                'plugin_websocket_invalid_close',
                'Plugin WebSocket close codes must be 1000 or in the 3000-4999 application range',
            );
        }
    }
    if (request?.reason !== undefined && (typeof request.reason !== 'string' || byteLength(request.reason) > 123)) {
        throw pluginWebSocketError(
            'plugin_websocket_invalid_close',
            'Plugin WebSocket close reasons must be UTF-8 strings no longer than 123 bytes',
        );
    }
}

/** @types/ws lags the v8 driver option this adapter deliberately owns. */
type BoundedWsClientOptions = WebSocket.ClientOptions & Readonly<{
    maxFragments: number;
}>;

type WsReceiverInspection = Readonly<{
    _fragmented?: unknown;
    _state?: unknown;
}>;

function copyDriverData(data: unknown): Uint8Array {
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
        const joined = Buffer.concat(data);
        return new Uint8Array(joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.byteLength));
    }
    if (Buffer.isBuffer(data)) {
        return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    throw pluginWebSocketError('plugin_websocket_protocol_error', 'Plugin WebSocket received an unsupported message payload');
}

function messageFromDriverData(data: unknown, isBinary: boolean): PluginWebSocketMessage {
    if (!isBinary && typeof data === 'string') return Object.freeze({ kind: 'text' as const, text: data });
    const bytes = copyDriverData(data);
    if (isBinary) return Object.freeze({ kind: 'binary' as const, data: bytes });
    try {
        return Object.freeze({
            kind: 'text' as const,
            text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        });
    } catch (error) {
        throw pluginWebSocketError(
            'plugin_websocket_protocol_error',
            'Plugin WebSocket received invalid UTF-8 text',
            error,
        );
    }
}

function readDriverErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
}

function isTlsDriverError(error: unknown, url: URL): boolean {
    const code = readDriverErrorCode(error);
    return code !== undefined && (
        (code === 'EPROTO' && url.protocol === 'wss:')
        || code.startsWith('ERR_TLS_')
        || TLS_DRIVER_ERROR_CODES.has(code)
    );
}

/**
 * `ws` exposes the parsed receiver only on the private driver seam. This is
 * inspection, not a second frame parser: it preserves the contractually
 * distinct abrupt-incomplete-message terminal truth that the WebSocket API
 * itself otherwise reports as an undifferentiated 1006 close.
 */
function hasIncompleteDriverMessage(socket: unknown): boolean {
    if (!socket || typeof socket !== 'object' || !('_receiver' in socket)) return false;
    const receiver = (socket as Readonly<{ _receiver?: unknown }>)._receiver;
    if (!receiver || typeof receiver !== 'object') return false;
    const inspected = receiver as WsReceiverInspection;
    return (typeof inspected._fragmented === 'number' && inspected._fragmented !== 0)
        || (typeof inspected._state === 'number' && inspected._state !== 0);
}

function messageByteLength(message: PluginWebSocketMessage): number {
    return message.kind === 'text' ? byteLength(message.text) : message.data.byteLength;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    assertNotAborted(signal);
    if (!signal) return operation;
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(createAbortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void operation.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

/**
 * The only low-level client transport. It is deliberately neutral: callers own
 * protocol state, reconnect policy, and message interpretation.
 */
export async function createPluginWebSocketConnection(
    input: PluginWebSocketOpenInput,
    options: PluginWebSocketRuntimeOptions = {},
): Promise<PluginWebSocketConnection> {
    const normalized = normalizePluginWebSocketOpenInput(input);
    assertNotAborted(options.signal);
    assertNotAborted(options.lifecycleSignal);

    const pinnedAddress = options.validatedAddresses?.[0];
    if (options.validatedAddresses !== undefined && pinnedAddress === undefined) {
        throw pluginWebSocketError(
            'plugin_websocket_connect_failed',
            'Plugin WebSocket connection has no validated network address',
        );
    }

    const driverOptions: BoundedWsClientOptions = Object.freeze({
        headers: normalized.headers,
        followRedirects: false,
        maxRedirects: 0,
        // The adapter owns the typed deadline. Keep the driver deadline just
        // beyond it so an opening timeout retains its canonical terminal code.
        handshakeTimeout: normalized.connectTimeoutMs + 100,
        maxPayload: normalized.maxMessageBytes,
        maxFragments: MAX_FRAGMENTS,
        allowSynchronousEvents: false,
        autoPong: true,
        // TLS verification is a host invariant, not a process-environment
        // default a plugin connection can inherit.
        rejectUnauthorized: true,
        skipUTF8Validation: false,
        ...(pinnedAddress === undefined ? {} : {
            // The request retains the original URL hostname, so Host and TLS
            // SNI/certificate verification remain name-based. Only socket
            // resolution is constrained to the addresses the policy owner
            // admitted immediately before this open.
            lookup: ((_hostname, lookupOptions, callback) => {
                if (typeof lookupOptions === 'object' && lookupOptions.all === true) {
                    callback(null, options.validatedAddresses!.map((address) => ({
                        address,
                        family: address.includes(':') ? 6 as const : 4 as const,
                    })));
                    return;
                }
                callback(null, pinnedAddress, pinnedAddress.includes(':') ? 6 : 4);
            }) satisfies LookupFunction,
        }),
    });
    let socket: WebSocket;
    try {
        socket = new WebSocket(normalized.url, [...normalized.protocols], driverOptions);
    } catch (error) {
        throw pluginWebSocketError(
            isTlsDriverError(error, normalized.url) ? 'plugin_websocket_tls_error' : 'plugin_websocket_connect_failed',
            'Plugin WebSocket connection could not be created',
            error,
        );
    }
    socket.binaryType = 'arraybuffer';

    let opened = false;
    let openSettled = false;
    let closeValue: PluginWebSocketClose | null = null;
    let closeIntent: CloseIntent | null = null;
    let openFailureCause: unknown;
    let queuedBytes = 0;
    const queuedMessages: PluginWebSocketMessage[] = [];
    let pendingReceive: Readonly<{
        resolve(value: PluginWebSocketMessage | Readonly<{ kind: 'closed'; close: PluginWebSocketClose }>): void;
        reject(error: unknown): void;
        cleanup(): void;
    }> | null = null;
    let sendTail: Promise<void> = Promise.resolve();
    let clearConnectTimer: (() => void) | null = null;
    let detachConnectAbort: (() => void) | null = null;
    let detachLifecycleAbort: (() => void) | null = null;
    let driverDisposed = false;
    let resolveClosed!: (close: PluginWebSocketClose) => void;
    const closed = new Promise<PluginWebSocketClose>((resolve) => { resolveClosed = resolve; });
    let resolveOpen!: (connection: PluginWebSocketConnection) => void;
    let rejectOpen!: (error: unknown) => void;
    const open = new Promise<PluginWebSocketConnection>((resolve, reject) => {
        resolveOpen = resolve;
        rejectOpen = reject;
    });

    const settleOpenFailure = (code: string) => {
        if (openSettled) return;
        openSettled = true;
        rejectOpen(pluginWebSocketError(code, 'Plugin WebSocket connection did not open', openFailureCause));
    };
    const disposeDriver = (): void => {
        if (driverDisposed) return;
        driverDisposed = true;
        try {
            socket.terminate();
        } catch {
            // The single terminal owner has already published the close truth.
        }
    };
    const settleClose = (intent: CloseIntent): void => {
        if (closeValue) return;
        const close = Object.freeze({
            kind: intent.kind,
            ...(intent.code === undefined ? {} : { code: intent.code }),
            ...(intent.reason === undefined ? {} : { reason: intent.reason }),
            wasClean: intent.wasClean,
            ...(intent.diagnostic === undefined ? {} : { diagnostic: intent.diagnostic }),
        }) satisfies PluginWebSocketClose;
        closeValue = close;
        clearConnectTimer?.();
        clearConnectTimer = null;
        detachConnectAbort?.();
        detachConnectAbort = null;
        detachLifecycleAbort?.();
        detachLifecycleAbort = null;
        if (pendingReceive) {
            const pending = pendingReceive;
            pendingReceive = null;
            pending.cleanup();
            pending.resolve(Object.freeze({ kind: 'closed' as const, close }));
        }
        disposeDriver();
        resolveClosed(close);
        if (!opened) settleOpenFailure(intent.diagnostic?.code ?? 'plugin_websocket_connect_failed');
    };
    const forceClose = (intent: CloseIntent): void => {
        if (closeValue) return;
        closeIntent = intent;
        // Forced terminal paths revoke the handle's authority immediately:
        // messages admitted before retirement must not be disclosed afterward.
        queuedMessages.length = 0;
        queuedBytes = 0;
        // Publish the single terminal state before touching the driver so any
        // re-entrant error/close event cannot overwrite lifecycle truth.
        settleClose(intent);
    };
    const closeForAbort = (signal: AbortSignal, lifecycle: boolean): void => {
        forceClose(Object.freeze({
            kind: lifecycle ? readLifecycleCloseKind(signal) : 'aborted',
            wasClean: false,
            diagnostic: closeDiagnostic(lifecycle ? 'plugin_websocket_lifecycle_closed' : 'plugin_websocket_aborted'),
        }));
    };
    const attachAbort = (
        signal: AbortSignal | undefined,
        lifecycle: boolean,
    ): (() => void) | null => {
        if (!signal) return null;
        const listener = () => closeForAbort(signal, lifecycle);
        if (signal.aborted) {
            listener();
            return null;
        }
        signal.addEventListener('abort', listener, { once: true });
        return () => signal.removeEventListener('abort', listener);
    };

    const connection: PluginWebSocketConnection = Object.freeze({
        get url() { return normalized.url.toString(); },
        get protocol() { return socket.protocol; },
        closed,
        async send(
            message: PluginWebSocketMessage,
            sendOptions: PluginCancellationOptions = {},
        ) {
            const snapshot = message?.kind === 'text'
                ? typeof message.text === 'string'
                    ? Object.freeze({ kind: 'text' as const, text: message.text })
                    : null
                : message?.kind === 'binary' && message.data instanceof Uint8Array
                    ? Object.freeze({ kind: 'binary' as const, data: new Uint8Array(message.data) })
                    : null;
            if (!snapshot) {
                throw pluginWebSocketError('plugin_websocket_invalid_message', 'Plugin WebSocket messages must be text or Uint8Array binary data');
            }
            const bytes = messageByteLength(snapshot);
            if (bytes > normalized.maxMessageBytes) {
                throw pluginWebSocketError('plugin_websocket_message_too_large', 'Plugin WebSocket message exceeds its configured limit');
            }
            const run = sendTail.then(async () => {
                assertNotAborted(sendOptions.signal);
                if (closeValue || socket.readyState !== socket.OPEN) {
                    throw pluginWebSocketError('plugin_websocket_closed', 'Plugin WebSocket is closed');
                }
                if (socket.bufferedAmount + bytes > normalized.maxBufferedSendBytes) {
                    throw pluginWebSocketError(
                        'plugin_websocket_backpressure_exceeded',
                        'Plugin WebSocket outgoing buffer exceeds its configured limit',
                    );
                }
                socket.send(
                    snapshot.kind === 'text' ? snapshot.text : Buffer.from(snapshot.data),
                    { binary: snapshot.kind === 'binary' },
                    (error) => {
                        if (!error || closeValue) return;
                        forceClose(Object.freeze({
                            kind: 'error' as const,
                            wasClean: false,
                            diagnostic: closeDiagnostic('plugin_websocket_connection_error'),
                        }));
                    },
                );
            });
            sendTail = run.catch(() => undefined);
            return await abortable(run, sendOptions.signal);
        },
        async receive(receiveOptions: PluginCancellationOptions = {}) {
            assertNotAborted(receiveOptions.signal);
            const queued = queuedMessages.shift();
            if (queued) {
                queuedBytes -= messageByteLength(queued);
                return queued;
            }
            if (closeValue) return Object.freeze({ kind: 'closed' as const, close: closeValue });
            if (pendingReceive) {
                throw pluginWebSocketError('plugin_websocket_receive_pending', 'Only one Plugin WebSocket receive may wait at a time');
            }
            return await new Promise<PluginWebSocketMessage | Readonly<{
                kind: 'closed';
                close: PluginWebSocketClose;
            }>>((resolve, reject) => {
                const onAbort = () => {
                    if (pendingReceive?.cleanup === cleanup) pendingReceive = null;
                    cleanup();
                    reject(createAbortError());
                };
                const cleanup = () => receiveOptions.signal?.removeEventListener('abort', onAbort);
                if (receiveOptions.signal) receiveOptions.signal.addEventListener('abort', onAbort, { once: true });
                pendingReceive = Object.freeze({ resolve, reject, cleanup });
                if (closeValue) {
                    const pending = pendingReceive;
                    pendingReceive = null;
                    pending.cleanup();
                    pending.resolve(Object.freeze({ kind: 'closed' as const, close: closeValue }));
                }
            });
        },
        close(request: Readonly<{ code?: number; reason?: string }> = {}) {
            validateCloseRequest(request);
            if (closeValue || closeIntent) return;
            closeIntent = Object.freeze({
                kind: 'local' as const,
                ...(request.code === undefined ? {} : { code: request.code }),
                ...(request.reason === undefined ? {} : { reason: request.reason }),
                wasClean: false,
            });
            try {
                socket.close(request.code, request.reason);
            } catch {
                forceClose(closeIntent);
            }
        },
        dispose() {
            if (closeValue) return;
            forceClose(closeIntent ?? Object.freeze({
                kind: 'local' as const,
                wasClean: false,
            }));
        },
    });

    socket.on('open', () => {
        if (closeValue) return;
        if (socket.protocol !== '' && !normalized.protocols.includes(socket.protocol)) {
            forceClose(Object.freeze({
                kind: 'error' as const,
                wasClean: false,
                diagnostic: closeDiagnostic('plugin_websocket_protocol_error'),
            }));
            return;
        }
        opened = true;
        clearConnectTimer?.();
        clearConnectTimer = null;
        detachConnectAbort?.();
        detachConnectAbort = null;
        if (!openSettled) {
            openSettled = true;
            resolveOpen(connection);
        }
    });
    socket.on('message', (data, isBinary) => {
        if (closeValue) return;
        let message: PluginWebSocketMessage;
        try {
            message = messageFromDriverData(data, isBinary);
        } catch {
            forceClose(Object.freeze({
                kind: 'error' as const,
                wasClean: false,
                diagnostic: closeDiagnostic('plugin_websocket_protocol_error'),
            }));
            return;
        }
        const bytes = messageByteLength(message);
        if (bytes > normalized.maxMessageBytes) {
            forceClose(Object.freeze({
                kind: 'error' as const,
                code: 1009,
                reason: 'plugin_websocket_message_too_large',
                wasClean: false,
                diagnostic: closeDiagnostic('plugin_websocket_message_too_large'),
            }));
            return;
        }
        if (pendingReceive) {
            const pending = pendingReceive;
            pendingReceive = null;
            pending.cleanup();
            pending.resolve(message);
            return;
        }
        if (
            queuedMessages.length >= normalized.maxPendingMessages
            || queuedBytes + bytes > normalized.maxPendingBytes
        ) {
            forceClose(Object.freeze({
                kind: 'error' as const,
                code: 1009,
                reason: 'plugin_websocket_backpressure_exceeded',
                wasClean: false,
                diagnostic: closeDiagnostic('plugin_websocket_backpressure_exceeded'),
            }));
            return;
        }
        queuedMessages.push(message);
        queuedBytes += bytes;
    });
    socket.on('unexpected-response', (_request, response) => {
        response.resume();
        if (closeValue) return;
        const status = typeof response.statusCode === 'number' ? response.statusCode : 'unknown';
        openFailureCause = pluginWebSocketError(
            'plugin_websocket_upgrade_rejected',
            `Plugin WebSocket upgrade was rejected with HTTP status ${status}`,
        );
        forceClose(Object.freeze({
            kind: 'error' as const,
            wasClean: false,
            diagnostic: closeDiagnostic('plugin_websocket_upgrade_rejected'),
        }));
    });
    socket.on('error', (error) => {
        if (closeValue) return;
        if (!opened) openFailureCause = error;
        const driverCode = readDriverErrorCode(error);
        const isPayloadLimit = driverCode === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';
        const isFragmentLimit = driverCode === 'WS_ERR_TOO_MANY_BUFFERED_PARTS';
        const isProtocolError = driverCode?.startsWith('WS_ERR_') === true;
        forceClose(Object.freeze({
            kind: 'error' as const,
            ...(isPayloadLimit ? { code: 1009, reason: 'plugin_websocket_message_too_large' } : {}),
            ...(isFragmentLimit ? { code: 1008, reason: 'plugin_websocket_fragment_limit_exceeded' } : {}),
            wasClean: false,
            diagnostic: closeDiagnostic(!opened
                ? isTlsDriverError(error, normalized.url)
                    ? 'plugin_websocket_tls_error'
                    : 'plugin_websocket_connect_failed'
                : isPayloadLimit
                    ? 'plugin_websocket_message_too_large'
                    : isFragmentLimit
                        ? 'plugin_websocket_fragment_limit_exceeded'
                    : isProtocolError
                        ? 'plugin_websocket_protocol_error'
                        : 'plugin_websocket_connection_error'),
        }));
    });
    socket.on('close', (code, reason) => {
        if (closeValue) return;
        const incomplete = hasIncompleteDriverMessage(socket);
        const diagnostic = incomplete
            ? closeDiagnostic('plugin_websocket_protocol_error')
            : closeIntent?.diagnostic;
        settleClose(Object.freeze({
            kind: incomplete ? 'error' : closeIntent?.kind ?? 'remote',
            ...(code !== 0 ? { code } : {}),
            ...(reason.byteLength > 0 ? { reason: reason.toString('utf8') } : {}),
            wasClean: !incomplete && code !== 1006,
            ...(diagnostic === undefined ? {} : { diagnostic }),
        }));
    });
    clearConnectTimer = () => clearTimeout(connectTimer);
    const connectTimer = setTimeout(() => forceClose(Object.freeze({
        kind: 'error' as const,
        wasClean: false,
        diagnostic: closeDiagnostic('plugin_websocket_connect_timeout'),
    })), normalized.connectTimeoutMs);
    detachConnectAbort = attachAbort(options.signal, false);
    detachLifecycleAbort = attachAbort(options.lifecycleSignal, true);

    try {
        return await open;
    } catch (error) {
        disposeDriver();
        throw error;
    }
}
