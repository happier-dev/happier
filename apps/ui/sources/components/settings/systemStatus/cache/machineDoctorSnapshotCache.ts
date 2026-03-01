import { MMKV } from 'react-native-mmkv';
import {
  DoctorSnapshotSchema,
  sanitizeDoctorSnapshotUrls,
  type DoctorSnapshot,
} from '@happier-dev/protocol';

export type CachedMachineDoctorSnapshot = Readonly<{
  cachedAt: number;
  snapshot: DoctorSnapshot;
}>;

const storage = new MMKV();
const CACHE_PREFIX = 'system-status.machineDoctorSnapshot.v1';

export function buildMachineDoctorSnapshotCacheKey(input: Readonly<{ serverId: string; machineId: string }>): string {
  return `${CACHE_PREFIX}:${input.serverId}:${input.machineId}`;
}

export function readCachedMachineDoctorSnapshot(input: Readonly<{ serverId: string; machineId: string }>): CachedMachineDoctorSnapshot | null {
  const key = buildMachineDoctorSnapshotCacheKey(input);
  const raw = storage.getString(key);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    storage.delete(key);
    return null;
  }

  const cachedAt = (parsed as { cachedAt?: unknown }).cachedAt;
  const snapshot = (parsed as { snapshot?: unknown }).snapshot;
  if (typeof cachedAt !== 'number') {
    storage.delete(key);
    return null;
  }

  const result = DoctorSnapshotSchema.safeParse(snapshot);
  if (!result.success) {
    storage.delete(key);
    return null;
  }

  return {
    cachedAt,
    snapshot: sanitizeDoctorSnapshotUrls(result.data),
  };
}

export function writeCachedMachineDoctorSnapshot(input: Readonly<{ serverId: string; machineId: string; cachedAt: number; snapshot: DoctorSnapshot }>): void {
  const key = buildMachineDoctorSnapshotCacheKey(input);
  const result = DoctorSnapshotSchema.safeParse(input.snapshot);
  if (!result.success) return;

  storage.set(key, JSON.stringify({
    cachedAt: input.cachedAt,
    snapshot: sanitizeDoctorSnapshotUrls(result.data),
  }));
}

export function clearCachedMachineDoctorSnapshot(input: Readonly<{ serverId: string; machineId: string }>): void {
  storage.delete(buildMachineDoctorSnapshotCacheKey(input));
}
