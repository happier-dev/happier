import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { changesRoutes } from "./changesRoutes";

describe("changesRoutes automation changes (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-changes-automation-" });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.restoreEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("returns automation changes through /v2/changes", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-changes-automation" },
            select: { id: true },
        });

        const changedAtCursor = await inTx(async (tx) => {
            return await markAccountChanged(tx, {
                accountId: account.id,
                kind: "automation",
                entityId: "automation-1",
                hint: { reason: "run-updated" },
            });
        });

        await withAuthenticatedTestApp(
            (app) => changesRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: "/v2/changes?after=0&limit=50",
                    headers: { "x-test-user-id": account.id },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json() as any;
                expect(body.nextCursor).toBe(changedAtCursor);
                expect(body.changes).toEqual([
                    expect.objectContaining({
                        kind: "automation",
                        entityId: "automation-1",
                        hint: { reason: "run-updated" },
                    }),
                ]);
            },
        );
    });
});
