import { configuration } from '@/configuration';

export type SessionClientMaterializationRuntime = Readonly<{
    readonly pendingMaterializedLocalIds: ReadonlySet<string>;
    readonly committedLocalIdsAwaitingEcho: ReadonlySet<string>;
    readonly pendingQueueMaterializedLocalIds: ReadonlySet<string>;
    readonly agentQueueEchoSuppressedLocalIds: ReadonlySet<string>;
    hasMaterializedLocalId: (localId: string) => boolean;
    hasSelfEchoSuppressedLocalId: (localId: string) => boolean;
    hasAgentQueueEchoSuppressedLocalId: (localId: string) => boolean;
    hasPendingQueueMaterializedLocalId: (localId: string) => boolean;
    shouldKeepUserSocketConnected: (params: Readonly<{
        hasPendingMessageCallback: boolean;
        hasQueuedDisconnectedSessionMessages: boolean;
    }>) => boolean;
    addPendingMaterializedLocalId: (localId: string) => void;
    markPendingQueueMaterializedLocalId: (localId: string) => void;
    markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    markCommittedLocalIdAwaitingEcho: (localId: string) => void;
    deleteMaterializedLocalId: (localId: string) => void;
    clearPendingMaterializedState: () => void;
    clearCommittedLocalIdCleanupTimers: () => void;
    clearAgentQueueEchoSuppressedLocalIdCleanupTimers: () => void;
    getPendingQueueMaterializedLocalIdsSize: () => number;
}>;

export function createSessionClientMaterializationRuntime(
    deps: Readonly<{
        forgetMaterializationRecovery: (localId: string) => void;
        onKeepAliveStateMayHaveChanged: () => void;
    }>,
): SessionClientMaterializationRuntime {
    const pendingMaterializedLocalIds = new Set<string>();
    const committedLocalIdsAwaitingEcho = new Set<string>();
    const pendingQueueMaterializedLocalIds = new Set<string>();
    const agentQueueEchoSuppressedLocalIds = new Set<string>();
    const committedLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const agentQueueEchoSuppressedLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

    const clearCommittedLocalIdCleanupTimers = (): void => {
        for (const timer of committedLocalIdCleanupTimers.values()) {
            clearTimeout(timer);
        }
        committedLocalIdCleanupTimers.clear();
    };

    const clearAgentQueueEchoSuppressedLocalIdCleanupTimers = (): void => {
        for (const timer of agentQueueEchoSuppressedLocalIdCleanupTimers.values()) {
            clearTimeout(timer);
        }
        agentQueueEchoSuppressedLocalIdCleanupTimers.clear();
    };

    return {
        pendingMaterializedLocalIds,
        committedLocalIdsAwaitingEcho,
        pendingQueueMaterializedLocalIds,
        agentQueueEchoSuppressedLocalIds,

        hasMaterializedLocalId,
        hasSelfEchoSuppressedLocalId,
        hasAgentQueueEchoSuppressedLocalId,
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
            const existingTimer = agentQueueEchoSuppressedLocalIdCleanupTimers.get(localId) ?? null;
            if (existingTimer) {
                clearTimeout(existingTimer);
            }
            const timer = setTimeout(() => {
                agentQueueEchoSuppressedLocalIdCleanupTimers.delete(localId);
                agentQueueEchoSuppressedLocalIds.delete(localId);
            }, configuration.transcriptRecoveryMaxWaitMs);
            timer.unref?.();
            agentQueueEchoSuppressedLocalIdCleanupTimers.set(localId, timer);
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
        },

        clearCommittedLocalIdCleanupTimers,
        clearAgentQueueEchoSuppressedLocalIdCleanupTimers,

        getPendingQueueMaterializedLocalIdsSize() {
            return pendingQueueMaterializedLocalIds.size;
        },
    };
}
