import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import { probeAuthenticatedServerFeaturesEndpoint } from '@/sync/api/capabilities/serverFeaturesClient';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

function trimBaseUrl(endpoint: string): string {
    return endpoint.replace(/\/+$/, '');
}

export function createSyncSocketReadinessProbe(params: Readonly<{
    endpoint: string;
    token: string;
}>): () => Promise<ReadinessProbeResult> {
    const endpoint = trimBaseUrl(params.endpoint);

    return async () => {
        try {
            const healthResponse = await runtimeFetch(`${endpoint}/health`, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                },
            });

            if (healthResponse.status >= 500) {
                return {
                    status: 'retry_later',
                    errorMessage: `Health check returned ${healthResponse.status}`,
                };
            }
        } catch (error) {
            return {
                status: 'server_unreachable',
                errorMessage: error instanceof Error ? error.message : String(error),
            };
        }

        const authProbeResult = await probeAuthenticatedServerFeaturesEndpoint({
            endpoint,
            token: params.token,
        });
        return authProbeResult;
    };
}
