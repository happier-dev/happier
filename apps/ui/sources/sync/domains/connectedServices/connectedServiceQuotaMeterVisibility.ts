import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol/connect/connected-service-schemas';

import { deriveQuotaMeterValues } from './deriveQuotaUtilizationPct';

/** Empty provider placeholders stay in the snapshot, but only useful or pinned windows are displayed. */
export function isConnectedServiceQuotaMeterVisible(
    meter: ConnectedServiceQuotaMeterV1,
    nowMs: number,
    pinnedMeterIds: readonly string[] = [],
): boolean {
    const { usedPct, used } = deriveQuotaMeterValues(meter);
    const resetsAt = meter.resetAtMs ?? meter.resetsAt;
    return usedPct !== null
        || (typeof used === 'number' && Number.isFinite(used))
        || (meter.status !== 'unavailable' && typeof meter.remaining === 'number' && Number.isFinite(meter.remaining))
        || (resetsAt !== null && resetsAt > 0 && Number.isFinite(resetsAt) && resetsAt >= nowMs)
        || pinnedMeterIds.includes(meter.meterId);
}
