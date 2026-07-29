import type { FeaturesPayloadDelta } from "./types";
import { readConnectedServicesFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveConnectedServicesFeature(
    env: NodeJS.ProcessEnv,
): FeaturesPayloadDelta {
    const featureEnv = readConnectedServicesFeatureEnv(env);
    const quotasEnabled = featureEnv.quotasEnabled;
    const accountGroupsEnabled = featureEnv.accountGroupsEnabled;
    const accountFallbackEnabled = featureEnv.accountFallbackEnabled;

    return {
        features: {
            connectedServices: {
                // Compatibility-only wire bit for released clients that still read the retired
                // master gate. Connected Accounts are core; current clients and routes do not
                // consult this value, and new servers always advertise them as available.
                enabled: true,
                quotas: { enabled: quotasEnabled },
                accountGroups: { enabled: accountGroupsEnabled },
                accountFallback: { enabled: accountFallbackEnabled },
            },
        },
        capabilities: {
            connectedServices: {
                credentialDelete: { revisionGuard: true },
                qualifiedAccounts: { protocolVersion: 4 },
            },
        },
    };
}
