import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';

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

        try {
            const authResponse = await runtimeFetch(`${endpoint}/v1/features`, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${params.token}`,
                },
            });

            if (authResponse.status === 401 || authResponse.status === 403) {
                return {
                    status: 'auth_failed',
                    statusCode: authResponse.status,
                    errorMessage: `Authenticated probe returned ${authResponse.status}`,
                };
            }

            if (authResponse.status >= 500) {
                return {
                    status: 'retry_later',
                    errorMessage: `Authenticated probe returned ${authResponse.status}`,
                };
            }

            return { status: 'ready' };
        } catch (error) {
            return {
                status: 'server_unreachable',
                errorMessage: error instanceof Error ? error.message : String(error),
            };
        }
    };
}
