import { t } from '@/text';

import type { ConnectedServiceQuotaSummary } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';

import { resolveConnectedServiceDisplayName } from './model/resolveConnectedServiceDisplayName';

export type ConnectedServiceQuotaSummaryCardMeter = Readonly<{
    key: string;
    label: string;
    remainingPct: number | null;
    valueText: string;
    status: ConnectedServiceQuotaSummary['meters'][number]['status'];
}>;

export type ConnectedServiceQuotaSummaryCard = Readonly<{
    key: string;
    title: string;
    value: string;
    subtitle: string;
    meters: ReadonlyArray<ConnectedServiceQuotaSummaryCardMeter>;
}>;

function formatRemainingPct(value: number | null): string {
    if (value === null || !Number.isFinite(value)) {
        return t('usage.noData.title');
    }

    return `${Math.round(value)}%`;
}

export function buildConnectedServiceQuotaSummaryCards(
    summaries: ReadonlyArray<ConnectedServiceQuotaSummary>,
): ReadonlyArray<ConnectedServiceQuotaSummaryCard> {
    return summaries.map((summary) => {
        const subtitleParts = [
            summary.primaryMeter?.label ?? null,
            summary.planLabel,
            summary.profileLabel ?? summary.profileId,
        ].filter((value): value is string => Boolean(value && value.trim()));

        return {
            key: summary.key,
            title: resolveConnectedServiceDisplayName(summary.serviceId, t),
            value: formatRemainingPct(summary.primaryMeter?.remainingPct ?? null),
            subtitle: subtitleParts.join(' · ') || t('usage.noData.title'),
            meters: summary.meters.map((meter) => ({
                key: meter.meterId,
                label: meter.label,
                remainingPct: meter.remainingPct,
                valueText: formatRemainingPct(meter.remainingPct),
                status: meter.status,
            })),
        } satisfies ConnectedServiceQuotaSummaryCard;
    });
}
