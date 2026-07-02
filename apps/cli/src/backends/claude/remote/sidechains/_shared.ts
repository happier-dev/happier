import { LruSet, setBoundedMap } from '@/utils/collections/lru';

export { LruSet, setBoundedMap };

export function markUuidSeenAndReturnIsDuplicate(params: {
  seenUuidsBySidechainId: Map<string, LruSet>;
  sidechainId: string;
  uuid: string;
  maxSeenUuidsPerSidechain: number;
  maxSidechains?: number;
}): boolean {
  const uuid = String(params.uuid ?? '').trim();
  if (!uuid) return false;

  const existing = params.seenUuidsBySidechainId.get(params.sidechainId) ?? null;
  const seen = existing ?? new LruSet(params.maxSeenUuidsPerSidechain);
  if (!existing) {
    if (typeof params.maxSidechains === 'number') {
      setBoundedMap(params.seenUuidsBySidechainId, params.sidechainId, seen, params.maxSidechains);
    } else {
      params.seenUuidsBySidechainId.set(params.sidechainId, seen);
    }
  } else if (typeof params.maxSidechains === 'number') {
    // refresh insertion order for bounded maps
    setBoundedMap(params.seenUuidsBySidechainId, params.sidechainId, existing, params.maxSidechains);
  }

  if (seen.has(uuid)) return true;
  seen.add(uuid);
  return false;
}
