import type { ApiEphemeralActivityUpdate } from '../api/types/apiTypes';

type ActivityUpdateAccumulatorOptions = Readonly<{
    shouldContinue?: () => boolean;
    sourceServerId?: string | null;
}>;

type PendingActivityUpdate = Readonly<{
    update: ApiEphemeralActivityUpdate;
    shouldContinue: () => boolean;
    sourceServerId: string | null;
}>;

function normalizeSourceServerId(sourceServerId: string | null | undefined): string | null {
    const normalized = typeof sourceServerId === 'string' ? sourceServerId.trim() : '';
    return normalized.length > 0 ? normalized : null;
}

function buildScopedActivityUpdateKey(sessionId: string, sourceServerId: string | null): string {
    return `${sourceServerId ?? ''}\u0000${sessionId}`;
}

export class ActivityUpdateAccumulator {
    private pendingUpdates = new Map<string, PendingActivityUpdate>();
    private lastEmittedStates = new Map<string, { active: boolean; thinking: boolean; activeAt: number }>();
    private timeoutId: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private flushHandler: (
            updates: Map<string, ApiEphemeralActivityUpdate>,
            options?: { sourceServerId?: string | null },
        ) => void,
        private debounceDelay: number = 500
    ) {}

    addUpdate(update: ApiEphemeralActivityUpdate, options?: ActivityUpdateAccumulatorOptions): void {
        const sessionId = update.id;
        const sourceServerId = normalizeSourceServerId(options?.sourceServerId);
        const updateKey = buildScopedActivityUpdateKey(sessionId, sourceServerId);
        const lastState = this.lastEmittedStates.get(updateKey);
        const thinking = update.thinking ?? false;
        const pendingUpdate: PendingActivityUpdate = {
            update,
            shouldContinue: options?.shouldContinue ?? (() => true),
            sourceServerId,
        };

        // Check if this is a critical timestamp update (more than half of disconnect timeout old)
        const timeSinceLastUpdate = lastState ? update.activeAt - lastState.activeAt : 0;
        const isCriticalTimestamp = timeSinceLastUpdate > 60000; // Half of 120 second timeout

        // Check if this is a significant state change that needs immediate emission
        const isSignificantChange = !lastState || 
            lastState.active !== update.active || 
            lastState.thinking !== thinking ||
            isCriticalTimestamp;

        if (isSignificantChange) {
            // Cancel any pending timeout
            if (this.timeoutId) {
                clearTimeout(this.timeoutId);
                this.timeoutId = null;
            }

            // Add the immediate update to pending updates
            this.pendingUpdates.set(updateKey, pendingUpdate);

            // Flush all pending updates together (batched)
            this.flushPendingUpdates();
        } else {
            // Accumulate for debounced emission (only timestamp updates)
            this.pendingUpdates.set(updateKey, pendingUpdate);

            // Only start a new timer if one isn't already running
            if (!this.timeoutId) {
                this.timeoutId = setTimeout(() => {
                    this.flushPendingUpdates();
                    this.timeoutId = null;
                }, this.debounceDelay);
            }
            // Don't reset the timer for subsequent updates - let it fire!
        }
    }

    private flushPendingUpdates(): void {
        if (this.pendingUpdates.size > 0) {
            const updatesToFlushBySourceServerId = new Map<string, Map<string, ApiEphemeralActivityUpdate>>();
            for (const [, pending] of this.pendingUpdates) {
                if (pending.shouldContinue()) {
                    const sourceKey = pending.sourceServerId ?? '';
                    const updatesForSource = updatesToFlushBySourceServerId.get(sourceKey) ?? new Map<string, ApiEphemeralActivityUpdate>();
                    updatesForSource.set(pending.update.id, pending.update);
                    updatesToFlushBySourceServerId.set(sourceKey, updatesForSource);
                }
            }

            for (const [sourceKey, updatesToFlush] of updatesToFlushBySourceServerId) {
                if (updatesToFlush.size > 0) {
                    const sourceServerId = sourceKey || null;
                    if (sourceServerId) {
                        this.flushHandler(updatesToFlush, { sourceServerId });
                    } else {
                        this.flushHandler(updatesToFlush);
                    }
                }

                // Update last emitted states for all flushed updates
                for (const [sessionId, update] of updatesToFlush) {
                    this.lastEmittedStates.set(buildScopedActivityUpdateKey(sessionId, sourceKey || null), {
                        active: update.active,
                        thinking: update.thinking ?? false,
                        activeAt: update.activeAt
                    });
                }
            }

            // Clear pending updates
            this.pendingUpdates.clear();
        }
    }

    cancel(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        this.pendingUpdates.clear();
    }

    reset(): void {
        this.cancel();
        this.lastEmittedStates.clear();
    }

    flush(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        this.flushPendingUpdates();
    }
}
