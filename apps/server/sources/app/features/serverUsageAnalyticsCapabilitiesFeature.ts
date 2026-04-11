import type { FeaturesPayloadDelta } from './types';
import { accountUsageRoutePaths } from '../api/routes/account/accountUsageRoutePaths';

export function resolveServerUsageAnalyticsCapabilitiesFeature(): FeaturesPayloadDelta {
    return {
        capabilities: {
            server: {
                usageAnalytics: {
                    version: 1,
                    eventsIngest: {
                        path: accountUsageRoutePaths.analyticsEventsIngest,
                    },
                    query: {
                        path: accountUsageRoutePaths.analyticsQuery,
                    },
                    legacy: {
                        usageReportsPath: accountUsageRoutePaths.legacyReportsIngest,
                        usageQueryPath: accountUsageRoutePaths.legacyQuery,
                    },
                },
            },
        },
    };
}
