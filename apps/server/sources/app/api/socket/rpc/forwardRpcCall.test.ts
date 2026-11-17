import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { Server, type Socket } from 'socket.io';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcAckResponseEmitter } from './_types';

const machineFindFirstMock = vi.hoisted(() => vi.fn());

vi.mock('@/storage/db', () => ({
    db: {
        machine: { findFirst: machineFindFirstMock },
    },
}));

vi.mock('@/app/monitoring/metrics/index', () => ({
    observeRpcCall: vi.fn(),
    observeRpcTargetLookup: vi.fn(),
    recordRpcCallFailure: vi.fn(),
    recordRpcMethodNotAvailable: vi.fn(),
    recordRpcSelfCallRejection: vi.fn(),
    recordSocketClusterFetchSockets: vi.fn(),
}));

vi.mock('@/utils/logging/log', () => ({ log: vi.fn() }));


import { forwardRpcCall } from './forwardRpcCall';
import { buildRpcMethodRoom } from './rpcMethodRoom';
import { registerSocketRoomDiscovery } from '../socketRoomDiscovery';
import { log } from '@/utils/logging/log';
import { discoverRpcTargets, readMachineRpcTargetPresence, readRegisteredRpcTargetPresence } from './rpcTargetDiscovery';
import { cancelRpcTarget } from './cancelRpcTarget';
import { projectRpcFailureDiagnostic } from './rpcFailureDiagnostic';

