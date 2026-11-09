import { Platform } from 'react-native';

// Native MMKV identifies its backing store by configuration, not JS instance.
type StoredValue = string | number | boolean | ArrayBuffer;
type NativeStores = Map<string, Map<string, StoredValue>>;
const storesKey = Symbol.for('happier.vitest.mmkvStores');
const nativeRuntime = globalThis as unknown as { [key: symbol]: NativeStores | undefined };
// The native backing outlives JS module reloads, including handles held by cached SDK mocks.
const stores = nativeRuntime[storesKey] ??= new Map<string, Map<string, StoredValue>>();

// Only MMKV 3.3.3's web adapter uses backslash as its store/key separator.
// Keep the default host model strict; explicit native fixtures use the native contract.
function validateWebIdentifier(value: string, kind: 'key' | 'id' = 'key'): void {
    if (Platform.OS !== 'ios' && Platform.OS !== 'android' && value.includes('\\')) {
        throw new Error(`MMKV: \`${kind}\` cannot contain the backslash character (\`\\\`)!`);
    }
}

/** Clear native backing contents without invalidating existing MMKV handles. */
export function resetMmkvStoresForTests(): void {
    for (const values of stores.values()) values.clear();
}

export class MMKV {
    private readonly values: Map<string, StoredValue>;

    constructor(configuration: Readonly<{ id: string; path?: string }> = { id: 'mmkv.default' }) {
        validateWebIdentifier(configuration.id, 'id');
        const storageKey = JSON.stringify([configuration.path ?? null, configuration.id]);
        let values = stores.get(storageKey);
        if (!values) {
            values = new Map();
            stores.set(storageKey, values);
        }
        this.values = values;
    }

    getString(key: string): string | undefined {
        validateWebIdentifier(key);
        const value = this.values.get(key);
        return typeof value === 'string' ? value : undefined;
    }

    getNumber(key: string): number | undefined {
        validateWebIdentifier(key);
        const value = this.values.get(key);
        return typeof value === 'number' ? value : undefined;
    }

    getBoolean(key: string): boolean | undefined {
        validateWebIdentifier(key);
        const value = this.values.get(key);
        return typeof value === 'boolean' ? value : undefined;
    }

    getBuffer(key: string): ArrayBuffer | undefined {
        validateWebIdentifier(key);
        const value = this.values.get(key);
        return value instanceof ArrayBuffer ? value : undefined;
    }

    set(key: string, value: StoredValue): void {
        validateWebIdentifier(key);
        this.values.set(key, value);
    }

    contains(key: string): boolean {
        validateWebIdentifier(key);
        return this.values.has(key);
    }

    delete(key: string): void {
        validateWebIdentifier(key);
        this.values.delete(key);
    }

    getAllKeys(): string[] {
        return [...this.values.keys()];
    }

    clearAll(): void {
        this.values.clear();
    }
}
