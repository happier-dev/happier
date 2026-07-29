import { configuration } from '@/configuration';
import {
    applyKnownPendingQueueState,
    countMaterializablePendingRows,
    derivePendingQueueStateAfterMaterializeResult,
    type KnownPendingQueueState,
    type PendingQueueState,
    UNKNOWN_PENDING_QUEUE_STATE,
} from '../../pendingQueueState';
import {
    isActiveLatestTurnStatus,
    isTerminalSessionTurnMutationAction,
    latestTurnStatusForSessionTurnMutationAction,
    type LatestTurnStatusSnapshot,
} from '../../sessionTurnStatusSnapshot';

type SessionTurnMutationActionInput = Parameters<typeof latestTurnStatusForSessionTurnMutationAction>[0];

export type SessionClientMaterializationRuntime = Readonly<{
    readonly pendingMaterializedLocalIds: ReadonlySet<string>;
    readonly committedLocalIdsAwaitingEcho: ReadonlySet<string>;
    readonly pendingQueueMaterializedLocalIds: ReadonlySet<string>;
    readonly agentQueueEchoSuppressedLocalIds: ReadonlySet<string>;
    getPendingQueueState: () => PendingQueueState;
    getLatestTurnStatus: () => LatestTurnStatusSnapshot | undefined;
    getLatestTurnStatusObservedAt: () => number | null;
    getLatestTurnSnapshot: () => Readonly<{
        status: Exclude<LatestTurnStatusSnapshot, null>;
        observedAt: number;
    }> | null;
    shouldAttemptPendingMaterialization: () => boolean;
    shouldRefreshTurnStatusBeforePendingMaterialization: () => boolean;
    markTurnStatusRefreshPendingVersion: () => void;
    applyPendingQueueState: (state: KnownPendingQueueState) => boolean;
    applyLatestTurnStatus: (status: LatestTurnStatusSnapshot, observedAt?: number | null) => void;
    observeSessionTurnMutationAction: (
        action: SessionTurnMutationActionInput,
        observedAt?: number,
    ) => Readonly<{ isTerminal: boolean }>;
    hasActiveLocalTurn: () => boolean;
    getActiveLocalTurnProgressAt: () => number | null;
    shouldForceRefreshStaleBlockedTurnStatus: () => boolean;
    observeMaterializeResult: (params: Readonly<{ didMaterialize: boolean; pendingQueueState?: KnownPendingQueueState | null }>) => boolean;
    hasMaterializedLocalId: (localId: string) => boolean;
    hasSelfEchoSuppressedLocalId: (localId: string) => boolean;
    hasAgentQueueEchoSuppressedLocalId: (localId: string) => boolean;
    hasPendingQueueMaterializedLocalId: (localId: string) => boolean;
    shouldKeepUserSocketConnected: (params: Readonly<{
        hasProviderInputConsumer: boolean;
        hasQueuedDisconnectedSessionMessages: boolean;
    }>) => boolean;
    addPendingMaterializedLocalId: (localId: string) => void;
    markPendingQueueMaterializedLocalId: (localId: string) => void;
    markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    clearAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    markCommittedLocalIdAwaitingEcho: (localId: string) => void;
    deleteMaterializedLocalId: (localId: string) => void;
    clearPendingMaterializedState: () => void;
    clearCommittedLocalIdCleanupTimers: () => void;
    getPendingQueueMaterializedLocalIdsSize: () => number;
}>;

