import { statSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { enqueuePendingMessage } from "@/app/session/pending/pendingMessageService";
import { applySqliteRuntimePragmas, createDbMaintenanceClient, createDbSqliteMaintenanceClient, db } from "@/storage/db";
import { checkpointSqliteWal, maintainSqliteWal } from "@/storage/sqliteWalCheckpoint";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const authentication = createPresentUserSessionAccessAuthentication();

function walSizeBytes(dbPath: string): number {
    try {
        return statSync(`${dbPath}-wal`).size;
    } catch {
        return 0;
    }
}

describe("storage/sqliteWalCheckpoint (integration)", () => {
    let harness: LightSqliteHarness | null = null;

    afterEach(async () => {
        if (harness) {
            await harness.close();
            harness = null;
        }
    });

    it("opens a dedicated maintenance connection without a Prisma model client", async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-maintenance-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
        const maintenance = await createDbSqliteMaintenanceClient();
        try {
            await db.$executeRawUnsafe("CREATE TABLE _wal_maintenance_probe (id INTEGER PRIMARY KEY);");
            expect(await checkpointSqliteWal(maintenance)).toMatchObject({ busy: 0 });
            expect(walSizeBytes(harness.dbPath)).toBe(0);
            expect("account" in maintenance).toBe(false);
        } finally {
            await maintenance.$disconnect();
        }
    });

    it("truncates the WAL file back to zero", async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-wal-checkpoint-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });

        // Grow the WAL with committed writes. Stay under the default autocheckpoint
        // threshold so the WAL is non-empty when we checkpoint explicitly.
        await db.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS _wal_probe (id INTEGER PRIMARY KEY, payload TEXT);");
        const payload = "x".repeat(1024);
        for (let i = 0; i < 500; i++) {
            await db.$executeRawUnsafe("INSERT INTO _wal_probe (payload) VALUES (?);", payload);
        }

        expect(walSizeBytes(harness.dbPath)).toBeGreaterThan(0);

        const result = await checkpointSqliteWal(db);

        expect(result.busy).toBe(0);
        expect(walSizeBytes(harness.dbPath)).toBe(0);
    });

    it("defers WAL reset for a held reader while preserving primary reads and writes", async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-wal-checkpoint-contention-",
            sqliteConnectionLimit: 1,
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
        await db.$queryRawUnsafe("PRAGMA wal_autocheckpoint=0;");
        const account = await db.account.create({
            data: { publicKey: "pk-wal-checkpoint-contention" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: { tag: "wal-checkpoint-contention", accountId: account.id, metadata: "meta" },
            select: { id: true },
        });
        const reader = await createDbMaintenanceClient("sqlite");
        const checkpointer = await createDbSqliteMaintenanceClient(500);
        await reader.$connect();
        await applySqliteRuntimePragmas(checkpointer, process.env);

        try {
            // Keep WAL frames present, then hold a read snapshot over all of them. This produces
            // SQLite's exact `busy=1, log=checkpointed` WAL-reset-deferred result.
            await db.account.create({ data: { publicKey: "pk-wal-checkpoint-contention-frame" } });
            await reader.$executeRawUnsafe("BEGIN DEFERRED;");
            await reader.account.findUnique({ where: { id: account.id }, select: { id: true } });

            const passive = await maintainSqliteWal(checkpointer);
            expect(passive.busy).toBe(0);
            expect(passive.logFrames).toBeGreaterThan(0);
            expect(passive.checkpointedFrames).toBe(passive.logFrames);

            const [checkpoint, enqueued, laterRead] = await Promise.all([
                checkpointSqliteWal(checkpointer),
                enqueuePendingMessage({
                    actorUserId: account.id,
                    authentication,
                    sessionId: session.id,
                    localId: "wal-checkpoint-contention-pending",
                    ciphertext: "cipher",
                    requestedAction: { v: 1, kind: "enqueue" },
                    diagnosticCorrelationId: "wal-checkpoint-contention",
                }),
                db.account.findUnique({ where: { id: account.id }, select: { id: true } }),
            ]);
            expect(checkpoint.busy).toBe(1);
            expect(checkpoint.logFrames).toBeGreaterThan(0);
            expect(checkpoint.checkpointedFrames).toBeGreaterThanOrEqual(passive.logFrames);
            expect(enqueued).toMatchObject({ ok: true, didWrite: true });
            expect(laterRead).toEqual({ id: account.id });
            await expect(db.sessionPendingMessage.findUnique({
                where: {
                    sessionId_localId: {
                        sessionId: session.id,
                        localId: "wal-checkpoint-contention-pending",
                    },
                },
                select: { localId: true },
            })).resolves.toEqual({ localId: "wal-checkpoint-contention-pending" });
            await reader.$executeRawUnsafe("ROLLBACK;");
            expect(await checkpointSqliteWal(checkpointer)).toMatchObject({ busy: 0 });
            expect(walSizeBytes(harness.dbPath)).toBe(0);
        } finally {
            await reader.$executeRawUnsafe("ROLLBACK;").catch(() => {});
            await Promise.all([reader.$disconnect(), checkpointer.$disconnect()]);
        }
    });
});
