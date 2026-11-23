import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { io as ioClient } from "socket.io-client";
import { Server } from "socket.io";

import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { resolveCurrentMachineRecipientAccountIdsInTx } from "@/app/machines/machineAccess";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { startSocket } from "./socket";
import type { Fastify as AppFastify } from "./types";

function waitForConnection(socket: ReturnType<typeof ioClient>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            socket.off("connect", onConnect);
            socket.off("connect_error", onConnectError);
        };
        const onConnect = () => {
            cleanup();
            resolve();
        };
        const onConnectError = (error: unknown) => {
            cleanup();
            reject(error);
        };

        socket.on("connect", onConnect);
        socket.on("connect_error", onConnectError);
    });
}

function waitForRegistration(
    socket: ReturnType<typeof ioClient>,
    method: string,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for immediate RPC registration: ${method}`));
        }, 5_000);
        const cleanup = () => {
            clearTimeout(timeout);
            socket.off(SOCKET_RPC_EVENTS.REGISTERED, onRegistered);
            socket.off(SOCKET_RPC_EVENTS.ERROR, onError);
        };
        const onRegistered = (payload: unknown) => {
            if (
                typeof payload === "object"
                && payload !== null
                && (payload as { method?: unknown }).method === method
            ) {
                cleanup();
                resolve();
            }
        };
        const onError = (payload: unknown) => {
            cleanup();
            reject(new Error(`Immediate RPC registration failed: ${JSON.stringify(payload)}`));
        };

        socket.on(SOCKET_RPC_EVENTS.REGISTERED, onRegistered);
        socket.on(SOCKET_RPC_EVENTS.ERROR, onError);
    });
}

describe("startSocket RPC activation", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-socket-rpc-activation-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    afterEach(async () => {
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    it("publishes Machine presence on admitted connections, clean disconnects, and reconnects", async () => {
        const machineId = "m-presence-reconnect";
        const account = await db.account.create({ data: { publicKey: `presence-${Date.now()}` } });
        await db.machine.create({ data: {
            id: machineId, accountId: account.id, metadata: "metadata", metadataVersion: 1,
            daemonState: null, daemonStateVersion: 0, active: false,
        } });
        // Establish the real heartbeat audience before waiting on transport;
        // storage/schema failures must surface instead of timing out silently.
        expect(await inTx(tx => resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId))).toEqual([account.id]);
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (typeof address !== "object" || !address) throw new Error("Failed to bind socket server");
        const options = { path: "/v1/updates", transports: ["websocket"], reconnection: false, autoConnect: false };
        const reader = ioClient(`http://127.0.0.1:${address.port}`, { ...options, auth: { token } });
        const daemon = ioClient(`http://127.0.0.1:${address.port}`, { ...options, auth: {
            token, clientType: "machine-scoped", machineId, runtimeId: "presence-runtime",
            startupSource: "manual", serviceManaged: false,
        } });
        const nextPresence = () => new Promise<Record<string, unknown>>(resolve => {
            const receive = (payload: Record<string, unknown>) => {
                if (payload.type !== "machine-activity" || payload.id !== machineId) return;
                reader.off("ephemeral", receive);
                resolve(payload);
            };
            reader.on("ephemeral", receive);
        });
        try {
            const readerConnected = waitForConnection(reader);
            reader.connect();
            await readerConnected;
            // An acknowledged request passes the real admission hold, ensuring
            // this authenticated reader is ready before daemon admission.
            await reader.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.CALL, { method: `${machineId}:neutral.probe`, params: {} });

            const admitted = nextPresence();
            daemon.connect();
            expect(await admitted).toMatchObject({ type: "machine-activity", id: machineId, active: true, reconnected: true });

            const disconnected = nextPresence();
            daemon.disconnect();
            expect(await disconnected).toEqual({ type: "machine-activity", id: machineId, active: false, activeAt: expect.any(Number) });

            const reconnected = nextPresence();
            daemon.connect();
            expect(await reconnected).toMatchObject({ type: "machine-activity", id: machineId, active: true, reconnected: true });
        } finally {
            daemon.close();
            reader.close();
            await app.close();
        }
    });

    it("admits the initial RPC registration exactly once after delayed post-connect room admission", async () => {
        const machineId = "m-rpc-activation";
        const method = `${machineId}:neutral.immediate`;
        const sentinel = { source: "machine-connect-callback", value: 42 };
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: machineId,
                accountId: account.id,
                metadata: "metadata",
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                active: false,
            },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });

        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        const server = app.machineDaemonPresence;
        if (!(server instanceof Server)) throw new Error("Expected the live Socket.IO server");
        let initializing = false;
        let releaseRead: () => void = () => {};
        const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
        let readArrived: () => void = () => {};
        const firstRead = new Promise<void>((resolve) => { readArrived = resolve; });
        let packetArrived: () => void = () => {};
        const firstPacket = new Promise<void>((resolve) => { packetArrived = resolve; });
        server.prependOnceListener("connection", (socket) => {
            initializing = true;
            socket.onAny((event: string) => {
                if (event === SOCKET_RPC_EVENTS.REGISTER) packetArrived();
            });
        });
        // Delay the real Socket.IO adapter boundary. Authentication, packet
        // admission and handler registration remain the production path.
        const adapter = server.of('/').adapter;
        const originalAddAll = adapter.addAll.bind(adapter);
        const admissionSpy = vi.spyOn(adapter, "addAll").mockImplementation((...args) => {
            if (!initializing) return originalAddAll(...args);
            readArrived();
            return readReleased.then(() => originalAddAll(...args));
        });
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        const port = typeof address === "object" && address ? address.port : null;
        if (!port) {
            await app.close();
            throw new Error("Failed to bind socket server");
        }

        const machineSocket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: {
                token,
                clientType: "machine-scoped",
                machineId,
                runtimeId: "runtime-rpc-activation",
                startupSource: "manual",
                serviceManaged: false,
            },
        });
        const callerSocket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: { token },
        });

        try {
            const registered = waitForRegistration(machineSocket, method);
            let registrationCount = 0;
            machineSocket.on(SOCKET_RPC_EVENTS.REGISTERED, () => { registrationCount += 1; });
            machineSocket.on("connect", () => {
                machineSocket.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
            });
            machineSocket.on(
                SOCKET_RPC_EVENTS.REQUEST,
                (
                    _request: unknown,
                    acknowledge: (response: unknown) => void,
                ) => {
                    acknowledge(sentinel);
                },
            );

            const machineConnected = waitForConnection(machineSocket);
            machineSocket.connect();
            await machineConnected;
            await Promise.all([firstPacket, firstRead]);
            initializing = false;
            releaseRead();
            await registered;

            const callerConnected = waitForConnection(callerSocket);
            callerSocket.connect();
            await callerConnected;

            const response = await callerSocket.timeout(5_000).emitWithAck(
                SOCKET_RPC_EVENTS.CALL,
                {
                    method,
                    params: { probe: "after-admission" },
                },
            );

            expect(response).toEqual({
                ok: true,
                result: sentinel,
            });
            expect(registrationCount).toBe(1);
        } finally {
            releaseRead();
            admissionSpy.mockRestore();
            machineSocket.close();
            callerSocket.close();
            await app.close();
        }
    }, 30_000);
});
