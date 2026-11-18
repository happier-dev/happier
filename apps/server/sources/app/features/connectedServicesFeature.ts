import type { FeaturesPayloadDelta } from "./types";
import { readConnectedServicesFeatureEnv } from "./catalog/readFeatureEnv";
import { readServerConfig } from "@happier-dev/protocol/serverConfig/serverConfigCodec";
import { SERVER_CONFIG } from "@happier-dev/protocol/serverConfig/registry";
import { ConnectedAccountPublicOAuthClientV1Schema } from "@happier-dev/protocol/features/payload/capabilities/connectedServicesCapabilities";

/**
 * The Home's public OAuth clients, one row per Connected Account service. Each
 * client id is per Home because the callback is the Home's web origin. A row is
 * advertised only when its client id (and scopes) are configured and valid.
 */
function readPublicOAuthClients(env: NodeJS.ProcessEnv) {
    const rows = [
        {
            service: { pluginId: "happier.deploy.cloudflare", localId: "cloudflare" },
            clientId: readServerConfig(env, SERVER_CONFIG.HAPPIER_CONNECTED_SERVICES_CLOUDFLARE_OAUTH_CLIENT_ID),
            scopesByMode: { oauth: readServerConfig(env, SERVER_CONFIG.HAPPIER_CONNECTED_SERVICES_CLOUDFLARE_OAUTH_SCOPES) },
        },
        {
            // Vercel permissions are set on the app, so consent asks only for identity and offline access.
            service: { pluginId: "happier.machine.vercel", localId: "vercel-account" },
            clientId: readServerConfig(env, SERVER_CONFIG.HAPPIER_CONNECTED_SERVICES_VERCEL_OAUTH_CLIENT_ID),
            scopesByMode: { oauth: ["openid", "email", "profile", "offline_access"] },
        },
    ];
    // Validate per row: the client-side schema drops the whole list on one malformed row.
    return rows.flatMap(row => {
        const parsed = ConnectedAccountPublicOAuthClientV1Schema.safeParse({ ...row, clientId: row.clientId.trim() });
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
