import type { FeaturesPayloadDelta } from "./types";
import { readConnectedServicesFeatureEnv } from "./catalog/readFeatureEnv";
import { readServerConfig } from "@happier-dev/protocol/serverConfig/serverConfigCodec";
import { SERVER_CONFIG } from "@happier-dev/protocol/serverConfig/registry";
import { ConnectedAccountPublicOAuthClientV1Schema } from "@happier-dev/protocol/features/payload/capabilities/connectedServicesCapabilities";

function readPublicOAuthClients(env: NodeJS.ProcessEnv) {
    const rows: unknown = readServerConfig(env, SERVER_CONFIG.HAPPIER_CONNECTED_SERVICES_PUBLIC_OAUTH_CLIENTS);
    if (!Array.isArray(rows)) return [];
    // A malformed operator row must not withdraw another service’s valid client.
    return rows.flatMap((row: unknown) => {
        const parsed = ConnectedAccountPublicOAuthClientV1Schema.safeParse(row);
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
