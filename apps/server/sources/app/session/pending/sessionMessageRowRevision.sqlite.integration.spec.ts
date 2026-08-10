import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createSessionMessage } from "../sessionWriteService";
import { createSessionMessageFromPending } from "./pendingMessageTranscriptCommit";

const observationProvenance = { kind: "non_dependent", source: "external" } as const;

describe("SessionMessage row revision (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-message-row-revision-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 180_000);

    afterEach(async () => {
        harness.resetEnv();
        await db.sessionMessage.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => await harness.close());

    async function seed() {
        const account = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: `tag-${randomUUID()}`,
                metadata: "{}",
            },
            select: { id: true },
        });
        return { actorUserId: account.id, sessionId: session.id };
    }

    async function writeObservedMessage(params: Readonly<{
        actorUserId: string;
        sessionId: string;
        localId: string;
        ciphertext: string;
        sourceUpdatedAt: number;
    }>) {
        return await createSessionMessage({
            actorUserId: params.actorUserId,
            sessionId: params.sessionId,
            localId: params.localId,
            ciphertext: params.ciphertext,
            trustedSourceTimestamps: {
                createdAt: 1_700_000_000_000,
                updatedAt: params.sourceUpdatedAt,
            },
            trustedTranscriptObservationProvenance: observationProvenance,
        });
    }

    async function readRevision(sessionId: string, localId: string) {
        return await db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId, localId } },
            select: { rowRevision: true, sourceUpdatedAt: true },
        });
    }

    it("starts at zero and gives distinct revisions to two mutations with the same source millisecond", async () => {
        const { actorUserId, sessionId } = await seed();
        const localId = `observed-${randomUUID()}`;

        await expect(writeObservedMessage({
            actorUserId,
            sessionId,
            localId,
            ciphertext: "cipher-initial",
            sourceUpdatedAt: 1_700_000_000_000,
        })).resolves.toMatchObject({ ok: true, didWrite: true });
        await expect(readRevision(sessionId, localId)).resolves.toEqual({
            rowRevision: 0n,
            sourceUpdatedAt: new Date(1_700_000_000_000),
        });

        await expect(writeObservedMessage({
            actorUserId,
            sessionId,
            localId,
            ciphertext: "cipher-initial",
            sourceUpdatedAt: 1_700_000_000_001,
        })).resolves.toMatchObject({ ok: true, didUpdate: false });
        const metadataMutation = await readRevision(sessionId, localId);

        await expect(writeObservedMessage({
            actorUserId,
            sessionId,
            localId,
            ciphertext: "cipher-changed",
            sourceUpdatedAt: 1_700_000_000_001,
        })).resolves.toMatchObject({ ok: true, didUpdate: true });
        const contentMutation = await readRevision(sessionId, localId);

        expect(metadataMutation).toEqual({
            rowRevision: 1n,
            sourceUpdatedAt: new Date(1_700_000_000_001),
        });
        expect(contentMutation).toEqual({
            rowRevision: 2n,
            sourceUpdatedAt: new Date(1_700_000_000_001),
        });
    });

    it("does not advance for no-op or losing updates", async () => {
        const { actorUserId, sessionId } = await seed();
        const localId = `no-op-${randomUUID()}`;

        await writeObservedMessage({
            actorUserId,
            sessionId,
            localId,
            ciphertext: "cipher-initial",
            sourceUpdatedAt: 1_700_000_000_000,
        });
        await writeObservedMessage({
            actorUserId,
            sessionId,
            localId,
            ciphertext: "cipher-initial",
            sourceUpdatedAt: 1_700_000_000_001,
        });

        await expect(writeObservedMessage({
            actorUserId,
            sessionId,
            localId,
            ciphertext: "cipher-initial",
            sourceUpdatedAt: 1_700_000_000_001,
        })).resolves.toMatchObject({ ok: true, didUpdate: false });
        await expect(writeObservedMessage({
            actorUserId,
            sessionId,
            localId,
            ciphertext: "cipher-stale",
            sourceUpdatedAt: 1_700_000_000_000,
        })).resolves.toEqual({ ok: false, error: "invalid-params" });
        await expect(readRevision(sessionId, localId)).resolves.toEqual({
            rowRevision: 1n,
            sourceUpdatedAt: new Date(1_700_000_000_001),
        });
    });

    it("increments the pending role-backfill writer exactly once and rolls it back with its transaction", async () => {
        const { sessionId } = await seed();
        const localId = `pending-${randomUUID()}`;
        const content = { t: "encrypted", c: "cipher-pending" } as const;

        await inTx(async (tx) => await createSessionMessageFromPending(tx, {
            sessionId,
            localId,
            content,
            messageRole: null,
        }));
        await expect(readRevision(sessionId, localId)).resolves.toMatchObject({ rowRevision: 0n });

        await expect(inTx(async (tx) => {
            const roleBackfill = await createSessionMessageFromPending(tx, {
                sessionId,
                localId,
                content,
                messageRole: "user",
            });
            expect(roleBackfill).toMatchObject({ ok: true, didUpdate: true });
            throw new Error("test rollback");
        })).rejects.toThrow("test rollback");
        await expect(readRevision(sessionId, localId)).resolves.toMatchObject({ rowRevision: 0n });

        await expect(inTx(async (tx) => await createSessionMessageFromPending(tx, {
            sessionId,
            localId,
            content,
            messageRole: "user",
        }))).resolves.toMatchObject({ ok: true, didUpdate: true });
        await expect(readRevision(sessionId, localId)).resolves.toMatchObject({ rowRevision: 1n });
    });

    it("preserves two atomic increments for concurrent committed content updates", async () => {
        const { actorUserId, sessionId } = await seed();
        const localId = `concurrent-${randomUUID()}`;

        await writeObservedMessage({
            actorUserId,
            sessionId,
            localId,
            ciphertext: "cipher-initial",
            sourceUpdatedAt: 1_700_000_000_000,
        });

        const results = await Promise.all([
            writeObservedMessage({
                actorUserId,
                sessionId,
                localId,
                ciphertext: "cipher-first",
                sourceUpdatedAt: 1_700_000_000_001,
            }),
            writeObservedMessage({
                actorUserId,
                sessionId,
                localId,
                ciphertext: "cipher-second",
                sourceUpdatedAt: 1_700_000_000_001,
            }),
        ]);

        expect(results).toEqual([
            expect.objectContaining({ ok: true, didUpdate: true }),
            expect.objectContaining({ ok: true, didUpdate: true }),
        ]);
        await expect(readRevision(sessionId, localId)).resolves.toMatchObject({ rowRevision: 2n });
    });
});
