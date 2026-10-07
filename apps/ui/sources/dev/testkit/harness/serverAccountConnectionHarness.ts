import { vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

type ConfigureSocketBoundary = (socket: Socket, serverUrl: string | undefined) => void;
const socketBoundary = vi.hoisted(() => ({ configure: undefined as ConfigureSocketBoundary | undefined }));

/** Also reusable by cross-package suites whose host imports Socket before the UI harness. */
export async function createSocketIoClientBoundary(importOriginal: <T>() => Promise<T>) {
    const actual = await importOriginal<typeof import('socket.io-client')>();
    const createSocket = (...args: Parameters<typeof actual.io>) => {
        const socket = actual.io(...args);
        vi.spyOn(socket, 'connect').mockReturnValue(socket);
        // This cold SDK fixture never opens an Engine.IO connection or creates
        // namespace/ACK teardown state. Deliver the external disconnect event
        // through the real listeners; Sync and Account lifetime teardown stay real.
        vi.spyOn(socket, 'disconnect').mockImplementation(() => {
            if (!socket.connected) return socket;
            socket.connected = false;
            for (const listener of socket.listeners('disconnect')) listener('io client disconnect');
            return socket;
        });
        socketBoundary.configure?.(socket, args[0]);
        return socket;
    };
    // Socket.IO publishes one callable namespace through io/connect/default in
    // both ESM and CommonJS. Keep every alias on this same transport boundary.
    const factory = Object.assign(createSocket, actual.io, { io: createSocket, connect: createSocket });
    return { ...actual, io: factory, connect: factory, default: factory };
}

/** Keep the real Socket and Sync owners; only the external transport is replaced. */
export function installDisconnectedServerSocketBoundary(configure?: ConfigureSocketBoundary): void {
    socketBoundary.configure = configure;
    vi.mock('socket.io-client', createSocketIoClientBoundary);
}

/** Apply a real Account lifetime before a test installs its domain data or fake clock. */
export async function restoreServerAccountForTest(params: Readonly<{
    serverUrl: string;
    /** Advertised Home identity, established before its Account lifetime starts. */
    serverIdentityId?: string;
    accountId?: string;
    /** Genuine synthetic credentials for tests exercising encrypted Account/Session owners. */
    credentials?: AuthCredentials;
    request?: NonNullable<Parameters<typeof import('@/utils/system/runtimeFetch').setRuntimeFetch>[0]>;
}>) {
    const { upsertServerProfileOnly, setActiveServer } = await import('@/sync/domains/server/serverRuntime');
    const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    // Home activation may start readiness immediately; install its HTTP
    // boundary before activation rather than racing a real network request.
    setRuntimeFetch(async (url, init) => {
        const requestUrl = new URL(String(url));
        if (requestUrl.origin !== new URL(params.serverUrl).origin) {
            throw new Error(`Unexpected test Home request origin: ${requestUrl.origin}`);
        }
        if (requestUrl.pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        return params.request ? params.request(url, init) : new Response('{}', { status: 404 });
    });
    let home = await upsertServerProfileOnly({ serverUrl: params.serverUrl, name: 'Test Home' });
    if (params.serverIdentityId) {
        const identifiedHome = await setServerProfileIdentityForUrl(home.serverUrl, params.serverIdentityId);
        if (!identifiedHome) throw new Error('Test Home identity could not be established');
        home = identifiedHome;
    }
    await setActiveServer({ serverId: home.id });
    const credentials = params.credentials ?? { token: `e30.${Buffer.from(JSON.stringify({ sub: params.accountId ?? 'account-a' })).toString('base64url')}.signature` };
    const credentialBoundary = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
    await restoreConnectionToActiveServer(credentials);
    return {
        home,
        credentials,
        async dispose() {
            await disconnectActiveServerConnection();
            resetRuntimeFetch();
            credentialBoundary.mockRestore();
        },
    };
}
