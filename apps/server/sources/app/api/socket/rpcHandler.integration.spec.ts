import { describe, expect, it, vi } from "vitest";

import { RPC_ERROR_CODES } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import { createDbMocks, installDbModuleMock } from "../testkit/dbMocks";
import { createEnvReset } from "../testkit/env";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

function createTarget(id: string, result: unknown) {
    const emitWithAck = vi.fn().mockResolvedValue(result);
    return {
        socket: {
            id,
            timeout: vi.fn(() => ({
                emitWithAck,
            })),
        },
        emitWithAck,
    };
}

function createIo(responsesByRoom: Record<string, unknown[][]>) {
    const fetchesByRoom = new Map<string, unknown[][]>(
        Object.entries(responsesByRoom).map(([room, responses]) => [room, [...responses]]),
    );

    const inMock = vi.fn((room: string) => {
        const readNext = async () => {
            const queue = fetchesByRoom.get(room) ?? [];
            if (queue.length === 0) {
                return [];
            }
            if (queue.length === 1) {
                return queue[0];
            }
            return queue.shift() ?? [];
        };

        return {
            timeout: vi.fn(() => ({
                fetchSockets: vi.fn(readNext),
            })),
            fetchSockets: vi.fn(readNext),
        };
    });

    return {
        io: {
            in: inMock,
        } as any,
        inMock,
    };
}

describe("rpcHandler", () => {
    const resetRpcAvailabilityEnv = createEnvReset();

    it("waits briefly for a late session-scoped room member before forwarding the RPC", async () => {
        vi.useFakeTimers();
        vi.resetModules();
        resetRpcAvailabilityEnv({
            HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: "30",
            HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS: "10",
        });

        try {
            const target = createTarget("target-socket", { ok: true, value: 123 });
            const { io, inMock } = createIo({
                "rpc:user-1:sess_1:execution.run.stream.start": [
                    [],
                    [],
                    [target.socket],
                ],
            });
            const callerSocket = createFakeSocket({
                id: "caller-socket",
                emit: vi.fn(),
                join: vi.fn(),
                leave: vi.fn(),
            } as any);

            const { rpcHandler } = await import("./rpcHandler");
            rpcHandler("user-1", callerSocket as any, { io });

            const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
            const callback = vi.fn();
            const pending = handler({ method: "sess_1:execution.run.stream.start", params: { runId: "run-1" } }, callback);

            await vi.advanceTimersByTimeAsync(20);
            await pending;

            expect(inMock).toHaveBeenCalledWith("rpc:user-1:sess_1:execution.run.stream.start");
            expect(target.socket.timeout).toHaveBeenCalledWith(30000);
            expect(target.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
                method: "sess_1:execution.run.stream.start",
                params: { runId: "run-1" },
            });
            expect(callback).toHaveBeenCalledWith({
                ok: true,
                result: { ok: true, value: 123 },
            });
        } finally {
            resetRpcAvailabilityEnv();
            vi.useRealTimers();
        }
    });

    it("routes delegated permission RPCs through the owner room", async () => {
        vi.resetModules();

        const dbMocks = createDbMocks({
            session: ["findUnique"],
        } as const);
        dbMocks.db.session.findUnique.mockResolvedValue({ accountId: "owner-1" });
        installDbModuleMock({ db: dbMocks.db });
        vi.doMock("@/app/share/accessControl", () => ({
            canApprovePermissions: vi.fn().mockResolvedValue(true),
        }));

        try {
            const target = createTarget("owner-socket", { ok: true, value: "owner" });
            const { io, inMock } = createIo({
                "rpc:owner-1:sess_1:permission": [[target.socket]],
            });
            const callerSocket = createFakeSocket({
                id: "caller-socket",
                emit: vi.fn(),
                join: vi.fn(),
                leave: vi.fn(),
            } as any);

            const { rpcHandler } = await import("./rpcHandler");
            rpcHandler("user-1", callerSocket as any, { io });

            const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
            const callback = vi.fn();
            await handler({ method: "sess_1:permission", params: { requestId: "perm-1" } }, callback);

            expect(inMock).toHaveBeenCalledWith("rpc:owner-1:sess_1:permission");
            expect(target.socket.timeout).toHaveBeenCalledWith(30000);
            expect(target.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
                method: "sess_1:permission",
                params: { requestId: "perm-1" },
            });
            expect(callback).toHaveBeenCalledWith({
                ok: true,
                result: { ok: true, value: "owner" },
            });
        } finally {
            vi.doUnmock("@/storage/db");
            vi.doUnmock("@/app/share/accessControl");
        }
    });

    it("returns forbidden for delegated permission RPCs when approval is denied", async () => {
        vi.resetModules();

        const dbMocks = createDbMocks({
            session: ["findUnique"],
        } as const);
        dbMocks.db.session.findUnique.mockResolvedValue({ accountId: "owner-1" });
        installDbModuleMock({ db: dbMocks.db });
        vi.doMock("@/app/share/accessControl", () => ({
            canApprovePermissions: vi.fn().mockResolvedValue(false),
        }));

        try {
            const { io, inMock } = createIo({
                "rpc:owner-1:sess_1:permission": [[createTarget("owner-socket", { ok: true }).socket]],
            });
            const callerSocket = createFakeSocket({
                id: "caller-socket",
                emit: vi.fn(),
                join: vi.fn(),
                leave: vi.fn(),
            } as any);

            const { rpcHandler } = await import("./rpcHandler");
            rpcHandler("user-1", callerSocket as any, { io });

            const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
            const callback = vi.fn();
            await handler({ method: "sess_1:permission", params: { requestId: "perm-1" } }, callback);

            expect(inMock).not.toHaveBeenCalled();
            expect(callback).toHaveBeenCalledWith({
                ok: false,
                error: "Forbidden",
            });
        } finally {
            vi.doUnmock("@/storage/db");
            vi.doUnmock("@/app/share/accessControl");
        }
    });

    it("returns METHOD_NOT_AVAILABLE when the room stays empty", async () => {
        vi.resetModules();
        const { io } = createIo({
            "rpc:user-1:missing-method": [[]],
        });
        const callerSocket = createFakeSocket({
            id: "caller-socket",
            emit: vi.fn(),
            join: vi.fn(),
            leave: vi.fn(),
        } as any);

        const { rpcHandler } = await import("./rpcHandler");
        rpcHandler("user-1", callerSocket as any, { io });

        const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
        const callback = vi.fn();
        await handler({ method: "missing-method", params: {} }, callback);

        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    });

    it("uses the longer capabilities timeout for capabilities RPCs", async () => {
        vi.resetModules();
        const target = createTarget("target-socket", { ok: true, result: "{}" });
        const { io } = createIo({
            "rpc:user-1:machine-1:capabilities.invoke": [[target.socket]],
        });
        const callerSocket = createFakeSocket({
            id: "caller-socket",
            emit: vi.fn(),
            join: vi.fn(),
            leave: vi.fn(),
        } as any);

        const { rpcHandler } = await import("./rpcHandler");
        rpcHandler("user-1", callerSocket as any, { io });

        const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
        const callback = vi.fn();
        await handler({ method: "machine-1:capabilities.invoke", params: { id: "cli.gemini" } }, callback);

        expect(target.socket.timeout).toHaveBeenCalledWith(120000);
        expect(target.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
            method: "machine-1:capabilities.invoke",
            params: { id: "cli.gemini" },
        });
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { ok: true, result: "{}" },
        });
    });
});
