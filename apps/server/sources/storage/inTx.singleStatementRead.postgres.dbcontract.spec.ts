import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auth } from "@/app/auth/auth";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { readDatabaseErrorCode } from "@/storage/transactionErrors";
import { createDbMaintenanceClient, type PrismaClientType } from "@/storage/prisma";
import { recordDriverStatements, type DriverStatementEvent } from "@/testkit/driverStatements";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("single-statement reads", () => {
    const statements: DriverStatementEvent[] = [];
    let client: PrismaClientType;
    let originalTransaction: typeof db.$transaction;

    beforeAll(async () => {
        vi.stubEnv("HANDY_MASTER_SECRET", "single-statement-read-contract");
        initDbPostgres();
        await db.$connect();
        await auth.init();
        client = await createDbMaintenanceClient("postgres", undefined, { onDriverStatement: recordDriverStatements(event => statements.push(event)) });
        await client.$connect();
        originalTransaction = db.$transaction;
        // Real Postgres through a query-observing twin of the transaction transport.
        db.$transaction = new Proxy(originalTransaction, { apply: (_target, _receiver, args) =>
            Reflect.apply(client.$transaction, client, args) });
    });

    afterAll(async () => {
        db.$transaction = originalTransaction;
        await client.$disconnect();
        await db.$disconnect();
    });

    const createAccount = async (label: string) => await db.account.create({
        data: { publicKey: `${label}-${randomUUID()}`, encryptionMode: "plain" },
    });

    it("runs a declared single read without any transaction framing, and a real read-only transaction keeps its frame", async () => {
        const account = await createAccount("single");
        statements.length = 0;
        const read = await inTx(tx => tx.account.findUnique({
            where: { id: account.id }, select: { seq: true },
        }), { readOnly: true, singleStatementRead: true });
        expect(read).toEqual({ seq: expect.any(Number) });
        expect(statements).toHaveLength(0);

        statements.length = 0;
        await inTx(tx => tx.account.findUnique({ where: { id: account.id }, select: { seq: true } }), { readOnly: true });
        const framing = statements.map(({ query }) => query.split(" ")[0].toUpperCase());
        expect(framing.filter(kind => kind === "BEGIN")).toHaveLength(1);
        expect(framing.filter(kind => kind === "COMMIT")).toHaveLength(1);
    });

    it("returns the typed storage failure when an operator cancels a read waiting on a table lock", async () => {
        const account = await createAccount("cancel");
        let releaseLock!: () => void;
        const released = new Promise<void>(resolve => { releaseLock = resolve; });
        let locked!: () => void;
        const lockHeld = new Promise<void>(resolve => { locked = resolve; });
        const holder = client.$transaction(async tx => {
            await tx.$executeRawUnsafe('LOCK TABLE "Account" IN ACCESS EXCLUSIVE MODE');
            locked();
            await released;
        }, { timeout: 30_000 });
        await lockHeld;
        try {
            const reading = inTx(tx => tx.account.findUnique({ where: { id: account.id }, select: { seq: true } }),
                { readOnly: true, singleStatementRead: true }).then(() => null, error => error);
            let cancelled = false;
            for (let attempt = 0; attempt < 200 && !cancelled; attempt++) {
                const rows = await client.$queryRawUnsafe<Array<{ cancelled: boolean }>>(`
                    SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity
                    WHERE datname = current_database() AND wait_event_type = 'Lock'
                      AND query LIKE '%"Account"%' AND query NOT LIKE '%pg_cancel_backend%'`);
                cancelled = rows.some(row => row.cancelled);
                if (!cancelled) await new Promise(resolve => setTimeout(resolve, 25));
            }
            expect(cancelled).toBe(true);
            expect(readDatabaseErrorCode(await reading)).toBe("database_transaction_conflict_exhausted");
        } finally {
            releaseLock();
            await holder;
        }
    });

    it("verifies a credential on the Account row with no transaction frame and still applies revocation", async () => {
        const account = await createAccount("verify");
        const other = await createAccount("verify-other");
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const otherToken = await auth.createToken(other.id, undefined, { kind: "account", authority: "present_user" });

        statements.length = 0;
        await expect(auth.verifyToken(token)).resolves.toMatchObject({ userId: account.id });
        expect(statements).toHaveLength(0);
        await expect(auth.verifyToken(otherToken)).resolves.toMatchObject({ userId: other.id });

        await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } });
        await expect(auth.verifyToken(token)).resolves.toBeNull();
        await expect(auth.verifyToken(otherToken)).resolves.toMatchObject({ userId: other.id });

        await db.account.update({ where: { id: other.id }, data: { status: "suspended" } });
        await expect(auth.verifyToken(otherToken)).resolves.toBeNull();
    });
});
