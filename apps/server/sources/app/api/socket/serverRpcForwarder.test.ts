import { RPC_ERROR_CODES } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import type { SocketRpcRequestPayload } from "@happier-dev/protocol/socketRpc";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { Server, type Socket } from "socket.io";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServerRpcForwarder } from "./serverRpcForwarder";
import { buildRpcMethodRoom } from "./rpc/rpcMethodRoom";
import { enableMonitoring } from "@/app/api/utils/enableMonitoring";
import type { Fastify as HappierFastify } from "@/app/api/types";
import { logger } from "@/utils/logging/log";

const rpcMetricsMocks = vi.hoisted(() => ({
    observeRpcCall: vi.fn(),
    recordRpcCallFailure: vi.fn(),
    observeRpcTargetLookup: vi.fn(),
    recordRpcMethodNotAvailable: vi.fn(),
    recordRpcSelfCallRejection: vi.fn(),
    recordSocketClusterFetchSockets: vi.fn(),
}));

vi.mock("@/app/monitoring/metrics/index", async importOriginal => ({
    ...await importOriginal<typeof import("@/app/monitoring/metrics/index")>(),
    ...rpcMetricsMocks,
}));

function createIo(params: { targetsByRoom?: Record<string, unknown[]>; errorsByRoom?: Record<string, Error> } = {}) {
    const io = new Server();
    const inMock = vi.spyOn(io, "in").mockImplementation((rooms: string | string[]) => {
        const room = typeof rooms === "string" ? rooms : rooms[0];
        return {
            timeout: vi.fn(() => ({
                fetchSockets: params.errorsByRoom?.[room]
                    ? vi.fn().mockRejectedValue(params.errorsByRoom[room])
                    : vi.fn().mockResolvedValue(params.targetsByRoom?.[room] ?? []),
            })),
            fetchSockets: params.errorsByRoom?.[room]
                ? vi.fn().mockRejectedValue(params.errorsByRoom[room])
                : vi.fn().mockResolvedValue(params.targetsByRoom?.[room] ?? []),
        } as unknown as ReturnType<Server["in"]>;
    });

    return { io, inMock };
}

