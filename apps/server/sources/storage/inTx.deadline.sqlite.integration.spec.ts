import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { inTx } from "./inTx";

describe("inTx absolute deadline on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-dev-in-tx-deadline-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    afterAll(async () => await harness.close());

    it("rolls back a mutation whose transaction execution exceeds the request deadline and never commits later", async () => {
        harness.resetEnv();
        const account = await db.account.create({ data: { publicKey: "deadline-before" }, select: { id: true } });

        await expect(inTx(async (tx) => {
            await tx.account.update({ where: { id: account.id }, data: { publicKey: "deadline-after" } });
            await new Promise((resolve) => setTimeout(resolve, 100));
        }, { deadlineAtMs: Date.now() + 25 })).rejects.toMatchObject({
            name: "TransactionDeadlineExceededError",
        });

        await new Promise((resolve) => setTimeout(resolve, 125));
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { publicKey: true },
        })).resolves.toEqual({ publicKey: "deadline-before" });
    });
});
