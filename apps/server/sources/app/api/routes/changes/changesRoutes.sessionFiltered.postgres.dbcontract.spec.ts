import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db, initDbPostgres, shutdownDbClient } from "@/storage/db";
import { changesRoutes } from "./changesRoutes";

const provider = String(
    process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres",
).trim().toLowerCase();
const accountPublicKeyPrefix = "session-filtered-changes-perf-";

describe.skipIf(provider !== "postgres" && provider !== "postgresql")(
    "Session-filtered changes query shape (real PostgreSQL)",
    () => {
        beforeAll(async () => {
            if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
                || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
                throw new Error("Run with the disposable PostgreSQL DB-contract harness");
            }
            initDbPostgres();
            await db.$connect();
        });

        afterEach(async () => {
            const accounts = await db.account.findMany({
                where: { publicKey: { startsWith: accountPublicKeyPrefix } },
                select: { id: true },
            });
            const accountIds = accounts.map((account) => account.id);
            await db.accountChange.deleteMany({ where: { accountId: { in: accountIds } } });
            await db.session.deleteMany({ where: { accountId: { in: accountIds } } });
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
        });

        afterAll(async () => {
            await shutdownDbClient();
        });

        it("selects kinds before paging across one thousand irrelevant rows with snapshot-bounded cursors", async () => {
            const account = await db.account.create({ data: {
                publicKey: `${accountPublicKeyPrefix}${randomUUID()}`,
                encryptionMode: "plain",
            } });
            const unrelatedCount = 1_000;
            const boundary = unrelatedCount + 2;
            const throughCursor = boundary + 2;
            await db.accountChange.createMany({ data: [
                { accountId: account.id, kind: "machine", entityId: "acknowledged", cursor: 1 },
                ...Array.from({ length: unrelatedCount }, (_, index) => ({
                    accountId: account.id, kind: "automation", entityId: `irrelevant-${index}`, cursor: index + 2,
                })),
                { accountId: account.id, kind: "machine", entityId: "boundary", cursor: boundary },
                { accountId: account.id, kind: "share", entityId: "tail", cursor: boundary + 1 },
                { accountId: account.id, kind: "automation", entityId: "irrelevant-tail", cursor: throughCursor },
                { accountId: account.id, kind: "machine", entityId: "beyond-snapshot", cursor: throughCursor + 1 },
            ] });
            await db.account.update({ where: { id: account.id }, data: { seq: throughCursor } });
            await withAuthenticatedTestApp(changesRoutes, async (app) => {
                const headers = { "x-test-user-id": account.id };
                const first = await app.inject({ method: "GET", url: "/v2/changes?kinds=machine,share&after=1&limit=1", headers });
                expect(first.statusCode).toBe(200);
                expect(first.json()).toMatchObject({ changes: [{ kind: "machine", entityId: "boundary", cursor: boundary }], nextCursor: boundary });
                const tail = await app.inject({ method: "GET", url: `/v2/changes?kinds=machine,share&after=${boundary}&limit=2`, headers });
                expect(tail.json()).toMatchObject({ changes: [{ kind: "share", entityId: "tail", cursor: boundary + 1 }], nextCursor: throughCursor });
                const drained = await app.inject({ method: "GET", url: `/v2/changes?kinds=machine,share&after=${throughCursor}`, headers });
                expect(drained.json()).toMatchObject({ changes: [], nextCursor: throughCursor });
                const noMatch = await app.inject({ method: "GET", url: "/v2/changes?kinds=session&after=1", headers });
                expect(noMatch.json()).toMatchObject({ changes: [], nextCursor: throughCursor });
                const unselected = await app.inject({ method: "GET", url: "/v2/changes?after=1&limit=1", headers });
                expect(unselected.json()).toMatchObject({ changes: [{ kind: "automation", cursor: 2 }], nextCursor: 2 });
            });
        });

        it("serves one exact Session page despite one thousand unrelated Account changes", async () => {
            const account = await db.account.create({ data: {
                publicKey: `${accountPublicKeyPrefix}${randomUUID()}`,
                encryptionMode: "plain",
            } });
            const session = await db.session.create({ data: {
                accountId: account.id,
                tag: randomUUID(),
                metadata: "{}",
                encryptionMode: "plain",
            } });
            const unrelatedCount = 1_000;
            await db.accountChange.createMany({ data: [
                ...Array.from({ length: unrelatedCount }, (_, index) => ({
                    accountId: account.id,
                    kind: "automation",
                    entityId: `unrelated-${index}`,
                    cursor: index + 1,
                })),
                {
                    accountId: account.id,
                    kind: "session",
                    entityId: session.id,
                    sessionId: session.id,
                    cursor: unrelatedCount + 1,
                },
            ] });
            await db.account.update({ where: { id: account.id }, data: { seq: unrelatedCount + 1 } });

            await withAuthenticatedTestApp(changesRoutes, async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: `/v2/changes?sessionId=${session.id}&limit=1`,
                    headers: { "x-test-user-id": account.id },
                });

                expect(response.statusCode).toBe(200);
                expect(response.json()).toMatchObject({
                    changes: [{ cursor: unrelatedCount + 1, kind: "session", entityId: session.id }],
                    nextCursor: unrelatedCount + 1,
                });
            });
        });
    },
);
