// Native MMKV identifies its backing store by configuration, not JS instance.
type StoredValue = string | number | boolean | ArrayBuffer;
const stores = new Map<string, Map<string, StoredValue>>();

/** Clear native backing contents without invalidating existing MMKV handles. */
export function resetMmkvStoresForTests(): void {
    for (const values of stores.values()) values.clear();
}

export class MMKV {
    private readonly values: Map<string, StoredValue>;

    constructor(configuration: Readonly<{ id: string; path?: string }> = { id: 'mmkv.default' }) {
        const storageKey = JSON.stringify([configuration.path ?? null, configuration.id]);
        let values = stores.get(storageKey);
        if (!values) {
            values = new Map();
            stores.set(storageKey, values);
        }
        this.values = values;
    }

    getString(key: string): string | undefined {
        const value = this.values.get(key);
        return typeof value === 'string' ? value : undefined;
    }

    getNumber(key: string): number | undefined {
        const value = this.values.get(key);
        return typeof value === 'number' ? value : undefined;
    }

    getBoolean(key: string): boolean | undefined {
        const value = this.values.get(key);
        return typeof value === 'boolean' ? value : undefined;
    }

    getBuffer(key: string): ArrayBuffer | undefined {
        const value = this.values.get(key);
        return value instanceof ArrayBuffer ? value : undefined;
    }

    set(key: string, value: StoredValue): void {
        this.values.set(key, value);
    }

    delete(key: string): void {
        this.values.delete(key);
    }

    getAllKeys(): string[] {
        return [...this.values.keys()];
    }

    clearAll(): void {
        this.values.clear();
    }
}
