import type { UsageRelativePeriod } from '@happier-dev/protocol/inputs/usageQuery';

export type UsagePeriod = UsageRelativePeriod;
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
    // Everything retained; the accounting owner resolves the observed calendar span.
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
