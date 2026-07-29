export async function getOrLoadConnectedServiceCatalogHook<K, T>(
  cache: Map<K, Promise<T>>,
  key: K,
  load: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing) return await existing;

  const loadedPromise = load();
  const cachedPromise = loadedPromise.catch((error: unknown) => {
    if (cache.get(key) === cachedPromise) {
      cache.delete(key);
    }
    throw error;
  });
  cache.set(key, cachedPromise);
  return await cachedPromise;
}
