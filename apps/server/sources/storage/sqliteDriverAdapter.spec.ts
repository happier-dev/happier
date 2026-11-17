import { ColumnTypeEnum, type SqlDriverAdapter } from "@prisma/driver-adapter-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseSqliteDatabaseUrl, SqliteDriverAdapterFactory } from "./sqliteDriverAdapter";

const query = (sql: string, args: unknown[] = [], scalarTypes: string[] = []) => ({
    sql,
    args,
    argTypes: args.map((_, index) => ({ scalarType: (scalarTypes[index] ?? "unknown") as never, arity: "scalar" as const })),
});

describe("SQLite driver adapter", () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function open(options: Partial<{ connectionLimit: number; busyTimeoutMs: number }> = {}): Promise<Readonly<{
        adapter: SqlDriverAdapter;
        path: string;
        factory: SqliteDriverAdapterFactory;
    }>> {
        const dir = await mkdtemp(join(tmpdir(), "happier-sqlite-adapter-"));
        const path = join(dir, "db.sqlite");
        const factory = new SqliteDriverAdapterFactory({ path, connectionLimit: 1, busyTimeoutMs: 2_000, ...options });
        const adapter = await factory.connect();
        cleanups.push(async () => {
            await adapter.dispose();
            await rm(dir, { recursive: true, force: true });
        });
        await adapter.executeScript([
            'CREATE TABLE "Row" ("id" TEXT PRIMARY KEY, "at" DATETIME, "flag" BOOLEAN, "n" INTEGER, "big" BIGINT,',
            '"doc" JSONB, "bytes" BLOB, "label" TEXT);',
        ].join(" "));
        return { adapter, path, factory };
    }

    it("stores DateTime values in the Rust engine's integer-millisecond format", async () => {
        const { adapter } = await open();
        const at = new Date(1_794_597_781_134);
        await adapter.executeRaw(query('INSERT INTO "Row" ("id", "at", "flag", "n") VALUES (?, ?, ?, ?)',
            ["a", at.toISOString(), true, "7"], ["string", "datetime", "boolean", "int"]));
        await adapter.executeRaw(query('INSERT INTO "Row" ("id", "at") VALUES (?, ?)', ["b", at]));

        const stored = await adapter.queryRaw(query(
            'SELECT typeof("at") AS t, "at" + 0 AS ms, typeof("flag") AS f, typeof("n") AS n FROM "Row" ORDER BY "id"'));
        expect(stored.rows).toEqual([["integer", 1_794_597_781_134, "integer", "integer"], ["integer", 1_794_597_781_134, "null", "null"]]);
    });

    it("reads 0.2-written cells with the column types the Rust engine reported", async () => {
        const { adapter } = await open();
        // Literal SQL pins the stored representation the Rust engine wrote (P03-PRISMA-7 census of
        // a real 0.2 database: DATETIME integer ms, BOOLEAN integer, BIGINT integer, JSONB text).
        await adapter.executeScript(`INSERT INTO "Row" VALUES ('r', 1794597781134, 1, 5, 9007199254740993,
            '{"a":1}', X'0102', 'x'), ('s', '2026-10-01 12:30:00', 0, NULL, 2, NULL, NULL, NULL)`);

        const result = await adapter.queryRaw(query(
            'SELECT "at", "flag", "n", "big", "doc", "bytes", "label", count(*) OVER () AS total FROM "Row" ORDER BY "id"'));
        expect(result.columnTypes).toEqual([
            ColumnTypeEnum.DateTime, ColumnTypeEnum.Boolean, ColumnTypeEnum.Int32, ColumnTypeEnum.Int64,
            ColumnTypeEnum.Json, ColumnTypeEnum.Bytes, ColumnTypeEnum.Text, ColumnTypeEnum.Int64,
        ]);
        expect(result.rows[0]).toEqual([
            "2026-11-13T19:23:01.134Z", true, 5, "9007199254740993", '{"a":1}', new Uint8Array([1, 2]), "x", 2,
        ]);
        // SQLite's CURRENT_TIMESTAMP text is UTC.
        expect(result.rows[1]!.slice(0, 2)).toEqual(["2026-10-01T12:30:00Z", false]);
    });

    it("binds integer numbers as int64, as the Rust engine and bun:sqlite do", async () => {
        const { adapter } = await open();
        const result = await adapter.queryRaw(query("SELECT typeof(?) AS i, typeof(?) AS f", [7, 1.5]));
        expect(result.rows).toEqual([["integer", "real"]]);
    });

    it("maps constraint violations to Prisma's error kinds", async () => {
        const { adapter } = await open();
        await adapter.executeRaw(query('INSERT INTO "Row" ("id") VALUES (?)', ["dup"]));
        await expect(adapter.executeRaw(query('INSERT INTO "Row" ("id") VALUES (?)', ["dup"]))).rejects.toMatchObject({
            cause: { kind: "UniqueConstraintViolation", originalCode: "1555" },
        });
    });

    it("waits for a busy database without blocking the event loop, then reports SQLITE_BUSY as a timeout", async () => {
        const { adapter, path } = await open({ busyTimeoutMs: 300 });
        // A second connection of this process holds the write lock across event-loop turns.
        const holder = await new SqliteDriverAdapterFactory({ path, connectionLimit: 1, busyTimeoutMs: 0 }).connect();
        cleanups.push(() => holder.dispose());
        const transaction = await holder.startTransaction();

        let ticks = 0;
        const ticker = setInterval(() => { ticks += 1; }, 5);
        const startedAt = Date.now();
        const write = adapter.executeRaw(query('INSERT INTO "Row" ("id") VALUES (?)', ["waits"]));
        setTimeout(() => {
            void transaction.executeRaw(query("COMMIT")).then(() => transaction.commit());
        }, 100);
        await expect(write).resolves.toBe(1);
        clearInterval(ticker);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
        expect(ticks).toBeGreaterThan(5);

        const blocker = await holder.startTransaction();
        await expect(adapter.executeRaw(query('INSERT INTO "Row" ("id") VALUES (?)', ["times-out"]))).rejects.toMatchObject({
            cause: { kind: "SocketTimeout" },
        });
        await blocker.executeRaw(query("ROLLBACK"));
        await blocker.rollback();
    });

    it("holds the connection for an interactive transaction; other statements wait for it", async () => {
        const { adapter, factory } = await open();
        const transaction = await adapter.startTransaction();
        await transaction.executeRaw(query('INSERT INTO "Row" ("id") VALUES (?)', ["in-tx"]));
        const outside = adapter.queryRaw(query('SELECT count(*) AS n FROM "Row"'));
        expect(factory.poolStats()).toEqual({ open: 1, idle: 0, waiting: 1 });
        await transaction.executeRaw(query("ROLLBACK"));
        await transaction.rollback();
        // The outside read ran after the rollback, never inside the transaction.
        expect((await outside).rows).toEqual([[0]]);
    });

    it("serves other statements while a transaction waits to begin on a busy database", async () => {
        const { adapter, path, factory } = await open();
        const holder = await new SqliteDriverAdapterFactory({ path, connectionLimit: 1, busyTimeoutMs: 0 }).connect();
        cleanups.push(() => holder.dispose());
        const lock = await holder.startTransaction();

        let begun = false;
        const waiting = adapter.startTransaction().then((transaction) => { begun = true; return transaction; });
        await new Promise((resolve) => setTimeout(resolve, 20));
        // The waiting transaction holds no SQLite state yet, so the single connection serves the read.
        expect((await adapter.queryRaw(query('SELECT count(*) AS n FROM "Row"'))).rows).toEqual([[0]]);
        expect(begun).toBe(false);
        expect(factory.poolStats()).toMatchObject({ open: 1 });

        await lock.executeRaw(query("ROLLBACK"));
        await lock.rollback();
        const transaction = await waiting;
        await transaction.executeRaw(query("ROLLBACK"));
        await transaction.rollback();
    });

    it("reads the path and pool size from a Prisma SQLite URL", () => {
        expect(parseSqliteDatabaseUrl("file:/data/happier.sqlite?socket_timeout=30&connection_limit=2"))
            .toEqual({ path: "/data/happier.sqlite", connectionLimit: 2 });
        expect(parseSqliteDatabaseUrl("file:C:\\Users\\fixture\\data.sqlite")).toEqual({ path: "C:\\Users\\fixture\\data.sqlite", connectionLimit: 1 });
    });
});
