import type { FeaturesPayloadDelta } from "@/app/features/types";

import { readEncryptionFeatureEnv } from "./catalog/readFeatureEnv";
import { resolveEffectiveDefaultAccountEncryptionMode } from "@happier-dev/protocol";

export function resolveEncryptionFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureEnv = readEncryptionFeatureEnv(env);

    const plaintextStorageEnabled = featureEnv.storagePolicy !== "required_e2ee";
    const accountOptOutEnabled =
        plaintextStorageEnabled && featureEnv.storagePolicy === "optional" && featureEnv.allowAccountOptOut;

    const effectiveDefaultAccountMode = resolveEffectiveDefaultAccountEncryptionMode(
        featureEnv.storagePolicy,
        featureEnv.defaultAccountMode,
    );

    return {
        features: {
            encryption: {
                plaintextStorage: { enabled: plaintextStorageEnabled },
                accountOptOut: { enabled: accountOptOutEnabled },
            },
        },
        capabilities: {
            encryption: {
                storagePolicy: featureEnv.storagePolicy,
                allowAccountOptOut: accountOptOutEnabled,
                defaultAccountMode: effectiveDefaultAccountMode,
            },
        },
    };
}
