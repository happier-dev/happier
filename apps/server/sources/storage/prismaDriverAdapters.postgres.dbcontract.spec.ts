import { describe, expect, it } from "vitest";
import { getDbProviderFromEnv } from "@/storage/db";
import { createDbMaintenanceClient } from "@/storage/prisma";
import { recordDriverStatements } from "@/testkit/driverStatements";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { isTransactionStorageError } from "@/storage/transactionErrors";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("PostgreSQL driver statement observer", () => {
    it("projects a native pool acquisition timeout as unavailable and recovers after release", async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || supplied !== process.env.DATABASE_URL) throw new Error("Use the disposable PostgreSQL DB-contract harness");
        const url = new URL(supplied);
        // One occupied slot makes the adapter's real acquisition failure observable.
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("pool_timeout", "1");
        const client = await createDbMaintenanceClient("postgres", url.href);
        const app = createAuthenticatedTestApp();
        let queryFailure: unknown;
        app.get("/pool-read", async () => {
            try { return await client.$queryRaw`SELECT 1::int AS value`; }
            catch (error) { queryFailure = error; throw error; }
        });
        app.get("/unclassified-failure", async () => { throw new Error("unclassified failure"); });
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: () => void;
        const occupied = new Promise<void>(resolve => { ready = resolve; });
        let holderOutcome: Promise<PromiseSettledResult<void>[]> | undefined;
        try {
            expect((await app.inject({ method: "GET", url: "/pool-read" })).json()).toEqual([{ value: 1 }]);
            expect((await app.inject({ method: "GET", url: "/unclassified-failure" })).statusCode).toBe(500);
            const holder = client.$transaction(async tx => {
                await tx.$queryRaw`SELECT 1`;
                ready();
                await released;
            }, { timeout: 30_000 });
            holderOutcome = Promise.allSettled([holder]);
            await Promise.race([occupied, holder.then(() => { throw new Error("Holder exited before rendezvous"); })]);
            const unavailable = await app.inject({ method: "GET", url: "/pool-read" });
            // Characterize the actual pg-pool boundary, rather than constructing a Prisma P-code.
            expect(queryFailure).toMatchObject({ name: "Error", message: "timeout exceeded when trying to connect" });
            expect(isTransactionStorageError(queryFailure)).toBe(false);
            expect(unavailable.statusCode).toBe(503);
            expect(unavailable.json()).toEqual({ error: "database_connection_unavailable", statusCode: 503 });
            release();
            expect(await holderOutcome).toEqual([{ status: "fulfilled", value: undefined }]);
            holderOutcome = undefined;
            // The same still-connected pool serves the next deliberate read without a retry owner.
            expect((await app.inject({ method: "GET", url: "/pool-read" })).json()).toEqual([{ value: 1 }]);
        } finally {
            release();
            if (holderOutcome) expect(await holderOutcome).toEqual([{ status: "fulfilled", value: undefined }]);
            await app.close();
            await client.$disconnect();
        }
    });

    it("keeps observing statements after the client disconnects and connects again", async () => {
        const seen: string[] = [];
        const client = await createDbMaintenanceClient("postgres", undefined, {
            onDriverStatement: recordDriverStatements(({ query }) => { if (query.includes("observer_probe")) seen.push(query); }),
        });
        try {
            await client.$queryRawUnsafe('SELECT 1 AS "observer_probe_before"');
            // The adapter ends its pool on disconnect and builds the next one on connect.
            await client.$disconnect();
            await client.$connect();
            await client.$queryRawUnsafe('SELECT 1 AS "observer_probe_after"');
            expect(seen).toEqual(['SELECT 1 AS "observer_probe_before"', 'SELECT 1 AS "observer_probe_after"']);
        } finally {
            await client.$disconnect();
        }
    });
});
