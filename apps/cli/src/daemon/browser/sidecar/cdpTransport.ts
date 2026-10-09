import type { LoopbackWebSocketJsonClientV1 } from '@/plugins/runtime/exec/privateContract';

import { createLoopbackWebSocketJsonClient } from '@/plugins/runtime/exec/loopbackWebSocket';

import type {
    BrowserSidecarCdpCommandScope,
    BrowserSidecarCdpControlTransport,
    BrowserSidecarCdpEventSubscriber,
    BrowserSidecarCdpPageHandle,
} from './controlAdapter';
import {
    discoverBrowserSidecarCdpEndpoint,
    type BrowserSidecarCdpEndpoint,
} from './cdpEndpoint';

export type BrowserSidecarCdpTransportErrorCode =
    | 'cdp_command_failed'
    | 'cdp_malformed_response'
    | 'cdp_protocol_error'
    | 'cdp_request_timeout'
    | 'cdp_transport_closed'
    | 'cdp_transport_disposed'
    | 'cdp_unavailable';

export class BrowserSidecarCdpTransportError extends Error {
    readonly code: BrowserSidecarCdpTransportErrorCode;
    /** Only transport preflight can prove nondispatch; pending/send failures may have landed. */
    readonly dispatchStatus: 'not_dispatched' | 'unknown';

    constructor(code: BrowserSidecarCdpTransportErrorCode, message: string, dispatchStatus: 'not_dispatched' | 'unknown' = 'unknown') {
        super(message);
        this.name = 'BrowserSidecarCdpTransportError';
        this.code = code;
        this.dispatchStatus = dispatchStatus;
    }
}

class BrowserSidecarCdpRequestAbortedError extends DOMException {
    readonly dispatchStatus: 'not_dispatched' | 'unknown';

    constructor(dispatchStatus: 'not_dispatched' | 'unknown') {
        super('Browser sidecar CDP request was aborted.', 'AbortError');
        this.dispatchStatus = dispatchStatus;
    }
}

export function isBrowserSidecarCdpCommandNotDispatched(error: unknown): boolean {
    return (error instanceof BrowserSidecarCdpTransportError || error instanceof BrowserSidecarCdpRequestAbortedError)
        && error.dispatchStatus === 'not_dispatched';
}

export type BrowserSidecarCdpTransport = BrowserSidecarCdpControlTransport & Readonly<{
    /**
     * Subscribe to raw CDP protocol notifications (messages without an `id`). Used by the offline
     * diagnostics lane to feed the ring from the SAME live connection. Returns an unsubscribe handle.
     */
    subscribeCdpEvents(listener: BrowserSidecarCdpEventSubscriber): () => void;
    dispose(): void;
}>;

type CdpResponse = Readonly<{
    id: number;
    result?: unknown;
    error?: Readonly<{
        code?: unknown;
        message?: unknown;
        data?: unknown;
    }>;
}>;

type PendingRequest = Readonly<{
    id: number;
    resolve(result: unknown): void;
    reject(error: Error): void;
    cleanup(): void;
}>;

type CdpCommandInput = BrowserSidecarCdpCommandScope & Readonly<{
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
}>;

function privateError(code: BrowserSidecarCdpTransportErrorCode): BrowserSidecarCdpTransportError {
    switch (code) {
        case 'cdp_command_failed':
            return new BrowserSidecarCdpTransportError(code, 'Browser sidecar CDP command failed.');
        case 'cdp_malformed_response':
            return new BrowserSidecarCdpTransportError(code, 'Browser sidecar CDP response was malformed.');
        case 'cdp_protocol_error':
            return new BrowserSidecarCdpTransportError(code, 'Browser sidecar CDP protocol violation.');
        case 'cdp_request_timeout':
            return new BrowserSidecarCdpTransportError(code, 'Browser sidecar CDP request timed out.');
        case 'cdp_transport_closed':
            return new BrowserSidecarCdpTransportError(code, 'Browser sidecar CDP transport closed.');
        case 'cdp_transport_disposed':
            return new BrowserSidecarCdpTransportError(code, 'Browser sidecar CDP transport was disposed.');
        case 'cdp_unavailable':
            return new BrowserSidecarCdpTransportError(code, 'Browser sidecar CDP transport is unavailable.');
    }
}

function recordValue(input: unknown): Record<string, unknown> | null {
    return input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : null;
}

function hasOwn(input: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(input, key);
}