describe("createServerRpcForwarder", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    beforeEach(() => {
        Object.values(rpcMetricsMocks).forEach((mock) => mock.mockReset());
    });

    it.each([false, true])("joins HTTP-originated forwards without enabling timing or cancellation (failed ACK=%s)", async failed => {
        vi.stubEnv("HAPPIER_WEB_LATENCY_TRACE", "0");
        const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
        const method = "agent.run";
        const io = new Server();
        const sent: SocketRpcRequestPayload[] = [];
        // Only the socket transport and telemetry outputs are synthetic. HTTP
        // monitoring, async context, discovery and forwarding remain composed.
        const target = { id: "target-socket", connected: true, data: {},
            timeout: (_timeoutMs: number, _options: unknown) => ({
                emitWithAck: async (_event: string, payload: SocketRpcRequestPayload) => {
                    sent.push(payload);
                    if (failed) throw Object.assign(new Error("private-transport-detail"), { code: "SOCKET_DISCONNECTED" });
                    return { ok: true, secret: "private-response" };
                },
            }),
        };
        io.sockets.sockets.set(target.id, target as unknown as Socket);
        io.sockets.adapter.rooms.set(buildRpcMethodRoom({ userId: "user-1", method }), new Set([target.id]));
        const app = Fastify() as unknown as HappierFastify;
        enableMonitoring(app);
        const forwardRpcForUser = createServerRpcForwarder({ io });
        const roots: string[] = [];
        app.get("/forward", async request => {
            roots.push(request.id);
            await Promise.resolve();
            return forwardRpcForUser({ userId: "user-1", method, params: { secret: "private-input" } });
        });
        try {
            const responses = await Promise.all([app.inject("/forward"), app.inject("/forward")]);
            expect(responses.map(response => response.json().ok)).toEqual([!failed, !failed]);
            expect(sent).toHaveLength(2);
            expect(sent.map(payload => payload.traceId).sort()).toEqual([...roots].sort());
            for (const payload of sent) expect(payload).not.toHaveProperty("requestId");
            const events = info.mock.calls.map(([entry]) => entry).filter(
                (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && "event" in entry,
            );
            for (const root of roots) {
                const requestId = `sha256:${createHash("sha256").update(root).digest("hex")}`;
                const joined = events.filter(entry => entry.requestId === requestId);
                expect(joined.map(entry => entry.event)).toEqual([
                    "rpc-target-lookup", "rpc-target-issued", "rpc-target-ack",
                    ...(failed ? ["rpc-failed"] : []),
                ]);
                expect(joined.find(entry => entry.event === "rpc-target-ack")).toMatchObject({ status: failed ? "failed" : "received",
                    ...(failed ? { failure: "disconnected" } : {}) });
                for (const entry of joined) expect(entry).not.toHaveProperty("callerSocketId");
            }
            expect(JSON.stringify(events)).not.toContain("private-");
            expect(JSON.stringify(events)).not.toContain('"req-');
        } finally {
            await app.close();
            io.sockets.sockets.clear();
        }
    });

    it("forwards through the canonical RPC room discovery path", async () => {
        const emitWithAck = vi.fn().mockResolvedValue({ ok: true, value: 42 });
        const target = {
            id: "target-socket",
            timeout: vi.fn(() => ({
                emitWithAck,
            })),
        };
        const { io, inMock } = createIo({
            targetsByRoom: {
                "rpc:user-1:agent.run": [target],
            },
        });

        const forwardRpcForUser = createServerRpcForwarder({ io });
        const response = await forwardRpcForUser({
            userId: "user-1",
            method: "agent.run",
            params: { value: 1 },
        });

        expect(inMock).toHaveBeenCalledWith("rpc:user-1:agent.run");
        expect(target.timeout).toHaveBeenCalledWith(30000, { rejectOnDisconnect: true });
        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
            method: "agent.run",
            params: { value: 1 },
            timeoutMs: 30000,
            callerAuthority: "account_automation",
        });
        expect(response).toEqual({
            ok: true,
            result: { ok: true, value: 42 },
        });
        expect(rpcMetricsMocks.recordSocketClusterFetchSockets).toHaveBeenCalledWith(expect.objectContaining({
            result: "ok",
        }));
        expect(rpcMetricsMocks.observeRpcTargetLookup).toHaveBeenCalledWith(expect.objectContaining({
            method: "agent.run",
            result: "resolved",
        }));
        expect(rpcMetricsMocks.observeRpcCall).toHaveBeenCalledWith(expect.objectContaining({
            method: "agent.run",
            result: "ok",
        }));
    });

    it("returns method-not-available when the room has no eligible target", async () => {
        const { io } = createIo({
            targetsByRoom: {
                "rpc:user-1:missing-method": [],
            },
        });

        const forwardRpcForUser = createServerRpcForwarder({ io });
        const response = await forwardRpcForUser({
            userId: "user-1",
            method: "missing-method",
            params: {},
        });

        expect(response).toEqual({
            ok: false,
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
        expect(rpcMetricsMocks.recordRpcMethodNotAvailable).toHaveBeenCalledWith("missing-method");
        expect(rpcMetricsMocks.recordRpcCallFailure).toHaveBeenCalledWith("missing-method", "method_not_available");
        expect(rpcMetricsMocks.observeRpcTargetLookup).toHaveBeenCalledWith(expect.objectContaining({
            method: "missing-method",
            result: "miss",
        }));
        expect(rpcMetricsMocks.observeRpcCall).toHaveBeenCalledWith(expect.objectContaining({
            method: "missing-method",
            result: "error",
        }));
    });

    it("records cluster discovery failures without claiming the method is absent", async () => {
        const { io } = createIo({
            errorsByRoom: {
                "rpc:user-1:agent.run": new Error("adapter exploded"),
            },
        });

        const forwardRpcForUser = createServerRpcForwarder({ io });
        const response = await forwardRpcForUser({
            userId: "user-1",
            method: "agent.run",
            params: {},
        });

        expect(response).toMatchObject({
            ok: false,
            errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE,
            failureCause: { phase: "rpc.discovery.target", errorClass: "Error" },
        });
        expect(rpcMetricsMocks.recordSocketClusterFetchSockets).toHaveBeenCalledWith(expect.objectContaining({
            result: "error",
            reason: "unknown",
        }));
        expect(rpcMetricsMocks.observeRpcTargetLookup).toHaveBeenCalledWith(expect.objectContaining({
            method: "agent.run",
            result: "miss",
        }));
    });
});
