import { io, type Socket } from 'socket.io-client';

import type { ManagedConnectionTransport, TransportDisconnectEvent } from '@happier-dev/connection-supervisor';

type SyncSocket = Socket;

export function createSyncSocketTransport(params: Readonly<{
    endpoint: string;
    token: string;
    transports?: string[];
}>): Readonly<{
    socket: SyncSocket;
    transport: ManagedConnectionTransport;
}> {
    const socket = io(params.endpoint, {
        path: '/v1/updates',
        auth: {
            token: params.token,
            clientType: 'user-scoped' as const,
            clientPurpose: 'sync' as const,
        },
        ...(params.transports ? { transports: params.transports } : null),
        // Avoid the socket.io global Manager cache. We manage connection lifecycles explicitly,
        // and cached Managers can retain sockets/listeners across rebuilds.
        forceNew: true,
        multiplex: false,
        reconnection: false,
        autoConnect: false,
    });

    const connectedListeners = new Set<() => void>();
    const disconnectedListeners = new Set<(event: TransportDisconnectEvent) => void>();
    const errorListeners = new Set<(error: unknown) => void>();
    let intentionalDisconnect = false;

    socket.on('connect', () => {
        connectedListeners.forEach((listener) => listener());
    });

    socket.on('disconnect', (reason: string) => {
        const event: TransportDisconnectEvent = {
            intentional: intentionalDisconnect,
            reason,
        };
        intentionalDisconnect = false;
        disconnectedListeners.forEach((listener) => listener(event));
    });

    socket.on('connect_error', (error) => {
        errorListeners.forEach((listener) => listener(error));
    });

    socket.on('error', (error) => {
        errorListeners.forEach((listener) => listener(error));
    });

    const transport: ManagedConnectionTransport = {
        async connect(): Promise<void> {
            // Defensive: disconnect() may be called while already disconnected/connecting, which might not emit
            // a 'disconnect' event. Reset so the next disconnect isn't misclassified as intentional.
            intentionalDisconnect = false;
            socket.connect();
        },
        async disconnect(options?: { intentional?: boolean }): Promise<void> {
            intentionalDisconnect = options?.intentional === true;
            socket.disconnect();
        },
        async destroy(): Promise<void> {
            intentionalDisconnect = false;
            connectedListeners.clear();
            disconnectedListeners.clear();
            errorListeners.clear();
            socket.offAny?.();
            socket.removeAllListeners?.();
            try {
                socket.disconnect();
            } catch {
                // ignore
            }
        },
        isConnected(): boolean {
            return socket.connected === true;
        },
        onConnected(listener: () => void): () => void {
            connectedListeners.add(listener);
            return () => connectedListeners.delete(listener);
        },
        onDisconnected(listener: (event: TransportDisconnectEvent) => void): () => void {
            disconnectedListeners.add(listener);
            return () => disconnectedListeners.delete(listener);
        },
        onError(listener: (error: unknown) => void): () => void {
            errorListeners.add(listener);
            return () => errorListeners.delete(listener);
        },
    };

    return { socket, transport };
}
