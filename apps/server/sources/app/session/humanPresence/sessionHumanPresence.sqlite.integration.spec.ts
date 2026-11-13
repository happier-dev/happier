import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket } from "socket.io-client";
import { startSocket } from "@/app/api/socket";
import type { Fastify as AppFastify } from "@/app/api/types";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { withSqliteReadSnapshot } from "@/storage/prisma";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { SessionHumanPresenceSnapshotV1Schema, type SessionHumanPresenceSnapshotV1 } from "@happier-dev/protocol/sessions";
import { inTx } from "@/storage/inTx";
import { deleteSessionAccessGrantInTx, putSessionAccessGrantInTx } from "@/app/session/access/sessionAccessGrantService";
import { notifySessionHumanPresenceAccessChanged } from "./sessionHumanPresenceService";
import { notifyDiscussionHumanPresenceAccessChanged } from "./sessionHumanPresenceService";
import { setDiscussionGrant, removeDiscussionGrant } from "@/app/discussions/accessService";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol";
import { decodeBase64 } from "@happier-dev/protocol/crypto/base64";
import { eventRouter } from "@/app/events/eventRouter";
import { discussionHumanPresenceRoom } from "./sessionHumanPresenceRooms";

const visibleEvent = "session-human-presence:visible-replace";
const snapshotEvent = "session-human-presence:snapshot";
// The real client declares under its existing 7.5s socket acknowledgement deadline.
// Staying below it keeps this a meaningful bound while absorbing the first cold
// Prisma/SQLite access query, which a 1s budget could not.
const ACK_TIMEOUT_MS = 5_000;
const ownerAuthentication = () => ({ env: process.env, authority: "present_user" as const, authenticationEvidence: [] });

function deferred<T = void>(): Readonly<{
    promise: Promise<T>;
    resolve: (value: T) => void;
}> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

/**
 * Pauses the real SQLite profile read after Discussion grant admission. The
 * resource and grant are now stale if deletion commits during this boundary;
 * the final resource read must prevent an outbound snapshot from that state.
 */
function installDiscussionPresenceReadBarrier(input: Readonly<{
    discussionId: string;
    accountId: string;
}>): Readonly<{
    firstRead: Promise<void>;
    nextProjectionRead: Promise<void>;
    releaseFirst: () => void;
    restore: () => void;
}> {
    const firstRead = deferred();
    const releaseFirst = deferred();
    const nextProjectionRead = deferred();
    const originalDelegate = db.discussion;
    const originalFindUnique = originalDelegate.findUnique;
    const accountDelegate = db.account;
    const originalFindMany = accountDelegate.findMany;
    let paused = false;
    let restored = false;

    // Intercept the real model method rather than replacing Prisma's computed
    // model property (the generated client can ignore a replacement delegate).
    Reflect.set(originalDelegate, "findUnique", async (...args: Parameters<typeof originalFindUnique>) => {
        const result = await Reflect.apply(originalFindUnique, originalDelegate, args);
        const candidate = args[0] as Readonly<{ where?: Readonly<{ id?: unknown }> }> | undefined;
        if (paused && candidate?.where?.id === input.discussionId && result === null) nextProjectionRead.resolve();
        return result;
    });
    Reflect.set(accountDelegate, "findMany", async (...args: Parameters<typeof originalFindMany>) => {
        const result = await Reflect.apply(originalFindMany, accountDelegate, args);
        const candidate = args[0] as Readonly<{
            where?: Readonly<{ id?: Readonly<{ in?: readonly string[] }> }>;
            select?: Readonly<{ name?: unknown }>;
        }> | undefined;
        if (!paused && candidate?.where?.id?.in?.includes(input.accountId) && candidate.select?.name === true) {
            paused = true;
            firstRead.resolve();
            await releaseFirst.promise;
        }
        return result;
    });

    return {
        firstRead: firstRead.promise,
        nextProjectionRead: nextProjectionRead.promise,
        releaseFirst: () => releaseFirst.resolve(),
        restore: () => {
            if (restored) return;
            restored = true;
            releaseFirst.resolve();
            Reflect.set(originalDelegate, "findUnique", originalFindUnique);
            Reflect.set(accountDelegate, "findMany", originalFindMany);
        },
    };
}

