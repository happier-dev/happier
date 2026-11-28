import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderPrismaCompatibleSqliteDatabaseUrl } from "@happier-dev/cli-common/firstPartyRuntime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDbMaintenanceClient, createDbSqliteMaintenanceClient, db, getPrismaConnectionLimit, resolveSqliteRuntimePragmasFromEnv, resolveSqliteStartupDiagnosticsFromEnv, withSqliteReadSnapshot } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("storage/prisma sqlite pragmas", () => {
    let harness: LightSqliteHarness | null = null;

    afterEach(async () => {
        if (harness) {
            await harness.close();
            harness = null;
        }
        vi.unstubAllEnvs();
    });

    it("keeps the main pool's connection limit when maintenance and snapshot clients open", async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-runtime-budget-",
            env: { HAPPIER_DB_CONNECTION_LIMIT: "3", HAPPY_DB_CONNECTION_LIMIT: "" },
        });
        expect(getPrismaConnectionLimit()).toBe(3);
        const maintenance = await createDbSqliteMaintenanceClient();
        try {
            expect(Number((await maintenance.$queryRawUnsafe("SELECT 1 AS value"))[0]?.value)).toBe(1);
            expect(await withSqliteReadSnapshot(reader => reader.$queryRawUnsafe("SELECT 1 AS value"))).toEqual([{ value: 1n }]);
            expect(getPrismaConnectionLimit()).toBe(3);
        } finally {
            await maintenance.$disconnect();
        }
    });

    it("configures WAL and leaves busy waiting to the adapter for sqlite connections (stack stability)", async () => {
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
        const [{ journal_size_limit: journalSizeLimit }] = await db.$queryRawUnsafe<
            Array<{ journal_size_limit: number | bigint }>
        >("SELECT journal_size_limit FROM pragma_journal_size_limit;");
        const timeoutRows = await Promise.all(
            Array.from({ length: 16 }, () =>
                db.$queryRawUnsafe<Array<{ timeout: number | bigint }>>("SELECT timeout FROM pragma_busy_timeout;"),
            ),
        );

        expect(journalMode.toLowerCase()).toBe("wal");
        expect(Number(synchronous)).toBe(1); // NORMAL
        // SQLite's own busy handler would block the JS thread; the adapter waits asynchronously
        // up to the configured budget instead (sqliteDriverAdapter.spec.ts covers the wait).
        expect(Number(timeout)).toBe(0);
        expect(resolveSqliteRuntimePragmasFromEnv(process.env).busyTimeoutMs).toBe(30000);
        expect(Number(journalSizeLimit)).toBe(64 * 1024 * 1024);
        expect(timeoutRows.flat().map((row) => Number(row.timeout))).toEqual(Array.from({ length: 16 }, () => 0));
    });

    it("accepts negative journal_size_limit values as SQLite no-limit opt-out", () => {
        expect(resolveSqliteRuntimePragmasFromEnv({
            HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES: "-1",
        }).journalSizeLimitBytes).toBe(-1);
    });

    it("treats zero journal_size_limit as an explicit minimum-size limit", () => {
        expect(resolveSqliteRuntimePragmasFromEnv({
            HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES: "0",
        }).journalSizeLimitBytes).toBe(0);
    });

    it("reports sanitized sqlite startup diagnostics and unsupported pool timeout parameters", () => {
        const diagnostics = resolveSqliteStartupDiagnosticsFromEnv({
            DATABASE_URL: "file:/tmp/happier-secret-path/test.sqlite?socket_timeout=45&connection_limit=1&pool_timeout=60",
            HAPPIER_SQLITE_BUSY_TIMEOUT_MS: "45000",
            HAPPIER_SQLITE_JOURNAL_MODE: "DELETE",
            HAPPIER_SQLITE_SYNCHRONOUS: "FULL",
        });

        expect(diagnostics).toEqual({
            provider: "sqlite",
            journalMode: "DELETE",
            synchronous: "FULL",
            busyTimeoutMs: 45000,
            journalSizeLimitBytes: 64 * 1024 * 1024,
            databaseUrlSocketTimeoutSeconds: 45,
            databaseUrlConnectionLimit: 1,
            databaseUrlConnectionLimitStatus: "configured",
            databaseUrlPoolAcquisitionTimeoutStatus: "unbounded",
            ignoredDatabaseUrlQueryParameters: ["pool_timeout"],
        });
        expect(JSON.stringify(diagnostics)).not.toContain("happier-secret-path");
    });

    it("opens sqlite databases whose filesystem path contains spaces", async () => {
        const parentDir = await mkdtemp(join(tmpdir(), "happier-sqlite-pragmas-"));
        const baseDir = join(parentDir, "single connection");
        await mkdir(baseDir);
        const databaseUrl = renderPrismaCompatibleSqliteDatabaseUrl({
            dbPath: join(baseDir, "test.sqlite"),
            platform: process.platform,
            sqlite: { connectionLimit: 1 },
        });

        const client = await createDbMaintenanceClient("sqlite", databaseUrl);
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
            await rm(parentDir, { recursive: true, force: true });
        }
    });
});
