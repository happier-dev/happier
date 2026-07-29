import { describe, expect, it, vi } from 'vitest';

import { getOrLoadConnectedServiceCatalogHook } from './catalogHookCache';

describe('connected-service catalog hook cache', () => {
  it('evicts rejected hook loads while concurrent callers share and cache the successful retry', async () => {
    type LoadedHook = Readonly<{ status: 'loaded' }>;
    const cache = new Map<'codex', Promise<LoadedHook>>();
    let attempt = 0;
    let resolveRetry = (_value: LoadedHook): void => {
      throw new Error('retry load did not start');
    };
    const load = vi.fn(async (): Promise<LoadedHook> => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('transient plugin load outage');
      }
      return await new Promise<LoadedHook>((resolve) => {
        resolveRetry = resolve;
      });
    });

    await expect(getOrLoadConnectedServiceCatalogHook(cache, 'codex', load))
      .rejects.toThrow('transient plugin load outage');

    const retryA = getOrLoadConnectedServiceCatalogHook(cache, 'codex', load);
    const retryB = getOrLoadConnectedServiceCatalogHook(cache, 'codex', load);
    const retries = Promise.all([retryA, retryB]);
    void retries.catch(() => undefined);
    expect(load).toHaveBeenCalledTimes(2);
    resolveRetry({ status: 'loaded' });

    await expect(retries).resolves.toEqual([
      { status: 'loaded' },
      { status: 'loaded' },
    ]);
    await expect(getOrLoadConnectedServiceCatalogHook(cache, 'codex', load))
      .resolves.toEqual({ status: 'loaded' });
    expect(load).toHaveBeenCalledTimes(2);

    const nullCache = new Map<'pi', Promise<null>>();
    const loadNull = vi.fn(async () => null);
    await expect(getOrLoadConnectedServiceCatalogHook(nullCache, 'pi', loadNull)).resolves.toBeNull();
    await expect(getOrLoadConnectedServiceCatalogHook(nullCache, 'pi', loadNull)).resolves.toBeNull();
    expect(loadNull).toHaveBeenCalledTimes(1);
  });
});
