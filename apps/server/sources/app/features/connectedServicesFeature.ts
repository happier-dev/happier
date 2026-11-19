import type { FeaturesPayloadDelta } from "./types";
import { readConnectedServicesFeatureEnv } from "./catalog/readFeatureEnv";
import { readServerConfig } from "@happier-dev/protocol/serverConfig/serverConfigCodec";
import { CONNECTED_ACCOUNT_PUBLIC_OAUTH_CLIENT_CONFIG } from "@happier-dev/protocol/serverConfig/registry";
import { ConnectedAccountPublicOAuthClientV1Schema } from "@happier-dev/protocol/features/payload/capabilities/connectedServicesCapabilities";

/**
 * The Home's public OAuth clients, one row per Connected Account service. Each
 * client id is per Home because the callback is the Home's web origin. A row is
 * advertised only when its client id (and scopes) are configured and valid.
 */
function readPublicOAuthClients(env: NodeJS.ProcessEnv) {
    // Validate per row so one malformed setting cannot withdraw another provider.
    return CONNECTED_ACCOUNT_PUBLIC_OAUTH_CLIENT_CONFIG.flatMap(entry => {
        const { service, scopes } = entry;
        const parsed = ConnectedAccountPublicOAuthClientV1Schema.safeParse({
            service,
            clientId: readServerConfig(env, entry),
            scopesByMode: { oauth: 'key' in scopes ? readServerConfig(env, scopes) : scopes },
        });
        return parsed.success ? [parsed.data] : [];
    });
}

export function resolveConnectedServicesFeature(
    env: NodeJS.ProcessEnv,
): FeaturesPayloadDelta {
    const featureEnv = readConnectedServicesFeatureEnv(env);
    const quotasEnabled = featureEnv.quotasEnabled;
    const accountGroupsEnabled = featureEnv.accountGroupsEnabled;
    const accountFallbackEnabled = featureEnv.accountFallbackEnabled;
    const publicOAuthClients = readPublicOAuthClients(env);

    return {
        features: {
            connectedServices: {
                // Compatibility-only wire bit for released clients that still read the retired
                // master gate. Connected Accounts are core; current clients and routes do not
                // consult this value, and new servers always advertise them as available.
                enabled: true,
                quotas: { enabled: quotasEnabled },
                subscription: { enabled: true },
                accountGroups: { enabled: accountGroupsEnabled },
                accountFallback: { enabled: accountFallbackEnabled },
                autoQuotaReset: { enabled: true },
                autoDisablePlanInvalid: { enabled: true },
                poolQuotaLimitSelection: { enabled: true },
            },
        },
        capabilities: {
            connectedServices: {
                credentialDelete: { revisionGuard: true },
                qualifiedAccounts: { protocolVersion: 4 },
                credentialRemovalReview: { protocolVersion: 1 },
                ...(publicOAuthClients.length ? { publicOAuthClients } : {}),
            },
        },
    };
}
