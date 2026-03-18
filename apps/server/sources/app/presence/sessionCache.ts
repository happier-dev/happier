import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { sessionCacheCounter, databaseUpdatesSkippedCounter } from "@/app/monitoring/metrics2";
import { checkSessionAccess } from "@/app/share/accessControl";

interface SessionCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    userId: string;
    sessionId: string;
    active: boolean;
}

interface MachineCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    userId: string;
    active: boolean;
}

function readErrorCode(error: unknown): string | null {
    if (!error || typeof error !== "object") {
        return null;
    }
    const { code } = error as { code?: unknown };
    return typeof code === "string" ? code : null;
}

class ActivityCache {
    private sessionCache = new Map<string, SessionCacheEntry>();
    private machineCache = new Map<string, MachineCacheEntry>();
    private batchTimer: NodeJS.Timeout | null = null;
    private dbFlushEnabled = false;
    private flushInFlight: Promise<void> | null = null;
    private dbFlushBackoffUntil = 0;
    private nextCleanupAt = 0;
    
    // Cache TTL (30 seconds)
    private readonly CACHE_TTL = 30 * 1000;
    
    // Only update DB if time difference is significant (30 seconds)
    private readonly UPDATE_THRESHOLD = 30 * 1000;
    
    // Batch update interval (5 seconds)
    private readonly BATCH_INTERVAL = 5 * 1000;
    private readonly CLEANUP_INTERVAL = 5 * 60 * 1000;
    private readonly DB_FLUSH_BACKOFF_INTERVAL = 30 * 1000;

    constructor() {}

    private startBatchTimer(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
        }
        
