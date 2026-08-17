import type { ConnectedServiceQuotaGaugeLabelFormatter } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import type { ResetCountdownDaysFormatter } from '@/sync/domains/connectedServices/formatResetCountdown';
import { t } from '@/text';

/**
 * Real `t()`-backed gauge formatter so USAGE rows carry localized
 * remaining/used/reset labels through the canonical domain formatter.
 *
 * Shared by the legacy and qualified account-block containers so the two
 * identity models can never drift into different usage vocabulary.
 */
export const ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER: ConnectedServiceQuotaGaugeLabelFormatter = {
    remaining: ({ percent }) => t('connectedServices.quota.remaining', { percent }),
    remainingWithReset: ({ percent, reset }) =>
        t('connectedServices.quota.remainingWithReset', { percent, reset }),
    used: ({ used, limit }) => t('connectedServices.account.usedDetail', { used, limit }),
    durationNow: () => t('connectedServices.quota.duration.now'),
    durationOutdated: () => t('connectedServices.quota.duration.outdated'),
    durationDaysHours: ({ days, hours }) => t('connectedServices.quota.duration.daysHours', { days, hours }),
    durationHoursMinutes: ({ hours, minutes }) =>
        t('connectedServices.quota.duration.hoursMinutes', { hours, minutes }),
    durationHours: ({ hours }) => t('connectedServices.quota.duration.hours', { hours }),
    durationMinutes: ({ minutes }) => t('connectedServices.quota.duration.minutes', { minutes }),
};

export const ACCOUNT_BLOCK_RESET_COUNTDOWN_DAYS_FORMATTER: ResetCountdownDaysFormatter = {
    now: () => t('connectedServices.account.resets.now'),
    inDays: ({ days }) => t('connectedServices.account.resets.inDays', { days }),
};
