import type { FeaturesPayloadDelta } from './types';

export function resolveServerUsageAnalyticsCapabilitiesFeature(): FeaturesPayloadDelta {
    return {
        capabilities: {
            server: {
                usageAnalytics: {
                    version: 1,
                    eventsIngest: {
                        path: '/v2/usage-events',
                    },
                    query: {
                        path: '/v2/usage/query',
                    },
                    legacy: {
                        usageReportsPath: '/v2/usage-reports',
                        usageQueryPath: '/v1/usage/query',
                    },
                },
            },
        },
    };
}
