import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LightSqliteHarness } from "@/testkit/lightSqliteHarness";

/**
 * Composed check for per-stack Home identity on a shared database (owner ruling 2026-11-18):
 * a source stack and a QA stack share one real database, each restart is a fresh module
 * lifetime, and each server publishes its own identity and canonical URL through the real
 * identity and descriptor owners. Only the Iroh lifecycle is injected (no native endpoint here).
 */
let harness: LightSqliteHarness;
let consumerDataDir: string;

const SOURCE_URL = "https://source.example.test";
const CONSUMER_URL = "https://qa-consumer.example.test";

function sourceEnv(): NodeJS.ProcessEnv {
    return {
        HAPPIER_DB_PROVIDER: "sqlite",
        HAPPIER_SERVER_LIGHT_DATA_DIR: harness.baseDir,
        HAPPIER_CANONICAL_SERVER_URL: SOURCE_URL,
        HAPPIER_PUBLIC_SERVER_URL: SOURCE_URL,
    };
}

function consumerEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
        HAPPIER_DB_PROVIDER: "sqlite",
        HAPPIER_STACK_SHARED_DB_SOURCE_STACK: "repo-dev",
        HAPPIER_SERVER_LIGHT_DATA_DIR: consumerDataDir,
        HAPPIER_CANONICAL_SERVER_URL: CONSUMER_URL,
        HAPPIER_PUBLIC_SERVER_URL: CONSUMER_URL,
        ...extra,
    };
}

/** One server process lifetime over the shared database: fresh module state, same rows. */
async function startServerLifetime(env: NodeJS.ProcessEnv) {
    vi.resetModules();
    const storage = await import("@/storage/prisma");
    await storage.initDbSqlite();
    const identity = await import("./serverIdentity");
    const continuity = await import("@/app/features/homeConnectionDescriptorContinuity");
    const publication = await import("@/app/features/homeConnectionDescriptorPublication");
    const identityId = await identity.initializeServerIdentityCache(env);
    const store = continuity.createHomeConnectionDescriptorContinuityStoreForServer(env);
    if (!store) throw new Error("expected a descriptor continuity store");
    const descriptor = await publication.readHomeConnectionDescriptor({
        env, continuityStore: store, visibility: "public",
        resolveIrohEndpointState: () => ({ status: "unavailable", snapshot: null, failureReason: null }),
    });
    const persistedRow = await (await import("@/storage/db")).db.simpleCache.findUnique({
        where: { key: identity.SERVER_IDENTITY_CACHE_KEY }, select: { value: true },
    });
    await storage.shutdownDbClient();
    return { identityId, descriptor, persistedRow: persistedRow?.value ?? null };
}

beforeEach(async () => {
    vi.resetModules();
    const kit = await import("@/testkit/lightSqliteHarness");
    harness = await kit.createLightSqliteHarness({ tempDirPrefix: "happier-shared-db-identity-" });
    await (await import("@/storage/prisma")).shutdownDbClient();
    consumerDataDir = await mkdtemp(join(tmpdir(), "happier-shared-db-consumer-"));
}, 60_000);
afterEach(async () => {
    await harness?.close();
    if (consumerDataDir) await rm(consumerDataDir, { recursive: true, force: true });
});

describe("per-stack Home identity on a shared database", () => {
    it("lets a source stack and a QA consumer each publish their own identity and URL with no cross-talk", async () => {
        const source = await startServerLifetime(sourceEnv());
        expect(source.identityId).toMatch(/^srv_/);
        expect(source.descriptor).toMatchObject({ homeServerIdentityId: source.identityId, canonicalServerUrl: SOURCE_URL });

        const consumer = await startServerLifetime(consumerEnv());
        expect(consumer.identityId).toMatch(/^srv_/);
        expect(consumer.identityId).not.toBe(source.identityId);
        expect(consumer.descriptor).toMatchObject({ homeServerIdentityId: consumer.identityId, canonicalServerUrl: CONSUMER_URL });
        expect(consumer.descriptor?.endpoints).toEqual([{ kind: "https", url: CONSUMER_URL }]);
        // The shared row still belongs to the source stack.
        expect(consumer.persistedRow).toBe(source.identityId);

        // Restarts (reloads) keep each server's own identity and URL.
        const sourceAgain = await startServerLifetime(sourceEnv());
        expect(sourceAgain.identityId).toBe(source.identityId);
        expect(sourceAgain.descriptor).toMatchObject({ homeServerIdentityId: source.identityId, canonicalServerUrl: SOURCE_URL });
        const consumerAgain = await startServerLifetime(consumerEnv());
        expect(consumerAgain.identityId).toBe(consumer.identityId);
        expect(consumerAgain.descriptor).toMatchObject({ homeServerIdentityId: consumer.identityId, canonicalServerUrl: CONSUMER_URL });
    }, 60_000);

    it("keeps a pinned consumer identity out of the shared row", async () => {
        const source = await startServerLifetime(sourceEnv());
        const pinned = await startServerLifetime(consumerEnv({ HAPPIER_SERVER_IDENTITY_ID: "srv_pinnedQaConsumer123" }));
        expect(pinned.identityId).toBe("srv_pinnedQaConsumer123");
        expect(pinned.persistedRow).toBe(source.identityId);
        expect((await startServerLifetime(consumerEnv())).identityId).toBe("srv_pinnedQaConsumer123");
        expect((await startServerLifetime(sourceEnv())).identityId).toBe(source.identityId);
    }, 60_000);
});
