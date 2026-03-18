import { RPC_ERROR_CODES } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import type { Server, Socket } from "socket.io";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createRpcRedisRegistryCoordinatorMock = vi.fn();
const resolveRpcCallTargetMock = vi.fn();
const resolveRpcMethodAvailabilityGraceMsMock = vi.fn<(method: string) => number>(() => 0);
const resolveRpcMethodAvailabilityPollMsMock = vi.fn<() => number>(() => 1);

vi.mock("@/utils/logging/log", () => ({
    log: vi.fn(),
}));

vi.mock("./rpcForwardTimeout", () => ({
    resolveRpcForwardTimeoutMs: vi.fn(() => 50),
}));

vi.mock("./rpcMethodAvailabilityGrace", () => ({
    resolveRpcMethodAvailabilityGraceMs: (method: string) => resolveRpcMethodAvailabilityGraceMsMock(method),
    resolveRpcMethodAvailabilityPollMs: () => resolveRpcMethodAvailabilityPollMsMock(),
}));

vi.mock("./resolveRpcCallTarget", () => ({
    resolveRpcCallTarget: (...args: unknown[]) => resolveRpcCallTargetMock(...args),
}));

vi.mock("./rpcRedisRegistryCoordinator", () => ({
    createRpcRedisRegistryCoordinator: (...args: unknown[]) => createRpcRedisRegistryCoordinatorMock(...args),
}));

import { rpcHandler } from "./rpcHandler";

interface FakeSocket {
    id: string;
    connected: boolean;
    data?: Record<string, unknown>;
    on: (event: string, handler: (...args: any[]) => unknown) => void;
    emit: ReturnType<typeof vi.fn>;
    timeout: ReturnType<typeof vi.fn>;
    trigger: (event: string, ...args: any[]) => Promise<void>;
}

