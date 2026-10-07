import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import type { Socket } from 'socket.io-client';
import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';
import { createHappierSocket } from '@happier-dev/sync-client';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl, resolveServerSocketIoTransports } from '../client/serverHttpBaseUrl';
import { getSocketIoProxyOptions } from '@/utils/proxy/socketIoProxy';
import { buildTerminalAuthorityCeiling } from '@/settings/accountSettings/resolveEffectiveTerminalPresentUserPolicy';
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
            ...buildTerminalAuthorityCeiling({ token: opts.token, serverHttpBaseUrl: serverUrl }),
        },
        ...(transports ? { transports } : null),
        withCredentials: true,
        engineOptions: getSocketIoProxyOptions({ targetUrl: serverUrl, env: process.env }),
        ...(opts.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: opts.connectTimeoutMs }),
    }) as SessionSocketConnection;
}

export function createSessionScopedSocket(opts: { token: string; sessionId: string; machineId?: string; serverUrl?: string }): Socket<ServerToClientEvents, ClientToServerEvents> {
    return createSessionScopedSocketConnection(opts).socket;
}

export function createUserScopedSocketConnection(opts: { token: string; serverUrl?: string; connectTimeoutMs?: number; authorityCeiling?: 'account_automation' }): SessionSocketConnection {
    const serverUrl = opts.serverUrl ? normalizeServerHttpBaseUrl(opts.serverUrl) : resolveServerHttpBaseUrl();
    const transports = resolveServerSocketIoTransports();
    return createHappierSocket({
        endpoint: serverUrl,
        token: opts.token,
        clientType: 'user-scoped',
        authExtras: {
            ...buildCurrentCliClientCompatibilitySocketAuth('session-runner'),
            ...buildTerminalAuthorityCeiling({ token: opts.token, serverHttpBaseUrl: serverUrl }),
            ...(opts.authorityCeiling === 'account_automation' ? { authorityCeiling: opts.authorityCeiling } : {}),
        },
        ...(transports ? { transports } : null),
        withCredentials: true,
        engineOptions: getSocketIoProxyOptions({ targetUrl: serverUrl, env: process.env }),
        ...(opts.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: opts.connectTimeoutMs }),
    }) as SessionSocketConnection;
}

export function createUserScopedSocket(opts: { token: string; serverUrl?: string }): Socket<ServerToClientEvents, ClientToServerEvents> {
    return createUserScopedSocketConnection(opts).socket;
}
