import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { io as ioClient } from "socket.io-client";

import { auth } from "@/app/auth/auth";
import { startSocket } from "@/app/api/socket";
import type { Fastify as AppFastify } from "@/app/api/types";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { authRoutes } from "./authRoutes";

const SIGN_OUT_EVERYWHERE_PATH = "/v1/auth/sessions/sign-out-everywhere";

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    enableAuthentication(typed);
    startSocket(typed);
    authRoutes(typed);
    return typed;
}

async function waitForSocketConnection(socket: ReturnType<typeof ioClient>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
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

async function waitForSocketConnectionRejection(socket: ReturnType<typeof ioClient>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            socket.off("connect", onConnect);
            socket.off("connect_error", onConnectError);
        };
        const onConnect = () => {
            cleanup();
            reject(new Error("Socket connected with an epoch-revoked token"));
        };
        const onConnectError = () => {
            cleanup();
            resolve();
        };
        socket.on("connect", onConnect);
        socket.on("connect_error", onConnectError);
    });
}

async function waitForSocketReady(socket: ReturnType<typeof ioClient>): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve, reject) => {
        socket.timeout(5_000).emit("ping", (error: unknown) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

async function waitForSocketDisconnect(socket: ReturnType<typeof ioClient>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for Socket.IO disconnect"));
        }, 10_000);
        const cleanup = () => {
            clearTimeout(timeout);
            socket.off("disconnect", onDisconnect);
        };
        const onDisconnect = () => {
            cleanup();
            resolve();
        };
        socket.on("disconnect", onDisconnect);
    });
}

describe("authRoutes (sign out everywhere) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-sign-out-everywhere-",
            initAuth: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
                AUTH_LOGIN_ELIGIBILITY_ACCOUNT_SNAPSHOT_CACHE_TTL_MS: "0",
            },
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("bumps the authenticated Account epoch, immediately rejects its warmed signed token, and retains its API tokens", async () => {
        const account = await db.account.create({
            data: { publicKey: "sign-out-everywhere-owner" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);
        const pat = await auth.createApiToken({
            accountId: account.id,
            label: "Retained by sign out everywhere",
        });
        const app = createTestApp();
        await app.ready();

        try {
            const warmed = await app.inject({
                method: "GET",
                url: "/v1/auth/ping",
                headers: { authorization: `Bearer ${token}` },
            });
            expect(warmed.statusCode).toBe(200);

            const response = await app.inject({
                method: "POST",
                url: SIGN_OUT_EVERYWHERE_PATH,
                headers: { authorization: `Bearer ${token}` },
                payload: {},
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: "signed_out" });

            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: { tokenEpoch: true },
            })).resolves.toEqual({ tokenEpoch: 1 });

            const rejected = await app.inject({
                method: "GET",
                url: "/v1/auth/ping",
                headers: { authorization: `Bearer ${token}` },
            });
            expect(rejected.statusCode).toBe(401);

            await expect(auth.verifyToken(pat.token)).resolves.toMatchObject({
                userId: account.id,
                authTokenKind: "api_token",
                authority: "account_automation",
            });
        } finally {
            await app.close();
        }
    });

    it("does not let a PAT or caller-supplied Account id invoke sign out everywhere", async () => {
        const account = await db.account.create({
            data: { publicKey: "sign-out-everywhere-present-user" },
            select: { id: true },
        });
        const [signedToken, pat] = await Promise.all([
            auth.createToken(account.id),
            auth.createApiToken({ accountId: account.id, label: "Automation cannot sign out" }),
        ]);
        const app = createTestApp();
        await app.ready();

        try {
            const [automationResponse, retargetResponse] = await Promise.all([
                app.inject({
                    method: "POST",
                    url: SIGN_OUT_EVERYWHERE_PATH,
                    headers: { authorization: `Bearer ${pat.token}` },
                    payload: {},
                }),
                app.inject({
                    method: "POST",
                    url: SIGN_OUT_EVERYWHERE_PATH,
                    headers: { authorization: `Bearer ${signedToken}` },
                    payload: { accountId: "other-account" },
                }),
            ]);

            expect(automationResponse.statusCode).toBe(403);
            expect(automationResponse.json()).toEqual({ error: "present_user_required" });
            expect(retargetResponse.statusCode).toBe(400);
            expect(retargetResponse.json()).toEqual({ error: "invalid_request" });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: { tokenEpoch: true },
            })).resolves.toEqual({ tokenEpoch: 0 });
        } finally {
            await app.close();
        }
    });

    it("disconnects established user and user-machines Socket.IO sockets after the durable epoch bump", async () => {
        const account = await db.account.create({
            data: { publicKey: "sign-out-everywhere-socket-owner" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "sign-out-everywhere-machine",
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
        const app = createTestApp();
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        const port = typeof address === "object" && address ? address.port : null;
        if (!port) {
            await app.close();
            throw new Error("Failed to bind socket server");
        }

        const userSocket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: { token },
        });
        const machineSocket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: {
                token,
                clientType: "machine-scoped",
                machineId: "sign-out-everywhere-machine",
            },
        });

        try {
            const userConnected = waitForSocketConnection(userSocket);
            const machineConnected = waitForSocketConnection(machineSocket);
            userSocket.connect();
            machineSocket.connect();
            await Promise.all([userConnected, machineConnected]);
            await Promise.all([waitForSocketReady(userSocket), waitForSocketReady(machineSocket)]);

            const userDisconnected = waitForSocketDisconnect(userSocket);
            const machineDisconnected = waitForSocketDisconnect(machineSocket);
            const response = await app.inject({
                method: "POST",
                url: SIGN_OUT_EVERYWHERE_PATH,
                headers: { authorization: `Bearer ${token}` },
                payload: {},
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: "signed_out" });
            await Promise.all([userDisconnected, machineDisconnected]);
            expect(userSocket.connected).toBe(false);
            expect(machineSocket.connected).toBe(false);

            const oldTokenReconnect = ioClient(`http://127.0.0.1:${port}`, {
                path: "/v1/updates",
                transports: ["websocket"],
                reconnection: false,
                autoConnect: false,
                auth: { token },
            });
            try {
                const rejected = waitForSocketConnectionRejection(oldTokenReconnect);
                oldTokenReconnect.connect();
                await rejected;
            } finally {
                oldTokenReconnect.close();
            }

            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: { tokenEpoch: true },
            })).resolves.toEqual({ tokenEpoch: 1 });
        } finally {
            userSocket.close();
            machineSocket.close();
            await app.close();
        }
    }, 30_000);
});
