import type { FeaturesPayloadDelta } from "./types";
import { resolveOAuthProviderStatuses } from "@/app/oauth/providers/registry";

export function resolveOAuthFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    return {
        capabilities: {
            oauth: {
                providers: resolveOAuthProviderStatuses(env),
            },
        },
    };
}
