import { vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { SessionSystemRecordStored } from '@happier-dev/protocol';
import type { SessionEffectiveAccessV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { assertBoundaryImportOrder, recordBoundaryImportOriginal } from './assertBoundaryImportOrder';
import { createCompactSessionListFetchBoundary, createSessionReadBatchFetchBoundary } from './sessionReadBatchHttpBoundary';

/** Session/record HTTP fixture below the real Sync, authority, repository and codec owners. */
export function createSessionSystemRecordHttpFixture(params: Readonly<{
    sessionId: string;
    records: readonly SessionSystemRecordStored[];
    encryptionMode?: 'plain' | 'e2ee';
    dataEncryptionKey?: string | null;
    effectiveAccess?: SessionEffectiveAccessV1;
}>) {
    const recordReads: string[] = [];
    const readSingle: NonNullable<Parameters<typeof import('@/utils/system/runtimeFetch').setRuntimeFetch>[0]> = async url => {
        const parsed = new URL(String(url));
        const prefix = `/v2/sessions/${encodeURIComponent(params.sessionId)}`;
        if (parsed.pathname === prefix) {
            const session = {
                id: params.sessionId, createdAt: 1, updatedAt: 2, seq: 0, active: true, activeAt: 2,
                encryptionMode: params.encryptionMode ?? 'plain', dataEncryptionKey: params.dataEncryptionKey ?? null,
                metadataVersion: 0, metadata: JSON.stringify({ path: '/repo', host: 'test' }),
                agentStateVersion: 1, agentState: null, share: null,
                ...(params.effectiveAccess ? { effectiveAccess: params.effectiveAccess,
                    responsibleAccountId: null, responsibleAccount: null } : {}),
            };
            // Negotiated access replies carry the complete responsibility projection;
            // the strict current reader must not reinterpret an omitted pair as unassigned.
            return Response.json({ session: params.effectiveAccess ? SessionCurrentProjectionRecordV1Schema.parse(session) : session });
        }
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
    // Session reads arrive on the batch wire; it composes the same single-Session facts.
    const request = createSessionReadBatchFetchBoundary(readSingle);
    return { request, recordReads };
}

type ConfigureSocketBoundary = (socket: Socket, serverUrl: string | undefined) => void;

/** The reachable authenticated Home probes shared by real connection fixtures. */
export function createServerAccountConnectionProbeHttpResponse(pathname: string): Response | null {
    return pathname === '/health' || pathname === '/v1/auth/ping' ? new Response('{}', { status: 200 }) : null;
}

/** Deliver the external SDK's successful dial through its real registered listeners. */
export function configureConnectedServerSocketBoundary(socket: Socket): void {
    socket.connected = false;
    socket.connect = vi.fn<typeof socket.connect>(() => {
        if (!socket.connected) {
            socket.connected = true;
            for (const listener of socket.listeners('connect')) listener();
        }
        return socket;
    });
}

type SocketResponder = Readonly<{ configure: ConfigureSocketBoundary }>;
const socketBoundary = vi.hoisted(() => ({
    configure: undefined as ConfigureSocketBoundary | undefined,
    responders: new Map<string, SocketResponder>(),
}));
let currentRuntimeFetchBoundary: object | undefined;

function socketResponderKey(serverUrl: string, token: string): string {
    return JSON.stringify([new URL(serverUrl).href.replace(/\/+$/, ''), token]);
}

/** Also reusable by cross-package suites whose host imports Socket before the UI harness. */
export async function createSocketIoClientBoundary(importOriginal: <T>() => Promise<T>) {
    const actual = await importOriginal<typeof import('socket.io-client')>();
    recordBoundaryImportOriginal(actual);
    const createSocket = (...args: Parameters<typeof actual.io>) => {
        const socket = actual.io(...args);
        // Capture the physical transport principal before a fixture configures
        // SDK methods. A later Home must never become this socket's authority.
        const auth = socket.auth;
        const token: unknown = typeof auth === 'object' && auth !== null ? auth.token : undefined;
        const responderKey = typeof args[0] === 'string' && typeof token === 'string'
            ? socketResponderKey(args[0], token) : null;
        let responder = responderKey ? socketBoundary.responders.get(responderKey) : undefined;
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
        (responder?.configure ?? socketBoundary.configure)?.(socket, args[0]);
        if (responderKey && responder) {
            let respond = socket.emitWithAck;
            const emitWithAck: typeof socket.emitWithAck = async (...emission) => {
                const current = socketBoundary.responders.get(responderKey);
                if (!current) throw new Error('Socket test responder retired for captured Home/auth principal');
                if (current !== responder) {
                    // The actual RPC pool may retain an idle socket across
                    // fixture replacement for this SAME endpoint/principal.
                    current.configure(socket, args[0]);
                    respond = socket.emitWithAck;
                    socket.emitWithAck = emitWithAck;
                    responder = current;
                }
                return await respond.apply(socket, emission);
            };
            socket.emitWithAck = emitWithAck;
        }
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
 * An optional Home/auth scope owns one external responder. Matching retained
 * physical sockets resolve its replacement at request time; other principals
 * retain their own responder. Disposal never removes a later replacement.
 */
export function installDisconnectedServerSocketBoundary(configure?: ConfigureSocketBoundary, scope?: Readonly<{
    serverUrl: string;
    token: string;
}>): Readonly<{ dispose(): void }> {
    assertBoundaryImportOrder('installDisconnectedServerSocketBoundary', ['socket.io-client']);
    const responder = configure && scope ? Object.freeze({ configure }) : null;
    const key = scope ? socketResponderKey(scope.serverUrl, scope.token) : null;
    if (responder && key) socketBoundary.responders.set(key, responder);
    else socketBoundary.configure = configure;
    vi.doMock('socket.io-client', createSocketIoClientBoundary);
    return { dispose() {
        if (key && socketBoundary.responders.get(key) === responder) socketBoundary.responders.delete(key);
    } };
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
    /** Warm Account replacement uses the real serialized switch, not cold restore. */
    activation?: 'switch';
    /** Explicit external Homes that may receive captured cleanup after replacement. */
    additionalRequestOrigins?: readonly string[];
    /** Cold Socket SDK responder owned by this exact restored Home/auth principal. */
    configureSocket?: ConfigureSocketBoundary;
    /** Unclaimed domain routes return null and remain HTTP 404, not network failures. */
    request?: (...args: Parameters<NonNullable<Parameters<typeof import('@/utils/system/runtimeFetch').setRuntimeFetch>[0]>>) => Promise<Response | null>;
}>) {
    // Match the app entry: the real implementation publishes the public Sync
    // singleton before connection restoration can hydrate or switch its Home.
    await import('@/sync/syncEngine');
    // Home-profile mutation itself uses the browser storage lock, before any
    // credential write or Account restoration can run.
    const webLocks = typeof globalThis.navigator?.locks?.request === 'function' ? null : installWebLockManagerMock();
    const { upsertServerProfileOnly, setActiveServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { setServerProfileIdentityForUrl, getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const { loadSyncSingletonForTests } = await import('./syncSingletonLoader');
    await loadSyncSingletonForTests();
    const { restoreConnectionToActiveServer, switchConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    // Restore is the app's cold Account lifecycle, not a switch over a prior Sync Account.
    if (params.activation !== 'switch') await disconnectActiveServerConnection();
    // Home activation may start readiness immediately; install its HTTP
    // boundary before activation rather than racing a real network request.
    const requestOrigins = new Set([params.serverUrl, ...(params.additionalRequestOrigins ?? [])].map(url => new URL(url).origin));
    const requestBoundary = createCompactSessionListFetchBoundary(async (url, init) => {
        const requestUrl = new URL(String(url));
        if (!requestOrigins.has(requestUrl.origin)) {
            throw new Error(`Unexpected test Home request origin: ${requestUrl.origin}`);
        }
        const probe = createServerAccountConnectionProbeHttpResponse(requestUrl.pathname);
        if (probe) return probe;
        return await params.request?.(url, init) ?? undefined;
    }, { preferExactSnapshot: true });
    currentRuntimeFetchBoundary = requestBoundary;
    setRuntimeFetch(requestBoundary);
    let home = await upsertServerProfileOnly({ serverUrl: params.serverUrl, name: 'Test Home' });
    if (params.serverIdentityId) {
        const identifiedHome = await setServerProfileIdentityForUrl(home.serverUrl, params.serverIdentityId);
        if (!identifiedHome) throw new Error('Test Home identity could not be established');
        home = identifiedHome;
    }
    const credentials = params.credentials ?? { token: `e30.${Buffer.from(JSON.stringify({ sub: params.accountId ?? 'account-a' })).toString('base64url')}.signature` };
    const { canonicalizeServerUrl } = await import('@/sync/domains/server/url/serverUrlCanonical');
    const restoredHomeUrl = canonicalizeServerUrl(home.serverUrl);
    // Device SDK storage is the boundary; the actual credential owner decides
    // Home qualification, legacy migration and mutation lifetime before activation.
    const credentialWrite = await TokenStorage.setCredentialsForServerUrlWithRollback(home.serverUrl, { serverId: params.serverIdentityId ?? home.id }, credentials);
    if (!credentialWrite) {
        webLocks?.restore();
        throw new Error('Test Home credentials could not be stored');
    }
    const socketResponder = params.configureSocket
        ? installDisconnectedServerSocketBoundary(params.configureSocket, { serverUrl: home.serverUrl, token: credentials.token }) : null;
    try {
        await setActiveServer({ serverId: home.id });
        if (params.activation === 'switch') await switchConnectionToActiveServer();
        else await restoreConnectionToActiveServer(credentials);
    } catch (error) {
        socketResponder?.dispose();
        if (currentRuntimeFetchBoundary === requestBoundary) {
            currentRuntimeFetchBoundary = undefined;
            resetRuntimeFetch();
        }
        await credentialWrite.rollback();
        webLocks?.restore();
        throw error;
    }
    // Restoration may adopt the Home's advertised portable identity. Return
    // the profile that owns the restored lifetime, rather than its pre-adoption alias.
    const restoredHome = getServerProfileById(getActiveServerSnapshot().serverId);
    if (!restoredHome || canonicalizeServerUrl(restoredHome.serverUrl) !== restoredHomeUrl) {
        socketResponder?.dispose();
        await credentialWrite.rollback();
        webLocks?.restore();
        throw new Error('Test Account restoration did not retain its Home');
    }
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    // Some callers deliberately serve no Profile route. Before Profile hydration
    // there is no content lifetime to capture, so the real connection generation
    // still fences disposal from a later activation of this same Home.
    const restoredGeneration = getActiveServerSnapshot().generation;
    return {
        home: restoredHome,
        serverId: getActiveServerSnapshot().serverId,
        credentials,
        async dispose() {
            try {
                if (currentRuntimeFetchBoundary === requestBoundary
                    && getActiveServerSnapshot().generation === restoredGeneration
                    && (!accountLifetime || accountLifetime.isCurrent())) {
                    await disconnectActiveServerConnection();
                }
            } finally {
                socketResponder?.dispose();
                if (currentRuntimeFetchBoundary === requestBoundary) {
                    currentRuntimeFetchBoundary = undefined;
                    resetRuntimeFetch();
                }
                try { await credentialWrite.rollback(); }
                finally { webLocks?.restore(); }
            }
        },
    };
}
