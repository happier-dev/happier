import { readConnectedServiceLimitCategoryV1, readProviderAccountUsageRecordIdsFromMetadata } from '@happier-dev/protocol';

import { readStoredProviderAccountUsageSnapshot } from '@/daemon/connectedServices/accountUsage/hydration';
import { normalizeQuotaMeter } from '@/daemon/connectedServices/quotas/normalization';
import type { SessionUsageLimitRecoveryControlAdapterParams } from './sessionUsageLimitRecoveryControlTypes';

/** Read the stored account observations linked to this session; never query the provider or borrow another account. */
export async function readCachedUsageLimitRecoveryWindows(
  params: SessionUsageLimitRecoveryControlAdapterParams,
  providerId: string,
) {
  const recordIds = readProviderAccountUsageRecordIdsFromMetadata(params.metadata);
  const credentials = params.credentials;
  if (!credentials || recordIds.length === 0) return [];
  const { ApiClient } = await import('@/api/api');
  const api = await ApiClient.create(credentials);
  const accountEncryptionMode = await api.getAccountEncryptionMode().catch(() => 'unknown' as const);
  const observations = await Promise.all(recordIds.map(async (recordId) => (
    await readStoredProviderAccountUsageSnapshot({ api, credentials, recordId, accountEncryptionMode })
  )));
  return observations.flatMap((observation) => {
    if (!observation || observation.snapshot.providerId !== providerId) return [];
    return observation.snapshot.meters.flatMap((meter) => {
      const limitCategory = readConnectedServiceLimitCategoryV1(meter.details.limitCategory) ?? 'usage_limit';
      if (meter.status === 'unavailable' || (limitCategory !== 'usage_limit' && limitCategory !== 'rate_limit')) return [];
      const normalized = normalizeQuotaMeter({
        meterId: meter.meterId, label: meter.label, limitCategory,
        remainingPct: meter.remainingPct, utilizationPct: meter.utilizationPct,
        used: meter.used, limit: meter.limit, resetAtMs: meter.resetAtMs ?? meter.resetsAt,
      });
      return [{ remainingPct: normalized.remainingPct, resetAtMs: normalized.resetAtMs }];
    });
  });
}
