export class LruMap<K, V> {
    private readonly map = new Map<K, V>();
    private maxEntries: number;

    constructor(options: Readonly<{ maxEntries: number }>) {
        const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(0, options.maxEntries) : 0;
        this.maxEntries = maxEntries;
    }

    get size(): number {
        return this.map.size;
    }

    has(key: K): boolean {
        return this.map.has(key);
    }

    get(key: K): V | undefined {
        const existing = this.map.get(key);
        if (existing === undefined) {
            return undefined;
        }

        // Refresh LRU ordering.
        this.map.delete(key);
        this.map.set(key, existing);
        return existing;
    }

    set(key: K, value: V): void {
        if (this.map.has(key)) {
            this.map.delete(key);
        }
        this.map.set(key, value);
        this.evictIfNeeded();
    }

    delete(key: K): boolean {
        return this.map.delete(key);
    }

    clear(): void {
        this.map.clear();
    }

    setMaxEntries(maxEntries: number): void {
        const next = Number.isFinite(maxEntries) ? Math.max(0, maxEntries) : 0;
        this.maxEntries = next;
        this.evictIfNeeded();
    }

    private evictIfNeeded(): void {
        while (this.map.size > this.maxEntries) {
            const oldestKey = this.map.keys().next().value as K | undefined;
            if (oldestKey === undefined) break;
            this.map.delete(oldestKey);
        }
    }
}