describe('forwardRpcCall', () => {
    it('keeps arbitrary remote cause strings outside the host log projection', () => {
        const diagnostic = projectRpcFailureDiagnostic(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
            { ok: false, errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN, failureCause: {
                phase: 'rpc.remote', errorClass: 'RangeError', errorCode: 'private_remote_code', httpStatus: 503,
            } }, 'rpc.forward');
        expect(diagnostic?.failureCause).toEqual({ phase: 'rpc.remote' });
        expect(JSON.stringify(diagnostic)).not.toMatch(/private_remote_code|RangeError|503/u);
    });

    it.each([
        { error: Object.assign(new TypeError('private RPC boundary failure'), { code: 'EIO' }), errorCode: 'EIO', errorClass: 'TypeError' },
        { error: Object.assign(new RangeError('private RPC boundary failure'), { code: 'private_arbitrary_code' }), errorCode: null, errorClass: 'RangeError' },
    ])('retains a closed $errorClass ACK cause in one host diagnostic without changing JSON', async ({ error, errorCode, errorClass }) => {
        const io = new Server();
        // Socket.IO is the network boundary; discovery, forwarding and diagnostics stay real.
        const target = { id: 'diagnostic-target', connected: true, data: {},
            timeout: () => ({ emitWithAck: async () => { throw error; } }) };
        const fetchSockets = async () => [target];
        vi.spyOn(io, 'in').mockReturnValue({ fetchSockets, timeout: () => ({ fetchSockets }) } as unknown as ReturnType<Server['in']>);
        vi.mocked(log).mockClear();
        try {
            const response = await forwardRpcCall({ io, targetUserId: 'user',
                method: `diagnostic-session:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT}`, callParams: {}, traceId: 'diagnostic-request' });
            expect(JSON.parse(JSON.stringify(response))).toEqual({ ok: false, error: 'private RPC boundary failure' });
            const failures = vi.mocked(log).mock.calls.filter(([data]) => data.event === 'rpc-failed');
            expect(failures).toEqual([[expect.objectContaining({ failureCause: {
                phase: 'rpc.forward', errorClass, errorCode, httpStatus: null,
            } }), expect.any(String)]]);
            expect(JSON.stringify(failures)).not.toMatch(/private RPC boundary failure|private_arbitrary_code/u);
        } finally { vi.restoreAllMocks(); }
    });

    it('retains failed presence census causes while both observations stay unknown', async () => {
        const io = new Server();
        vi.spyOn(io.sockets.adapter, 'fetchSockets').mockRejectedValue(Object.assign(new Error('private census failure'), { code: 'EIO' }));
        vi.mocked(log).mockClear();
        try {
            const method = `diagnostic-machine:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT}`;
            expect(await readRegisteredRpcTargetPresence({ io, userId: 'user', method })).toBe('unknown');
            expect(await readMachineRpcTargetPresence({ io, userId: 'user', method,
                machineAdmission: { actorAccountId: 'user', custodianAccountId: 'user', machineId: 'diagnostic-machine',
                    installationId: 'diagnostic-installation', role: 'use', encryptionMode: 'plain' } })).toBe('unknown');
            expect(await discoverRpcTargets({ io, userId: 'user', method })).toMatchObject({
                targets: [], methodRoomEmpty: false, failureCause: { errorCode: 'EIO' },
            });
            expect(vi.mocked(log).mock.calls.map(([data]) => data.failureCause)).toEqual([
                { phase: 'rpc.discovery.presence', errorClass: 'Error', errorCode: 'EIO', httpStatus: null },
                { phase: 'rpc.discovery.machine_presence', errorClass: 'Error', errorCode: 'EIO', httpStatus: null },
                { phase: 'rpc.discovery.target', errorClass: 'Error', errorCode: 'EIO', httpStatus: null },
            ]);
            expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain('private census failure');
        } finally { vi.restoreAllMocks(); }
    });

    it('retains a target cancellation transport cause without exposing exception prose', async () => {
        const io = new Server();
        vi.spyOn(io.sockets.adapter, 'broadcast').mockImplementation(() => { throw Object.assign(new Error('private cancellation failure'), { code: 'EIO' }); });
        vi.mocked(log).mockClear();
        try {
            expect(cancelRpcTarget({ io, targetSocketId: 'diagnostic-target', targetRequestId: 'diagnostic-request' })).toBeUndefined();
            expect(vi.mocked(log).mock.calls).toEqual([[expect.objectContaining({ failureCause: {
                phase: 'rpc.cancel.target', errorClass: 'Error', errorCode: 'EIO', httpStatus: null,
            } }), expect.any(String)]]);
            expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain('private cancellation failure');
        } finally { vi.restoreAllMocks(); }
    });

    it('records an ordinary unavailable upload-init once with safe correlation and failure facts', async () => {
        const io = new Server();
        const method = `private-session:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT}`;
        vi.mocked(log).mockClear();
        const response = await forwardRpcCall({ io, targetUserId: 'user', method,
            traceId: 'private-token/path', callParams: { token: 'never-log-secret' } });
        expect(response).toMatchObject({ ok: false });
        const failures = vi.mocked(log).mock.calls.filter(([metadata]) =>
            typeof metadata === 'object' && metadata.event === 'rpc-failed');
        expect(failures).toEqual([[expect.objectContaining({
            method: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, errorCode: expect.any(String),
            requestId: expect.stringMatching(/^sha256:/), failureCause: { phase: 'rpc.forward' },
            effectAttempted: null,
        }), expect.any(String)]]);
        expect(JSON.stringify(failures)).not.toMatch(/private-token|private-session|never-log/);
    });

    it.each([
        { status: 'received', cancellable: true }, { status: 'disconnected', cancellable: true },
        { status: 'received', cancellable: false }, { status: 'disconnected', cancellable: false },
    ] as const)('joins target lookup, submission and $status ACK without content (cancellable=$cancellable)', async ({ status, cancellable }) => {
        const io = new Server();
        const method = 'machine-1:daemon.vitals.get';
        const controller = new AbortController();
        let acknowledge!: (value: unknown) => void;
        let rejectAcknowledgement!: (error: Error) => void;
        let submitted!: () => void;
        const issued = new Promise<void>(resolve => { submitted = resolve; });
        const response = new Promise<unknown>((resolve, reject) => { acknowledge = resolve; rejectAcknowledgement = reject; });
        const emitWithAck = vi.fn((_event: string, _payload: unknown) => { submitted(); return response; });
        const target = { id: 'daemon-namespace', connected: true, data: {}, timeout: () => ({ emitWithAck }) };
        // Only the socket network boundary is synthetic; lookup, selection and forwarding are real.
        io.sockets.sockets.set(target.id, target as unknown as Socket);
        io.sockets.adapter.rooms.set(buildRpcMethodRoom({ userId: 'user-1', method }), new Set([target.id]));
        vi.mocked(log).mockClear();
        try {
            const input = { io, targetUserId: 'user-1', method,
                callerSocketId: 'browser-namespace', callParams: { secret: 'private-request-content' },
                ...(cancellable
                    ? { cancellation: { targetRequestId: 'relay-trace-1', signal: controller.signal, onTargetSelected() {} } }
                    : { traceId: 'relay-trace-1' }),
            };
            const forwarded = forwardRpcCall(input);
            await issued;
            expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST,
                expect.objectContaining(cancellable ? { requestId: 'relay-trace-1' } : { traceId: 'relay-trace-1' }));
            if (!cancellable) expect(emitWithAck.mock.calls[0]?.[1]).not.toHaveProperty('requestId');
            const events = () => vi.mocked(log).mock.calls.map(([facts]) => facts)
                .filter(facts => typeof facts === 'object' && facts !== null && 'event' in facts);
            expect(events()).toEqual([
                expect.objectContaining({ event: 'rpc-target-lookup', requestId: 'relay-trace-1',
                    callerSocketId: 'browser-namespace', targetSocketId: 'daemon-namespace', status: 'target' }),
                expect.objectContaining({ event: 'rpc-target-issued', requestId: 'relay-trace-1',
                    callerSocketId: 'browser-namespace', targetSocketId: 'daemon-namespace', boundary: 'emitWithAck-returned' }),
            ]);
            if (status === 'received') {
                acknowledge({ secret: 'private-response-content' });
                await expect(forwarded).resolves.toMatchObject({ ok: true });
            } else {
                rejectAcknowledgement(Object.assign(new Error('private-transport-detail'), { code: 'SOCKET_DISCONNECTED' }));
                await expect(forwarded).resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
            }
            expect(events()).toHaveLength(status === 'received' ? 3 : 4);
            expect(events()[2]).toMatchObject({ event: 'rpc-target-ack', requestId: 'relay-trace-1',
                callerSocketId: 'browser-namespace', targetSocketId: 'daemon-namespace',
                status: status === 'received' ? 'received' : 'failed',
                ...(status === 'disconnected' ? { failure: 'disconnected' } : {}) });
            if (status === 'disconnected') expect(events()[3]).toMatchObject({
                event: 'rpc-failed', requestId: 'relay-trace-1', errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN,
                effectAttempted: null,
            });
            expect(JSON.stringify(events())).not.toContain('private-');
        } finally { acknowledge?.({}); io.sockets.sockets.clear(); }
    });

    it('correlates failed discovery without claiming issuance or ACK receipt', async () => {
        const io = new Server();
        const fetchSockets = vi.fn().mockRejectedValue(new Error('timeout reached: only 24 responses received out of 25'));
        vi.spyOn(io, 'in').mockReturnValue({ fetchSockets } as unknown as ReturnType<Server['in']>);
        vi.mocked(log).mockClear();
        try {
            await expect(forwardRpcCall({ io, targetUserId: 'user-1', method: 'unscoped-read', callParams: {},
                callerSocketId: 'browser-namespace', cancellation: { targetRequestId: 'relay-trace-2',
                    signal: new AbortController().signal, onTargetSelected() {} } })).resolves.toMatchObject({
                ok: false, errorCode: 'RPC_TRANSPORT_UNAVAILABLE',
            });
            expect(vi.mocked(log).mock.calls).toContainEqual([
                expect.objectContaining({ requestId: 'relay-trace-2', callerSocketId: 'browser-namespace', level: 'warn' }),
                expect.any(String),
            ]);
            const phases = vi.mocked(log).mock.calls.map(([facts]) => facts)
                .filter(facts => typeof facts === 'object' && facts !== null && 'event' in facts);
            expect(phases).toEqual([
                expect.objectContaining({ event: 'rpc-target-lookup',
                    requestId: 'relay-trace-2', status: 'not-available', discoveryFailed: true }),
                expect.objectContaining({ event: 'rpc-failed', requestId: 'relay-trace-2',
                    errorCode: 'RPC_TRANSPORT_UNAVAILABLE', failureCause: { phase: 'rpc.discovery.target' }, effectAttempted: null }),
            ]);
        } finally { vi.restoreAllMocks(); }
    });

    it('recovers discovery within the existing availability grace before dispatching once', async () => {
        vi.useFakeTimers();
        const io = new Server();
        const emitWithAck = vi.fn().mockResolvedValue('recovered-result');
        registerSocketRoomDiscovery(io);
        const target = { id: 'remote-app', data: { clientType: 'user-scoped' }, timeout: () => ({ emitWithAck }) };
        const fetchSockets = vi.fn().mockRejectedValueOnce(new Error('cluster unavailable')).mockResolvedValue([target]);
        vi.spyOn(io, 'in').mockReturnValue({ fetchSockets, timeout: () => ({ fetchSockets }) } as unknown as ReturnType<Server['in']>);
        try {
            const result = forwardRpcCall({ io, targetUserId: 'user-1', method: 'machine-1:read', callParams: {} });
            await vi.advanceTimersByTimeAsync(0);
            io.sockets.adapter.emit('join-room', buildRpcMethodRoom({ userId: 'user-1', method: 'machine-1:read' }), target.id);
            await expect(result).resolves.toMatchObject({ ok: true, result: 'recovered-result' });
            expect(emitWithAck).toHaveBeenCalledOnce();
        } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
    });
    it('reports failed discovery as transient transport failure, not missing capability or client', async () => {
        const io = new Server();
        const fetchSockets = vi.fn().mockRejectedValue(new Error('timeout reached: only 18 responses received out of 19'));
        vi.spyOn(io, 'in').mockReturnValue({ fetchSockets } as unknown as ReturnType<Server['in']>);
        try {
            for (const answeringClient of [undefined, { clientId: 'exact-app' }]) {
                expect(await forwardRpcCall({ io, targetUserId: 'user-1', method: 'unscoped-read',
                    callParams: {}, answeringClient })).toMatchObject({ ok: false, errorCode: 'RPC_TRANSPORT_UNAVAILABLE' });
            }
        } finally { vi.restoreAllMocks(); }
    });

    it('routes an eligible local socket without an adapter-wide census but preserves global single-client selection', async () => {
        const io = new Server();
        const method = 'unscoped-read';
        const emitWithAck = vi.fn().mockResolvedValue('local-result');
        const target = { id: 'local-app', connected: true, data: { clientType: 'user-scoped' },
            timeout: () => ({ emitWithAck }) };
        // Socket.IO's network boundary is synthetic; discovery, admission and selection remain real.
        io.sockets.sockets.set(target.id, target as unknown as Socket);
        io.sockets.adapter.rooms.set(buildRpcMethodRoom({ userId: 'user-1', method }), new Set([target.id]));
        const fetchSockets = vi.fn().mockRejectedValue(new Error('cluster unavailable'));
        vi.spyOn(io, 'in').mockReturnValue({ fetchSockets } as unknown as ReturnType<Server['in']>);
        try {
            expect(await forwardRpcCall({ io, targetUserId: 'user-1', method, callParams: {} }))
                .toMatchObject({ ok: true, result: 'local-result' });
            expect(fetchSockets).not.toHaveBeenCalled();
            expect(await forwardRpcCall({ io, targetUserId: 'user-1', method, callParams: {},
                answeringClient: { requireSingle: true } })).toMatchObject({ ok: false, errorCode: 'RPC_TRANSPORT_UNAVAILABLE' });
            expect(await forwardRpcCall({ io, targetUserId: 'user-1', method, callParams: {},
                callerSocketId: target.id })).toMatchObject({ ok: false, errorCode: 'RPC_TRANSPORT_UNAVAILABLE' });
            expect(await forwardRpcCall({ io, targetUserId: 'user-1', method, callParams: {},
                answeringClient: { clientId: 'other-app' } })).toMatchObject({ ok: false, errorCode: 'RPC_TRANSPORT_UNAVAILABLE' });
            expect(emitWithAck).toHaveBeenCalledOnce();
            Object.assign(target.data, { clientType: 'machine-scoped', machineId: 'revoked-machine' });
            machineFindFirstMock.mockResolvedValue({ revokedAt: new Date(), replacedByMachineId: null });
            expect(await forwardRpcCall({ io, targetUserId: 'user-1', method, callParams: {} }))
                .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
            expect(emitWithAck).toHaveBeenCalledOnce();
        } finally { io.sockets.sockets.clear(); vi.restoreAllMocks(); }
    });
    it('refuses an ambiguous answering-client mutation before either app receives it', async () => {
        const emitWithAck = vi.fn(async () => 'applied');
        const targets = ['app-a', 'app-b'].map(id => ({ id, data: { clientType: 'user-scoped', rpcDeviceLabel: id === 'app-a' ? 'My phone' : null }, timeout: () => ({ emitWithAck }) }));
        const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } }, in: () => ({ fetchSockets: async () => targets,
            timeout: () => ({ fetchSockets: async () => targets }) }) } as unknown as Server;
        const args = { io, targetUserId: 'user-1', method: `machine-1:${RPC_METHODS.UI_ACTION_EXECUTE}`,
            callParams: 'sealed-action', answeringClient: { requireSingle: true as const } };
        expect(await forwardRpcCall(args)).toMatchObject({ ok: false, errorCode: 'RPC_CLIENT_AMBIGUOUS',
            answeringClients: [{ id: 'app-a', deviceLabel: 'My phone' }, { id: 'app-b', deviceLabel: null }] });
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(await forwardRpcCall({ ...args, answeringClient: { clientId: 'app-b', includeCandidates: true } }))
            .toMatchObject({ ok: true, answeringClientId: 'app-b', answeringClients: [{ id: 'app-a', deviceLabel: 'My phone' }, { id: 'app-b', deviceLabel: null }] });
        expect(emitWithAck).toHaveBeenCalledOnce();
        expect(await forwardRpcCall({ ...args, answeringClient: { clientId: 'disconnected-app' } }))
            .toMatchObject({ ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' });
        expect(emitWithAck).toHaveBeenCalledOnce();
    });
    it.each(['absent', 'connected', 'registration-lost', 'not-registered-yet', 'other-machine', 'lookup-failed', 'method-lookup-failed', 'revoked', 'session'] as const)(
        'distinguishes an unavailable Machine from an unavailable operation (%s)', async state => {
            const target = { id: 'daemon', data: { clientType: 'machine-scoped', machineId: state === 'other-machine' ? 'machine-2' : 'machine-1',
                ...(state === 'not-registered-yet' ? {} : { rpcRegisteredMethods: state === 'registration-lost'
                    ? [`machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`] : ['machine-1:capabilities.describe'] }) },
                timeout: () => ({ emitWithAck: vi.fn() }) };
            const fetchSockets = vi.fn(async (room: string) => {
                if (room.startsWith('rpc:')) {
                    if (state === 'method-lookup-failed') throw new Error('cluster unavailable');
                    return [];
                }
                if (state === 'lookup-failed') throw new Error('cluster unavailable');
                return ['connected', 'registration-lost', 'not-registered-yet', 'method-lookup-failed', 'revoked', 'other-machine'].includes(state) ? [target] : [];
            });
            const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } }, in: (room: string) => ({ timeout: () => ({ fetchSockets: () => fetchSockets(room) }),
                fetchSockets: () => fetchSockets(room) }) } as unknown as Server;
            if (state === 'session') machineFindFirstMock.mockResolvedValue(null);
            if (state === 'revoked') machineFindFirstMock.mockResolvedValue({ revokedAt: new Date(), replacedByMachineId: null });
            const result = await forwardRpcCall({ io, targetUserId: 'user-1',
                method: `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`, callParams: {} });
            expect(result).toMatchObject({ ok: false, errorCode: state === 'absent' || state === 'other-machine' || state === 'revoked'
                ? 'target_unavailable' : state === 'connected' ? RPC_ERROR_CODES.METHOD_NOT_FOUND
                : state === 'method-lookup-failed' ? RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE : RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        },
    );
    it('does not return a private continuation transport error echo', async () => {
        const secret = 'd26-recognizable-private-value';
        const emitWithAck = vi.fn().mockRejectedValue(new Error(`socket echoed ${secret}`));
        const target = { id: 'receiver', data: { clientType: 'session-scoped' }, timeout: () => ({ emitWithAck }) };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } }, in: () => ({ timeout: () => ({ fetchSockets }), fetchSockets }) } as unknown as Server;
        const result = await forwardRpcCall({ io, targetUserId: 'user-1',
            method: 'machine-1:daemon.approval.request.secretContinue.v1', callParams: { value: secret } });
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(result).toEqual({ ok: false, error: 'confidential_continuation_failed', errorCode: 'confidential_continuation_failed' });
    });
    beforeEach(() => {
        machineFindFirstMock.mockReset().mockResolvedValue({
            revokedAt: null,
            replacedByMachineId: null,
        });
    });

    it.each([
        { method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE, timeoutMs: 20 * 60_000 },
        { method: 'unrelated.method', timeoutMs: 20 * 60_000 },
        { method: RPC_METHODS.CAPABILITIES_INVOKE, timeoutMs: null },
        { method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, timeoutMs: null },
    ])('preserves a waiting $method through the real Socket.IO acknowledgement timer', async ({ method, timeoutMs }) => {
        vi.useFakeTimers();
        const io = new Server();
        try {
            let respond!: (response: unknown) => void;
            // The adapter is the network boundary. Keep Socket.IO's real
            // BroadcastOperator acknowledgement and timer implementation.
            const dispatch = vi.spyOn(io.of('/').adapter, 'broadcastWithAck').mockImplementation(
                (_packet, _options, clientCount, acknowledgement) => {
                    respond = acknowledgement;
                    clientCount(1);
                },
            );
            const target = {
                id: 'daemon-socket',
                timeout: (ms: number) => io.to('daemon-socket').timeout(ms),
            };
            const fetchSockets = vi.fn().mockResolvedValue([target]);
            vi.spyOn(io, 'in').mockReturnValue({
                timeout: () => ({ fetchSockets }),
                fetchSockets,
            } as unknown as ReturnType<Server['in']>);
            let settled = false;
            const forwarded = forwardRpcCall({
                io,
                targetUserId: 'user-one',
                method: `machine-one:${method}`,
                callParams: 'encrypted-nonce-observer-request',
                timeoutMs,
            }).finally(() => { settled = true; });
            void forwarded.catch(() => {});

            await vi.advanceTimersByTimeAsync(11 * 60_000);
            expect(settled).toBe(false);
            respond('encrypted-resolved-session');
            await expect(forwarded).resolves.toEqual({ ok: true, result: ['encrypted-resolved-session'] });
            expect(dispatch).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.restoreAllMocks();
            vi.useRealTimers();
        }
    });

    it('forwards machine-encrypted transcript refresh bytes without inspecting or rewriting them', async () => {
        const encryptedRequest = 'ZW5jcnlwdGVkLXRyYW5zY3JpcHQtcmVmcmVzaC1yZXF1ZXN0';
        const encryptedResponse = 'ZW5jcnlwdGVkLXRyYW5zY3JpcHQtcmVmcmVzaC1yZXNwb25zZQ==';
        const emitWithAck = vi.fn().mockResolvedValue(encryptedResponse);
        const target = {
            id: 'daemon-socket',
            data: {
                clientType: 'machine-scoped',
                machineId: 'machine-1',
            },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;
        const method = `machine-1:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER}`;

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method,
            callParams: encryptedRequest,
        })).resolves.toEqual({
            ok: true,
            result: encryptedResponse,
        });
        expect(emitWithAck).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.REQUEST,
            expect.objectContaining({
                method,
                params: encryptedRequest,
                callerAuthority: 'account_automation',
            }),
        );
    });

    it('stamps verified caller authority outside client-controlled params', async () => {
        const emitWithAck = vi.fn().mockResolvedValue('ok');
        const target = { id: 'receiver', data: { clientType: 'session-scoped' }, timeout: () => ({ emitWithAck }) };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } }, in: () => ({ timeout: () => ({ fetchSockets }), fetchSockets }) } as unknown as Server;
        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method: 'session-1:permission',
            callParams: { callerAuthority: 'present_user', approved: true },
            callerSocket: { data: { authAuthority: 'account_automation' } },
        })).resolves.toMatchObject({ ok: true });
        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            callerAuthority: 'account_automation',
            params: { callerAuthority: 'present_user', approved: true },
        }));
        await forwardRpcCall({ io, targetUserId: 'user-1', method: 'session-1:permission', callParams: {},
            callerSocket: { data: { authAuthority: 'present_user' } } });
        expect(emitWithAck).toHaveBeenLastCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({ callerAuthority: 'present_user' }));
    });

    it.each([
        {
            name: 'legacy caller to current daemon',
            callerSupportsCurrentProtocol: false,
            targetSupportsCurrentProtocol: true,
        },
        {
            name: 'current caller to legacy daemon',
            callerSupportsCurrentProtocol: true,
            targetSupportsCurrentProtocol: false,
        },
    ])('refuses marked Machine RPC before daemon dispatch for $name', async ({
        callerSupportsCurrentProtocol,
        targetSupportsCurrentProtocol,
    }) => {
        machineFindFirstMock.mockResolvedValue({
            dataEncryptionKey: new Uint8Array(
                Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            ),
            revokedAt: null,
            replacedByMachineId: null,
        });
        const emitWithAck = vi.fn().mockResolvedValue('plain-response');
        const target = {
            id: 'daemon-socket',
            data: {
                clientType: 'machine-scoped',
                machineId: 'machine-1',
                accountStoredContentCompatibility: {
                    supportsCurrentProtocol: targetSupportsCurrentProtocol,
                    outcome: targetSupportsCurrentProtocol
                        ? 'accepted'
                        : 'observe-missing',
                },
            },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;
        const callerSocket = {
            data: {
                accountStoredContentCompatibility: {
                    supportsCurrentProtocol:
                        callerSupportsCurrentProtocol,
                    outcome: callerSupportsCurrentProtocol
                        ? 'accepted'
                        : 'observe-missing',
                },
            },
        };

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method: `machine-1:${RPC_METHODS.CAPABILITIES_INVOKE}`,
            callParams: 'opaque-request',
            callerSocket,
        })).resolves.toEqual({
            ok: false,
            error: 'client-upgrade-required',
            requirement: {
                v: 1,
                kind: 'account-stored-content',
                minimumProtocolVersion: 2,
            },
        });
        expect(emitWithAck).not.toHaveBeenCalled();
    });

    it('forwards marked Machine RPC when both caller and daemon are current', async () => {
        machineFindFirstMock.mockResolvedValue({
            dataEncryptionKey: new Uint8Array(
                Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            ),
            revokedAt: null,
            replacedByMachineId: null,
        });
        const currentCompatibility = {
            accepted: true,
            supportsCurrentProtocol: true,
            outcome: 'accepted',
        };
        const emitWithAck = vi.fn().mockResolvedValue('plain-response');
        const target = {
            id: 'daemon-socket',
            data: {
                clientType: 'machine-scoped',
                machineId: 'machine-1',
                accountStoredContentCompatibility: currentCompatibility,
            },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method: `machine-1:${RPC_METHODS.CAPABILITIES_INVOKE}`,
            callParams: 'plain-request',
            callerSocket: {
                data: {
                    accountStoredContentCompatibility: currentCompatibility,
                },
            },
        })).resolves.toEqual({
            ok: true,
            result: 'plain-response',
        });
        expect(emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('keeps retained E2EE Machine RPC available to legacy caller and daemon sockets', async () => {
        machineFindFirstMock.mockResolvedValue({
            dataEncryptionKey: new Uint8Array([0, 1, 2, 3]),
            revokedAt: null,
            replacedByMachineId: null,
        });
        const emitWithAck = vi.fn().mockResolvedValue('encrypted-response');
        const target = {
            id: 'legacy-daemon-socket',
            data: {
                clientType: 'machine-scoped',
                machineId: 'machine-1',
            },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method: `machine-1:${RPC_METHODS.CAPABILITIES_INVOKE}`,
            callParams: 'encrypted-request',
            callerSocket: { data: {} },
        })).resolves.toEqual({
            ok: true,
            result: 'encrypted-response',
        });
        expect(emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('unwraps a requested transport envelope while retaining the strict server acknowledgement', async () => {
        const emitWithAck = vi.fn().mockResolvedValue({
            v: 1,
            result: 'opaque-encrypted-stop-result',
            acknowledgement: {
                kind: 'session.stop',
                status: 'stopped',
            },
        });
        const target = {
            id: 'daemon-socket',
            data: {
                clientType: 'machine-scoped',
                machineId: 'machine-1',
            },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;
        const method = `machine-1:${RPC_METHODS.STOP_SESSION}`;

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method,
            callParams: 'opaque-encrypted-stop-request',
            transportResponseEnvelopeVersion: 1,
        })).resolves.toEqual({
            ok: true,
            result: 'opaque-encrypted-stop-result',
            transportAcknowledgement: {
                kind: 'session.stop',
                status: 'stopped',
            },
        });
        expect(emitWithAck).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.REQUEST,
            expect.objectContaining({
                method,
                params: 'opaque-encrypted-stop-request',
                transportResponseEnvelopeVersion: 1,
            }),
        );
    });

    it('keeps an Agent realtime terminal watch pending beyond the generic RPC timeout and settles on terminal', async () => {
        vi.useFakeTimers();
        try {
            let resolveTerminal!: (value: unknown) => void;
            const terminalResponse = new Promise<unknown>((resolve) => {
                resolveTerminal = resolve;
            });
            const emitWithAck = vi.fn(() => terminalResponse);
            const timeout = vi.fn(() => ({
                emitWithAck,
            }));
            const target = {
                id: 'session-runner-socket',
                timeout,
            };
            const fetchSockets = vi.fn().mockResolvedValue([target]);
            const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
                in: vi.fn(() => ({
                    timeout: vi.fn(() => ({ fetchSockets })),
                    fetchSockets,
                })),
            } as unknown as Server;
            const method = `session-1:${SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH}`;

            let settled = false;
            const forwarded = forwardRpcCall({
                io,
                targetUserId: 'user-1',
                method,
                callParams: { applicationAttemptId: 'voice-attempt-1' },
                timeoutMs: null,
            }).finally(() => {
                settled = true;
            });

            await vi.advanceTimersByTimeAsync(30_001);

            expect(settled).toBe(false);
            resolveTerminal({
                ok: true,
                status: 'terminal',
                event: { kind: 'terminal', reason: 'upstream_closed' },
            });
            await expect(forwarded).resolves.toEqual({
                ok: true,
                result: {
                    ok: true,
                    status: 'terminal',
                    event: { kind: 'terminal', reason: 'upstream_closed' },
                },
            });
            expect(timeout).toHaveBeenCalledWith(2_147_483_647, { rejectOnDisconnect: true });
            expect(emitWithAck).toHaveBeenCalledWith(
                SOCKET_RPC_EVENTS.REQUEST,
                {
                    method,
                    params: { applicationAttemptId: 'voice-attempt-1' },
                    timeoutMs: null,
                    callerAuthority: 'account_automation',
                },
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps an external Action relay pending beyond the generic RPC timeout and returns the daemon response', async () => {
        vi.useFakeTimers();
        try {
            let resolveDaemonResponse!: (value: unknown) => void;
            const daemonResponse = {
                v: 1,
                actionId: 'session.wait.idle',
                requestId: 'external-request-1',
                execution: { ok: true, result: { status: 'idle' } },
            };
            const pendingDaemonResponse = new Promise<unknown>((resolve) => {
                resolveDaemonResponse = resolve;
            });
            const emitWithAck = vi.fn(() => pendingDaemonResponse);
            const timeout = vi.fn(() => ({ emitWithAck }));
            const target = {
                id: 'machine-daemon-socket',
                timeout,
            };
            const fetchSockets = vi.fn().mockResolvedValue([target]);
            const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
                in: vi.fn(() => ({
                    timeout: vi.fn(() => ({ fetchSockets })),
                    fetchSockets,
                })),
            } as unknown as Server;
            const method = `machine-1:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`;
            const callParams = {
                actionId: 'session.wait.idle',
                envelope: { v: 1, requestId: 'external-request-1', input: { opaque: true } },
            };

            let settled = false;
            const forwarded = forwardRpcCall({
                io,
                targetUserId: 'user-1',
                method,
                callParams,
                timeoutMs: null,
            }).finally(() => {
                settled = true;
            });

            await vi.advanceTimersByTimeAsync(30_001);

            expect(settled).toBe(false);
            resolveDaemonResponse(daemonResponse);
            await expect(forwarded).resolves.toEqual({
                ok: true,
                result: daemonResponse,
            });
            expect(timeout).toHaveBeenCalledWith(2_147_483_647, { rejectOnDisconnect: true });
            expect(emitWithAck).toHaveBeenCalledWith(
                SOCKET_RPC_EVENTS.REQUEST,
                {
                    method,
                    params: callParams,
                    timeoutMs: null,
                    callerAuthority: 'account_automation',
                },
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('settles a cancelled submitted caller lifetime as unknown without resending', async () => {
        const controller = new AbortController();
        const io = new Server();
        let resolveDaemonResponse!: (value: unknown) => void;
        let markSubmitted!: () => void;
        const submitted = new Promise<void>((resolve) => {
            markSubmitted = resolve;
        });
        // Only the network adapter is replaced; cancellation and ACK timer
        // disposal run through Socket.IO's real BroadcastOperator.
        const dispatch = vi.spyOn(io.of('/').adapter, 'broadcastWithAck').mockImplementation(
            (_packet, _options, clientCount, acknowledgement) => {
                resolveDaemonResponse = acknowledgement;
                clientCount(1);
                markSubmitted();
            },
        );
        const target = {
            id: 'machine-daemon-socket',
            timeout: (ms: number, lifetime?: Readonly<{ rejectOnDisconnect?: boolean; signal?: AbortSignal }>) =>
                (io.to('machine-daemon-socket') as unknown as RpcAckResponseEmitter).timeout(ms, lifetime),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        vi.spyOn(io, 'in').mockReturnValue({
            timeout: () => ({ fetchSockets }), fetchSockets,
        } as unknown as ReturnType<Server['in']>);
        const onSubmittedUnknown = vi.fn();
        try {
            const forwarded = forwardRpcCall({
                io,
                targetUserId: 'user-1',
                method: `machine-1:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
                callParams: { actionId: 'session.wait.idle' },
                timeoutMs: null,
                onSubmittedUnknown,
                cancellation: {
                    targetRequestId: 'relay-request-1',
                    signal: controller.signal,
                    onTargetSelected: vi.fn(),
                },
            });

            await submitted;
            controller.abort(new Error('HTTP caller disconnected'));
            let result: unknown;
            void forwarded.then(value => { result = value; });
            try {
                await vi.waitFor(() => expect(result).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN }));
            } finally {
                resolveDaemonResponse({ authenticatedCancellation: true });
            }
            await expect(forwarded).resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
            expect(onSubmittedUnknown).toHaveBeenCalledOnce();
            expect(dispatch).toHaveBeenCalledOnce();
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('marks a timeout after target emission as a submitted-unknown settlement', async () => {
        const emitWithAck = vi.fn().mockRejectedValue(new Error('operation has timed out'));
        const onSubmittedUnknown = vi.fn();
        const target = {
            id: 'daemon-socket',
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method: 'agent.run',
            callParams: { request: 'opaque' },
            onSubmittedUnknown,
        })).resolves.toEqual({
            ok: false,
            error: 'operation has timed out',
            errorCode: 'MACHINE_RPC_TIMEOUT',
        });
        expect(emitWithAck).toHaveBeenCalledTimes(1);
        expect(onSubmittedUnknown).toHaveBeenCalledTimes(1);
    });

    it('does not report submitted unknown when target setup fails before emission', async () => {
        const onSubmittedUnknown = vi.fn();
        const target = {
            id: 'daemon-socket',
            timeout: vi.fn(() => {
                throw new Error('target setup unavailable');
            }),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method: 'agent.run',
            callParams: { request: 'opaque' },
            onSubmittedUnknown,
        })).resolves.toEqual({
            ok: false,
            error: 'target setup unavailable',
        });
        expect(onSubmittedUnknown).not.toHaveBeenCalled();
    });

    it('marks a post-emission target revalidation loss as a submitted-unknown settlement', async () => {
        const emitWithAck = vi.fn().mockResolvedValue({ ok: true });
        const onSubmittedUnknown = vi.fn();
        const target = {
            id: 'daemon-socket',
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const fetchSockets = vi.fn().mockResolvedValue([target]);
        const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets })),
                fetchSockets,
            })),
        } as unknown as Server;

        await expect(forwardRpcCall({
            io,
            targetUserId: 'user-1',
            method: 'agent.run',
            callParams: { request: 'opaque' },
            onSubmittedUnknown,
            targetGuard: {
                filterTargets: async (targets) => targets,
                runOperation: async ({ operation }) => {
                    await operation();
                    return { status: 'unavailable' };
                },
            },
        })).resolves.toEqual({
            ok: false,
            error: 'RPC target changed after request submission',
            errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN,
        });
        expect(emitWithAck).toHaveBeenCalledTimes(1);
        expect(onSubmittedUnknown).toHaveBeenCalledTimes(1);
    });

});
