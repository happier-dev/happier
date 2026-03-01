import type { ScmDiffArea } from '@happier-dev/protocol';

export type ScmDiffCacheKey = Readonly<{
    sessionId: string;
    snapshotSignature: string;
    diffArea: ScmDiffArea;
    path: string;
}>;

export type ScmDiffCacheEntry = Readonly<{
    diff: string;
    byteSize: number;
    cachedAtMs: number;
}>;

export type ScmDiffCacheOptions = Readonly<{
    maxEntries: number;
    maxTotalBytes: number;
    now: () => number;
}>;

export class ScmDiffCache {
    private readonly entries = new Map<string, ScmDiffCacheEntry & Readonly<{ sessionId: string; path: string }>>();
    private totalBytes = 0;
    private maxEntries: number;
    private maxTotalBytes: number;

    constructor(private readonly options: ScmDiffCacheOptions) {
        this.maxEntries = Number.isFinite(options.maxEntries) ? Math.max(0, options.maxEntries) : 0;
        this.maxTotalBytes = Number.isFinite(options.maxTotalBytes) ? Math.max(0, options.maxTotalBytes) : 0;
    }

    get(key: ScmDiffCacheKey): ScmDiffCacheEntry | null {
        const storageKey = this.toStorageKey(key);
        const existing = this.entries.get(storageKey) ?? null;
        if (!existing) return null;

        // Refresh LRU order by reinserting at the end.
        this.entries.delete(storageKey);
        this.entries.set(storageKey, existing);
        return existing;
    }

    setLimits(limits: Readonly<{ maxEntries: number; maxTotalBytes: number }>): void {
        this.maxEntries = Number.isFinite(limits.maxEntries) ? Math.max(0, limits.maxEntries) : 0;
        this.maxTotalBytes = Number.isFinite(limits.maxTotalBytes) ? Math.max(0, limits.maxTotalBytes) : 0;
        this.evictIfNeeded();
    }

    set(key: ScmDiffCacheKey, diff: string): void {
        if (!key.sessionId || !key.snapshotSignature || !key.diffArea || !key.path) return;
        const storageKey = this.toStorageKey(key);

        const previous = this.entries.get(storageKey) ?? null;
        if (previous) {
            this.totalBytes -= previous.byteSize;
            this.entries.delete(storageKey);
        }

        const byteSize = this.estimateBytes(diff);
        const entry: ScmDiffCacheEntry & Readonly<{ sessionId: string; path: string }> = {
            diff,
            byteSize,
            cachedAtMs: this.options.now(),
            sessionId: key.sessionId,
            path: key.path,
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
            if (!input.paths.has(entry.path)) continue;
            this.entries.delete(storageKey);
            this.totalBytes -= entry.byteSize;
        }
    }

    private estimateBytes(diff: string): number {
        // UTF-16 in JS: approximate 2 bytes per code unit. Fast and good enough for caps.
        return Math.max(0, diff.length * 2);
    }

    private toStorageKey(key: ScmDiffCacheKey): string {
        // Use a separator that cannot appear in paths.
        return `${key.sessionId}\u0000${key.snapshotSignature}\u0000${key.diffArea}\u0000${key.path}`;
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
