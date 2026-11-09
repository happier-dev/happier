import { createServer } from "node:http";

import { createAdapter } from "@socket.io/redis-streams-adapter";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveRedisAdapterValidationRedisUrl } from "../../../scripts/resolveRedisAdapterValidationRedisUrl";
import { getSocketRooms } from "@/app/api/socketRooms";

import { RedisStreamsRoomEmitter } from "./createRedisStreamsRoomEmitter";
import { eventRouter } from "./eventRouter";
import { buildNewMessageUpdate, buildUpdateSessionUpdate } from "./eventPayloadBuilders";
import { CREDENTIAL_QUALIFIED_SESSION_DELIVERY_EVENT } from "./socketRoomEmitter";
import { registerSessionConsumptionSocketEvent } from "@/app/api/socket/sessionConsumption";
import { db } from "@/storage/db";
import { createLightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { UpdateContainerSchema } from "@happier-dev/protocol/updates";
import { pingHandler } from "@/app/api/socket/pingHandler";
import { putSessionAccessGrantInTx } from "@/app/session/access/sessionAccessGrantService";
import { inTx } from "@/storage/inTx";
import { createLocalServicePreviewRuntime } from '@/app/local/services/preview/runtime';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol';
import { registerMachineAccessLossHandler } from './machineAccessLoss';

const SOCKET_PATH = "/v1/updates";

type RedisMemoryInstance = Awaited<ReturnType<typeof resolveRedisAdapterValidationRedisUrl>>["redisMemory"];

type StartedCluster = Readonly<{
    ioA: Server;
    ioB: Server;
    emitter: RedisStreamsRoomEmitter;
    redisA: Redis;
    redisB: Redis;
    redisEmitter: Redis;
    redisMemory: RedisMemoryInstance;
    portA: number;
    portB: number;
    receivingDeliveries: Promise<void>[];
    close: () => Promise<void>;
}>;

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address && typeof address === "object") {
        return address.port;
    }
    throw new Error("Failed to determine server port");
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startCluster(): Promise<StartedCluster> {
    const { redisUrl, redisMemory } = await resolveRedisAdapterValidationRedisUrl({
        env: process.env,
    });

    const redisA = new Redis(redisUrl);
    const redisB = new Redis(redisUrl);
    const redisEmitter = new Redis(redisUrl);
    const httpA = createServer();
    const httpB = createServer();
    const ioA = new Server(httpA, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        serveClient: false,
        adapter: createAdapter(redisA),
    });
    const ioB = new Server(httpB, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        serveClient: false,
        adapter: createAdapter(redisB),
    });

    const receivingDeliveries: Promise<void>[] = [];
    const attachConnectionHandler = (io: Server) => {
        io.on(CREDENTIAL_QUALIFIED_SESSION_DELIVERY_EVENT, delivery => {
            receivingDeliveries.push(eventRouter.receiveCredentialQualifiedSessionDelivery(io.local, delivery));
        });
        io.on("connection", (socket) => {
            const userId = socket.handshake.auth.userId as string | undefined;
            const clientType = socket.handshake.auth.clientType as "user-scoped" | "machine-scoped" | "session-scoped" | undefined;
            if (!userId || !clientType) {
                socket.disconnect();
                return;
            }

            // Authentication is this transport fixture's boundary; access, local
            // demand admission and both receiving-node projectors remain real.
            Object.assign(socket.data, { userId, clientType, authAuthority: "present_user",
                clientPurpose: socket.handshake.auth.clientPurpose, sessionId: socket.handshake.auth.sessionId });
            registerSessionConsumptionSocketEvent(socket, Promise.resolve(true));
            pingHandler(socket);

            socket.join(getSocketRooms({
                userId,
                clientType,
                ...(typeof socket.handshake.auth.sessionId === "string"
                    ? { sessionId: socket.handshake.auth.sessionId }
                    : {}),
                ...(typeof socket.handshake.auth.machineId === "string"
                    ? { machineId: socket.handshake.auth.machineId }
                    : {}),
            }));
        });
    };

    attachConnectionHandler(ioA);
    attachConnectionHandler(ioB);

    const portA = await listen(httpA);
    const portB = await listen(httpB);

    return {
        ioA,
        ioB,
        emitter: new RedisStreamsRoomEmitter(redisEmitter, { maxLen: 2_000, streamName: "socket.io" }),
        redisA,
        redisB,
        redisEmitter,
        redisMemory,
        portA,
        portB,
        receivingDeliveries,
        close: async () => {
            await ioA.close();
            await ioB.close();
            await closeServer(httpA);
            await closeServer(httpB);
            await redisA.quit();
            await redisB.quit();
            await redisEmitter.quit();
            if (redisMemory) {
                await redisMemory.stop();
            }
        },
    };
}

