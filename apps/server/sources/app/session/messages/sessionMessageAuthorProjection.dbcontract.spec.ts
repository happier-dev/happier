import { randomUUID } from "node:crypto";

import { createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } from "@happier-dev/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { backfillSessionMessageAuthorProjection } from "@/app/session/messages/backfillSessionMessageAuthorProjection";
import { db, initDbMysql, initDbPostgres, requireDbProviderFromEnv, shutdownDbClient } from "@/storage/db";

describe("Session message author provider contract", () => {
    let connected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("The disposable DB-contract DATABASE_URL is required");
        const provider = requireDbProviderFromEnv(process.env, "postgres");
        if (provider === "mysql") await initDbMysql();
        else if (provider === "postgres") initDbPostgres();
        else throw new Error("This DB-contract lane requires postgres or mysql; SQLite has its own integration suite");
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (connected) await shutdownDbClient();
    });

    it("backfills exact receipts, audits contradictions, and preserves history after Account deletion", async () => {
        const accounts = await Promise.all(["owner", "author"].map((role) => db.account.create({
            data: { publicKey: `author-contract-${role}-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        })));
        const ownerId = accounts[0]!.id;
        const authorId = accounts[1]!.id;
        const sessionIds: string[] = [];
        try {
            for (let index = 0; index < 2; index += 1) {
                const session = await db.session.create({
                    data: {
                        accountId: ownerId,
                        tag: `author-contract-${randomUUID()}`,
                        encryptionMode: "plain",
                        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: {} })),
                        metadataLayoutVersion: 1,
                        ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 })),
                    },
                    select: { id: true },
                });
                sessionIds.push(session.id);
            }
            const priorAudit = await backfillSessionMessageAuthorProjection();
            const receipt = {
                v: 1 as const,
                issuer: "authenticatedAccount" as const,
                actorAccountId: authorId,
                sessionRelationship: "sharedEditor" as const,
            };
            const human = await db.sessionMessage.create({
                data: {
                    sessionId: sessionIds[1]!,
                    seq: 1,
                    messageRole: "user",
                    inputAdmissionReceipt: receipt,
                    content: { t: "plain", v: { role: "user", content: { type: "text", text: "historical" } } },
                },
            });
            const invalid = await db.sessionMessage.create({
                data: {
                    sessionId: sessionIds[0]!,
                    seq: 1,
                    messageRole: "user",
                    authorAccountId: authorId,
                    inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
                    content: { t: "plain", v: { role: "user", content: { type: "text", text: "machine" } } },
                },
            });

            const audit = await backfillSessionMessageAuthorProjection({ batchSize: 2 });
            expect(audit).toMatchObject({ ok: false, disagreements: priorAudit.disagreements + 1 });
            expect(audit.filled).toBe(1);
            expect(await db.sessionMessage.findUniqueOrThrow({
                where: { id: human.id },
                select: { authorAccountId: true, inputAdmissionReceipt: true },
            })).toEqual({ authorAccountId: authorId, inputAdmissionReceipt: receipt });
            // Audit refuses to repair contradictory data in either direction.
            expect((await db.sessionMessage.findUniqueOrThrow({ where: { id: invalid.id } })).authorAccountId).toBe(authorId);
            await db.sessionMessage.update({ where: { id: invalid.id }, data: { authorAccountId: null } });
            const repeated = await backfillSessionMessageAuthorProjection({ batchSize: 2 });
            expect(repeated).toMatchObject({ filled: 0, disagreements: priorAudit.disagreements });
            expect(await db.session.findMany({
                where: { id: { in: sessionIds }, messages: { some: { authorAccountId: authorId } } },
                orderBy: { id: "asc" },
                take: 1,
                select: { id: true },
            })).toEqual([{ id: sessionIds[1] }]);

            await db.account.delete({ where: { id: authorId } });
            expect(await db.sessionMessage.findUniqueOrThrow({
                where: { id: human.id },
                select: { authorAccountId: true, inputAdmissionReceipt: true },
            })).toEqual({ authorAccountId: null, inputAdmissionReceipt: receipt });
            expect((await backfillSessionMessageAuthorProjection({ batchSize: 2 })).filled).toBe(0);
        } finally {
            await db.sessionMessage.deleteMany({ where: { sessionId: { in: sessionIds } } });
            await db.session.deleteMany({ where: { id: { in: sessionIds } } });
            await db.account.deleteMany({ where: { id: { in: [ownerId, authorId] } } });
        }
    });
});
