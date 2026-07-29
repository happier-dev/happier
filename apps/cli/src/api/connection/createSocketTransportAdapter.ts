import type { ManagedConnectionTransport, TransportDisconnectEvent } from '@happier-dev/connection-supervisor';

/**
 * Minimal socket shape required by the transport adapter.
 * Covers socket.io-client Socket instances regardless of the generic event maps.
 */
export type SocketLike = Readonly<{
    connected: boolean;
    on(event: string, handler: (...args: unknown[]) => void): unknown;
    io?: { on?(event: string, handler: (...args: unknown[]) => void): unknown };
}> & {
    connect?(): void;
    open?(): void;
    disconnect?(): void;
    close?(): void;
    removeAllListeners?(): void;
};

export type SocketTransportAdapterOptions = Readonly<{
    connectTimeoutMs?: number;
}>;

const DEFAULT_SOCKET_TRANSPORT_CONNECT_TIMEOUT_MS = 10_000;

function resolveConnectTimeoutMs(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.min(60_000, Math.trunc(value))
        : DEFAULT_SOCKET_TRANSPORT_CONNECT_TIMEOUT_MS;
}

function createSocketConnectTimeoutError(timeoutMs: number): Error {
    const error = new Error(`Socket connect timeout after ${timeoutMs}ms`);
    Object.defineProperty(error, 'code', { value: 'socket_connect_timeout', enumerable: true });
    return error;
}

function createSocketConnectDisconnectError(event: TransportDisconnectEvent): Error {
    if (event.error instanceof Error) return event.error;
    const reason = typeof event.reason === 'string' && event.reason.trim()
        ? event.reason
        : 'Socket disconnected before connect';
    const error = new Error(reason);
    Object.defineProperty(error, 'code', { value: 'socket_disconnected_before_connect', enumerable: true });
    return error;
}

/**
 * Wraps a socket.io-client Socket into a `ManagedConnectionTransport`.
 *
 * This adapter owns:
 *  - listener-set bookkeeping for connected / disconnected / error events
 *  - intentional-disconnect tracking
 *  - connect / disconnect / destroy delegation
 *
 * Callers are responsible for creating the socket with the correct auth
 * payload and options; this function only bridges it to the transport
 * interface consumed by `ManagedConnectionSupervisor`.
 */
export function createSocketTransportAdapter(
    socket: SocketLike,
    options: SocketTransportAdapterOptions = {},
): ManagedConnectionTransport {
    const connectedListeners = new Set<() => void>();
    const disconnectedListeners = new Set<(event: TransportDisconnectEvent) => void>();
    const errorListeners = new Set<(error: unknown) => void>();
    const connectAttemptErrorListeners = new Set<(error: unknown) => void>();
    let intentionalDisconnect = false;
    const connectTimeoutMs = resolveConnectTimeoutMs(options.connectTimeoutMs);

    socket.on('connect', () => {
        connectedListeners.forEach((listener) => listener());
    });

    socket.on('disconnect', (...args: unknown[]) => {
        const reason = typeof args[0] === 'string' ? args[0] : undefined;
        const event: TransportDisconnectEvent = {
            intentional: intentionalDisconnect,
            reason,
        };
        intentionalDisconnect = false;
        disconnectedListeners.forEach((listener) => listener(event));
    });

    socket.on('connect_error', (error: unknown) => {
        connectAttemptErrorListeners.forEach((listener) => listener(error));
        if (socket.connected === true) {
            errorListeners.forEach((listener) => listener(error));
        }
    });

    socket.io?.on?.('error', (error: unknown) => {
        connectAttemptErrorListeners.forEach((listener) => listener(error));
        if (socket.connected === true) {
            errorListeners.forEach((listener) => listener(error));
        }
    });

    return {
        async connect(): Promise<void> {
            if (socket.connected === true) return;
            const connect = typeof socket.connect === 'function'
                ? () => socket.connect?.()
                : typeof socket.open === 'function'
                    ? () => socket.open?.()
                    : null;
            if (!connect) {
                throw new Error('Socket transport cannot connect: missing connect/open method');
            }

            let timer: ReturnType<typeof setTimeout> | null = null;
            const waitForConnected = new Promise<void>((resolve, reject) => {
                let settled = false;
                const cleanup = () => {
                    if (timer) {
                        clearTimeout(timer);
                        timer = null;
                    }
                    connectedListeners.delete(onConnected);
                    disconnectedListeners.delete(onDisconnected);
                    connectAttemptErrorListeners.delete(onError);
                };
                const settle = (fn: () => void) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    fn();
                };
                const onConnected = () => settle(() => resolve());
                const onDisconnected = (event: TransportDisconnectEvent) => {
                    settle(() => reject(createSocketConnectDisconnectError(event)));
                };
                const onError = (error: unknown) => {
                    settle(() => reject(error instanceof Error ? error : new Error(String(error))));
                };
                connectedListeners.add(onConnected);
                disconnectedListeners.add(onDisconnected);
                connectAttemptErrorListeners.add(onError);
                timer = setTimeout(() => {
                    settle(() => reject(createSocketConnectTimeoutError(connectTimeoutMs)));
                }, connectTimeoutMs);
                timer.unref?.();
            });

            connect();
            await waitForConnected;
        },
        async disconnect(options?: { intentional?: boolean }): Promise<void> {
            intentionalDisconnect = options?.intentional === true;
            if (typeof socket.disconnect === 'function') {
                socket.disconnect();
                return;
            }
            socket.close?.();
        },
        async destroy(): Promise<void> {
            connectedListeners.clear();
            disconnectedListeners.clear();
            errorListeners.clear();
            connectAttemptErrorListeners.clear();
            socket.removeAllListeners?.();
        },
        isConnected(): boolean {
            return socket.connected === true;
        },
        onConnected(listener) {
            connectedListeners.add(listener);
            return () => connectedListeners.delete(listener);
        },
        onDisconnected(listener) {
            disconnectedListeners.add(listener);
            return () => disconnectedListeners.delete(listener);
        },
        onError(listener) {
            errorListeners.add(listener);
            return () => errorListeners.delete(listener);
        },
    };
}
