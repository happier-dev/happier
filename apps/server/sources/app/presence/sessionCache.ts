import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { sessionCacheCounter } from "@/app/monitoring/metrics/index";

interface SessionCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    userId: string;
    sessionId: string;
    active: boolean;
}

interface MachineCacheEntry {
    validUntil: number;
    userId: string;
}

type ActivityValiditySeed = Readonly<{
    userId: string;
    active: boolean;
    lastActiveAt: Date | null;
}>;

class ActivityCache {
    private sessionCache = new Map<string, SessionCacheEntry>();
    private machineCache = new Map<string, MachineCacheEntry>();
    private nextCleanupAt = 0;
    
    // Cache TTL (30 seconds)
    private readonly CACHE_TTL = 30 * 1000;
    
    private readonly CLEANUP_INTERVAL = 5 * 60 * 1000;

    constructor() {}

    invalidateMachine(machineId: string): void {
        this.machineCache.delete(machineId);
    }

    seedSessionValidity(params: Readonly<{
        sessionId: string;
        userId: string;
        active: boolean;
        lastActiveAt: Date | null;
    }>): void {
        this.maybeCleanup(Date.now());
        const cacheKey = `${params.sessionId}:${params.userId}`;
        this.sessionCache.set(cacheKey, {
            ...this.buildSeededSessionEntry(
                params.sessionId,
                params.userId,
                {
                    userId: params.userId,
                    active: params.active,
                    lastActiveAt: params.lastActiveAt,
                },
            ),
        });
    }

    seedMachineValidity(params: Readonly<{
        machineId: string;
        userId: string;
        active: boolean;
        lastActiveAt: Date | null;
    }>): void {
        this.maybeCleanup(Date.now());
        this.machineCache.set(params.machineId, {
            ...this.buildSeededMachineEntry({
                userId: params.userId,
                active: params.active,
                lastActiveAt: params.lastActiveAt,
            }),
        });
    }

    private buildSeededSessionEntry(sessionId: string, userId: string, params: ActivityValiditySeed): SessionCacheEntry {
        const now = Date.now();
        return {
            validUntil: now + this.CACHE_TTL,
            lastUpdateSent: params.lastActiveAt?.getTime() ?? 0,
            userId,
            sessionId,
            active: params.active,
        };
    }

    private buildSeededMachineEntry(params: ActivityValiditySeed): MachineCacheEntry {
        const now = Date.now();
        return {
            validUntil: now + this.CACHE_TTL,
            userId: params.userId,
        };
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
            const session = await db.session.findUnique({
                where: { id: sessionId },
                select: { accountId: true, active: true, lastActiveAt: true },
            });
            // This cache records execution-publisher activity, not human access.
            // Exact machine/session proof remains owned by sessionScopedBinding.
            if (!session || session.accountId !== userId || !session.lastActiveAt) return false;
            this.sessionCache.set(
                cacheKey,
                this.buildSeededSessionEntry(sessionId, userId, {
                    userId,
                    active: session.active,
                    lastActiveAt: session.lastActiveAt,
                }),
            );
            return true;
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
                if (machine.replacedByMachineId) {
                    this.machineCache.delete(machineId);
                    return false;
                }

                // Cache the result
                this.machineCache.set(
                    machineId,
                    this.buildSeededMachineEntry({
                        userId,
                        active: machine.active,
                        lastActiveAt: machine.lastActiveAt,
                    }),
                );
                return true;
            }
            
            return false;
        } catch (error) {
            log({ module: 'session-cache', level: 'error' }, `Error validating machine ${machineId}: ${error}`);
            return false;
        }
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
        
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.validUntil < now) {
                this.machineCache.delete(machineId);
            }
        }
    }

    async shutdown(): Promise<void> {
        this.nextCleanupAt = 0;
        this.sessionCache.clear();
        this.machineCache.clear();
    }
}

// Global instance
export const activityCache = new ActivityCache();
