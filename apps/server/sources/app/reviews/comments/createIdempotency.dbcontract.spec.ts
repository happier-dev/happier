import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ReviewCommentSnapshotV1 } from "@happier-dev/protocol";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { buildReviewCommentTextSnapshotHashes } from "./snapshots";
import { createReviewCommentOperations } from "./operations";
import { createSqlReviewCommentStore } from "./store";

function contractProvider(): "postgres" | "mysql" {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .toString()
        .trim()
        .toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported review-comment DB contract provider: ${raw}`);
}

function textSnapshot(): ReviewCommentSnapshotV1 {
    const lines = {
        selectedLines: ["return value.name;"],
        beforeContext: [],
        afterContext: [],
    };
    return {
        kind: "text",
        ...lines,
        ...buildReviewCommentTextSnapshotHashes(lines),
        capturedAt: 1,
        fileLength: 1,
        source: "workingTree",
        isUncommitted: true,
        isUntracked: false,
        truncated: false,
        hasBidiControls: false,
        likelyMinified: false,
    };
}

describe("review comment create idempotency DB contract", () => {
    const provider = contractProvider();
    const accountId = `review-idempotency-${provider}-${randomUUID()}`;
    let connected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL for DB contract test");
        if (provider === "mysql") {
            await initDbMysql();
        } else {
            initDbPostgres();
        }
        await db.$connect();
        connected = true;
        await db.account.create({
            data: {
                id: accountId,
                publicKey: `pk-${accountId}`,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
    });

    afterAll(async () => {
        if (!connected) return;
        await db.account.deleteMany({ where: { id: accountId } });
        await db.$disconnect();
    });

    it("collapses concurrent same-account creates and persists one comment/event", async () => {
        let ordinal = 0;
        const operations = createReviewCommentOperations(createSqlReviewCommentStore(), {
            now: () => Date.now(),
            createId: (prefix) => `${prefix}-${provider}-${++ordinal}-${randomUUID()}`,
        });
        const params = {
            accountId,
            actor: { kind: "user", userId: accountId } as const,
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 2 } as const,
                snapshot: textSnapshot(),
                body: "Null-check this value.",
                authorIntent: "open" as const,
                clientMutationId: "mutation-concurrent-create",
            },
        };

        const results = await Promise.all(Array.from({ length: 8 }, () => operations.create(params)));

        expect(new Set(results.map((result) => result.comment.id)).size).toBe(1);
        expect(results.filter((result) => result.replayed === false)).toHaveLength(1);
        expect(results.filter((result) => result.replayed === true)).toHaveLength(7);
        expect(await db.reviewComment.count({ where: { accountId } })).toBe(1);
        expect(await db.reviewCommentEvent.count({ where: { accountId } })).toBe(1);

        const caseDistinct = await operations.create({
            ...params,
            input: {
                ...params.input,
                clientMutationId: params.input.clientMutationId.toUpperCase(),
            },
        });
        expect(caseDistinct.replayed).toBe(false);
        expect(caseDistinct.comment.id).not.toBe(results[0]!.comment.id);
        expect(await db.reviewComment.count({ where: { accountId } })).toBe(2);
        expect(await db.reviewCommentEvent.count({ where: { accountId } })).toBe(2);

        const trailingSpaceDistinct = await operations.create({
            ...params,
            input: {
                ...params.input,
                clientMutationId: `${params.input.clientMutationId} `,
            },
        });
        expect(trailingSpaceDistinct.replayed).toBe(false);
        expect(trailingSpaceDistinct.comment.id).not.toBe(results[0]!.comment.id);
        expect(await db.reviewComment.count({ where: { accountId } })).toBe(3);
        expect(await db.reviewCommentEvent.count({ where: { accountId } })).toBe(3);
    });
});
