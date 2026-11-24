import { configuration } from '@/configuration';
import { ConnectedServiceIdSchema, CONNECTED_SERVICE_READER_SUPPORT_SOCKET_AUTH_FIELD, SESSION_UPDATE_INTEREST_SOCKET_AUTH_FIELD } from '@happier-dev/protocol';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import { io, Socket } from 'socket.io-client'
import { getSocketIoProxyOptions } from '@/utils/proxy/socketIoProxy';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

export function createSessionScopedSocket(opts: { token: string; sessionId: string; machineId?: string }): Socket<ServerToClientEvents, ClientToServerEvents> {
    const serverUrl = resolveServerHttpBaseUrl();
    const transports = configuration.socketIoTransports;
    return io(serverUrl, {
        auth: {
            [CONNECTED_SERVICE_READER_SUPPORT_SOCKET_AUTH_FIELD]: ConnectedServiceIdSchema.options,
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

export function createUserScopedSocket(opts: { token: string; sessionUpdateInterest?: string }): Socket<ServerToClientEvents, ClientToServerEvents> {
    const serverUrl = resolveServerHttpBaseUrl();
    const transports = configuration.socketIoTransports;
    return io(serverUrl, {
        auth: {
            [CONNECTED_SERVICE_READER_SUPPORT_SOCKET_AUTH_FIELD]: ConnectedServiceIdSchema.options,
            token: opts.token,
            clientType: 'user-scoped' as const,
            ...(opts.sessionUpdateInterest ? { [SESSION_UPDATE_INTEREST_SOCKET_AUTH_FIELD]: opts.sessionUpdateInterest } : {}),
        },
        path: '/v1/updates',
        reconnection: false,
        ...(transports ? { transports } : null),
        withCredentials: true,
        autoConnect: false,
        ...getSocketIoProxyOptions({ targetUrl: serverUrl, env: process.env }),
    });
}
