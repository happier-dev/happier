import { randomUUID } from "node:crypto";

import {
    makeExternalSessionHistoricalImportBatchIdV1,
    UsageAnalyticsQueryRequestSchema,
} from "@happier-dev/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeExternalSessionHistoricalImportCommand } from "@/app/session/externalSessionHistoricalImportCommand";
import {
    buildSessionMessagePublicationWhere,
    isSessionTranscriptShareable,
    loadSessionTranscriptPublication,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import { createSessionMessageFromPending } from "@/app/session/pending/pendingMessageTranscriptCommit";
import {
    writeHistoricalSessionMessageBatch,
    writeHistoricalSessionMessageBatchInTx,
} from "@/app/session/sessionTranscriptWrite";
import { createSessionMessage } from "@/app/session/sessionWriteService";
import { loadUsageMessageStatsForQuery } from "@/app/usage/query/loadUsageMessageStatsForQuery";
import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";

function resolveContractProvider(): "postgres" | "mysql" {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .toString()
        .trim()
        .toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported contract provider: ${raw}`);
}

describe("historical transcript writer database contract", () => {
    const provider = resolveContractProvider();
    let connected = false;
    let previousStoragePolicy: string | undefined;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
        previousStoragePolicy = process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (previousStoragePolicy === undefined) {
            delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        } else {
            process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = previousStoragePolicy;
        }
        if (connected) await db.$disconnect();
    });

    it("keeps historical, Pending, and ordinary writes gapless across retry, rollback, and mode rejection", async () => {
        const account = await db.account.create({
            data: { publicKey: `c1-db-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-db-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "machine_only",
            },
            select: { id: true },
        });
        const items = Array.from({ length: 12 }, (_, index) => ({
            localId: `history:${index}`,
            sidechainId: null,
            messageRole: index % 2 === 0 ? "user" as const : "agent" as const,
            content: { t: "plain" as const, v: { index } },
        }));
        const write = async () => await writeHistoricalSessionMessageBatch({
            sessionId: session.id,
            storagePolicy: "optional",
            items,
        });

        const [left, right] = await Promise.all([write(), write()]);
        expect(left.ok && right.ok).toBe(true);
        expect([left, right].filter((result) => result.ok && result.didWrite)).toHaveLength(1);

        await db.session.update({
            where: { id: session.id },
            data: { currentStorageState: "hosted" },
        });

        const [pending, ordinary] = await Promise.all([
            inTx(async (tx) => await createSessionMessageFromPending(tx, {
                sessionId: session.id,
                sessionEncryptionMode: "plain",
                storagePolicy: "optional",
                localId: "pending:item",
                messageRole: "agent",
                content: { t: "plain", v: { text: "pending" } },
            })),
            createSessionMessage({
                actorUserId: account.id,
                sessionId: session.id,
                localId: "ordinary:item",
                messageRole: "user",
                content: { t: "plain", v: { text: "ordinary" } },
            }),
        ]);
        expect(pending).toMatchObject({ ok: true, didWrite: true });
        expect(ordinary).toMatchObject({ ok: true, didWrite: true });

        await db.session.update({
            where: { id: session.id },
            data: { currentStorageState: "machine_only" },
        });

        await expect(inTx(async (tx) => {
            const rolledBack = await writeHistoricalSessionMessageBatchInTx(tx, {
                sessionId: session.id,
                storagePolicy: "optional",
                items: [{
                    localId: "history:rolled-back",
                    sidechainId: null,
                    messageRole: "user",
                    content: { t: "plain", v: { text: "rollback" } },
                }],
            });
            expect(rolledBack).toMatchObject({ ok: true, didWrite: true });
            throw new Error("rollback db-contract historical batch");
        })).rejects.toThrow("rollback db-contract historical batch");

        await expect(writeHistoricalSessionMessageBatch({
            sessionId: session.id,
            storagePolicy: "optional",
            items: [{
                localId: "history:mode-conflict",
                sidechainId: null,
                messageRole: "user",
                content: { t: "encrypted", c: "ciphertext" },
            }],
        })).resolves.toEqual({
            ok: false,
            error: "storage-mode-conflict",
            code: "session_encryption_mode_mismatch",
        });

        const rows = await db.sessionMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { seq: "asc" },
            select: { seq: true, localId: true },
        });
        expect(rows.map((row) => row.seq)).toEqual(
            Array.from({ length: items.length + 2 }, (_, index) => index + 1),
        );
        expect(rows.map((row) => row.localId)).toEqual(expect.arrayContaining([
            ...items.map((item) => item.localId),
            "pending:item",
            "ordinary:item",
        ]));
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { seq: true } }))
            .toEqual({ seq: items.length + 2 });
    });

    it.each(["machine_only", "server_partial", "snapshot_complete"] as const)(
        "rejects ordinary and Pending transcript writes while %s owns transcript storage",
        async (currentStorageState) => {
            const account = await db.account.create({
                data: { publicKey: `c1-db-storage-authority-${currentStorageState}-${randomUUID()}` },
                select: { id: true },
            });
            const session = await db.session.create({
                data: {
                    tag: `c1-db-storage-authority-${currentStorageState}-${randomUUID()}`,
                    accountId: account.id,
                    metadata: "metadata",
                    encryptionMode: "plain",
                    currentStorageState,
                },
                select: { id: true },
            });

            await expect(createSessionMessage({
                actorUserId: account.id,
                sessionId: session.id,
                localId: `ordinary:${currentStorageState}`,
                messageRole: "user",
                content: { t: "plain", v: { text: "ordinary" } },
            })).resolves.toEqual({
                ok: false,
                error: "invalid-params",
                code: "session_storage_authority_mismatch",
            });
            await expect(inTx(async (tx) => await createSessionMessageFromPending(tx, {
                sessionId: session.id,
                sessionEncryptionMode: "plain",
                storagePolicy: "optional",
                localId: `pending:${currentStorageState}`,
                messageRole: "agent",
                content: { t: "plain", v: { text: "pending" } },
            }))).resolves.toEqual({
                ok: false,
                error: "storage-mode-conflict",
                code: "session_storage_authority_mismatch",
            });
            await expect(db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: { seq: true },
            })).resolves.toEqual({ seq: 0 });
            await expect(db.sessionMessage.count({
                where: { sessionId: session.id },
            })).resolves.toBe(0);
        },
    );

    it("converges begin and batch retries, then publishes one immutable sequence ceiling", async () => {
        const account = await db.account.create({
            data: { publicKey: `c1-operation-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-operation-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "machine_only",
            },
            select: { id: true },
        });
        const claim = {
            sessionId: session.id,
            operationId: `operation-${randomUUID()}`,
            operationClaimId: `claim-${randomUUID()}`,
        } as const;
        const execute = async (command: unknown) => await executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-db-contract",
            command,
            limits: { maxItems: 200, maxSerializedBytes: 512 * 1024 },
        });
        const begin = {
            v: 1 as const,
            kind: "begin" as const,
            claim,
            expectedRevision: 0,
            expectedPriorStableStorage: { state: "machine_only" as const },
        };

        const beginResults = await Promise.all([execute(begin), execute(begin)]);
        expect(beginResults).toEqual([
            expect.objectContaining({ kind: "ready", claim, revision: 0 }),
            expect.objectContaining({ kind: "ready", claim, revision: 0 }),
        ]);

        const batch = {
            v: 1 as const,
            kind: "batch" as const,
            claim,
            expectedRevision: 0,
            batchId: makeExternalSessionHistoricalImportBatchIdV1([
                "history:published",
            ]),
            items: [{
                localId: "history:published",
                sidechainId: null,
                messageRole: "user" as const,
                content: { t: "plain" as const, v: { text: "published" } },
            }],
        };
        const batchResults = await Promise.all([execute(batch), execute(batch)]);
        expect(batchResults).toEqual([
            expect.objectContaining({
                kind: "batch_accepted",
                batchId: batch.batchId,
                acceptedThroughServerSeq: 1,
            }),
            expect.objectContaining({
                kind: "batch_accepted",
                batchId: batch.batchId,
                acceptedThroughServerSeq: 1,
            }),
        ]);

        const privateTail = await writeHistoricalSessionMessageBatch({
            sessionId: session.id,
            storagePolicy: "optional",
            items: [{
                localId: "history:not-published",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "plain", v: { text: "not published" } },
            }],
        });
        expect(privateTail).toMatchObject({ ok: true, didWrite: true, firstSeq: 2, lastSeq: 2 });

        const readVisibleRows = async () => {
            const publication = await loadSessionTranscriptPublication(db, session.id);
            return await db.sessionMessage.findMany({
                where: buildSessionMessagePublicationWhere({
                    where: { sessionId: session.id },
                    publication,
                }),
                orderBy: { seq: "asc" },
                select: { seq: true, localId: true },
            });
        };
        await expect(readVisibleRows()).resolves.toEqual([
            { seq: 1, localId: "history:published" },
        ]);
        await expect(loadUsageMessageStatsForQuery(
            account.id,
            UsageAnalyticsQueryRequestSchema.parse({}),
            [session.id],
        )).resolves.toEqual({ messageCount: 1 });

        const finalize = {
            v: 1 as const,
            kind: "finalize" as const,
            claim,
            expectedRevision: 0,
            expectedAcceptedThroughServerSeq: 1,
        };
        await expect(execute(finalize)).resolves.toMatchObject({
            kind: "finalized",
            claim,
            acceptedThroughServerSeq: 1,
        });
        await expect(execute(finalize)).resolves.toMatchObject({
            kind: "finalized",
            claim,
            acceptedThroughServerSeq: 1,
        });

        const published = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                currentStorageState: true,
                acceptedThroughServerSeq: true,
                materializationPublicationId: true,
                materializedThroughSourceAt: true,
                publishedThroughServerSeq: true,
                seq: true,
            },
        });
        expect(published).toMatchObject({
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: 1,
            seq: 2,
        });
        expect(published.materializationPublicationId).toEqual(expect.any(String));
        expect(published.materializedThroughSourceAt).not.toBeNull();
        expect(isSessionTranscriptShareable(published)).toBe(true);
        await expect(readVisibleRows()).resolves.toEqual([
            { seq: 1, localId: "history:published" },
        ]);
        await expect(loadUsageMessageStatsForQuery(
            account.id,
            UsageAnalyticsQueryRequestSchema.parse({}),
            [session.id],
        )).resolves.toEqual({ messageCount: 1 });
    });

    it("discards only exact unpublished job rows and converges repeated discard", async () => {
        const account = await db.account.create({
            data: { publicKey: `c1-discard-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-discard-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "machine_only",
            },
            select: { id: true },
        });
        const claim = {
            sessionId: session.id,
            operationId: `operation-${randomUUID()}`,
            operationClaimId: `claim-${randomUUID()}`,
        } as const;
        const execute = async (command: unknown) => await executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-db-contract-discard",
            command,
            limits: { maxItems: 200, maxSerializedBytes: 512 * 1024 },
        });

        await expect(execute({
            v: 1,
            kind: "begin",
            claim,
            expectedRevision: 0,
            expectedPriorStableStorage: { state: "machine_only" },
        })).resolves.toMatchObject({ kind: "ready" });
        await expect(execute({
            v: 1,
            kind: "batch",
            claim,
            expectedRevision: 0,
            batchId: makeExternalSessionHistoricalImportBatchIdV1([
                "history:discard-owned",
            ]),
            items: [{
                localId: "history:discard-owned",
                sidechainId: null,
                messageRole: "user",
                content: { t: "plain", v: { text: "discard" } },
            }],
        })).resolves.toMatchObject({
            kind: "batch_accepted",
            acceptedThroughServerSeq: 1,
        });
        await expect(writeHistoricalSessionMessageBatch({
            sessionId: session.id,
            storagePolicy: "optional",
            items: [{
                localId: "history:other-owner",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "plain", v: { text: "keep" } },
            }],
        })).resolves.toMatchObject({ ok: true, didWrite: true, firstSeq: 2, lastSeq: 2 });

        const discard = {
            v: 1 as const,
            kind: "discard" as const,
            claim,
            expectedRevision: 0,
        };
        await expect(execute(discard)).resolves.toMatchObject({
            kind: "discarded",
            claim,
        });
        await expect(execute(discard)).resolves.toMatchObject({
            kind: "discarded",
            claim,
        });

        await expect(db.sessionMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { seq: "asc" },
            select: { seq: true, localId: true },
        })).resolves.toEqual([
            { seq: 2, localId: "history:other-owner" },
        ]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                seq: true,
                currentStorageState: true,
                acceptedThroughServerSeq: true,
                materializationPublicationId: true,
                publishedThroughServerSeq: true,
            },
        })).resolves.toEqual({
            seq: 2,
            currentStorageState: "machine_only",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            publishedThroughServerSeq: null,
        });
    });
});
