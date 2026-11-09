import type { Socket } from 'socket.io-client';
import { createHappierSocket } from '@happier-dev/sync-client';

import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';

import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { ClientToServerEvents, ServerToClientEvents } from '@/api/types';
import { configuration } from '@/configuration';
import { ensureSessionMachineAccessKeyBinding } from '@/api/session/ensureSessionMachineAccessKeyBinding';
import { getSocketIoProxyOptions } from '@/utils/proxy/socketIoProxy';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import {
    buildCurrentSessionRunnerCompatibilitySocketAuth,
} from '@/api/clientCompatibility/cliClientCompatibility';

export function createSessionSocketTransport(params: Readonly<{
    token: string;
    sessionId: string;
    machineId?: string;
    serverUrl?: string;
    transports?: string[];
    env?: NodeJS.ProcessEnv;
    /** The atomic materializer already created this exact Machine/Session AccessKey. */
    accessKeyBinding?: 'ensure' | 'preestablished';
}>): Readonly<{
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    transport: ManagedConnectionTransport;
}> {
    const serverUrl = params.serverUrl
        ? normalizeServerHttpBaseUrl(params.serverUrl)
        : resolveServerHttpBaseUrl();
    const transports = params.transports ?? configuration.socketIoTransports;
    const env = params.env ?? process.env;

    const { socket: sharedSocket, transport: socketTransport } = createHappierSocket({
        endpoint: serverUrl,
        token: params.token,
        clientType: 'session-scoped',
        sessionId: params.sessionId,
        ...(params.machineId ? { machineId: params.machineId } : {}),
        authExtras: {
            ...buildCurrentSessionRunnerCompatibilitySocketAuth(),
        },
        connectTimeoutMs: resolveSessionControlSocketConnectTimeoutMs(),
        ...(transports ? { transports } : null),
        withCredentials: true,
        engineOptions: getSocketIoProxyOptions({ targetUrl: serverUrl, env }),
    });
    const socket = sharedSocket as Socket<ServerToClientEvents, ClientToServerEvents>;
    const transport: ManagedConnectionTransport = {
        ...socketTransport,
        async connect(): Promise<void> {
            if (params.accessKeyBinding !== 'preestablished') {
                await ensureSessionMachineAccessKeyBinding({
                    serverUrl,
                    token: params.token,
                    sessionId: params.sessionId,
                    machineId: params.machineId,
                });
            } else if (!params.machineId) {
                throw new Error('preestablished_session_access_key_requires_machine');
            }
            await socketTransport.connect();
        },
    };

    return { socket, transport };
}
