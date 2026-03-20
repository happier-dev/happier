import axios from 'axios';
import { io, type Socket } from 'socket.io-client';
import { randomUUID } from 'node:crypto';

import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';

import type { ClientToServerEvents, ServerToClientEvents } from '@/api/types';
import { createSocketTransportAdapter } from '@/api/connection/createSocketTransportAdapter';
import { configuration } from '@/configuration';
import { getSocketIoProxyOptions } from '@/utils/proxy/socketIoProxy';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';

async function ensureSessionSocketAccessKeyBinding(params: Readonly<{
    serverUrl: string;
    token: string;
    sessionId: string;
    machineId?: string;
}>): Promise<void> {
    if (!params.machineId) return;

    const requestConfig = {
        headers: {
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
        },
        timeout: configuration.sessionControlHttpTimeoutMs,
        validateStatus: () => true,
    };
    const accessKeyUrl = `${params.serverUrl}/v1/access-keys/${encodeURIComponent(params.sessionId)}/${encodeURIComponent(params.machineId)}`;

    const existing = await axios.get(accessKeyUrl, requestConfig);
    if (existing.status === 200 && existing.data?.accessKey) {
        return;
    }
    if (existing.status !== 200) {
        throw new Error(`Unexpected status from ${accessKeyUrl}: ${existing.status}`);
    }

    const created = await axios.post(accessKeyUrl, {
        data: `session-socket-binding:${randomUUID()}`,
    }, requestConfig);
    if (created.status === 200 || created.status === 409) {
        return;
    }
    throw new Error(`Unexpected status from ${accessKeyUrl}: ${created.status}`);
}

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
    const serverUrl = resolveLoopbackHttpUrl(params.serverUrl ?? configuration.apiServerUrl).replace(/\/+$/, '');
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

    const socketTransport = createSocketTransportAdapter(socket);
    const transport: ManagedConnectionTransport = {
        ...socketTransport,
        async connect(): Promise<void> {
            await ensureSessionSocketAccessKeyBinding({
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
