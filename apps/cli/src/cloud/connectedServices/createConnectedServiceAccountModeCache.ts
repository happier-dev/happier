import { AsyncTtlCache } from '@happier-dev/protocol';
import { AccountStoredContentClientUpgradeRequiredError } from '@/api/clientCompatibility/accountStoredContentActivation';

export type ConnectedServiceAccountMode = 'e2ee' | 'plain' | 'unknown';

export type ConnectedServiceAccountModeApi = Readonly<{
  getAccountEncryptionMode?: (
    options?: Readonly<{ refresh?: boolean }>,
  ) => Promise<ConnectedServiceAccountMode>;
}>;

const DEFAULT_ACCOUNT_MODE_SUCCESS_TTL_MS = 5_000;
const DEFAULT_ACCOUNT_MODE_ERROR_TTL_MS = 1_000;

function normalizeAccountMode(value: unknown): ConnectedServiceAccountMode {
  return value === 'plain' || value === 'e2ee' ? value : 'unknown';
}

export function createConnectedServiceAccountModeCache(params?: Readonly<{
  successTtlMs?: number;
  errorTtlMs?: number;
  nowMs?: () => number;
}>) {
  const cache = new AsyncTtlCache<Exclude<ConnectedServiceAccountMode, 'unknown'>>({
    successTtlMs: params?.successTtlMs ?? DEFAULT_ACCOUNT_MODE_SUCCESS_TTL_MS,
    errorTtlMs: params?.errorTtlMs ?? DEFAULT_ACCOUNT_MODE_ERROR_TTL_MS,
  });
  const nowMs = params?.nowMs ?? (() => Date.now());
  const apiKeys = new WeakMap<object, string>();
  const generationsByKey = new Map<string, number>();
  const refreshInflightByKey = new Map<string, Promise<ConnectedServiceAccountMode>>();
  let nextApiKey = 0;

  function cacheKeyForApi(api: ConnectedServiceAccountModeApi): string {
    const record = api as object;
    const existing = apiKeys.get(record);
    if (existing) return existing;
    const key = `api:${nextApiKey}`;
    nextApiKey += 1;
    apiKeys.set(record, key);
    return key;
  }

  function readGeneration(key: string): number {
    return generationsByKey.get(key) ?? 0;
  }

  function invalidate(api: ConnectedServiceAccountModeApi): void {
    const key = cacheKeyForApi(api);
    generationsByKey.set(key, readGeneration(key) + 1);
    cache.delete(key);
  }

  function clear(): void {
    generationsByKey.clear();
    refreshInflightByKey.clear();
    cache.clear();
  }

  async function loadMode(
    api: ConnectedServiceAccountModeApi,
    key: string,
    generation: number,
    options?: Readonly<{ refresh?: boolean }>,
  ): Promise<ConnectedServiceAccountMode> {
    try {
      const mode = normalizeAccountMode(
        await (options?.refresh
          ? api.getAccountEncryptionMode?.({ refresh: true })
          : api.getAccountEncryptionMode?.()),
      );
      if (mode === 'unknown') {
        if (readGeneration(key) === generation) cache.setError(key, { nowMs: nowMs() });
        return 'unknown';
      }
      if (readGeneration(key) === generation) cache.setSuccess(key, mode, { nowMs: nowMs() });
      return mode;
    } catch (error) {
      if (error instanceof AccountStoredContentClientUpgradeRequiredError) {
        throw error;
      }
      if (readGeneration(key) === generation) cache.setError(key, { nowMs: nowMs() });
      return 'unknown';
    }
  }

  async function resolve(api: ConnectedServiceAccountModeApi): Promise<ConnectedServiceAccountMode> {
    if (typeof api.getAccountEncryptionMode !== 'function') return 'unknown';
    const key = cacheKeyForApi(api);
    const cached = cache.get(key);
    const now = nowMs();
    if (cached && cache.isFresh(cached, now)) return cached.kind === 'success' ? cached.value : 'unknown';

    return await cache.runDedupe(key, async () => {
      const cachedAfterDedupe = cache.get(key);
      const dedupeNow = nowMs();
      if (cachedAfterDedupe && cache.isFresh(cachedAfterDedupe, dedupeNow)) {
        return cachedAfterDedupe.kind === 'success' ? cachedAfterDedupe.value : 'unknown';
      }
      return await loadMode(api, key, readGeneration(key));
    });
  }

  async function refresh(api: ConnectedServiceAccountModeApi): Promise<ConnectedServiceAccountMode> {
    if (typeof api.getAccountEncryptionMode !== 'function') return 'unknown';
    const key = cacheKeyForApi(api);
    const cached = cache.get(key);
    const now = nowMs();
    if (cached?.kind === 'error' && cache.isFresh(cached, now)) return 'unknown';
    const existing = refreshInflightByKey.get(key);
    if (existing) return await existing;
    invalidate(api);
    const generation = readGeneration(key);
    const refreshed = loadMode(api, key, generation, { refresh: true }).finally(() => {
      if (refreshInflightByKey.get(key) === refreshed) refreshInflightByKey.delete(key);
    });
    refreshInflightByKey.set(key, refreshed);
    return await refreshed;
  }

  return { clear, invalidate, refresh, resolve };
}
