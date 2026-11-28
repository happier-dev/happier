import type { FeaturesPayloadDelta } from './types';
import { readPeerMediationFeatureEnv, readTeamsFeatureEnv } from './catalog/readFeatureEnv';
import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_API_BASE_PATH_V1, TEAM_CREDENTIAL_EXTERNAL_PROVIDER_PROTOCOLS_V1 } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import { resolveConfiguredPublicServerUrl } from '@/app/serverUrls/effectiveServerUrls';

function resolveExternalApiDeploymentAvailability(env: NodeJS.ProcessEnv) {
    const config = readTeamsFeatureEnv(env);
    if (!config.enabled || !config.credentialResourcesEnabled || !config.credentialResourcesExternalApiEnabled) {
        return { available: false as const, reason: 'feature_disabled' as const };
    }
    const publicServerUrl = resolveConfiguredPublicServerUrl(env);
    if (!publicServerUrl) {
        return { available: false as const, reason: 'home_not_public_https' as const };
    }
    const parsed = new URL(publicServerUrl);
    if (parsed.protocol !== 'https:') {
        return { available: false as const, reason: 'home_not_public_https' as const };
    }
    if (!readPeerMediationFeatureEnv(env).substrateEnabled) {
        return { available: false as const, reason: 'deployment_readiness_unavailable' as const };
    }
    return {
        available: true as const,
        baseUrl: `${publicServerUrl.replace(/\/+$/u, '')}${TEAM_CREDENTIAL_EXTERNAL_PROVIDER_API_BASE_PATH_V1}`,
        protocols: TEAM_CREDENTIAL_EXTERNAL_PROVIDER_PROTOCOLS_V1,
    };
}

export function resolveTeamsFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const config = readTeamsFeatureEnv(env);
    return {
        features: {
            teams: {
                enabled: config.enabled,
                credentialResources: {
                    enabled: config.credentialResourcesEnabled,
                    externalApi: { enabled: config.credentialResourcesExternalApiEnabled },
                },
            },
        },
        capabilities: {
            teams: {
                ...(config.enabled ? { summariesReadBatchVersion: 1 as const } : {}),
                credentialResources: {
                    externalApi: resolveExternalApiDeploymentAvailability(env),
                },
            },
        },
    };
}
