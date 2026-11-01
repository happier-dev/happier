import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io, type Socket } from 'socket.io-client';
import { expect, it } from 'vitest';
import { callSocketRpc, createHappierSocket, emitWithAckCancellable, readRpcRequestDisposition } from '@happier-dev/sync-client';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createServerScopedRpcSocketPool } from './serverScopedRpcSocketPool';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from './serverScopedRpcTypes';

it.each([
    { firstTimeoutMs: 100, secondTimeoutMs: 2_000 },
    { firstTimeoutMs: 2_000, secondTimeoutMs: 100 },
])('lets a longer waiter acquire after a short waiter expires (first caller: $firstTimeoutMs ms)', async ({ firstTimeoutMs, secondTimeoutMs }) => {
    const http = createServer();
    const server = new Server(http, { path: '/v1/updates/' });
    let admitConnection!: () => void;
    const admitted = new Promise<void>((resolve) => { admitConnection = resolve; });
    let observeHandshake!: () => void;
    const handshake = new Promise<void>((resolve) => { observeHandshake = resolve; });
    server.use(async (_socket, next) => {
        observeHandshake();
        await admitted;
        next();
    });
    await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve); });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback server address');
    const sockets: Socket[] = [];
    const pool = createServerScopedRpcSocketPool({
        createSocket: ({ serverUrl }) => {
            const socket = io(serverUrl, { path: '/v1/updates/', autoConnect: false, reconnection: false, forceNew: true });
            socket.io.timeout(false);
            sockets.push(socket);
            return socket;
        },
        reachability: {
            startReachability: async () => {}, waitForReachable: async () => {},
            subscribeNetworkAllowed: () => () => {},
        },
        readIdleDisconnectMs: () => 0,
    });
    const scope = { serverUrl: `http://127.0.0.1:${address.port}`, token: 'synthetic-token' };
    try {
        const first = pool.acquire({ ...scope, timeoutMs: firstTimeoutMs });
        const second = pool.acquire({ ...scope, timeoutMs: secondTimeoutMs });
        const short = (firstTimeoutMs < secondTimeoutMs ? first : second).catch((error: unknown) => error);
        const long = firstTimeoutMs > secondTimeoutMs ? first : second;
        const longOutcome = long.catch((error: unknown) => error);
        await handshake;
        expect(await short).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT' });
        admitConnection();
        const client = await longOutcome;
        expect(client).not.toBeInstanceOf(Error);
        if (client instanceof Error) throw client;
        expect(sockets).toHaveLength(1);
        expect(sockets[0]?.connected).toBe(true);
        (await long).disconnect();
    } finally {
        admitConnection();
        await pool.stopAll();
        await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
});

it('delivers a later Describe while a sibling RPC holds an ACK on the same pooled socket', async () => {
    const http = createServer();
    const server = new Server(http, { path: '/v1/updates/' });
    let acknowledgeHeld!: (value: unknown) => void;
    let received!: () => void;
    const issued = new Promise<void>(resolve => { received = resolve; });
    server.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL,
        (request: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
            if (request.requestId === 'held-rpc') { acknowledgeHeld = ack; received(); }
            else ack({ ok: true, result: { completed: 'describe' } });
        }));
    await new Promise<void>(resolve => { http.listen(0, '127.0.0.1', resolve); });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback server address');
    const physical: Socket[] = [];
    const pool = createServerScopedRpcSocketPool({
        createSocket: ({ serverUrl, token }) => {
            const { socket } = createHappierSocket({ endpoint: serverUrl, token, clientType: 'user-scoped', clientPurpose: 'scoped-rpc' });
            physical.push(socket);
            return socket;
        },
        reachability: {
            startReachability: async () => {}, waitForReachable: async () => {},
            subscribeNetworkAllowed: () => () => {},
        },
        readIdleDisconnectMs: () => 0,
    });
    const scope = { serverUrl: `http://127.0.0.1:${address.port}`, token: 'synthetic-token', timeoutMs: DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS };
    let long: Promise<unknown> | undefined;
    let completed = false;
    try {
        const first = await pool.acquire(scope);
        long = callSocketRpc({ socket: first, target: { kind: 'machine', id: 'machine-1' },
            method: 'execution.run.start', params: {}, content: { mode: 'plain' }, timeoutMs: null, requestId: 'held-rpc' })
            .then(result => { completed = true; return result; });
        await issued;
        first.disconnect();
        const sibling = await pool.acquire(scope);
        expect(sibling.getSocketId()).toBe(first.getSocketId());
        await expect(callSocketRpc({ socket: sibling, target: { kind: 'machine', id: 'machine-1' },
            method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, params: {},
            content: { mode: 'plain' }, timeoutMs: null, requestId: 'describe-rpc' }))
            .resolves.toEqual({ completed: 'describe' });
        expect(completed).toBe(false);
        expect(physical).toHaveLength(1);
        acknowledgeHeld({ ok: true, result: { completed: 'held' } });
        await expect(long).resolves.toEqual({ completed: 'held' });
        sibling.disconnect();
    } finally {
        acknowledgeHeld?.({ ok: true, result: { completed: 'held' } });
        await pool.stopAll();
        await long?.catch(() => {});
        await new Promise<void>(resolve => { server.close(() => resolve()); });
    }
});

