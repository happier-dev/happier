import type { FeaturesResponse } from "./types";
import { resolveOAuthProviderStatuses } from "@/app/oauth/providers/registry";

export function resolveOAuthFeature(env: NodeJS.ProcessEnv): Pick<FeaturesResponse["features"], "oauth"> {
    return {
        oauth: {
            providers: resolveOAuthProviderStatuses(env),
        },
    };
}
