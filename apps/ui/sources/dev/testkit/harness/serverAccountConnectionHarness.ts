import { vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { SessionSystemRecordStored } from '@happier-dev/protocol';

/** Session/record HTTP fixture below the real Sync, authority, repository and codec owners. */
export function createSessionSystemRecordHttpFixture(params: Readonly<{
    sessionId: string;
    records: readonly SessionSystemRecordStored[];
    encryptionMode?: 'plain' | 'e2ee';
    dataEncryptionKey?: string | null;
}>) {
    const recordReads: string[] = [];
    const request: NonNullable<Parameters<typeof import('@/utils/system/runtimeFetch').setRuntimeFetch>[0]> = async url => {
        const parsed = new URL(String(url));
        const prefix = `/v2/sessions/${encodeURIComponent(params.sessionId)}`;
        if (parsed.pathname === prefix) return Response.json({ session: {
            id: params.sessionId, createdAt: 1, updatedAt: 2, seq: 0, active: true, activeAt: 2,
            encryptionMode: params.encryptionMode ?? 'plain', dataEncryptionKey: params.dataEncryptionKey ?? null,
            metadataVersion: 0, metadata: JSON.stringify({ path: '/repo', host: 'test' }),
            agentStateVersion: 1, agentState: null, share: null,
        } });
        if (parsed.pathname === `${prefix}/system-records/record`) {
            const localId = parsed.searchParams.get('localId');
            if (localId) recordReads.push(localId);
            const record = params.records.find(candidate => candidate.address.owner === parsed.searchParams.get('owner')
                && candidate.address.namespace === parsed.searchParams.get('namespace')
                && candidate.address.kind === parsed.searchParams.get('kind') && candidate.address.localId === localId);
            return Response.json({ record: record ?? null });
        }
        return new Response('{}', { status: 404 });
    };
    return { request, recordReads };
}

type ConfigureSocketBoundary = (socket: Socket, serverUrl: string | undefined) => void;
const socketBoundary = vi.hoisted(() => ({ configure: undefined as ConfigureSocketBoundary | undefined }));

/** Also reusable by cross-package suites whose host imports Socket before the UI harness. */
export async function createSocketIoClientBoundary(importOriginal: <T>() => Promise<T>) {
    const actual = await importOriginal<typeof import('socket.io-client')>();
    const createSocket = (...args: Parameters<typeof actual.io>) => {
        const socket = actual.io(...args);
        // These replacements belong to this cold external transport for its
        // entire lifetime, including teardown after a test restores its spies.
        socket.connect = vi.fn<typeof socket.connect>(() => socket);
        // Keep real Socket packet/ACK state; stop Engine.IO packets at its transport boundary.
        socket.io._packet = vi.fn<typeof socket.io._packet>(() => undefined);
        // This cold SDK fixture never opens an Engine.IO connection or creates
        // namespace/ACK teardown state. Deliver the external disconnect event
        // through the real listeners; Sync and Account lifetime teardown stay real.
        socket.disconnect = vi.fn<typeof socket.disconnect>(() => {
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
 * Install only when requested: importing this harness through a barrel must not
 * replace another suite's Socket.IO boundary. A test that statically imports a
 * transport owner also registers the boundary itself, hoisted above every import:
 * `vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal))`.
 * This call then only configures it.
 */
export function installDisconnectedServerSocketBoundary(configure?: ConfigureSocketBoundary): void {
    socketBoundary.configure = configure;
    vi.doMock('socket.io-client', createSocketIoClientBoundary);
}

/** Apply a real Account lifetime before a test installs its domain data or fake clock. */
export async function restoreServerAccountForTest(params: Readonly<{
    serverUrl: string;
    /** Advertised Home identity, established before its Account lifetime starts. */
    serverIdentityId?: string;
    accountId?: string;
    /** Genuine synthetic credentials for tests exercising encrypted Account/Session owners. */
    credentials?: AuthCredentials;
    /** Other saved Homes remain signed out in a single-Home boundary fixture. */
    credentialScope?: 'restored-home';
    request?: NonNullable<Parameters<typeof import('@/utils/system/runtimeFetch').setRuntimeFetch>[0]>;
}>) {
    // Match the app entry: the real implementation publishes the public Sync
    // singleton before connection restoration can hydrate or switch its Home.
    await import('@/sync/syncEngine');
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
