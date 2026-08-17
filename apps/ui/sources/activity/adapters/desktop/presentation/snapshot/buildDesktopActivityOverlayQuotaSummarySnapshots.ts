import type { ConnectedServiceQuotaSummary } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';

import type { DesktopActivityOverlayQuotaSummarySnapshot } from './desktopActivityOverlaySnapshotTypes';

function formatRemainingSummary(summary: ConnectedServiceQuotaSummary): string | null {
    const primaryMeter = summary.primaryMeter;
    if (!primaryMeter) {
        return summary.planLabel ? `${summary.planLabel}` : null;
    }

    const remaining = primaryMeter.remainingPct;
    const utilization = primaryMeter.utilizationPct;
    if (remaining == null && utilization == null) {
        return summary.planLabel ? `${summary.planLabel}` : null;
    }

    const meterLabel = primaryMeter.label.trim();
    const remainingLabel = remaining == null ? null : `${remaining}% remaining`;
    const utilizationLabel = utilization == null ? null : `${utilization}% used`;
    const detail = [remainingLabel, utilizationLabel].filter((value): value is string => Boolean(value)).join(' • ');
    if (meterLabel.length === 0) {
        return detail || null;
    }
    return detail ? `${meterLabel}: ${detail}` : meterLabel;
}

export function buildDesktopActivityOverlayQuotaSummarySnapshots(
    summaries: ReadonlyArray<ConnectedServiceQuotaSummary>,
): readonly DesktopActivityOverlayQuotaSummarySnapshot[] {
    return summaries.slice(0, 3).map((summary) => ({
        id: summary.key,
        title: summary.profileLabel?.trim() || summary.serviceLabel,
        summary: formatRemainingSummary(summary),
    }));
}
