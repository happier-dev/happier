import { readPolarConfig } from "./polarClient";
import { readRevenueCatConfig } from "./revenueCatClient";

export function readBillingConfig(env: NodeJS.ProcessEnv) {
    const polar = readPolarConfig(env);
    const revenueCat = readRevenueCatConfig(env);
    const billingReference = polar || revenueCat ? "account" : "supporter_code";
    return { polar, revenueCat, billingReference } as const;
}
