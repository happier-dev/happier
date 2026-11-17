interface SessionCacheEntry {
    validUntil: number;
    sessionId: string;
    active: boolean;
}

/**
 * Session-scoped publisher activity observed at socket handshake, read by the
 * retention rule so it never deletes a Session a live publisher just bound.
 */
class ActivityCache {
    private sessionCache = new Map<string, SessionCacheEntry>();
    private nextCleanupAt = 0;
    
    // Cache TTL (30 seconds)
    private readonly CACHE_TTL = 30 * 1000;
    
    private readonly CLEANUP_INTERVAL = 5 * 60 * 1000;

    seedSessionValidity(params: Readonly<{
        sessionId: string;
        userId: string;
        active: boolean;
    }>): void {
        const now = Date.now();
        this.maybeCleanup(now);
        this.sessionCache.set(`${params.sessionId}:${params.userId}`, {
            validUntil: now + this.CACHE_TTL,
            sessionId: params.sessionId,
            active: params.active,
        });
    }

    private maybeCleanup(now: number): void {
        if (this.nextCleanupAt && now < this.nextCleanupAt) return;
        this.cleanup(now);
        this.nextCleanupAt = now + this.CLEANUP_INTERVAL;
    }

    isSessionObservedActive(sessionId: string, now = Date.now()): boolean {
        this.maybeCleanup(now);
        for (const entry of this.sessionCache.values()) {
            if (entry.sessionId !== sessionId) continue;
            if (entry.validUntil <= now) continue;
            if (entry.active) {
                return true;
            }
        }
        return false;
    }

    markSessionInactive(sessionId: string, userId: string, timestamp: number): void {
        const cacheKey = `${sessionId}:${userId}`;
        this.sessionCache.delete(cacheKey);
        for (const [entryKey, entry] of this.sessionCache.entries()) {
            if (entry.sessionId !== sessionId) continue;
            this.sessionCache.delete(entryKey);
        }
    }

    // Cleanup old cache entries periodically
    cleanup(now = Date.now()): void {
        
        for (const [sessionId, entry] of this.sessionCache.entries()) {
            if (entry.validUntil < now) {
                this.sessionCache.delete(sessionId);
            }
        }
    }

    async shutdown(): Promise<void> {
        this.nextCleanupAt = 0;
        this.sessionCache.clear();
    }
}

// Global instance
export const activityCache = new ActivityCache();