it('settles a pending physical connection when the pool stops before the handshake completes', async () => {
    const http = createServer();
    const server = new Server(http, { path: '/v1/updates/' });
    let observeHandshake!: () => void;
    const handshake = new Promise<void>((resolve) => { observeHandshake = resolve; });
    server.use((_socket, _next) => { observeHandshake(); });
    await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve); });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback server address');
    let physicalSocket: Socket | undefined;
    const pool = createServerScopedRpcSocketPool({
        createSocket: ({ serverUrl }) => {
            physicalSocket = io(serverUrl, { path: '/v1/updates/', autoConnect: false, reconnection: false, forceNew: true });
            return physicalSocket;
        },
        reachability: {
            startReachability: async () => {}, waitForReachable: async () => {},
            subscribeNetworkAllowed: () => () => {},
        },
        readIdleDisconnectMs: () => 0,
    });
    try {
        let failure: unknown;
        const pending = pool.acquire({ serverUrl: `http://127.0.0.1:${address.port}`, token: 'synthetic-token', timeoutMs: 2_000 })
            .catch((error: unknown) => { failure = error; });
        await handshake;
        await pool.stopAll();
        await Promise.resolve();
        await Promise.resolve();
        expect(failure).toBeInstanceOf(Error);
        await pending;
        expect(physicalSocket?.listeners('connect')).toHaveLength(0);
    } finally {
        await pool.stopAll();
        await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
});

it('redials through real Home reachability after a disconnect and expired reconnect while an older stream retains the socket', async () => {
    const http = createServer((request, response) => {
        const accepted = request.url === '/v1/auth/ping' && request.headers.authorization === 'Bearer synthetic-token';
        response.writeHead(accepted ? 200 : 404, { 'Content-Type': 'application/json' });
        response.end('{}');
    });
    const server = new Server(http, { path: '/v1/updates/' });
    let handshakeCount = 0;
    let stalledHandshake!: () => void;
    const stalled = new Promise<void>(resolve => { stalledHandshake = resolve; });
    server.use((_socket, next) => {
        handshakeCount += 1;
        if (handshakeCount === 2) { stalledHandshake(); return; }
        next();
    });
    server.on('connection', socket => socket.on('probe', (_payload: unknown, ack: (value: string) => void) => ack('ready')));
    await new Promise<void>(resolve => { http.listen(0, '127.0.0.1', resolve); });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback server address');
    const sockets: Socket[] = [];
    const pool = createServerScopedRpcSocketPool({
        createSocket: ({ serverUrl }) => {
            const socket = io(serverUrl, { path: '/v1/updates/', autoConnect: false, reconnection: false, forceNew: true });
            socket.io.timeout(false);
            sockets.push(socket);
            return socket;
        },
        readIdleDisconnectMs: () => 0,
    });
    const scope = { serverUrl: `http://127.0.0.1:${address.port}`, token: 'synthetic-token', timeoutMs: 2_000 };
    try {
        const retainedStream = await pool.acquire(scope);
        sockets[0]!.disconnect();
        const expired = pool.acquire({ ...scope, timeoutMs: 100 }).catch((error: unknown) => error);
        await stalled;
        expect(await expired).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT' });
        const recovered = await pool.acquire(scope);
        expect(await recovered.timeout(1_000).emitWithAck('probe', null)).toBe('ready');
        // Recovery is in-place: existing holders/listeners still use the pooled socket.
        expect(await retainedStream.timeout(1_000).emitWithAck('probe', null)).toBe('ready');
        expect(sockets).toHaveLength(1);
        recovered.disconnect();
        retainedStream.disconnect();
    } finally {
        await pool.stopAll();
        await new Promise<void>(resolve => { server.close(() => resolve()); });
    }
});

