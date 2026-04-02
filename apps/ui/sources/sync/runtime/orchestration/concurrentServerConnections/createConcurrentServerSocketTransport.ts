import { io, type Socket } from 'socket.io-client';
import type {
    ManagedConnectionTransport,
    TransportDisconnectEvent,
} from '@happier-dev/connection-supervisor';

import { resolveSocketIoTransports } from '@/sync/runtime/socketIoTransports';

export type ConcurrentServerSocket = Socket;

export function createConcurrentServerSocketTransport(params: Readonly<{
    serverUrl: string;
    token: string;
}>): Readonly<{
    socket: ConcurrentServerSocket;
    transport: ManagedConnectionTransport;
}> {
    const transports = resolveSocketIoTransports();
    const socket = io(params.serverUrl, {
        path: '/v1/updates/',
        auth: {
            token: params.token,
            clientType: 'user-scoped' as const,
            clientPurpose: 'concurrent-server-cache' as const,
        },
        ...(transports ? { transports } : null),
        withCredentials: false,
        // Avoid the socket.io global Manager cache. This transport is frequently created/destroyed as
        // servers enter/exit the concurrent session cache, and cached Managers can retain listeners.
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

    socket.on('disconnect', (reason: unknown) => {
        const event: TransportDisconnectEvent = {
            intentional: intentionalDisconnect,
            reason: typeof reason === 'string' ? reason : null,
        };
        intentionalDisconnect = false;
        disconnectedListeners.forEach((listener) => listener(event));
    });

    socket.on('connect_error', (error: unknown) => {
        errorListeners.forEach((listener) => listener(error));
    });

    socket.on('error', (error: unknown) => {
        errorListeners.forEach((listener) => listener(error));
    });

    return {
        socket,
        transport: {
            async connect() {
                intentionalDisconnect = false;
                socket.connect();
            },
            async disconnect(options = {}) {
                intentionalDisconnect = options.intentional === true;
                socket.disconnect();
            },
            async destroy() {
                intentionalDisconnect = false;
                connectedListeners.clear();
                disconnectedListeners.clear();
                errorListeners.clear();
                socket.offAny?.();
                socket.removeAllListeners();
                try {
                    socket.disconnect();
                } catch {
                    // ignore
                }
            },
            isConnected() {
                return socket.connected;
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
        },
    };
}