export function createSessionClientMaterializationRuntime(
    deps: Readonly<{
        onKeepAliveStateMayHaveChanged: () => void;
        initialPendingQueueState?: PendingQueueState | null;
        initialLatestTurnStatus?: LatestTurnStatusSnapshot | undefined;
        initialLatestTurnStatusObservedAt?: number | null;
        isPendingQueueMaterializationBlocked?: () => boolean;
    }>,
): SessionClientMaterializationRuntime {
    const pendingMaterializedLocalIds = new Set<string>();
    const committedLocalIdsAwaitingEcho = new Set<string>();
    const pendingQueueMaterializedLocalIds = new Set<string>();
    const agentQueueEchoSuppressedLocalIds = new Set<string>();
    const committedLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let pendingQueueState: PendingQueueState = deps.initialPendingQueueState ?? UNKNOWN_PENDING_QUEUE_STATE;
    let latestTurnStatus = deps.initialLatestTurnStatus;
    let latestTurnStatusObservedAt = deps.initialLatestTurnStatusObservedAt ?? null;
    let lastTurnStatusRefreshPendingVersion: number | null = null;
    let hasActiveLocalTurn = false;
    let activeLocalTurnProgressAt: number | null = null;
    let lastStaleBlockedTurnStatusRefreshAt = 0;

    const hasMaterializedLocalId = (localId: string): boolean =>
        pendingMaterializedLocalIds.has(localId)
        || committedLocalIdsAwaitingEcho.has(localId)
        || pendingQueueMaterializedLocalIds.has(localId);

    const hasSelfEchoSuppressedLocalId = (localId: string): boolean =>
        pendingMaterializedLocalIds.has(localId)
        || committedLocalIdsAwaitingEcho.has(localId);

    const hasAgentQueueEchoSuppressedLocalId = (localId: string): boolean =>
        agentQueueEchoSuppressedLocalIds.has(localId);

    const hasPendingQueueMaterializedLocalId = (localId: string): boolean =>
        pendingQueueMaterializedLocalIds.has(localId);

    const applyLatestTurnStatusProjection = (
        status: LatestTurnStatusSnapshot,
        observedAt?: number | null,
    ): void => {
        const observedAtMs = typeof observedAt === 'number' && Number.isFinite(observedAt) && observedAt >= 0
            ? Math.trunc(observedAt)
            : null;
        if (observedAtMs === null) {
            if (latestTurnStatusObservedAt !== null) return;
        } else if (
            latestTurnStatusObservedAt !== null
            && observedAtMs < latestTurnStatusObservedAt
        ) {
            return;
        }

        latestTurnStatus = status;
        latestTurnStatusObservedAt = observedAtMs;
    };

    const clearCommittedLocalIdCleanupTimers = (): void => {
        for (const timer of committedLocalIdCleanupTimers.values()) {
            clearTimeout(timer);
        }
        committedLocalIdCleanupTimers.clear();
    };

    return {
        pendingMaterializedLocalIds,
        committedLocalIdsAwaitingEcho,
        pendingQueueMaterializedLocalIds,
        agentQueueEchoSuppressedLocalIds,

        getPendingQueueState() {
            return pendingQueueState;
        },

        getLatestTurnStatus() {
            return latestTurnStatus;
        },

        getLatestTurnStatusObservedAt() {
            return latestTurnStatusObservedAt;
        },

        getLatestTurnSnapshot() {
            if (
                latestTurnStatus === undefined
                || latestTurnStatus === null
                || latestTurnStatusObservedAt === null
            ) {
                return null;
            }
            return {
                status: latestTurnStatus,
                observedAt: latestTurnStatusObservedAt,
            };
        },

        shouldAttemptPendingMaterialization() {
            if (deps.isPendingQueueMaterializationBlocked?.() === true) {
                return false;
            }
            return countMaterializablePendingRows(pendingQueueState) > 0;
        },

        shouldRefreshTurnStatusBeforePendingMaterialization() {
            if (!pendingQueueState.known || countMaterializablePendingRows(pendingQueueState) <= 0) {
                return false;
            }
            if (deps.isPendingQueueMaterializationBlocked?.() === true) {
                return false;
            }
            if (isActiveLatestTurnStatus(latestTurnStatus)) {
                return false;
            }
            if (latestTurnStatus === undefined) {
                return false;
            }
            return lastTurnStatusRefreshPendingVersion !== pendingQueueState.pendingVersion;
        },

        markTurnStatusRefreshPendingVersion() {
            if (!pendingQueueState.known || latestTurnStatus === undefined) return;
            lastTurnStatusRefreshPendingVersion = pendingQueueState.pendingVersion;
        },

        applyPendingQueueState(state) {
            const result = applyKnownPendingQueueState(pendingQueueState, state);
            pendingQueueState = result.state;
            return result.changed;
        },

        applyLatestTurnStatus(status, observedAt) {
            applyLatestTurnStatusProjection(status, observedAt);
        },

        observeSessionTurnMutationAction(action, observedAt) {
            const mapped = latestTurnStatusForSessionTurnMutationAction(action);
            if (mapped !== undefined) {
                applyLatestTurnStatusProjection(mapped, observedAt);
            }
            if (action === 'begin') {
                hasActiveLocalTurn = true;
                activeLocalTurnProgressAt = typeof observedAt === 'number' && Number.isFinite(observedAt)
                    ? Math.trunc(observedAt)
                    : Date.now();
            } else if (isTerminalSessionTurnMutationAction(action)) {
                hasActiveLocalTurn = false;
                activeLocalTurnProgressAt = null;
            }
            return { isTerminal: isTerminalSessionTurnMutationAction(action) };
        },

        hasActiveLocalTurn() {
            return hasActiveLocalTurn;
        },

        getActiveLocalTurnProgressAt() {
            return activeLocalTurnProgressAt;
        },

        /**
         * Self-heal a stale busy gate: when ONLY a (possibly stale) 'in_progress' snapshot blocks
         * materialization and no canonical turn is active locally (e.g. a respawned runner or a
         * lost turn-end write), allow a throttled force-refresh of the server snapshot so queued
         * messages can never starve forever.
         */
        shouldForceRefreshStaleBlockedTurnStatus() {
            if (countMaterializablePendingRows(pendingQueueState) <= 0) return false;
            if (!isActiveLatestTurnStatus(latestTurnStatus)) return false;
            if (hasActiveLocalTurn) return false;
            const now = Date.now();
            if (
                lastStaleBlockedTurnStatusRefreshAt > 0
                && now - lastStaleBlockedTurnStatusRefreshAt < configuration.pendingQueueStateReconcileThrottleMs
            ) {
                return false;
            }
            lastStaleBlockedTurnStatusRefreshAt = now;
            return true;
        },

        observeMaterializeResult(params) {
            const result = derivePendingQueueStateAfterMaterializeResult({
                current: pendingQueueState,
                didMaterialize: params.didMaterialize,
                authoritativeState: params.pendingQueueState ?? null,
            });
            pendingQueueState = result.state;
            return result.changed;
        },

        hasMaterializedLocalId,
        hasSelfEchoSuppressedLocalId,
        hasAgentQueueEchoSuppressedLocalId,
        hasPendingQueueMaterializedLocalId,

        shouldKeepUserSocketConnected({ hasProviderInputConsumer, hasQueuedDisconnectedSessionMessages }) {
            return hasProviderInputConsumer
                || pendingMaterializedLocalIds.size > 0
                || committedLocalIdsAwaitingEcho.size > 0
                || pendingQueueMaterializedLocalIds.size > 0
                || hasQueuedDisconnectedSessionMessages;
        },

        addPendingMaterializedLocalId(localId) {
            if (!localId) return;
            pendingMaterializedLocalIds.add(localId);
        },

        markPendingQueueMaterializedLocalId(localId) {
            if (!localId) return;
            pendingQueueMaterializedLocalIds.add(localId);
        },

        markAgentQueueEchoSuppressedLocalId(localId) {
            if (!localId) return;
            agentQueueEchoSuppressedLocalIds.add(localId);
        },

        clearAgentQueueEchoSuppressedLocalId(localId) {
            if (!localId) return;
            agentQueueEchoSuppressedLocalIds.delete(localId);
        },

        markCommittedLocalIdAwaitingEcho(localId) {
            pendingMaterializedLocalIds.delete(localId);
            committedLocalIdsAwaitingEcho.add(localId);
            const existingTimer = committedLocalIdCleanupTimers.get(localId) ?? null;
            if (existingTimer) {
                clearTimeout(existingTimer);
            }
            const timer = setTimeout(() => {
                committedLocalIdCleanupTimers.delete(localId);
                committedLocalIdsAwaitingEcho.delete(localId);
                deps.onKeepAliveStateMayHaveChanged();
            }, configuration.transcriptRecoveryMaxWaitMs);
            timer.unref?.();
            committedLocalIdCleanupTimers.set(localId, timer);
        },

        deleteMaterializedLocalId(localId) {
            pendingMaterializedLocalIds.delete(localId);
            committedLocalIdsAwaitingEcho.delete(localId);
            pendingQueueMaterializedLocalIds.delete(localId);
            const cleanupTimer = committedLocalIdCleanupTimers.get(localId) ?? null;
            if (cleanupTimer) {
                clearTimeout(cleanupTimer);
                committedLocalIdCleanupTimers.delete(localId);
            }
            deps.onKeepAliveStateMayHaveChanged();
        },

        clearPendingMaterializedState() {
            pendingMaterializedLocalIds.clear();
            committedLocalIdsAwaitingEcho.clear();
            pendingQueueMaterializedLocalIds.clear();
            agentQueueEchoSuppressedLocalIds.clear();
        },

        clearCommittedLocalIdCleanupTimers,

        getPendingQueueMaterializedLocalIdsSize() {
            return pendingQueueMaterializedLocalIds.size;
        },
    };
}
