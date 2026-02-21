import type { FeaturesPayloadDelta } from "@/app/features/types";

import { resolveKeylessAccountsEnabled } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";

export function resolveE2eeFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    return {
        features: {
            e2ee: {
                keylessAccounts: {
                    enabled: resolveKeylessAccountsEnabled(env),
                },
            },
        },
    };
}
