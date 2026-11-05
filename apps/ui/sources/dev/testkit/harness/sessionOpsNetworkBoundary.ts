import { vi } from 'vitest';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createPlainAccountEncryptionCurrentnessFixture } from '../fixtures/accountEncryptionCurrentness';
import { createSessionReadBatchFetchBoundary } from './sessionReadBatchHttpBoundary';
import { waitForTestEvent } from '../hooks/waitForTestEvent';

export type SessionOpsRpcRequest = Readonly<{
    serverUrl: string;
    token: string | undefined;
    targetId: string;
    method: string;
    payload: unknown;
    timeoutMs: number | null;
}>;

export type SessionOpsRpcAck =
    | Readonly<{ ok: true; result: unknown }>
    | Readonly<{ ok: false; error: string; errorCode?: string }>;

export type SessionOpsSocketAckRequest = Readonly<{
    serverUrl: string;
    token: string | undefined;
    event: string;
    payload: unknown;
    timeoutMs: number | null;
}>;

type SessionOpsHttpResponder = (...args: Parameters<RuntimeFetch>) => Promise<Response | null>;
type SessionOpsSocketOptions = Readonly<{ auth?: { token?: string; clientPurpose?: unknown }; transports?: unknown }>;
type SessionOpsSocketBoundary = ReturnType<typeof import('../mocks/socketIo').createSocketIoBoundaryStub> & Readonly<{
    serverUrl: string;
    token: string | undefined;
    options: SessionOpsSocketOptions;
}>;
type SessionOpsSocketFactory = (serverUrl: string, options: SessionOpsSocketOptions) => SessionOpsSocketBoundary['socket'];

// Runtime consumers retain the SDK import between fixture installations.
const installedSocketBoundary = vi.hoisted(() => ({ current: null as SessionOpsSocketFactory | null }));

export type SessionOpsNetworkBoundary = Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;

