import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { inTx } from "@/storage/inTx";
import { db } from "@/storage/db";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { acquireAccountEncryptionTransitionFenceInTx } from "./accountEncryptionTransition";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "./accountSessionOwnerMetadataFence";

function deferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("Account Session owner-metadata fence (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-session-owner-fence-",
            sqliteConnectionLimit: 2,
        });
    }, 120_000);

    afterEach(async () => {
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("holds the SQLite writer reservation and leaves Account.updatedAt unchanged", async () => {
        const initialUpdatedAt = new Date("2020-01-02T03:04:05.000Z");
        const account = await db.account.create({
            data: {
                settingsVersion: 7,
                updatedAt: initialUpdatedAt,
            },
            select: { id: true },
        });
        const firstAcquired = deferred();
        const releaseFirst = deferred();
        let secondAcquired = false;

        const first = inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id);
            firstAcquired.resolve();
            await releaseFirst.promise;
        });
        await firstAcquired.promise;

        const second = inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id);
            secondAcquired = true;
        });

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(secondAcquired).toBe(false);

        releaseFirst.resolve();
        await first;
        await second;

        await expect(db.account.findUnique({
            where: { id: account.id },
            select: {
                settingsVersion: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            settingsVersion: 7,
            updatedAt: initialUpdatedAt,
        });
    }, 30_000);

    it("reports a missing Account through the transition fence without leaking the raw lock failure", async () => {
        await expect(inTx((tx) => (
            acquireAccountEncryptionTransitionFenceInTx(tx, "missing-account")
        ))).resolves.toEqual({
            status: "account_not_found",
        });
    });
});
