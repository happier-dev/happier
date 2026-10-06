import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";

export async function writeToSimpleCache(key: string, value: string) {
    await db.simpleCache.upsert({
        where: { key },
        update: { value },
        create: { key, value }
    });
}

export async function readFromSimpleCache(key: string, reader: Pick<Tx, "simpleCache"> = db): Promise<string | null> {
    const cache = await reader.simpleCache.findFirst({
        where: { key }
    });
    return cache?.value ?? null;
}

/** Atomically replace one cache value only while its serialized value matches. */
export async function compareAndSetSimpleCache(
    key: string,
    expectedValue: string | null,
    nextValue: string,
): Promise<boolean> {
    try {
        return await inTx((tx) => compareAndSetSimpleCacheInTx(tx, key, expectedValue, nextValue));
    } catch (error) {
        if (expectedValue === null && isPrismaErrorCode(error, "P2002")) return false;
        throw error;
    }
}

/** The same compare-and-set using the caller's existing transaction. */
export async function compareAndSetSimpleCacheInTx(
    tx: Tx,
    key: string,
    expectedValue: string | null,
    nextValue: string,
): Promise<boolean> {
    if (expectedValue === null) {
        const existing = await tx.simpleCache.findUnique({ where: { key }, select: { key: true } });
        if (existing) return false;
        await tx.simpleCache.create({ data: { key, value: nextValue } });
        return true;
    }
    const updated = await tx.simpleCache.updateMany({
        where: { key, value: expectedValue },
        data: { value: nextValue },
    });
    return updated.count === 1;
}

export async function runCachedBoolean(key: string, execute: () => Promise<boolean>): Promise<boolean> {
    let value = await readFromSimpleCache(key);
    if (value === null) {
        value = (await execute()) ? 'true' : 'false';
        await writeToSimpleCache(key, value);
    }
    return value === 'true';
}

export async function runCachedString(key: string, execute: () => Promise<string>): Promise<string> {
    let value = await readFromSimpleCache(key);
    if (value === null) {
        value = await execute();
        await writeToSimpleCache(key, value);
    }
    return value;
}
