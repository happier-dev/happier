import { t } from '@/text';
import type { UsageFilterState } from '@/sync/api/account/usageAnalytics';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';

export function buildUsageCurrentStreakSubtitle(
    period: UsageFilterState['period'],
    activeDays: number,
): string {
    return t('usage.summary.currentStreakSubtitleForPeriod', {
        count: activeDays,
        period: t(getUsagePeriodDefinition(period).translationKey),
    });
}
