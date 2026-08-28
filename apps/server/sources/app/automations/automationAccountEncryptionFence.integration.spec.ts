import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    acquireAccountEncryptionTransitionFenceInTx,
    applyAccountEncryptionTransitionInTx,
} from "@/app/encryption/accountEncryptionTransition";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    createAutomation,
    finalizeDeletedAutomationsWithoutRetainedRunsTx,
} from "./automationCrudService";
import { AutomationValidationError } from "./automationValidation";

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

function buildEncryptedTemplate(): string {
    return JSON.stringify({
        kind: "happier_automation_template_encrypted_v1",
        payloadCiphertext: "old-mode-automation-template",
    });
}

function installOldModeAccountReadBoundary(params: Readonly<{
    accountId: string;
    oldModeAccount: unknown;
}>): Readonly<{ restore: () => void }> {
    // SQLite serializes a real reader behind the Account writer lock. This
    // test-only Prisma boundary adapter supplies the already-observed
    // read-committed Account snapshot so the rest of both transactions uses
    // the real database race that a production read-committed provider admits.
    const mutableDb = db as any;
    const originalTransaction = mutableDb.$transaction;
    mutableDb.$transaction = async (operation: unknown, options: unknown) => {
        if (typeof operation !== "function") {
            return await originalTransaction.call(mutableDb, operation, options);
        }
        return await originalTransaction.call(
            mutableDb,
            async (tx: any) => {
                const originalFindUnique = tx.account.findUnique.bind(tx.account);
                const account = new Proxy(tx.account, {
                    get(target, property, receiver) {
                        if (property !== "findUnique") {
                            return Reflect.get(target, property, receiver);
                        }
                        return async (args: any) => {
                            if (
                                args?.where?.id === params.accountId
                                && args?.select?.encryptionMode === true
                                && args?.select?.seq === undefined
                            ) {
                                return params.oldModeAccount;
                            }
                            return await originalFindUnique(args);
                        };
                    },
                });
                const wrappedTx = new Proxy(tx, {
                    get(target, property, receiver) {
                        if (property === "account") return account;
                        return Reflect.get(target, property, receiver);
                    },
                });
                return await operation(wrappedTx);
            },
            options,
        );
    };
    return {
        restore: () => {
            mutableDb.$transaction = originalTransaction;
        },
    };
}

function installAutomationFinalizerCandidateReadProbe(params: Readonly<{
    onCandidateRead: () => void;
}>): Readonly<{ restore: () => void }> {
    // SQLite keeps the Account writer lock at database scope. This test-only
    // Prisma boundary probe observes the real finalizer's candidate read so
    // the test can distinguish Account-first admission from a late delete lock.
    const mutableDb = db as any;
    const originalTransaction = mutableDb.$transaction;
    mutableDb.$transaction = async (operation: unknown, options: unknown) => {
        if (typeof operation !== "function") {
            return await originalTransaction.call(mutableDb, operation, options);
        }
        return await originalTransaction.call(
            mutableDb,
            async (tx: any) => {
                const originalFindMany = tx.automation.findMany.bind(tx.automation);
                const automation = new Proxy(tx.automation, {
                    get(target, property, receiver) {
                        if (property !== "findMany") {
                            return Reflect.get(target, property, receiver);
                        }
                        return async (args: any) => {
                            if (
                                args?.where?.deletedAt?.not !== undefined
                                && args?.where?.runs?.none !== undefined
                            ) {
                                params.onCandidateRead();
                            }
                            return await originalFindMany(args);
                        };
                    },
                });
                const wrappedTx = new Proxy(tx, {
                    get(target, property, receiver) {
                        if (property === "automation") return automation;
                        return Reflect.get(target, property, receiver);
                    },
                });
                return await operation(wrappedTx);
            },
            options,
        );
    };
    return {
        restore: () => {
            mutableDb.$transaction = originalTransaction;
        },
    };
}

