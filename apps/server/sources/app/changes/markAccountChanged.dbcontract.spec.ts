import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { markAccountChanged } from "./markAccountChanged";

function resolveContractProvider(): "postgres" | "mysql" {
    const raw = String(
        process.env.HAPPIER_DB_PROVIDER
        ?? process.env.HAPPY_DB_PROVIDER
        ?? "postgres",
    ).trim().toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported AccountChange DB contract provider: ${raw}`);
}

const provider = resolveContractProvider();
const publicKeyPrefix = "dbcontract-account-change-coalescing-";

describe("AccountChange Collection coalescing database contract", () => {
    let dbConnected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error("Missing DATABASE_URL (required for db contract tests).");
        }
        if (provider === "mysql") {
            await initDbMysql();
        } else {
            initDbPostgres();
        }
        await db.$connect();
        dbConnected = true;
    });

    afterEach(async () => {
        await db.account.deleteMany({
            where: { publicKey: { startsWith: publicKeyPrefix } },
        });
    });

    afterAll(async () => {
        if (dbConnected) await db.$disconnect();
    });

    it(`keeps a retained Collection full hint broad across a later exact hint on ${provider}`, async () => {
        const account = await db.account.create({
            data: { publicKey: `${publicKeyPrefix}${randomUUID()}` },
            select: { id: true },
        });
        const pluginId = "example.contract";
        const collectionId = "tasks";
        const entityId = `pluginDomain/${pluginId}/data-collection/${collectionId}`;
        const fullCursor = await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId,
                    contractDigest: "a".repeat(43),
                    revision: 4,
                    full: true,
                },
            })
        ));
        const exactCursor = await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId,
                    contractDigest: "b".repeat(43),
                    revision: 5,
                    rowIds: ["task-1"],
                },
            })
        ));

        expect(exactCursor).toBeGreaterThan(fullCursor);
        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: account.id,
                    kind: "pluginDomain",
                    entityId,
                },
            },
            select: { cursor: true, hint: true },
        })).resolves.toEqual({
            cursor: exactCursor,
            hint: {
                pluginDomain: "dataCollection",
                pluginId,
                collectionId,
                contractDigest: "b".repeat(43),
                revision: 5,
                full: true,
            },
        });
    });

    it(`preserves exact-only and separate Collection identities on ${provider}`, async () => {
        const account = await db.account.create({
            data: { publicKey: `${publicKeyPrefix}${randomUUID()}` },
            select: { id: true },
        });
        const pluginId = "example.contract";
        const exactCollectionId = "exact-only";
        const fullCollectionId = "separate-full";
        const exactEntityId = `pluginDomain/${pluginId}/data-collection/${exactCollectionId}`;
        const fullEntityId = `pluginDomain/${pluginId}/data-collection/${fullCollectionId}`;

        await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId: exactEntityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId: exactCollectionId,
                    contractDigest: "c".repeat(43),
                    revision: 1,
                    rowIds: ["first"],
                },
            })
        ));
        const fullCursor = await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId: fullEntityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId: fullCollectionId,
                    contractDigest: "d".repeat(43),
                    revision: 3,
                    full: true,
                },
            })
        ));
        const exactCursor = await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId: exactEntityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId: exactCollectionId,
                    contractDigest: "c".repeat(43),
                    revision: 2,
                    rowIds: ["second"],
                },
            })
        ));

        await expect(db.accountChange.findMany({
            where: { accountId: account.id, kind: "pluginDomain" },
            orderBy: { entityId: "asc" },
            select: { cursor: true, entityId: true, hint: true },
        })).resolves.toEqual([{
            cursor: exactCursor,
            entityId: exactEntityId,
            hint: {
                pluginDomain: "dataCollection",
                pluginId,
                collectionId: exactCollectionId,
                contractDigest: "c".repeat(43),
                revision: 2,
                rowIds: ["second"],
            },
        }, {
            cursor: fullCursor,
            entityId: fullEntityId,
            hint: {
                pluginDomain: "dataCollection",
                pluginId,
                collectionId: fullCollectionId,
                contractDigest: "d".repeat(43),
                revision: 3,
                full: true,
            },
        }]);
    });
});
