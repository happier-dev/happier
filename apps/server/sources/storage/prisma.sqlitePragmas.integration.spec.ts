import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderPrismaCompatibleSqliteDatabaseUrl } from "@happier-dev/cli-common/firstPartyRuntime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDbSqliteMaintenanceClient, db, getPrismaConnectionLimit, resolveSqliteRuntimePragmasFromEnv, resolveSqliteStartupDiagnosticsFromEnv, withSqliteReadSnapshot } from "@/storage/db";
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

    it("keeps the main pool's native worker budget when maintenance and snapshot clients open", async () => {
        vi.stubEnv("TOKIO_WORKER_THREADS", undefined);
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-runtime-budget-",
            env: { HAPPIER_DB_CONNECTION_LIMIT: "3", HAPPY_DB_CONNECTION_LIMIT: "" },
        });
        expect(getPrismaConnectionLimit()).toBe(3);
        // Three pooled connections plus SQLite's read-snapshot, maintenance and readiness clients.
        expect(process.env.TOKIO_WORKER_THREADS).toBe("6");
        const maintenance = await createDbSqliteMaintenanceClient();
        try {
            expect(await maintenance.$queryRawUnsafe("SELECT 1 AS value")).toEqual([{ value: 1n }]);
            expect(await withSqliteReadSnapshot(reader => reader.$queryRawUnsafe("SELECT 1 AS value"))).toEqual([{ value: 1n }]);
            expect(getPrismaConnectionLimit()).toBe(3);
            expect(process.env.TOKIO_WORKER_THREADS).toBe("6");
        } finally {
            await maintenance.$disconnect();
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
        expect(Number(timeout)).toBe(30000);
        expect(Number(journalSizeLimit)).toBe(64 * 1024 * 1024);
        expect(timeoutRows.flat().map((row) => Number(row.timeout))).toEqual(Array.from({ length: 16 }, () => 30000));
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
            await rm(parentDir, { recursive: true, force: true });
        }
    });
});
