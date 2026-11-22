/**
 * Where a stored amount stands against its limit, decided once for every storage meter (Settings › Storage's limit
 * row and sentence, the Artifacts header meter): `neutral` below the near share, `near` from it (amber, one quiet
 * line), `full` at or over the limit (the cap notice). The near share is the approved storage-view lab's
 * "Near the limit" (scene 2, ≥ 90%); no surface keeps its own threshold.
 */
export type StorageQuotaState = 'neutral' | 'near' | 'full';

const STORAGE_QUOTA_NEAR_SHARE = 0.9;

export function resolveStorageQuotaState(
  usedBytes: number,
  limitBytes: number,
): StorageQuotaState {
  if (usedBytes >= limitBytes) return 'full';
  return limitBytes > 0 && usedBytes / limitBytes >= STORAGE_QUOTA_NEAR_SHARE
    ? 'near'
    : 'neutral';
}
