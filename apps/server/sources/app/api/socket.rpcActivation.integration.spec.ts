import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { io as ioClient } from "socket.io-client";

import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
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

    it("accepts an RPC registered immediately from an admitted machine socket connect callback", async () => {
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
        const token = await auth.createToken(account.id);

        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
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
        } finally {
            machineSocket.close();
            callerSocket.close();
            await app.close();
        }
    }, 30_000);
});
