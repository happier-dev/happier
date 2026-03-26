import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import {
    deletePendingMessage,
    discardPendingMessage,
    enqueuePendingMessage,
    listPendingMessages,
    materializeNextPendingMessage,
    reorderPendingMessages,
    restorePendingMessage,
    updatePendingMessage,
} from "./pendingMessageService";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("pendingMessageService (shared sessions)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-pending-shared-",
            initAuth: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    const createAccount = async (kind: string) => {
        return db.account.create({
            data: { publicKey: `pk-${kind}-${randomUUID()}` },
            select: { id: true },
        });
    };

    const createSession = async <TSelect extends Prisma.SessionSelect>(
        ownerId: string,
        select: TSelect = { id: true } as TSelect,
    ): Promise<Prisma.SessionGetPayload<{ select: TSelect }>> => {
        return db.session.create({
            data: {
                tag: `tag-${randomUUID()}`,
                accountId: ownerId,
                metadata: "meta",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select,
        });
    };

    const shareSession = async (params: {
        sessionId: string;
        ownerId: string;
        participantId: string;
        accessLevel: "edit" | "view";
    }) => {
        return db.sessionShare.create({
            data: {
                sessionId: params.sessionId,
                sharedByUserId: params.ownerId,
                sharedWithUserId: params.participantId,
                accessLevel: params.accessLevel,
                canApprovePermissions: false,
                encryptedDataKey: Buffer.from([0, ...new Array(80).fill(1)]),
            },
            select: { id: true },
        });
    };

    it("allows shared edit participants to edit/reorder/discard/restore pending (queue is session-global)", async () => {
        const owner = await createAccount("owner");
        const collaborator = await createAccount("collab");
        const session = await createSession(owner.id);

        await shareSession({
            sessionId: session.id,
            ownerId: owner.id,
            participantId: collaborator.id,
            accessLevel: "edit",
        });

        const localIdA = `a-${randomUUID()}`;
        const localIdB = `b-${randomUUID()}`;
        const localIdC = `c-${randomUUID()}`;

        const enqueueA = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: localIdA,
            ciphertext: "cipher-a-1",
        });
        expect(enqueueA.ok).toBe(true);

        const enqueueB = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: localIdB,
            ciphertext: "cipher-b-1",
        });
        expect(enqueueB.ok).toBe(true);

        const enqueueC = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: localIdC,
            ciphertext: "cipher-c-1",
        });
        expect(enqueueC.ok).toBe(true);

        const editA = await updatePendingMessage({
            actorUserId: collaborator.id,
            sessionId: session.id,
            localId: localIdA,
            ciphertext: "cipher-a-2",
        });
        expect(editA.ok).toBe(true);

        const reorder1 = await reorderPendingMessages({
            actorUserId: collaborator.id,
            sessionId: session.id,
            orderedLocalIds: [localIdB, localIdC, localIdA],
        });
        expect(reorder1.ok).toBe(true);

        const discardC = await discardPendingMessage({
            actorUserId: collaborator.id,
            sessionId: session.id,
            localId: localIdC,
            reason: "test",
        });
        expect(discardC.ok).toBe(true);

        const restoreC = await restorePendingMessage({
            actorUserId: collaborator.id,
            sessionId: session.id,
            localId: localIdC,
        });
        expect(restoreC.ok).toBe(true);

        const reorder2 = await reorderPendingMessages({
            actorUserId: collaborator.id,
            sessionId: session.id,
            orderedLocalIds: [localIdB, localIdC, localIdA],
        });
        expect(reorder2.ok).toBe(true);

        const listQueued = await listPendingMessages({
            actorUserId: collaborator.id,
            sessionId: session.id,
            includeDiscarded: false,
        });
        expect(listQueued.ok).toBe(true);
        if (!listQueued.ok) throw new Error("unexpected list failure");
        expect(listQueued.pending.map((p) => p.localId)).toEqual([localIdB, localIdC, localIdA]);

        // Owner materializes into transcript; edits + order must be preserved.
        const materializedLocalIds: string[] = [];
        for (;;) {
            const res = await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id });
            expect(res.ok).toBe(true);
            if (!res.ok) throw new Error("unexpected materialize failure");
            if (!res.didMaterialize) break;
            materializedLocalIds.push(res.message.localId ?? "");
        }
        expect(materializedLocalIds).toEqual([localIdB, localIdC, localIdA]);

        const messages = await db.sessionMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { seq: "asc" },
            select: { localId: true, content: true },
        });
        expect(messages.map((m) => m.localId)).toEqual([localIdB, localIdC, localIdA]);
        const aMsg = messages.find((m) => m.localId === localIdA);
        expect((aMsg?.content as any)?.c).toBe("cipher-a-2");
    });

    it("keeps newly queued messages after pre-existing queued rows when the queue counter lags behind", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);

        const localIdA = `seed-a-${randomUUID()}`;
        const localIdB = `seed-b-${randomUUID()}`;
        const localIdC = `new-c-${randomUUID()}`;

        await db.sessionPendingMessage.create({
            data: {
                sessionId: session.id,
                localId: localIdA,
                content: { t: "encrypted", c: "cipher-seed-a" },
                status: "queued",
                position: 5,
                authorAccountId: owner.id,
            },
        });
        await db.sessionPendingMessage.create({
            data: {
                sessionId: session.id,
                localId: localIdB,
                content: { t: "encrypted", c: "cipher-seed-b" },
                status: "queued",
                position: 6,
                authorAccountId: owner.id,
            },
        });
        await db.session.update({
            where: { id: session.id },
            data: { pendingQueueSeq: 0 },
        });

        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: localIdC,
            ciphertext: "cipher-new-c",
        });
        expect(enqueue.ok).toBe(true);
        if (!enqueue.ok) throw new Error("expected enqueue to succeed");
        expect(enqueue.pending.position).toBe(7);

        const listQueued = await listPendingMessages({
            actorUserId: owner.id,
            sessionId: session.id,
            includeDiscarded: false,
        });
        expect(listQueued.ok).toBe(true);
        if (!listQueued.ok) throw new Error("unexpected list failure");
        expect(listQueued.pending.map((p) => p.localId)).toEqual([localIdA, localIdB, localIdC]);
        expect(listQueued.pending.map((p) => p.position)).toEqual([5, 6, 7]);
    });

    it("forbids non-owner participants from materializing pending", async () => {
        const owner = await createAccount("owner");
        const collaborator = await createAccount("collab");
        const session = await createSession(owner.id);

        await shareSession({
            sessionId: session.id,
            ownerId: owner.id,
            participantId: collaborator.id,
            accessLevel: "edit",
        });

        const localId = `a-${randomUUID()}`;
        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-1",
        });
        expect(enqueue.ok).toBe(true);

        const materialize = await materializeNextPendingMessage({ actorUserId: collaborator.id, sessionId: session.id });
        expect(materialize.ok).toBe(false);
        if (materialize.ok) throw new Error("expected forbidden");
        expect(materialize.error).toBe("forbidden");
    });

    it("does not decrement pendingCount below 0 when session state is inconsistent", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id, { id: true, pendingVersion: true });

        const localId = `a-${randomUUID()}`;
        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-1",
        });
        expect(enqueue.ok).toBe(true);

        // Simulate a race or data inconsistency where pendingCount is already 0.
        await db.session.update({ where: { id: session.id }, data: { pendingCount: 0 } });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingVersion: true },
        });

        const materialize = await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok) throw new Error("unexpected materialize failure");
        expect(materialize.didMaterialize).toBe(true);

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingVersion: true },
        });
        expect(after.pendingCount).toBe(0);
        expect(after.pendingVersion).toBe(before.pendingVersion + 1);
    });

    it("forbids view-only participants from mutating pending (but allows listing)", async () => {
        const owner = await createAccount("owner");
        const viewer = await createAccount("viewer");
        const session = await createSession(owner.id);

        await shareSession({
            sessionId: session.id,
            ownerId: owner.id,
            participantId: viewer.id,
            accessLevel: "view",
        });

        const localId = `a-${randomUUID()}`;
        const enqueueOwner = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-1",
        });
        expect(enqueueOwner.ok).toBe(true);

        const list = await listPendingMessages({ actorUserId: viewer.id, sessionId: session.id, includeDiscarded: true });
        expect(list.ok).toBe(true);

        const enqueueViewer = await enqueuePendingMessage({
            actorUserId: viewer.id,
            sessionId: session.id,
            localId: `v-${randomUUID()}`,
            ciphertext: "cipher-view",
        });
        expect(enqueueViewer.ok).toBe(false);
        if (enqueueViewer.ok) throw new Error("expected forbidden");
        expect(enqueueViewer.error).toBe("forbidden");

        const edit = await updatePendingMessage({
            actorUserId: viewer.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-2",
        });
        expect(edit.ok).toBe(false);
        if (edit.ok) throw new Error("expected forbidden");
        expect(edit.error).toBe("forbidden");

        const reorder = await reorderPendingMessages({ actorUserId: viewer.id, sessionId: session.id, orderedLocalIds: [localId] });
        expect(reorder.ok).toBe(false);
        if (reorder.ok) throw new Error("expected forbidden");
        expect(reorder.error).toBe("forbidden");

        const discard = await discardPendingMessage({ actorUserId: viewer.id, sessionId: session.id, localId, reason: "test" });
        expect(discard.ok).toBe(false);
        if (discard.ok) throw new Error("expected forbidden");
        expect(discard.error).toBe("forbidden");

        const restore = await restorePendingMessage({ actorUserId: viewer.id, sessionId: session.id, localId });
        expect(restore.ok).toBe(false);
        if (restore.ok) throw new Error("expected forbidden");
        expect(restore.error).toBe("forbidden");

        const del = await deletePendingMessage({ actorUserId: viewer.id, sessionId: session.id, localId });
        expect(del.ok).toBe(false);
        if (del.ok) throw new Error("expected forbidden");
        expect(del.error).toBe("forbidden");
    });

    it("treats deletePendingMessage as a no-op when the localId does not exist", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id, { id: true, pendingVersion: true, pendingCount: true });

        const localId = `missing-${randomUUID()}`;
        const res = await deletePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error("expected ok");
        expect(res.pendingVersion).toBe(session.pendingVersion);
        expect(res.pendingCount).toBe(session.pendingCount);
        expect(res.participantCursors).toEqual([]);

        const after = await db.session.findUnique({
            where: { id: session.id },
            select: { pendingVersion: true, pendingCount: true },
        });
        expect(after?.pendingVersion).toBe(session.pendingVersion);
        expect(after?.pendingCount).toBe(session.pendingCount);
    });

    it("treats discardPendingMessage as a no-op when message is already discarded", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);

        const localId = `a-${randomUUID()}`;
        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-1",
        });
        expect(enqueue.ok).toBe(true);
        if (!enqueue.ok) throw new Error("expected enqueue to succeed");

        const firstDiscard = await discardPendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, reason: "test" });
        expect(firstDiscard.ok).toBe(true);
        if (!firstDiscard.ok) throw new Error("expected first discard to succeed");

        const beforeSecondDiscard = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingVersion: true, pendingCount: true },
        });

        const secondDiscard = await discardPendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, reason: "test-2" });
        expect(secondDiscard.ok).toBe(true);
        if (!secondDiscard.ok) throw new Error("expected second discard to succeed");
        expect(secondDiscard.pendingVersion).toBe(beforeSecondDiscard.pendingVersion);
        expect(secondDiscard.pendingCount).toBe(beforeSecondDiscard.pendingCount);
        expect(secondDiscard.participantCursors).toEqual([]);

        const afterSecondDiscard = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingVersion: true, pendingCount: true },
        });
        expect(afterSecondDiscard.pendingVersion).toBe(beforeSecondDiscard.pendingVersion);
        expect(afterSecondDiscard.pendingCount).toBe(beforeSecondDiscard.pendingCount);
    });

    it("treats non-participants as session-not-found", async () => {
        const owner = await createAccount("owner");
        const stranger = await createAccount("stranger");
        const session = await createSession(owner.id);

        const list = await listPendingMessages({ actorUserId: stranger.id, sessionId: session.id, includeDiscarded: true });
        expect(list.ok).toBe(false);
        if (list.ok) throw new Error("expected session-not-found");
        expect(list.error).toBe("session-not-found");
    });
});
