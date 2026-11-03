import { stopLocalMachinePresenceTimeout } from '@/app/presence/timeout';
import tweetnacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { encodeBase64 as encodeProtocolBase64 } from '@happier-dev/protocol/crypto/base64';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import Fastify from "fastify";
import { Server } from "socket.io";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { io as ioClient } from "socket.io-client";

import { startSocket } from "./socket";
import { getAccountRevocationSocketRoom } from "./socketRooms";
import type { Fastify as AppFastify } from "./types";
import { auth } from "@/app/auth/auth";
import { db, withSqliteReadSnapshot } from "@/storage/db";
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

function waitForHandlerUsabilityOrDisconnect(
    socket: ReturnType<typeof ioClient>,
): Promise<"handler_usable" | "disconnected"> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for revocation to disconnect post-connect admission"));
        }, 5_000);
        const cleanup = () => {
            clearTimeout(timeout);
            socket.off("disconnect", onDisconnect);
            socket.off("connect_error", onConnectError);
        };
        const onDisconnect = () => {
            cleanup();
            resolve("disconnected");
        };
        const onConnectError = () => {
            cleanup();
            resolve("disconnected");
        };

        socket.on("disconnect", onDisconnect);
        socket.on("connect_error", onConnectError);
        void socket.timeout(1_000).emitWithAck("ping").then(
            () => {
                cleanup();
                resolve("handler_usable");
            },
            () => {},
        );
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

function deferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolvePromise: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: () => resolvePromise?.(),
    };
}

function pausePrismaQuery<T extends object>(query: T, release: Promise<void>): T {
    return new Proxy(query, {
        get(target, property, receiver) {
            if (property !== "then") {
                return Reflect.get(target, property, receiver);
            }
            const then = Reflect.get(target, property, target);
            if (typeof then !== "function") {
                return then;
            }
            return (...args: unknown[]) => release.then(() => Reflect.apply(then, target, args));
        },
    });
}

type PausedAdmissionBoundary = Readonly<{
    reached: Promise<void>;
    release: () => void;
    restore: () => void;
}>;

