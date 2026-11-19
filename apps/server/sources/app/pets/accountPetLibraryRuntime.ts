import { readPetsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { accountPetPrivateFiles } from "@/storage/blob/files";

import { createPrismaAccountPetLibraryPersistence } from "./accountPetLibraryPersistence";
import { createAccountPetLibraryServices, type AccountPetLibraryServices } from "./accountPetLibraryService";

type DefaultAccountPetLibraryServicesCache = Readonly<{
    key: string;
    services: AccountPetLibraryServices;
}>;

let defaultAccountPetLibraryServicesCache: DefaultAccountPetLibraryServicesCache | null = null;

function createDefaultAccountPetLibraryServicesCacheKey(params: {
    maxManifestBytes: number;
    maxCanonicalSpritesheetBytes: number;
    maxCanonicalPackageBytes: number;
    maxImportedPetsPerAccount: number;
    maxImportedPetBytesPerAccount: number;
}): string {
    return JSON.stringify(params);
}

export function getDefaultAccountPetLibraryServices() {
    const petsFeatureEnv = readPetsFeatureEnv(process.env);
    const key = createDefaultAccountPetLibraryServicesCacheKey({
        maxManifestBytes: petsFeatureEnv.maxManifestBytes,
        maxCanonicalSpritesheetBytes: petsFeatureEnv.maxCanonicalSpritesheetBytes,
        maxCanonicalPackageBytes: petsFeatureEnv.maxCanonicalPackageBytes,
        maxImportedPetsPerAccount: petsFeatureEnv.maxImportedPetsPerAccount,
        maxImportedPetBytesPerAccount: petsFeatureEnv.maxImportedPetBytesPerAccount,
    });

    if (defaultAccountPetLibraryServicesCache?.key === key) {
        return defaultAccountPetLibraryServicesCache.services;
    }

    const services = createAccountPetLibraryServices({
        privateFiles: accountPetPrivateFiles,
        persistence: createPrismaAccountPetLibraryPersistence(),
        maxManifestBytes: petsFeatureEnv.maxManifestBytes,
        maxSpritesheetBytes: petsFeatureEnv.maxCanonicalSpritesheetBytes,
        maxPackageBytes: petsFeatureEnv.maxCanonicalPackageBytes,
        maxImportedPetsPerAccount: petsFeatureEnv.maxImportedPetsPerAccount,
        maxImportedPetBytesPerAccount: petsFeatureEnv.maxImportedPetBytesPerAccount,
    });
    defaultAccountPetLibraryServicesCache = { key, services };
    return services;
}

export async function deleteDefaultAccountPetPrivateObject(objectKey: string): Promise<void> {
    await accountPetPrivateFiles.deletePrivateFile(objectKey);
}
