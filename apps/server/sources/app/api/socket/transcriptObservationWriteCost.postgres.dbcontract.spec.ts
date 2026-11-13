import { afterAll, beforeAll, describe, vi } from "vitest";

import { auth } from "@/app/auth/auth";
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from "@/storage/db";
import { transcriptObservationWriteCostContract } from "./transcriptObservationWriteCost.testkit";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("transcript observation write cost (PostgreSQL)", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract runner");
        }
        vi.stubEnv("HANDY_MASTER_SECRET", "transcript-write-cost-disposable-fixture");
        initDbPostgres();
        await db.$connect();
        await auth.init();
    });
    afterAll(async () => { await shutdownDbClient(); vi.unstubAllEnvs(); });
    transcriptObservationWriteCostContract("postgres");
});
