import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createDbMaintenanceClient, getDbProviderFromEnv, type PrismaClientType } from "@/storage/prisma";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { withWebLatencyTrace } from "@/utils/webLatencyTrace";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("PostgreSQL Account admission attribution", () => {
    let observer: PrismaClientType;
    let connected = false;
    const serverIdentity = `qa-tx:${process.pid}`;

    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || supplied !== process.env.DATABASE_URL) throw new Error("Use the disposable PostgreSQL DB-contract harness");
        const url = new URL(supplied);
        // Reusing the one backend after commit rules out an apparent reset
        // caused merely by selecting another pooled connection.
        url.searchParams.set("connection_limit", "1");
        vi.stubEnv("DATABASE_URL", url.toString());
        vi.stubEnv("HAPPIER_STACK_STACK", "qa-tx");
        vi.stubEnv("HAPPIER_DB_CONNECTION_LIMIT", "1");
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
        vi.stubEnv("HAPPIER_WEB_LATENCY_TRACE", "1");
        observer = await createDbMaintenanceClient("postgres", process.env.HAPPIER_TEST_POSTGRES_DIRECT_DATABASE_URL ?? supplied);
        initDbPostgres();
        await Promise.all([db.$connect(), observer.$connect()]);
        connected = true;
    });

    afterAll(async () => {
        if (connected) await Promise.all([db.$disconnect(), observer.$disconnect()]);
        vi.unstubAllEnvs();
    });

    it("attributes an idle Account holder without advancing its first snapshot and resets on the same backend", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const requestId = randomUUID();
        const transactionClass = "artifact-access-grant-set";
        let peerCommitted = false;
        let attributionStatements = 0;
        const commitPeer = async () => {
            if (peerCommitted) return;
            await observer.account.update({ where: { id: account.id }, data: { settingsVersion: { increment: 1 } } });
            peerCommitted = true;
        };
        const outcome = await withWebLatencyTrace(requestId, () => inTx(async tx => {
            // Intercept only the SQL transport; the real admission and inTx
            // owners run unchanged. Commit the peer after attribution SQL,
            // before the Account SELECT (or there for the unimplemented control).
            const observed = new Proxy(tx, {
                get(target, property) {
                    if (property === "$executeRawUnsafe") return async (sql: string, ...values: unknown[]) => {
                        const result = await target.$executeRawUnsafe(sql, ...values);
                        if (sql.startsWith("SET LOCAL application_name")) {
                            attributionStatements += 1;
                            await commitPeer();
                        }
                        return result;
                    };
                    if (property === "$queryRawUnsafe") return async (sql: string, ...values: unknown[]) => {
                        if (sql.includes('FROM "Account"')) await commitPeer();
                        return await target.$queryRawUnsafe(sql, ...values);
                    };
                    return Reflect.get(target, property, target);
                },
            }) satisfies Tx;
            await acquireAccountSessionOwnerMetadataFenceInTx(observed, account.id, "content");
            expect((await tx.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(1);
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            const [holder] = await observer.$queryRaw<Array<{ application_name: string; state: string }>>`
                SELECT application_name, state FROM pg_stat_activity WHERE pid = ${pid}
            `;
            // Observe the backend from another session while the real managed
            // transaction holds its Account lock and awaits the observer.
            expect(holder).toEqual({ application_name: `${serverIdentity}:${transactionClass.slice(0, 63 - serverIdentity.length - requestId.length - 2)}:${requestId}`, state: "idle in transaction" });
            await acquireAccountSessionOwnerMetadataFenceInTx(observed, account.id, "content");
            return pid;
        }, { isolationLevel: "Serializable", transactionClass }));
        expect(peerCommitted).toBe(true);
        expect(attributionStatements).toBe(1);
        const [after] = await db.$queryRaw<Array<{ pid: number; application_name: string }>>`
            SELECT pg_backend_pid() AS pid, current_setting('application_name') AS application_name
        `;
        expect(after).toEqual({ pid: outcome, application_name: serverIdentity });
    });

    it("reattributes each retry after rollback and preserves full request identities within PostgreSQL's name limit", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const requestId = randomUUID();
        const transactionClass = "artifact-recipient-key-envelopes-commit";
        const names: string[] = [];
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "1");
        try {
            const pid = await withWebLatencyTrace(requestId, () => inTx(async tx => {
                // The first attempt's LOCAL value must not survive rollback.
                expect(await tx.$queryRaw`SELECT current_setting('application_name') AS name`).toEqual([{ name: serverIdentity }]);
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "content");
                const [current] = await tx.$queryRaw<Array<{ name: string; pid: number }>>`
                    SELECT current_setting('application_name') AS name, pg_backend_pid() AS pid
                `;
                names.push(current.name);
                if (names.length === 1) await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '40001'; END $$`;
                return current.pid;
            }, { transactionClass }));
            expect(names).toEqual(Array(2).fill(`${serverIdentity}:${transactionClass.slice(0, 63 - serverIdentity.length - requestId.length - 2)}:${requestId}`));
            expect(await db.$queryRaw`SELECT pg_backend_pid() AS pid, current_setting('application_name') AS name`)
                .toEqual([{ pid, name: serverIdentity }]);
        } finally {
            vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
        }
    });

    it("keeps the startup identity outside managed Account admission", async () => {
        await inTx(async tx => {
            expect(await tx.$queryRaw`SELECT current_setting('application_name') AS name`).toEqual([{ name: serverIdentity }]);
        }, { transactionClass: "no-account-admission" });
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        await db.$transaction(async tx => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "content");
            expect(await tx.$queryRaw`SELECT current_setting('application_name') AS name`).toEqual([{ name: serverIdentity }]);
        });
    });

    it("never copies arbitrary request or class text into the backend name", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        await withWebLatencyTrace("private ' input", () => inTx(async tx => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "content");
            expect(await tx.$queryRaw`SELECT current_setting('application_name') AS name`)
                .toEqual([{ name: `${serverIdentity}:unspecified:unattributed` }]);
        }, { transactionClass: "private ' input" }));
    });
});
