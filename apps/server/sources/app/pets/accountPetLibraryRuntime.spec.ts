import { afterEach, describe, expect, it, vi } from "vitest";

describe("accountPetLibraryRuntime", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
        vi.resetModules();
    });

    it("reuses default services while the effective runtime configuration is unchanged", async () => {
        process.env.HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR = "/tmp/happier-private-files-one";
        process.env.HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES = "123";
        const { getDefaultAccountPetLibraryServices } = await import("./accountPetLibraryRuntime");

        const first = getDefaultAccountPetLibraryServices();
        const second = getDefaultAccountPetLibraryServices();

        expect(second).toBe(first);
    });

    it("recreates default services when the private files root changes", async () => {
        process.env.HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR = "/tmp/happier-private-files-one";
        const { getDefaultAccountPetLibraryServices } = await import("./accountPetLibraryRuntime");
        const first = getDefaultAccountPetLibraryServices();

        process.env.HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR = "/tmp/happier-private-files-two";
        const second = getDefaultAccountPetLibraryServices();

        expect(second).not.toBe(first);
    });
});
