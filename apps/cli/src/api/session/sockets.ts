import { configuration } from '@/configuration';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import { io, Socket } from 'socket.io-client'
import { resolveLoopbackHttpUrl } from '../client/loopbackUrl';
import { getSocketIoProxyOptions } from '@/utils/proxy/socketIoProxy';

export function createSessionScopedSocket(opts: { token: string; sessionId: string; machineId?: string }): Socket<ServerToClientEvents, ClientToServerEvents> {
    const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
    const transports = configuration.socketIoTransports;
    return io(serverUrl, {
        auth: {
            token: opts.token,
            clientType: 'session-scoped' as const,
            sessionId: opts.sessionId,
            ...(opts.machineId ? { machineId: opts.machineId } : null),
        },
        path: '/v1/updates',
        reconnection: false,
        ...(transports ? { transports } : null),
        withCredentials: true,
        autoConnect: false,
        ...getSocketIoProxyOptions({ targetUrl: serverUrl, env: process.env }),
    });
}

export function createUserScopedSocket(opts: { token: string }): Socket<ServerToClientEvents, ClientToServerEvents> {
    const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
    const transports = configuration.socketIoTransports;
    return io(serverUrl, {
        auth: {
            token: opts.token,
            clientType: 'user-scoped' as const,
        },
        path: '/v1/updates',
        reconnection: false,
        ...(transports ? { transports } : null),
        withCredentials: true,
        autoConnect: false,
        ...getSocketIoProxyOptions({ targetUrl: serverUrl, env: process.env }),
    });
}
