import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { db, initDbPostgres, isPrismaErrorCode, shutdownDbClient } from "@/storage/prisma";
import { inTx } from "@/storage/inTx";

describe("PostgreSQL minimal Prisma error formatting", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        vi.stubEnv("NODE_ENV", "development");
        initDbPostgres();
        await db.$connect();
    });

    afterAll(async () => {
        await shutdownDbClient();
        vi.unstubAllEnvs();
    });

    it("preserves real known-request codes and messages through root, batch and inTx reads", async () => {
        const missingId = randomUUID();
        for (const query of [
            () => db.account.findUniqueOrThrow({ where: { id: missingId } }),
            () => db.$transaction([db.account.findUniqueOrThrow({ where: { id: missingId } })]),
            () => inTx(tx => tx.account.findUniqueOrThrow({ where: { id: missingId } })),
        ]) {
            const error: unknown = await query().then(() => null, error => error);
            expect(isPrismaErrorCode(error, "P2025")).toBe(true);
            expect(error).toMatchObject({ code: "P2025", message: expect.any(String) });
            expect(error).toBeInstanceOf(Error);
            if (error instanceof Error) expect(error.message.length).toBeGreaterThan(0);
        }
        const error: unknown = await inTx(tx => tx.$queryRawUnsafe("SELECT * FROM happier_absent_call_site_table"))
            .then(() => null, error => error);
        expect(isPrismaErrorCode(error, "P2010")).toBe(true);
        expect(error).toMatchObject({ code: "P2010", meta: { code: "42P01" } });
        // A failed transaction must release its connection for the next query.
        expect(await inTx(tx => tx.$queryRaw`SELECT 1::int AS value`)).toEqual([{ value: 1 }]);
    });
});
