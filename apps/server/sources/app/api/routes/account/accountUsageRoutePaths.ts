export const accountUsageRoutePaths = {
    prices: '/v1/account/usage/prices',
    pricesRefresh: '/v1/account/usage/prices/refresh',
    legacyQuery: '/v1/usage/query',
    analyticsQuery: '/v2/usage/query',
    analyticsEventsIngest: '/v2/usage-events',
    nativeHistoryDelete: '/v2/usage-events/delete-native-history',
    legacyReportsIngest: '/v2/usage-reports',
} as const;
