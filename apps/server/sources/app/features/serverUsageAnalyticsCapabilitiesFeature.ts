import type { FeaturesPayloadDelta } from './types';
import { accountUsageRoutePaths } from '../api/routes/account/accountUsageRoutePaths';

export function resolveServerUsageAnalyticsCapabilitiesFeature(): FeaturesPayloadDelta {
    return {
        // Representation support, not an operator rollout switch. Incumbent
        // clients discard this additive feature family and keep their grammar.
        features: { usage: { compactBatch: { enabled: true } } },
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
