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

class ActivityCache {
    private sessionCache = new Map<string, SessionCacheEntry>();
    private machineCache = new Map<string, MachineCacheEntry>();
    private batchTimer: NodeJS.Timeout | null = null;
    private dbFlushEnabled = false;
    private nextCleanupAt = 0;
    
    // Cache TTL (30 seconds)
    private readonly CACHE_TTL = 30 * 1000;
    
    // Only update DB if time difference is significant (30 seconds)
    private readonly UPDATE_THRESHOLD = 30 * 1000;
    
    // Batch update interval (5 seconds)
    private readonly BATCH_INTERVAL = 5 * 1000;
    private readonly CLEANUP_INTERVAL = 5 * 60 * 1000;

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

    private maybeCleanup(now: number): void {
        if (this.nextCleanupAt && now < this.nextCleanupAt) return;
        this.cleanup();
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

    private async flushPendingUpdates(): Promise<void> {
        const sessionUpdatesById = new Map<string, number>();
        const machineUpdates: { id: string, timestamp: number, userId: string }[] = [];
        
        // Collect session updates
        for (const entry of this.sessionCache.values()) {
            if (entry.pendingUpdate) {
                sessionUpdatesById.set(entry.sessionId, Math.max(sessionUpdatesById.get(entry.sessionId) ?? 0, entry.pendingUpdate));
                entry.lastUpdateSent = entry.pendingUpdate;
                entry.pendingUpdate = null;
            }
        }
        
        // Collect machine updates
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.pendingUpdate) {
                machineUpdates.push({ 
                    id: machineId, 
                    timestamp: entry.pendingUpdate, 
                    userId: entry.userId 
                });
                entry.active = true;
                entry.lastUpdateSent = entry.pendingUpdate;
                entry.pendingUpdate = null;
            }
        }
        
        // Batch update sessions
        if (sessionUpdatesById.size > 0) {
            try {
                await Promise.all(Array.from(sessionUpdatesById.entries()).map(([sessionId, timestamp]) =>
                    db.session.updateMany({
                        where: { id: sessionId },
                        data: { lastActiveAt: new Date(timestamp), active: true }
                    })
                ));
                
                log({ module: 'session-cache' }, `Flushed ${sessionUpdatesById.size} session updates`);
            } catch (error) {
                log({ module: 'session-cache', level: 'error' }, `Error updating sessions: ${error}`);
            }
        }
        
        // Batch update machines
        if (machineUpdates.length > 0) {
            try {
                await Promise.all(machineUpdates.map(update =>
                    db.machine.updateMany({
                        where: {
                            accountId: update.userId,
                            id: update.id,
                            revokedAt: null,
                        },
                        data: { lastActiveAt: new Date(update.timestamp), active: true }
                    })
                ));
                
                log({ module: 'session-cache' }, `Flushed ${machineUpdates.length} machine updates`);
            } catch (error) {
                log({ module: 'session-cache', level: 'error' }, `Error updating machines: ${error}`);
            }
        }
    }

    // Cleanup old cache entries periodically
    cleanup(): void {
        const now = Date.now();
        
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
        
        // Flush any remaining updates
        if (this.dbFlushEnabled) {
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
