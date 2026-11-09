type BrowserRecordStorageModule = typeof import('@/sync/domains/state/browserRecordStorage');

/** IndexedDB boundary fixture; keeps the synchronous transactional update contract. */
export function createBrowserRecordStorageModuleMock(): BrowserRecordStorageModule {
    const records = new Map<string, string>();
    const updateBrowserRecords: BrowserRecordStorageModule['updateBrowserRecords'] = async (keys, update) => {
        const next = update(new Map(keys.map((key) => [key, records.get(key)])));
        for (const [key, value] of next.values) {
            if (value === undefined) records.delete(key);
            else records.set(key, value);
        }
        return next.result;
    };
    const updateBrowserRecord: BrowserRecordStorageModule['updateBrowserRecord'] = (key, update) =>
        updateBrowserRecords([key], (current) => {
            const next = update(current.get(key));
            return { values: new Map([[key, next.value]]), result: next.result };
        });
    return {
        // This fixture substitutes record transactions; callers needing raw IndexedDB must install that OS boundary.
        openBrowserRecordDatabase: async () => { throw new Error('Raw IndexedDB is not configured by the browser record fixture'); },
        readBrowserRecord: async (key) => records.get(key),
        updateBrowserRecord,
        updateBrowserRecords,
        writeBrowserRecord: (key, value) => updateBrowserRecord(key, () => ({ value, result: undefined })),
        deleteBrowserRecord: (key) => updateBrowserRecord(key, () => ({ value: undefined, result: undefined })),
        listBrowserRecords: async (prefix) => new Map([...records].filter(([key]) => key.startsWith(prefix))),
        clearBrowserRecords: async () => { records.clear(); },
        clearEmbedBrowserRecords: () => { records.clear(); },
    };
}
