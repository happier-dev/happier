import { describe, expect, it, vi } from "vitest";

import { RPC_ERROR_CODES } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import { createDbMocks, installDbModuleMock } from "../testkit/dbMocks";
import { createEnvReset } from "../testkit/env";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

const RELEASED_SERVER_V0_2_0_PROVENANCE = Object.freeze({
    tag: "server-v0.2.0",
    commit: "739fb368aaf4d510e0b2280cdbe2acee3fefcf12",
    linuxX64Sha256: "64083eddbb181ccd4a1113670295945670d7bdd30b86a342ecf6b9888ea0bef2",
});

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
                timeoutMs: 30000,
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

    it("preserves released-server opaque session RPC forwarding for Agent-realtime control without audio", async () => {
        // server-v0.2.0 rpcHandler.ts at the pinned commit forwards normalized
        // arbitrary method strings and opaque params without parsing Agent realtime.
        expect(RELEASED_SERVER_V0_2_0_PROVENANCE).toEqual({
            tag: "server-v0.2.0",
            commit: "739fb368aaf4d510e0b2280cdbe2acee3fefcf12",
            linuxX64Sha256: "64083eddbb181ccd4a1113670295945670d7bdd30b86a342ecf6b9888ea0bef2",
        });
        const inspectMethod = "sess_1:session.agentRealtime.inspect";
        const startMethod = "sess_1:session.agentRealtime.start";
        const provider = {
            pluginId: "happier.agent.codex",
            localId: "realtime-codex",
        };
        const inspectPayload = { v: 1, provider };
        const startPayload = {
            ...inspectPayload,
            applicationAttemptId: "voice:released-server-vector",
            transport: {
                kind: "webrtc",
                offerSdp: "v=0\r\na=released-server-vector\r\n",
            },
        };
        const inspectTarget = createTarget("daemon-inspect-socket", {
            ok: true,
            status: "available",
            transport: "webrtc",
        });
        const startTarget = createTarget("daemon-start-socket", {
            ok: true,
            status: "started",
            transport: {
                kind: "webrtc",
                answerSdp: "v=0\r\na=released-server-answer\r\n",
            },
        });
        const { io, inMock } = createIo({
            [`rpc:user-1:${inspectMethod}`]: [[inspectTarget.socket]],
            [`rpc:user-1:${startMethod}`]: [[startTarget.socket]],
        });
        const callerSocket = createFakeSocket({
            id: "current-ui-socket",
            emit: vi.fn(),
            join: vi.fn(),
            leave: vi.fn(),
        } as any);

        vi.resetModules();
        const { rpcHandler } = await import("./rpcHandler");
        rpcHandler("user-1", callerSocket as any, { io });
        const handler = getSocketHandler(callerSocket, SOCKET_RPC_EVENTS.CALL);
        const inspectCallback = vi.fn();
        const startCallback = vi.fn();

        await handler({ method: inspectMethod, params: inspectPayload }, inspectCallback);
        await handler({ method: startMethod, params: startPayload }, startCallback);

        expect(inMock).toHaveBeenCalledWith(`rpc:user-1:${inspectMethod}`);
        expect(inMock).toHaveBeenCalledWith(`rpc:user-1:${startMethod}`);
        expect(inspectTarget.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
            method: inspectMethod,
            params: inspectPayload,
            timeoutMs: 30000,
        });
        expect(startTarget.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
            method: startMethod,
            params: startPayload,
            timeoutMs: 30000,
        });
        expect(startPayload).not.toHaveProperty("audio");
        expect(startPayload).not.toHaveProperty("pcm");
        expect(JSON.stringify(startPayload)).not.toContain("voice_media");
        expect(inspectCallback).toHaveBeenCalledWith({
            ok: true,
            result: {
                ok: true,
                status: "available",
                transport: "webrtc",
            },
        });
        expect(startCallback).toHaveBeenCalledWith({
            ok: true,
            result: {
                ok: true,
                status: "started",
                transport: {
                    kind: "webrtc",
                    answerSdp: "v=0\r\na=released-server-answer\r\n",
                },
            },
        });
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
                timeoutMs: 30000,
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
            timeoutMs: 120000,
        });
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { ok: true, result: "{}" },
        });
    });
});