describe("authenticated human presence over real memory-adapter sockets", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-human-presence-", initAuth: true, initEncrypt: true,
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("projects admitted pending edits for the socket lifetime without metadata writes or false human viewers", async () => {
        const [owner, editor, viewer] = await Promise.all(["Edit owner", "Editor", "Read only"].map(name =>
            db.account.create({ data: { publicKey: crypto.randomUUID(), name, encryptionMode: "plain" } })));
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: JSON.stringify({ t: "plain", v: {} }),
        } });
        const otherSession = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: JSON.stringify({ t: "plain", v: {} }),
        } });
        for (const [account, accessLevel] of [[editor, "edit"], [viewer, "view"]] as const) {
            await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: account.id, status: "friend" } });
            expect(await inTx(tx => putSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id, sessionId: session.id,
                subject: { kind: "account", accountId: account.id },
                grant: { accessLevel, canApprovePermissions: false }, authentication: ownerAuthentication(),
            }))).toMatchObject({ ok: true });
        }
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP listener");
        const clients: Socket[] = [];
        const observations = new Map<Socket, SessionHumanPresenceSnapshotV1[]>();
        const connect = async (accountId: string, observer = false) => {
            const token = await auth.createToken(accountId, undefined, { kind: "account", authority: "present_user" });
            const client = ioClient(`http://127.0.0.1:${address.port}`, {
                path: "/v1/updates", transports: ["websocket"], reconnection: false, autoConnect: false,
                auth: { token, ...(observer ? { clientType: "session-scoped", sessionId: session.id } : {}) },
            });
            clients.push(client);
            observations.set(client, []);
            client.on(snapshotEvent, value => observations.get(client)!.push(SessionHumanPresenceSnapshotV1Schema.parse(value)));
            await new Promise<void>((resolve, reject) => {
                client.once("connect", resolve); client.once("connect_error", reject); client.connect();
            });
            return client;
        };
        const declare = (client: Socket, sessionIds: string[], pendingMessageEdits: Array<{ sessionId: string; holdId: string }>) =>
            client.timeout(ACK_TIMEOUT_MS).emitWithAck(visibleEvent, { v: 1, sessionIds, pendingMessageEdits });
        const latest = (client: Socket) => observations.get(client)!.filter(
            (value): value is Extract<SessionHumanPresenceSnapshotV1, { sessionId: string }> => value.sessionId === session.id,
        ).at(-1);
        const hold = { sessionId: session.id, holdId: "drainhold:editing-device" };
        try {
            const editorSocket = await connect(editor.id);
            const before = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { metadata: true, metadataVersion: true } });
            expect(await declare(editorSocket, [], [hold])).toEqual({
                v: 1, ok: true, admittedSessionIds: [], admittedPendingMessageEdits: [hold],
            });
            const declareAdmittedObserver = async (client: Socket) => {
                // The socket handshake already admitted this exact Session. A
                // second database read can fail independently and strand the queue
                // before it joins the room that owns projection recovery.
                const reader = await withSqliteReadSnapshot(async tx => tx.session);
                const originalFindMany = reader.findMany;
                const admissionReads = vi.fn(async () => { throw new Error("admission read unavailable"); });
                Reflect.set(reader, "findMany", admissionReads);
                try {
                    expect(await declare(client, [session.id], [])).toEqual({
                        v: 1, ok: true, admittedSessionIds: [session.id], admittedPendingMessageEdits: [],
                    });
                    expect(admissionReads).not.toHaveBeenCalled();
                } finally { Reflect.set(reader, "findMany", originalFindMany); }
            };
            let observer = await connect(owner.id, true);
            await declareAdmittedObserver(observer);
            await expect.poll(() => latest(observer)).toMatchObject({ viewers: [], pendingMessageEditHoldIds: [hold.holdId] });
            await expect.poll(() => latest(editorSocket)).toMatchObject({ viewers: [] });
            expect(latest(editorSocket)).not.toHaveProperty("pendingMessageEditHoldIds");
            expect(await declare(observer, [otherSession.id], [])).toEqual({ v: 1, ok: false, errorCode: "INVALID_REQUEST" });
            await expect(connect(viewer.id, true)).rejects.toMatchObject({
                data: { error: "invalid-session", statusCode: 403 },
            });

            observer.close();
            observer = await connect(owner.id, true);
            // A real profile-read outage after room admission uses the existing
            // projection repair, preserving the other device's live edit.
            const profileReader = db.account;
            const originalFindMany = profileReader.findMany;
            const profileReads = vi.fn(originalFindMany.bind(profileReader)).mockRejectedValueOnce(new Error("projection profile unavailable"));
            Reflect.set(profileReader, "findMany", profileReads);
            try {
                await declareAdmittedObserver(observer);
                await expect.poll(() => profileReads.mock.calls.length).toBeGreaterThan(0);
                expect(latest(observer)).toBeUndefined();
            } finally { Reflect.set(profileReader, "findMany", originalFindMany); }
            await expect.poll(() => latest(observer), { timeout: 8_000 }).toMatchObject({
                viewers: [], pendingMessageEditHoldIds: [hold.holdId],
            });

            const legacy = await connect(owner.id);
            expect(await legacy.timeout(ACK_TIMEOUT_MS).emitWithAck(visibleEvent, { v: 1, sessionIds: [session.id] }))
                .toEqual({ v: 1, ok: true, admittedSessionIds: [session.id] });
            await expect.poll(() => latest(legacy)?.viewers).toHaveLength(1);
            expect(latest(legacy)).not.toHaveProperty("pendingMessageEditHoldIds");
            const reader = await connect(viewer.id);
            expect(await declare(reader, [], [{ sessionId: session.id, holdId: "read-only-hold" }])).toEqual({
                v: 1, ok: true, admittedSessionIds: [], admittedPendingMessageEdits: [],
            });

            // Changing actual visibility must neither release the edit nor turn
            // the session-scoped queue observer into a human viewer.
            expect(await declare(editorSocket, [session.id], [hold])).toMatchObject({ admittedPendingMessageEdits: [hold] });
            await expect.poll(() => latest(observer)?.viewers.map(value => value.account.accountId).sort())
                .toEqual([owner.id, editor.id].sort());
            expect(await inTx(tx => putSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id, sessionId: session.id,
                subject: { kind: "account", accountId: editor.id },
                grant: { accessLevel: "view", canApprovePermissions: false }, authentication: ownerAuthentication(),
            }))).toMatchObject({ ok: true });
            // The committed access change withdraws open-ended queue control,
            // even though the socket retains its readable declaration identity.
            await expect.poll(() => latest(observer)?.pendingMessageEditHoldIds).toEqual([]);
            // A replacement cannot revive that hold while input access is absent;
            // a new edit still needs its own admission.
            expect(await declare(editorSocket, [], [hold, { sessionId: session.id, holdId: "new-after-downgrade" }]))
                .toMatchObject({ admittedPendingMessageEdits: [hold] });
            await expect.poll(() => latest(observer)).toMatchObject({
                viewers: [{ account: { accountId: owner.id } }], pendingMessageEditHoldIds: [],
            });
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { metadata: true, metadataVersion: true } })).toEqual(before);

            expect(await inTx(tx => putSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id, sessionId: session.id,
                subject: { kind: "account", accountId: editor.id },
                grant: { accessLevel: "edit", canApprovePermissions: false }, authentication: ownerAuthentication(),
            }))).toMatchObject({ ok: true });
            await expect.poll(() => latest(observer)?.pendingMessageEditHoldIds).toEqual([hold.holdId]);
            expect(await declare(editorSocket, [], [])).toMatchObject({ admittedPendingMessageEdits: [] });
            await expect.poll(() => latest(observer)?.pendingMessageEditHoldIds).toEqual([]);
            expect(await declare(editorSocket, [], [hold])).toMatchObject({ admittedPendingMessageEdits: [hold] });
            await expect.poll(() => latest(observer)?.pendingMessageEditHoldIds).toEqual([hold.holdId]);
            legacy.close();
            editorSocket.close();
            await expect.poll(() => latest(observer)).toMatchObject({ viewers: [], pendingMessageEditHoldIds: [] });
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { metadata: true, metadataVersion: true } })).toEqual(before);
        } finally {
            clients.forEach(client => client.close());
            await app.close();
        }
    }, 30_000);

    it("negotiates on the actual visible replacement, admits readable sessions, replaces and clears rooms", async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), name: "Owner" } });
        const other = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        // One real Socket.IO declaration deliberately exceeds the retired
        // Lane-local 16-Session ceiling. The transport's actual byte bound still
        // applies, but presence must not invent a smaller item-count boundary.
        const sessions = await Promise.all([...Array.from({ length: 20 }, () => owner.id), other.id].map(accountId => db.session.create({
            data: { accountId, tag: crypto.randomUUID(), metadata: "{}" },
        })));
        const token = await auth.createToken(owner.id, undefined, { kind: "account", authority: "present_user" });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP listener");
        const clients: Socket[] = [];
        const connect = async () => {
            const client = ioClient(`http://127.0.0.1:${address.port}`, {
                path: "/v1/updates", transports: ["websocket"], reconnection: false, autoConnect: false, auth: { token },
            });
            clients.push(client);
            await new Promise<void>((resolve, reject) => {
                client.once("connect", resolve);
                client.once("connect_error", reject);
                client.connect();
            });
            return client;
        };
        // A bare acknowledgement timeout names only Socket.IO internals, so each
        // declaration carries the step that actually stalled.
        const declare = async (step: string, client: Socket, payload: unknown): Promise<unknown> => {
            try {
                return await client.timeout(ACK_TIMEOUT_MS).emitWithAck(visibleEvent, payload);
            } catch (error) {
                throw new Error(`Human presence declaration "${step}" was not acknowledged: ${String(error)}`);
            }
        };
        try {
            const client = await connect();
            const snapshots: Array<{ sessionId: string; viewers: Array<{ account: { accountId: string }; typing: boolean }> }> = [];
            client.on(snapshotEvent, value => snapshots.push(value));
            const ids = sessions.slice(0, 20).map(session => session.id).sort();
            expect(await declare("initial", client, { v: 1, sessionIds: sessions.map(session => session.id) }))
                .toEqual({ v: 1, ok: true, admittedSessionIds: ids });
            await expect.poll(() => snapshots.some(value => value.sessionId === ids[0]
                && value.viewers.length === 1 && value.viewers[0].account.accountId === owner.id), {
                // Presence is best effort. Reuse the real client acknowledgement
                // budget here rather than inventing Vitest's implicit one-second
                // product deadline for the first cold SQLite projection.
                timeout: ACK_TIMEOUT_MS,
            }).toBe(true);
            const observer = await connect();
            const observed: Array<{ sessionId: string; viewers: unknown[] }> = [];
            observer.on(snapshotEvent, value => observed.push(value));
            // Declared while the first client's projections are still in flight: a second
            // tab must be admitted promptly instead of starving behind awareness reads.
            await declare("observer", observer, { v: 1, sessionIds: [ids[0]] });
            await expect.poll(() => observed.at(-1)?.viewers.length).toBe(1);
            expect(await declare("replace", client, { v: 1, sessionIds: [ids[1]] }))
                .toEqual({ v: 1, ok: true, admittedSessionIds: [ids[1]] });
            expect(await declare("empty", client, { v: 1, sessionIds: [] }))
                .toEqual({ v: 1, ok: true, admittedSessionIds: [] });
            expect(await declare("unsupported version", observer, { v: 2, sessionIds: [] }))
                .toEqual({ v: 1, ok: false, errorCode: "UNSUPPORTED_VERSION" });
            expect(await declare("malformed id", observer, { v: 1, sessionIds: [""] }))
                .toEqual({ v: 1, ok: false, errorCode: "INVALID_REQUEST" });
        } finally {
            clients.forEach(client => client.close());
            await app.close();
        }
    }, 30_000);

    it("isolates simultaneous Session and two-discussion declarations through replacement, revocation, and deletion", async () => {
        const [owner, sessionViewer, discussionAViewer, discussionBViewer, everywhereViewer] = await Promise.all([
            "Owner", "Session viewer", "Discussion A viewer", "Discussion B viewer", "Everywhere viewer",
        ].map(name => db.account.create({
            data: { publicKey: crypto.randomUUID(), name, encryptionMode: "plain" },
        })));
        const session = await db.session.create({ data: {
            accountId: owner.id,
            tag: crypto.randomUUID(),
            encryptionMode: "plain",
            metadata: JSON.stringify({ t: "plain", v: {} }),
        } });
        const [discussionA, discussionB] = await Promise.all(["Discussion A", "Discussion B"].map(title =>
            db.discussion.create({ data: {
                ownerAccountId: owner.id,
                encryptionMode: "plain",
                dataEncryptionKey: new Uint8Array(decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)),
                creationLocalId: crypto.randomUUID(),
                creationEqualityEvidenceV1: {},
                createdByAccountId: owner.id,
                titleContent: { t: "plain", v: { v: 1, title } },
                lastMessageAt: new Date(),
            } })));
        // Access is granted and later revoked through the real grant owner, whose
        // committed transition is the production publisher of the presence recheck.
        for (const account of [sessionViewer, discussionAViewer, discussionBViewer, everywhereViewer]) {
            await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: account.id, status: "friend" } });
            expect(await inTx(tx => putSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject: { kind: "account", accountId: account.id },
                grant: { accessLevel: "edit", canApprovePermissions: false },
                authentication: ownerAuthentication(),
            }))).toMatchObject({ ok: true, changed: true });
            for (const discussion of [discussionA, discussionB]) {
                expect(await setDiscussionGrant({ actorAccountId: owner.id, discussionId: discussion.id,
                    authentication: ownerAuthentication(), request: { principal: { kind: "account", accountId: account.id }, accessLevel: "edit" },
                })).toMatchObject({ ok: true });
            }
        }
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP listener");
        const clients: Socket[] = [];
        const observations = new Map<Socket, SessionHumanPresenceSnapshotV1[]>();
        const connect = async (accountId: string) => {
            const token = await auth.createToken(accountId, undefined, { kind: "account", authority: "present_user" });
            const client = ioClient(`http://127.0.0.1:${address.port}`, {
                path: "/v1/updates",
                transports: ["websocket"],
                reconnection: false,
                autoConnect: false,
                auth: { token },
            });
            clients.push(client);
            observations.set(client, []);
            client.on(snapshotEvent, value => observations.get(client)!.push(SessionHumanPresenceSnapshotV1Schema.parse(value)));
            await new Promise<void>((resolve, reject) => {
                client.once("connect", resolve);
                client.once("connect_error", reject);
                client.connect();
            });
            return client;
        };
        const locationA = { discussionId: discussionA.id };
        const locationB = { discussionId: discussionB.id };
        const sortedLocations = [locationA, locationB].sort((left, right) =>
            left.discussionId.localeCompare(right.discussionId));
        const declare = (
            client: Socket,
            sessionIds: readonly string[],
            locations: readonly Readonly<{ discussionId: string }>[],
        ) => client.timeout(ACK_TIMEOUT_MS).emitWithAck(visibleEvent, { v: 1, sessionIds, locations });
        const latestAccountIds = (client: Socket, discussionId?: string) => observations.get(client)!
            .filter(value => discussionId === undefined ? value.sessionId === session.id : value.discussionId === discussionId)
            .at(-1)?.viewers.map(value => value.account.accountId).sort();
        const expectLocation = async (client: Socket, accountIds: readonly string[], discussionId?: string) => {
            await expect.poll(() => latestAccountIds(client, discussionId), { timeout: ACK_TIMEOUT_MS })
                .toEqual([...accountIds].sort());
        };
        try {
            const observerSocket = await connect(owner.id);
            const sessionSocket = await connect(sessionViewer.id);
            const discussionASocket = await connect(discussionAViewer.id);
            const discussionBSocket = await connect(discussionBViewer.id);
            const everywhereSocket = await connect(everywhereViewer.id);

            expect(await declare(observerSocket, [session.id], [locationA, locationB])).toEqual({
                v: 1,
                ok: true,
                admittedSessionIds: [session.id],
                admittedLocations: sortedLocations,
            });
            await Promise.all([
                declare(sessionSocket, [session.id], []),
                declare(discussionASocket, [], [locationA]),
                declare(discussionBSocket, [], [locationB]),
                declare(everywhereSocket, [session.id], [locationA, locationB]),
            ]);
            await expectLocation(observerSocket, [owner.id, sessionViewer.id, everywhereViewer.id]);
            await expectLocation(observerSocket, [owner.id, discussionAViewer.id, everywhereViewer.id], discussionA.id);
            await expectLocation(observerSocket, [owner.id, discussionBViewer.id, everywhereViewer.id], discussionB.id);

            expect(await declare(sessionSocket, [], [locationA])).toEqual({
                v: 1,
                ok: true,
                admittedSessionIds: [],
                admittedLocations: [locationA],
            });
            await expectLocation(observerSocket, [owner.id, everywhereViewer.id]);
            await expectLocation(
                observerSocket,
                [owner.id, sessionViewer.id, discussionAViewer.id, everywhereViewer.id],
                discussionA.id,
            );
            await expectLocation(observerSocket, [owner.id, discussionBViewer.id, everywhereViewer.id], discussionB.id);
            expect(await declare(sessionSocket, [], [locationB])).toEqual({
                v: 1,
                ok: true,
                admittedSessionIds: [],
                admittedLocations: [locationB],
            });
            await expectLocation(observerSocket, [owner.id, discussionAViewer.id, everywhereViewer.id], discussionA.id);
            await expectLocation(
                observerSocket,
                [owner.id, sessionViewer.id, discussionBViewer.id, everywhereViewer.id],
                discussionB.id,
            );
            expect(await declare(sessionSocket, [], [])).toEqual({
                v: 1,
                ok: true,
                admittedSessionIds: [],
                admittedLocations: [],
            });
            await expectLocation(observerSocket, [owner.id, discussionAViewer.id, everywhereViewer.id], discussionA.id);
            await expectLocation(observerSocket, [owner.id, discussionBViewer.id, everywhereViewer.id], discussionB.id);

            expect(await everywhereSocket.timeout(ACK_TIMEOUT_MS).emitWithAck(visibleEvent, {
                v: 2,
                sessionIds: [],
            })).toEqual({ v: 1, ok: false, errorCode: "UNSUPPORTED_VERSION" });
            expect(await everywhereSocket.timeout(ACK_TIMEOUT_MS).emitWithAck(visibleEvent, {
                v: 1,
                sessionIds: [],
                locations: [{ discussionId: " " }],
            })).toEqual({ v: 1, ok: false, errorCode: "INVALID_REQUEST" });
            notifySessionHumanPresenceAccessChanged({ sessionId: session.id });
            await expectLocation(observerSocket, [owner.id, everywhereViewer.id]);
            await expectLocation(observerSocket, [owner.id, discussionAViewer.id, everywhereViewer.id], discussionA.id);
            await expectLocation(observerSocket, [owner.id, discussionBViewer.id, everywhereViewer.id], discussionB.id);

            expect(await inTx(tx => deleteSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject: { kind: "account", accountId: everywhereViewer.id },
                authentication: ownerAuthentication(),
            }))).toMatchObject({ ok: true, changed: true });
            await expectLocation(observerSocket, [owner.id]);
            // Removing source access cannot revoke an independent Discussion.
            await expectLocation(observerSocket, [owner.id, discussionAViewer.id, everywhereViewer.id], discussionA.id);
            await expectLocation(observerSocket, [owner.id, discussionBViewer.id, everywhereViewer.id], discussionB.id);
            for (const discussion of [discussionA, discussionB]) {
                expect(await removeDiscussionGrant({ actorAccountId: owner.id, discussionId: discussion.id,
                    authentication: ownerAuthentication(), request: { principal: { kind: "account", accountId: everywhereViewer.id } },
                })).toMatchObject({ ok: true });
            }
            await expectLocation(observerSocket, [owner.id, discussionAViewer.id], discussionA.id);
            await expectLocation(observerSocket, [owner.id, discussionBViewer.id], discussionB.id);

            const discussionBSnapshotCount = observations.get(observerSocket)!
                .filter(value => value.discussionId === discussionB.id).length;
            await db.discussion.delete({ where: { id: discussionA.id } });
            const discussionADeletedAt = Date.now();
            notifyDiscussionHumanPresenceAccessChanged({ discussionId: discussionA.id });
            notifyDiscussionHumanPresenceAccessChanged({ discussionId: discussionB.id });
            await expect.poll(() => observations.get(observerSocket)!
                .filter(value => value.discussionId === discussionB.id).length, { timeout: ACK_TIMEOUT_MS })
                .toBeGreaterThan(discussionBSnapshotCount);
            expect(observations.get(observerSocket)!
                .filter(value => value.discussionId === discussionA.id && value.observedAt > discussionADeletedAt)).toEqual([]);
            expect(await declare(observerSocket, [session.id], [locationA, locationB])).toEqual({
                v: 1,
                ok: true,
                admittedSessionIds: [session.id],
                admittedLocations: [locationB],
            });
        } finally {
            clients.forEach(client => client.close());
            await app.close();
        }
    }, 30_000);

    it("does not emit a Discussion snapshot after deletion commits during projection", async () => {
        const owner = await db.account.create({ data: {
            publicKey: crypto.randomUUID(), name: "Discussion deletion owner", encryptionMode: "plain",
        } });
        const session = await db.session.create({ data: {
            accountId: owner.id,
            tag: crypto.randomUUID(),
            encryptionMode: "plain",
            metadata: JSON.stringify({ t: "plain", v: {} }),
        } });
        const discussion = await db.discussion.create({ data: {
            ownerAccountId: owner.id,
            encryptionMode: "plain",
            dataEncryptionKey: new Uint8Array(decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)),
            creationLocalId: crypto.randomUUID(),
            creationEqualityEvidenceV1: {},
            createdByAccountId: owner.id,
            titleContent: { t: "plain", v: { v: 1, title: "Delete during projection" } },
            lastMessageAt: new Date(),
        } });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP listener");
        const token = await auth.createToken(owner.id, undefined, { kind: "account", authority: "present_user" });
        const client = ioClient(`http://127.0.0.1:${address.port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: { token },
        });
        const observations: SessionHumanPresenceSnapshotV1[] = [];
        const staleSnapshot = deferred<SessionHumanPresenceSnapshotV1>();
        client.on(snapshotEvent, value => {
            const snapshot = SessionHumanPresenceSnapshotV1Schema.parse(value);
            observations.push(snapshot);
            if (snapshot.discussionId === discussion.id) {
                staleSnapshot.resolve(snapshot);
            }
        });
        await new Promise<void>((resolve, reject) => {
            client.once("connect", resolve);
            client.once("connect_error", reject);
            client.connect();
        });
        const barrier = installDiscussionPresenceReadBarrier({
            discussionId: discussion.id,
            accountId: owner.id,
        });
        try {
            const location = { discussionId: discussion.id };
            expect(await client.timeout(ACK_TIMEOUT_MS).emitWithAck(visibleEvent, {
                v: 1,
                sessionIds: [],
                locations: [location],
            })).toEqual({
                v: 1,
                ok: true,
                admittedSessionIds: [],
                admittedLocations: [location],
            });
            await barrier.firstRead;

            await db.discussion.delete({ where: { id: discussion.id } });
            notifyDiscussionHumanPresenceAccessChanged({ discussionId: discussion.id });
            barrier.releaseFirst();

            const outcome = await Promise.race([
                barrier.nextProjectionRead.then(() => ({ kind: "current" as const })),
                staleSnapshot.promise.then(snapshot => ({ kind: "stale_snapshot" as const, snapshot })),
            ]);
            expect(outcome).toEqual({ kind: "current" });
            const serverSocket = [...eventRouter.getConnections(owner.id) ?? []]
                .find(connection => connection.socket.id === client.id)?.socket;
            expect(serverSocket).toBeDefined();
            // Wait for the queued deletion projection to finish evicting the
            // actual socket, then flush the same transport with an acknowledged
            // empty replacement before checking that no earlier packet leaked.
            await expect.poll(() => serverSocket?.rooms.has(discussionHumanPresenceRoom({ discussionId: discussion.id })), {
                timeout: ACK_TIMEOUT_MS,
            }).toBe(false);
            expect(await client.timeout(ACK_TIMEOUT_MS).emitWithAck(visibleEvent, { v: 1, sessionIds: [], locations: [] }))
                .toEqual({ v: 1, ok: true, admittedSessionIds: [], admittedLocations: [] });
            expect(observations.filter(snapshot => snapshot.discussionId === discussion.id)).toEqual([]);
        } finally {
            barrier.restore();
            client.close();
            await app.close();
        }
    }, 30_000);

    it("names authorized guests, checks input separately, expires typing and evicts after committed revocation", async () => {
        const [owner, editor, viewer, guest] = await Promise.all(["Owner", "Editor", "Viewer", "Named guest"].map(name =>
            db.account.create({ data: { publicKey: crypto.randomUUID(), name, encryptionMode: "plain" } })));
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: JSON.stringify({ t: "plain", v: {} }),
        } });
        const discussion = await db.discussion.create({ data: {
            ownerAccountId: owner.id,
            encryptionMode: "plain",
            dataEncryptionKey: new Uint8Array(decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)),
            creationLocalId: crypto.randomUUID(),
            creationEqualityEvidenceV1: {},
            createdByAccountId: owner.id,
            titleContent: { t: "plain", v: { v: 1, title: "Presence" } },
            lastMessageAt: new Date(),
        } });
        const putDirect = (accountId: string, accessLevel: "view" | "edit") => inTx(tx => putSessionAccessGrantInTx(tx, {
            actorAccountId: owner.id,
            sessionId: session.id,
            subject: { kind: "account", accountId },
            grant: { accessLevel, canApprovePermissions: false },
            authentication: ownerAuthentication(),
        }));
        for (const account of [editor, viewer]) {
            await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: account.id, status: "friend" } });
        }
        expect(await putDirect(editor.id, "edit")).toMatchObject({ ok: true, changed: true });
        expect(await putDirect(viewer.id, "view")).toMatchObject({ ok: true, changed: true });
        const putDiscussion = (accountId: string, accessLevel: "view" | "edit") => setDiscussionGrant({
            actorAccountId: owner.id, discussionId: discussion.id, authentication: ownerAuthentication(),
            request: { principal: { kind: "account", accountId }, accessLevel },
        });
        expect(await putDiscussion(editor.id, "edit")).toMatchObject({ ok: true });
        expect(await putDiscussion(viewer.id, "view")).toMatchObject({ ok: true });
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: guest.id, role: "guest" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Guests", nameKey: "guests" } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id } });
        await db.sessionGrant.create({ data: { principalKind: 'group', sessionId: session.id, teamGroupId: group.id, accessLevel: "edit", effectiveAt: new Date() } });
        expect(await setDiscussionGrant({ actorAccountId: owner.id, discussionId: discussion.id, authentication: ownerAuthentication(),
            request: { principal: { kind: "group", groupId: group.id, teamId: team.id }, accessLevel: "edit" },
        })).toMatchObject({ ok: true });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP listener");
        const clients: Socket[] = [];
        const observations = new Map<Socket, SessionHumanPresenceSnapshotV1[]>();
        const connect = async (accountId: string, scope?: "session-scoped") => {
            const token = await auth.createToken(accountId, undefined, { kind: "account", authority: "present_user" });
            const client = ioClient(`http://127.0.0.1:${address.port}`, {
                path: "/v1/updates", transports: ["websocket"], reconnection: false, autoConnect: false,
                auth: { token, ...(scope ? { clientType: scope, sessionId: session.id } : {}) },
            });
            clients.push(client);
            observations.set(client, []);
            client.on(snapshotEvent, value => observations.get(client)!.push(SessionHumanPresenceSnapshotV1Schema.parse(value)));
            await new Promise<void>((resolve, reject) => {
                client.once("connect", resolve);
                client.once("connect_error", reject);
                client.connect();
            });
            return client;
        };
        const declare = (
            client: Socket,
            sessionIds = [session.id],
            locations: readonly Readonly<{ discussionId: string }>[] = [],
        ) => client.timeout(ACK_TIMEOUT_MS).emitWithAck(visibleEvent, {
            v: 1,
            sessionIds,
            ...(locations.length > 0 ? { locations } : {}),
        });
        try {
            const ownerSocket = await connect(owner.id);
            const editorSocket = await connect(editor.id);
            const viewerSocket = await connect(viewer.id);
            const guestSocket = await connect(guest.id);
            const secondGuestSocket = await connect(guest.id);
            const publisherSocket = await connect(owner.id, "session-scoped");
            const beforeReadStates = await db.accountSessionReadState.count();
            const beforeFollows = await db.accountSessionFollow.count();
            const beforeChanges = await db.accountChange.count();
            const last = () => observations.get(ownerSocket)!
                .filter(value => value.sessionId === session.id && value.discussionId === undefined).at(-1);
            for (const client of [ownerSocket, editorSocket, viewerSocket, guestSocket, secondGuestSocket]) {
                expect(await declare(client, [session.id], [
                    { discussionId: discussion.id },
                ])).toEqual({
                    v: 1,
                    ok: true,
                    admittedSessionIds: [session.id],
                    admittedLocations: [{ discussionId: discussion.id }],
                });
            }
            await expect.poll(() => last()?.viewers.length).toBe(4);
            const lastDiscussion = () => observations.get(ownerSocket)!
                .filter(value => value.discussionId === discussion.id).at(-1);
            await expect.poll(() => lastDiscussion()?.viewers.length).toBe(4);
            expect(last()?.viewers.find(value => value.account.accountId === guest.id)?.account.firstName).toBe("Named guest");
            await expect(publisherSocket.timeout(200).emitWithAck(visibleEvent, { v: 1, sessionIds: [session.id] })).rejects.toThrow();
            expect(observations.get(publisherSocket)).toEqual([]);

            viewerSocket.emit("session-human-presence:typing-set", {
                v: 1, discussionId: discussion.id, typing: true,
            });
            await declare(viewerSocket, [session.id], [{ discussionId: discussion.id }]);
            editorSocket.emit("session-human-presence:typing-set", {
                v: 1, discussionId: discussion.id, typing: true,
            });
            await expect.poll(() => lastDiscussion()?.viewers.find(value => value.account.accountId === editor.id)?.typing).toBe(true);
            expect(lastDiscussion()?.viewers.find(value => value.account.accountId === viewer.id)?.typing).toBe(false);
            // Discussion typing is scoped to that exact location and must not
            // leak into the neighboring Session composer snapshot.
            expect(last()?.viewers.find(value => value.account.accountId === editor.id)?.typing).toBe(false);
            await expect.poll(() => lastDiscussion()?.viewers.find(value => value.account.accountId === editor.id)?.typing, { timeout: 8_000 }).toBe(false);

            editorSocket.emit("session-human-presence:typing-set", {
                v: 1, discussionId: discussion.id, typing: true,
            });
            await expect.poll(() => lastDiscussion()?.viewers.find(value => value.account.accountId === editor.id)?.typing).toBe(true);
            // Presence itself writes no read state, Follow or AccountChange; the
            // grant transitions below legitimately do, so the invariant is checked
            // around each presence-only phase.
            expect(await db.accountSessionReadState.count()).toBe(beforeReadStates);
            expect(await db.accountSessionFollow.count()).toBe(beforeFollows);
            expect(await db.accountChange.count()).toBe(beforeChanges);
            expect(await putDiscussion(editor.id, "view")).toMatchObject({ ok: true, value: { changed: true } });
            await expect.poll(() => lastDiscussion()?.viewers.find(value => value.account.accountId === editor.id)?.typing).toBe(false);
            expect(last()?.viewers.some(value => value.account.accountId === editor.id)).toBe(true);
            expect(await inTx(tx => deleteSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject: { kind: "account", accountId: editor.id },
                authentication: ownerAuthentication(),
            }))).toMatchObject({ ok: true, changed: true });
            await expect.poll(() => last()?.viewers.some(value => value.account.accountId === editor.id)).toBe(false);
            expect(await removeDiscussionGrant({ actorAccountId: owner.id, discussionId: discussion.id,
                authentication: ownerAuthentication(), request: { principal: { kind: "account", accountId: editor.id } },
            })).toMatchObject({ ok: true });
            await expect.poll(() => lastDiscussion()?.viewers.some(value => value.account.accountId === editor.id)).toBe(false);
            const afterRevocationReadStates = await db.accountSessionReadState.count();
            const afterRevocationFollows = await db.accountSessionFollow.count();
            const afterRevocationChanges = await db.accountChange.count();
            expect(await declare(editorSocket, [session.id], [{ discussionId: discussion.id }]))
                .toEqual({ v: 1, ok: true, admittedSessionIds: [], admittedLocations: [] });
            expect(await declare(guestSocket, [])).toEqual({ v: 1, ok: true, admittedSessionIds: [] });
            secondGuestSocket.close();
            await expect.poll(() => last()?.viewers.some(value => value.account.accountId === guest.id)).toBe(false);
            expect(await db.accountSessionReadState.count()).toBe(afterRevocationReadStates);
            expect(await db.accountSessionFollow.count()).toBe(afterRevocationFollows);
            expect(await db.accountChange.count()).toBe(afterRevocationChanges);
        } finally {
            clients.forEach(client => client.close());
            await app.close();
        }
    }, 30_000);
});
