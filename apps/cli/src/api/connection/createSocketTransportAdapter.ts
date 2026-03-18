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
export function createSocketTransportAdapter(socket: SocketLike): ManagedConnectionTransport {
    const connectedListeners = new Set<() => void>();
    const disconnectedListeners = new Set<(event: TransportDisconnectEvent) => void>();
    const errorListeners = new Set<(error: unknown) => void>();
    let intentionalDisconnect = false;

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
        errorListeners.forEach((listener) => listener(error));
    });

    socket.io?.on?.('error', (error: unknown) => {
        errorListeners.forEach((listener) => listener(error));
    });

    return {
        async connect(): Promise<void> {
            if (typeof socket.connect === 'function') {
                socket.connect();
                return;
            }
            socket.open?.();
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
