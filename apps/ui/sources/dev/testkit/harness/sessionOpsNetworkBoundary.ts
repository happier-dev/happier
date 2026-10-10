import { vi } from 'vitest';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';

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
type SessionOpsSocketBoundary = ReturnType<typeof import('../mocks/socketIo').createSocketIoBoundaryStub> & Readonly<{
    serverUrl: string;
    token: string | undefined;
}>;

export type SessionOpsNetworkBoundary = Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;

/** Scoped operations use real Home/Account admission; only network and device credentials are replaced. */
export async function installSessionOpsNetworkBoundary() {
    const requests: SessionOpsRpcRequest[] = [];
    const responses = new Map<string, unknown>();
    let rpcResponder: ((request: SessionOpsRpcRequest) => Promise<unknown>) | null = null;
    let rpcAckResponder: ((request: SessionOpsRpcRequest) => Promise<SessionOpsRpcAck>) | null = null;
    let httpResponder: SessionOpsHttpResponder | null = null;
    let socketAckResponder: ((request: SessionOpsSocketAckRequest) => Promise<unknown | null>) | null = null;
    let socketConfigurator: ((boundary: SessionOpsSocketBoundary) => void) | null = null;
    const sockets: Array<{ disconnect(): unknown }> = [];
    const socketBoundaries: SessionOpsSocketBoundary[] = [];
    vi.doMock('socket.io-client', async (importOriginal) => {
        const actual = await importOriginal<typeof import('socket.io-client')>();
        const { createSocketIoBoundaryStub } = await import('../mocks/socketIo');
        const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
        const { RPC_ERROR_CODES } = await import('@happier-dev/protocol/rpc');
        return {
            ...actual,
            io: (serverUrl: string, options: { auth?: { token?: string } }) => {
                const boundary = createSocketIoBoundaryStub();
                const { socket } = boundary;
                sockets.push(socket);
                const recordedBoundary = { ...boundary, serverUrl, token: options.auth?.token };
                socketBoundaries.push(recordedBoundary);
                let timeoutMs: number | null = null;
                socket.timeout.mockImplementation((value) => {
                    timeoutMs = value;
                    return { emitWithAck: socket.emitWithAck };
                });
                socket.emitWithAck.mockImplementation(async (event, payload) => {
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
                    if (rpcAckResponder) return await rpcAckResponder(request);
                    if (rpcResponder) return { ok: true, result: await rpcResponder(request) };
                    if (!responses.has(method)) {
                        return { ok: false, error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
                    }
                    return { ok: true, result: responses.get(method) };
                });
                socketConfigurator?.(recordedBoundary);
                return socket;
            },
        };
    });

    // This harness serves scoped saved Homes. It does not fabricate a focused Sync Account.
    const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const { MACHINE_PLAIN_DATA_KEY_MARKER } = await import('@happier-dev/protocol');
    const { createAccountTokenForTests } = await import('./homeGovernanceHarness');
    const { canonicalizeServerUrl } = await import('@/sync/domains/server/url/serverUrlCanonical');
    const homes = new Map<string, string>();
    const credentialRequests: Array<{ serverUrl: string; serverId: string | undefined }> = [];
    const readBoundaryCredentials: typeof TokenStorage.getCredentialsForServerUrl = async (serverUrl, options) => {
        credentialRequests.push({ serverUrl, serverId: options?.serverId ?? undefined });
        const token = homes.get(serverUrl);
        return token ? { token } : null;
    };
    let credentialBoundary = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(readBoundaryCredentials);
    const httpRequests: Array<{ url: string; token: string | null }> = [];
    const runtimeFetchBoundary: RuntimeFetch = async (input, init) => {
        const url = new URL(String(input));
        const token = new Headers(init?.headers).get('authorization');
        httpRequests.push({ url: url.href, token });
        if (!homes.has(url.origin)) throw new Error(`Unexpected test Home: ${url.origin}`);
        const response = httpResponder ? await httpResponder(input, init) : null;
        if (response !== null) return response;
        // Public saved-Home discovery uses a tokenless readiness probe whose
        // contract is the HTTP status, not a response body.
        if (url.pathname === '/health') return new Response(null, { status: 200 });
        if (url.pathname === '/v1/auth/ping') return Response.json({});
        if (url.pathname.startsWith('/v1/machines/')) return Response.json({ machine: {
            id: decodeURIComponent(url.pathname.slice('/v1/machines/'.length)),
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        } });
        return Response.json({}, { status: 404 });
    };
    setRuntimeFetch(runtimeFetchBoundary);
    return {
        requests,
        httpRequests,
        credentialRequests,
        socketBoundaries,
        resetRequests() {
            // The global UI cleanup retires runtimeFetch after every test.
            setRuntimeFetch(runtimeFetchBoundary);
            // Real-custody cases restore this shortcut to exercise the native
            // credential parser/mutation owner. A reused fixture starts the
            // next case with its original external credential boundary again.
            credentialBoundary.mockRestore();
            credentialBoundary = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(readBoundaryCredentials);
            requests.length = 0;
            httpRequests.length = 0;
            credentialRequests.length = 0;
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
        setAccount(homeUrl: string, accountId: string) {
            const serverUrl = canonicalizeServerUrl(homeUrl);
            if (!homes.has(serverUrl)) throw new Error(`Test Home is not registered: ${serverUrl}`);
            homes.set(serverUrl, createAccountTokenForTests(accountId));
        },
        async addHome(serverUrl: string, accountId: string) {
            const profile = await upsertServerProfile({ serverUrl, name: accountId });
            const token = createAccountTokenForTests(accountId);
            homes.set(profile.serverUrl, token);
            return { ...profile, accountId, token };
        },
        dispose() {
            rpcResponder = null;
            rpcAckResponder = null;
            httpResponder = null;
            socketAckResponder = null;
            socketConfigurator = null;
            for (const socket of sockets) socket.disconnect();
            resetRuntimeFetch();
            credentialBoundary.mockRestore();
            vi.doUnmock('socket.io-client');
        },
    };
}
