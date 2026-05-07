import { afterEach, describe, expect, it, vi } from "vitest";

describe("accountPetLibraryRuntime", () => {
    afterEach(() => {
        delete process.env.HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR;
        delete process.env.HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES;
        vi.restoreAllMocks();
        vi.doUnmock("@/app/features/catalog/readFeatureEnv");
        vi.doUnmock("@/storage/privateFiles/privateFilesLocal");
        vi.doUnmock("./accountPetLibraryPersistence");
        vi.doUnmock("./accountPetLibraryService");
        vi.resetModules();
    });

    it("reuses the cached services without reconstructing dependencies when the cache key is unchanged", async () => {
        const serviceInstance = { readAccountPetAssetForAccount: vi.fn() };
        const createAccountPetLibraryServices = vi.fn(() => serviceInstance);
        const createLocalPrivateFilesBackend = vi.fn(() => ({ kind: "private-files" }));
        const createPrismaAccountPetLibraryPersistence = vi.fn(() => ({ kind: "persistence" }));

        vi.doMock("@/app/features/catalog/readFeatureEnv", () => ({
            readPetsFeatureEnv: () => ({
                maxManifestBytes: 1,
                maxCanonicalSpritesheetBytes: 2,
                maxCanonicalPackageBytes: 3,
                maxImportedPetsPerAccount: 4,
                maxImportedPetBytesPerAccount: 5,
            }),
        }));
        vi.doMock("@/storage/privateFiles/privateFilesLocal", () => ({
            resolveLocalPrivateFilesDir: () => "/tmp/happier-private-files",
            createLocalPrivateFilesBackend,
        }));
        vi.doMock("./accountPetLibraryPersistence", () => ({
            createPrismaAccountPetLibraryPersistence,
        }));
        vi.doMock("./accountPetLibraryService", () => ({
            createAccountPetLibraryServices,
        }));

        const { getDefaultAccountPetLibraryServices } = await import("./accountPetLibraryRuntime");

        const first = getDefaultAccountPetLibraryServices();
        const second = getDefaultAccountPetLibraryServices();

        expect(second).toBe(first);
        expect(createLocalPrivateFilesBackend).toHaveBeenCalledTimes(1);
        expect(createPrismaAccountPetLibraryPersistence).toHaveBeenCalledTimes(1);
        expect(createAccountPetLibraryServices).toHaveBeenCalledTimes(1);
    });

    it("recreates the default services when the private files root changes", async () => {
        let privateFilesRootDir = "/tmp/happier-private-files-one";
        const createAccountPetLibraryServices = vi.fn(() => ({
            readAccountPetAssetForAccount: vi.fn(),
        }));

        vi.doMock("@/app/features/catalog/readFeatureEnv", () => ({
            readPetsFeatureEnv: () => ({
                maxManifestBytes: 1,
                maxCanonicalSpritesheetBytes: 2,
                maxCanonicalPackageBytes: 3,
                maxImportedPetsPerAccount: 4,
                maxImportedPetBytesPerAccount: 5,
            }),
        }));
        vi.doMock("@/storage/privateFiles/privateFilesLocal", () => ({
            resolveLocalPrivateFilesDir: () => privateFilesRootDir,
            createLocalPrivateFilesBackend: () => ({ kind: "private-files" }),
        }));
        vi.doMock("./accountPetLibraryPersistence", () => ({
            createPrismaAccountPetLibraryPersistence: () => ({ kind: "persistence" }),
        }));
        vi.doMock("./accountPetLibraryService", () => ({
            createAccountPetLibraryServices,
        }));

        const { getDefaultAccountPetLibraryServices } = await import("./accountPetLibraryRuntime");
        const first = getDefaultAccountPetLibraryServices();

        privateFilesRootDir = "/tmp/happier-private-files-two";
        const second = getDefaultAccountPetLibraryServices();

        expect(second).not.toBe(first);
        expect(createAccountPetLibraryServices).toHaveBeenCalledTimes(2);
    });
});
