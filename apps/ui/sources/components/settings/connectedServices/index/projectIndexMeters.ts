import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol/connect/connected-service-schemas';

import { selectConnectedServiceQuotaSummaryMeters } from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import { isConnectedServiceQuotaMeterVisible } from '@/sync/domains/connectedServices/connectedServiceQuotaMeterVisibility';
import { presentConnectedServiceQuotaReportedAmount, type ConnectedServiceQuotaReportedAmount } from '@/sync/domains/connectedServices/accountUsage/presentProviderConnectionUsage';

export type ConnectedAccountIndexMeter = Readonly<{
    meterId: string;
    label: string;
    remainingPct: number | null;
    resetsAt: number | null;
    status: ConnectedServiceQuotaMeterV1['status'];
    reportedAmount?: ConnectedServiceQuotaReportedAmount;
}>;

/** Useful and pinned windows, in the provider's order. */
export function projectIndexMeters(
    meters: readonly ConnectedServiceQuotaMeterV1[],
    nowMs: number = Date.now(),
    pinnedMeterIds: readonly string[] = [],
): readonly ConnectedAccountIndexMeter[] {
    return selectConnectedServiceQuotaSummaryMeters({ meters, meterIds: meters.map((meter) => meter.meterId), strategy: 'primary' })
        .flatMap((selected) => {
            if (!selected.meter || !isConnectedServiceQuotaMeterVisible(selected.meter, nowMs, pinnedMeterIds)) return [];
            const reportedAmount = presentConnectedServiceQuotaReportedAmount(selected.meter);
            return [{
                meterId: selected.meterId,
                label: selected.label,
                remainingPct: selected.remainingPct,
                resetsAt: selected.meter.resetAtMs ?? selected.meter.resetsAt ?? null,
                status: selected.meter.status,
                ...(reportedAmount === undefined ? {} : { reportedAmount }),
            }];
        });
}
