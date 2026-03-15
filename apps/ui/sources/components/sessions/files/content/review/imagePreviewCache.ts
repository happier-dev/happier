export type ImagePreviewCacheKey = Readonly<{
    sessionId: string;
    snapshotSignature: string;
    filePath: string;
}>;

export type ImagePreviewCacheValue =
    | Readonly<{ status: 'loaded'; uri: string }>
    | Readonly<{ status: 'error'; error: string }>;

export type ImagePreviewCacheEntry = Readonly<{
    value: ImagePreviewCacheValue;
    byteSize: number;
    cachedAtMs: number;
    sessionId: string;
    snapshotSignature: string;
    filePath: string;
}>;

export type ImagePreviewCacheOptions = Readonly<{
    maxEntries: number;
    maxTotalBytes: number;
    now: () => number;
}>;

export class ImagePreviewCache {
    private readonly entries = new Map<string, ImagePreviewCacheEntry>();
    private totalBytes = 0;
    private maxEntries: number;
    private maxTotalBytes: number;

    constructor(private readonly options: ImagePreviewCacheOptions) {
        this.maxEntries = Number.isFinite(options.maxEntries) ? Math.max(0, options.maxEntries) : 0;
        this.maxTotalBytes = Number.isFinite(options.maxTotalBytes) ? Math.max(0, options.maxTotalBytes) : 0;
    }

    get(key: ImagePreviewCacheKey): ImagePreviewCacheValue | null {
        const storageKey = this.toStorageKey(key);
        const existing = this.entries.get(storageKey) ?? null;
        if (!existing) return null;

        // Refresh LRU order by reinserting at the end.
        this.entries.delete(storageKey);
        this.entries.set(storageKey, existing);
        return existing.value;
    }

    setLimits(limits: Readonly<{ maxEntries: number; maxTotalBytes: number }>): void {
        this.maxEntries = Number.isFinite(limits.maxEntries) ? Math.max(0, limits.maxEntries) : 0;
        this.maxTotalBytes = Number.isFinite(limits.maxTotalBytes) ? Math.max(0, limits.maxTotalBytes) : 0;
        this.evictIfNeeded();
    }

    set(key: ImagePreviewCacheKey, value: ImagePreviewCacheValue): void {
        if (!key.sessionId || !key.snapshotSignature || !key.filePath) return;
        const storageKey = this.toStorageKey(key);

        const previous = this.entries.get(storageKey) ?? null;
        if (previous) {
            this.totalBytes -= previous.byteSize;
            this.entries.delete(storageKey);
        }

        const byteSize = this.estimateBytes(value);
        const entry: ImagePreviewCacheEntry = {
            value,
            byteSize,
            cachedAtMs: this.options.now(),
            sessionId: key.sessionId,
            snapshotSignature: key.snapshotSignature,
            filePath: key.filePath,
        };
        this.entries.set(storageKey, entry);
        this.totalBytes += byteSize;
        this.evictIfNeeded();
    }

    invalidateSession(sessionId: string): void {
        if (!sessionId) return;
        for (const [storageKey, entry] of this.entries) {
            if (entry.sessionId !== sessionId) continue;
            this.entries.delete(storageKey);
            this.totalBytes -= entry.byteSize;
        }
    }

    invalidatePaths(input: Readonly<{ sessionId: string; paths: ReadonlySet<string> }>): void {
        const sessionId = input.sessionId;
        if (!sessionId) return;
        if (!(input.paths instanceof Set) && typeof (input.paths as any)?.has !== 'function') return;

        for (const [storageKey, entry] of this.entries) {
            if (entry.sessionId !== sessionId) continue;
            if (!input.paths.has(entry.filePath)) continue;
            this.entries.delete(storageKey);
            this.totalBytes -= entry.byteSize;
        }
    }

    private estimateBytes(value: ImagePreviewCacheValue): number {
        if (value.status === 'loaded') {
            // UTF-16 in JS: approximate 2 bytes per code unit. Good enough for caps.
            return Math.max(0, value.uri.length * 2);
        }
        return Math.max(0, value.error.length * 2);
    }

    private toStorageKey(key: ImagePreviewCacheKey): string {
        return `${key.sessionId}\u0000${key.snapshotSignature}\u0000${key.filePath}`;
    }

    private evictIfNeeded(): void {
        const maxEntries = this.maxEntries;
        const maxTotalBytes = this.maxTotalBytes;

        while (this.entries.size > maxEntries || (maxTotalBytes > 0 && this.totalBytes > maxTotalBytes)) {
            const oldestKey = this.entries.keys().next().value as string | undefined;
            if (!oldestKey) break;
            const oldest = this.entries.get(oldestKey);
            this.entries.delete(oldestKey);
            if (oldest) {
                this.totalBytes -= oldest.byteSize;
            }
        }
    }
}
