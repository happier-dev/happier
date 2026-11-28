import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { eventRouter } from "@/app/events/eventRouter";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import {
    enqueuePendingMessage,
    materializeNextPendingMessageForCurrentPublisher,
} from "@/app/session/pending/pendingMessageService";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";
import { authorizeSessionRelayPublish } from "./sessionRelayAuthCache";

import { sessionUpdateHandler } from "./sessionUpdateHandler";

describe("accepted Pending settlement publisher replacement race on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-accepted-settlement-publisher-race-",
            // These cases exhaust transaction acquisition by holding the pool's only connection.
            env: { HAPPIER_SQLITE_CONNECTION_LIMIT: "1" },
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    it.each([
        { v: 1 },
        { v: 2, outcome: "handed_off" },
    ])("fails closed for settlement $v when a successor commits before the settlement CAS", async (settlement) => {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `session-${randomUUID()}`,
                accountId: owner.id,
                metadata: "{}",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        const localId = `pending-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "ciphertext",
            requestedAction: { v: 1, kind: "enqueue" },
        });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { deliveryState: "delivering", providerAction: "send" },
        });

        let nowMs = new Date("2026-07-19T10:00:00.000Z").getTime();
        const presence = createSessionPublisherPresence({ now: () => new Date(nowMs++) });
        const predecessorSocket = createFakeSocket({
            id: "predecessor-socket",
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: session.id,
                    machineId,
                    proof: "machine-access-key",
                },
            },
        });
        const successorSocket = createFakeSocket({ id: "successor-socket" });
        const binding = { accountId: owner.id, machineId, sessionId: session.id };
        const registered = await presence.registerPublisher({
            socket: predecessorSocket,
            binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        expect(registered.status).toBe("registered");

        let replacementBaseline: { status: string; deliveryState: string | null; deliveryBlockedReason: string | null } | null = null;
        const racingPresence = {
            resolveCurrentPublisher: presence.resolveCurrentPublisher,
            runAsCurrentPublisher: async <T>(params: Parameters<typeof presence.runAsCurrentPublisher<T>>[0]) => (
                await presence.runAsCurrentPublisher({
                    ...params,
                    action: async (publisher) => {
                        const replacement = await presence.registerPublisher({
                            socket: successorSocket,
                            binding,
                            completeActivitySnapshot: { state: "active", activeCount: 1 },
                        });
                        expect(replacement.status).toBe("registered");
                        replacementBaseline = await db.sessionPendingMessage.findUniqueOrThrow({
                            where: { sessionId_localId: { sessionId: session.id, localId } },
                            select: { status: true, deliveryState: true, deliveryBlockedReason: true },
                        });
                        return await params.action(publisher);
                    },
                })
            ),
        };
        const connection = {
            connectionType: "session-scoped",
            socket: predecessorSocket,
            userId: owner.id,
            sessionId: session.id,
        } as any;
        sessionUpdateHandler(owner.id, predecessorSocket as any, connection, {
            presence: racingPresence,
            binding,
        });
        const callback = vi.fn();

        await getSocketHandler(predecessorSocket, "pending-delivery-accepted-v1")({
            ...settlement,
            sessionId: session.id,
            localId,
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: "forbidden" });
        expect(replacementBaseline).not.toBeNull();
        await expect(db.sessionPendingMessage.findUnique({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual(replacementBaseline);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("retires only the current publisher's exact provider claim on terminal handoff", async () => {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: { tag: `session-${randomUUID()}`, accountId: owner.id, metadata: "{}" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        const held = `held-${randomUUID()}`;
        const claimed = `claimed-${randomUUID()}`;
        for (const localId of [held, claimed]) {
            await expect(enqueuePendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                ciphertext: "ciphertext",
                requestedAction: { v: 1, kind: localId === held ? "enqueue" : "send_now" },
            })).resolves.toMatchObject({ ok: true });
        }
        const presence = createSessionPublisherPresence();
        const socket = createFakeSocket({
            id: "terminal-handoff-socket",
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: { sessionId: session.id, machineId, proof: "machine-access-key" },
            },
        });
        const binding = { accountId: owner.id, machineId, sessionId: session.id };
        await expect(presence.registerPublisher({
            socket,
            binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toMatchObject({ status: "registered" });
        const current = await presence.resolveCurrentPublisher({ socket, binding });
        if (current.status !== "current") throw new Error("expected current publisher");
        await expect(materializeNextPendingMessageForCurrentPublisher({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryTiming: "after_foreground_ready",
            foregroundState: "ready",
            trustedPublisherFence: { ...binding, committedFence: current.committedFence },
        })).resolves.toMatchObject({ ok: true, didMaterialize: true, message: { localId: claimed } });
        const connection = {
            connectionType: "session-scoped",
            socket: socket as unknown as Parameters<typeof sessionUpdateHandler>[1],
            userId: owner.id,
            sessionId: session.id,
        } as const;
        sessionUpdateHandler(owner.id, connection.socket, connection, { presence, binding });
        const handler = getSocketHandler(socket, "pending-delivery-accepted-v1");
        const settle = async (localId: string) => {
            const acknowledge = vi.fn();
            await handler({ v: 2, sessionId: session.id, localId, outcome: "handed_off" }, acknowledge);
            expect(acknowledge).toHaveBeenCalledTimes(1);
            return acknowledge.mock.calls[0]?.[0];
        };

        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { seq: true, pendingVersion: true },
        });
        eventRouter.addConnection(owner.id, connection);
        try {
            await expect(settle(held)).resolves.toEqual({ ok: false, error: "not-materialized" });
            await db.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId: session.id, localId: held } },
                data: { deliveryState: "delivering" },
            });
            await expect(settle(held)).resolves.toEqual({ ok: false, error: "not-materialized" });
            await db.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId: session.id, localId: held } },
                data: { deliveryState: null },
            });

            const responses = await Promise.all([settle(claimed), settle(claimed)]);
            const finalState = { ok: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: before.pendingVersion + 1 };
            expect(responses).toEqual([
                { ...finalState, didResolve: true },
                { ...finalState, didResolve: false },
            ]);
            await expect(settle(claimed)).resolves.toEqual({ ...finalState, didResolve: false });
            expect(socket.emit.mock.calls.filter(([name]) => name === "update")).toEqual([[
                "update",
                expect.objectContaining({
                    body: expect.objectContaining({
                        t: "pending-changed",
                        sessionId: session.id,
                        pendingCount: finalState.pendingCount,
                        pendingVersion: finalState.pendingVersion,
                    }),
                }),
            ]]);
        } finally {
            eventRouter.removeConnection(owner.id, connection);
        }

        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id },
            select: { localId: true, status: true },
        })).resolves.toEqual([{ localId: held, status: "queued" }]);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { seq: true, pendingCount: true, pendingVersion: true, pendingActivationRequestId: true },
        })).resolves.toEqual({
            seq: before.seq,
            pendingCount: 1,
            pendingVersion: before.pendingVersion + 1,
            pendingActivationRequestId: null,
        });
    });

    it("returns typed overload without killing the socket event loop when publisher authority cannot acquire a transaction", async () => {
        harness.resetEnv({
            HAPPIER_DB_TX_MAX_RETRIES: "0",
            HAPPIER_DB_TX_MAX_WAIT_MS: "1000",
            HAPPIER_DB_TX_TIMEOUT_MS: "30000",
        });
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `session-${randomUUID()}`,
                accountId: owner.id,
                metadata: "{}",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        const localId = `pending-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "ciphertext",
            requestedAction: { v: 1, kind: "enqueue" },
        });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { deliveryState: "delivering", providerAction: "send" },
        });

        const presence = createSessionPublisherPresence();
        const socket = createFakeSocket({
            id: "transaction-unavailable-socket",
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: session.id,
                    machineId,
                    proof: "machine-access-key",
                },
            },
        });
        const binding = { accountId: owner.id, machineId, sessionId: session.id };
        await expect(presence.registerPublisher({
            socket,
            binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toMatchObject({ status: "registered" });
        const connection = {
            connectionType: "session-scoped",
            socket,
            userId: owner.id,
            sessionId: session.id,
        } as any;
        await expect(authorizeSessionRelayPublish({
            socket: socket as any,
            connection,
            userId: owner.id,
            sessionId: session.id,
        })).resolves.toContain(owner.id);
        sessionUpdateHandler(owner.id, socket as any, connection, { presence, binding });
        const handler = getSocketHandler(socket, "pending-delivery-accepted-v1");
        const pendingBaseline = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true },
        });

        let markHolderEntered!: () => void;
        const holderEntered = new Promise<void>((resolve) => { markHolderEntered = resolve; });
        let releaseHolder!: () => void;
        const holderRelease = new Promise<void>((resolve) => { releaseHolder = resolve; });
        const holder = inTx(async () => {
            markHolderEntered();
            await holderRelease;
        });
        await holderEntered;

        const overloadedAck = vi.fn();
        try {
            await expect(handler({ v: 1, sessionId: session.id, localId }, overloadedAck)).resolves.toBeUndefined();
            expect(overloadedAck).toHaveBeenCalledTimes(1);
            expect(overloadedAck).toHaveBeenCalledWith({
                ok: false,
                error: "transaction-unavailable",
                retryAfterMs: 1_000,
            });
        } finally {
            releaseHolder();
            await holder;
        }

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true },
        })).resolves.toEqual(pendingBaseline);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);

        const recoveredAck = vi.fn();
        await expect(handler({ v: 1, sessionId: session.id, localId }, recoveredAck)).resolves.toBeUndefined();
        expect(recoveredAck).toHaveBeenCalledTimes(1);
        expect(recoveredAck).toHaveBeenCalledWith(expect.objectContaining({ ok: true, didResolve: true }));
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
    });
});
