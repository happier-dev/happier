import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import type { Server, Socket } from "socket.io";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSocket, triggerSocketHandler } from "../testkit/socketHarness";

const createRpcRedisRegistryCoordinatorMock = vi.fn();
const resolveRpcCallTargetMock = vi.fn();
const resolveRpcMethodAvailabilityGraceMsMock = vi.fn<(method: string) => number>(() => 0);
const resolveRpcMethodAvailabilityPollMsMock = vi.fn<() => number>(() => 1);
const checkSessionAccessMock = vi.hoisted(() => vi.fn());
const requireAccessLevelMock = vi.hoisted(() => vi.fn());
const resolveRpcForwardTimeoutMsMock = vi.hoisted(() => vi.fn<(method: string, requestedTimeoutMs?: unknown) => number>(() => 50));
const dbMockFns = vi.hoisted(() => ({
    machineFindFirst: vi.fn(async (): Promise<{ revokedAt: Date | null; replacedByMachineId: string | null }> => ({
        revokedAt: null,
        replacedByMachineId: null,
    })),
    sessionFindUnique: vi.fn(),
}));

vi.mock("@/utils/logging/log", () => ({
    log: vi.fn(),
    warn: vi.fn(),
}));

vi.mock("./rpcForwardTimeout", () => ({
    resolveRpcForwardTimeoutMs: (method: string, requestedTimeoutMs?: unknown) =>
        resolveRpcForwardTimeoutMsMock(method, requestedTimeoutMs),
}));

vi.mock("./rpcMethodAvailabilityGrace", () => ({
    resolveRpcMethodAvailabilityGraceMs: (method: string) => resolveRpcMethodAvailabilityGraceMsMock(method),
    resolveRpcMethodAvailabilityPollMs: () => resolveRpcMethodAvailabilityPollMsMock(),
}));

vi.mock("./resolveRpcCallTarget", () => ({
    resolveRpcCallTarget: (...args: unknown[]) => resolveRpcCallTargetMock(...args),
}));

vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess: (...args: unknown[]) => checkSessionAccessMock(...args),
    requireAccessLevel: (...args: unknown[]) => requireAccessLevelMock(...args),
}));

vi.mock("./rpcRedisRegistryCoordinator", () => ({
    createRpcRedisRegistryCoordinator: (...args: unknown[]) => createRpcRedisRegistryCoordinatorMock(...args),
}));

vi.mock("@/storage/db", () => ({
    db: {
        machine: { findFirst: dbMockFns.machineFindFirst },
        session: { findUnique: dbMockFns.sessionFindUnique },
    },
}));

import { rpcHandler } from "./rpcHandler";

