import {
    RPC_ERROR_CODES,
    RPC_METHODS,
    SESSION_RPC_METHODS,
    SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
} from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import type { Server } from "socket.io";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    CurrentSessionPublisherAuthority,
    RunAsProjectedCurrentPublisherResult,
} from "@/app/presence/sessionPublisherPresence";

import { createFakeSocket, triggerSocketHandler } from "../../testkit/socketHarness";

const resolveRpcCallTargetMock = vi.hoisted(() => vi.fn());
const machineFindFirstMock = vi.hoisted(() => vi.fn(async (): Promise<{ revokedAt: Date | null; replacedByMachineId: string | null }> => ({
    revokedAt: null,
    replacedByMachineId: null,
})));
const accessKeyFindUniqueMock = vi.hoisted(() => vi.fn(async (): Promise<{ machineId: string; machine: { revokedAt: Date | null; replacedByMachineId: string | null } } | null> => ({
    machineId: "machine-1",
    machine: {
        revokedAt: null,
        replacedByMachineId: null,
    },
})));
const checkSessionAccessMock = vi.hoisted(() => vi.fn(async () => ({
    userId: "user-1",
    sessionId: "sess_1",
    level: "edit",
    isOwner: false,
})));
const requireAccessLevelMock = vi.hoisted(() => vi.fn(() => true));
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

vi.mock("./resolveRpcCallTarget", () => ({
    resolveRpcCallTarget: (...args: unknown[]) => resolveRpcCallTargetMock(...args),
}));

vi.mock("@/app/monitoring/metrics/index", () => rpcMetricsMocks);

vi.mock("@/storage/db", () => ({
    db: {
        machine: { findFirst: machineFindFirstMock },
        accessKey: { findUnique: accessKeyFindUniqueMock },
    },
}));

vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess: checkSessionAccessMock,
    requireAccessLevel: requireAccessLevelMock,
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
    beforeEach(() => {
        resolveRpcCallTargetMock.mockReset();
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
        checkSessionAccessMock.mockReset();
        checkSessionAccessMock.mockResolvedValue({
            userId: "user-1",
            sessionId: "sess_1",
            level: "edit",
            isOwner: false,
        });
        requireAccessLevelMock.mockReset();
        requireAccessLevelMock.mockReturnValue(true);
        Object.values(rpcMetricsMocks).forEach((mock) => mock.mockReset());
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
        expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
            type: "register",
            error: "Machine replaced",
        });
    });

    it.each([
        RPC_METHODS.SPAWN_HAPPY_SESSION,
        RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT,
    ])("revalidates an observe-era daemon before registering provider-starting RPC %s", async (providerStartingMethod) => {
        vi.stubEnv("HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT", "required");
        vi.stubEnv("HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION", "2");
        vi.stubEnv("HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON", JSON.stringify({
            daemon: "0.2.11",
            "session-runner": "0.2.11",
        }));
        const join = vi.fn().mockResolvedValue(undefined);
        const socket = createFakeSocket({
            id: "old-daemon-socket",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
                sessionSyncCompatibility: {
                    parseResult: {
                        status: "valid",
                        declaration: {
                            v: 1,
                            clientKind: "daemon",
                            appVersion: "0.2.9",
                            sessionSyncProtocolVersion: 2,
                        },
                    },
                },
            },
            join,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);

        try {
            registerSocketRpcHandlers({
                userId: "user-1",
                socket: socket as any,
                io: {} as Server,
            });

            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, {
                method: `machine-1:${providerStartingMethod}`,
            });

            expect(join).not.toHaveBeenCalled();
            expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
                type: "register",
                error: "client-upgrade-required",
                requirement: {
                    v: 1,
                    minimumSessionSyncProtocolVersion: 2,
                    clientKind: "daemon",
                    minimumAppVersion: "0.2.11",
                    updateUrl: null,
                },
            });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("keeps non-provider-starting machine RPC registration available across a required floor", async () => {
        vi.stubEnv("HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT", "required");
        vi.stubEnv("HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION", "2");
        vi.stubEnv("HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON", JSON.stringify({
            daemon: "0.2.11",
            "session-runner": "0.2.11",
        }));
        const join = vi.fn().mockResolvedValue(undefined);
        const socket = createFakeSocket({
            id: "daemon-socket",
            data: {
                clientType: "machine-scoped",
                machineId: "machine-1",
            },
            join,
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);

        try {
            registerSocketRpcHandlers({
                userId: "user-1",
                socket: socket as any,
                io: {} as Server,
            });

            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, {
                method: `machine-1:${RPC_METHODS.CAPABILITIES_INVOKE}`,
            });

            expect(join).toHaveBeenCalledWith(`rpc:user-1:machine-1:${RPC_METHODS.CAPABILITIES_INVOKE}`);
            expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, {
                method: `machine-1:${RPC_METHODS.CAPABILITIES_INVOKE}`,
            });
            expect(socket.emit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.anything());
        } finally {
            vi.unstubAllEnvs();
        }
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
        expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
            type: "register",
            error: "Forbidden",
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
        expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
            type: "register",
            error: "Forbidden",
        });
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

        resolveRpcCallTargetMock.mockResolvedValue({
            type: "target",
            targetUserId: "user-1",
        });

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
            timeoutMs: 30000,
        });
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { ok: true, value: 123 },
        });
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

        resolveRpcCallTargetMock.mockResolvedValue({
            type: "target",
            targetUserId: "user-1",
        });

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

        resolveRpcCallTargetMock.mockResolvedValue({
            type: "target",
            targetUserId: "user-1",
        });

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
        requireAccessLevelMock.mockReturnValue(false);
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

        expect(checkSessionAccessMock).toHaveBeenCalledWith("user-1", "sess_1");
        expect(requireAccessLevelMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: "sess_1",
        }), "edit");
        expect(resolveRpcCallTargetMock).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
        });
    });

    it("uses a dedicated cluster fetch timeout for session-scoped rpc discovery", async () => {
        const { io, timeout } = createIo({
            targetsByRoom: {
                "rpc:user-1:sess_1:execution.run.stream.start": [],
            },
        });
        const socket = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();

        resolveRpcCallTargetMock.mockResolvedValue({
            type: "target",
            targetUserId: "user-1",
        });

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

        resolveRpcCallTargetMock.mockResolvedValue({
            type: "target",
            targetUserId: "user-1",
        });

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
        expect(resolveRpcCallTargetMock).not.toHaveBeenCalled();
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

        resolveRpcCallTargetMock.mockResolvedValue({
            type: "target",
            targetUserId: "user-1",
        });

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
        expect(resolveRpcCallTargetMock).not.toHaveBeenCalled();
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

        resolveRpcCallTargetMock.mockResolvedValue({
            type: "target",
            targetUserId: "user-1",
        });

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

        expect(resolveRpcCallTargetMock).not.toHaveBeenCalled();
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

        resolveRpcCallTargetMock.mockResolvedValue({
            type: "target",
            targetUserId: "user-1",
        });

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method: "agent.run", params: {} }, callback);

        expect(resolveRpcCallTargetMock).not.toHaveBeenCalled();
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

    it("returns forbidden without discovering rooms when the target resolution is denied", async () => {
        const { io, inMock } = createIo();
        const socket = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave: vi.fn().mockResolvedValue(undefined),
        } as any);
        const callback = vi.fn();

        resolveRpcCallTargetMock.mockResolvedValue({
            type: "forbidden",
        });

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method: "sess_1:permission", params: {} }, callback);

        expect(inMock).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Forbidden",
        });
        expect(rpcMetricsMocks.recordRpcCallFailure).toHaveBeenCalledWith("sess_1:permission", "forbidden");
        expect(rpcMetricsMocks.observeRpcCall).toHaveBeenCalledWith(expect.objectContaining({
            method: "sess_1:permission",
            result: "error",
        }));
    });

    it("leaves all owned rooms on disconnect cleanup", async () => {
        const leave = vi.fn().mockResolvedValue(undefined);
        const socket = createFakeSocket({
            id: "caller-socket",
            join: vi.fn().mockResolvedValue(undefined),
            leave,
        } as any);

        registerSocketRpcHandlers({
            userId: "user-1",
            socket: socket as any,
            io: {} as Server,
        });

        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: "agent.run" });
        await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: "sess_1:execution.run.stream.start" });
        await triggerSocketHandler(socket, "disconnect");

        expect(leave).toHaveBeenCalledWith("rpc:user-1:agent.run");
        expect(leave).toHaveBeenCalledWith("rpc:user-1:sess_1:execution.run.stream.start");
        expect(rpcMetricsMocks.recordRpcUnregistration).toHaveBeenCalledWith("agent.run");
        expect(rpcMetricsMocks.recordRpcUnregistration).toHaveBeenCalledWith("sess_1:execution.run.stream.start");
    });

    it("notifies the owning machine socket when a user socket registers, unregisters, or disconnects a machine-scoped RPC handler", async () => {
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
        const method = `machine-1:${RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME}`;

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

    it("hydrates a reconnecting machine socket from existing machine-scoped RPC registrations", async () => {
        const { io, addToRoom, createRoomAwareSocket } = createRoomAwareIo();
        const uiSocket = createRoomAwareSocket({
            id: "ui-socket",
            data: { clientType: "user-scoped" },
        });
        const daemonSocket = createRoomAwareSocket({
            id: "daemon-reconnect-socket",
            data: { clientType: "machine-scoped", machineId: "machine-1" },
        });
        const method = `machine-1:${RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME}`;
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

    it("routes model transition to the single DB-current publisher even when a stale socket sorts first", async () => {
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
        resolveRpcCallTargetMock.mockResolvedValue({ type: "target", targetUserId: "user-1" });

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
        resolveRpcCallTargetMock.mockResolvedValue({ type: "target", targetUserId: "user-1" });

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
        resolveRpcCallTargetMock.mockResolvedValue({ type: "target", targetUserId: "user-1" });

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
