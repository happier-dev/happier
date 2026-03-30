export async function warmInFlight<Key, Result>(
    map: Map<Key, Promise<Result>>,
    key: Key,
    load: () => Promise<Result>,
): Promise<Result> {
    const inFlight = map.get(key);
    if (inFlight) {
        return await inFlight;
    }

    const promise = (async () => {
        try {
            return await load();
        } finally {
            map.delete(key);
        }
    })();
    map.set(key, promise);
    return await promise;
}