function createRedisCoordinator(overrides: Record<string, unknown> = {}) {
    return {
        enabled: false,
        registerMethod: vi.fn().mockResolvedValue(undefined),
        unregisterMethod: vi.fn().mockResolvedValue(undefined),
        lookupSocketId: vi.fn().mockResolvedValue(null),
        unregisterAll: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function createSocket(params: { id: string; emitWithAck?: ReturnType<typeof vi.fn>; data?: Record<string, unknown> }) {
    const emitWithAck = params.emitWithAck ?? vi.fn().mockResolvedValue(undefined);
    return createFakeSocket({
        id: params.id,
        ...(params.data !== undefined ? { data: params.data } : {}),
        emit: vi.fn(),
        timeout: vi.fn(() => ({
            emitWithAck,
        })),
    });
}

describe("rpcHandler", () => {
    beforeEach(() => {
        createRpcRedisRegistryCoordinatorMock.mockReset();
        resolveRpcCallTargetMock.mockReset();
        resolveRpcMethodAvailabilityGraceMsMock.mockReset();
        resolveRpcMethodAvailabilityGraceMsMock.mockReturnValue(0);
        resolveRpcMethodAvailabilityPollMsMock.mockReset();
        resolveRpcMethodAvailabilityPollMsMock.mockReturnValue(1);
        checkSessionAccessMock.mockReset();
        requireAccessLevelMock.mockReset();
        requireAccessLevelMock.mockReturnValue(true);
        resolveRpcForwardTimeoutMsMock.mockReset();
        resolveRpcForwardTimeoutMsMock.mockReturnValue(50);
        dbMockFns.machineFindFirst.mockReset();
        dbMockFns.machineFindFirst.mockResolvedValue({ revokedAt: null, replacedByMachineId: null });
        dbMockFns.sessionFindUnique.mockReset();
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    it("rejects session-prefixed RPC registration when the socket lacks machine-bound session proof", async () => {
        const redisCoordinator = createRedisCoordinator();
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);

        const socket = createSocket({
            id: "socket-1",
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: "sess_1",
                    proof: "owner-session",
                    machineId: null,
                },
            },
        });
        const userRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>();

        rpcHandler("user-1", socket as unknown as Socket, userRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: "sess_1:execution.run.stream.start" });

        expect(userRpcListeners.size).toBe(0);
        expect(redisCoordinator.registerMethod).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.ERROR,
            expect.objectContaining({ type: "register", error: "Forbidden" }),
        );
    });

    it("rejects session-prefixed RPC registration for a different session namespace", async () => {
        const redisCoordinator = createRedisCoordinator();
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);

        const socket = createSocket({
            id: "socket-1",
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: "sess_1",
                    proof: "machine-access-key",
                    machineId: "machine-1",
                },
            },
        });
        const userRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>();

        rpcHandler("user-1", socket as unknown as Socket, userRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: "sess_2:execution.run.stream.start" });

        expect(userRpcListeners.size).toBe(0);
        expect(redisCoordinator.registerMethod).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.ERROR,
            expect.objectContaining({ type: "register", error: "Forbidden" }),
        );
    });

    it("rejects RPC registration when the method name exceeds the bounded maximum length", async () => {
        const redisCoordinator = createRedisCoordinator();
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);

        const socket = createSocket({ id: "socket-1" });
        const userRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>();

        rpcHandler("user-1", socket as unknown as Socket, userRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: "m".repeat(513) });

        expect(userRpcListeners.size).toBe(0);
        expect(redisCoordinator.registerMethod).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.ERROR,
            expect.objectContaining({ type: "register", error: "Invalid method name" }),
        );
    });

    it("rejects RPC registration from a replaced machine-scoped socket", async () => {
        const redisCoordinator = createRedisCoordinator();
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);
        dbMockFns.machineFindFirst.mockResolvedValueOnce({ revokedAt: null, replacedByMachineId: "machine-current" });

        const socket = createSocket({
            id: "socket-1",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-old",
            },
        });
        const userRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>();

        rpcHandler("user-1", socket as unknown as Socket, userRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: "machine-old:spawn-happy-session" });

        expect(dbMockFns.machineFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: "user-1", id: "machine-old" },
            select: { revokedAt: true, replacedByMachineId: true },
        }));
        expect(userRpcListeners.size).toBe(0);
        expect(redisCoordinator.registerMethod).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.ERROR,
            expect.objectContaining({ type: "register", error: "Machine replaced" }),
        );
    });
    it("prunes an empty per-user listener map after unregister and reattaches it on the next registration", async () => {
        const redisCoordinator = createRedisCoordinator();
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);

        const socket = createSocket({ id: "socket-1" });
        const userRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>([["user-1", userRpcListeners]]);

        rpcHandler("user-1", socket as unknown as Socket, userRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: "agent.run" });
        expect(allRpcListeners.get("user-1")).toBe(userRpcListeners);

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.UNREGISTER, { method: "agent.run" });

        expect(userRpcListeners.size).toBe(0);
        expect(allRpcListeners.has("user-1")).toBe(false);

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: "agent.run" });

        expect(allRpcListeners.get("user-1")).toBe(userRpcListeners);
        expect(userRpcListeners.get("agent.run")).toBe(socket);
    });

    it("routes same-user RPCs through the reattached listener map after prune and re-register", async () => {
        const redisCoordinator = createRedisCoordinator();
        createRpcRedisRegistryCoordinatorMock
            .mockReturnValueOnce(redisCoordinator)
            .mockReturnValueOnce(redisCoordinator);

        const firstSocket = createSocket({ id: "socket-1" });
        const firstUserRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>([["user-1", firstUserRpcListeners]]);

        rpcHandler("user-1", firstSocket as unknown as Socket, firstUserRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await triggerSocketHandler(firstSocket, SOCKET_RPC_EVENTS.REGISTER, { method: "agent.run" });
        await triggerSocketHandler(firstSocket, SOCKET_RPC_EVENTS.UNREGISTER, { method: "agent.run" });

        const secondSocket = createSocket({
            id: "socket-2",
            emitWithAck: vi.fn().mockResolvedValue({ ok: true }),
        });
        const secondUserRpcListeners = new Map<string, Socket>();

        rpcHandler("user-1", secondSocket as unknown as Socket, secondUserRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await triggerSocketHandler(secondSocket, SOCKET_RPC_EVENTS.REGISTER, { method: "agent.run" });

        resolveRpcCallTargetMock.mockResolvedValue({
            targetUserId: "user-1",
            targetSocket: null,
        });

        const callback = vi.fn();
        await triggerSocketHandler(firstSocket, SOCKET_RPC_EVENTS.CALL, { method: "agent.run", params: {} }, callback);

        expect(secondSocket.timeout).toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({ ok: true, result: { ok: true } });
    });

    it("rejects session-runner restart RPCs without edit authorization before forwarding", async () => {
        const redisCoordinator = createRedisCoordinator();
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);

        const callerSocket = createSocket({ id: "caller-socket" });
        const targetSocket = createSocket({
            id: "target-socket",
            emitWithAck: vi.fn().mockResolvedValue({ ok: true }),
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
            },
        });
        const method = `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`;
        const userRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>([
            ["user-1", new Map<string, Socket>([[method, targetSocket as unknown as Socket]])],
        ]);
        const callback = vi.fn();
        resolveRpcCallTargetMock.mockResolvedValue({
            targetUserId: "user-1",
            targetSocket,
        });
        checkSessionAccessMock.mockResolvedValue({
            userId: "user-1",
            sessionId: "s1",
            level: "view",
            isOwner: false,
        });
        requireAccessLevelMock.mockReturnValue(false);

        rpcHandler("user-1", callerSocket as unknown as Socket, userRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await triggerSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "encrypted-payload",
            authorization: { kind: "session.write", sessionId: "s1" },
        }, callback);

        expect(checkSessionAccessMock).toHaveBeenCalledWith("user-1", "s1");
        expect(requireAccessLevelMock).toHaveBeenCalledWith(expect.objectContaining({ level: "view" }), "edit");
        expect(targetSocket.timeout).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        });
    });

    it("forwards session-runner restart RPC authorization after edit access succeeds", async () => {
        const redisCoordinator = createRedisCoordinator();
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);

        const callerSocket = createSocket({ id: "caller-socket" });
        const targetEmitWithAck = vi.fn().mockResolvedValue({ ok: true, restarted: true });
        const targetSocket = createSocket({
            id: "target-socket",
            emitWithAck: targetEmitWithAck,
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
            },
        });
        const method = `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`;
        const userRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>([
            ["user-1", new Map<string, Socket>([[method, targetSocket as unknown as Socket]])],
        ]);
        const callback = vi.fn();
        resolveRpcCallTargetMock.mockResolvedValue({
            targetUserId: "user-1",
            targetSocket,
        });
        checkSessionAccessMock.mockResolvedValue({
            userId: "user-1",
            sessionId: "s1",
            level: "edit",
            isOwner: true,
        });
        requireAccessLevelMock.mockReturnValue(true);

        rpcHandler("user-1", callerSocket as unknown as Socket, userRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await triggerSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "encrypted-payload",
            authorization: { kind: "session.write", sessionId: " s1 " },
        }, callback);

        expect(checkSessionAccessMock).toHaveBeenCalledWith("user-1", "s1");
        expect(requireAccessLevelMock).toHaveBeenCalledWith(expect.objectContaining({ level: "edit" }), "edit");
        expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
            method,
            params: "encrypted-payload",
            authorization: { kind: "session.write", sessionId: "s1" },
        });
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { ok: true, restarted: true },
        });
    });

    it("rejects a Session Agent transition that carries no edit proof before forwarding", async () => {
        const redisCoordinator = createRedisCoordinator();
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);

        const callerSocket = createSocket({ id: "caller-socket" });
        const targetSocket = createSocket({
            id: "target-socket",
            emitWithAck: vi.fn().mockResolvedValue({ ok: true }),
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
            },
        });
        const method = `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`;
        const userRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>([
            ["user-1", new Map<string, Socket>([[method, targetSocket as unknown as Socket]])],
        ]);
        const callback = vi.fn();
        resolveRpcCallTargetMock.mockResolvedValue({
            targetUserId: "user-1",
            targetSocket,
        });

        rpcHandler("user-1", callerSocket as unknown as Socket, userRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await triggerSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "encrypted-payload",
        }, callback);

        expect(checkSessionAccessMock).not.toHaveBeenCalled();
        expect(targetSocket.timeout).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        });
    });

    it("rejects a Session Agent transition from a collaborator without edit access", async () => {
        const redisCoordinator = createRedisCoordinator();
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);

        const callerSocket = createSocket({ id: "caller-socket" });
        const targetSocket = createSocket({
            id: "target-socket",
            emitWithAck: vi.fn().mockResolvedValue({ ok: true }),
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
            },
        });
        const method = `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`;
        const userRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>([
            ["user-1", new Map<string, Socket>([[method, targetSocket as unknown as Socket]])],
        ]);
        const callback = vi.fn();
        resolveRpcCallTargetMock.mockResolvedValue({
            targetUserId: "user-1",
            targetSocket,
        });
        checkSessionAccessMock.mockResolvedValue({
            userId: "user-1",
            sessionId: "s1",
            level: "view",
            isOwner: false,
        });
        requireAccessLevelMock.mockReturnValue(false);

        rpcHandler("user-1", callerSocket as unknown as Socket, userRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await triggerSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "encrypted-payload",
            authorization: { kind: "session.write", sessionId: "s1" },
        }, callback);

        expect(checkSessionAccessMock).toHaveBeenCalledWith("user-1", "s1");
        expect(requireAccessLevelMock).toHaveBeenCalledWith(expect.objectContaining({ level: "view" }), "edit");
        expect(targetSocket.timeout).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        });
    });

    it("forwards a Session Agent transition with its edit proof so the daemon can bind it to the payload", async () => {
        const redisCoordinator = createRedisCoordinator();
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);

        const callerSocket = createSocket({ id: "caller-socket" });
        const targetEmitWithAck = vi.fn().mockResolvedValue({ type: "accepted", localId: "local-1" });
        const targetSocket = createSocket({
            id: "target-socket",
            emitWithAck: targetEmitWithAck,
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
            },
        });
        const method = `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`;
        const userRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>([
            ["user-1", new Map<string, Socket>([[method, targetSocket as unknown as Socket]])],
        ]);
        const callback = vi.fn();
        resolveRpcCallTargetMock.mockResolvedValue({
            targetUserId: "user-1",
            targetSocket,
        });
        checkSessionAccessMock.mockResolvedValue({
            userId: "user-1",
            sessionId: "s1",
            level: "edit",
            isOwner: true,
        });
        requireAccessLevelMock.mockReturnValue(true);

        rpcHandler("user-1", callerSocket as unknown as Socket, userRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await triggerSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "encrypted-payload",
            authorization: { kind: "session.write", sessionId: " s1 " },
        }, callback);

        expect(checkSessionAccessMock).toHaveBeenCalledWith("user-1", "s1");
        expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
            method,
            params: "encrypted-payload",
            authorization: { kind: "session.write", sessionId: "s1" },
        });
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { type: "accepted", localId: "local-1" },
        });
    });

    it("does not let an older socket overwrite a newer per-user listener map on later register", async () => {
        const redisCoordinator = createRedisCoordinator();
        createRpcRedisRegistryCoordinatorMock
            .mockReturnValueOnce(redisCoordinator)
            .mockReturnValueOnce(redisCoordinator);

        const firstSocket = createSocket({ id: "socket-1" });
        const initialUserRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>([["user-1", initialUserRpcListeners]]);

        rpcHandler("user-1", firstSocket as unknown as Socket, initialUserRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await triggerSocketHandler(firstSocket, SOCKET_RPC_EVENTS.REGISTER, { method: "agent.old" });
        await triggerSocketHandler(firstSocket, SOCKET_RPC_EVENTS.UNREGISTER, { method: "agent.old" });

        const secondSocket = createSocket({ id: "socket-2" });
        const secondUserRpcListeners = new Map<string, Socket>();
        rpcHandler("user-1", secondSocket as unknown as Socket, secondUserRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await triggerSocketHandler(secondSocket, SOCKET_RPC_EVENTS.REGISTER, { method: "agent.new" });
        await triggerSocketHandler(firstSocket, SOCKET_RPC_EVENTS.REGISTER, { method: "agent.old" });

        const activeMap = allRpcListeners.get("user-1");
        expect(activeMap).toBeTruthy();
        expect(activeMap?.get("agent.new")).toBe(secondSocket);
        expect(activeMap?.get("agent.old")).toBe(firstSocket);
    });

    it("prunes an empty per-user listener map when the owning socket disconnects", async () => {
        const redisCoordinator = createRedisCoordinator();
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);

        const socket = createSocket({ id: "socket-1" });
        const userRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>([["user-1", userRpcListeners]]);

        rpcHandler("user-1", socket as unknown as Socket, userRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: "agent.run" });
        await triggerSocketHandler(socket, "disconnect");

        expect(userRpcListeners.size).toBe(0);
        expect(allRpcListeners.has("user-1")).toBe(false);
    });

    it("cancels the issuing socket's in-flight target request when that caller disconnects", async () => {
        const redisCoordinator = createRedisCoordinator();
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);
        let resolveTarget!: (value: unknown) => void;
        const targetEmitWithAck = vi.fn((_event: string, _request: { requestId?: string }) => new Promise<unknown>((resolve) => {
            resolveTarget = resolve;
        }));
        const targetSocket = createSocket({ id: "target-socket", emitWithAck: targetEmitWithAck });
        const callerSocket = createSocket({ id: "caller-socket" });
        const targetCancelEmit = vi.fn();
        const io = {
            to: vi.fn(() => ({ emit: targetCancelEmit })),
        };
        const callback = vi.fn();
        resolveRpcCallTargetMock.mockResolvedValue({
            targetUserId: "user-1",
            targetSocket,
        });

        rpcHandler("user-1", callerSocket as unknown as Socket, new Map(), new Map(), {
            io: io as unknown as Server,
            redisRegistry: { enabled: false },
        });

        const call = triggerSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL, {
            method: "agent.run",
            params: {},
            requestId: "caller-request-1",
        }, callback);
        await vi.waitFor(() => expect(targetEmitWithAck).toHaveBeenCalledTimes(1));
        const targetRequestId = targetEmitWithAck.mock.calls[0]?.[1]?.requestId;
        expect(targetRequestId).toEqual(expect.any(String));
        expect(targetRequestId).not.toBe("caller-request-1");

        await triggerSocketHandler(callerSocket, "disconnect");

        expect(io.to).toHaveBeenCalledWith("target-socket");
        expect(targetCancelEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CANCEL, {
            requestId: targetRequestId,
        });
        await expect(call).resolves.toBeUndefined();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "RPC request cancelled by caller",
        });
        resolveTarget({ ok: true });
    });

    it("forwards an explicit caller cancellation and releases its correlation for reuse", async () => {
        const redisCoordinator = createRedisCoordinator();
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);
        const pendingTargetResolvers: Array<(value: unknown) => void> = [];
        const targetEmitWithAck = vi.fn((_event: string, _request: { requestId?: string }) => new Promise<unknown>((resolve) => {
            pendingTargetResolvers.push(resolve);
        }));
        const targetSocket = createSocket({ id: "target-socket", emitWithAck: targetEmitWithAck });
        const callerSocket = createSocket({ id: "caller-socket" });
        const targetCancelEmit = vi.fn();
        const io = {
            to: vi.fn(() => ({ emit: targetCancelEmit })),
        };
        const firstCallback = vi.fn();
        const secondCallback = vi.fn();
        resolveRpcCallTargetMock.mockResolvedValue({
            targetUserId: "user-1",
            targetSocket,
        });

        rpcHandler("user-1", callerSocket as unknown as Socket, new Map(), new Map(), {
            io: io as unknown as Server,
            redisRegistry: { enabled: false },
        });

        const firstCall = triggerSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL, {
            method: "machine-1:spawn-happy-session",
            params: "encrypted-request",
            requestId: "caller-request-1",
        }, firstCallback);
        await vi.waitFor(() => expect(targetEmitWithAck).toHaveBeenCalledTimes(1));
        const firstTargetRequestId = targetEmitWithAck.mock.calls[0]?.[1]?.requestId;

        await triggerSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CANCEL, {
            requestId: "caller-request-1",
        });

        expect(targetCancelEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CANCEL, {
            requestId: firstTargetRequestId,
        });
        await expect(firstCall).resolves.toBeUndefined();
        expect(firstCallback).toHaveBeenCalledWith({
            ok: false,
            error: "RPC request cancelled by caller",
        });

        const secondCall = triggerSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL, {
            method: "machine-1:spawn-happy-session",
            params: "encrypted-request",
            requestId: "caller-request-1",
        }, secondCallback);
        await vi.waitFor(() => expect(targetEmitWithAck).toHaveBeenCalledTimes(2));
        pendingTargetResolvers[1]?.({ ok: true });
        await expect(secondCall).resolves.toBeUndefined();
        expect(secondCallback).toHaveBeenCalledWith({ ok: true, result: { ok: true } });

        pendingTargetResolvers[0]?.({ ok: true });
    });

    it("forwards the resolver-selected caller-lifecycle timeout without another relay deadline", async () => {
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(createRedisCoordinator());
        const relayTimeoutMs = 2_147_483_647;
        resolveRpcForwardTimeoutMsMock.mockReturnValue(relayTimeoutMs);
        const method = "agent.run";
        const targetEmitWithAck = vi.fn().mockResolvedValue({ ok: true });
        const targetSocket = createSocket({ id: "target-socket", emitWithAck: targetEmitWithAck });
        const callerSocket = createSocket({ id: "caller-socket" });
        const callback = vi.fn();
        resolveRpcCallTargetMock.mockResolvedValue({ targetUserId: "user-1", targetSocket });
        rpcHandler("user-1", callerSocket as unknown as Socket, new Map(), new Map(), {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });
        await triggerSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: {},
        }, callback);

        expect(resolveRpcForwardTimeoutMsMock).toHaveBeenCalledWith(method, undefined);
        expect(targetSocket.timeout).toHaveBeenCalledWith(relayTimeoutMs);
        expect(targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({ method }));
        expect(callback).toHaveBeenCalledWith({ ok: true, result: { ok: true } });
    });

    it.each([false, true])("surfaces public delegated target failures on the outer response (redis=%s)", async (redisEnabled) => {
        const publicFailure = {
            type: "socket-rpc-target-failure-v1",
            errorCode: "STRUCTURED_QUESTION_RECEIVER_NOT_OWNER",
            error: "This answer could not be handled safely. Update or reconnect Happier, then try again.",
        };
        const targetSocket = createSocket({
            id: "target-socket",
            emitWithAck: vi.fn().mockResolvedValue(publicFailure),
            data: { clientType: "user-scoped" },
        });
        const redisCoordinator = createRedisCoordinator({
            enabled: redisEnabled,
            lookupSocketId: vi.fn().mockResolvedValue(redisEnabled ? "target-socket" : null),
        });
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);
        resolveRpcCallTargetMock.mockResolvedValue({
            targetUserId: "owner",
            targetSocket: redisEnabled ? null : targetSocket,
        });
        const io = {
            timeout: vi.fn(() => ({
                to: vi.fn(() => ({ emitWithAck: vi.fn().mockResolvedValue([publicFailure]) })),
            })),
        };
        const caller = createSocket({ id: "caller" });
        const callback = vi.fn();
        rpcHandler("delegate", caller as unknown as Socket, new Map(), new Map(), {
            io: io as unknown as Server,
            redisRegistry: redisEnabled ? { enabled: true, instanceId: "instance" } : { enabled: false },
        });

        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method: "session-1:session.structuredQuestion.respond.v1",
            params: "encrypted-private-payload",
        }, callback);

        expect(callback).toHaveBeenCalledWith({
            ok: false,
            errorCode: publicFailure.errorCode,
            error: publicFailure.error,
        });
        expect(JSON.stringify(callback.mock.calls)).not.toContain("encrypted-private-payload");
    });
});