describe("Automation Account-encryption transition fence (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-account-encryption-fence-",
            initAuth: false,
            sqliteConnectionLimit: 2,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("does not commit an old-mode scheduled Run after the Account transition fence is acquired", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                seq: 41,
            },
            select: { id: true },
        });
        const oldModeAccount = await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                publicKey: true,
                encryptionMode: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        });
        const transitionFenceAcquired = deferred();
        const releaseTransition = deferred();
        let writerSettled = false;
        const transition = inTx(async (tx) => {
            const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, account.id);
            expect(fence.status).toBe("ready");
            if (fence.status !== "ready") return;
            transitionFenceAcquired.resolve();
            await releaseTransition.promise;
            await applyAccountEncryptionTransitionInTx(tx, {
                accountId: account.id,
                expectedVersion: fence.account.version,
                toMode: "plain",
                contentKey: { kind: "preserve" },
            });
        });

        await transitionFenceAcquired.promise;
        const accountReadBoundary = installOldModeAccountReadBoundary({
            accountId: account.id,
            oldModeAccount,
        });
        const writer = createAutomation({
            accountId: account.id,
            input: {
                name: "old-mode scheduled writer",
                description: null,
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000, timezone: null },
                targetType: "new_session",
                templateCiphertext: buildEncryptedTemplate(),
                assignments: [],
            },
        }).finally(() => {
            writerSettled = true;
        });

        try {
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(writerSettled).toBe(false);

            releaseTransition.resolve();
            await transition;

            await expect(writer).rejects.toBeInstanceOf(AutomationValidationError);
        } finally {
            accountReadBoundary.restore();
            releaseTransition.resolve();
            await transition.catch(() => undefined);
            await writer.catch(() => undefined);
        }

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { encryptionMode: true },
        })).resolves.toEqual({ encryptionMode: "plain" });
        await expect(db.automation.count({ where: { accountId: account.id } })).resolves.toBe(0);
        await expect(db.automationRun.count({ where: { accountId: account.id } })).resolves.toBe(0);
    }, 30_000);

    it("does not scan a soft-deleted Automation before the Account transition fence releases", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                seq: 41,
            },
            select: { id: true },
        });
        await db.automation.create({
            data: {
                id: "automation-retention-finalizer-transition-fence",
                accountId: account.id,
                name: "soft deleted transition participant",
                enabled: false,
                deletedAt: new Date("2026-08-25T12:00:00.000Z"),
                targetType: "new_session",
                templateCiphertext: buildEncryptedTemplate(),
                templateVersion: 1,
            },
        });
        const otherAccount = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.automation.create({
            data: {
                id: "automation-retention-finalizer-other-account",
                accountId: otherAccount.id,
                name: "unrelated soft deleted Automation",
                enabled: false,
                deletedAt: new Date("2026-08-24T12:00:00.000Z"),
                targetType: "new_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_plain_v1",
                    payload: { prompt: "unrelated" },
                }),
                templateVersion: 1,
            },
        });

        let candidateRead = false;
        const candidateProbe = installAutomationFinalizerCandidateReadProbe({
            onCandidateRead: () => {
                candidateRead = true;
            },
        });
        const finalizerTransactionEntered = deferred();
        const beginFinalizer = deferred();
        let finalizerSettled = false;
        const finalizer = inTx(async (tx) => {
            finalizerTransactionEntered.resolve();
            await beginFinalizer.promise;
            return await finalizeDeletedAutomationsWithoutRetainedRunsTx({
                tx,
                accountId: account.id,
                limit: 1,
            });
        }).finally(() => {
            finalizerSettled = true;
        });

        await finalizerTransactionEntered.promise;
        const transitionFenceAcquired = deferred();
        const releaseTransition = deferred();
        const transition = inTx(async (tx) => {
            const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, account.id);
            expect(fence.status).toBe("ready");
            if (fence.status !== "ready") return;
            transitionFenceAcquired.resolve();
            await releaseTransition.promise;
            await applyAccountEncryptionTransitionInTx(tx, {
                accountId: account.id,
                expectedVersion: fence.account.version,
                toMode: "plain",
                contentKey: { kind: "preserve" },
            });
        });

        await transitionFenceAcquired.promise;

        try {
            beginFinalizer.resolve();
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(candidateRead).toBe(false);
            expect(finalizerSettled).toBe(false);

            releaseTransition.resolve();
            await transition;
            await expect(finalizer).resolves.toBe(1);
        } finally {
            candidateProbe.restore();
            beginFinalizer.resolve();
            releaseTransition.resolve();
            await transition.catch(() => undefined);
            await finalizer.catch(() => undefined);
        }

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { encryptionMode: true },
        })).resolves.toEqual({ encryptionMode: "plain" });
        await expect(db.automation.count({ where: { accountId: account.id } })).resolves.toBe(0);
        await expect(db.automation.count({ where: { accountId: otherAccount.id } })).resolves.toBe(1);
    }, 30_000);
});
