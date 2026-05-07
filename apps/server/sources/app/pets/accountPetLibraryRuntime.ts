import { readPetsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { createLocalPrivateFilesBackend, resolveLocalPrivateFilesDir } from "@/storage/privateFiles/privateFilesLocal";

import { createPrismaAccountPetLibraryPersistence } from "./accountPetLibraryPersistence";
import { createAccountPetLibraryServices, type AccountPetLibraryServices } from "./accountPetLibraryService";

type DefaultAccountPetLibraryServiceCache = Readonly<{
    key: string;
    services: AccountPetLibraryServices;
}>;

type DefaultAccountPetLibraryServiceConfig = Readonly<{
    key: string;
    privateFilesRootDir: string;
    petsFeatureEnv: ReturnType<typeof readPetsFeatureEnv>;
}>;

let defaultAccountPetLibraryServiceCache: DefaultAccountPetLibraryServiceCache | null = null;

function resolveDefaultAccountPetLibraryServiceConfig(
    env: NodeJS.ProcessEnv,
): DefaultAccountPetLibraryServiceConfig {
    const petsFeatureEnv = readPetsFeatureEnv(env);
    const privateFilesRootDir = resolveLocalPrivateFilesDir(env);

    return {
        key: JSON.stringify({
            privateFilesRootDir,
            maxManifestBytes: petsFeatureEnv.maxManifestBytes,
            maxCanonicalSpritesheetBytes: petsFeatureEnv.maxCanonicalSpritesheetBytes,
            maxCanonicalPackageBytes: petsFeatureEnv.maxCanonicalPackageBytes,
            maxImportedPetsPerAccount: petsFeatureEnv.maxImportedPetsPerAccount,
            maxImportedPetBytesPerAccount: petsFeatureEnv.maxImportedPetBytesPerAccount,
        }),
        privateFilesRootDir,
        petsFeatureEnv,
    };
}

export function getDefaultAccountPetLibraryServices(env: NodeJS.ProcessEnv = process.env) {
    const config = resolveDefaultAccountPetLibraryServiceConfig(env);
    if (defaultAccountPetLibraryServiceCache?.key === config.key) {
        return defaultAccountPetLibraryServiceCache.services;
    }

    const services = createAccountPetLibraryServices({
        privateFiles: createLocalPrivateFilesBackend({ rootDir: config.privateFilesRootDir }),
        persistence: createPrismaAccountPetLibraryPersistence(),
        maxManifestBytes: config.petsFeatureEnv.maxManifestBytes,
        maxSpritesheetBytes: config.petsFeatureEnv.maxCanonicalSpritesheetBytes,
        maxPackageBytes: config.petsFeatureEnv.maxCanonicalPackageBytes,
        maxImportedPetsPerAccount: config.petsFeatureEnv.maxImportedPetsPerAccount,
        maxImportedPetBytesPerAccount: config.petsFeatureEnv.maxImportedPetBytesPerAccount,
    });

    defaultAccountPetLibraryServiceCache = {
        key: config.key,
        services,
    };
    return services;
}
