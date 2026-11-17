import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { readMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { db, initDbPostgres } from "@/storage/db";
import { inReadSnapshot, inTx } from "@/storage/inTx";
import { createDbMaintenanceClient, getDbProviderFromEnv, type PrismaClientType } from "@/storage/prisma";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("PostgreSQL transaction connection admission", () => {
    let observer: PrismaClientType;
    let connected = false;
    const originalLimit = process.env.HAPPIER_DB_CONNECTION_LIMIT;
    const originalRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;

    beforeAll(async () => {
        // The existing Docker runner supplies an isolated disposable database.
        // No URL/credentials are inspected, copied or changed by this fixture.
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) throw new Error("Use the disposable PostgreSQL DB-contract harness");
        process.env.HAPPIER_DB_CONNECTION_LIMIT = "3";
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        observer = await createDbMaintenanceClient("postgres");
        initDbPostgres();
        await Promise.all([db.$connect(), observer.$connect()]);
        connected = true;
    });

    it.each(["request", "acquisition"] as const)("admits read snapshots through the same owner and removes a queued attempt at its %s deadline", async boundary => {
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: () => void;
        const occupied = new Promise<void>(resolve => { ready = resolve; });
        let snapshotCount = 0;
        const snapshots = Promise.allSettled([0, 1].map(() => inReadSnapshot(async tx => {
            await tx.$queryRaw`SELECT 1::int AS value`;
            if (++snapshotCount === 2) ready();
            // Test-only rendezvous holds the real snapshot connections.
            await released;
        })));
        let entered = false;
        try {
            await occupied;
            // Direct Home queries remain available while both transaction
            // permits belong to read snapshots, not just contended writers.
            expect(await db.$queryRaw`SELECT 1::int AS value`).toEqual([{ value: 1 }]);
            const expired = inTx(async () => { entered = true; }, boundary === "request"
                ? { deadlineAtMs: Date.now() + 25 }
                : { maxWaitMs: 25 });
            await expect(expired).rejects.toMatchObject({ name: boundary === "request"
                ? "TransactionDeadlineExceededError" : "TransactionAcquisitionUnavailableError" });
        } finally {
            release();
            expect((await snapshots).filter(outcome => outcome.status === "rejected")).toEqual([]);
        }
        // Releasing the holders cannot run an expired request later; the next
        // legitimate transaction can still acquire and release its permit.
        await expect(inTx(async tx => tx.$queryRaw`SELECT 2::int AS value`)).resolves.toEqual([{ value: 2 }]);
        expect(entered).toBe(false);
    });

    afterAll(async () => {
        if (connected) await Promise.all([db.$disconnect(), observer.$disconnect()]);
        if (originalLimit === undefined) delete process.env.HAPPIER_DB_CONNECTION_LIMIT;
        else process.env.HAPPIER_DB_CONNECTION_LIMIT = originalLimit;
        if (originalRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
        else process.env.HAPPIER_DB_TX_MAX_RETRIES = originalRetries;
    });

    it("keeps Machine validation, RPC availability and presence usable during 100 contended Account writes", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}", active: true } });
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: (pid: number) => void;
        const locked = new Promise<number>(resolve => { ready = resolve; });
        const holder = observer.$transaction(async tx => {
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`
                SELECT pg_backend_pid() AS pid FROM "Account" WHERE id = ${account.id} FOR NO KEY UPDATE
            `;
            ready(pid);
            await released;
        }, { timeout: 30_000 });
        const holderOutcome = Promise.allSettled([holder]);
        let writers: Promise<PromiseSettledResult<unknown>[]> | undefined;
        let probes: PromiseSettledResult<unknown>[] = [];
        let waitingConnections = 0;
        const startedAtMs = Date.now();
        try {
            const holderPid = await Promise.race([locked, holder.then(() => { throw new Error("Holder exited before rendezvous"); })]);
            writers = Promise.allSettled(Array.from({ length: 100 }, (_, index) => inTx(async tx => {
                expect((await acquireAccountEncryptionTransitionFenceInTx(tx, account.id, "content")).status).toBe("ready");
                await markAccountChanged(tx, { accountId: account.id, kind: "account", entityId: `writer-${index}` });
            }, { transactionClass: "test-contended-account-write" })));
            while (waitingConnections < 2) {
                const [{ count }] = await observer.$queryRaw<Array<{ count: number }>>`
                    SELECT count(*)::int AS count FROM pg_stat_activity
                    WHERE datname = current_database() AND pid <> ${holderPid}::int AND wait_event_type = 'Lock'
                `;
                waitingConnections = count;
            }
            // Give the native pool time to schedule all ready acquisitions.
            await observer.$queryRaw`SELECT 1::int FROM pg_sleep(0.05)`;
            const [{ count }] = await observer.$queryRaw<Array<{ count: number }>>`
                SELECT count(*)::int AS count FROM pg_stat_activity
                WHERE datname = current_database() AND pid <> ${holderPid}::int AND wait_event_type = 'Lock'
            `;
            waitingConnections = count;
            probes = await Promise.allSettled([
                readMachineAvailabilityState({ accountId: account.id, machineId: machine.id }),
                db.machine.updateMany({ where: { id: machine.id, accountId: account.id }, data: { lastActiveAt: new Date() } }),
            ]);
            console.info("C43_WRITE_ADMISSION", { writers: 100, poolSize: 3, waitingConnections,
                probesBeforeHolderReleaseMs: Date.now() - startedAtMs, probes });
        } finally {
            release();
            await holderOutcome;
            if (writers) await writers;
        }
        try {
            expect(probes).toEqual([
                { status: "fulfilled", value: "available" },
                { status: "fulfilled", value: { count: 1 } },
            ]);
            expect(waitingConnections).toBe(2);
            expect((await writers!).filter(outcome => outcome.status === "rejected")).toEqual([]);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(100);
            expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(100);
        } finally {
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
