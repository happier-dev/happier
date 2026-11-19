import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultAccountPetLibraryServices } from "./accountPetLibraryRuntime";

describe("accountPetLibraryRuntime", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("reuses default services while the effective runtime configuration is unchanged", () => {
        vi.stubEnv("HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES", "123");

        const first = getDefaultAccountPetLibraryServices();
        const second = getDefaultAccountPetLibraryServices();

        expect(second).toBe(first);
    });

    it("recreates default services when the Pet admission limits change", () => {
        vi.stubEnv("HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES", "123");
        const first = getDefaultAccountPetLibraryServices();

        vi.stubEnv("HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES", "456");
        const second = getDefaultAccountPetLibraryServices();

        expect(second).not.toBe(first);
    });
});
