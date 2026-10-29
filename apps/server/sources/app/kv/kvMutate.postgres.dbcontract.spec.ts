import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { inTx } from "@/storage/inTx";
import { applyUserKvMutationsInTx, kvMutate } from "./kvMutate";
import { kvBulkGet } from "./kvBulkGet";

function waitForDatabasePause<T>(operation: Promise<T>, paused: Promise<void>): Promise<void> {
    return Promise.race([paused, operation.then(() => { throw new Error("KV operation finished before its database interleaving boundary"); })]);
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("UserKVStore resource admission", () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it("set-reads requested keys once while publishing changed values and preserving stale/foreign isolation", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const foreign = await db.account.create({ data: { encryptionMode: "plain" } });
        const keys = Array.from({ length: 1001 }, (_, index) => `sweep-${index}`);
        await db.userKVStore.createMany({ data: [account, foreign].flatMap(owner => keys.map(key => ({
            accountId: owner.id, key, version: 3, value: Buffer.from(owner.id === account.id ? "before" : "foreign"),
        }))) });
        const queries: Prisma.QueryEvent[] = [];
        const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
        client.$on("query", event => queries.push(event));
        await client.$connect();
        const transaction = db.$transaction;
        // Observe SQL at the actual database boundary; CAS, validation and publication stay real.
        db.$transaction = new Proxy(transaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        const reads = () => queries.filter(event => /^SELECT\b/.test(event.query.trimStart())
            && /FROM\s+"public"\."UserKVStore"(?:\s|$)/.test(event.query)).length;
        try {
            const costs: number[] = [];
            for (const count of [1, 100]) {
                const demanded = keys.slice(0, count);
                const version = count === 1 ? 3 : 4;
                if (count === 100) await db.userKVStore.updateMany({ where: { accountId: account.id }, data: { version } });
                queries.length = 0;
                expect(await kvMutate({ uid: account.id }, demanded.map(key => ({ key, version,
                    value: Buffer.from("after").toString("base64") })))).toEqual({ success: true,
                    results: demanded.map(key => ({ key, version: version + 1 })) });
                costs.push(reads());
                // The real reader and durable change feed consume the committed write.
                expect((await kvBulkGet({ uid: account.id }, demanded)).values).toEqual(expect.arrayContaining(
                    demanded.map(key => ({ key, value: Buffer.from("after").toString("base64"), version: version + 1 }))));
                expect(await db.accountChange.count({ where: { accountId: account.id, kind: "kv" } })).toBe(1);
            }
            const beforeCursor = (await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq;
            queries.length = 0;
            const stale = await inTx(tx => applyUserKvMutationsInTx(tx, { uid: account.id }, keys.map(key => ({
                key, version: 2, value: null,
            }))));
            const chunkedReads = reads();
            expect(stale.success).toBe(false);
            if (!stale.success) {
                expect(stale.errors).toHaveLength(keys.length);
                expect(stale.errors[0]).toMatchObject({ key: keys[0], version: 5,
                    value: Buffer.from("after").toString("base64") });
            }
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(beforeCursor);
            expect(await db.userKVStore.count({ where: { accountId: foreign.id, version: 3, value: Buffer.from("foreign") } })).toBe(keys.length);
            console.info("KV_PREFLIGHT_SQL", JSON.stringify({ keys: [1, 100, 1001], reads: [...costs, chunkedReads] }));
            expect(costs).toEqual([1, 1]);
            expect(chunkedReads).toBe(2);
        } finally { db.$transaction = transaction; await client.$disconnect(); }
    });

    it("preserves last-value-wins and request order for repeated existing keys in one batch", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        await db.userKVStore.create({ data: { accountId: account.id, key: "z-existing", version: 3, value: Buffer.from("before") } });
        const mutations = [
            { key: "z-existing", version: 3, value: Buffer.from("first").toString("base64") },
            { key: "a-new", version: -1, value: Buffer.from("new").toString("base64") },
            { key: "z-existing", version: 3, value: Buffer.from("last").toString("base64") },
        ];
        const results = mutations.map(mutation => ({ key: mutation.key, version: mutation.version + 1 }));
        expect(await kvMutate({ uid: account.id }, mutations)).toEqual({ success: true, results });
        const current = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: "z-existing" } } });
        expect(current.version).toBe(4);
        expect(Buffer.from(current.value!).toString()).toBe("last");
    });

    it.each([false, true])("admits one expected-version winner and rejects its entire competing batch (existing=%s)", async existing => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const key = "shared";
        const unrelatedKey = "a-unrelated";
        const prior = Buffer.from("prior").toString("base64");
        const next = Buffer.from("next").toString("base64");
        if (existing) await db.userKVStore.create({ data: { accountId: account.id, key,
            value: Buffer.from("prior"), version: 0 } });
        const version = existing ? 0 : -1;
        let firstReady!: () => void;
        const ready = new Promise<void>(resolve => { firstReady = resolve; });
        let releaseFirst!: () => void;
        const released = new Promise<void>(resolve => { releaseFirst = resolve; });
        let secondReady!: () => void;
        const competing = new Promise<void>(resolve => { secondReady = resolve; });
        let releaseSecond!: () => void;
        const secondReleased = new Promise<void>(resolve => { releaseSecond = resolve; });
        // Only interleave the database boundary: both version decisions and
        // every row write remain inside the production mutation owner.
        const instrument = (tx: Tx, first: boolean) => new Proxy(tx, { get(inner, property, receiver) {
            if (property === "$queryRawUnsafe") return async (query: string, ...values: unknown[]) => {
                if (!first && (query.includes('FROM "UserKVStore"') || query.includes("pg_advisory_xact_lock"))
                    && values.includes(key)) secondReady();
                return inner.$queryRawUnsafe(query, ...values);
            };
            if (property !== "userKVStore") return Reflect.get(inner, property, receiver);
            return new Proxy(inner.userKVStore, { get(delegate, method, delegateReceiver) {
                const operation = Reflect.get(delegate, method, delegateReceiver);
                if (method !== "update" && method !== "updateMany" && method !== "create") return operation;
                return async (...args: unknown[]) => {
                    if (first) { firstReady(); await released; }
                    else if (method === "create" && (args[0] as { data?: { key?: string } })?.data?.key === unrelatedKey) {
                        return Reflect.apply(operation, delegate, args);
                    } else { secondReady(); await secondReleased; }
                    return Reflect.apply(operation, delegate, args);
                };
            } });
        } });
        const transaction = db.$transaction;
        let attempts = 0;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            const first = attempts++ === 0;
            return Reflect.apply(target, receiver, [(tx: Tx) => callback(instrument(tx, first)), ...args.slice(1)]);
        } });
        try {
            const first = kvMutate({ uid: account.id }, [
                { key, value: next, version },
            ]);
            await waitForDatabasePause(first, ready);
            const second = kvMutate({ uid: account.id }, [
                { key: unrelatedKey, value: prior, version: -1 }, { key, value: prior, version },
            ]);
            await waitForDatabasePause(second, competing);
            releaseFirst();
            const firstOutcome = await first;
            releaseSecond();
            const outcomes = [firstOutcome, await second];
            expect(outcomes).toEqual([
                expect.objectContaining({ success: true }),
                { success: false, errors: [
                    { key, error: "version-mismatch", version: version + 1, value: next },
                ] },
            ]);
            expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: account.id, key: unrelatedKey } } })).toBeNull();
            expect(await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key } },
                select: { version: true, value: true } })).toEqual({ version: version + 1, value: new Uint8Array(Buffer.from("next")) });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).seq).toBe(1);
        } finally { releaseFirst(); releaseSecond(); db.$transaction = transaction; }
    });
});
