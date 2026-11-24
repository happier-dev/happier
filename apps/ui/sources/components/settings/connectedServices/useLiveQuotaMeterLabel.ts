import { useDeadlineSeconds } from '@/hooks/time/useDeadlineSeconds';
import { formatQuotaMeterRemaining } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { formatResetCountdown, type ResetCountdownFormatter } from '@/sync/domains/connectedServices/formatResetCountdown';
import { t } from '@/text';

export const QUOTA_RESET_COUNTDOWN_FORMATTER: ResetCountdownFormatter = {
    durationNow: () => t('connectedServices.quota.duration.now'),
    durationOutdated: () => t('connectedServices.quota.duration.outdated'),
    durationDaysHours: (params) => t('connectedServices.quota.duration.daysHours', params),
    durationHoursMinutes: (params) => t('connectedServices.quota.duration.hoursMinutes', params),
    durationHours: (params) => t('connectedServices.quota.duration.hours', params),
    durationMinutes: (params) => t('connectedServices.quota.duration.minutes', params),
    durationSeconds: (params) => t('connectedServices.quota.duration.seconds', params),
};

export function useLiveQuotaMeterLabel(params: Readonly<{
    resetAtMs: number | null | undefined;
    presented: boolean;
    remainingPct: number | null;
    detailLabel: string;
    surface: 'account' | 'composer';
}>): string {
    const resetAtMs = typeof params.resetAtMs === 'number' && Number.isFinite(params.resetAtMs) ? params.resetAtMs : null;
    const seconds = useDeadlineSeconds(resetAtMs, params.presented);
    if (resetAtMs === null || !params.presented) return params.detailLabel;
    const resetLabel = seconds > 0 ? formatResetCountdown(0, seconds * 1_000, QUOTA_RESET_COUNTDOWN_FORMATTER) : null;
    return formatQuotaMeterRemaining(params.remainingPct, resetLabel, {
        unavailable: () => t('common.unavailable'),
        remaining: (input) => params.surface === 'account'
            ? t('connectedServices.quota.remaining', input)
            : t('agentInput.providerUsage.remaining', input),
        remainingWithReset: (input) => params.surface === 'account'
            ? t('connectedServices.quota.remainingWithReset', input)
            : t('agentInput.providerUsage.remainingWithReset', input),
    });
}
