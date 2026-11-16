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
import { stopLocalMachinePresenceTimeout } from '@/app/presence/timeout';
import tweetnacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { encodeBase64 as encodeProtocolBase64 } from '@happier-dev/protocol/crypto/base64';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { resolveMachineAdmissionInTx, setMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createAuthenticatedTestApp } from './testkit/sqliteFastify';
import { registerAccountSessionsSignOutEverywhereRoute } from './routes/auth/registerAccountSessionsSignOutEverywhereRoute';
import { ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountSessions';
import { eventRouter } from '@/app/events/eventRouter';
import type { EphemeralUpdate } from '@happier-dev/protocol/updates';
import { buildAccountStoredContentCompatibilitySocketAuthV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

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

function pauseNextWriteTransaction(): PausedAdmissionBoundary {
    const reached = deferred();
    const release = deferred();
    const transaction = db.$transaction;
    let paused = false;
    // Hold the actual DB acquisition boundary, before any SQLite connection is
    // occupied. The replacement handshake can still read and withdraw safely.
    db.$transaction = new Proxy(transaction, { apply(target, receiver, args) {
        if (paused) return Reflect.apply(target, receiver, args);
        paused = true;
        reached.resolve();
        return release.promise.then(() => Reflect.apply(target, receiver, args));
    } });
    return { reached: reached.promise, release: release.resolve, restore: () => { db.$transaction = transaction; } };
}

async function pausePostConnectAccountCurrentnessRead(
    server: Server,
    accountId: string,
): Promise<PausedAdmissionBoundary> {
    const reached = deferred();
    const release = deferred();
    const accountReaders = new Set([db.account, await withSqliteReadSnapshot(async reader => reader.account)]);
    const restorers: Array<() => void> = [];
    let paused = false;
    // Intercept only the persistence boundary once the real socket has joined
    // the revocation room. Auth's signed-epoch lookup uses the ordinary reader;
    // full token verification uses its read snapshot. Neither owner is mocked.
    for (const accountReader of accountReaders) {
        const originalFindUnique = accountReader.findUnique;
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
        restorers.push(() => {
            findUniqueSpy.mockRestore();
            Reflect.set(accountReader, "findUnique", originalFindUnique);
        });
    }
    return { reached: reached.promise, release: release.resolve, restore: () => { for (const restore of restorers) restore(); } };
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

    it.each([true, false])('withdraws retained connection capabilities before a same-installation predecessor reconnect (requester protection: %s)', async retainedRequesterProtection => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const installation = tweetnacl.sign.keyPair();
        const installationId = `installation-${account.id}`;
        const siblingCapabilities = { sessionSpawn: { protocolVersions: [1] } };
        const capabilities = { ...siblingCapabilities, requesterExecutionIsolation: { protocolVersions: [1] },
            connectedAccountAuthentication: { protocolVersions: [1] } };
        const retainedSiblings = { ...siblingCapabilities, futureOperation: { protocolVersions: [2] } };
        const machine = await db.machine.create({ data: { id: `downgrade-${account.id}`, accountId: account.id,
            installationId, installationPublicKey: new Uint8Array(installation.publicKey), active: true,
            metadata: encodePlainMachineStoredContent({ host: 'downgrade-host', platform: 'linux', happyCliVersion: '0.3.0',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { ...retainedSiblings,
                ...(retainedRequesterProtection ? { requesterExecutionIsolation: capabilities.requesterExecutionIsolation } : {}),
                connectedAccountAuthentication: capabilities.connectedAccountAuthentication },
            operationProtocolCapabilitiesRevision: 7 } });
        // Observe actual database content writes, including equal-value updates,
        // without replacing transaction or publication logic with mocks.
        await db.$executeRawUnsafe('CREATE TABLE CapabilityLifecycleWrite (machineId TEXT NOT NULL)');
        await db.$executeRawUnsafe(`CREATE TRIGGER capability_lifecycle_write AFTER UPDATE OF
            operationProtocolCapabilities, operationProtocolCapabilitiesRevision ON Machine
            BEGIN INSERT INTO CapabilityLifecycleWrite (machineId) VALUES (NEW.id); END`);
        const contentWrites = async () => Number((await db.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(*) AS count FROM CapabilityLifecycleWrite WHERE machineId = ${machine.id}`)[0].count);
        await makeShareEligibleForTest(account.id, member.id);
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: account.id, machineId: machine.id,
            principal: { kind: 'account', accountId: member.id }, level: 'view' }));
        const admission = (actorAccountId: string) => inReadSnapshot(tx => resolveMachineAdmissionInTx(tx, {
            actorAccountId, machineId: machine.id, actionId: 'session.spawn_new',
        }));
        expect(await admission(member.id)).toMatchObject(retainedRequesterProtection
            ? { kind: 'admitted' } : { kind: 'denied', code: 'daemon_upgrade_required' });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Missing socket listener');
        // ../0.2 at 285ee7c5acb3bea1489896a254e4445f2483a213 sends this signed
        // installation handshake, but never publishes operation capabilities.
        const connect = () => ioClient(`http://127.0.0.1:${address.port}`, { path: '/v1/updates', transports: ['websocket'],
            reconnection: false, autoConnect: false, auth: { token, clientType: 'machine-scoped', machineId: machine.id,
                runtimeId: 'same-installation-downgrade', startupSource: 'manual', serviceManaged: false,
                installationId, installationPublicKey: encodeProtocolBase64(installation.publicKey, 'base64url'),
                installationProof: signMachineInstallationProof({ payload: { version: 1, installationId,
                    machineId: machine.id, accountId: account.id }, privateKey: installation.secretKey }) } });
        const oldDaemon = connect();
        const currentDaemon = connect();
        const downgradedAgain = connect();
        try {
            let connected = waitForConnectionSuccess(oldDaemon); oldDaemon.connect(); await connected;
            // The connect event itself must already observe withdrawal; no daemon publication is sent.
            expect(await admission(member.id)).toEqual({ kind: 'denied', code: 'daemon_upgrade_required' });
            expect(await admission(account.id)).toMatchObject({ kind: 'admitted' });
            await oldDaemon.timeout(10_000).emitWithAck('ping');
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { operationProtocolCapabilities: true, operationProtocolCapabilitiesRevision: true } })).toEqual({
                operationProtocolCapabilities: retainedSiblings, operationProtocolCapabilitiesRevision: 8,
            });
            expect(await contentWrites()).toBe(1);
            const publicationState = () => db.account.findMany({ where: { id: { in: [account.id, member.id] } },
                select: { id: true, seq: true }, orderBy: { id: 'asc' } });
            const beforeEqual = await publicationState();
            connected = waitForConnectionSuccess(currentDaemon); currentDaemon.connect(); await connected;
            await currentDaemon.timeout(10_000).emitWithAck('ping');
            expect(await publicationState()).toEqual(beforeEqual);
            expect(await contentWrites()).toBe(1);
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { operationProtocolCapabilities: true, operationProtocolCapabilitiesRevision: true } })).toEqual({
                operationProtocolCapabilities: retainedSiblings, operationProtocolCapabilitiesRevision: 8,
            });
            expect(await currentDaemon.timeout(10_000).emitWithAck(MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
                { capabilities })).toMatchObject({ result: 'success', revision: 9 });
            expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { operationProtocolCapabilities: true } })).operationProtocolCapabilities).toEqual(capabilities);
            expect(await admission(member.id)).toMatchObject({ kind: 'admitted' });
            expect(await contentWrites()).toBe(2);

            // Hold an already-dispatched changed projection at DB acquisition
            // while a predecessor takes over the same installation.
            const server = app.machineDaemonPresence as Server;
            const serverSocket = server.sockets.sockets.get(currentDaemon.id!);
            if (!serverSocket) throw new Error('Missing current Machine socket');
            let completePublication!: (value: unknown) => void;
            const publicationResult = new Promise<unknown>(resolve => { completePublication = resolve; });
            serverSocket.use((packet, next) => {
                if (packet[0] === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
                    const acknowledge = packet[packet.length - 1];
                    packet[packet.length - 1] = (value: unknown) => {
                        completePublication(value);
                        if (typeof acknowledge === 'function') acknowledge(value);
                    };
                }
                next();
            });
            const paused = pauseNextWriteTransaction();
            try {
                currentDaemon.emit(MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
                    { capabilities: { ...capabilities, sessionFollow: { contextV1: true } } }, () => {});
                await paused.reached;
                connected = waitForConnectionSuccess(downgradedAgain); downgradedAgain.connect(); await connected;
                await downgradedAgain.timeout(10_000).emitWithAck('ping');
                expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                    select: { operationProtocolCapabilities: true } })).operationProtocolCapabilities).toEqual(siblingCapabilities);
                expect(await admission(member.id)).toEqual({ kind: 'denied', code: 'daemon_upgrade_required' });
                paused.release();
                expect(await publicationResult).toEqual({ v: 1, result: 'error', code: 'machine_unavailable' });
                expect(await admission(member.id)).toEqual({ kind: 'denied', code: 'daemon_upgrade_required' });
                expect(await admission(account.id)).toMatchObject({ kind: 'admitted' });
                expect(await contentWrites()).toBe(3);
            } finally { paused.release(); paused.restore(); }
        } finally {
            oldDaemon.close(); currentDaemon.close(); downgradedAgain.close(); await app.close();
            await db.$executeRawUnsafe('DROP TRIGGER capability_lifecycle_write');
            await db.$executeRawUnsafe('DROP TABLE CapabilityLifecycleWrite');
        }
    }, 60_000);

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

    it("refuses an existing credential's socket under a sign-in provider the Home requires in its settings", async () => {
        await db.homeSettings.create({ data: { id: "home", revision: 1, values: { AUTH_REQUIRED_LOGIN_PROVIDERS: ["github"] } } });
        const account = await db.account.create({ data: { publicKey: `pk-home-required-${Date.now()}` }, select: { id: true } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") {
            await app.close();
            await db.homeSettings.deleteMany({});
            throw new Error("Failed to bind socket server");
        }
        const socket = ioClient(`http://127.0.0.1:${address.port}`, {
            path: "/v1/updates", transports: ["websocket"], reconnection: false, auth: { token },
        });
        let payload: ProviderRequiredErrorPayload;
        try {
            payload = await waitForConnectionFailure(socket);
        } finally {
            socket.close();
            await app.close();
            await db.homeSettings.deleteMany({});
        }
        expect(payload.data).toEqual({ error: "provider-required", provider: "github", statusCode: 403 });
    }, 30_000);

    it("rejects API tokens outside an admitted Session viewer socket", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-api-token-${Date.now()}` },
            select: { id: true },
        });
        const apiToken = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: await preparePlainAccountApiTokenLabel(account.id, "Socket admission must reject this"),
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
                    // PATs may use the Session-viewer composition, but this
                    // nonexistent Session cannot pass its real access owner.
                    const error = admission.name === "session" ? "credential_scope_denied" : "invalid-token";
                    expect(payload.message, admission.name).toBe(error);
                    expect(payload.data, admission.name).toEqual({
                        error,
                        provider: undefined,
                        statusCode: admission.name === "session" ? 403 : 401,
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
                    await db.machine.create({ data: { id: machineId, accountId, metadata: "metadata",
                        metadataVersion: 1, daemonState: null, daemonStateVersion: 0, active: false } });
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
                    return { reached: admissionReached.promise, release: releaseAdmission.resolve,
                        restore: () => {
                            findFirstSpy.mockRestore();
                            Reflect.set(db.machine, "findFirst", originalFindFirst);
                        } };
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
                    await db.machine.create({ data: { id: machineId, accountId, metadata: "metadata",
                        metadataVersion: 1, daemonState: null, daemonStateVersion: 0, active: false } });
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
                    await db.machine.create({ data: { id: machineId, accountId, metadata: "metadata",
                        metadataVersion: 1, daemonState: null, daemonStateVersion: 0, active: false } });
                    return { socketAuth: { clientType: "machine-scoped", machineId },
                        protectedRoom: `machine:${machineId}:${accountId}` };
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

    it("makes a cleanly stopped Machine offline immediately and admits its replacement without the presence timeout", async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const installation = tweetnacl.sign.keyPair();
        const installationId = `clean-stop-${account.id}`;
        const machine = await db.machine.create({ data: {
            id: `clean-stop-${account.id}`, accountId: account.id, installationId,
            installationPublicKey: new Uint8Array(installation.publicKey), active: false,
            metadata: encodePlainMachineStoredContent({ host: 'clean-stop', platform: 'linux', happyCliVersion: '0.3.0',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = createAuthenticatedTestApp({ authentication: 'real' }) as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') { await app.close(); throw new Error('Missing socket listener'); }
        const connect = (runtimeId: string) => ioClient(`http://127.0.0.1:${address.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, autoConnect: false,
            auth: { token, clientType: 'machine-scoped', machineId: machine.id, runtimeId,
                startupSource: 'manual', serviceManaged: false, installationId,
                installationPublicKey: encodeProtocolBase64(installation.publicKey, 'base64url'),
                installationProof: signMachineInstallationProof({ payload: { version: 1, installationId,
                    machineId: machine.id, accountId: account.id }, privateKey: installation.secretKey }),
            },
        });
        const publisher = connect('clean-stop-first');
        const replacement = connect('clean-stop-replacement');
        const viewer = ioClient(`http://127.0.0.1:${address.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, autoConnect: false,
            auth: { token, clientType: 'user-scoped' },
        });
        const currentViewer = ioClient(`http://127.0.0.1:${address.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, autoConnect: false,
            auth: { token, clientType: 'user-scoped',
                ...buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
        });
        const activity: Array<Extract<EphemeralUpdate, { type: 'machine-activity' }>> = [];
        const currentActivity: typeof activity = [];
        currentViewer.on('ephemeral', (event: EphemeralUpdate) => {
            if (event.type === 'machine-activity' && event.id === machine.id) currentActivity.push(event);
        });
        viewer.on('ephemeral', (event: EphemeralUpdate) => {
            if (event.type === 'machine-activity' && event.id === machine.id) activity.push(event);
        });
        const readPresence = () => db.machine.findUniqueOrThrow({ where: { id: machine.id } });
        try {
            expect(await auth.verifyTokenForRoute(token)).toMatchObject({ userId: account.id });
            const watching = waitForConnectionSuccess(viewer); viewer.connect(); await watching;
            await viewer.timeout(7_500).emitWithAck('ping');
            const watchingCurrent = waitForConnectionSuccess(currentViewer); currentViewer.connect(); await watchingCurrent;
            await currentViewer.timeout(7_500).emitWithAck('ping');
            const connected = waitForConnectionSuccess(publisher); publisher.connect(); await connected;
            await publisher.timeout(7_500).emitWithAck('ping');
            let online = await readPresence();
            expect(online.active).toBe(true);
            await expect.poll(() => currentActivity.length).toBe(1);
            publisher.emit('machine-alive', { machineId: machine.id, time: Date.now() });
            await expect.poll(() => activity.length).toBe(2);
            online = await readPresence();
            expect(activity[1]).toEqual({ type: 'machine-activity', id: machine.id, active: true,
                activeAt: online.lastActiveAt.getTime() });
            expect(currentActivity).toHaveLength(1);
            activity.pop(); // Keep the transition assertions independent of the legacy observation.
            publisher.disconnect();
            await expect.poll(async () => (await readPresence()).active).toBe(false);
            expect((await readPresence()).lastActiveAt).toEqual(online.lastActiveAt);
            await expect.poll(() => activity.filter(event => !event.active)).toEqual([
                { type: 'machine-activity', id: machine.id, active: false, activeAt: online.lastActiveAt.getTime() },
            ]);
            const reconnected = waitForConnectionSuccess(replacement); replacement.connect(); await reconnected;
            await replacement.timeout(7_500).emitWithAck('ping');
            expect((await readPresence()).active).toBe(true);
            await expect.poll(() => activity.map(event => event.active)).toEqual([true, false, true]);
            // An unexpected transport loss retains the existing missed-beat grace.
            const serverSocket = [...eventRouter.getConnections(account.id) ?? []]
                .find(connection => connection.socket.id === replacement.id)?.socket;
            if (!serverSocket) throw new Error('Missing admitted replacement socket');
            const transportClosed = new Promise<void>(resolve => serverSocket.once('disconnect', () => { setImmediate(resolve); }));
            replacement.io.engine.close();
            await transportClosed;
            expect((await inTx(tx => tx.machine.findUniqueOrThrow({ where: { id: machine.id } }))).active).toBe(true);
        } finally {
            publisher.close(); replacement.close(); viewer.close(); currentViewer.close(); await app.close();
        }
    }, 30_000);

    it("verifies an installed Machine publisher once at connect, accepts semantic beats without reverification, and evicts it on sign-out", async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const installation = tweetnacl.sign.keyPair();
        const installationId = `publisher-installation-${account.id}`;
        const lastSeen = new Date(Date.now() - 70_000);
        const machine = await db.machine.create({ data: {
            id: `publisher-${account.id}`, accountId: account.id,
            installationId, installationPublicKey: new Uint8Array(installation.publicKey),
            metadata: encodePlainMachineStoredContent({ host: 'publisher-host', platform: 'linux', happyCliVersion: '0.3.0',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            active: false, lastActiveAt: lastSeen,
        } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = createAuthenticatedTestApp({ authentication: 'real' }) as AppFastify;
        startSocket(app);
        registerAccountSessionsSignOutEverywhereRoute(app);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') { await app.close(); throw new Error('Missing socket listener'); }
        const publisherAuth = {
            token, clientType: 'machine-scoped', machineId: machine.id,
            runtimeId: 'installed-machine-publisher', startupSource: 'manual', serviceManaged: false,
            installationId, installationPublicKey: encodeProtocolBase64(installation.publicKey, 'base64url'),
            installationProof: signMachineInstallationProof({ payload: { version: 1, installationId,
                machineId: machine.id, accountId: account.id }, privateKey: installation.secretKey }),
        };
        const connect = () => ioClient(`http://127.0.0.1:${address.port}`, { path: '/v1/updates', transports: ['websocket'],
            reconnection: false, autoConnect: false, auth: publisherAuth });
        const publisher = connect();
        // Observe the real verifier without replacing credential admission.
        const verification = vi.spyOn(auth, 'verifyTokenForRoute');
        const epochReads = vi.spyOn(auth, 'isSignedCredentialCurrent');
        const readPresence = () => db.machine.findUniqueOrThrow({ where: { id: machine.id },
            select: { active: true, lastActiveAt: true } });
        try {
            const connected = waitForConnectionSuccess(publisher); publisher.connect(); await connected;
            // Ping only waits for production packet admission to become ready.
            await publisher.timeout(7_500).emitWithAck('ping');
            const admitted = await readPresence();
            expect(admitted.active).toBe(true);
            expect(admitted.lastActiveAt.getTime()).toBeGreaterThan(lastSeen.getTime());
            expect.soft(verification.mock.calls.length).toBe(1);
            expect(epochReads.mock.calls.length).toBe(1);
            verification.mockClear();
            epochReads.mockClear();

            let lastActiveAt = admitted.lastActiveAt.getTime();
            for (let beat = 0; beat < 3; beat += 1) {
                await expect.poll(() => Date.now()).toBeGreaterThan(lastActiveAt);
                publisher.emit('machine-alive', { machineId: machine.id, time: Date.now() });
                // Observe the semantic write itself; a ping would acknowledge
                // dispatch without waiting for the async liveness transaction.
                await expect.poll(async () => (await readPresence()).lastActiveAt.getTime()).toBeGreaterThan(lastActiveAt);
                const presence = await readPresence();
                expect(presence.active).toBe(true);
                lastActiveAt = presence.lastActiveAt.getTime();
            }
            expect.soft(verification.mock.calls.length).toBe(0);
            expect(epochReads.mock.calls.length).toBe(0);

            const disconnected = new Promise<void>(resolve => publisher.once('disconnect', () => resolve()));
            const signedOut = await app.inject({ method: 'POST', url: ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1,
                headers: { authorization: `Bearer ${token}` }, payload: {} });
            expect(signedOut.statusCode).toBe(200);
            expect(signedOut.json()).toEqual({ status: 'signed_out' });
            await disconnected;
            expect(publisher.connected).toBe(false);
            const retry = connect();
            try {
                const refused = waitForConnectionFailure(retry); retry.connect();
                expect((await refused).message).toBe('invalid-token');
            } finally { retry.close(); }
        } finally {
            verification.mockRestore();
            epochReads.mockRestore();
            publisher.close();
            await app.close();
        }
    }, 30_000);

    it("admits a machine-bound Session publisher once and retires it through Account eviction", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-publisher-${Date.now()}` }, select: { id: true } });
        await db.machine.create({ data: { id: "m-publisher", accountId: account.id, metadata: "metadata", metadataVersion: 1,
            daemonState: null, daemonStateVersion: 0, active: false } });
        await db.session.create({ data: { id: "s-publisher", tag: `t-publisher-${Date.now()}`, accountId: account.id,
            encryptionMode: "e2ee", metadata: "{}" } });
        await db.accessKey.create({ data: { accountId: account.id, machineId: "m-publisher", sessionId: "s-publisher", data: "envelope" } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        const port = typeof address === "object" && address ? address.port : null;
        if (!port) { await app.close(); throw new Error("Failed to bind socket server"); }
        const publisherAuth = { token, clientType: "session-scoped", sessionId: "s-publisher", machineId: "m-publisher" };
        const publisher = ioClient(`http://127.0.0.1:${port}`, { path: "/v1/updates", transports: ["websocket"],
            reconnection: false, autoConnect: false, auth: publisherAuth });
        const verification = vi.spyOn(auth, "verifyTokenForRoute");
        try {
            await new Promise<void>((resolve, reject) => {
                publisher.once("connect", resolve); publisher.once("connect_error", reject); publisher.connect();
            });
            await publisher.timeout(7_500).emitWithAck("ping");
            // Connect admission owns the credential decision; later packets of
            // the admitted publisher do not re-verify it.
            verification.mockClear();
            for (let packet = 0; packet < 3; packet += 1) await publisher.timeout(7_500).emitWithAck("ping");
            expect(verification).toHaveBeenCalledTimes(0);

            // Revocation takes effect through the committed owner and its eviction push.
            const disconnected = new Promise<void>(resolve => publisher.once("disconnect", () => resolve()));
            await auth.signOutEverywhere(account.id);
            app.disconnectAccountSockets(account.id);
            await disconnected;
            const retry = ioClient(`http://127.0.0.1:${port}`, { path: "/v1/updates", transports: ["websocket"],
                reconnection: false, auth: publisherAuth });
            try {
                expect((await waitForConnectionFailure(retry)).message).toBe("invalid-token");
            } finally {
                retry.close();
            }
        } finally {
            verification.mockRestore();
            publisher.close();
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
