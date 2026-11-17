import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountPetLibraryEntryV1Schema } from "@happier-dev/protocol/pets/accountLibrary";
import { PET_PACKAGE_FORMAT_CODEX_ATLAS_V1 } from "@happier-dev/protocol/pets/constants";

import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

import { createPrismaAccountPetLibraryPersistence, type PersistAccountPetResult, type DeletePersistedAccountPetResult } from "./accountPetLibraryPersistence";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Account pet library admission (PostgreSQL)", () => {
    const accountIds: string[] = [];
    let connected = false;

    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (connected) {
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
            await db.$disconnect();
        }
    });

    async function fixture() {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        accountIds.push(account.id);
        return account;
    }

    function petParams(accountId: string) {
        const accountPetId = randomUUID();
        return {
            accountId,
            objectKey: `private/accounts/${accountId}/pets/${accountPetId}/spritesheet.webp`,
            quotaLimits: { maxImportedPetsPerAccount: 10, maxImportedPetBytesPerAccount: 1_000 },
            entry: AccountPetLibraryEntryV1Schema.parse({
                accountPetId,
                packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
                manifest: { id: "blink", displayName: "Blink", description: "Companion pet", spritesheetPath: "spritesheet.webp" },
                spritesheetAssetRef: { assetId: randomUUID(), mediaType: "image/webp", digest: "sha256:asset", sizeBytes: 123 },
                digest: "sha256:pet", sizeBytes: 123, createdAt: 1, updatedAt: 1, origin: { kind: "manualImport" },
            }),
        };
    }

    /** Schedule only the real Prisma boundary; admission, quota, mutation and publication stay real. */
    async function observeTransactions<T>(observe: (tx: Tx) => Tx | void, run: () => T): Promise<Awaited<T>> {
        const original = db.$transaction.bind(db);
        db.$transaction = (async <R>(callback: (tx: Tx) => Promise<R>, options?: { isolationLevel?: "Serializable" | "RepeatableRead" | "ReadCommitted"; timeout?: number; maxWait?: number }) =>
            original(async tx => callback(observe(tx) ?? tx), options)) as typeof db.$transaction;
        try { return await run(); }
        finally { db.$transaction = original; }
    }

    /** Release the holder once the peer settles or PostgreSQL proves that it waits on this transaction. */
    async function commitOrBlock(tx: Tx, write: () => Promise<unknown>, pending: Promise<unknown>[]) {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        let settled = false;
        const competitor = write().finally(() => { settled = true; });
        void competitor.catch(() => undefined);
        pending.push(competitor);
        while (!settled) {
            const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                    WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
            `;
            if (blocked) return;
        }
        await competitor;
    }

    it("finds only the Account's active package for a digest", async () => {
        const account = await fixture();
        const otherAccount = await fixture();
        const params = petParams(account.id);
        const persistence = createPrismaAccountPetLibraryPersistence();
        await expect(persistence.persistAccountPet(params)).resolves.toEqual({ ok: true });
        await expect(persistence.readAccountPetByDigest(otherAccount.id, params.entry.digest)).resolves.toBeNull();
        await expect(persistence.readAccountPetByDigest(account.id, params.entry.digest))
            .resolves.toMatchObject({ accountId: account.id, entry: params.entry });
        await expect(persistence.deleteAccountPet(account.id, params.entry.accountPetId)).resolves.toMatchObject({ ok: true });
        await expect(persistence.readAccountPetByDigest(account.id, params.entry.digest)).resolves.toBeNull();
    });

    it.each(["persist", "delete"] as const)("%s completes while an unrelated content writer holds admission", async operation => {
        const account = await fixture();
        const params = petParams(account.id);
        const persistence = createPrismaAccountPetLibraryPersistence();
        if (operation === "delete") await expect(persistence.persistAccountPet(params)).resolves.toEqual({ ok: true });
        const pending: Promise<unknown>[] = [];
        let completed = false;
        try {
            await inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "content");
                await commitOrBlock(tx, async () => {
                    const result = operation === "persist"
                        ? await persistence.persistAccountPet(params)
                        : await persistence.deleteAccountPet(account.id, params.entry.accountPetId);
                    expect(result).toMatchObject({ ok: true });
                    completed = true;
                }, pending);
                expect(completed, "Pet mutations must not exclude unrelated content admission").toBe(true);
            });
        } finally { await Promise.allSettled(pending); }
        await expect(persistence.readAccountPet(account.id, params.entry.accountPetId)).resolves.toEqual(
            operation === "delete" ? null : expect.objectContaining({ entry: params.entry }),
        );
    });

    it.each(["count", "bytes"] as const)("serializes concurrent %s quota checks before either pet is inserted", async dimension => {
        const account = await fixture();
        const firstParams = petParams(account.id);
        firstParams.quotaLimits = dimension === "count"
            ? { maxImportedPetsPerAccount: 1, maxImportedPetBytesPerAccount: 1_000 }
            : { maxImportedPetsPerAccount: 10, maxImportedPetBytesPerAccount: firstParams.entry.sizeBytes };
        const secondParams = { ...petParams(account.id), quotaLimits: firstParams.quotaLimits };
        const pending: Promise<unknown>[] = [];
        let firstTx: Tx | undefined;
        let secondResult: PersistAccountPetResult | undefined;
        const persistence = createPrismaAccountPetLibraryPersistence({ hooks: { afterQuotaRead: async () => {
            if (!firstTx) throw new Error("Missing observed pet transaction");
            await commitOrBlock(firstTx, async () => {
                secondResult = await createPrismaAccountPetLibraryPersistence().persistAccountPet(secondParams);
            }, pending);
        } } });
        try {
            const firstResult = await observeTransactions(tx => { firstTx ??= tx; }, () => persistence.persistAccountPet(firstParams));
            await Promise.all(pending);
            expect(firstResult).toEqual({ ok: true });
            expect(secondResult).toEqual({ ok: false, error: "quota-exceeded" });
            const pets = await createPrismaAccountPetLibraryPersistence().listAccountPets(account.id);
            expect(pets.map(pet => pet.entry)).toEqual([firstParams.entry]);
            expect(await db.accountPetAsset.count({ where: { accountId: account.id } })).toBe(1);
        } finally { await Promise.allSettled(pending); }
    });

    it("rechecks delete currentness after the preceding pet mutation commits", async () => {
        const account = await fixture();
        const params = petParams(account.id);
        const persistence = createPrismaAccountPetLibraryPersistence();
        await expect(persistence.persistAccountPet(params)).resolves.toEqual({ ok: true });
        const before = await db.account.findUniqueOrThrow({ where: { id: account.id } });
        const pending: Promise<unknown>[] = [];
        let observed = false;
        let secondResult: DeletePersistedAccountPetResult | undefined;
        try {
            const firstResult = await observeTransactions(tx => new Proxy(tx, { get(target, property, receiver) {
                if (property !== "accountPetPackage") return Reflect.get(target, property, receiver);
                return new Proxy(target.accountPetPackage, { get(model, method, modelReceiver) {
                    if (method !== "findFirst") return Reflect.get(model, method, modelReceiver);
                    return async (...args: unknown[]) => {
                        const row: unknown = await Reflect.apply(model.findFirst, model, args);
                        if (!observed) {
                            observed = true;
                            await commitOrBlock(tx, async () => {
                                secondResult = await persistence.deleteAccountPet(account.id, params.entry.accountPetId);
                            }, pending);
                        }
                        return row;
                    };
                } });
            } }), () => persistence.deleteAccountPet(account.id, params.entry.accountPetId));
            await Promise.all(pending);
            expect(observed).toBe(true);
            expect(firstResult).toMatchObject({ ok: true });
            expect(secondResult).toEqual({ ok: false, error: "not-found" });
            expect(await db.accountPetPackage.findUniqueOrThrow({ where: { id: params.entry.accountPetId } }))
                .toMatchObject({ version: 2, deletedAt: expect.any(Date) });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(before.seq + 1);
            await expect(persistence.readAccountPet(account.id, params.entry.accountPetId)).resolves.toBeNull();
        } finally { await Promise.allSettled(pending); }
    });
});
