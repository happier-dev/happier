import { RPC_ERROR_CODES } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import type { Server } from "socket.io";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
