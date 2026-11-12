import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LightSqliteHarness } from "@/testkit/lightSqliteHarness";

// Each case is a new process lifetime over a disposable real database.
const output = vi.hoisted(() => ({ log: vi.fn<(meta: Record<string, unknown>, message?: string) => void>() }));
// Count the existing query instrumentation at the logging IO boundary, including snapshot clients.
vi.mock("@/utils/logging/log", async importOriginal => ({
    ...await importOriginal<typeof import("@/utils/logging/log")>(), ...output,
}));
const identityOperations = () => output.log.mock.calls.filter(([meta]) =>
    typeof meta.phase === "string" && meta.phase.startsWith("db.SimpleCache."));
let harness: LightSqliteHarness;
let identity: typeof import("./serverIdentity");
let db: typeof import("@/storage/db")["db"];
beforeEach(async () => {
    vi.resetModules();
    const kit = await import("@/testkit/lightSqliteHarness");
    harness = await kit.createLightSqliteHarness({ tempDirPrefix: "happier-server-identity-",
        env: { HAPPIER_WEB_LATENCY_TRACE: "1" } });
    vi.spyOn((await import("@/utils/logging/log")).logger, "isLevelEnabled").mockReturnValue(true);
    output.log.mockClear();
    db = (await import("@/storage/db")).db;
    identity = await import("./serverIdentity");
}, 60_000);
afterEach(async () => { vi.restoreAllMocks(); await harness?.close(); });

describe("server identity process lifetime", () => {
    it("generates one stable identity under concurrent cold reads, then performs no identity storage operations", async () => {
        const identities = await Promise.all(Array.from({ length: 100 }, () => identity.getOrCreateServerIdentityId({})));
        expect(new Set(identities).size).toBe(1);
        expect(identities[0]).toMatch(/^srv_[A-Za-z0-9]{24,}$/);
        await expect(db.simpleCache.count({ where: { key: identity.SERVER_IDENTITY_CACHE_KEY } })).resolves.toBe(1);
        expect(identityOperations().length).toBeGreaterThan(0);
        output.log.mockClear();
        for (let i = 0; i < 100; i++) {
            expect(await identity.getOrCreateServerIdentityId({})).toBe(identities[0]);
            expect(await identity.readCurrentServerIdentityId({})).toBe(identities[0]);
        }
        expect(identityOperations()).toHaveLength(0);
    });

    it("persists a pinned identity once and shares it with every getter for the process lifetime", async () => {
        const env = { HAPPIER_SERVER_IDENTITY_ID: "srv_startupPinned123" };
        expect(await identity.initializeServerIdentityCache(env)).toBe(env.HAPPIER_SERVER_IDENTITY_ID);
        await expect(db.simpleCache.findUnique({ where: { key: identity.SERVER_IDENTITY_CACHE_KEY }, select: { value: true } }))
            .resolves.toEqual({ value: env.HAPPIER_SERVER_IDENTITY_ID });
        expect(identityOperations().length).toBeGreaterThan(0);
        output.log.mockClear();
        const later = { HAPPIER_SERVER_IDENTITY_ID: "srv_laterPinned123" };
        for (let i = 0; i < 100; i++) {
            expect(await identity.getOrCreateServerIdentityId(later)).toBe(env.HAPPIER_SERVER_IDENTITY_ID);
            expect(await identity.readCurrentServerIdentityId(later)).toBe(env.HAPPIER_SERVER_IDENTITY_ID);
            expect(identity.readCachedServerIdentityIdForHotPath(later)).toBe(env.HAPPIER_SERVER_IDENTITY_ID);
        }
        expect(identityOperations()).toHaveLength(0);
    });

    it.each(["srv/unsafe", "envPinned123"])("rejects an invalid pinned identity before publication: %s", async value => {
        await expect(identity.getOrCreateServerIdentityId({ HAPPIER_SERVER_IDENTITY_ID: value }))
            .rejects.toThrow("HAPPIER_SERVER_IDENTITY_ID");
        expect(identity.readCachedServerIdentityIdForHotPath({})).toBeNull();
    });

    it("rejects an invalid persisted identity, then admits a valid persisted identity", async () => {
        await db.simpleCache.create({ data: { key: identity.SERVER_IDENTITY_CACHE_KEY, value: "envPinned123" } });
        await expect(identity.getOrCreateServerIdentityId({})).rejects.toThrow("server.identity.v1");
        await db.simpleCache.update({ where: { key: identity.SERVER_IDENTITY_CACHE_KEY }, data: { value: "srv_restoredValid123" } });
        expect(await identity.getOrCreateServerIdentityId({})).toBe("srv_restoredValid123");
        expect(await identity.readCurrentServerIdentityId({})).toBe("srv_restoredValid123");
    });
});
