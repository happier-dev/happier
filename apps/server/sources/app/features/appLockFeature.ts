import type { FeaturesPayloadDelta } from "./types";
import { readAppLockFeatureEnv } from "./catalog/readFeatureEnv";

/**
 * App-lock email recovery. Each account brings its own SMTP server (entered in the app), so the
 * capability requires explicit operator admission of account-configured outbound SMTP access.
 */
export function resolveAppLockFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const config = readAppLockFeatureEnv(env);
    return {
        features: {
            appLock: {
                emailRecovery: { enabled: config.emailRecoveryEnabled },
            },
        },
    };
}
