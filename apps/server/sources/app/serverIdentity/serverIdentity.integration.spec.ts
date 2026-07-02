import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { db } from "@/storage/db";

import { getOrCreateServerIdentityId } from "./serverIdentity";

type ServerIdentityCacheModule = {
    initializeServerIdentityCache?: (env?: NodeJS.ProcessEnv) => Promise<string | null>;
    readCachedServerIdentityIdForHotPath?: (env?: NodeJS.ProcessEnv) => string | null;
};

async function loadServerIdentityCacheModule(): Promise<ServerIdentityCacheModule> {
    const loaded: unknown = await import("./serverIdentity");
    return loaded as ServerIdentityCacheModule;
}

describe("serverIdentity", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-server-identity-",
        });
    }, 60_000);

    afterAll(async () => {
        await harness.close();
    });

    it("generates one stable identity under concurrent cold reads", async () => {
        await db.simpleCache.deleteMany({ where: { key: "server.identity.v1" } });

        const identities = await Promise.all(
            Array.from({ length: 8 }, () => getOrCreateServerIdentityId({} as NodeJS.ProcessEnv)),
        );

        expect(new Set(identities).size).toBe(1);
        expect(identities[0]).toMatch(/^srv_[A-Za-z0-9]{24,}$/);
        await expect(db.simpleCache.count({ where: { key: "server.identity.v1" } })).resolves.toBe(1);
    });

    it("honors and persists an env-pinned identity", async () => {
        await db.simpleCache.deleteMany({ where: { key: "server.identity.v1" } });

        const identity = await getOrCreateServerIdentityId({
            HAPPIER_SERVER_IDENTITY_ID: "srv_envPinned123",
        } as NodeJS.ProcessEnv);

        expect(identity).toBe("srv_envPinned123");
        await expect(
            db.simpleCache.findUnique({
                where: { key: "server.identity.v1" },
                select: { value: true },
            }),
        ).resolves.toEqual({ value: "srv_envPinned123" });
    });

    it("initializes, persists, and serves one process identity without storage on the hot path", async () => {
        await db.simpleCache.deleteMany({ where: { key: "server.identity.v1" } });
        const identityModule = await loadServerIdentityCacheModule();
        expect(typeof identityModule.initializeServerIdentityCache).toBe("function");
        expect(typeof identityModule.readCachedServerIdentityIdForHotPath).toBe("function");

        const initialized = await identityModule.initializeServerIdentityCache!({
            HAPPIER_SERVER_IDENTITY_ID: "srv_startupPinned123",
        } as NodeJS.ProcessEnv);
        const second = await identityModule.initializeServerIdentityCache!({
            HAPPIER_SERVER_IDENTITY_ID: "srv_secondPinned123",
        } as NodeJS.ProcessEnv);

        expect(initialized).toBe("srv_startupPinned123");
        expect(second).toBe("srv_startupPinned123");
        expect(identityModule.readCachedServerIdentityIdForHotPath!({
            HAPPIER_SERVER_IDENTITY_ID: "srv_secondPinned123",
        } as NodeJS.ProcessEnv)).toBe("srv_startupPinned123");
        await expect(
            db.simpleCache.findUnique({
                where: { key: "server.identity.v1" },
                select: { value: true },
            }),
        ).resolves.toEqual({ value: "srv_startupPinned123" });

        await db.simpleCache.deleteMany({ where: { key: "server.identity.v1" } });
        expect(identityModule.readCachedServerIdentityIdForHotPath!({
            HAPPIER_SERVER_IDENTITY_ID: "srv_thirdPinned123",
        } as NodeJS.ProcessEnv)).toBe("srv_startupPinned123");
    });

    it("rejects env-pinned identities that are unsafe for storage keys", async () => {
        await expect(getOrCreateServerIdentityId({
            HAPPIER_SERVER_IDENTITY_ID: "srv/unsafe",
        } as NodeJS.ProcessEnv)).rejects.toThrow("HAPPIER_SERVER_IDENTITY_ID");
    });

    it("rejects env-pinned identities that do not use the server-issued prefix", async () => {
        await expect(getOrCreateServerIdentityId({
            HAPPIER_SERVER_IDENTITY_ID: "envPinned123",
        } as NodeJS.ProcessEnv)).rejects.toThrow("HAPPIER_SERVER_IDENTITY_ID");
    });

    it("rejects persisted identities that do not use the server-issued prefix", async () => {
        await db.simpleCache.upsert({
            where: { key: "server.identity.v1" },
            create: { key: "server.identity.v1", value: "envPinned123" },
            update: { value: "envPinned123" },
        });

        await expect(getOrCreateServerIdentityId({} as NodeJS.ProcessEnv)).rejects.toThrow("server.identity.v1");
    });
});
