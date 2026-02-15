import { ensureKokoroCacheApiAvailable } from '@/voice/kokoro/assets/kokoroCacheApi';

const TRANSFORMERS_CACHE_NAME = 'transformers-cache';
const KOKORO_VOICES_CACHE_NAME = 'kokoro-voices';

function getCacheStorage(): CacheStorage | null {
  const value = (globalThis as any).caches;
  if (!value) return null;
  if (typeof value.open !== 'function' || typeof value.delete !== 'function') return null;
  return value as CacheStorage;
}

async function countCacheKeys(cacheName: string): Promise<number> {
  await ensureKokoroCacheApiAvailable();
  const caches = getCacheStorage();
  if (!caches) return 0;
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    return Array.isArray(keys) ? keys.length : 0;
  } catch {
    return 0;
  }
}

export async function getKokoroBrowserCacheSummary(): Promise<{
  transformersCacheCount: number;
  kokoroVoicesCacheCount: number;
}> {
  const [transformersCacheCount, kokoroVoicesCacheCount] = await Promise.all([
    countCacheKeys(TRANSFORMERS_CACHE_NAME),
    countCacheKeys(KOKORO_VOICES_CACHE_NAME),
  ]);
  return { transformersCacheCount, kokoroVoicesCacheCount };
}

export async function clearKokoroBrowserCaches(): Promise<void> {
  await ensureKokoroCacheApiAvailable();
  const caches = getCacheStorage();
  if (!caches) return;

  await Promise.all([
    caches.delete(TRANSFORMERS_CACHE_NAME).catch(() => false),
    caches.delete(KOKORO_VOICES_CACHE_NAME).catch(() => false),
  ]);
}
