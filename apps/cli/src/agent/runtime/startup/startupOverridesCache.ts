import type { PermissionMode } from '@/api/types';
import { configuration } from '@/configuration';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type CachedOverrides = Readonly<{
  permissionMode: PermissionMode;
  permissionModeUpdatedAt: number;
  modelId: string | null;
  modelUpdatedAt: number;
  updatedAt: number;
}>;

type CacheFileV1 = Readonly<{
  version: 1;
  byBackend: Readonly<Record<string, CachedOverrides>>;
}>;

const DEFAULT_CACHE: CacheFileV1 = { version: 1, byBackend: {} };

function resolveCachePath(): string {
  return join(configuration.happyHomeDir, 'cli', 'startup-overrides-cache.json');
}

let inMemory: CacheFileV1 | null = null;
let persistInFlight: Promise<void> | null = null;

function loadCacheOnce(): CacheFileV1 {
  if (inMemory) return inMemory;

  const filePath = resolveCachePath();
  if (!existsSync(filePath)) {
    inMemory = DEFAULT_CACHE;
    return inMemory;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CacheFileV1> | null;
    if (!parsed || parsed.version !== 1 || !parsed.byBackend || typeof parsed.byBackend !== 'object') {
      inMemory = DEFAULT_CACHE;
      return inMemory;
    }
    const normalized: Record<string, CachedOverrides> = {};
    for (const [backendId, value] of Object.entries(parsed.byBackend as Record<string, unknown>)) {
      const entry = normalizeCachedOverrides(value);
      if (!entry) continue;
      normalized[backendId] = entry;
    }
    inMemory = { version: 1, byBackend: normalized };
    return inMemory;
  } catch {
    inMemory = DEFAULT_CACHE;
    return inMemory;
  }
}

function normalizeCachedOverrides(value: unknown): CachedOverrides | null {
  const obj = value as any;
  const permissionMode = typeof obj?.permissionMode === 'string' ? (obj.permissionMode as PermissionMode) : null;
  const permissionModeUpdatedAt = typeof obj?.permissionModeUpdatedAt === 'number' ? obj.permissionModeUpdatedAt : 0;
  const modelIdRaw = obj?.modelId;
  const modelId = typeof modelIdRaw === 'string' ? modelIdRaw : modelIdRaw === null ? null : null;
  const modelUpdatedAt = typeof obj?.modelUpdatedAt === 'number' ? obj.modelUpdatedAt : 0;
  const updatedAt = typeof obj?.updatedAt === 'number' ? obj.updatedAt : 0;
  if (!permissionMode || permissionModeUpdatedAt <= 0 || updatedAt <= 0) return null;
  return {
    permissionMode,
    permissionModeUpdatedAt,
    modelId,
    modelUpdatedAt,
    updatedAt,
  };
}

export function readStartupOverridesCacheForBackend(opts: {
  backendId: string;
  nowMs: number;
  maxAgeMs: number;
}): CachedOverrides | null {
  const cache = loadCacheOnce();
  const entry = cache.byBackend[opts.backendId];
  if (!entry) return null;
  if (opts.maxAgeMs >= 0 && opts.nowMs - entry.updatedAt > opts.maxAgeMs) {
    return null;
  }
  return entry;
}

export function writeStartupOverridesCacheForBackend(opts: {
  backendId: string;
  permissionMode: PermissionMode;
  permissionModeUpdatedAt: number;
  modelId: string | null;
  modelUpdatedAt: number;
  updatedAt: number;
}): void {
  const cache = loadCacheOnce();
  const existing = cache.byBackend[opts.backendId];
  if (existing && existing.updatedAt >= opts.updatedAt) {
    return;
  }

  const next: CacheFileV1 = {
    version: 1,
    byBackend: {
      ...cache.byBackend,
      [opts.backendId]: {
        permissionMode: opts.permissionMode,
        permissionModeUpdatedAt: opts.permissionModeUpdatedAt,
        modelId: opts.modelId,
        modelUpdatedAt: opts.modelUpdatedAt,
        updatedAt: opts.updatedAt,
      },
    },
  };
  inMemory = next;
  void persistCache(next);
}

async function persistCache(cache: CacheFileV1): Promise<void> {
  if (persistInFlight) return persistInFlight;

  const filePath = resolveCachePath();
  const dir = dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  persistInFlight = (async () => {
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(tmpPath, JSON.stringify(cache), 'utf-8');
      await rename(tmpPath, filePath);
    } catch {
      // ignore
    } finally {
      persistInFlight = null;
    }
  })();
  return persistInFlight;
}
