import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
    publishPersonalHomeFileNoClobberDurably,
    readServerIdentityRecord,
    replacePersonalHomeFileDurably,
} from '@happier-dev/cli-common/firstPartyRuntime/server';
import { SERVER_IDENTITY_ID_PATTERN } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';

import { isSharedDatabaseConsumer, resolveServerIdentityRecordPathFromEnv } from "@/config/sharedDatabaseConsumer";
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

/**
 * Where this server keeps its identity. A database row normally; a Stack shared-database consumer
 * shares its source's rows, so it keeps its own identity in its private runtime directory and
 * never reads or writes the source's row (owner ruling 2026-11-18: per-stack Home identity).
 */
type ServerIdentityStore = Readonly<{
    read: () => Promise<string | null>;
    /** Records a pinned identity, replacing any earlier value. */
    pin: (serverIdentityId: string) => Promise<void>;
    /** Stores the candidate unless another writer stored first; returns the stored identity. */
    create: (candidate: string) => Promise<string>;
}>;

const databaseServerIdentityStore: ServerIdentityStore = {
    read: () => readPersistedServerIdentityId(),
    pin: async (serverIdentityId) => {
        await db.simpleCache.upsert({
            where: { key: SERVER_IDENTITY_CACHE_KEY },
            create: { key: SERVER_IDENTITY_CACHE_KEY, value: serverIdentityId },
            update: { value: serverIdentityId },
        });
    },
    create: async (candidate) => {
        try {
            const created = await db.simpleCache.create({
                data: { key: SERVER_IDENTITY_CACHE_KEY, value: candidate },
                select: { value: true },
            });
            return created.value;
        } catch (error) {
            if (!isPrismaErrorCode(error, "P2002")) throw error;
            const raced = await readPersistedServerIdentityId();
            if (raced) return raced;
            throw error;
        }
    },
};

function isFileExistsError(error: unknown): boolean {
    return error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST";
}

function createFileServerIdentityStore(path: string): ServerIdentityStore {
    // The Stack and the CLI read this record through the same cli-common parser.
    const read = () => readServerIdentityRecord(path);
    const writeTemporary = async (serverIdentityId: string): Promise<string> => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, `${serverIdentityId}\n`, { encoding: "utf8", mode: 0o600 });
        return temporaryPath;
    };
    return {
        read,
        pin: async (serverIdentityId) => {
            const temporaryPath = await writeTemporary(serverIdentityId);
            try {
                await replacePersonalHomeFileDurably(temporaryPath, path);
            } finally {
                await rm(temporaryPath, { force: true });
            }
        },
        create: async (candidate) => {
            const temporaryPath = await writeTemporary(candidate);
            try {
                await publishPersonalHomeFileNoClobberDurably(temporaryPath, path);
                return candidate;
            } catch (error) {
                if (!isFileExistsError(error)) throw error;
                const raced = await read();
                if (raced) return raced;
                throw error;
            } finally {
                await rm(temporaryPath, { force: true });
            }
        },
    };
}

function resolveServerIdentityStore(env: NodeJS.ProcessEnv): ServerIdentityStore {
    if (!isSharedDatabaseConsumer(env)) return databaseServerIdentityStore;
    const recordPath = resolveServerIdentityRecordPathFromEnv(env);
    if (!recordPath) {
        throw new Error("A shared-database consumer needs HAPPIER_SERVER_LIGHT_DATA_DIR for its own Home identity");
    }
    return createFileServerIdentityStore(recordPath);
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
    const cached = readCachedServerIdentityIdForHotPath(env);
    if (cached || isSharedDatabaseConsumer(env)) return cached;
    return projectPersistedServerIdentityId(storedValue);
}

/** Reads the process identity without opening an out-of-transaction writer during cold composition. */
export async function readCurrentServerIdentityId(
    env: NodeJS.ProcessEnv = process.env,
    reader: Pick<Tx, "simpleCache"> = db,
): Promise<string | null> {
    const cached = readCachedServerIdentityIdForHotPath(env);
    if (cached) return cached;
    return isSharedDatabaseConsumer(env)
        ? await resolveServerIdentityStore(env).read()
        : await readPersistedServerIdentityId(reader);
}

async function resolveServerIdentityId(env: NodeJS.ProcessEnv): Promise<string> {
    const pinned = readPinnedServerIdentityId(env);
    const store = resolveServerIdentityStore(env);
    if (pinned) {
        await store.pin(pinned);
        return pinned;
    }

    const persisted = await store.read();
    if (persisted) return persisted;
    return await store.create(createServerIdentityId());
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