function createRedisCoordinator(overrides: Record<string, unknown> = {}) {
    return {
        enabled: false,
        registerMethod: vi.fn().mockResolvedValue(undefined),
        startRefreshLoopIfNeeded: vi.fn(),
        removeSocketRegistration: vi.fn().mockResolvedValue(undefined),
        stopRefreshLoopIfIdle: vi.fn().mockResolvedValue(undefined),
        lookupSocketId: vi.fn().mockResolvedValue(null),
        cleanupMethodsForSocket: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function createSocket(params: { id: string; emitWithAck?: ReturnType<typeof vi.fn>; data?: Record<string, unknown> }): FakeSocket {
    const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
    const emitWithAck = params.emitWithAck ?? vi.fn().mockResolvedValue(undefined);

    return {
        id: params.id,
        connected: true,
        data: params.data,
        on(event, handler) {
            const existing = handlers.get(event) ?? [];
            existing.push(handler);
            handlers.set(event, existing);
        },
        emit: vi.fn(),
        timeout: vi.fn(() => ({
            emitWithAck,
        })),
        async trigger(event, ...args) {
            for (const handler of handlers.get(event) ?? []) {
                await handler(...args);
            }
        },
    };
}

describe("rpcHandler", () => {
    beforeEach(() => {
        createRpcRedisRegistryCoordinatorMock.mockReset();
        resolveRpcCallTargetMock.mockReset();
        resolveRpcMethodAvailabilityGraceMsMock.mockReset();
        resolveRpcMethodAvailabilityGraceMsMock.mockReturnValue(0);
        resolveRpcMethodAvailabilityPollMsMock.mockReset();
        resolveRpcMethodAvailabilityPollMsMock.mockReturnValue(1);
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

        await socket.trigger(SOCKET_RPC_EVENTS.REGISTER, { method: "sess_1:execution.run.stream.start" });

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

        await socket.trigger(SOCKET_RPC_EVENTS.REGISTER, { method: "sess_2:execution.run.stream.start" });

        expect(userRpcListeners.size).toBe(0);
        expect(redisCoordinator.registerMethod).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.ERROR,
            expect.objectContaining({ type: "register", error: "Forbidden" }),
        );
    });
    it("removes only the socket mapping that failed during a forwarded RPC call", async () => {
        const redisCoordinator = createRedisCoordinator({
            enabled: true,
            lookupSocketId: vi
                .fn()
                .mockResolvedValueOnce("stale-socket")
                .mockResolvedValueOnce("fresh-socket"),
            removeSocketRegistration: vi.fn().mockResolvedValue(undefined),
        });
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);
        resolveRpcCallTargetMock.mockResolvedValue({
            targetUserId: "target-user",
            targetSocket: null,
        });

        const emitWithAck = vi.fn().mockRejectedValue(new Error("RPC call failed"));
        const io = {
            timeout: vi.fn(() => ({
                to: vi.fn(() => ({
                    emitWithAck,
                })),
            })),
        };
        const socket = createSocket({ id: "caller-socket" });
        const userRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>();
        const callback = vi.fn();

        rpcHandler("caller-user", socket as unknown as Socket, userRpcListeners, allRpcListeners, {
            io: io as unknown as Server,
            redisRegistry: { enabled: true, instanceId: "instance-1" },
        });

        await socket.trigger(SOCKET_RPC_EVENTS.CALL, { method: "agent.run", params: {} }, callback);

        expect(redisCoordinator.removeSocketRegistration).toHaveBeenCalledTimes(1);
        expect(redisCoordinator.removeSocketRegistration).toHaveBeenCalledWith("target-user", "agent.run", "stale-socket");
        expect(redisCoordinator.removeSocketRegistration).not.toHaveBeenCalledWith("target-user", "agent.run", "fresh-socket");
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "RPC call failed",
        });
    });

    it("waits through a stale redis mapping until a connected target socket is available during reconnect grace", async () => {
        vi.useFakeTimers();
        resolveRpcMethodAvailabilityGraceMsMock.mockReturnValue(20);
        resolveRpcMethodAvailabilityPollMsMock.mockReturnValue(5);

        const redisCoordinator = createRedisCoordinator({
            enabled: true,
            lookupSocketId: vi.fn().mockResolvedValue("stale-socket"),
        });
        createRpcRedisRegistryCoordinatorMock.mockReturnValue(redisCoordinator);
        resolveRpcCallTargetMock.mockResolvedValue({
            targetUserId: "target-user",
            targetSocket: null,
        });

        const ioEmitWithAck = vi.fn().mockResolvedValue([]);
        const io = {
            timeout: vi.fn(() => ({
                to: vi.fn(() => ({
                    emitWithAck: ioEmitWithAck,
                })),
            })),
        };
        const callerSocket = createSocket({ id: "caller-socket" });
        const reconnectingTargetSocket = createSocket({
            id: "reconnected-target-socket",
            emitWithAck: vi.fn().mockResolvedValue({ ok: true, via: "reconnected-socket" }),
        });
        const allRpcListeners = new Map<string, Map<string, Socket>>([["target-user", new Map<string, Socket>]]);
        const targetListeners = allRpcListeners.get("target-user");
        const callback = vi.fn();

        rpcHandler("caller-user", callerSocket as unknown as Socket, new Map<string, Socket>(), allRpcListeners, {
            io: io as unknown as Server,
            redisRegistry: { enabled: true, instanceId: "instance-1" },
        });

        setTimeout(() => {
            targetListeners?.set("agent.run", reconnectingTargetSocket as unknown as Socket);
        }, 5);

        const callPromise = callerSocket.trigger(SOCKET_RPC_EVENTS.CALL, { method: "agent.run", params: {} }, callback);

        await vi.advanceTimersByTimeAsync(5);
        await callPromise;

        expect(reconnectingTargetSocket.timeout).toHaveBeenCalled();
        expect(ioEmitWithAck).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { ok: true, via: "reconnected-socket" },
        });
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

        await socket.trigger(SOCKET_RPC_EVENTS.REGISTER, { method: "agent.run" });
        expect(allRpcListeners.get("user-1")).toBe(userRpcListeners);

        await socket.trigger(SOCKET_RPC_EVENTS.UNREGISTER, { method: "agent.run" });

        expect(userRpcListeners.size).toBe(0);
        expect(allRpcListeners.has("user-1")).toBe(false);

        await socket.trigger(SOCKET_RPC_EVENTS.REGISTER, { method: "agent.run" });

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

        await firstSocket.trigger(SOCKET_RPC_EVENTS.REGISTER, { method: "agent.run" });
        await firstSocket.trigger(SOCKET_RPC_EVENTS.UNREGISTER, { method: "agent.run" });

        const secondSocket = createSocket({
            id: "socket-2",
            emitWithAck: vi.fn().mockResolvedValue({ ok: true }),
        });
        const secondUserRpcListeners = new Map<string, Socket>();

        rpcHandler("user-1", secondSocket as unknown as Socket, secondUserRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await secondSocket.trigger(SOCKET_RPC_EVENTS.REGISTER, { method: "agent.run" });

        resolveRpcCallTargetMock.mockResolvedValue({
            targetUserId: "user-1",
            targetSocket: null,
        });

        const callback = vi.fn();
        await firstSocket.trigger(SOCKET_RPC_EVENTS.CALL, { method: "agent.run", params: {} }, callback);

        expect(secondSocket.timeout).toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({ ok: true, result: { ok: true } });
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

        await firstSocket.trigger(SOCKET_RPC_EVENTS.REGISTER, { method: "agent.old" });
        await firstSocket.trigger(SOCKET_RPC_EVENTS.UNREGISTER, { method: "agent.old" });

        const secondSocket = createSocket({ id: "socket-2" });
        const secondUserRpcListeners = new Map<string, Socket>();
        rpcHandler("user-1", secondSocket as unknown as Socket, secondUserRpcListeners, allRpcListeners, {
            io: {} as Server,
            redisRegistry: { enabled: false },
        });

        await secondSocket.trigger(SOCKET_RPC_EVENTS.REGISTER, { method: "agent.new" });
        await firstSocket.trigger(SOCKET_RPC_EVENTS.REGISTER, { method: "agent.old" });

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

        await socket.trigger(SOCKET_RPC_EVENTS.REGISTER, { method: "agent.run" });
        await socket.trigger("disconnect");

        expect(userRpcListeners.size).toBe(0);
        expect(allRpcListeners.has("user-1")).toBe(false);
        expect(redisCoordinator.cleanupMethodsForSocket).toHaveBeenCalledWith("user-1", ["agent.run"], "socket-1");
    });
});
