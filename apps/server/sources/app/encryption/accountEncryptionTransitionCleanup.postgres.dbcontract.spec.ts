import { randomUUID } from "node:crypto";
import { preparePluginAccountCollectionContractV1 } from "@happier-dev/protocol/plugins/data/collectionsV1";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import {
    ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE,
    cancelAccountEncryptionTransitionCoordinatorInTx,
    cleanupExpiredAccountEncryptionTransitionsInTx,
    prepareAccountEncryptionTransitionCoordinatorInTx,
} from "./accountEncryptionTransitionCoordinator";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "./accountSessionOwnerMetadataFence";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

const now = new Date("2026-10-22T12:00:00.000Z");
const retainedContract = preparePluginAccountCollectionContractV1({
    pluginId: "example.cleanup-contract",
    contribution: { id: "tasks", schemaVersion: 1, serverReadable: ["id"], indexes: [], schema: { type: "object",
        properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
}).normalized;

async function createRetainedStages(stageCount: number, expired = true) {
    const account = await db.account.create({ data: { encryptionMode: "plain" } });
    const transition = await db.accountEncryptionTransition.create({ data: {
        accountId: account.id,
        activeAccountId: account.id,
        fromEncryptionMode: "plain",
        toEncryptionMode: "e2ee",
        sourceAccountVersion: 0,
        sourceSettingsVersion: 0,
        status: "preparing",
        preparedAt: new Date(now.getTime() - ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.lifetimeMs),
        expiresAt: new Date(now.getTime() + (expired ? 0 : ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.lifetimeMs)),
    } });
    // Cleanup consumes retained rows, including partially prepared inventories;
    // no live Collection or target authorization is required to retire them.
    await db.accountEncryptionTransitionCollectionStage.createMany({ data: Array.from(
        { length: stageCount }, (_, index) => ({
            transitionId: transition.id,
            pluginId: "example.cleanup-contract",
            collectionId: "tasks",
            rowId: `retained-${index}`,
            sourceRevision: 1,
            sourceEnvelope: { t: "plain", v: {} },
            schemaVersion: 1,
            contractDigest: retainedContract.contractDigest,
            sourceEncodedBytes: 0n,
        }),
    ) });
    return { accountId: account.id, transitionId: transition.id };
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Account transition cleanup admission", () => {
    const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing disposable PostgreSQL contract DATABASE_URL");
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => {
        await db.$disconnect();
        if (previousRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
        else process.env.HAPPIER_DB_TX_MAX_RETRIES = previousRetries;
    });

    it.each(["cancel", "expire"] as const)("allows unrelated content writes while %s cleanup retains its transaction", async operation => {
        const fixture = await createRetainedStages(1, operation === "expire");
        const holderEntered = deferred();
        const releaseHolder = deferred();
        const writerStarted = deferred();
        let writerEntered = false;
        let writerSettled = false;
        let writerPid = 0;
        const holder = Promise.allSettled([inTx(async tx => {
            if (operation === "cancel") {
                expect(await cancelAccountEncryptionTransitionCoordinatorInTx({ tx, ...fixture, now }))
                    .toEqual({ status: "cancelled" });
            } else {
                expect(await cleanupExpiredAccountEncryptionTransitionsInTx({ tx, accountId: fixture.accountId, now }))
                    .toEqual({ expiredTransitionCount: 1, removedStageCount: 1 });
            }
            holderEntered.resolve();
            await releaseHolder.promise;
        })]).finally(() => { holderEntered.resolve(); });
        await holderEntered.promise;
        const writer = Promise.allSettled([inTx(async tx => {
            const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>("SELECT pg_backend_pid() AS pid");
            writerPid = backend.pid;
            writerStarted.resolve();
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, fixture.accountId, "content");
            await tx.machine.create({ data: { id: randomUUID(), accountId: fixture.accountId, metadata: "{}" } });
            writerEntered = true;
        })]).finally(() => { writerSettled = true; writerStarted.resolve(); });
        try {
            await writerStarted.promise;
            let blockers: number[] = [];
            while (!writerEntered && !writerSettled && blockers.length === 0) {
                [{ blockers }] = await db.$queryRawUnsafe<Array<{ blockers: number[] }>>(
                    "SELECT pg_blocking_pids($1::int) AS blockers", writerPid,
                );
            }
            expect(blockers, "retiring private stages must not exclude unrelated Account content").toEqual([]);
            expect(writerEntered).toBe(true);
        } finally {
            releaseHolder.resolve();
            const outcomes = [...await holder, ...await writer];
            await db.machine.deleteMany({ where: { accountId: fixture.accountId } });
            await db.account.delete({ where: { id: fixture.accountId } });
            for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
        }
    });

    it("rechecks the remaining staged inventory after a concurrent cleanup chunk commits", async () => {
        const fixture = await createRetainedStages(ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.cleanupBatchSize + 1);
        const firstEntered = deferred();
        const releaseFirst = deferred();
        const secondStarted = deferred();
        let secondSettled = false;
        let secondPid = 0;
        const first = Promise.allSettled([inTx(async tx => {
            expect(await cleanupExpiredAccountEncryptionTransitionsInTx({ tx, accountId: fixture.accountId, now }))
                .toEqual({ expiredTransitionCount: 0, removedStageCount: ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.cleanupBatchSize });
            firstEntered.resolve();
            await releaseFirst.promise;
        })]).finally(() => { firstEntered.resolve(); });
        await firstEntered.promise;
        const second = Promise.allSettled([inTx(async tx => {
            const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>("SELECT pg_backend_pid() AS pid");
            secondPid = backend.pid;
            secondStarted.resolve();
            return await cleanupExpiredAccountEncryptionTransitionsInTx({ tx, accountId: fixture.accountId, now });
        })]).finally(() => { secondSettled = true; secondStarted.resolve(); });
        try {
            await secondStarted.promise;
            let blockers: number[] = [];
            while (!secondSettled && blockers.length === 0) {
                [{ blockers }] = await db.$queryRawUnsafe<Array<{ blockers: number[] }>>(
                    "SELECT pg_blocking_pids($1::int) AS blockers", secondPid,
                );
            }
            expect(blockers.length).toBeGreaterThan(0);
        } finally {
            releaseFirst.resolve();
            const outcomes = [...await first, ...await second];
            try {
                for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
                expect(outcomes[1]).toMatchObject({ status: "fulfilled", value: { expiredTransitionCount: 1, removedStageCount: 1 } });
                expect(await db.accountEncryptionTransition.findUniqueOrThrow({
                    where: { id: fixture.transitionId }, select: { status: true, activeAccountId: true },
                })).toEqual({ status: "expired", activeAccountId: null });
                expect(await db.accountEncryptionTransitionCollectionStage.count({ where: { transitionId: fixture.transitionId } })).toBe(0);
            } finally {
                await db.account.delete({ where: { id: fixture.accountId } });
            }
        }
    });

    it("prepares under its exclusive audience while cleaning an unrelated expired Account", async () => {
        const expired = await createRetainedStages(1);
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        try {
            expect(await inTx(tx => prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId: account.id,
                now,
                request: {
                    toMode: "e2ee",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint: null,
                    expectedContentKeyFingerprint: null,
                },
            }))).toMatchObject({ status: "prepared", transition: { fromMode: "plain", toMode: "e2ee" } });
            expect(await db.accountEncryptionTransition.findUniqueOrThrow({
                where: { id: expired.transitionId }, select: { status: true, activeAccountId: true },
            })).toEqual({ status: "expired", activeAccountId: null });
            expect(await db.accountEncryptionTransitionCollectionStage.count({ where: { transitionId: expired.transitionId } })).toBe(0);
            expect(await db.account.findUniqueOrThrow({
                where: { id: account.id }, select: { encryptionMode: true },
            })).toEqual({ encryptionMode: "plain" });
        } finally {
            await db.account.deleteMany({ where: { id: { in: [account.id, expired.accountId] } } });
        }
    });
});
