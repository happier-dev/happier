import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { USAGE_PRICE_ACTION_IDS } from '@happier-dev/protocol/usage/usageActionIdsV1';

export const accountUsageRoutePaths = {
    prices: getActionSpec(USAGE_PRICE_ACTION_IDS.get).serverTransport!.path,
    pricesRefresh: getActionSpec(USAGE_PRICE_ACTION_IDS.refresh).serverTransport!.path,
    legacyQuery: '/v1/usage/query',
    analyticsQuery: '/v2/usage/query',
    analyticsQueryBatch: '/v2/usage/query-batch',
    analyticsEventsIngest: '/v2/usage-events',
    nativeHistoryDelete: '/v2/usage-events/delete-native-history',
    legacyReportsIngest: '/v2/usage-reports',
} as const;
