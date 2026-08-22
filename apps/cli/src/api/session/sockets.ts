import { configuration } from '@/configuration';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import { io, Socket } from 'socket.io-client'
import { resolveServerHttpBaseUrl } from '../client/serverHttpBaseUrl';
import { getSocketIoProxyOptions } from '@/utils/proxy/socketIoProxy';
import {
    buildCurrentCliClientCompatibilitySocketAuth,
} from '@/api/clientCompatibility/cliClientCompatibility';

export function createSessionScopedSocket(opts: { token: string; sessionId: string; machineId?: string }): Socket<ServerToClientEvents, ClientToServerEvents> {
    const serverUrl = resolveServerHttpBaseUrl();
    const transports = configuration.socketIoTransports;
    return io(serverUrl, {
        auth: {
            token: opts.token,
            clientType: 'session-scoped' as const,
            sessionId: opts.sessionId,
            ...(opts.machineId ? { machineId: opts.machineId } : null),
            ...buildCurrentCliClientCompatibilitySocketAuth('session-runner'),
        },
        path: '/v1/updates/',
        reconnection: false,
        ...(transports ? { transports } : null),
        withCredentials: true,
        autoConnect: false,
        ...getSocketIoProxyOptions({ targetUrl: serverUrl, env: process.env }),
    });
}

export function createUserScopedSocket(opts: { token: string }): Socket<ServerToClientEvents, ClientToServerEvents> {
    const serverUrl = resolveServerHttpBaseUrl();
    const transports = configuration.socketIoTransports;
    return io(serverUrl, {
        auth: {
            token: opts.token,
            clientType: 'user-scoped' as const,
            ...buildCurrentCliClientCompatibilitySocketAuth('session-runner'),
        },
        path: '/v1/updates/',
        reconnection: false,
        ...(transports ? { transports } : null),
        withCredentials: true,
        autoConnect: false,
        ...getSocketIoProxyOptions({ targetUrl: serverUrl, env: process.env }),
    });
}
