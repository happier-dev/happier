import { describe, expect, it } from "vitest";

import { BUILT_IN_PET_IDS_V1 } from "@happier-dev/protocol";

import { resolveFeaturesFromEnv } from "./registry";

describe("features/petsFeature", () => {
    it("exposes pets.companion as enabled by default", () => {
        const result = resolveFeaturesFromEnv({} as NodeJS.ProcessEnv);

        expect(result.features?.pets?.companion?.enabled).toBe(true);
    });

    it("allows servers to disable pets.companion without disabling pets.sync", () => {
        const result = resolveFeaturesFromEnv({
            HAPPIER_FEATURE_PETS_COMPANION__ENABLED: "0",
            HAPPIER_FEATURE_PETS_SYNC__ENABLED: "1",
        } as NodeJS.ProcessEnv);

        expect(result.features?.pets?.companion?.enabled).toBe(false);
        expect(result.features?.pets?.sync?.enabled).toBe(true);
    });

    it("exposes pets.sync as a server-represented feature gate when enabled by env", () => {
        const result = resolveFeaturesFromEnv({
            HAPPIER_FEATURE_PETS_SYNC__ENABLED: "1",
        } as NodeJS.ProcessEnv);

        expect(result.features?.pets?.companion?.enabled).toBe(true);
        expect(result.features?.pets?.sync?.enabled).toBe(true);
    });

    it("keeps pets.sync enabled when companion is build-policy denied", () => {
        const result = resolveFeaturesFromEnv({
            HAPPIER_BUILD_FEATURES_DENY: "pets.companion",
            HAPPIER_FEATURE_PETS_SYNC__ENABLED: "1",
        } as NodeJS.ProcessEnv);

        expect(result.features?.pets?.companion?.enabled).toBe(false);
        expect(result.features?.pets?.sync?.enabled).toBe(true);
    });

    it("surfaces bounded pets import limits as capabilities without using them as gates", () => {
        const result = resolveFeaturesFromEnv({
            HAPPIER_FEATURE_PETS_SYNC__ENABLED: "1",
            HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES: "16384",
            HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_SPRITESHEET_BYTES: "5242880",
            HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_PACKAGE_BYTES: "6291456",
            HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PETS_PER_ACCOUNT: "20",
            HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PET_BYTES_PER_ACCOUNT: "104857600",
        } as NodeJS.ProcessEnv);

        expect(result.capabilities?.pets?.limits).toEqual(expect.objectContaining({
            maxManifestBytes: 16_384,
            maxCanonicalSpritesheetBytes: 5_242_880,
            maxCanonicalPackageBytes: 6_291_456,
            maxImportedPetsPerAccount: 20,
            maxImportedPetBytesPerAccount: 104_857_600,
        }));
    });

    it("surfaces companion and conservative sync capability details without using them as gates", () => {
        const result = resolveFeaturesFromEnv({
            HAPPIER_FEATURE_PETS_SYNC__ENABLED: "1",
        } as NodeJS.ProcessEnv);

        expect(result.features?.pets?.sync?.enabled).toBe(true);
        expect(result.capabilities?.pets?.companion).toEqual({
            builtInPetIds: [...BUILT_IN_PET_IDS_V1],
        });
        expect(result.capabilities?.pets?.sync).toEqual(expect.objectContaining({
            supportedMediaTypes: ["image/webp", "image/png"],
            encryptedCustomPetSyncPolicy: "disabled",
            maxManifestBytes: expect.any(Number),
            maxCanonicalSpritesheetBytes: expect.any(Number),
            maxCanonicalPackageBytes: expect.any(Number),
            maxImportedPetsPerAccount: expect.any(Number),
            maxImportedPetBytesPerAccount: expect.any(Number),
        }));
    });

    it("publishes the configured encrypted custom pet sync policy in sync capabilities", () => {
        const result = resolveFeaturesFromEnv({
            HAPPIER_FEATURE_PETS_SYNC__ENABLED: "1",
            HAPPIER_FEATURE_PETS_SYNC__ENCRYPTED_CUSTOM_PET_SYNC_POLICY: "allowedWithClientValidation",
        } as NodeJS.ProcessEnv);

        expect(result.features?.pets?.sync?.enabled).toBe(true);
        expect(result.capabilities?.pets?.sync?.encryptedCustomPetSyncPolicy).toBe("allowedWithClientValidation");
    });
});
