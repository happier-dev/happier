import { describe, expect, it } from "vitest";
import { getDbProviderFromEnv } from "@/storage/db";
import { createDbMaintenanceClient } from "@/storage/prisma";
import { recordDriverStatements } from "@/testkit/driverStatements";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("PostgreSQL driver statement observer", () => {
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
