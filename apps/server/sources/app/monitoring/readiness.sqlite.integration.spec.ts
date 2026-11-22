import { closeSync, openSync, writeSync } from "node:fs";
import { Session } from "node:inspector";
import { getHeapStatistics } from "node:v8";

import type { FastifyReply } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { sendDatabaseReadinessResponse } from "@/app/monitoring/readiness";
import { db } from "@/storage/db";
import { disconnectDbReadinessProbe, withSqliteReadSnapshot } from "@/storage/prisma";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void; reject: (reason: unknown) => void }> {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

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

    it("does not retain a query compiler for the fixed SQL probe", async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-readiness-compiler-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
        const inspector = new Session();
        inspector.connect();
        const usedHeapAfterCollection = async (): Promise<number> => {
            await new Promise<void>((resolve, reject) => {
                inspector.post("HeapProfiler.collectGarbage", (error) => error ? reject(error) : resolve());
            });
            return getHeapStatistics().used_heap_size;
        };
        try {
            await expect(readReadinessStatus()).resolves.toBe(200);
            await expect(readReadinessStatus()).resolves.toBe(200);
            const beforeClose = await usedHeapAfterCollection();
            await disconnectDbReadinessProbe();
            const afterClose = await usedHeapAfterCollection();
            // The retired compiler retained 28 MiB. Leave room for unrelated GC variation.
            expect(beforeClose - afterClose).toBeLessThan(5 * 1024 * 1024);
        } finally {
            inspector.disconnect();
        }
    });

    it("answers while transactions hold both the sole primary connection and the read snapshot", async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-readiness-snapshot-head-of-line-",
            sqliteConnectionLimit: 1,
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
        // Hold the real connections without blocking the event loop in the synchronous SQLite binding.
        const primaryHeld = deferred();
        const snapshotHeld = deferred();
        const release = deferred();
        const snapshotRead = withSqliteReadSnapshot(async (reader) => {
            await reader.$queryRaw`SELECT count(*) FROM sqlite_master`;
            snapshotHeld.resolve();
            await release.promise;
        });
        void snapshotRead.catch(snapshotHeld.reject);
        const primaryRead = db.$transaction(async () => {
            primaryHeld.resolve();
            await release.promise;
        });
        void primaryRead.catch(primaryHeld.reject);
        try {
            await Promise.all([snapshotHeld.promise, primaryHeld.promise]);
            await expect(readReadinessStatus()).resolves.toBe(200);
        } finally {
            release.resolve();
            await Promise.all([snapshotRead, primaryRead]);
        }
    });

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
