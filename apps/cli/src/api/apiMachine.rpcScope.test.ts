import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Server, type Socket as ServerSocket } from 'socket.io';
import { io } from 'socket.io-client';
import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS, resolveSocketRpcSessionAuthorization } from '@happier-dev/protocol/rpc';
import { SessionTransferRpcMethodV1Schema, SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { RpcRequest } from './rpc/types';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { ApiMachineClient } from './apiMachine';
import { registerMachineDiagnosticsRpcHandlers } from './machine/rpcHandlers.diagnostics';
import { configuration } from '@/configuration';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';

// Persistence is the boundary: exercise the actual server registration and machine-availability policy.
vi.mock('../../../server/sources/storage/db', () => ({
    db: {
        machine: { findFirst: async () => ({ revokedAt: null, replacedByMachineId: null }) },
    },
}));

// Resolve the server during collection, before the socket lifecycle's test deadline.
// The dynamic path preserves the server's Vitest alias without compiling it under CLI aliases.
const serverModulePath = '../../../server/sources/app/api/socket/rpc/registerSocketRpcHandlers';
const { registerSocketRpcHandlers }: {
    registerSocketRpcHandlers: (params: Readonly<{ userId: string; socket: ServerSocket; io: Server }>) => void;
} = await import(serverModulePath);

describe('ApiMachineClient RPC scope on the server registration harness', () => {
    it.each(['reconnect', 'replacement'] as const)('re-admits a permanently refused method after socket %s', async (transition) => {
        const manager = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain', logger: () => {} });
        manager.registerHandler(RPC_METHODS.CAPABILITIES_DESCRIBE, () => ({ protocolVersion: 1 }));
        const method = `machine-1:${RPC_METHODS.CAPABILITIES_DESCRIBE}`;
        const http = createServer();
        const sockets = new Server(http);
        sockets.on('connection', (socket) => {
            socket.data = { clientType: 'machine-scoped', machineId: socket.handshake.query.machineId };
            registerSocketRpcHandlers({ userId: 'account-1', socket, io: sockets });
        });
        await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback socket endpoint');
        const url = `http://127.0.0.1:${address.port}`;
        const first = io(url, { autoConnect: false, reconnection: false, query: { machineId: 'machine-2' } });
        let next = first;
        const connect = async (socket: ReturnType<typeof io>) => {
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('connect_error', reject);
                socket.connect();
            });
            manager.onSocketConnect(socket);
        };
        try {
            const rejection = new Promise<unknown>((resolve) => first.once(SOCKET_RPC_EVENTS.ERROR, resolve));
            await connect(first);
            await expect(rejection).resolves.toMatchObject({ type: 'register', method, retryable: false });
            const emit = vi.spyOn(first, 'emit');
            expect(manager.replayUnacknowledgedHandlerRegistrations()).toEqual([]);
            expect(emit).not.toHaveBeenCalled();
            // Replacement can begin a new admission without a prior manager disconnect callback.
            if (transition === 'reconnect') manager.onSocketDisconnect();
            first.disconnect();
            if (transition === 'replacement') {
                next = io(url, { autoConnect: false, reconnection: false, query: { machineId: 'machine-1' } });
            } else {
                first.io.opts.query = { machineId: 'machine-1' };
            }
            await connect(next);
            await expect(manager.waitForRegisteredHandlers([RPC_METHODS.CAPABILITIES_DESCRIBE], { timeoutMs: 5_000 }))
                .resolves.toEqual({ status: 'ready' });
            expect(manager.replayUnacknowledgedHandlerRegistrations()).toEqual([]);
        } finally {
            manager.onSocketDisconnect();
            first.disconnect();
            next.disconnect();
            await new Promise<void>((resolve) => sockets.close(() => resolve()));
        }
    });

    it('retains bound Session log-tail dispatch through the real Action owner', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'session-log-contract-'));
        const path = join(dir, 'session.log');
        await writeFile(path, '0123456789', 'utf8');
        const manager = new RpcHandlerManager({ scopePrefix: 'session-1', encryptionMode: 'plain' });
        const registration = registerSessionHandlers(manager, dir, {
            sessionId: 'session-1',
            transcriptActionExecutor: createCliActionExecutor({
                token: 'test-token', sessionId: 'session-1', mode: 'e2ee',
                ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
                sessionLogAccess: { workingDirectory: dir, accessPolicy: { kind: 'restrictedRoots', roots: [dir] } },
            }),
        });
        try {
            await expect(manager.handleRequest({
                method: `session-1:${RPC_METHODS.SESSION_LOG_TAIL}`,
                params: { path, offset: 2, maxBytes: 4 },
            })).resolves.toMatchObject({ ok: true, path, tail: '2345', offset: 2, nextOffset: 6, truncated: true });
        } finally {
            await registration.dispose();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it.each([false, true])('registers without Forbidden errors with machine diagnostics=%s', async (includeDiagnostics) => {
        const client = new ApiMachineClient('test-token', {
            id: 'machine-1', encryptionMode: 'plain', metadata: null, metadataVersion: 0,
            daemonState: null, daemonStateVersion: 0,
        });
        // Observe the existing private transport owner without adding a production inspection API.
        const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
        expect(manager).toBeInstanceOf(RpcHandlerManager);
        if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing machine RPC owner');
        if (includeDiagnostics) registerMachineDiagnosticsRpcHandlers({ rpcHandlerManager: manager });
        const http = createServer();
        const sockets = new Server(http);
        const settled: unknown[] = [];
        const errors: unknown[] = [];
        const connectedServerSocket = new Promise<ServerSocket>((resolve) => {
            sockets.on('connection', (socket) => {
                socket.data = socket.handshake.query.clientType === 'user'
                    ? { clientType: 'user-scoped' }
                    : { clientType: 'machine-scoped', machineId: 'machine-1' };
                // Model the trusted Account authentication stamp supplied before the real RPC owner.
                socket.data.authAuthority = 'present_user';
                socket.data.authTokenAuthenticationEvidence = [];
                socket.onAnyOutgoing((event, payload) => {
                    if (event === SOCKET_RPC_EVENTS.REGISTERED || event === SOCKET_RPC_EVENTS.ERROR) settled.push(payload);
                    if (event === SOCKET_RPC_EVENTS.ERROR) errors.push(payload);
                });
                registerSocketRpcHandlers({ userId: 'account-1', socket, io: sockets });
                resolve(socket);
            });
        });
        await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback socket endpoint');
        const clientSocket = io(`http://127.0.0.1:${address.port}`, { autoConnect: false, reconnection: false });
        const emit = vi.spyOn(clientSocket, 'emit');
        const temporaryDirs: string[] = [];
        let callerSocket: ReturnType<typeof io> | undefined;
        try {
            await new Promise<void>((resolve, reject) => {
                clientSocket.once('connect', resolve);
                clientSocket.once('connect_error', reject);
                clientSocket.connect();
            });
            const serverSocket = await connectedServerSocket;
            clientSocket.on(SOCKET_RPC_EVENTS.REQUEST, (request: RpcRequest, ack: (result: unknown) => void) => {
                void manager.handleRequest(request).then(ack);
            });
            manager.onSocketConnect(clientSocket);
            const methods = emit.mock.calls
                .filter(([event]) => event === SOCKET_RPC_EVENTS.REGISTER)
                .map(([, payload]) => (payload as { method: string }).method);
            expect(methods.length).toBeGreaterThan(0);
            await expect.poll(() => settled.length).toBe(methods.length);
            // Transfers are dual-scope by the canonical wire schema and the server's explicit machine exemption.
            expect(methods.filter((method) =>
                resolveSocketRpcSessionAuthorization(method)?.routeToSessionOwnerDaemon === true
                && !SessionTransferRpcMethodV1Schema.safeParse(method.slice(method.indexOf(':') + 1)).success,
            )).toEqual([]);
            expect(errors).toEqual([]);
            await expect(manager.waitForRegisteredHandlers(methods.map((method) => method.slice(method.indexOf(':') + 1)),
                { timeoutMs: 5_000 })).resolves.toEqual({ status: 'ready' });
            expect(methods).toContain(`machine-1:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT}`);
            expect(methods).toContain(`machine-1:${RPC_METHODS.CAPABILITIES_DESCRIBE}`);
            const connectedAccountControlMethod = 'machine-1:daemon.connectedAccounts.control.command';
            expect(methods).toContain(connectedAccountControlMethod);
            callerSocket = io(`http://127.0.0.1:${address.port}`, {
                autoConnect: false, reconnection: false, query: { clientType: 'user' },
            });
            const caller = callerSocket;
            await new Promise<void>((resolve, reject) => {
                caller.once('connect', resolve);
                caller.once('connect_error', reject);
                caller.connect();
            });
            await expect(caller.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.CALL, {
                method: connectedAccountControlMethod,
                params: { v: 1, machineId: 'machine-1', command: {
                    operation: 'describeService', service: { pluginId: 'acme.accounts', localId: 'work' },
                } },
            })).resolves.toEqual({ ok: true, result: { status: 'unavailable', code: 'connected_account_daemon_runtime_unavailable' } });
            await expect(serverSocket.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.REQUEST,
                { method: `machine-1:${RPC_METHODS.CAPABILITIES_DESCRIBE}`, params: {} }))
                .resolves.toMatchObject({ protocolVersion: 1 });
            if (includeDiagnostics) {
                const method = 'machine-1:daemon.session.log.tail';
                expect(methods).toContain(method);
                expect(methods).not.toContain(`machine-1:${RPC_METHODS.SESSION_LOG_TAIL}`);
                const logsDir = join(configuration.happyHomeDir, 'logs');
                await mkdir(logsDir, { recursive: true });
                const logDir = await mkdtemp(join(logsDir, 'machine-log-contract-'));
                temporaryDirs.push(logDir);
                const logPath = join(logDir, 'session.log');
                const contents = 'first line\nlast line\n';
                await writeFile(logPath, contents, 'utf8');
                await expect(caller.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.CALL,
                    { method, params: { path: logPath, maxBytes: 1024 } }))
                    .resolves.toEqual({ ok: true, result: {
                        success: true, path: await realpath(logPath), tail: contents, truncated: false,
                    } });

                const outsideDir = await mkdtemp(join(tmpdir(), 'machine-log-contract-outside-'));
                temporaryDirs.push(outsideDir);
                const outsidePath = join(outsideDir, 'outside.log');
                await writeFile(outsidePath, 'private', 'utf8');
                await expect(caller.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.CALL,
                    { method, params: { path: outsidePath } }))
                    .resolves.toMatchObject({ ok: true, result: { success: false } });
            }
        } finally {
            manager.onSocketDisconnect();
            callerSocket?.disconnect();
            clientSocket.disconnect();
            await client.shutdown();
            await new Promise<void>((resolve) => sockets.close(() => resolve()));
            await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
        }
    });
});