async function connectClient(
    port: number,
    clientType: "user-scoped" | "machine-scoped" | "session-scoped" = "user-scoped",
    userId = "user-1",
    binding: Readonly<{ sessionId?: string; machineId?: string; clientPurpose?: string }> = {},
): Promise<ClientSocket> {
    const socket = createClient(`http://127.0.0.1:${port}`, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        timeout: 5_000,
        auth: {
            userId,
            clientType,
            ...(binding.clientPurpose ? { clientPurpose: binding.clientPurpose } : {}),
            ...(clientType === "session-scoped"
                ? { sessionId: binding.sessionId ?? "session-1" }
                : {}),
            ...(clientType === "machine-scoped"
                ? { machineId: binding.machineId ?? "machine-1" }
                : binding.machineId
                    ? { machineId: binding.machineId }
                    : {}),
        },
    });

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout connecting socket client on port ${port}`)), 6_000);
        socket.once("connect", () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once("connect_error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });

    return socket;
}

describe("eventRouter redis streams emitter integration", () => {
    it('retires remote preview credentials and an in-flight mint through the existing Redis push', async () => {
        const runtime = createLocalServicePreviewRuntime({ tokenSecret: 'test', publicBaseUrl: 'https://app.happier.test',
            hostOriginBaseDomain: 'preview.happier.test' });
        const resource: LocalServicePreviewResourceV1 = { previewId: 'remote-preview', machineId: 'machine',
            owner: { kind: 'user', id: 'starter' }, serviceTarget: { kind: 'managed_service', machineId: 'machine',
                managedServiceId: 'instance', cwd: '/workspace', declaration: { workspaceRefId: 'workspace', selection: { kind: 'manifest', name: 'web' } } },
            target: { scheme: 'http', host: '127.0.0.1', port: 5173 }, initialPath: { pathname: '/', search: '' }, originMode: 'host',
            display: { title: 'Fixture', addressLabel: 'localhost:5173' } };
        const registered = runtime.registerPreview({ resource, accountId: 'starter', viewerAccountId: 'viewer' });
        if (!registered.ok) throw new Error(registered.reasonCode);
        if (!registered.accessUrl) throw new Error('preview_private_route_unavailable');
        const binding = { previewId: resource.previewId, machineId: resource.machineId, sessionId: undefined };
        const viewer = runtime.exchangeAccessToken({ ...binding, rawToken: new URL(registered.accessUrl).searchParams.get('previewToken') });
        if (!viewer.ok) throw new Error('Preview exchange failed');
        const attempt = runtime.retainMachineAccess({ machineId: 'machine', accountIds: ['viewer', 'starter'] });
        const cluster = await startCluster();
        startedClusters.push(cluster);
        // Listening does not finish the adapter's asynchronous Redis subscriptions.
        // Match the canonical redisAdapterRecoveryCluster transport readiness boundary.
        await vi.waitFor(async () => {
            expect(await cluster.ioA.of('/').adapter.serverCount()).toBe(2);
            expect(await cluster.ioB.of('/').adapter.serverCount()).toBe(2);
        }, { timeout: 25_000, interval: 100 });
        // Match the existing cluster journeys: finish transport startup before the one-shot revoke.
        // createAdapter starts its duplicate Redis readers asynchronously after construction.
        const connected = await connectClient(cluster.portB);
        startedClients.push(connected);
        let received!: () => void;
        const accessLost = new Promise<void>(resolve => { received = resolve; });
        const release = registerMachineAccessLossHandler(cluster.ioB, input => { runtime.retireMachineAccess(input); received(); });
        try {
            // The headless publisher is a separate Redis participant from the serving API node.
            eventRouter.setIo(cluster.emitter);
            eventRouter.disconnectMachineAndSessionSockets({ accountId: 'viewer', machineId: 'machine', sessionBindings: [] });
            await accessLost;
            expect(attempt.signal.aborted).toBe(true);
            expect(runtime.validateAccess({ ...binding, rawToken: viewer.rawToken }).ok).toBe(false);
            expect(runtime.registerPreview({ resource, accountId: 'starter', viewerAccountId: 'viewer', machineAccessSignal: attempt.signal }))
                .toMatchObject({ ok: false, reasonCode: 'session_not_authorized' });
            const fresh = runtime.retainMachineAccess({ machineId: 'machine', accountIds: ['other-viewer', 'starter'] });
            expect(runtime.registerPreview({ resource, accountId: 'starter', viewerAccountId: 'other-viewer', machineAccessSignal: fresh.signal }).ok).toBe(true);
            fresh.release();
        } finally { attempt.release(); release(); }
    });
    const startedClusters: StartedCluster[] = [];
    const startedClients: ClientSocket[] = [];

    afterEach(async () => {
        eventRouter.clearIo();
        while (startedClients.length > 0) {
            startedClients.pop()?.disconnect();
        }
        while (startedClusters.length > 0) {
            await startedClusters.pop()?.close();
        }
    });

    it("classifies protected worker forwarding on each receiving node using only that node's socket demand", async () => {
        const harness = await createLightSqliteHarness({ tempDirPrefix: "happier-consumption-redis-" });
        try {
            const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
            const viewer = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
            const session = await db.session.create({ data: {
                accountId: owner.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain",
            } });
            await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: viewer.id, status: "friend" } });
            expect(await inTx(tx => putSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id, sessionId: session.id, subject: { kind: "account", accountId: viewer.id },
                grant: { accessLevel: "view", canApprovePermissions: false },
                authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] },
            }))).toMatchObject({ ok: true });
            const cluster = await startCluster();
            startedClusters.push(cluster);
            const activeA = await connectClient(cluster.portA, "user-scoped", owner.id, { clientPurpose: "sync" });
            const hiddenB = await connectClient(cluster.portB, "user-scoped", owner.id, { clientPurpose: "sync" });
            const durableB = await connectClient(cluster.portB, "user-scoped", owner.id, { clientPurpose: "concurrent-server-cache" });
            startedClients.push(activeA, hiddenB, durableB);
            const received = new Map(startedClients.map(client => [client, [] as unknown[]]));
            for (const client of startedClients) client.on("update", value => received.get(client)!.push(UpdateContainerSchema.parse(value)));
            expect(await activeA.timeout(5_000).emitWithAck("session-consumption-replace", {
                v: 1, liveSessionIds: [session.id], durableSessionIds: [],
            })).toEqual({ ok: true, v: 1, liveSessionIds: [session.id], durableSessionIds: [] });
            expect(await durableB.timeout(5_000).emitWithAck("session-consumption-replace", {
                v: 1, liveSessionIds: [], durableSessionIds: [session.id],
            })).toEqual({ ok: true, v: 1, liveSessionIds: [], durableSessionIds: [session.id] });
            eventRouter.setIo(cluster.emitter);
            const payload = buildNewMessageUpdate({ id: "redis-message", seq: 1, localId: null,
                content: { t: "encrypted", c: "private-redis-content" }, createdAt: new Date(1), updatedAt: new Date(2) },
                session.id, 1, "redis-update");
            const arrived = Promise.all([activeA, hiddenB, durableB].map(client => new Promise<void>(resolve => client.once("update", () => resolve()))));
            await eventRouter.emitUpdate({ userId: owner.id, payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: session.id } });
            await arrived;
            expect(received.get(activeA)).toEqual([payload]);
            expect(received.get(durableB)).toEqual([payload]);
            expect(received.get(hiddenB)).toEqual([expect.objectContaining({ body: expect.objectContaining({
                delivery: "hint", message: expect.not.objectContaining({ content: expect.anything() }),
            }) })]);

            const metadataPayload = buildUpdateSessionUpdate(session.id, 2, "redis-metadata",
                { version: 7, value: "private-redis-metadata" }, { version: 4, value: "private-redis-agent-state" },
                { active: true, pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0 });
            const metadataArrived = Promise.all([activeA, hiddenB, durableB].map(client =>
                new Promise<void>(resolve => client.once("update", () => resolve()))));
            await eventRouter.emitUpdate({ userId: owner.id, payload: metadataPayload,
                recipientFilter: { type: "all-interested-in-session", sessionId: session.id } });
            await metadataArrived;
            expect(received.get(activeA)?.at(-1)).toEqual(metadataPayload);
            expect(received.get(durableB)?.at(-1)).toEqual(metadataPayload);
            const hiddenMetadata = received.get(hiddenB)?.at(-1);
            expect(hiddenMetadata).toMatchObject({ body: { metadataDocument: "omitted", metadataVersion: 7,
                metadataLayoutVersion: 0, agentState: { version: 4, value: "private-redis-agent-state" }, pendingPermissionRequestCount: 1 } });
            expect(hiddenMetadata).not.toHaveProperty("body.metadata");
            expect(hiddenMetadata).not.toHaveProperty("body.ownerMetadata");

            const sharedA = await connectClient(cluster.portA, "user-scoped", viewer.id, { clientPurpose: "sync" });
            const sharedB = await connectClient(cluster.portB, "user-scoped", viewer.id, { clientPurpose: "concurrent-server-cache" });
            startedClients.push(sharedA, sharedB);
            for (const client of [sharedA, sharedB]) {
                received.set(client, []);
                client.on("update", value => received.get(client)!.push(UpdateContainerSchema.parse(value)));
                expect(await client.timeout(5_000).emitWithAck("session-consumption-replace", {
                    v: 1, liveSessionIds: [], durableSessionIds: [],
                })).toEqual({ ok: true, v: 1, liveSessionIds: [], durableSessionIds: [] });
            }
            const sharedMetadata = buildUpdateSessionUpdate(session.id, 3, "redis-shared-metadata",
                { version: 8, value: "shared-completion-and-confirmation-metadata" },
                { version: 4, value: "private-redis-agent-state" });
            sharedMetadata.body.metadataLayoutVersion = 1;
            const sharedArrived = Promise.all([sharedA, sharedB].map(client =>
                new Promise<void>(resolve => client.once("update", () => resolve()))));
            await eventRouter.emitUpdate({ userId: viewer.id, payload: sharedMetadata,
                recipientFilter: { type: "all-interested-in-session", sessionId: session.id } });
            await sharedArrived;
            for (const client of [sharedA, sharedB]) expect(received.get(client)).toEqual([sharedMetadata]);

            await db.account.update({ where: { id: owner.id }, data: { status: "suspended" } });
            await eventRouter.emitUpdate({ userId: owner.id, payload: { ...payload, id: "revoked-update" },
                recipientFilter: { type: "all-interested-in-session", sessionId: session.id } });
            // Observe transport arrival, then await the real receiving-node
            // admission on both nodes before the client-side delivery barrier.
            await expect.poll(() => cluster.receivingDeliveries.length).toBe(8);
            await Promise.all(cluster.receivingDeliveries);
            await Promise.all(startedClients.map(client => client.timeout(5_000).emitWithAck("ping")));
            for (const client of [activeA, hiddenB, durableB]) expect(received.get(client)).toHaveLength(2);
            for (const client of [sharedA, sharedB]) expect(received.get(client)).toHaveLength(1);
        } finally { await harness.close(); }
    }, 120_000);

    it("disconnects user and machine rooms on both replicas from the worker emitter without touching another Account", async () => {
        const cluster = await startCluster();
        startedClusters.push(cluster);
        const sockets = await Promise.all([
            connectClient(cluster.portA),
            connectClient(cluster.portB, "machine-scoped"),
        ]);
        const other = await connectClient(cluster.portB, "user-scoped", "user-2");
        startedClients.push(...sockets, other);
        eventRouter.setIo(cluster.emitter);
        const disconnected = sockets.map((socket) => new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Account socket stayed connected")), 5_000);
            socket.once("disconnect", () => { clearTimeout(timer); resolve(); });
        }));
        eventRouter.disconnectAccountSockets("user-1");
        await Promise.all(disconnected);
        expect(other.connected).toBe(true);
    });

    it("disconnects one exact Machine and requester-bound Session sockets across replicas without evicting history profiles", async () => {
        const cluster = await startCluster();
        startedClusters.push(cluster);
        const machine = await connectClient(cluster.portB, "machine-scoped", "user-1", {
            machineId: "machine-1",
        });
        const boundSession = await connectClient(cluster.portB, "session-scoped", "user-1", {
            sessionId: "session-1",
            machineId: "machine-1",
        });
        const ownerSession = await connectClient(cluster.portB, "session-scoped", "user-1", {
            sessionId: "session-1",
        });
        const requesterSession = await connectClient(cluster.portA, "session-scoped", "user-2", {
            sessionId: "session-2",
            machineId: "machine-1",
        });
        const requesterHistory = await connectClient(cluster.portA, "session-scoped", "user-2", {
            sessionId: "session-2",
        });
        const requesterOtherMachine = await connectClient(cluster.portB, "session-scoped", "user-2", {
            sessionId: "session-2",
            machineId: "machine-2",
        });
        startedClients.push(machine, boundSession, ownerSession, requesterSession, requesterHistory, requesterOtherMachine);
        eventRouter.setIo(cluster.emitter);

        const disconnected = [machine, boundSession, requesterSession].map((socket) => new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Exact resource socket stayed connected")), 5_000);
            socket.once("disconnect", () => {
                clearTimeout(timer);
                resolve();
            });
        }));
        eventRouter.disconnectMachineAndSessionSockets({
            accountId: "user-1",
            machineId: "machine-1",
            sessionBindings: [
                { accountId: "user-1", sessionId: "session-1" },
                { accountId: "user-2", sessionId: "session-2" },
            ],
        });

        await Promise.all(disconnected);
        expect(ownerSession.connected).toBe(true);
        expect(requesterHistory.connected).toBe(true);
        expect(requesterOtherMachine.connected).toBe(true);
    });

    it("delivers room-targeted updates from an external emitter process to connected api sockets", async () => {
        const cluster = await startCluster();
        startedClusters.push(cluster);
        const socket = await connectClient(cluster.portB);
        startedClients.push(socket);

        eventRouter.setIo(cluster.emitter as unknown as Parameters<typeof eventRouter.setIo>[0]);

        const updatePromise = new Promise<unknown>((resolve) => {
            socket.once("update", (payload) => resolve(payload));
        });

        eventRouter.emitUpdate({
            userId: "user-1",
            payload: {
                id: "upd-1",
                seq: 1,
                createdAt: Date.now(),
                body: { t: "new-message" },
            } as never,
            recipientFilter: { type: "all-user-authenticated-connections" },
        });

        await expect(updatePromise).resolves.toEqual(expect.objectContaining({
            id: "upd-1",
        }));
    });
});
