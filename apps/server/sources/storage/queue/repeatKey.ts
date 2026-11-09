import { Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/config/databaseProvider";

const DEFAULT_REPEAT_KEY_TTL_MS = 1000 * 60 * 60 * 24;

/**
 * Derives the existing default RepeatKey retention from the caller's deciding
 * clock. Callers that already sampled transaction/database time use this
 * helper so lookup and persistence cannot disagree under process-clock skew.
 */
export function defaultRepeatKeyExpiresAt(now: Date): Date {
    return new Date(now.getTime() + DEFAULT_REPEAT_KEY_TTL_MS);
}

/**
 * Serialize one creation intent without locking its Account publication cursor.
 * PostgreSQL ReadCommitted creators take this before reading the repeat result;
 * the lock ends with commit/rollback and adds no persistent reservation. Other
 * providers retain their existing Serializable creation transactions.
 */
export async function lockPostgresRepeatKeyInTx(tx: Tx, key: string): Promise<void> {
    if (getDbProviderFromEnv(process.env, 'postgres') === 'postgres') {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', key);
    }
}

export async function fetchRepeatKey(tx: Tx, key: string, now: Date = new Date()) {
    let session = await tx.repeatKey.findUnique({ where: { key, expiresAt: { gt: now } } });
    if (session) {
        return session.value;
    } else {
        return null;
    }
}

export async function saveRepeatKey(
    tx: Tx,
    key: string,
    value: string,
    timeout: number | Date = defaultRepeatKeyExpiresAt(new Date()),
) {
    const expiresAt = timeout instanceof Date ? timeout : new Date(timeout);
    await tx.repeatKey.upsert({
        where: { key },
        create: { key, value, expiresAt },
        update: { key, value, expiresAt }
    });
}

/**
 * Consumes one live record by deleting the exact key/value pair inside the
 * caller's transaction. Concurrent consumers of the same record observe a
 * single winner because only one delete can match, so no `consumedAt` column,
 * history row, or exactly-once protocol is needed.
 */
export async function deleteRepeatKeyExact(tx: Tx, key: string, value: string, now: Date = new Date()): Promise<boolean> {
    const deleted = await tx.repeatKey.deleteMany({
        where: { key, value, expiresAt: { gt: now } },
    });
    return deleted.count === 1;
}

export async function repeatKey(tx: Tx, key: string, value: string, timeout: number = Date.now() + DEFAULT_REPEAT_KEY_TTL_MS): Promise<boolean> {
    let session = await tx.repeatKey.findUnique({ where: { key, expiresAt: { lte: new Date() } } });
    if (session) {
        return false;
    }
    await tx.repeatKey.upsert({
        where: { key },
        create: { key, value, expiresAt: new Date(timeout) },
        update: { key, value, expiresAt: new Date(timeout) }
    });
    return true;
}
