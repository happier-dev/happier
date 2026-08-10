import { io, type Socket } from 'socket.io-client';

import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';

import type { ClientToServerEvents, ServerToClientEvents } from '@/api/types';
import { createSocketTransportAdapter } from '@/api/connection/createSocketTransportAdapter';
import { configuration } from '@/configuration';
import { ensureSessionMachineAccessKeyBinding } from '@/api/session/ensureSessionMachineAccessKeyBinding';
import { getSocketIoProxyOptions } from '@/utils/proxy/socketIoProxy';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';

export function createSessionSocketTransport(params: Readonly<{
    token: string;
    sessionId: string;
    machineId?: string;
    serverUrl?: string;
    transports?: string[];
    env?: NodeJS.ProcessEnv;
}>): Readonly<{
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    transport: ManagedConnectionTransport;
}> {
    const serverUrl = params.serverUrl
        ? normalizeServerHttpBaseUrl(params.serverUrl)
        : resolveServerHttpBaseUrl();
    const transports = params.transports ?? configuration.socketIoTransports;
    const env = params.env ?? process.env;

    const socket = io(serverUrl, {
        ...(transports ? { transports } : null),
        auth: {
            token: params.token,
            clientType: 'session-scoped' as const,
            sessionId: params.sessionId,
            ...(params.machineId ? { machineId: params.machineId } : null),
        },
        path: '/v1/updates',
        reconnection: false,
        withCredentials: true,
        autoConnect: false,
        ...getSocketIoProxyOptions({ targetUrl: serverUrl, env }),
    });

    const socketTransport = createSocketTransportAdapter(socket, {
        connectTimeoutMs: resolveSessionControlSocketConnectTimeoutMs(),
    });
    const transport: ManagedConnectionTransport = {
        ...socketTransport,
        async connect(): Promise<void> {
            await ensureSessionMachineAccessKeyBinding({
                serverUrl,
                token: params.token,
                sessionId: params.sessionId,
                machineId: params.machineId,
            });
            await socketTransport.connect();
        },
    };

    return { socket, transport };
}
