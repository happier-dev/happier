import Fastify from "fastify";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionConsumptionReplaceAckV1Schema } from "@happier-dev/protocol";
import { UpdateContainerSchema } from "@happier-dev/protocol/updates";
import { buildAccountStoredContentCompatibilitySocketAuthV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from "@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1";
import { startSocket } from "@/app/api/socket";
import type { Fastify as AppFastify } from "@/app/api/types";
import { auth } from "@/app/auth/auth";
import { buildMessageUpdatedUpdate, buildNewMessageUpdate, buildUpdateSessionUpdate, eventRouter } from "@/app/events/eventRouter";
import { deleteSessionAccessGrantInTx, putSessionAccessGrantInTx } from "@/app/session/access/sessionAccessGrantService";
import { notifySessionHumanPresenceAccessChanged } from "@/app/session/humanPresence/sessionHumanPresenceService";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import * as sqliteStorage from "@/storage/prisma";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("Session consumption through authenticated Socket.IO registration and SQLite", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-session-consumption-", initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: "", HAPPIER_SOCKET_ADAPTER: "memory" } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("replaces demand, isolates devices, survives reconnect and rechecks revoked access before hints or bodies", async () => {
        const [owner, viewer, stranger] = await Promise.all(Array.from({ length: 3 }, () => db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        })));
        const [session, denied] = await Promise.all([owner, stranger].map(account => db.session.create({ data: {
            accountId: account.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain",
        } })));
        const authentication = { env: process.env, authority: "present_user" as const, authenticationEvidence: [] };
        await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: viewer.id, status: "friend" } });
        expect(await inTx(tx => putSessionAccessGrantInTx(tx, {
            actorAccountId: owner.id, sessionId: session.id, subject: { kind: "account", accountId: viewer.id },
            grant: { accessLevel: "view", canApprovePermissions: false }, authentication,
        }))).toMatchObject({ ok: true });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        const io = app.machineDaemonPresence;
        if (!(io instanceof Server)) throw new Error("Missing Socket.IO server");
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("Missing socket address");
        const clients: ClientSocket[] = [];
        const updates = new Map<ClientSocket, unknown[]>();
        const metadataUpdates = new Map<ClientSocket, unknown[]>();
        const ticks = new Map<ClientSocket, unknown[]>();
        const accountChangeFrames = new Map<ClientSocket, number>();
        const open = async (accountId: string, clientPurpose: string, runner = false) => {
            const token = await auth.createToken(accountId, undefined, { kind: "account", authority: "present_user" });
            const client = connect(`http://127.0.0.1:${address.port}`, {
                path: "/v1/updates", transports: ["websocket"], reconnection: false, autoConnect: false,
                auth: { ...buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION), token, clientPurpose, clientType: runner ? "session-scoped" : "user-scoped",
                    ...(runner ? { sessionId: session.id } : {}) },
            });
            clients.push(client);
            updates.set(client, []);
            metadataUpdates.set(client, []);
            ticks.set(client, []);
            accountChangeFrames.set(client, 0);
            client.on("update", value => {
                const parsed = UpdateContainerSchema.parse(value);
                if (parsed.body.t === "account-change") accountChangeFrames.set(client, accountChangeFrames.get(client)! + 1);
                if (parsed.body.t === "new-message" || parsed.body.t === "message-updated") updates.get(client)!.push(parsed);
                if (parsed.body.t === "update-session") metadataUpdates.get(client)!.push(parsed);
            });
            client.on("ephemeral", value => {
                if (value.type === "transcript-stream-segment" || value.type === "transcript-stream-segment-delta") ticks.get(client)!.push(value);
            });
            await new Promise<void>((resolve, reject) => {
                client.once("connect", resolve); client.once("connect_error", reject); client.connect();
            });
            // Use the same ACK boundary as the real client to wait for connect convergence.
            await client.timeout(7_500).emitWithAck("ping");
            return client;
        };
        const replace = async (client: ClientSocket, liveSessionIds: string[], durableSessionIds: string[]) =>
            SessionConsumptionReplaceAckV1Schema.parse(await client.timeout(7_500).emitWithAck(
                "session-consumption-replace", { v: 1, liveSessionIds, durableSessionIds },
            ));
        const settle = async () => {
            await Promise.all(clients.filter(client => client.connected).map(client => client.timeout(7_500).emitWithAck("ping")));
        };
        const message = { id: "message", seq: 1, localId: null, content: { t: "encrypted" as const, c: "private-content" },
            createdAt: new Date(1), updatedAt: new Date(2) };
        const publish = async (accountId: string, revision = false) => eventRouter.emitUpdate({ userId: accountId,
            payload: (revision ? buildMessageUpdatedUpdate : buildNewMessageUpdate)(message, session.id, revision ? 2 : 1, crypto.randomUUID()),
            recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
        });
        try {
            const hidden = await open(owner.id, "sync");
            const live = await open(owner.id, "sync");
            const durable = await open(owner.id, "concurrent-server-cache");
            const runner = await open(owner.id, "sdk-live", true);
            const shared = await open(viewer.id, "sync");
            const unrelated = await open(stranger.id, "sync");
            expect(await replace(unrelated, [session.id], [session.id]))
                .toEqual({ ok: true, v: 1, liveSessionIds: [], durableSessionIds: [] });
            expect(await replace(live, [session.id, denied.id, "missing"], []))
                .toEqual({ ok: true, v: 1, liveSessionIds: [session.id], durableSessionIds: [] });
            expect(await replace(durable, [], [session.id]))
                .toEqual({ ok: true, v: 1, liveSessionIds: [], durableSessionIds: [session.id] });
            expect(await replace(shared, [session.id], []))
                .toEqual({ ok: true, v: 1, liveSessionIds: [session.id], durableSessionIds: [] });
            const metadataPayload = buildUpdateSessionUpdate(session.id, 3, "metadata-update",
                { version: 9, value: "private-metadata" }, { version: 4, value: "request-ledger" },
                { pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0 });
            await eventRouter.emitUpdate({ userId: owner.id, payload: metadataPayload,
                recipientFilter: { type: "all-interested-in-session", sessionId: session.id } });
            await settle();
            expect(metadataUpdates.get(hidden)).toMatchObject([{ body: { metadataDocument: "omitted", metadataVersion: 9,
                metadataLayoutVersion: 0, agentState: { version: 4, value: "request-ledger" }, pendingPermissionRequestCount: 1 } }]);
            expect(metadataUpdates.get(hidden)?.[0]).not.toHaveProperty("body.metadata");
            for (const client of [live, durable, runner]) expect(metadataUpdates.get(client)).toEqual([metadataPayload]);
            await replace(shared, [], []);
            const recipientMetadataPayload = buildUpdateSessionUpdate(session.id, 4, "recipient-metadata-update",
                { version: 10, value: JSON.stringify({ completedRequests: { request: { status: "approved" } },
                    actionConfirmationsV1: { v: 1 } }) }, { version: 4, value: "request-ledger" });
            recipientMetadataPayload.body.metadataLayoutVersion = 1;
            await eventRouter.emitUpdate({ userId: viewer.id, payload: recipientMetadataPayload,
                recipientFilter: { type: "all-interested-in-session", sessionId: session.id } });
            await settle();
            expect(metadataUpdates.get(shared)).toEqual([recipientMetadataPayload]);
            await replace(shared, [session.id], []);
            await replace(hidden, [session.id], []);
            await eventRouter.emitUpdate({ userId: owner.id, payload: metadataPayload,
                recipientFilter: { type: "all-interested-in-session", sessionId: session.id } });
            await settle();
            expect(metadataUpdates.get(hidden)?.at(-1)).toEqual(metadataPayload);
            await replace(hidden, [], []);
            await publish(owner.id);
            await publish(owner.id, true);
            for (const type of ["transcript-stream-segment", "transcript-stream-segment-delta"] as const) {
                await eventRouter.emitEphemeral({ userId: owner.id,
                    payload: { type, sessionId: session.id, message: { localId: "segment", tick: 2, baseLength: 1,
                        content: { t: "encrypted", c: "private-tick" }, createdAt: 1, updatedAt: 2 } },
                    recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
                });
            }
            await settle();
            expect(updates.get(hidden)).toEqual(["new-message", "message-updated"].map(t => expect.objectContaining({
                body: expect.objectContaining({ t, delivery: "hint", message: expect.not.objectContaining({ content: expect.anything() }) }),
            })));
            for (const client of [live, durable, runner]) expect(updates.get(client)).toHaveLength(2);
            for (const client of [live, durable, runner]) for (const update of updates.get(client)!) expect(update).toMatchObject({
                body: { delivery: "full", message: { content: message.content } },
            });
            expect(ticks.get(hidden)).toHaveLength(0);
            expect(ticks.get(durable)).toHaveLength(0);
            expect(ticks.get(live)).toHaveLength(2);
            expect(ticks.get(runner)).toHaveLength(2);

            await replace(live, [], []);
            await publish(owner.id, true);
            await settle();
            expect(updates.get(live)!.at(-1)).toMatchObject({ body: { delivery: "hint", message: { id: "message", seq: 1 } } });
            live.disconnect();
            const reconnected = await open(owner.id, "sync");
            await publish(owner.id);
            await settle();
            expect(updates.get(reconnected)).toMatchObject([{ body: { delivery: "hint" } }]);

            await publish(viewer.id);
            await settle();
            expect(updates.get(shared)).toHaveLength(1);
            const beforeRevoke = new Map(accountChangeFrames);
            expect(await inTx(tx => deleteSessionAccessGrantInTx(tx, { actorAccountId: owner.id,
                sessionId: session.id, subject: { kind: "account", accountId: viewer.id }, authentication })))
                .toMatchObject({ ok: true });
            // A grant revocation does not disconnect the person's whole Account
            // transport, but the committed Session access-change push retires
            // that open stream: its live demand is gone without any delivery.
            expect(shared.connected).toBe(true);
            const sharedServerSocket = io.sockets.sockets.get(shared.id!);
            await vi.waitFor(() => expect(sharedServerSocket?.data.sessionConsumption?.liveSessionIds.has(session.id)).toBe(false));
            await settle();
            expect(accountChangeFrames.get(shared)! - beforeRevoke.get(shared)!).toBe(1);
            expect(accountChangeFrames.get(unrelated)! - beforeRevoke.get(unrelated)!).toBe(0);
            console.info("SESSION_ACCESS_CHANGE_ACCOUNT_FRAMES", JSON.stringify({
                owner: accountChangeFrames.get(reconnected)! - beforeRevoke.get(reconnected)!,
                viewer: accountChangeFrames.get(shared)! - beforeRevoke.get(shared)!,
                stranger: accountChangeFrames.get(unrelated)! - beforeRevoke.get(unrelated)!,
            }));
            const beforeAccessPush = new Map(accountChangeFrames);
            notifySessionHumanPresenceAccessChanged({ sessionId: session.id });
            // The real declaration ACK drains this socket's ordered consumption
            // lane after retirement; no arbitrary timing window is needed.
            await replace(shared, [], []);
            await settle();
            expect(accountChangeFrames).toEqual(beforeAccessPush);
            console.info("SESSION_ACCESS_PUSH_EXTRA_ACCOUNT_FRAMES", 0);
            const snapshotSizes: number[] = [];
            const readSnapshot = sqliteStorage.withSqliteReadSnapshot;
            // Observe the genuine database boundary without replacing a query,
            // admission decision or projection. Every finite event/declaration
            // owns one snapshot, which must already exclude revoked readers.
            const observeSnapshot = vi.spyOn(sqliteStorage, "withSqliteReadSnapshot")
                .mockImplementation(async function<T>(
                    read: (reader: sqliteStorage.TransactionClient) => Promise<T>,
                    options?: Readonly<{ deadlineAtMs?: number }>,
                ): Promise<T> {
                    return readSnapshot(async tx => {
                        const captured = await read(tx);
                        // Retain only admission cardinality: captured socket
                        // objects include credentials and must never enter diffs.
                        if (captured && typeof captured === "object" && "value" in captured
                            && Array.isArray(captured.value)) snapshotSizes.push(captured.value.length);
                        return captured;
                    }, options);
                });
            try {
                const refusedAtCapture = async (operation: () => Promise<unknown>) => {
                    snapshotSizes.length = 0;
                    await operation();
                    expect(snapshotSizes).toEqual([0]);
                };
                // Live segments reach UI consumers only through admitted live
                // demand, so a retired stream costs no per-delta decision.
                const refusedWithoutCapture = async (operation: () => Promise<unknown>) => {
                    snapshotSizes.length = 0;
                    await operation();
                    expect(snapshotSizes).toEqual([]);
                };
                for (const accountId of [viewer.id, stranger.id]) {
                    await refusedAtCapture(() => publish(accountId, true));
                    await refusedAtCapture(async () => eventRouter.emitUpdate({ userId: accountId, payload: metadataPayload,
                        recipientFilter: { type: "all-interested-in-session", sessionId: session.id } }));
                    for (const type of ["transcript-stream-segment", "transcript-stream-segment-delta"] as const) {
                        await refusedWithoutCapture(async () => eventRouter.emitEphemeral({ userId: accountId,
                            payload: { type, sessionId: session.id, message: { localId: "revoked-segment", tick: 3,
                                baseLength: 1, content: { t: "encrypted", c: "after-revoke" }, createdAt: 1, updatedAt: 2 } },
                            recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
                        }));
                    }
                }
                await settle();
                expect(updates.get(shared)).toHaveLength(1);
                expect(metadataUpdates.get(shared)).toEqual([recipientMetadataPayload]);
                expect(ticks.get(shared)).toEqual([]);
                expect(updates.get(unrelated)).toEqual([]);
                expect(metadataUpdates.get(unrelated)).toEqual([]);
                expect(ticks.get(unrelated)).toEqual([]);
                await refusedAtCapture(async () => {
                    expect(await replace(shared, [session.id], [session.id]))
                        .toEqual({ ok: true, v: 1, liveSessionIds: [], durableSessionIds: [] });
                });
                await refusedAtCapture(() => publish(viewer.id));
                await settle();
                expect(updates.get(shared)).toHaveLength(1);

                // The same guard must keep the authorized owner working.
                const ownerUpdates = updates.get(durable)!.length;
                const ownerSegments = ticks.get(runner)!.length;
                snapshotSizes.length = 0;
                expect(await replace(durable, [], [session.id]))
                    .toEqual({ ok: true, v: 1, liveSessionIds: [], durableSessionIds: [session.id] });
                expect(snapshotSizes).toEqual([1]);
                snapshotSizes.length = 0;
                await publish(owner.id, true);
                expect(snapshotSizes).toHaveLength(1);
                expect(snapshotSizes[0]).toBeGreaterThan(0);
                snapshotSizes.length = 0;
                await eventRouter.emitEphemeral({ userId: owner.id,
                    payload: { type: "transcript-stream-segment", sessionId: session.id,
                        message: { localId: "owner-after-revoke", tick: 3, baseLength: 1,
                            content: { t: "encrypted", c: "owner-still-authorized" }, createdAt: 1, updatedAt: 2 } },
                    recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
                });
                // A live segment shares no delivery snapshot: UI consumers go by
                // admitted demand and the runner by its own held decision.
                expect(snapshotSizes).toEqual([]);
                await settle();
                expect(updates.get(durable)).toHaveLength(ownerUpdates + 1);
                expect(updates.get(durable)!.at(-1)).toMatchObject({ body: { delivery: "full", message: { content: message.content } } });
                expect(ticks.get(runner)).toHaveLength(ownerSegments + 1);
                expect(shared.connected).toBe(true);
                expect(unrelated.connected).toBe(true);
            } finally {
                observeSnapshot.mockRestore();
            }
        } finally {
            clients.forEach(client => client.disconnect());
            eventRouter.clearIo();
            await io.close();
            await app.close();
        }
    }, 60_000);
});
