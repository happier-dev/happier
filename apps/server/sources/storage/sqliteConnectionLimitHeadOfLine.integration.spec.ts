import { randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";

import type { FastifyReply } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sendDatabaseReadinessResponse } from "@/app/monitoring/readiness";
import { enqueuePendingMessage } from "@/app/session/pending/pendingMessageService";
import {
    createDbSqliteMaintenanceClient,
    db,
} from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function readPrimaryBusyConnectionCount(): Promise<number> {
    const metrics = await db.$metrics.json();
    return metrics.gauges.find((metric) => metric.key === "prisma_pool_connections_busy")?.value ?? 0;
}

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

describe("SQLite connection_limit=1 head-of-line attribution", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-head-of-line-",
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    it("answers /ready while a long application read holds the sole primary connection", async () => {
        let longReadSettled = false;
        const longRead = db.$queryRawUnsafe(LONG_READ_SQL).finally(() => {
            longReadSettled = true;
        });
        try {
            await vi.waitFor(async () => {
                expect(await readPrimaryBusyConnectionCount()).toBe(1);
            }, { timeout: 2_000, interval: 5 });

            await expect(readReadinessStatus()).resolves.toBe(200);
            expect(longReadSettled).toBe(false);
        } finally {
            await longRead;
        }
    }, 60_000);

    it("shows a blocked write occupying the sole primary connection and stalling later reads", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-sqlite-head-of-line-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `tag-sqlite-head-of-line-${randomUUID()}`,
                accountId: account.id,
                metadata: "meta",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true },
        });
        const externalWriter = await createDbSqliteMaintenanceClient();
        await externalWriter.$connect();
        const writerEntered = deferred();
        const releaseWriter = deferred();
        const writer = externalWriter.$transaction(async () => {
            writerEntered.resolve();
            await releaseWriter.promise;
        }, { maxWait: 2_000, timeout: 5_000 });

        try {
            await writerEntered.promise;

            // WAL still permits a read while another connection owns the writer lock.
            await expect(db.account.findUnique({
                where: { id: account.id },
                select: { id: true },
            })).resolves.toEqual({ id: account.id });

            let enqueueSettled = false;
            const enqueue = enqueuePendingMessage({
                actorUserId: account.id,
                sessionId: session.id,
                localId: `pending-sqlite-head-of-line-${randomUUID()}`,
                ciphertext: "cipher-sqlite-head-of-line",
                requestedAction: { v: 1, kind: "enqueue" },
                diagnosticCorrelationId: "probe-sqlite-head-of-line",
            }).finally(() => {
                enqueueSettled = true;
            });

            await vi.waitFor(async () => {
                expect(await readPrimaryBusyConnectionCount()).toBe(1);
            }, { timeout: 2_000, interval: 10 });

            let laterReadSettled = false;
            const laterRead = db.account.findUnique({
                where: { id: account.id },
                select: { id: true },
            }).finally(() => {
                laterReadSettled = true;
            });

            await new Promise((resolve) => setTimeout(resolve, 75));
            expect(enqueueSettled).toBe(false);
            expect(laterReadSettled).toBe(false);

            releaseWriter.resolve();
            await writer;
            await expect(enqueue).resolves.toMatchObject({ ok: true, didWrite: true });
            await expect(laterRead).resolves.toEqual({ id: account.id });
        } finally {
            releaseWriter.resolve();
            await writer.catch(() => {});
            await externalWriter.$disconnect();
        }
    });
});

describe("SQLite readiness on a broken database file", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-readiness-broken-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    it("fails /ready when the database file is no longer a SQLite database", async () => {
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
