import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { inTx, type Tx } from "./inTx";

type DeadlineBoundInTx = <T>(
    operation: (tx: Tx) => Promise<T>,
    options?: Readonly<{ deadlineAtMs?: number }>,
) => Promise<T>;

describe("inTx request deadline on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-in-tx-deadline-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    it("rolls back a write when the whole transaction body exceeds its deadline and never commits later", async () => {
        harness.resetEnv();
        const account = await db.account.create({
            data: { publicKey: `pk-in-tx-deadline-${randomUUID()}` },
            select: { id: true, publicKey: true },
        });
        const boundedInTx = inTx as DeadlineBoundInTx;

        const result = await boundedInTx(async (tx) => {
            await tx.account.update({
                where: { id: account.id },
                data: { publicKey: `${account.publicKey}-changed` },
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
            return "completed";
        }, { deadlineAtMs: Date.now() + 25 }).then(
            (value) => ({ status: "fulfilled" as const, value }),
            (reason: unknown) => ({ status: "rejected" as const, reason }),
        );

        expect(result).toMatchObject({ status: "rejected" });
        await new Promise((resolve) => setTimeout(resolve, 125));
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { publicKey: true },
        })).resolves.toEqual({ publicKey: account.publicKey });
    });
});
