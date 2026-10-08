import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { resolveAgyQuotaPoolForModel, resolveAgyQuotaPoolForLimit, resolveAgyQuotaModelFamily } from '@happier-dev/agents';

/** Model buckets cannot establish the allowance for an unrelated active model. */
export function projectAgyQuotaSnapshotForModel(
    snapshot: ConnectedServiceQuotaSnapshotV1,
    modelId: string | null | undefined,
): ConnectedServiceQuotaSnapshotV1 | null {
    const activeModel = modelId?.trim();
    if (!activeModel) return null;
    const pool = resolveAgyQuotaPoolForModel(activeModel);
    const shared = pool ? snapshot.meters.filter((meter) => resolveAgyQuotaPoolForLimit(meter.providerLimitId) === pool) : [];
    const family = resolveAgyQuotaModelFamily(activeModel);
    const modelMeters = snapshot.meters.filter((meter) => meter.modelId === activeModel || (family && meter.meterId === `family:${family.id}`));
    // Shared five-hour readings replace per-model duplicates. Weekly-only data
    // supplements the model reading, retaining its independently reported limit.
    const hasShortWindow = shared.some((meter) => meter.scope === 'five_hour' || meter.windowDurationMs === 18_000_000);
    const meters = hasShortWindow ? shared : [...modelMeters, ...shared];
    return meters.length > 0 ? { ...snapshot, meters } : null;
}
