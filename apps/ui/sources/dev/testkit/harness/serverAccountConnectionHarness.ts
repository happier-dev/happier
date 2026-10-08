import { vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

type ConfigureSocketBoundary = (socket: Socket, serverUrl: string | undefined) => void;
const socketBoundary = vi.hoisted(() => ({ configure: undefined as ConfigureSocketBoundary | undefined }));

/** Also reusable by cross-package suites whose host imports Socket before the UI harness. */
export async function createSocketIoClientBoundary(importOriginal: <T>() => Promise<T>) {
    const actual = await importOriginal<typeof import('socket.io-client')>();
    const createSocket = (...args: Parameters<typeof actual.io>) => {
        const socket = actual.io(...args);
        vi.spyOn(socket, 'connect').mockReturnValue(socket);
        // Connected test sockets still use the real Socket's packet/ACK state,
        // but this fixture never opens Engine.IO. Stop outbound packets at the
        // SDK transport boundary instead of dereferencing a nonexistent engine.
        vi.spyOn(socket.io, '_packet').mockImplementation(() => undefined);
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

/**
 * Keep the real Socket and Sync owners; only the external transport is replaced.
 *
 * The `vi.mock` here is registered when this harness module loads. A test that statically imports a
 * transport owner (for example the transfer plumbing, whose server-scoped RPC pool imports
 * `socket.io-client`) before this harness binds the real client first. Such a test also registers
 * the boundary itself, so it is hoisted above every import:
 * `vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal))`.
 * This call then only configures it.
 */
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
    // Home-profile mutation itself uses the browser storage lock, before any
    // credential write or Account restoration can run.
    const webLocks = typeof globalThis.navigator?.locks?.request === 'function' ? null : installWebLockManagerMock();
    const { upsertServerProfileOnly, setActiveServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const { loadSyncSingletonForTests } = await import('./syncSingletonLoader');
    await loadSyncSingletonForTests();
    const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    // Restore is the app's cold Account lifecycle, not a switch over a prior Sync Account.
    await disconnectActiveServerConnection();
    // Home activation may start readiness immediately; install its HTTP
    // boundary before activation rather than racing a real network request.
    setRuntimeFetch(async (url, init) => {
        const requestUrl = new URL(String(url));
        if (requestUrl.origin !== new URL(params.serverUrl).origin) {
            throw new Error(`Unexpected test Home request origin: ${requestUrl.origin}`);
        }
        if (requestUrl.pathname === '/health' || requestUrl.pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        return params.request ? params.request(url, init) : new Response('{}', { status: 404 });
    });
    let home = await upsertServerProfileOnly({ serverUrl: params.serverUrl, name: 'Test Home' });
    if (params.serverIdentityId) {
        const identifiedHome = await setServerProfileIdentityForUrl(home.serverUrl, params.serverIdentityId);
        if (!identifiedHome) throw new Error('Test Home identity could not be established');
        home = identifiedHome;
    }
    const credentials = params.credentials ?? { token: `e30.${Buffer.from(JSON.stringify({ sub: params.accountId ?? 'account-a' })).toString('base64url')}.signature` };
    // Exercise genuine credential custody. Only browser locking is replaced;
    // other saved Homes retain their own credentials and lookup semantics.
    const credentialWrite = await TokenStorage.setCredentialsForServerUrlWithRollback(
        home.serverUrl, { serverId: params.serverIdentityId ?? home.id }, credentials,
    );
    if (!credentialWrite) {
        webLocks?.restore();
        throw new Error('Test Home credentials could not be persisted');
    }
    // Home activation can start a connection immediately; its credentials must already be present.
    await setActiveServer({ serverId: home.id });
    await restoreConnectionToActiveServer(credentials);
    return {
        home,
        /** Runtime/session scope uses the advertised identity; home.id remains the saved device profile id. */
        serverId: getActiveServerSnapshot().serverId,
        credentials,
        async dispose() {
            await disconnectActiveServerConnection();
            resetRuntimeFetch();
            await credentialWrite.rollback();
            webLocks?.restore();
        },
    };
}
