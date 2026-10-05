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
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
    uiBrowserAutomationDispatchMethod,
} from "@happier-dev/protocol";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import type { Server, Socket } from "socket.io";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSha256SecretDigest } from "@/app/auth/secretDigest";
import { auth } from "@/app/auth/auth";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { computeExternalActionSocketRpcRequestDigestV1, ExternalActionExecutionAuthorizationV1Schema } from "@happier-dev/protocol/actions";
import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";

import type {
    CurrentSessionPublisherAuthority,
    RunAsProjectedCurrentPublisherResult,
} from "@/app/presence/sessionPublisherPresence";

import { createFakeSocket as createSocketHarnessFake, triggerSocketHandler } from "../../testkit/socketHarness";
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from "../externalActionDispatcher";

type RpcTargetEmitWithAck = (
    event: string,
    request: Readonly<{ requestId?: string }>,
) => Promise<unknown>;

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

const machineFindFirstMock = vi.hoisted(() => vi.fn(async (): Promise<{ revokedAt: Date | null; replacedByMachineId: string | null; installationId?: string; installationPublicKey?: Uint8Array; kind?: string }> => ({
    revokedAt: null,
    replacedByMachineId: null,
})));
const accessKeyFindUniqueMock = vi.hoisted(() => vi.fn(async (): Promise<{ machineId?: string; accountId?: string; session?: { accountId: string }; machine?: { revokedAt: Date | null; replacedByMachineId: string | null } } | null> => ({
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

vi.mock("@/storage/db", () => {
    const databaseBoundary = {
        machine: { findFirst: machineFindFirstMock },
        account: { findUnique: accountFindUniqueMock },
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
        const socket = createFakeSocket({
            ...overrides,
            join: vi.fn(async (room: string) => addToRoom(room, socket)),
            leave: vi.fn(async (room: string) => removeFromRoom(room, socket)),
        } as any);
        return socket;
    };

    return { io, rooms, addToRoom, createRoomAwareSocket, emitToRoom, fetchSockets };
}

describe("registerSocketRpcHandlers", () => {
    const sessionActionOrigin = {
        v: 1, caller: { kind: 'session', sessionId: 'lead', starterDepth: 2, turnDepth: 4 },
        callerPermissionMode: 'read-only', sourceTurnId: 'turn-original', requestId: 'action-original', workspaceWrites: 'deny',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
    };
    async function createSessionActionFixture() {
        sessionFindUniqueMock.mockImplementation(async (args?: { where?: { id?: string } }) => createOwnedSessionAccessRow(args?.where?.id));
        accessKeyFindUniqueMock.mockResolvedValue({ session: { accountId: 'user-1' }, machine: { revokedAt: null, replacedByMachineId: null } });
        machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null, installationId: 'installation-source', kind: 'regular' });
        const source = createFakeSocket({ id: 'source-daemon', data: {
            clientType: 'machine-scoped', machineId: 'machine-source', authTokenKind: 'account', verifiedMachineInstallationId: 'installation-source',
        }, handshake: { auth: { token: await auth.createToken('user-1', undefined, { kind: 'account', authority: 'present_user' }) } } });
        const effect = vi.fn(async (_event: string, _request: unknown) => ({ updated: true }));
        const target = { id: 'target-runtime', data: { clientType: 'session-scoped', sessionPublisherAuthority: {
            v: 1, accountId: 'user-1', sessionId: 'report', machineId: 'machine-target', committedFenceMs: 2,
        } }, timeout: () => ({ emitWithAck: effect }) };
        const publisher = { data: { sessionPublisherAuthority: {
            v: 1, accountId: 'user-1', sessionId: 'lead', machineId: 'machine-source', committedFenceMs: 2,
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
                if (scenario === 'installation') machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: null, installationId: 'replacement', kind: 'regular' });
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
    it("admits UI browser automation only from the authenticated exact Machine", async () => {
        const method = `machine-1:${uiBrowserAutomationDispatchMethod({ browserSessionId: 'visible-session', viewId: 'visible-view' })}`;
        const effect = vi.fn(async () => 'encrypted-page-result');
        const target = { id: 'ui-view', data: { clientType: 'user-scoped' }, timeout: () => ({ emitWithAck: effect }) };
        const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target], [target.id]: [target] });
        for (const data of [
            { clientType: 'user-scoped' },
            { clientType: 'machine-scoped', machineId: 'machine-2' },
            { clientType: 'machine-scoped', machineId: 'machine-1' },
        ]) {
            const socket = createFakeSocket({ id: 'caller', data });
            registerSocketRpcHandlers({ userId: 'user-1', socket: socket as unknown as Socket, io });
            const ack = vi.fn();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: 'encrypted-admitted-action' }, ack);
            expect(ack).toHaveBeenCalledWith(data.machineId === 'machine-1'
                ? { ok: true, result: 'encrypted-page-result' }
                : { ok: false, error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN });
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
    function createTokenViewer(sessionId = "sess_1", approve = false, includePermission = false) {
        const credentialId = "00000000-0000-4000-8000-000000000001";
        const secret = "a".repeat(43);
        const principal = {
            accountId: "user-1", principalId: "user-1", credentialId,
            authority: "account_automation" as const, expiresAt: null,
            parentTokenId: null, embedConfig: null,
            grant: {
                v: 1, actions: { families: [], ids: ["session.transcript.get", "session.message.send", ...(includePermission ? ["session.permission.respond"] : [])] },
                targets: { sessions: [sessionId], machines: [] }, approve,
                origins: [], models: null, permissionModes: null, create: null,
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

    it("admits a viewer's declared message RPC but refuses another action sharing its input capability", async () => {
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
        const { socket, admission, principal, tokenRow } = createTokenViewer();
        const effect = vi.fn(async (_event: string, _request: Record<string, unknown>) => ({ success: true }));
        accessKeyFindUniqueMock.mockResolvedValue({ session: { accountId: 'user-1' }, machine: { revokedAt: null, replacedByMachineId: null } });
        const target = { id: "session-daemon", data: { clientType: "session-scoped",
            sessionPublisherAuthority: { v: 1, accountId: 'user-1', sessionId: 'sess_1', machineId: 'machine-current', committedFenceMs: 2 } }, timeout: () => {
                // Simulate a database grant update between ingress and target dispatch.
                apiTokenFindUniqueMock.mockResolvedValue({ ...tokenRow, accessGrant: { ...principal.grant, permissionModes: ['read-only'] } });
                return { emitWithAck: effect };
            } };
        const method = `sess_1:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`;
        const { io } = createTargetRoutingIo({ [`rpc:user-1:${method}`]: [target], [target.id]: [target] });
        registerSocketRpcHandlers({ userId: "user-1", socket: socket as unknown as Socket, io, ephemeralRunnerAdmission: admission,
            sessionPublisherPresence: createSessionPublisherPresence() });
        const accepted = vi.fn();
        const opaqueParams = 'session-ciphertext';
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: opaqueParams,
            callerInputAuthorization: { token: 'caller-forged' }, callerInputConstraints: { models: [], permissionModes: [] } }, accepted);
        expect(accepted).toHaveBeenCalledWith({ ok: true, result: { success: true } });
        const forwarded = effect.mock.calls[0]![1];
        const issued = ExternalActionExecutionAuthorizationV1Schema.parse(forwarded.callerInputAuthorization);
        expect(await auth.verifyExternalActionExecutionAuthorization(issued.token)).toEqual(issued.binding);
        expect(issued.binding).toMatchObject({ actionId: 'session.message.send', machineId: 'machine-current',
            credentialId: principal.credentialId, target: { kind: 'session', sessionId: 'sess_1' } });
        expect(issued.binding.requestId).toBe(forwarded.requestId);
        expect(issued.binding.grant.permissionModes).toEqual(['read-only']);
        expect(forwarded.callerInputConstraints).toEqual({ models: null, permissionModes: ['read-only'] });
        expect(issued.binding.requestEnvelopeDigest).toBe(computeExternalActionSocketRpcRequestDigestV1({
            method, params: opaqueParams, requestId: issued.binding.requestId, target: { kind: 'session', sessionId: 'sess_1' },
        }));
        const denied = vi.fn();
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method: `sess_1:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`, params: {} }, denied);
        expect(denied).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effect).toHaveBeenCalledOnce();
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
                machineId: "machine-1", committedFenceMs: 2 } }, timeout: () => ({ emitWithAck: effect }) };
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

    it("reserves the external Action relay method for an exact machine daemon and rejects client calls", async () => {
        const method = `machine-1:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`;
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

    it("reserves the Session server-start method for a proof-attested exact machine daemon and rejects client calls", async () => {
        const method = `machine-1:${SESSION_SERVER_START_DAEMON_RPC_METHOD_V1}`;
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

    it("rejects RPC registration from a replaced machine-scoped socket", async () => {
        machineFindFirstMock.mockResolvedValue({ revokedAt: null, replacedByMachineId: "machine-current" });
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
            error: "Machine replaced",
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
        accessKeyFindUniqueMock.mockResolvedValue({
            machineId: "machine-old",
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
            select: {
                machineId: true,
                machine: { select: { revokedAt: true, replacedByMachineId: true } },
            },
        }));
        expect(join).not.toHaveBeenCalled();
expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
            type: "register",
            error: "Forbidden",
        }));
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
        expect(target.timeout).toHaveBeenCalledWith(30000);
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

    it("keeps execution-run input forwarding under the caller lifecycle", async () => {
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
        }, callback);

        expect(target.timeout).toHaveBeenCalledWith(2_147_483_647);
        expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            method,
            timeoutMs: 2_147_483_647,
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

    it("forwards only the server-stamped actor for a permission decision", async () => {
        sessionShareFindUniqueMock.mockResolvedValue({
            id: "share-1",
            sharedWithUserId: "shared-user",
            accessLevel: "edit",
            canApprovePermissions: true,
        });
        const targetEmitWithAck = vi.fn().mockResolvedValue({ ok: true });
        const target = {
            id: "target-socket",
            timeout: vi.fn(() => ({
                emitWithAck: targetEmitWithAck,
            })),
        };
        const { io } = createIo({
            targetsByRoom: {
                "rpc:session-owner:sess_1:session.permission.respond": [target],
            },
        });
        const socket = createFakeSocket({
            id: "caller-socket",
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
        };

        registerSocketRpcHandlers({
            userId: "shared-user",
            socket: socket as any,
            io,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, {
            method: "sess_1:session.permission.respond",
            params: { id: "request-1", approved: true },
            authorization: {
                kind: "session.permission.respond",
                sessionId: "sess_1",
                actor: {
                    kind: "accountUser",
                    accountId: "forged-account",
                    relationship: "owner",
                },
            },
        });

        expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
            method: "sess_1:session.permission.respond",
            params: { id: "request-1", approved: true },
            callerAuthority: "present_user",
            timeoutMs: 30000,
            authorization: stampedAuthorization,
        });
    });

    it("routes collaborator Run start to the owner daemon but keeps privileged Run controls owner-only", async () => {
        const targetEmitWithAck = vi.fn().mockResolvedValue({ ok: true });
        const target = {
            id: "target-socket",
            timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
        };
        const startMethod = `sess_1:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`;
        const { io, inMock } = createIo({
            targetsByRoom: {
                [`rpc:session-owner:${startMethod}`]: [target],
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

        for (const method of [
            SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
            SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
            SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
            SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1,
            SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
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
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
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

    it("rejects session-runner restart RPCs without edit authorization before forwarding", async () => {
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
                method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`,
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
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
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
        accessKeyFindUniqueMock.mockResolvedValue({
            machineId: "machine-old",
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
            select: {
                machineId: true,
                machine: { select: { revokedAt: true, replacedByMachineId: true } },
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

    it.each([RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME, 'ui.actions.contributed.execute', 'ui.actions.execute.v1'])("notifies the owning machine socket for %s registration, unregistration, or disconnect", async (rpcMethod) => {
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

    it.each([RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME, 'ui.actions.contributed.execute', 'ui.actions.execute.v1'])("hydrates a reconnecting machine socket from existing %s registrations", async (rpcMethod) => {
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
        addToRoom("user:user-1", uiSocket);
        addToRoom("machine:machine-1:user-1", daemonSocket);
        registerSocketRpcHandlers({ userId: "user-1", socket: uiSocket as any, io });

        await triggerSocketHandler(uiSocket, SOCKET_RPC_EVENTS.REGISTER, { method });
        uiSocket.emit.mockClear();
        daemonSocket.emit.mockClear();

        registerSocketRpcHandlers({ userId: "user-1", socket: daemonSocket as any, io });

        await vi.waitFor(() => {
            expect(daemonSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
        });
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
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
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
        sessionFindUniqueMock.mockResolvedValue(createOwnedSessionAccessRow());
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
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    });

    it("suppresses a model-transition result when post-effect publisher revalidation fails", async () => {
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
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    });
});
