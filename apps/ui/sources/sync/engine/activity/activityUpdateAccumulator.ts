import type { ApiEphemeralActivityUpdate } from '@/sync/api/types/apiTypes';
import { activityInstanceKey } from '@/sync/domains/session/sessionAddress';
import { createSessionRuntimeObservationSource, didSessionRuntimeObservationRecover, type SessionRuntimeObservationSource } from '@/sync/domains/session/sessionRuntimeObservation';

export type ActivityUpdateFlushOptions = Readonly<{
    sourceServerId?: string | null;
    recoveryCandidateSessionIds?: ReadonlySet<string>;
}>;

type ActivityUpdateAccumulatorOptions = Readonly<{
    shouldContinue?: () => boolean;
    sourceServerId?: string | null;
}>;

type PendingActivityUpdate = Readonly<{
    update: ApiEphemeralActivityUpdate;
    shouldContinue: () => boolean;
    sourceServerId: string | null;
    recoveryCandidate: boolean;
}>;

function normalizeSourceServerId(sourceServerId: string | null | undefined): string | null {
    const normalized = typeof sourceServerId === 'string' ? sourceServerId.trim() : '';
    return normalized.length > 0 ? normalized : null;
}

function buildScopedActivityUpdateKey(sessionId: string, sourceServerId: string | null): string {
    return activityInstanceKey({ serverId: sourceServerId, sessionId }, 'ephemeral_activity_update');
}

export class ActivityUpdateAccumulator {
    private pendingUpdates = new Map<string, PendingActivityUpdate>();
    private timeoutId: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private flushHandler: (
            updates: Map<string, ApiEphemeralActivityUpdate>,
            options?: ActivityUpdateFlushOptions,
        ) => void,
        private debounceDelay: number = 500,
        private observations: SessionRuntimeObservationSource = createSessionRuntimeObservationSource(),
    ) {}

    addUpdate(update: ApiEphemeralActivityUpdate, options?: ActivityUpdateAccumulatorOptions): void {
        const sessionId = update.id;
        const sourceServerId = normalizeSourceServerId(options?.sourceServerId);
        const updateKey = buildScopedActivityUpdateKey(sessionId, sourceServerId);
        const shouldContinue = options?.shouldContinue ?? (() => true);
        if (!shouldContinue()) return;
        const lastState = this.observations.read({ serverId: sourceServerId, sessionId });
        const thinking = update.thinking ?? false;
        if (!this.observations.observe({ serverId: sourceServerId, sessionId }, {
            active: update.active, thinking, activeAt: update.activeAt,
            presence: update.active ? 'online' : update.activeAt,
        })) return;
        // Only a genuine scoped ephemeral can establish online presence after
        // a durable attachment observation. Publication still requires the row
        // to cross its canonical freshness boundary; this is only a candidate.
        const recoveryCandidate = sourceServerId !== null && (
            !lastState
            || (update.active && lastState.presence !== 'online')
            || didSessionRuntimeObservationRecover(lastState,
                this.observations.read({ serverId: sourceServerId, sessionId }), Date.now())
        );
        const pendingUpdate: PendingActivityUpdate = {
            update,
            shouldContinue,
            sourceServerId,
            recoveryCandidate,
        };

        // Check if this is a critical timestamp update (more than half of disconnect timeout old)
        const timeSinceLastUpdate = lastState ? update.activeAt - lastState.activeAt : 0;
        const isCriticalTimestamp = timeSinceLastUpdate > 60000; // Half of 120 second timeout

        // Check if this is a significant state change that needs immediate emission
        const isSignificantChange = !lastState || 
            lastState.active !== update.active || 
            lastState.thinking !== thinking ||
            isCriticalTimestamp || recoveryCandidate;

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
            const updatesToFlushBySourceServerId = new Map<string, {
                updates: Map<string, ApiEphemeralActivityUpdate>;
                recoveryCandidateSessionIds?: Set<string>;
            }>();
            for (const [, pending] of this.pendingUpdates) {
                if (pending.shouldContinue()) {
                    const sourceKey = pending.sourceServerId ?? '';
                    const updatesForSource: {
                        updates: Map<string, ApiEphemeralActivityUpdate>;
                        recoveryCandidateSessionIds?: Set<string>;
                    } = updatesToFlushBySourceServerId.get(sourceKey) ?? { updates: new Map<string, ApiEphemeralActivityUpdate>() };
                    updatesForSource.updates.set(pending.update.id, pending.update);
                    if (pending.recoveryCandidate) (updatesForSource.recoveryCandidateSessionIds ??= new Set()).add(pending.update.id);
                    updatesToFlushBySourceServerId.set(sourceKey, updatesForSource);
                }
            }

            for (const [sourceKey, group] of updatesToFlushBySourceServerId) {
                const updatesToFlush = group.updates;
                if (updatesToFlush.size > 0) {
                    const sourceServerId = sourceKey || null;
                    if (sourceServerId || group.recoveryCandidateSessionIds?.size) {
                        this.flushHandler(updatesToFlush, {
                            ...(sourceServerId ? { sourceServerId } : {}),
                            ...(group.recoveryCandidateSessionIds?.size ? { recoveryCandidateSessionIds: group.recoveryCandidateSessionIds } : {}),
                        });
                    } else {
                        this.flushHandler(updatesToFlush);
                    }
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
        this.observations.clear();
    }

    flush(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        this.flushPendingUpdates();
    }
}
