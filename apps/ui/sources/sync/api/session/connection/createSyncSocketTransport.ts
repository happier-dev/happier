import { io, type Socket } from 'socket.io-client';

import type { ManagedConnectionTransport, TransportDisconnectEvent } from '@happier-dev/connection-supervisor';

type SyncSocket = Socket;

function isSocketActive(socket: SyncSocket): boolean {
    return (socket as unknown as { active?: boolean }).active === true;
}

function isAlreadyDisconnectedSocketError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return error.message.toLowerCase().includes('socket has been disconnected');
}

export function createSyncSocketTransport(params: Readonly<{
    endpoint: string;
    token: string;
    transports?: string[];
}>): Readonly<{
    socket: SyncSocket;
    transport: ManagedConnectionTransport;
}> {
    const endpoint = String(params.endpoint ?? '').trim().replace(/\/+$/, '');
    const socket = io(endpoint, {
        // Socket.IO mounts on an Engine.IO endpoint that expects a trailing slash on the wire
        // (`/v1/updates/?EIO=...`). Some browser environments can otherwise surface this as
        // a generic `xhr poll error` during bootstrap even when the server is healthy.
        path: '/v1/updates/',
        auth: {
            token: params.token,
            clientType: 'user-scoped' as const,
            clientPurpose: 'sync' as const,
        },
        ...(params.transports ? { transports: params.transports } : null),
        // Explicitly disable cookies/credentialed requests for cross-origin polling transport.
        // Our server authenticates via the token in the Socket.IO handshake, and sets
        // `credentials: false` for CORS, so a credentialed polling request is blocked by
        // browsers and surfaces as `xhr poll error`.
        withCredentials: false,
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
            if (socket.connected !== true && !isSocketActive(socket)) {
                intentionalDisconnect = false;
                return;
            }
            intentionalDisconnect = options?.intentional === true;
            try {
                socket.disconnect();
            } catch (error) {
                intentionalDisconnect = false;
                if (isAlreadyDisconnectedSocketError(error)) {
                    return;
                }
                throw error;
            }
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
