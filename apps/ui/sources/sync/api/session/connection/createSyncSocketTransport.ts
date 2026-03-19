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
        },
        ...(params.transports ? { transports: params.transports } : null),
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

    const transport: ManagedConnectionTransport = {
        async connect(): Promise<void> {
            socket.connect();
        },
        async disconnect(options?: { intentional?: boolean }): Promise<void> {
            intentionalDisconnect = options?.intentional === true;
            socket.disconnect();
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
