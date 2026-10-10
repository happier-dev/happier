import { resolveUsageBucketBounds } from '@happier-dev/protocol';

export type UsagePeriod = 'today' | '7days' | '30days' | '90days' | 'year' | 'all';
export type UsagePeriodGranularity = 'hour' | 'day' | 'month';
export type UsageLegacyPeriodGranularity = 'hour' | 'day';

export type UsagePeriodDefinition = Readonly<{
    period: UsagePeriod;
    translationKey: 'usage.today' | 'usage.last7Days' | 'usage.last30Days' | 'usage.last90Days' | 'usage.lastYear' | 'usage.allTime';
    /** The filter bar's compact label ("24h", "7D"). */
    shortTranslationKey: 'usage.periodTodayShort' | 'usage.period7dShort' | 'usage.period30dShort' | 'usage.period90dShort' | 'usage.periodYearShort' | 'usage.periodAllShort';
    rangeDayCount: number;
    granularity: UsagePeriodGranularity;
    legacyGranularity: UsageLegacyPeriodGranularity;
}>;

const usagePeriodDefinitions = {
    today: {
        period: 'today',
        translationKey: 'usage.today',
        shortTranslationKey: 'usage.periodTodayShort',
        rangeDayCount: 1,
        granularity: 'hour',
        legacyGranularity: 'hour',
    },
    '7days': {
        period: '7days',
        translationKey: 'usage.last7Days',
        shortTranslationKey: 'usage.period7dShort',
        rangeDayCount: 7,
        granularity: 'day',
        legacyGranularity: 'day',
    },
    '30days': {
        period: '30days',
        translationKey: 'usage.last30Days',
        shortTranslationKey: 'usage.period30dShort',
        rangeDayCount: 30,
        granularity: 'day',
        legacyGranularity: 'day',
    },
    '90days': {
        period: '90days',
        translationKey: 'usage.last90Days',
        shortTranslationKey: 'usage.period90dShort',
        rangeDayCount: 90,
        granularity: 'day',
        legacyGranularity: 'day',
    },
    year: {
        period: 'year',
        translationKey: 'usage.lastYear',
        shortTranslationKey: 'usage.periodYearShort',
        rangeDayCount: 365,
        granularity: 'month',
        legacyGranularity: 'day',
    },
    // Everything retained: the range starts at the epoch, so no recorded fact is outside it.
    all: {
        period: 'all',
        translationKey: 'usage.allTime',
        shortTranslationKey: 'usage.periodAllShort',
        rangeDayCount: Number.POSITIVE_INFINITY,
        granularity: 'month',
        legacyGranularity: 'day',
    },
} satisfies Record<UsagePeriod, UsagePeriodDefinition>;

export const USAGE_PERIODS = Object.freeze(
    Object.keys(usagePeriodDefinitions) as UsagePeriod[],
) as readonly UsagePeriod[];

export function isUsagePeriod(value: string | null | undefined): value is UsagePeriod {
    return value != null && value in usagePeriodDefinitions;
}

export function getUsagePeriodDefinition(period: UsagePeriod): UsagePeriodDefinition {
    return usagePeriodDefinitions[period];
}

export function resolveUsagePeriodStartTimeSeconds(period: UsagePeriod, nowMs: number, timeZoneOffsetMinutes?: number): number {
    if (period === 'today') {
        if (timeZoneOffsetMinutes !== undefined) {
            return Math.floor(resolveUsageBucketBounds('day', nowMs, timeZoneOffsetMinutes).bucketStartMs / 1000);
        }
        // Team's incumbent local-day request has no fixed-offset query contract.
        // Personal usage readers always pass the selected query offset explicitly.
        const today = new Date(nowMs);
        today.setHours(0, 0, 0, 0);
        return Math.floor(today.getTime() / 1000);
    }

    if (period === 'all') return 0;
    const nowSeconds = Math.floor(nowMs / 1000);
    const oneDaySeconds = 24 * 60 * 60;
    return nowSeconds - (getUsagePeriodDefinition(period).rangeDayCount * oneDaySeconds);
}
