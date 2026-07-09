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
import type { PendingMaterializationActiveTurnPolicy } from '../../pendingMaterializationActiveTurnPolicy';
import { blocksPendingMaterializationDuringActiveTurn } from '../../pendingMaterializationActiveTurnPolicy';

type SessionTurnMutationActionInput = Parameters<typeof latestTurnStatusForSessionTurnMutationAction>[0];

export type SessionClientMaterializationRuntime = Readonly<{
    readonly pendingMaterializedLocalIds: ReadonlySet<string>;
    readonly committedLocalIdsAwaitingEcho: ReadonlySet<string>;
    readonly pendingQueueMaterializedLocalIds: ReadonlySet<string>;
    readonly agentQueueEchoSuppressedLocalIds: ReadonlySet<string>;
    readonly agentQueueDeliveredLocalIds: ReadonlySet<string>;
    getPendingQueueState: () => PendingQueueState;
    getLatestTurnStatus: () => LatestTurnStatusSnapshot | undefined;
    shouldAttemptPendingMaterialization: (opts?: {
        activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
    }) => boolean;
    shouldRefreshTurnStatusBeforePendingMaterialization: () => boolean;
    markTurnStatusRefreshPendingVersion: () => void;
    applyPendingQueueState: (state: KnownPendingQueueState) => boolean;
    applyLatestTurnStatus: (status: LatestTurnStatusSnapshot) => void;
    observeSessionTurnMutationAction: (action: SessionTurnMutationActionInput) => Readonly<{ isTerminal: boolean }>;
    hasActiveLocalTurn: () => boolean;
    shouldForceRefreshStaleBlockedTurnStatus: () => boolean;
    observeMaterializeResult: (params: Readonly<{ didMaterialize: boolean; pendingQueueState?: KnownPendingQueueState | null }>) => boolean;
    hasMaterializedLocalId: (localId: string) => boolean;
    hasSelfEchoSuppressedLocalId: (localId: string) => boolean;
    hasAgentQueueEchoSuppressedLocalId: (localId: string) => boolean;
    hasAgentQueueDeliveredLocalId: (localId: string) => boolean;
    hasPendingQueueMaterializedLocalId: (localId: string) => boolean;
    shouldKeepUserSocketConnected: (params: Readonly<{
        hasPendingMessageCallback: boolean;
        hasQueuedDisconnectedSessionMessages: boolean;
    }>) => boolean;
    addPendingMaterializedLocalId: (localId: string) => void;
    markPendingQueueMaterializedLocalId: (localId: string) => void;
    markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    clearAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    markAgentQueueDeliveredLocalId: (localId: string) => void;
    clearAgentQueueDeliveredLocalId: (localId: string) => void;
    markCommittedLocalIdAwaitingEcho: (localId: string) => void;
    deleteMaterializedLocalId: (localId: string) => void;
    clearPendingMaterializedState: () => void;
    clearCommittedLocalIdCleanupTimers: () => void;
    getPendingQueueMaterializedLocalIdsSize: () => number;
}>;

export function createSessionClientMaterializationRuntime(
    deps: Readonly<{
        forgetMaterializationRecovery: (localId: string) => void;
        onKeepAliveStateMayHaveChanged: () => void;
        initialPendingQueueState?: PendingQueueState | null;
        initialLatestTurnStatus?: LatestTurnStatusSnapshot | undefined;
        isPendingQueueMaterializationBlocked?: () => boolean;
    }>,
): SessionClientMaterializationRuntime {
    const pendingMaterializedLocalIds = new Set<string>();
    const committedLocalIdsAwaitingEcho = new Set<string>();
    const pendingQueueMaterializedLocalIds = new Set<string>();
    const agentQueueEchoSuppressedLocalIds = new Set<string>();
    const agentQueueDeliveredLocalIds = new Set<string>();
    const committedLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let pendingQueueState: PendingQueueState = deps.initialPendingQueueState ?? UNKNOWN_PENDING_QUEUE_STATE;
    let latestTurnStatus = deps.initialLatestTurnStatus;
    let lastTurnStatusRefreshPendingVersion: number | null = null;
    let hasActiveLocalTurn = false;
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

    const hasAgentQueueDeliveredLocalId = (localId: string): boolean =>
        agentQueueDeliveredLocalIds.has(localId);

    const hasPendingQueueMaterializedLocalId = (localId: string): boolean =>
        pendingQueueMaterializedLocalIds.has(localId);

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
        agentQueueDeliveredLocalIds,

        getPendingQueueState() {
            return pendingQueueState;
        },

        getLatestTurnStatus() {
            return latestTurnStatus;
        },

        shouldAttemptPendingMaterialization(opts = {}) {
            if (deps.isPendingQueueMaterializationBlocked?.() === true) {
                return false;
            }
            if (
                blocksPendingMaterializationDuringActiveTurn(opts.activeTurnDeliveryPolicy)
                && isActiveLatestTurnStatus(latestTurnStatus)
            ) {
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

        applyLatestTurnStatus(status) {
            latestTurnStatus = status;
        },

        observeSessionTurnMutationAction(action) {
            const mapped = latestTurnStatusForSessionTurnMutationAction(action);
            if (mapped !== undefined) {
                latestTurnStatus = mapped;
            }
            if (action === 'begin') {
                hasActiveLocalTurn = true;
            } else if (isTerminalSessionTurnMutationAction(action)) {
                hasActiveLocalTurn = false;
            }
            return { isTerminal: isTerminalSessionTurnMutationAction(action) };
        },

        hasActiveLocalTurn() {
            return hasActiveLocalTurn;
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
        hasAgentQueueDeliveredLocalId,
        hasPendingQueueMaterializedLocalId,

        shouldKeepUserSocketConnected({ hasPendingMessageCallback, hasQueuedDisconnectedSessionMessages }) {
            return hasPendingMessageCallback
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

        markAgentQueueDeliveredLocalId(localId) {
            if (!localId) return;
            agentQueueDeliveredLocalIds.add(localId);
        },

        clearAgentQueueDeliveredLocalId(localId) {
            if (!localId) return;
            agentQueueDeliveredLocalIds.delete(localId);
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
            deps.forgetMaterializationRecovery(localId);
            deps.onKeepAliveStateMayHaveChanged();
        },

        clearPendingMaterializedState() {
            pendingMaterializedLocalIds.clear();
            committedLocalIdsAwaitingEcho.clear();
            pendingQueueMaterializedLocalIds.clear();
            agentQueueEchoSuppressedLocalIds.clear();
            agentQueueDeliveredLocalIds.clear();
        },

        clearCommittedLocalIdCleanupTimers,

        getPendingQueueMaterializedLocalIdsSize() {
            return pendingQueueMaterializedLocalIds.size;
        },
    };
}
