import type { FeaturesPayloadDelta } from "./types";
import { readPetsFeatureEnv } from "./catalog/readFeatureEnv";
import {
    BUILT_IN_PET_IDS_V1,
    PET_PACKAGE_LIMITS_V1,
    PET_SYNC_SUPPORTED_MEDIA_TYPES_V1,
} from "@happier-dev/protocol";

export function resolvePetsFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const config = readPetsFeatureEnv(env);

    return {
        features: {
            pets: {
                companion: { enabled: config.companionEnabled },
                sync: { enabled: config.syncEnabled },
            },
        },
        capabilities: {
            pets: {
                companion: {
                    builtInPetIds: [...BUILT_IN_PET_IDS_V1],
                },
                limits: {
                    maxManifestBytes: config.maxManifestBytes,
                    maxCanonicalSpritesheetBytes: config.maxCanonicalSpritesheetBytes,
                    maxCanonicalPackageBytes: config.maxCanonicalPackageBytes,
                    maxPreCanonicalImportBytes: PET_PACKAGE_LIMITS_V1.maxPreCanonicalImportBytes,
                    maxImportedPetsPerAccount: config.maxImportedPetsPerAccount,
                    maxImportedPetBytesPerAccount: config.maxImportedPetBytesPerAccount,
                    maxImportedPetsPerDevice: PET_PACKAGE_LIMITS_V1.maxImportedPetsPerDevice,
                    maxImportedPetBytesPerDevice: PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerDevice,
                },
                sync: {
                    maxManifestBytes: config.maxManifestBytes,
                    maxCanonicalSpritesheetBytes: config.maxCanonicalSpritesheetBytes,
                    maxCanonicalPackageBytes: config.maxCanonicalPackageBytes,
                    maxPreCanonicalImportBytes: PET_PACKAGE_LIMITS_V1.maxPreCanonicalImportBytes,
                    maxImportedPetsPerAccount: config.maxImportedPetsPerAccount,
                    maxImportedPetBytesPerAccount: config.maxImportedPetBytesPerAccount,
                    maxImportedPetsPerDevice: PET_PACKAGE_LIMITS_V1.maxImportedPetsPerDevice,
                    maxImportedPetBytesPerDevice: PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerDevice,
                    supportedMediaTypes: [...PET_SYNC_SUPPORTED_MEDIA_TYPES_V1],
                    encryptedCustomPetSyncPolicy: config.encryptedCustomPetSyncPolicy,
                },
            },
        },
    };
}