it('refuses an ACK write after its pooled physical socket disconnects without buffering a later effect', async () => {
    const http = createServer();
    const server = new Server(http, { path: '/v1/updates/' });
    let writes = 0;
    server.on('connection', (socket) => {
        socket.on('update-metadata', () => { writes += 1; });
        socket.on('probe', (ack: () => void) => { ack(); });
    });
    await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve); });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback server address');
    let physicalSocket: Socket | undefined;
    const pool = createServerScopedRpcSocketPool({
        createSocket: ({ serverUrl }) => {
            physicalSocket = io(serverUrl, { path: '/v1/updates/', autoConnect: false, reconnection: false, forceNew: true });
            return physicalSocket;
        },
        // The live loopback server is already reachable; Socket.IO owns dialing.
        reachability: {
            startReachability: async () => {}, waitForReachable: async () => {},
            subscribeNetworkAllowed: () => () => {},
        },
        readIdleDisconnectMs: () => 0,
    });
    const scope = { serverUrl: `http://127.0.0.1:${address.port}`, token: 'synthetic-token', timeoutMs: 5_000 };
    try {
        const first = await pool.acquire(scope);
        if (!physicalSocket) throw new Error('Missing pooled physical socket');
        physicalSocket.disconnect();
        let failure: unknown = null;
        const pending = emitWithAckCancellable({
            socket: first, event: 'update-metadata',
            payload: { sid: 'session-1', metadata: 'synthetic-ciphertext', expectedVersion: 3 },
            timeoutMs: null,
        }).catch((error: unknown) => { failure = error; });
        const second = await pool.acquire(scope);
        // Socket.IO packet ordering makes this real ACK a barrier after any
        // incorrectly buffered write, without a test-only timing assumption.
        await physicalSocket.emitWithAck('probe');
        expect(writes).toBe(0);
        expect(readRpcRequestDisposition(failure)).toBe('notSent');
        await pending;
        first.disconnect();
        second.disconnect();
    } finally {
        await pool.stopAll();
        await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
});

it('settles the original issued read after namespace loss even when its pooled socket is connected again', async () => {
    const http = createServer();
    const server = new Server(http, { path: '/v1/updates/' });
    const requests: string[] = [];
    let acknowledgeOld!: (value: unknown) => void;
    let observeIssued!: () => void;
    const issued = new Promise<void>(resolve => { observeIssued = resolve; });
    server.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL,
        (request: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
            requests.push(request.requestId!);
            if (request.requestId === 'old-read') { acknowledgeOld = ack; observeIssued(); }
            else ack({ ok: true, result: 'current-read' });
        }));
    await new Promise<void>(resolve => { http.listen(0, '127.0.0.1', resolve); });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback server address');
    const sockets: Socket[] = [];
    const pool = createServerScopedRpcSocketPool({
        createSocket: ({ serverUrl }) => {
            const socket = io(serverUrl, { path: '/v1/updates/', autoConnect: false, reconnection: false, forceNew: true });
            socket.io.timeout(false);
            sockets.push(socket);
            return socket;
        },
        reachability: {
            startReachability: async () => {}, waitForReachable: async () => {},
            subscribeNetworkAllowed: () => () => {},
        },
        readIdleDisconnectMs: () => 0,
    });
    const scope = { serverUrl: `http://127.0.0.1:${address.port}`, token: 'synthetic-token', timeoutMs: 5_000 };
    try {
        const first = await pool.acquire(scope);
        const originalNamespace = first.getSocketId();
        const oldRead = callSocketRpc({ socket: first, target: { kind: 'machine', id: 'machine-1' },
            method: RPC_METHODS.MACHINES_VITALS_GET, params: {}, content: { mode: 'plain' }, timeoutMs: null, requestId: 'old-read' })
            .catch((error: unknown) => error);
        await issued;
        sockets[0]!.disconnect();
        const second = await pool.acquire(scope);
        expect(second.connected).toBe(true);
        expect(second.getSocketId()).not.toBe(originalNamespace);
        expect(first.getSocketId()).toBe(second.getSocketId());
        expect(sockets).toHaveLength(1);
        const failure = await oldRead;
        expect(failure).toMatchObject({ rpcErrorCode: 'RPC_TRANSPORT_UNAVAILABLE' });
        expect(readRpcRequestDisposition(failure)).toBe('outcomeUnknown');
        // A late reply belongs to the old namespace; the new request's ACK is
        // the transport barrier, not a timer or a replay of the old read.
        acknowledgeOld({ ok: true, result: 'late-old-read' });
        await expect(callSocketRpc({ socket: second, target: { kind: 'machine', id: 'machine-1' },
            method: RPC_METHODS.MACHINES_VITALS_GET, params: {}, content: { mode: 'plain' }, timeoutMs: null, requestId: 'new-read' }))
            .resolves.toBe('current-read');
        expect(requests).toEqual(['old-read', 'new-read']);
        first.disconnect();
        second.disconnect();
    } finally {
        await pool.stopAll();
        await new Promise<void>(resolve => { server.close(() => resolve()); });
    }
});
