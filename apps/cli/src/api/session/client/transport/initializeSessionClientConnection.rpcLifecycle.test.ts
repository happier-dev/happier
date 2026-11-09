import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io-client';
import { afterEach, expect, it, vi } from 'vitest';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY } from '@happier-dev/protocol/clientCompatibility/primitives';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { initializeSessionClientConnection } from './initializeSessionClientConnection';

afterEach(() => { vi.unstubAllGlobals(); });

it.each(['disconnect', 'auth_failed'] as const)(
    'keeps reconnected Run handlers published when old %s invalidation finishes',
    async failure => {
        // Only the HTTP/socket transport is simulated; supervision, compatibility
        // resolution and the RPC registration/receipt owner run unchanged.
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            features: {}, capabilities: { session: {
                runtimeActivity: { protocolVersion: SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY },
                pendingInput: { protocolVersion: 1 }, publisherAuthority: { protocolVersion: 1 },
            } },
        }), { status: 200 })));
        const events = new EventEmitter();
        let connected = true;
        let connectedListener = () => {};
        let disconnectedListener = (_event: { intentional: boolean }) => {};
        const published: string[] = [];
        const socketBoundary = {
            get connected() { return connected; },
            on: (event: string, listener: (...args: unknown[]) => void) => { events.on(event, listener); return socketBoundary; },
            emit: (event: string, payload: { method: string }) => {
                if (event === SOCKET_RPC_EVENTS.REGISTER) {
                    published.push(payload.method);
                    events.emit(SOCKET_RPC_EVENTS.REGISTERED, payload);
                }
                return socketBoundary;
            },
            emitWithAck: async () => ({ ok: true, capability: 'session-transcript-observation-v1' }),
        };
        // A narrowed fake of Socket.IO is the external boundary, not a domain mock.
        const socket = socketBoundary as unknown as Socket;
        const rpc = new RpcHandlerManager({ scopePrefix: 'run-host', encryptionMode: 'plain', logger: () => {} });
        const methods = [SESSION_RPC_METHODS.EXECUTION_RUN_START, SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
            SESSION_RPC_METHODS.EXECUTION_RUN_SEND];
        for (const method of methods) rpc.registerHandler(method, async () => ({ ok: true }));
        let epoch = 0;
        let releaseInvalidation!: () => void;
        const invalidation = new Promise<void>(resolve => { releaseInvalidation = resolve; });
        let invalidationStarted!: () => void;
        const started = new Promise<void>(resolve => { invalidationStarted = resolve; });
        let connectionReady!: () => void;
        let ready = new Promise<void>(resolve => { connectionReady = resolve; });
        const connection = initializeSessionClientConnection({
            token: 'test-token',
            transport: {
                serverId: 'run-host-home', serverUrl: `http://run-host-${failure}.invalid`,
                createSessionSocketTransport: () => ({ socket, transport: {
                    connect: async () => { connected = true; connectedListener(); },
                    disconnect: async () => { connected = false; }, destroy: async () => {},
                    isConnected: () => connected,
                    onConnected: listener => { connectedListener = listener; return () => {}; },
                    onDisconnected: listener => { disconnectedListener = listener; return () => {}; },
                    onError: () => () => {},
                } }),
            },
            sessionId: 'run-host', localMachineId: 'machine', userScopedAccountUpdates: false,
            getMetadataSnapshot: () => null, setSessionSocket: () => {}, rpcHandlerManager: rpc,
            handleUserScopedUpdate: () => {}, installSessionSocketEventHandlers: () => {},
            classifyTransportErrorToProbeResult: undefined, onStateChange: () => {},
            shouldKeepUserSocketConnected: () => false, kickUserSocketConnect: () => {},
            syncChangesOnConnect: async () => {}, shouldSyncSessionSnapshotOnConnect: () => false,
            syncSessionSnapshotFromServer: async () => {},
            flushDurableSessionMutationsOnReconnect: async () => {},
            markConnected: () => ({ reason: epoch === 0 ? 'connect' : 'reconnect', epoch: ++epoch }),
            setSessionSyncPendingInputServerContractResult: async result => {
                if (result?.mode === 'indeterminate') { invalidationStarted(); await invalidation; }
            },
            onSessionFollowInvalidated: () => connectionReady(),
        });
        try {
            await connection.sessionConnectionSupervisor.start();
            await ready;
            expect(methods.every(method => rpc.isHandlerRegistrationAcknowledged(method))).toBe(true);
            let failed: Promise<unknown> | undefined;
            if (failure === 'disconnect') disconnectedListener({ intentional: true });
            else failed = Promise.resolve(connection.sessionConnectionSupervisor.reportProbeResult?.({
                status: 'auth_failed', statusCode: 401, errorMessage: 'Authentication failed',
            }, connection.sessionConnectionSupervisor.captureProbeReportScope?.()));
            await started;
            ready = new Promise<void>(resolve => { connectionReady = resolve; });
            connected = true;
            if (failure === 'auth_failed') await connection.sessionConnectionSupervisor.start();
            else connectedListener();
            await ready;
            const countAfterReconnect = published.length;
            releaseInvalidation();
            await failed;
            await Promise.resolve();
            expect(methods.every(method => rpc.isHandlerRegistrationAcknowledged(method))).toBe(true);
            rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_GET, async () => ({ ok: true }));
            expect(published.slice(countAfterReconnect)).toEqual([`run-host:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`]);
            await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toEqual({ ok: true });
        } finally {
            releaseInvalidation();
            await connection.sessionConnectionSupervisor.stop();
        }
    },
);
