// External device-database boundary. The source harness never opens or mutates IndexedDB.
const records = new Map<string, string>();

export async function readBrowserRecord(key: string): Promise<string | undefined> { return records.get(key); }
export async function updateBrowserRecord<T>(key: string, update: (current: string | undefined) => { value: string | undefined; result: T }): Promise<T> {
    const next = update(records.get(key));
    if (next.value === undefined) records.delete(key);
    else records.set(key, next.value);
    return next.result;
}
export async function writeBrowserRecord(key: string, value: string): Promise<void> { records.set(key, value); }
export async function deleteBrowserRecord(key: string): Promise<void> { records.delete(key); }
export async function clearBrowserRecords(): Promise<void> { records.clear(); }
export function clearEmbedBrowserRecords(): void { records.clear(); }
export async function listBrowserRecords(prefix: string): Promise<Map<string, string>> {
    return new Map([...records].filter(([key]) => key.startsWith(prefix)));
}
