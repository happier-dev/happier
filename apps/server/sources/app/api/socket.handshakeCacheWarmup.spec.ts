import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { auth } from "@/app/auth/auth";
import { eventRouter } from "@/app/events/eventRouter";
import * as metrics from "@/app/monitoring/metrics/index";
import { activityCache } from "@/app/presence/sessionCache";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { startSocket } from "./socket";
import type { Fastify as AppFastify } from "./types";

const serverCtor = vi.hoisted(() => vi.fn());
// Socket.IO is the transport boundary; authentication, binding and cache logic stay real.
vi.mock("socket.io", () => ({
    Server: function ServerMock(...args: unknown[]) {
        return serverCtor(...args);
    },
}));

function createHandshakeServer() {
    const server = { on: vi.fn(), use: vi.fn(), close: vi.fn(), to: vi.fn(() => ({ emit: vi.fn() })) };
    serverCtor.mockReturnValue(server);
    return server;
}

describe("startSocket handshake cache warmup", () => {
    let harness: LightSqliteHarness;
    let app: AppFastify;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-handshake-warmup-", initAuth: true });
    }, 120_000);

    beforeEach(() => {
        vi.clearAllMocks();
        harness.resetEnv({ AUTH_REQUIRED_LOGIN_PROVIDERS: undefined, HAPPIER_SOCKET_ADAPTER: "memory" });
        app = Fastify({ logger: false }) as unknown as AppFastify;
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        eventRouter.clearIo();
        await app.close();
    });

    afterAll(async () => { await harness.close(); });

    async function runHandshake() {
        const account = await db.account.create({ data: { publicKey: `warmup-${randomUUID()}` } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const server = createHandshakeServer();
        startSocket(app);
        const middleware = server.use.mock.calls[0]?.[0] as
            (socket: Record<string, unknown>, next: (error?: unknown) => void) => Promise<void>;
        const socket = {
            id: "warmup-socket",
            handshake: { auth: { token, clientType: "session-scoped", sessionId: "warmup-session", machineId: "warmup-machine" }, headers: {} },
            conn: { transport: { name: "websocket" } },
            data: {} as Record<string, unknown>,
        };
        return { account, middleware, socket };
    }

    it("seeds session and machine validity from a successful machine-bound session handshake", async () => {
        const { account, middleware, socket } = await runHandshake();
        const lastActiveAt = new Date("2026-04-19T18:00:00.000Z");
        await db.session.create({ data: { id: "warmup-session", tag: "warmup-session", accountId: account.id, metadata: "{}", active: true, lastActiveAt } });
        await db.machine.create({ data: { id: "warmup-machine", accountId: account.id, metadata: "{}", active: true, lastActiveAt } });
        await db.accessKey.create({ data: { accountId: account.id, sessionId: "warmup-session", machineId: "warmup-machine", data: "key" } });
        const stages = vi.spyOn(metrics, "recordSocketAuthHandshakeStageDuration");
        const next = vi.fn();

        await middleware(socket, next);

        expect(next).toHaveBeenCalledWith();
        expect(socket.data.sessionScopedBinding).toEqual({ sessionId: "warmup-session", machineId: "warmup-machine", proof: "machine-access-key" });
        // Warm validity must survive a storage outage without doing another lookup.
        const sessionLookup = vi.spyOn(db.session, "findUnique").mockRejectedValue(new Error("database unavailable"));
        const machineLookup = vi.spyOn(db.machine, "findUnique").mockRejectedValue(new Error("database unavailable"));
        expect(await activityCache.isSessionValid("warmup-session", account.id)).toBe(true);
        expect(await activityCache.isMachineValid("warmup-machine", account.id)).toBe(true);
        expect(sessionLookup).not.toHaveBeenCalled();
        expect(machineLookup).not.toHaveBeenCalled();
        for (const stage of ["verify-token", "login-eligibility", "session-binding"]) {
            expect(stages).toHaveBeenCalledWith(expect.objectContaining({ clientType: "session-scoped", transport: "websocket", stage, result: "ok" }));
        }
    });

    it("rejects a session-scoped handshake with upstream_error when binding lookup throws", async () => {
        const { middleware, socket } = await runHandshake();
        vi.spyOn(db.accessKey, "findUnique").mockRejectedValueOnce({ code: "P2037" });
        const exceptions = vi.spyOn(metrics, "recordSocketAuthHandshakeException");
        const stages = vi.spyOn(metrics, "recordSocketAuthHandshakeStageDuration");
        const next = vi.fn();

        await middleware(socket, next);

        expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "upstream_error", data: { error: "upstream_error", statusCode: 503 } }));
        expect(socket.data.sessionScopedBinding).toBeUndefined();
        expect(exceptions).toHaveBeenCalledWith({ clientType: "session-scoped", transport: "websocket", stage: "session-binding", classification: "prisma-p2037" });
        expect(stages).toHaveBeenCalledWith(expect.objectContaining({ clientType: "session-scoped", transport: "websocket", stage: "session-binding", result: "error" }));
    });
});
