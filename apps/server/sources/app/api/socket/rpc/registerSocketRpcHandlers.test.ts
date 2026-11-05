import {
    RPC_ERROR_CODES,
    RPC_METHODS,
    SESSION_RPC_METHODS,
    SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
} from "@happier-dev/protocol/rpc";
import {
    AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1,
    CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
    CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
    CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
    decodeBase64,
    encodePlainMachineStoredContent,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
    uiBrowserAutomationDispatchMethod,
} from "@happier-dev/protocol";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import { Server, type Socket } from "socket.io";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSha256SecretDigest } from "@/app/auth/secretDigest";
import { auth } from "@/app/auth/auth";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { computeExternalActionSocketRpcRequestDigestV1, ExternalActionExecutionAuthorizationV1Schema } from "@happier-dev/protocol/actions";
import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import type { ApiTokenGrantV1 } from '@happier-dev/protocol/auth/apiTokenGrant';

import type {
    CurrentSessionPublisherAuthority,
    RunAsProjectedCurrentPublisherResult,
} from "@/app/presence/sessionPublisherPresence";

import { createFakeSocket as createSocketHarnessFake, triggerSocketHandler } from "../../testkit/socketHarness";
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from "../externalActionDispatcher";
import { workflowDraftClientRpcMethod } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import {
    currentUiContextCommandClientRpcMethod,
    currentUiContextReadClientRpcMethod,
    mountedWorkReadClientRpcMethod,
} from '@happier-dev/protocol/actions/clientDispatchV1';
import { getMachineSocketRoom } from '../../socketRooms';
import { buildMachineRpcAvailabilityRoom } from './rpcMethodRoom';
import * as logging from '@/utils/logging/log';
import { callSocketRpc } from '@happier-dev/sync-client';
import { createHash } from 'node:crypto';

type RpcTargetEmitWithAck = (
    event: string,
    request: Readonly<{ requestId?: string }>,
) => Promise<unknown>;

type AccessKeyFindUniqueArgs = Readonly<{
    where?: {
        accountId_machineId_sessionId?: {
            accountId: string;
            machineId: string;
            sessionId: string;
        };
    };
}>;

function createFakeSocket(overrides: Record<string, any> = {}) {
    return createSocketHarnessFake({
        ...overrides,
        data: {
            authAuthority: "present_user",
            authTokenAuthenticationEvidence: [],
            ...(overrides.data ?? {}),
        },
    });
}

function createOwnedSessionAccessRow(sessionId = "sess_1") {
    return {
        id: sessionId,
        active: true,
        archivedAt: null,
        lastActiveAt: new Date(2),
        publisherGeneration: 1n,
        publisherGenerationLastActiveAt: new Date(2),
        updatedAt: new Date(2),
        accountId: "user-1",
        primaryTeamId: null,
        account: { status: "active" },
        currentStorageState: "hosted",
        seq: 0,
        acceptedThroughServerSeq: null,
        materializationPublicationId: null,
        materializedThroughSourceAt: null,
        publishedThroughServerSeq: null,
        shares: [],
        teamGrants: [],
        groupGrants: [],
    };
}

const machineFindFirstMock = vi.hoisted(() => vi.fn(async (_args?: unknown): Promise<{ revokedAt: Date | null; replacedByMachineId: string | null; installationId?: string; installationPublicKey?: Uint8Array; kind?: string } | null> => ({
    revokedAt: null,
    replacedByMachineId: null,
})));
const managedMachineFindUniqueMock = vi.hoisted(() => vi.fn());
const accessKeyFindUniqueMock = vi.hoisted(() => vi.fn(async (_args?: AccessKeyFindUniqueArgs): Promise<{ machineId?: string; accountId?: string; session?: { accountId: string }; machine?: { revokedAt: Date | null; replacedByMachineId: string | null } } | null> => ({
    machineId: "machine-1",
    machine: {
        revokedAt: null,
        replacedByMachineId: null,
    },
})));
const ephemeralRunnerActivationFindFirstMock = vi.hoisted(() => vi.fn());
const accountFindUniqueMock = vi.hoisted(() => vi.fn());
const sessionFindUniqueMock = vi.hoisted(() => vi.fn());
const sessionFindFirstMock = vi.hoisted(() => vi.fn());
const sessionShareFindUniqueMock = vi.hoisted(() => vi.fn());
const apiTokenFindUniqueMock = vi.hoisted(() => vi.fn());
const authorizeSessionFollowSourceKeyPreparationMock = vi.hoisted(() => vi.fn());
const authorizeSessionFollowSourceKeyPreparerMock = vi.hoisted(() => vi.fn());
const rpcMetricsMocks = vi.hoisted(() => ({
    recordRpcRegistration: vi.fn(),
    recordRpcUnregistration: vi.fn(),
    observeRpcCall: vi.fn(),
    recordRpcCallFailure: vi.fn(),
    observeRpcTargetLookup: vi.fn(),
    recordRpcMethodNotAvailable: vi.fn(),
    recordRpcSelfCallRejection: vi.fn(),
    recordSocketClusterFetchSockets: vi.fn(),
}));

vi.mock("@/app/monitoring/metrics/index", () => rpcMetricsMocks);

