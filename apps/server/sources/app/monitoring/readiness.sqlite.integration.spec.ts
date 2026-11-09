import { closeSync, openSync, writeSync } from "node:fs";

import type { FastifyReply } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { sendDatabaseReadinessResponse } from "@/app/monitoring/readiness";
import { db } from "@/storage/db";
import { withSqliteReadSnapshot } from "@/storage/prisma";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

// A CPU-bound read that holds its pool connection for a long time, standing in for a
// cold, large list read (#832: a ~40 MB archived-session page took ~7 s).
const LONG_READ_SQL =
    "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 30000000) SELECT count(*) AS n FROM cnt";

async function readReadinessStatus(): Promise<number> {
    let statusCode = 200;
    const reply = {
        code(code: number) {
            statusCode = code;
            return reply;
        },
        send() {
            return reply;
        },
    };
    // Fastify reply is the HTTP boundary; readiness only uses code()/send().
    await sendDatabaseReadinessResponse(reply as unknown as FastifyReply);
    return statusCode;
}

describe("SQLite /ready probe", () => {
    let harness: LightSqliteHarness | null = null;

    afterEach(async () => {
        await harness?.close();
        harness = null;
    });

    it("answers while a long application read holds the sole primary connection", async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-readiness-head-of-line-",
            sqliteConnectionLimit: 1,
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
        let longReadSettled = false;
        const longRead = db.$queryRawUnsafe(LONG_READ_SQL).finally(() => {
            longReadSettled = true;
        });
        try {
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(longReadSettled).toBe(false);

            await expect(readReadinessStatus()).resolves.toBe(200);
            expect(longReadSettled).toBe(false);
        } finally {
            await longRead;
        }
    }, 60_000);

    it("answers while long reads hold both the primary connection and the read snapshot", async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-readiness-snapshot-head-of-line-",
            sqliteConnectionLimit: 1,
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
        let settledReads = 0;
        const appRead = db.$queryRawUnsafe(LONG_READ_SQL).finally(() => {
            settledReads += 1;
        });
        // Read-only transactions (Session listing pages) run on the snapshot connection.
        const snapshotRead = withSqliteReadSnapshot((reader) => reader.$queryRawUnsafe(LONG_READ_SQL)).finally(() => {
            settledReads += 1;
        });
        try {
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(settledReads).toBe(0);

            await expect(readReadinessStatus()).resolves.toBe(200);
            expect(settledReads).toBe(0);
        } finally {
            await Promise.all([appRead, snapshotRead]);
        }
    }, 120_000);

    it("fails when the database file is no longer a SQLite database", async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-readiness-broken-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
        await expect(readReadinessStatus()).resolves.toBe(200);

        // Move every page into the main file, then overwrite its header.
        await db.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE);");
        const fd = openSync(harness.dbPath, "r+");
        try {
            writeSync(fd, Buffer.alloc(4096, 0x41), 0, 4096, 0);
        } finally {
            closeSync(fd);
        }

        await expect(readReadinessStatus()).resolves.toBe(503);
    });
});