async function pausePostConnectAccountCurrentnessRead(
    server: Server,
    accountId: string,
): Promise<PausedAdmissionBoundary> {
    const reached = deferred();
    const release = deferred();
    const accountReader = await withSqliteReadSnapshot(async reader => reader.account);
    const originalFindUnique = accountReader.findUnique;
    let paused = false;
    // Intercept only the persistence boundary once the real socket has joined
    // the revocation room. No verifier is mocked or selected by call count.
    const findUniqueSpy = vi.spyOn(accountReader, "findUnique").mockImplementation((...args) => {
        const query = originalFindUnique(...args);
        if (
            paused
            || args[0].where.id !== accountId
            || args[0].select?.tokenEpoch !== true
            || !server.sockets.adapter.rooms.has(getAccountRevocationSocketRoom(accountId))
        ) return query;
        paused = true;
        return new Proxy(query, {
            get(target, property, receiver) {
                if (property !== "then") return Reflect.get(target, property, receiver);
                return (...callbacks: unknown[]) => {
                    const result = Promise.resolve(target).then(async (value) => {
                        // Preserve the database's real result, including the old
                        // epoch, while a lifecycle mutation commits concurrently.
                        reached.resolve();
                        await release.promise;
                        return value;
                    });
                    return Reflect.apply(result.then, result, callbacks);
                };
            },
        });
    });
    return {
        reached: reached.promise,
        release: release.resolve,
        restore: () => {
            findUniqueSpy.mockRestore();
            Reflect.set(accountReader, "findUnique", originalFindUnique);
        },
    };
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
        await stopLocalMachinePresenceTimeout();
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    it.each(['installation-id', 'public-key'])('refuses a displaced %s on its next authenticated connection', async (change) => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const oldKey = tweetnacl.sign.keyPair();
        const newKey = change === 'public-key' ? tweetnacl.sign.keyPair() : oldKey;
        const machine = await db.machine.create({ data: {
            id: `rebound-${account.id}`, accountId: account.id,
            installationId: change === 'installation-id' ? 'installation-new' : 'installation-old',
            installationPublicKey: new Uint8Array(newKey.publicKey),
            metadata: encodePlainMachineStoredContent({ host: 'rebound' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)),
        } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Missing socket listener');
        const socket = ioClient(`http://127.0.0.1:${address.port}`, { path: '/v1/updates', transports: ['websocket'],
            reconnection: false, autoConnect: false, auth: { token, clientType: 'machine-scoped', machineId: machine.id,
                runtimeId: 'displaced-runtime', startupSource: 'manual', serviceManaged: false,
                installationId: 'installation-old', installationPublicKey: encodeProtocolBase64(oldKey.publicKey, 'base64url'),
                installationProof: signMachineInstallationProof({ payload: { version: 1, installationId: 'installation-old',
                    machineId: machine.id, accountId: account.id }, privateKey: oldKey.secretKey }) } });
        try {
            const connection = waitForConnectionSuccess(socket);
            socket.connect();
            await expect(connection).rejects.toMatchObject({ data: { error: 'machine_revoked', statusCode: 410 } });
            expect(socket.connected).toBe(false);
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toMatchObject({
                installationId: machine.installationId, revokedAt: null,
            });
        } finally {
            socket.disconnect();
            await app.close();
        }
    });

    it('admits connect only when ready and keeps superseded and ordinary disconnects out of presence transitions', async () => {
        const account = await db.account.create({ data: { publicKey: `presence-socket-${Date.now()}` } });
        const lastSeen = new Date(Date.now() - 70_000);
        const contentAt = new Date('2025-01-01T00:00:00.000Z');
        const machine = await db.machine.create({ data: { id: `presence-socket-${account.id}`, accountId: account.id,
            metadata: 'metadata', active: false, lastActiveAt: lastSeen, updatedAt: contentAt } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Missing socket listener');
        const url = `http://127.0.0.1:${address.port}`;
        const connect = (extra: Record<string, unknown>) => ioClient(url, { path: '/v1/updates', transports: ['websocket'],
            reconnection: false, autoConnect: false, auth: { token, ...extra } });
        const viewer = connect({ clientType: 'user-scoped' });
        const publisher = () => connect({ clientType: 'machine-scoped', machineId: machine.id,
            runtimeId: 'same-runtime-reconnect', startupSource: 'manual', serviceManaged: false });
        const first = publisher();
        const replacement = publisher();
        const activities: unknown[] = [];
        viewer.on('ephemeral', payload => { if (payload?.type === 'machine-activity') activities.push(payload); });
        try {
            let connected = waitForConnectionSuccess(viewer); viewer.connect(); await connected;
            await viewer.timeout(10_000).emitWithAck('ping');
            connected = waitForConnectionSuccess(first); first.connect(); await connected;
            await first.timeout(10_000).emitWithAck('ping');
            const admitted = await db.machine.findUniqueOrThrow({ where: { id: machine.id } });
            expect.soft(admitted.active).toBe(true);
            expect.soft(admitted.lastActiveAt.getTime()).toBeGreaterThan(lastSeen.getTime());
            expect(admitted.updatedAt).toEqual(contentAt);
            await viewer.timeout(10_000).emitWithAck('ping');
            expect(activities).toHaveLength(1);
            activities.length = 0;
            const disconnected = new Promise<void>(resolve => { first.once('disconnect', () => resolve()); });
            connected = waitForConnectionSuccess(replacement); replacement.connect(); await connected;
            await disconnected;
            await replacement.timeout(10_000).emitWithAck('ping');
            await viewer.timeout(10_000).emitWithAck('ping');
            // Explicit incumbent reconnect recovery remains until D4; it must
            // not overlap a stale old socket's invented false transition.
            expect.soft(activities).toMatchObject([{ type: 'machine-activity', id: machine.id,
                active: true, reconnected: true }]);
            expect.soft(activities).toHaveLength(1);
            activities.length = 0;
            const beforeDisconnect = await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true, updatedAt: true } });
            replacement.close();
            await viewer.timeout(10_000).emitWithAck('ping');
            expect(activities).toEqual([]);
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true, updatedAt: true } })).toEqual(beforeDisconnect);
        } finally {
            first.close(); replacement.close(); viewer.close(); await app.close();
        }
    }, 60_000);

    it("disconnects a user-scoped socket when GitHub is required but the account has no GitHub identity", async () => {
        harness.resetEnv({ AUTH_REQUIRED_LOGIN_PROVIDERS: "github" });

        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });

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

    it("rejects an API token before it can enter every generic Socket.IO admission family", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-api-token-${Date.now()}` },
            select: { id: true },
        });
        const apiToken = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Socket admission must reject this",
        });

        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        const port = typeof address === "object" && address ? address.port : null;
        if (!port) {
            await app.close();
            throw new Error("Failed to bind socket server");
        }

        try {
            for (const admission of [
                { name: "user", auth: {} },
                {
                    name: "session",
                    auth: { clientType: "session-scoped", sessionId: "session-api-token-rejected" },
                },
                {
                    name: "machine",
                    auth: { clientType: "machine-scoped", machineId: "machine-api-token-rejected" },
                },
            ] as const) {
                const socket = ioClient(`http://127.0.0.1:${port}`, {
                    path: "/v1/updates",
                    transports: ["websocket"],
                    reconnection: false,
                    auth: { token: apiToken.token, ...admission.auth },
                });

                try {
                    const payload = await waitForConnectionFailure(socket);
                    expect(payload.message, admission.name).toBe("invalid-token");
                    expect(payload.data, admission.name).toEqual({
                        error: "invalid-token",
                        provider: undefined,
                        statusCode: 401,
                        owner: undefined,
                    });
                } finally {
                    socket.close();
                }
            }
        } finally {
            await app.close();
        }
    }, 30_000);

    it("rejects an Account Directory token before it can enter every generic Socket.IO admission family", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-account-directory-${Date.now()}` },
            select: { id: true },
        });
        // The restricted Directory kind is minted here only to prove the
        // negative admission contract; no production Home route mints it.
        const directoryToken = await auth.createToken(account.id, undefined, {
            kind: "account_directory",
            authority: "present_user",
        });

        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        const port = typeof address === "object" && address ? address.port : null;
        if (!port) {
            await app.close();
            throw new Error("Failed to bind socket server");
        }

        try {
            for (const admission of [
                { name: "user", auth: {} },
                {
                    name: "session",
                    auth: { clientType: "session-scoped", sessionId: "session-directory-token-rejected" },
                },
                {
                    name: "machine",
                    auth: { clientType: "machine-scoped", machineId: "machine-directory-token-rejected" },
                },
            ] as const) {
                const socket = ioClient(`http://127.0.0.1:${port}`, {
                    path: "/v1/updates",
                    transports: ["websocket"],
                    reconnection: false,
                    auth: { token: directoryToken, ...admission.auth },
                });

                try {
                    const payload = await waitForConnectionFailure(socket);
                    expect(payload.message, admission.name).toBe("invalid-token");
                    expect(payload.data, admission.name).toEqual({
                        error: "invalid-token",
                        provider: undefined,
                        statusCode: 401,
                        owner: undefined,
                    });
                } finally {
                    socket.close();
                }
            }
        } finally {
            await app.close();
        }
    }, 30_000);

    it("rejects user, session, and machine admissions when their token epoch advances after initial verification", async () => {
        const admissions = [
            {
                name: "user",
                configure: async (_accountId: string): Promise<Readonly<Record<string, string>>> => ({}),
                // User admission has no separate entity lookup after token verification.
                // Pause its existing final currentness read, not the removed duplicate
                // eligibility lookup. Session and Machine retain their earlier lookups.
                pauseAdmission: pausePostConnectAccountCurrentnessRead,
            },
            {
                name: "session",
                configure: async (accountId: string): Promise<Readonly<Record<string, string>>> => {
                    const sessionId = `s-epoch-race-${Date.now()}`;
                    await db.session.create({
                        data: {
                            id: sessionId,
                            tag: `t-epoch-race-${Date.now()}`,
                            accountId,
                            encryptionMode: "e2ee",
                            metadata: "{}",
                        },
                    });
                    return { clientType: "session-scoped", sessionId };
                },
                pauseAdmission: (): PausedAdmissionBoundary => {
                    const admissionReached = deferred();
                    const releaseAdmission = deferred();
                    const originalFindUnique = db.session.findUnique;
                    const findUniqueSpy = vi.spyOn(db.session, "findUnique").mockImplementation((...args) => {
                        admissionReached.resolve();
                        return pausePrismaQuery(originalFindUnique(...args), releaseAdmission.promise);
                    });
                    return {
                        reached: admissionReached.promise,
                        release: releaseAdmission.resolve,
                        restore: () => {
                            findUniqueSpy.mockRestore();
                            Reflect.set(db.session, "findUnique", originalFindUnique);
                        },
                    };
                },
            },
            {
                name: "machine",
                configure: async (accountId: string): Promise<Readonly<Record<string, string>>> => {
                    const machineId = `m-epoch-race-${Date.now()}`;
                    await db.machine.create({
                        data: {
                            id: machineId,
                            accountId,
                            metadata: "metadata",
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                            active: false,
                        },
                    });
                    return { clientType: "machine-scoped", machineId };
                },
                pauseAdmission: (): PausedAdmissionBoundary => {
                    const admissionReached = deferred();
                    const releaseAdmission = deferred();
                    const originalFindFirst = db.machine.findFirst;
                    const findFirstSpy = vi.spyOn(db.machine, "findFirst").mockImplementation((...args) => {
                        admissionReached.resolve();
                        return pausePrismaQuery(originalFindFirst(...args), releaseAdmission.promise);
                    });
                    return {
                        reached: admissionReached.promise,
                        release: releaseAdmission.resolve,
                        restore: () => {
                            findFirstSpy.mockRestore();
                            Reflect.set(db.machine, "findFirst", originalFindFirst);
                        },
                    };
                },
            },
        ] as const;

        for (const admission of admissions) {
            const account = await db.account.create({
                data: { publicKey: `pk-epoch-race-${admission.name}-${Date.now()}` },
                select: { id: true },
            });
            const token = await auth.createToken(account.id, undefined, {
                kind: "account",
                authority: "present_user",
            });
            const socketAuth = await admission.configure(account.id);
            const app = Fastify({ logger: false }) as unknown as AppFastify;
            startSocket(app);
            const socketServer = app.machineDaemonPresence;
            if (!(socketServer instanceof Server)) throw new Error("Expected the live Socket.IO server");
            const pausedAdmission = await admission.pauseAdmission(socketServer, account.id);
            await app.listen({ port: 0, host: "127.0.0.1" });
            const address = app.server.address();
            const port = typeof address === "object" && address ? address.port : null;
            if (!port) {
                pausedAdmission.restore();
                await app.close();
                throw new Error("Failed to bind socket server");
            }

            const socket = ioClient(`http://127.0.0.1:${port}`, {
                path: "/v1/updates",
                transports: ["websocket"],
                reconnection: false,
                autoConnect: false,
                auth: { token, ...socketAuth },
            });

            try {
                const outcome = waitForHandlerUsabilityOrDisconnect(socket);
                socket.connect();
                await pausedAdmission.reached;
                await auth.signOutEverywhere(account.id);
                app.disconnectAccountSockets(account.id);
                pausedAdmission.release();

                await expect(outcome, admission.name).resolves.toBe("disconnected");
            } finally {
                pausedAdmission.release();
                socket.close();
                pausedAdmission.restore();
                await app.close();
            }
        }
    }, 30_000);

    it("keeps user, session, and machine sockets handler-inert when sign-out races post-connect epoch verification", async () => {
        const admissions = [
            {
                name: "user",
                configure: async (_accountId: string): Promise<Readonly<Record<string, string>>> => ({}),
            },
            {
                name: "session",
                configure: async (accountId: string): Promise<Readonly<Record<string, string>>> => {
                    const sessionId = `s-post-connect-epoch-${Date.now()}`;
                    await db.session.create({
                        data: {
                            id: sessionId,
                            tag: `t-post-connect-epoch-${Date.now()}`,
                            accountId,
                            encryptionMode: "e2ee",
                            metadata: "{}",
                        },
                    });
                    return { clientType: "session-scoped", sessionId };
                },
            },
            {
                name: "machine",
                configure: async (accountId: string): Promise<Readonly<Record<string, string>>> => {
                    const machineId = `m-post-connect-epoch-${Date.now()}`;
                    await db.machine.create({
                        data: {
                            id: machineId,
                            accountId,
                            metadata: "metadata",
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                            active: false,
                        },
                    });
                    return { clientType: "machine-scoped", machineId };
                },
            },
        ] as const;

        for (const admission of admissions) {
            const account = await db.account.create({
                data: { publicKey: `pk-post-connect-epoch-${admission.name}-${Date.now()}` },
                select: { id: true },
            });
            const token = await auth.createToken(account.id, undefined, {
                kind: "account",
                authority: "present_user",
            });
            const socketAuth = await admission.configure(account.id);
            const app = Fastify({ logger: false }) as unknown as AppFastify;
            startSocket(app);
            const socketServer = app.machineDaemonPresence;
            if (!(socketServer instanceof Server)) throw new Error("Expected the live Socket.IO server");
            const pausedCurrentness = await pausePostConnectAccountCurrentnessRead(socketServer, account.id);
            await app.listen({ port: 0, host: "127.0.0.1" });
            const address = app.server.address();
            const port = typeof address === "object" && address ? address.port : null;
            if (!port) {
                pausedCurrentness.release();
                pausedCurrentness.restore();
                await app.close();
                throw new Error("Failed to bind socket server");
            }

            const socket = ioClient(`http://127.0.0.1:${port}`, {
                path: "/v1/updates",
                transports: ["websocket"],
                reconnection: false,
                autoConnect: false,
                auth: { token, ...socketAuth },
            });

            try {
                socket.connect();
                await pausedCurrentness.reached;
                const outcome = waitForHandlerUsabilityOrDisconnect(socket);
                await auth.signOutEverywhere(account.id);
                app.disconnectAccountSockets(account.id);
                pausedCurrentness.release();

                await expect(outcome).resolves.toBe("disconnected");
            } finally {
                pausedCurrentness.release();
                socket.close();
                pausedCurrentness.restore();
                await app.close();
            }
        }
    }, 30_000);

    it("keeps protected fanout rooms unavailable until final token currentness succeeds", async () => {
        const admissions = [
            {
                name: "user",
                configure: async (accountId: string) => ({
                    socketAuth: {} as Readonly<Record<string, string>>,
                    protectedRoom: `user-scoped:${accountId}`,
                }),
            },
            {
                name: "session",
                configure: async (accountId: string) => {
                    const sessionId = `s-room-currentness-${crypto.randomUUID()}`;
                    await db.session.create({
                        data: {
                            id: sessionId,
                            tag: `t-room-currentness-${crypto.randomUUID()}`,
                            accountId,
                            encryptionMode: "e2ee",
                            metadata: "{}",
                        },
                    });
                    return {
                        socketAuth: { clientType: "session-scoped", sessionId },
                        protectedRoom: `session:${sessionId}:${accountId}`,
                    };
                },
            },
            {
                name: "machine",
                configure: async (accountId: string) => {
                    const machineId = `m-room-currentness-${crypto.randomUUID()}`;
                    await db.machine.create({
                        data: {
                            id: machineId,
                            accountId,
                            metadata: "metadata",
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                            active: false,
                        },
                    });
                    return {
                        socketAuth: { clientType: "machine-scoped", machineId },
                        protectedRoom: `machine:${machineId}:${accountId}`,
                    };
                },
            },
        ] as const;

        for (const admission of admissions) {
            const account = await db.account.create({
                data: { publicKey: `pk-room-currentness-${admission.name}-${crypto.randomUUID()}` },
                select: { id: true },
            });
            const token = await auth.createToken(account.id, undefined, {
                kind: "account",
                authority: "present_user",
            });
            const { socketAuth, protectedRoom } = await admission.configure(account.id);
            const app = Fastify({ logger: false }) as unknown as AppFastify;
            startSocket(app);
            const socketServer = app.machineDaemonPresence;
            if (!(socketServer instanceof Server)) throw new Error("Expected the live Socket.IO server");
            const pausedCurrentness = await pausePostConnectAccountCurrentnessRead(socketServer, account.id);
            await app.listen({ port: 0, host: "127.0.0.1" });
            const address = app.server.address();
            const port = typeof address === "object" && address ? address.port : null;
            if (!port) {
                pausedCurrentness.release();
                pausedCurrentness.restore();
                await app.close();
                throw new Error("Failed to bind socket server");
            }

            const socket = ioClient(`http://127.0.0.1:${port}`, {
                path: "/v1/updates",
                transports: ["websocket"],
                reconnection: false,
                autoConnect: false,
                auth: { token, ...socketAuth },
            });
            const protectedPayloads: unknown[] = [];
            socket.on("currentness-protected-probe", (payload) => protectedPayloads.push(payload));

            try {
                socket.connect();
                await pausedCurrentness.reached;

                expect(await socketServer.in(protectedRoom).fetchSockets(), admission.name)
                    .toHaveLength(0);
                socketServer.to(protectedRoom).emit("currentness-protected-probe", {
                    phase: "before-currentness",
                });
                await new Promise<void>((resolve) => setTimeout(resolve, 50));
                expect(protectedPayloads, admission.name).toEqual([]);

                pausedCurrentness.release();
                await expect.poll(
                    async () => (await socketServer.in(protectedRoom).fetchSockets()).length,
                ).toBe(1);
                socketServer.to(protectedRoom).emit("currentness-protected-probe", {
                    phase: "after-currentness",
                });
                await expect.poll(() => protectedPayloads).toEqual([{ phase: "after-currentness" }]);
            } finally {
                pausedCurrentness.release();
                socket.close();
                pausedCurrentness.restore();
                await app.close();
            }
        }
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
        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });

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

        const token = await auth.createToken(otherAccount.id, undefined, {
            kind: "account",
            authority: "present_user",
        });

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

    it("disconnects a machine-scoped socket when the machine is revoked", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-revoked-${Date.now()}` },
            select: { id: true },
        });

        await db.machine.create({
            data: {
                id: "m-revoked",
                accountId: account.id,
                metadata: "metadata",
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                active: false,
                revokedAt: new Date("2026-05-12T00:00:00.000Z"),
            },
            select: { id: true },
        });

        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });

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
            auth: { token, clientType: "machine-scoped", machineId: "m-revoked" },
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

    it("disconnects a machine-scoped socket when the machine is replaced", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-replaced-${Date.now()}` },
            select: { id: true },
        });

        await db.machine.create({
            data: {
                id: "m-current",
                accountId: account.id,
                metadata: "metadata",
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                active: false,
            },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "m-replaced",
                accountId: account.id,
                metadata: "metadata",
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                active: false,
                replacedByMachineId: "m-current",
            },
            select: { id: true },
        });

        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });

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
            auth: { token, clientType: "machine-scoped", machineId: "m-replaced" },
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

        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });

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

        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });

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

        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });

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

        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });

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

        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });

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

        const token = await auth.createToken(otherAccount.id, undefined, {
            kind: "account",
            authority: "present_user",
        });

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