vi.mock("@/storage/db", async () => {
    const { inTxPostgresControlStatementMock } = await import('../../testkit/dbMocks');
    const readMachine = async (args: Readonly<{ where: { id: string } }>) => {
        const observed = await machineFindFirstMock(args);
        if (!observed) return null;
        // Genuine Prisma boundary: return persisted relations to the real admission owner.
        return { id: args.where.id, accountId: 'user-1', kind: 'persistent', active: true,
            metadata: encodePlainMachineStoredContent({ host: 'fixture', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/fixture', happyHomeDir: '/home/fixture/.happier' }), metadataVersion: 1,
            daemonState: null, daemonStateVersion: 0,
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), installationId: null,
            account: { id: 'user-1', status: 'active', encryptionMode: 'plain', firstName: null,
                lastName: null, username: null, avatar: null }, accountGrants: [], teamGrants: [], groupGrants: [],
            ...observed };
    };
    const databaseBoundary = {
        // Prisma executes the real inTx owner's transaction-mode declaration at this database boundary.
        ...inTxPostgresControlStatementMock,
        machine: { findFirst: machineFindFirstMock, findUnique: readMachine,
            findMany: async (args: Readonly<{ where: { id: { in: readonly string[] } } }>) => {
                const rows = await Promise.all(args.where.id.in.map(id => readMachine({ where: { id } })));
                return rows.filter(row => row !== null);
            } },
        account: { findUnique: accountFindUniqueMock },
        managedMachine: { findUnique: managedMachineFindUniqueMock,
            // Fleet reads select by enrolled Machine ids; the same persisted rows answer each id.
            findMany: async (args: Readonly<{ where: { enrolledMachineId: { in: readonly string[] } } }>) =>
                (await Promise.all(args.where.enrolledMachineId.in.map(enrolledMachineId =>
                    managedMachineFindUniqueMock({ where: { enrolledMachineId } })))).filter(row => row !== null && row !== undefined) },
        accessKey: { findUnique: accessKeyFindUniqueMock },
        ephemeralRunnerActivation: { findFirst: ephemeralRunnerActivationFindFirstMock },
        session: { findUnique: sessionFindUniqueMock, findFirst: sessionFindFirstMock },
        sessionShare: { findUnique: sessionShareFindUniqueMock },
        accountApiToken: { findUnique: apiTokenFindUniqueMock, findFirst: apiTokenFindUniqueMock, updateMany: vi.fn(async () => ({ count: 1 })) },
        simpleCache: { findUnique: vi.fn(async () => ({ value: `srv_${'a'.repeat(32)}` })) },
    };
    return { db: { ...databaseBoundary,
        $transaction: async (operation: (tx: typeof databaseBoundary) => Promise<unknown>) => operation(databaseBoundary),
    } };
});
vi.mock("@/app/session/follow/sessionFollowEdgeService", () => ({
    authorizeSessionFollowSourceKeyPreparation: authorizeSessionFollowSourceKeyPreparationMock,
    authorizeSessionFollowSourceKeyPreparer: authorizeSessionFollowSourceKeyPreparerMock,
}));


import { registerSocketRpcHandlers } from "./registerSocketRpcHandlers";

function createIo(params: { targetsByRoom?: Record<string, unknown[]> } = {}) {
    const fetchSockets = vi.fn(async (room: string) => params.targetsByRoom?.[room] ?? []);
    const timeout = vi.fn((timeoutMs: number) => ({
        fetchSockets: () => fetchSockets.mock.calls.length >= 0
            ? fetchSockets(fetchSockets.mock.calls.at(-1)?.[0] ?? "")
            : Promise.resolve([]),
    }));
    const inMock = vi.fn((room: string) => {
        fetchSockets.mockImplementationOnce(async () => params.targetsByRoom?.[room] ?? []);
        return {
            timeout,
            fetchSockets: () => fetchSockets(room),
        };
    });

    return {
        io: {
            sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
            in: inMock,
        } as unknown as Server,
        inMock,
        timeout,
    };
}

function createTargetRoutingIo(targetsByRoom: Record<string, unknown[]>) {
    const fetchSockets = vi.fn(async (room: string) => targetsByRoom[room] ?? []);
    return {
        io: {
            sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
            in: vi.fn((room: string) => ({
                timeout: vi.fn(() => ({
                    fetchSockets: () => fetchSockets(room),
                })),
                fetchSockets: () => fetchSockets(room),
            })),
        } as unknown as Server,
        fetchSockets,
    };
}

function createRoomAwareIo() {
    const rooms = new Map<string, Set<any>>();
    const emitToRoom = vi.fn((room: string, event: string, payload: unknown) => {
        for (const socket of rooms.get(room) ?? []) {
            socket.emit(event, payload);
        }
    });
    const fetchSockets = vi.fn(async (room: string) => [...(rooms.get(room) ?? [])]);
    const io = {
        sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
        in: vi.fn((room: string) => ({
            timeout: vi.fn(() => ({
                fetchSockets: () => fetchSockets(room),
            })),
            fetchSockets: () => fetchSockets(room),
        })),
        to: vi.fn((room: string) => ({
            emit: (event: string, payload: unknown) => emitToRoom(room, event, payload),
        })),
    } as unknown as Server;

    const addToRoom = (room: string, socket: any): void => {
        const sockets = rooms.get(room) ?? new Set<any>();
        sockets.add(socket);
        rooms.set(room, sockets);
    };
    const removeFromRoom = (room: string, socket: any): void => {
        const sockets = rooms.get(room);
        sockets?.delete(socket);
        if (sockets && sockets.size === 0) {
            rooms.delete(room);
        }
    };
    const createRoomAwareSocket = (overrides: Record<string, unknown>) => {
        const socket = createFakeSocket(overrides);
        return Object.assign(socket, {
            join: vi.fn(async (room: string) => addToRoom(room, socket)),
            leave: vi.fn(async (room: string) => removeFromRoom(room, socket)),
        });
    };

    return { io, rooms, addToRoom, createRoomAwareSocket, emitToRoom, fetchSockets };
}

describe("registerSocketRpcHandlers", () => {
    describe('live approval origins', () => {
        const method = `approval-origin.${'a'.repeat(43)}:approval.origin.decide`;
        const receiverData = { clientType: 'user-scoped', authTokenKind: 'account', authAuthority: 'present_user' };

        it('delivers only current unrestricted present-user decisions to the live CLI origin', async () => {
            const effect = vi.fn(async () => ({ ok: true, status: 'completed' }));
            const target = { id: 'live-cli-origin', data: receiverData, timeout: () => ({ emitWithAck: effect }) };
            const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target], [target.id]: [target] });
            for (const scenario of ['automation', 'api-token', 'session', 'machine', 'external', 'present-user'] as const) {
                const socket = createFakeSocket({ id: `decider-${scenario}`, data: {
                    ...receiverData,
                    ...(scenario === 'automation' ? { authAuthority: 'account_automation' } : {}),
                    ...(scenario === 'api-token' ? { authTokenKind: 'api_token', apiTokenPrincipal: {} } : {}),
                    ...(scenario === 'session' ? { clientType: 'session-scoped', sessionId: 'sess_1' } : {}),
                    ...(scenario === 'machine' ? { clientType: 'machine-scoped', machineId: 'machine-1' } : {}),
                }, handshake: { auth: { token: await auth.createToken('user-1', undefined, {
                    kind: 'account', authority: 'present_user',
                }) } } });
                registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io });
                const ack = vi.fn();
                await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-decision',
                    callerAuthority: 'present_user',
                    ...(scenario === 'external' ? { externalActionExecution: { v: 1 } } : {}),
                }, ack);
                expect(ack).toHaveBeenCalledWith(scenario === 'present-user'
                    ? expect.objectContaining({ ok: true, result: { ok: true, status: 'completed' } })
                    : expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
            }
            expect(effect).toHaveBeenCalledOnce();
            expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST,
                expect.objectContaining({ method, params: 'sealed-decision', callerAuthority: 'present_user' }));
        });

        it('refuses distinct duplicate live origins even when one has newer UI focus', async () => {
            const effect = vi.fn(async () => ({ ok: true }));
            const targets = ['origin-a', 'origin-b'].map((id, index) => ({ id,
                data: { ...receiverData, uiLastFocusedAt: index + 1 }, timeout: () => ({ emitWithAck: effect }) }));
            const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: targets,
                ...Object.fromEntries(targets.map(target => [target.id, [target]])) });
            // One local origin must not bypass a complete cross-node census.
            io.sockets.sockets.set(targets[0]!.id, { ...targets[0], connected: true } as unknown as Socket);
            io.sockets.adapter.rooms.set(`rpc:user-1:${method}`, new Set([targets[0]!.id]));
            const socket = createFakeSocket({ id: 'decider', data: receiverData,
                handshake: { auth: { token: await auth.createToken('user-1', undefined, {
                    kind: 'account', authority: 'present_user',
                }) } } });
            registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io });
            const ack = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-decision' }, ack);
            expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' }));
            expect(effect).not.toHaveBeenCalled();
        });

        it('ignores unsuitable receivers and deduplicates the same ordinary CLI socket', async () => {
            const effect = vi.fn(async () => ({ ok: true }));
            const rejectedEffect = vi.fn(async () => ({ ok: false }));
            const target = { id: 'live-cli-origin', data: { ...receiverData, authTokenKind: 'terminal', authAuthority: 'account_automation' },
                timeout: () => ({ emitWithAck: effect }) };
            const unsuitable = [
                { ...receiverData, clientType: 'machine-scoped', machineId: 'machine-1' },
                { ...receiverData, clientType: 'session-scoped', sessionId: 'sess_1' },
                { ...receiverData, authTokenKind: 'api_token', apiTokenPrincipal: {} },
            ].map((data, index) => ({ id: `unsuitable-${index}`, data, timeout: () => ({ emitWithAck: rejectedEffect }) }));
            const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target, target, ...unsuitable], [target.id]: [target] });
            const socket = createFakeSocket({ id: 'decider', data: receiverData,
                handshake: { auth: { token: await auth.createToken('user-1', undefined, {
                    kind: 'account', authority: 'present_user',
                }) } } });
            registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io });
            const ack = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-decision' }, ack);
            expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true, result: { ok: true } }));
            expect(effect).toHaveBeenCalledOnce();
            expect(rejectedEffect).not.toHaveBeenCalled();
        });

        it('rechecks the current caller credential after target discovery and before delivery', async () => {
            const effect = vi.fn(async () => ({ ok: true }));
            const target = { id: 'live-cli-origin', data: receiverData, timeout: () => ({ emitWithAck: effect }) };
            const { io, fetchSockets } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target], [target.id]: [target] });
            fetchSockets.mockImplementation(async room => {
                accountFindUniqueMock.mockResolvedValue({ status: 'active', tokenEpoch: 4 });
                return room === target.id || room === `rpc:user-1:${method}` ? [target] : [];
            });
            const socket = createFakeSocket({ id: 'decider', data: receiverData,
                handshake: { auth: { token: await auth.createToken('user-1', undefined, {
                    kind: 'account', authority: 'present_user',
                }) } } });
            registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io });
            const ack = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-decision' }, ack);
            expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
            expect(effect).not.toHaveBeenCalled();
        });

        it('uses fresh terminal credentials and preserves the original socket ceiling', async () => {
            accountFindUniqueMock.mockResolvedValue({ status: 'active', tokenEpoch: 3 });
            const token = await auth.createToken('user-1', undefined, { kind: 'terminal', authority: 'account_automation' });
            const effect = vi.fn(async () => ({ ok: true }));
            const target = { id: 'live-cli-origin', data: receiverData, timeout: () => ({ emitWithAck: effect }) };
            const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target], [target.id]: [target] });
            const handshake: { auth: { token: string; authorityCeiling?: 'account_automation' } } = { auth: { token } };
            const socket = createFakeSocket({ id: 'terminal-decider', data: { ...receiverData, authTokenKind: 'terminal' }, handshake });
            registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io });
            const allowed = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-decision' }, allowed);
            expect(allowed).toHaveBeenCalledWith(expect.objectContaining({ ok: true, result: { ok: true } }));

            accountFindUniqueMock.mockResolvedValue({ status: 'active', tokenEpoch: 4 });
            expect(await auth.verifyTokenForRoute(token)).toBeNull();
            const revokedAuthority = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-decision' }, revokedAuthority);
            expect(revokedAuthority).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));

            accountFindUniqueMock.mockResolvedValue({ status: 'active', tokenEpoch: 3 });
            handshake.auth.authorityCeiling = 'account_automation';
            const narrowed = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-decision' }, narrowed);
            expect(narrowed).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
            expect(effect).toHaveBeenCalledOnce();
        });
    });

    it('joins ordinary client issuance through Home without adding cancellation custody', async () => {
        const log = vi.spyOn(logging, 'log').mockImplementation(() => {});
        try {
            machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null,
                installationId: 'installation-1', kind: 'persistent' });
            const method = `machine-1:${RPC_METHODS.MACHINES_VITALS_GET}`;
            const { io, addToRoom, createRoomAwareSocket } = createRoomAwareIo();
            let targetTraceId: unknown;
            const target = vi.fn(async (_event: string, packet: unknown) => {
                expect(packet).not.toHaveProperty('requestId');
                targetTraceId = Reflect.get(packet as object, 'traceId');
                return { state: 'reporting' };
            });
            const timeout = vi.fn((_milliseconds: number, _options: unknown) => ({ emitWithAck: target }));
            const daemon = createRoomAwareSocket({ id: 'daemon', data: { clientType: 'machine-scoped',
                machineId: 'machine-1', verifiedMachineInstallationId: 'installation-1' },
                timeout });
            addToRoom(daemon.id, daemon);
            registerSocketRpcHandlers({ userId: 'user-1', socket: daemon as unknown as Socket, io });
            await triggerSocketHandler(daemon, SOCKET_RPC_EVENTS.REGISTER, { method });
            const caller = createRoomAwareSocket({ id: 'reader', data: { clientType: 'user-scoped' } });
            registerSocketRpcHandlers({ userId: 'user-1', socket: caller as unknown as Socket, io });
            let callerTraceId: unknown;
            // Only the socket network boundary is adapted: issuance, ingress,
            // admission, discovery, forwarding and response decoding stay real.
            const clientSocket = { connected: true, emit: vi.fn(), emitWithAck: async (event: string, packet: unknown) => {
                expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
                expect(packet).not.toHaveProperty('requestId');
                callerTraceId = Reflect.get(packet as object, 'traceId');
                const ack = vi.fn();
                await triggerSocketHandler(caller, event, packet, ack);
                return ack.mock.calls[0]?.[0];
            } };
            await expect(callSocketRpc({ socket: clientSocket, target: { kind: 'machine', id: 'machine-1' },
                method: RPC_METHODS.MACHINES_VITALS_GET, params: { secret: 'never-log-input' }, content: { mode: 'plain' } }))
                .resolves.toEqual({ state: 'reporting' });
            expect(callerTraceId).toEqual(expect.stringMatching(/^rpc_/));
            expect(targetTraceId).toEqual(expect.stringMatching(/^rpc_/));
            expect(targetTraceId).not.toBe(callerTraceId);
            const events = log.mock.calls.map(([metadata]) => metadata).filter(metadata => metadata.event);
            const ownedPhases = new Set(['rpc-call-received', 'rpc-call-admitted', 'machine-rpc-relay-completed',
                'rpc-target-lookup', 'rpc-target-issued', 'rpc-target-ack']);
            expect(events.filter(metadata => ownedPhases.has(metadata.event) && metadata.requestId === callerTraceId).map(metadata => metadata.event)).toEqual([
                'rpc-call-received', 'rpc-call-admitted', 'machine-rpc-relay-completed',
            ]);
            expect(events.filter(metadata => ownedPhases.has(metadata.event) && metadata.requestId === targetTraceId).map(metadata => metadata.event)).toEqual([
                'rpc-target-lookup', 'rpc-target-issued', 'rpc-target-ack',
            ]);
            expect(events.find(metadata => metadata.event === 'machine-rpc-relay-completed')).toMatchObject({
                requestId: callerTraceId, targetRequestId: targetTraceId,
            });
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CANCEL, { requestId: callerTraceId });
            await triggerSocketHandler(caller, 'disconnect');
            expect(daemon.emit.mock.calls.filter((call: readonly unknown[]) => call[0] === SOCKET_RPC_EVENTS.CANCEL)).toEqual([]);
            expect(clientSocket.emit).not.toHaveBeenCalled();
            expect(target).toHaveBeenCalledOnce();
            expect(timeout.mock.calls[0]?.[1]).not.toHaveProperty('signal');
            expect(JSON.stringify(events)).not.toContain('never-log');
        } finally { log.mockRestore(); }
    });
    it.each(['opaque', 'malformed'] as const)('keeps %s diagnostic metadata out of authority and content logs', async kind => {
        const log = vi.spyOn(logging, 'log').mockImplementation(() => {});
        try {
            machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null,
                installationId: 'installation-1', kind: 'persistent' });
            const method = `machine-1:${RPC_METHODS.MACHINES_VITALS_GET}`;
            const { io, addToRoom, createRoomAwareSocket } = createRoomAwareIo();
            const effect = vi.fn(async (_event: string, packet: unknown) => {
                expect(packet).not.toHaveProperty('requestId');
                if (kind === 'opaque') expect(packet).toHaveProperty('traceId', expect.stringMatching(/^rpc_/));
                else expect(packet).not.toHaveProperty('traceId');
                return { state: 'reporting' };
            });
            const daemon = createRoomAwareSocket({ id: 'daemon', data: { clientType: 'machine-scoped',
                machineId: 'machine-1', verifiedMachineInstallationId: 'installation-1' },
                timeout: () => ({ emitWithAck: effect }) });
            addToRoom(daemon.id, daemon);
            registerSocketRpcHandlers({ userId: 'user-1', socket: daemon as unknown as Socket, io });
            await triggerSocketHandler(daemon, SOCKET_RPC_EVENTS.REGISTER, { method });
            const caller = createRoomAwareSocket({ id: 'reader', data: { clientType: 'user-scoped' } });
            registerSocketRpcHandlers({ userId: 'user-1', socket: caller as unknown as Socket, io });
            const opaqueId = 'never-log-token/path\nnever-log-secret';
            const traceId = kind === 'opaque' ? opaqueId : { secret: 'never-log-secret' };
            const ack = vi.fn();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, traceId, params: {} }, ack);
            expect(ack).toHaveBeenCalledWith({ ok: true, result: { state: 'reporting' } });
            expect(effect).toHaveBeenCalledOnce();
            if (kind === 'opaque') expect(log).toHaveBeenCalledWith(expect.objectContaining({
                event: 'machine-rpc-relay-completed',
                requestId: `sha256:${createHash('sha256').update(opaqueId).digest('hex')}`,
            }), 'Machine RPC relay completed');
            expect(JSON.stringify(log.mock.calls)).not.toContain('never-log');
        } finally { log.mockRestore(); }
    });
    it.each(['machines.vitals.get', 'machines.guard.get', 'machines.storage.summary.get'])(
        'correlates admitted resource RPC diagnostics without logging content: %s', async (rpcMethod) => {
            const log = vi.spyOn(logging, 'log').mockImplementation(() => {});
            try {
                machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null,
                    installationId: 'installation-1', kind: 'persistent' });
                const method = `machine-1:${rpcMethod}`;
                const { io, addToRoom, createRoomAwareSocket } = createRoomAwareIo();
                const effect = vi.fn<RpcTargetEmitWithAck>(async () => ({ state: 'reporting' }));
                const daemon = createRoomAwareSocket({ id: 'daemon', data: { clientType: 'machine-scoped',
                    machineId: 'machine-1', verifiedMachineInstallationId: 'installation-1' },
                    timeout: () => ({ emitWithAck: effect }) });
                addToRoom(daemon.id, daemon);
                registerSocketRpcHandlers({ userId: 'user-1', socket: daemon as unknown as Socket, io });
                await triggerSocketHandler(daemon, SOCKET_RPC_EVENTS.REGISTER, { method });
                const caller = createRoomAwareSocket({ id: 'reader', data: { clientType: 'user-scoped' } });
                registerSocketRpcHandlers({ userId: 'user-1', socket: caller as unknown as Socket, io });
                const ack = vi.fn();
                await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
                    method, requestId: 'resource-caller', params: { machineId: 'machine-1' },
                }, ack);
                expect(ack).toHaveBeenCalledWith({ ok: true, result: { state: 'reporting' } });
                const targetRequestId = effect.mock.calls[0]?.[1]?.requestId;
                expect(targetRequestId).toEqual(expect.any(String));
                expect(log).toHaveBeenCalledWith(expect.objectContaining({
                    event: 'machine-rpc-relay-completed', method,
                    requestId: `sha256:${createHash('sha256').update('resource-caller').digest('hex')}`,
                    targetRequestId, targetSocketId: 'daemon',
                    durationMs: expect.any(Number), admissionMs: expect.any(Number), relayMs: expect.any(Number),
                }), 'Machine RPC relay completed');
                const diagnostic = log.mock.calls.find(([metadata]) => metadata.event === 'machine-rpc-relay-completed')?.[0];
                expect(diagnostic).not.toHaveProperty('params');
                expect(diagnostic).not.toHaveProperty('result');
            } finally {
                log.mockRestore();
            }
        },
    );
    it.each(['current', 'foreign', 'shared-use', 'revoked', 'replaced', 'unknown', 'uninstalled', 'ephemeral', 'old-installation', 'session-proof'] as const)(
        'routes detached execution-run reads through exact Machine admission: %s', async (scenario) => {
            machineFindFirstMock.mockImplementation(async (args) => {
                const machineId = (args as { where: { id: string } }).where.id;
                return machineId !== 'machine-1' || scenario === 'unknown' ? null : {
                    revokedAt: scenario === 'revoked' ? new Date(1) : null,
                    replacedByMachineId: scenario === 'replaced' ? 'replacement-machine' : null,
                    ...(scenario === 'uninstalled' ? {} : { installationId: 'installation-1' }),
                    kind: scenario === 'ephemeral' ? 'ephemeral_session_runner' : 'persistent',
                    ...(scenario === 'shared-use' ? { accountGrants: [{ accountId: 'other-user', accessLevel: 'view',
                        account: { status: 'active', firstName: null, lastName: null, username: null, avatar: null } }] } : {}),
                };
            });
            sessionFindUniqueMock.mockResolvedValue(null);
            const method = `machine-1:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`;
            const { io, rooms, addToRoom, createRoomAwareSocket } = createRoomAwareIo();
            const effect = vi.fn(async () => ({ runId: 'detached-run', status: 'failed' }));
            const daemon = createRoomAwareSocket({ id: 'daemon', data: { clientType: 'machine-scoped',
                machineId: 'machine-1', verifiedMachineInstallationId: scenario === 'old-installation' ? 'old' : 'installation-1' },
                timeout: () => ({ emitWithAck: effect }) });
            addToRoom(daemon.id, daemon);
            registerSocketRpcHandlers({ userId: 'user-1', socket: daemon as unknown as Socket, io });
            await triggerSocketHandler(daemon, SOCKET_RPC_EVENTS.REGISTER, { method });
            if (scenario === 'current') expect(rooms.get(`rpc:user-1:${method}`)?.has(daemon)).toBe(true);
            const caller = createRoomAwareSocket({ id: 'reader', data: { clientType: 'user-scoped' } });
            registerSocketRpcHandlers({ userId: scenario === 'foreign' || scenario === 'shared-use' ? 'other-user' : 'user-1', socket: caller as unknown as Socket, io });
            if (scenario === 'shared-use') {
                const { resolveMachineAdmission } = await import('@/app/machines/machineAccess');
                expect(await resolveMachineAdmission({ actorAccountId: 'other-user', machineId: 'machine-1', requiredRole: 'use' }))
                    .toMatchObject({ kind: 'admitted', role: 'use' });
            }
            const ack = vi.fn();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: { runId: 'detached-run', sessionId: null },
                ...(scenario === 'session-proof' ? { authorization: { kind: 'session.write', sessionId: 'other-session' } } : {}) }, ack);
            if (scenario === 'current') {
                expect(ack).toHaveBeenCalledWith({ ok: true, result: { runId: 'detached-run', status: 'failed' } });
                expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
                    machineAdmission: expect.objectContaining({ actorAccountId: 'user-1', machineId: 'machine-1', installationId: 'installation-1' }),
                }));
            } else {
                expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                expect(effect).not.toHaveBeenCalled();
            }
        });

    it.each([
        { clientType: 'user-scoped', method: SESSION_RPC_METHODS.EXECUTION_RUN_GET },
        { clientType: 'user-scoped', method: `machine-1:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}` },
        { clientType: 'machine-scoped', machineId: 'machine-2', method: `machine-1:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}` },
    ])('refuses execution-run registration outside the exact publishing scope: $clientType $method', async ({ method, ...data }) => {
        const { io, rooms, createRoomAwareSocket } = createRoomAwareIo();
        const socket = createRoomAwareSocket({ id: 'wrong-publisher', data });
        registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io });
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method });
        expect(rooms.has(`rpc:user-1:${method}`)).toBe(false);
    });

    it('does not register Session-only execution broker authority on a Machine', async () => {
        const { io, rooms, createRoomAwareSocket } = createRoomAwareIo();
        const daemon = createRoomAwareSocket({ id: 'daemon', data: { clientType: 'machine-scoped', machineId: 'machine-1' } });
        registerSocketRpcHandlers({ userId: 'user-1', socket: daemon as unknown as Socket, io });
        await triggerSocketHandler(daemon, SOCKET_RPC_EVENTS.REGISTER, { method: `machine-1:${SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1}` });
        expect(rooms.has(`rpc:user-1:machine-1:${SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1}`)).toBe(false);
    });

    it.each([RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS, RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY])(
        'relays ordinary filesystem reads without a signed workspace continuation: %s', async (rpcMethod) => {
            const method = `machine-1:${rpcMethod}`;
            const target = { id: 'filesystem-daemon', data: { clientType: 'machine-scoped', machineId: 'machine-1' },
                timeout: () => ({ emitWithAck: async () => 'filesystem-result' }) };
            const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target], [target.id]: [target] });
            const socket = createFakeSocket({ id: 'browser', data: { clientType: 'user-scoped' } });
            registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io });
            const acknowledge = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: 'opaque-listing-request' }, acknowledge);
            expect(acknowledge).toHaveBeenCalledWith({ ok: true, result: 'filesystem-result' });
        },
    );
    it('never promotes a client-supplied Machine-read origin into Home authority', async () => {
        const method = `machine-1:${RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_BROKER_ELIGIBILITY}`;
        const emitWithAck = vi.fn(async (_event: string, _request: { authorization?: unknown }) => 'encrypted-eligibility-result');
        const target = { id: 'broker-daemon', data: { clientType: 'machine-scoped', machineId: 'machine-1' },
            timeout: () => ({ emitWithAck }) };
        const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target], [target.id]: [target] });
        const socket = createFakeSocket({ id: 'browser', data: { clientType: 'user-scoped' } });
        registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io });
        const acknowledge = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: 'encrypted-eligibility-request',
            authorization: { kind: 'machine.read.serverOrigin', accountId: 'user-1', machineId: 'machine-1' } }, acknowledge);
        expect(acknowledge).toHaveBeenCalledWith({ ok: true, result: 'encrypted-eligibility-result' });
        expect(emitWithAck.mock.calls).toHaveLength(1);
        expect(emitWithAck.mock.calls[0][1].authorization).toBeUndefined();
    });
    it.each([undefined, 'old-installation', 'current-installation'])('registers current-service admission only on the current verified installation: %s', async (installationId) => {
        machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null, installationId: 'current-installation' });
        const join = vi.fn(async () => {});
        const socket = createFakeSocket({ id: 'daemon', join, data: { clientType: 'machine-scoped', machineId: 'machine-1',
            ...(installationId ? { verifiedMachineInstallationId: installationId } : {}) } });
        const { io } = createIo();
        registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io });
        const method = 'machine-1:daemon.localServices.preview.admission';
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method });
        if (installationId === 'current-installation') {
            expect(join).toHaveBeenCalledWith(`rpc:user-1:${method}`);
            expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
        } else {
            expect(join).not.toHaveBeenCalled();
            expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({ type: 'register', error: 'Forbidden' }));
        }
    });
    it("refuses client-forged current-service admission before any target lookup", async () => {
        const socket = createFakeSocket({ id: 'caller', data: { clientType: 'user-scoped' } });
        const { io, fetchSockets } = createTargetRoutingIo({});
        registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io });
        const acknowledge = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method: 'machine-1:daemon.localServices.preview.admission', params: { v: 1, kind: 'read' },
            authorization: { kind: 'localServices.preview.admission.serverOrigin' },
        }, acknowledge);
        expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(fetchSockets).not.toHaveBeenCalled();
    });
    const sessionActionOrigin = {
        v: 1, caller: { kind: 'session', sessionId: 'lead', starterDepth: 2, turnDepth: 4 },
        callerPermissionMode: 'read-only', sourceTurnId: 'turn-original', requestId: 'action-original', workspaceWrites: 'deny',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
    };
    async function createSessionActionFixture(tokenKind: 'account' | 'terminal' = 'account') {
        sessionFindUniqueMock.mockImplementation(async (args?: { where?: { id?: string } }) => createOwnedSessionAccessRow(args?.where?.id));
        accessKeyFindUniqueMock.mockImplementation(async (args) => {
            const tuple = args?.where?.accountId_machineId_sessionId;
            const session = await sessionFindUniqueMock({ where: { id: tuple?.sessionId } });
            return session ? { accountId: tuple?.accountId ?? 'user-1', machineId: tuple?.machineId ?? 'machine-source',
                session: { accountId: session.accountId }, machine: { revokedAt: null, replacedByMachineId: null } } : null;
        });
        machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null, installationId: 'installation-source', kind: 'persistent' });
        const source = createFakeSocket({ id: 'source-daemon', data: {
            clientType: 'machine-scoped', machineId: 'machine-source', authTokenKind: tokenKind, verifiedMachineInstallationId: 'installation-source',
            authAuthority: tokenKind === 'terminal' ? 'account_automation' : 'present_user',
        }, handshake: { auth: { token: await auth.createToken('user-1', undefined, { kind: tokenKind,
            authority: tokenKind === 'terminal' ? 'account_automation' : 'present_user' }) } } });
        const effect = vi.fn(async (_event: string, _request: unknown) => ({ updated: true }));
        const target = { id: 'target-runtime', data: { clientType: 'session-scoped', sessionPublisherAuthority: {
            v: 1, accountId: 'user-1', sessionId: 'report', machineId: 'machine-target', committedFenceMs: 2, publisherGeneration: '1',
        } }, timeout: () => ({ emitWithAck: effect }) };
        const publisher = { data: { sessionPublisherAuthority: {
            v: 1, accountId: 'user-1', sessionId: 'lead', machineId: 'machine-source', committedFenceMs: 2, publisherGeneration: '1',
        } } };
        const rooms: Record<string, unknown[]> = { 'session:lead:user-1': [publisher],
            'rpc:user-1:report:session.notes.set': [target], [target.id]: [target] };
        const { io } = createTargetRoutingIo(rooms);
        return { source, effect, rooms, io, target, publisher };
    }
    it('forwards authenticated Session Action facts as automation through real ingress and relay', async () => {
        const { source, effect, io } = await createSessionActionFixture();
        registerSocketRpcHandlers({ userId: 'user-1', socket: source as unknown as Socket, io, sessionPublisherPresence: createSessionPublisherPresence() });
        const ack = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method: 'report:session.notes.set', params: 'sealed-role-input',
            authorization: { kind: 'session.action', sessionId: 'report', origin: sessionActionOrigin },
            sessionActionOrigin: { ...sessionActionOrigin, callerPermissionMode: 'yolo' }, callerAuthority: 'present_user',
        }, ack);
        expect(ack).toHaveBeenCalledWith({ ok: true, result: { updated: true } });
        expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            callerAuthority: 'account_automation', sessionActionOrigin, params: 'sealed-role-input',
            authorization: { kind: 'session.write', sessionId: 'report' },
        }));
    });
    it.each(['account', 'terminal'] as const)('forwards an installed %s daemon skill read with its original Session authority', async (tokenKind) => {
        const { source, effect, rooms, io, target } = await createSessionActionFixture(tokenKind);
        target.data.sessionPublisherAuthority.sessionId = 'lead';
        rooms['rpc:user-1:lead:skills.read'] = [target];
        registerSocketRpcHandlers({ userId: 'user-1', socket: source as unknown as Socket, io,
            sessionPublisherPresence: createSessionPublisherPresence() });
        const ack = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method: 'lead:skills.read', params: 'sealed-skill-input',
            authorization: { kind: 'session.action', sessionId: 'lead', origin: sessionActionOrigin },
        }, ack);
        expect(ack).toHaveBeenCalledWith({ ok: true, result: { updated: true } });
        expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            method: 'lead:skills.read', callerAuthority: 'account_automation', sessionActionOrigin,
            authorization: { kind: 'session.write', sessionId: 'lead' },
        }));
    });
    it.each(['user', 'session', 'unverified', 'wrong-installation', 'wrong-host', 'foreign-caller', 'foreign-target', 'restricted', 'unknown-origin-field', 'wrong-target', 'unrelated-method', 'roles.create', 'roles.list'])('refuses forged Session Action source: %s', async (scenario) => {
        const { source, effect, io, publisher } = await createSessionActionFixture();
        if (scenario === 'user') source.data!.clientType = 'user-scoped';
        if (scenario === 'session') source.data!.clientType = 'session-scoped';
        if (scenario === 'unverified') delete source.data!.verifiedMachineInstallationId;
        if (scenario === 'wrong-installation') source.data!.verifiedMachineInstallationId = 'other';
        if (scenario === 'wrong-host') publisher.data.sessionPublisherAuthority.machineId = 'other';
        if (scenario === 'foreign-caller') sessionFindUniqueMock.mockImplementation(async (args?: { where?: { id?: string } }) => ({ ...createOwnedSessionAccessRow(args?.where?.id), accountId: args?.where?.id === 'lead' ? 'foreign' : 'user-1' }));
        if (scenario === 'foreign-target') sessionFindUniqueMock.mockImplementation(async (args?: { where?: { id?: string } }) => ({ ...createOwnedSessionAccessRow(args?.where?.id), accountId: args?.where?.id === 'report' ? 'foreign' : 'user-1' }));
        if (scenario === 'restricted') source.data!.ephemeralRunnerAdmission = { kind: 'machine-runtime' };
        registerSocketRpcHandlers({ userId: 'user-1', socket: source as unknown as Socket, io, sessionPublisherPresence: createSessionPublisherPresence() });
        const ack = vi.fn();
        const method = scenario.startsWith('roles.') ? `report:${scenario}`
            : scenario === 'unrelated-method' ? 'report:session.goal.set' : 'report:session.notes.set';
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-role-input',
            authorization: { kind: 'session.action', sessionId: scenario === 'wrong-target' ? 'other' : 'report',
                origin: scenario === 'unknown-origin-field' ? { ...sessionActionOrigin, authority: 'present_user' } : sessionActionOrigin },
        }, ack);
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effect).not.toHaveBeenCalled();
    });
    it.each(['installation', 'hosting-machine'])('rechecks Session Action source %s immediately before target dispatch', async (scenario) => {
        const { source, effect, io, publisher } = await createSessionActionFixture();
        const originalIn = io.in.bind(io);
        io.in = ((room: string) => {
            if (room === 'rpc:user-1:report:session.notes.set') {
                if (scenario === 'installation') machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null, installationId: 'replacement', kind: 'persistent' });
                else publisher.data.sessionPublisherAuthority.machineId = 'replacement';
            }
            return originalIn(room);
        }) as typeof io.in;
        registerSocketRpcHandlers({ userId: 'user-1', socket: source as unknown as Socket, io, sessionPublisherPresence: createSessionPublisherPresence() });
        const ack = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method: 'report:session.notes.set', params: 'sealed-role-input',
            authorization: { kind: 'session.action', sessionId: 'report', origin: sessionActionOrigin },
        }, ack);
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(effect).not.toHaveBeenCalled();
    });

    async function createWorkspaceSyncSourcePhaseFixture() {
        const fixture = await createSessionActionFixture();
        const homeId = `srv_${'a'.repeat(32)}`;
        const routing = { v: 1, phase: 'prepare', operationId: 'source-operation', accountServerId: homeId, sourceMachineId: 'machine-source',
            sourceRootPath: '/child/custom', sourceSessionId: 'lead' };
        const managedRow = { id: 'managed-child', homeId, custodianAccountId: 'user-1',
            controllerMachineId: 'machine-parent', controllerInstallationId: 'installation-parent',
            enrolledMachineId: routing.sourceMachineId, creationState: 'active', allocation: 'bound', archivedAt: null,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' },
                schemaVersion: 1, value: {}, devcontainerObservation: { nativeResourceId: 'container-current', user: 'coder',
                    workspaceFolder: routing.sourceRootPath,
                    storage: { kind: 'bind', hostPath: '/parent/source', childPath: routing.sourceRootPath } } } };
        managedMachineFindUniqueMock.mockImplementation(async (args: Readonly<{ where: { enrolledMachineId?: string; id?: string } }>) =>
            args.where.enrolledMachineId === managedRow.enrolledMachineId || args.where.id === managedRow.id ? managedRow : null);
        machineFindFirstMock.mockImplementation(async (args?: unknown) => {
            const where = args && typeof args === 'object' && 'where' in args ? args.where : undefined;
            const machineId = where && typeof where === 'object' && 'id' in where ? where.id : undefined;
            return { revokedAt: null, replacedByMachineId: null, kind: 'persistent',
                installationId: machineId === 'machine-parent' ? 'installation-parent' : 'installation-source' };
        });
        const method = 'machine-parent:daemon.workspaceSync.handoffSourcePhase.v1';
        const effect = vi.fn(async (_event: string, _request: unknown) => ({ prepared: true }));
        const target = { id: 'parent-daemon', data: { clientType: 'machine-scoped', machineId: 'machine-parent',
            verifiedMachineInstallationId: 'installation-parent' }, timeout: () => ({ emitWithAck: effect }) };
        fixture.rooms[`rpc:user-1:${method}`] = [target];
        fixture.rooms[target.id] = [target];
        return { ...fixture, homeId, routing, managedRow, method, target, effect };
    }

    it('routes bind-child Workspace Sync SOURCE phases with original child admission and present-user identity', async () => {
        const { source, effect, io, routing, method } = await createWorkspaceSyncSourcePhaseFixture();
        registerSocketRpcHandlers({ userId: 'user-1', socket: source as unknown as Socket, io,
            sessionPublisherPresence: createSessionPublisherPresence() });
        const ack = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-source-phase',
            workspaceSyncSourceRouting: routing }, ack);
        expect(ack).toHaveBeenCalledWith({ ok: true, result: { prepared: true } });
        expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            params: 'sealed-source-phase', callerAuthority: 'present_user', workspaceSyncSourceRouting: routing,
            machineAdmission: { actorAccountId: 'user-1', custodianAccountId: 'user-1', machineId: 'machine-source',
                installationId: 'installation-source', role: 'manage', encryptionMode: 'plain' },
        }));
        expect(effect.mock.calls[0]?.[1]).not.toHaveProperty('sessionActionOrigin');
    });

    it('preserves genuine Session Action origin through bind-child Workspace Sync SOURCE routing', async () => {
        const { source, effect, io, routing, method } = await createWorkspaceSyncSourcePhaseFixture();
        registerSocketRpcHandlers({ userId: 'user-1', socket: source as unknown as Socket, io,
            sessionPublisherPresence: createSessionPublisherPresence() });
        const ack = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-source-phase',
            workspaceSyncSourceRouting: routing,
            authorization: { kind: 'session.action', sessionId: 'lead', origin: sessionActionOrigin } }, ack);
        expect(ack).toHaveBeenCalledWith({ ok: true, result: { prepared: true } });
        expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            callerAuthority: 'account_automation', sessionActionOrigin,
            machineAdmission: expect.objectContaining({ machineId: 'machine-source', installationId: 'installation-source' }),
        }));
    });

    it('preserves the Home-admitted shared child actor through SOURCE routing without a parent grant', async () => {
        const { source, effect, io, routing, method } = await createWorkspaceSyncSourcePhaseFixture();
        const originalMachineRead = machineFindFirstMock.getMockImplementation()!;
        let grantLevel: 'view' | 'admin' | null = 'view';
        machineFindFirstMock.mockImplementation(async args => {
            const where = args && typeof args === 'object' && 'where' in args ? args.where : undefined;
            const machineId = where && typeof where === 'object' && 'id' in where ? where.id : undefined;
            const machine = await originalMachineRead(args);
            if (!machine) return null;
            return { ...machine, accountGrants: machineId === routing.sourceMachineId && grantLevel
                ? [{ accountId: 'requester', accessLevel: grantLevel, account: { id: 'requester', status: 'active',
                    firstName: null, lastName: null, username: null, avatar: null } }] : [] };
        });
        const { resolveMachineAdmission } = await import('@/app/machines/machineAccess');
        expect(await resolveMachineAdmission({ actorAccountId: 'requester', machineId: 'machine-parent',
            requiredRole: 'use', requireOnline: true })).toMatchObject({ kind: 'denied', code: 'access_denied' });
        const admitted = await resolveMachineAdmission({ actorAccountId: 'requester', machineId: routing.sourceMachineId,
            requiredRole: 'use', requireOnline: true });
        expect(admitted.kind).toBe('admitted');
        if (admitted.kind !== 'admitted') throw new Error('Shared child fixture must use real current Machine admission');
        const { kind: _kind, ...machineAdmission } = admitted;
        const sourceRouting = { ...routing, sourceContext: { machineAdmission, callerAuthority: 'account_automation',
            callerInputConstraints: { models: [{ agentTargetKey: 'agent:codex', providerConnectionId: null,
                modelId: 'allowed-model' }], permissionModes: ['read-only'] } } };
        registerSocketRpcHandlers({ userId: 'user-1', socket: source as unknown as Socket, io,
            sessionPublisherPresence: createSessionPublisherPresence() });
        const ack = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-shared-source',
            workspaceSyncSourceRouting: sourceRouting }, ack);
        expect(ack).toHaveBeenCalledWith({ ok: true, result: { prepared: true } });
        expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            machineAdmission, callerAuthority: 'account_automation',
            callerInputConstraints: sourceRouting.sourceContext.callerInputConstraints,
            workspaceSyncSourceRouting: sourceRouting,
        }));
        expect(machineAdmission).toMatchObject({ actorAccountId: 'requester', role: 'use', machineId: 'machine-source' });
        expect(effect.mock.calls[0]?.[1]).not.toHaveProperty('sessionActionOrigin');
        const widerRouting = { ...sourceRouting, sourceContext: { ...sourceRouting.sourceContext,
            machineAdmission: { ...machineAdmission, role: 'manage' } } };
        const wider = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-shared-source',
            workspaceSyncSourceRouting: widerRouting }, wider);
        expect(wider).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        grantLevel = 'admin';
        const stillNarrow = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-shared-source',
            workspaceSyncSourceRouting: sourceRouting }, stillNarrow);
        expect(stillNarrow).toHaveBeenCalledWith({ ok: true, result: { prepared: true } });
        expect(effect.mock.calls[1]?.[1]).toMatchObject({ machineAdmission,
            callerAuthority: 'account_automation', callerInputConstraints: sourceRouting.sourceContext.callerInputConstraints });
        grantLevel = null;
        const revoked = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-shared-source',
            workspaceSyncSourceRouting: sourceRouting }, revoked);
        expect(revoked).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        const releaseRouting = { ...sourceRouting, phase: 'abort' };
        const release = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-retained-shared-abort',
            workspaceSyncSourceRouting: releaseRouting }, release);
        expect(release).toHaveBeenCalledWith({ ok: true, result: { prepared: true } });
        expect(effect.mock.calls[2]?.[1]).toMatchObject({ machineAdmission, workspaceSyncSourceRouting: releaseRouting });
        grantLevel = 'view';
        source.data!.clientType = 'user-scoped';
        const refused = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-shared-source',
            workspaceSyncSourceRouting: sourceRouting }, refused);
        expect(refused).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effect).toHaveBeenCalledTimes(3);
    });

    it.each(['user-socket', 'foreign-child', 'stale-source', 'wrong-home', 'wrong-root', 'child-volume', 'retired-relation', 'replaced-parent'])
    ('refuses invalid bind-child Workspace Sync SOURCE routing before a parent effect: %s', async (scenario) => {
        const { source, effect, io, routing, managedRow, method } = await createWorkspaceSyncSourcePhaseFixture();
        if (scenario === 'user-socket') source.data!.clientType = 'user-scoped';
        if (scenario === 'foreign-child') routing.sourceMachineId = 'foreign-child';
        if (scenario === 'stale-source') source.data!.verifiedMachineInstallationId = 'old-child-installation';
        if (scenario === 'wrong-home') routing.accountServerId = `srv_${'b'.repeat(32)}`;
        if (scenario === 'wrong-root') routing.sourceRootPath = '/child/other';
        if (scenario === 'child-volume') managedRow.resource.devcontainerObservation.storage.kind = 'child';
        if (scenario === 'retired-relation') managedRow.creationState = 'retired';
        if (scenario === 'replaced-parent') managedRow.controllerInstallationId = 'old-parent-installation';
        registerSocketRpcHandlers({ userId: 'user-1', socket: source as unknown as Socket, io,
            sessionPublisherPresence: createSessionPublisherPresence() });
        const ack = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-source-phase',
            workspaceSyncSourceRouting: routing }, ack);
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effect).not.toHaveBeenCalled();
    });

    it.each(['commit', 'abort'])('routes only retained SOURCE %s cleanup after Session adoption and native root drift', async phase => {
        const { source, effect, io, routing, managedRow, publisher, method } = await createWorkspaceSyncSourcePhaseFixture();
        routing.phase = phase;
        publisher.data.sessionPublisherAuthority.machineId = 'adopted-target';
        managedRow.resource.devcontainerObservation.storage.kind = 'child';
        registerSocketRpcHandlers({ userId: 'user-1', socket: source as unknown as Socket, io,
            sessionPublisherPresence: createSessionPublisherPresence() });
        const ack = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-retained-cleanup',
            workspaceSyncSourceRouting: routing }, ack);
        expect(ack).toHaveBeenCalledWith({ ok: true, result: { prepared: true } });
        expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            workspaceSyncSourceRouting: routing,
            machineAdmission: expect.objectContaining({ machineId: 'machine-source', installationId: 'installation-source' }),
        }));
        Object.assign(source, { handshake: { auth: { token: 'retired-account-credential' } } });
        const refused = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-retained-cleanup',
            workspaceSyncSourceRouting: routing }, refused);
        expect(refused).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effect).toHaveBeenCalledOnce();
    });

    it.each(['commit', 'abort'])('routes retained SOURCE %s cleanup after replacement clears child enrollment', async phase => {
        const { source, effect, io, routing, managedRow, method } = await createWorkspaceSyncSourcePhaseFixture();
        registerSocketRpcHandlers({ userId: 'user-1', socket: source as unknown as Socket, io,
            sessionPublisherPresence: createSessionPublisherPresence() });
        const prepare = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-source-prepare',
            workspaceSyncSourceRouting: routing }, prepare);
        expect(prepare).toHaveBeenCalledWith({ ok: true, result: { prepared: true } });
        // reportManagedIntent's replacement transition clears the inverse enrollment,
        // while the original installed child can still run until fresh enrollment.
        Object.assign(managedRow, { enrolledMachineId: null, replacementEnrollment: { machineId: routing.sourceMachineId } });
        routing.phase = phase;
        const cleanup = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-retained-cleanup',
            workspaceSyncSourceRouting: routing }, cleanup);
        expect(cleanup).toHaveBeenCalledWith({ ok: true, result: { prepared: true } });
        expect(effect.mock.calls[1]?.[1]).toMatchObject({ workspaceSyncSourceRouting: routing,
            machineAdmission: { machineId: 'machine-source', installationId: 'installation-source' } });
        routing.phase = 'prepare';
        const fresh = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-new-prepare',
            workspaceSyncSourceRouting: routing }, fresh);
        expect(fresh).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effect).toHaveBeenCalledTimes(2);
    });

    it.each(['source-session', 'parent-installation'])('rechecks bind-child SOURCE %s at selected parent dispatch', async scenario => {
        const { source, effect, io, routing, managedRow, publisher, method } = await createWorkspaceSyncSourcePhaseFixture();
        const originalIn = io.in.bind(io);
        io.in = ((room: string) => {
            if (room === `rpc:user-1:${method}`) {
                if (scenario === 'source-session') publisher.data.sessionPublisherAuthority.machineId = 'adopted-target';
                else managedRow.controllerInstallationId = 'replaced-parent-installation';
            }
            return originalIn(room);
        }) as typeof io.in;
        registerSocketRpcHandlers({ userId: 'user-1', socket: source as unknown as Socket, io,
            sessionPublisherPresence: createSessionPublisherPresence() });
        const ack = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-source-phase',
            workspaceSyncSourceRouting: routing }, ack);
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effect).not.toHaveBeenCalled();
    });

    it('routes TARGET preflight with the original shared child admission and no source Session hosting requirement', async () => {
        const { source, io, routing, publisher, target, effect, rooms } = await createWorkspaceSyncSourcePhaseFixture();
        const originalMachineRead = machineFindFirstMock.getMockImplementation()!;
        machineFindFirstMock.mockImplementation(async args => {
            const where = args && typeof args === 'object' && 'where' in args ? args.where : undefined;
            const machineId = where && typeof where === 'object' && 'id' in where ? where.id : undefined;
            const machine = await originalMachineRead(args);
            if (!machine) return null;
            return { ...machine, accountGrants: machineId === routing.sourceMachineId
                ? [{ accountId: 'requester', accessLevel: 'view', account: { id: 'requester', status: 'active',
                    firstName: null, lastName: null, username: null, avatar: null } }] : [] };
        });
        const { resolveMachineAdmission } = await import('@/app/machines/machineAccess');
        expect(await resolveMachineAdmission({ actorAccountId: 'requester', machineId: 'machine-parent',
            requiredRole: 'use', requireOnline: true })).toMatchObject({ kind: 'denied', code: 'access_denied' });
        const admitted = await resolveMachineAdmission({ actorAccountId: 'requester', machineId: routing.sourceMachineId,
            requiredRole: 'use', requireOnline: true });
        expect(admitted).toMatchObject({ kind: 'admitted' });
        if (admitted.kind !== 'admitted') throw new Error('Real shared target child admission required');
        const { kind: _kind, ...machineAdmission } = admitted;
        const targetRouting = { v: 1, phase: 'preflight', operationId: routing.operationId,
            accountServerId: routing.accountServerId, targetMachineId: routing.sourceMachineId,
            targetRootPath: routing.sourceRootPath,
            targetContext: { machineAdmission, callerAuthority: 'account_automation',
                callerInputConstraints: { models: null, permissionModes: ['read-only'] } } };
        const method = `machine-parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
        rooms[`rpc:user-1:${method}`] = [target];
        publisher.data.sessionPublisherAuthority.machineId = 'unrelated-source';
        registerSocketRpcHandlers({ userId: 'user-1', socket: source as unknown as Socket, io,
            sessionPublisherPresence: createSessionPublisherPresence() });
        const ack = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-target-preflight',
            workspaceSyncTargetRouting: targetRouting }, ack);
        expect(ack).toHaveBeenCalledWith({ ok: true, result: { prepared: true } });
        expect(effect.mock.calls[0]?.[1]).toMatchObject({ machineAdmission,
            callerAuthority: 'account_automation', callerInputConstraints: targetRouting.targetContext.callerInputConstraints,
            workspaceSyncTargetRouting: targetRouting });
        expect(effect.mock.calls[0]?.[1]).not.toHaveProperty('sessionActionOrigin');
        source.data!.clientType = 'user-scoped';
        const refused = vi.fn();
        await triggerSocketHandler(source, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-target-preflight',
            workspaceSyncTargetRouting: targetRouting }, refused);
        expect(refused).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effect).toHaveBeenCalledOnce();
    });

    it.each([
        uiBrowserAutomationDispatchMethod({ browserSessionId: 'visible-session', viewId: 'visible-view' }),
        RPC_METHODS.UI_ACTION_EXECUTE,
        `${RPC_METHODS.UI_ACTION_EXECUTE}.session.${encodeURIComponent(JSON.stringify('viewed-session'))}`,
        RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE,
        RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME,
        mountedWorkReadClientRpcMethod('session.work.get', 'work-lead'),
        mountedWorkReadClientRpcMethod('session.work.get', '\u0800'.repeat(600)),
        mountedWorkReadClientRpcMethod('inbox.get'),
        workflowDraftClientRpcMethod({ scope: { serverId: 'home', accountId: 'user-1' }, draftId: 'draft' }),
        workflowDraftClientRpcMethod({ scope: { serverId: 'home-' + '\u0800'.repeat(600), accountId: 'user-1' }, draftId: 'draft' }),
    ])("admits UI Action continuation %s only from the authenticated exact Machine", async (rpcMethod) => {
        // Real daemons are enrolled. A legacy row without installation custody
        // skipped the receiving guard and hid rejection of the App recipient.
        machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null,
            installationId: 'installed-machine-1' });
        const method = `machine-1:${rpcMethod}`;
        const effect = vi.fn(async () => 'encrypted-page-result');
        const target = { id: 'ui-view', data: { clientType: 'user-scoped' }, timeout: () => ({ emitWithAck: effect }) };
        const connectedMachines: ReturnType<typeof createFakeSocket>[] = [];
        const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target], [target.id]: [target],
            [getMachineSocketRoom('user-1', 'machine-1')]: connectedMachines });
        for (const data of [
            { clientType: 'machine-scoped', machineId: 'machine-1', verifiedMachineInstallationId: 'installed-machine-1' },
            { clientType: 'user-scoped' },
            { clientType: 'machine-scoped', machineId: 'machine-2' },
            { clientType: 'machine-scoped', machineId: 'machine-1', verifiedMachineInstallationId: 'retired-installation' },
        ]) {
            const socket = createFakeSocket({ id: 'caller', data });
            connectedMachines.splice(0, connectedMachines.length, socket);
            registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io });
            const ack = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: 'encrypted-admitted-action' }, ack);
            if (data.machineId === 'machine-1' && data.verifiedMachineInstallationId === 'retired-installation') {
                expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }));
            } else {
                expect(ack).toHaveBeenCalledWith(data.machineId === 'machine-1'
                    ? { ok: true, result: 'encrypted-page-result' }
                    : { ok: false, error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN });
            }
        }
        expect(effect).toHaveBeenCalledOnce();
        machineFindFirstMock.mockResolvedValue({ revokedAt: new Date(1), replacedByMachineId: null });
        const revoked = createFakeSocket({ id: 'revoked-caller', data: { clientType: 'machine-scoped', machineId: 'machine-1' } });
        registerSocketRpcHandlers({ userId: 'user-1', socket: revoked as unknown as Socket, io });
        const revokedAck = vi.fn();
        await triggerSocketHandler(revoked, SOCKET_RPC_EVENTS.CALL, { method, params: 'encrypted-admitted-action' }, revokedAck);
        expect(revokedAck).toHaveBeenCalledWith({ ok: false, error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(effect).toHaveBeenCalledOnce();
    });

    it('routes a versioned answering-client continuation through the existing authenticated Machine owner', async () => {
        machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null, installationId: 'installed-machine-1' });
        const method = `machine-1:${RPC_METHODS.UI_ACTION_EXECUTE}`;
        const effects: string[] = [];
        const targets = ['app-a', 'app-b'].map(id => ({ id, data: { clientType: 'user-scoped' },
            timeout: () => ({ emitWithAck: async () => { effects.push(id); return 'encrypted-result'; } }) }));
        const socket = createFakeSocket({ id: 'daemon', data: { clientType: 'machine-scoped', machineId: 'machine-1',
            verifiedMachineInstallationId: 'installed-machine-1' } });
        const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: targets,
            'app-a': [targets[0]!], 'app-b': [targets[1]!], [getMachineSocketRoom('user-1', 'machine-1')]: [socket] });
        registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io });
        const call = { method: `machine-1:answering-client.v1/${RPC_METHODS.UI_ACTION_EXECUTE}`, params: 'encrypted-action' };
        const refused = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { ...call, answeringClient: { requireSingle: true } }, refused);
        expect(refused).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'RPC_CLIENT_AMBIGUOUS' }));
        expect(effects).toEqual([]);
        const selected = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { ...call, answeringClient: { clientId: 'app-b', requireSingle: true } }, selected);
        expect(selected).toHaveBeenCalledWith(expect.objectContaining({ ok: true, result: 'encrypted-result', answeringClientId: 'app-b' }));
        expect(effects).toEqual(['app-b']);
        socket.data!.clientType = 'user-scoped';
        const forged = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { ...call, answeringClient: { clientId: 'app-b' } }, forged);
        expect(forged).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effects).toEqual(['app-b']);
    });

    it('refuses an ambiguous mounted draft instead of choosing a client by socket id', async () => {
        machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null,
            installationId: 'installed-machine-1' });
        const method = `machine-1:${workflowDraftClientRpcMethod({ scope: { serverId: 'home', accountId: 'user-1' }, draftId: 'draft' })}`;
        const effect = vi.fn(async () => 'encrypted-page-result');
        const targets = ['first-editor', 'second-editor'].map(id => ({ id, data: { clientType: 'user-scoped' },
            timeout: () => ({ emitWithAck: effect }) }));
        const socket = createFakeSocket({ id: 'caller', data: { clientType: 'machine-scoped', machineId: 'machine-1',
            verifiedMachineInstallationId: 'installed-machine-1' } });
        const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: targets,
            [getMachineSocketRoom('user-1', 'machine-1')]: [socket],
            ...Object.fromEntries(targets.map(target => [target.id, [target]])) });
        registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io });
        const ack = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: 'encrypted-admitted-action' }, ack);
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }));
        expect(effect).not.toHaveBeenCalled();
    });

    it("advertises exact UI automation methods for maximum valid browser identity strings", async () => {
        const { io, addToRoom, createRoomAwareSocket } = createRoomAwareIo();
        const uiSocket = createRoomAwareSocket({ id: 'ui-view', data: { clientType: 'user-scoped' } });
        const daemonSocket = createRoomAwareSocket({ id: 'machine-view', data: { clientType: 'machine-scoped', machineId: 'machine-1' } });
        const method = `machine-1:${uiBrowserAutomationDispatchMethod({ browserSessionId: '\u0800'.repeat(256), viewId: '\ud800'.repeat(256) })}`;
        addToRoom('user:user-1', uiSocket);
        addToRoom('machine:machine-1:user-1', daemonSocket);
        registerSocketRpcHandlers({ userId: 'user-1', socket: uiSocket as unknown as Socket, io });
        await triggerSocketHandler(uiSocket, SOCKET_RPC_EVENTS.REGISTER, { method });
        expect(daemonSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
        await triggerSocketHandler(uiSocket, SOCKET_RPC_EVENTS.UNREGISTER, { method });
        expect(daemonSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.UNREGISTERED, { method });
    });

    const authEnvironment = snapshotEnv();
    beforeAll(async () => {
        applyEnvValues({ HANDY_MASTER_SECRET: "socket-rpc-authority-test" });
        const { auth } = await import("@/app/auth/auth");
        await auth.init();
    });
    afterAll(() => restoreEnv(authEnvironment));
    function createTokenViewer(sessionId = "sess_1", approve = false, includePermission = false,
        permissionModes: ApiTokenGrantV1['permissionModes'] = null, includeAnswer = false) {
        const credentialId = "00000000-0000-4000-8000-000000000001";
        const secret = "a".repeat(43);
        const principal = {
            accountId: "user-1", principalId: "user-1", credentialId,
            authority: "account_automation" as const, expiresAt: null,
            parentTokenId: null, embedConfig: null,
            grant: {
                v: 1, actions: { families: [], ids: ["session.transcript.get", "session.message.send", ...(includePermission ? ["session.permission.respond"] : []),
                    ...(includeAnswer ? ['session.user_action.answer'] : [])] },
                targets: { sessions: [sessionId], machines: [] }, approve,
                origins: [], models: null, permissionModes, create: null,
            },
        };
        const tokenRow = {
            id: credentialId, accountId: principal.accountId,
            secretDigest: createSha256SecretDigest(secret).toString('base64url'),
            expiresAt: null, lastUsedAt: new Date(), parentTokenId: null,
            Account: { status: 'active' }, accessGrant: principal.grant,
            embedConfig: null, authenticationEvidence: null,
        };
        apiTokenFindUniqueMock.mockResolvedValue(tokenRow);
        const admission = { kind: "api-token-session-viewer", sessionId, principal };
        const socket = createFakeSocket({
            id: "token-viewer", handshake: { auth: { token: `hap_v1_${credentialId}_${secret}` } }, data: {
                clientType: "session-scoped", authAuthority: "account_automation",
                authTokenKind: "api_token", apiTokenPrincipal: principal,
                ephemeralRunnerAdmission: admission,
                sessionScopedBinding: { sessionId, machineId: null, proof: "owner-session" },
            },
        });
        return { socket, principal, tokenRow, admission: admission as unknown as NonNullable<Parameters<typeof registerSocketRpcHandlers>[0]["ephemeralRunnerAdmission"]> };
    }

    it.each([
        { rpcMethod: SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, actionId: 'session.message.send' },
        { rpcMethod: RPC_METHODS.SESSION_USER_ACTION_ANSWER, actionId: 'session.user_action.answer' },
    ])("admits a viewer's declared input RPC with exact proof but refuses another action sharing its input capability ($actionId)", async ({ rpcMethod, actionId }) => {
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null, installationId: 'installation-current', kind: 'persistent' });
        const { socket, admission, principal } = createTokenViewer('sess_1', false, false, ['read-only'], actionId === 'session.user_action.answer');
        const effect = vi.fn(async (_event: string, _request: Record<string, unknown>) => ({ success: true }));
        accessKeyFindUniqueMock.mockResolvedValue({ session: { accountId: 'user-1' }, machine: { revokedAt: null, replacedByMachineId: null } });
        const target = { id: "session-daemon", data: { clientType: "session-scoped",
            sessionPublisherAuthority: { v: 1, accountId: 'user-1', sessionId: 'sess_1', machineId: 'machine-current', committedFenceMs: 2, publisherGeneration: '1' } },
            timeout: () => ({ emitWithAck: effect }) };
        const method = `sess_1:${rpcMethod}`;
        const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target], [target.id]: [target] });
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as unknown as Socket, io, ephemeralRunnerAdmission: admission,
            sessionPublisherPresence: createSessionPublisherPresence() });
        const accepted = vi.fn();
        const opaqueParams = 'session-ciphertext';
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: opaqueParams,
            callerInputAuthorization: { token: 'caller-forged' }, callerInputConstraints: { models: [], permissionModes: [] } }, accepted);
        expect(accepted).toHaveBeenCalledWith({ ok: true, result: { success: true } });
        const forwarded = effect.mock.calls[0]![1];
        expect(forwarded).toHaveProperty('callerInputAuthorization');
        const issued = ExternalActionExecutionAuthorizationV1Schema.parse(forwarded.callerInputAuthorization);
        expect(await auth.verifyExternalActionExecutionAuthorization(issued.token)).toEqual(issued.binding);
        expect(issued.binding).toMatchObject({ actionId, machineId: 'machine-current',
            credentialId: principal.credentialId, target: { kind: 'session', sessionId: 'sess_1' } });
        expect(issued.binding.requestId).toBe(forwarded.requestId);
        expect(issued.binding).toMatchObject({ grant: { permissionModes: ['read-only'] } });
        expect(forwarded.callerInputConstraints).toEqual({ models: null, permissionModes: ['read-only'] });
        expect(issued.binding.requestEnvelopeDigest).toBe(computeExternalActionSocketRpcRequestDigestV1({
            method, params: opaqueParams, requestId: issued.binding.requestId, target: { kind: 'session', sessionId: 'sess_1' },
        }));
        const denied = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method: `sess_1:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`, params: {} }, denied);
        expect(denied).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effect).toHaveBeenCalledOnce();
    });

    it('refuses a captured wider viewer grant when the real issuer observes in-flight narrowing', async () => {
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        accessKeyFindUniqueMock.mockResolvedValue({ session: { accountId: 'user-1' }, machine: { revokedAt: null, replacedByMachineId: null } });
        const { socket, admission, principal, tokenRow } = createTokenViewer();
        machineFindFirstMock.mockImplementation(async (args?: unknown) => {
            const select = args && typeof args === 'object' && 'select' in args
                ? args.select : null;
            if (select && typeof select === 'object' && 'installationId' in select
                && select.installationId === true) {
                // The persistent DB narrows the credential after ingress, while
                // the issuer resolves current Machine custody before minting.
                apiTokenFindUniqueMock.mockResolvedValue({ ...tokenRow,
                    accessGrant: { ...principal.grant, permissionModes: ['read-only'] } });
            }
            return { revokedAt: null, replacedByMachineId: null,
                installationId: 'installation-current', kind: 'persistent' };
        });
        const effect = vi.fn(async () => ({ success: true }));
        const target = { id: 'session-daemon', data: { clientType: 'session-scoped',
            sessionPublisherAuthority: { v: 1, accountId: 'user-1', sessionId: 'sess_1', machineId: 'machine-current', committedFenceMs: 2, publisherGeneration: '1' } },
            timeout: () => ({ emitWithAck: effect }) };
        const method = `sess_1:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`;
        const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target], [target.id]: [target] });
        registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io,
            ephemeralRunnerAdmission: admission, sessionPublisherPresence: createSessionPublisherPresence() });
        const refused = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: 'session-ciphertext' }, refused);
        expect(refused).toHaveBeenCalledWith({ ok: false, error: 'credential_scope_denied' });
        expect(effect).not.toHaveBeenCalled();
    });

    it("refuses token viewer registration and permission decisions without approve", async () => {
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        const { socket, admission } = createTokenViewer('sess_1', false, true);
        const { io } = createTargetRoutingIo({});
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as unknown as Socket, io, ephemeralRunnerAdmission: admission });
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: "sess_1:permission" });
expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({ type: "register", error: "Forbidden" }));
        const denied = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method: "sess_1:permission", params: {} }, denied);
        expect(denied).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
    });

    it("forwards a model-only viewer Action through target revalidation without enabling Send", async () => {
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        accessKeyFindUniqueMock.mockResolvedValue({ session: { accountId: 'user-1' }, machine: { revokedAt: null, replacedByMachineId: null } });
        const { socket, admission, principal } = createTokenViewer();
        principal.grant.actions.ids = ["session.transcript.get", "session.model.set"];
        const result = { status: "applied" };
        const effect = vi.fn(async () => result);
        const target = { id: "current-session-daemon", data: { clientType: "session-scoped",
            sessionPublisherAuthority: { v: 1, accountId: "user-1", sessionId: "sess_1",
                machineId: "machine-1", committedFenceMs: 2, publisherGeneration: '1' } }, timeout: () => ({ emitWithAck: effect }) };
        const method = `sess_1:${SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION}`;
        const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target], [target.id]: [target] });
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as unknown as Socket, io,
            ephemeralRunnerAdmission: admission, sessionPublisherPresence: createSessionPublisherPresence() });
        const accepted = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: "sealed-model-input" }, accepted);
        expect(accepted).toHaveBeenCalledWith({ ok: true, result });
        const denied = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method: `sess_1:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`, params: "sealed-message",
        }, denied);
        expect(denied).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effect).toHaveBeenCalledOnce();
    });

    it("preserves ordinary Machine transfers for shared readers without Send", async () => {
        sessionFindUniqueMock.mockResolvedValue({ ...createOwnedSessionAccessRow(), accountId: "other-owner",
            shares: [{ id: "share", sharedWithUserId: "user-1", accessLevel: "view", canApprovePermissions: false }] });
        const socket = createFakeSocket({ data: { clientType: "user-scoped" } });
        const method = `machine-1:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT}`;
        const result = { success: true, uploadId: "upload" };
        const effect = vi.fn(async () => result);
        const target = { id: "machine-daemon", data: { clientType: "machine-scoped", machineId: "machine-1" },
            timeout: () => ({ emitWithAck: effect }) };
        const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target], [target.id]: [target] });
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as unknown as Socket, io });
        const ack = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method,
            params: { t: "session_file_upload_v1", path: "/workspace/notes.txt", sizeBytes: 0 } }, ack);
        expect(ack).toHaveBeenCalledWith({ ok: true, result });
    });

    describe("optional SCM Session proof", () => {
        function createScmSessionProofFixture(rpcMethod: string = RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ) {
            const method = `machine-1:${rpcMethod}`;
            const effect = vi.fn(async (_event: string, _request: Record<string, unknown>) => "sealed-result");
            const ownerEffect = vi.fn(async () => "wrong-owner-result");
            const target = { id: "scm-machine", data: { clientType: "machine-scoped", machineId: "machine-1" },
                timeout: () => ({ emitWithAck: effect }) };
            const ownerTarget = { id: "session-owner-machine", data: { clientType: "machine-scoped", machineId: "machine-1" },
                timeout: () => ({ emitWithAck: ownerEffect }) };
            const { io, fetchSockets } = createTargetRoutingIo({
                [`rpc:user-1:${method}`]: [target], [`rpc:session-owner:${method}`]: [ownerTarget],
                [target.id]: [target], [ownerTarget.id]: [ownerTarget],
            });
            const socket = createFakeSocket({ id: "scm-caller", data: { clientType: "user-scoped" } });
            registerSocketRpcHandlers({ userId: "user-1", socket: socket as unknown as Socket, io });
            return { method, socket, effect, ownerEffect, fetchSockets };
        }

        it.each([RPC_METHODS.SCM_CHANGE_DISCARD, RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ, RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE])(
            "keeps workspace %s without proof and never promotes its input sessionId", async (rpcMethod) => {
                sessionFindUniqueMock.mockResolvedValue(null);
                const { method, socket, effect } = createScmSessionProofFixture(rpcMethod);
                const ack = vi.fn();
                await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
                    method, params: { cwd: "/workspace", sessionId: "private-session", resultId: "result-1" },
                }, ack);
                expect(ack).toHaveBeenCalledWith({ ok: true, result: "sealed-result" });
                expect(effect.mock.calls[0]![1].authorization).toBeUndefined();
                expect(sessionFindUniqueMock).not.toHaveBeenCalled();
            });

        it("stamps separately authorized Session access without changing Machine routing", async () => {
            sessionShareFindUniqueMock.mockResolvedValue({ id: "share-1", sharedWithUserId: "user-1",
                accessLevel: "view", canApprovePermissions: false });
            const { method, socket, effect, ownerEffect, fetchSockets } = createScmSessionProofFixture();
            const ack = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
                method, params: "sealed-scm-input", authorization: { kind: "session.write", sessionId: "private-session" },
            }, ack);
            expect(ack).toHaveBeenCalledWith({ ok: true, result: "sealed-result" });
            expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
                params: "sealed-scm-input", authorization: { kind: "session.write", sessionId: "private-session" },
            }));
            expect(fetchSockets).toHaveBeenCalledWith(`rpc:user-1:${method}`);
            expect(ownerEffect).not.toHaveBeenCalled();
        });

        it.each([null, {}, { kind: "session.write", sessionId: "" },
            { kind: "session.write", sessionId: "private-session", extra: true },
            { kind: "session.permission.respond", sessionId: "private-session" },
        ])("refuses malformed or inappropriate supplied proof %j", async (authorization) => {
            const { method, socket, effect, fetchSockets } = createScmSessionProofFixture();
            const ack = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: "sealed-scm-input", authorization }, ack);
            expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
            expect(effect).not.toHaveBeenCalled();
            expect(fetchSockets).not.toHaveBeenCalled();
        });

        it("refuses proof for a Session unavailable to the actual caller", async () => {
            sessionShareFindUniqueMock.mockResolvedValue(null);
            const { method, socket, effect } = createScmSessionProofFixture();
            const ack = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
                method, params: "sealed-scm-input", authorization: { kind: "session.write", sessionId: "private-session" },
            }, ack);
            expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
            expect(effect).not.toHaveBeenCalled();
        });

        it.each([RPC_METHODS.SCM_CHANGE_DISCARD, RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE, RPC_METHODS.SCM_DIFF_SUMMARY_REFINE,
            RPC_METHODS.SCM_DIFF_SUMMARY_DISCUSS, RPC_METHODS.SCM_DIFF_SUMMARY_ADD_OUTPUTS,
        ])("requires Session input authority for %s", async (rpcMethod) => {
            sessionShareFindUniqueMock.mockResolvedValue({ id: "share-1", sharedWithUserId: "user-1",
                accessLevel: "view", canApprovePermissions: false });
            const { method, socket, effect } = createScmSessionProofFixture(rpcMethod);
            const request = { method, params: "sealed-scm-input", authorization: { kind: "session.write", sessionId: "private-session" } };
            const denied = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, request, denied);
            expect(denied).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
            expect(effect).not.toHaveBeenCalled();
            sessionShareFindUniqueMock.mockResolvedValue({ id: "share-1", sharedWithUserId: "user-1",
                accessLevel: "edit", canApprovePermissions: false });
            const accepted = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, request, accepted);
            expect(accepted).toHaveBeenCalledWith({ ok: true, result: "sealed-result" });
        });

        it("revalidates optional Session proof before dispatch", async () => {
            const permitted = { ...createOwnedSessionAccessRow("private-session"), accountId: "session-owner",
                shares: [{ id: "share-1", sharedWithUserId: "user-1", accessLevel: "view", canApprovePermissions: false }] };
            sessionFindUniqueMock.mockResolvedValueOnce(permitted).mockResolvedValue({ ...permitted, shares: [] });
            const { method, socket, effect } = createScmSessionProofFixture();
            const ack = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
                method, params: "sealed-scm-input", authorization: { kind: "session.write", sessionId: "private-session" },
            }, ack);
            expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }));
            expect(effect).not.toHaveBeenCalled();
        });

        it.each([RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE, RPC_METHODS.SCM_CHANGE_DISCARD])("does not let valid Session proof bypass Machine availability: %s", async (rpcMethod) => {
            sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow("private-session"));
            machineFindFirstMock.mockResolvedValue({ revokedAt: new Date(1), replacedByMachineId: null });
            const { method, socket, effect } = createScmSessionProofFixture(rpcMethod);
            const ack = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
                method, params: "sealed-scm-input", authorization: { kind: "session.write", sessionId: "private-session" },
            }, ack);
            expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'target_unavailable' }));
            expect(effect).not.toHaveBeenCalled();
        });
    });

    it("refuses detached execution-run decisions under automation authority and forwards present-user decisions", async () => {
        const method = `machine-1:${RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND}`;
        const effect = vi.fn(async () => ({ ok: true }));
        const target = { id: "machine-daemon", data: { clientType: "machine-scoped", machineId: "machine-1" },
            timeout: () => ({ emitWithAck: effect }) };
        const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target], [target.id]: [target] });
        for (const authority of ["account_automation", "present_user"] as const) {
            const socket = createFakeSocket({ id: `terminal-${authority}`,
                data: { clientType: "user-scoped", authTokenKind: "terminal", authAuthority: authority } });
            registerSocketRpcHandlers({ userId: "user-1", socket: socket as unknown as Socket, io });
            const ack = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
                method, params: { runId: "run", requestId: "request", approved: true },
                callerAuthority: "present_user",
            }, ack);
            expect(ack).toHaveBeenCalledWith(authority === "present_user"
                ? { ok: true, result: { ok: true } }
                : expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        }
        expect(effect).toHaveBeenCalledOnce();
    });

    it("refuses the retired machine attachment carrier for token viewers", async () => {
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        const { socket, admission } = createTokenViewer();
        const method = `machine-1:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT}`;
        const effect = vi.fn(async () => ({ success: true, uploadId: "upload" }));
        const target = { id: "machine-daemon", data: { clientType: "machine-scoped", machineId: "machine-1" },
            timeout: () => ({ emitWithAck: effect }) };
        const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target], [target.id]: [target] });
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as unknown as Socket, io, ephemeralRunnerAdmission: admission });
        const ack = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: {
            t: "session_attachment_upload_v1", sessionId: "sess_1", fileName: "notes.txt",
            sizeBytes: 0, messageLocalId: "message-a",
        } }, ack);
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effect).not.toHaveBeenCalled();
    });

    it('admits an explicitly approving token and refuses it after revocation despite a retained socket', async () => {
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        const { socket, admission } = createTokenViewer('sess_1', true, true);
        const effect = vi.fn(async () => ({ success: true }));
        const target = { id: 'session-daemon', data: { clientType: 'session-scoped' }, timeout: () => ({ emitWithAck: effect }) };
        const method = 'sess_1:permission';
        const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target], [target.id]: [target] });
        registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io, ephemeralRunnerAdmission: admission });
        const accepted = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: {} }, accepted);
        expect(accepted).toHaveBeenCalledWith({ ok: true, result: { success: true } });
        apiTokenFindUniqueMock.mockResolvedValue(null);
        const refused = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: {} }, refused);
        expect(refused).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effect).toHaveBeenCalledOnce();
    });

    it("admits only the exact encrypted attachment header on every phase and replaces caller constraints", async () => {
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        const { socket, admission } = createTokenViewer();
        const effect = vi.fn(async () => 'sealed-transfer-response');
        const target = { id: 'session-daemon', data: { clientType: 'session-scoped' }, timeout: () => ({ emitWithAck: effect }) };
        const methods = [RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
            RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT];
        const { io } = createTargetRoutingIo(Object.fromEntries([
            ...methods.map(method => [`rpc:user-1:sess_1:${method}`, [target]]), [target.id, [target]],
        ]));
        registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io, ephemeralRunnerAdmission: admission });
        for (const method of methods) {
            const accepted = vi.fn();
            const transferRouting = { method, t: 'session_attachment_upload_v1', sessionId: 'sess_1' };
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method: `sess_1:${method}`, params: 'sealed-private-input',
                transferRouting, callerInputConstraints: { models: [], permissionModes: [] } }, accepted);
            expect(accepted).toHaveBeenCalledWith({ ok: true, result: 'sealed-transfer-response' });
            expect(effect).toHaveBeenLastCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
                params: 'sealed-private-input', transferRouting, callerAuthority: 'account_automation',
                callerInputConstraints: { models: null, permissionModes: null },
            }));
        }
        const plainAccepted = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method: `sess_1:${methods[0]}`,
            params: { t: 'session_attachment_upload_v1', sessionId: 'sess_1', fileName: 'notes.txt', sizeBytes: 0, messageLocalId: 'message-a' },
            transferRouting: { method: methods[0], t: 'session_attachment_upload_v1', sessionId: 'sess_1' },
        }, plainAccepted);
        expect(plainAccepted).toHaveBeenCalledWith({ ok: true, result: 'sealed-transfer-response' });
        for (const extra of [undefined, { method: methods[0], t: 'session_file_download_v1', sessionId: 'sess_1' },
            { method: methods[0], t: 'session_attachment_upload_v1', sessionId: 'other-session' }]) {
            const refused = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
                method: `sess_1:${methods[0]}`, params: 'sealed-private-input', ...(extra ? { transferRouting: extra } : {}),
            }, refused);
            expect(refused).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        }
        expect(effect).toHaveBeenCalledTimes(methods.length + 1);
    });

    it("refuses an ordinary shared reader's abort and an automation caller's permission decision", async () => {
        const method = "sess_1:abort";
        const effect = vi.fn(async () => ({ success: true }));
        const target = { id: "session-daemon", data: { clientType: "session-scoped" }, timeout: () => ({ emitWithAck: effect }) };
        const permissionMethod = "sess_1:permission";
        const { io } = createTargetRoutingIo({
            [`rpc:session-owner:${method}`]: [target], [`rpc:user-1:${method}`]: [target],
            [`rpc:session-owner:${permissionMethod}`]: [target], [target.id]: [target],
        });
        sessionShareFindUniqueMock.mockResolvedValue({ sharedWithUserId: "user-1", accessLevel: "view", canApprovePermissions: true });
        const socket = createFakeSocket({ data: { clientType: "user-scoped", authAuthority: "account_automation" } });
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as unknown as Socket, io });
        for (const deniedMethod of [method, permissionMethod]) {
            const denied = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method: deniedMethod, params: {} }, denied);
            expect(denied).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        }
        expect(effect).not.toHaveBeenCalled();
    });

    beforeEach(() => {
        machineFindFirstMock.mockReset();
        machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null });
        accessKeyFindUniqueMock.mockReset();
        accessKeyFindUniqueMock.mockResolvedValue({
            machineId: "machine-1",
            machine: {
                revokedAt: null,
                replacedByMachineId: null,
            },
        });
        ephemeralRunnerActivationFindFirstMock.mockReset();
        apiTokenFindUniqueMock.mockReset();
        ephemeralRunnerActivationFindFirstMock.mockResolvedValue({ id: "activation-1" });
        accountFindUniqueMock.mockReset();
        accountFindUniqueMock.mockResolvedValue({ status: "active", tokenEpoch: 3 });
        sessionFindUniqueMock.mockReset();
        sessionFindUniqueMock.mockImplementation(async (args?: { where?: { id?: string } }) => {
            const share = await sessionShareFindUniqueMock();
            return {
                id: args?.where?.id ?? "session-1",
                accountId: "session-owner",
                primaryTeamId: null,
                account: { status: "active" },
                currentStorageState: "hosted",
                seq: 0,
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                shares: share ? [share] : [],
                teamGrants: [],
                groupGrants: [],
            };
        });
        sessionFindFirstMock.mockReset();
        sessionFindFirstMock.mockResolvedValue({ id: "session-1" });
        sessionShareFindUniqueMock.mockReset();
        sessionShareFindUniqueMock.mockResolvedValue({
            id: "share-1",
            sharedWithUserId: "user-1",
            accessLevel: "edit",
            canApprovePermissions: false,
        });
        authorizeSessionFollowSourceKeyPreparationMock.mockReset();
        authorizeSessionFollowSourceKeyPreparerMock.mockReset();
        authorizeSessionFollowSourceKeyPreparerMock.mockResolvedValue({
            ok: true,
            value: { destinationRuntimeAccountId: "destination-owner" },
        });
        Object.values(rpcMetricsMocks).forEach((mock) => mock.mockReset());
    });

    it("rejects malformed external Action execution metadata before forwarding the RPC", async () => {
        const method = `machine-1:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`;
        const { io, fetchSockets } = createTargetRoutingIo({});
        const socket = createFakeSocket({ id: "caller-socket" });
        const callback = vi.fn();
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as any, io });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: { contributionId: "board" },
            externalActionExecution: { v: 1 },
        }, callback);

        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: "Forbidden" }));
        expect(fetchSockets).not.toHaveBeenCalled();
    });

    it("forwards source-key preparation only to the exact admitted Runner Machine", async () => {
        const principal = {
            kind: "ephemeral_session_runner" as const,
            authority: "session_runtime" as const,
            accountId: "destination-owner",
            activationId: "00000000-0000-4000-8000-000000000013",
            sessionId: "destination",
            machineId: "runner-machine",
            installationId: "runner-installation",
            installationPublicKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
            creatorTokenEpoch: 1,
        };
        authorizeSessionFollowSourceKeyPreparationMock.mockResolvedValue({
            ok: true,
            value: {
                destinationRuntimeAccountId: "destination-owner",
                sourceSessionId: "source",
                destinationSessionId: "destination",
                machineId: "runner-machine",
            },
        });
        const method = `runner-machine:${RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE}`;
        // Ordinary encrypted Machine RPC acknowledges the ciphertext directly;
        // the Home adds the caller-facing success envelope.
        const emitWithAck = vi.fn().mockResolvedValue("opaque-encrypted-result");
        const target = {
            id: "runner-socket",
            data: {
                clientType: "machine-scoped",
                machineId: "runner-machine",
                ephemeralRunnerAdmission: { kind: "machine-runtime", principal },
            },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const { io } = createTargetRoutingIo({
            [`rpc:destination-owner:${method}`]: [target],
            "runner-socket": [target],
        });
        const socket = createFakeSocket({ id: "caller-socket" });
        const callback = vi.fn();
        const authorization = {
            kind: "session.follow.sourceKey.prepare",
            sourceSessionId: "source",
            destinationSessionId: "destination",
        };
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as any, io });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque-encrypted-request",
            authorization,
        }, callback);

        expect(authorizeSessionFollowSourceKeyPreparationMock).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "user-1",
            principal,
            sourceSessionId: "source",
            destinationSessionId: "destination",
        }));
        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            method,
            params: "opaque-encrypted-request",
            authorization,
        }));
        expect(callback).toHaveBeenCalledWith({ ok: true, result: "opaque-encrypted-result" });
    });

    it("does not forward source-key preparation to a Machine socket without its verified Runner principal", async () => {
        authorizeSessionFollowSourceKeyPreparerMock.mockResolvedValue({
            ok: true,
            value: { destinationRuntimeAccountId: "user-1" },
        });
        authorizeSessionFollowSourceKeyPreparationMock.mockResolvedValue({
            ok: true,
            value: {
                destinationRuntimeAccountId: "user-1",
                sourceSessionId: "source",
                destinationSessionId: "destination",
                machineId: "runner-machine",
            },
        });
        const method = `runner-machine:${RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE}`;
        const emitWithAck = vi.fn().mockResolvedValue("opaque-encrypted-result");
        const target = {
            id: "unproven-runner-socket",
            data: { clientType: "machine-scoped", machineId: "runner-machine" },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const { io } = createTargetRoutingIo({
            [`rpc:user-1:${method}`]: [target],
            "unproven-runner-socket": [target],
        });
        const socket = createFakeSocket({ id: "caller-socket" });
        const callback = vi.fn();
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as any, io });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque",
            authorization: {
                kind: "session.follow.sourceKey.prepare",
                sourceSessionId: "source",
                destinationSessionId: "destination",
            },
        }, callback);

        expect(emitWithAck).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    });

    it("rejects malformed or denied source-key preparation before forwarding", async () => {
        authorizeSessionFollowSourceKeyPreparationMock.mockResolvedValue({ ok: false, error: "session_follow_source_forbidden" });
        const method = `runner-machine:${RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE}`;
        const { io, fetchSockets } = createTargetRoutingIo({});
        const socket = createFakeSocket({ id: "caller-socket" });
        const callback = vi.fn();
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as any, io });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque",
            authorization: { kind: "session.follow.sourceKey.prepare", sourceSessionId: "source", destinationSessionId: "source" },
        }, callback);
        expect(authorizeSessionFollowSourceKeyPreparationMock).not.toHaveBeenCalled();
        expect(fetchSockets).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
    });

    it("joins and leaves the canonical RPC room on register and unregister", async () => {
        const socket = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: "agent.run" });
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.UNREGISTER, { method: "agent.run" });

        expect((socket as any).join).toHaveBeenCalledWith("rpc:user-1:agent.run");
        expect((socket as any).leave).toHaveBeenCalledWith("rpc:user-1:agent.run");
        expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method: "agent.run" });
        expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.UNREGISTERED, { method: "agent.run" });
        expect(rpcMetricsMocks.recordRpcRegistration).toHaveBeenCalledWith("agent.run");
        expect(rpcMetricsMocks.recordRpcUnregistration).toHaveBeenCalledWith("agent.run");
    });

    it("registers only the exact classified Runner Machine services", async () => {
        const join = vi.fn().mockResolvedValue(undefined);
        const socket = createFakeSocket({
            id: "runner-machine-socket",
            data: { clientType: "machine-scoped", machineId: "runner-machine" },
            join,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const principal = {
            kind: "ephemeral_session_runner" as const,
            authority: "session_runtime" as const,
            accountId: "user-1",
            activationId: "10000000-0000-4000-8000-000000000013",
            sessionId: "runner-session",
            machineId: "runner-machine",
            installationId: "runner-installation",
            installationPublicKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
            creatorTokenEpoch: 3,
        };
        const admission = { kind: "machine-runtime" as const, principal };
        machineFindFirstMock.mockResolvedValue({
            revokedAt: null,
            replacedByMachineId: null,
            kind: "ephemeral_session_runner",
            installationPublicKey: decodeBase64(principal.installationPublicKey, "base64url"),
        });
        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io: {} as Server,
            ephemeralRunnerAdmission: admission,
        });

        const allowed = `runner-machine:${RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE}`;
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: allowed });
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, {
            method: `runner-machine:${RPC_METHODS.READ_FILE}`,
        });
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, {
            method: `runner-machine:${RPC_METHODS.STOP_SESSION}`,
        });
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, {
            method: `runner-machine:${RPC_METHODS.DAEMON_TERMINAL_ENSURE}`,
        });
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, {
            method: `other-machine:${RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE}`,
        });
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, {
            method: `runner-machine:${RPC_METHODS.STOP_DAEMON}`,
        });

        expect(join).toHaveBeenCalledTimes(4);
        expect(join).toHaveBeenCalledWith(`rpc:user-1:${allowed}`);
        expect(join).toHaveBeenCalledWith(`rpc:user-1:runner-machine:${RPC_METHODS.READ_FILE}`);
        expect(join).toHaveBeenCalledWith(`rpc:user-1:runner-machine:${RPC_METHODS.STOP_SESSION}`);
        expect(join).toHaveBeenCalledWith(`rpc:user-1:runner-machine:${RPC_METHODS.DAEMON_TERMINAL_ENSURE}`);
expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
            type: "register",
            error: "Forbidden",
        }));
    });

    it("does not admit a Runner Machine into an RPC room after its materialized principal becomes stale", async () => {
        const join = vi.fn().mockResolvedValue(undefined);
        const socket = createFakeSocket({
            id: "runner-machine-socket",
            data: { clientType: "machine-scoped", machineId: "runner-machine" },
            join,
        } as any);
        const principal = {
            kind: "ephemeral_session_runner" as const,
            authority: "session_runtime" as const,
            accountId: "user-1",
            activationId: "10000000-0000-4000-8000-000000000013",
            sessionId: "runner-session",
            machineId: "runner-machine",
            installationId: "runner-installation",
            installationPublicKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
            creatorTokenEpoch: 3,
        };
        const admission = { kind: "machine-runtime" as const, principal };
        ephemeralRunnerActivationFindFirstMock.mockResolvedValue(null);
        registerSocketRpcHandlers({
            userId: principal.accountId,
            socket: socket as any,
            io: {} as Server,
            ephemeralRunnerAdmission: admission,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, {
            method: `${principal.machineId}:${RPC_METHODS.READ_FILE}`,
        });

        expect(join).not.toHaveBeenCalled();
expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
            type: "register",
            error: "Forbidden",
        }));
    });

    it.each([
        RPC_METHODS.STOP_DAEMON,
        RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE,
    ])("rejects Runner-originated Machine RPC calls before they reach an ordinary Machine: %s", async (rpcMethod) => {
        const principal = {
            kind: "ephemeral_session_runner" as const,
            authority: "session_runtime" as const,
            accountId: "user-1",
            activationId: "10000000-0000-4000-8000-000000000013",
            sessionId: "runner-session",
            machineId: "runner-machine",
            installationId: "runner-installation",
            installationPublicKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
            creatorTokenEpoch: 3,
        };
        const admission = { kind: "machine-runtime" as const, principal };
        const method = `ordinary-machine:${rpcMethod}`;
        const emitWithAck = vi.fn().mockResolvedValue({ secret: "must-not-reach-runner" });
        const target = {
            id: "ordinary-machine-socket",
            data: { clientType: "machine-scoped", machineId: "ordinary-machine" },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const { io } = createTargetRoutingIo({
            [`rpc:user-1:${method}`]: [target],
            [target.id]: [target],
        });
        const socket = createFakeSocket({
            id: "runner-machine-socket",
            data: {
                clientType: "machine-scoped",
                machineId: principal.machineId,
                ephemeralRunnerAdmission: admission,
            },
        });
        const callback = vi.fn();
        registerSocketRpcHandlers({
            userId: principal.accountId,
            socket: socket as any,
            io,
            ephemeralRunnerAdmission: admission,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: { request: "untrusted-runner-call" },
        }, callback);

        expect(emitWithAck).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        });
    });

    it("does not forward a Runner file RPC after its materialized principal is no longer current", async () => {
        const principal = {
            kind: "ephemeral_session_runner" as const,
            authority: "session_runtime" as const,
            accountId: "user-1",
            activationId: "10000000-0000-4000-8000-000000000013",
            sessionId: "session-1",
            machineId: "machine-1",
            installationId: "runner-installation",
            installationPublicKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
            creatorTokenEpoch: 3,
        };
        ephemeralRunnerActivationFindFirstMock.mockResolvedValue(null);
        const method = `machine-1:${RPC_METHODS.READ_FILE}`;
        const emitWithAck = vi.fn().mockResolvedValue({ success: true, content: "secret" });
        const target = {
            id: "runner-machine-socket",
            data: {
                clientType: "machine-scoped",
                machineId: principal.machineId,
                ephemeralRunnerAdmission: { kind: "machine-runtime", principal },
            },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const { io } = createTargetRoutingIo({
            [`rpc:user-1:${method}`]: [target],
            [target.id]: [target],
        });
        const socket = createFakeSocket({ id: "caller-socket" });
        const callback = vi.fn();
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as any, io });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: { path: "/workspace/secret.txt" },
        }, callback);

        expect(emitWithAck).not.toHaveBeenCalled();
        expect(ephemeralRunnerActivationFindFirstMock).toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    });

    it("does not let an ordinary Account socket claim an ephemeral Runner Machine file receiver", async () => {
        machineFindFirstMock.mockResolvedValue({
            revokedAt: null,
            replacedByMachineId: null,
            kind: "ephemeral_session_runner",
        });
        const method = `machine-1:${RPC_METHODS.READ_FILE}`;
        const emitWithAck = vi.fn().mockResolvedValue({ success: true, content: "secret" });
        const target = {
            id: "impostor-machine-socket",
            data: { clientType: "machine-scoped", machineId: "machine-1" },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const { io } = createTargetRoutingIo({
            [`rpc:user-1:${method}`]: [target],
            [target.id]: [target],
        });
        const socket = createFakeSocket({ id: "caller-socket" });
        const callback = vi.fn();
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as any, io });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: { path: "/workspace/secret.txt" },
        }, callback);

        expect(emitWithAck).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    });

    it("forwards an exact Runner file RPC only while its principal and Session capability are current", async () => {
        const principal = {
            kind: "ephemeral_session_runner" as const,
            authority: "session_runtime" as const,
            accountId: "user-1",
            activationId: "10000000-0000-4000-8000-000000000013",
            sessionId: "session-1",
            machineId: "machine-1",
            installationId: "runner-installation",
            installationPublicKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
            creatorTokenEpoch: 3,
        };
        ephemeralRunnerActivationFindFirstMock.mockResolvedValue({
            id: principal.activationId,
            creatorAccountId: principal.accountId,
            sessionId: principal.sessionId,
        });
        machineFindFirstMock.mockResolvedValue({
            revokedAt: null,
            replacedByMachineId: null,
            installationPublicKey: decodeBase64(principal.installationPublicKey, "base64url"),
        });
        accessKeyFindUniqueMock.mockResolvedValue({ accountId: principal.accountId });
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow(principal.sessionId));
        const method = `${principal.machineId}:${RPC_METHODS.READ_FILE}`;
        const emitWithAck = vi.fn().mockResolvedValue("opaque-encrypted-file-result");
        const target = {
            id: "runner-machine-socket",
            data: {
                clientType: "machine-scoped",
                machineId: principal.machineId,
                ephemeralRunnerAdmission: { kind: "machine-runtime", principal },
            },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const { io } = createTargetRoutingIo({
            [`rpc:user-1:${method}`]: [target],
            [target.id]: [target],
        });
        const socket = createFakeSocket({ id: "caller-socket" });
        const callback = vi.fn();
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as any, io });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque-encrypted-file-request",
        }, callback);

        expect(accountFindUniqueMock).toHaveBeenCalled();
        expect(ephemeralRunnerActivationFindFirstMock).toHaveBeenCalled();
        expect(sessionFindFirstMock).toHaveBeenCalled();
        expect(machineFindFirstMock).toHaveBeenCalled();
        expect(accessKeyFindUniqueMock).toHaveBeenCalled();
        expect(sessionFindUniqueMock).toHaveBeenCalled();
        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            method,
            params: "opaque-encrypted-file-request",
            authorization: { kind: "session.write", sessionId: principal.sessionId },
        }));
        expect(callback).toHaveBeenCalledWith({ ok: true, result: "opaque-encrypted-file-result" });
    });

    it("routes a collaborator Runner file RPC to the owner Machine and stamps its exact Session authorization", async () => {
        const principal = {
            kind: "ephemeral_session_runner" as const,
            authority: "session_runtime" as const,
            accountId: "session-owner",
            activationId: "10000000-0000-4000-8000-000000000013",
            sessionId: "session-1",
            machineId: "machine-1",
            installationId: "runner-installation",
            installationPublicKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
            creatorTokenEpoch: 3,
        };
        ephemeralRunnerActivationFindFirstMock.mockResolvedValue({
            id: principal.activationId,
            creatorAccountId: principal.accountId,
            sessionId: principal.sessionId,
        });
        machineFindFirstMock.mockResolvedValue({
            revokedAt: null,
            replacedByMachineId: null,
            installationPublicKey: decodeBase64(principal.installationPublicKey, "base64url"),
        });
        accessKeyFindUniqueMock.mockResolvedValue({ accountId: principal.accountId });
        sessionFindUniqueMock.mockResolvedValue({
            ...createOwnedSessionAccessRow(principal.sessionId),
            accountId: principal.accountId,
            shares: [{
                id: "share-1",
                sharedWithUserId: "collaborator",
                accessLevel: "edit",
                canApprovePermissions: false,
            }],
        });
        const method = `${principal.machineId}:${RPC_METHODS.READ_FILE}`;
        const emitWithAck = vi.fn().mockResolvedValue("opaque-encrypted-file-result");
        const target = {
            id: "runner-machine-socket",
            data: {
                clientType: "machine-scoped",
                machineId: principal.machineId,
                ephemeralRunnerAdmission: { kind: "machine-runtime", principal },
            },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const { io, fetchSockets } = createTargetRoutingIo({
            [`rpc:${principal.accountId}:${method}`]: [target],
            [target.id]: [target],
        });
        const socket = createFakeSocket({ id: "collaborator-socket" });
        const callback = vi.fn();
        registerSocketRpcHandlers({ userId: "collaborator", socket: socket as any, io });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque-encrypted-file-request",
        }, callback);

        expect(fetchSockets).toHaveBeenCalledWith(`rpc:${principal.accountId}:${method}`);
        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            method,
            params: "opaque-encrypted-file-request",
            authorization: { kind: "session.write", sessionId: principal.sessionId },
        }));
        expect(callback).toHaveBeenCalledWith({ ok: true, result: "opaque-encrypted-file-result" });

    });

    it("reserves the Automation reply-handoff method for an exact machine daemon and rejects client calls", async () => {
        const method = `machine-1:${AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1}`;
        const userJoin = vi.fn().mockResolvedValue(undefined);
        const userSocket = createFakeSocket({
            id: "user-socket",
            data: { clientType: "user-scoped" },
            join: userJoin,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: userSocket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(userSocket, SOCKET_RPC_EVENTS.REGISTER, { method });
        const callback = vi.fn();
        await triggerSocketHandler(userSocket, SOCKET_RPC_EVENTS.CALL, { method, params: {} }, callback);

        expect(userJoin).not.toHaveBeenCalled();
        expect(userSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
            type: "register",
            error: "Forbidden",
        }));
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        });

        const machineJoin = vi.fn().mockResolvedValue(undefined);
        machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null, installationId: 'installation-1', kind: 'persistent' });
        const machineSocket = createFakeSocket({
            id: "machine-socket",
            data: { clientType: "machine-scoped", machineId: "machine-1" },
            join: machineJoin,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        registerSocketRpcHandlers({
            userId: "user-1",
            socket: machineSocket as any,
            io: {} as Server,
        });
        await triggerSocketHandler(machineSocket, SOCKET_RPC_EVENTS.REGISTER, { method });
        expect(machineJoin).toHaveBeenCalledWith(`rpc:user-1:${method}`);
    });

    it.each([
        EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
        RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS,
    ])("reserves server-origin method %s for an exact machine daemon and rejects client calls", async (rpcMethod) => {
        const method = `machine-1:${rpcMethod}`;
        const userJoin = vi.fn().mockResolvedValue(undefined);
        const userSocket = createFakeSocket({
            id: "user-socket",
            data: { clientType: "user-scoped" },
            join: userJoin,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: userSocket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(userSocket, SOCKET_RPC_EVENTS.REGISTER, { method });
        const callback = vi.fn();
        const callParams = rpcMethod === RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS
            ? { v: 1, subjectAccountId: 'another-account' } : {};
        await triggerSocketHandler(userSocket, SOCKET_RPC_EVENTS.CALL, { method, params: callParams }, callback);

        expect(userJoin).not.toHaveBeenCalled();
expect(userSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
            type: "register",
            error: "Forbidden",
        }));
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        });

        const bareMethodCallback = vi.fn();
        await triggerSocketHandler(userSocket, SOCKET_RPC_EVENTS.CALL, { method: rpcMethod, params: callParams }, bareMethodCallback);
        expect(bareMethodCallback).toHaveBeenCalledWith({ ok: false, error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN });

        for (const data of [
            { clientType: 'machine-scoped', machineId: 'machine-1' },
            { clientType: 'machine-scoped', machineId: 'machine-other', verifiedMachineInstallationId: 'installation-1' },
        ]) {
            const deniedJoin = vi.fn().mockResolvedValue(undefined);
            const deniedSocket = createFakeSocket({
                id: 'invalid-machine-socket', data,
                join: deniedJoin, leave: vi.fn().mockResolvedValue(undefined),
            });
            registerSocketRpcHandlers({ userId: 'user-1', socket: deniedSocket as unknown as Socket, io: {} as Server });
            await triggerSocketHandler(deniedSocket, SOCKET_RPC_EVENTS.REGISTER, { method });
            expect(deniedJoin).not.toHaveBeenCalled();
            expect(deniedSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
                type: 'register', error: 'Forbidden',
            }));
        }

        const machineJoin = vi.fn().mockResolvedValue(undefined);
        const machineSocket = createFakeSocket({
            id: "machine-socket",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
                verifiedMachineInstallationId: "installation-1",
            },
            join: machineJoin,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        registerSocketRpcHandlers({
            userId: "user-1",
            socket: machineSocket as any,
            io: {} as Server,
        });
        await triggerSocketHandler(machineSocket, SOCKET_RPC_EVENTS.REGISTER, { method });
        expect(machineJoin).toHaveBeenCalledWith(`rpc:user-1:${method}`);
    });

    it.each([SESSION_SERVER_START_DAEMON_RPC_METHOD_V1, 'daemon.localServices.preview.admission'])("reserves %s for a proof-attested exact machine daemon and rejects client calls", async (reservedMethod) => {
        machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null, installationId: 'installation-1', kind: 'persistent' });
        const method = `machine-1:${reservedMethod}`;
        const userJoin = vi.fn().mockResolvedValue(undefined);
        const userSocket = createFakeSocket({
            id: "user-socket",
            data: { clientType: "user-scoped" },
            join: userJoin,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: userSocket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(userSocket, SOCKET_RPC_EVENTS.REGISTER, { method });
        const callback = vi.fn();
        await triggerSocketHandler(userSocket, SOCKET_RPC_EVENTS.CALL, { method, params: {} }, callback);

        expect(userJoin).not.toHaveBeenCalled();
expect(userSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
            type: "register",
            error: "Forbidden",
        }));
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        });

        const unverifiedMachineJoin = vi.fn().mockResolvedValue(undefined);
        const unverifiedMachineSocket = createFakeSocket({
            id: "unverified-machine-socket",
            data: { clientType: "machine-scoped", machineId: "machine-1" },
            join: unverifiedMachineJoin,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        registerSocketRpcHandlers({
            userId: "user-1",
            socket: unverifiedMachineSocket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(unverifiedMachineSocket, SOCKET_RPC_EVENTS.REGISTER, { method });
        expect(unverifiedMachineJoin).not.toHaveBeenCalled();
expect(unverifiedMachineSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
            type: "register",
            error: "Forbidden",
        }));

        const machineJoin = vi.fn().mockResolvedValue(undefined);
        const machineSocket = createFakeSocket({
            id: "machine-socket",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
                verifiedMachineInstallationId: "installation-1",
            },
            join: machineJoin,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        registerSocketRpcHandlers({
            userId: "user-1",
            socket: machineSocket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(machineSocket, SOCKET_RPC_EVENTS.REGISTER, { method });
        expect(machineJoin).toHaveBeenCalledWith(`rpc:user-1:${method}`);
    });

    it.each(["revoked", "replaced"] as const)("rejects RPC registration from a %s machine-scoped socket", async (state) => {
        machineFindFirstMock.mockResolvedValue({ revokedAt: state === "revoked" ? new Date(1) : null,
            replacedByMachineId: state === "replaced" ? "machine-current" : null });
        const join = vi.fn().mockResolvedValue(undefined);
        const socket = createFakeSocket({
            id: "socket-1",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-old",
            },
            join,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: "machine-old:spawn-happy-session" });

        expect(machineFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: "user-1", id: "machine-old" },
            select: { revokedAt: true, replacedByMachineId: true },
        }));
        expect(join).not.toHaveBeenCalled();
expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
            type: "register",
            error: state === "replaced" ? "Machine replaced" : "Machine unavailable",
            method: "machine-old:spawn-happy-session",
            retryable: true,
        }));
    });

    it("allows the exact machine daemon to register the machine-owned session spawn RPC", async () => {
        const join = vi.fn().mockResolvedValue(undefined);
        const socket = createFakeSocket({
            id: "machine-1-socket",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
            },
            join,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const method = `machine-1:${RPC_METHODS.SESSION_SPAWN_NEW}`;

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method });

        expect(join).toHaveBeenCalledWith(`rpc:user-1:${method}`);
        expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
    });

    it("forwards an Account caller's machine-owned session spawn call to the registered daemon", async () => {
        const method = `machine-1:${RPC_METHODS.SESSION_SPAWN_NEW}`;
        const emitWithAck = vi.fn().mockResolvedValue({ type: "success", sessionId: "session-new" });
        const target = {
            id: "machine-1-socket",
            data: { clientType: "machine-scoped", machineId: "machine-1" },
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const { io } = createTargetRoutingIo({
            [`rpc:user-1:${method}`]: [target],
            [target.id]: [target],
        });
        const socket = createFakeSocket({ id: "caller-socket" });
        const callback = vi.fn();
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as any, io });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "sealed-spawn-request",
        }, callback);

        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            method,
            params: "sealed-spawn-request",
        }));
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { type: "success", sessionId: "session-new" },
        });
    });

    it("rejects a machine-scoped socket registering another machine's RPC prefix", async () => {
        const join = vi.fn().mockResolvedValue(undefined);
        const socket = createFakeSocket({
            id: "machine-2-socket",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-2",
            },
            join,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, {
            method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
        });

        expect(join).not.toHaveBeenCalled();
expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
            type: "register",
            error: "Forbidden",
        }));
    });

    it.each([
        ["daemon.session.log.tail", true],
        [RPC_METHODS.SESSION_LOG_TAIL, false],
    ])("admits machine log registration %s only in its canonical scope", async (rpcMethod, allowed) => {
        const join = vi.fn().mockResolvedValue(undefined);
        const socket = createFakeSocket({
            id: "machine-1-socket",
            data: { clientType: "machine-scoped", machineId: "machine-1" },
            join,
            leave: vi.fn().mockResolvedValue(undefined),
        });
        const { io } = createRoomAwareIo();
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as unknown as Socket, io });
        const method = `machine-1:${rpcMethod}`;
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method });
        if (allowed) {
            expect(join).toHaveBeenCalledWith(`rpc:user-1:${method}`);
            expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
        } else {
            expect(join).not.toHaveBeenCalled();
expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({ type: "register", error: "Forbidden" }));
        }
    });

    it("keeps unprefixed daemon RPC registration available to a machine-scoped socket", async () => {
        const join = vi.fn().mockResolvedValue(undefined);
        const socket = createFakeSocket({
            id: "machine-1-socket",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
            },
            join,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, {
            method: RPC_METHODS.CAPABILITIES_INVOKE,
        });

        expect(join).toHaveBeenCalledWith(`rpc:user-1:${RPC_METHODS.CAPABILITIES_INVOKE}`);
        expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, {
            method: RPC_METHODS.CAPABILITIES_INVOKE,
        });
    });

    it("rejects session-scoped RPC registration without a machine access-key binding", async () => {
        const join = vi.fn().mockResolvedValue(undefined);
        const socket = createFakeSocket({
            id: "session-socket",
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: "sess_1",
                    machineId: null,
                    proof: "owner-session",
                },
            },
            join,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: "sess_1:execution.run.stream.start" });

        expect(join).not.toHaveBeenCalled();
expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
            type: "register",
            error: "Forbidden",
        }));
    });

    it.each(["session.unlisted", "transcript.unlisted"])("rejects unlisted Session RPC %s at registration before it can become dispatchable", async (unlistedMethod) => {
        const join = vi.fn().mockResolvedValue(undefined);
        const socket = createFakeSocket({
            id: "session-socket",
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: "sess_1",
                    machineId: "machine-1",
                    proof: "machine-access-key",
                },
            },
            join,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);

        registerSocketRpcHandlers({ userId: "user-1", socket: socket as any, io: {} as Server });
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: `sess_1:${unlistedMethod}` });

        expect(join).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
            type: "register",
            error: "RPC method not available",
            method: `sess_1:${unlistedMethod}`,
            retryable: false,
        });
    });

    it.each(["session.unlisted", "transcript.unlisted"])("rejects unlisted Session RPC %s at final dispatch", async (unlistedMethod) => {
        const socket = createFakeSocket({
            id: "caller-socket",
            data: { clientType: "user-scoped" },
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();

        registerSocketRpcHandlers({ userId: "user-1", socket: socket as any, io: {} as Server });
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method: `sess_1:${unlistedMethod}`,
            params: {},
            authorization: { kind: "session.write", sessionId: "sess_1" },
        }, callback);

        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    });

    it.each([
        CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
        CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
        CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
    ])("registers and forwards owner presentation custody with a server-minted socket origin: %s", async (rpcMethod) => {
        const method = `sess_1:${rpcMethod}`;
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow("sess_1"));
        accessKeyFindUniqueMock.mockResolvedValue({ session: { accountId: 'user-1' }, machine: { revokedAt: null, replacedByMachineId: null } });
        const targetEmitWithAck = vi.fn().mockResolvedValue({ status: "accepted" });
        const targetJoin = vi.fn().mockResolvedValue(undefined);
        const target = createFakeSocket({
            id: "session-target",
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: "sess_1",
                    machineId: "machine-1",
                    proof: "machine-access-key",
                },
            },
            join: targetJoin,
            leave: vi.fn().mockResolvedValue(undefined),
            timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
        } as any);
        const { io } = createIo({
            targetsByRoom: {
                [`rpc:user-1:${method}`]: [target],
            },
        });
        registerSocketRpcHandlers({ userId: "user-1", socket: target as any, io });

        await triggerSocketHandler(target, SOCKET_RPC_EVENTS.REGISTER, { method });

        expect(targetJoin).toHaveBeenCalledWith(`rpc:user-1:${method}`);
        expect(target.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });

        const caller = createFakeSocket({ id: "owner-ui-connection" } as any);
        const callback = vi.fn();
        registerSocketRpcHandlers({ userId: "user-1", socket: caller as any, io });

        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: { clientId: "client-1" },
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: true, result: { status: "accepted" } });
        expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            method,
            params: { clientId: "client-1" },
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.CURRENT_SESSION_PRESENTATION_ORIGIN,
                sessionId: "sess_1",
                accountId: "user-1",
                connectionId: "owner-ui-connection",
            },
        }));
    });

    it.each([
        CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
        CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
    ])("refuses view-only collaborators before presentation custody reaches the daemon: %s", async (rpcMethod) => {
        const method = `sess_1:${rpcMethod}`;
        sessionShareFindUniqueMock.mockResolvedValue({
            id: "share-1",
            sharedWithUserId: "user-1",
            accessLevel: "view",
            canApprovePermissions: false,
        });
        const targetEmitWithAck = vi.fn().mockResolvedValue({ status: "accepted" });
        const target = { id: "session-target", timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })) };
        const { io } = createIo({ targetsByRoom: { [`rpc:session-owner:${method}`]: [target] } });
        const caller = createFakeSocket({ id: "shared-viewer" } as any);
        const callback = vi.fn();
        registerSocketRpcHandlers({ userId: "user-1", socket: caller as any, io });

        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: { clientId: "forged-client", focused: true, draftRevision: 0 },
        }, callback);

        expect(targetEmitWithAck).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            ok: false,
            error: "Forbidden",
        }));
    });

    it("retires the exact presentation origin at the owner daemon when its authenticated socket disconnects", async () => {
        const bindMethod = `sess_1:${CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD}`;
        const unbindMethod = `sess_1:${CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD}`;
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow("sess_1"));
        const targetEmitWithAck = vi.fn(async (_event: string, request: Readonly<{ method: string }>) => (
            request.method === bindMethod ? { status: "bound" } : { status: "retired" }
        ));
        const target = {
            id: "session-target",
            timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
        };
        const { io } = createIo({
            targetsByRoom: {
                [`rpc:user-1:${bindMethod}`]: [target],
                [`rpc:user-1:${unbindMethod}`]: [target],
            },
        });
        const caller = createFakeSocket({ id: "owner-ui-connection" } as any);
        registerSocketRpcHandlers({ userId: "user-1", socket: caller as any, io });

        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method: bindMethod,
            params: { clientId: "client-1", focused: true, draftRevision: 0 },
        }, vi.fn());
        await triggerSocketHandler(caller, "disconnect");

        expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            method: unbindMethod,
            params: { clientId: "client-1" },
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.CURRENT_SESSION_PRESENTATION_ORIGIN,
                sessionId: "sess_1",
                accountId: "user-1",
                connectionId: "owner-ui-connection",
            },
        }));
    });

    it("retires a presentation bind that completes after its authenticated socket disconnected", async () => {
        const bindMethod = `sess_1:${CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD}`;
        const unbindMethod = `sess_1:${CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD}`;
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow("sess_1"));
        let resolveBind!: (value: unknown) => void;
        const bindResult = new Promise<unknown>((resolve) => {
            resolveBind = resolve;
        });
        const targetEmitWithAck = vi.fn(async (_event: string, request: Readonly<{ method: string }>) => (
            request.method === bindMethod ? await bindResult : { status: "retired" }
        ));
        const target = {
            id: "session-target",
            timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
        };
        const { io } = createIo({
            targetsByRoom: {
                [`rpc:user-1:${bindMethod}`]: [target],
                [`rpc:user-1:${unbindMethod}`]: [target],
            },
        });
        const caller = createFakeSocket({ id: "owner-ui-connection" } as any);
        registerSocketRpcHandlers({ userId: "user-1", socket: caller as any, io });

        const bindCall = triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method: bindMethod,
            params: { clientId: "client-1", focused: true, draftRevision: 0 },
        }, vi.fn());
        await vi.waitFor(() => expect(targetEmitWithAck).toHaveBeenCalledTimes(1));
        await triggerSocketHandler(caller, "disconnect");
        resolveBind({ status: "bound" });
        await bindCall;

        await vi.waitFor(() => expect(
            targetEmitWithAck.mock.calls.map((call) => call[1].method).at(-1),
        ).toBe(unbindMethod));
    });

    it("rejects a presentation binding whose explicit authorization names another Session", async () => {
        const method = `sess_1:${CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD}`;
        const targetEmitWithAck = vi.fn().mockResolvedValue({ status: "accepted" });
        const { io } = createIo({
            targetsByRoom: {
                [`rpc:session-owner:${method}`]: [{
                    id: "session-target",
                    timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
                }],
            },
        });
        const caller = createFakeSocket({ id: "shared-viewer" } as any);
        const callback = vi.fn();
        registerSocketRpcHandlers({ userId: "user-1", socket: caller as any, io });

        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: { clientId: "client-1" },
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                sessionId: "sess_other",
            },
        }, callback);

        expect(targetEmitWithAck).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        });
    });

    it("rejects presentation binding before forwarding when the caller is not the Session owner", async () => {
        const method = `sess_1:${CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD}`;
        sessionShareFindUniqueMock
            .mockResolvedValueOnce({
                id: "share-1",
                sharedWithUserId: "user-1",
                accessLevel: "view",
                canApprovePermissions: false,
            })
            .mockResolvedValue(null);
        const targetEmitWithAck = vi.fn().mockResolvedValue({ status: "accepted" });
        const target = {
            id: "session-target",
            timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
        };
        const { io } = createIo({
            targetsByRoom: {
                [`rpc:session-owner:${method}`]: [target],
                "session-target": [target],
            },
        });
        const caller = createFakeSocket({ id: "shared-viewer" } as any);
        const callback = vi.fn();
        registerSocketRpcHandlers({ userId: "user-1", socket: caller as any, io });

        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: { clientId: "client-1" },
        }, callback);

        expect(targetEmitWithAck).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        });
    });

    it.each([
        CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
        CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
    ])("fails current-session presentation RPC closed after Session access is removed: %s", async (rpcMethod) => {
        const method = `sess_1:${rpcMethod}`;
        const targetEmitWithAck = vi.fn().mockResolvedValue({ status: "accepted" });
        const target = {
            id: "session-target",
            timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
        };
        const { io } = createIo({
            targetsByRoom: {
                [`rpc:session-owner:${method}`]: [target],
            },
        });
        const caller = createFakeSocket({ id: "former-viewer" } as any);
        const callback = vi.fn();
        sessionShareFindUniqueMock.mockResolvedValue(null);
        registerSocketRpcHandlers({ userId: "user-1", socket: caller as any, io });

        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: { clientId: "client-1" },
        }, callback);

        expect(targetEmitWithAck).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        });
    });

    it("rejects session-scoped RPC registration when a lingering access key points at a replaced machine", async () => {
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        accessKeyFindUniqueMock.mockResolvedValue({
            machineId: "machine-old",
            session: { accountId: 'user-1' },
            machine: {
                revokedAt: null,
                replacedByMachineId: "machine-current",
            },
        });
        const join = vi.fn().mockResolvedValue(undefined);
        const socket = createFakeSocket({
            id: "session-socket",
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: "sess_1",
                    machineId: "machine-old",
                    proof: "machine-access-key",
                },
            },
            join,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: "sess_1:execution.run.stream.start" });

        expect(accessKeyFindUniqueMock).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId_machineId_sessionId: {
                    accountId: "user-1",
                    machineId: "machine-old",
                    sessionId: "sess_1",
                },
            },
        }));
        expect(join).not.toHaveBeenCalled();
expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
            type: "register",
            error: "Forbidden",
        }));
    });

    it("rejects malformed explicit deadlines before looking up or dispatching a target", async () => {
        const effect = vi.fn(async () => "result");
        const { io, inMock } = createIo({ targetsByRoom: {
            "rpc:user-1:agent.run": [{ id: "target", timeout: () => ({ emitWithAck: effect }) }],
        } });
        const socket = createFakeSocket({ id: "caller" });
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as unknown as Socket, io });
        for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY, "1000", false]) {
            const acknowledge = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method: "agent.run", params: {}, timeoutMs }, acknowledge);
            expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.any(String) }));
        }
        expect(effect).not.toHaveBeenCalled();
        expect(inMock).not.toHaveBeenCalled();
    });

    it("forwards calls through room discovery and excludes the caller socket", async () => {
        const targetEmitWithAck = vi.fn().mockResolvedValue({ ok: true, value: 123 });
        const target = {
            id: "target-socket",
            timeout: vi.fn(() => ({
                emitWithAck: targetEmitWithAck,
            })),
        };
        const { io, inMock } = createIo({
            targetsByRoom: {
                "rpc:user-1:agent.run": [
                    { id: "caller-socket", timeout: vi.fn() },
                    target,
                ],
            },
        });
        const socket = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();


        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method: "agent.run", params: { value: 1 } }, callback);

        expect(inMock).toHaveBeenCalledWith("rpc:user-1:agent.run");
        expect(target.timeout).toHaveBeenCalledWith(30000, { rejectOnDisconnect: true });
        expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
            method: "agent.run",
            params: { value: 1 },
            callerAuthority: "present_user",
            timeoutMs: 30000,
        });
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { ok: true, value: 123 },
        });
    });

    it("keeps explicitly unbounded execution-run input forwarding under the caller lifecycle", async () => {
        machineFindFirstMock.mockResolvedValue(null);
        const method = `sess_1:${SESSION_RPC_METHODS.EXECUTION_RUN_SEND}`;
        const targetEmitWithAck = vi.fn().mockResolvedValue({ ok: true });
        const target = {
            id: "target-socket",
            timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
        };
        const { io } = createIo({
            targetsByRoom: {
                [`rpc:session-owner:${method}`]: [target],
            },
        });
        const socket = createFakeSocket({ id: "owner-socket" } as any);
        const callback = vi.fn();

        registerSocketRpcHandlers({ userId: "session-owner", socket: socket as any, io });
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: { runId: "run-1", message: "Continue" },
            timeoutMs: null,
        }, callback);

        expect(target.timeout).toHaveBeenCalledWith(2_147_483_647, { rejectOnDisconnect: true });
        expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            method,
            timeoutMs: null,
        }));
        expect(callback).toHaveBeenCalledWith({ ok: true, result: { ok: true } });
    });

    it("binds cancellation to the issuing socket and server-mints distinct target request ids", async () => {
        const pendingResolvers: Array<(value: unknown) => void> = [];
        const targetEmitWithAck = vi.fn<RpcTargetEmitWithAck>(() => new Promise<unknown>((resolve) => {
            pendingResolvers.push(resolve);
        }));
        const target = {
            id: "target-socket",
            timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
        };
        const targetCancelEmit = vi.fn();
        const io = {
            sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets: async () => [target] })),
                fetchSockets: async () => [target],
            })),
            to: vi.fn(() => ({ emit: targetCancelEmit })),
        } as unknown as Server;
        const firstCaller = createFakeSocket({
            id: "caller-one",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const secondCaller = createFakeSocket({
            id: "caller-two",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);

        registerSocketRpcHandlers({ userId: "user-1", socket: firstCaller as any, io });
        registerSocketRpcHandlers({ userId: "user-1", socket: secondCaller as any, io });

        const firstCall = triggerSocketHandler(
            firstCaller,
            SOCKET_RPC_EVENTS.CALL,
            { method: "agent.run", params: { query: "first" }, requestId: "caller-request" },
            vi.fn(),
        );
        const secondCall = triggerSocketHandler(
            secondCaller,
            SOCKET_RPC_EVENTS.CALL,
            { method: "agent.run", params: { query: "second" }, requestId: "caller-request" },
            vi.fn(),
        );

        await vi.waitFor(() => expect(targetEmitWithAck).toHaveBeenCalledTimes(2));
        const firstTargetRequestId = targetEmitWithAck.mock.calls[0]?.[1]?.requestId;
        const secondTargetRequestId = targetEmitWithAck.mock.calls[1]?.[1]?.requestId;
        expect(firstTargetRequestId).toEqual(expect.any(String));
        expect(secondTargetRequestId).toEqual(expect.any(String));
        expect(firstTargetRequestId).not.toBe(secondTargetRequestId);

        await triggerSocketHandler(firstCaller, SOCKET_RPC_EVENTS.CANCEL, { requestId: "caller-request" });

        expect(io.to).toHaveBeenCalledWith("target-socket");
        expect(targetCancelEmit).toHaveBeenCalledTimes(1);
        expect(targetCancelEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CANCEL, {
            requestId: firstTargetRequestId,
        });

        pendingResolvers[0]?.({ ok: true, request: "first" });
        pendingResolvers[1]?.({ ok: true, request: "second" });
        await Promise.all([firstCall, secondCall]);

        await triggerSocketHandler(firstCaller, SOCKET_RPC_EVENTS.CANCEL, { requestId: "caller-request" });
        expect(targetCancelEmit).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])("retains an opted-in cancelled call's own ACK unless its caller disconnects (%s)", async (disconnect) => {
        const io = new Server();
        let acknowledge!: (value: unknown) => void;
        // Socket.IO's real ACK lifecycle remains in the path; only its network
        // adapter and the authenticated calling socket are boundaries here.
        const dispatch = vi.spyOn(io.of('/').adapter, 'broadcastWithAck').mockImplementation(
            (_packet, _options, clientCount, response) => {
                acknowledge = response;
                clientCount(1);
            },
        );
        const target = {
            id: 'cooperative-target',
            timeout: (ms: number, lifetime?: Readonly<{ rejectOnDisconnect?: boolean; signal?: AbortSignal }>) =>
                (io.to('cooperative-target') as unknown as import('./_types').RpcAckResponseEmitter).timeout(ms, lifetime),
        };
        vi.spyOn(io, 'in').mockReturnValue({
            timeout: () => ({ fetchSockets: async () => [target] }),
            fetchSockets: async () => [target],
        } as unknown as ReturnType<Server['in']>);
        const caller = createFakeSocket({ id: 'cooperative-caller' });
        const callback = vi.fn();
        registerSocketRpcHandlers({ userId: 'user-1', socket: caller as unknown as Socket, io });
        const call = triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method: 'agent.run', params: {}, requestId: 'cooperative-request',
            timeoutMs: null, waitForResultOnCancel: true,
        }, callback);
        try {
            await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CANCEL, { requestId: 'cooperative-request' });
            if (disconnect) await triggerSocketHandler(caller, 'disconnect');
            acknowledge('opaque-partial-result-with-undo');
            await call;
            expect(callback).toHaveBeenCalledWith(disconnect
                ? expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN })
                : { ok: true, result: ['opaque-partial-result-with-undo'] });
            expect(dispatch).toHaveBeenCalledOnce();
        } finally {
            acknowledge?.('cleanup');
            await call;
            vi.restoreAllMocks();
        }
    });

    it("cancels an in-flight target request when its issuing socket disconnects", async () => {
        let resolveTargetRequest!: (value: unknown) => void;
        const targetEmitWithAck = vi.fn<RpcTargetEmitWithAck>(() => new Promise<unknown>((resolve) => {
            resolveTargetRequest = resolve;
        }));
        const target = {
            id: "target-socket",
            timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
        };
        const targetCancelEmit = vi.fn();
        const io = {
            sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets: async () => [target] })),
                fetchSockets: async () => [target],
            })),
            to: vi.fn(() => ({ emit: targetCancelEmit })),
        } as unknown as Server;
        const caller = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);

        registerSocketRpcHandlers({ userId: "user-1", socket: caller as any, io });

        const call = triggerSocketHandler(
            caller,
            SOCKET_RPC_EVENTS.CALL,
            { method: "agent.run", params: {}, requestId: "disconnect-request" },
            vi.fn(),
        );
        await vi.waitFor(() => expect(targetEmitWithAck).toHaveBeenCalledTimes(1));
        const targetRequestId = targetEmitWithAck.mock.calls[0]?.[1]?.requestId;

        await triggerSocketHandler(caller, "disconnect");

        expect(targetCancelEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CANCEL, {
            requestId: targetRequestId,
        });

        resolveTargetRequest({ ok: true });
        await call;
    });

    it.each([RPC_METHODS.SESSION_PERMISSION_RESPOND, RPC_METHODS.SESSION_USER_ACTION_ANSWER,
        SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1, 'approval.request.decide'])("forwards only the server-stamped actor for %s", async (decisionMethod) => {
        sessionShareFindUniqueMock.mockResolvedValue({
            id: "share-1",
            sharedWithUserId: "shared-user",
            accessLevel: "edit",
            canApprovePermissions: decisionMethod === RPC_METHODS.SESSION_PERMISSION_RESPOND,
        });
        const targetEmitWithAck = vi.fn().mockResolvedValue({ ok: true });
        const target = {
            id: "target-socket",
            ...(decisionMethod === 'approval.request.decide' ? { data: { clientType: 'machine-scoped', machineId: 'machine-1' } } : {}),
            timeout: vi.fn(() => ({
                emitWithAck: targetEmitWithAck,
            })),
        };
        if (decisionMethod === 'approval.request.decide') {
            machineFindFirstMock.mockImplementation(async args => {
                const query = args as Readonly<{ where?: Readonly<{ id?: string }> }> | undefined;
                return query?.where?.id === 'sess_1' ? null : { revokedAt: null, replacedByMachineId: null, accountId: 'session-owner' };
            });
            sessionFindUniqueMock.mockImplementation(async () => ({ ...createOwnedSessionAccessRow(), accountId: 'session-owner',
                shares: [await sessionShareFindUniqueMock()] }));
            accessKeyFindUniqueMock.mockResolvedValue({ machineId: 'machine-1', session: { accountId: 'session-owner' },
                machine: { revokedAt: null, replacedByMachineId: null } });
        }
        const publisher = { data: { sessionPublisherAuthority: { v: 1, accountId: 'session-owner', sessionId: 'sess_1',
            machineId: 'machine-1', committedFenceMs: 2, publisherGeneration: '1' } } };
        const { io } = createTargetRoutingIo({
            [`rpc:session-owner:${decisionMethod === 'approval.request.decide' ? 'machine-1' : 'sess_1'}:${decisionMethod}`]: [target],
            'session:sess_1:session-owner': [publisher], [target.id]: [target],
        });
        const socket = createFakeSocket({
            id: "caller-socket",
            ...(decisionMethod === 'approval.request.decide' ? { handshake: { auth: { token: await auth.createToken('shared-user', undefined, {
                kind: 'account', authority: 'present_user', authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
            }) } } } : {}),
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const stampedAuthorization = {
            kind: "session.permission.respond" as const,
            sessionId: "sess_1",
            actor: {
                kind: "accountUser" as const,
                accountId: "shared-user",
                relationship: "sharedApprover" as const,
            },
            ...(decisionMethod === 'approval.request.decide' ? { authentication: { tokenEpoch: 3,
                evidence: { v: 1, evidence: [{ kind: 'home_method', methodId: 'key_challenge' }] } } } : {}),
        };

        registerSocketRpcHandlers({
            userId: "shared-user",
            socket: socket as any,
            io,
            ...(decisionMethod === 'approval.request.decide' ? { sessionPublisherPresence: createSessionPublisherPresence() } : {}),
        });

        const decisionResponse = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method: `sess_1:${decisionMethod}`,
            params: { id: "request-1", approved: true },
            authorization: {
                kind: "session.permission.respond",
                sessionId: "sess_1",
                authentication: { tokenEpoch: 999,
                    evidence: { v: 1, evidence: [{ kind: 'home_method', methodId: 'forged_method' }] } },
                actor: {
                    kind: "accountUser",
                    accountId: "forged-account",
                    relationship: "owner",
                },
            },
        }, decisionResponse);

        expect(targetEmitWithAck.mock.calls.length, JSON.stringify(decisionResponse.mock.calls)).toBeGreaterThan(0);
        expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
            method: `sess_1:${decisionMethod}`,
            params: { id: "request-1", approved: true },
            callerAuthority: "present_user",
            timeoutMs: 30000,
            authorization: stampedAuthorization,
        });
    });

    it.each(['viewer', 'automation'])("refuses %s requester approval decisions", async (scenario) => {
        machineFindFirstMock.mockImplementation(async args => {
            const query = args as Readonly<{ where?: Readonly<{ id?: string }> }> | undefined;
            return query?.where?.id === 'sess_1' ? null : { revokedAt: null, replacedByMachineId: null };
        });
        sessionShareFindUniqueMock.mockResolvedValue({ id: 'share-1', sharedWithUserId: 'shared-user',
            accessLevel: scenario === 'viewer' ? 'view' : 'edit', canApprovePermissions: true });
        const targetEmitWithAck = vi.fn().mockResolvedValue({ ok: true });
        const target = { id: 'target', timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })) };
        const method = 'sess_1:approval.request.decide';
        const { io } = createIo({ targetsByRoom: { [`rpc:session-owner:${method}`]: [target] } });
        const socket = createFakeSocket({ id: 'requester',
            handshake: { auth: { token: await auth.createToken('shared-user', undefined, scenario === 'automation'
                ? { kind: 'terminal', authority: 'account_automation' } : { kind: 'account', authority: 'present_user' }) } },
            data: { authAuthority: scenario === 'automation' ? 'account_automation' : 'present_user' } });
        registerSocketRpcHandlers({ userId: 'shared-user', socket: socket as any, io });
        const ack = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method,
            params: { artifactId: 'approval', decision: 'approved', sessionId: 'sess_1' } }, ack);
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(targetEmitWithAck).not.toHaveBeenCalled();
    });

    it("routes collaborator Run start to the owner daemon but keeps privileged Run controls owner-only", async () => {
        // The exact Session fixture has no same-id Machine row.
        machineFindFirstMock.mockResolvedValue(null);
        const targetEmitWithAck = vi.fn().mockResolvedValue({ ok: true });
        const target = {
            id: "target-socket",
            timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
        };
        const startMethod = `sess_1:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`;
        const readMethod = `sess_1:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`;
        const publisherMethod = `sess_1:${SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1}`;
        const { io, inMock } = createIo({
            targetsByRoom: {
                [`rpc:session-owner:${startMethod}`]: [target],
                [`rpc:session-owner:${readMethod}`]: [target],
                [`rpc:session-owner:${publisherMethod}`]: [target],
            },
        });
        const socket = createFakeSocket({ id: "shared-editor" } as any);
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as any, io });

        const startCallback = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method: startMethod,
            params: { instructions: "Review." },
        }, startCallback);
        expect(inMock).toHaveBeenCalledWith(`rpc:session-owner:${startMethod}`);
        expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            method: startMethod,
            authorization: { kind: "session.write", sessionId: "sess_1" },
        }));
        const readCallback = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method: readMethod, params: { runId: 'attached-run' } }, readCallback);
        expect(readCallback).toHaveBeenCalledWith({ ok: true, result: { ok: true } });
        expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            method: readMethod, authorization: { kind: 'session.write', sessionId: 'sess_1' },
        }));

        for (const method of [
            SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
            SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
            SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
            SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1,
            SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
            SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1,
            SESSION_RPC_METHODS.SESSION_MESSAGE_REPLY_OBSERVE_V1,
        ]) {
            const callback = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
                method: `sess_1:${method}`,
                params: {},
            }, callback);
            expect(callback).toHaveBeenCalledWith({
                ok: false,
                error: "Forbidden",
                errorCode: RPC_ERROR_CODES.FORBIDDEN,
            });
        }
        sessionFindUniqueMock.mockResolvedValue({ ...createOwnedSessionAccessRow(), accountId: 'session-owner' });
        const ownerSocket = createFakeSocket({ id: 'session-owner-caller' });
        registerSocketRpcHandlers({ userId: 'session-owner', socket: ownerSocket as never, io });
        const ownerCallback = vi.fn();
        await triggerSocketHandler(ownerSocket, SOCKET_RPC_EVENTS.CALL, { method: publisherMethod, params: {} }, ownerCallback);
        expect(ownerCallback).toHaveBeenCalledWith({ ok: true, result: { ok: true } });
        expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            method: publisherMethod, authorization: { kind: 'session.write', sessionId: 'sess_1' },
        }));
        sessionShareFindUniqueMock.mockResolvedValue(null);
        const revokedRead = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method: readMethod, params: { runId: 'attached-run' } }, revokedRead);
        expect(revokedRead).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
    });

    it("does not forward calls to replaced machine-scoped targets discovered from the RPC room", async () => {
        machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: "machine-current" });
        const targetEmitWithAck = vi.fn().mockResolvedValue({ ok: true, value: 123 });
        const target = {
            id: "target-socket",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-old",
            },
            timeout: vi.fn(() => ({
                emitWithAck: targetEmitWithAck,
            })),
        };
        const { io } = createIo({
            targetsByRoom: {
                "rpc:user-1:machine-old:spawn-happy-session": [target],
            },
        });
        const socket = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();


        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io,
        });

        await triggerSocketHandler(
            socket,
            SOCKET_RPC_EVENTS.CALL,
            { method: "machine-old:spawn-happy-session", params: {} },
            callback,
        );

        expect(machineFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: "user-1", id: "machine-old" },
            select: { revokedAt: true, replacedByMachineId: true },
        }));
        expect(targetEmitWithAck).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "RPC target unavailable",
            errorCode: 'target_unavailable',
        });
    });

    it("returns the canonical method-not-available error when no target is present", async () => {
        const { io } = createIo({
            targetsByRoom: {
                "rpc:user-1:missing-method": [],
            },
        });
        const socket = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();


        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method: "missing-method", params: {} }, callback);

        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
        expect(rpcMetricsMocks.recordRpcMethodNotAvailable).toHaveBeenCalledWith("missing-method");
        expect(rpcMetricsMocks.recordRpcCallFailure).toHaveBeenCalledWith("missing-method", "method_not_available");
        expect(rpcMetricsMocks.observeRpcCall).toHaveBeenCalledWith(expect.objectContaining({
            method: "missing-method",
            result: "error",
        }));
        expect(rpcMetricsMocks.observeRpcTargetLookup).toHaveBeenCalledWith(expect.objectContaining({
            method: "missing-method",
            result: "miss",
        }));
    });

    it.each(['daemon.sessionRunner.restart', 'daemon.sessionRunner.restart.confirmedBackground'])('rejects %s RPCs without edit authorization before forwarding', async method => {
        sessionShareFindUniqueMock.mockResolvedValue({ id: "share-1", accessLevel: "view", canApprovePermissions: false });
        const socket = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(
            socket,
            SOCKET_RPC_EVENTS.CALL,
            {
                method: `machine-1:${method}`,
                params: "encrypted-payload",
                authorization: {
                    kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                    sessionId: "sess_1",
                },
            },
            callback,
        );

        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        });
    });

    it("requires exact Session edit attestation for remote grant inventory and revocation", async () => {
        sessionShareFindUniqueMock.mockResolvedValue({ id: "share-1", accessLevel: "view", canApprovePermissions: false });
        const socket = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io: {} as Server,
        });

        for (const method of [
            "session.permission.remote.grants.list",
            "session.permission.remote.grants.revoke",
        ]) {
            const callback = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
                method: `sess_1:${method}`,
                params: "encrypted-payload",
                authorization: {
                    kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                    sessionId: "sess_1",
                },
            }, callback);

            expect(callback).toHaveBeenCalledWith({
                ok: false,
                error: "Forbidden",
                errorCode: RPC_ERROR_CODES.FORBIDDEN,
            });
        }
    });

    it("rejects a Session Agent transition that carries no edit proof before resolving a target", async () => {
        const socket = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(
            socket,
            SOCKET_RPC_EVENTS.CALL,
            {
                method: `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
                params: "encrypted-payload",
            },
            callback,
        );

        expect(sessionFindUniqueMock).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        });
    });

    it("rejects a Session Agent transition from a collaborator without edit access", async () => {
        sessionShareFindUniqueMock.mockResolvedValue({ id: "share-1", accessLevel: "view", canApprovePermissions: false });
        const socket = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(
            socket,
            SOCKET_RPC_EVENTS.CALL,
            {
                method: `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
                params: "encrypted-payload",
                authorization: {
                    kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                    sessionId: "sess_1",
                },
            },
            callback,
        );

        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        });
    });

    it("forwards a Session Agent transition with its edit proof so the daemon can bind it to the payload", async () => {
        const targetEmitWithAck = vi.fn().mockResolvedValue({ type: "accepted", localId: "local-1" });
        const target = {
            id: "target-socket",
            timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
        };
        const { io } = createIo({
            targetsByRoom: {
                [`rpc:user-1:machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`]: [target],
            },
        });
        const socket = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();


        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io,
        });

        await triggerSocketHandler(
            socket,
            SOCKET_RPC_EVENTS.CALL,
            {
                method: `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
                params: "encrypted-payload",
                authorization: {
                    kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                    sessionId: "sess_1",
                },
            },
            callback,
        );

        expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            method: `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
            params: "encrypted-payload",
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                sessionId: "sess_1",
            },
        }));
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { type: "accepted", localId: "local-1" },
        });
    });

    it("uses a dedicated cluster fetch timeout for session-scoped rpc discovery", async () => {
        // The Session namespace is not a persisted Machine identity.
        machineFindFirstMock.mockResolvedValue(null);
        const method = `sess_1:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`;
        const { io, timeout } = createIo({
            targetsByRoom: {
                [`rpc:session-owner:${method}`]: [],
            },
        });
        const socket = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();


        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io,
        });

        await triggerSocketHandler(
            socket,
            SOCKET_RPC_EVENTS.CALL,
            { method, params: {} },
            callback,
        );

        expect(timeout).toHaveBeenCalledWith(1000);
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "RPC target unavailable",
            errorCode: 'target_unavailable',
        });
    });

    it("rejects session-scoped RPC calls without a machine access-key binding before resolving or forwarding", async () => {
        const { io, inMock } = createIo({
            targetsByRoom: {
                "rpc:user-1:sess_1:execution.run.stream.start": [],
            },
        });
        const socket = createFakeSocket({
            id: "session-caller-socket",
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: "sess_1",
                    machineId: null,
                    proof: "owner-session",
                },
            },
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();


        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io,
        });

        await triggerSocketHandler(
            socket,
            SOCKET_RPC_EVENTS.CALL,
            { method: "sess_1:execution.run.stream.start", params: {} },
            callback,
        );

        expect(accessKeyFindUniqueMock).not.toHaveBeenCalled();
        expect(inMock).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
        });
        expect(rpcMetricsMocks.recordRpcCallFailure).toHaveBeenCalledWith("sess_1:execution.run.stream.start", "forbidden");
        expect(rpcMetricsMocks.observeRpcCall).toHaveBeenCalledWith(expect.objectContaining({
            method: "sess_1:execution.run.stream.start",
            result: "error",
        }));
    });

    it("rejects session-scoped RPC calls when a lingering access key points at a replaced machine", async () => {
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        accessKeyFindUniqueMock.mockResolvedValue({
            machineId: "machine-old",
            session: { accountId: 'user-1' },
            machine: {
                revokedAt: null,
                replacedByMachineId: "machine-current",
            },
        });
        const { io, inMock } = createIo({
            targetsByRoom: {
                "rpc:user-1:sess_1:execution.run.stream.start": [],
            },
        });
        const socket = createFakeSocket({
            id: "session-caller-socket",
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: "sess_1",
                    machineId: "machine-old",
                    proof: "machine-access-key",
                },
            },
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();


        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io,
        });

        await triggerSocketHandler(
            socket,
            SOCKET_RPC_EVENTS.CALL,
            { method: "sess_1:execution.run.stream.start", params: {} },
            callback,
        );

        expect(accessKeyFindUniqueMock).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId_machineId_sessionId: {
                    accountId: "user-1",
                    machineId: "machine-old",
                    sessionId: "sess_1",
                },
            },
        }));
        expect(inMock).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
        });
        expect(rpcMetricsMocks.recordRpcCallFailure).toHaveBeenCalledWith("sess_1:execution.run.stream.start", "forbidden");
        expect(rpcMetricsMocks.observeRpcCall).toHaveBeenCalledWith(expect.objectContaining({
            method: "sess_1:execution.run.stream.start",
            result: "error",
        }));
    });

    it("rejects session-scoped callers for a different session-prefixed RPC before resolving or forwarding", async () => {
        const { io, inMock } = createIo({
            targetsByRoom: {
                "rpc:user-1:sess_2:execution.run.stream.start": [],
            },
        });
        const socket = createFakeSocket({
            id: "session-caller-socket",
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: "sess_1",
                    machineId: null,
                    proof: "owner-session",
                },
            },
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();


        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io,
        });

        await triggerSocketHandler(
            socket,
            SOCKET_RPC_EVENTS.CALL,
            { method: "sess_2:execution.run.stream.start", params: {} },
            callback,
        );

        expect(inMock).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
        });
        expect(rpcMetricsMocks.recordRpcCallFailure).toHaveBeenCalledWith("sess_2:execution.run.stream.start", "forbidden");
        expect(rpcMetricsMocks.observeRpcCall).toHaveBeenCalledWith(expect.objectContaining({
            method: "sess_2:execution.run.stream.start",
            result: "error",
        }));
    });

    it("rejects unprefixed RPC calls from session-scoped callers before resolving or forwarding", async () => {
        const { io, inMock } = createIo({
            targetsByRoom: {
                "rpc:user-1:agent.run": [],
            },
        });
        const socket = createFakeSocket({
            id: "session-caller-socket",
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: "sess_1",
                    machineId: null,
                    proof: "owner-session",
                },
            },
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();


        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method: "agent.run", params: {} }, callback);

        expect(inMock).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
        });
        expect(rpcMetricsMocks.recordRpcCallFailure).toHaveBeenCalledWith("agent.run", "forbidden");
        expect(rpcMetricsMocks.observeRpcCall).toHaveBeenCalledWith(expect.objectContaining({
            method: "agent.run",
            result: "error",
        }));
    });

    it("leaves all owned rooms on disconnect cleanup", async () => {
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow('sess_1'));
        accessKeyFindUniqueMock.mockResolvedValue({ session: { accountId: 'user-1' }, machine: { revokedAt: null, replacedByMachineId: null } });
        const leave = vi.fn().mockResolvedValue(undefined);
        const socket = createFakeSocket({
            id: "caller-socket",
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: "sess_1",
                    machineId: "machine-1",
                    proof: "machine-access-key",
                },
            },
            join: vi.fn().mockResolvedValue(undefined),
            leave,
        } as any);

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: `sess_1:${SESSION_RPC_METHODS.SESSION_WORK_STATE_GET}` });
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: "sess_1:execution.run.stream.start" });
        await triggerSocketHandler(socket, "disconnect");

        expect(leave).toHaveBeenCalledWith(`rpc:user-1:sess_1:${SESSION_RPC_METHODS.SESSION_WORK_STATE_GET}`);
        expect(leave).toHaveBeenCalledWith("rpc:user-1:sess_1:execution.run.stream.start");
        expect(rpcMetricsMocks.recordRpcUnregistration).toHaveBeenCalledWith(`sess_1:${SESSION_RPC_METHODS.SESSION_WORK_STATE_GET}`);
        expect(rpcMetricsMocks.recordRpcUnregistration).toHaveBeenCalledWith("sess_1:execution.run.stream.start");
    });

    it.each(['usage.sources.discover', 'daemon.connectedServices.pools.selection.get'])(
        'discovers and forwards daemon read %s independently of UI reverse registrations', async (rpcMethod) => {
            machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null,
                installationId: 'installation-1', kind: 'persistent' });
            const method = `machine-1:${rpcMethod}`;
            const { io, addToRoom, createRoomAwareSocket } = createRoomAwareIo();
            // Socket.IO is the process boundary; server admission/discovery/forwarding stay real.
            const effect = vi.fn<RpcTargetEmitWithAck>(async () => 'daemon-read-result');
            const daemon = createRoomAwareSocket({ id: 'read-daemon', data: {
                clientType: 'machine-scoped', machineId: 'machine-1', verifiedMachineInstallationId: 'installation-1',
            }, timeout: () => ({ emitWithAck: effect }) });
            addToRoom(daemon.id, daemon);
            addToRoom(getMachineSocketRoom('user-1', 'machine-1'), daemon);
            registerSocketRpcHandlers({ userId: 'user-1', socket: daemon as unknown as Socket, io });
            await triggerSocketHandler(daemon, SOCKET_RPC_EVENTS.REGISTER, { method });

            const reader = createRoomAwareSocket({ id: 'read-client', data: { clientType: 'user-scoped' } });
            registerSocketRpcHandlers({ userId: 'user-1', socket: reader as unknown as Socket, io });
            const read = async () => {
                const ack = vi.fn();
                await triggerSocketHandler(reader, SOCKET_RPC_EVENTS.CALL, { method, params: 'read-request' }, ack);
                expect(ack).toHaveBeenCalledWith({ ok: true, result: 'daemon-read-result' });
            };
            await read();

            const reverseMethod = `machine-1:${currentUiContextReadClientRpcMethod()}`;
            machineFindFirstMock.mockClear();
            await triggerSocketHandler(reader, SOCKET_RPC_EVENTS.REGISTER, { method: reverseMethod });
            expect(machineFindFirstMock).not.toHaveBeenCalled();
            expect(daemon.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method: reverseMethod });
            await triggerSocketHandler(reader, SOCKET_RPC_EVENTS.UNREGISTER, { method: reverseMethod });
            await read();
            expect(effect).toHaveBeenCalledTimes(2);
        },
    );

    it("registers a mounted command inventory without per-method Machine availability reads and refuses revoked callers", async () => {
        const { io, addToRoom, createRoomAwareSocket } = createRoomAwareIo();
        const effect = vi.fn<RpcTargetEmitWithAck>(async () => "encrypted-page-result");
        const uiSocket = createRoomAwareSocket({ id: "page-ui", data: { clientType: "user-scoped" },
            timeout: () => ({ emitWithAck: effect }) });
        addToRoom(uiSocket.id, uiSocket);
        registerSocketRpcHandlers({ userId: "user-1", socket: uiSocket as unknown as Socket, io });
        machineFindFirstMock.mockClear();
        const methods = Array.from({ length: 90 }, (_, index) =>
            `machine-1:${currentUiContextCommandClientRpcMethod(`page-command-${index}`)}`);
        await Promise.all(methods.map(method => triggerSocketHandler(uiSocket, SOCKET_RPC_EVENTS.REGISTER, { method })));
        for (const method of methods) {
            expect(uiSocket.join).toHaveBeenCalledWith(`rpc:user-1:${method}`);
            expect(uiSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
        }
        expect(machineFindFirstMock).not.toHaveBeenCalled();

        machineFindFirstMock.mockResolvedValue({ revokedAt: new Date(1), replacedByMachineId: null });
        const daemon = createRoomAwareSocket({ id: "revoked-daemon", data: {
            clientType: "machine-scoped", machineId: "machine-1",
        } });
        addToRoom(getMachineSocketRoom("user-1", "machine-1"), daemon);
        registerSocketRpcHandlers({ userId: "user-1", socket: daemon as unknown as Socket, io });
        await triggerSocketHandler(daemon, SOCKET_RPC_EVENTS.REGISTER, { method: "machine-1:spawn-happy-session" });
        expect(daemon.join).not.toHaveBeenCalled();
        expect(daemon.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR,
            expect.objectContaining({ error: "Machine unavailable" }));
        const ack = vi.fn();
        await triggerSocketHandler(daemon, SOCKET_RPC_EVENTS.CALL, { method: methods[0], params: "encrypted-page-call" }, ack);
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effect).not.toHaveBeenCalled();
    });

    it.each([
        currentUiContextReadClientRpcMethod(),
        currentUiContextCommandClientRpcMethod("current-ui-command:fixture"),
    ])("routes mounted current-context method %s through the exact Account and Machine registration", async (rpcMethod) => {
        machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null,
            installationId: "installed-machine-1" });
        const method = `machine-1:${rpcMethod}`;
        const { io, addToRoom, createRoomAwareSocket } = createRoomAwareIo();
        const effect = vi.fn<RpcTargetEmitWithAck>(async (_event, request) => {
            expect(request).toMatchObject({ method, params: "encrypted-current-context" });
            return "encrypted-current-context-result";
        });
        const uiSocket = createRoomAwareSocket({
            id: "current-context-ui",
            data: { clientType: "user-scoped" },
            timeout: () => ({ emitWithAck: effect }),
        });
        const daemonSocket = createRoomAwareSocket({
            id: "current-context-daemon",
            data: { clientType: "machine-scoped", machineId: "machine-1",
                verifiedMachineInstallationId: "installed-machine-1" },
        });
        addToRoom(uiSocket.id, uiSocket);
        addToRoom(getMachineSocketRoom("user-1", "machine-1"), daemonSocket);
        registerSocketRpcHandlers({ userId: "user-1", socket: uiSocket as unknown as Socket, io });
        registerSocketRpcHandlers({ userId: "user-1", socket: daemonSocket as unknown as Socket, io });

        const noProvider = vi.fn();
        await triggerSocketHandler(daemonSocket, SOCKET_RPC_EVENTS.CALL, {
            method, params: "encrypted-current-context",
        }, noProvider);
        expect(noProvider).toHaveBeenCalledWith(expect.objectContaining({
            ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        }));
        expect(effect).not.toHaveBeenCalled();

        await triggerSocketHandler(uiSocket, SOCKET_RPC_EVENTS.REGISTER, { method });
        expect(daemonSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
        const routed = vi.fn();
        await triggerSocketHandler(daemonSocket, SOCKET_RPC_EVENTS.CALL, {
            method, params: "encrypted-current-context",
        }, routed);
        expect(routed).toHaveBeenCalledWith({ ok: true, result: "encrypted-current-context-result" });
        expect(effect).toHaveBeenCalledOnce();
    });

    it("keeps a re-registered current-context owner after its stale unregister leave settles", async () => {
        machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null,
            installationId: "installed-machine-1" });
        const method = `machine-1:${currentUiContextReadClientRpcMethod()}`;
        const room = `rpc:user-1:${method}`;
        const { io, rooms, addToRoom, createRoomAwareSocket } = createRoomAwareIo();
        const effect = vi.fn<RpcTargetEmitWithAck>(async () => "current-context-result");
        const uiSocket = createRoomAwareSocket({ id: "current-context-ui", data: { clientType: "user-scoped" },
            timeout: () => ({ emitWithAck: effect }) });
        const daemonSocket = createRoomAwareSocket({ id: "current-context-daemon", data: {
            clientType: "machine-scoped", machineId: "machine-1", verifiedMachineInstallationId: "installed-machine-1",
        } });
        addToRoom(uiSocket.id, uiSocket);
        addToRoom(getMachineSocketRoom("user-1", "machine-1"), daemonSocket);
        registerSocketRpcHandlers({ userId: "user-1", socket: uiSocket as unknown as Socket, io });
        registerSocketRpcHandlers({ userId: "user-1", socket: daemonSocket as unknown as Socket, io });
        await triggerSocketHandler(uiSocket, SOCKET_RPC_EVENTS.REGISTER, { method });

        let allowLeave!: () => void;
        const leaveAllowed = new Promise<void>((resolve) => { allowLeave = resolve; });
        let leaveStarted!: () => void;
        const leaveWasStarted = new Promise<void>((resolve) => { leaveStarted = resolve; });
        vi.mocked(uiSocket.leave).mockImplementation(async (leavingRoom: string) => {
            leaveStarted();
            await leaveAllowed;
            rooms.get(leavingRoom)?.delete(uiSocket);
        });
        daemonSocket.emit.mockClear();

        const unregistering = triggerSocketHandler(uiSocket, SOCKET_RPC_EVENTS.UNREGISTER, { method });
        await leaveWasStarted;
        await triggerSocketHandler(uiSocket, SOCKET_RPC_EVENTS.REGISTER, { method });
        allowLeave();
        await unregistering;

        expect(rooms.get(room)).toContain(uiSocket);
        expect(daemonSocket.emit).toHaveBeenLastCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
        const routed = vi.fn();
        await triggerSocketHandler(daemonSocket, SOCKET_RPC_EVENTS.CALL, {
            method, params: "encrypted-current-context",
        }, routed);
        expect(routed).toHaveBeenCalledWith({ ok: true, result: "current-context-result" });
    });

    it.each([RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME, 'ui.actions.contributed.execute', 'ui.actions.execute.v1',
        mountedWorkReadClientRpcMethod('session.work.get', 'work-lead'), mountedWorkReadClientRpcMethod('inbox.get')])("notifies the owning machine socket for %s registration, unregistration, or disconnect", async (rpcMethod) => {
        const { io, addToRoom, createRoomAwareSocket, emitToRoom } = createRoomAwareIo();
        const uiSocket = createRoomAwareSocket({
            id: "ui-socket",
            data: { clientType: "user-scoped" },
        });
        const daemonSocket = createRoomAwareSocket({
            id: "daemon-socket",
            data: { clientType: "machine-scoped", machineId: "machine-1" },
        });
        const otherMachineSocket = createRoomAwareSocket({
            id: "other-machine-socket",
            data: { clientType: "machine-scoped", machineId: "machine-2" },
        });
        const otherAccountMachineSocket = createRoomAwareSocket({
            id: "other-account-machine-socket",
            data: { clientType: "machine-scoped", machineId: "machine-1" },
        });
        addToRoom("machine:machine-1:user-1", daemonSocket);
        addToRoom("machine:machine-2:user-1", otherMachineSocket);
        addToRoom("machine:machine-1:user-2", otherAccountMachineSocket);
        const method = `machine-1:${rpcMethod}`;

        registerSocketRpcHandlers({ userId: "user-1", socket: uiSocket as any, io });
        registerSocketRpcHandlers({ userId: "user-1", socket: daemonSocket as any, io });

        await triggerSocketHandler(uiSocket, SOCKET_RPC_EVENTS.REGISTER, { method });

        expect(daemonSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
        expect(otherMachineSocket.emit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
        expect(otherAccountMachineSocket.emit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
        expect(emitToRoom).toHaveBeenCalledWith("machine:machine-1:user-1", SOCKET_RPC_EVENTS.REGISTERED, { method });

        await triggerSocketHandler(uiSocket, SOCKET_RPC_EVENTS.UNREGISTER, { method });

        expect(daemonSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.UNREGISTERED, { method });
        expect(otherMachineSocket.emit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.UNREGISTERED, { method });
        expect(otherAccountMachineSocket.emit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.UNREGISTERED, { method });

        daemonSocket.emit.mockClear();
        await triggerSocketHandler(uiSocket, SOCKET_RPC_EVENTS.REGISTER, { method });
        machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: "machine-current" });
        await triggerSocketHandler(uiSocket, "disconnect");

        expect(daemonSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.UNREGISTERED, { method });
    });

    it("does not tell a machine its client RPC went away when the cluster census itself failed", async () => {
        const { io, addToRoom, createRoomAwareSocket, fetchSockets } = createRoomAwareIo();
        const uiSocket = createRoomAwareSocket({ id: "ui-socket", data: { clientType: "user-scoped" } });
        const daemonSocket = createRoomAwareSocket({ id: "daemon-socket", data: { clientType: "machine-scoped", machineId: "machine-1" } });
        addToRoom("machine:machine-1:user-1", daemonSocket);
        const method = `machine-1:${RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME}`;
        registerSocketRpcHandlers({ userId: "user-1", socket: uiSocket as any, io });
        await triggerSocketHandler(uiSocket, SOCKET_RPC_EVENTS.REGISTER, { method });
        daemonSocket.emit.mockClear();

        // A census that threw (e.g. one Redis peer timing out) is unknown, not an empty room.
        fetchSockets.mockImplementationOnce(async () => { throw new Error("timeout reached: only 22 responses received out of 23"); });
        await triggerSocketHandler(uiSocket, SOCKET_RPC_EVENTS.UNREGISTER, { method });
        expect(daemonSocket.emit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.UNREGISTERED, { method });
    });

    it.each([RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME, 'ui.actions.contributed.execute', 'ui.actions.execute.v1',
        mountedWorkReadClientRpcMethod('session.work.get', 'work-lead'), mountedWorkReadClientRpcMethod('inbox.get')])("hydrates a reconnecting machine socket from existing %s registrations", async (rpcMethod) => {
        const { io, addToRoom, createRoomAwareSocket } = createRoomAwareIo();
        const uiSocket = createRoomAwareSocket({
            id: "ui-socket",
            data: { clientType: "user-scoped" },
        });
        const daemonSocket = createRoomAwareSocket({
            id: "daemon-reconnect-socket",
            data: { clientType: "machine-scoped", machineId: "machine-1" },
        });
        const method = `machine-1:${rpcMethod}`;
        for (let index = 0; index < 1_001; index++) {
            const unrelated = createRoomAwareSocket({ id: `unrelated-${index}`, data: { clientType: 'user-scoped' } });
            addToRoom('user:user-1', unrelated);
        }
        const transported: string[] = [];
        const read = io.in.bind(io);
        vi.spyOn(io, 'in').mockImplementation((room) => {
            const operator = read(room);
            const fetch = operator.fetchSockets.bind(operator);
            operator.fetchSockets = async () => {
                const sockets = await fetch();
                transported.push(...sockets.map(socket => socket.id));
                return sockets;
            };
            return operator;
        });
        addToRoom("user:user-1", uiSocket);
        addToRoom("machine:machine-1:user-1", daemonSocket);
        registerSocketRpcHandlers({ userId: "user-1", socket: uiSocket as any, io });

        await triggerSocketHandler(uiSocket, SOCKET_RPC_EVENTS.REGISTER, { method });
        uiSocket.emit.mockClear();
        daemonSocket.emit.mockClear();
        transported.length = 0;

        registerSocketRpcHandlers({ userId: "user-1", socket: daemonSocket as any, io });

        await vi.waitFor(() => {
            expect(daemonSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
        });
        expect(transported).toEqual(['ui-socket']);
    });

    it('keeps a different live method indexed when the previous last method retires during its join', async () => {
        const { io, rooms, addToRoom, createRoomAwareSocket } = createRoomAwareIo();
        const ui = createRoomAwareSocket({ id: 'ui-index-race', data: { clientType: 'user-scoped' } });
        const oldMethod = `machine-1:${RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME}`;
        const newMethod = `machine-1:${RPC_METHODS.UI_ACTION_EXECUTE}`;
        const indexRoom = buildMachineRpcAvailabilityRoom({ userId: 'user-1', machineId: 'machine-1' });
        registerSocketRpcHandlers({ userId: 'user-1', socket: ui as unknown as Socket, io });
        await triggerSocketHandler(ui, SOCKET_RPC_EVENTS.REGISTER, { method: oldMethod });
        // The real registration/unregistration owners run; only asynchronous adapter
        // completion is controlled to exercise a different-method interleaving.
        let interleaved = false;
        ui.join.mockImplementation(async (room: string) => {
            addToRoom(room, ui);
            if (room === indexRoom && !interleaved) {
                interleaved = true;
                await triggerSocketHandler(ui, SOCKET_RPC_EVENTS.UNREGISTER, { method: oldMethod });
            }
        });
        await triggerSocketHandler(ui, SOCKET_RPC_EVENTS.REGISTER, { method: newMethod });
        expect(ui.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method: newMethod });
        expect(rooms.get(indexRoom)?.has(ui)).toBe(true);
    });

    it('does not advertise a registration unregistered during its availability join', async () => {
        const { io, rooms, addToRoom, createRoomAwareSocket } = createRoomAwareIo();
        const ui = createRoomAwareSocket({ id: 'ui-same-method-race', data: { clientType: 'user-scoped' } });
        const daemon = createRoomAwareSocket({ id: 'daemon-same-method-race', data: { clientType: 'machine-scoped', machineId: 'machine-1' } });
        addToRoom(getMachineSocketRoom('user-1', 'machine-1'), daemon);
        const method = `machine-1:${RPC_METHODS.UI_ACTION_EXECUTE}`;
        const indexRoom = buildMachineRpcAvailabilityRoom({ userId: 'user-1', machineId: 'machine-1' });
        registerSocketRpcHandlers({ userId: 'user-1', socket: ui as unknown as Socket, io });
        ui.join.mockImplementation(async (room: string) => {
            addToRoom(room, ui);
            if (room === indexRoom) await triggerSocketHandler(ui, SOCKET_RPC_EVENTS.UNREGISTER, { method });
        });
        await triggerSocketHandler(ui, SOCKET_RPC_EVENTS.REGISTER, { method });
        expect(ui.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.UNREGISTERED, { method });
        expect(ui.emit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
        expect(daemon.emit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
        expect(rooms.get(`rpc:user-1:${method}`)?.has(ui)).not.toBe(true);
        expect(rooms.get(indexRoom)?.has(ui)).not.toBe(true);
    });

    it("rejects explicit Session stop from a shared editor before lifecycle dispatch", async () => {
        const socket = createFakeSocket({
            id: "caller-socket",
            data: { clientType: "user-scoped" },
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();
        const captureExplicitMachineStop = vi.fn();
        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io: {} as Server,
            sessionPublisherPresence: {
                captureExplicitMachineStop,
                finalizeExplicitMachineStop: vi.fn(),
                resolveProjectedCurrentPublisher: vi.fn(async () => null),
                isCurrentPublisherProjection: vi.fn(),
                runAsProjectedCurrentPublisher: vi.fn(),
            },
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
            params: "opaque-stop-request",
            authorization: { kind: "session.write", sessionId: "sess_1" },
        }, callback);

        expect(captureExplicitMachineStop).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        });
    });

    it("keeps requester Session ownership distinct from the shared Machine's Stop destination", async () => {
        const method = `machine-1:${RPC_METHODS.STOP_SESSION}`;
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        sessionFindFirstMock.mockImplementation(async ({ where }) => (
            where.id === "sess_1" && where.accountId === "user-1" ? { id: "sess_1" } : null
        ));
        const machine = {
            accountId: "custodian", revokedAt: null, replacedByMachineId: null,
            installationId: "installation-1", kind: "persistent",
            account: { id: "custodian", status: "active", encryptionMode: "plain" },
            accountGrants: [{ accountId: "user-1", accessLevel: "view",
                account: { id: "user-1", status: "active" } }],
        };
        machineFindFirstMock.mockResolvedValue(machine);
        // Prisma is the system boundary. The real binding/presence/admission owners
        // must find the requester's exact tuple, not a synthetic custodian tuple.
        accessKeyFindUniqueMock.mockImplementation(async (args) => {
            const key = (args as { where: { accountId_machineId_sessionId: {
                accountId: string; machineId: string; sessionId: string;
            } } }).where.accountId_machineId_sessionId;
            return key.accountId === "user-1" && key.machineId === "machine-1" && key.sessionId === "sess_1"
                ? { machineId: key.machineId, session: { accountId: "user-1" }, machine }
                : null;
        });
        // A raw reply has no lifecycle proof; this case isolates admission and
        // routing without mocking the presence owner's subsequent mutation path.
        const effect = vi.fn(async () => ({ status: "stopped" }));
        const target = { id: "custodian-daemon", data: { clientType: "machine-scoped",
            machineId: "machine-1", verifiedMachineInstallationId: "installation-1" },
            timeout: () => ({ emitWithAck: effect }) };
        const { io } = createTargetRoutingIo({ [`rpc:custodian:${method}`]: [target], [target.id]: [target] });
        const caller = createFakeSocket({ id: "requester", data: { clientType: "user-scoped" } });
        registerSocketRpcHandlers({ userId: "user-1", socket: caller as unknown as Socket, io,
            sessionPublisherPresence: createSessionPublisherPresence() });
        const acknowledge = vi.fn();
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method, params: "sealed-stop-request", authorization: { kind: "session.write", sessionId: "sess_1" },
        }, acknowledge);
        expect(acknowledge).toHaveBeenCalledWith({ ok: true, result: { status: "stopped" } });
        expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            machineAdmission: expect.objectContaining({ actorAccountId: "user-1", custodianAccountId: "custodian" }),
            authorization: { kind: "session.write", sessionId: "sess_1" },
        }));
    });

    it("does not let a wrong-machine responder author explicit stop proof", async () => {
        const method = `machine-1:${RPC_METHODS.STOP_SESSION}`;
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        const wrongMachineEffect = vi.fn().mockResolvedValue({
            v: 1,
            result: "opaque-stop-result",
            acknowledgement: { kind: "session.stop", status: "stopped" },
        });
        const wrongMachineTarget = {
            id: "wrong-machine-target",
            data: { clientType: "machine-scoped", machineId: "machine-2" },
            timeout: vi.fn(() => ({ emitWithAck: wrongMachineEffect })),
        };
        const { io } = createTargetRoutingIo({
            [`rpc:user-1:${method}`]: [wrongMachineTarget],
        });
        const caller = createFakeSocket({
            id: "caller-socket",
            data: { clientType: "user-scoped" },
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();
        const finalizeExplicitMachineStop = vi.fn(async () => ({ status: "already_inactive" as const }));
        const sessionPublisherPresence = {
            captureExplicitMachineStop: vi.fn(async () => ({
                status: "captured" as const,
                target: {
                    binding: { accountId: "user-1", machineId: "machine-1", sessionId: "sess_1" },
                    authority: { kind: "generation" as const, publisherGeneration: 1n },
                },
            })),
            finalizeExplicitMachineStop,
            resolveProjectedCurrentPublisher: vi.fn(async () => null),
            isCurrentPublisherProjection: vi.fn(),
            runAsProjectedCurrentPublisher: vi.fn(),
        };

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: caller as any,
            io,
            sessionPublisherPresence,
        });
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque-stop-request",
            authorization: { kind: "session.write", sessionId: "sess_1" },
        }, callback);

        expect(wrongMachineEffect).not.toHaveBeenCalled();
        expect(finalizeExplicitMachineStop).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "RPC target unavailable",
            errorCode: 'target_unavailable',
        });
    });

    it("forwards a legacy raw stopped result without granting lifecycle authority", async () => {
        const method = `machine-1:${RPC_METHODS.STOP_SESSION}`;
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        const rawStoppedResult = { status: "stopped" as const };
        const targetEffect = vi.fn().mockResolvedValue(rawStoppedResult);
        const target = {
            id: "machine-1-target",
            data: { clientType: "machine-scoped", machineId: "machine-1" },
            timeout: vi.fn(() => ({ emitWithAck: targetEffect })),
        };
        const { io } = createTargetRoutingIo({
            [`rpc:user-1:${method}`]: [target],
            "machine-1-target": [target],
        });
        const caller = createFakeSocket({
            id: "caller-socket",
            data: { clientType: "user-scoped" },
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();
        const finalizeExplicitMachineStop = vi.fn(async () => ({ status: "already_inactive" as const }));
        const sessionPublisherPresence = {
            captureExplicitMachineStop: vi.fn(async () => ({
                status: "captured" as const,
                target: {
                    binding: { accountId: "user-1", machineId: "machine-1", sessionId: "sess_1" },
                    authority: { kind: "generation" as const, publisherGeneration: 1n },
                },
            })),
            finalizeExplicitMachineStop,
            resolveProjectedCurrentPublisher: vi.fn(async () => null),
            isCurrentPublisherProjection: vi.fn(),
            runAsProjectedCurrentPublisher: vi.fn(),
        };

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: caller as any,
            io,
            sessionPublisherPresence,
        });
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque-stop-request",
            authorization: { kind: "session.write", sessionId: "sess_1" },
        }, callback);

        expect(targetEffect).toHaveBeenCalledTimes(1);
        expect(finalizeExplicitMachineStop).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({ ok: true, result: rawStoppedResult });
    });

    it("returns typed machine-control unavailability when the authorized session lacks the exact machine binding", async () => {
        const method = `machine-1:${RPC_METHODS.STOP_SESSION}`;
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        const targetEffect = vi.fn();
        const target = {
            id: "machine-1-target",
            data: { clientType: "machine-scoped", machineId: "machine-1" },
            timeout: vi.fn(() => ({ emitWithAck: targetEffect })),
        };
        const { io } = createTargetRoutingIo({
            [`rpc:user-1:${method}`]: [target],
            "machine-1-target": [target],
        });
        const caller = createFakeSocket({
            id: "caller-socket",
            data: { clientType: "user-scoped" },
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: caller as any,
            io,
            sessionPublisherPresence: {
                captureExplicitMachineStop: vi.fn(async () => ({
                    status: "rejected" as const,
                    reason: "machine_control_unavailable" as const,
                })),
                finalizeExplicitMachineStop: vi.fn(),
                resolveProjectedCurrentPublisher: vi.fn(async () => null),
                isCurrentPublisherProjection: vi.fn(),
                runAsProjectedCurrentPublisher: vi.fn(),
            },
        });
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque-stop-request",
            authorization: { kind: "session.write", sessionId: "sess_1" },
        }, callback);

        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Session machine control unavailable",
            errorCode: "RPC_SESSION_MACHINE_CONTROL_UNAVAILABLE",
        });
        expect(targetEffect).not.toHaveBeenCalled();
    });

    it("finalizes daemon-proven stop even when the caller omits its callback", async () => {
        const method = `machine-1:${RPC_METHODS.STOP_SESSION}`;
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        const targetEffect = vi.fn().mockResolvedValue({
            v: 1,
            result: "opaque-stop-result",
            acknowledgement: { kind: "session.stop", status: "stopped" },
        });
        const target = {
            id: "machine-1-target",
            data: { clientType: "machine-scoped", machineId: "machine-1" },
            timeout: vi.fn(() => ({ emitWithAck: targetEffect })),
        };
        const { io } = createTargetRoutingIo({
            [`rpc:user-1:${method}`]: [target],
            "machine-1-target": [target],
        });
        const caller = createFakeSocket({
            id: "caller-socket",
            data: { clientType: "user-scoped" },
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const finalizeExplicitMachineStop = vi.fn(async () => ({ status: "already_inactive" as const }));
        const sessionPublisherPresence = {
            captureExplicitMachineStop: vi.fn(async () => ({
                status: "captured" as const,
                target: {
                    binding: { accountId: "user-1", machineId: "machine-1", sessionId: "sess_1" },
                    authority: { kind: "generation" as const, publisherGeneration: 1n },
                },
            })),
            finalizeExplicitMachineStop,
            resolveProjectedCurrentPublisher: vi.fn(async () => null),
            isCurrentPublisherProjection: vi.fn(),
            runAsProjectedCurrentPublisher: vi.fn(),
        };

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: caller as any,
            io,
            sessionPublisherPresence,
        });
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque-stop-request",
            authorization: { kind: "session.write", sessionId: "sess_1" },
        });

        expect(targetEffect).toHaveBeenCalledTimes(1);
        expect(finalizeExplicitMachineStop).toHaveBeenCalledTimes(1);
    });

    it("routes model transition to the single DB-current publisher even when a stale socket sorts first", async () => {
        sessionFindUniqueMock.mockResolvedValue({ ...createOwnedSessionAccessRow(), publisherGeneration: 2n });
        const method = `sess_1:${SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION}`;
        const staleEmitWithAck = vi.fn().mockResolvedValue({ ok: true, status: "wrong-stale-result" });
        const exactResult = {
            ok: false,
            status: "restart_required",
            activeSelection: {
                agentTargetKey: "backend:codex",
                providerConnectionId: null,
                modelId: "old-model",
            },
            requestedSelection: {
                agentTargetKey: "backend:codex",
                providerConnectionId: null,
                modelId: "next-model",
            },
        } as const;
        const currentEmitWithAck = vi.fn().mockResolvedValue(exactResult);
        const staleTarget = {
            id: "a-stale",
            data: {
                sessionPublisherAuthority: {
                    v: 1,
                    accountId: "user-1",
                    machineId: "machine-stale",
                    sessionId: "sess_1",
                    committedFenceMs: 1,
                    publisherGeneration: "1",
                },
            },
            timeout: vi.fn(() => ({ emitWithAck: staleEmitWithAck })),
        };
        const currentTarget = {
            id: "z-current",
            data: {
                sessionPublisherAuthority: {
                    v: 1,
                    accountId: "user-1",
                    machineId: "machine-current",
                    sessionId: "sess_1",
                    committedFenceMs: 2,
                    publisherGeneration: "2",
                },
            },
            timeout: vi.fn(() => ({ emitWithAck: currentEmitWithAck })),
        };
        const refreshedCurrentTarget = {
            ...currentTarget,
            data: {
                sessionPublisherAuthority: {
                    ...currentTarget.data.sessionPublisherAuthority,
                    committedFenceMs: 3,
                },
            },
        };
        const { io, fetchSockets } = createTargetRoutingIo({
            [`rpc:user-1:${method}`]: [staleTarget, currentTarget],
            "z-current": [refreshedCurrentTarget],
        });
        const caller = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();
        const sessionPublisherPresence = {
            captureExplicitMachineStop: vi.fn(),
            finalizeExplicitMachineStop: vi.fn(),
            resolveProjectedCurrentPublisher: vi.fn(async () => null),
            isCurrentPublisherProjection: vi.fn(async (params: { projection: unknown }) => (
                (params.projection as { committedFenceMs?: unknown } | null)?.committedFenceMs === 2
            )),
            runAsProjectedCurrentPublisher: async <T>(params: {
                readLatestProjection: () => Promise<unknown>;
                operation: (authority: CurrentSessionPublisherAuthority) => Promise<T>;
            }): Promise<RunAsProjectedCurrentPublisherResult<T>> => {
                const value = await params.operation({
                    accountId: "user-1",
                    machineId: "machine-current",
                    sessionId: "sess_1",
                    committedFence: new Date(2),
                });
                const latest = await params.readLatestProjection();
                expect(latest).toMatchObject({ committedFenceMs: 3 });
                return { status: "current" as const, value };
            },
        };

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: caller as any,
            io,
            sessionPublisherPresence,
        });
        await triggerSocketHandler(
            caller,
            SOCKET_RPC_EVENTS.CALL,
            { method, params: "opaque-request" },
            callback,
        );

        expect(staleEmitWithAck).not.toHaveBeenCalled();
        expect(currentEmitWithAck).toHaveBeenCalledTimes(1);
        expect(fetchSockets).toHaveBeenCalledWith("z-current");
        expect(callback).toHaveBeenCalledWith({ ok: true, result: exactResult });
    });

    it.each([
        { name: "zero", currentFenceValues: [] as number[] },
        { name: "multiple", currentFenceValues: [1, 2] },
    ])("fails model transition closed when $name registered targets prove current", async ({ currentFenceValues }) => {
        // No Machine exists under this Session's namespace.
        machineFindFirstMock.mockResolvedValue(null);
        const method = `sess_1:${SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION}`;
        const firstEffect = vi.fn().mockResolvedValue({ ok: true, status: "wrong-first" });
        const secondEffect = vi.fn().mockResolvedValue({ ok: true, status: "wrong-second" });
        const target = (id: string, committedFenceMs: number, effect: typeof firstEffect) => ({
            id,
            data: {
                sessionPublisherAuthority: {
                    v: 1,
                    accountId: "user-1",
                    machineId: `machine-${id}`,
                    sessionId: "sess_1",
                    committedFenceMs,
                    publisherGeneration: String(committedFenceMs),
                },
            },
            timeout: vi.fn(() => ({ emitWithAck: effect })),
        });
        const { io } = createTargetRoutingIo({
            [`rpc:user-1:${method}`]: [
                target("a", 1, firstEffect),
                target("b", 2, secondEffect),
            ],
        });
        const caller = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();
        const sessionPublisherPresence = {
            captureExplicitMachineStop: vi.fn(),
            finalizeExplicitMachineStop: vi.fn(),
            resolveProjectedCurrentPublisher: vi.fn(async () => null),
            isCurrentPublisherProjection: vi.fn(async (params: { projection: unknown }) => currentFenceValues.includes(
                (params.projection as { committedFenceMs: number }).committedFenceMs,
            )),
            runAsProjectedCurrentPublisher: vi.fn(),
        };

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: caller as any,
            io,
            sessionPublisherPresence,
        });
        await triggerSocketHandler(
            caller,
            SOCKET_RPC_EVENTS.CALL,
            { method, params: "opaque-request" },
            callback,
        );

        expect(firstEffect).not.toHaveBeenCalled();
        expect(secondEffect).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "RPC target unavailable",
            errorCode: 'target_unavailable',
        });
    });

    it("reports an unknown model-transition outcome when post-effect publisher revalidation fails", async () => {
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        const method = `sess_1:${SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION}`;
        const effect = vi.fn().mockResolvedValue({ ok: true, status: "applied" });
        const target = {
            id: "current-target",
            data: {
                sessionPublisherAuthority: {
                    v: 1,
                    accountId: "user-1",
                    machineId: "machine-current",
                    sessionId: "sess_1",
                    committedFenceMs: 2,
                    publisherGeneration: "1",
                },
            },
            timeout: vi.fn(() => ({ emitWithAck: effect })),
        };
        const { io } = createTargetRoutingIo({
            [`rpc:user-1:${method}`]: [target],
            "current-target": [],
        });
        const caller = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();
        const sessionPublisherPresence = {
            captureExplicitMachineStop: vi.fn(),
            finalizeExplicitMachineStop: vi.fn(),
            resolveProjectedCurrentPublisher: vi.fn(async () => null),
            isCurrentPublisherProjection: vi.fn(async () => true),
            runAsProjectedCurrentPublisher: async <T>(params: {
                readLatestProjection: () => Promise<unknown>;
                operation: (authority: CurrentSessionPublisherAuthority) => Promise<T>;
            }): Promise<RunAsProjectedCurrentPublisherResult<T>> => {
                await params.operation({
                    accountId: "user-1",
                    machineId: "machine-current",
                    sessionId: "sess_1",
                    committedFence: new Date(2),
                });
                await params.readLatestProjection();
                return { status: "unavailable" as const };
            },
        };

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: caller as any,
            io,
            sessionPublisherPresence,
        });
        await triggerSocketHandler(
            caller,
            SOCKET_RPC_EVENTS.CALL,
            { method, params: "opaque-request" },
            callback,
        );

        expect(effect).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "RPC target changed after request submission",
            errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN,
        });
    });
});
