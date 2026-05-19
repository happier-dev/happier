import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderPrismaCompatibleSqliteDatabaseUrl } from "@happier-dev/cli-common/firstPartyRuntime";
import { afterEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("storage/prisma sqlite pragmas", () => {
    let harness: LightSqliteHarness | null = null;

    afterEach(async () => {
        if (harness) {
            await harness.close();
            harness = null;
        }
    });

    it("configures WAL and URL busy_timeout for sqlite connections (stack stability)", async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-pragmas-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });

        const [{ journal_mode: journalMode }] = await db.$queryRawUnsafe<Array<{ journal_mode: string }>>(
            "SELECT journal_mode FROM pragma_journal_mode;",
        );
        const [{ synchronous }] = await db.$queryRawUnsafe<Array<{ synchronous: number | bigint }>>(
            "SELECT synchronous FROM pragma_synchronous;",
        );
        const [{ timeout }] = await db.$queryRawUnsafe<Array<{ timeout: number | bigint }>>(
            "SELECT timeout FROM pragma_busy_timeout;",
        );
        const timeoutRows = await Promise.all(
            Array.from({ length: 16 }, () =>
                db.$queryRawUnsafe<Array<{ timeout: number | bigint }>>("SELECT timeout FROM pragma_busy_timeout;"),
            ),
        );

        expect(journalMode.toLowerCase()).toBe("wal");
        expect(Number(synchronous)).toBe(1); // NORMAL
        expect(Number(timeout)).toBe(30000);
        expect(timeoutRows.flat().map((row) => Number(row.timeout))).toEqual(Array.from({ length: 16 }, () => 30000));
    });

    it("observes consistent synchronous mode when sqlite connection_limit is explicit", async () => {
        const baseDir = await mkdtemp(join(tmpdir(), "happier-sqlite-pragmas-single-connection-"));
        const originalDatabaseUrl = process.env.DATABASE_URL;
        const databaseUrl = renderPrismaCompatibleSqliteDatabaseUrl({
            dbPath: join(baseDir, "test.sqlite"),
            platform: process.platform,
            sqlite: { connectionLimit: 1 },
        });

        process.env.DATABASE_URL = databaseUrl;
        const { PrismaClient } = await import("../../generated/sqlite-client/index.js");
        const client = new PrismaClient();
        try {
            await client.$queryRawUnsafe("PRAGMA synchronous=NORMAL;");
            const synchronousRows = await Promise.all(
                Array.from({ length: 16 }, () =>
                    client.$queryRawUnsafe<Array<{ synchronous: number | bigint }>>("SELECT synchronous FROM pragma_synchronous;"),
                ),
            );

            expect(synchronousRows.flat().map((row) => Number(row.synchronous))).toEqual(Array.from({ length: 16 }, () => 1));
        } finally {
            await client.$disconnect();
            if (typeof originalDatabaseUrl === "string") {
                process.env.DATABASE_URL = originalDatabaseUrl;
            } else {
                delete process.env.DATABASE_URL;
            }
            await rm(baseDir, { recursive: true, force: true });
        }
    });
});
