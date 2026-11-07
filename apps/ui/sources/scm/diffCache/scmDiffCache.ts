import type { ScmDiffArea } from '@happier-dev/protocol/scm/workingSnapshot';

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

export type ScmDiffLoadResult = Readonly<{ success: true; diff: string }> | Readonly<{ success: false; error: string }>;

export class ScmDiffCache {
    // Snapshot signatures contain the repository's full status projection. Keep
    // that string as its own Map key so each file lookup reuses its cached hash.
    private readonly keysBySnapshot = new Map<string, Map<string, ScmDiffCacheKey>>();
    private readonly inFlight = new Map<ScmDiffCacheKey, { key: ScmDiffCacheKey; promise: Promise<ScmDiffLoadResult> }>();

    async getOrLoad(key: ScmDiffCacheKey, load: () => Promise<ScmDiffLoadResult>): Promise<ScmDiffLoadResult> {
        const cached = this.get(key);
        if (cached) return { success: true, diff: cached.diff };
        const storageKey = this.toStorageKey(key);
        const pending = this.inFlight.get(storageKey);
        if (pending) return pending.promise;
        let promise: Promise<ScmDiffLoadResult> | undefined;
        try {
            promise = load();
            this.inFlight.set(storageKey, { key, promise });
            const result = await promise;
            if (result.success && this.inFlight.get(storageKey)?.promise === promise) this.set(key, result.diff);
            return result;
        } finally {
            if (this.inFlight.get(storageKey)?.promise === promise) this.inFlight.delete(storageKey);
            this.forgetUnusedKey(storageKey);
        }
    }

    private readonly entries = new Map<ScmDiffCacheKey, ScmDiffCacheEntry & Readonly<{ sessionId: string; path: string }>>();
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
        if (!existing) {
            this.forgetUnusedKey(storageKey);
            return null;
        }

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
        for (const [storageKey, pending] of this.inFlight) {
            if (pending.key.sessionId !== sessionId) continue;
            this.inFlight.delete(storageKey);
            this.forgetUnusedKey(storageKey);
        }
        for (const [storageKey, entry] of this.entries) {
            if (entry.sessionId !== sessionId) continue;
            this.entries.delete(storageKey);
            this.totalBytes -= entry.byteSize;
            this.forgetUnusedKey(storageKey);
        }
    }

    invalidatePaths(input: Readonly<{ sessionId: string; paths: ReadonlySet<string> }>): void {
        const sessionId = input.sessionId;
        if (!sessionId) return;
        for (const [storageKey, pending] of this.inFlight) {
            if (pending.key.sessionId !== sessionId || !input.paths.has(pending.key.path)) continue;
            this.inFlight.delete(storageKey);
            this.forgetUnusedKey(storageKey);
        }

        for (const [storageKey, entry] of this.entries) {
            if (entry.sessionId !== sessionId) continue;
            if (!input.paths.has(entry.path)) continue;
            this.entries.delete(storageKey);
            this.totalBytes -= entry.byteSize;
            this.forgetUnusedKey(storageKey);
        }
    }

    private estimateBytes(diff: string): number {
        // UTF-16 in JS: approximate 2 bytes per code unit. Fast and good enough for caps.
        return Math.max(0, diff.length * 2);
    }

    private fileKey(key: ScmDiffCacheKey): string {
        return `${key.sessionId}\u0000${key.diffArea}\u0000${key.path}`;
    }

    private toStorageKey(key: ScmDiffCacheKey): ScmDiffCacheKey {
        let keys = this.keysBySnapshot.get(key.snapshotSignature);
        if (!keys) {
            keys = new Map();
            this.keysBySnapshot.set(key.snapshotSignature, keys);
        }
        const fileKey = this.fileKey(key);
        let stored = keys.get(fileKey);
        if (!stored) {
            stored = key;
            keys.set(fileKey, stored);
        }
        return stored;
    }

    private forgetUnusedKey(key: ScmDiffCacheKey): void {
        if (this.entries.has(key) || this.inFlight.has(key)) return;
        const keys = this.keysBySnapshot.get(key.snapshotSignature);
        const fileKey = this.fileKey(key);
        // An invalidated load may finish after a replacement has acquired this path.
        if (keys?.get(fileKey) !== key) return;
        keys.delete(fileKey);
        if (keys.size === 0) this.keysBySnapshot.delete(key.snapshotSignature);
    }

    private evictIfNeeded(): void {
        const maxEntries = this.maxEntries;
        const maxTotalBytes = this.maxTotalBytes;

        while (this.entries.size > maxEntries || (maxTotalBytes > 0 && this.totalBytes > maxTotalBytes)) {
            const oldestKey = this.entries.keys().next().value;
            if (!oldestKey) break;
            const oldest = this.entries.get(oldestKey);
            this.entries.delete(oldestKey);
            if (oldest) {
                this.totalBytes -= oldest.byteSize;
            }
            this.forgetUnusedKey(oldestKey);
        }
    }
}
