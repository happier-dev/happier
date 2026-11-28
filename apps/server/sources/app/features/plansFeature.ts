import { resolveLimitTable } from "@/app/plans/accountLimits";

import { readPlansFeatureEnv } from "./catalog/readFeatureEnv";
import type { FeaturesPayloadDelta } from "./types";

/**
 * `plans`: the operator allows it, the config is readable, and there is something to show (a plan
 * or any non-null base limit). False on a default server because there is nothing to show.
 * `supporter`: every way of backing Happier (offer, ring, credits, star ask); on unless the operator
 * turns it off.
 */
export function resolvePlansFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const flags = readPlansFeatureEnv(env);
    const table = resolveLimitTable(env);
    const hasSomethingToShow = table.ok
        && (table.plans.size > 0 || Object.values(table.base).some((limit) => limit !== null));
    return {
        features: {
            plans: { enabled: flags.plansEnabled && hasSomethingToShow },
            supporter: { enabled: flags.supporterEnabled },
        },
    };
}
