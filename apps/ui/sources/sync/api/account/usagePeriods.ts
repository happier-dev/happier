export type UsagePeriod = 'today' | '7days' | '30days' | 'year';
export type UsagePeriodGranularity = 'hour' | 'day' | 'month';
export type UsageLegacyPeriodGranularity = 'hour' | 'day';

export type UsagePeriodDefinition = Readonly<{
    period: UsagePeriod;
    translationKey: 'usage.today' | 'usage.last7Days' | 'usage.last30Days' | 'usage.lastYear';
    rangeDayCount: number;
    granularity: UsagePeriodGranularity;
    legacyGranularity: UsageLegacyPeriodGranularity;
}>;

const usagePeriodDefinitions = {
    today: {
        period: 'today',
        translationKey: 'usage.today',
        rangeDayCount: 1,
        granularity: 'hour',
        legacyGranularity: 'hour',
    },
    '7days': {
        period: '7days',
        translationKey: 'usage.last7Days',
        rangeDayCount: 7,
        granularity: 'day',
        legacyGranularity: 'day',
    },
    '30days': {
        period: '30days',
        translationKey: 'usage.last30Days',
        rangeDayCount: 30,
        granularity: 'day',
        legacyGranularity: 'day',
    },
    year: {
        period: 'year',
        translationKey: 'usage.lastYear',
        rangeDayCount: 365,
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

export function resolveUsagePeriodStartTimeSeconds(period: UsagePeriod, nowMs: number): number {
    if (period === 'today') {
        const today = new Date(nowMs);
        today.setHours(0, 0, 0, 0);
        return Math.floor(today.getTime() / 1000);
    }

    const nowSeconds = Math.floor(nowMs / 1000);
    const oneDaySeconds = 24 * 60 * 60;
    return nowSeconds - (getUsagePeriodDefinition(period).rangeDayCount * oneDaySeconds);
}
