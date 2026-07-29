import { RPC_ERROR_CODES } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import type { Server } from "socket.io";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createServerRpcForwarder } from "./serverRpcForwarder";

const rpcMetricsMocks = vi.hoisted(() => ({
    observeRpcCall: vi.fn(),
    recordRpcCallFailure: vi.fn(),
    observeRpcTargetLookup: vi.fn(),
    recordRpcMethodNotAvailable: vi.fn(),
    recordRpcSelfCallRejection: vi.fn(),
    recordSocketClusterFetchSockets: vi.fn(),
}));

vi.mock("@/app/monitoring/metrics/index", () => rpcMetricsMocks);

function createIo(params: { targetsByRoom?: Record<string, unknown[]>; errorsByRoom?: Record<string, Error> } = {}) {
    const inMock = vi.fn((room: string) => ({
        timeout: vi.fn(() => ({
            fetchSockets: params.errorsByRoom?.[room]
                ? vi.fn().mockRejectedValue(params.errorsByRoom[room])
                : vi.fn().mockResolvedValue(params.targetsByRoom?.[room] ?? []),
        })),
        fetchSockets: params.errorsByRoom?.[room]
            ? vi.fn().mockRejectedValue(params.errorsByRoom[room])
            : vi.fn().mockResolvedValue(params.targetsByRoom?.[room] ?? []),
    }));

    return {
        io: {
            in: inMock,
        } as unknown as Server,
        inMock,
    };
}

describe("createServerRpcForwarder", () => {
    beforeEach(() => {
        Object.values(rpcMetricsMocks).forEach((mock) => mock.mockReset());
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
        expect(target.timeout).toHaveBeenCalledWith(30000);
        expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
            method: "agent.run",
            params: { value: 1 },
            timeoutMs: 30000,
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

    it("records cluster discovery failures and degrades to method-not-available", async () => {
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

        expect(response).toEqual({
            ok: false,
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
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
