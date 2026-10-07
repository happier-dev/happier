import { vi } from 'vitest';

/** Browser persistence SDK boundary; the real Artifact store and custody owner run above it. */
export function installPluginArtifactCacheBoundary() {
    const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
    const stores = new Map<string, Map<string, Response>>();
    let failDelete = false;
    let deletionAttempts = 0;
    const requestUrl = (request: RequestInfo | URL) => typeof request === 'string'
        ? request : request instanceof URL ? request.href : request.url;
    const caches: CacheStorage = {
        open: async (name) => {
            const records = stores.get(name) ?? new Map<string, Response>();
            stores.set(name, records);
            const cache: Cache = {
                match: async (request) => records.get(requestUrl(request))?.clone(),
                matchAll: async (request) => request
                    ? [...records.entries()].filter(([url]) => url === requestUrl(request)).map(([, response]) => response.clone())
                    : [...records.values()].map((response) => response.clone()),
                put: async (request, response) => { records.set(requestUrl(request), response.clone()); },
                delete: async (request) => {
                    deletionAttempts += 1;
                    if (failDelete) throw new Error('simulated cache deletion failure');
                    return records.delete(requestUrl(request));
                },
                keys: async () => [...records.keys()].map((url) => new Request(url)),
                add: async () => { throw new Error('Unexpected Cache.add: Artifact bytes are supplied by the real store.'); },
                addAll: async () => { throw new Error('Unexpected Cache.addAll: Artifact bytes are supplied by the real store.'); },
            };
            return cache;
        },
        delete: async (name) => stores.delete(name),
        has: async (name) => stores.has(name),
        keys: async () => [...stores.keys()],
        match: async () => undefined,
    };
    // Install before importing the real bundle cache: it selects the physical SDK once.
    vi.stubGlobal('caches', caches);
    return {
        caches,
        get deletionAttempts() { return deletionAttempts; },
        rejectDeletes(reject: boolean) { failDelete = reject; },
        reset() { stores.clear(); failDelete = false; deletionAttempts = 0; },
        dispose() {
            if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
            else Reflect.deleteProperty(globalThis, 'caches');
        },
    };
}