function readStringField(input: unknown, field: string): string | null {
    const record = recordValue(input);
    const value = record?.[field];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function readErrorCode(input: unknown): string | null {
    return input && typeof input === 'object' && typeof (input as { code?: unknown }).code === 'string'
        ? (input as { code: string }).code
        : null;
}

function readErrorMessage(input: unknown): string {
    return input instanceof Error ? input.message : '';
}

function mapClientClosedError(input: unknown): BrowserSidecarCdpTransportErrorCode {
    if (readErrorCode(input) !== 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR') {
        return 'cdp_transport_closed';
    }
    const message = readErrorMessage(input);
    if (message.includes('not valid JSON')) {
        return 'cdp_malformed_response';
    }
    return 'cdp_protocol_error';
}

export function createBrowserSidecarCdpTransport(input: Readonly<{
    client: LoopbackWebSocketJsonClientV1;
    disposeClient?: (error?: Error) => void;
}>): BrowserSidecarCdpTransport {
    const pending = new Map<number, PendingRequest>();
    const eventListeners = new Set<BrowserSidecarCdpEventSubscriber>();
    let nextId = 1;
    let disposedError: BrowserSidecarCdpTransportError | null = null;

    function rejectPending(request: PendingRequest, error: Error): void {
        if (!pending.delete(request.id)) return;
        request.cleanup();
        request.reject(error);
    }

    function resolvePending(request: PendingRequest, result: unknown): void {
        if (!pending.delete(request.id)) return;
        request.cleanup();
        request.resolve(result);
    }

    function failAll(error: BrowserSidecarCdpTransportError): void {
        if (!disposedError) {
            disposedError = error;
        }
        for (const request of [...pending.values()]) {
            rejectPending(request, error);
        }
    }

    function handleProtocolFailure(code: BrowserSidecarCdpTransportErrorCode): void {
        const error = privateError(code);
        failAll(error);
        input.disposeClient?.(error);
    }

    function dispatchEventNotification(record: Record<string, unknown>): void {
        if (eventListeners.size === 0) return;
        const method = record.method;
        if (typeof method !== 'string') return;
        const params = recordValue(record.params) ?? undefined;
        const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
        const notification = {
            method,
            ...(params ? { params } : {}),
            ...(sessionId ? { sessionId } : {}),
        };
        for (const listener of [...eventListeners]) {
            try {
                listener(notification);
            } catch {
                // A diagnostics listener must never be able to break the CDP transport correlation.
            }
        }
    }

    function handleMessage(message: unknown): void {
        if (disposedError) return;
        const record = recordValue(message);
        if (!record) {
            handleProtocolFailure('cdp_malformed_response');
            return;
        }

        if (!hasOwn(record, 'id')) {
            if (typeof record.method === 'string') {
                dispatchEventNotification(record);
                return;
            }
            handleProtocolFailure('cdp_malformed_response');
            return;
        }

        if (typeof record.id !== 'number' || !Number.isInteger(record.id)) {
            handleProtocolFailure('cdp_malformed_response');
            return;
        }

        const request = pending.get(record.id);
        if (!request) {
            // Chrome can finish an issued command after its containing operation was cancelled.
            // That late reply must not poison unrelated commands on the same connection.
            if (record.id > 0 && record.id < nextId) return;
            handleProtocolFailure('cdp_protocol_error');
            return;
        }

        if (hasOwn(record, 'error')) {
            rejectPending(request, privateError('cdp_command_failed'));
            return;
        }

        if (!hasOwn(record, 'result')) {
            rejectPending(request, privateError('cdp_malformed_response'));
            return;
        }

        resolvePending(request, (message as CdpResponse).result);
    }

    const unsubscribe = input.client.subscribe(handleMessage);

    input.client.closed.then(() => {
        failAll(privateError('cdp_transport_closed'));
    }, (error: unknown) => {
        failAll(privateError(mapClientClosedError(error)));
    });

    async function sendCommand(command: CdpCommandInput): Promise<unknown> {
        if (disposedError) {
            throw new BrowserSidecarCdpTransportError(disposedError.code, disposedError.message, 'not_dispatched');
        }
        if (command.signal?.aborted) {
            throw new BrowserSidecarCdpRequestAbortedError('not_dispatched');
        }
        if (command.deadlineMs !== undefined && command.deadlineMs <= Date.now()) {
            const error = privateError('cdp_request_timeout');
            throw new BrowserSidecarCdpTransportError(error.code, error.message, 'not_dispatched');
        }

        const id = nextId;
        nextId += 1;
        const message = {
            id,
            ...(command.sessionId ? { sessionId: command.sessionId } : {}),
            method: command.method,
            ...(command.params ? { params: command.params } : {}),
        };

        return await new Promise<unknown>((resolve, reject) => {
            let timeout: NodeJS.Timeout | undefined;
            const onAbort = () => rejectPending(request, new BrowserSidecarCdpRequestAbortedError('unknown'));
            const request: PendingRequest = {
                id,
                resolve,
                reject,
                cleanup() {
                    if (timeout !== undefined) clearTimeout(timeout);
                    command.signal?.removeEventListener('abort', onAbort);
                },
            };
            pending.set(id, request);
            command.signal?.addEventListener('abort', onAbort, { once: true });
            if (command.deadlineMs !== undefined) {
                timeout = setTimeout(() => rejectPending(request, privateError('cdp_request_timeout')), Math.max(0, command.deadlineMs - Date.now()));
            }
            try {
                void input.client.sendJson(message, { signal: command.signal }).catch(() => {
                    rejectPending(request, privateError('cdp_transport_closed'));
                });
            } catch {
                rejectPending(request, privateError('cdp_transport_closed'));
            }
        });
    }

    async function openPage(pageInput: BrowserSidecarCdpCommandScope & Readonly<{ url: string; focus: boolean }>): Promise<BrowserSidecarCdpPageHandle> {
        const scope = { signal: pageInput.signal, deadlineMs: pageInput.deadlineMs };
        const createTargetResult = await sendCommand({
            ...scope,
            method: 'Target.createTarget',
            params: { url: pageInput.url },
        });
        const targetId = readStringField(createTargetResult, 'targetId');
        if (!targetId) {
            throw privateError('cdp_malformed_response');
        }

        const attachResult = await sendCommand({
            ...scope,
            method: 'Target.attachToTarget',
            params: { targetId, flatten: true },
        });
        const sessionId = readStringField(attachResult, 'sessionId');
        if (!sessionId) {
            throw privateError('cdp_malformed_response');
        }

        if (pageInput.focus) {
            await sendCommand({
                ...scope,
                method: 'Target.activateTarget',
                params: { targetId },
            });
        }

        return { targetId, sessionId };
    }

    return {
        openPage,
        async dispatchPageCommand(command) {
            return await sendCommand({
                method: command.method,
                params: command.params,
                sessionId: command.sessionId,
                signal: command.signal,
                deadlineMs: command.deadlineMs,
            });
        },
        async dispatchBrowserCommand(command) {
            return await sendCommand({
                method: command.method,
                params: command.params,
                signal: command.signal,
                deadlineMs: command.deadlineMs,
            });
        },
        subscribeCdpEvents(listener) {
            eventListeners.add(listener);
            return () => {
                eventListeners.delete(listener);
            };
        },
        dispose() {
            if (disposedError?.code === 'cdp_transport_disposed') return;
            const error = privateError('cdp_transport_disposed');
            disposedError = error;
            unsubscribe();
            failAll(error);
            input.disposeClient?.(error);
        },
    };
}

export async function connectBrowserSidecarCdpTransport(input: Readonly<{
    endpoint: Pick<BrowserSidecarCdpEndpoint, 'url'>;
    connectTimeoutMs?: number;
    signal?: AbortSignal;
}>): Promise<BrowserSidecarCdpTransport> {
    const endpoint = discoverBrowserSidecarCdpEndpoint({
        kind: 'explicit',
        endpoint: input.endpoint.url,
    });
    if (!endpoint.ok) {
        throw privateError('cdp_unavailable');
    }

    let client: Awaited<ReturnType<typeof createLoopbackWebSocketJsonClient>>;
    try {
        client = await createLoopbackWebSocketJsonClient({
            endpoint: { url: endpoint.endpoint.url },
            connect: {
                timeoutMs: input.connectTimeoutMs,
            },
            limits: {
                // Capture/stream operations own resource policy, not this multiplexed socket.
                messageByteLimits: null,
            },
            signal: input.signal,
        });
    } catch {
        throw privateError('cdp_unavailable');
    }

    return createBrowserSidecarCdpTransport({
        client: client.client,
        disposeClient: (error) => client.dispose(error),
    });
}
