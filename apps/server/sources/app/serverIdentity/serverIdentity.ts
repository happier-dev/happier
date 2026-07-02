import { db, isPrismaErrorCode } from "@/storage/db";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

export const SERVER_IDENTITY_CACHE_KEY = "server.identity.v1";
export const SERVER_IDENTITY_ENV_KEY = "HAPPIER_SERVER_IDENTITY_ID";

const SERVER_IDENTITY_ID_PATTERN = /^srv_[A-Za-z0-9._-]{1,60}$/;

let cachedServerIdentityId: string | null = null;
let initializeServerIdentityCacheInFlight: Promise<string | null> | null = null;

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

async function readPersistedServerIdentityId(): Promise<string | null> {
    const row = await db.simpleCache.findUnique({
        where: { key: SERVER_IDENTITY_CACHE_KEY },
        select: { value: true },
    });
    const value = row?.value.trim();
    return value ? assertValidServerIdentityId(value, SERVER_IDENTITY_CACHE_KEY) : null;
}

export async function getOrCreateServerIdentityId(
    env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
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

export async function initializeServerIdentityCache(
    env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
    if (cachedServerIdentityId) return cachedServerIdentityId;
    const pinned = readPinnedServerIdentityId(env);
    if (pinned) {
        cachedServerIdentityId = pinned;
    }
    initializeServerIdentityCacheInFlight ??= getOrCreateServerIdentityId(env)
        .then((serverIdentityId) => {
            cachedServerIdentityId = serverIdentityId;
            return serverIdentityId;
        })
        .catch((error: unknown) => {
            if (isServerIdentityStorageUnavailableError(error)) {
                return cachedServerIdentityId;
            }
            throw error;
        })
        .finally(() => {
            initializeServerIdentityCacheInFlight = null;
        });
    return initializeServerIdentityCacheInFlight;
}

export function readCachedServerIdentityIdForHotPath(
    env: NodeJS.ProcessEnv = process.env,
): string | null {
    if (cachedServerIdentityId) return cachedServerIdentityId;
    return readPinnedServerIdentityId(env);
}
