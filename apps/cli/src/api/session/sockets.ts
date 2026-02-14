import { configuration } from '@/configuration';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import { io, Socket } from 'socket.io-client'
import { resolveLoopbackHttpUrl } from '../client/loopbackUrl';
import { getSocketIoProxyOptions } from '@/utils/proxy/socketIoProxy';

export function createSessionScopedSocket(opts: { token: string; sessionId: string }): Socket<ServerToClientEvents, ClientToServerEvents> {
    const serverUrl = resolveLoopbackHttpUrl(configuration.serverUrl).replace(/\/+$/, '');
    return io(serverUrl, {
        auth: {
            token: opts.token,
            clientType: 'session-scoped' as const,
            sessionId: opts.sessionId,
        },
        path: '/v1/updates',
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        transports: ['websocket'],
        withCredentials: true,
        autoConnect: false,
        ...getSocketIoProxyOptions({ targetUrl: serverUrl, env: process.env }),
    });
}

export function createUserScopedSocket(opts: { token: string }): Socket<ServerToClientEvents, ClientToServerEvents> {
    const serverUrl = resolveLoopbackHttpUrl(configuration.serverUrl).replace(/\/+$/, '');
    return io(serverUrl, {
        auth: {
            token: opts.token,
            clientType: 'user-scoped' as const,
        },
        path: '/v1/updates',
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        transports: ['websocket'],
        withCredentials: true,
        autoConnect: false,
        ...getSocketIoProxyOptions({ targetUrl: serverUrl, env: process.env }),
    });
}
