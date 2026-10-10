import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { auth } from "@/app/auth/auth";
import { eventRouter } from "@/app/events/eventRouter";
import * as metrics from "@/app/monitoring/metrics/index";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createFakeSocket } from "./testkit/socketHarness";
import { startSocket } from "./socket";
import type { Fastify as AppFastify } from "./types";

const serverCtor = vi.hoisted(() => vi.fn());
// Only Socket.IO transport is replaced; both credential checks and handler registration are real.
vi.mock("socket.io", () => ({
    Server: function ServerMock(...args: unknown[]) {
        return serverCtor(...args);
    },
}));

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => { resolve = complete; });
    return { promise, resolve };
}

describe("startSocket connect convergence", () => {
    let harness: LightSqliteHarness;
    let app: AppFastify;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-connect-convergence-", initAuth: true });
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

    async function createConnection(join: (rooms: unknown) => Promise<void> = async () => {}) {
        const account = await db.account.create({ data: { publicKey: `convergence-${randomUUID()}` } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const server = { on: vi.fn(), use: vi.fn(), close: vi.fn(), to: vi.fn(() => ({ emit: vi.fn() })) };
        serverCtor.mockReturnValue(server);
        startSocket(app);
        const base = createFakeSocket({ id: `socket-${account.id}`, data: {} });
        // The complete server installs several listeners for the same transport
        // event. Preserve Socket.IO's fanout instead of the handler-map's last one.
        const events = new EventEmitter();
        const socket = {
            ...base,
            data: {} as Record<string, unknown>,
            handshake: { auth: { token, clientType: "user-scoped", clientPurpose: "stress" }, address: "127.0.0.1", headers: { "user-agent": "test-agent" } },
            conn: { transport: { name: "websocket" } },
            join: vi.fn(join),
            use: vi.fn(),
            leave: vi.fn(),
            on: events.on.bind(events),
            once: events.once.bind(events),
            disconnect: vi.fn(() => {
                socket.connected = false;
                events.emit("disconnect", "server namespace disconnect");
            }),
        };
        const middleware = server.use.mock.calls[0]?.[0] as
            (socket: Record<string, unknown>, next: (error?: unknown) => void) => Promise<void>;
        const next = vi.fn();
        await middleware(socket, next);
        expect(next).toHaveBeenCalledWith();
        const connection = server.on.mock.calls.find(([event]) => event === "connection")?.[1] as
            (socket: Record<string, unknown>) => Promise<void>;
        return { account, socket, connection, events };
    }

    it("records connect start and completion without counting a later disconnect as pre-ready", async () => {
        const { account, socket, connection, events } = await createConnection();
        const phases = vi.spyOn(metrics, "recordSocketConnectConvergencePhase");
        const durations = vi.spyOn(metrics, "recordSocketConnectConvergenceDuration");

        await connection(socket);
        expect(events.listenerCount("disconnect")).toBeGreaterThan(0);
        expect(eventRouter.getConnections(account.id)?.size).toBe(1);
        socket.connected = false;
        events.emit("disconnect", "transport close");
        expect(eventRouter.getConnections(account.id) === undefined).toBe(true);

        expect(phases).toHaveBeenCalledWith({ clientType: "user-scoped", transport: "websocket", phase: "start" });
        expect(phases).toHaveBeenCalledWith({ clientType: "user-scoped", transport: "websocket", phase: "complete" });
        expect(phases).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "disconnect_before_ready" }));
        expect(durations).toHaveBeenCalledWith(expect.objectContaining({ clientType: "user-scoped", transport: "websocket", result: "ready" }));
        expect(durations).not.toHaveBeenCalledWith(expect.objectContaining({ result: "disconnect_before_ready" }));
    });

    it("records a disconnect before ready when the socket drops during room join", async () => {
        const joined = deferred();
        const release = deferred();
        const { account, socket, connection, events } = await createConnection(async () => {
            joined.resolve();
            await release.promise;
        });
        const phases = vi.spyOn(metrics, "recordSocketConnectConvergencePhase");
        const durations = vi.spyOn(metrics, "recordSocketConnectConvergenceDuration");

        const connecting = connection(socket);
        await joined.promise;
        // Socket.IO changes connected before resolving the in-flight join. Admission
        // must refuse the socket without exposing authority-bearing listeners.
        socket.connected = false;
        release.resolve();
        await connecting;

        expect(socket.disconnect).toHaveBeenCalledWith(true);
        expect(eventRouter.getConnections(account.id) === undefined).toBe(true);
        expect(events.listenerCount("rpc-register")).toBe(0);
        expect(phases).toHaveBeenCalledWith({ clientType: "user-scoped", transport: "websocket", phase: "start" });
        expect(phases).toHaveBeenCalledWith({ clientType: "user-scoped", transport: "websocket", phase: "disconnect_before_ready" });
        expect(phases).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "complete" }));
        expect(durations).toHaveBeenCalledWith(expect.objectContaining({ clientType: "user-scoped", transport: "websocket", result: "disconnect_before_ready" }));
        expect(durations).not.toHaveBeenCalledWith(expect.objectContaining({ result: "ready" }));
    });
});
