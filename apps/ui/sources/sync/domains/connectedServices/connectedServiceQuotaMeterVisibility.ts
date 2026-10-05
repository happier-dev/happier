import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';

import { deriveQuotaUtilizationPct } from './deriveQuotaUtilizationPct';

/** Empty provider placeholders stay in the snapshot, but only useful or pinned windows are displayed. */
export function isConnectedServiceQuotaMeterVisible(
    meter: ConnectedServiceQuotaMeterV1,
    nowMs: number,
    pinnedMeterIds: readonly string[] = [],
): boolean {
    const resetsAt = meter.resetAtMs ?? meter.resetsAt;
    return deriveQuotaUtilizationPct(meter) !== null
        || (typeof meter.used === 'number' && Number.isFinite(meter.used)
            && typeof meter.limit === 'number' && Number.isFinite(meter.limit))
        || (resetsAt !== null && resetsAt > 0 && Number.isFinite(resetsAt) && resetsAt >= nowMs)
        || pinnedMeterIds.includes(meter.meterId);
}
