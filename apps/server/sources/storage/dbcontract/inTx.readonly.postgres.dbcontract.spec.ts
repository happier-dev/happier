import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inReadSnapshot, inTx } from "@/storage/inTx";

const postgres = getDbProviderFromEnv(process.env, "postgres") === "postgres";

describe.skipIf(!postgres)("PostgreSQL read-only transactions", () => {
    let accountId: string;
    let sessionId: string;
    let artifactId: string;
    let connected = false;

    beforeAll(async () => {
        // The Docker contract runner supplies both URLs for its disposable database.
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        // Shared-stack diagnostics must preserve Prisma's interactive transaction receiver.
        vi.stubEnv("HAPPIER_STACK_SHARED_DB_SOURCE_STACK", "readonly-contract");
        initDbPostgres();
        await db.$connect();
        connected = true;
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        accountId = account.id;
        sessionId = (await db.session.create({ data: {
            accountId, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } })).id;
        artifactId = (await db.artifact.create({ data: {
            id: randomUUID(), accountId, header: Buffer.from("header"), body: Buffer.from("body"),
            dataEncryptionKey: Buffer.from("test-key"),
        } })).id;
    });

    afterAll(async () => {
        if (connected) await db.$disconnect();
        vi.unstubAllEnvs();
    });

    it.each(["Serializable", "RepeatableRead", "ReadCommitted"] as const)("declares read-only before the callback at %s isolation", async isolationLevel => {
        const mode = await inTx(tx => tx.$queryRaw<Array<{ readOnly: string; deferrable: string }>>`
            SELECT current_setting('transaction_read_only') AS "readOnly",
                   current_setting('transaction_deferrable') AS deferrable
        `, { readOnly: true, isolationLevel });
        expect(mode).toEqual([{ readOnly: "on", deferrable: "off" }]);
    });

    it("rejects a write without replaying it and keeps ordinary transactions writable", async () => {
        let attempts = 0;
        await expect(inTx(async tx => {
            attempts += 1;
            await tx.$executeRaw`UPDATE "Account" SET seq = seq + 1 WHERE id = ${accountId}`;
        }, { readOnly: true, isolationLevel: "Serializable" })).rejects.toMatchObject({
            code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "25006" } } },
        });
        expect(attempts).toBe(1);
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } }))
            .toEqual({ seq: 0 });
        await inTx(async tx => {
            expect(await tx.$queryRaw<Array<{ readOnly: string; isolation: string }>>`
                SELECT current_setting('transaction_read_only') AS "readOnly",
                       current_setting('transaction_isolation') AS isolation
            `).toEqual([{ readOnly: "off", isolation: "read committed" }]);
            await tx.account.update({ where: { id: accountId }, data: { seq: 1 } });
        });
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } }))
            .toEqual({ seq: 1 });
    });

    it("redeclares read-only on a serialization retry within the original deadline", async () => {
        let attempts = 0;
        const deadlineAtMs = Date.now() + 30_000;
        const mode = await inTx(async tx => {
            attempts += 1;
            const result = await tx.$queryRaw<Array<{ readOnly: string }>>`
                SELECT current_setting('transaction_read_only') AS "readOnly"
            `;
            // A server-raised serialization failure exercises Prisma's real SQLSTATE wrapper.
            if (attempts === 1) await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '40001'; END $$`;
            return result;
        }, { readOnly: true, isolationLevel: "Serializable", deadlineAtMs });
        expect(attempts).toBe(2);
        expect(mode).toEqual([{ readOnly: "on" }]);
        expect(Date.now()).toBeLessThan(deadlineAtMs);
    });

    it("keeps concurrent root-client and ordinary transaction writes outside a read-only snapshot", async () => {
        const account = await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } });
        const session = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { seq: true } });
        await inReadSnapshot(async tx => {
            const readMode = () => tx.$queryRaw<Array<{ readOnly: string }>>`
                SELECT current_setting('transaction_read_only') AS "readOnly"
            `;
            expect(await readMode()).toEqual([{ readOnly: "on" }]);
            // Session-cache flushes use the root client while API reads hold snapshots.
            const [rootWrite, transactionWrite] = await Promise.all([
                db.account.updateMany({ where: { id: accountId }, data: { seq: { increment: 1 } } }),
                inTx(async writer => {
                    expect(await writer.$queryRaw<Array<{ readOnly: string }>>`
                        SELECT current_setting('transaction_read_only') AS "readOnly"
                    `).toEqual([{ readOnly: "off" }]);
                    return writer.session.updateMany({ where: { id: sessionId }, data: { seq: { increment: 1 } } });
                }),
            ]);
            expect(rootWrite.count).toBe(1);
            expect(transactionWrite.count).toBe(1);
            expect(await readMode()).toEqual([{ readOnly: "on" }]);
        });
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } }))
            .toEqual({ seq: account.seq + 1 });
        expect(await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { seq: true } }))
            .toEqual({ seq: session.seq + 1 });
    });

    it("keeps the Session/Artifact snapshot stable across writer commits and measures predicate locks", async () => {
        const measurements: Array<{ readOnly: boolean; overlap: boolean; beforeCommit: number; afterCommit: number }> = [];
        for (const readOnly of [false, true]) {
            for (const overlap of [false, true]) {
                let releaseWriter!: () => void;
                const writerRelease = new Promise<void>(resolve => { releaseWriter = resolve; });
                let writerReady!: () => void;
                const ready = new Promise<void>(resolve => { writerReady = resolve; });
                const writer = overlap ? inTx(async tx => {
                    await tx.session.update({ where: { id: sessionId }, data: { seq: { increment: 1 } } });
                    writerReady();
                    await writerRelease;
                }, { isolationLevel: "Serializable" }) : Promise.resolve();
                if (overlap) await Promise.race([ready, writer]);
                try {
                    await inTx(async tx => {
                        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                        const read = async () => {
                            return {
                                session: await tx.session.findUniqueOrThrow({ where: { id: sessionId }, select: { id: true, seq: true } }),
                                artifact: await tx.artifact.findUniqueOrThrow({ where: { id: artifactId }, select: { id: true } }),
                            };
                        };
                        const locks = async () => {
                            const [{ count }] = await db.$queryRaw<Array<{ count: number }>>`
                                SELECT count(*)::int AS count FROM pg_locks
                                WHERE mode = 'SIReadLock' AND pid = ${pid}
                            `;
                            return count;
                        };
                        const snapshot = await read();
                        const beforeCommit = await locks();
                        releaseWriter();
                        await writer;
                        expect(await read()).toEqual(snapshot);
                        measurements.push({ readOnly, overlap, beforeCommit, afterCommit: await locks() });
                    }, { readOnly, isolationLevel: "Serializable" });
                } finally {
                    releaseWriter();
                    await writer;
                }
            }
        }
        // Diagnostic measurements are workload-specific, not a universal lock-count assertion.
        console.info("FIX59_SIREAD", JSON.stringify({
            version: await db.$queryRaw`SELECT version()`, measurements,
        }));
    });
});
