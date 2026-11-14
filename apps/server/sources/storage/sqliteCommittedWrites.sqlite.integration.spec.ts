import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { onSqliteCommittedWrite } from "@/storage/sqliteCommittedWrites";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("SQLite committed-write edge (real light SQLite client)", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-sqlite-committed-writes-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness?.close();
    });

    it("reports writes through the primary client and stays silent for reads", async () => {
        let writes = 0;
        const unsubscribe = onSqliteCommittedWrite(() => {
            writes += 1;
        });
        try {
            await db.account.findMany({ take: 1 });
            await db.account.count();
            await inTx(async (tx) => await tx.account.findMany({ take: 1 }));
            expect(writes).toBe(0);

            await db.account.create({ data: { id: "account-committed-write", publicKey: null } });
            expect(writes).toBeGreaterThan(0);

            const beforeTxWrite = writes;
            await inTx(async (tx) => {
                await tx.account.update({ where: { id: "account-committed-write" }, data: { firstName: "w" } });
            });
            expect(writes).toBeGreaterThan(beforeTxWrite);
        } finally {
            unsubscribe();
            await db.account.deleteMany({ where: { id: "account-committed-write" } });
        }
    });
});