        this.batchTimer = setInterval(() => {
            this.flushPendingUpdates().catch(error => {
                log({ module: 'session-cache', level: 'error' }, `Error flushing updates: ${error}`);
            });
        }, this.BATCH_INTERVAL);
    }

    enableDbFlush(): void {
        if (this.dbFlushEnabled) return;
        this.dbFlushEnabled = true;
        this.startBatchTimer();
    }

    invalidateMachine(machineId: string): void {
        this.machineCache.delete(machineId);
    }

    private shouldBackoffDbFlush(error: unknown): boolean {
        const code = readErrorCode(error);
        if (code === "SQLITE_BUSY" || code === "P1008" || code === "P2028") {
            return true;
        }
        const message = error instanceof Error ? error.message : String(error);
        return (
            message.includes("Socket timeout") ||
            message.includes("database failed to respond") ||
            message.includes("SQLITE_BUSY")
        );
    }

    private maybeCleanup(now: number): void {
        if (this.nextCleanupAt && now < this.nextCleanupAt) return;
        this.cleanup(now);
        this.nextCleanupAt = now + this.CLEANUP_INTERVAL;
    }

    async isSessionValid(sessionId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        this.maybeCleanup(now);
        const cacheKey = `${sessionId}:${userId}`;
        const cached = this.sessionCache.get(cacheKey);
        
        // Check cache first
        if (cached && cached.validUntil > now) {
            sessionCacheCounter.inc({ operation: 'session_validation', result: 'hit' });
            return true;
        }
        
        sessionCacheCounter.inc({ operation: 'session_validation', result: 'miss' });
        
        // Cache miss - check database
        try {
            const access = await checkSessionAccess(userId, sessionId);
            
            if (access) {
                const session = await db.session.findUnique({
                    where: { id: sessionId },
                    select: { lastActiveAt: true, active: true },
                });
                if (!session?.lastActiveAt) {
                    // Fail closed: presence should not mark unknown sessions as valid.
                    return false;
                }

                // Cache the result
                this.sessionCache.set(cacheKey, {
                    validUntil: now + this.CACHE_TTL,
                    lastUpdateSent: session.lastActiveAt.getTime(),
                    pendingUpdate: null,
                    userId,
                    sessionId,
                    active: session.active,
                });
                return true;
            }
            
            return false;
        } catch (error) {
            log({ module: 'session-cache', level: 'error' }, `Error validating session ${sessionId}: ${error}`);
            return false;
        }
    }

    async isMachineValid(machineId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        this.maybeCleanup(now);
        const cached = this.machineCache.get(machineId);
        
        // Check cache first
        if (cached && cached.validUntil > now && cached.userId === userId) {
            sessionCacheCounter.inc({ operation: 'machine_validation', result: 'hit' });
            return true;
        }
        
        sessionCacheCounter.inc({ operation: 'machine_validation', result: 'miss' });
        
        // Cache miss - check database
        try {
            const machine = await db.machine.findUnique({
                where: {
                    accountId_id: {
                        accountId: userId,
                        id: machineId
                    }
                }
            });
            
            if (machine) {
                if (machine.revokedAt) {
                    // Fail closed: a revoked/forgotten machine is treated as invalid for presence.
                    this.machineCache.delete(machineId);
                    return false;
                }

                // Cache the result
                this.machineCache.set(machineId, {
                    validUntil: now + this.CACHE_TTL,
                    lastUpdateSent: machine.lastActiveAt?.getTime() || 0,
                    pendingUpdate: null,
                    userId,
                    active: machine.active
                });
                return true;
            }
            
            return false;
        } catch (error) {
            log({ module: 'session-cache', level: 'error' }, `Error validating machine ${machineId}: ${error}`);
            return false;
        }
    }

    queueSessionUpdate(sessionId: string, userId: string, timestamp: number): boolean {
        this.maybeCleanup(Date.now());
        const cacheKey = `${sessionId}:${userId}`;
        const cached = this.sessionCache.get(cacheKey);
        if (!cached) {
            return false; // Should validate first
        }

        // If the session is currently marked inactive, force a DB write to flip it back to active
        // even if `lastActiveAt` is already recent (e.g. after a restart or previously-buggy writes).
        if (!cached.active) {
            cached.pendingUpdate = timestamp;
            cached.active = true;
            return true;
        }
        
        // Only queue if time difference is significant
        const timeDiff = Math.abs(timestamp - cached.lastUpdateSent);
        if (timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            return true;
        }
        
        databaseUpdatesSkippedCounter.inc({ type: 'session' });
        return false; // No update needed
    }

    isSessionObservedActive(sessionId: string, now = Date.now()): boolean {
        this.maybeCleanup(now);
        for (const entry of this.sessionCache.values()) {
            if (entry.sessionId !== sessionId) continue;
            if (entry.validUntil <= now) continue;
            if (entry.active || entry.pendingUpdate !== null) {
                return true;
            }
        }
        return false;
    }

    queueMachineUpdate(machineId: string, timestamp: number): boolean {
        this.maybeCleanup(Date.now());
        const cached = this.machineCache.get(machineId);
        if (!cached) {
            return false; // Should validate first
        }
        
        // If the machine is currently marked inactive, force a DB write to flip it back to active
        // even if `lastActiveAt` is already recent (e.g. after a restart or previously-buggy writes).
        if (!cached.active) {
            cached.pendingUpdate = timestamp;
            cached.active = true;
            return true;
        }

        // Only queue if time difference is significant
        const timeDiff = Math.abs(timestamp - cached.lastUpdateSent);
        if (timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            return true;
        }
        
        databaseUpdatesSkippedCounter.inc({ type: 'machine' });
        return false; // No update needed
    }

    markSessionUpdateSent(sessionId: string, userId: string, timestamp: number): void {
        const cacheKey = `${sessionId}:${userId}`;
        const cached = this.sessionCache.get(cacheKey);
        if (!cached) return;
        cached.lastUpdateSent = timestamp;
        cached.pendingUpdate = null;
        cached.active = true;
    }

    markMachineUpdateSent(machineId: string, timestamp: number): void {
        const cached = this.machineCache.get(machineId);
        if (!cached) return;
        cached.lastUpdateSent = timestamp;
        cached.pendingUpdate = null;
        cached.active = true;
    }

    private flushPendingUpdates(): Promise<void> {
        // Avoid overlapping flushes (interval ticks, shutdown-triggered flush, etc.). On SQLite, overlapping
        // presence writes can cause lock contention that delays control-plane requests (e.g. machine registration).
        if (this.flushInFlight) {
            return this.flushInFlight;
        }

        const flushPromise = this.flushPendingUpdatesInternal().finally(() => {
            if (this.flushInFlight === flushPromise) {
                this.flushInFlight = null;
            }
        });
        this.flushInFlight = flushPromise;
        return flushPromise;
    }

    private async flushPendingUpdatesInternal(): Promise<void> {
        const now = Date.now();
        if (now < this.dbFlushBackoffUntil) return;
        let shouldAbortFlush = false;

        const sessionUpdatesById = new Map<string, { timestamp: number; entries: SessionCacheEntry[] }>();
        const machineUpdates: { machineId: string; timestamp: number; entry: MachineCacheEntry }[] = [];
        
        // Collect session updates
        for (const entry of this.sessionCache.values()) {
            if (entry.pendingUpdate !== null) {
                const timestamp = entry.pendingUpdate;
                const existing = sessionUpdatesById.get(entry.sessionId);
                if (!existing) {
                    sessionUpdatesById.set(entry.sessionId, { timestamp, entries: [entry] });
                } else {
                    existing.timestamp = Math.max(existing.timestamp, timestamp);
                    existing.entries.push(entry);
                }
            }
        }
        
        // Collect machine updates
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.pendingUpdate !== null) {
                machineUpdates.push({
                    machineId,
                    timestamp: entry.pendingUpdate,
                    entry,
                });
            }
        }
        
        // Flush session presence updates (best-effort).
        if (sessionUpdatesById.size > 0) {
            let okCount = 0;
            for (const [sessionId, update] of sessionUpdatesById.entries()) {
                const { timestamp, entries } = update;
                try {
                    // On SQLite, concurrent write bursts can trigger busy contention and delay unrelated
                    // control-plane requests (e.g. machine registration). Flush sequentially to reduce lock pressure.
                    await db.session.updateMany({
                        where: { id: sessionId },
                        data: { lastActiveAt: new Date(timestamp), active: true }
                    });

                    for (const entry of entries) {
                        entry.lastUpdateSent = timestamp;
                        // Preserve newer queued updates that arrived while awaiting the DB write.
                        // The flush snapshot uses the pendingUpdate value observed at collection time.
                        const pending = entry.pendingUpdate;
                        entry.pendingUpdate = pending !== null && pending > timestamp ? pending : null;
                        entry.active = true;
                    }
                    okCount += 1;
                } catch (error) {
                    // Keep the pending update so the next flush can retry.
                    for (const entry of entries) {
                        entry.pendingUpdate = Math.max(entry.pendingUpdate ?? 0, timestamp);
                    }
                    log(
                        { module: 'session-cache', level: 'error', sessionId },
                        `Error updating session: ${error}`,
                    );
                    if (this.shouldBackoffDbFlush(error)) {
                        this.dbFlushBackoffUntil = Date.now() + this.DB_FLUSH_BACKOFF_INTERVAL;
                        shouldAbortFlush = true;
                        break;
                    }
                }
            }

            log({ module: 'session-cache' }, `Flushed ${okCount}/${sessionUpdatesById.size} session updates`);
        }

        if (shouldAbortFlush) {
            return;
        }
        
        // Flush machine presence updates (best-effort).
        if (machineUpdates.length > 0) {
            let okCount = 0;
            for (const update of machineUpdates) {
                try {
                    // See sessions flush above: keep presence updates sequential to reduce lock contention.
                    await db.machine.updateMany({
                        where: {
                            accountId: update.entry.userId,
                            id: update.machineId,
                            revokedAt: null,
                        },
                        data: { lastActiveAt: new Date(update.timestamp), active: true }
                    });

                    update.entry.lastUpdateSent = update.timestamp;
                    // Preserve newer queued updates that arrived while awaiting the DB write.
                    const pending = update.entry.pendingUpdate;
                    update.entry.pendingUpdate = pending !== null && pending > update.timestamp ? pending : null;
                    update.entry.active = true;
                    okCount += 1;
                } catch (error) {
                    // Keep the pending update so the next flush can retry.
                    update.entry.pendingUpdate = Math.max(update.entry.pendingUpdate ?? 0, update.timestamp);
                    log(
                        { module: 'session-cache', level: 'error', machineId: update.machineId },
                        `Error updating machine: ${error}`,
                    );
                    if (this.shouldBackoffDbFlush(error)) {
                        this.dbFlushBackoffUntil = Date.now() + this.DB_FLUSH_BACKOFF_INTERVAL;
                        shouldAbortFlush = true;
                        break;
                    }
                }
            }

            log({ module: 'session-cache' }, `Flushed ${okCount}/${machineUpdates.length} machine updates`);
        }
    }

    // Cleanup old cache entries periodically
    cleanup(now = Date.now()): void {
        
        for (const [sessionId, entry] of this.sessionCache.entries()) {
            if (entry.validUntil < now) {
                this.sessionCache.delete(sessionId);
            }
        }
        
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.validUntil < now) {
                this.machineCache.delete(machineId);
            }
        }
    }

    shutdown(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }
        const shouldFlush = this.dbFlushEnabled;
        this.dbFlushEnabled = false;
        this.dbFlushBackoffUntil = 0;
        this.nextCleanupAt = 0;
        
        // Flush any remaining updates
        if (shouldFlush) {
            this.flushPendingUpdates().catch(error => {
                log({ module: 'session-cache', level: 'error' }, `Error flushing final updates: ${error}`);
            });
        }

        // Ensure shutdown is a hard stop: cache entries must not leak across lifetimes
        // (and tests should not share state through the singleton).
        this.sessionCache.clear();
        this.machineCache.clear();
    }
}

// Global instance
export const activityCache = new ActivityCache();
