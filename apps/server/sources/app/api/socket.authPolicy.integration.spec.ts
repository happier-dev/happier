import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { io as ioClient } from "socket.io-client";

import { startSocket } from "./socket";
import type { Fastify as AppFastify } from "./types";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

type ProviderRequiredErrorPayload = {
    message: string;
    data: {
        error: string;
        provider?: string;
        statusCode?: number;
    } | null;
};

function parseConnectErrorPayload(err: unknown): ProviderRequiredErrorPayload {
    const obj = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
    const dataObj = typeof obj.data === "object" && obj.data !== null ? (obj.data as Record<string, unknown>) : null;
    return {
        message: typeof obj.message === "string" ? obj.message : String(err),
        data: dataObj
            ? {
                error: typeof dataObj.error === "string" ? dataObj.error : "unknown",
                provider: typeof dataObj.provider === "string" ? dataObj.provider : undefined,
                statusCode: typeof dataObj.statusCode === "number" ? dataObj.statusCode : undefined,
            }
            : null,
    };
}

async function waitForConnectionFailure(socket: ReturnType<typeof ioClient>): Promise<ProviderRequiredErrorPayload> {
    return await new Promise<ProviderRequiredErrorPayload>((resolve, reject) => {
        const cleanup = () => {
            socket.off("connect_error", onConnectError);
            socket.off("connect", onConnect);
        };

        const onConnectError = (err: unknown) => {
            cleanup();
            resolve(parseConnectErrorPayload(err));
        };

        const onConnect = () => {
            cleanup();
            reject(new Error("Socket connected unexpectedly - policy enforcement failed"));
        };

        socket.on("connect_error", onConnectError);
        socket.on("connect", onConnect);
    });
}

describe("startSocket (auth policy enforcement)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-socket-policy-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.unstubAllGlobals();
        harness.resetEnv();
        harness.resetEnv({ AUTH_REQUIRED_LOGIN_PROVIDERS: undefined });
    });

    afterEach(async () => {
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    it("disconnects a user-scoped socket when GitHub is required but the account has no GitHub identity", async () => {
        harness.resetEnv({ AUTH_REQUIRED_LOGIN_PROVIDERS: "github" });

        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
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

        const socket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            auth: { token },
        });

        let payload: ProviderRequiredErrorPayload;
        try {
            payload = await waitForConnectionFailure(socket);
        } finally {
            socket.close();
            await app.close();
        }

        expect(payload.message).toBe("provider-required");
        expect(payload.data).toEqual({
            error: "provider-required",
            provider: "github",
            statusCode: 403,
        });
    }, 30_000);

    it("disconnects a machine-scoped socket when the machine belongs to another account", async () => {
        const owningAccount = await db.account.create({
            data: { publicKey: `pk-owning-${Date.now()}` },
            select: { id: true },
        });
        const otherAccount = await db.account.create({
            data: { publicKey: `pk-other-${Date.now()}` },
            select: { id: true },
        });

        await db.machine.create({
            data: {
                id: "m-test",
                accountId: owningAccount.id,
                metadata: "metadata",
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                active: false,
            },
            select: { id: true },
        });

        const token = await auth.createToken(otherAccount.id);

        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        const port = typeof address === "object" && address ? address.port : null;
        if (!port) {
            await app.close();
            throw new Error("Failed to bind socket server");
        }

        const socket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            auth: { token, clientType: "machine-scoped", machineId: "m-test" },
        });

        let payload: ProviderRequiredErrorPayload;
        try {
            payload = await waitForConnectionFailure(socket);
        } finally {
            socket.close();
            await app.close();
        }

        expect(payload.message).toBe("invalid-machine");
        expect(payload.data).toEqual({
            error: "invalid-machine",
            provider: undefined,
            statusCode: 403,
        });
    }, 30_000);

    it("disconnects a session-scoped socket when machineId is provided without a bound access key", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });

        await db.machine.create({
            data: {
                id: "m-test",
                accountId: account.id,
                metadata: "metadata",
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                active: false,
            },
            select: { id: true },
        });

        await db.session.create({
            data: { id: "s-test", tag: `t-${Date.now()}`, accountId: account.id, encryptionMode: "e2ee", metadata: "{}" },
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

        const socket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            auth: {
                token,
                clientType: "session-scoped",
                sessionId: "s-test",
                machineId: "m-test",
            },
        });

        let payload: ProviderRequiredErrorPayload;
        try {
            payload = await waitForConnectionFailure(socket);
        } finally {
            socket.close();
            await app.close();
        }

        expect(payload.message).toBe("invalid-session-access-key");
        expect(payload.data).toEqual({
            error: "invalid-session-access-key",
            statusCode: 403,
        });
    }, 30_000);

    it("disconnects a session-scoped socket when the claimed session does not belong to the authenticated account", async () => {
        const owner = await db.account.create({
            data: { publicKey: `pk-owner-${Date.now()}` },
            select: { id: true },
        });
        const otherAccount = await db.account.create({
            data: { publicKey: `pk-other-${Date.now()}` },
            select: { id: true },
        });

        await db.session.create({
            data: { id: "s-foreign", tag: `t-${Date.now()}`, accountId: owner.id, encryptionMode: "e2ee", metadata: "{}" },
        });

        const token = await auth.createToken(otherAccount.id);

        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        const port = typeof address === "object" && address ? address.port : null;
        if (!port) {
            await app.close();
            throw new Error("Failed to bind socket server");
        }

        const socket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            auth: {
                token,
                clientType: "session-scoped",
                sessionId: "s-foreign",
            },
        });

        let payload: ProviderRequiredErrorPayload;
        try {
            payload = await waitForConnectionFailure(socket);
        } finally {
            socket.close();
            await app.close();
        }

        expect(payload.message).toBe("invalid-session");
        expect(payload.data).toEqual({
            error: "invalid-session",
            statusCode: 403,
        });
    }, 30_000);
});
