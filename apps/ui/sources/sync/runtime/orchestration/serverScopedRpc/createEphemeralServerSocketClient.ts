import { io } from 'socket.io-client';

import type { ScopedSocketClient, ScopedSocketConnectParams } from './serverScopedRpcTypes';

export async function createEphemeralServerSocketClient(params: ScopedSocketConnectParams): Promise<ScopedSocketClient> {
    return await new Promise<ScopedSocketClient>((resolve, reject) => {
        const socket = io(params.serverUrl, {
            path: '/v1/updates',
            auth: {
                token: params.token,
                clientType: 'user-scoped' as const,
            },
            transports: ['websocket'],
            reconnection: false,
        });

        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
                socket.disconnect();
            } catch {
                // no-op
            }
            reject(new Error('Scoped RPC socket connection timeout'));
        }, params.timeoutMs);

        const cleanup = () => {
            clearTimeout(timeout);
            socket.off('connect', onConnect);
            socket.off('connect_error', onConnectError);
        };

        const onConnect = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(socket);
        };

        const onConnectError = (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error instanceof Error ? error : new Error('Scoped RPC socket connection failed'));
        };

        socket.on('connect', onConnect);
        socket.on('connect_error', onConnectError);
    });
}
