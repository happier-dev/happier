import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import type { Socket } from 'socket.io-client';
import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';
import { createHappierSocket } from '@happier-dev/sync-client';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl, resolveServerSocketIoTransports } from '../client/serverHttpBaseUrl';
import { getSocketIoProxyOptions } from '@/utils/proxy/socketIoProxy';
import {
    buildCurrentCliClientCompatibilitySocketAuth,
} from '@/api/clientCompatibility/cliClientCompatibility';

type SessionSocketConnection = Readonly<{
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    transport: ManagedConnectionTransport;
}>;

export function createSessionScopedSocketConnection(opts: { token: string; sessionId: string; machineId?: string; serverUrl?: string; connectTimeoutMs?: number }): SessionSocketConnection {
    const serverUrl = opts.serverUrl ? normalizeServerHttpBaseUrl(opts.serverUrl) : resolveServerHttpBaseUrl();
    const transports = resolveServerSocketIoTransports();
    return createHappierSocket({
        endpoint: serverUrl,
        token: opts.token,
        clientType: 'session-scoped',
        sessionId: opts.sessionId,
        ...(opts.machineId ? { machineId: opts.machineId } : {}),
        authExtras: {
            ...buildCurrentCliClientCompatibilitySocketAuth('session-runner'),
        },
        ...(transports ? { transports } : null),
        withCredentials: true,
        engineOptions: getSocketIoProxyOptions({ targetUrl: serverUrl, env: sessionProcessEnvironment() }),
        ...(opts.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: opts.connectTimeoutMs }),
    }) as SessionSocketConnection;
}

export function createSessionScopedSocket(opts: { token: string; sessionId: string; machineId?: string; serverUrl?: string }): Socket<ServerToClientEvents, ClientToServerEvents> {
    return createSessionScopedSocketConnection(opts).socket;
}

export function createUserScopedSocketConnection(opts: { token: string; serverUrl?: string; connectTimeoutMs?: number; authorityCeiling?: 'account_automation'; clientPurpose?: string }): SessionSocketConnection {
    const serverUrl = opts.serverUrl ? normalizeServerHttpBaseUrl(opts.serverUrl) : resolveServerHttpBaseUrl();
    const transports = resolveServerSocketIoTransports();
    return createHappierSocket({
        endpoint: serverUrl,
        token: opts.token,
        clientType: 'user-scoped',
        clientPurpose: opts.clientPurpose,
        authExtras: {
            ...buildCurrentCliClientCompatibilitySocketAuth('session-runner'),
            ...(opts.authorityCeiling === 'account_automation' ? { authorityCeiling: opts.authorityCeiling } : {}),
        },
        ...(transports ? { transports } : null),
        withCredentials: true,
        engineOptions: getSocketIoProxyOptions({ targetUrl: serverUrl, env: sessionProcessEnvironment() }),
        ...(opts.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: opts.connectTimeoutMs }),
    }) as SessionSocketConnection;
}

export function createUserScopedSocket(opts: { token: string; serverUrl?: string }): Socket<ServerToClientEvents, ClientToServerEvents> {
    return createUserScopedSocketConnection(opts).socket;
}
