import { SERVER_IDENTITY_ID_PATTERN } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';

import { db, isPrismaErrorCode } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

export const SERVER_IDENTITY_CACHE_KEY = "server.identity.v1";
export const SERVER_IDENTITY_ENV_KEY = "HAPPIER_SERVER_IDENTITY_ID";

let cachedServerIdentityId: string | null = null;
let serverIdentityInFlight: Promise<string> | null = null;

function assertValidServerIdentityId(value: string, sourceLabel: string): string {
    if (SERVER_IDENTITY_ID_PATTERN.test(value)) return value;
    throw new Error(`${sourceLabel} must match ${SERVER_IDENTITY_ID_PATTERN.source}`);
}

function isServerIdentityStorageUnavailableError(error: unknown): boolean {
    if (isPrismaErrorCode(error, "P1008")) return true;
    if (isPrismaErrorCode(error, "P2024")) return true;
    if (isPrismaErrorCode(error, "P2028")) return true;
    if (isPrismaErrorCode(error, "SQLITE_BUSY")) return true;

    const message = error instanceof Error ? error.message.toLowerCase() : "";
    return message.includes("database client is not initialized")
        || message.includes("socket timeout")
        || message.includes("database failed to respond")
        || message.includes("database is locked")
        || message.includes("sqlite_busy");
}

export function readPinnedServerIdentityId(env: NodeJS.ProcessEnv = process.env): string | null {
    const value = env[SERVER_IDENTITY_ENV_KEY]?.trim();
    return value ? assertValidServerIdentityId(value, SERVER_IDENTITY_ENV_KEY) : null;
}

function createServerIdentityId(): string {
    return `srv_${randomKeyNaked(32)}`;
}

async function persistPinnedServerIdentityId(serverIdentityId: string): Promise<void> {
    await db.simpleCache.upsert({
        where: { key: SERVER_IDENTITY_CACHE_KEY },
        create: { key: SERVER_IDENTITY_CACHE_KEY, value: serverIdentityId },
        update: { value: serverIdentityId },
    });
}

async function readPersistedServerIdentityId(reader: Pick<Tx, "simpleCache"> = db): Promise<string | null> {
    const row = await reader.simpleCache.findUnique({
        where: { key: SERVER_IDENTITY_CACHE_KEY },
        select: { value: true },
    });
    return projectPersistedServerIdentityId(row?.value ?? null);
}

function projectPersistedServerIdentityId(storedValue: string | null): string | null {
    const value = storedValue?.trim();
    return value ? assertValidServerIdentityId(value, SERVER_IDENTITY_CACHE_KEY) : null;
}

/** Composed reads capture the persisted value in their own statement; identity precedence stays here. */
export function projectCurrentServerIdentityId(storedValue: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
    return readCachedServerIdentityIdForHotPath(env) ?? projectPersistedServerIdentityId(storedValue);
}

/** Reads the process identity without opening an out-of-transaction writer during cold composition. */
export async function readCurrentServerIdentityId(
    env: NodeJS.ProcessEnv = process.env,
    reader: Pick<Tx, "simpleCache"> = db,
): Promise<string | null> {
    return readCachedServerIdentityIdForHotPath(env) ?? await readPersistedServerIdentityId(reader);
}

async function resolveServerIdentityId(env: NodeJS.ProcessEnv): Promise<string> {
    const pinned = readPinnedServerIdentityId(env);
    if (pinned) {
        await persistPinnedServerIdentityId(pinned);
        return pinned;
    }

    const persisted = await readPersistedServerIdentityId();
    if (persisted) return persisted;

    const candidate = createServerIdentityId();
    try {
        const created = await db.simpleCache.create({
            data: { key: SERVER_IDENTITY_CACHE_KEY, value: candidate },
            select: { value: true },
        });
        return created.value;
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) {
            throw error;
        }
        const raced = await readPersistedServerIdentityId();
        if (raced) return raced;
        throw error;
    }
}

/** One persisted identity per process; all callers share cold initialization and warm reads. */
export async function getOrCreateServerIdentityId(
    env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
    if (cachedServerIdentityId) return cachedServerIdentityId;
    serverIdentityInFlight ??= resolveServerIdentityId(env)
        .then((serverIdentityId) => {
            cachedServerIdentityId = serverIdentityId;
            return serverIdentityId;
        })
        .finally(() => { serverIdentityInFlight = null; });
    return serverIdentityInFlight;
}

export async function initializeServerIdentityCache(
    env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
    try {
        return await getOrCreateServerIdentityId(env);
    } catch (error) {
        if (!isServerIdentityStorageUnavailableError(error)) throw error;
        cachedServerIdentityId ??= readPinnedServerIdentityId(env);
        return cachedServerIdentityId;
    }
}

export function readCachedServerIdentityIdForHotPath(
    env: NodeJS.ProcessEnv = process.env,
): string | null {
    if (cachedServerIdentityId) return cachedServerIdentityId;
    return readPinnedServerIdentityId(env);
}
