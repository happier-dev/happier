import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { db, initDbSqlite } from "./prisma";

describe("storage/prisma sqlite pragmas (integration)", () => {
    const envBackup = { ...process.env };
    let baseDir = "";
    let didInit = false;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-prisma-sqlite-pragmas-"));
        const dbPath = join(baseDir, "pragmas.sqlite");

        process.env.HAPPIER_DB_PROVIDER = "sqlite";
        process.env.HAPPY_DB_PROVIDER = "sqlite";
        process.env.DATABASE_URL = `file:${dbPath}`;

        await initDbSqlite();
        didInit = true;
        await db.$connect();
    });

    afterAll(async () => {
        if (didInit) {
            await db.$disconnect().catch(() => {});
        }
        process.env = envBackup;
        if (baseDir) {
            await rm(baseDir, { recursive: true, force: true });
        }
    });

    it("enables SQLite foreign keys and WAL mode with normal synchronous writes", async () => {
        const foreignKeys = await db.$queryRawUnsafe<Array<{ foreign_keys: number }>>("PRAGMA foreign_keys;");
        const journalMode = await db.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode;");
        const synchronous = await db.$queryRawUnsafe<Array<{ synchronous: number }>>("PRAGMA synchronous;");

        expect(foreignKeys[0]?.foreign_keys).toBe(1);
        expect(String(journalMode[0]?.journal_mode ?? "").toLowerCase()).toBe("wal");
        expect(synchronous[0]?.synchronous).toBe(1);
    });
});
