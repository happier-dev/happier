import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { acquireWorkflowPublicationLocksInTx } from "./acquireWorkflowPublicationLocksInTx";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Workflow publication PostgreSQL-compatible dialect", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each(["postgres", "pglite"])("locks retained Runs with the %s profile", async backend => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const run = await db.automationRun.create({ data: { accountId: account.id, originKind: "direct", causeKind: null,
            workflowAcceptedSnapshotEnvelope: "{}", workflowCustodyState: "pending",
            state: "queued", scheduledAt: new Date(), dueAt: new Date() } });
        const previous = process.env.HAPPIER_DB_PROVIDER;
        process.env.HAPPIER_DB_PROVIDER = backend;
        try {
            await inTx(async tx => {
                await acquireWorkflowPublicationLocksInTx(tx, { accountId: account.id, runIds: [run.id] });
                expect(await tx.$queryRawUnsafe<Array<{ mode: string }>>(
                    `SELECT mode FROM pg_locks WHERE pid = pg_backend_pid()
                        AND relation = '"AutomationRun"'::regclass AND mode = 'RowShareLock'`,
                )).toEqual([{ mode: "RowShareLock" }]);
            });
        } finally {
            if (previous === undefined) delete process.env.HAPPIER_DB_PROVIDER;
            else process.env.HAPPIER_DB_PROVIDER = previous;
        }
    });
});
