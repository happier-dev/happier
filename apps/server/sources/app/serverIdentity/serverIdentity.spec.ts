import { beforeEach, describe, expect, it, vi } from "vitest";

describe("serverIdentity cache without initialized storage", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it("fails soft to null when storage is unavailable and no pinned identity exists", async () => {
        const {
            initializeServerIdentityCache,
            readCachedServerIdentityIdForHotPath,
        } = await import("./serverIdentity");

        await expect(initializeServerIdentityCache({} as NodeJS.ProcessEnv)).resolves.toBeNull();
        expect(readCachedServerIdentityIdForHotPath({} as NodeJS.ProcessEnv)).toBeNull();
    });

    it("caches a pinned identity even when persistence storage is unavailable", async () => {
        const {
            initializeServerIdentityCache,
            readCachedServerIdentityIdForHotPath,
        } = await import("./serverIdentity");

        const env = {
            HAPPIER_SERVER_IDENTITY_ID: "srv_uninitializedPinned123",
        } as NodeJS.ProcessEnv;

        await expect(initializeServerIdentityCache(env)).resolves.toBe("srv_uninitializedPinned123");
        expect(readCachedServerIdentityIdForHotPath({
            HAPPIER_SERVER_IDENTITY_ID: "srv_laterPinned123",
        } as NodeJS.ProcessEnv)).toBe("srv_uninitializedPinned123");
    });

    it("still rejects unsafe pinned identities before failing soft", async () => {
        const { initializeServerIdentityCache } = await import("./serverIdentity");

        await expect(initializeServerIdentityCache({
            HAPPIER_SERVER_IDENTITY_ID: "srv/unsafe",
        } as NodeJS.ProcessEnv)).rejects.toThrow("HAPPIER_SERVER_IDENTITY_ID");
    });
});