/** Scoped operations use real Home/Account admission and custody; only network and device locking are replaced. */
export async function installSessionOpsNetworkBoundary() {
    const requests: SessionOpsRpcRequest[] = [];
    const rpcListeners = new Set<() => void>();
    const responses = new Map<string, unknown>();
    let rpcResponder: ((request: SessionOpsRpcRequest) => Promise<unknown>) | null = null;
    let rpcAckResponder: ((request: SessionOpsRpcRequest) => Promise<SessionOpsRpcAck>) | null = null;
    let httpResponder: SessionOpsHttpResponder | null = null;
    let socketAckResponder: ((request: SessionOpsSocketAckRequest) => Promise<unknown | null>) | null = null;
    let socketConfigurator: ((boundary: SessionOpsSocketBoundary) => void) | null = null;
    const sockets: Array<{ disconnect(): unknown }> = [];
    const socketBoundaries: SessionOpsSocketBoundary[] = [];
    const { createSocketIoBoundaryStub } = await import('../mocks/socketIo');
    const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
    const { RPC_ERROR_CODES } = await import('@happier-dev/protocol/rpc');
    const createSocket: SessionOpsSocketFactory = (serverUrl, options) => {
        const boundary = createSocketIoBoundaryStub();
        const { socket } = boundary;
        sockets.push(socket);
        const recordedBoundary = { ...boundary, serverUrl, token: options.auth?.token, options };
        socketBoundaries.push(recordedBoundary);
        let timeoutMs: number | null = null;
        // Pooled sockets retain this transport across a test's spy restoration.
        socket.timeout = vi.fn((value: number) => {
            timeoutMs = value ?? null;
            return { emitWithAck: socket.emitWithAck };
        });
        socket.emitWithAck = vi.fn(async (event: string, payload?: unknown): Promise<unknown> => {
            if (event !== SOCKET_RPC_EVENTS.CALL) {
                const response = socketAckResponder ? await socketAckResponder({
                    serverUrl, token: options.auth?.token, event, payload, timeoutMs,
                }) : null;
                return response !== null ? response : { v: 1, ok: true, admittedSessionIds: [] };
            }
            if (!payload || typeof payload !== 'object' || !('method' in payload)
                || typeof payload.method !== 'string' || !('params' in payload)) {
                throw new Error('Malformed Socket RPC request');
            }
            const separator = payload.method.indexOf(':');
            const method = payload.method.slice(separator + 1);
            const request: SessionOpsRpcRequest = { serverUrl, token: options.auth?.token,
                targetId: payload.method.slice(0, separator), method, payload: payload.params, timeoutMs };
            requests.push(request);
            for (const notify of rpcListeners) notify();
            if (rpcAckResponder) return await rpcAckResponder(request);
            if (rpcResponder) return { ok: true, result: await rpcResponder(request) };
            if (!responses.has(method)) {
                return { ok: false, error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            return { ok: true, result: responses.get(method) };
        });
        socketConfigurator?.(recordedBoundary);
        return socket;
    };
    installedSocketBoundary.current = createSocket;
    vi.doMock('socket.io-client', async (importOriginal) => {
        const actual = await importOriginal<typeof import('socket.io-client')>();
        return {
            ...actual,
            io: (serverUrl: string, options: SessionOpsSocketOptions) => {
                const current = installedSocketBoundary.current;
                if (!current) throw new Error('Session operations Socket boundary is not installed');
                return current(serverUrl, options);
            },
        };
    });

    // This harness serves scoped saved Homes. It does not fabricate a focused Sync Account.
    const { upsertServerProfile, adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const { createPlainMachineRowFixture, createMachineReadBatchResponseFixture } = await import('../fixtures/machineFixtures');
    const { createAccountTokenForTests } = await import('./homeGovernanceHarness');
    const { createAccountSettingsHttpBoundary } = await import('./actionHomesHttpHarness');
    const { canonicalizeServerUrl } = await import('@/sync/domains/server/url/serverUrlCanonical');
    const { installWebLockManagerMock, installLocalStorageMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
    const { Platform } = await import('react-native');
    const browserStorage = (globalThis as { window?: { localStorage?: Storage } }).window?.localStorage
        ?? globalThis.localStorage;
    const localStorage = Platform.OS === 'web' && typeof browserStorage?.getItem !== 'function'
        ? installLocalStorageMock() : null;
    const locks = typeof globalThis.navigator?.locks?.request === 'function' ? null : installWebLockManagerMock();
    const homes = new Map<string, {
        serverId: string;
        accountId: string;
        encryptionMode: 'plain' | 'e2ee';
        settings: ReturnType<typeof createAccountSettingsHttpBoundary>;
    }>();
    const credentialWrites: Array<NonNullable<Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>>>> = [];
    const credentialRequests: Array<{ serverUrl: string; serverId: string | undefined }> = [];
    const readCredentials = TokenStorage.getCredentialsForServerUrl;
    const observeCredentialRead: typeof TokenStorage.getCredentialsForServerUrl = async (serverUrl, options) => {
        credentialRequests.push({ serverUrl, serverId: options?.serverId ?? undefined });
        return await readCredentials.call(TokenStorage, serverUrl, options);
    };
    // Observation only: the real credential owner admits every served and unserved Home.
    let credentialObserver = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(observeCredentialRead);
    const httpRequests: Array<{ url: string; token: string | null; method: string }> = [];
    const runtimeFetchBoundary: RuntimeFetch = createSessionReadBatchFetchBoundary(async (input, init) => {
        const url = new URL(String(input));
        const token = new Headers(init?.headers).get('authorization');
        httpRequests.push({ url: url.href, token, method: (init?.method ?? 'GET').toUpperCase() });
        if (!homes.has(url.origin)) throw new Error(`Unexpected test Home: ${url.origin}`);
        const response = httpResponder ? await httpResponder(input, init) : null;
        if (response !== null) return response;
        const settingsResponse = homes.get(url.origin)!.settings.handle(input, init);
        if (settingsResponse) return settingsResponse;
        // Public saved-Home discovery uses a tokenless readiness probe whose
        // contract is the HTTP status, not a response body.
        if (url.pathname === '/health') return new Response(null, { status: 200 });
        if (url.pathname === '/v1/auth/ping') return Response.json({});
        if (url.pathname === '/v1/account/encryption') return Response.json({ mode: homes.get(url.origin)!.encryptionMode, updatedAt: 1 });
        if (url.pathname === '/v1/account/encryption/currentness' && homes.get(url.origin)!.encryptionMode === 'plain') {
            return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        }
        if (url.pathname === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
        const accountId = homes.get(url.origin)?.accountId;
        if (!accountId) throw new Error(`Test Home Account is unavailable: ${url.origin}`);
        if (url.pathname === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
            id => createPlainMachineRowFixture({ id, accountId }));
        if (url.pathname === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'machine-1', accountId })]);
        if (url.pathname.startsWith('/v1/machines/')) return Response.json({ machine: createPlainMachineRowFixture({
            id: decodeURIComponent(url.pathname.slice('/v1/machines/'.length)), accountId,
        }) });
        return Response.json({ error: 'not_found' }, { status: 404 });
    });
    setRuntimeFetch(runtimeFetchBoundary);
    return {
        requests,
        httpRequests,
        request: runtimeFetchBoundary,
        subscribeRpcRequests(notify: () => void) {
            rpcListeners.add(notify);
            return () => { rpcListeners.delete(notify); };
        },
        async waitForRpcRequest(predicate: (request: SessionOpsRpcRequest, all: readonly SessionOpsRpcRequest[]) => boolean) {
            const request = await waitForTestEvent(notify => {
                rpcListeners.add(notify);
                return () => { rpcListeners.delete(notify); };
            }, () => requests.find(value => predicate(value, requests)), value => value !== undefined);
            return request!;
        },
        get credentialRequests() {
            return credentialRequests;
        },
        socketBoundaries,
        resetRequests() {
            // The global UI cleanup retires runtimeFetch after every test.
            setRuntimeFetch(runtimeFetchBoundary);
            credentialObserver.mockRestore();
            credentialObserver = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(observeCredentialRead);
            credentialRequests.length = 0;
            requests.length = 0;
            httpRequests.length = 0;
            socketBoundaries.length = 0;
            responses.clear();
            rpcResponder = null;
            rpcAckResponder = null;
            httpResponder = null;
            socketAckResponder = null;
            socketConfigurator = null;
        },
        respond(method: string, response: unknown) { responses.set(method, response); },
        setRpcResponder(responder: (request: SessionOpsRpcRequest) => Promise<unknown>) {
            rpcResponder = responder;
        },
        setRpcAckResponder(responder: (request: SessionOpsRpcRequest) => Promise<SessionOpsRpcAck>) {
            rpcAckResponder = responder;
        },
        setHttpResponder(responder: SessionOpsHttpResponder) {
            httpResponder = responder;
        },
        setSocketAckResponder(responder: (request: SessionOpsSocketAckRequest) => Promise<unknown | null>) {
            socketAckResponder = responder;
        },
        setSocketConfigurator(configure: (boundary: SessionOpsSocketBoundary) => void) {
            socketConfigurator = configure;
        },
        async setAccount(homeUrl: string, accountId: string) {
            const serverUrl = canonicalizeServerUrl(homeUrl);
            const home = homes.get(serverUrl);
            if (!home) throw new Error(`Test Home is not registered: ${serverUrl}`);
            const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
            const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
            const applied = getActiveServerAccountScope()?.serverId === resolveServerProfileScopeIdForIdentifier(home.serverId);
            const { disconnectActiveServerConnection, restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
            if (applied) await disconnectActiveServerConnection();
            const credentials = { token: createAccountTokenForTests(accountId) };
            const write = await TokenStorage.setCredentialsForServerUrlWithRollback(serverUrl, { serverId: home.serverId }, credentials);
            if (!write) throw new Error(`Test Home credential replacement was refused: ${serverUrl}`);
            credentialWrites.push(write);
            home.accountId = accountId;
            if (applied) await restoreConnectionToActiveServer(credentials);
        },
        async addHome(serverUrl: string, accountId: string, options: Readonly<{
            credentials?: AuthCredentials; encryptionMode?: 'plain' | 'e2ee';
            /** Adopts the Home with its server identity and a present-user Account token, as Actions carried over the Account external-Action carrier require. */
            serverIdentityId?: string;
        }> = {}) {
            const profile = options.serverIdentityId
                ? await adoptHomeProfile({ descriptor: { serverUrl, homeServerIdentityId: options.serverIdentityId, displayName: accountId },
                    source: 'manual', suggestedName: accountId })
                : await upsertServerProfile({ serverUrl, name: accountId });
            const credentials = options.credentials ?? { token: createAccountTokenForTests(accountId, { currentAccount: Boolean(options.serverIdentityId) }) };
            const write = await TokenStorage.setCredentialsForServerUrlWithRollback(profile.serverUrl, { serverId: profile.id }, credentials);
            if (!write) throw new Error(`Test Home credential publication was refused: ${profile.serverUrl}`);
            credentialWrites.push(write);
            const encryptionMode = options.encryptionMode ?? 'plain';
            const settings = homes.get(profile.serverUrl)?.settings ?? createAccountSettingsHttpBoundary({
                serverUrl: profile.serverUrl, initialAccounts: [],
            });
            settings.replaceAccountSettings(accountId, encryptionMode === 'plain'
                ? { content: { t: 'plain', v: {} }, version: 1 }
                : { content: null, version: 0 });
            homes.set(profile.serverUrl, { serverId: profile.id, accountId, encryptionMode, settings });
            const token = credentials.token;
            return { ...profile, accountId, token };
        },
        async dispose() {
            const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
            try {
                // A lease disconnect returns custody to the pool. Retire that
                // custody before clearing this fixture's transport responders.
                await serverScopedRpcSocketPool.stopAll();
            } finally {
                rpcListeners.clear();
                rpcResponder = null;
                rpcAckResponder = null;
                httpResponder = null;
                socketAckResponder = null;
                socketConfigurator = null;
                for (const socket of sockets) socket.disconnect();
                resetRuntimeFetch();
                credentialObserver.mockRestore();
                if (installedSocketBoundary.current === createSocket) {
                    installedSocketBoundary.current = null;
                    vi.doUnmock('socket.io-client');
                }
                try { for (const write of credentialWrites.splice(0).reverse()) await write.rollback(); }
                finally { locks?.restore(); localStorage?.restore(); }
            }
        },
    };
}
