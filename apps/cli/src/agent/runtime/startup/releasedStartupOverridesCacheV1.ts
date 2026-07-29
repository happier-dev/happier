import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { PermissionMode } from '@/api/types';
import { isPermissionMode } from '@/api/types';
import { configuration } from '@/configuration';

/**
 * Compatibility owner for the deployed Codex provider-resume cache from cli-v0.2.0
 * (526aa0db60a36db0f05ba4566ea443e397486424). This reader/writer preserves that
 * exact on-disk startup-seed direction. Remove it only after supported releases no
 * longer require the V1 Codex resume contract and its contraction is approved.
 */
export type ReleasedStartupOverridesCacheEntryV1 = Readonly<{
  permissionMode: PermissionMode;
  permissionModeUpdatedAt: number;
  modelId: string | null;
  modelUpdatedAt: number;
  updatedAt: number;
}>;

type ReleasedStartupOverridesCacheFileV1 = Readonly<{
  version: 1;
  byBackend: Readonly<Record<string, ReleasedStartupOverridesCacheEntryV1>>;
}>;

const EMPTY_CACHE: ReleasedStartupOverridesCacheFileV1 = { version: 1, byBackend: {} };
let inMemory: ReleasedStartupOverridesCacheFileV1 | null = null;
let persistInFlight: Promise<void> | null = null;
let pendingPersist: ReleasedStartupOverridesCacheFileV1 | null = null;

function resolveCachePath(): string {
  return join(configuration.happyHomeDir, 'cli', 'startup-overrides-cache.json');
}

function kickPersist(): void {
  if (persistInFlight || !pendingPersist) return;
  const filePath = resolveCachePath();
  const temporaryPath = `${filePath}.tmp`;
  persistInFlight = (async () => {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      while (pendingPersist) {
        const snapshot = pendingPersist;
        pendingPersist = null;
        await writeFile(temporaryPath, JSON.stringify(snapshot), 'utf8');
        await rename(temporaryPath, filePath);
      }
    } catch {
      // Released V1 cache writes are best-effort compatibility state.
    } finally {
      persistInFlight = null;
      kickPersist();
    }
  })();
}

function normalizeEntry(value: unknown): ReleasedStartupOverridesCacheEntryV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const permissionMode = typeof record.permissionMode === 'string'
    && isPermissionMode(record.permissionMode)
      ? record.permissionMode
      : null;
  const permissionModeUpdatedAt =
    typeof record.permissionModeUpdatedAt === 'number' ? record.permissionModeUpdatedAt : 0;
  const modelId = typeof record.modelId === 'string'
    ? record.modelId
    : record.modelId === null
      ? null
      : null;
  const modelUpdatedAt = typeof record.modelUpdatedAt === 'number' ? record.modelUpdatedAt : 0;
  const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : 0;
  if (!permissionMode || permissionModeUpdatedAt <= 0 || updatedAt <= 0) return null;
  return {
    permissionMode,
    permissionModeUpdatedAt,
    modelId,
    modelUpdatedAt,
    updatedAt,
  };
}

function loadCacheOnce(): ReleasedStartupOverridesCacheFileV1 {
  if (inMemory) return inMemory;
  const filePath = resolveCachePath();
  if (!existsSync(filePath)) {
    inMemory = EMPTY_CACHE;
    return inMemory;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      inMemory = EMPTY_CACHE;
      return inMemory;
    }
    const record = parsed as Readonly<Record<string, unknown>>;
    if (record.version !== 1 || !record.byBackend || typeof record.byBackend !== 'object') {
      inMemory = EMPTY_CACHE;
      return inMemory;
    }
    const byBackend: Record<string, ReleasedStartupOverridesCacheEntryV1> = {};
    for (const [backendId, value] of Object.entries(record.byBackend)) {
      const entry = normalizeEntry(value);
      if (entry) byBackend[backendId] = entry;
    }
    inMemory = { version: 1, byBackend };
    return inMemory;
  } catch {
    inMemory = EMPTY_CACHE;
    return inMemory;
  }
}

export function readReleasedStartupOverridesCacheV1(params: Readonly<{
  backendId: string;
  nowMs: number;
  maxAgeMs: number;
}>): ReleasedStartupOverridesCacheEntryV1 | null {
  const entry = loadCacheOnce().byBackend[params.backendId];
  if (!entry) return null;
  return params.maxAgeMs >= 0 && params.nowMs - entry.updatedAt > params.maxAgeMs
    ? null
    : entry;
}

export function writeReleasedStartupOverridesCacheV1(params: Readonly<{
  backendId: string;
}> & ReleasedStartupOverridesCacheEntryV1): void {
  const cache = loadCacheOnce();
  const existing = cache.byBackend[params.backendId];
  if (existing && existing.updatedAt >= params.updatedAt) return;
  const next: ReleasedStartupOverridesCacheFileV1 = {
    version: 1,
    byBackend: {
      ...cache.byBackend,
      [params.backendId]: {
        permissionMode: params.permissionMode,
        permissionModeUpdatedAt: params.permissionModeUpdatedAt,
        modelId: params.modelId,
        modelUpdatedAt: params.modelUpdatedAt,
        updatedAt: params.updatedAt,
      },
    },
  };
  inMemory = next;
  pendingPersist = next;
  kickPersist();
}
