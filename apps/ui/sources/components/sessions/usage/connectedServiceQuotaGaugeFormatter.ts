import { t } from '@/text';
import type { ConnectedServiceQuotaGaugeLabelFormatter } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';

export const connectedServiceQuotaGaugeFormatter: ConnectedServiceQuotaGaugeLabelFormatter = {
    unavailable: () => t('common.unavailable'),
    remaining: ({ percent }) => t('agentInput.providerUsage.remaining', { percent }),
    remainingWithReset: ({ percent, reset }) => t('agentInput.providerUsage.remainingWithReset', { percent, reset }),
    used: ({ used, limit }) => t('agentInput.providerUsage.usedCount', { used, limit }),
    durationNow: () => t('agentInput.providerUsage.duration.now'),
    durationOutdated: () => t('agentInput.providerUsage.duration.outdated'),
    durationDaysHours: ({ days, hours }) => t('agentInput.providerUsage.duration.daysHours', { days, hours }),
    durationHoursMinutes: ({ hours, minutes }) => t('agentInput.providerUsage.duration.hoursMinutes', { hours, minutes }),
    durationMinutes: ({ minutes }) => t('agentInput.providerUsage.duration.minutes', { minutes }),
    durationHoursMinutesSeconds: ({ hours, minutes, seconds }) =>
        t('agentInput.providerUsage.duration.hoursMinutesSeconds', { hours, minutes, seconds }),
    durationMinutesSeconds: ({ minutes, seconds }) => t('agentInput.providerUsage.duration.minutesSeconds', { minutes, seconds }),
    subscriptionEnds: ({ date }) => t('connectedServices.subscription.ends', { date }),
    subscriptionEndsInDays: ({ days }) => t('connectedServices.subscription.endsInDays', { days }),
    subscriptionRenews: ({ date }) => t('connectedServices.subscription.renews', { date }),
    subscriptionRenewsInDays: ({ days }) => t('connectedServices.subscription.renewsInDays', { days }),
};
