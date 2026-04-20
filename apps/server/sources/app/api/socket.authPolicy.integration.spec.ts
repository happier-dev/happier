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
        owner?: {
            cliVersion?: string;
            publicReleaseChannel?: string;
            startupSource?: string;
            serviceManaged?: boolean;
            serviceLabel?: string;
        };
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
                owner: typeof dataObj.owner === "object" && dataObj.owner !== null
                    ? {
                        cliVersion: typeof (dataObj.owner as Record<string, unknown>).cliVersion === "string"
                            ? (dataObj.owner as Record<string, unknown>).cliVersion as string
                            : undefined,
                        publicReleaseChannel: typeof (dataObj.owner as Record<string, unknown>).publicReleaseChannel === "string"
                            ? (dataObj.owner as Record<string, unknown>).publicReleaseChannel as string
                            : undefined,
                        startupSource: typeof (dataObj.owner as Record<string, unknown>).startupSource === "string"
                            ? (dataObj.owner as Record<string, unknown>).startupSource as string
                            : undefined,
                        serviceManaged: typeof (dataObj.owner as Record<string, unknown>).serviceManaged === "boolean"
                            ? (dataObj.owner as Record<string, unknown>).serviceManaged as boolean
                            : undefined,
                        serviceLabel: typeof (dataObj.owner as Record<string, unknown>).serviceLabel === "string"
                            ? (dataObj.owner as Record<string, unknown>).serviceLabel as string
                            : undefined,
                    }
                    : undefined,
            }
            : null,
    };
}

async function waitForConnectionSuccess(socket: ReturnType<typeof ioClient>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            socket.off("connect", onConnect);
            socket.off("connect_error", onConnectError);
        };

        const onConnect = () => {
            cleanup();
            resolve();
        };

        const onConnectError = (err: unknown) => {
            cleanup();
            reject(err);
        };

        socket.on("connect", onConnect);
        socket.on("connect_error", onConnectError);
    });
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

    it("disconnects a machine-scoped socket when a required login provider is missing", async () => {
        harness.resetEnv({ AUTH_REQUIRED_LOGIN_PROVIDERS: "github" });

        const account = await db.account.create({
            data: { publicKey: `pk-machine-provider-${Date.now()}` },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "m-provider-required",
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

        const socket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            auth: {
                token,
                clientType: "machine-scoped",
                machineId: "m-provider-required",
            },
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
            owner: undefined,
        });
    }, 30_000);

    it("rejects a second machine-scoped socket when another live owner already holds the machine", async () => {
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

        const ownerSocket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: {
                token,
                clientType: "machine-scoped",
                machineId: "m-test",
                runtimeId: "runtime-stable",
                cliVersion: "0.2.0",
                publicReleaseChannel: "stable",
                startupSource: "background-service",
                serviceManaged: true,
                serviceLabel: "com.happier.cli.daemon.default",
            },
        });

        const conflictingSocket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: {
                token,
                clientType: "machine-scoped",
                machineId: "m-test",
                runtimeId: "runtime-dev",
                cliVersion: "0.2.4-dev",
                publicReleaseChannel: "dev",
                startupSource: "manual",
                serviceManaged: false,
            },
        });

        let payload: ProviderRequiredErrorPayload;
        try {
            ownerSocket.connect();
            await waitForConnectionSuccess(ownerSocket);
            const failurePromise = waitForConnectionFailure(conflictingSocket);
            conflictingSocket.connect();
            payload = await failurePromise;
        } finally {
            ownerSocket.close();
            conflictingSocket.close();
            await app.close();
        }

        expect(payload.message).toBe("machine-owner-conflict");
        expect(payload.data).toEqual({
            error: "machine-owner-conflict",
            provider: undefined,
            statusCode: 409,
            owner: {
                cliVersion: "0.2.0",
                publicReleaseChannel: "stable",
                startupSource: "background-service",
                serviceManaged: true,
                serviceLabel: "com.happier.cli.daemon.default",
            },
        });
    }, 30_000);

    it("accepts sparse ownership metadata and ignores invalid ownership fields during machine auth", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });

        await db.machine.create({
            data: {
                id: "m-sparse",
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

        const ownerSocket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: {
                token,
                clientType: "machine-scoped",
                machineId: "m-sparse",
                runtimeId: "runtime-sparse",
                cliVersion: "0.2.0",
                startupSource: "invalid",
                serviceManaged: "yes",
                extraFutureField: "future",
            },
        });

        try {
            ownerSocket.connect();
            await waitForConnectionSuccess(ownerSocket);
        } finally {
            ownerSocket.close();
            await app.close();
        }
    }, 30_000);

    it("rejects takeover when the current owner is a background service", async () => {
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

        const ownerSocket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            auth: {
                token,
                clientType: "machine-scoped",
                machineId: "m-test",
                runtimeId: "runtime-stable",
                cliVersion: "0.2.0",
                publicReleaseChannel: "stable",
                startupSource: "background-service",
                serviceManaged: true,
                serviceLabel: "com.happier.cli.daemon.default",
            },
        });

        const takeoverSocket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: {
                token,
                clientType: "machine-scoped",
                machineId: "m-test",
                runtimeId: "runtime-dev",
                cliVersion: "0.2.4-dev",
                publicReleaseChannel: "dev",
                startupSource: "manual",
                serviceManaged: false,
                takeover: true,
            },
        });

        let payload: ProviderRequiredErrorPayload;
        let ownerConnectedState = false;
        try {
            await waitForConnectionSuccess(ownerSocket);
            takeoverSocket.connect();
            payload = await waitForConnectionFailure(takeoverSocket);
            ownerConnectedState = ownerSocket.connected;
        } finally {
            ownerSocket.close();
            takeoverSocket.close();
            await app.close();
        }

        expect(payload.message).toBe("machine-owner-conflict");
        expect(payload.data).toEqual({
            error: "machine-owner-conflict",
            provider: undefined,
            statusCode: 409,
            owner: {
                cliVersion: "0.2.0",
                publicReleaseChannel: "stable",
                startupSource: "background-service",
                serviceManaged: true,
                serviceLabel: "com.happier.cli.daemon.default",
            },
        });
        expect(ownerConnectedState).toBe(true);
    }, 30_000);

    it("allows takeover only when the current owner is manual", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });

        await db.machine.create({
            data: {
                id: "m-test-manual",
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

        const ownerSocket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            auth: {
                token,
                clientType: "machine-scoped",
                machineId: "m-test-manual",
                runtimeId: "runtime-manual",
                cliVersion: "0.2.0",
                publicReleaseChannel: "stable",
                startupSource: "manual",
                serviceManaged: false,
            },
        });

        const takeoverSocket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: {
                token,
                clientType: "machine-scoped",
                machineId: "m-test-manual",
                runtimeId: "runtime-dev",
                cliVersion: "0.2.4-dev",
                publicReleaseChannel: "dev",
                startupSource: "manual",
                serviceManaged: false,
                takeover: true,
            },
        });

        try {
            await waitForConnectionSuccess(ownerSocket);

            const ownerDisconnected = new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("timed out waiting for owner socket disconnect")), 10_000);
                ownerSocket.once("disconnect", () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });

            const takeoverConnected = waitForConnectionSuccess(takeoverSocket);
            takeoverSocket.connect();

            await takeoverConnected;
            await ownerDisconnected;

            expect(takeoverSocket.connected).toBe(true);
            expect(ownerSocket.connected).toBe(false);
        } finally {
            ownerSocket.close();
            takeoverSocket.close();
            await app.close();
        }
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
